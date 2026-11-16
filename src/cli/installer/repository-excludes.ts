import { randomUUID } from 'crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, sep } from 'path';
import { upsertManagedBlock } from '../../core/adoption/managed-block';
import { ignoreBlockProof, removeRuntimeStateIgnoreBlock, runtimeStateIgnoreOperation, userExcludesFilePath } from '../../effects/adoption/gitignore-plan';
import { resolveGitCommonDirectory } from '../../effects/git/common-directory';
import { isRepoHarnessAdoptedPath, readRepoHarnessRegistryStrictSnapshot } from '../../effects/repo-registry';
import { writePrivateConfiguration } from './configuration-ownership';
import { installProfileHostMutationPaths } from './install-profile';
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

function unsafe(path: string, reason: string): Error {
  return new Error(`repository_exclude_unsafe: ${path} ${reason}; fix it, or remove the repository from the registry, then run the command again`);
}

/**
 * `<common dir>/info/exclude` of a repository (`git rev-parse --git-common-dir`), resolved with realpath.native, so worktrees and
 * gitdir links of one repository share one owner. Refused: a symlinked or non-directory `info`,
 * a symlinked, non-regular or hard-linked (nlink > 1) `exclude`, and a path in a host path that rh manages.
 */
export function repositoryExcludeTarget(commonDir: string, env: NodeJS.ProcessEnv): string {
  const info = join(realpathSync.native(commonDir), 'info');
  const path = join(info, 'exclude');
  const infoStat = lstatSync(info, { throwIfNoEntry: false });
  if (infoStat && (infoStat.isSymbolicLink() || !infoStat.isDirectory())) throw unsafe(info, 'is not a real directory');
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) throw unsafe(path, 'is not a regular file');
  if (stat && stat.nlink > 1) throw unsafe(path, `has ${stat.nlink} hard links`);
  for (const managed of installProfileHostMutationPaths(env)) {
    let root: string;
    try { root = realpathSync.native(managed); } catch { continue; }
    if (path === root || path.startsWith(root + sep)) throw unsafe(path, `is in ${managed}, which rh manages`);
  }
  return path;
}

/** Replaces a Git ignore file through a temp file in its directory; the mode stays. An empty result removes the file. */
export function replaceIgnoreFile(path: string, content: string): void {
  if (!content.trim()) { unlinkSync(path); return; }
  const mode = (lstatSync(path, { throwIfNoEntry: false })?.mode ?? 0o644) & 0o777;
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { flag: 'wx' });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
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
        if (!existsSync(dirname(path))) mkdirSync(dirname(path));
        replaceIgnoreFile(path, update.content!);
        lines.push(`${path}: written`);
      }
    } catch (error) { return failed(error); }
  }
  if (unavailable.length) lines.push(`unavailable registered repositories: ${unavailable.join(', ')}`);
  return { status: 'ok', detail: lines.join('; ') || 'no adopted repository is registered', unavailable };
}

/**
 * One-shot migration (#2844): earlier releases wrote the runtime-state block to the user-level
 * Git excludes file. Update removes that block only after every registered repository holds its
 * own block. A failed or unavailable repository keeps it; an unsafe target stays untouched.
 */
export function retireUserExcludesBlock(env: NodeJS.ProcessEnv, repositories: RepositoryExcludesResult): { status: 'ok' | 'skipped'; detail: string } {
  const excludes = userExcludesFilePath(env);
  if (!excludes.ok) return { status: 'skipped', detail: `user-level Git excludes file not resolved; nothing removed: ${excludes.error}` };
  const path = excludes.path;
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return { status: 'skipped', detail: `${path}: absent` };
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    return { status: 'skipped', detail: `${path}: not a regular single-link file; left untouched. Remove the runtime-state block from it by hand` };
  }
  const removal = removeRuntimeStateIgnoreBlock(readFileSync(path, 'utf8'));
  if (removal.status === 'none') return { status: 'skipped', detail: `${path}: no runtime-state block` };
  if (repositories.status !== 'ok' || repositories.unavailable.length) {
    return { status: 'skipped', detail: `${path}: kept the runtime-state block until every registered repository holds its own block` };
  }
  if (removal.status !== 'removed') {
    return { status: 'skipped', detail: `${path}: kept the ${removal.status} runtime-state block; move your rules outside the markers, then delete the block` };
  }
  replaceIgnoreFile(path, removal.content);
  return { status: 'ok', detail: `${path}: removed the runtime-state block; each adopted repository holds it in .git/info/exclude` };
}
