import { parseJsonText } from '../../core/evidence/file-syntax';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import { renderManagedBlock } from '../../core/adoption/managed-block';
import { markedBlock, markedBlockLayout, MARKED_BLOCK_FRAGMENTS } from '../../core/host-config/marked-block';
import { HostConfigError } from '../../core/host-config/types';
import { removeRuntimeStateIgnoreBlock, runtimeStateIgnoreOperation, userExcludesFilePath } from '../../effects/adoption/gitignore-plan';
import { decode, openRepositoryFileGate } from '../../effects/host-config/gate';
import { repositoryConfigPaths, repositoryExcludePath, resolveHostConfigRepository, type HostConfigRepository } from '../../effects/host-config/repository';
import { isRepoHarnessAdoptedPath, readRepoHarnessRegistryStrictSnapshot } from '../../effects/repo-registry';
import { repoHarnessHome } from '../../effects/repo-harness-home';
import { readPathRecords } from '../../effects/host-config/path-records';
import { isReleasedUserExcludesBlock } from '../../effects/upgrade/released-values';
import { installProfileStatePath } from './install-state';

const SELECTOR = 'runtime-state';
const OWNER = MARKED_BLOCK_FRAGMENTS[SELECTOR];

/** An entry of `repository-excludes.json`, the list of exclude files that releases before #3080 wrote. */
interface LegacyRepositoryExclude { readonly repo_id: string; readonly repo_path: string; readonly exclude_path: string }

/** While this file exists, the import has not run: uninstall keeps every repository block and asks for `rh update` first. */
export function legacyRepositoryExcludesPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(installProfileStatePath(env)), 'repository-excludes.json');
}

function readLegacyLedger(path: string): LegacyRepositoryExclude[] {
  const value = parseJsonText(readFileSync(path, 'utf8'), path) as { version?: unknown; entries?: unknown } | null;
  const valid = (entry: Record<string, unknown>) => Object.keys(entry).sort().join(',') === 'exclude_path,repo_id,repo_path'
    && Object.values(entry).every((field) => typeof field === 'string');
  if (value?.version !== 1 || !Array.isArray(value.entries) || !value.entries.every(valid)) throw new Error(`repository_excludes_ledger_invalid: ${path}`);
  return value.entries;
}

/** The block that rh writes now, with no final line ending. */
function runtimeStateBlock(): string {
  return renderManagedBlock(runtimeStateIgnoreOperation(''));
}

/**
 * One-shot import (#3080). A block becomes a ledger record only with both
 * halves of the evidence: an entry that names exactly the exclude file that
 * its repository resolves to now, and block text that rh shipped. Every other
 * block stays unclaimed and is reported, so rh never removes it. Invalid JSON
 * or a failed ledger write stops the step and keeps the file; a rerun finds
 * the records that it already wrote. The file goes after the last record.
 */
function importLegacyLedger(env: NodeJS.ProcessEnv, lines: string[]): void {
  const path = legacyRepositoryExcludesPath(env);
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  for (const entry of readLegacyLedger(path)) {
    const unclaimed = (reason: string) => lines.push(`${entry.exclude_path}: not imported (${reason}); rh does not claim or remove its block`);
    let repository: HostConfigRepository;
    try { repository = resolveHostConfigRepository(entry.repo_path); }
    catch (error) { unclaimed(`the repository ${entry.repo_path} does not resolve: ${error instanceof Error ? error.message : String(error)}`); continue; }
    const target = repositoryExcludePath(repository);
    if (target !== entry.exclude_path) { unclaimed(`the repository uses ${target} now`); continue; }
    const gate = openRepositoryFileGate(env, repositoryConfigPaths(env, repository));
    try {
      if (gate.recorded(target).length || !existsSync(target)) continue;
      const content = decode(readFileSync(target), target);
      const layout = markedBlockLayout(content, SELECTOR);
      if (layout.kind === 'none') continue;
      if (layout.kind === 'unbalanced') { unclaimed('unbalanced runtime-state markers'); continue; }
      const inserted = content.slice(layout.start, layout.end);
      const block = inserted.replace(/\r\n/g, '\n');
      if (block !== runtimeStateBlock() && !isReleasedUserExcludesBlock(block)) { unclaimed('the block was edited'); continue; }
      gate.adopt(target, { kind: 'text_block', backup: null, externalChange: false, fragments: [{ owner: OWNER, selector: SELECTOR, kind: 'add', inserted, preimage: inserted }] });
      lines.push(`${target}: imported`);
    } catch (error) {
      if (!(error instanceof HostConfigError)) throw error;
      unclaimed(error.message);
    }
  }
  unlinkSync(path);
}

/**
 * A path with its links followed: realpath.native of the path; for a missing path, the target of a
 * dangling link (relative to the link's directory), else the resolved parent and the remaining name.
 */
function followLinks(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return followLinks(resolve(dirname(path), readlinkSync(path)));
    return join(followLinks(dirname(path)), basename(path));
  }
}

/** rh refuses only a write into its own home or into a path that the install ledger records for another owner. */
function assertWriteTarget(path: string, env: NodeJS.ProcessEnv): void {
  const owned = Object.keys(readPathRecords(env));
  for (const root of [repoHarnessHome(env), dirname(installProfileStatePath(env)), ...owned]) {
    const resolved = followLinks(root);
    if (path === resolved || path.startsWith(resolved + sep)) {
      throw new Error(`excludes_target_rh_managed: ${path} is in ${root}, which rh manages; fix the link, or remove the repository from the registry, then run the command again`);
    }
  }
}

/**
 * `incomplete` names each registered repository that does not hold a proved block (missing, not a
 * Git repository, or an edited block); `targets` holds the exclude files that rh wrote or proved.
 */
export interface RepositoryExcludesResult { readonly status: 'ok' | 'failed'; readonly detail: string; readonly incomplete: readonly string[]; readonly targets: readonly string[] }

/**
 * Writes the runtime-state block into the exclude file of each adopted repository in the registry,
 * through the repository ledger of its clone: the record reaches the ledger before the write, so
 * uninstall finds every block that rh wrote. The one-shot import runs first.
 * Every caller holds the global runtime lock, so block updates are serialized.
 */
export function writeRepositoryExcludes(env: NodeJS.ProcessEnv): RepositoryExcludesResult {
  const lines: string[] = [];
  const unavailable: string[] = [];
  const edited: string[] = [];
  const owners = new Map<string, string>();
  const incomplete = () => [...unavailable, ...edited.map((path) => `${path}: edited block`)];
  const failed = (error: unknown) => ({ status: 'failed' as const, detail: [...lines, error instanceof Error ? error.message : String(error)].join('; '), incomplete: incomplete(), targets: [...owners.keys()] });
  let repos;
  try {
    importLegacyLedger(env, lines);
    repos = [...readRepoHarnessRegistryStrictSnapshot({ env }).repos].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) { return failed(error); }
  const block = runtimeStateBlock();
  for (const repo of repos) {
    if (!existsSync(repo.path)) { unavailable.push(`${repo.path}: missing`); continue; }
    if (!isRepoHarnessAdoptedPath(repo.path)) continue;
    let repository: HostConfigRepository;
    try { repository = resolveHostConfigRepository(repo.path); }
    catch { unavailable.push(`${repo.path}: not a Git worktree root`); continue; }
    const path = repositoryExcludePath(repository);
    if (owners.has(path)) { lines.push(`${path}: written for ${owners.get(path)}`); continue; }
    owners.set(path, repo.path);
    try {
      const gate = openRepositoryFileGate(env, repositoryConfigPaths(env, repository));
      const content = existsSync(path) ? decode(readFileSync(path), path) : null;
      const kind = content !== null && markedBlockLayout(content, SELECTOR).kind === 'balanced' ? 'refresh' : 'add';
      // A block that the user deleted after rh recorded it comes back: the insert removes no user byte.
      const selected = kind === 'add' && gate.recorded(path).length > 0;
      const result = gate.apply([{ path, backup: 'overrides-only', fragments: [{ owner: OWNER, selector: SELECTOR, kind, strategy: markedBlock, value: block, ...(selected ? { selected } : {}) }] }]);
      if (result.skipped.length) {
        edited.push(path);
        lines.push(`${path}: kept a block that rh cannot prove it wrote; delete it, then run rh update again to get the current one`);
      } else lines.push(`${path}: ${result.written.length ? 'written' : 'current'}`);
    } catch (error) {
      // The file stays as it is: not UTF-8, unbalanced markers, or a target that the admission refuses.
      if (!(error instanceof HostConfigError)) return failed(error);
      unavailable.push(`${path}: ${error.message}`);
    }
  }
  if (unavailable.length) lines.push(`unavailable registered repositories: ${unavailable.join(', ')}`);
  return { status: 'ok', detail: lines.join('; ') || 'no adopted repository is registered', incomplete: incomplete(), targets: [...owners.keys()] };
}

/**
 * One-shot migration (#2844): earlier releases wrote the runtime-state block to the user-level
 * Git excludes file. Update removes only that block, after every registered repository holds its
 * own proved block; a failed, unavailable or edited repository block keeps it, and so does a user-level
 * file that is itself a repository exclude target. User links are followed.
 */
export function retireUserExcludesBlock(env: NodeJS.ProcessEnv, repositories: RepositoryExcludesResult): { status: 'ok' | 'skipped'; detail: string } {
  const excludes = userExcludesFilePath(env);
  if (!excludes.ok) return { status: 'skipped', detail: `user-level Git excludes file not resolved; nothing removed: ${excludes.error}` };
  const path = excludes.path;
  try {
    if (!existsSync(path)) return { status: 'skipped', detail: `${path}: absent` };
    const removal = removeRuntimeStateIgnoreBlock(readFileSync(path, 'latin1'));
    if (removal.status === 'none') return { status: 'skipped', detail: `${path}: no runtime-state block` };
    if (repositories.status !== 'ok' || repositories.incomplete.length) {
      return { status: 'skipped', detail: `${path}: kept the runtime-state block until every registered repository holds its own proved block` };
    }
    if (repositories.targets.includes(followLinks(path))) {
      return { status: 'skipped', detail: `${path}: kept the runtime-state block; this file is also a repository exclude file` };
    }
    if (removal.status !== 'removed') {
      return { status: 'skipped', detail: `${path}: kept the ${removal.status} runtime-state block; move your rules outside the markers, then delete the block` };
    }
    assertWriteTarget(followLinks(path), env);
    writeFileSync(path, removal.content, 'latin1');
    return { status: 'ok', detail: `${path}: removed the runtime-state block; each adopted repository holds it in .git/info/exclude` };
  } catch (error) {
    return { status: 'skipped', detail: `${path}: kept the runtime-state block: ${error instanceof Error ? error.message : String(error)}` };
  }
}
