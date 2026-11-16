import { sha256Prefixed } from '../../core/evidence/sha256';
import { planFile, rebaseOffset, type FilePlan, type PlannedFragment } from '../../core/host-config/plan';
import {
  HostConfigError,
  expectedFromCommitted,
  sameExpected,
  type ExpectedFile,
  type FileCommitted,
  type FileRecord,
  type FileRecordKind,
  type FragmentRecord,
  type FragmentRequest,
  type HostConfigLedger,
  type HostPath,
  type Sha256,
  type SkippedOverride,
} from '../../core/host-config/types';
import {
  createDirectories,
  ensurePrivateDirectory,
  expectedOf,
  hostConfigPaths,
  missingDirectories,
  observeFile,
  putVault,
  readLedger,
  readVault,
  removeCreatedDirectories,
  removeTarget,
  replaceTarget,
  resolveHostPath,
  writeLedger,
  type HostConfigPaths,
} from './store';

export interface HostConfigFileChange {
  readonly path: string;
  readonly fragments: readonly FragmentRequest[];
  /** An earlier rh version wrote this path before the ledger existed. */
  readonly baselineUnknown?: boolean;
}

export interface HostConfigApplyResult {
  readonly written: readonly string[];
  readonly skipped: readonly SkippedOverride[];
}

export interface HostConfigDelegateResult {
  readonly changed: readonly string[];
}

export interface HostConfigRevertEntry {
  readonly path: string;
  /**
   * `released`: rh's fragments were already the file's text, so only the
   * records go. `kept_edited`: the file is not as rh recorded it, so the file
   * and its record stay.
   */
  readonly action: 'removed' | 'restored' | 'text_removed' | 'released' | 'kept_edited';
}

export interface HostConfigGateOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export interface HostConfigGate {
  apply(changes: readonly HostConfigFileChange[]): HostConfigApplyResult;
  /**
   * Only for out-of-process writers: `run` gets the destinations with links
   * followed and may write them. The gate backs up the bytes that rh did not
   * write and records each path before `run`, and records each change after.
   */
  delegate(declaredPaths: readonly string[], run: (destinations: readonly string[]) => void): HostConfigDelegateResult;
  /** Undo rh's recorded writes, for the named paths or for all; a path without a record is not touched. */
  revert(paths?: readonly string[]): readonly HostConfigRevertEntry[];
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decode(bytes: Buffer | null, path: string): string {
  try { return bytes === null ? '' : UTF8.decode(bytes); }
  catch { throw new HostConfigError('host_config_invalid_state', `not UTF-8 text: ${path}`); }
}

/** Two aliases of one file are one path. */
function admitPaths(paths: HostConfigPaths, targets: readonly string[]): HostPath[] {
  const admitted = targets.map((path) => resolveHostPath(paths, path));
  if (new Set(admitted).size !== admitted.length) throw new HostConfigError('host_config_invalid_state', 'a call names one path twice');
  ensurePrivateDirectory(paths.vault);
  return admitted;
}

function committedOf(expected: ExpectedFile): FileCommitted {
  return expected.existed ? { type: 'file', sha256: expected.sha256 } : { type: 'absent' };
}

function isCommitted(record: FileRecord, observed: ExpectedFile): boolean {
  return sameExpected(observed, expectedFromCommitted(record.committed));
}

/**
 * The first record of a path fixes its kind and baseline. Later writes update
 * `committed`, set a new backup when they replace bytes that rh did not write,
 * and keep `external_change` once the file differed from `committed`.
 */
function nextFileRecord(previous: FileRecord | undefined, first: { kind: FileRecordKind; backup: Sha256 | null; baselineUnknown: boolean },
  preimage: ExpectedFile, written: ExpectedFile, createdDirs: readonly string[]): FileRecord {
  if (!previous) {
    return {
      kind: first.kind,
      baseline: first.baselineUnknown ? { state: 'unknown' }
        : preimage.existed ? { state: 'known', existed: true, sha256: preimage.sha256 } : { state: 'known', existed: false },
      committed: committedOf(written),
      backup: first.backup,
      external_change: false,
      created_dirs: createdDirs,
    };
  }
  return {
    ...previous,
    committed: committedOf(written),
    backup: first.backup ?? previous.backup,
    external_change: previous.external_change || !isCommitted(previous, preimage),
    created_dirs: [...previous.created_dirs, ...createdDirs.filter((directory) => !previous.created_dirs.includes(directory))],
  };
}

/** An outside edit since rh's last write is recorded also when rh writes nothing now. */
function markExternalChange(files: Record<string, FileRecord>, path: string, preimage: ExpectedFile): boolean {
  const recorded = files[path];
  if (!recorded || recorded.external_change || isCommitted(recorded, preimage)) return false;
  files[path] = { ...recorded, external_change: true };
  return true;
}

/** True when the ledger does not already hold this fragment with this text. */
function fragmentChanges(fragment: PlannedFragment): boolean {
  return !fragment.previous || fragment.previous.edit.inserted !== fragment.edit.inserted;
}

/**
 * The fragment records of one file after its plan. A refresh of rh's own text
 * keeps the first record's removed text, so the ledger holds the text from
 * before rh. Text that rh did not write and now replaces (an override, or a
 * selected refresh over a user's change) goes to the vault first. A record
 * outside the plan keeps a proven offset only when the file still held the
 * committed bytes that the offset refers to.
 */
function fileFragments(paths: HostConfigPaths, plan: FilePlan, recorded: readonly FragmentRecord[], offsetsValid: boolean): FragmentRecord[] {
  const planned = plan.fragments.map(({ owner, selector, kind, edit, previous, resultAt }): FragmentRecord => {
    if (previous && previous.edit.inserted === edit.removed) return { ...previous, at: resultAt, edit: { ...previous.edit, inserted: edit.inserted } };
    const removed = kind === 'override' || previous ? { removed_vault: putVault(paths, Buffer.from(edit.removed, 'utf8')) } : { removed: edit.removed };
    return { file: plan.file, owner, selector, kind, at: resultAt, edit: { ...removed, inserted: edit.inserted } };
  });
  const replaced = new Set(plan.fragments.map((fragment) => fragment.previous));
  const edits = plan.fragments.map((fragment) => fragment.edit);
  const others = recorded.filter((entry) => !replaced.has(entry)).map((entry): FragmentRecord => ({
    ...entry,
    at: offsetsValid && entry.at !== null ? rebaseOffset(entry.at, entry.edit.inserted.length, edits) : null,
  }));
  return [...others, ...planned];
}

/** Each record reaches the ledger before its write, so every write has its record. */
function applyChanges(paths: HostConfigPaths, changes: readonly HostConfigFileChange[]): HostConfigApplyResult {
  const targets = admitPaths(paths, changes.map((change) => change.path));
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let fragments = ledger.fragments;
  const persist = () => writeLedger(paths, { protocol: 1, files, fragments });
  const skipped: SkippedOverride[] = [];
  const written: HostPath[] = [];
  for (const [index, change] of changes.entries()) {
    const path = targets[index]!;
    const { observation, bytes } = observeFile(path);
    const preimage = expectedOf(observation, path);
    const content = decode(bytes, path);
    const recorded = fragments.filter((entry) => entry.file === path);
    const plan = planFile(path, content, change.fragments, recorded);
    skipped.push(...plan.skipped);
    const unchanged = plan.result === content;
    // A fragment whose text is already in place is still recorded, but its file is not written.
    if (unchanged && !plan.fragments.some(fragmentChanges)) {
      if (markExternalChange(files, path, preimage)) persist();
      continue;
    }
    const previous = files[path];
    const before = fragments;
    const result = Buffer.from(plan.result, 'utf8');
    const createdDirs = unchanged ? [] : missingDirectories(path);
    fragments = [...fragments.filter((entry) => entry.file !== path), ...fileFragments(paths, plan, recorded, !previous || isCommitted(previous, preimage))];
    files[path] = nextFileRecord(previous, { kind: preimage.existed ? 'text_block' : 'created', backup: null, baselineUnknown: change.baselineUnknown === true },
      preimage, unchanged ? preimage : { existed: true, sha256: sha256Prefixed(result) }, createdDirs);
    persist();
    if (unchanged) continue;
    try {
      createDirectories(createdDirs);
      replaceTarget(path, result, preimage);
    } catch (error) {
      removeCreatedDirectories(createdDirs);
      fragments = before;
      if (previous) files[path] = previous; else delete files[path];
      persist();
      throw error;
    }
    written.push(path);
  }
  return { written, skipped };
}

function delegateWrite(paths: HostConfigPaths, declaredPaths: readonly string[], run: (destinations: readonly HostPath[]) => void): HostConfigDelegateResult {
  const targets = admitPaths(paths, declaredPaths);
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  const persist = () => writeLedger(paths, { ...ledger, files });
  const observed = targets.map((path) => {
    const previous = files[path];
    // A whole-file writer would replace rh's text blocks and the user's bytes around them with no record of either.
    if (previous?.kind === 'text_block') throw new HostConfigError('host_config_invalid_state', `rh text blocks are recorded in this file, so a delegated writer may not replace it: ${path}`);
    const { observation, bytes } = observeFile(path);
    const preimage = expectedOf(observation, path);
    // Bytes that rh did not write go to the vault before the writer may replace them.
    const backup = bytes !== null && (!previous || !isCommitted(previous, preimage)) ? putVault(paths, bytes) : null;
    const provisional = nextFileRecord(previous, { kind: preimage.existed ? 'replaced' : 'created', backup, baselineUnknown: false }, preimage, preimage, []);
    return { path, preimage, previous, provisional };
  });
  for (const { path, provisional } of observed) files[path] = provisional;
  persist();
  let failure: unknown = null;
  try { run(targets); } catch (error) { failure = error; }

  // Every change the writer made keeps its record, also when the writer failed; an unchanged path gets its old record back.
  const changed: HostPath[] = [];
  for (const { path, preimage, previous, provisional } of observed) {
    const result = expectedOf(observeFile(path).observation, path);
    if (!sameExpected(result, preimage)) {
      files[path] = { ...provisional, committed: committedOf(result) };
      changed.push(path);
    } else if (previous) {
      files[path] = previous;
      markExternalChange(files, path, preimage);
    } else {
      delete files[path];
    }
  }
  persist();
  if (failure !== null) throw failure;
  return { changed };
}

/** Undo each recorded edit at its recorded offset, last offset first; null when one is not where the ledger says. */
function revertTextBlocks(paths: HostConfigPaths, content: string, records: readonly FragmentRecord[]): string | null {
  let result = content;
  for (const entry of [...records].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))) {
    const { at, edit: { inserted } } = entry;
    if (at === null || result.slice(at, at + inserted.length) !== inserted) return null;
    const original = 'removed_vault' in entry.edit ? readVault(paths, entry.edit.removed_vault).toString('utf8') : entry.edit.removed;
    result = result.slice(0, at) + original + result.slice(at + inserted.length);
  }
  return result;
}

/**
 * rh reverts a file only while it still hashes to the committed bytes. A
 * created or replaced file also needs no external change: a later rh write
 * may have kept user bytes in it. Directories go after all files, so files
 * that share a created directory release it together.
 */
function revertFiles(paths: HostConfigPaths, only: readonly string[] | undefined): HostConfigRevertEntry[] {
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let fragments = ledger.fragments;
  const report: HostConfigRevertEntry[] = [];
  const createdDirs: string[] = [];
  const targets = only ? only.map((path) => resolveHostPath(paths, path)) : (Object.keys(ledger.files) as HostPath[]);
  for (const path of targets) {
    const record = files[path];
    if (!record) continue;
    const { observation, bytes } = observeFile(path);
    const current = expectedOf(observation, path);
    const drop = (action: HostConfigRevertEntry['action']) => {
      delete files[path];
      fragments = fragments.filter((entry) => entry.file !== path);
      report.push({ path, action });
    };
    const content = record.kind === 'text_block' && isCommitted(record, current)
      ? revertTextBlocks(paths, decode(bytes, path), fragments.filter((entry) => entry.file === path)) : null;
    if (content !== null) {
      const result = Buffer.from(content, 'utf8');
      if (result.equals(bytes!)) { drop('released'); continue; }
      replaceTarget(path, result, current);
      drop('text_removed');
    } else if (record.kind === 'text_block' || record.external_change || !isCommitted(record, current)) {
      report.push({ path, action: 'kept_edited' });
    } else if (record.kind === 'created') {
      if (current.existed) removeTarget(path, current);
      createdDirs.push(...record.created_dirs);
      drop('removed');
    } else {
      replaceTarget(path, readVault(paths, record.backup!), current);
      drop('restored');
    }
  }
  removeCreatedDirectories(createdDirs);
  writeLedger(paths, { protocol: 1, files, fragments });
  return report;
}

export function openHostConfigGate(options: HostConfigGateOptions = {}): HostConfigGate {
  const paths = hostConfigPaths(options.env ?? process.env);
  return {
    apply: (changes) => applyChanges(paths, changes),
    delegate: (declaredPaths, run) => delegateWrite(paths, declaredPaths, run),
    revert: (only) => revertFiles(paths, only),
  };
}
