import { requireHome } from '../repo-harness-home';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PathRecord, PathRecordHost } from '../../core/host-config/types';
import { antigravityAgentRoot, antigravitySkillRoot, hostSkillRoot, stagedSkillRoot, syncSkillRoots } from '../host-skill-roots';
import { isPathInside } from '../path-containment';
import { hostConfigPaths, hostPathKey, readLedger, resolveHostPath, writeLedger } from './store';
import { observeEntryIdentity, pathRecordContentHolds, pathRecordEntry } from './whole-path';

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
 * Canonicalize the real on-disk spelling of existing non-symlink components under `~/.gemini/config/<leaf>`.
 * Never follows a symlink below HOME and stops on access errors (EACCES/EPERM), keeping the remaining literal
 * segments so non-Antigravity callers are never blocked while Antigravity guards still fail closed.
 */
export function canonicalAntigravityDir(resolvedHome: string, leaf: 'skills' | 'agents'): string {
  const parts = ['.gemini', 'config', leaf] as const;
  let current = resolvedHome;
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(current, parts[index]!);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(next, { throwIfNoEntry: false }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') return join(current, ...parts.slice(index));
      throw error;
    }
    if (!stat || !stat.isDirectory()) return join(current, ...parts.slice(index));
    try { current = realpathSync.native(next); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') return join(current, ...parts.slice(index));
      throw error;
    }
  }
  return current;
}

/**
 * True when `candidate` equals `root` or is a verified case-only alias of `root` on disk
 * (both real non-symlink directories with the exact same `observeEntryIdentity`).
 */
export function antigravityDirMatches(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  if (candidate.toLowerCase() !== root.toLowerCase()) return false;
  try {
    const rootStat = lstatSync(root, { throwIfNoEntry: false });
    const candidateStat = lstatSync(candidate, { throwIfNoEntry: false });
    if (!rootStat?.isDirectory() || !candidateStat?.isDirectory()) return false;
    const rootId = observeEntryIdentity(root);
    return rootId !== null && rootId === observeEntryIdentity(candidate);
  } catch {
    return false;
  }
}

/**
 * The root of the record's host that holds the key, with its links followed: a
 * removal is checked beneath it. `~/.claude.json` has HOME as its root. Null
 * for a key outside every root of its host.
 */
export function pathRecordRoot(env: NodeJS.ProcessEnv, key: string, record: PathRecord): string | null {
  const paths = hostConfigPaths(env);
  if (record.host === 'claude' && key === hostPathKey(paths, join(requireHome(env), '.claude.json'))) return dirname(key);
  if (record.host === 'antigravity') {
    // Canonicalize HOME and verified non-symlink directory components only: never resolve through links below HOME.
    const home = resolveHostPath(paths, requireHome(env));
    const skills = canonicalAntigravityDir(home, 'skills');
    const agents = canonicalAntigravityDir(home, 'agents');
    const exact = [skills, agents].find(root => key !== root && isPathInside(root, key));
    if (exact !== undefined) return exact;
    const parent = dirname(key);
    if (antigravityDirMatches(skills, parent) || antigravityDirMatches(agents, parent)) return parent;
    const grandParent = dirname(parent);
    if (grandParent !== parent && antigravityDirMatches(agents, grandParent)) return grandParent;
    return null;
  }
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
  return pathRecordHostRoot(env, path)?.host ?? null;
}

/** As `pathRecordHost`, with the innermost root of that host that holds the path, also before links are followed. */
export function pathRecordHostRoot(env: NodeJS.ProcessEnv, path: string): { readonly host: PathRecordHost; readonly root: string } | null {
  const home = requireHome(env);
  if (path === join(home, '.claude.json')) return { host: 'claude', root: home };
  for (const host of HOST_ORDER) {
    const candidates = host === 'antigravity' && path.toLowerCase().includes('.gemini')
      ? (() => {
        const resolved = resolveHostPath(hostConfigPaths(env), home);
        return [...new Set([...hostRoots(env, host), canonicalAntigravityDir(resolved, 'skills'), canonicalAntigravityDir(resolved, 'agents')])];
      })()
      : hostRoots(env, host);
    const root = candidates.filter(candidate => path !== candidate && isPathInside(candidate, path)).sort((a, b) => b.length - a.length)[0];
    if (root !== undefined) return { host, root };
  }
  return null;
}

/** The hosts in the order that `pathRecordHost` tries their roots. */
const HOST_ORDER: readonly PathRecordHost[] = ['pi', 'claude', 'codex', 'antigravity', 'staged', 'bin'];

/** The install root of a host, before links are followed. */
function hostRoots(env: NodeJS.ProcessEnv, host: PathRecordHost): readonly string[] {
  const home = requireHome(env);
  if (host === 'pi') return [hostSkillRoot(home, 'pi', env)];
  if (host === 'antigravity') {
    const resolved = resolveHostPath(hostConfigPaths(env), home);
    return [...new Set([
      antigravitySkillRoot(home), antigravityAgentRoot(home),
      antigravitySkillRoot(resolved), antigravityAgentRoot(resolved),
    ])];
  }
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

/**
 * The `created` records as the hook's ledger surfaces: a file that the user keeps (`user_managed`) is not one that rh created.
 * `current` is the proof that the path still holds what rh wrote; the hook asks it only for the surface that matches its
 * target, because a directory proof hashes the whole tree.
 */
export function createdPaths(env: NodeJS.ProcessEnv): readonly { readonly path: string; readonly type: PathRecord['committed']['type']; readonly current: () => boolean }[] {
  const { records } = partitionPathRecords(env, readLedger(hostConfigPaths(env)).paths, cachedSupported(env));
  return Object.entries(records).filter(([, record]) => record.kind === 'created')
    .map(([path, record]) => ({ path, type: record.committed.type, current: () => pathRecordIsCurrent(path, record) }));
}

/**
 * `current`: the entry at the key is the one that rh wrote, so a removal or an overwrite acts on it. `changed`: it does not
 * hold what rh recorded. `replaced`: it holds that, but it is another file-system entry (a copy, a restore or a re-creation).
 * `unproved`: the record has no identity, so nothing proves that rh wrote the entry (#3266, JD 7001045792). A Herdr skill
 * record proves itself by its marker, because Herdr rewrites the directory.
 */
export type PathRecordProof = 'current' | 'changed' | 'replaced' | 'unproved';

export function pathRecordProof(key: string, record: PathRecord): PathRecordProof {
  const entry = pathRecordEntry(key, record);
  const before = observeEntryIdentity(entry);
  if (!pathRecordContentHolds(key, record)) return 'changed';
  if ('proof' in record.committed) return 'current';
  if (record.identity === undefined) return 'unproved';
  return before === record.identity && observeEntryIdentity(entry) === record.identity ? 'current' : 'replaced';
}

export function pathRecordIsCurrent(key: string, record: PathRecord): boolean {
  return pathRecordProof(key, record) === 'current';
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
