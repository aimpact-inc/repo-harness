import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { HostConfigError } from '../../core/host-config/types';
import { configuredGitBinary, resolveGitCommonDirectory } from '../git/common-directory';
import { hostConfigRepositoryKey } from '../git/repository-identity';
import { ensureCheckoutBackupDirectory, FS_BACKUP_ROOT } from '../checkout-filesystem';
import { isPathInside } from '../path-containment';
import { selfIgnoringRefusal } from '../self-ignoring-directory';
import { openRepositoryHostConfigGate, planPathRevertEntry, rollbackHostConfigTransaction, type HostConfigRepositoryGate, type HostConfigRevertEntry, type HostConfigRollbackResult } from './gate';
import { pathRecordEntry } from './whole-path';
import { hostConfigPaths, migrateLedgerSchema, observeFile, readProjectedLedger, repositoryLedgerLayout, type HostConfigPaths } from './store';

/**
 * The repository scope of the host-config gate (#2854): files that rh writes
 * inside a repository, outside its `.repo-harness/`. The ledger and the vault
 * of one clone live in `~/.repo-harness/config/repos/<key>/` and never in the
 * working tree, because the vault holds whole user files (owner, D4).
 */

export interface HostConfigRepository {
  /** The clone, from Git's common directory: it keys the ledger. */
  readonly repositoryId: string;
  /** The selected worktree root, links followed. */
  readonly worktree: string;
}

/**
 * The worktree root is the selected directory itself: it must hold `.git`
 * (no walk up). Git names the clone with no `GIT_*` variable of the caller,
 * and the clone selects the ledger only; it never admits a target.
 */
export function resolveHostConfigRepository(directory: string): HostConfigRepository {
  const worktree = realpathSync.native(directory);
  if (!lstatSync(join(worktree, '.git'), { throwIfNoEntry: false })) {
    throw new HostConfigError('host_config_invalid_path', `name the worktree root, the directory that holds .git: ${directory}`);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { repositoryId: resolveGitCommonDirectory(worktree, configuredGitBinary(), undefined, env), worktree };
}

export function repositoryConfigPaths(env: NodeJS.ProcessEnv, repository: HostConfigRepository): HostConfigPaths {
  return repositoryLedgerLayout(hostConfigPaths(env).harness, hostConfigRepositoryKey(repository.repositoryId));
}

/** The `info/exclude` of the clone: one file for all its worktrees (#3080). */
export function repositoryExcludePath(repository: HostConfigRepository): string {
  return join(repository.repositoryId, 'info', 'exclude');
}

/**
 * Why rh may not write `target` for the worktree, or null; it reads the file
 * system only, so no Git variable changes the answer (P6). Each component
 * from the root to the target must be no link, and no directory below the
 * root on the way may hold a `.git` entry: a submodule, a nested repository or
 * a nested linked worktree owns what is below it. An absent component ends
 * the walk: there is nothing there to write over.
 */
export function repositoryTargetRefusal(worktree: string, target: string): string | null {
  const rel = relative(worktree, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return `${target} is outside the worktree ${worktree}`;
  const parts = rel.split(sep);
  let current = worktree;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) return `${current} is a link`;
    if (index === parts.length - 1) return null;
    if (!stat.isDirectory()) return null;
    if (lstatSync(join(current, '.git'), { throwIfNoEntry: false })) return `${current} holds .git, so another checkout owns it`;
  }
  return null;
}

/** Why the worktree cannot stage the bytes for `target`, or null; it reads only. */
function stagingRefusal(worktree: string, target: string): string | null {
  const backups = join(worktree, FS_BACKUP_ROOT);
  const guard = selfIgnoringRefusal(backups);
  if (guard !== null) return guard;
  // The staging directory sits below the backup root, or below the worktree before the root exists.
  let near = backups;
  while (!lstatSync(near, { throwIfNoEntry: false })) near = dirname(near);
  const parent = lstatSync(dirname(target), { throwIfNoEntry: false });
  if (parent && parent.dev !== lstatSync(near).dev) return `${near} is on another file system than ${target}, so rh cannot move the bytes there in one rename`;
  return null;
}

/**
 * Repository writes stage their bytes in their own guarded
 * `.ai/harness/backups/staging/<uuid>/` in the worktree, never at a name
 * beside the target, so a kill leaves no copy that Git can stage. `stage`
 * runs the target rule again right before each write.
 */
export function withRepositoryStaging<T>(worktree: string, run: (stage: (target: string) => string) => T): T {
  const staging = `${FS_BACKUP_ROOT}/staging/${randomUUID()}`;
  let made = false;
  const stage = (target: string): string => {
    const refused = repositoryTargetRefusal(worktree, target) ?? stagingRefusal(worktree, target);
    if (refused !== null) throw new HostConfigError('host_config_invalid_path', `rh does not write this repository file: ${refused}`);
    if (!made) { ensureCheckoutBackupDirectory(worktree, staging); made = true; }
    return join(worktree, staging, randomUUID());
  };
  try { return run(stage); }
  finally { if (made) rmSync(join(worktree, staging), { recursive: true, force: true }); }
}

/**
 * The repository gate; each call stages in its own guarded directory.
 * `transaction` keeps a preimage of each rh entry that a write replaces.
 */
export function openRepositoryGate(env: NodeJS.ProcessEnv, repository: HostConfigRepository, options: { readonly transaction?: string } = {}): HostConfigRepositoryGate {
  const { worktree } = repository;
  const paths = repositoryConfigPaths(env, repository);
  // `rh init` and `rh config restore --repo` run no user-level migration, so each repository write moves an older ledger first.
  const call = <T>(run: (gate: HostConfigRepositoryGate) => T): T => withRepositoryStaging(worktree, (stage) => {
    migrateLedgerSchema(paths);
    return run(openRepositoryHostConfigGate(env, paths, { worktree, refusal: (target) => repositoryTargetRefusal(worktree, target), stage, transaction: options.transaction }));
  });
  return {
    writePaths: (writes) => call((gate) => gate.writePaths(writes)),
    createDirectories: (directories) => call((gate) => gate.createDirectories(directories)),
    revertPaths: (paths) => call((gate) => gate.revertPaths(paths)),
  };
}

/** The gate writes of one run and their rollback to the ledger as it was before the run. */
export interface RepositoryWriteRun {
  readonly gate: HostConfigRepositoryGate;
  rollback(): HostConfigRollbackResult;
}

/**
 * One run of repository writes (#2903). The caller holds the runtime lock.
 * `transaction` is the run's guarded directory for preimages; the rollback
 * puts each entry back through repository staging, never beside the target.
 */
export function openRepositoryWriteRun(env: NodeJS.ProcessEnv, repository: HostConfigRepository, transaction: string): RepositoryWriteRun {
  const paths = repositoryConfigPaths(env, repository);
  migrateLedgerSchema(paths);
  const snapshot = observeFile(paths.ledger).bytes;
  return {
    gate: openRepositoryGate(env, repository, { transaction }),
    rollback: () => withRepositoryStaging(repository.worktree, (stage) => rollbackHostConfigTransaction(paths, snapshot, transaction, { stage })),
  };
}

export interface RepositoryRestorePlan {
  /** What a revert of each record would do, as `rh config restore --repo` reports it. */
  readonly entries: readonly HostConfigRevertEntry[];
  /** Records that rh does not touch, with the reason. */
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
  /** The directories that rh created and removes when they are empty after the revert: each holds an entry that goes. */
  readonly directories: readonly string[];
}

/**
 * The restore of one worktree, read-only: the records under the selected root
 * (or the one at `only`), each with its revert action, or its refusal by the
 * target rule or the staging check. A dry run prints it; the apply plans it
 * again under the lock and reverts only the entries.
 */
export function repositoryRestorePlan(env: NodeJS.ProcessEnv, repository: HostConfigRepository, options: { readonly only?: string; readonly owner?: string } = {}): RepositoryRestorePlan {
  const paths = repositoryConfigPaths(env, repository);
  const unrecorded = (where: string) => new HostConfigError('host_config_repository_unrecorded', `rh records no repository file ${where}`);
  if (!observeFile(paths.ledger).observation.existed) throw unrecorded(`for ${repository.worktree}`);
  // A read-only plan: an older ledger reads as the move leaves it; the apply moves it under the lock first.
  const ledger = readProjectedLedger(paths);
  const records = ledger.paths;
  let keys = Object.keys(records).filter((key) => isPathInside(repository.worktree, key) && (options.owner === undefined || records[key]!.owner === options.owner));
  if (options.only !== undefined) {
    if (!keys.includes(options.only)) throw unrecorded(`at ${options.only}`);
    keys = [options.only];
  }
  if (!keys.length) throw unrecorded(`in ${repository.worktree}`);
  const entries: HostConfigRevertEntry[] = [];
  const refused: { path: string; reason: string }[] = [];
  for (const key of keys) {
    const entry = planPathRevertEntry(paths, key, records[key]!);
    const reason = repositoryTargetRefusal(repository.worktree, key) ?? (entry.action === 'restored' ? stagingRefusal(repository.worktree, key) : null);
    if (reason !== null) refused.push({ path: key, reason });
    else entries.push(entry);
  }
  // The revert's own rule: a created directory goes only with an entry inside it.
  const dropped = entries.filter((entry) => entry.action !== 'kept_edited').map((entry) => pathRecordEntry(entry.path, records[entry.path]!));
  const directories = ledger.directories.filter((directory) => dropped.some((entry) => isPathInside(directory, entry)));
  return { entries, refused, directories };
}

/** Revert the planned entries; the gate checks each target again before its write. */
export function revertRepositoryPaths(env: NodeJS.ProcessEnv, repository: HostConfigRepository, plan: RepositoryRestorePlan): readonly HostConfigRevertEntry[] {
  return plan.entries.length ? openRepositoryGate(env, repository).revertPaths(plan.entries.map((entry) => entry.path)) : [];
}
