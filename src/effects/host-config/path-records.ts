import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { requireHome } from '../repo-harness-home';
import { dirname, join } from 'node:path';
import { sha256Prefixed } from '../../core/evidence/sha256';
import type { PathRecord, PathRecordHost } from '../../core/host-config/types';
import { ownedSkillIsIntact } from './herdr-skill-marker';
import { hostSkillRoot, stagedSkillRoot, syncSkillRoots } from '../host-skill-roots';
import { hashManagedTree, OWNER_MARKER } from '../managed-tree';
import { isPathInside } from '../path-containment';
import { hostConfigPaths, hostPathKey, readLedger, resolveHostPath, writeLedger } from './store';

/**
 * The ledger's path records: the only ownership record of the whole host paths
 * that an install writes. Every reader takes them through `ownedPath` and
 * `pathRecordIsCurrent`; the install producer replaces the map through
 * `writePathRecords`.
 */

export type PathRecords = Readonly<Record<string, PathRecord>>;

/** The check of the install surfaces that a path record may name, for one HOME. */
export type SupportedPathRecord = (env: NodeJS.ProcessEnv) => (key: string, record: PathRecord) => boolean;

/**
 * The installer owns the install surface list (install-profile.ts registers it
 * when it loads). Without a registered check no record is supported, so a
 * reader acts on nothing.
 */
let supportedCheck: SupportedPathRecord | null = null;

export function registerSupportedPathRecords(check: SupportedPathRecord): void {
  supportedCheck = check;
  supportedByEnv.clear();
}

/**
 * The built check per environment, for `createdPaths` only. A hook process
 * reads the records once per target and writes nothing, and each build loads
 * the skill catalog and resolves every install root. The key hashes the whole
 * environment, because the roots come from several variables. An install
 * changes links under the roots while it runs, so its readers build the check
 * each time.
 */
const supportedByEnv = new Map<string, (key: string, record: PathRecord) => boolean>();
const SUPPORTED_CACHE_SIZE = 4;

function cachedSupported(env: NodeJS.ProcessEnv): (key: string, record: PathRecord) => boolean {
  if (!supportedCheck) return () => false;
  const key = sha256Prefixed(JSON.stringify(Object.entries(env).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))));
  let check = supportedByEnv.get(key);
  if (!check) {
    check = supportedCheck(env);
    if (supportedByEnv.size >= SUPPORTED_CACHE_SIZE) supportedByEnv.delete(supportedByEnv.keys().next().value!);
    supportedByEnv.set(key, check);
  }
  return check;
}

export interface PathRecordSet {
  readonly records: PathRecords;
  /** Keys outside the root of their host, with the root's links followed. */
  readonly outside: readonly string[];
  /** Keys inside their root that name no install surface (path, owner or kind). */
  readonly unsupported: readonly string[];
}

/**
 * The records that may grant a write or a removal. A removal acts on the key,
 * so a record outside its host root or on a path that no install surface names
 * could name a user file: rh never acts on it, reports it, and the next record
 * write drops it. A host root that moved after the install (a linked
 * `~/.claude`) leaves such records; the next install records its paths again
 * under their new keys.
 */
export function partitionPathRecords(env: NodeJS.ProcessEnv, all: PathRecords,
  supported: (key: string, record: PathRecord) => boolean = supportedCheck?.(env) ?? (() => false)): PathRecordSet {
  const records: Record<string, PathRecord> = {};
  const outside: string[] = [];
  const unsupported: string[] = [];
  for (const [key, record] of Object.entries(all)) {
    if (pathRecordRoot(env, key, record) === null) outside.push(key);
    else if (!supported(key, record)) unsupported.push(key);
    else records[key] = record;
  }
  return { records, outside, unsupported };
}

/**
 * The root of the record's host that holds the key, with its links followed: a
 * removal is checked beneath it. `~/.claude.json` has HOME as its root. Null
 * for a key outside every root of its host.
 */
export function pathRecordRoot(env: NodeJS.ProcessEnv, key: string, record: PathRecord): string | null {
  const paths = hostConfigPaths(env);
  if (record.host === 'claude' && key === hostPathKey(paths, join(requireHome(env), '.claude.json'))) return dirname(key);
  return hostRoots(env, record.host).map(root => resolveHostPath(paths, root)).find(root => key !== root && isPathInside(root, key)) ?? null;
}

export function readPathRecordSet(env: NodeJS.ProcessEnv): PathRecordSet {
  return partitionPathRecords(env, readLedger(hostConfigPaths(env)).paths);
}

export function readPathRecords(env: NodeJS.ProcessEnv): PathRecords {
  return readPathRecordSet(env).records;
}

/** The record key of a host path: its parent links followed, the leaf kept. */
export function pathRecordKey(env: NodeJS.ProcessEnv, path: string): string {
  return hostPathKey(hostConfigPaths(env), path);
}

/**
 * The host root of a path as the installer names it, before links are
 * followed: a linked `~/.claude` still selects `claude` for an uninstall.
 * Null for a path outside every install root.
 */
export function pathRecordHost(env: NodeJS.ProcessEnv, path: string): PathRecordHost | null {
  if (path === join(requireHome(env), '.claude.json')) return 'claude';
  return HOST_ORDER.find(host => hostRoots(env, host).some(root => path !== root && isPathInside(root, path))) ?? null;
}

/** The hosts in the order that `pathRecordHost` tries their roots. */
const HOST_ORDER: readonly PathRecordHost[] = ['pi', 'claude', 'codex', 'staged', 'bin'];

/** The install root of a host, before links are followed. */
function hostRoots(env: NodeJS.ProcessEnv, host: PathRecordHost): readonly string[] {
  const home = requireHome(env);
  if (host === 'pi') return [hostSkillRoot(home, 'pi', env)];
  if (host === 'staged') return [join(stagedSkillRoot(home), '..')];
  if (host === 'bin') return [env.BUN_INSTALL ?? join(home, '.bun')];
  // A repository record lives in a worktree, never under a host root of the user.
  if (host === 'repository') return [];
  const sync = syncSkillRoots(env, home, ['pi'])[host];
  return [...new Set([join(home, '.' + host), ...(sync ? [sync] : [])])];
}

export function ownedPath(env: NodeJS.ProcessEnv, path: string, records: PathRecords = readPathRecords(env)): PathRecord | null {
  return records[pathRecordKey(env, path)] ?? null;
}

/** The `created` records as the hook's ledger surfaces: a file that the user keeps (`user_managed`) is not one that rh created. */
export function createdPaths(env: NodeJS.ProcessEnv): readonly { readonly path: string; readonly type: PathRecord['committed']['type'] }[] {
  const { records } = partitionPathRecords(env, readLedger(hostConfigPaths(env)).paths, cachedSupported(env));
  return Object.entries(records).filter(([, record]) => record.kind === 'created').map(([path, record]) => ({ path, type: record.committed.type }));
}

/** Empty directories and special entries have no entry in the recorded tree hash. */
function treeEntriesAreCovered(path: string): boolean {
  let covered = false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === OWNER_MARKER) {
      if (!entry.isFile()) return false;
    } else if (entry.isDirectory()) {
      if (!treeEntriesAreCovered(join(path, entry.name))) return false;
      covered = true;
    } else if (entry.isFile() || entry.isSymbolicLink()) covered = true;
    else return false;
  }
  return covered;
}

/** The entry that a path record acts on: the file that its user link names, or the key itself. */
export function pathRecordEntry(key: string, record: PathRecord): string {
  return record.link_target ?? key;
}

/**
 * The entry at the key still is what rh recorded: a removal acts only then.
 * For a linked record the key must still be a link that names `link_target`,
 * and that file must hold `committed`.
 */
export function pathRecordIsCurrent(key: string, record: PathRecord): boolean {
  const stat = lstatSync(key, { throwIfNoEntry: false });
  if (!stat) return false;
  const committed = record.committed;
  try {
    if (record.link_target !== undefined) {
      if (!stat.isSymbolicLink() || realpathSync.native(key) !== record.link_target || committed.type !== 'file') return false;
      return lstatSync(record.link_target).isFile() && sha256Prefixed(readFileSync(record.link_target)) === committed.sha256;
    }
    if (committed.type === 'symlink') return stat.isSymbolicLink() && readlinkSync(key) === committed.target;
    if (committed.type === 'file') return stat.isFile() && sha256Prefixed(readFileSync(key)) === committed.sha256;
    if (!stat.isDirectory()) return false;
    if (!treeEntriesAreCovered(key)) return false;
    return 'proof' in committed ? ownedSkillIsIntact(key) : hashManagedTree(key) === committed.sha256;
  } catch {
    return false;
  }
}

/** Replace the path records and return whether they changed; the keys are sorted so that an unchanged set writes no bytes. */
export function writePathRecords(env: NodeJS.ProcessEnv, records: PathRecords): boolean {
  const paths = hostConfigPaths(env);
  const ledger = readLedger(paths);
  const sorted = Object.fromEntries(Object.entries(records).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
  if (JSON.stringify(sorted) === JSON.stringify(ledger.paths)) return false;
  writeLedger(paths, { ...ledger, paths: sorted });
  return true;
}

/** The digest of the path-record set that a candidate receipt carries as `ownership_manifest_digest`. */
export function pathRecordsDigest(records: PathRecords): string {
  return sha256Prefixed(JSON.stringify(Object.entries(records).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))));
}
