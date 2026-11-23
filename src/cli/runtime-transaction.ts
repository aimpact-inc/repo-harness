/**
 * The global runtime host transactions: install bootstrap, selection
 * projection, update refresh and their rollback. They load the architecture
 * and MCP plugin code lazily, so this module stays with the composition root.
 */
import { globalRuntimeScope, withRuntimeTransactionLock } from '../effects/locking/runtime-transaction-lock';
import { migrateCodexConfigRecords } from './installer/codex-config-migration';
import { randomBytes } from 'crypto';
import { existsSync, lstatSync } from 'fs';
import { createInterface } from 'readline/promises';
import { assertOverridesCarried, formatHostConfigPreview, previewHostConfig, resolveOverrides } from './commands/install';
import { planPiPackage } from './installer/pi-package';
import { migrateRuntimeHostConfig } from './installer/install-profile';
import { installStatePendingMigration, migrateInstallState, planInstallStateMigration } from './installer/install-state-migration';
import { requireHome } from '../effects/repo-harness-home';
import { parsePluginList, selectionLabel, type PluginId, type PluginSelection } from '../core/skill-surface/plugin-manifest';
import { registerArchitecturePorts } from '../core/architecture/contracts';
import { reconciledByCandidate, runGlobalRuntimeSetup, type GlobalRuntimeOptions, type GlobalRuntimeResult, type McpLocalConfigCheck } from './commands/global-runtime';
import { parseReportLanguageFlag } from './installer/global-context';
import { publishCandidateReconciliationCapability } from './commands/candidate-reconciliation';
import { sha256Prefixed } from '../core/evidence/sha256';
import { windowsProtectedHelperConfigPath } from '../effects/runtime/protected-helper-platform';
import { providerSkillLock } from '../effects/host-skill-roots';
import type { AntigravityMcpUndo } from '../effects/host-config/gate';
import { applyInstallSelection, assertArchitecturePolicySelection, beginInstallHostTransaction, commitInstallHostTransaction, planSkillSync, installProfileTransactionPaths, keptPluginLine, commandPluginRepairLines, notAddedPluginLine, planInstallSelection, prepareInstallSelectionSwitch, readInstallState, requireInstallState, resolveRecordedSelection, rollbackInstallHostTransaction, skippedPluginLine, type InstallState, type SelectionResolution } from './installer/install-profile';
import { enabledPlugins } from './installer/install-state';
import { type ExclusiveDirectoryLockHandle } from '../effects/locking/exclusive-directory-lock';
import { assertTarget } from './commands/validators';

let architectureRegistered = false;

/**
 * Loads and registers the architecture providers, once. The root calls it
 * only for a selected plugin: at start for the recorded selection, and in
 * install, update and candidate reconciliation when their plugin set adds
 * it. In-process tests of a selected plugin call it too.
 */
export function registerArchitecturePlugin(): void {
  if (architectureRegistered) return;
  const { ARCHITECTURE_PROVIDERS } = require('../effects/architecture/providers') as typeof import('../effects/architecture/providers');
  const { ARCHITECTURE_SETUP_PROVIDER } = require('./commands/architecture-setup') as typeof import('./commands/architecture-setup');
  const { CODEGRAPH_PROVIDER } = require('./tools/codegraph') as typeof import('./tools/codegraph');
  registerArchitecturePorts({ ...ARCHITECTURE_PROVIDERS, setup: ARCHITECTURE_SETUP_PROVIDER, codegraph: CODEGRAPH_PROVIDER });
  architectureRegistered = true;
}

/** Update's MCP preflight: loaded here and only when core calls it, which it does for a selected mcp plugin. */
export const mcpLocalConfigCheck: McpLocalConfigCheck = env => (require('./mcp/local-config-check') as typeof import('./mcp/local-config-check')).checkMcpLocalConfigFile(env);

export interface GlobalRuntimeCommandOptions {
  target: string;
  cli?: boolean;
  syncSkill?: boolean;
  hooks?: string | false;
  externalSkills?: boolean;
  withObsidianSkills?: boolean;
  codegraph?: boolean;
  reportLanguage?: string;
  json?: boolean;
  /** `--plugins a,b` gives a string; `--no-plugins` gives false; neither gives undefined. */
  plugins?: string | false;
  dryRun?: boolean;
  /** Each `--override <path>#<selector>`, in order. */
  override?: string[];
}

/** Minimal duck-typed slice of `Command` so tests can fake option-value sourcing without constructing a real commander `Command`. */
export interface OptionSourceLookup {
  getOptionValueSource(key: string): string | undefined;
}

export interface ResolveOptionalRuntimeDepsOptions {
  interactive: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Resolve the two user-selectable optional dependencies (external skills,
 * CodeGraph) for the `init`/`install` global runtime bootstrap.
 *
 * Non-interactive (non-TTY, or `--json`): mutable external skills are opt-in;
 * CodeGraph follows the command's explicit/default option value.
 *
 * Interactive: for each item not explicitly passed on the CLI (i.e. its
 * option value source isn't `'cli'`), prompt; Enter/`y` keeps the command's
 * configured default, `n` skips it. Explicit flags are honored without prompting.
 */
export async function resolveOptionalRuntimeDeps(
  rawOpts: GlobalRuntimeCommandOptions,
  cmd: OptionSourceLookup | undefined,
  opts: ResolveOptionalRuntimeDepsOptions,
): Promise<{ externalSkills: boolean; codegraph: boolean }> {
  let externalSkills = rawOpts.externalSkills === true;
  let codegraph = rawOpts.codegraph === true;
  if (!opts.interactive) return { externalSkills, codegraph };

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input, output, terminal: false });
  try {
    if (cmd?.getOptionValueSource('externalSkills') !== 'cli') {
      const answer = (await rl.question('Install external skills (Waza, Mermaid, cross-review)? [y/N]: ')).trim().toLowerCase();
      output.write('\n');
      externalSkills = answer === 'y' || answer === 'yes';
    }
    if (cmd?.getOptionValueSource('codegraph') !== 'cli') {
      const answer = (await rl.question('Install CodeGraph CLI and configure its MCP server? [y/N]: ')).trim().toLowerCase();
      output.write('\n');
      codegraph = answer === 'y' || answer === 'yes';
    }
  } finally {
    rl.close();
  }
  return { externalSkills, codegraph };
}

/** A selection on its way into a host transaction: its kind, the setup set (`run`) and the recorded set (`record`). */
interface TransactionSelection {
  readonly selection: PluginSelection;
  readonly run: readonly PluginId[];
  readonly record: readonly PluginId[];
}

export function runTransactionalSelectionProjection(
  selected: TransactionSelection,
  options: GlobalRuntimeOptions,
  commitState: (transaction: ReturnType<typeof beginInstallHostTransaction>, result: GlobalRuntimeResult) => InstallState,
): { result: GlobalRuntimeResult; state: InstallState | null } {
  const plugins = selected.run;
  const transactionEnv = runtimeHostTransactionEnv(options.env);
  // An invalid XDG_STATE_HOME must fail before the lock creates transaction state.
  providerSkillLock(transactionEnv.HOME!, transactionEnv);
  return withRuntimeTransactionLock(globalRuntimeScope(transactionEnv), (lock) => {
    // The one-shot state migration commits on its own before the snapshot, so a rollback keeps it.
    migrateInstallState(transactionEnv);
    if (options.hostAdapters !== false) migrateRuntimeHostConfig(transactionEnv);
    const transaction = beginInstallHostTransaction(runtimeHostMutationPaths(transactionEnv), transactionEnv, { runtimeLock: lock });
    let antigravityMcpRevert: AntigravityMcpUndo | undefined;
    const rollback = (cause: unknown) => rollbackRuntimeTransaction(transaction, cause, antigravityMcpRevert);
    let result: GlobalRuntimeResult;
    try {
      prepareInstallSelectionSwitch(selected.record, transactionEnv, transaction.backup_root, undo => { antigravityMcpRevert = undo; });
      if (plugins.includes('architecture')) registerArchitecturePlugin();
      result = runGlobalRuntimeSetup({ ...options, plugins, runtimeLock: lock, transaction: transaction.backup_root });
    } catch (error) {
      rollback(error);
      throw error;
    }
    if (result.exitCode !== 0) {
      rollback(new Error(`install failed: ${result.stderr || result.lines.join('; ') || `exit ${result.exitCode}`}`));
      return { result, state: null };
    }
    try {
      commitState(transaction, result);
      migrateCodexConfigRecords(transactionEnv);
      const state = requireInstallState(transactionEnv);
      commitInstallHostTransaction(transaction);
      return { result, state };
    } catch (error) {
      rollback(error);
      throw error;
    }
  });
}

export function refusedPaths(result: GlobalRuntimeResult): string[] {
  return result.steps.flatMap(step => step.refused_path ? [step.refused_path] : []);
}

/** Restore the snapshot bytes only. A failed restore keeps both errors. */
function restoreTransactionBytes(transaction: ReturnType<typeof beginInstallHostTransaction>, cause: unknown): void {
  try { rollbackInstallHostTransaction(transaction); } catch (restoreError) {
    throw new AggregateError([cause, restoreError], `runtime transaction failed and its restore failed: ${[cause, restoreError].map(item => (item instanceof Error ? item.message : String(item))).join('; ')}`);
  }
}

/** The ledger rollback also takes out a Pi package entry that the transaction recorded. */
function rollbackRuntimeTransaction(transaction: ReturnType<typeof beginInstallHostTransaction>, cause: unknown,
  antigravityMcpRevert?: AntigravityMcpUndo): void {
  const failures: unknown[] = [];
  try { rollbackInstallHostTransaction(transaction, { antigravityMcpUndo: antigravityMcpRevert }); } catch (error) { failures.push(error); }
  if (failures.length) {
    const errors = [cause, ...failures];
    throw new AggregateError(errors, `runtime transaction failed and compensation was incomplete: ${errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`);
  }
}

function runtimeHostTransactionEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const home = requireHome(env ?? process.env);
  return {
    ...process.env,
    ...env,
    HOME: home,
  };
}

/** The one-shot state migration under the runtime lock, for an entry point that reads the state before its transaction. */
export function migrateInstallStateLocked(env: NodeJS.ProcessEnv): void {
  // An invalid XDG_STATE_HOME must fail before the lock creates transaction state.
  providerSkillLock(requireHome(env), env);
  withRuntimeTransactionLock(globalRuntimeScope(env), () => migrateInstallState(env));
}

function runtimeHostMutationPaths(env: NodeJS.ProcessEnv): readonly string[] {
  const paths = [...installProfileTransactionPaths(env)];
  if (process.platform === 'win32') paths.push(windowsProtectedHelperConfigPath());
  return [...new Set(paths)];
}

function candidateHandoffContext(
  transaction: ReturnType<typeof beginInstallHostTransaction>,
  lock: ExclusiveDirectoryLockHandle,
): NonNullable<GlobalRuntimeOptions['candidateHandoff']> {
  const context = {
    transactionId: sha256Prefixed(transaction.backup_root),
    transactionBackupRoot: transaction.backup_root,
    parentToken: randomBytes(32).toString('hex'),
  };
  publishCandidateReconciliationCapability({
    transactionId: context.transactionId,
    transactionBackupRoot: context.transactionBackupRoot,
    parentToken: context.parentToken,
    parentPid: process.pid,
    lockPath: lock.lockPath,
    lockOwnerToken: lock.ownerToken,
  });
  return context;
}

export function runTransactionalRuntimeRefresh(
  options: GlobalRuntimeOptions,
  setup: (options: GlobalRuntimeOptions) => GlobalRuntimeResult = (setupOptions) => runGlobalRuntimeSetup(setupOptions),
  preflight?: (env: NodeJS.ProcessEnv, plugins: readonly PluginId[]) => void,
): GlobalRuntimeResult {
  const transactionEnv = runtimeHostTransactionEnv(options.env);
  // An invalid XDG_STATE_HOME must fail before the lock creates transaction state.
  providerSkillLock(transactionEnv.HOME!, transactionEnv);
  return withRuntimeTransactionLock(globalRuntimeScope(transactionEnv), (lock) => {
    // The one-shot state migration commits on its own before the snapshot, so a rollback keeps it.
    migrateInstallState(transactionEnv);
    let plugins: readonly PluginId[];
    // Null when the caller passes its own plugin set; then the recorded state does not change.
    let recordedSelection: { readonly state: InstallState; readonly resolved: SelectionResolution } | null = null;
    if (options.plugins !== undefined) plugins = options.plugins;
    else {
      const state = requireInstallState(transactionEnv);
      const resolved = resolveRecordedSelection(state, options.target ?? 'both', transactionEnv, {
        partial: options.syncSkill === false || options.hostAdapters === false,
      });
      recordedSelection = { state, resolved };
      plugins = resolved.run;
    }
    assertArchitecturePolicySelection(options.cwd ?? process.cwd(), plugins, transactionEnv);
    preflight?.(transactionEnv, plugins);
    if (options.hostAdapters !== false) migrateRuntimeHostConfig(transactionEnv);
    if (plugins.includes('architecture')) registerArchitecturePlugin();
    const transaction = beginInstallHostTransaction(runtimeHostMutationPaths(transactionEnv), transactionEnv, { runtimeLock: lock });
    let result: GlobalRuntimeResult;
    try {
      result = setup({ ...options, plugins, runtimeLock: lock, transaction: transaction.backup_root, candidateHandoff: candidateHandoffContext(transaction, lock), mcpLocalConfigCheck });
    } catch (error) {
      rollbackRuntimeTransaction(transaction, error);
      throw error;
    }
    // After a candidate handoff the parent reads and writes no install state: the candidate
    // version may record plugins that this version does not know. A failure restores bytes only.
    const byCandidate = reconciledByCandidate(result);
    if (result.exitCode !== 0) {
      const cause = new Error(`runtime refresh failed: ${result.stderr || result.lines.join('; ') || `exit ${result.exitCode}`}`);
      if (byCandidate) restoreTransactionBytes(transaction, cause);
      else rollbackRuntimeTransaction(transaction, cause);
      return result;
    }
    try {
      if (!byCandidate) {
        if (recordedSelection !== null) {
          const { state, resolved } = recordedSelection;
          if (selectionChanged(state, resolved)) {
            applyInstallSelection(state.selection, resolved.record, transactionEnv, new Date(), transaction, {
              kept: resolved.kept.map(entry => entry.id), refused: refusedPaths(result),
            });
          }
          result = { ...result, lines: [...selectionLines(resolved), ...commandPluginRepairLines(state.selection), ...result.lines] };
        }
        migrateCodexConfigRecords(transactionEnv);
      }
      commitInstallHostTransaction(transaction);
      return result;
    } catch (error) {
      if (byCandidate) restoreTransactionBytes(transaction, error);
      else rollbackRuntimeTransaction(transaction, error);
      throw error;
    }
  });
}

/** True when the resolved record set differs from the recorded plugin ids, so the state must commit it. */
function selectionChanged(state: InstallState, resolved: SelectionResolution): boolean {
  return resolved.record.join(',') !== enabledPlugins(state).join(',');
}

export function selectionLines(resolved: Pick<SelectionResolution, 'skipped' | 'kept'> & { readonly notAdded?: readonly PluginId[] }): string[] {
  return [
    ...resolved.skipped.map(skippedPluginLine),
    ...resolved.kept.map(keptPluginLine),
    ...(resolved.notAdded ?? []).map(notAddedPluginLine),
  ].map(line => `[plugins] ${line}`);
}

export async function runGlobalRuntimeBootstrap(
  rawOpts: GlobalRuntimeCommandOptions,
  cmd?: OptionSourceLookup,
): Promise<never> {
  const target = assertTarget(rawOpts.target, 'install');
  const hostAdapters = rawOpts.hooks === false ? null : target;
  const overrides = resolveOverrides(rawOpts.override ?? [], process.env);
  assertOverridesCarried(hostAdapters, overrides, process.env);
  if (rawOpts.dryRun !== true) migrateInstallStateLocked(process.env);
  // A dry run on a protocol 3 state plans with the migration's projection and writes nothing.
  const projected = rawOpts.dryRun === true && installStatePendingMigration(process.env) ? planInstallStateMigration(process.env) : null;
  const current = projected?.state ?? readInstallState();
  // `--plugins` selects exactly its ids, `--no-plugins` core only, and neither `all`.
  const selection: PluginSelection = rawOpts.plugins === false ? [] : rawOpts.plugins === undefined ? 'all' : parsePluginList(rawOpts.plugins);
  const resolved = resolveRecordedSelection({ selection, plugins: current?.plugins ?? [] }, target);
  const { run: plugins, record } = resolved;
  assertArchitecturePolicySelection(process.cwd(), plugins);
  const basePlan = planInstallSelection(selection, resolved, current, process.env);
  const plan = { ...basePlan,
    pi_package: planPiPackage(basePlan.pi_package.source, plugins.includes('pi') && target === 'both' && rawOpts.hooks !== false),
    skill_projections: rawOpts.syncSkill === false ? [] : basePlan.skill_projections.filter(projection => projection.host !== 'pi' || target === 'both'),
  };
  if (rawOpts.dryRun === true) {
    const removedDanglingSkillLinks = rawOpts.syncSkill === false ? [] : planSkillSync(plugins).retired
      .filter(path => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(path));
    const hostConfig = previewHostConfig(hostAdapters, overrides, process.env);
    if (rawOpts.json === true) console.log(JSON.stringify({ ...plan, removedDanglingSkillLinks, host_config: hostConfig }, null, 2));
    else {
      console.log(`[plugins] selection=${selectionLabel(selection)}`);
      console.log(`[plugins] requested=${record.join(',') || '(core only)'} current=${plan.current_plugins === null ? 'none' : plan.current_plugins.join(',') || '(core only)'}`);
      console.log(`[plugins] install=${plan.install.join(',') || '(none)'}`);
      console.log(`[plugins] keep=${plan.keep.join(',') || '(none)'}`);
      console.log(`[plugins] remove=${plan.remove.join(',') || '(none)'}`);
      for (const line of selectionLines(resolved)) console.log(line);
      for (const link of removedDanglingSkillLinks) console.log(`[sync-installed] would remove dangling skill symlink: ${link}`);
      for (const line of formatHostConfigPreview(hostConfig)) console.log(line);
    }
    process.exit(0);
  }
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && rawOpts.json !== true;
  // Waza and Mermaid are core and fetched by default; CodeGraph follows the architecture plugin.
  const defaults = { externalSkills: true, codegraph: plugins.includes('architecture') };
  const selectedDefaults = {
    externalSkills: cmd?.getOptionValueSource('externalSkills') === 'cli'
      ? rawOpts.externalSkills !== false
      : defaults.externalSkills,
    codegraph: cmd?.getOptionValueSource('codegraph') === 'cli'
      ? rawOpts.codegraph !== false && defaults.codegraph
      : defaults.codegraph,
  };
  const { externalSkills, codegraph } = interactive
    ? await resolveOptionalRuntimeDeps({
        ...rawOpts,
        externalSkills: selectedDefaults.externalSkills,
        codegraph: selectedDefaults.codegraph,
      }, cmd, { interactive })
    : selectedDefaults;
  const transaction = runTransactionalSelectionProjection({ selection, run: plugins, record }, {
    target,
    installCli: rawOpts.cli !== false,
    syncSkill: rawOpts.syncSkill !== false,
    hostAdapters: rawOpts.hooks !== false,
    externalSkills,
    obsidianSkills: rawOpts.withObsidianSkills === true,
    codegraph,
    reportLanguage: rawOpts.reportLanguage === undefined ? undefined : parseReportLanguageFlag(rawOpts.reportLanguage),
    overrides,
  }, (transaction, result) => (
    applyInstallSelection(
      selection,
      record,
      process.env,
      new Date(),
      transaction,
      { kept: resolved.kept.map(entry => entry.id), refused: refusedPaths(result) },
    ).state
  ));
  const result = transaction.result;
  const installed = transaction.state;
  if (rawOpts.json === true) {
    console.log(JSON.stringify({ ...result, install_plan: plan, installed_state: installed }, null, 2));
  } else {
    console.log(`[plugins] ${record.join(',') || '(core only)'}`);
    for (const line of selectionLines(resolved)) console.log(line);
    for (const line of result.lines) console.log(line);
  }
  process.exit(result.exitCode);
}
