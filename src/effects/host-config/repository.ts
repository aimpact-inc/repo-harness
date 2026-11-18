import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { HostConfigError, type HostConfigLedger, type PathRecord } from '../../core/host-config/types';
import { hostConfigRepositoryKey, resolveRepositoryIdentity, resolveWorktreeId } from '../git/repository-identity';
import { gitExecFileSync } from '../git/runner';
import { isPathInside } from '../path-containment';
import { openRepositoryHostConfigGate, type HostConfigPathWrite, type HostConfigRepositoryGate } from './gate';
import { hostConfigPaths, hostPathKey, resolveHostPath, type HostConfigPaths } from './store';

/**
 * The repository scope of the host-config gate (#2854): files that rh writes
 * inside a repository, outside its `.repo-harness/`. The ledger and the vault
 * of one clone live in `~/.repo-harness/config/repos/<key>/` and never in a
 * Git worktree, because the vault holds whole user files (owner, D4; P7).
 */

export interface HostConfigRepository {
  /** The clone, from `resolveRepositoryIdentity`: it keys the ledger. */
  readonly repositoryId: string;
  /** The worktree root, links followed. */
  readonly worktree: string;
  /** The other worktrees of the clone that lie under this root, roots resolved (`git worktree list`): a path in one of them is that worktree's (P6). */
  readonly nested: readonly string[];
}

export function resolveHostConfigRepository(cwd: string): HostConfigRepository {
  const { repositoryId, worktreeId } = resolveRepositoryIdentity(cwd);
  // Record keys follow links with `realpathSync.native`, so the roots that they are compared with do too.
  const worktree = realpathSync.native(worktreeId);
  const listed = gitExecFileSync(['worktree', 'list', '--porcelain'], { cwd: worktree, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
  const nested = listed.filter((root) => lstatSync(root, { throwIfNoEntry: false })).map((root) => realpathSync.native(root))
    .filter((root) => root !== worktree && isPathInside(worktree, root));
  return { repositoryId, worktree, nested };
}

export function repositoryConfigPaths(env: NodeJS.ProcessEnv, repository: Pick<HostConfigRepository, 'repositoryId'>): HostConfigPaths {
  const { harness } = hostConfigPaths(env);
  const root = join(harness, 'config', 'repos', hostConfigRepositoryKey(repository.repositoryId));
  return { harness, root, ledger: join(root, 'ledger.json'), vault: join(root, 'vault') };
}

/** The real location of a path that may not exist yet: the deepest existing ancestor with its links followed, then the missing tail. */
function realLocation(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!lstatSync(current, { throwIfNoEntry: false })) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync.native(current), ...missing);
}

/** The Git worktree that holds the deepest existing directory of `path`, or null outside every worktree. */
function enclosingWorktree(path: string): string | null {
  let current = path;
  while (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) current = dirname(current);
  try { return realpathSync.native(resolveWorktreeId(current)); } catch { return null; }
}

/**
 * Why `path` is not a file of this worktree, or null when it is (P6): its
 * record key (parent links followed) and its target (all links followed) lie
 * in the worktree root and in no other worktree of the clone, and no
 * directory on the path leads elsewhere since rh recorded it.
 */
export function repositoryPathRefusal(paths: HostConfigPaths, repository: HostConfigRepository, path: string): string | null {
  const key = hostPathKey(paths, path);
  const target = resolveHostPath(paths, path);
  if (key !== resolve(path)) return `a directory on its path now leads to ${dirname(key)}`;
  if (!isPathInside(repository.worktree, key) || !isPathInside(repository.worktree, target)) return `it resolves outside the worktree ${repository.worktree}`;
  const other = repository.nested.find((root) => isPathInside(root, key) || isPathInside(root, target) || root === key);
  return other === undefined ? null : `it lies in the worktree ${other}`;
}

/**
 * The repository gate after the storage check (P7): the real location of the
 * repository ledger and vault lies in no Git worktree, or a copy of a user
 * file could enter a commit. The check runs before any storage is made and
 * before any strip. Every write target must pass `repositoryPathRefusal`.
 */
export function openRepositoryGate(env: NodeJS.ProcessEnv, repository: HostConfigRepository): HostConfigRepositoryGate {
  const paths = repositoryConfigPaths(env, repository);
  const storage = realLocation(paths.root);
  const enclosing = enclosingWorktree(storage);
  if (enclosing !== null) {
    throw new HostConfigError('host_config_invalid_path', `the repository ledger ${storage} would lie in the Git worktree ${enclosing}, where a copy of a user file could be committed; rh writes nothing`);
  }
  const gate = openRepositoryHostConfigGate(env, paths, repository.worktree);
  return {
    writePaths: (writes: readonly HostConfigPathWrite[]) => {
      for (const write of writes) {
        const refusal = repositoryPathRefusal(paths, repository, write.path);
        if (refusal !== null) throw new HostConfigError('host_config_invalid_path', `${refusal}, so rh does not write it for this worktree: ${write.path}`);
      }
      return gate.writePaths(writes);
    },
    revertPaths: (keys) => gate.revertPaths(keys),
  };
}

/** The records of one restore, checked once: its dry run and its restore act on the same set (P6). */
export interface RepositoryRestoreSet {
  readonly records: Readonly<Record<string, PathRecord>>;
  readonly refused: readonly { readonly path: string; readonly record: PathRecord; readonly reason: string }[];
}

/** The records in this worktree's root: those that a restore may act on, and those that now lead elsewhere. A nested linked checkout keeps its own. */
export function repositoryRestoreSet(paths: HostConfigPaths, repository: HostConfigRepository, ledger: HostConfigLedger): RepositoryRestoreSet {
  const records: Record<string, PathRecord> = {};
  const refused: { path: string; record: PathRecord; reason: string }[] = [];
  for (const [key, record] of Object.entries(ledger.paths)) {
    if (!isPathInside(repository.worktree, key) || repository.nested.some((root) => isPathInside(root, key) || root === key)) continue;
    const reason = repositoryPathRefusal(paths, repository, key);
    if (reason === null) records[key] = record;
    else refused.push({ path: key, record, reason });
  }
  return { records, refused };
}
