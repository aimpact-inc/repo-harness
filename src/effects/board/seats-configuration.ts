import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAgentsConfig } from '../../core/board/agents-settings';
import { agySeatAgentName, agySeatBrief } from '../../core/board/seat-launch';
import { agySeatAgentTools } from '../../core/board/seat-launch-agy-tools';
import { MAGPIE_EXTENSION_PATH, SEAT_POOL_STALE_MS, buildSeatPool, catalogProbeModelIds, decodeSeatPool, decodeSeatPoolProbe, emptySeatPoolProbe, type SeatPoolCacheV1, type SeatPoolProbe, type SeatPoolV1 } from '../../core/board/seat-pool';
import {
  SeatOverrideValidationError,
  applySeatOverrides,
  decodeEffectiveSeats,
  decodeSeatOverrideResult,
  decodeSeatOverrides,
  effectiveSeatsInvalidMessage,
  normalizeOverrideInstruction,
  seatOverridesInvalidMessage,
  type SeatOverrideRevokeRequestV1,
  type SeatOverrideResultV1,
  type SeatOverrideSetRequestV1,
  type SeatOverridesV1,
  type SeatRouteOverrideV1,
} from '../../core/board/seat-overrides';
import {
  AgySeatSettingsError, FRONTEND_SEAT_IDS, ROUTING_CLASSES, SEAT_IDS, SEAT_RUNTIMES, SEAT_SCAFFOLD_SUB_AGENTS, WORKER_SEAT_IDS,
  agyEffortValid, decodeSeatsConfig, isAgyAllowedSeat, isRetiredSeatModel, retiredSeatModelField, seatHostId, seatModelShapeValid, seatTakesFleet, seatsConfigInvalidMessage,
  type AgyCatalogModel, type LaunchSeatId, type SeatConfigV1, type SeatId, type SeatModelV1, type SeatRoutingV1, type SeatRuntime,
  type SeatsConfigV1, type SeatsRangesV1, type SeatsSettingsResultV1,
} from '../../core/board/seats-settings';
import { SeatsConfigMigrationRequiredError } from '../../core/board/seats-settings-migration';
import { isRecord } from '../../core/evidence/is-record';
import { renderJsonObjectUpdate } from '../../core/evidence/json-object-update';
import { sha256Hex, sha256Prefixed } from '../../core/evidence/sha256';
import { HostConfigError } from '../../core/host-config/types';
import { GlobalConfigurationError, mutateGlobalConfiguration, readGlobalConfiguration } from '../configuration/global-configuration';
import { antigravityAgentsDirHostPath, checkAntigravityPath, openHostConfigGate } from '../host-config/gate';
import { hostConfigPaths, hostPathKey, readLedger } from '../host-config/store';
import { globalRuntimeScope, withRuntimeTransactionLock } from '../locking/runtime-transaction-lock';
import { runProcess } from '../process-runner';
import { EFFORT_LEVELS } from '../terminal/task-role-profiles';
import { AGY_AGENT_DESCRIPTIONS, agySeatAgentRecordIsCurrent, findAgySeatAgentRecord, refuseExistingAgySeatAgent, renderAgySeatAgentMarkdown } from './agy-seat-agent-records';
import {
  AGY_CATALOG_CHILD_ARG, AGY_CATALOG_CHILD_MS, CATALOG_RUNTIMES, SEAT_POOL_CHILD_MS, SEAT_POOL_MEMBER_MS,
  agyEnvironment, agyProbeEnv, isAgyCatalogModel, probeSeatCatalog, projectAgyCatalog, readAgyCatalogOffThread, type AgyProbe,
} from './seats-catalog';
import { checkPoolDirectories, readPoolFile, seatPoolPath, storeSeatPool } from './seats-pool-store';
import { RUNTIME_RANGES, SEAT_RANGES, changedKeys } from './seats-settings-ranges';

export type SeatsConfigurationErrorCode =
  | 'busy'
  | 'config_invalid'
  | SeatsConfigMigrationRequiredError['code']
  | 'config_is_link'
  | 'revision_conflict'
  | AgySeatSettingsError['code']
  | 'owner_approval_required'
  | 'seat_override_instruction_invalid'
  | 'seat_not_configured'
  | 'seat_override_not_found'
  | 'seat_override_active'
  | 'seat_runtime_not_enabled'
  | 'seat_model_invalid'
  | 'seat_model_retired'
  | 'seat_effort_invalid'
  | 'seat_effort_unverified'
  | 'seat_tool_not_allowed'
  | 'seat_fleet_not_allowed';

export class SeatsConfigurationError extends Error {
  constructor(readonly code: SeatsConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'SeatsConfigurationError';
  }
}

export function seatsRanges(enabledRuntimes: readonly string[], agyModels: readonly AgyCatalogModel[] | null): SeatsRangesV1 {
  return {
    runtimes: SEAT_RUNTIMES.map(id => ({ id, enabled: enabledRuntimes.includes(seatHostId(id)), ...RUNTIME_RANGES[id] })),
    efforts: EFFORT_LEVELS,
    agy_models: agyModels,
    roles: SEAT_SCAFFOLD_SUB_AGENTS.map(name => ({ name, writable: false })),
    seats: SEAT_RANGES,
    routing: { classes: ROUTING_CLASSES, worker_seats: WORKER_SEAT_IDS, frontend_seats: FRONTEND_SEAT_IDS },
  };
}

export interface SeatsConfiguration {
  readonly revision: string;
  /** Effective seats with active owner overrides overlaid. */
  readonly seats: SeatsConfigV1;
  /** Base catalog seats stored in `config.seats` before overrides. */
  readonly base_seats: SeatsConfigV1;
  /** Active owner-authorized route overrides stored in `config.seat_overrides`. */
  readonly overrides: SeatOverridesV1;
  readonly enabled_runtimes: readonly string[];
}

const configInvalid = (section: string) =>
  new SeatsConfigurationError('config_invalid', `The ${section} section of the repo-harness configuration is not valid.`);

export function enabledRuntimesOf(config: Record<string, unknown>): readonly string[] {
  if (config.agents === undefined) return [];
  try { return decodeAgentsConfig(config.agents).enabled; } catch { throw configInvalid('agents'); }
}

/** Reads and saves enforce the section contract through this one decoder call; only saves enforce the runtime ranges that can change later. */
function decodeSeatsSection(value: unknown): SeatsConfigV1 {
  try { return decodeSeatsConfig(value); } catch (error) {
    if (error instanceof SeatsConfigMigrationRequiredError || error instanceof AgySeatSettingsError) throw new SeatsConfigurationError(error.code, error.message);
    throw new SeatsConfigurationError('config_invalid', seatsConfigInvalidMessage(error));
  }
}

function decodeSeatOverridesSection(value: unknown): SeatOverridesV1 {
  try { return decodeSeatOverrides(value); } catch (error) {
    if (error instanceof AgySeatSettingsError) throw new SeatsConfigurationError(error.code, error.message);
    throw new SeatsConfigurationError('config_invalid', seatOverridesInvalidMessage(error));
  }
}

function decodeEffectiveSeatsDocument(config: Record<string, unknown>) {
  try { return decodeEffectiveSeats(config); } catch (error) {
    if (error instanceof SeatsConfigMigrationRequiredError || error instanceof AgySeatSettingsError || error instanceof SeatOverrideValidationError) {
      throw new SeatsConfigurationError(error.code, error.message);
    }
    throw new SeatsConfigurationError('config_invalid', effectiveSeatsInvalidMessage(error));
  }
}

export function readSeatsConfiguration(env: NodeJS.ProcessEnv = process.env): SeatsConfiguration {
  let document: ReturnType<typeof readGlobalConfiguration>;
  try {
    document = readGlobalConfiguration(env);
  } catch {
    throw new SeatsConfigurationError('config_invalid', 'The repo-harness configuration file is not a valid JSON object.');
  }
  const resolved = decodeEffectiveSeatsDocument(document.config);
  return {
    revision: document.revision,
    seats: resolved.seats,
    base_seats: resolved.base_seats,
    overrides: resolved.overrides,
    enabled_runtimes: enabledRuntimesOf(document.config),
  };
}

/** The model id and effort are user text (#3250, #3641): name the field and allowed values, never echo the submitted value. */
function checkEffort(field: string, model: SeatModelV1, runtimeId: SeatRuntime): void {
  const runtime = RUNTIME_RANGES[runtimeId];
  if (model.effort !== null && (!runtime.effort || !EFFORT_LEVELS.includes(model.effort))) {
    const allowed = runtime.effort ? EFFORT_LEVELS.join(', ') : 'none';
    throw new SeatsConfigurationError(
      'seat_effort_invalid',
      `The effort at ${field} is not valid for ${runtimeId}. Allowed values: ${allowed}.`,
    );
  }
}

export function checkSeatRoutingModels(routing: SeatRoutingV1): void {
  if (routing.low_quota_explorer.model === null) {
    throw new SeatsConfigurationError('seat_model_invalid', 'The routing.low_quota_explorer model is required.');
  }
  checkEffort('seats.routing.low_quota_explorer.effort', routing.low_quota_explorer, 'claude');
}

function checkSeat(id: SeatId, seat: SeatConfigV1, enabledRuntimes: readonly string[]): void {
  const runtime = RUNTIME_RANGES[seat.runtime];
  const range = SEAT_RANGES[id];
  if (!enabledRuntimes.includes(seatHostId(seat.runtime))) {
    throw new SeatsConfigurationError('seat_runtime_not_enabled', `Fix the ${id} seat before saving. Its runtime ${seat.runtime} is disabled under Hosts.`);
  }
  checkEffort(`seats.${id}.effort`, seat, seat.runtime);
  const tool = seat.tools.find(item => !range.tools.includes(item));
  if (tool !== undefined) throw new SeatsConfigurationError('seat_tool_not_allowed', `The ${id} seat cannot have the ${tool} tool group.`);
  const role = seat.fleet.find(name => !runtime.fleet || !seatTakesFleet(seat) || !range.fleet.includes(name));
  if (role !== undefined) throw new SeatsConfigurationError('seat_fleet_not_allowed', `The ${id} seat on ${seat.runtime} cannot call the ${role} sub-agent.`);
}

/** Resolve the installation through OAR for both standalone quota reads and the seat catalog. */
export async function resolveAgyInstallation(env: NodeJS.ProcessEnv) {
  const { antigravityRuntime } = await import('@botiverse/oar/runtimes/antigravity');
  return antigravityRuntime.installation({ env: agyEnvironment(env) });
}

/** Read the native catalog in a child with a scratch cwd. Only its typed projection returns. */
export function probeAgySeat(env: NodeJS.ProcessEnv = process.env): AgyProbe {
  const cwd = mkdtempSync(join(tmpdir(), 'rh-agy-catalog-'));
  try {
    const result = runProcess(process.execPath, [fileURLToPath(import.meta.url), AGY_CATALOG_CHILD_ARG], {
      cwd, env: agyProbeEnv(env), inheritEnv: false, timeoutMs: AGY_CATALOG_CHILD_MS, processGroup: true,
    });
    if (!result.ok) return { kind: 'unknown' };
    const row: unknown = JSON.parse(result.stdout);
    if (!isRecord(row)) return { kind: 'unknown' };
    switch (row.kind) {
      case 'not_installed': case 'unsupported': case 'signed_out': case 'catalog_unknown': return { kind: row.kind };
      case 'available':
        if (typeof row.executable === 'string' && isAbsolute(row.executable) && typeof row.version === 'string'
          && /^\d+\.\d+\.\d+$/u.test(row.version) && Array.isArray(row.models) && row.models.every(isAgyCatalogModel)) {
          return { kind: row.kind, installation: { kind: 'available', via: 'executable', command: row.executable, version: row.version }, models: row.models };
        }
    }
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The effort menus that the settings page offers: the launch catalog, read only while Antigravity is on in Hosts. */
export async function agyCatalogModels(enabledRuntimes: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<readonly AgyCatalogModel[] | null> {
  if (!enabledRuntimes.includes(seatHostId('agy'))) return null;
  const probe = await readAgyCatalogOffThread(env);
  return probe.kind === 'available' ? probe.models : null;
}

/**
 * An explicit agy effort needs the catalog menu only when its model or effort changes. A stored seat is not checked
 * again, so a signed-out agy does not block a save of another seat. The Default effort (null) needs no menu.
 */
function agyEffortChanged(stored: SeatConfigV1 | null, next: SeatConfigV1 | null): next is SeatConfigV1 & { readonly effort: string } {
  return next?.runtime === 'agy' && next.effort !== null
    && !(stored?.runtime === 'agy' && stored.model === next.model && stored.effort === next.effort);
}

/** The messages name the seat field only: a model id is user text and a refusal body goes into the operator audit. */
function checkAgyEffort(id: SeatId, seat: { readonly model: string | null; readonly effort: string }, catalog: AgyProbe, section: 'seats' | 'seat_overrides' = 'seats'): void {
  const listed = catalog.kind === 'available' ? catalog.models.find(model => model.id === seat.model) : undefined;
  if (catalog.kind !== 'available' || listed?.efforts === null) {
    throw new SeatsConfigurationError('seat_effort_unverified', `agy did not report the effort menu of the ${section}.${id}.model, so ${section}.${id}.effort cannot be checked.`);
  }
  if (!listed?.efforts.includes(seat.effort)) {
    throw new SeatsConfigurationError('seat_effort_invalid', `The agy catalog does not offer ${section}.${id}.effort for ${section}.${id}.model.`);
  }
}

async function readAgyCatalog(): Promise<AgyProbe> {
  const env = agyEnvironment(process.env);
  let stage: 'unknown' | 'catalog_unknown' = 'unknown';
  try {
    const installed = await resolveAgyInstallation(process.env);
    if (installed.kind === 'not_found') return { kind: 'not_installed' };
    if (installed.kind === 'unsupported') return { kind: 'unsupported' };
    if (installed.via !== 'executable' || !isAbsolute(installed.command)) return { kind: 'unknown' };
    stage = 'catalog_unknown';
    // The catalog reports sign-in directly. The auth endpoint also reads account identity.
    const { antigravityRuntime } = await import('@botiverse/oar/runtimes/antigravity');
    const catalog = await antigravityRuntime.listModels(installed, { env, timeoutMs: SEAT_POOL_MEMBER_MS });
    if (catalog.kind === 'unauthenticated') return { kind: 'signed_out' };
    if (catalog.kind !== 'ok') return { kind: 'catalog_unknown' };
    const models = projectAgyCatalog(catalog);
    return models.size === 0 ? { kind: 'catalog_unknown' } : { kind: 'available', installation: installed, models: [...models.values()] };
  } catch {
    return { kind: stage };
  }
}

async function probeAgyPool(): Promise<SeatPoolProbe> {
  const probe = await readAgyCatalog();
  switch (probe.kind) {
    case 'available': return { id: 'agy', installation: 'available', sign_in: 'logged_in', models: 'ok',
      listed: [...catalogProbeModelIds('agy')].filter(id => probe.models.some(model => model.id === id)).map(id => ({ id, disabled: false })) };
    case 'signed_out': return { ...emptySeatPoolProbe('agy', 'available'), sign_in: 'logged_out', models: 'unauthenticated' };
    case 'catalog_unknown': return { ...emptySeatPoolProbe('agy', 'available'), sign_in: 'unknown', models: 'unknown' };
    case 'not_installed': return emptySeatPoolProbe('agy', 'not_installed');
    default: return emptySeatPoolProbe('agy', 'unknown');
  }
}

export function collectSeatPoolProbes(env: NodeJS.ProcessEnv = process.env, includeAgy = false): readonly SeatPoolProbe[] {
  const which = (id: SeatRuntime) => Bun.which(id, { PATH: env.PATH ?? '' });
  const pi = emptySeatPoolProbe('pi', which('pi') === null ? 'not_installed' : 'available');
  const commands = CATALOG_RUNTIMES.map(id => which(id) ?? '');
  const runtimes = includeAgy ? [...CATALOG_RUNTIMES, 'agy'] as const : CATALOG_RUNTIMES;
  if (!includeAgy && commands.every(command => command === '')) return [...CATALOG_RUNTIMES.map(id => emptySeatPoolProbe(id, 'not_installed')), pi];
  const cwd = mkdtempSync(join(tmpdir(), 'rh-seat-pool-'));
  try {
    const answer = runProcess(process.execPath, [fileURLToPath(import.meta.url), ...commands, ...(includeAgy ? ['agy'] : [])], {
      cwd, timeoutMs: SEAT_POOL_CHILD_MS, processGroup: true,
      inheritEnv: false, env: { ...env, OAR_CHILD_STDERR: 'ignore' },
    });
    if (answer.ok) {
      const rows: unknown = JSON.parse(answer.stdout);
      if (Array.isArray(rows) && rows.length === runtimes.length) {
        return [...runtimes.map((id, index) => decodeSeatPoolProbe(id, rows[index])), pi];
      }
    }
  } catch {
    // Process errors and raw child output stay private.
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  return [...CATALOG_RUNTIMES.map((id, index) => emptySeatPoolProbe(id, commands[index] === '' ? 'not_installed' : 'unknown')), pi];
}

/** Check only the path of the extension that Magpie writes. Its contents can include a gateway key. */
export function magpieExtensionInstalled(env: NodeJS.ProcessEnv): boolean {
  const agentDirectory = env.PI_CODING_AGENT_DIR || join(env.HOME ?? homedir(), '.pi', 'agent');
  try {
    return lstatSync(join(agentDirectory, MAGPIE_EXTENSION_PATH), { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}

export function readSeatPoolCache(env: NodeJS.ProcessEnv = process.env, now = Date.now()): SeatPoolCacheV1 | null {
  try {
    const path = seatPoolPath(env);
    checkPoolDirectories(path, false);
    const report = decodeSeatPool(readPoolFile(path));
    const age = now - Date.parse(report.collected_at);
    return { status: age < 0 || age >= SEAT_POOL_STALE_MS ? 'stale' : 'ready', report };
  } catch {
    return null;
  }
}

/** The cache only serves settings. A request for the pool always observes the environment again. */
export function refreshSeatPool(): { readonly report: SeatPoolV1; readonly stored: boolean } {
  const { seats } = readSeatsConfiguration();
  const probes = collectSeatPoolProbes(process.env, true);
  const report = buildSeatPool(seats, probes, new Date().toISOString());
  try {
    storeSeatPool(report);
    return { report, stored: true };
  } catch {
    return { report, stored: false };
  }
}

if (import.meta.main) {
  if (process.argv[2] === AGY_CATALOG_CHILD_ARG) {
    const probe = await readAgyCatalog();
    const row = probe.kind === 'available'
      ? { kind: probe.kind, executable: probe.installation.command, version: probe.installation.version, models: probe.models }
      : probe;
    process.stdout.write(`${JSON.stringify(row)}\n`, () => process.exit(0));
  } else {
    const probes: SeatPoolProbe[] = [];
    for (const [index, id] of CATALOG_RUNTIMES.entries()) probes.push(await probeSeatCatalog(id, process.argv[index + 2] ?? ''));
    if (process.argv[2 + CATALOG_RUNTIMES.length] === 'agy') probes.push(await probeAgyPool());
    process.stdout.write(`${JSON.stringify(probes)}\n`, () => process.exit(0));
  }
}

export interface AgySeatAgentSpec {
  readonly baseName: string;
  /** Content-addressed agent directory and frontmatter name (`rh-<role>-<digest12>`). */
  readonly name: string;
  /** Full `agent.md` UTF-8 content with frontmatter `name: <name>`. */
  readonly content: string;
  /** Expected `sha256:<hex>` of the `agent.md` file bytes. */
  readonly fileDigest: string;
}

/** Deterministic content-addressed agy agent spec (`rh-<role>-<digest12>`). */
export function agySeatAgentSpec(seat: LaunchSeatId, config: SeatConfigV1): AgySeatAgentSpec {
  const baseName = agySeatAgentName(seat);
  const tools = agySeatAgentTools(seat, config);
  const description = AGY_AGENT_DESCRIPTIONS[baseName] ?? `Repo-harness ${seat}`;
  const inheritMcp = config.tools.includes('mcp');
  const body = agySeatBrief(seat, config);
  const canonical = renderAgySeatAgentMarkdown(baseName, description, tools, inheritMcp, body);
  const digest12 = sha256Hex(Buffer.from(canonical, 'utf8')).slice(0, 12);
  const name = `${baseName}-${digest12}`;
  const content = renderAgySeatAgentMarkdown(name, description, tools, inheritMcp, body);
  const fileDigest = sha256Prefixed(Buffer.from(content, 'utf8'));
  return { baseName, name, content, fileDigest };
}

/**
 * Materialize the content-addressed agy seat agent under `~/.gemini/config/agents/rh-<role>-<digest12>/agent.md`
 * as a file `PathRecord` through `openHostConfigGate` (`owner: 'core'`). Cache hits verify the root guard,
 * on-disk `agent.md` identity/digest, agent directory identity, and that `agent.md` is the sole regular entry.
 */
export function writeAgySeatAgent(seat: LaunchSeatId, config: SeatConfigV1, env: NodeJS.ProcessEnv): string {
  const spec = agySeatAgentSpec(seat, config);
  const paths = hostConfigPaths(env);

  const checkHitOrRefusePresent = (): { readonly hit: boolean; readonly fileKey: string } => {
    const agentsDir = antigravityAgentsDirHostPath(env, paths);
    checkAntigravityPath(agentsDir, 'directory');
    // Guarded canonical parent path before checking the agent directory or joining agent.md.
    const agentDir = hostPathKey(paths, join(agentsDir, spec.name));
    const dirStat = lstatSync(agentDir, { throwIfNoEntry: false });
    if (dirStat !== undefined && !dirStat.isDirectory()) {
      throw new HostConfigError('host_config_replacement_refused', `an existing non-directory entry blocks the agy agent directory: ${agentDir}`);
    }
    const fileKey = join(agentDir, 'agent.md');
    const ledger = readLedger(paths);
    const matched = findAgySeatAgentRecord(ledger, agentsDir, fileKey);
    const recordedKey = matched?.key ?? fileKey;
    const record = matched?.record;
    if (agySeatAgentRecordIsCurrent(ledger, record, recordedKey, spec.fileDigest, agentDir)) return { hit: true, fileKey };
    // Fail closed on any existing directory or file (edited, replaced, extra entry, symlinked, or unrecorded).
    if (dirStat !== undefined || lstatSync(fileKey, { throwIfNoEntry: false }) !== undefined) {
      refuseExistingAgySeatAgent(ledger, record, recordedKey, agentDir, spec.fileDigest);
    }
    return { hit: false, fileKey };
  };

  if (checkHitOrRefusePresent().hit) return spec.name;

  return withRuntimeTransactionLock(globalRuntimeScope(env), () => {
    const checked = checkHitOrRefusePresent();
    if (checked.hit) return spec.name;
    openHostConfigGate({ env }).writePaths([{
      path: checked.fileKey,
      owner: 'core',
      entry: { type: 'file', bytes: Buffer.from(spec.content, 'utf8'), mode: 0o600 },
    }]);
    return spec.name;
  });
}

function assertNoActiveOverrideCleared(next: SeatsConfigV1, overrides: SeatOverridesV1): void {
  const blocked = SEAT_IDS.find(id => next[id] === null && overrides[id] !== undefined);
  if (blocked !== undefined) {
    throw new SeatsConfigurationError('seat_override_active', `Revoke the active owner override on ${blocked} before turning the seat off.`);
  }
}

/** Replaces the `seats` section. It writes only the configuration file; panes that run keep their launch arguments. */
export async function applySeatsSettings(
  request: { readonly expected_revision: string; readonly seats: SeatsConfigV1 },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeatsSettingsResultV1> {
  const retired = retiredSeatModelField(request.seats);
  if (retired !== null) throw new SeatsConfigurationError('seat_model_retired', `The model at ${retired} is retired. Choose another model.`);
  try {
    // The catalog read can take a minute, so it runs before the configuration lock. The expected revision refuses a
    // section that changed after this read.
    const stored = SEAT_IDS.some(id => agyEffortChanged(null, request.seats[id])) ? readSeatsConfiguration(env).base_seats : null;
    const agyChecks = stored === null ? [] : SEAT_IDS.flatMap((id) => {
      const seat = request.seats[id];
      return agyEffortChanged(stored[id], seat) ? [{ id, seat }] : [];
    });
    const catalog = agyChecks.length === 0 ? null : await readAgyCatalogOffThread(env);
    const result = mutateGlobalConfiguration(env, (config) => {
      const enabled = enabledRuntimesOf(config);
      for (const id of SEAT_IDS) {
        const seat = request.seats[id];
        if (seat !== null) checkSeat(id, seat, enabled);
      }
      if (catalog !== null) for (const { id, seat } of agyChecks) checkAgyEffort(id, seat, catalog);
      checkSeatRoutingModels(request.seats.routing);
      // One decoder for the read path and the save (#2917): a candidate that `rh quota` or `rh seats argv` would refuse is never written.
      const next = decodeSeatsSection(request.seats);
      const overrides = decodeSeatOverridesSection(config.seat_overrides);
      assertNoActiveOverrideCleared(next, overrides);
      applySeatOverrides(next, overrides);
      const changed = changedKeys(decodeSeatsSection(config.seats), next);
      return { config: { ...config, seats: next }, value: changed };
    }, { expectedRevision: request.expected_revision });
    return { config_revision: result.revision, changed_keys: result.value };
  } catch (error) {
    if (error instanceof GlobalConfigurationError || error instanceof SeatOverrideValidationError) {
      throw new SeatsConfigurationError(error.code, error.message);
    }
    throw error;
  }
}

function validateOverrideRouteInput(request: SeatOverrideSetRequestV1): string {
  if (!(SEAT_IDS as readonly string[]).includes(request.seat)) {
    throw new SeatsConfigurationError('config_invalid', 'The seat_overrides seat is not valid.');
  }
  if (!(SEAT_RUNTIMES as readonly string[]).includes(request.runtime)) {
    throw new SeatsConfigurationError(
      'seat_runtime_not_allowed',
      `The runtime at seat_overrides.${request.seat}.runtime is not valid. Allowed values: ${SEAT_RUNTIMES.join(', ')}.`,
    );
  }
  if (request.owner_approved !== true) {
    throw new SeatsConfigurationError('owner_approval_required', 'Explicit owner approval is required to authorize a seat route override.');
  }
  const instruction = normalizeOverrideInstruction(request.instruction);
  if (instruction === null) {
    throw new SeatsConfigurationError('seat_override_instruction_invalid', 'Provide a single-line owner instruction between 1 and 280 characters.');
  }
  if (request.runtime === 'agy' && !isAgyAllowedSeat(request.seat)) {
    throw new SeatsConfigurationError('seat_runtime_not_allowed', `The ${request.seat} seat cannot use the agy runtime.`);
  }
  const modelValid = request.runtime === 'agy'
    ? seatModelShapeValid('agy', request.model)
    : request.model === null || seatModelShapeValid(request.runtime, request.model);
  if (!modelValid) {
    throw new SeatsConfigurationError('seat_model_invalid', `The model at seat_overrides.${request.seat}.model is not valid for ${request.runtime}.`);
  }
  if (isRetiredSeatModel(request.model)) {
    throw new SeatsConfigurationError('seat_model_retired', `The model at seat_overrides.${request.seat}.model is retired. Choose another model.`);
  }
  checkEffort(`seat_overrides.${request.seat}.effort`, { model: request.model, effort: request.effort }, request.runtime);
  if (request.runtime === 'agy' && request.model !== null && !agyEffortValid(request.model, request.effort)) {
    throw new SeatsConfigurationError(
      'seat_effort_invalid',
      `The effort at seat_overrides.${request.seat}.effort is not valid for agy. Allowed values: ${EFFORT_LEVELS.join(', ')}.`,
    );
  }
  return instruction;
}

/**
 * Authorize one owner seat route override in `~/.repo-harness/config.json#seat_overrides` (#3641).
 * Reuses the range-checked configuration write lock; base catalog routes stay untouched in `seats`.
 */
export async function applySeatOverride(
  request: SeatOverrideSetRequestV1,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<SeatOverrideResultV1> {
  const instruction = validateOverrideRouteInput(request);
  try {
    const needsAgyCatalog = request.runtime === 'agy' && request.effort !== null
      && readSeatsConfiguration(env).enabled_runtimes.includes(seatHostId('agy'));
    const catalog = needsAgyCatalog ? await readAgyCatalogOffThread(env) : null;
    const result = mutateGlobalConfiguration(env, (config) => {
      const enabled = enabledRuntimesOf(config);
      if (!enabled.includes(seatHostId(request.runtime))) {
        throw new SeatsConfigurationError('seat_runtime_not_enabled', `Enable ${request.runtime} under Hosts before authorizing a ${request.seat} override.`);
      }
      const base = decodeSeatsSection(config.seats);
      if (base[request.seat] === null) {
        throw new SeatsConfigurationError('seat_not_configured', `Configure the ${request.seat} seat before authorizing a route override.`);
      }
      if (request.runtime === 'agy' && request.effort !== null) {
        if (catalog === null) {
          throw new SeatsConfigurationError('seat_effort_unverified', `agy did not report the effort menu of the seat_overrides.${request.seat}.model, so seat_overrides.${request.seat}.effort cannot be checked.`);
        }
        checkAgyEffort(request.seat, { model: request.model, effort: request.effort }, catalog, 'seat_overrides');
      }
      const currentOverrides = decodeSeatOverridesSection(config.seat_overrides);
      const override: SeatRouteOverrideV1 = {
        runtime: request.runtime,
        model: request.model,
        effort: request.effort,
        authorized_at: now.toISOString(),
        instruction,
      };
      const nextOverrides = decodeSeatOverridesSection({ ...currentOverrides, [request.seat]: override });
      applySeatOverrides(base, nextOverrides);
      return { config: { ...config, seat_overrides: nextOverrides }, value: override.authorized_at };
    }, { expectedRevision: request.expected_revision, render: renderJsonObjectUpdate });
    return decodeSeatOverrideResult({
      config_revision: result.revision,
      seat: request.seat,
      active: true,
      authorized_at: result.value,
      changed_keys: [`seat_overrides.${request.seat}`],
    });
  } catch (error) {
    if (error instanceof GlobalConfigurationError) throw new SeatsConfigurationError(error.code, error.message);
    if (error instanceof SeatOverrideValidationError) throw new SeatsConfigurationError(error.code, error.message);
    throw error;
  }
}

/** Revoke one active owner seat route override, restoring the stored base catalog route in `seats`. */
export function revokeSeatOverride(
  request: SeatOverrideRevokeRequestV1,
  env: NodeJS.ProcessEnv = process.env,
): SeatOverrideResultV1 {
  if (!(SEAT_IDS as readonly string[]).includes(request.seat)) {
    throw new SeatsConfigurationError('config_invalid', 'The seat_overrides seat is not valid.');
  }
  if (request.owner_approved !== true) {
    throw new SeatsConfigurationError('owner_approval_required', 'Explicit owner approval is required to revoke a seat route override.');
  }
  try {
    const result = mutateGlobalConfiguration(env, (config) => {
      decodeSeatsSection(config.seats);
      const currentOverrides = decodeSeatOverridesSection(config.seat_overrides);
      if (currentOverrides[request.seat] === undefined) {
        throw new SeatsConfigurationError('seat_override_not_found', `No active owner override exists for the ${request.seat} seat.`);
      }
      const remainingEntries = Object.entries(currentOverrides).filter(([id]) => id !== request.seat);
      if (remainingEntries.length === 0) {
        const { seat_overrides: _removed, ...rest } = config;
        return { config: rest, value: true };
      }
      const nextOverrides = decodeSeatOverridesSection(Object.fromEntries(remainingEntries));
      return { config: { ...config, seat_overrides: nextOverrides }, value: true };
    }, { expectedRevision: request.expected_revision, render: renderJsonObjectUpdate });
    return decodeSeatOverrideResult({
      config_revision: result.revision,
      seat: request.seat,
      active: false,
      authorized_at: null,
      changed_keys: [`seat_overrides.${request.seat}`],
    });
  } catch (error) {
    if (error instanceof GlobalConfigurationError) throw new SeatsConfigurationError(error.code, error.message);
    throw error;
  }
}
