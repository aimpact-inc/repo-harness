import { decodeAgentsConfig } from '../../core/board/agents-settings';
import {
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
  seatsConfigInvalidMessage,
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
import { EFFORT_LEVELS } from '../terminal/task-role-profiles';
import { GlobalConfigurationError, mutateGlobalConfiguration, readGlobalConfiguration } from '../configuration/global-configuration';

export type SeatsConfigurationErrorCode =
  | 'busy'
  | 'config_invalid'
  | SeatsConfigMigrationRequiredError['code']
  | 'config_is_link'
  | 'revision_conflict'
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
  orchestrator: { fleet: SEAT_SCAFFOLD_SUB_AGENTS, tools: without('edit') },
  advisor: { fleet: SEAT_SCAFFOLD_SUB_AGENTS, tools: without('gh') },
  worker: { fleet: SEAT_SCAFFOLD_SUB_AGENTS, tools: SEAT_TOOLS },
  'worker-deep': { fleet: SEAT_SCAFFOLD_SUB_AGENTS, tools: SEAT_TOOLS },
  'worker-important': { fleet: SEAT_SCAFFOLD_SUB_AGENTS, tools: SEAT_TOOLS },
  'worker-important-fast': { fleet: SEAT_SCAFFOLD_SUB_AGENTS, tools: SEAT_TOOLS },
  'worker-light': { fleet: SEAT_SCAFFOLD_SUB_AGENTS, tools: SEAT_TOOLS },
  gatekeeper: { fleet: [], tools: ['net', 'read', 'shell'] },
  'gatekeeper-deep': { fleet: [], tools: ['net', 'read', 'shell'] },
  'gatekeeper-fallback': { fleet: [], tools: ['net', 'read', 'shell'] },
  reviewer: { fleet: [], tools: ['net', 'read', 'shell'] },
};
const SEAT_RANGES = Object.fromEntries(SEAT_IDS.map(id => [id, { models: SEAT_RECOMMENDED_MODELS[id], ...SEAT_ACCESS[id] }])) as SeatsRangesV1['seats'];

/** Pi takes fleet roles only on a Codex model behind `magpie/codex/` (`seatTakesFleet`). */
const RUNTIME_RANGES: Readonly<Record<SeatRuntime, Omit<SeatRuntimeRangeV1, 'id' | 'enabled'>>> = {
  claude: { effort: true, fleet: true },
  codex: { effort: true, fleet: true },
  pi: { effort: true, fleet: true },
};

export function seatsRanges(enabledRuntimes: readonly string[]): SeatsRangesV1 {
  return {
    runtimes: SEAT_RUNTIMES.map(id => ({ id, enabled: enabledRuntimes.includes(id), ...RUNTIME_RANGES[id] })),
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

function enabledRuntimesOf(config: Record<string, unknown>): readonly string[] {
  if (config.agents === undefined) return [];
  try { return decodeAgentsConfig(config.agents).enabled; } catch { throw configInvalid('agents'); }
}

/** Reads and saves enforce the section contract through this one decoder call; only saves enforce the runtime ranges that can change later. */
function decodeSeatsSection(value: unknown): SeatsConfigV1 {
  try { return decodeSeatsConfig(value); } catch (error) {
    if (error instanceof SeatsConfigMigrationRequiredError) throw new SeatsConfigurationError(error.code, error.message);
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
  if (!enabledRuntimes.includes(seat.runtime)) {
    throw new SeatsConfigurationError('seat_runtime_not_enabled', `Fix the ${id} seat before saving. Its runtime ${seat.runtime} is disabled under Hosts.`);
  }
  checkEffort(`${id} seat`, seat, seat.runtime);
  const tool = seat.tools.find(item => !range.tools.includes(item));
  if (tool !== undefined) throw new SeatsConfigurationError('seat_tool_not_allowed', `The ${id} seat cannot have the ${tool} tool group.`);
  const role = seat.fleet.find(name => !runtime.fleet || !seatTakesFleet(seat) || !range.fleet.includes(name));
  if (role !== undefined) throw new SeatsConfigurationError('seat_fleet_not_allowed', `The ${id} seat on ${seat.runtime} cannot call the ${role} sub-agent.`);
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
    .map(field => `seats.routing.${field}`)];
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
