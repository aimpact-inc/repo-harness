import { Command } from 'commander';
import { resolve } from 'node:path';
import { globalRuntimeScope, withRuntimeTransactionLock } from '../../effects/locking/runtime-transaction-lock';
import { openHostConfigGate, planPathRevert } from '../../effects/host-config/gate';
import { repositoryConfigPaths, repositoryRestorePlan, resolveHostConfigRepository, revertRepositoryPaths } from '../../effects/host-config/repository';
import { HostConfigError } from '../../core/host-config/types';
import { isPathInside } from '../../effects/path-containment';
import { collectRetired, configDiff, configStatus, type ConfigStatus, type FragmentDiff, type GcResult } from '../../effects/host-config/inspect';
import { hostConfigPaths, hostPathKey, observeFile, readLedger, readProjectedLedger, resolveHostPath } from '../../effects/host-config/store';
import { migrateInstallState } from '../installer/install-state-migration';
import { exitCodeOf, revertItem, type UninstallItem } from '../installer/uninstall';

/**
 * `rh config status|diff|restore|gc`: the host-config ledger for the user.
 * Output never holds a value that rh cannot prove it wrote (D6, #2851).
 */

export interface ConfigCommandResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
  readonly json: unknown;
}

function failure(error: unknown): ConfigCommandResult {
  const message = `[config] ${(error as Error).message}`;
  return { exitCode: 2, lines: [message], json: { error: (error as Error).message } };
}

function statusLines(status: ConfigStatus): string[] {
  const lines = [`[config] ledger ${status.ledger}`];
  for (const file of status.files) {
    const baseline = file.baseline === 'unknown' ? 'baseline unknown' : `baseline ${file.baseline}`;
    const state = [file.committed ? 'as rh wrote it' : 'changed since rh wrote it', ...(file.externalChange ? ['external change'] : [])].join(', ');
    lines.push(`[file] ${file.path}: current ${file.current}; ${baseline}; ${state}`);
    for (const fragment of file.fragments) lines.push(`  ${fragment.owner} ${fragment.selector} (${fragment.kind}): ${fragment.state}`);
  }
  for (const path of status.paths) lines.push(`[path] ${path.path}: ${path.owner} ${path.kind}; ${path.current ? 'as rh wrote it' : 'changed since rh wrote it'}`);
  for (const entry of status.recovery) lines.push(`[recovery] ${entry.file}: whole-file copy ${entry.copy} (${entry.at})`);
  for (const path of status.baselineCandidates) lines.push(`[candidate] ${path}: an old global-context backup; rh does not use it as a baseline`);
  if (status.retired) lines.push(`[retired] ${status.retired} vault copies of finished reverts; rh config gc deletes each 30 days after its revert`);
  return lines;
}

export function runConfigStatus(env: NodeJS.ProcessEnv): ConfigCommandResult {
  try {
    const status = configStatus(env);
    return { exitCode: 0, lines: statusLines(status), json: status };
  } catch (error) { return failure(error); }
}

function diffLines(path: string, fragments: readonly FragmentDiff[]): string[] {
  const lines = [`[diff] ${path}`];
  for (const fragment of fragments) {
    lines.push(`  ${fragment.owner} ${fragment.selector} (${fragment.kind}): ${fragment.state}; rh ${fragment.rh ?? 'unknown'}; current ${fragment.current ?? 'none'}`);
    if (fragment.value !== undefined && fragment.value !== null) lines.push(...fragment.value.split(/\r?\n/).map((line) => `    | ${line}`));
  }
  return lines;
}

export function runConfigDiff(env: NodeJS.ProcessEnv, path: string, options: { readonly showValues?: boolean } = {}): ConfigCommandResult {
  try {
    const diff = configDiff(env, path, options);
    return { exitCode: 0, lines: diffLines(diff.path, diff.fragments), json: diff };
  } catch (error) { return failure(error); }
}

/**
 * Revert one file through the gate, all of rh's fragments or one owner's.
 * The report and exit code follow `rh uninstall`. A dry run reads the ledger
 * as the schema move would leave it and takes no lock.
 */
export function runConfigRestore(env: NodeJS.ProcessEnv, path: string | undefined, options: { readonly owner?: string; readonly dryRun?: boolean; readonly repo?: string } = {}): ConfigCommandResult {
  try {
    if (options.repo !== undefined) return finishRestore(restoreRepository(env, options.repo, path, options), options.dryRun === true);
    const revert = (): UninstallItem[] => {
      if (path === undefined) throw new HostConfigError('host_config_invalid_path', 'name a file, or a repository with --repo');
      const paths = hostConfigPaths(env);
      const target = resolveHostPath(paths, path);
      const gate = openHostConfigGate({ env, preview: options.dryRun === true });
      const others = options.owner === undefined ? [] : (options.dryRun ? readProjectedLedger : readLedger)(paths).fragments.filter((entry) => entry.file === target && entry.owner !== options.owner);
      const entries = gate.revert([path], options.owner === undefined ? {} : { owner: options.owner });
      if (!entries.length) return [{ path: target, action: 'note', reason: options.owner === undefined ? 'rh has no record of this file' : `rh records no fragment of ${options.owner} in this file` }];
      return [...entries.map(revertItem), ...others.map((entry): UninstallItem => ({ path: target, action: 'kept', reason: `${entry.selector}: owned by ${entry.owner}` }))];
    };
    return finishRestore(options.dryRun ? revert() : withRuntimeTransactionLock(globalRuntimeScope(env), () => { migrateInstallState(env); return revert(); }), options.dryRun === true);
  } catch (error) { return failure(error); }
}

function finishRestore(items: readonly UninstallItem[], dryRun: boolean): ConfigCommandResult {
  const exitCode = exitCodeOf(items);
  return { exitCode, lines: [...items.map((item) => `[${item.action}] ${item.path}: ${item.reason}`), `[restore] ${exitCode === 2 ? 'failed' : exitCode === 1 ? 'partial' : 'complete'}${dryRun ? ' (dry-run)' : ''}`], json: { exitCode, dryRun, items } };
}

/**
 * `--repo`: the records of one repository ledger under the selected worktree
 * root (D5, D6), or the one record at `path`. The dry run and the apply share
 * one read-only plan; the apply plans again under the runtime lock and runs no
 * user-level migration, since it never reads the user ledger. A record that
 * the target rule or the staging check refuses stays, with its reason.
 */
function restoreRepository(env: NodeJS.ProcessEnv, repo: string, path: string | undefined, options: { readonly owner?: string; readonly dryRun?: boolean }): UninstallItem[] {
  const repository = resolveHostConfigRepository(repo);
  const only = path === undefined ? undefined : hostPathKey(repositoryConfigPaths(env, repository), path);
  const run = (): UninstallItem[] => {
    const plan = repositoryRestorePlan(env, repository, { only, owner: options.owner });
    const entries = options.dryRun ? plan.entries : revertRepositoryPaths(env, repository, plan);
    return [...entries.map(revertItem), ...plan.refused.map((entry): UninstallItem => ({ path: entry.path, action: 'kept', reason: entry.reason }))];
  };
  return options.dryRun ? run() : withRuntimeTransactionLock(globalRuntimeScope(env), run);
}

export function runConfigGc(env: NodeJS.ProcessEnv, options: { readonly dryRun?: boolean; readonly now?: Date } = {}): ConfigCommandResult {
  try {
    const run = (): GcResult => collectRetired(env, options);
    const result = options.dryRun ? run() : withRuntimeTransactionLock(globalRuntimeScope(env), () => { migrateInstallState(env); return run(); });
    const verb = options.dryRun ? 'would delete' : 'deleted';
    return { exitCode: result.changed.length ? 1 : 0, json: result,
      lines: [...result.deleted.map((path) => `[gc] ${verb} ${path}`),
        ...result.changed.map((path) => `[unresolved] ${path}: no longer the retired copy (edited or replaced); kept with its retirement record`),
        `[gc] ${result.deleted.length} ${verb}; ${result.waiting} retired copies younger than 30 days kept${options.dryRun ? ' (dry-run)' : ''}`] };
  } catch (error) { return failure(error); }
}

function emit(result: ConfigCommandResult, json: boolean | undefined): never {
  if (json) console.log(JSON.stringify(result.json, null, 2));
  else for (const line of result.lines) console.log(line);
  process.exit(result.exitCode);
}

export function buildConfigCommand(): Command {
  const config = new Command('config').description('Show and revert what rh changed in host configuration files');
  config.command('status').description('Paths, sha256 and states of every file and path that rh records; no values')
    .option('--json', 'Output JSON').action((opts: { json?: boolean }) => emit(runConfigStatus(process.env), opts.json));
  config.command('diff <path>').description("rh's fragments in one file, by hash")
    .option('--show-values', 'Also print text that the ledger proves rh wrote; any other value prints as its size and hash')
    .option('--json', 'Output JSON')
    .action((path: string, opts: { json?: boolean; showValues?: boolean }) => emit(runConfigDiff(process.env, resolve(path), { showValues: opts.showValues }), opts.json));
  config.command('restore [path]').description("Revert rh's changes in one file, or in one repository with --repo")
    .option('--repo <dir>', "Revert rh's recorded files in the worktree of this repository")
    .option('--owner <id>', 'Revert only the fragments of this owner')
    .option('--dry-run', 'Report the revert and write nothing')
    .option('--json', 'Output JSON')
    .action((path: string | undefined, opts: { json?: boolean; owner?: string; dryRun?: boolean; repo?: string }) =>
      emit(runConfigRestore(process.env, path === undefined ? undefined : resolve(path), { owner: opts.owner, dryRun: opts.dryRun, repo: opts.repo === undefined ? undefined : resolve(opts.repo) }), opts.json));
  config.command('gc').description('Delete vault copies of reverts that finished 30 days ago and that no record references')
    .option('--dry-run', 'List the copies and delete nothing')
    .option('--json', 'Output JSON')
    .action((opts: { json?: boolean; dryRun?: boolean }) => emit(runConfigGc(process.env, { dryRun: opts.dryRun }), opts.json));
  return config;
}
