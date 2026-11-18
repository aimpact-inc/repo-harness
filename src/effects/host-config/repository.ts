import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { hostConfigRepositoryKey, resolveRepositoryIdentity } from '../git/repository-identity';
import { openRepositoryHostConfigGate } from './gate';
import { hostConfigPaths, type HostConfigPaths } from './store';

/**
 * The repository scope of the host-config gate (#2854): files that rh writes
 * inside a repository, outside its `.repo-harness/`. The ledger and the vault
 * of one clone live in `~/.repo-harness/config/repos/<key>/` and never in the
 * working tree, because the vault holds whole user files (owner, D4).
 */

export interface HostConfigRepository {
  /** The clone, from `resolveRepositoryIdentity`: it keys the ledger. */
  readonly repositoryId: string;
  /** The worktree root, links followed. */
  readonly worktree: string;
}

export function resolveHostConfigRepository(cwd: string): HostConfigRepository {
  const { repositoryId, worktreeId } = resolveRepositoryIdentity(cwd);
  // The gate compares record keys, which follow links with `realpathSync.native`, against this root.
  return { repositoryId, worktree: realpathSync.native(worktreeId) };
}

export function repositoryConfigPaths(env: NodeJS.ProcessEnv, repository: HostConfigRepository): HostConfigPaths {
  const { harness } = hostConfigPaths(env);
  const root = join(harness, 'config', 'repos', hostConfigRepositoryKey(repository.repositoryId));
  return { harness, root, ledger: join(root, 'ledger.json'), vault: join(root, 'vault') };
}

export function openRepositoryGate(env: NodeJS.ProcessEnv, repository: HostConfigRepository) {
  return openRepositoryHostConfigGate(env, repositoryConfigPaths(env, repository), repository.worktree);
}
