import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAgentsConfig } from '../../core/board/agents-settings';
import { isRecord } from '../../core/evidence/is-record';
import { sha256Hex } from '../../core/evidence/sha256';
import { AGY_SEAT_AGENT, agySeatBrief } from '../../core/board/seat-launch';
import {
  AgySeatSettingsError,
  COUNCIL_TOOLS,
  SEAT_ALLOWED_FLEET,
  SEAT_IDS,
  SEAT_RUNTIMES,
  SEAT_SCAFFOLD_SUB_AGENTS,
  SEAT_TOOLS,
  FRONTEND_SEAT_IDS,
  ROUTING_CLASSES,
  ROUTING_KEYS,
  WORKER_SEAT_IDS,
  SeatsConfigMigrationRequiredError,
  decodeSeatsConfig,
  isCouncilOnlyModel,
  isCouncilSeat,
  seatsConfigInvalidMessage,
  seatHostId,
  seatModelShapeValid,
  seatTakesFleet,
  type SeatConfigV1,
  type SeatModelV1,
  type SeatRoutingV1,
  type SeatId,
  type SeatRuntime,
  type SeatRangeV1,
  type SeatRuntimeRangeV1,
  type SeatsConfigV1,
  type SeatsRangesV1,
  type SeatsSettingsResultV1,
  type SeatTool,
} from '../../core/board/seats-settings';
import { SEAT_RECOMMENDED_MODELS } from '../../core/board/recommended-models';
import { MAGPIE_EXTENSION_PATH, SEAT_POOL_KIND, SEAT_POOL_STALE_MS, buildSeatPool, decodeSeatPool, decodeSeatPoolProbe, emptySeatPoolProbe, recommendedModelIds, type SeatPoolCacheV1, type SeatPoolProbe, type SeatPoolV1 } from '../../core/board/seat-pool';
import { EFFORT_LEVELS } from '../terminal/task-role-profiles';
import { GlobalConfigurationError, globalConfigurationPath, mutateGlobalConfiguration, readGlobalConfiguration } from '../configuration/global-configuration';
import { withExclusiveDirectoryLock } from '../locking/exclusive-directory-lock';
import { publishFileByRename } from '../atomic-append';
import { runProcess } from '../process-runner';

export type SeatsConfigurationErrorCode =
  | 'busy'
  | 'config_invalid'
  | SeatsConfigMigrationRequiredError['code']
  | 'config_is_link'
  | 'revision_conflict'
  | AgySeatSettingsError['code']
  | 'seat_runtime_not_enabled'
  | 'seat_model_invalid'
  | 'seat_effort_invalid'
  | 'seat_tool_not_allowed'
  | 'seat_fleet_not_allowed';

export class SeatsConfigurationError extends Error {
  constructor(readonly code: SeatsConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'SeatsConfigurationError';
  }
}

const without = (...excluded: SeatTool[]): readonly SeatTool[] => SEAT_TOOLS.filter(tool => !excluded.includes(tool));

/**
 * Seats can use read-only scaffold roles. Writers and reviewers run in their own Herdr seats (#3305).
 * The orchestrator does not edit (#1472). The advisor may edit proposals (#2032) and does not write GitHub (#1472).
 */
const SEAT_ACCESS: { readonly [seat in SeatId]: Omit<SeatRangeV1, 'models'> } = {
  orchestrator: { fleet: SEAT_ALLOWED_FLEET.orchestrator, tools: without('edit') },
  advisor: { fleet: SEAT_ALLOWED_FLEET.advisor, tools: without('gh') },
  council: { fleet: SEAT_ALLOWED_FLEET.council, tools: COUNCIL_TOOLS },
  worker: { fleet: SEAT_ALLOWED_FLEET.worker, tools: SEAT_TOOLS },
  'worker-deep': { fleet: SEAT_ALLOWED_FLEET['worker-deep'], tools: SEAT_TOOLS },
  'worker-opus': { fleet: SEAT_ALLOWED_FLEET['worker-opus'], tools: SEAT_TOOLS },
  'worker-neon': { fleet: SEAT_ALLOWED_FLEET['worker-neon'], tools: SEAT_TOOLS },
  'worker-light': { fleet: SEAT_ALLOWED_FLEET['worker-light'], tools: SEAT_TOOLS },
  gatekeeper: { fleet: SEAT_ALLOWED_FLEET.gatekeeper, tools: ['net', 'read', 'shell'] },
  'gatekeeper-fallback': { fleet: SEAT_ALLOWED_FLEET['gatekeeper-fallback'], tools: ['net', 'read', 'shell'] },
  reviewer: { fleet: SEAT_ALLOWED_FLEET.reviewer, tools: ['net', 'read', 'shell'] },
};
const SEAT_RANGES = Object.fromEntries(SEAT_IDS.map(id => [id, { models: SEAT_RECOMMENDED_MODELS[id], ...SEAT_ACCESS[id] }])) as SeatsRangesV1['seats'];

const RUNTIME_RANGES: Readonly<Record<SeatRuntime, Omit<SeatRuntimeRangeV1, 'id' | 'enabled'>>> = {
  claude: { effort: true, fleet: true },
  codex: { effort: true, fleet: true },
  pi: { effort: true, fleet: true },
  agy: { effort: false, fleet: false },
};

export function seatsRanges(enabledRuntimes: readonly string[]): SeatsRangesV1 {
  return {
    runtimes: SEAT_RUNTIMES.map(id => ({ id, enabled: enabledRuntimes.includes(seatHostId(id)), ...RUNTIME_RANGES[id] })),
    efforts: EFFORT_LEVELS,
    roles: SEAT_SCAFFOLD_SUB_AGENTS.map(name => ({ name, writable: false })),
    seats: SEAT_RANGES,
    routing: { classes: ROUTING_CLASSES, worker_seats: WORKER_SEAT_IDS, frontend_seats: FRONTEND_SEAT_IDS },
  };
}

export interface SeatsConfiguration {
  readonly revision: string;
  readonly seats: SeatsConfigV1;
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

export function readSeatsConfiguration(env: NodeJS.ProcessEnv = process.env): SeatsConfiguration {
  let document: ReturnType<typeof readGlobalConfiguration>;
  try {
    document = readGlobalConfiguration(env);
  } catch {
    throw new SeatsConfigurationError('config_invalid', 'The repo-harness configuration file is not a valid JSON object.');
  }
  return { revision: document.revision, seats: decodeSeatsSection(document.config.seats), enabled_runtimes: enabledRuntimesOf(document.config) };
}

/** The model id is the user's (#3250): the request decoder owns its shape, and the seat's `models` in the ranges only recommends. */
function checkEffort(subject: string, model: SeatModelV1, runtimeId: SeatRuntime): void {
  const runtime = RUNTIME_RANGES[runtimeId];
  if (model.effort !== null && (!runtime.effort || !EFFORT_LEVELS.includes(model.effort))) {
    throw new SeatsConfigurationError('seat_effort_invalid', `The ${subject} cannot use effort ${model.effort} on ${runtimeId}.`);
  }
}

export function checkSeatRoutingModels(routing: SeatRoutingV1): void {
  if (routing.low_quota_explorer.model === null) {
    throw new SeatsConfigurationError('seat_model_invalid', 'The routing.low_quota_explorer model is required.');
  }
  checkEffort('routing.low_quota_explorer', routing.low_quota_explorer, 'claude');
}

function checkSeat(id: SeatId, seat: SeatConfigV1, enabledRuntimes: readonly string[]): void {
  const runtime = RUNTIME_RANGES[seat.runtime];
  const range = SEAT_RANGES[id];
  if (!enabledRuntimes.includes(seatHostId(seat.runtime))) {
    throw new SeatsConfigurationError('seat_runtime_not_enabled', `Fix the ${id} seat before saving. Its runtime ${seat.runtime} is disabled under Hosts.`);
  }
  if (!isCouncilSeat(id) && isCouncilOnlyModel(seat)) {
    throw new SeatsConfigurationError('seat_model_invalid', `The ${id} seat cannot use ${seat.model}. That model is restricted to the council seat.`);
  }
  checkEffort(`${id} seat`, seat, seat.runtime);
  const tool = seat.tools.find(item => !range.tools.includes(item));
  if (tool !== undefined) throw new SeatsConfigurationError('seat_tool_not_allowed', `The ${id} seat cannot have the ${tool} tool group.`);
  const role = seat.fleet.find(name => !runtime.fleet || !seatTakesFleet(seat) || !range.fleet.includes(name));
  if (role !== undefined) throw new SeatsConfigurationError('seat_fleet_not_allowed', `The ${id} seat on ${seat.runtime} cannot call the ${role} sub-agent.`);
}

const SEAT_POOL_MEMBER_MS = 15_000;
// Codex installation can run both a readiness and a version check. Leave time for OAR to close its processes.
const SEAT_POOL_CHILD_MS = 120_000;
const SEAT_POOL_FILE_LIMIT = 64 * 1024;
const CATALOG_RUNTIMES = ['claude', 'codex'] as const;

type AgyProbe =
  | { readonly kind: 'available'; readonly executable: string; readonly models: ReadonlySet<string> }
  | { readonly kind: 'not_installed' | 'unsupported' | 'signed_out' | 'catalog_unknown' | 'unknown' };

/** Observe the native CLI once. Its login state and raw output stay with the probe. */
export async function probeAgySeat(env: NodeJS.ProcessEnv = process.env): Promise<AgyProbe> {
  const probeEnv: NodeJS.ProcessEnv = { HOME: env.HOME ?? homedir(), PATH: env.PATH ?? '', TMPDIR: env.TMPDIR,
    BUN_INSTALL: env.BUN_INSTALL, OAR_ANTIGRAVITY_BIN: env.OAR_ANTIGRAVITY_BIN, OAR_CHILD_STDERR: 'ignore', NO_COLOR: '1', TERM: 'dumb' };
  let executable: string;
  try {
    const { antigravityRuntime } = await import('@botiverse/oar/runtimes/antigravity');
    const overlay = Object.fromEntries(Object.keys(process.env).map(key => [key, null]));
    const installed = await antigravityRuntime.installation?.({ env: { ...overlay, ...Object.fromEntries(Object.entries(probeEnv).map(([key, value]) => [key, value ?? null])) } });
    if (installed?.kind === 'not_found') return { kind: 'not_installed' };
    if (installed?.kind === 'unsupported') return { kind: 'unsupported' };
    if (installed?.kind !== 'available' || installed.via !== 'executable' || !isAbsolute(installed.command)) return { kind: 'unknown' };
    executable = installed.command;
  } catch {
    return { kind: 'unknown' };
  }

  let cwd: string | undefined;
  try {
    cwd = mkdtempSync(join(tmpdir(), 'rh-agy-catalog-'));
    const result = runProcess(executable, ['models'], { cwd, env: probeEnv, inheritEnv: false, timeoutMs: SEAT_POOL_MEMBER_MS, processGroup: true });
    if (!result.timedOut && result.status === 1 && /Please sign in\b/iu.test(`${result.stdout}\n${result.stderr}`)) return { kind: 'signed_out' };
    if (!result.ok) return { kind: 'catalog_unknown' };
    const models = new Set<string>();
    for (const line of result.stdout.split(/\r?\n/u)) {
      if (line.trim() === '') continue;
      const [id, name, ...rest] = line.split('\t');
      if (!seatModelShapeValid('agy', id) || !name?.trim() || rest.length !== 0) return { kind: 'catalog_unknown' };
      models.add(id);
    }
    return models.size === 0 ? { kind: 'catalog_unknown' } : { kind: 'available', executable, models };
  } catch {
    return { kind: 'catalog_unknown' };
  } finally {
    if (cwd !== undefined) rmSync(cwd, { recursive: true, force: true });
  }
}

async function probeAgyPool(): Promise<SeatPoolProbe> {
  const probe = await probeAgySeat();
  switch (probe.kind) {
    case 'available': return { id: 'agy', installation: 'available', sign_in: 'logged_in', models: 'ok',
      listed: [...recommendedModelIds('agy')].filter(id => probe.models.has(id)).map(id => ({ id, disabled: false })) };
    case 'signed_out': return { ...emptySeatPoolProbe('agy', 'available'), sign_in: 'logged_out', models: 'unauthenticated' };
    case 'catalog_unknown': return { ...emptySeatPoolProbe('agy', 'available'), sign_in: 'unknown', models: 'unknown' };
    case 'not_installed': return emptySeatPoolProbe('agy', 'not_installed');
    default: return emptySeatPoolProbe('agy', 'unknown');
  }
}

async function probeSeatCatalog(id: typeof CATALOG_RUNTIMES[number], command: string): Promise<SeatPoolProbe> {
  if (command === '') return emptySeatPoolProbe(id, 'not_installed');
  let probe = emptySeatPoolProbe(id, 'unknown');
  try {
    const runtime = id === 'claude' ? (await import('@botiverse/oar/runtimes/claude')).claudeRuntime
      : (await import('@botiverse/oar/runtimes/codex')).codexRuntime;
    const { installation, authStatus, listModels } = runtime;
    if (installation === undefined || authStatus === undefined || listModels === undefined) return probe;
    const env = { [id === 'claude' ? 'OAR_CLAUDE_BIN' : 'OAR_CODEX_BIN']: command };
    const installed = await installation({ env });
    if (installed.kind === 'not_found') return emptySeatPoolProbe(id, 'not_installed');
    if (installed.kind !== 'available') return probe;
    probe = { ...probe, installation: 'available', sign_in: 'unknown' };
    const auth = await authStatus(installed, { timeoutMs: SEAT_POOL_MEMBER_MS });
    if (auth.kind !== 'logged_in') return { ...probe, sign_in: auth.kind };
    probe = { ...probe, sign_in: 'logged_in', models: 'unknown' };
    const catalog = await listModels(installed, { cwd: process.cwd(), timeoutMs: SEAT_POOL_MEMBER_MS });
    if (catalog.kind === 'unauthenticated') return { ...probe, models: 'unauthenticated' };
    if (catalog.kind !== 'ok') return probe;
    const wanted = recommendedModelIds(id);
    return { ...probe, models: 'ok', listed: catalog.models.filter(model => wanted.has(model.id))
      .map(model => ({ id: model.id, disabled: model.disabled !== undefined })) };
  } catch {
    return probe;
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

function seatPoolPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(globalConfigurationPath(env)), 'seats', 'pool.json');
}

function checkPoolDirectories(path: string, create: boolean): void {
  for (const directory of [dirname(dirname(path)), dirname(path)]) {
    if (create) {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!lstatSync(directory).isDirectory()) throw new Error('seat_pool_invalid_path');
  }
}

function readPoolFile(path: string): Record<string, unknown> {
  if (!lstatSync(path).isFile()) throw new Error('seat_pool_invalid_path');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > SEAT_POOL_FILE_LIMIT) throw new Error('seat_pool_invalid_path');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!isRecord(value) || value.protocol !== 1 || value.kind !== SEAT_POOL_KIND) throw new Error('seat_pool_unowned_file');
    return value;
  } finally { closeSync(fd); }
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

function storeSeatPool(report: SeatPoolV1): void {
  const path = seatPoolPath(process.env);
  checkPoolDirectories(path, true);
  withExclusiveDirectoryLock(realpathSync(dirname(path)), 'pool.lock', () => {
    checkPoolDirectories(path, false);
    // The protocol marker identifies the cache across changes to the recommended table.
    let previous: Record<string, unknown> | undefined;
    try { previous = readPoolFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (typeof previous?.collected_at === 'string' && Date.parse(previous.collected_at) > Date.parse(report.collected_at)
      && Date.parse(previous.collected_at) <= Date.now()) return;
    publishFileByRename(path, Buffer.from(`${JSON.stringify(report, null, 2)}\n`), `${path}.tmp-${randomUUID()}`);
  }, { reclaimStaleOwner: true });
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
  // Only the pool probe child runs the OAR catalog members, one runtime at a time.
  const probes: SeatPoolProbe[] = [];
  for (const [index, id] of CATALOG_RUNTIMES.entries()) probes.push(await probeSeatCatalog(id, process.argv[index + 2] ?? ''));
  if (process.argv[2 + CATALOG_RUNTIMES.length] === 'agy') probes.push(await probeAgyPool());
  process.stdout.write(`${JSON.stringify(probes)}\n`, () => process.exit(0));
}

/** Publish the generated advisor by digest. An existing path can only be reused if it holds these bytes. */
export function writeAgySeatAgent(config: SeatConfigV1, env: NodeJS.ProcessEnv): string {
  const content = Buffer.from([
    '---', `name: ${AGY_SEAT_AGENT}`, 'description: Repo-harness advisor', 'mainAgent: true',
    'tools: [view_file, run_command, search_web]', 'inheritMcp: false', '---', '', '# System', '', agySeatBrief(config), '',
  ].join('\n'));
  const digest = sha256Hex(content);
  let directory = realpathSync(dirname(dirname(globalConfigurationPath(env))));
  for (const part of ['.repo-harness', 'seats', 'agy', digest, '.agents', 'agents', AGY_SEAT_AGENT]) {
    directory = join(directory, part);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error('agy agent directory must be owned and contain no links.');
  }
  const path = join(directory, 'agent.md');
  const temporary = join(directory, `.agent-${randomUUID()}.tmp`);
  writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
  try {
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size !== content.length || !readFileSync(fd).equals(content)) throw new Error('agy agent file differs from its expected content.');
      } finally { closeSync(fd); }
    }
  } finally {
    unlinkSync(temporary);
  }
  return dirname(dirname(dirname(directory)));
}

const FIELDS = ['runtime', 'model', 'advisor_model', 'effort', 'tools', 'fleet'] as const;

function changedKeys(current: SeatsConfigV1, next: SeatsConfigV1): string[] {
  return [...SEAT_IDS.flatMap(id => {
    const before = current[id], after = next[id];
    if (before === null || after === null) return before === after ? [] : [`seats.${id}`];
    return FIELDS.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      .map(field => `seats.${id}.${field}`);
  }),
  ...ROUTING_KEYS
    .filter(field => JSON.stringify(current.routing[field]) !== JSON.stringify(next.routing[field]))
    .map(field => `seats.routing.${field}`),
  ...SEAT_SCAFFOLD_SUB_AGENTS
    .filter(role => current.pi_sub_agent_models?.[role] !== next.pi_sub_agent_models?.[role])
    .map(role => `seats.pi_sub_agent_models.${role}`)];
}

/** Replaces the `seats` section. It writes only the configuration file; panes that run keep their launch arguments. */
export function applySeatsSettings(
  request: { readonly expected_revision: string; readonly seats: SeatsConfigV1 },
  env: NodeJS.ProcessEnv = process.env,
): SeatsSettingsResultV1 {
  try {
    const result = mutateGlobalConfiguration(env, (config) => {
      const enabled = enabledRuntimesOf(config);
      for (const id of SEAT_IDS) {
        const seat = request.seats[id];
        if (seat !== null) checkSeat(id, seat, enabled);
      }
      checkSeatRoutingModels(request.seats.routing);
      // One decoder for the read path and the save (#2917): a candidate that `rh quota` or `rh seats argv` would refuse is never written.
      const next = decodeSeatsSection(request.seats);
      const changed = changedKeys(decodeSeatsSection(config.seats), next);
      return { config: { ...config, seats: next }, value: changed };
    }, { expectedRevision: request.expected_revision });
    return { config_revision: result.revision, changed_keys: result.value };
  } catch (error) {
    if (error instanceof GlobalConfigurationError) throw new SeatsConfigurationError(error.code, error.message);
    throw error;
  }
}
