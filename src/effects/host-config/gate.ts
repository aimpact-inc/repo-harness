import { sha256Prefixed } from '../../core/evidence/sha256';
import { planFile, type FilePlan, type PlannedFragment } from '../../core/host-config/plan';
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
  /** `kept_edited`: the user changed rh's bytes, so the file and its record stay. */
  readonly action: 'removed' | 'restored' | 'text_removed' | 'kept_edited';
}

export interface HostConfigGateOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export interface HostConfigGate {
  apply(changes: readonly HostConfigFileChange[]): HostConfigApplyResult;
  /**
   * Only for out-of-process writers: `run` gets the destinations with links
   * followed and may write them; the gate backs up the user files first and
   * records each change after.
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

/** The first record of a path fixes its kind, baseline and backup; later writes update `committed`. */
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
    external_change: previous.external_change || !sameExpected(preimage, expectedFromCommitted(previous.committed)),
    created_dirs: [...previous.created_dirs, ...createdDirs.filter((directory) => !previous.created_dirs.includes(directory))],
  };
}

/** An outside edit since rh's last write is recorded also when rh writes nothing now. */
function markExternalChange(files: Record<string, FileRecord>, path: string, preimage: ExpectedFile): boolean {
  const recorded = files[path];
  if (!recorded || recorded.external_change || sameExpected(preimage, expectedFromCommitted(recorded.committed))) return false;
  files[path] = { ...recorded, external_change: true };
  return true;
}

/** True when the ledger does not already hold this fragment with this text. */
function fragmentChanges(fragment: PlannedFragment): boolean {
  return !fragment.previous || fragment.previous.edit.inserted !== fragment.edit.inserted;
}

/**
 * The fragment records of one plan. A refresh keeps the first record's kind
 * and removed text, so the ledger always holds the text from before rh. A new
 * override backs up the replaced user text in the vault; the caller runs this
 * before the file write.
 */
function planRecords(paths: HostConfigPaths, plan: FilePlan): { replaced: Set<FragmentRecord>; added: FragmentRecord[] } {
  const replaced = new Set<FragmentRecord>();
  const added = plan.fragments.map(({ owner, selector, kind, edit, previous }): FragmentRecord => {
    if (previous) {
      replaced.add(previous);
      return { ...previous, edit: { ...previous.edit, inserted: edit.inserted } };
    }
    const removed = kind === 'override' ? { removed_vault: putVault(paths, Buffer.from(edit.removed, 'utf8')) } : { removed: edit.removed };
    return { file: plan.file, owner, selector, kind, edit: { ...removed, inserted: edit.inserted } };
  });
  return { replaced, added };
}

function applyChanges(paths: HostConfigPaths, changes: readonly HostConfigFileChange[]): HostConfigApplyResult {
  const targets = admitPaths(paths, changes.map((change) => change.path));
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let fragments = ledger.fragments;
  const skipped: SkippedOverride[] = [];
  const written: HostPath[] = [];
  let changed = false;
  const record = ({ replaced, added }: ReturnType<typeof planRecords>) => {
    fragments = [...fragments.filter((entry) => !replaced.has(entry)), ...added];
  };
  try {
    for (const [index, change] of changes.entries()) {
      const path = targets[index]!;
      const { observation, bytes } = observeFile(path);
      const preimage = expectedOf(observation, path);
      const content = decode(bytes, path);
      const plan = planFile(path, content, change.fragments, ledger.fragments);
      skipped.push(...plan.skipped);
      // A fragment whose text is already in place is still recorded, but its file is not written.
      if (plan.result === content) {
        changed = markExternalChange(files, path, preimage) || changed;
        if (plan.fragments.some(fragmentChanges)) { record(planRecords(paths, plan)); changed = true; }
        continue;
      }
      const records = planRecords(paths, plan);
      const createdDirs = createDirectories(path);
      const result = Buffer.from(plan.result, 'utf8');
      try { replaceTarget(path, result, preimage); }
      catch (error) { removeCreatedDirectories(createdDirs); throw error; }
      files[path] = nextFileRecord(ledger.files[path], { kind: preimage.existed ? 'text_block' : 'created', backup: null, baselineUnknown: change.baselineUnknown === true },
        preimage, { existed: true, sha256: sha256Prefixed(result) }, createdDirs);
      record(records);
      written.push(path);
      changed = true;
    }
  } finally {
    // Every write that happened gets its record, also when a later file fails.
    if (changed) writeLedger(paths, { protocol: 1, files, fragments });
  }
  return { written, skipped };
}

function delegateWrite(paths: HostConfigPaths, declaredPaths: readonly string[], run: (destinations: readonly HostPath[]) => void): HostConfigDelegateResult {
  const targets = admitPaths(paths, declaredPaths);
  const before = readLedger(paths);
  const observed = targets.map((path) => {
    const { observation, bytes } = observeFile(path);
    // Back up the user's bytes before the writer may replace them; a recorded path keeps its first backup.
    const backup = bytes !== null && !before.files[path] ? putVault(paths, bytes) : null;
    return { path, preimage: expectedOf(observation, path), backup };
  });
  let failure: unknown = null;
  try { run(targets); } catch (error) { failure = error; }

  // Every change the writer made gets its record, also when the writer failed.
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  const changed: HostPath[] = [];
  let externalChange = false;
  for (const { path, preimage, backup } of observed) {
    const result = expectedOf(observeFile(path).observation, path);
    if (sameExpected(result, preimage)) { externalChange = markExternalChange(files, path, preimage) || externalChange; continue; }
    changed.push(path);
    files[path] = nextFileRecord(ledger.files[path], { kind: preimage.existed ? 'replaced' : 'created', backup, baselineUnknown: false }, preimage, result, []);
  }
  if (changed.length > 0 || externalChange) writeLedger(paths, { ...ledger, files });
  if (failure !== null) throw failure;
  return { changed };
}

/** Remove each rh text block that is still as rh wrote it; return the content and the records whose text was not found once. */
function removeTextBlocks(paths: HostConfigPaths, content: string, records: readonly FragmentRecord[]): { content: string; kept: FragmentRecord[] } {
  const kept: FragmentRecord[] = [];
  let result = content;
  for (const entry of [...records].reverse()) {
    const { inserted } = entry.edit;
    const at = result.indexOf(inserted);
    if (inserted === '' || at < 0 || result.indexOf(inserted, at + 1) >= 0) { kept.push(entry); continue; }
    const original = 'removed_vault' in entry.edit ? readVault(paths, entry.edit.removed_vault).toString('utf8') : entry.edit.removed;
    result = result.slice(0, at) + original + result.slice(at + inserted.length);
  }
  return { content: result, kept };
}

function revertFiles(paths: HostConfigPaths, only: readonly string[] | undefined): HostConfigRevertEntry[] {
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let fragments = ledger.fragments;
  const report: HostConfigRevertEntry[] = [];
  const targets = only ? only.map((path) => resolveHostPath(paths, path)) : (Object.keys(ledger.files) as HostPath[]);
  for (const path of targets) {
    const record = ledger.files[path];
    if (!record) continue;
    const { observation, bytes } = observeFile(path);
    const current = expectedOf(observation, path);
    const own = fragments.filter((entry) => entry.file === path);
    const drop = (action: HostConfigRevertEntry['action']) => {
      delete files[path];
      fragments = fragments.filter((entry) => entry.file !== path);
      report.push({ path, action });
    };
    if (record.kind === 'text_block') {
      const { content, kept } = removeTextBlocks(paths, decode(bytes, path), own);
      const result = Buffer.from(content, 'utf8');
      if (bytes !== null && !result.equals(bytes)) replaceTarget(path, result, current);
      if (kept.length === 0) { drop('text_removed'); continue; }
      fragments = fragments.filter((entry) => entry.file !== path || kept.includes(entry));
      files[path] = { ...record, committed: bytes === null ? { type: 'absent' } : { type: 'file', sha256: sha256Prefixed(result) } };
      report.push({ path, action: 'kept_edited' });
    } else if (!sameExpected(current, expectedFromCommitted(record.committed))) {
      report.push({ path, action: 'kept_edited' });
    } else if (record.kind === 'created') {
      if (current.existed) removeTarget(path, current);
      removeCreatedDirectories(record.created_dirs);
      drop('removed');
    } else {
      if (record.backup === null) throw new HostConfigError('host_config_invalid_state', `a replaced file has no backup: ${path}`);
      replaceTarget(path, readVault(paths, record.backup), current);
      drop('restored');
    }
  }
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
