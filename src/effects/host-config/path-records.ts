import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256Prefixed } from '../../core/evidence/sha256';
import type { PathRecord, PathRecordHost } from '../../core/host-config/types';
import { ownedSkillIsIntact } from '../herdr-skill-marker';
import { hostSkillRoot, stagedSkillRoot } from '../host-skill-roots';
import { hashManagedTree } from '../managed-tree';
import { isPathInside } from '../path-containment';
import { hostConfigPaths, hostPathKey, readLedger, resolveHostPath, writeLedger } from './store';

/**
 * The ledger's path records: the only ownership record of the whole host paths
 * that an install writes. Every reader takes them through `ownedPath` and
 * `pathRecordIsCurrent`; the install producer replaces the map through
 * `writePathRecords`.
 */

export type PathRecords = Readonly<Record<string, PathRecord>>;

/**
 * The records, each key checked against the root that its host names, with the
 * root's links followed. A removal acts on the key, so a record outside its
 * root could name a user file outside every install root: rh never acts on it,
 * reports it in `outside`, and the next record write drops it. A host root that
 * moved after the install (a linked `~/.claude`) leaves such records; the next
 * install records its paths again under their new keys.
 */
export function readPathRecordSet(env: NodeJS.ProcessEnv): { readonly records: PathRecords; readonly outside: readonly string[] } {
  const paths = hostConfigPaths(env);
  const records: Record<string, PathRecord> = {};
  const outside: string[] = [];
  for (const [key, record] of Object.entries(readLedger(paths).paths)) {
    const root = resolveHostPath(paths, hostRoot(env, record.host));
    const inside = (key !== root && isPathInside(root, key))
      || (record.host === 'claude' && key === hostPathKey(paths, join(env.HOME ?? homedir(), '.claude.json')));
    if (inside) records[key] = record;
    else outside.push(key);
  }
  return { records, outside };
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
  if (path === join(env.HOME ?? homedir(), '.claude.json')) return 'claude';
  return HOST_ORDER.find((host) => { const root = hostRoot(env, host); return path !== root && isPathInside(root, path); }) ?? null;
}

/** The hosts in the order that `pathRecordHost` tries their roots. */
const HOST_ORDER: readonly PathRecordHost[] = ['pi', 'claude', 'codex', 'staged', 'bin'];

/** The install root of a host, before links are followed. */
function hostRoot(env: NodeJS.ProcessEnv, host: PathRecordHost): string {
  const home = env.HOME ?? homedir();
  if (host === 'pi') return hostSkillRoot(home, 'pi', env);
  if (host === 'staged') return join(stagedSkillRoot(home), '..');
  if (host === 'bin') return env.BUN_INSTALL ?? join(home, '.bun');
  return join(home, `.${host}`);
}

export function ownedPath(env: NodeJS.ProcessEnv, path: string, records: PathRecords = readPathRecords(env)): PathRecord | null {
  return records[pathRecordKey(env, path)] ?? null;
}

/** The `created` records as the hook's ledger surfaces: a file that the user keeps (`user_managed`) is not one that rh created. */
export function createdPaths(env: NodeJS.ProcessEnv): readonly { readonly path: string; readonly type: PathRecord['committed']['type'] }[] {
  return Object.entries(readPathRecords(env)).filter(([, record]) => record.kind === 'created').map(([path, record]) => ({ path, type: record.committed.type }));
}

/** The entry at the key still is what rh recorded: a removal acts only then. */
export function pathRecordIsCurrent(key: string, record: PathRecord): boolean {
  const stat = lstatSync(key, { throwIfNoEntry: false });
  if (!stat) return false;
  const committed = record.committed;
  try {
    if (committed.type === 'symlink') return stat.isSymbolicLink() && readlinkSync(key) === committed.target;
    if (committed.type === 'file') return stat.isFile() && sha256Prefixed(readFileSync(key)) === committed.sha256;
    if (!stat.isDirectory()) return false;
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
