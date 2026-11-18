import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { planFile, type FilePlan, type PlannedFragment } from '../../core/host-config/plan';
import { fileFormatOf, fragmentFormat, type FragmentFormat } from '../../core/host-config/registry';
import { isMarkedBlockSelector } from '../../core/host-config/marked-block';
import {
  HostConfigError,
  expectedFromCommitted,
  sameExpected,
  type ExpectedFile,
  type FileBaseline,
  type FileCommitted,
  type FileFormat,
  type FileRecord,
  type FileRecordKind,
  type FragmentEdit,
  type FragmentRecord,
  type FragmentRequest,
  type HostConfigBackupPolicy,
  EMPTY_LEDGER,
  type HostConfigLedger,
  type HostPath,
  type PathCommitted,
  type PathRecord,
  type RetiredMaterial,
  type Sha256,
  type SkippedOverride,
  type ToolId,
  type ToolRecord,
} from '../../core/host-config/types';
import { insertUserPathEntry, listsUserPathEntry, type UserPathPort } from '../../core/host-config/path-entry';
import {
  createDirectories,
  ensurePrivateDirectory,
  expectedOf,
  hostConfigPaths,
  hostConfigPathsAt,
  missingDirectories,
  observeFile,
  parseSnapshotLedger,
  hostPathKey,
  pathRecordOf,
  putVault,
  readLedger,
  readProjectedLedger,
  readVault,
  removeCreatedDirectories,
  removeTarget,
  replaceTarget,
  resolveHostPath,
  writeLedger,
  writeLedgerBytes,
  type HostConfigPaths,
} from './store';
import { isPathInside } from '../path-containment';
import { pathRecordEntry, pathRecordHost, pathRecordIsCurrent } from './path-records';
import {
  discardStagedEntry,
  hasPreimage,
  keepPreimage,
  observePathEntry,
  publishPathEntry,
  removePathEntry,
  restorePreimage,
  sameCommitted,
  stagePathEntry,
  type PathEntry,
} from './whole-path';
import { locatedText, observeDeclaredFragments, settleDelegatedFragments, type HostConfigFragmentDeclaration, type HostConfigUnattributedDiff } from './delegated';

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
  /** The path-record keys whose entry the writer changed, and the files whose declared fragment records changed. */
  readonly changed: readonly string[];
  /** The declared files that the writer changed outside their declared fragments. */
  readonly unattributed: readonly HostConfigUnattributedDiff[];
}

/** A whole path, the declared fragments of a shared host file (the `delegated` strategy, #2852), or a shared tool (#2853). */
export type HostConfigDelegateDeclaration = HostConfigPathDeclaration | HostConfigFragmentDeclaration | HostConfigToolDeclaration;

function isFragmentDeclaration(declaration: HostConfigDelegateDeclaration): declaration is HostConfigFragmentDeclaration {
  return 'selectors' in declaration;
}

function isToolDeclaration(declaration: HostConfigDelegateDeclaration): declaration is HostConfigToolDeclaration {
  return 'tool' in declaration;
}

/**
 * The entries of a shared tool in its install directory, outside the host
 * roots (#2853). The writer gets the directory, links followed. An entry that
 * the writer creates gets a tool record; a recorded entry that still held its
 * recorded bytes follows the writer; an entry that existed with no record is
 * never claimed.
 */
export interface HostConfigToolDeclaration {
  readonly tool: ToolId;
  readonly version: string;
  readonly directory: string;
  readonly entries: readonly string[];
}

/** A tool entry that is gone now, so its record goes (`releaseAbsentTools`). */
export interface HostConfigToolRevertEntry {
  readonly tool: ToolId;
  readonly path: string;
  readonly action: 'already_absent';
}

/** The label of the user PATH entry in a tool release. */
export const userPathLabel = (entry: string): string => `HKCU\\Environment\\Path: ${entry}`;

/** One whole entry for the gate to write at a host path, owned by `owner` (`core` or a plugin id). */
export interface HostConfigPathWrite {
  readonly path: string;
  readonly owner: string;
  readonly entry: PathEntry;
  /**
   * The user's word to replace a file that rh does not own (`--force`): the
   * gate keeps that file in the vault first and records `replaced`.
   */
  readonly replace?: boolean;
}

/** A host path that an out-of-process writer may write, owned by `owner`. */
export interface HostConfigPathDeclaration {
  readonly path: string;
  readonly owner: string;
  /** As in `HostConfigPathWrite`: the writer may replace a file that rh does not own. */
  readonly replace?: boolean;
  /**
   * The exact link target that makes an unrecorded link rh's: the gate adopts
   * the path only while no record names it and the link still holds this target.
   */
  readonly adopt?: string;
}

export interface HostConfigPathOptions {
  /**
   * The runtime transaction directory. Before the gate replaces or removes an
   * entry that rh owns, it keeps a copy here, so a rollback of the transaction
   * can put it back; the transaction deletes the directory at commit.
   */
  readonly transaction?: string;
}


export interface HostConfigRevertEntry {
  readonly path: string;
  /**
   * `released`: the file already equals its backup (rh's fragments were its
   * text), so only the records go. `already_absent`: the file is missing, so
   * only its records go. `kept_edited`: the file and its records stay because
   * the file is not as rh recorded it. `failed`: the reverted bytes would not
   * equal the known baseline, so nothing is written and every record and
   * vault copy stays.
   */
  readonly action: 'removed' | 'restored' | 'text_removed' | 'released' | 'already_absent' | 'kept_edited' | 'failed';
  /** The selectors of the fragments that stay in a kept file. */
  readonly kept?: readonly string[];
  /**
   * `proved`: the result was checked equal to the file before rh. `unknown`:
   * rh has no record of the file before it, so equality cannot be proved.
   */
  readonly baseline?: 'proved' | 'unknown';
  readonly code?: 'host_config_restore_mismatch';
}

/** A fragment that an earlier rh version wrote, as its old record names it. */
export interface AdoptedFragment {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentRecord['kind'];
  readonly inserted: string;
  readonly preimage?: string;
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
  /**
   * A dry run or a preview: the gate reads the ledger as the schema move would
   * leave it (`readProjectedLedger`), every revert is a dry run, and every
   * other write is refused.
   */
  readonly preview?: boolean;
}

/** The result of `removeEditedBlock`: the vault path of the whole-file copy; null in a dry run. */
export interface HostConfigBlockRemoval {
  readonly path: string;
  readonly selector: string;
  readonly recovery: string | null;
}

export interface HostConfigGate {
  apply(changes: readonly HostConfigFileChange[]): HostConfigApplyResult;
  /**
   * Write whole entries (a file, a link, a directory tree) and record each as
   * a path record before it is published. An existing path must be rh's (a
   * current record of the same owner); any other existing path is refused,
   * except a file under `replace`, which goes to the vault first.
   */
  writePaths(writes: readonly HostConfigPathWrite[], options?: HostConfigPathOptions): readonly string[];
  /**
   * Only for out-of-process writers: `run` gets one destination per
   * declaration, in order: the path-record key of a whole path (parent links
   * followed, leaf kept), and the file of a fragment declaration (links
   * followed). The gate keeps the files that `replace` lets the writer replace
   * in the vault before `run`, and records each entry that the writer changed
   * after it, and each adopted link also when the writer left it unchanged. A
   * changed path that rh did not own and that `replace` did not allow is
   * reported and not recorded. A fragment declaration records only the
   * declared fragments by `settleDelegatedFragments`; a change outside them is
   * returned in `unattributed` and marks the file `external_change`, so no
   * revert restores or removes the whole file. A failed `run` still gets its
   * records, so that a transaction rollback can undo them, and then throws.
   */
  delegate(declared: readonly HostConfigDelegateDeclaration[], run: (destinations: readonly string[]) => void, options?: HostConfigPathOptions): HostConfigDelegateResult;
  /**
   * Append `entry` to the user `Path` value for a tool that has a record,
   * unless an entry already lists it. The tool record gets the exact text
   * before the write; a failed write takes it out again.
   */
  addUserPathEntry(tool: ToolId, entry: string, port: UserPathPort): 'listed' | 'added';
  /**
   * Release each tool entry that is gone now: a file, link or tree that is
   * absent, a created directory that is absent, and, with `port`, a user PATH
   * entry that no entry of the value lists. A target that comes back later is
   * then not rh's. A dry run (or a preview gate) reports and writes nothing.
   */
  releaseAbsentTools(port: (() => UserPathPort) | null, options?: { readonly dryRun?: boolean }): readonly HostConfigToolRevertEntry[];
  /**
   * Undo the path records of the named paths, which the caller takes from the
   * records that may grant a removal (`readPathRecords`): a `created` entry goes
   * while it is current, a `replaced` file gets the user file back while it
   * still holds rh's bytes, and a `user_managed` record is released. A changed
   * entry stays with its record and is reported `kept_edited`.
   */
  revertPaths(paths: readonly string[], options?: HostConfigPathOptions): readonly HostConfigRevertEntry[];
  /**
   * The user's word that they keep each file in `kept`: its record becomes
   * `user_managed` with the file's current hash. Every other `user_managed`
   * record of a path in `scope` goes. `kept` must be inside `scope`.
   */
  keepUserPaths(owner: string, scope: readonly string[], kept: readonly string[]): void;
  /**
   * One-shot migration: rh's current file at `path` replaced the user file
   * `backup` before the ledger had path records. The backup goes to the vault
   * and the record becomes `replaced`. The path must have no record or a
   * current `created` record of `owner`.
   */
  adoptReplacedPath(path: string, owner: string, backup: Buffer): void;
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
  /**
   * Take out text that no fragment record names (a hook entry that an earlier
   * rh version wrote) from a file that hashes to `expectedSha256`. Each removal
   * gets the content after the removals before it and must return a pure
   * deletion of text in it. The file before goes to the vault as the record's
   * `external_backup`, and no fragment record is added: a revert never puts
   * the removed text back. The hash of the written file, or null when the
   * removals change nothing.
   */
  removeUnrecordedText(path: string, expectedSha256: Sha256, removals: readonly ((content: string) => FragmentEdit)[]): Sha256 | null;
  /** The fragment records of one path, its links followed. */
  recorded(path: string): readonly FragmentRecord[];
  /**
   * The user's word to take out the one recorded marked block of `path`, also
   * when the user edited it. The whole file goes to the vault as a recovery
   * copy, recorded before the write; GC never deletes it.
   */
  removeEditedBlock(path: string, options?: { readonly dryRun?: boolean }): HostConfigBlockRemoval;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The one strict UTF-8 reading of a host file: a planner that edits its text reads it the same way. */
export function decode(bytes: Buffer | null, path: string): string {
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

/**
 * An install owns the whole path of a path record (a skill, a link, a fleet
 * file); no gate operation acts on it until #2850 gives the gate that strategy.
 */
function refuseRecordedPaths(ledger: HostConfigLedger, targets: readonly HostPath[]): void {
  for (const target of targets) {
    const key = pathRecordOf(ledger, target);
    if (key !== null) throw new HostConfigError('host_config_invalid_state', `an install owns this whole path (${key}), so the gate does not write it: ${target}`);
  }
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
function nextFileRecord(previous: FileRecord | undefined, first: { kind: FileRecordKind; backup: Sha256 | null; baselineUnknown: boolean; format: FileFormat | undefined },
  preimage: ExpectedFile, written: ExpectedFile): FileRecord {
  const format = previous?.format ?? first.format;
  if (!previous) {
    return {
      kind: first.kind,
      baseline: first.baselineUnknown ? { state: 'unknown' }
        : preimage.existed ? { state: 'known', existed: true, sha256: preimage.sha256 } : { state: 'known', existed: false },
      committed: committedOf(written),
      backup: first.backup,
      external_change: false,
      ...(format ? { format } : {}),
    };
  }
  // The first backup stays the restore target; a later copy of an outside edit is kept apart for the report. A file
  // that rh adopted has no backup: its first copy, taken while it holds what rh recorded, becomes the restore target.
  const adopted = previous.backup === null && isCommitted(previous, preimage) ? first.backup : null;
  const externalBackup = adopted ? previous.external_backup : first.backup ?? previous.external_backup;
  return {
    ...previous,
    backup: previous.backup ?? adopted,
    committed: committedOf(written),
    ...(externalBackup ? { external_backup: externalBackup } : {}),
    external_change: previous.external_change || !isCommitted(previous, preimage),
    ...(format ? { format } : {}),
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

/**
 * The whole file goes to the vault before rh writes over bytes that rh did not
 * write. A file as rh recorded it needs no copy when its backup already holds
 * those bytes or when rh wrote all of it (`created`); an adopted file has
 * neither, so an edit that removes user bytes copies it.
 */
function backupUserBytes(paths: HostConfigPaths, previous: FileRecord | undefined, preimage: ExpectedFile, bytes: Buffer | null, removesUserBytes: boolean): Sha256 | null {
  if (bytes === null) return null;
  const copied = previous && isCommitted(previous, preimage) && (!removesUserBytes || previous.backup !== null || previous.kind === 'created');
  return copied ? null : putVault(paths, bytes);
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
    ...plan.fragments.map(({ owner, selector, kind, previous, text, created }): FragmentRecord => {
      const container = previous?.created ?? created;
      return { file: plan.file, owner, selector, kind: previous?.kind ?? kind, inserted: text, ...(container ? { created: container } : {}),
        ...(previous?.separator !== undefined ? { separator: previous.separator } : {}),
        ...(previous?.preimage !== undefined ? { preimage: previous.preimage } : {}) };
    }),
  ];
}

/** Each record reaches the ledger before its write, so every write has its record. */
function applyChanges(paths: HostConfigPaths, changes: readonly HostConfigFileChange[]): HostConfigApplyResult {
  const targets = admitPaths(paths, changes.map((change) => change.path));
  const ledger = readLedger(paths);
  const files = { ...ledger.files };
  let { fragments, directories } = ledger;
  refuseRecordedPaths(ledger, targets);
  const persist = () => writeLedger(paths, { ...ledger, files, fragments, directories });
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
    const removesUserBytes = !plan.fragments.every(keepsUserBytes);
    const backup = change.backup === 'overrides-only' && !removesUserBytes ? null : backupUserBytes(paths, previous, preimage, bytes, removesUserBytes);
    fragments = [...fragments.filter((entry) => entry.file !== path), ...fileFragments(plan, recorded)];
    directories = [...directories, ...createdDirs];
    files[path] = nextFileRecord(previous, { kind: preimage.existed ? 'text_block' : 'created', backup, baselineUnknown: change.baselineUnknown === true, format: fileFormatOf(change.path) },
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

// ---- whole paths --------------------------------------------------------

/** A path record key, the host that the install root names, and the record of another key whose directory holds it. */
function admitWholePath(env: NodeJS.ProcessEnv, paths: HostConfigPaths, ledger: HostConfigLedger, path: string): { key: string; host: PathRecord['host'] } {
  const key = hostPathKey(paths, path);
  const host = pathRecordHost(env, path);
  if (host === null) throw new HostConfigError('host_config_invalid_path', `not inside an install root, so rh records no whole path there: ${path}`);
  const holder = pathRecordOf(ledger, key as HostPath);
  if (holder !== null && toolOf(ledger, holder) !== null) throw new HostConfigError('host_config_invalid_state', `rh records this path for the tool ${toolOf(ledger, holder)}, so it does not write it as an install path: ${path}`);
  if (holder !== null && holder !== key) throw new HostConfigError('host_config_invalid_state', `the recorded directory ${holder} holds this path, so rh does not write it on its own: ${path}`);
  // A whole entry would replace rh's text blocks and the user's bytes around them with no record of either.
  if (ledger.files[key]?.kind === 'text_block') throw new HostConfigError('host_config_invalid_state', `rh text blocks are recorded in this file, so rh does not write it as a whole path: ${path}`);
  return { key, host };
}

/** True when the entry at the key is rh's to replace for `owner`: a current record of that owner that the user does not keep. */
function ownsEntry(record: PathRecord | undefined, owner: string, key: string): record is PathRecord {
  return record !== undefined && record.owner === owner && record.kind !== 'user_managed' && pathRecordIsCurrent(key, record);
}

function refusal(path: string, record: PathRecord | undefined, owner: string): HostConfigError {
  const reason = !record ? 'rh has no record of it' : record.owner !== owner ? `rh records it for ${record.owner}`
    : record.kind === 'user_managed' ? 'the user keeps it' : 'it changed since rh wrote it';
  return new HostConfigError('host_config_replacement_refused', `${reason}, so rh does not replace it: ${path}`);
}

/** The bytes of a user file that `replace` lets rh write over, in the vault; only a regular file qualifies. */
function vaultUserFile(paths: HostConfigPaths, entry: string, observed: PathCommitted, path: string): Sha256 {
  if (observed.type !== 'file') throw new HostConfigError('host_config_invalid_state', `only a file can be replaced on the user's word: ${path}`);
  return putVault(paths, readFileSync(entry));
}

/**
 * The file that a user link at the key names, when rh writes a file there: rh
 * follows the link, writes that file and keeps the link. A link that rh
 * recorded as its own entry is replaced as a link.
 */
function linkTargetOf(paths: HostConfigPaths, key: string, previous: PathRecord | undefined, entry: PathEntry): string | undefined {
  if (entry.type !== 'file' || previous?.committed.type === 'symlink' || !lstatSync(key, { throwIfNoEntry: false })?.isSymbolicLink()) return undefined;
  return resolveHostPath(paths, key);
}

function nextPathRecord(previous: PathRecord | undefined, owner: string, host: PathRecord['host'], observed: PathCommitted | null,
  committed: PathCommitted, backup: Sha256 | undefined, linkTarget?: string): PathRecord {
  const baseline = previous?.baseline ?? (observed === null ? { state: 'known' as const, existed: false as const }
    : observed.type === 'file' ? { state: 'known' as const, existed: true as const, sha256: observed.sha256 } : { state: 'unknown' as const });
  const kept = backup ?? (previous?.kind === 'replaced' ? previous.backup : undefined);
  return { owner, host, kind: kept ? 'replaced' : 'created', baseline, committed, ...(kept ? { backup: kept } : {}), ...(linkTarget ? { link_target: linkTarget } : {}) };
}

/** `validPathRecord` holds a `replaced` record to a file: the user file that it replaced comes back as a file. */
function assertReplacedIsFile(record: PathRecord, path: string): void {
  if (record.kind === 'replaced' && record.committed.type !== 'file') {
    throw new HostConfigError('host_config_invalid_state', `rh replaced a user file here, so it writes only a file at this path: ${path}`);
  }
}

/** Each record reaches the ledger before its entry is published, so every whole-path write has its record. */
function writeWholePaths(env: NodeJS.ProcessEnv, paths: HostConfigPaths, writes: readonly HostConfigPathWrite[], options: HostConfigPathOptions): string[] {
  const ledger = readLedger(paths);
  const records = { ...ledger.paths };
  let directories = ledger.directories;
  const persist = () => writeLedger(paths, { ...ledger, paths: records, directories });
  const admitted = writes.map((write) => ({ write, ...admitWholePath(env, paths, ledger, write.path) }));
  if (new Set(admitted.map(({ key }) => key)).size !== admitted.length) throw new HostConfigError('host_config_invalid_state', 'a call names one path twice');
  const written: string[] = [];
  for (const { write, key, host } of admitted) {
    const previous = records[key];
    const linkTarget = linkTargetOf(paths, key, previous, write.entry);
    const entry = linkTarget ?? key;
    // A record binds to its entry. When the key now reaches another file (a re-pointed link), the record does not
    // move with it: a replaced user file keeps its record and vault copy and stops the write; any other record starts again.
    const recorded = previous && pathRecordEntry(key, previous);
    if (previous?.kind === 'replaced' && recorded !== entry) {
      throw new HostConfigError('host_config_replacement_refused', `rh replaced the user file ${recorded} and keeps it in the vault, but this path now reaches ${entry}, so rh does not write it. Point it back to ${recorded}, then run the command again: ${write.path}`);
    }
    const prior = recorded === entry ? previous : undefined;
    const observed = observePathEntry(entry);
    let backup: Sha256 | undefined;
    if (observed !== null && !ownsEntry(prior, write.owner, key)) {
      if (!write.replace) throw refusal(write.path, prior, write.owner);
      backup = vaultUserFile(paths, entry, observed, write.path);
    }
    const createdDirs = missingDirectories(entry as HostPath);
    createDirectories(createdDirs);
    let staged: string | null = null;
    try {
      const stage = stagePathEntry(entry, write.entry);
      staged = stage.staged;
      const next = nextPathRecord(prior, write.owner, host, observed, stage.committed, backup, linkTarget);
      assertReplacedIsFile(next, write.path);
      if (sameCommitted(observed, stage.committed) && prior && JSON.stringify(prior) === JSON.stringify(next)) {
        discardStagedEntry(staged);
        continue;
      }
      if (backup === undefined && options.transaction) keepPreimage(options.transaction, entry);
      records[key] = next;
      directories = [...directories, ...createdDirs];
      persist();
      publishPathEntry(staged, entry);
      staged = null;
      written.push(key);
    } catch (error) {
      if (staged) discardStagedEntry(staged);
      if (previous) records[key] = previous; else delete records[key];
      directories = directories.filter((directory) => !createdDirs.includes(directory));
      removeCreatedDirectories(createdDirs);
      persist();
      throw error;
    }
  }
  return written;
}

/** A declared host file before the call: its bytes, and the declared selectors' text. */
interface DelegatedFile {
  readonly declaration: HostConfigFragmentDeclaration;
  readonly path: HostPath;
  readonly format: FileFormat | undefined;
  readonly preimage: ExpectedFile;
  readonly content: string | null;
  readonly observed: ReadonlyMap<string, string | null>;
}

function observeDelegatedFiles(paths: HostConfigPaths, ledger: HostConfigLedger, declared: readonly HostConfigFragmentDeclaration[]): DelegatedFile[] {
  const targets = declared.length ? admitPaths(paths, declared.map((declaration) => declaration.path)) : [];
  refuseRecordedPaths(ledger, targets);
  return declared.map((declaration, index) => {
    const path = targets[index]!;
    const { observation, bytes } = observeFile(path);
    const preimage = expectedOf(observation, path);
    const content = preimage.existed ? decode(bytes, path) : null;
    const format = ledger.files[path]?.format ?? fileFormatOf(declaration.path);
    return { declaration, path, format, preimage, content, observed: observeDeclaredFragments(path, format, content, declaration.selectors) };
  });
}

/**
 * The records of the declared files after the call. A file whose declared
 * fragments all go and that holds no other record loses its file record; the
 * file itself stays. A file with no record before and no fragment now gets
 * no record: rh claims nothing there.
 */
function settleDelegatedFiles(after: HostConfigLedger, observed: readonly DelegatedFile[]):
  { files: Record<string, FileRecord>; fragments: readonly FragmentRecord[]; changed: string[]; unattributed: HostConfigUnattributedDiff[]; released: Sha256[] } {
  const files = { ...after.files };
  let fragments = after.fragments;
  const changed: string[] = [];
  const unattributed: HostConfigUnattributedDiff[] = [];
  const released: Sha256[] = [];
  for (const { declaration, path, format, preimage, content, observed: declared } of observed) {
    const { observation, bytes } = observeFile(path);
    const now = expectedOf(observation, path);
    const recorded = fragments.filter((entry) => entry.file === path);
    let text: string | null = null;
    try { text = now.existed ? decode(bytes, path) : null; } catch (error) { if (!(error instanceof HostConfigError)) throw error; }
    const outcome = now.existed && text === null
      ? { fragments: recorded, unattributed: true }
      : settleDelegatedFragments({ path, owner: declaration.owner, fileFormat: format, before: content, after: text, observed: declared, recorded });
    if (outcome.unattributed) unattributed.push({ code: 'host_config_unattributed_diff', path, sha256: now.existed ? now.sha256 : null });
    const same = outcome.fragments.length === recorded.length && outcome.fragments.every((entry, index) => entry === recorded[index]);
    if (!same) changed.push(path);
    fragments = [...fragments.filter((entry) => entry.file !== path), ...outcome.fragments];
    const previous = files[path];
    if (!outcome.fragments.length) {
      if (previous && !same) { released.push(...materialOf(previous)); delete files[path]; }
      continue;
    }
    if (same && sameExpected(preimage, now) && !outcome.unattributed) continue;
    const next = nextFileRecord(previous, { kind: preimage.existed ? 'text_block' : 'created', backup: null, baselineUnknown: false, format }, preimage, now);
    files[path] = outcome.unattributed ? { ...next, external_change: true } : next;
  }
  return { files, fragments, changed, unattributed, released };
}

/**
 * The out-of-process form of `writeWholePaths`, with the declared fragments
 * of shared host files. Every destination is checked before `run`: an
 * existing entry must be rh's, an unrecorded link that holds the
 * declaration's `adopt` target, or a file under `replace`, which goes to the
 * vault first; a declared file must be one that its strategy reads; any other
 * destination stops the call before the writer runs. Records follow the
 * writer: a path that it did not change keeps the record that the ledger then
 * holds, so the writer's own record changes (a `user_managed` claim) stay; an
 * adopted link with no record then is recorded. The ledger is written once,
 * after `run`.
 */
function delegateWrites(env: NodeJS.ProcessEnv, paths: HostConfigPaths, declared: readonly HostConfigDelegateDeclaration[],
  run: (destinations: readonly string[]) => void, options: HostConfigPathOptions): HostConfigDelegateResult {
  const ledger = readLedger(paths);
  const wholes = declared.filter((declaration): declaration is HostConfigPathDeclaration => !isFragmentDeclaration(declaration) && !isToolDeclaration(declaration));
  const admitted = wholes.map((declaration) => ({ declaration, ...admitWholePath(env, paths, ledger, declaration.path) }));
  if (new Set(admitted.map(({ key }) => key)).size !== admitted.length) throw new HostConfigError('host_config_invalid_state', 'a call names one path twice');
  const delegatedFiles = observeDelegatedFiles(paths, ledger, declared.filter(isFragmentDeclaration));
  const tools = observeTools(paths, ledger, declared.filter(isToolDeclaration));
  const checked = admitted.map(({ declaration, key, host }) => {
    const previous = ledger.paths[key];
    const observed = observePathEntry(key);
    // Adoption needs the transaction's preimage: a failure must put the link back.
    const adopted = previous === undefined && options.transaction !== undefined && observed?.type === 'symlink'
      && declaration.adopt !== undefined && observed.target === declaration.adopt;
    const owned = observed === null || adopted || ownsEntry(previous, declaration.owner, key);
    if (!owned && !(declaration.replace && observed.type === 'file')) {
      throw observed.type === 'file' || !declaration.replace ? refusal(declaration.path, previous, declaration.owner)
        : new HostConfigError('host_config_invalid_state', `only a file can be replaced on the user's word: ${declaration.path}`);
    }
    return { declaration, key, host, previous, observed, owned, adopted };
  });
  const before = checked.map((entry) => {
    const backup = entry.owned ? undefined : putVault(paths, readFileSync(entry.key));
    if (entry.owned && options.transaction) keepPreimage(options.transaction, entry.key);
    return { ...entry, backup };
  });
  const keys = new Map(admitted.map(({ declaration, key }) => [declaration, key]));
  const files = new Map<HostConfigDelegateDeclaration, string>([
    ...delegatedFiles.map((file) => [file.declaration, file.path] as const),
    ...tools.map((tool) => [tool.declaration, tool.directory] as const),
  ]);
  let failure: unknown = null;
  try { run(declared.map((declaration) => keys.get(declaration as HostConfigPathDeclaration) ?? files.get(declaration)!)); } catch (error) { failure = error; }

  const after = readLedger(paths);
  const records = { ...after.paths };
  const changed: string[] = [];
  const invalid: string[] = [];
  for (const { declaration, key, host, previous, observed, owned, adopted, backup } of before) {
    const now = observePathEntry(key);
    if (adopted && failure !== null) {
      // No record names the link, so the transaction rollback does not see it: a failed writer leaves it as rh found it.
      if (!sameCommitted(now, observed)) restorePreimage(options.transaction!, key);
      continue;
    }
    if (sameCommitted(now, observed) && !(adopted && records[key] === undefined)) continue;
    // A failed replacement must keep the vault reference, also when the writer removed the entry.
    if ((backup !== undefined || previous?.kind === 'replaced') && now?.type !== 'file') {
      records[key] = backup !== undefined
        ? nextPathRecord(undefined, declaration.owner, host, observed, observed!, backup)
        : previous!;
      invalid.push(declaration.path);
      continue;
    }
    const next = now === null ? null : nextPathRecord(owned ? previous : undefined, declaration.owner, host, observed, now, backup);
    if (next === null) delete records[key]; else records[key] = next;
    changed.push(key);
  }
  const settled = settleDelegatedFiles(after, delegatedFiles);
  writeLedger(paths, { ...after, paths: records, files: settled.files, fragments: settled.fragments, retired: retire(after.retired, settled.released), tools: settleTools(after.tools, tools) });
  if (failure !== null) throw failure;
  if (invalid.length) throw new HostConfigError('host_config_invalid_state', `rh replaced a user file at these paths, but the delegated writer did not leave a file there: ${invalid.join(', ')}`);
  return { changed: [...changed, ...settled.changed], unattributed: settled.unattributed };
}

// ---- shared tools (#2853) -------------------------------------------------

/** The tool whose record holds the key. */
function toolOf(ledger: HostConfigLedger, key: string): ToolId | null {
  return (Object.entries(ledger.tools) as [ToolId, ToolRecord][]).find(([, record]) => key in record.paths)?.[0] ?? null;
}

interface ObservedTool {
  readonly declaration: HostConfigToolDeclaration;
  readonly directory: string;
  /** The directories that are missing before the writer runs, outermost first. */
  readonly missing: readonly string[];
  readonly before: ReadonlyMap<string, PathCommitted | null>;
}

function observeTools(paths: HostConfigPaths, ledger: HostConfigLedger, declared: readonly HostConfigToolDeclaration[]): ObservedTool[] {
  if (new Set(declared.map((declaration) => declaration.tool)).size !== declared.length) throw new HostConfigError('host_config_invalid_state', 'a call names one tool twice');
  return declared.map((declaration) => {
    const directory = resolveHostPath(paths, declaration.directory);
    const keys = declaration.entries.map((name) => join(directory, name));
    for (const key of keys) {
      const holder = pathRecordOf(ledger, key as HostPath) ?? (ledger.files[key] ? key : null);
      if (holder !== null && toolOf(ledger, holder) !== declaration.tool) throw new HostConfigError('host_config_invalid_state', `another ledger record owns this path, so rh does not install ${declaration.tool} there: ${key}`);
    }
    return { declaration, directory, missing: missingDirectories(join(directory, '_') as HostPath), before: new Map(keys.map((key) => [key, observePathEntry(key)])) };
  });
}

/**
 * The tool records after the writer: an entry that it created is recorded, a
 * recorded entry that held its recorded bytes before follows it, and every
 * other entry keeps the record that it had. A record with nothing left goes.
 */
function settleTools(current: HostConfigLedger['tools'], observed: readonly ObservedTool[]): HostConfigLedger['tools'] {
  const tools = { ...current };
  for (const { declaration, missing, before } of observed) {
    const previous = tools[declaration.tool];
    const recorded: Record<string, { committed: PathCommitted }> = { ...previous?.paths };
    let wrote = false;
    for (const [key, prior] of before) {
      const now = observePathEntry(key);
      const owned = prior === null || (recorded[key] !== undefined && sameCommitted(prior, recorded[key].committed));
      if (!owned || sameCommitted(prior, now)) continue;
      wrote = true;
      if (now === null) delete recorded[key]; else recorded[key] = { committed: now };
    }
    const directories = [...(previous?.directories ?? []), ...missing.filter((directory) => lstatSync(directory, { throwIfNoEntry: false })?.isDirectory())];
    if (!Object.keys(recorded).length && !previous?.path_entry) { delete tools[declaration.tool]; continue; }
    tools[declaration.tool] = {
      installed_by: 'rh-install', removable: true, ...previous,
      version: wrote || !previous ? declaration.version : previous.version,
      paths: recorded, directories: [...new Set(directories)],
    };
  }
  return tools;
}

function addUserPathEntry(paths: HostConfigPaths, tool: ToolId, entry: string, port: UserPathPort): 'listed' | 'added' {
  const ledger = readLedger(paths);
  const record = ledger.tools[tool];
  if (!record) throw new HostConfigError('host_config_invalid_state', `rh has no record of ${tool}, so it adds no PATH entry for it`);
  const value = port.read();
  if (listsUserPathEntry(value.raw, entry)) return 'listed';
  const { next, record: pathEntry } = insertUserPathEntry(value, entry);
  writeLedger(paths, { ...ledger, tools: { ...ledger.tools, [tool]: { ...record, path_entry: pathEntry } } });
  try { port.write(value, next); }
  catch (error) { writeLedger(paths, ledger); throw error; }
  return 'added';
}

function releaseAbsentTools(paths: HostConfigPaths, port: (() => UserPathPort) | null, dryRun: boolean, read: LedgerReader): HostConfigToolRevertEntry[] {
  const ledger = read(paths);
  const tools = { ...ledger.tools };
  const released: HostConfigToolRevertEntry[] = [];
  let user: UserPathPort | null = null;
  for (const [tool, record] of Object.entries(ledger.tools) as [ToolId, ToolRecord][]) {
    const gone = Object.keys(record.paths).filter((key) => observePathEntry(key) === null);
    const goneDirectories = record.directories.filter((directory) => !lstatSync(directory, { throwIfNoEntry: false }));
    user ??= record.path_entry && port ? port() : null;
    const goneEntry = record.path_entry !== undefined && user !== null && !listsUserPathEntry(user.read().raw, record.path_entry.entry);
    if (!gone.length && !goneDirectories.length && !goneEntry) continue;
    released.push(...[...gone, ...goneDirectories].map((path) => ({ tool, path, action: 'already_absent' as const })));
    if (goneEntry) released.push({ tool, path: userPathLabel(record.path_entry!.entry), action: 'already_absent' });
    const { path_entry: pathEntry, ...rest } = record;
    const kept = Object.fromEntries(Object.entries(record.paths).filter(([key]) => !gone.includes(key)));
    const keptEntry = goneEntry ? undefined : pathEntry;
    if (!Object.keys(kept).length && !keptEntry) delete tools[tool];
    else tools[tool] = { ...rest, paths: kept, directories: record.directories.filter((directory) => !goneDirectories.includes(directory)), ...(keptEntry ? { path_entry: keptEntry } : {}) };
  }
  if (!dryRun && released.length) writeLedger(paths, { ...ledger, tools });
  return released;
}

/**
 * The tool records after a rollback. A rollback does not undo a tool install,
 * and a record that a run released on observation (its target was absent) is
 * a fact, not an effect of the transaction: it never comes back. So a tool or
 * entry that the ledger no longer holds stays released, and an entry that it
 * holds stays only while the target holds those recorded bytes, or the bytes
 * recorded before the transaction. The user PATH entry stays as the ledger
 * holds it: the rollback does not undo the registry.
 */
function rollbackTools(before: HostConfigLedger['tools'], now: HostConfigLedger['tools']): HostConfigLedger['tools'] {
  const tools: Partial<Record<ToolId, ToolRecord>> = {};
  for (const [tool, record] of Object.entries(now) as [ToolId, ToolRecord][]) {
    const earlier = before[tool];
    if (JSON.stringify(earlier) === JSON.stringify(record)) { tools[tool] = record; continue; }
    const recorded: Record<string, { committed: PathCommitted }> = {};
    for (const [key, entry] of Object.entries(record.paths)) {
      const observed = observePathEntry(key);
      if (sameCommitted(observed, entry.committed)) recorded[key] = entry;
      else if (earlier?.paths[key] && sameCommitted(observed, earlier.paths[key].committed)) recorded[key] = earlier.paths[key];
    }
    if (!Object.keys(recorded).length && !record.path_entry) continue;
    tools[tool] = { ...record, paths: recorded, directories: record.directories.filter((directory) => lstatSync(directory, { throwIfNoEntry: false })) };
  }
  return tools;
}

function keepUserPaths(env: NodeJS.ProcessEnv, paths: HostConfigPaths, owner: string, scope: readonly string[], kept: readonly string[]): void {
  const ledger = readLedger(paths);
  const records = { ...ledger.paths };
  const inScope = new Map(scope.map((path) => { const admitted = admitWholePath(env, paths, ledger, path); return [admitted.key, admitted.host]; }));
  for (const key of inScope.keys()) if (records[key]?.kind === 'user_managed') delete records[key];
  for (const path of kept) {
    const key = hostPathKey(paths, path);
    const host = inScope.get(key);
    if (host === undefined) throw new HostConfigError('host_config_invalid_path', `a kept path must be inside the scope: ${path}`);
    const committed = observePathEntry(key);
    if (committed?.type !== 'file') throw new HostConfigError('host_config_invalid_state', `the user keeps only a file: ${path}`);
    records[key] = { owner, host, kind: 'user_managed', baseline: { state: 'unknown' }, committed };
  }
  writeLedger(paths, { ...ledger, paths: records });
}

function adoptReplacedPath(env: NodeJS.ProcessEnv, paths: HostConfigPaths, path: string, owner: string, backup: Buffer): void {
  const ledger = readLedger(paths);
  const { key, host } = admitWholePath(env, paths, ledger, path);
  const previous = ledger.paths[key];
  const committed = observePathEntry(key);
  if (committed?.type !== 'file') throw new HostConfigError('host_config_invalid_state', `only a file can have replaced a user file: ${path}`);
  if (previous && !(previous.kind === 'created' && ownsEntry(previous, owner, key))) throw refusal(path, previous, owner);
  const record: PathRecord = { owner, host, kind: 'replaced', baseline: previous?.baseline ?? { state: 'unknown' }, committed, backup: putVault(paths, backup) };
  writeLedger(paths, { ...ledger, paths: { ...ledger.paths, [key]: record } });
}

/**
 * The undo that a path record gets now, with no write: a caller that plans
 * from records that the ledger does not hold yet (a dry-run migration) uses
 * the same rule as `revertPaths`.
 */
export function planPathRevert(key: string, record: PathRecord): HostConfigRevertEntry['action'] {
  if (record.kind === 'user_managed') return 'released';
  // A missing entry ends the claim at this read: a file that appears later is not the one that rh wrote.
  if (observePathEntry(pathRecordEntry(key, record)) === null) return 'released';
  if (!pathRecordIsCurrent(key, record)) return 'kept_edited';
  return record.kind === 'replaced' ? 'restored' : 'removed';
}

/** One write of a revert and the ledger change that it makes. */
interface RevertStep {
  /**
   * `delete`: the write takes an entry or rh's added text away, so its claim
   * leaves the ledger before it. `restore`: the write gives the user's bytes
   * back, so its claim stays until it lands. `release`: no write; the claim
   * goes at once.
   */
  readonly kind: 'delete' | 'restore' | 'release';
  readonly write?: () => void;
  readonly commit: (ledger: HostConfigLedger) => HostConfigLedger;
}

/**
 * The order of every revert (P4, #2854). One durable ledger write takes out
 * each claim whose write deletes an entry or only takes out rh's added text
 * (#3227), and each release, before the first
 * write: a failure or a kill then leaves an entry with no claim, never a claim
 * without its entry, so a later run cannot delete an entry that the user put
 * back. The deletions run next. A restore keeps its claim and vault copy
 * until its write lands, so a failed restore can run again; each landed
 * restore reaches the ledger also when a later write fails. The caller writes
 * the returned ledger with its closing state.
 */
function retireThenDestroy(paths: HostConfigPaths, ledger: HostConfigLedger, steps: readonly RevertStep[]): HostConfigLedger {
  const early = steps.filter((step) => step.kind !== 'restore');
  let state = early.reduce((current, step) => step.commit(current), ledger);
  if (early.length) writeLedger(paths, state);
  for (const step of early) step.write?.();
  try {
    for (const step of steps.filter((entry) => entry.kind === 'restore')) {
      step.write!();
      state = step.commit(state);
    }
  } catch (error) {
    writeLedger(paths, state);
    throw error;
  }
  return state;
}

function revertWholePaths(paths: HostConfigPaths, only: readonly string[], options: HostConfigPathOptions): HostConfigRevertEntry[] {
  const ledger = readLedger(paths);
  const report: HostConfigRevertEntry[] = [];
  /** The entries of the dropped records: a created directory goes only with an entry inside it. */
  const dropped: string[] = [];
  const steps: RevertStep[] = [];
  for (const key of new Set(only.map((path) => hostPathKey(paths, path)))) {
    const record = ledger.paths[key];
    if (!record) continue;
    const action = planPathRevert(key, record);
    report.push({ path: key, action });
    if (action === 'kept_edited') continue;
    const entry = pathRecordEntry(key, record);
    dropped.push(entry);
    const commit = (state: HostConfigLedger): HostConfigLedger => {
      const { [key]: _gone, ...records } = state.paths;
      return { ...state, paths: records, retired: retire(state.retired, record.backup ? [record.backup] : []) };
    };
    if (action === 'released') { steps.push({ kind: 'release', commit }); continue; }
    steps.push({ kind: action === 'removed' ? 'delete' : 'restore', commit, write: () => {
      if (options.transaction) keepPreimage(options.transaction, entry);
      if (record.kind === 'replaced') {
        const committed = record.committed as Extract<PathCommitted, { type: 'file' }>;
        replaceTarget(entry as HostPath, readVault(paths, record.backup!), { existed: true, sha256: committed.sha256 });
      } else removePathEntry(entry);
    } });
  }
  const state = retireThenDestroy(paths, ledger, steps);
  const attempted = ledger.directories.filter((directory) => dropped.some((key) => isPathInside(directory, key)));
  const kept = removeCreatedDirectories(attempted);
  writeLedger(paths, { ...state, directories: state.directories.filter((directory) => !attempted.includes(directory) || kept.includes(directory)) });
  return report;
}

interface FragmentRevert {
  readonly content: string;
  readonly removed: readonly FragmentRecord[];
  readonly kept: readonly string[];
  /** Records that went with no edit, since their text was already at the inverse: the user changed the file there. */
  readonly atInverse: number;
  /** An edit set text back from the backup; with none, the revert only took out rh's added text. */
  readonly restored: boolean;
}

/**
 * The per-fragment rule: a fragment goes only while the text at its selector
 * is still byte-identical to what rh recorded. An `add` is taken out. An
 * override (or a selected refresh of text that rh never recorded) is set back
 * to its text in the backup, which holds the file before rh's first write
 * over the user's bytes and never changes; with no backup it stays. Every
 * other fragment stays. `all` holds every record of the file: a container
 * that a removal empties goes only when one of them proves that rh created it.
 */
function revertFragments(fileFormat: FileFormat | undefined, content: string, records: readonly FragmentRecord[], all: readonly FragmentRecord[], backup: string | null): FragmentRevert {
  const removed: FragmentRecord[] = [];
  const kept: string[] = [];
  let atInverse = 0;
  let restored = false;
  for (const record of records) {
    const format = fragmentFormat(fileFormat, record.selector);
    // A file that the strategy can no longer read keeps every fragment.
    const located = format ? locatedText(format, content, record.selector) : undefined;
    if (format && located !== undefined && isInverse(format, record, located, backup)) {
      // The text is already what the revert would leave: only the record goes.
      removed.push(record);
      atInverse += 1;
      continue;
    }
    const intact = format !== null && record.inserted !== '' && located === record.inserted;
    if (!format || !intact || (record.kind !== 'add' && backup === null)) {
      kept.push(record.selector);
      continue;
    }
    const edit = record.kind === 'add' ? format.remove(content, record.selector, all) : format.restore(content, record.selector, backup!, all);
    content = content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
    removed.push(record);
    restored ||= record.kind !== 'add';
  }
  return { content, removed, kept, atInverse, restored };
}

/**
 * The inverse of a fragment: no text for an `add`, and the selector's text in
 * the backup for any other kind. With no backup, or a backup that the strategy
 * cannot read, there is no proof.
 */
function isInverse(format: FragmentFormat, record: FragmentRecord, located: string | null, backup: string | null): boolean {
  if (record.kind === 'add') return located === null;
  if (backup === null) return false;
  const before = locatedText(format, backup, record.selector);
  return before !== undefined && before === located;
}

/** What a revert knows about one recorded file. */
export interface FileRevertInput {
  readonly path: string;
  /** The file record's format; absent on an older record, where the path's name gives it. */
  readonly format?: FileFormat;
  readonly kind: FileRecord['kind'];
  readonly hasBackup: boolean;
  readonly externalChange: boolean;
  /** The file hashes to the record's `committed`. */
  readonly committed: boolean;
  readonly existed: boolean;
  /** The requested path is there while the file that it names is missing: a link that dangles. */
  readonly requestedPresent?: boolean;
  /** The file's bytes; null when it is missing or not a regular file. */
  readonly bytes: Buffer | null;
  /** The bytes before rh, for the whole-file restore. */
  readonly backup: () => Buffer;
  /** The records that this revert takes out, after its filter. */
  readonly own: readonly FragmentRecord[];
  /** Every record of the file. */
  readonly all: readonly FragmentRecord[];
  readonly filtered: boolean;
  /** The file before rh; absent for a record that a migration has not written yet, which counts as unknown. */
  readonly baseline?: FileBaseline;
  /** The vault reference of `backup`. */
  readonly backupReference?: Sha256 | null;
}

export interface FileRevertPlan {
  readonly entry: HostConfigRevertEntry;
  /** `restores`: the write puts user bytes back; false when it only takes out rh's added text, which makes it a removal. */
  readonly write: { readonly kind: 'remove' } | { readonly kind: 'replace'; readonly content: Buffer; readonly restores: boolean } | null;
  /** `drop`: the file record goes; `update`: it stays and `committed` follows the write; `keep`: it stays as it is. */
  readonly record: 'drop' | 'update' | 'keep';
  readonly removed: readonly FragmentRecord[];
}

/**
 * The revert of one recorded file, with no read or write: `revert` carries it
 * out, and a dry run before a migration reports it for records not written yet.
 */
export function planFileRevert(input: FileRevertInput): FileRevertPlan {
  return checkBaseline(input, planRevertWrite(input));
}

/**
 * A whole-file restore needs a backup that is the file before rh: an
 * `overrides-only` file takes its backup at the first override, after rh may
 * have added to it, so it goes by the per-fragment rule. An unknown baseline
 * keeps the backup as the restore target (a migration's adopted state).
 */
function backupIsBaseline(input: FileRevertInput): boolean {
  const baseline = input.baseline;
  return baseline?.state !== 'known' || (baseline.existed && input.backupReference === baseline.sha256);
}

function planRevertWrite(input: FileRevertInput): FileRevertPlan {
  const { path, kind, own, all, filtered } = input;
  const format = input.format ?? fileFormatOf(path);
  // A dangling link is still there, so the file is not absent: it and its records stay.
  if (!input.existed && input.requestedPresent) return { entry: { path, action: 'kept_edited', kept: own.map((entry) => entry.selector) }, write: null, record: 'keep', removed: [] };
  if (!filtered && !input.existed) {
    return { entry: { path, action: 'already_absent' }, write: null, record: 'drop', removed: all };
  }
  if (!filtered && !input.externalChange && input.committed && (kind === 'created' || (input.hasBackup && backupIsBaseline(input)))) {
    if (kind === 'created') return { entry: { path, action: 'removed' }, write: { kind: 'remove' }, record: 'drop', removed: all };
    const backup = input.backup();
    if (input.bytes !== null && backup.equals(input.bytes)) return { entry: { path, action: 'released' }, write: null, record: 'drop', removed: all };
    return { entry: { path, action: 'text_removed' }, write: { kind: 'replace', content: backup, restores: true }, record: 'drop', removed: all };
  }
  if (!input.existed || input.bytes === null) return { entry: { path, action: 'kept_edited', kept: own.map((entry) => entry.selector) }, write: null, record: 'keep', removed: [] };
  const original = decode(input.bytes, path);
  const result = revertFragments(format, original, own, all, input.hasBackup ? decode(input.backup(), path) : null);
  const removed = new Set(result.removed);
  const remaining = all.filter((entry) => !removed.has(entry));
  const changed = result.content !== original;
  const content = Buffer.from(result.content, 'utf8');
  const withKept = (action: HostConfigRevertEntry['action']): HostConfigRevertEntry => result.kept.length ? { path, action, kept: result.kept } : { path, action };
  if (filtered || result.kept.length || remaining.length) {
    // The file keeps its record; `committed` follows the write, and an outside edit stays recorded.
    const action = result.kept.length || !removed.size ? 'kept_edited' : changed ? 'text_removed' : 'released';
    return { entry: withKept(action), write: changed ? { kind: 'replace', content, restores: result.restored } : null, record: changed ? 'update' : 'keep', removed: result.removed };
  }
  // A changed file with no fragment to take out (a created file) stays with its record.
  if (!removed.size && !(kind === 'text_block' && !input.hasBackup)) return { entry: withKept('kept_edited'), write: null, record: 'keep', removed: [] };
  // An empty created file goes only when this revert took out all of rh's text: a fragment that the user already took out proves the file is the user's now.
  const empty = kind === 'created' && result.atInverse === 0 && all.some((record) => fragmentFormat(format, record.selector)?.empty(result.content) === true);
  const write = empty ? { kind: 'remove' as const } : changed ? { kind: 'replace' as const, content, restores: result.restored } : null;
  return { entry: withKept(empty ? 'removed' : changed ? 'text_removed' : 'released'), write, record: 'drop', removed: result.removed };
}

/**
 * The check before a write (D1, #2851): when the baseline is known, the file
 * has no outside change and every fragment goes, the result must be the file
 * before rh, by hash or by absence. A mismatch writes nothing and keeps every
 * record. A filtered revert, an outside change or an unknown baseline proves
 * nothing about the baseline and is not checked.
 */
function checkBaseline(input: FileRevertInput, plan: FileRevertPlan): FileRevertPlan {
  const baseline = input.baseline;
  if (plan.record !== 'drop' || !input.existed) return plan;
  if (baseline?.state !== 'known') return { ...plan, entry: { ...plan.entry, baseline: 'unknown' } };
  if (input.filtered || input.externalChange || !input.committed) return plan;
  const result = plan.write === null ? input.bytes : plan.write.kind === 'remove' ? null : plan.write.content;
  const equal = baseline.existed ? result !== null && sha256Prefixed(result) === baseline.sha256 : result === null;
  if (equal) return { ...plan, entry: { ...plan.entry, baseline: 'proved' } };
  return { entry: { path: input.path, action: 'failed', code: 'host_config_restore_mismatch' }, write: null, record: 'keep', removed: [] };
}

/** The requested path itself is there, before its links are followed: lstat of the leaf. */
function requestedPresent(path: string): boolean {
  return lstatSync(resolve(path), { throwIfNoEntry: false }) !== undefined;
}

/**
 * The revert of the file that `adopt` would record now, with no write: a dry
 * run before a migration observes the file as `revert` does after it (links
 * followed, then lstat) and plans by the same rule, also for an absent file.
 */
export function planAdoptedRevert(env: NodeJS.ProcessEnv, path: string, adoption: HostConfigAdoption): HostConfigRevertEntry {
  const resolved = resolveHostPath(hostConfigPaths(env), path);
  const { observation, bytes } = observeFile(resolved);
  const records = adoption.fragments.map((fragment) => ({ file: resolved, ...fragment }));
  return planFileRevert({
    path: resolved, format: fileFormatOf(path), kind: adoption.kind ?? (adoption.backup === null ? 'created' : 'text_block'), hasBackup: adoption.backup !== null,
    externalChange: adoption.externalChange, committed: true, existed: expectedOf(observation, resolved).existed, requestedPresent: requestedPresent(path), bytes,
    backup: () => adoption.backup!, own: records, all: records, filtered: false,
  }).entry;
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
function revertFiles(paths: HostConfigPaths, only: readonly string[] | undefined, options: HostConfigRevertOptions, read: LedgerReader): HostConfigRevertEntry[] {
  const dryRun = options.dryRun === true;
  const filter: RevertFilter = { owner: options.owner, selectors: options.selectors };
  const filtered = filter.owner !== undefined || filter.selectors !== undefined;
  const ledger = read(paths);
  const report: HostConfigRevertEntry[] = [];
  const steps: RevertStep[] = [];
  const targets = only ? only.map((path) => resolveHostPath(paths, path)) : (Object.keys(ledger.files) as HostPath[]);
  refuseRecordedPaths(ledger, targets);
  const seen = new Set<string>();
  for (const [index, path] of targets.entries()) {
    const record = ledger.files[path];
    if (!record || seen.has(path)) continue;
    seen.add(path);
    const { observation, bytes } = observeFile(path);
    const current = expectedOf(observation, path);
    const all = ledger.fragments.filter((entry) => entry.file === path);
    const own = all.filter((entry) => matchesFilter(entry, filter));
    if (filtered && !own.length) continue;
    const plan = planFileRevert({
      path, format: record.format, kind: record.kind, hasBackup: record.backup !== null, externalChange: record.external_change, committed: isCommitted(record, current),
      existed: current.existed, requestedPresent: only !== undefined && requestedPresent(only[index]!), bytes, backup: () => readVault(paths, record.backup!), own, all, filtered,
      baseline: record.baseline, backupReference: record.backup,
    });
    report.push(plan.entry);
    const removed = new Set(plan.removed);
    const write = plan.write;
    const commit = (state: HostConfigLedger): HostConfigLedger => {
      const files = { ...state.files };
      if (plan.record === 'drop') delete files[path];
      else if (plan.record === 'update' && write?.kind === 'replace') {
        files[path] = { ...record, committed: { type: 'file', sha256: sha256Prefixed(write.content) }, external_change: record.external_change || !isCommitted(record, current) };
      }
      return { ...state, files, fragments: state.fragments.filter((entry) => !removed.has(entry)),
        retired: plan.record === 'drop' ? retire(state.retired, materialOf(record)) : state.retired };
    };
    steps.push(write === null ? { kind: 'release', commit }
      : write.kind === 'remove' ? { kind: 'delete', commit, write: () => removeTarget(path, current) }
        : { kind: write.restores ? 'restore' : 'delete', commit, write: () => replaceTarget(path, write.content, current) });
  }
  if (dryRun) return report;
  const state = retireThenDestroy(paths, ledger, steps);
  const attempted = filtered ? [] : only ? ledger.directories.filter((directory) => targets.some((path) => isPathInside(directory, path))) : ledger.directories;
  const kept = removeCreatedDirectories(attempted);
  writeLedger(paths, { ...state, directories: state.directories.filter((directory) => !attempted.includes(directory) || kept.includes(directory)) });
  return report;
}

/** The vault copies that a file record holds. */
function materialOf(record: FileRecord): Sha256[] {
  return [record.backup, record.external_backup].filter((reference): reference is Sha256 => typeof reference === 'string');
}

/** Retire released vault copies now; a copy retired before restarts its 30 days. */
function retire(retired: readonly RetiredMaterial[], released: readonly Sha256[]): RetiredMaterial[] {
  if (!released.length) return [...retired];
  const at = new Date().toISOString();
  const fresh = [...new Set(released)];
  return [...retired.filter((entry) => !fresh.includes(entry.sha256)), ...fresh.map((sha256) => ({ sha256, at }))];
}

function adoptFile(paths: HostConfigPaths, target: string, adoption: HostConfigAdoption): 'adopted' | 'recorded' {
  const [path] = admitPaths(paths, [target]) as [HostPath];
  const ledger = readLedger(paths);
  refuseRecordedPaths(ledger, [path]);
  if (ledger.files[path]) return 'recorded';
  const current = expectedOf(observeFile(path).observation, path);
  const kind = adoption.kind ?? (adoption.backup === null ? 'created' : 'text_block');
  if (kind === 'created' && adoption.backup !== null) throw new HostConfigError('host_config_invalid_state', `a created file has no backup: ${path}`);
  const format = fileFormatOf(target);
  const record: FileRecord = {
    kind,
    baseline: { state: 'unknown' },
    committed: committedOf(current),
    backup: adoption.backup === null ? null : putVault(paths, adoption.backup),
    external_change: adoption.externalChange,
    ...(format ? { format } : {}),
  };
  const fragments = adoption.fragments.map((fragment) => ({ file: path, ...fragment }));
  writeLedger(paths, { ...ledger, files: { ...ledger.files, [path]: record }, fragments: [...ledger.fragments, ...fragments] });
  return 'adopted';
}

/**
 * A file with no record gets `text_block` with an unknown baseline and no
 * backup, so a revert releases it. A recorded file keeps its backup, which
 * may still hold the removed text, so it is marked `external_change` and a
 * revert takes out rh's fragments one by one instead of restoring that backup.
 */
function removeUnrecordedText(paths: HostConfigPaths, target: string, expectedSha256: Sha256, removals: readonly ((content: string) => FragmentEdit)[]): Sha256 | null {
  const [path] = admitPaths(paths, [target]) as [HostPath];
  const ledger = readLedger(paths);
  refuseRecordedPaths(ledger, [path]);
  const { observation, bytes } = observeFile(path);
  const preimage = expectedOf(observation, path);
  if (!preimage.existed || preimage.sha256 !== expectedSha256) {
    throw new HostConfigError('host_config_invalid_state', `the file changed since rh planned its removal, so rh writes nothing to it: ${path}`);
  }
  const content = decode(bytes, path);
  let result = content;
  for (const removal of removals) {
    const edit = removal(result);
    if (edit.inserted !== '' || result.slice(edit.at, edit.at + edit.removed.length) !== edit.removed) {
      throw new HostConfigError('host_config_invalid_state', `a removal must only take out text that is in the file, so rh writes nothing to it: ${path}`);
    }
    result = result.slice(0, edit.at) + result.slice(edit.at + edit.removed.length);
  }
  if (result === content) return null;
  const written = Buffer.from(result, 'utf8');
  const committed: FileCommitted = { type: 'file', sha256: sha256Prefixed(written) };
  const external_backup = putVault(paths, bytes!);
  const previous = ledger.files[path];
  const record: FileRecord = previous ? { ...previous, committed, external_backup, external_change: true }
    : { kind: 'text_block', baseline: { state: 'unknown' }, committed, backup: null, external_backup, external_change: false };
  writeLedger(paths, { ...ledger, files: { ...ledger.files, [path]: record } });
  try {
    replaceTarget(path, written, preimage);
  } catch (error) {
    writeLedger(paths, ledger);
    throw error;
  }
  return committed.sha256;
}

/** The entries that a transaction rollback could not prove, as `<path>: <selector>`. */
export interface HostConfigRollbackResult {
  readonly unresolved: readonly string[];
}

const fragmentKey = (record: FragmentRecord): string => `${record.owner}\0${record.selector}`;

/**
 * The rollback of the gate writes of one install transaction, from the ledger
 * as it was before the transaction (`snapshot`, null when there was none), and
 * the transaction directory that holds the path preimages (`transaction`). It
 * writes the host files and then the ledger: the snapshot's records, except
 * the path record of each entry that it cannot undo, which stays so that the
 * entry keeps its owner.
 * For each file whose records changed, an intact fragment goes back to its
 * state before the transaction: to its snapshot text after a refresh, to its
 * adopted text when the transaction adopted it, out when the transaction
 * added it, and to its backup text when the transaction overrode a user
 * value. A file of which the transaction took a whole copy goes back to that
 * copy first. A file that the transaction created goes only when the file did not
 * exist before it and still holds exactly what it wrote. A file whose
 * unrecorded text the transaction removed (a new `external_backup` and no
 * fragment change) gets its record before the transaction only when the
 * caller already put the file back to that backup; otherwise the record
 * stays. A file record that the transaction dropped stays dropped with its
 * fragments and the retirement of its vault copies (P4, #3227): this rollback
 * does not undo a file revert, so a claim from the snapshot would have no text
 * on disk. Every other entry stays and is returned.
 */
export function rollbackHostConfigTransaction(harness: string, snapshot: Buffer | null, transaction: string): HostConfigRollbackResult {
  const paths = hostConfigPathsAt(harness);
  const before = snapshot === null ? EMPTY_LEDGER : parseSnapshotLedger(snapshot, `${paths.ledger} (transaction snapshot)`);
  const now = readLedger(paths);
  const unresolved: string[] = [];
  const releasedFiles = new Set(Object.keys(before.files).filter((path) => !now.files[path]));
  const files = Object.fromEntries(Object.entries(before.files).filter(([path]) => !releasedFiles.has(path)));
  const releasedMaterial = new Set([...releasedFiles].flatMap((path) => materialOf(before.files[path]!)));
  for (const path of Object.keys(now.files) as HostPath[]) {
    const record = now.files[path]!;
    const previous = before.files[path];
    const all = now.fragments.filter((entry) => entry.file === path);
    const earlier = before.fragments.filter((entry) => entry.file === path);
    const changed = all.filter((entry) => earlier.find((old) => fragmentKey(old) === fragmentKey(entry))?.inserted !== entry.inserted);
    const dropped = earlier.filter((old) => !all.some((entry) => fragmentKey(entry) === fragmentKey(old)));
    unresolved.push(...dropped.map((old) => `${path}: ${old.selector}`));
    if (!changed.length && !dropped.length && record.external_backup && record.external_backup !== previous?.external_backup) {
      const current = expectedOf(observeFile(path).observation, path);
      if (!current.existed || current.sha256 !== record.external_backup) {
        files[path] = record;
        unresolved.push(path);
      }
      continue;
    }
    if (!changed.length) continue;
    const { observation, bytes } = observeFile(path);
    const current = expectedOf(observation, path);
    if (bytes === null || !isCommitted(record, current)) {
      unresolved.push(...changed.map((entry) => `${path}: ${entry.selector}`));
      continue;
    }
    // The bytes before an override in this transaction: the copy that it took of an outside edit, or the first backup.
    const source = previous && record.external_backup !== previous.external_backup ? record.external_backup : record.backup;
    const backup = source ? decode(readVault(paths, source), path) : null;
    // A whole-file copy that this transaction took holds every byte that its later writes changed, also outside the
    // fragments (a legacy migration): the file goes back to it, and only a fragment that it still shows as written,
    // by an earlier write of this transaction, gets its own edit.
    const copy = !previous || record.backup !== previous.backup ? record.backup
      : record.external_backup !== previous.external_backup ? record.external_backup ?? null : null;
    let content = decode(copy ? readVault(paths, copy) : bytes, path);
    const fileFormat = record.format ?? fileFormatOf(path);
    for (const entry of [...changed].reverse()) {
      const format = fragmentFormat(fileFormat, entry.selector);
      const range = format?.strategy.locate(content, entry.selector) ?? null;
      const old = earlier.find((candidate) => fragmentKey(candidate) === fragmentKey(entry));
      if (copy && (!range || content.slice(range.start, range.end) !== entry.inserted)) continue;
      if (!format || !range || content.slice(range.start, range.end) !== entry.inserted || (!old && entry.preimage === undefined && entry.kind !== 'add' && backup === null)) {
        unresolved.push(`${path}: ${entry.selector}`);
        continue;
      }
      const edit: FragmentEdit = old ? { at: range.start, removed: entry.inserted, inserted: old.inserted }
        : entry.preimage !== undefined ? { at: range.start, removed: entry.inserted, inserted: entry.preimage }
          : entry.kind === 'add' ? format.remove(content, entry.selector, all)
            : format.restore(content, entry.selector, backup!, all);
      content = content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
    }
    const created = !previous && record.kind === 'created' && record.baseline.state === 'known' && record.baseline.existed === false;
    if (created && all.some((entry) => fragmentFormat(fileFormat, entry.selector)?.empty(content) === true)) removeTarget(path, current);
    else if (content !== decode(bytes, path)) replaceTarget(path, Buffer.from(content, 'utf8'), current);
  }
  const pathRecords = rollbackWholePaths(paths, before, now, transaction, unresolved);
  const kept = removeCreatedDirectories(now.directories.filter((directory) => !before.directories.includes(directory)));
  const restored: HostConfigLedger = { ...before, files, fragments: before.fragments.filter((entry) => !releasedFiles.has(entry.file)),
    retired: [...before.retired.filter((entry) => !releasedMaterial.has(entry.sha256)), ...now.retired.filter((entry) => releasedMaterial.has(entry.sha256))], paths: pathRecords, directories: [...before.directories, ...kept], tools: rollbackTools(before.tools, now.tools) };
  // No ledger before the transaction and no record left: the ledger file goes, as it was.
  if (snapshot === null && JSON.stringify(restored) === JSON.stringify(EMPTY_LEDGER)) rmSync(paths.ledger, { force: true });
  // A clean rollback puts the snapshot back as it was: a parent of an older protocol reads its ledger again.
  else if (snapshot !== null && JSON.stringify(restored) === JSON.stringify(before)) writeLedgerBytes(paths, snapshot);
  else writeLedger(paths, restored);
  return { unresolved };
}

/**
 * The path records after a rollback. A path that the transaction wrote goes
 * back to its entry before the transaction: out when it was absent, the user
 * file from the vault when the transaction replaced one, and the transaction's
 * preimage when it refreshed or removed rh's entry. An entry that is no longer
 * what the transaction recorded stays with that record, and is returned.
 */
function rollbackWholePaths(paths: HostConfigPaths, before: HostConfigLedger, now: HostConfigLedger, transaction: string, unresolved: string[]): Record<string, PathRecord> {
  const records: Record<string, PathRecord> = { ...before.paths };
  for (const key of new Set([...Object.keys(before.paths), ...Object.keys(now.paths)])) {
    const old = before.paths[key];
    const current = now.paths[key];
    // A linked record acts on the file that its link names, also for the transaction's preimage.
    const at = pathRecordEntry(key, (current ?? old)!);
    if (JSON.stringify(old) === JSON.stringify(current) && !hasPreimage(transaction, at)) continue;
    // A claim or release of a file that the user keeps changes no entry.
    if (current?.kind === 'user_managed' || (!current && old?.kind === 'user_managed')) continue;
    if (!current) {
      const entry = observePathEntry(at);
      // A revert in this transaction took the record out: the entry is gone, or it is the user file that came back from the vault.
      const reverted = entry === null || (old!.kind === 'replaced' && entry.type === 'file' && entry.sha256 === old!.backup);
      if (reverted && hasPreimage(transaction, at)) restorePreimage(transaction, at);
      // A claim released on observation is a fact, not an effect of this transaction: it stays released (P4).
      else if (entry === null) delete records[key];
      else if (!pathRecordIsCurrent(key, old!)) unresolved.push(key);
      continue;
    }
    if (!pathRecordIsCurrent(key, current)) { records[key] = current; unresolved.push(key); continue; }
    if (current.kind === 'replaced' && current.backup !== old?.backup) {
      const committed = current.committed as Extract<PathCommitted, { type: 'file' }>;
      replaceTarget(at as HostPath, readVault(paths, current.backup!), { existed: true, sha256: committed.sha256 });
    } else if (!old && !hasPreimage(transaction, at)) removePathEntry(at);
    // A link that this transaction adopted has a preimage of itself, so it comes back; a created entry has an absent preimage.
    else if (hasPreimage(transaction, at)) restorePreimage(transaction, at);
    else { records[key] = current; unresolved.push(key); }
  }
  return records;
}

type LedgerReader = (paths: HostConfigPaths) => HostConfigLedger;

/**
 * The one recorded marked block of the file goes, with no check of its text.
 * The recovery copy and its record reach the vault and the ledger before the
 * write; a failed write puts the other records back and keeps the copy.
 */
function removeEditedBlock(paths: HostConfigPaths, target: string, dryRun: boolean, read: LedgerReader): HostConfigBlockRemoval {
  const path = dryRun ? resolveHostPath(paths, target) : admitPaths(paths, [target])[0]!;
  const ledger = read(paths);
  refuseRecordedPaths(ledger, [path]);
  const record = ledger.files[path];
  const blocks = ledger.fragments.filter((entry) => entry.file === path && isMarkedBlockSelector(entry.selector));
  if (!record || blocks.length !== 1) throw new HostConfigError('host_config_invalid_state', `rh records no single marked block in this file: ${path}`);
  const block = blocks[0]!;
  const { observation, bytes } = observeFile(path);
  if (bytes === null) throw new HostConfigError('host_config_invalid_state', `not a regular file: ${path}`);
  const content = decode(bytes, path);
  const format = fragmentFormat(record.format ?? fileFormatOf(path), block.selector)!;
  // An unbalanced block throws here, before any copy or write.
  if (!format.strategy.locate(content, block.selector)) throw new HostConfigError('host_config_invalid_state', `the recorded block is not in the file: ${path}`);
  const all = ledger.fragments.filter((entry) => entry.file === path);
  const edit = format.remove(content, block.selector, all);
  const result = Buffer.from(content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length), 'utf8');
  if (dryRun) return { path, selector: block.selector, recovery: null };
  const copy = putVault(paths, bytes);
  const at = new Date().toISOString();
  const fragments = ledger.fragments.filter((entry) => entry !== block);
  const files = { ...ledger.files };
  const remains = fragments.some((entry) => entry.file === path);
  if (remains) files[path] = { ...record, committed: { type: 'file', sha256: sha256Prefixed(result) } };
  else delete files[path];
  const recovery = [...ledger.recovery, { file: path, sha256: copy, at }];
  writeLedger(paths, { ...ledger, files, fragments, recovery, retired: remains ? [...ledger.retired] : retire(ledger.retired, materialOf(record)) });
  try { replaceTarget(path, result, expectedOf(observation, path)); }
  catch (error) {
    writeLedger(paths, { ...ledger, recovery });
    throw error;
  }
  return { path, selector: block.selector, recovery: join(paths.vault, copy.slice('sha256:'.length)) };
}

function refusePreview(): never {
  throw new HostConfigError('host_config_invalid_state', 'a preview gate writes nothing');
}

export function openHostConfigGate(options: HostConfigGateOptions = {}): HostConfigGate {
  const env = options.env ?? process.env;
  const paths = hostConfigPaths(env);
  const preview = options.preview === true;
  const read: LedgerReader = preview ? readProjectedLedger : readLedger;
  const recorded = (path: string) => {
    const resolved = resolveHostPath(paths, path);
    return read(paths).fragments.filter((entry) => entry.file === resolved);
  };
  if (preview) {
    return {
      apply: refusePreview, writePaths: refusePreview, delegate: refusePreview, revertPaths: refusePreview, addUserPathEntry: refusePreview,
      releaseAbsentTools: (port) => releaseAbsentTools(paths, port, true, read),
      keepUserPaths: refusePreview, adoptReplacedPath: refusePreview, adopt: refusePreview, removeUnrecordedText: refusePreview,
      revert: (only, revertOptions) => revertFiles(paths, only, { ...revertOptions, dryRun: true }, read),
      removeEditedBlock: (path) => removeEditedBlock(paths, path, true, read),
      recorded,
    };
  }
  return {
    apply: (changes) => applyChanges(paths, changes),
    writePaths: (writes, pathOptions) => writeWholePaths(env, paths, writes, pathOptions ?? {}),
    delegate: (declared, run, pathOptions) => delegateWrites(env, paths, declared, run, pathOptions ?? {}),
    addUserPathEntry: (tool, entry, port) => addUserPathEntry(paths, tool, entry, port),
    releaseAbsentTools: (port, releaseOptions) => releaseAbsentTools(paths, port, releaseOptions?.dryRun === true, read),
    revertPaths: (only, revertOptions) => revertWholePaths(paths, only, revertOptions ?? {}),
    keepUserPaths: (owner, scope, kept) => keepUserPaths(env, paths, owner, scope, kept),
    adoptReplacedPath: (path, owner, backup) => adoptReplacedPath(env, paths, path, owner, backup),
    revert: (only, revertOptions) => revertFiles(paths, only, revertOptions ?? {}, read),
    adopt: (path, adoption) => adoptFile(paths, path, adoption),
    removeUnrecordedText: (path, expectedSha256, removals) => removeUnrecordedText(paths, path, expectedSha256, removals),
    recorded,
    removeEditedBlock: (path, removeOptions) => removeEditedBlock(paths, path, removeOptions?.dryRun === true, read),
  };
}
