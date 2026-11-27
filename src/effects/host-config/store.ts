import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { sha256Hex, sha256Prefixed } from '../../core/evidence/sha256';
import {
  EMPTY_LEDGER,
  HOST_CONFIG_LEDGER_PROTOCOL,
  HostConfigError,
  matchesExpected,
  type ExpectedFile,
  type FileObservation,
  type HostConfigLedger,
  type HostPath,
  type PathRecord,
  type Sha256,
} from '../../core/host-config/types';
import { publishFileByRename, retryWindowsSharingRace } from '../atomic-append';
import { adoptedIdentity, observeEntryIdentity } from './whole-path';
import { ensureSelfIgnoringDirectory } from '../self-ignoring-directory';
import { globalConfigurationPath } from '../configuration/global-configuration';
import { isPathInside } from '../path-containment';
import {
  isIdentity, isObject, isSha, isText, PATH_RECORD_HOSTS, validBaseline, validDirectoryIdentities,
  validPathCommitted, validRetirement, validTextRecords, validUserPathEntry,
} from './ledger-validation';

/** Storage beside the global configuration file: `~/.repo-harness/config/`. */
export interface HostConfigPaths {
  /** `~/.repo-harness/` with links followed: no host target may lie inside it. */
  readonly harness: string;
  readonly root: string;
  readonly ledger: string;
  readonly vault: string;
}

function invalidState(message: string): HostConfigError {
  return new HostConfigError('host_config_invalid_state', message);
}

/** Bounds a chain of dangling links, as the kernel bounds a link chain. */
const MAX_LINK_HOPS = 40;

/**
 * Follow the user's links: `realpathSync.native` of the deepest existing
 * ancestor, plus the missing tail. A dangling link is followed to the path it
 * names, where the write then creates the file.
 */
function followLinks(path: string, hops = 0): string {
  const missing: string[] = [];
  let current = path;
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  try { return join(realpathSync.native(current), ...missing); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || hops >= MAX_LINK_HOPS) throw error;
    return followLinks(join(resolve(dirname(current), readlinkSync(current)), ...missing), hops + 1);
  }
}

export function hostConfigPaths(env: NodeJS.ProcessEnv): HostConfigPaths {
  return hostConfigPathsAt(followLinks(dirname(globalConfigurationPath(env))));
}

/** The host-config layout under one `~/.repo-harness` directory, links already followed. */
export function hostConfigPathsAt(harness: string): HostConfigPaths {
  const root = join(harness, 'config');
  return { harness, root, ledger: join(root, 'ledger.json'), vault: join(root, 'vault') };
}

/** The one boundary for a host path: links followed, and refused inside `~/.repo-harness/`. */
export function resolveHostPath(paths: HostConfigPaths, path: unknown): HostPath {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new HostConfigError('host_config_invalid_path', `not an absolute path: ${String(path)}`);
  const resolved = followLinks(resolve(path));
  if (isPathInside(paths.harness, resolved)) throw new HostConfigError('host_config_invalid_path', `rh does not write host configuration inside ${paths.harness}: ${path}`);
  return resolved as HostPath;
}

/**
 * The key of a path record: the parent chain with links followed and the leaf
 * kept, the entry that a removal acts on. A recorded skill link stays the link,
 * not the package directory that it names.
 */
export function hostPathKey(paths: HostConfigPaths, path: string): string {
  if (!isAbsolute(path)) throw new HostConfigError('host_config_invalid_path', `not an absolute path: ${path}`);
  const absolute = resolve(path);
  const key = join(followLinks(dirname(absolute)), basename(absolute));
  if (isPathInside(paths.harness, key)) throw new HostConfigError('host_config_invalid_path', `rh records no host path inside ${paths.harness}: ${path}`);
  return key;
}

/** The path record or tool path that owns a gate target: the same entry, or a recorded directory above it. */
export function pathRecordOf(ledger: HostConfigLedger, target: HostPath): string | null {
  const owned = [...Object.entries(ledger.paths), ...Object.values(ledger.tools).flatMap((tool) => Object.entries(tool!.paths))];
  for (const [key, record] of owned) {
    if (key === target || (record.committed.type === 'directory' && isPathInside(key, target))) return key;
  }
  return null;
}

export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function observeFile(path: string): { readonly observation: FileObservation; readonly bytes: Buffer | null } {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { observation: { existed: false }, bytes: null };
  if (stat.isSymbolicLink()) return { observation: { existed: true, type: 'symlink' }, bytes: null };
  if (stat.isDirectory()) return { observation: { existed: true, type: 'directory' }, bytes: null };
  if (!stat.isFile()) return { observation: { existed: true, type: 'other' }, bytes: null };
  const bytes = readFileSync(path);
  return { observation: { existed: true, type: 'file', sha256: sha256Prefixed(bytes) }, bytes };
}

export function expectedOf(observation: FileObservation, path: string): ExpectedFile {
  if (!observation.existed) return { existed: false };
  if (observation.type !== 'file') throw invalidState(`not a regular file: ${path}`);
  return { existed: true, sha256: observation.sha256 };
}

/**
 * Replace the target by a `wx` temporary file beside it and a rename. The
 * target must still match `expected` right before the rename, so rh never
 * overwrites a change that it did not see. An existing file keeps its mode.
 * A transaction can observe the staged entry's identity before it is published.
 */
export function replaceTarget(path: HostPath, bytes: Buffer, expected: ExpectedFile, temporary = `${path}.${randomUUID()}.tmp`,
  observeStaged?: (staged: string) => void): void {
  const mode = lstatSync(path, { throwIfNoEntry: false })?.mode ?? 0o600;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength) throw invalidState(`partial write: ${path}`);
      fchmodSync(fd, mode & 0o777);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    observeStaged?.(temporary);
    if (!matchesExpected(observeFile(path).observation, expected)) {
      throw new HostConfigError('host_config_target_changed', `the target changed before the write: ${path}`);
    }
    retryWindowsSharingRace(() => renameSync(temporary, path));
  } finally { rmSync(temporary, { force: true }); }
}

export function removeTarget(path: HostPath, expected: ExpectedFile): void {
  if (!matchesExpected(observeFile(path).observation, expected)) {
    throw new HostConfigError('host_config_target_changed', `the target changed before the removal: ${path}`);
  }
  retryWindowsSharingRace(() => unlinkSync(path));
}

/** The missing ancestors of the target, outermost first. */
export function missingDirectories(path: HostPath): string[] {
  const missing: string[] = [];
  for (let current = dirname(path); !lstatSync(current, { throwIfNoEntry: false }); current = dirname(current)) missing.unshift(current);
  return missing;
}

export function createDirectories(directories: readonly string[]): void {
  for (const directory of directories) mkdirSync(directory, { mode: 0o700 });
}

export interface RemoveCreatedDirectoriesOptions {
  /** Recorded `observeEntryIdentity` for created directories; when present for a directory, it must match before `rmdir`. */
  readonly identities?: Readonly<Record<string, string>>;
  /** Directories for which a matching recorded identity is required before `rmdir` (an absent identity preserves the directory). */
  readonly requireIdentity?: (directory: string) => boolean;
}

/** Remove the directories rh created, innermost first, and return those that still hold other content. */
export function removeCreatedDirectories(
  directories: readonly string[],
  options: RemoveCreatedDirectoriesOptions = {},
): string[] {
  const kept: string[] = [];
  for (const directory of [...new Set(directories)].sort((a, b) => b.length - a.length)) {
    const expected = options.identities?.[directory];
    const required = options.requireIdentity?.(directory) === true;
    if (expected !== undefined || required) {
      const stat = lstatSync(directory, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isDirectory() || expected === undefined || observeEntryIdentity(directory) !== expected) {
        // Different file-system object (or unproved when identity is required): preserve it and release the dead claim.
        continue;
      }
    }
    try { rmdirSync(directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') kept.push(directory);
      else if (code !== 'ENOENT') throw error;
    }
  }
  return kept;
}

// ---- ledger -------------------------------------------------------------

export function validPathRecord(record: unknown): record is PathRecord {
  if (!isObject(record) || !isText(record.owner) || record.owner === '' || !PATH_RECORD_HOSTS.includes(record.host as string)
    || !validBaseline(record.baseline) || !validPathCommitted(record.committed)) return false;
  if (record.identity !== undefined && !(isIdentity(record.identity) && record.kind !== 'user_managed' && !(isObject(record.committed) && 'proof' in record.committed))) return false;
  const file = isObject(record.committed) && record.committed.type === 'file';
  // A user link at the key: rh acts on the file that it names, which only a created or replaced file record does.
  if (record.link_target !== undefined && !(isText(record.link_target) && isAbsolute(record.link_target) && file && record.kind !== 'user_managed')) return false;
  if (record.kind === 'replaced') return file && isSha(record.backup);
  return record.backup === undefined && (record.kind === 'created' || (record.kind === 'user_managed' && file));
}

export function readLedger(paths: HostConfigPaths): HostConfigLedger {
  const { observation, bytes } = observeFile(paths.ledger);
  if (!observation.existed) return EMPTY_LEDGER;
  if (bytes === null) throw invalidState(`the ledger is not a regular file: ${paths.ledger}`);
  return parseLedger(bytes, paths.ledger);
}

function parseJson(bytes: Buffer, label: string): unknown {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw invalidState(`the ledger is not valid JSON: ${label}`); }
}

function validPathRecords(value: Record<string, unknown>): boolean {
  return isObject(value.paths) && Object.entries(value.paths).every(([path, record]) => isAbsolute(path) && validPathRecord(record));
}

const TOOL_IDS: readonly string[] = ['herdr-core', 'bun'];

export function validToolRecord(record: unknown): boolean {
  if (!isObject(record) || !isObject(record.paths) || !Array.isArray(record.directories)) return false;
  return (record.installed_by === 'rh-install' || record.installed_by === 'rh-bootstrap') && isText(record.version) && record.version !== ''
    && Object.entries(record.paths).every(([path, entry]) => isAbsolute(path) && isObject(entry) && validPathCommitted(entry.committed)
      && Object.keys(entry).every((key) => key === 'committed' || (key === 'identity' && isIdentity(entry.identity))))
    && record.directories.every((directory) => isText(directory) && isAbsolute(directory))
    && (record.path_entry === undefined || validUserPathEntry(record.path_entry))
    && (record.profile === undefined || (isObject(record.profile) && isText(record.profile.file) && isAbsolute(record.profile.file) && isText(record.profile.inserted) && record.profile.inserted !== ''))
    && (record.registry_keys === undefined || (Array.isArray(record.registry_keys) && record.registry_keys.every((key) => isText(key) && key.startsWith('HKCU\\'))))
    && typeof record.removable === 'boolean';
}

/** Each host path has one owner record: a tool path is in no other tool, file record or path record. */
function validTools(value: Record<string, unknown>): boolean {
  if (!isObject(value.tools) || !Object.entries(value.tools).every(([id, record]) => TOOL_IDS.includes(id) && validToolRecord(record))) return false;
  const keys = Object.values(value.tools as HostConfigLedger['tools']).flatMap((tool) => Object.keys(tool!.paths));
  const taken = new Set([...Object.keys(value.files as object), ...Object.keys(value.paths as object)]);
  return new Set(keys).size === keys.length && keys.every((key) => !taken.has(key));
}

/** A valid ledger of an older protocol in the current shape, records as they are; null for any other value. */
function olderLedger(value: unknown): HostConfigLedger | null {
  if (!isObject(value) || !validTextRecords(value)) return null;
  if (value.protocol === 4) {
    return validPathRecords(value) && validRetirement(value) && validTools(value)
      ? { ...(value as unknown as HostConfigLedger), protocol: HOST_CONFIG_LEDGER_PROTOCOL } : null;
  }
  if ('tools' in value) return null;
  const { files, fragments, directories } = value as unknown as HostConfigLedger;
  const moved = { protocol: HOST_CONFIG_LEDGER_PROTOCOL as typeof HOST_CONFIG_LEDGER_PROTOCOL, files, fragments, directories, tools: {} };
  const empty = !('retired' in value) && !('recovery' in value);
  if (value.protocol === 1 && empty && !('paths' in value)) return { ...moved, paths: {}, retired: [], recovery: [] };
  if (value.protocol === 2 && empty && validPathRecords(value)) return { ...moved, paths: value.paths as HostConfigLedger['paths'], retired: [], recovery: [] };
  if (value.protocol === 3 && validPathRecords(value) && validRetirement(value)) {
    const { paths, retired, recovery } = value as unknown as HostConfigLedger;
    return { ...moved, paths, retired, recovery };
  }
  return null;
}

type LegacyIdentityExclusion = (key: string, record: HostConfigLedger['paths'][string]) => boolean;

/**
 * An older ledger as the schema move leaves it; null for any other value. The move of the live ledger, and its preview,
 * adopt each eligible claim whose entry holds what rh recorded (JD 7001045792). A transaction snapshot (`adopt` false)
 * keeps its records as they are, so a rollback never opens the adoption again.
 */
function movedLedger(value: unknown, adopt: boolean, exclude?: LegacyIdentityExclusion): HostConfigLedger | null {
  const older = olderLedger(value);
  if (older === null || !adopt) return older;
  const paths = Object.fromEntries(Object.entries(older.paths).map(([key, record]) => {
    if (exclude?.(key, record)) {
      const { identity: _identity, ...unproved } = record;
      return [key, unproved];
    }
    const identity = record.kind === 'user_managed' || 'proof' in record.committed ? null : adoptedIdentity(key, record);
    return [key, identity === null ? record : { ...record, identity }];
  }));
  return { ...older, paths };
}

const RETIRED_PROTOCOLS: Readonly<Record<number, string>> = {
  1: 'which has no path records', 2: 'which has no retirement records', 3: 'which has no tool records', 4: 'which has no entry identity',
};

/** The ledger in `bytes`, also a copy of it; `label` names the file in an error. An older protocol names the update step. */
export function parseLedger(bytes: Buffer, label: string): HostConfigLedger {
  const value = parseJson(bytes, label);
  const retired = isObject(value) && typeof value.protocol === 'number' ? RETIRED_PROTOCOLS[value.protocol] : undefined;
  if (retired) throw invalidState(`the ledger is protocol ${String((value as Record<string, unknown>).protocol)}, ${retired}; run: rh update (${label})`);
  const valid = isObject(value) && value.protocol === HOST_CONFIG_LEDGER_PROTOCOL && validTextRecords(value) && validDirectoryIdentities(value)
    && validPathRecords(value) && validRetirement(value) && validTools(value);
  if (!valid) throw invalidState(`the ledger has an invalid shape: ${label}`);
  return value as unknown as HostConfigLedger;
}

/**
 * The one-shot move of an older ledger to protocol 5: a protocol 1 ledger
 * gets an empty `paths`, protocols 1 and 2 get empty `retired` and `recovery`,
 * protocols 1 to 3 get empty `tools`, and each path record that the entry
 * still proves gets its identity (`movedLedger`). A mutating entry runs it
 * under the runtime lock; a later run finds protocol 5.
 */
export function migrateLedgerSchema(paths: HostConfigPaths, exclude?: LegacyIdentityExclusion): void {
  const { observation, bytes } = observeFile(paths.ledger);
  if (!observation.existed) return;
  if (bytes === null) throw invalidState(`the ledger is not a regular file: ${paths.ledger}`);
  const value = parseJson(bytes, paths.ledger);
  if (!isObject(value) || typeof value.protocol !== 'number' || !RETIRED_PROTOCOLS[value.protocol]) return;
  const moved = movedLedger(value, true, exclude);
  if (!moved) throw invalidState(`the protocol ${String(value.protocol)} ledger has an invalid shape: ${paths.ledger}`);
  writeLedger(paths, moved);
}

/**
 * The ledger as the schema move would leave it, read without moving it. Only a
 * dry run or a preview reads it; every other reader takes `readLedger`.
 */
export function readProjectedLedger(paths: HostConfigPaths, exclude?: LegacyIdentityExclusion): HostConfigLedger {
  const { observation, bytes } = observeFile(paths.ledger);
  if (!observation.existed) return EMPTY_LEDGER;
  if (bytes === null) throw invalidState(`the ledger is not a regular file: ${paths.ledger}`);
  return movedLedger(parseJson(bytes, paths.ledger), true, exclude) ?? parseLedger(bytes, paths.ledger);
}

/**
 * A transaction's ledger snapshot: the parent took it before a candidate of
 * a newer package moved the ledger, so it can be an older protocol. It reads
 * as the move leaves it.
 */
export function parseSnapshotLedger(bytes: Buffer, label: string): HostConfigLedger {
  return movedLedger(parseJson(bytes, label), false) ?? parseLedger(bytes, label);
}

/** The path records of `readProjectedLedger`. */
export function projectedLedgerPaths(paths: HostConfigPaths, exclude?: LegacyIdentityExclusion): HostConfigLedger['paths'] {
  return readProjectedLedger(paths, exclude).paths;
}

export function writeLedger(paths: HostConfigPaths, ledger: HostConfigLedger): void {
  writeLedgerBytes(paths, Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8'));
}

/** Put back a transaction's ledger snapshot byte for byte, in the protocol that its writer reads. */
export function writeLedgerBytes(paths: HostConfigPaths, bytes: Buffer): void {
  publishFileByRename(paths.ledger, bytes, `${paths.ledger}.${randomUUID()}.tmp`);
}

/** The ledger and vault of one clone's repository scope (#2854), keyed by its Git common directory. */
export function repositoryLedgerLayout(harness: string, key: string): HostConfigPaths {
  const root = join(harness, 'config', 'repos', key);
  return { harness, root, ledger: join(root, 'ledger.json'), vault: join(root, 'vault') };
}

/** Every repository ledger, also of a repository that left the registry or is gone: uninstall reverts each. */
export function repositoryLedgers(env: NodeJS.ProcessEnv): HostConfigPaths[] {
  const { harness } = hostConfigPaths(env);
  const repos = join(harness, 'config', 'repos');
  if (!lstatSync(repos, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(repos).sort().map((key) => repositoryLedgerLayout(harness, key)).filter((paths) => lstatSync(paths.ledger, { throwIfNoEntry: false }));
}

// ---- vault --------------------------------------------------------------

export function vaultPath(paths: HostConfigPaths, reference: Sha256): string {
  return join(paths.vault, reference.slice('sha256:'.length));
}

/** Content-addressed and shared: a second put of the same bytes reuses the stored copy. */
export function putVault(paths: HostConfigPaths, bytes: Buffer): Sha256 {
  const hex = sha256Hex(bytes);
  const target = join(paths.vault, hex);
  ensurePrivateDirectory(paths.root);
  ensureSelfIgnoringDirectory(paths.vault);
  if (!lstatSync(target, { throwIfNoEntry: false })) publishFileByRename(target, bytes, `${target}.${randomUUID()}.tmp`);
  readVault(paths, `sha256:${hex}`);
  return `sha256:${hex}`;
}

export function readVault(paths: HostConfigPaths, reference: Sha256): Buffer {
  const target = join(paths.vault, reference.slice('sha256:'.length));
  const { bytes } = observeFile(target);
  if (bytes === null || sha256Prefixed(bytes) !== reference) throw invalidState(`the vault entry is missing or does not match its name: ${target}`);
  return bytes;
}
