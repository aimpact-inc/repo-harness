import { sha256Prefixed } from '../../core/evidence/sha256';
import { planFile, type FilePlan, type PlannedFragment } from '../../core/host-config/plan';
import { fragmentFormat } from '../../core/host-config/registry';
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
  type HostConfigBackupPolicy,
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
import { isPathInside } from '../path-containment';

export interface HostConfigFileChange {
  readonly path: string;
  readonly fragments: readonly FragmentRequest[];
  /** An earlier rh version wrote this path before the ledger existed. */
  readonly baselineUnknown?: boolean;
  /** Default `whole-file`. */
  readonly backup?: HostConfigBackupPolicy;
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
   * `released`: the file already equals its backup (rh's fragments were its
   * text), so only the records go. `kept_edited`: the file is not as rh recorded it, so the file
   * and its record stay.
   */
  readonly action: 'removed' | 'restored' | 'text_removed' | 'released' | 'kept_edited';
  /** The selectors of the fragments that stay in a kept file. */
  readonly kept?: readonly string[];
}

/** A fragment that an earlier rh version wrote, as its old record names it. */
export interface AdoptedFragment {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentRecord['kind'];
  readonly inserted: string;
}

/**
 * One-shot migration of a file that an earlier rh version wrote before the
 * ledger existed. `backup` is the file before rh, rebuilt from the old record.
 * The kind is `created` when `backup` is null, unless the migration names
 * `text_block` for a file that rh only added to and keeps no copy of.
 */
export interface HostConfigAdoption {
  readonly kind?: 'created' | 'text_block';
  readonly backup: Buffer | null;
  readonly fragments: readonly AdoptedFragment[];
  readonly externalChange: boolean;
}

export interface HostConfigRevertOptions {
  /** Report what the revert would do and write nothing. */
  readonly dryRun?: boolean;
  /** Take out only the fragments of this owner; the file records stay. */
  readonly owner?: string;
  /** Take out only the fragments at these selectors; the file records stay. */
  readonly selectors?: readonly string[];
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
  /**
   * Undo rh's recorded writes, for the named paths or for all; a path without
   * a record is not touched. With an owner or selector filter, only the
   * matching fragments go, by the per-fragment rule.
   */
  revert(paths?: readonly string[], options?: HostConfigRevertOptions): readonly HostConfigRevertEntry[];
  /**
   * Record a file that has no record, with `baseline.state: unknown` and
   * `committed` set to the current file. It writes no host file. A path that
   * already has a record keeps it (`recorded`), so a migration can run again.
   */
  adopt(path: string, adoption: HostConfigAdoption): 'adopted' | 'recorded';
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
  preimage: ExpectedFile, written: ExpectedFile): FileRecord {
  if (!previous) {
    return {
      kind: first.kind,
      baseline: first.baselineUnknown ? { state: 'unknown' }
        : preimage.existed ? { state: 'known', existed: true, sha256: preimage.sha256 } : { state: 'known', existed: false },
      committed: committedOf(written),
      backup: first.backup,
      external_change: false,
    };
  }
  return {
    ...previous,
    committed: committedOf(written),
    backup: first.backup ?? previous.backup,
    external_change: previous.external_change || !isCommitted(previous, preimage),
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
  return !fragment.previous || fragment.previous.inserted !== fragment.text;
}

/** True when the edit replaces no bytes, or only the text that rh recorded at the selector. */
function keepsUserBytes(fragment: PlannedFragment): boolean {
  return fragment.edit.removed === '' || fragment.previous?.inserted === fragment.edit.removed;
}

/** The whole file goes to the vault before rh writes over bytes that rh did not write. */
function backupUserBytes(paths: HostConfigPaths, previous: FileRecord | undefined, preimage: ExpectedFile, bytes: Buffer | null): Sha256 | null {
  return bytes !== null && (!previous || !isCommitted(previous, preimage)) ? putVault(paths, bytes) : null;
}

/**
 * The fragment records of one file after its plan: a planned fragment replaces
 * the record of its owner and selector. The first kind stays, so a refresh of
 * an `add` is still removable by the per-fragment revert.
 */
function fileFragments(plan: FilePlan, recorded: readonly FragmentRecord[]): FragmentRecord[] {
  const replaced = new Set(plan.fragments.map((fragment) => fragment.previous));
  return [
    ...recorded.filter((entry) => !replaced.has(entry)),
    ...plan.fragments.map(({ owner, selector, kind, previous, text }) => ({ file: plan.file, owner, selector, kind: previous?.kind ?? kind, inserted: text })),
  ];
}

/** Each record reaches the ledger before its write, so every write has its record. */
function applyChanges(paths: HostConfigPaths, changes: readonly HostConfigFileChange[]): HostConfigApplyResult {
  const targets = admitPaths(paths, changes.map((change) => change.path));
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let { fragments, directories } = ledger;
  const persist = () => writeLedger(paths, { protocol: 1, files, fragments, directories });
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
    const before = { fragments, directories };
    const result = Buffer.from(plan.result, 'utf8');
    const createdDirs = unchanged ? [] : missingDirectories(path);
    const backup = change.backup === 'overrides-only' && plan.fragments.every(keepsUserBytes) ? null : backupUserBytes(paths, previous, preimage, bytes);
    fragments = [...fragments.filter((entry) => entry.file !== path), ...fileFragments(plan, recorded)];
    directories = [...directories, ...createdDirs];
    files[path] = nextFileRecord(previous, { kind: preimage.existed ? 'text_block' : 'created', backup, baselineUnknown: change.baselineUnknown === true },
      preimage, unchanged ? preimage : { existed: true, sha256: sha256Prefixed(result) });
    persist();
    if (unchanged) continue;
    try {
      createDirectories(createdDirs);
      replaceTarget(path, result, preimage);
    } catch (error) {
      removeCreatedDirectories(createdDirs);
      ({ fragments, directories } = before);
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
    const backup = backupUserBytes(paths, previous, preimage, bytes);
    const provisional = nextFileRecord(previous, { kind: preimage.existed ? 'replaced' : 'created', backup, baselineUnknown: false }, preimage, preimage);
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

interface FragmentRevert {
  readonly content: string;
  readonly removed: readonly FragmentRecord[];
  readonly kept: readonly string[];
}

/**
 * The per-fragment rule: a fragment goes only when rh added it (its first
 * kind is `add`) and the text at its selector is still byte-identical to what
 * rh recorded; every other fragment stays. An override is never restored here,
 * because the vault may hold rh's earlier text instead of the user's value.
 */
function revertFragments(path: string, content: string, records: readonly FragmentRecord[]): FragmentRevert {
  const format = fragmentFormat(path);
  const removed: FragmentRecord[] = [];
  const kept: string[] = [];
  for (const record of records) {
    const range = format?.strategy.locate(content, record.selector) ?? null;
    if (!format || record.kind !== 'add' || record.inserted === '' || !range || content.slice(range.start, range.end) !== record.inserted) {
      kept.push(record.selector);
      continue;
    }
    const edit = format.remove(content, record.selector);
    content = content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
    removed.push(record);
  }
  return { content, removed, kept };
}

interface RevertFilter {
  readonly owner?: string;
  readonly selectors?: readonly string[];
}

function matchesFilter(record: FragmentRecord, filter: RevertFilter): boolean {
  return (filter.owner === undefined || record.owner === filter.owner) && (filter.selectors === undefined || filter.selectors.includes(record.selector));
}

/**
 * A file that hashes to `committed` with no external change and a backup (or
 * that rh created) reverts as a whole: the backup, or no file, is exactly the
 * state before rh, whatever the order of rh's edits. Any other file, and every
 * file under an owner or selector filter, goes by the per-fragment rule; the
 * file keeps its record while a fragment of it stays. Created directories go
 * after all files, only in an unfiltered revert; a directory that still holds
 * content keeps its record for a later revert.
 */
function revertFiles(paths: HostConfigPaths, only: readonly string[] | undefined, options: HostConfigRevertOptions): HostConfigRevertEntry[] {
  const dryRun = options.dryRun === true;
  const filter: RevertFilter = { owner: options.owner, selectors: options.selectors };
  const filtered = filter.owner !== undefined || filter.selectors !== undefined;
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let fragments = ledger.fragments;
  const report: HostConfigRevertEntry[] = [];
  const targets = only ? only.map((path) => resolveHostPath(paths, path)) : (Object.keys(ledger.files) as HostPath[]);
  for (const path of targets) {
    const record = files[path];
    if (!record) continue;
    const { observation, bytes } = observeFile(path);
    const current = expectedOf(observation, path);
    const own = fragments.filter((entry) => entry.file === path && matchesFilter(entry, filter));
    if (filtered && !own.length) continue;
    const whole = !filtered && !record.external_change && isCommitted(record, current) && (record.kind === 'created' || record.backup !== null);
    if (whole) {
      let action: HostConfigRevertEntry['action'];
      if (record.kind === 'created') {
        if (current.existed && !dryRun) removeTarget(path, current);
        action = 'removed';
      } else {
        const backup = readVault(paths, record.backup!);
        if (bytes !== null && backup.equals(bytes)) action = 'released';
        else {
          if (!dryRun) replaceTarget(path, backup, current);
          action = record.kind === 'replaced' ? 'restored' : 'text_removed';
        }
      }
      delete files[path];
      fragments = fragments.filter((entry) => entry.file !== path);
      report.push({ path, action });
      continue;
    }
    if (!current.existed || bytes === null) {
      report.push({ path, action: 'kept_edited', kept: own.map((entry) => entry.selector) });
      continue;
    }
    const result = revertFragments(path, decode(bytes, path), own);
    const removed = new Set(result.removed);
    const remaining = fragments.filter((entry) => entry.file === path && !removed.has(entry));
    const empty = record.kind === 'created' && fragmentFormat(path)?.empty(result.content) === true;
    let action: HostConfigRevertEntry['action'];
    if (filtered || result.kept.length || remaining.length) {
      // The file keeps its record; `committed` follows the write, and an outside edit stays recorded.
      if (removed.size && !dryRun) replaceTarget(path, Buffer.from(result.content, 'utf8'), current);
      if (removed.size) {
        files[path] = { ...record, committed: { type: 'file', sha256: sha256Prefixed(Buffer.from(result.content, 'utf8')) },
          external_change: record.external_change || !isCommitted(record, current) };
      }
      action = result.kept.length || !removed.size ? 'kept_edited' : 'text_removed';
    } else {
      if (!dryRun) {
        if (empty) removeTarget(path, current);
        else if (removed.size) replaceTarget(path, Buffer.from(result.content, 'utf8'), current);
      }
      delete files[path];
      action = empty ? 'removed' : removed.size ? 'text_removed' : record.kind === 'text_block' && record.backup === null ? 'released' : 'kept_edited';
      if (action === 'kept_edited') files[path] = record;
    }
    fragments = fragments.filter((entry) => !removed.has(entry));
    report.push(result.kept.length ? { path, action, kept: result.kept } : { path, action });
  }
  if (dryRun) return report;
  const attempted = filtered ? [] : only ? ledger.directories.filter((directory) => targets.some((path) => isPathInside(directory, path))) : ledger.directories;
  const kept = removeCreatedDirectories(attempted);
  const directories = ledger.directories.filter((directory) => !attempted.includes(directory) || kept.includes(directory));
  writeLedger(paths, { protocol: 1, files, fragments, directories });
  return report;
}

function adoptFile(paths: HostConfigPaths, target: string, adoption: HostConfigAdoption): 'adopted' | 'recorded' {
  const [path] = admitPaths(paths, [target]) as [HostPath];
  const ledger = readLedger(paths);
  if (ledger.files[path]) return 'recorded';
  const current = expectedOf(observeFile(path).observation, path);
  const kind = adoption.kind ?? (adoption.backup === null ? 'created' : 'text_block');
  if (kind === 'created' && adoption.backup !== null) throw new HostConfigError('host_config_invalid_state', `a created file has no backup: ${path}`);
  const record: FileRecord = {
    kind,
    baseline: { state: 'unknown' },
    committed: committedOf(current),
    backup: adoption.backup === null ? null : putVault(paths, adoption.backup),
    external_change: adoption.externalChange,
  };
  const fragments = adoption.fragments.map((fragment) => ({ file: path, ...fragment }));
  writeLedger(paths, { ...ledger, files: { ...ledger.files, [path]: record }, fragments: [...ledger.fragments, ...fragments] });
  return 'adopted';
}

export function openHostConfigGate(options: HostConfigGateOptions = {}): HostConfigGate {
  const paths = hostConfigPaths(options.env ?? process.env);
  return {
    apply: (changes) => applyChanges(paths, changes),
    delegate: (declaredPaths, run) => delegateWrite(paths, declaredPaths, run),
    revert: (only, revertOptions) => revertFiles(paths, only, revertOptions ?? {}),
    adopt: (path, adoption) => adoptFile(paths, path, adoption),
  };
}
