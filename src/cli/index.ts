#!/usr/bin/env bun
import { buildStrategyCommand } from './commands/strategy';
import { CLI_NAME } from '../core/skill-surface/cli-name';
import { globalRuntimeScope, withRuntimeTransactionLock, type RuntimeTransactionContext } from '../effects/locking/runtime-transaction-lock';
import { openHostConfigGate, type AntigravityMcpUndo } from '../effects/host-config/gate';
import { hostConfigPaths } from '../effects/host-config/store';
/**
 * repo-harness CLI entry.
 *
 * Wires commander.js to the global runtime bootstrap, repo-local update,
 * hook adapter, status, doctor, migrate, security, and tool command bodies.
 */

import { Command, CommanderError } from 'commander';
import { resolve } from 'path';
import { assertOverridesCarried, formatHostConfigPreview, hasRecordedAntigravityState, previewHostConfig, resolveOverrides, runInstall, runUninstall, type HostConfigPreview, type HostConfigPreviewItem, type InstallCommandOptions, type InstallCommandResult } from './commands/install';
import { installStatePendingMigration, migrateInstallState, planInstallStateMigration } from './installer/install-state-migration';
import { PLUGIN_IDS, type PluginId } from '../core/skill-surface/plugin-manifest';
import { writeAllSync } from './runtime/write-all-sync';
import { runInit } from './commands/init';
import { CLI_VERSION, formatStatus, runStatus } from './commands/status';
import { formatDoctor, runDoctor, type DoctorPorts } from './commands/doctor';
import { buildSetupCommand } from './commands/setup-check';
import { buildReviewCommand } from './commands/review';
import { buildUpgradeCommand } from './commands/upgrade';
import { assertPluginCommandSelected, declareArchitectureSelection, pluginSelected, readRecordedSelection, recordedPlugins } from './installer/architecture-selection';
import { buildHerdrCommand } from './commands/herdr';
import { buildEventsCommand } from './commands/events';
import { buildCapabilityCommand } from './commands/capability';
import { buildDocsCommand } from './commands/docs';
import { buildConfigCommand } from './commands/config';
import { buildMcpCommand } from './commands/mcp';
import { buildRunCommand } from './commands/run';
import { buildVerifyCommand } from './commands/verify';
import { buildStateCommand } from './commands/state';
import { buildPublicationCommand } from './commands/publication';
import { buildBoardCommand } from './commands/board';
import { attentionWatchDoctorCheck } from '../effects/board/attention-watch';
import { readLocalRepositoryId } from '../effects/board/collect';
import { githubRemoteRepository } from '../core/board/source';
import { attentionHostPorts, boardHostPorts } from '../effects/terminal/herdr-core';
import { buildFleetCommand } from './commands/fleet';
import { buildBotsCommand } from './commands/bots';
import { buildOperatorCommand } from './commands/operator';
import { buildWorktreesCommand } from './commands/worktrees';
import { buildSeatsCommand } from './commands/seats';
import { buildCatchUpCommand } from './commands/catch-up';
import { buildQuotaCommand } from './commands/quota';
import { buildRulesCommand } from './commands/rules';
import { buildArchCommand } from './commands/arch';
import { buildArchitectureDebtCommand } from './commands/architecture-debt';
import { buildArchitectureProjectionCommand } from './commands/architecture-projection';
import { buildModuleCommand } from './commands/module';
import { buildRefactorCommand } from './commands/refactor';
import { buildCodegraphCommand } from './commands/tools';
import { buildRetentionCommand, type RetentionPorts } from './commands/retention';
import { MCP_AUDIT_LOG_RELATIVE_PATH } from '../core/public-projections/mcp-audit-log';
import { TASK_INBOX_V2_RELATIVE_PATH } from '../core/fleet/task-inbox-layout';
import { formatSecurityScan, runSecurityScan } from './commands/security';
import { MIN_BUN_VERSION, bunVersionIsSupported, installAntigravityRuntime, runGlobalRuntimeSetup, updateLeftoverSummary, updateRegisteredUpgradeSummary, type GlobalRuntimeOptions, type GlobalRuntimeResult } from './commands/global-runtime';
import { parseReportLanguageFlag, REPORT_LANGUAGE_FLAG_VALUES, type ReportLanguageFlag } from './installer/global-context';
import { installStateStatus, readInstallState, rollbackInstallSelection, withHostConfigTransaction } from './installer/install-profile';
import { enabledPlugins } from './installer/install-state';
import { runAdoptionPlan } from './commands/adoption-plan';
import { buildCommandsCommand, recordCommandPlugin } from './commands/commands';
import { assertAdapterTarget, assertTarget, assertLocation, assertAdoptionMode } from './commands/validators';
import { migrateInstallStateLocked, registerArchitecturePlugin, runGlobalRuntimeBootstrap, runTransactionalRuntimeRefresh, runTransactionalSelectionProjection, type GlobalRuntimeCommandOptions } from './runtime-transaction';
import { runCandidateRuntimeReconciliation } from './candidate-runtime-reconciliation';

// The recorded selection, read once per process. Core reaches the architecture code only through the ports.
const recordedSelection = readRecordedSelection();
if (pluginSelected(recordedSelection, 'architecture')) registerArchitecturePlugin();
else declareArchitectureSelection(recordedSelection);

/** A plugin command stays in help; its handler checks the selection before any probe or write, then loads the plugin code. */
function pluginCommand(command: Command, id: PluginId, name: string = command.name()): Command {
  recordCommandPlugin(command, id);
  return command.hook('preAction', () => assertPluginCommandSelected(recordedSelection, id, name));
}

/** The MCP sidecar logs, for a selected plugin only: the lazy load keeps every other process free of MCP code. */
function selectedMcpLogs(): readonly string[] {
  if (!pluginSelected(recordedSelection, 'mcp')) return [];
  const { MCP_INDEX_EVENTS_RELATIVE_PATH, MCP_METRICS_RELATIVE_PATH, MCP_TRACE_RELATIVE_PATH } = require('./mcp/log-paths') as typeof import('./mcp/log-paths');
  return [MCP_INDEX_EVENTS_RELATIVE_PATH, MCP_METRICS_RELATIVE_PATH, MCP_TRACE_RELATIVE_PATH, MCP_AUDIT_LOG_RELATIVE_PATH];
}

/**
 * The plugin checks, setup steps and storage roots that core commands take as
 * parameters. This root is the only importer of their implementations. Tests
 * and the setup check child pass the same value.
 */
export const CLI_PORTS: {
  readonly doctor: DoctorPorts;
  readonly retention: RetentionPorts;
} = {
  doctor: { attentionWatchCheck: (cwd) => attentionWatchDoctorCheck(attentionHostPorts(), () => readLocalRepositoryId({ repo_root: cwd }, url => githubRemoteRepository(url) !== null)) },
  retention: {
    rotatingLogs: selectedMcpLogs(),
    commonProtocolRoots: [TASK_INBOX_V2_RELATIVE_PATH],
  },
};

const TARGET_HELP = 'codex|claude|both';
const ADAPTER_TARGET_HELP = `${TARGET_HELP}|antigravity`;
const LOCATION_HELP = 'global';

const OVERRIDE_HELP = 'Let rh write the fragment at <path>#<selector> over a value that rh did not write (repeatable)';

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function loadAntigravityCodegraph() {
  return require('./tools/codegraph') as typeof import('./tools/codegraph');
}

function targetedCodegraphChange(command: 'install' | 'update', env: NodeJS.ProcessEnv, dryRun: boolean) {
  const codegraph = loadAntigravityCodegraph();
  const name = `${command} --target antigravity --configure-codegraph`;
  const projected = installStatePendingMigration(env) ? planInstallStateMigration(env)?.state : null;
  if (projected) {
    // Refuse an ineligible legacy state or MCP path before committing its migration.
    assertPluginCommandSelected({ status: 'recorded', selection: projected.selection, plugins: enabledPlugins(projected) }, 'architecture', name, env);
    codegraph.preflightAntigravityCodegraph(env, true);
  }
  if (!dryRun) migrateInstallState(env);
  if (!dryRun || !projected) assertPluginCommandSelected(readRecordedSelection(env), 'architecture', name, env);
  if (!projected) codegraph.preflightAntigravityCodegraph(env, true);
  return codegraph.prepareAntigravityCodegraph(process.cwd(), env);
}

function previewTargetedCodegraph(command: 'install' | 'update', env: NodeJS.ProcessEnv, hostConfig: HostConfigPreview): HostConfigPreview {
  const change = targetedCodegraphChange(command, env, true);
  const { path, selector, action, ledgerAction } = openHostConfigGate({ env, preview: true }).previewAntigravityMcp(change);
  const items: HostConfigPreviewItem[] = [...hostConfig.items];
  if (action) items.push({ path, selector, action });
  if (ledgerAction) items.push({ path: hostConfigPaths(env).ledger, selector: `${path}#${selector}`, action: ledgerAction });
  return { ...hostConfig, items, notListed: hostConfig.notListed.filter(writer => writer !== 'CodeGraph configuration') };
}

class TargetedAdapterFailure extends Error {
  constructor(readonly result: InstallCommandResult) { super(result.lines.join('\n')); }
}

function runTargetedCodegraph(
  command: 'install' | 'update',
  env: NodeJS.ProcessEnv,
  runtimeLock: RuntimeTransactionContext,
  runAdapters: (transaction: string) => InstallCommandResult,
): InstallCommandResult {
  const change = targetedCodegraphChange(command, env, false);
  let mcpUndo: AntigravityMcpUndo | undefined;
  try {
    return withHostConfigTransaction(env, undefined, transaction => {
      const config = openHostConfigGate({ env }).apply([change], { onAntigravityMcpWrite: undo => { mcpUndo = undo; } });
      const status = config.skipped[0]?.code ?? (config.written.length ? 'changed' : 'unchanged');
      const adapters = runAdapters(transaction);
      if (adapters.exitCode !== 0) throw new TargetedAdapterFailure(adapters);
      return { exitCode: 0, lines: [...adapters.lines, `[antigravity] ${status}: configure CodeGraph MCP - ${change.path}`] };
    }, undefined, { runtimeLock, snapshotPaths: [hostConfigPaths(env).ledger], antigravityMcpUndo: () => mcpUndo });
  } catch (error) {
    if (error instanceof TargetedAdapterFailure) return error.result;
    throw error;
  }
}

/** The runtime transaction invokes this while it still holds its lock and rollback snapshot. */
function refreshRuntimeWithAntigravityCodegraph(options: GlobalRuntimeOptions): GlobalRuntimeResult {
  const result = runGlobalRuntimeSetup(options);
  if (result.exitCode !== 0 || !options.plugins?.includes('architecture')) return result;
  const env = options.env ?? process.env;
  const step = loadAntigravityCodegraph().configureAntigravityCodegraphStep(options.cwd ?? process.cwd(), env);
  if (!step) return result;
  const line = `[runtime] ${step.status}: ${step.step} - ${step.detail}`;
  return {
    ...result,
    exitCode: step.status === 'failed' ? 1 : 0,
    steps: [...result.steps, step],
    lines: [...result.lines, line],
    stdout: [result.stdout, line].filter(Boolean).join('\n'),
    stderr: step.status === 'failed' ? step.detail ?? '' : result.stderr,
  };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name(CLI_NAME)
    .description('Make Claude/Codex work resumable, reviewable, and repo-local')
    .addHelpText('after', '\nGlobal shortcuts:\n  -V, --version  output the version number')
    .exitOverride();

  program
    .command('install')
    .description('Install the global runtime or, for --location global or --target antigravity, only hook adapters')
    .option('--target <target>', `Target host: ${ADAPTER_TARGET_HELP}`, 'both')
    .option('--plugins <ids>', `Enable exactly these comma-separated plugins (${PLUGIN_IDS.join('|')}); omitted, every plugin that this host can run`)
    .option('--no-plugins', 'Enable core only')
    .option('--dry-run', 'Print the install/keep/remove plugin plan without writing')
    .option('--state', 'Print the effective install state without writing')
    .option('--rollback', 'Restore the previous install state')
    .option('--location <location>', `Adapter-only install location: ${LOCATION_HELP}`)
    .option('--no-cli', 'Skip installing the repo-harness CLI globally')
    .option('--no-sync-skill', 'Skip refreshing repo-harness skill aliases under host skill roots')
    .option('--no-hooks', 'Skip global hook adapter installation during full runtime install')
    .option('--no-external-skills', 'Skip mutable third-party Waza and Mermaid skill bootstrap')
    .option('--with-obsidian-skills', 'Explicitly install the pinned obsidian-markdown and obsidian-cli companion Skills')
    .option('--configure-codegraph', 'Configure CodeGraph MCP with --target antigravity')
    .option('--no-codegraph', 'Skip CodeGraph CLI/MCP configuration')
    .option('--report-language <language>', `Reporting language for Global Working Rules that record none: ${REPORT_LANGUAGE_FLAG_VALUES.join('|')}`)
    .option('--override <path#selector>', OVERRIDE_HELP, collectOption, [])
    .option('--json', 'Output JSON instead of human-readable text')
    .action(async (rawOpts: GlobalRuntimeCommandOptions & { location?: string; state?: boolean; rollback?: boolean; configureCodegraph?: boolean }, cmd: Command) => {
      const target = assertAdapterTarget(rawOpts.target, 'install');
      const location = rawOpts.location === undefined ? undefined : assertLocation(rawOpts.location, 'install');
      if (rawOpts.configureCodegraph && target !== 'antigravity') throw new Error('rh install --configure-codegraph requires --target antigravity');
      const configureCodegraph = rawOpts.configureCodegraph === true && rawOpts.codegraph !== false;
      const env = process.env;
      // Adapter-only installs validate the install-state protocol under the runtime lock.
      const installAdapters = (adapterOptions: Pick<InstallCommandOptions, 'reportLanguage' | 'syncSkill' | 'hooks' | 'updateMode'> = {}) =>
        withRuntimeTransactionLock(globalRuntimeScope(env), runtimeLock => {
          const installAntigravity = () => installAntigravityRuntime(env, runtimeLock, { ...adapterOptions, externalSkills: rawOpts.externalSkills });
          // The scoped MCP edit precedes the runtime's adapter transaction under the same lock.
          if (configureCodegraph) return runTargetedCodegraph('install', env, runtimeLock, () => installAntigravity());
          migrateInstallState(env);
          readInstallState(env);
          return target === 'antigravity' ? installAntigravity() : runInstall({ target, location: location ?? 'global' });
        });
      if (target === 'antigravity') {
        if (rawOpts.state || rawOpts.rollback || rawOpts.plugins !== undefined || rawOpts.override?.length || rawOpts.withObsidianSkills) {
          throw new Error('rh install --target antigravity only installs Antigravity hooks, global rules, and skills');
        }
        if (rawOpts.hooks === false) throw new Error('rh install --target antigravity requires hooks');
        const reportLanguage = rawOpts.reportLanguage === undefined ? undefined : parseReportLanguageFlag(rawOpts.reportLanguage);
        const adapterOptions = { reportLanguage, syncSkill: rawOpts.syncSkill, hooks: true, updateMode: false };
        if (rawOpts.dryRun) {
          const adapters = previewHostConfig(target, [], env, adapterOptions);
          const hostConfig = configureCodegraph ? previewTargetedCodegraph('install', env, adapters) : adapters;
          if (rawOpts.json) console.log(JSON.stringify({ host_config: hostConfig }, null, 2));
          else for (const line of formatHostConfigPreview(hostConfig)) console.log(line);
          process.exit(hostConfig.unplanned.length ? 1 : 0);
        }
        const result = installAdapters(adapterOptions);
        if (rawOpts.json) console.log(JSON.stringify(result, null, 2));
        else for (const line of result.lines) console.log(line);
        process.exit(result.exitCode);
      }
      if (rawOpts.reportLanguage !== undefined && rawOpts.location !== undefined) {
        throw new Error('--report-language cannot be combined with --location');
      }
      if (rawOpts.plugins !== undefined && (rawOpts.state === true || rawOpts.rollback === true || rawOpts.location !== undefined)) {
        throw new Error('--plugins and --no-plugins cannot be combined with --state, --rollback, or --location');
      }
      if (rawOpts.dryRun === true && rawOpts.location !== undefined) {
        throw new Error('--dry-run cannot be combined with --location');
      }
      if (rawOpts.override?.length && (rawOpts.state === true || rawOpts.rollback === true || rawOpts.location !== undefined)) {
        throw new Error('--override cannot be combined with --state, --rollback, or --location');
      }
      if (rawOpts.state === true) {
        const state = readInstallState();
        console.log(JSON.stringify(state ? installStateStatus(state) : null, null, 2));
        process.exit(state ? 0 : 1);
      }
      if (rawOpts.rollback === true) {
        migrateInstallStateLocked(process.env);
        const current = readInstallState();
        if (!current?.previous) throw new Error('no previous install transaction to roll back');
        const plugins = enabledPlugins(current.previous);
        const transaction = runTransactionalSelectionProjection({ selection: current.previous.selection, run: plugins, record: plugins }, {
          target,
          installCli: false,
          syncSkill: true,
          hostAdapters: true,
          externalSkills: true,
          codegraph: plugins.includes('architecture'),
        }, (transaction) => rollbackInstallSelection(process.env, transaction));
        const result = transaction.result;
        const restored = transaction.state;
        if (rawOpts.json === true) {
          console.log(JSON.stringify({ ...result, restored_state: restored }, null, 2));
        } else {
          for (const line of result.lines) console.log(line);
          if (restored) console.log(`[plugins] restored=${enabledPlugins(restored).join(',') || '(core only)'}`);
        }
        process.exit(result.exitCode);
      }
      if (location === undefined) {
        await runGlobalRuntimeBootstrap(rawOpts, cmd);
        return;
      }
      const result = installAdapters();
      for (const line of result.lines) console.log(line);
      process.exit(result.exitCode);
    });

  program
    .command('init')
    .description('Install or refresh the repo-local harness workflow in an existing repo')
    .option('--repo <path>', 'Target repository path (defaults to cwd)')
    .option('--dry-run', 'Plan repo harness changes without applying them')
    .option('--target <target>', `Host target for readiness checks: ${TARGET_HELP}`, 'both')
    .option('--no-verify', 'Skip repo workflow verification after apply')
    .option('--no-codegraph', 'Skip building the CodeGraph index and MCP readiness check')
    .option('--mode <mode>', 'Adoption mode: minimal|standard|self-host', 'standard')
    .option('--sync-codegraph', 'Sync the CodeGraph index after ensure')
    .option('--json', 'Output JSON instead of human-readable text')
    .action(async (rawOpts: {
      repo?: string;
      dryRun?: boolean;
      target: string;
      verify?: boolean;
      codegraph?: boolean;
      mode?: string;
      syncCodegraph?: boolean;
      json?: boolean;
    }) => {
      const target = assertTarget(rawOpts.target, 'init');
      const mode = assertAdoptionMode(rawOpts.mode ?? 'standard', 'init');
      // The planner reads documentation authoring env only from its options,
      // so the public command boundary supplies the real process environment.
      const env = process.env;
      if (rawOpts.dryRun === true) {
        const plan = runAdoptionPlan({
          repo: rawOpts.repo,
          mode,
          json: rawOpts.json === true,
          explicitRepo: rawOpts.repo !== undefined,
          env,
        });
        writeAllSync(1, plan.output);
        process.exit(plan.exitCode);
      }
      const common = {
        repo: rawOpts.repo,
        apply: true,
        target,
        verify: rawOpts.verify !== false,
        codegraph: rawOpts.codegraph !== false,
        syncCodegraph: rawOpts.syncCodegraph === true,
        mode,
        env,
      };
      const result = runInit({ ...common, plugins: recordedPlugins(recordedSelection) });
      if (rawOpts.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const line of result.lines) console.log(line);
      }
      process.exit(result.exitCode);
    });

  program
    .command('update')
    .description('Update the global repo-harness CLI and user-level managed runtime')
    .option('--target <target>', `Host target: ${ADAPTER_TARGET_HELP}. Antigravity refreshes its recorded hook locally`, 'both')
    .option('--version <version>', 'Install a specific repo-harness package version')
    .option('--channel <channel>', 'Install package channel: latest|next')
    .option('--no-cli', 'Skip installing the repo-harness CLI globally')
    .option('--no-sync-skill', 'Skip refreshing repo-harness skill aliases under host skill roots')
    .option('--no-hooks', 'Skip global hook adapter installation')
    .option('--with-external-skills', 'Also refresh mutable third-party Waza and Mermaid providers')
    .option('--with-obsidian-skills', 'Explicitly install or verify the pinned obsidian-markdown and obsidian-cli companion Skills')
    .option('--no-external-skills', 'Do not refresh third-party Waza and Mermaid providers (default)')
    .option('--configure-codegraph', 'Refresh CodeGraph CLI/MCP or configure MCP for --target antigravity')
    .option('--no-codegraph', 'Skip refreshing the global CodeGraph CLI/MCP')
    .option('--report-language <language>', `Reporting language for Global Working Rules that record none: ${REPORT_LANGUAGE_FLAG_VALUES.join('|')}`)
    .option('--override <path#selector>', OVERRIDE_HELP, collectOption, [])
    .option('--dry-run', 'Print the local host-config plan; start no package install')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: {
      target: string;
      version?: string;
      channel?: string;
      cli?: boolean;
      syncSkill?: boolean;
      hooks?: string | false;
      withExternalSkills?: boolean;
      withObsidianSkills?: boolean;
      externalSkills?: boolean;
      codegraph?: boolean;
      configureCodegraph?: boolean;
      reportLanguage?: string;
      override: string[];
      dryRun?: boolean;
      json?: boolean;
    }) => {
      const target = assertAdapterTarget(rawOpts.target, 'update');
      const configureCodegraph = rawOpts.configureCodegraph === true && rawOpts.codegraph !== false;
      if (target === 'antigravity') {
        if (rawOpts.version || rawOpts.channel || rawOpts.override.length || rawOpts.withObsidianSkills || rawOpts.withExternalSkills) {
          throw new Error('rh update --target antigravity refreshes recorded Antigravity hooks, global rules, skills, and optional CodeGraph MCP');
        }
        const reportLanguage = rawOpts.reportLanguage === undefined ? undefined : parseReportLanguageFlag(rawOpts.reportLanguage);
        const env = process.env;
        const adapterOptions = { reportLanguage, syncSkill: rawOpts.syncSkill, updateMode: true, hooks: rawOpts.hooks !== false };
        if (rawOpts.dryRun) {
          const selected = hasRecordedAntigravityState(env, true);
          const adapters = previewHostConfig(selected ? target : null, [], env, adapterOptions);
          const hostConfig = configureCodegraph ? previewTargetedCodegraph('update', env, adapters) : adapters;
          if (rawOpts.json) console.log(JSON.stringify({ host_config: hostConfig, candidate_changes: 'unavailable' }, null, 2));
          else for (const line of formatHostConfigPreview(hostConfig)) console.log(line);
          process.exit(hostConfig.unplanned.length ? 1 : 0);
        }
        const refreshAdapters = (transaction?: string) => hasRecordedAntigravityState(env, false)
          ? runInstall({ target, location: 'global', ...adapterOptions, transaction })
          : { exitCode: 0, lines: ['[antigravity] no recorded hook member; run rh install --target antigravity to install it'] };
        const result = withRuntimeTransactionLock(globalRuntimeScope(env), runtimeLock => {
          if (configureCodegraph) return runTargetedCodegraph('update', env, runtimeLock, refreshAdapters);
          migrateInstallState(env);
          return refreshAdapters();
        });
        if (rawOpts.json) console.log(JSON.stringify(result, null, 2));
        else for (const line of result.lines) console.log(line);
        process.exit(result.exitCode);
      }
      if (rawOpts.channel !== undefined && !['latest', 'next'].includes(rawOpts.channel)) {
        console.error('rh update: invalid --channel (expected: latest, next)');
        process.exit(2);
      }
      if (rawOpts.reportLanguage !== undefined && !REPORT_LANGUAGE_FLAG_VALUES.includes(rawOpts.reportLanguage as ReportLanguageFlag)) {
        console.error(`rh update: invalid --report-language (expected: ${REPORT_LANGUAGE_FLAG_VALUES.join(', ')})`);
        process.exit(2);
      }
      const hostAdapters = rawOpts.hooks === false ? null : target;
      const overrides = resolveOverrides(rawOpts.override, process.env);
      assertOverridesCarried(hostAdapters, overrides, process.env);
      if (rawOpts.dryRun === true) {
        const hostConfig = previewHostConfig(hostAdapters, overrides, process.env);
        if (rawOpts.json === true) console.log(JSON.stringify({ host_config: hostConfig, candidate_changes: 'unavailable' }, null, 2));
        else {
          for (const line of formatHostConfigPreview(hostConfig)) console.log(line);
          console.log('[update] dry run: the current local host changes only; candidate-version changes are unavailable in a dry run');
        }
        process.exit(0);
      }
      const installSpec = rawOpts.version
        ? `repo-harness@${rawOpts.version}`
        : rawOpts.channel
          ? `repo-harness@${rawOpts.channel}`
          : 'repo-harness@latest';
      const refreshAntigravity = target === 'both' && configureCodegraph;
      const result = runTransactionalRuntimeRefresh({
        target,
        installCli: rawOpts.cli !== false,
        installSpec,
        updateMode: true,
        syncSkill: rawOpts.syncSkill !== false,
        hostAdapters: rawOpts.hooks !== false,
        externalSkills: rawOpts.externalSkills === false ? false : rawOpts.withExternalSkills === true ? true : undefined,
        obsidianSkills: rawOpts.withObsidianSkills === true,
        codegraph: rawOpts.codegraph === false ? false : rawOpts.configureCodegraph === true ? true : undefined,
        reportLanguage: rawOpts.reportLanguage as ReportLanguageFlag | undefined,
        overrides,
      }, refreshAntigravity ? refreshRuntimeWithAntigravityCodegraph : undefined, refreshAntigravity ? (env, plugins) => {
        if (plugins.includes('architecture')) loadAntigravityCodegraph().preflightAntigravityCodegraph(env);
      } : undefined);
      if (result.exitCode === 0) {
        result.lines.push(updateLeftoverSummary(process.cwd(), rawOpts.cli !== false));
        result.lines.push(updateRegisteredUpgradeSummary(process.cwd(), rawOpts.cli !== false));
      }
      if (rawOpts.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        for (const line of result.lines) console.log(line);
      }
      process.exit(result.exitCode);
    });

  program
    .command('uninstall')
    .description('Remove owned user-level configuration; preserve user changes and static history')
    .option('--target <target>', `Target host: ${ADAPTER_TARGET_HELP}`, 'both')
    .option('--location <location>', `Install location: ${LOCATION_HELP}`, 'global')
    .option('--dry-run', 'Preview cleanup without filesystem writes')
    .option('--remove-edited-block <path>', 'Also remove the rules block in this file when you edited it; the whole file goes to the vault first (repeatable)', (value: string, previous: string[]) => [...previous, resolve(value)], [] as string[])
    .option('--with-tools', 'Also remove herdr-core, its hc link and the user PATH entry that rh installed, where they still hold what rh wrote')
    .option('--json', 'Output the cleanup result as JSON')
    .action((rawOpts: { target: string; location: string; dryRun?: boolean; json?: boolean; removeEditedBlock: string[]; withTools?: boolean }) => {
      const target = assertAdapterTarget(rawOpts.target, 'uninstall');
      const location = assertLocation(rawOpts.location, 'uninstall');
      if (rawOpts.withTools && target !== 'both') {
        console.error('rh uninstall: --with-tools needs --target both; the shared tools serve both hosts');
        process.exit(2);
      }
      const uninstallAdapters = () => runUninstall({ target, location, dryRun: rawOpts.dryRun, removeEditedBlocks: rawOpts.removeEditedBlock, withTools: rawOpts.withTools });
      const result = uninstallAdapters();
      if (rawOpts.json) console.log(JSON.stringify(result, null, 2));
      else for (const line of result.lines) console.log(line);
      process.exit(result.exitCode);
    });

  program
    .command('status')
    .description('Show CLI version, host install status, route coverage, and repo opt-in state')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: { json?: boolean }) => {
      const report = runStatus();
      console.log(formatStatus(report, rawOpts.json === true));
      process.exit(0);
    });

  program
    .command('doctor')
    .description('Run read-only readiness diagnostics (PATH, version, hosts, trust state)')
    .option('--json', 'Output JSON instead of human-readable text')
    .action((rawOpts: { json?: boolean }) => {
      const report = runDoctor(CLI_PORTS.doctor);
      console.log(formatDoctor(report, rawOpts.json === true));
      process.exit(report.summary.fail > 0 ? 1 : 0);
    });

  const loadReviewRunner = async () => (await import('../effects/review-runner/task-review-runner')).taskReviewRunner;
  const review = buildReviewCommand(loadReviewRunner);
  for (const name of ['round', 'status', 'close', 'cancel']) {
    const command = review.commands.find(candidate => candidate.name() === name);
    if (!command) throw new Error(`review ${name} is not defined`);
    pluginCommand(command, 'peer-runtime', `review ${name}`);
  }
  program.addCommand(review);
  program.addCommand(buildSetupCommand(CLI_PORTS.doctor));
  program.addCommand(buildUpgradeCommand());

  const security = program
    .command('security')
    .description('Read-only security checks for local hook and editor task configs');
  security
    .command('scan')
    .description('Scan Claude/Codex hook configs and VS Code folder-open tasks')
    .option('--json', 'Output JSON instead of human-readable text')
    .option('--strict', 'Exit non-zero when high-risk or failed findings are present')
    .action((rawOpts: { json?: boolean; strict?: boolean }) => {
      const report = runSecurityScan();
      console.log(formatSecurityScan(report, rawOpts.json === true));
      const strictFailure = report.findings.some((finding) => finding.severity === 'high' || finding.severity === 'fail');
      process.exit(rawOpts.strict === true && strictFailure ? 1 : 0);
    });

  program.addCommand(pluginCommand(buildHerdrCommand(), 'peer-runtime'));
  program.addCommand(pluginCommand(buildEventsCommand(), 'peer-runtime'));
  program.addCommand(buildCapabilityCommand());
  program.addCommand(buildDocsCommand());
  program.addCommand(buildConfigCommand());
  const mcp = buildMcpCommand();
  for (const name of ['serve', 'doctor']) {
    const command = mcp.commands.find(candidate => candidate.name() === name);
    if (!command) throw new Error(`mcp ${name} is not defined`);
    pluginCommand(command, 'mcp', `mcp ${name}`);
  }
  program.addCommand(mcp);
  program.addCommand(buildRunCommand());
  program.addCommand(buildVerifyCommand());
  program.addCommand(buildStateCommand());
  program.addCommand(buildPublicationCommand());
  program.addCommand(buildBoardCommand(boardHostPorts(), attentionHostPorts()));
  program.addCommand(buildFleetCommand());
  program.addCommand(buildBotsCommand());
  const operator = buildOperatorCommand(loadReviewRunner);
  const investigation = operator.commands.find(command => command.name() === 'cleanup-investigation-job');
  if (!investigation) throw new Error('operator cleanup-investigation-job is not defined');
  pluginCommand(investigation, 'peer-runtime', 'operator cleanup-investigation-job');
  program.addCommand(pluginCommand(operator, 'operator'));
  const worktrees = buildWorktreesCommand();
  for (const name of ['list', 'clean', 'path']) {
    const command = worktrees.commands.find(candidate => candidate.name() === name);
    if (!command) throw new Error(`worktrees ${name} is not defined`);
    pluginCommand(command, 'operator', `worktrees ${name}`);
  }
  program.addCommand(worktrees);
  program.addCommand(pluginCommand(buildCatchUpCommand(), 'operator'));
  program.addCommand(buildQuotaCommand());
  program.addCommand(buildRulesCommand(boardHostPorts()));
  const arch = buildArchCommand();
  // addCommand, not command(): a child made by command() copies the settings of `rh arch` and would lose its help and strict options.
  for (const child of [buildArchitectureProjectionCommand(), buildArchitectureDebtCommand(), buildModuleCommand(), buildRefactorCommand(), buildCodegraphCommand()]) arch.addCommand(child);
  program.addCommand(pluginCommand(arch, 'architecture'));
  program.addCommand(pluginCommand(buildStrategyCommand(), 'strategy-memory'));
  program.addCommand(buildCommandsCommand(() => program));
  program.addCommand(buildRetentionCommand(CLI_PORTS.retention));
  // The seat reset posts notices through the notify relay only when peer-runtime is selected.
  program.addCommand(buildSeatsCommand(pluginSelected(recordedSelection, 'peer-runtime')
    ? async () => (await import('../effects/terminal/notify-relay')).postNotifyEvent : undefined));
  program
    .command('__reconcile-installed-runtime', { hidden: true })
    .description('Internal candidate-owned managed runtime reconciliation')
    .requiredOption('--request <base64url>', 'Parent transaction capability payload')
    .action((rawOpts: { request: string }) => {
      try {
        console.log(JSON.stringify(runCandidateRuntimeReconciliation(rawOpts.request)));
        process.exit(0);
      } catch (error) {
        console.error(`candidate reconciliation: ${(error as Error).message}`);
        process.exit(1);
      }
    });

  return program;
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const bunVersion = process.versions.bun;
  if (!bunVersionIsSupported(bunVersion)) {
    throw new Error(
      `repo-harness requires Bun >= ${MIN_BUN_VERSION}; found ${bunVersion ?? 'unknown'}. Upgrade Bun and retry.`,
    );
  }
  const args = argv.slice(2);
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
    console.log(CLI_VERSION);
    return;
  }
  await buildProgram().parseAsync(argv);
}

if (import.meta.main) {
  try {
    await runCli(process.argv);
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    // Commander already printed its own parse and help messages. Every other error prints here, also one with an exitCode.
    if (!(err instanceof CommanderError) && e.message) console.error(e.message);
    process.exit(typeof e.exitCode === 'number' ? e.exitCode : 1);
  }
}
