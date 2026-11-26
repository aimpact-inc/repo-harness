import { globalConfigurationPath, mutateGlobalConfiguration, restoreGlobalConfiguration } from '../../effects/configuration/global-configuration';
import { publishFileByRename, retryWindowsSharingRace } from '../../effects/atomic-append';
import wazaRules from "../../core/skill-surface/waza-shared-rules.json";
import { bunGlobalPackageRoot, expectedSkillProjections } from './skill-projection';
import { configurationReceiptPath } from './configuration-ownership';
import { expectedOf, hostConfigPaths, hostConfigPathsAt, observeFile, putVault, readLedger, removeTarget, replaceTarget, repositoryLedgers, resolveHostPath } from '../../effects/host-config/store';
import { ensureSelfIgnoringDirectory, isSelfIgnoreGuard, SELF_IGNORE_NAME } from '../../effects/self-ignoring-directory';
import { antigravityAgentsDirHostPath, antigravityMcpConfigHostPath, AntigravityHooksPathError, antigravitySkillsDirHostPath, openHostConfigGate, piGlobalRulesHostPath, planPathRevert, recoverRetiredPathWrites, rollbackHostConfigTransaction, type AntigravityMcpUndo } from '../../effects/host-config/gate';
import { AGY_SEAT_AGENT_DIR_PATTERN } from '../../core/board/seat-launch';
import { namingTomlFile } from '../../core/host-config/toml-fragment';
import { migrateCodexConfigRecords } from './codex-config-migration';
import { migrateJsonConfigRecords } from './json-config-migration';
import { antigravityDirMatches, pathRecordIsCurrent, pathRecordKey, pathRecordsDigest, readPathRecords, readPathRecordSet, registerSupportedPathRecords, writePathRecords, type PathRecords } from '../../effects/host-config/path-records';
import { HostConfigError, type HostPath, type PathCommitted, type PathRecord, type PathRecordHost, type PathRecordKind } from '../../core/host-config/types';
import { globalContextBackupEligible, globalContextPath } from './global-context';
import { acquireRuntimeTransactionLock, assertRuntimeTransactionContext, globalRuntimeScope, runtimeTransactionLockRelativePath, runtimeTransactionRoot, withRuntimeTransactionContext, type RuntimeTransactionContext, type RuntimeTransactionLock, type RuntimeTransactionScope } from '../../effects/locking/runtime-transaction-lock';
import { exclusiveDirectoryLockOwnerLiveness, readExclusiveDirectoryLockOwner } from '../../effects/locking/exclusive-directory-lock';
import { currentProcessStartTime } from '../../effects/locking/process-start-time';
import { randomUUID } from 'crypto';
import { windowsProtectedHelperConfigPath } from '../../effects/runtime/protected-helper-platform';
import { isRecord } from '../../core/evidence/is-record';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { requireHome } from '../../effects/repo-harness-home';
import { basename, dirname, join, posix, win32 } from 'path';
import {
  compareManagedHookProjection,
  type HookHost,
} from './managed-entries';
import {
  mutationPathSkillNames as catalogMutationPathSkillNames,
  requiredExplicitExternalDependencyInstallGroups,
  validateSkillSurfaceCatalogValue,
  selectionOwnedSkillNames,
  facadesForSelection,
  hostSkillPlacements,
  type SkillSurfaceCatalog,
} from '../../core/skill-surface/catalog';
import {
  COMMAND_PLUGINS,
  HOST_PROGRAM_PLUGINS,
  installSelectionCommand,
  UPDATE_COMMAND,
  isCommandPlugin,
  isHostProgramPlugin,
  isSurfaceOwner,
  ownerEnabled,
  PLUGIN_IDS,
  type PluginId,
  type PluginSelection,
  type SurfaceOwner,
} from '../../core/skill-surface/plugin-manifest';
import { antigravitySkillRoot, hostSkillRoot, providerSkillLock, stagedSkillRoot, syncSkillRoots, type SkillHost } from '../../effects/host-skill-roots';
import { MANAGED_AGENTS } from '../../effects/terminal/task-role-profiles';
import { hashManagedTree } from '../../effects/managed-tree';
import { readWorkflowPolicyDocument } from '../../effects/state/resolve-effective-state';
import { POLICY_ABSENT, POLICY_PATH, isPolicyObject, policyValue } from '../../core/workflow/policy-schema';
import { capabilitySourceModeOf } from '../../effects/architecture/capability-resolver';
import { ownedPiPackages, piPackagePresent, piPackageRemoval, planPiPackage, recordedPiPackages, removePiPackage, type PiPackageStep } from './pi-package';
import { piExecutable } from '../../effects/pi-executable';
import skillSurfaceManifest from '../../../assets/skill-commands/manifest.json';
import { version as PACKAGE_VERSION } from '../../../package.json';
import { pluginRepair } from './architecture-selection';
import { RETIRED_CLI_NAME } from '../../core/skill-surface/cli-name';
import {
  enabledPlugins,
  INSTALL_STATE_PROTOCOL,
  installProfileStatePath,
  InstallStateError,
  readRecordedInstallState,
  type RecordedInstallSnapshot,
  type RecordedInstallState,
} from './install-state';

/**
 * Parses this package's own skill-surface manifest. Not parameterized by
 * env/sourceRoot: install-profile.ts manages installed state at the user's
 * HOME, not a foreign source tree, so its manifest is always the running
 * package's own file. The module system resolves it at build time in a bundle
 * and at load time in source. Fails closed before any caller mutates host
 * state. Deliberately does not pass an `exists` callback for package sources.
 */
export function loadSkillSurfaceCatalog(): SkillSurfaceCatalog {
  const resolution = validateSkillSurfaceCatalogValue(skillSurfaceManifest, { declared: true });
  if (resolution.status !== 'valid') {
    const detail = resolution.diagnostics.map((d) => `${d.code} ${d.path}: ${d.message}`).join('; ');
    throw new Error(`invalid skill-surface catalog assets/skill-commands/manifest.json: ${detail}`);
  }
  return resolution.catalog;
}

export const INSTALL_HOSTS = ['claude', 'codex', 'pi'] as const;
const AGENT_FLEET_FILE = new RegExp(
  `/(?:\\.claude/agents/(?:${MANAGED_AGENTS.join('|')})\\.md|\\.codex/agents/(?:${MANAGED_AGENTS.join('|')})\\.toml)$`,
);

/** The recorded state after the source check of each Pi package. Host path ownership lives in the ledger's path records. */
export type InstallState = RecordedInstallState;

export type InstallStateSnapshot = RecordedInstallSnapshot;

/** One ledger path record as `rh install --state` shows it. */
export interface OwnershipEntry {
  readonly path: string;
  readonly owner: string;
  readonly host: PathRecordHost;
  readonly kind: PathRecordKind;
  readonly type: PathCommitted['type'];
  readonly current: boolean;
}

export interface OwnerProbe {
  readonly status: 'present' | 'missing';
  readonly evidence: readonly string[];
  /** The named checks that found no evidence. */
  readonly missing: readonly string[];
}

export interface InstallStateStatus extends InstallState {
  /** A projection of the ledger's path records. */
  readonly ownership: readonly OwnershipEntry[];
  /** Record keys outside the root of their host: rh does not act on them, and the next record write drops them. */
  readonly ownership_outside_root: readonly string[];
  /** Record keys that name no install surface (path, owner or kind): rh does not act on them, and the next record write drops them. */
  readonly ownership_unsupported: readonly string[];
  /** `core` and each enabled plugin. */
  readonly probes: Readonly<Partial<Record<SurfaceOwner, OwnerProbe>>>;
  readonly drift: {
    readonly status: 'consistent' | 'drift';
    readonly missing_owners: readonly SurfaceOwner[];
    readonly surface_drift: readonly string[];
  };
}

/** A host plugin that the `all` selection does not run or record, because its host program or target is absent. */
export interface SkippedPlugin {
  readonly id: PluginId;
  readonly reason: string;
  /** The command that adds the plugin after the host program is installed. */
  readonly command: string;
}

/** A recorded host plugin of the `all` selection whose host program or target is now absent. */
export interface KeptPlugin {
  readonly id: PluginId;
  readonly reason: string;
  /** The explicit selection that removes the plugin. */
  readonly command: string;
}

/**
 * The plugin set of a selection on this host. `run` drives the setup steps;
 * `record` is the set that the install state stores. They differ only by the
 * `kept` plugins, whose ledger surfaces stay untouched.
 */
export interface SelectionResolution {
  readonly run: readonly PluginId[];
  readonly record: readonly PluginId[];
  readonly skipped: readonly SkippedPlugin[];
  readonly kept: readonly KeptPlugin[];
  /** Plugins that a complete refresh would add; a partial refresh never grows the recorded set. */
  readonly notAdded: readonly PluginId[];
}

interface HostSurfaceSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly backup_path: string | null;
}

export interface InstallHostTransaction {
  readonly protocol: 1;
  readonly backup_root: string;
  readonly snapshots: readonly HostSurfaceSnapshot[];
}

export interface InstallPlan {
  readonly hosts: typeof INSTALL_HOSTS;
  readonly pi_package: PiPackageStep;
  readonly skill_projections: ReturnType<typeof expectedSkillProjections>;
  readonly protocol: typeof INSTALL_STATE_PROTOCOL;
  readonly selection: PluginSelection;
  readonly requested_plugins: readonly PluginId[];
  readonly current_plugins: readonly PluginId[] | null;
  readonly install: readonly PluginId[];
  readonly keep: readonly PluginId[];
  readonly remove: readonly PluginId[];
  readonly skipped: readonly SkippedPlugin[];
  readonly state_path: string;
}

export const CODEGRAPH_CONFIG_MARKER = 'codegraph-config-projection';

function adapterHasRequiredProjection(path: string, host: HookHost, env: NodeJS.ProcessEnv): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: unknown };
    const projection = compareManagedHookProjection(parsed.hooks ?? {}, host, env);
    // A selection transition may probe still-present managed routes before the
    // installer rewrites the adapter. Extra routes are tolerated by this
    // presence probe, but any required route field drift, duplicate, or
    // missing route is not.
    return projection.error === undefined && projection.mismatches.every((mismatch) => mismatch.kind === 'unexpected');
  } catch {
    return false;
  }
}

const FACADE_NAME_PREFIX = 'repo-harness-';

const SKILL_HOSTS: readonly SkillHost[] = ['codex', 'claude', 'pi'];

function hostSkillRoots(home: string, env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return [...new Set([...SKILL_HOSTS.map(host => hostSkillRoot(home, host, env)), ...effectiveSkillRoots(PLUGIN_IDS, env)])];
}

/**
 * The skill hosts that a selection manages. The Pi root is the `pi` plugin's
 * surface, so discovery and probes never read it without `pi`: a copy left
 * there is not evidence and not a record.
 */
function selectedSkillHosts(plugins: readonly PluginId[]): readonly SkillHost[] {
  return SKILL_HOSTS.filter((host) => host !== 'pi' || plugins.includes('pi'));
}

/**
 * Discovery records every owner-marked repo-harness-* directory, including a
 * name that later leaves the catalog. The state reader accepts the same
 * bounded set, so a committed receipt stays readable until removal.
 */
function isDiscoveredFacadePath(path: string, home: string, env: NodeJS.ProcessEnv): boolean {
  const name = basename(path);
  return name.startsWith(FACADE_NAME_PREFIX) && hostSkillRoots(home, env).some((root) => join(root, name) === path);
}

/**
 * The plugin manifest's surface map for paths outside the skill catalog, and
 * the catalog owner for skill paths. The Pi skill root is the `pi` plugin's
 * surface, whatever package it holds. Null means that no selection owns the path.
 */
export function ownerForInstallPath(path: string, env: NodeJS.ProcessEnv = process.env, suppliedCatalog?: SkillSurfaceCatalog): SurfaceOwner | null {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1) ?? '';
  const home = requireHome(env);
  const inAntigravity = dirname(path) === antigravitySkillRoot(home);
  const inSkills = inAntigravity || [...hostSkillRoots(home, env), stagedSkillRoot(home)].includes(dirname(path));
  if (inSkills && normalized.startsWith(`${hostSkillRoot(home, 'pi', env).replaceAll('\\', '/')}/`)) return 'pi';
  if (name === 'repo-harness' && inSkills) return 'core';
  if (inSkills) {
    const catalog = suppliedCatalog ?? loadSkillSurfaceCatalog();
    const pkg = catalog.packages.find(entry => entry.name === name);
    if (inAntigravity) return pkg?.hosts.includes('antigravity') ? pkg.owner : null;
    if (pkg?.kind === 'facade' || pkg?.kind === 'provider-skill') return pkg.owner;
    // The installer writes the Herdr skill itself (configureRequiredHerdrSkill), outside the selection projection.
    if (pkg?.name === 'herdr') return pkg.owner;
    if (selectionOwnedSkillNames(catalog).includes(name)) return pkg!.owner;
    const obsidianSelection = requiredExplicitExternalDependencyInstallGroups(catalog, 'obsidian-memory', ['claude', 'codex']);
    if (obsidianSelection.status !== 'selected') {
      throw new Error(`invalid Obsidian dependency selection: ${obsidianSelection.status}:${obsidianSelection.name}`);
    }
    if (obsidianSelection.groups.some(({ skills }) => skills.includes(name))) return pkg!.owner;
  }
  if (AGENT_FLEET_FILE.test(normalized)) return 'core';
  if (wazaRules.files.includes(name) && /\/(?:\.agents|\.codex|\.claude)\/rules\/[^/]+$/.test(normalized)) return 'core';
  if (normalized.endsWith('/bin/codegraph')) return 'architecture';
  if (normalized.endsWith('/bin/archctx')) return 'architecture';
  if (normalized.endsWith('/bin/rh')) return 'core';
  // The retired 0.32 CLI link; `rh update` removes it inside the host transaction.
  if (normalized.endsWith('/bin/repo-harness')) return 'core';
  return null;
}

function fleetTargets(home: string, roles: readonly string[]) {
  return roles.flatMap((agent) => [
    { host: 'codex' as const, path: join(home, '.codex', 'agents', `${agent}.toml`) },
    { host: 'claude' as const, path: join(home, '.claude', 'agents', `${agent}.md`) },
  ]);
}

/** Generated agent fleet targets written by scripts/install-agent-fleet.sh. */
export function agentFleetTargetPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  return fleetTargets(requireHome(env), MANAGED_AGENTS).map(({ path }) => path);
}

const RETIRED_AGENT_ROLES = ['fast-worker', 'deep-worker', 'root-cause-prover', 'gatekeeper'];

// #3306 keeps these exact historical paths readable while older installs or their vault copies can still name them.
export function retiredAgentFleetTargets(env: NodeJS.ProcessEnv) {
  return fleetTargets(requireHome(env), RETIRED_AGENT_ROLES);
}

/** Exclude legacy adoption by recorded host and filename even after the user moves the host root. */
export function isHistoricalRetiredAgentRecord(key: string, record: PathRecord): boolean {
  if (record.owner !== 'core' || record.committed.type !== 'file' || (record.host !== 'claude' && record.host !== 'codex')) return false;
  const filename = basename(key);
  const extension = record.host === 'claude' ? '.md' : '.toml';
  return RETIRED_AGENT_ROLES.some(role => filename === `${role}${extension}`);
}

function recordKeyOrNull(env: NodeJS.ProcessEnv, path: string): string | null {
  try { return pathRecordKey(env, path); } catch { return null; }
}

function retiredAgentKeys(env: NodeJS.ProcessEnv): ReadonlyMap<string, 'codex' | 'claude'> {
  const keys = new Map<string, 'codex' | 'claude'>();
  for (const { path, host } of retiredAgentFleetTargets(env)) {
    const key = recordKeyOrNull(env, path);
    if (key !== null) keys.set(key, host);
  }
  return keys;
}

export function retiredAgentRecordCheck(env: NodeJS.ProcessEnv): (key: string, record: PathRecord) => boolean {
  const hosts = retiredAgentKeys(env);
  return (key, record) => hosts.get(key) === record.host && isHistoricalRetiredAgentRecord(key, record);
}

/** Called under the global runtime lock before rebuilding the ledger or taking a new snapshot. */
export function recoverRetiredAgentFleet(env: NodeJS.ProcessEnv, transaction?: string): void {
  recoverRetiredPathWrites(hostConfigPaths(env), retiredAgentKeys(env), transaction);
}

/** Retire recorded agents inside the install/update transaction. */
export function retireAgentFleet(env: NodeJS.ProcessEnv, transaction: string) {
  const isRetired = retiredAgentRecordCheck(env);
  const retired = Object.entries(readPathRecords(env)).filter(([key, record]) => isRetired(key, record)).map(([key]) => key);
  if (!retired.length) return [];
  return openHostConfigGate({ env }).revertPaths(retired, { transaction, retire: true });
}

const FLEET_RECEIPT = 'agent-fleet-user-managed.json';

/** The fleet receipt of a release before #2896, which the one-shot migration moves into the ledger. */
export function fleetReceiptPath(env: NodeJS.ProcessEnv): string {
  return join(requireHome(env), '.repo-harness', FLEET_RECEIPT);
}

/** The path records that a producer edits, by key. */
type RecordMap = Map<string, PathRecord>;

function ownerSelected(record: PathRecord, plugins: readonly PluginId[]): boolean {
  return record.kind === 'user_managed' || (isSurfaceOwner(record.owner) && ownerEnabled(record.owner, plugins));
}

/** The records that a selection commits: no record of a plugin outside `plugins`. */
function selectionRecords(records: RecordMap, plugins: readonly PluginId[]): Record<string, PathRecord> {
  return Object.fromEntries([...records].filter(([, record]) => ownerSelected(record, plugins)));
}

/**
 * The current records that a rebuilt set carries: each path still on disk
 * unchanged, each `user_managed` record, each `replaced` record (it holds the
 * vault reference of a user file), and every record of a kept plugin.
 */
function carriedRecords(prior: PathRecords, kept: readonly PluginId[] = []): RecordMap {
  return new Map(Object.entries(prior).filter(([key, record]) => (
    record.kind === 'user_managed' || record.kind === 'replaced' || (kept as readonly string[]).includes(record.owner) || pathRecordIsCurrent(key, record)
  )));
}

/** A Pi package source that an install may own: the Bun global package root, with the `pi` plugin enabled. */
export function validPiPackage(source: string, env: NodeJS.ProcessEnv, plugins: readonly PluginId[]): boolean {
  return plugins.includes('pi') && source === bunGlobalPackageRoot(env);
}

/**
 * The mandatory runtime dependencies that repo-harness pins in its package
 * dependencies. Bun hoists them beside the CLI package, so a CLI install
 * rewrites them and a host transaction must restore them with the CLI.
 */
export const ARCHCTX_PACKAGES = ['archctx', 'archctx-contracts'] as const;

export function installProfileHostMutationPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const home = requireHome(env);
  const bunRoot = env.BUN_INSTALL ?? join(home, '.bun');
  const { repoHarnessSkills: skills, externalSkills } = catalogMutationPathSkillNames(loadSkillSurfaceCatalog());
  const paths = [
    join(bunRoot, 'bin', 'rh'),
    join(bunRoot, 'bin', RETIRED_CLI_NAME),
    join(bunRoot, 'bin', 'archctx'),
    join(bunRoot, 'bin', 'codegraph'),
    join(bunRoot, 'install', 'global', 'package.json'),
    join(bunRoot, 'install', 'global', 'bun.lock'),
    join(bunRoot, 'install', 'global', 'bun.lockb'),
    join(bunRoot, 'install', 'global', 'node_modules', 'repo-harness'),
    join(bunRoot, 'install', 'global', 'node_modules', '@colbymchenry', 'codegraph'),
    ...ARCHCTX_PACKAGES.map(name => join(bunRoot, 'install', 'global', 'node_modules', name)),
    join(home, '.codex', 'hooks.json'),
    join(home, '.codex', 'config.toml'),
    // The gate writes the file that a dotfile link names, so the snapshot holds that file as well as the link.
    resolveHostPath(hostConfigPaths(env), join(home, '.codex', 'config.toml')),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude.json'),
    join(home, '.repo-harness', 'config.json'),
    installProfileStatePath(env),
    configurationReceiptPath(home),
    // A rollback that restores `~/.codex/config.toml` restores its ledger records with it.
    hostConfigPaths(env).ledger,
    providerSkillLock(home, env).path,
  ];
  for (const root of hostSkillRoots(home, env)) {
    for (const skill of [...skills, ...externalSkills]) paths.push(join(root, skill));
  }
  for (const skill of externalSkills) {
    paths.push(join(stagedSkillRoot(home), skill));
  }
  for (const rule of wazaRules.files) {
    paths.push(
      join(home, '.agents', 'rules', rule),
      join(home, '.codex', 'rules', rule),
      join(home, '.claude', 'rules', rule),
    );
  }
  paths.push(...agentFleetTargetPaths(env));
  // Install and update rewrite the managed Global Working Rules block. A path
  // whose copy would fail (unreadable or special file) stays out of the
  // backup; the rules plan skips that file and never writes it.
  for (const host of ['codex', 'claude'] as const) {
    const path = globalContextPath(home, host);
    if (globalContextBackupEligible(path)) paths.push(path);
  }
  return [...new Set(paths)];
}

/**
 * The install surfaces that a path record may name: the host mutation paths,
 * a repo-harness-* facade in a host skill root, and the exact retired fleet
 * paths for retirement and vault recovery. A record outside this set never
 * grants a write or a removal.
 */
export function supportedPathRecord(env: NodeJS.ProcessEnv): (key: string, record: PathRecord) => boolean {
  const keys = (paths: readonly string[]) => new Set(paths.map(path => recordKeyOrNull(env, path)).filter((key): key is string => key !== null));
  const isRetired = retiredAgentRecordCheck(env);
  const catalog = loadSkillSurfaceCatalog();
  const { repoHarnessSkills } = catalogMutationPathSkillNames(catalog);
  const antigravitySkillNames = new Set(
    catalog.packages
      .filter((pkg) => (pkg.source !== null && !pkg.explicitOnly && (pkg.kind === 'router' || pkg.kind === 'facade' || pkg.kind === 'provider-skill'))
      || (pkg.kind === 'external' && pkg.hosts.includes('antigravity')))
      .map((pkg) => pkg.name),
  );
  let antigravityRoots: { readonly skills: string; readonly agents: string } | null = null;
  const getAntigravityRoots = () => (antigravityRoots ??= {
    skills: antigravitySkillsDirHostPath(env),
    agents: antigravityAgentsDirHostPath(env),
  });
  const allowed = keys([...installProfileHostMutationPaths(env), ...effectiveSkillRoots(PLUGIN_IDS, env).flatMap(root => repoHarnessSkills.map(name => join(root, name)))]);
  const fleet = keys(agentFleetTargetPaths(env));
  const facadeRoots = new Set([...keys(hostSkillRoots(requireHome(env), env).map((root) => join(root, FACADE_NAME_PREFIX)))].map((key) => dirname(key)));
  return (key, record) => {
    if (isRetired(key, record)) return true;
    if (!isSurfaceOwner(record.owner)) return false;
    if (record.host === 'antigravity') {
      const { skills, agents } = getAntigravityRoots();
      const name = basename(key);
      if (record.kind !== 'created') return false;
      if (antigravityDirMatches(skills, dirname(key))) {
        return antigravitySkillNames.has(name) || name.startsWith(FACADE_NAME_PREFIX);
      }
      const agentDir = dirname(key);
      return name === 'agent.md'
        && AGY_SEAT_AGENT_DIR_PATTERN.test(basename(agentDir))
        && antigravityDirMatches(agents, dirname(agentDir))
        && record.owner === 'core'
        && record.committed.type === 'file';
    }
    return record.kind === 'user_managed'
      ? fleet.has(key)
      : allowed.has(key) || (basename(key).startsWith(FACADE_NAME_PREFIX) && facadeRoots.has(dirname(key)));
  };
}

registerSupportedPathRecords(supportedPathRecord);

function skippedOwnership(env: NodeJS.ProcessEnv): Pick<InstallStateStatus, 'ownership_outside_root' | 'ownership_unsupported'> {
  const { outside, unsupported } = readPathRecordSet(env);
  return { ownership_outside_root: outside, ownership_unsupported: unsupported };
}

/**
 * The skill roots that scripts/sync-codex-installed-copies.sh writes for a
 * selection. The shell reads the same syncSkillRoots result from
 * skill-surface-select.ts.
 */
export function effectiveSkillRoots(plugins: readonly PluginId[], env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const roots = syncSkillRoots(env, requireHome(env), plugins);
  return [roots.codex, roots.claude, roots.pi].filter((root): root is string => root !== null);
}

/** Only rh runtime files and the Bun package have whole-file snapshots. */
export function installProfileTransactionPaths(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const home = requireHome(env);
  const bunRoot = env.BUN_INSTALL ?? join(home, '.bun');
  return [
    ...['rh', RETIRED_CLI_NAME, 'archctx', 'codegraph'].map(name => join(bunRoot, 'bin', name)),
    ...['package.json', 'bun.lock', 'bun.lockb'].map(name => join(bunRoot, 'install/global', name)),
    ...['repo-harness', '@colbymchenry/codegraph', ...ARCHCTX_PACKAGES].map(name => join(bunRoot, 'install/global/node_modules', name)),
    globalConfigurationPath(env), installProfileStatePath(env), configurationReceiptPath(home), hostConfigPaths(env).ledger,
    ...(process.platform === 'win32' ? [windowsProtectedHelperConfigPath()] : []),
  ];
}

/**
 * The script receives only absent paths, current paths of the selected owner,
 * and unrecorded links that already name the exact source that the script
 * links there. 0.34.0 linked some facades into every root but recorded one.
 * `sourceRoot` is the exact root string that the writer gets: the targets are
 * built as the writer builds them (`$SOURCE_ROOT/$source`).
 */
export function planSkillSync(plugins: readonly PluginId[], env: NodeJS.ProcessEnv = process.env, catalog = loadSkillSurfaceCatalog(), sourceRoot?: string) {
  const { repoHarnessSkills } = catalogMutationPathSkillNames(catalog);
  const prior = readPathRecords(env);
  const selected = new Set(facadesForSelection(catalog, plugins));
  const linkSources = new Map<string, string>();
  if (sourceRoot !== undefined) {
    linkSources.set('repo-harness', sourceRoot);
    for (const pkg of catalog.packages) {
      if (pkg.kind !== 'facade' || pkg.source === null || !selected.has(pkg.name)) continue;
      const target = join(sourceRoot, pkg.source);
      if (existsSync(join(target, 'SKILL.md'))) linkSources.set(pkg.name, target);
    }
  }
  const declared = new Map<string, { path: string; owner: SurfaceOwner; adopt?: string }>();
  for (const root of effectiveSkillRoots(plugins, env)) {
    const names = new Set(repoHarnessSkills);
    if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of readdirSync(root)) {
        const path = join(root, name);
        if (name.startsWith(FACADE_NAME_PREFIX) || (lstatSync(path).isSymbolicLink() && !existsSync(path))) names.add(name);
      }
    }
    for (const name of names) {
      const path = join(root, name);
      const key = pathRecordKey(env, path);
      const record = prior[key];
      const owner = ownerForInstallPath(path, env, catalog) ?? (record && isSurfaceOwner(record.owner) ? record.owner : null);
      if (owner === null || (!ownerEnabled(owner, plugins) && !record)) continue;
      const entry = lstatSync(path, { throwIfNoEntry: false });
      const adopt = linkSources.get(name);
      if (entry && !record && adopt !== undefined && entry.isSymbolicLink() && readlinkSync(path) === adopt) {
        declared.set(key, { path, owner, adopt });
        continue;
      }
      if (entry && (!record || record.kind === 'user_managed'
        || record.owner !== owner || !pathRecordIsCurrent(key, record))) continue;
      declared.set(key, { path, owner });
    }
  }
  const providers = hostSkillPlacements(catalog);
  const integrations = new Set(catalog.packages.filter(pkg => pkg.kind === 'integration').map(pkg => pkg.name));
  const roots = syncSkillRoots(env, requireHome(env), plugins);
  const retired = [...declared.values()].filter(({ path }) => {
    const name = basename(path), root = dirname(path);
    const host = root === roots.codex ? 'codex' : root === roots.claude ? 'claude' : 'pi';
    return lstatExists(path) && name.startsWith(FACADE_NAME_PREFIX) && !selected.has(name) && !providers[host].includes(name) && !integrations.has(name);
  }).map(entry => entry.path);
  return { declared: [...declared.values()], retired };
}

/** Config adoption commits before the runtime snapshot, including a protocol 5 state with an older adapter. */
export function migrateRuntimeHostConfig(env: NodeJS.ProcessEnv): void {
  requireHome(env);
  migrateCodexConfigRecords(env);
  migrateJsonConfigRecords(env);
}

export function hostPathReplacementRefused(error: unknown): error is HostConfigError {
  return error instanceof HostConfigError && error.code === 'host_config_replacement_refused';
}

/** Standalone writers use the same runtime lock and transaction as install. */
export function withHostConfigTransaction<T>(env: NodeJS.ProcessEnv, transaction: string | undefined,
  run: (root: string, runtimeLock?: RuntimeTransactionContext) => T, beforeSnapshot?: () => void,
  held?: { readonly runtimeLock: RuntimeTransactionContext; readonly snapshotPaths: readonly string[]; readonly antigravityMcpUndo?: () => AntigravityMcpUndo | undefined }): T {
  requireHome(env);
  if (transaction !== undefined) return run(transaction);
  return withRuntimeTransactionContext(globalRuntimeScope(env), held?.runtimeLock, runtimeLock => {
    beforeSnapshot?.();
    const paths = held?.snapshotPaths ?? installProfileTransactionPaths(env);
    const current = beginInstallHostTransaction(paths, env, { runtimeLock });
    try {
      const result = run(current.backup_root, runtimeLock);
      commitInstallHostTransaction(current);
      return result;
    } catch (error) {
      try { rollbackInstallHostTransaction(current, { antigravityMcpUndo: held?.antigravityMcpUndo?.() }); }
      catch (restore) { throw new AggregateError([error, restore], 'host writer rollback failed'); }
      throw error;
    }
  });
}

const transactionLocks = new WeakMap<InstallHostTransaction, { context: RuntimeTransactionContext; owned: RuntimeTransactionLock | undefined; piRules: HostPath }>();

const TRANSACTION_PREFIX = 'install-';
/** The process that runs a transaction, in the lock owner's shape (PID and start time), and the paths that it snapshots by index. */
const TRANSACTION_OWNER = 'owner.json';

interface TransactionOwner {
  readonly pid: number;
  readonly startTime: string | null;
  readonly paths: readonly string[];
}

/** `none`: an earlier rh version wrote no record. `invalid`: the record proves nothing, so the directory stays. */
function readTransactionOwner(directory: string): TransactionOwner | 'none' | 'invalid' {
  const path = join(directory, TRANSACTION_OWNER);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return 'none';
  if (!stat.isFile()) return 'invalid';
  let record: { pid?: unknown; start_time?: unknown; paths?: unknown };
  try { record = JSON.parse(readFileSync(path, 'utf-8')); } catch { return 'invalid'; }
  if (!Number.isSafeInteger(record?.pid) || (record.pid as number) <= 0
    || !Array.isArray(record.paths) || !record.paths.every((entry) => typeof entry === 'string')) return 'invalid';
  const startTime = typeof record.start_time === 'string' && record.start_time !== '' ? record.start_time : null;
  return { pid: record.pid as number, startTime, paths: record.paths as string[] };
}

/**
 * Settle one copy against its host path. A copy equal to the host bytes goes.
 * A file copy that differs, or whose host file is gone, can be the only
 * preimage of that file, so it moves to the private vault. A link or directory
 * copy that differs stays where it is.
 */
function settleTransactionCopy(copy: string, host: string, env: NodeJS.ProcessEnv): void {
  const copied = lstatSync(copy);
  const current = lstatSync(host, { throwIfNoEntry: false });
  if (copied.isFile()) {
    const bytes = readFileSync(copy);
    if (!current?.isFile() || !readFileSync(host).equals(bytes)) {
      const paths = hostConfigPaths(env);
      const vaulted = join(paths.vault, putVault(paths, bytes).slice('sha256:'.length));
      process.stderr.write(`[install] ${host} is not as a killed install found it; its earlier bytes are in ${vaulted}\n`);
    }
    rmSync(copy);
    return;
  }
  const same = copied.isSymbolicLink()
    ? current?.isSymbolicLink() === true && readlinkSync(host) === readlinkSync(copy)
    : copied.isDirectory() && current?.isDirectory() === true && hashManagedTree(host) === hashManagedTree(copy);
  if (same) rmSync(copy, { recursive: true, force: true });
  else process.stderr.write(`[install] kept ${copy}: it differs from ${host}\n`);
}

/**
 * The lock holder settles only runtime copies whose owner ended. Retired host
 * snapshots and gate preimages stay for recovery. Nothing is restored to a
 * host path. A directory without an owner record and a retained legacy backup
 * (`manifest.json`) stay; a link is never followed.
 */
function settleOrphanedTransactions(transactionRoot: string, env: NodeJS.ProcessEnv): void {
  for (const name of readdirSync(transactionRoot)) {
    const directory = join(transactionRoot, name);
    // A run killed before its rename leaves a staging directory with at most its owner record and no copies.
    const staging = name.startsWith('.staging-');
    // An unlocked transaction (`rh init`) may remove its own directory while the sweep reads it.
    if (!(staging || name.startsWith(TRANSACTION_PREFIX)) || !lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() || lstatExists(join(directory, 'manifest.json'))) continue;
    const owner = readTransactionOwner(directory);
    if (owner === 'none') {
      if (!staging && lstatExists(directory)) process.stderr.write(`[install] kept the install transaction of an earlier rh version: ${directory}\n`);
      continue;
    }
    if (owner === 'invalid' || exclusiveDirectoryLockOwnerLiveness({ lockPath: directory, pid: owner.pid, startTime: owner.startTime, token: '' }) !== 'dead') continue;
    for (const entry of readdirSync(directory)) {
      const host = /^\d+$/.test(entry) ? owner.paths[Number(entry)] : undefined;
      if (host !== undefined && installProfileTransactionPaths(env).includes(host)) settleTransactionCopy(join(directory, entry), host, env);
    }
    if (readdirSync(directory).every((entry) => entry === TRANSACTION_OWNER || entry === RETIRED_STAGED_SKILLS || (entry === SELF_IGNORE_NAME && isSelfIgnoreGuard(join(directory, entry))))) rmSync(directory, { recursive: true, force: true });
    else process.stderr.write(`[install] kept incomplete transaction for recovery: ${directory}\n`);
  }
}

/** A candidate runs under its parent's lock, so only the process that holds the lock removes orphans. */
function holdsRuntimeLock(scope: RuntimeTransactionScope): boolean {
  return readExclusiveDirectoryLockOwner(realpathSync(scope.root), runtimeTransactionLockRelativePath(scope))?.pid === process.pid;
}

/** The staged-skill observations that an rh before #2852 kept in its transaction: an orphan that holds only them has nothing to recover. */
const RETIRED_STAGED_SKILLS = 'staged-skills.json';

/** The owner record goes in before the directory gets its `install-` name, so no live directory is ever without one. */
function createTransactionDirectory(transactionRoot: string, paths: readonly string[]): string {
  const staging = mkdtempSync(join(transactionRoot, '.staging-'));
  const directory = join(transactionRoot, `${TRANSACTION_PREFIX}${randomUUID()}`);
  try {
    // The guard goes in first: the directory holds copies of host files (#2854 P7).
    ensureSelfIgnoringDirectory(staging);
    writeFileSync(join(staging, TRANSACTION_OWNER), `${JSON.stringify({ pid: process.pid, start_time: currentProcessStartTime(), paths })}\n`, { mode: 0o600 });
    renameSync(staging, directory);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return directory;
}

/** Retained backups belong only to legacy cleanup, apart from runtime commits. */
export function beginLegacyCleanupBackup(paths: readonly string[], env: NodeJS.ProcessEnv, runtimeLock: RuntimeTransactionContext): InstallHostTransaction {
  return snapshotPaths(paths, env, { retainBackup: true, runtimeLock });
}

export function beginInstallHostTransaction(paths: readonly string[], env: NodeJS.ProcessEnv = process.env, options: { readonly runtimeLock?: RuntimeTransactionContext } = {}): InstallHostTransaction {
  const allowed = new Set(installProfileTransactionPaths(env));
  if (paths.some(path => !allowed.has(path))) throw new Error('runtime transaction contains a host path');
  return snapshotPaths(paths, env, options);
}

function snapshotPaths(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly retainBackup?: boolean; readonly runtimeLock?: RuntimeTransactionContext } = {},
): InstallHostTransaction {
  const scope = globalRuntimeScope(env);
  const containsConfig = paths.includes(globalConfigurationPath(env)) || paths.includes(join(scope.root, '.repo-harness', 'config.json'));
  let owned: RuntimeTransactionLock | undefined;
  const context = containsConfig ? options.runtimeLock ?? (owned = acquireRuntimeTransactionLock(scope)) : options.runtimeLock;
  try {
    if (context) assertRuntimeTransactionContext(context, scope);
    if (containsConfig) mutateGlobalConfiguration(env, () => ({ value: undefined }), { runtimeLock: context });
    const transactionRoot = runtimeTransactionRoot(scope);
    mkdirSync(transactionRoot, { recursive: true });
    ensureSelfIgnoringDirectory(transactionRoot);
    if (context && holdsRuntimeLock(scope)) settleOrphanedTransactions(transactionRoot, env);
    const unique = [...new Set(paths)];
    const backupRoot = createTransactionDirectory(transactionRoot, unique);
    try {
      const snapshots = unique.map((path, index): HostSurfaceSnapshot => {
        if (!existsSync(path) && !lstatExists(path)) return { path, existed: false, backup_path: null };
        const backupPath = join(backupRoot, String(index));
        cpSync(path, backupPath, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
        return { path, existed: true, backup_path: backupPath };
      });
      const transaction: InstallHostTransaction = { protocol: 1, backup_root: backupRoot, snapshots };
      if (context) transactionLocks.set(transaction, { context, owned, piRules: piGlobalRulesHostPath(env) });
      if (options.retainBackup === true) {
        writeFileSync(join(backupRoot, 'manifest.json'), `${JSON.stringify(transaction, null, 2)}\n`, { mode: 0o600 });
      }
      return transaction;
    } catch (error) {
      rmSync(backupRoot, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    owned?.release();
    throw error;
  }
}

function isGlobalConfigurationSnapshot(path: string): boolean {
  return path.replaceAll('\\', '/').endsWith('/.repo-harness/config.json');
}

function assertTransactionLock(transaction: InstallHostTransaction, context?: RuntimeTransactionContext): void {
  const held = transactionLocks.get(transaction)?.context ?? context;
  if (held) {
    assertRuntimeTransactionContext(held, held.scope);
    for (const snapshot of transaction.snapshots) {
      if (isGlobalConfigurationSnapshot(snapshot.path)) assertRuntimeTransactionContext(held, globalRuntimeScope({ HOME: dirname(dirname(snapshot.path)) }));
    }
    return;
  }
  if (transaction.snapshots.some(snapshot => isGlobalConfigurationSnapshot(snapshot.path))) {
    throw new Error('configuration rollback requires its original runtime transaction context');
  }
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function restoreSnapshot(transaction: InstallHostTransaction, snapshot: HostSurfaceSnapshot, runtimeLock?: RuntimeTransactionContext): void {
  if (isGlobalConfigurationSnapshot(snapshot.path)) {
    const context = transactionLocks.get(transaction)?.context ?? runtimeLock;
    if (!context) throw new Error('configuration rollback lost its runtime transaction context');
    restoreGlobalConfiguration(snapshot.path, snapshot.existed && snapshot.backup_path !== null ? readFileSync(snapshot.backup_path) : null, context);
    return;
  }
  if (!snapshot.existed && lstatSync(dirname(snapshot.path), { throwIfNoEntry: false })?.isFile()) return;
  if (snapshot.existed && snapshot.backup_path !== null && !lstatExists(snapshot.backup_path)) throw new Error('its backup ' + snapshot.backup_path + ' is missing, so the path stays as it is');
  rmSync(snapshot.path, { recursive: true, force: true });
  if (snapshot.existed && snapshot.backup_path !== null) {
    mkdirSync(dirname(snapshot.path), { recursive: true });
    cpSync(snapshot.backup_path, snapshot.path, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  }
}

/** Legacy cleanup keeps its retained snapshots and restores only its own mutations. */
export function rollbackLegacyCleanupBackup(transaction: InstallHostTransaction, runtimeLock: RuntimeTransactionContext): void {
  assertTransactionLock(transaction, runtimeLock);
  const failures: unknown[] = [];
  for (const snapshot of [...transaction.snapshots].reverse()) {
    try { restoreSnapshot(transaction, snapshot, runtimeLock); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'legacy cleanup rollback failed');
}

/** Refresh state versions after the gate refreshed the recorded paths. */
export function refreshInstallStateVersions(env: NodeJS.ProcessEnv): void {
  const current = readInstallState(env);
  if (current) writeState({ ...current, ...versions(enabledPlugins(current)) }, env);
}

export function rollbackInstallHostTransaction(
  transaction: InstallHostTransaction,
  options: { readonly runtimeLock?: RuntimeTransactionContext; readonly antigravityMcpUndo?: AntigravityMcpUndo } = {},
): void {
  assertTransactionLock(transaction, options.runtimeLock);
  try {
    const failures: string[] = [];
    const ledger = transaction.snapshots.find(snapshot => basename(snapshot.path) === 'ledger.json' && basename(dirname(snapshot.path)) === 'config');
    if (ledger) {
      try {
        const result = rollbackHostConfigTransaction(hostConfigPathsAt(dirname(dirname(ledger.path))),
          ledger.existed && ledger.backup_path !== null ? readFileSync(ledger.backup_path) : null, transaction.backup_root,
          { antigravityMcpUndo: options.antigravityMcpUndo, piRules: transactionLocks.get(transaction)?.piRules });
        failures.push(...result.unresolved.map(entry => entry + ': rh cannot prove this host configuration entry; run rh update'));
      } catch (error) { failures.push('host configuration rollback: ' + String((error as Error).message ?? error) + '; run rh update'); }
    }
    for (const snapshot of [...transaction.snapshots].reverse()) {
      if (snapshot === ledger) continue;
      try {
        restoreSnapshot(transaction, snapshot, options.runtimeLock);
      } catch (error) {
        failures.push(`${snapshot.path}: ${String((error as Error).message ?? error)}`);
      }
    }
    if (failures.length === 0) {
      rmSync(transaction.backup_root, { recursive: true, force: true });
    }
    if (failures.length > 0) throw new Error(`install transaction compensation failed:\n${failures.join('\n')}`);
  } finally {
    transactionLocks.get(transaction)?.owned?.release();
    transactionLocks.delete(transaction);
  }
}

export function commitInstallHostTransaction(transaction: InstallHostTransaction): void {
  assertTransactionLock(transaction);
  rmSync(transaction.backup_root, { recursive: true, force: true });
  transactionLocks.get(transaction)?.owned?.release();
  transactionLocks.delete(transaction);
}

/**
 * A parent of rh 0.34.0 writes no owner record and does not snapshot the
 * ledger, and it reads only the protocol 1 ledger that it left. Under such a
 * parent the candidate keeps the ledger before its migrations, which the
 * parent can read, and after them, which its rollback starts from: a rollback
 * to the earlier one would take out the records that the migration converted
 * from current entries, and remove those entries. The migration also moves
 * the fleet receipt into the ledger, and that parent does not snapshot the
 * receipt either, so it goes back with the earlier ledger.
 */
function olderParentFiles(env: NodeJS.ProcessEnv): { readonly ledger: string; readonly 'fleet-receipt': string } {
  return { ledger: hostConfigPaths(env).ledger, 'fleet-receipt': fleetReceiptPath(env) };
}

function keepOlderParentCopy(backupRoot: string, name: string, path: string): void {
  if (lstatExists(path)) writeFileSync(join(backupRoot, `${name}.json`), readFileSync(path), { mode: 0o600, flag: 'wx' });
  else writeFileSync(join(backupRoot, `${name}.absent`), '', { mode: 0o600, flag: 'wx' });
}

function readOlderParentCopy(backupRoot: string, name: string): Buffer | null {
  const copy = join(backupRoot, `${name}.json`);
  if (lstatExists(copy)) return readFileSync(copy);
  if (lstatExists(join(backupRoot, `${name}.absent`))) return null;
  throw new Error(`runtime transaction of an earlier rh version has no ${name} copy; run rh update`);
}

/**
 * Every copy is read before the first write, so a missing copy changes no
 * file. A file that still holds its copy's bytes is one that the run did not
 * change (a migration can stop before it), so its entry, link and mode stay.
 */
function restoreOlderParentFiles(backupRoot: string, env: NodeJS.ProcessEnv): void {
  const files = Object.entries(olderParentFiles(env)).map(([name, path]) => ({ path, bytes: readOlderParentCopy(backupRoot, `${name}-before-migration`) }));
  for (const { path, bytes } of files) {
    // The copy followed a link, so the comparison does too.
    const current = lstatExists(path) ? readFileSync(path) : null;
    if (bytes === null ? current === null : current?.equals(bytes) === true) continue;
    if (bytes === null) rmSync(path, { force: true });
    else publishFileByRename(path, bytes, `${path}.${randomUUID()}.tmp`);
  }
}

const REPOSITORY_LEDGER_COPY = /^repository-ledger-(.+)-after-migration\.json$/;

/**
 * No parent snapshots a repository ledger, and a parent of an older protocol cannot read a moved one. The candidate keeps
 * each ledger that its move changed, before and after the move, in the parent's transaction directory, so the copies
 * leave with the transaction.
 */
function keepMovedRepositoryLedgers(backupRoot: string, env: NodeJS.ProcessEnv, migrate: () => void): void {
  const before = repositoryLedgers(env).map(({ ledger }) => ({ ledger, key: basename(dirname(ledger)), bytes: readFileSync(ledger) }));
  for (const { key, ledger } of before) keepOlderParentCopy(backupRoot, `repository-ledger-${key}-before-migration`, ledger);
  const keepMoved = () => {
    for (const { key, ledger, bytes } of before) {
      if (lstatExists(ledger) && !readFileSync(ledger).equals(bytes)) keepOlderParentCopy(backupRoot, `repository-ledger-${key}-after-migration`, ledger);
    }
  };
  try { migrate(); } catch (error) {
    // A move that stops part way runs no candidate rollback: the ledgers that it moved go back now.
    keepMoved();
    const kept = restoreMovedRepositoryLedgers(backupRoot, env);
    throw kept.length ? new AggregateError([error], `${error instanceof Error ? error.message : String(error)}; ${movedLedgersKept(kept)}`) : error;
  }
  keepMoved();
}

function movedLedgersKept(kept: readonly string[]): string {
  return `these repository ledgers changed after their move, so they stay at the current protocol: ${kept.join(', ')}; run rh update`;
}

/**
 * A failed candidate puts back each repository ledger that still holds the bytes of its move. A ledger that the run
 * also wrote stays as it is; its paths are returned for the report.
 */
function restoreMovedRepositoryLedgers(backupRoot: string, env: NodeJS.ProcessEnv): string[] {
  const kept: string[] = [];
  for (const name of readdirSync(backupRoot)) {
    const key = REPOSITORY_LEDGER_COPY.exec(name)?.[1];
    if (key === undefined) continue;
    const ledger = join(hostConfigPaths(env).harness, 'config', 'repos', key, 'ledger.json');
    const after = readOlderParentCopy(backupRoot, `repository-ledger-${key}-after-migration`)!;
    const earlier = readOlderParentCopy(backupRoot, `repository-ledger-${key}-before-migration`)!;
    if (lstatExists(ledger) && readFileSync(ledger).equals(after)) publishFileByRename(ledger, earlier, `${ledger}.${randomUUID()}.tmp`);
    else kept.push(ledger);
  }
  return kept;
}

/** The candidate's one-shot migrations in its parent's transaction. A failed move must leave a ledger the parent can read. */
export function migrateInParentTransaction(backupRoot: string, env: NodeJS.ProcessEnv, migrate: () => void): void {
  if (readTransactionOwner(backupRoot) !== 'none') {
    const ledger = hostConfigPaths(env).ledger as HostPath;
    const before = observeFile(ledger);
    expectedOf(before.observation, ledger);
    try { keepMovedRepositoryLedgers(backupRoot, env, migrate); } catch (error) {
      // These migrations adopt records without writing the entries they describe. Put the ledger bytes back directly.
      try {
        const after = observeFile(ledger);
        const expected = expectedOf(after.observation, ledger);
        if (before.bytes === null) {
          if (expected.existed) removeTarget(ledger, expected);
        } else if (!after.bytes?.equals(before.bytes)) replaceTarget(ledger, before.bytes, expected);
      } catch (restore) {
        const errors = [error, restore];
        throw new AggregateError(errors, `restore after a failed migration failed: ${errors.map(item => item instanceof Error ? item.message : String(item)).join('; ')}`);
      }
      throw error;
    }
    return;
  }
  for (const [name, path] of Object.entries(olderParentFiles(env))) keepOlderParentCopy(backupRoot, `${name}-before-migration`, path);
  try { keepMovedRepositoryLedgers(backupRoot, env, migrate); } catch (error) {
    try { restoreOlderParentFiles(backupRoot, env); } catch (restore) { throw new AggregateError([error, restore], 'restore after a failed migration failed'); }
    throw error;
  }
  keepOlderParentCopy(backupRoot, 'ledger-after-migration', hostConfigPaths(env).ledger);
}

/** Undo candidate host writes with the parent transaction's ledger snapshot. */
export function rollbackRuntimeHostConfig(backupRoot: string, env: NodeJS.ProcessEnv): void {
  const owner = readTransactionOwner(backupRoot);
  if (owner === 'invalid') throw new Error('runtime transaction has no valid owner; run rh update');
  const ledger = hostConfigPaths(env).ledger;
  let snapshot: Buffer | null;
  if (owner === 'none') snapshot = readOlderParentCopy(backupRoot, 'ledger-after-migration');
  else {
    const index = owner.paths.indexOf(ledger);
    if (index < 0) throw new Error('runtime transaction has no ledger snapshot; run rh update');
    const backup = join(backupRoot, String(index));
    snapshot = lstatExists(backup) ? readFileSync(backup) : null;
  }
  const kept = restoreMovedRepositoryLedgers(backupRoot, env);
  const result = rollbackHostConfigTransaction(hostConfigPathsAt(dirname(dirname(ledger))), snapshot, backupRoot, { piRules: piGlobalRulesHostPath(env) });
  if (result.unresolved.length) throw new Error(['host configuration rollback unresolved: ' + result.unresolved.join(', ') + '; run rh update', ...(kept.length ? [movedLedgersKept(kept)] : [])].join('; '));
  if (owner === 'none') restoreOlderParentFiles(backupRoot, env);
  if (kept.length) throw new Error(movedLedgersKept(kept));
}

/** The lock entries of the removed staged skills go by the ledger's per-fragment rule: only an entry that rh recorded and that is intact. */
function removeOwnedSkillLockEntries(env: NodeJS.ProcessEnv, skillNames: ReadonlySet<string>): void {
  if (skillNames.size === 0) return;
  const lockPath = providerSkillLock(requireHome(env), env).path;
  for (const entry of openHostConfigGate({ env }).revert([lockPath], { selectors: [...skillNames].map((name) => `skills.${name}`) })) {
    if (entry.action !== 'kept_edited') continue;
    process.stderr.write(`[install] kept_edited ${entry.path}: rh cannot take out the lock entries ${entry.kept?.join(', ') ?? ''} as they are now; their bytes stay\n`);
  }
}

/**
 * Remove the owned paths and Pi packages of each plugin that the target
 * selection drops. A changed path stops the switch. The gate undoes each path
 * and drops its record, and keeps its entry in `transaction` for a rollback.
 */
function removeRetiredOwnedSurfaces(
  plugins: readonly PluginId[],
  env: NodeJS.ProcessEnv,
  transaction: string,
): readonly string[] {
  const records = readPathRecords(env);
  const retired = Object.keys(records).filter((key) => !ownerSelected(records[key]!, plugins));
  const planned = retired.find((key) => planPathRevert(key, records[key]!) === 'kept_edited');
  if (planned) throw new Error(`refusing plugin switch because managed surface drifted: ${planned}`);
  const ownedSkills = new Set(selectionOwnedSkillNames(loadSkillSurfaceCatalog()));
  const removedSkills = new Set(retired.filter((key) => records[key]!.host === 'staged' && ownedSkills.has(basename(key))).map((key) => basename(key)));
  // Only an entry that the ledger records under owner `pi`, as rh wrote it, is rh's to remove.
  const piPackages: ReadonlyMap<string, string> = plugins.includes('pi') ? new Map() : recordedPiPackages(env);
  const editedPi = [...piPackages].find(([source, recorded]) => piPackageRemoval(source, recorded, env) === 'edited');
  if (editedPi) throw new Error(`refusing plugin switch because managed surface drifted: ${editedPi[0]}`);
  for (const [source, recorded] of piPackages) removePiPackage(source, recorded, env);
  const changed = openHostConfigGate({ env }).revertPaths(retired, { transaction }).find((entry) => entry.action === 'kept_edited');
  if (changed) throw new Error(`refusing plugin switch because managed surface drifted: ${changed.path}`);
  removeOwnedSkillLockEntries(env, removedSkills);
  return [...piPackages.keys(), ...retired];
}

/**
 * The architecture plugin's fragments in the host files (the CodeGraph table
 * and server, and its tool rule) go with the plugin, through the gate's
 * per-fragment rule: a fragment that the user changed stays, and an override
 * is never restored here, so only a whole-file revert gives a user's value back.
 * One rule for a fragment that the switch cannot take out (edited, an
 * unsupported spelling, or a file that does not parse): its bytes stay, the
 * switch names the file, and it goes on with the other files. Each file is
 * its own revert, so a failure in one leaves the records of the others right.
 */
function removeArchitectureHostFragments(env: NodeJS.ProcessEnv, onAntigravityMcpRemoval?: (undo: AntigravityMcpUndo) => void): void {
  const home = requireHome(env);
  const gate = openHostConfigGate({ env });
  const targets = [join(home, '.codex', 'config.toml'), join(home, '.claude.json'), join(home, '.claude', 'settings.json')];
  const ledgerPaths = hostConfigPaths(env);
  const mcp = antigravityMcpConfigHostPath(env, ledgerPaths);
  if (readLedger(ledgerPaths).files[mcp]) targets.push(mcp);
  for (const path of targets) {
    let entries;
    try { entries = gate.revert([path], { owner: 'architecture', onAntigravityMcpRemoval }); } catch (error) {
      if (path === mcp && error instanceof AntigravityHooksPathError) {
        process.stderr.write(`[install] refused ${path}: ${error.message}\n`);
        continue;
      }
      // Only config.toml goes through Bun's TOML parser; the gate keeps a JSON file that does not parse with its fragments.
      if (!(error instanceof SyntaxError)) throw error;
      process.stderr.write(`[install] kept_edited ${(namingTomlFile(path, error) as Error).message}\n`);
      continue;
    }
    for (const entry of entries) {
      if (entry.action !== 'kept_edited') continue;
      process.stderr.write(`[install] kept_edited ${entry.path}: rh cannot take out the architecture fragments ${entry.kept?.join(', ') ?? ''} as they are now; their bytes stay. Remove them by hand if you do not want them\n`);
    }
  }
}

export function prepareInstallSelectionSwitch(
  plugins: readonly PluginId[],
  env: NodeJS.ProcessEnv,
  transaction: string,
  onAntigravityMcpRemoval?: (undo: AntigravityMcpUndo) => void,
): readonly string[] {
  // The old records of the host files move to the ledger first, so the architecture revert below finds them.
  migrateCodexConfigRecords(env);
  migrateJsonConfigRecords(env);
  if (!readInstallState(env)) return [];
  const removed = removeRetiredOwnedSurfaces(plugins, env, transaction);
  if (!ownerEnabled('architecture', plugins)) removeArchitectureHostFragments(env, onAntigravityMcpRemoval);
  return removed;
}

/** The path allowlist, type and hash shape of a protocol 3 ownership surface. */
function validSurfaceShape(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): boolean {
  if (raw.type === 'pi-package') {
    return raw.authority === 'repo-harness-install-transaction' && raw.removal === 'managed-surfaces-only'
      && raw.path === bunGlobalPackageRoot(env) && raw.managed_marker === 'pi-package-source'
      && raw.content_hash === null && raw.symlink_target === null;
  }
  const allowedPaths = new Set(installProfileHostMutationPaths(env));
  const retired = retiredAgentFleetTargets(env).some(({ path }) => path === raw.path);
  if (retired && !(raw.owner === 'core' && raw.type === 'managed-file' && raw.managed_marker === 'transaction-created-file'
    && typeof raw.content_hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(raw.content_hash))) return false;
  return (
    raw.authority === 'repo-harness-install-transaction'
    && raw.removal === 'managed-surfaces-only'
    && typeof raw.path === 'string'
    && (retired || allowedPaths.has(raw.path) || isDiscoveredFacadePath(raw.path, requireHome(env), env))
    && ['directory-copy', 'symlink', 'managed-file'].includes(String(raw.type))
    && (raw.content_hash === null || typeof raw.content_hash === 'string')
    && (raw.managed_marker === null || typeof raw.managed_marker === 'string')
    && (raw.symlink_target === null || typeof raw.symlink_target === 'string')
    && (raw.type === 'symlink'
      ? raw.symlink_target !== null && raw.content_hash === null && raw.managed_marker === null
      : raw.symlink_target === null && typeof raw.content_hash === 'string' && typeof raw.managed_marker === 'string')
  );
}

const SURFACE_KEYS = ['authority', 'content_hash', 'managed_marker', 'owner', 'path', 'removal', 'symlink_target', 'type'].join(',');

/** The check of one protocol 3 `ownership_manifest` surface, for the one-shot migration (install-state-migration.ts) only. */
export function isLegacyOwnershipSurface(raw: unknown, env: NodeJS.ProcessEnv, plugins: readonly PluginId[]): boolean {
  if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== SURFACE_KEYS) return false;
  if (!isSurfaceOwner(raw.owner) || !ownerEnabled(raw.owner, plugins)) return false;
  if (raw.type === 'pi-package' && raw.owner !== 'pi') return false;
  return validSurfaceShape(raw, env);
}

export function readInstallState(env: NodeJS.ProcessEnv = process.env): InstallState | null {
  return readRecordedInstallState(env);
}

/** `update` resolves the recorded selection; without a state it has none. */
export function requireInstallState(env: NodeJS.ProcessEnv = process.env): InstallState {
  const state = readInstallState(env);
  if (state === null) {
    const path = installProfileStatePath(env);
    throw new InstallStateError('install_state_missing', path, `no install state at ${path}; run: rh install`);
  }
  return state;
}

function existing(paths: readonly string[]): string[] {
  return paths.filter((path) => existsSync(path));
}

function canonicalEvidence(home: string, hosts: readonly SkillHost[], relativePaths: readonly string[], env: NodeJS.ProcessEnv): string[] {
  return existing(hosts.flatMap((host) => relativePaths.map((relative) => join(hostSkillRoot(home, host, env), 'repo-harness', relative))));
}

export function executableCandidatePaths(
  name: string,
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const pathApi = platform === 'win32' ? win32 : posix;
  const pathDelimiter = platform === 'win32' ? ';' : ':';
  const bunRoot = env.BUN_INSTALL ?? pathApi.join(home, '.bun');
  const extensions = platform === 'win32'
    ? (env.PATHEXT || process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((ext) => ext.trim()).filter(Boolean)
    : [''];
  const pathDirs = (env.PATH ?? '')
    .split(pathDelimiter)
    .map((dir) => (platform === 'win32' ? dir.replace(/^"(.*)"$/, '$1') : dir))
    .filter(Boolean);
  const directories = [pathApi.join(bunRoot, 'bin'), ...pathDirs];
  return [...new Set(directories.flatMap((directory) => extensions.map((extension) => pathApi.join(directory, `${name}${extension}`))))];
}

function executableEvidence(name: string, env: NodeJS.ProcessEnv): string[] {
  return existing(executableCandidatePaths(name, requireHome(env), env));
}

/** The facades and provider skills that an owner's probe requires. */
function ownedProbeSkills(catalog: SkillSurfaceCatalog, owner: SurfaceOwner) {
  return catalog.packages.filter(pkg => (pkg.kind === 'facade' || pkg.kind === 'provider-skill') && pkg.owner === owner && !pkg.explicitOnly);
}

/**
 * Each host root requires the owned skills that list its host. The set is
 * present when one root holds its non-empty required set completely.
 */
function completeHostSkillSetEvidence(home: string, hosts: readonly SkillHost[], packages: ReturnType<typeof ownedProbeSkills>,
  env: NodeJS.ProcessEnv, refused: readonly string[]): string[] {
  for (const host of hosts) {
    const root = hostSkillRoot(home, host, env);
    // A skill entry that the gate refused to replace is present evidence: it holds the user's copy, a dangling link included.
    const paths = packages.filter(pkg => pkg.hosts.includes(host))
      .map(pkg => join(root, pkg.name)).map(skill => refused.includes(skill) ? skill : join(skill, 'SKILL.md'));
    if (paths.length > 0 && paths.every(path => refused.includes(path) ? lstatExists(path) : existsSync(path))) return paths;
  }
  return [];
}

function completeAgentFleetEvidence(home: string): string[] {
  for (const [root, extension] of [[join(home, '.codex', 'agents'), '.toml'], [join(home, '.claude', 'agents'), '.md']] as const) {
    const paths = MANAGED_AGENTS.map((agent) => join(root, `${agent}${extension}`));
    if (paths.every(existsSync)) return paths;
  }
  return [];
}

function probe(checks: Readonly<Record<string, readonly string[]>>): OwnerProbe {
  const missing = Object.entries(checks).filter(([, evidence]) => evidence.length === 0).map(([name]) => name);
  return { status: missing.length === 0 ? 'present' : 'missing', evidence: Object.values(checks).flat(), missing };
}

export function canonicalEvidenceMatchesAll(evidence: readonly string[], relativePaths: readonly string[]): boolean {
  return relativePaths.every((relative) => {
    const suffix = `/${relative.replaceAll('\\', '/')}`;
    return evidence.some((path) => path.replaceAll('\\', '/').endsWith(suffix));
  });
}

function allOrNone(home: string, hosts: readonly SkillHost[], relativePaths: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const evidence = canonicalEvidence(home, hosts, relativePaths, env);
  return canonicalEvidenceMatchesAll(evidence, relativePaths) ? evidence : [];
}

function probeCore(env: NodeJS.ProcessEnv, catalog: SkillSurfaceCatalog, hosts: readonly SkillHost[], refused: readonly string[]): OwnerProbe {
  const home = requireHome(env);
  const adapters = ([
    { path: join(home, '.codex', 'hooks.json'), host: 'codex' },
    { path: join(home, '.claude', 'settings.json'), host: 'claude' },
  ] as const).filter(({ path, host }) => existsSync(path) && adapterHasRequiredProjection(path, host, env)).map(({ path }) => path);
  const fleet = completeAgentFleetEvidence(home);
  const coreFacades = ownedProbeSkills(catalog, 'core').filter(pkg => pkg.kind === 'facade');
  return probe({
    'cli': executableEvidence('rh', env),
    'effective-state': canonicalEvidence(home, hosts, ['src/cli/commands/state.ts'], env),
    // The mutation guard is an in-process handler bundled in the canonical copy.
    'guards': allOrNone(home, hosts, ['src/cli/hook/mutation-guard.ts', 'scripts/contract-worktree.sh'], env),
    'handoff': canonicalEvidence(home, hosts, ['references/handoff.md'], env),
    'host-adapters': adapters,
    'workflow': canonicalEvidence(home, hosts, ['src/core/workflow/profile.ts'], env),
    'core-skills': completeHostSkillSetEvidence(home, hosts, coreFacades, env, refused),
    'agent-fleet': fleet,
    'verifier': canonicalEvidence(home, hosts, ['src/effects/review-runner/task-oar-host.ts'], env),
    'release-gates': allOrNone(home, hosts, ['scripts/verify-sprint.sh', 'scripts/ship-worktrees.sh'], env),
  });
}

/** The Pi plugin's real state: the `pi` executable and its user package entry for this package. A failed `pi list` throws. */
function probePi(env: NodeJS.ProcessEnv): OwnerProbe {
  const source = bunGlobalPackageRoot(env);
  if (piExecutable(env) === null || source === null) return { status: 'missing', evidence: [], missing: ['pi-executable'] };
  return probe({ 'pi-package': piPackagePresent(source, env) ? [source] : [] });
}

function probeOwners(plugins: readonly PluginId[], env: NodeJS.ProcessEnv, refused: readonly string[]): Partial<Record<SurfaceOwner, OwnerProbe>> {
  const home = requireHome(env);
  const catalog = loadSkillSurfaceCatalog();
  const hosts = selectedSkillHosts(plugins);
  const probes: Partial<Record<SurfaceOwner, OwnerProbe>> = { core: probeCore(env, catalog, hosts, refused) };
  for (const id of plugins) {
    if (isCommandPlugin(id)) continue;
    if (id === 'pi') probes.pi = probePi(env);
    else probes[id] = probe({ skills: completeHostSkillSetEvidence(home, hosts, ownedProbeSkills(catalog, id), env, refused) });
  }
  return probes;
}

/** `refused`: host skill paths that the gate refused to replace in the current run. Only a selection commit passes them. */
export function installStateStatus(
  state: InstallState,
  env: NodeJS.ProcessEnv = process.env,
  records: PathRecords = readPathRecords(env),
  refused: readonly string[] = [],
): InstallStateStatus {
  const probes = probeOwners(enabledPlugins(state), env, refused);
  const missing = (Object.entries(probes) as [SurfaceOwner, OwnerProbe][])
    .filter(([, result]) => result.status === 'missing')
    .map(([owner]) => owner);
  // A valid selection may consume a pre-existing user-managed CLI, skill, or
  // CodeGraph installation. Ownership is required before removal, not before
  // truthful presence can be reported.
  const ownership = Object.entries(records).map(([path, record]): OwnershipEntry => ({
    path, owner: record.owner, host: record.host, kind: record.kind, type: record.committed.type, current: pathRecordIsCurrent(path, record),
  }));
  const piDrift = piExecutable(env) === null || !enabledPlugins(state).includes('pi') ? [] : ownedPiPackages(env).filter((source) => {
    try { return !piPackagePresent(source, env); } catch { return true; }
  });
  // A file that the user keeps is not rh's to keep current.
  const surfaceDrift = [...ownership.filter((entry) => entry.kind === 'created' && !entry.current).map((entry) => entry.path), ...piDrift];
  return {
    ...state,
    ownership,
    ...skippedOwnership(env),
    probes,
    drift: {
      status: missing.length === 0 && surfaceDrift.length === 0 ? 'consistent' : 'drift',
      missing_owners: missing,
      surface_drift: surfaceDrift,
    },
  };
}

/** Why a host plugin cannot be selected now, or null when its host program is present. Other read errors throw. */
function hostPluginAbsence(_id: (typeof HOST_PROGRAM_PLUGINS)[number], env: NodeJS.ProcessEnv): string | null {
  return piExecutable(env) === null ? 'pi is not on PATH' : null;
}

type InstallTarget = 'claude' | 'codex' | 'both';

const TARGET_HOSTS: Readonly<Record<InstallTarget, readonly SkillHost[]>> = { claude: ['claude'], codex: ['codex'], both: ['claude', 'codex', 'pi'] };
const TARGET_BOTH_COMMAND = 'rh install --target both';

/**
 * Why this target cannot run a plugin now, and the command that adds it, or
 * null. A command plugin is always available. A skill plugin needs a target
 * host for one of its skills. The Pi plugin needs the Pi host, and a host
 * plugin needs its program. A read error other than a definite absence throws.
 */
function pluginUnavailable(id: PluginId, target: InstallTarget, env: NodeJS.ProcessEnv): { readonly reason: string; readonly command: string } | null {
  if (isCommandPlugin(id)) return null;
  if (id === 'pi' && target !== 'both') return { reason: `--target ${target} does not include the Pi host`, command: TARGET_BOTH_COMMAND };
  const skills = ownedProbeSkills(loadSkillSurfaceCatalog(), id);
  if (skills.length > 0 && !skills.some(pkg => pkg.hosts.some(host => (TARGET_HOSTS[target] as readonly string[]).includes(host)))) {
    return { reason: `--target ${target} has no host for its skills`, command: TARGET_BOTH_COMMAND };
  }
  const absence = isHostProgramPlugin(id) ? hostPluginAbsence(id, env) : null;
  return absence === null ? null : { reason: absence, command: UPDATE_COMMAND };
}

/** An explicit plugin fails closed before any write when its host program or a host of its skills is absent. */
export function assertExplicitSelectionRunnable(plugins: readonly PluginId[], target: InstallTarget, env: NodeJS.ProcessEnv = process.env): void {
  const unavailable = plugins.flatMap((id) => {
    const absent = pluginUnavailable(id, target, env);
    return absent === null ? [] : [`${id} (${absent.reason})`];
  });
  if (unavailable.length > 0) {
    throw new InstallStateError('install_plugin_unavailable', installProfileStatePath(env),
      `cannot select ${unavailable.join(', ')}; install the host program or choose a target with its host, or drop the plugin from --plugins`);
  }
}

/**
 * The one resolver of a selection on this host, for install, update and the
 * candidate process. An explicit list runs and records exactly its ids or
 * fails closed. `all` runs and records every plugin of this version; a host
 * plugin whose program or target is absent is skipped, or kept in the record
 * when the state already records it (removal needs an explicit selection).
 */
export function resolveRecordedSelection(
  state: Pick<InstallState, 'selection' | 'plugins'>,
  target: InstallTarget,
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly partial?: boolean } = {},
): SelectionResolution {
  if (state.selection !== 'all') {
    assertExplicitSelectionRunnable(state.selection, target, env);
    return { run: state.selection, record: state.selection, skipped: [], kept: [], notAdded: [] };
  }
  const recorded = enabledPlugins(state);
  const run: PluginId[] = [];
  const keptReasons = new Map<PluginId, string>();
  const skipped: SkippedPlugin[] = [];
  for (const id of PLUGIN_IDS) {
    const absent = pluginUnavailable(id, target, env);
    if (absent === null) run.push(id);
    else if (recorded.includes(id)) keptReasons.set(id, absent.reason);
    else skipped.push({ id, ...absent });
  }
  const grown = PLUGIN_IDS.filter(id => run.includes(id) || keptReasons.has(id));
  // A partial refresh (--no-sync-skill or --no-hooks) runs and records only the recorded set.
  const record = options.partial === true ? grown.filter(id => recorded.includes(id)) : grown;
  const kept = [...keptReasons].map(([id, reason]) => ({ id, reason, command: installSelectionCommand(record.filter(other => other !== id)) }));
  return {
    run: run.filter(id => record.includes(id)), record, skipped, kept,
    notAdded: grown.filter(id => !record.includes(id)),
  };
}

/** A fresh `all` selection: every plugin that the host can run. */
export function defaultPluginSelection(target: InstallTarget, env: NodeJS.ProcessEnv = process.env): { readonly plugins: readonly PluginId[]; readonly skipped: readonly SkippedPlugin[] } {
  const { run, skipped } = resolveRecordedSelection({ selection: 'all', plugins: [] }, target, env);
  return { plugins: run, skipped };
}

export function skippedPluginLine(entry: SkippedPlugin): string {
  const after = entry.command === UPDATE_COMMAND ? 'install the host program, then run' : 'run';
  return `skipped ${entry.id}: ${entry.reason}; to add it later, ${after}: ${entry.command}`;
}

export function keptPluginLine(entry: KeptPlugin): string {
  return `kept ${entry.id}: ${entry.reason}; update keeps the recorded plugin; to remove it, run: ${entry.command}`;
}

export function notAddedPluginLine(id: PluginId): string {
  return `not added ${id} in a partial refresh; run: ${UPDATE_COMMAND}`;
}

/** The O3 repair of an explicit list: one command for every unselected command plugin, because a second command would drop the first id. */
export function commandPluginRepairLines(selection: PluginSelection): string[] {
  if (selection === 'all') return [];
  const missing = COMMAND_PLUGINS.filter(id => !selection.includes(id));
  if (missing.length === 0) return [];
  const repair = installSelectionCommand(PLUGIN_IDS.filter(id => selection.includes(id) || isCommandPlugin(id)));
  return [`[plugins] not selected ${missing.join(', ')}: an explicit list does not grow; to add them, run: ${repair}`];
}

/**
 * A repository whose policy sets `context.capability_source: archcontext` or
 * `tooling.codegraph.enabled: true` needs the architecture plugin. update,
 * install and init stop here before any write when the selection lacks it.
 */
export function assertArchitecturePolicySelection(cwd: string, plugins: readonly PluginId[], env: NodeJS.ProcessEnv = process.env): void {
  if (plugins.includes('architecture')) return;
  const policy = readWorkflowPolicyDocument(cwd);
  if (!policy.present) return;
  // A non-object section on the path leaves the key absent.
  const tooling = policy.rootIsObject ? policyValue(policy, 'tooling') : POLICY_ABSENT;
  const codegraph = isPolicyObject(tooling) ? policyValue(policy, 'tooling.codegraph') : POLICY_ABSENT;
  const codegraphEnabled = isPolicyObject(codegraph) ? policyValue(policy, 'tooling.codegraph.enabled') : POLICY_ABSENT;
  const needs = [
    ...(capabilitySourceModeOf(policy) === 'archcontext' ? ['context.capability_source: archcontext'] : []),
    ...(codegraphEnabled === true ? ['tooling.codegraph.enabled: true'] : []),
  ];
  if (needs.length === 0) return;
  throw new InstallStateError('install_plugin_unavailable', installProfileStatePath(env),
    `${join(cwd, POLICY_PATH)} sets ${needs.join(' and ')}, which needs the architecture plugin; run: ${pluginRepair('architecture', plugins)}`);
}

/** `run` drives the Pi package and skill projections; `record` is the plugin set that the plan installs, keeps and removes. */
export function planInstallSelection(
  selection: PluginSelection,
  resolved: Pick<SelectionResolution, 'run' | 'record'> & { readonly skipped?: readonly SkippedPlugin[] },
  current: InstallState | null,
  env: NodeJS.ProcessEnv = process.env,
): InstallPlan {
  const packageRoot = bunGlobalPackageRoot(env);
  if (packageRoot === null) throw new Error('Bun global package root unavailable: set HOME, USERPROFILE or BUN_INSTALL');
  const installed = current === null ? [] : enabledPlugins(current);
  const plugins = resolved.record;
  return {
    hosts: INSTALL_HOSTS,
    pi_package: planPiPackage(packageRoot, resolved.run.includes('pi'), env),
    skill_projections: expectedSkillProjections(loadSkillSurfaceCatalog(), packageRoot, requireHome(env), resolved.run, env),
    protocol: INSTALL_STATE_PROTOCOL,
    selection,
    requested_plugins: plugins,
    current_plugins: current === null ? null : installed,
    install: plugins.filter((id) => !installed.includes(id)),
    keep: plugins.filter((id) => installed.includes(id)),
    remove: installed.filter((id) => !plugins.includes(id)),
    skipped: resolved.skipped ?? [],
    state_path: installProfileStatePath(env),
  };
}

export function writeState(state: InstallState, env: NodeJS.ProcessEnv): void {
  const target = installProfileStatePath(env);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  retryWindowsSharingRace(() => renameSync(temp, target));
}

/** Core and enabled plugins record the running CLI version. */
export function versions(plugins: readonly PluginId[]): Pick<InstallState, 'core' | 'plugins'> {
  return { core: { version: PACKAGE_VERSION }, plugins: plugins.map(id => ({ id, version: PACKAGE_VERSION })) };
}

function snapshot(state: InstallState): InstallStateSnapshot {
  const { previous: _previous, ...rest } = state;
  return rest;
}

/**
 * Commit a selection. `plugins` is the recorded set (`record` of the resolver).
 * A `kept` plugin is recorded but did not run: its ledger surfaces stay as
 * they are, and neither its probe nor its surfaces gate this commit. A
 * `refused` skill path holds a user copy that the gate kept: it counts as
 * present here, and status reports the missing skill until the user moves it.
 */
export function applyInstallSelection(
  selection: PluginSelection,
  plugins: readonly PluginId[],
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  transaction?: Pick<InstallHostTransaction, 'backup_root'>,
  options: {
    readonly kept?: readonly PluginId[];
    readonly refused?: readonly string[];
  } = {},
): { readonly plan: InstallPlan; readonly state: InstallState } {
  if (selection !== 'all' && selection.join(',') !== plugins.join(',')) {
    throw new Error(`explicit selection ${selection.join(',')} does not equal the recorded plugins ${plugins.join(',')}`);
  }
  const kept = options.kept ?? [];
  const ran = plugins.filter(id => !kept.includes(id));
  const current = readInstallState(env);
  const plan = planInstallSelection(selection, { run: ran, record: plugins }, current, env);
  const { records: prior, outside, unsupported } = readPathRecordSet(env);
  const records = carriedRecords(prior, kept);
  const committed = selectionRecords(records, plugins);
  const recordedVersions = versions(plugins);
  const unchanged = current !== null
    && JSON.stringify({ core: current.core, plugins: current.plugins }) === JSON.stringify(recordedVersions)
    && JSON.stringify(current.selection) === JSON.stringify(selection)
    && pathRecordsDigest(prior) === pathRecordsDigest(committed)
    // A record outside its host root goes with the next write, so it never stays unacted forever.
    && outside.length === 0 && unsupported.length === 0;
  const state: InstallState = {
    protocol: INSTALL_STATE_PROTOCOL,
    ...recordedVersions,
    selection,
    transaction_id: randomUUID(),
    applied_at: now.toISOString(),
    previous: current === null ? null : snapshot(current),
  };
  const status = installStateStatus({ ...state, plugins: state.plugins.filter(plugin => !kept.includes(plugin.id)) }, env,
    Object.fromEntries(Object.entries(committed).filter(([, record]) => !(kept as readonly string[]).includes(record.owner))), options.refused);
  if (status.drift.status !== 'consistent') {
    throw new Error(
      `install projection is incomplete: missing=${status.drift.missing_owners.map(owner => `${owner}(${status.probes[owner]?.missing.join('+')})`).join(',') || '(none)'}; surface_drift=${status.drift.surface_drift.join(',') || '(none)'}`,
    );
  }
  // A no-change apply writes nothing, so `previous` keeps the last real change for a rollback.
  if (unchanged) return { plan, state: current };
  writePathRecords(env, committed);
  writeState(state, env);
  return { plan, state };
}

export function rollbackInstallSelection(
  env: NodeJS.ProcessEnv = process.env,
  transaction?: Pick<InstallHostTransaction, 'backup_root'>,
): InstallState {
  const current = readInstallState(env);
  if (!current?.previous) throw new Error('no previous install transaction to roll back');
  const plugins = enabledPlugins(current.previous);
  const prior = readPathRecords(env);
  const records = carriedRecords(prior);
  const committed = selectionRecords(records, plugins);
  const restored: InstallState = {
    ...current.previous,
    ...versions(plugins),
    transaction_id: randomUUID(),
    applied_at: new Date().toISOString(),
    previous: null,
  };
  const status = installStateStatus(restored, env, committed);
  if (status.drift.status !== 'consistent') {
    throw new Error(
      `rollback projection is incomplete: missing=${status.drift.missing_owners.map(owner => `${owner}(${status.probes[owner]?.missing.join('+')})`).join(',') || '(none)'}; surface_drift=${status.drift.surface_drift.join(',') || '(none)'}`,
    );
  }
  writePathRecords(env, committed);
  writeState(restored, env);
  return restored;
}
