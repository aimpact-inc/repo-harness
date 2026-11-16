import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, sep } from 'path';
import { upsertManagedBlock } from '../../core/adoption/managed-block';
import { ignoreBlockProof, removeRuntimeStateIgnoreBlock, runtimeStateIgnoreOperation, userExcludesFilePath } from '../../effects/adoption/gitignore-plan';
import { resolveGitCommonDirectory } from '../../effects/git/common-directory';
import { isRepoHarnessAdoptedPath, readRepoHarnessRegistryStrictSnapshot } from '../../effects/repo-registry';
import { writePrivateConfiguration } from './configuration-ownership';
import { repoHarnessHome } from '../../effects/repo-harness-home';
import { readInstallState } from './install-profile';
import { installProfileStatePath } from './install-state';

/** One repository write: the resolved `info/exclude` of a repository's Git common directory. */
export interface RepositoryExclude { readonly repo_id: string; readonly repo_path: string; readonly exclude_path: string }

export function repositoryExcludesLedgerPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(installProfileStatePath(env)), 'repository-excludes.json');
}

export function readRepositoryExcludes(env: NodeJS.ProcessEnv): RepositoryExclude[] {
  const path = repositoryExcludesLedgerPath(env);
  if (!lstatSync(path, { throwIfNoEntry: false })) return [];
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const valid = (entry: Record<string, unknown>) => Object.keys(entry).sort().join(',') === 'exclude_path,repo_id,repo_path'
    && Object.values(entry).every((field) => typeof field === 'string');
  if (value?.version !== 1 || !Array.isArray(value.entries) || !value.entries.every(valid)) throw new Error(`repository_excludes_ledger_invalid: ${path}`);
  return value.entries;
}

export function serializeRepositoryExcludes(entries: readonly RepositoryExclude[]): string | null {
  return entries.length ? `${JSON.stringify({ version: 1, entries }, null, 2)}\n` : null;
}

/** A path with its links followed: the deepest existing ancestor resolved with realpath.native, then the remaining names. */
function followLinks(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(followLinks(dirname(path)), basename(path));
  }
}

/** rh refuses only a write into its own home or into a path that the install ledger records for another owner. */
function assertWriteTarget(path: string, env: NodeJS.ProcessEnv): void {
  const owned = (readInstallState(env)?.ownership_manifest ?? []).map((surface) => surface.path);
  for (const root of [repoHarnessHome(env), dirname(installProfileStatePath(env)), ...owned]) {
    const resolved = followLinks(root);
    if (path === resolved || path.startsWith(resolved + sep)) {
      throw new Error(`excludes_target_rh_managed: ${path} is in ${root}, which rh manages; fix the link, or remove the repository from the registry, then run the command again`);
    }
  }
}

/**
 * `<common dir>/info/exclude` of a repository (`git rev-parse --git-common-dir`) with user links followed,
 * so worktrees, gitdir links and linked exclude files of one repository share one owner and one ledger key.
 */
export function repositoryExcludeTarget(commonDir: string, env: NodeJS.ProcessEnv): string {
  const path = followLinks(join(commonDir, 'info', 'exclude'));
  assertWriteTarget(path, env);
  return path;
}

export interface RepositoryExcludesResult { readonly status: 'ok' | 'failed'; readonly detail: string; readonly unavailable: readonly string[] }

/**
 * Writes the runtime-state block into the exclude file of each adopted repository in the registry.
 * The ledger names a target before its first write, so uninstall finds every block that rh wrote.
 * Every caller holds the global runtime lock, so block updates are serialized.
 */
export function writeRepositoryExcludes(env: NodeJS.ProcessEnv): RepositoryExcludesResult {
  const lines: string[] = [];
  const unavailable: string[] = [];
  const failed = (error: unknown) => ({ status: 'failed' as const, detail: [...lines, error instanceof Error ? error.message : String(error)].join('; '), unavailable });
  let ledger: RepositoryExclude[];
  let repos;
  try {
    ledger = readRepositoryExcludes(env);
    repos = [...readRepoHarnessRegistryStrictSnapshot({ env }).repos].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) { return failed(error); }
  const owners = new Map<string, string>();
  for (const repo of repos) {
    if (!existsSync(repo.path)) { unavailable.push(`${repo.path}: missing`); continue; }
    if (!isRepoHarnessAdoptedPath(repo.path)) continue;
    let commonDir: string;
    try { commonDir = resolveGitCommonDirectory(repo.path, undefined, undefined, env); }
    catch { unavailable.push(`${repo.path}: not a Git repository`); continue; }
    try {
      const path = repositoryExcludeTarget(commonDir, env);
      if (owners.has(path)) { lines.push(`${path}: written for ${owners.get(path)}`); continue; }
      owners.set(path, repo.path);
      if (!ledger.some((entry) => entry.exclude_path === path)) {
        ledger = [...ledger, { repo_id: repo.id, repo_path: repo.path, exclude_path: path }];
        writePrivateConfiguration(repositoryExcludesLedgerPath(env), serializeRepositoryExcludes(ledger)!, env.HOME ?? homedir());
      }
      const operation = runtimeStateIgnoreOperation(path);
      const update = upsertManagedBlock(existsSync(path) ? readFileSync(path, 'utf8') : '', operation, ignoreBlockProof(operation));
      if (!update.ok) throw new Error(`${path}: ${update.error}`);
      if (update.kept !== undefined) lines.push(`${path}: kept the edited block "${update.kept}"; delete it, then run rh update again to get the current one`);
      else if (!update.changed) lines.push(`${path}: current`);
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, update.content!);
        lines.push(`${path}: written`);
      }
    } catch (error) { return failed(error); }
  }
  if (unavailable.length) lines.push(`unavailable registered repositories: ${unavailable.join(', ')}`);
  return { status: 'ok', detail: lines.join('; ') || 'no adopted repository is registered', unavailable };
}

/**
 * One-shot migration (#2844): earlier releases wrote the runtime-state block to the user-level
 * Git excludes file. Update removes only that block, after every registered repository holds its
 * own block; a failed or unavailable repository keeps it. User links are followed.
 */
export function retireUserExcludesBlock(env: NodeJS.ProcessEnv, repositories: RepositoryExcludesResult): { status: 'ok' | 'skipped'; detail: string } {
  const excludes = userExcludesFilePath(env);
  if (!excludes.ok) return { status: 'skipped', detail: `user-level Git excludes file not resolved; nothing removed: ${excludes.error}` };
  const path = excludes.path;
  try {
    if (!existsSync(path)) return { status: 'skipped', detail: `${path}: absent` };
    const removal = removeRuntimeStateIgnoreBlock(readFileSync(path, 'utf8'));
    if (removal.status === 'none') return { status: 'skipped', detail: `${path}: no runtime-state block` };
    if (repositories.status !== 'ok' || repositories.unavailable.length) {
      return { status: 'skipped', detail: `${path}: kept the runtime-state block until every registered repository holds its own block` };
    }
    if (removal.status !== 'removed') {
      return { status: 'skipped', detail: `${path}: kept the ${removal.status} runtime-state block; move your rules outside the markers, then delete the block` };
    }
    assertWriteTarget(followLinks(path), env);
    writeFileSync(path, removal.content);
    return { status: 'ok', detail: `${path}: removed the runtime-state block; each adopted repository holds it in .git/info/exclude` };
  } catch (error) {
    return { status: 'skipped', detail: `${path}: kept the runtime-state block: ${error instanceof Error ? error.message : String(error)}` };
  }
}
