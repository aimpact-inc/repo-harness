// Public contracts for the seat settings (G33): the `seats` section of
// `~/.repo-harness/config.json` and GET/POST /api/v1/settings/seats. The
// decoders check shape, seat invariants and the shared Claude advisor model range.
// The configuration effect checks the other model, effort and fleet ranges;
// the GET body carries them as `ranges`, and the browser renders only that.
import { DEFAULT_EXHAUSTED_AT_OR_ABOVE_USED, EXHAUSTED_AT_OR_ABOVE_USED_RANGE } from './quota';
import type { SeatPoolCacheV1 } from './seat-pool';

export const WORKER_SEAT_IDS = ['worker', 'worker-deep', 'worker-opus', 'worker-neon', 'worker-light'] as const;
export type WorkerSeatId = typeof WORKER_SEAT_IDS[number];
export const FRONTEND_SEAT_IDS = ['worker-opus', 'worker-neon'] as const;
export const ROUTING_CLASSES = ['important_deep', 'important_fast', 'simple_deep', 'simple_fast', 'frontend'] as const;
export type RoutingClass = typeof ROUTING_CLASSES[number];
export const SEAT_IDS = ['orchestrator', 'advisor', 'council', ...WORKER_SEAT_IDS, 'gatekeeper', 'gatekeeper-fallback', 'reviewer'] as const;
export type SeatId = typeof SEAT_IDS[number];
/** The gatekeeper-fallback seat launches only as the effective gatekeeper (#2253), under the gatekeeper label and brief. */
export type LaunchSeatId = Exclude<SeatId, 'gatekeeper-fallback'>;
export const LAUNCH_SEAT_IDS = SEAT_IDS.filter((id): id is LaunchSeatId => id !== 'gatekeeper-fallback');
/** The seats that may be null in the section. */
export type OptionalSeatId = 'worker-light' | 'gatekeeper-fallback' | 'council';
export const isCouncilSeat = (id: SeatId): boolean => id === 'council';
export const isOptionalSeat = (id: SeatId): id is OptionalSeatId => id === 'worker-light' || id === 'gatekeeper-fallback' || isCouncilSeat(id);
export const isReviewSeat = (id: SeatId): boolean => id === 'gatekeeper' || id === 'gatekeeper-fallback' || id === 'reviewer';
export const isWorkerSeat = (seat: SeatId): seat is WorkerSeatId => WORKER_SEAT_IDS.includes(seat as WorkerSeatId);

/** The runtimes that run in a Herdr pane. */
export const SEAT_RUNTIMES = ['claude', 'codex', 'pi', 'agy'] as const;
export type SeatRuntime = typeof SEAT_RUNTIMES[number];

export const seatHostId = (runtime: SeatRuntime): string => runtime === 'agy' ? 'antigravity' : runtime;

/** The Claude runtime model range and the labels used by fleet role profiles. */
export const MODEL_FAMILY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
});

/** Tool groups. `read` is always on. */
export const SEAT_TOOLS = ['read', 'edit', 'shell', 'net', 'tasks', 'schedule', 'mcp', 'gh'] as const;
export type SeatTool = typeof SEAT_TOOLS[number];
export const AGY_SEAT_TOOLS = ['net', 'read', 'shell'] as const satisfies readonly SeatTool[];

const TOKEN = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const ROLE = /^[a-z][a-z0-9-]{0,63}$/u;
const REVISION = /^(?:absent|sha256:[0-9a-f]{64})$/u;

/** One seat. A null `model` or `effort` means the host default. */
export interface SeatConfigV1 {
  readonly runtime: SeatRuntime;
  readonly model: string | null;
  /** Optional Claude advisor tool model. Other runtimes require null. */
  readonly advisor_model: string | null;
  readonly effort: string | null;
  readonly tools: readonly SeatTool[];
  readonly fleet: readonly string[];
}

/** A Pi seat on this model prefix runs a Codex-range GPT model through magpie: it draws on the same ChatGPT account as a Codex seat. */
export const PI_CODEX_MODEL_PREFIX = 'magpie/codex/';
export const isPiCodexSeat = (seat: { readonly runtime: SeatRuntime; readonly model: string | null }): boolean =>
  seat.runtime === 'pi' && seat.model?.startsWith(PI_CODEX_MODEL_PREFIX) === true;

export const PI_AGY_MODEL_PREFIX = 'magpie/agy-cli/';
const AGY_NEON_MODEL = 'gemini-4-neon';
const AGY_HYDROGEN_MODEL = 'gemini-4-hydrogen';
export const PI_NEON_MODEL = `${PI_AGY_MODEL_PREFIX}${AGY_NEON_MODEL}`;

export const isNeonSeat = (seat: Pick<SeatConfigV1, 'runtime' | 'model'>): boolean =>
  (seat.runtime === 'pi' && seat.model === PI_NEON_MODEL)
  || (seat.runtime === 'agy' && seat.model?.startsWith(AGY_NEON_MODEL) === true);

export const isClaudeOrNeonSeat = (seat: Pick<SeatConfigV1, 'runtime' | 'model'>): boolean =>
  seat.runtime === 'claude' || isNeonSeat(seat);

/** Models restricted exclusively to the council plane (ADR-0006 §1). */
export const isCouncilOnlyModel = (seat: Pick<SeatConfigV1, 'runtime' | 'model'>): boolean =>
  seat.model !== null && (
    (seat.runtime === 'claude' && seat.model === 'fable')
    || (seat.runtime === 'codex' && seat.model === 'gpt-6.2-astra')
    || (seat.runtime === 'pi' && seat.model === `${PI_CODEX_MODEL_PREFIX}gpt-6.2-astra`)
  );

/** The retired pre-ADR-0006 default advisor (`claude / fable`), which `rh update` migrates to the active preset. */
export const isLegacyDefaultAdvisor = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && (value as Record<string, unknown>).runtime === 'claude'
  && (value as Record<string, unknown>).model === 'fable';

/** Fleet access depends on the seat's role range, independent of the model that the runtime runs. */
export const seatTakesFleet = (seat: { readonly runtime: SeatRuntime }): boolean => seat.runtime !== 'agy';

export interface SeatModelV1 {
  readonly model: string | null;
  readonly effort: string | null;
}

/** The owner's choice of the seats that run on credits while the ChatGPT account is exhausted (#2630): none, the review seats, or every ChatGPT seat. */
export const CODEX_CREDIT_MODES = ['off', 'review', 'all'] as const;
export type CodexCreditMode = typeof CODEX_CREDIT_MODES[number];

export type SeatRoutingV1 = { readonly [task in RoutingClass]: readonly WorkerSeatId[] } & {
  readonly claude_saving_below_remaining: number;
  /** Claude hyper mode (#2633): weekly remaining at or above this percent. Saving wins below its own threshold. */
  readonly claude_hyper_at_or_above_remaining: number;
  /** Google Ultra (`agy_gemini`) saving floor (ADR-0006 §1): blocks `agy_gemini` workers below this percent while keeping `advisor` active. */
  readonly agy_saving_below_remaining: number;
  /**
   * A window at or above this percent used is `exhausted` (#2909). The default is the reading's own
   * `DEFAULT_EXHAUSTED_AT_OR_ABOVE_USED`, so the quota classifier and the section keep one value. A
   * provider-reported limit is exhausted at any value.
   */
  readonly exhausted_at_or_above_used: number;
  readonly codex_credit_mode: CodexCreditMode;
  /** Below this credit balance the credit mode acts as `off`. */
  readonly codex_credit_floor: number;
  readonly low_quota_explorer: SeatModelV1;
  /**
   * The owner's list of Pi model prefixes that routing does not pick (#2769), such as `magpie/anthropic` for an API key
   * that has no budget left. The quota reader sees only the subscription windows, not this spend.
   */
  readonly unavailable_pi_providers: readonly string[];
};
export const ROUTING_KEYS = [...ROUTING_CLASSES, 'claude_saving_below_remaining', 'claude_hyper_at_or_above_remaining',
  'agy_saving_below_remaining', 'exhausted_at_or_above_used', 'codex_credit_mode', 'codex_credit_floor', 'low_quota_explorer', 'unavailable_pi_providers'] as const satisfies readonly (keyof SeatRoutingV1)[];
export type SeatsConfigV1 = { readonly [seat in Exclude<SeatId, OptionalSeatId>]: SeatConfigV1 } & {
  readonly [seat in OptionalSeatId]: SeatConfigV1 | null;
} & {
  readonly routing: SeatRoutingV1;
  /** Pi role model overrides. An omitted role uses its recommended model. */
  readonly pi_sub_agent_models?: PiSubAgentModels;
};

export const SEAT_SCAFFOLD_SUB_AGENTS = Object.freeze(['deep-reasoner', 'explorer'] as const);
export type SeatScaffoldSubAgent = typeof SEAT_SCAFFOLD_SUB_AGENTS[number];
export type PiSubAgentModels = Readonly<Partial<Record<SeatScaffoldSubAgent, string>>>;

const EXPLORER_ONLY_FLEET: readonly SeatScaffoldSubAgent[] = Object.freeze(['explorer'] as const);
const EMPTY_FLEET: readonly SeatScaffoldSubAgent[] = Object.freeze([] as const);

/** Per-seat permitted sub-agent roles (ADR-0006 §3). Single authority for config decoding, migration stripping, and Settings ranges. */
export const SEAT_ALLOWED_FLEET: Readonly<Record<SeatId, readonly SeatScaffoldSubAgent[]>> = Object.freeze({
  orchestrator: EXPLORER_ONLY_FLEET,
  advisor: SEAT_SCAFFOLD_SUB_AGENTS,
  council: EXPLORER_ONLY_FLEET,
  worker: EXPLORER_ONLY_FLEET,
  'worker-deep': EXPLORER_ONLY_FLEET,
  'worker-opus': EXPLORER_ONLY_FLEET,
  'worker-neon': EXPLORER_ONLY_FLEET,
  'worker-light': EMPTY_FLEET,
  gatekeeper: EMPTY_FLEET,
  'gatekeeper-fallback': EMPTY_FLEET,
  reviewer: EMPTY_FLEET,
});

const WORKER_LIGHT_MODEL = 'zai/glm-5.3-flash';
export const PI_SUB_AGENT_DEFAULTS = Object.freeze({
  'deep-reasoner': Object.freeze({ model: `${PI_CODEX_MODEL_PREFIX}gpt-6.2-sol`, thinking: 'high' }),
  explorer: Object.freeze({ model: WORKER_LIGHT_MODEL, thinking: 'high' }),
}) satisfies Readonly<Record<SeatScaffoldSubAgent, { model: string; thinking: string }>>;

export function piSubAgentModel(role: SeatScaffoldSubAgent, overrides?: PiSubAgentModels): string {
  return overrides?.[role] ?? PI_SUB_AGENT_DEFAULTS[role].model;
}

export function isSeatScaffoldSubAgent(role: string): role is SeatScaffoldSubAgent {
  return SEAT_SCAFFOLD_SUB_AGENTS.some(available => available === role);
}

const ORCHESTRATOR_TOOLS: readonly SeatTool[] = Object.freeze(['gh', 'mcp', 'net', 'read', 'shell', 'tasks'] as const);
const ADVISOR_TOOLS: readonly SeatTool[] = Object.freeze(['mcp', 'net', 'read', 'shell'] as const);
const WORKER_TOOLS: readonly SeatTool[] = Object.freeze(['edit', 'gh', 'mcp', 'net', 'read', 'shell', 'tasks'] as const);
export const RETIRED_SEAT_FLEET_ROLES = Object.freeze(['deep-worker', 'fast-worker', 'gatekeeper', 'root-cause-prover'] as const);
const isDisallowedFleetRole = (id: SeatId, role: unknown): boolean =>
  RETIRED_SEAT_FLEET_ROLES.some(retired => retired === role)
  || (role === 'harness-evaluator' && isWorkerSeat(id))
  || (!isReviewSeat(id) && typeof role === 'string' && isSeatScaffoldSubAgent(role) && !SEAT_ALLOWED_FLEET[id].includes(role));
const REVIEW_TOOLS: readonly SeatTool[] = Object.freeze(['net', 'read', 'shell'] as const);
export const COUNCIL_TOOLS: readonly SeatTool[] = Object.freeze(['net', 'read', 'shell'] as const);

const DEFAULT_ROUTING: SeatRoutingV1 = Object.freeze({
  claude_saving_below_remaining: 20,
  claude_hyper_at_or_above_remaining: 50,
  agy_saving_below_remaining: 25,
  exhausted_at_or_above_used: DEFAULT_EXHAUSTED_AT_OR_ABOVE_USED,
  codex_credit_mode: 'off',
  codex_credit_floor: 0,
  important_deep: Object.freeze(['worker-opus', 'worker-neon', 'worker-deep'] as const),
  important_fast: Object.freeze(['worker-opus', 'worker-neon', 'worker', 'worker-light'] as const),
  simple_deep: Object.freeze(['worker-neon', 'worker-deep'] as const),
  simple_fast: Object.freeze(['worker-light', 'worker'] as const),
  frontend: Object.freeze(['worker-opus', 'worker-neon'] as const),
  low_quota_explorer: Object.freeze({ model: 'haiku', effort: 'high' }),
  unavailable_pi_providers: Object.freeze([]),
});

/** Native Claude fallback advisor when neither Magpie nor Antigravity is enabled (ADR-0006 §2). */
export const NATIVE_CLAUDE_ADVISOR: SeatConfigV1 = Object.freeze({
  runtime: 'claude',
  model: 'opus',
  advisor_model: null,
  effort: 'high',
  tools: ADVISOR_TOOLS,
  fleet: SEAT_SCAFFOLD_SUB_AGENTS,
});

/**
 * The 11-seat preset for Magpie-First (`'magpie'`) or Native-First (`'native'`) transport (ADR-0006 §2).
 * Both presets decode cleanly under `decodeSeatsConfig`.
 */
export function defaultSeatsConfig(preset: 'magpie' | 'native' = 'magpie'): SeatsConfigV1 {
  const orchestrator: SeatConfigV1 = Object.freeze({
    runtime: 'claude', model: 'opus', advisor_model: null, effort: 'high', tools: ORCHESTRATOR_TOOLS, fleet: SEAT_ALLOWED_FLEET.orchestrator,
  });
  const workerOpus: SeatConfigV1 = Object.freeze({
    runtime: 'claude', model: 'opus', advisor_model: null, effort: 'high', tools: WORKER_TOOLS, fleet: SEAT_ALLOWED_FLEET['worker-opus'],
  });
  const reviewer: SeatConfigV1 = Object.freeze({
    runtime: 'claude', model: 'opus', advisor_model: null, effort: 'high', tools: REVIEW_TOOLS, fleet: SEAT_ALLOWED_FLEET.reviewer,
  });
  if (preset === 'native') {
    return Object.freeze({
      orchestrator,
      advisor: Object.freeze({ runtime: 'agy', model: 'gemini-4-neon-high', advisor_model: null, effort: null, tools: AGY_SEAT_TOOLS, fleet: EMPTY_FLEET }),
      council: null,
      worker: Object.freeze({ runtime: 'codex', model: 'gpt-6.1-terra', advisor_model: null, effort: 'high', tools: WORKER_TOOLS, fleet: SEAT_ALLOWED_FLEET.worker }),
      'worker-deep': Object.freeze({ runtime: 'codex', model: 'gpt-6.2-sol', advisor_model: null, effort: 'high', tools: WORKER_TOOLS, fleet: SEAT_ALLOWED_FLEET['worker-deep'] }),
      'worker-opus': workerOpus,
      'worker-neon': Object.freeze({ runtime: 'agy', model: 'gemini-4-neon-high', advisor_model: null, effort: null, tools: AGY_SEAT_TOOLS, fleet: EMPTY_FLEET }),
      'worker-light': Object.freeze({ runtime: 'agy', model: AGY_HYDROGEN_MODEL, advisor_model: null, effort: null, tools: AGY_SEAT_TOOLS, fleet: EMPTY_FLEET }),
      gatekeeper: Object.freeze({ runtime: 'codex', model: 'gpt-6.2-sol', advisor_model: null, effort: 'high', tools: REVIEW_TOOLS, fleet: SEAT_ALLOWED_FLEET.gatekeeper }),
      'gatekeeper-fallback': null,
      reviewer,
      routing: DEFAULT_ROUTING,
    });
  }
  return Object.freeze({
    orchestrator,
    advisor: Object.freeze({ runtime: 'pi', model: PI_NEON_MODEL, advisor_model: null, effort: 'xhigh', tools: ADVISOR_TOOLS, fleet: SEAT_ALLOWED_FLEET.advisor }),
    council: null,
    worker: Object.freeze({ runtime: 'pi', model: `${PI_CODEX_MODEL_PREFIX}gpt-6.1-terra`, advisor_model: null, effort: 'high', tools: WORKER_TOOLS, fleet: SEAT_ALLOWED_FLEET.worker }),
    'worker-deep': Object.freeze({ runtime: 'pi', model: `${PI_CODEX_MODEL_PREFIX}gpt-6.2-sol`, advisor_model: null, effort: 'high', tools: WORKER_TOOLS, fleet: SEAT_ALLOWED_FLEET['worker-deep'] }),
    'worker-opus': workerOpus,
    'worker-neon': Object.freeze({ runtime: 'pi', model: PI_NEON_MODEL, advisor_model: null, effort: 'high', tools: WORKER_TOOLS, fleet: SEAT_ALLOWED_FLEET['worker-neon'] }),
    'worker-light': Object.freeze({ runtime: 'pi', model: WORKER_LIGHT_MODEL, advisor_model: null, effort: null, tools: WORKER_TOOLS, fleet: SEAT_ALLOWED_FLEET['worker-light'] }),
    gatekeeper: Object.freeze({ runtime: 'pi', model: `${PI_CODEX_MODEL_PREFIX}gpt-6.2-sol`, advisor_model: null, effort: 'high', tools: REVIEW_TOOLS, fleet: SEAT_ALLOWED_FLEET.gatekeeper }),
    'gatekeeper-fallback': Object.freeze({ runtime: 'pi', model: WORKER_LIGHT_MODEL, advisor_model: null, effort: null, tools: REVIEW_TOOLS, fleet: SEAT_ALLOWED_FLEET['gatekeeper-fallback'] }),
    reviewer,
    routing: DEFAULT_ROUTING,
  });
}

/**
 * The section an absent `seats` key reads as: the Magpie-First 11-seat preset (ADR-0006 §2).
 * `rh seats argv` launches from the same value. The defaults and Settings ranges share `SEAT_ALLOWED_FLEET`.
 */
export const DEFAULT_SEATS_CONFIG: SeatsConfigV1 = defaultSeatsConfig('magpie');
export const NATIVE_SEATS_PRESET: SeatsConfigV1 = defaultSeatsConfig('native');

export const SEATS_CONFIG_UPDATE_ACTION = 'rh update';

/** The routing keys that came after the first stored sections (#2630, #2633, #2769, #3366): `rh update` adds each with its default. */
export const INTRODUCED_ROUTING_DEFAULTS = Object.freeze({
  codex_credit_mode: DEFAULT_SEATS_CONFIG.routing.codex_credit_mode,
  codex_credit_floor: DEFAULT_SEATS_CONFIG.routing.codex_credit_floor,
  claude_hyper_at_or_above_remaining: DEFAULT_SEATS_CONFIG.routing.claude_hyper_at_or_above_remaining,
  agy_saving_below_remaining: DEFAULT_SEATS_CONFIG.routing.agy_saving_below_remaining,
  exhausted_at_or_above_used: DEFAULT_SEATS_CONFIG.routing.exhausted_at_or_above_used,
  unavailable_pi_providers: DEFAULT_SEATS_CONFIG.routing.unavailable_pi_providers,
}) satisfies Partial<SeatRoutingV1>;

export class SeatsConfigMigrationRequiredError extends Error {
  readonly code = 'seats_config_migration_required';
  readonly next_action = SEATS_CONFIG_UPDATE_ACTION;
  constructor() {
    super(`The stored seats section needs a one-shot migration. Run ${SEATS_CONFIG_UPDATE_ACTION}.`);
  }
}

/** One pane runtime as the seat form may offer it. */
export interface SeatRuntimeRangeV1 {
  readonly id: SeatRuntime;
  /** In `agents.enabled`. A seat can be saved only on an enabled runtime. */
  readonly enabled: boolean;
  readonly effort: boolean;
  readonly fleet: boolean;
}

export interface SeatRoleV1 {
  readonly name: string;
  readonly writable: boolean;
}

/** One recommended model of a seat: the runtime that runs it and its model id. */
export interface SeatModelEntryV1 {
  readonly runtime: SeatRuntime;
  readonly model: string;
}

/** What one seat may select: the fleet roles and the tool groups. `models` only recommends (#3252); the model id is the user's. */
export interface SeatRangeV1 {
  readonly models: readonly SeatModelEntryV1[];
  readonly fleet: readonly string[];
  readonly tools: readonly SeatTool[];
}

export interface SeatsRangesV1 {
  readonly runtimes: readonly SeatRuntimeRangeV1[];
  readonly efforts: readonly string[];
  readonly roles: readonly SeatRoleV1[];
  readonly seats: { readonly [seat in SeatId]: SeatRangeV1 };
  readonly routing: {
    readonly classes: readonly RoutingClass[];
    readonly worker_seats: readonly WorkerSeatId[];
    readonly frontend_seats: readonly typeof FRONTEND_SEAT_IDS[number][];
  };
}

/** GET /api/v1/settings/seats. An absent section reads as the defaults. `revision` is the revision of the whole file. */
export interface SeatsSettingsV1 {
  readonly protocol: 1;
  readonly kind: 'operator_seats_settings';
  readonly config: SeatsConfigV1 & { readonly revision: string };
  /** The section an absent `seats` key reads as; the form shows it as the recommendation. */
  readonly defaults: SeatsConfigV1;
  readonly ranges: SeatsRangesV1;
  readonly model_pool?: SeatPoolCacheV1;
}

/** POST /api/v1/settings/seats without `request_id`. `seats` replaces the whole section. */
export interface SeatsSettingsRequestV1 {
  readonly expected_revision: string;
  readonly seats: SeatsConfigV1;
}

/** POST success. `changed_keys` names the seat fields whose value changed, such as `seats.worker.fleet`. */
export interface SeatsSettingsResultV1 {
  readonly config_revision: string;
  readonly changed_keys: readonly string[];
}

/** A decoder refusal. `field` names the seat field, never its value, so a report cannot carry a secret (#3244). */
class SeatsDecodeError extends Error {
  constructor(code: string, readonly field: string | null) {
    super(field === null ? code : `${code}: ${field}`);
  }
}

type AgySeatErrorCode = 'seat_runtime_not_allowed' | 'seat_model_invalid' | 'seat_effort_invalid' | 'seat_tool_not_allowed' | 'seat_fleet_not_allowed';

export class AgySeatSettingsError extends SeatsDecodeError {
  constructor(readonly code: AgySeatErrorCode, id: SeatId, field: string) {
    super(code, `seats.${id}.${field}`);
  }
}

/** Seats allowed to carry `runtime: 'agy'` in decoded config (ADR-0006 §2; non-advisor launch stays guarded until #3377). */
const AGY_ALLOWED_SEAT_IDS: ReadonlySet<SeatId> = new Set(['advisor', 'worker-neon', 'worker-light', 'gatekeeper-fallback']);

function checkAgySeat(id: SeatId, seat: SeatConfigV1): void {
  if (!AGY_ALLOWED_SEAT_IDS.has(id)) throw new AgySeatSettingsError('seat_runtime_not_allowed', id, 'runtime');
  if (!seatModelShapeValid('agy', seat.model)) throw new AgySeatSettingsError('seat_model_invalid', id, 'model');
  if ((id === 'worker-light' || id === 'gatekeeper-fallback') && seat.model !== AGY_HYDROGEN_MODEL) {
    throw new AgySeatSettingsError('seat_model_invalid', id, 'model');
  }
  if (id === 'worker-neon' && !seat.model.startsWith(AGY_NEON_MODEL)) {
    throw new AgySeatSettingsError('seat_model_invalid', id, 'model');
  }
  if (seat.effort !== null) throw new AgySeatSettingsError('seat_effort_invalid', id, 'effort');
  if (seat.advisor_model !== null) throw new AgySeatSettingsError('seat_model_invalid', id, 'advisor_model');
  if (seat.fleet.length !== 0) throw new AgySeatSettingsError('seat_fleet_not_allowed', id, 'fleet');
  if (seat.tools.length !== AGY_SEAT_TOOLS.length || !AGY_SEAT_TOOLS.every(tool => seat.tools.includes(tool))) {
    throw new AgySeatSettingsError('seat_tool_not_allowed', id, 'tools');
  }
}

function invalid(code: string, field: string | null = null): never {
  throw new SeatsDecodeError(code, field);
}

/** The one message for an invalid stored seats section; it names the refused seat field when the decoder knows it. */
export function seatsConfigInvalidMessage(error: unknown): string {
  const field = error instanceof SeatsDecodeError ? error.field : null;
  return `The seats section of the repo-harness configuration is not valid${field === null ? '' : ` at ${field}`}.`;
}

function object(value: unknown, keys: readonly string[], code: string, required = keys): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(code);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.includes(key)) invalid(code);
  for (const key of required) if (!(key in record)) invalid(code);
  return record;
}

function text(value: unknown, code: string): string {
  return typeof value === 'string' ? value : invalid(code);
}

function nullableToken(value: unknown, code: string): string | null {
  return value === null ? null : (typeof value === 'string' && TOKEN.test(value) ? value : invalid(code));
}

/** A strictly ascending list, so the config bytes, and so the revision, stay stable. */
function ascending<T extends string>(value: unknown, accept: (item: unknown) => item is T, code: string): readonly T[] {
  if (!Array.isArray(value)) invalid(code);
  const items = value.map(item => (accept(item) ? item : invalid(code)));
  if (items.some((item, index) => index > 0 && items[index - 1]! >= item)) invalid(code);
  return items;
}

const isTool = (value: unknown): value is SeatTool => SEAT_TOOLS.includes(value as SeatTool);
const isRole = (value: unknown): value is string => typeof value === 'string' && ROLE.test(value);
const PI_PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})*$/u;
const isPiProvider = (value: unknown): value is string => typeof value === 'string' && PI_PROVIDER.test(value);

/**
 * Why a Pi seat may start a provider that the owner lists as unavailable, or null (#2769). A listed prefix matches the
 * seat model at a `/` boundary. While the list is non-empty, a Pi seat without a model is unavailable too: Pi then picks
 * its own host default provider, and routing does not read Pi settings as a second authority for that provider.
 */
export function unavailablePiSeat(seat: { readonly runtime: SeatRuntime; readonly model: string | null }, routing: SeatRoutingV1): string | null {
  if (seat.runtime !== 'pi' || routing.unavailable_pi_providers.length === 0) return null;
  const model = seat.model;
  if (model === null) return 'pi default provider unknown: give the seat an explicit model or empty seats.routing.unavailable_pi_providers';
  const provider = routing.unavailable_pi_providers.find(prefix => model.startsWith(`${prefix}/`));
  return provider === undefined ? null : `pi provider ${provider} unavailable`;
}

/**
 * The one model rule of a seat (#3250): the id has the shape that its launcher can pass. A Pi id is `<provider>/<model>`;
 * any other id is a lowercase token. The recommended lists in the ranges do not limit it; a wrong id fails at launch.
 */
export function seatModelShapeValid(runtime: SeatRuntime, model: unknown): model is string {
  return typeof model === 'string' && (runtime === 'pi' ? /^[^/]+\/.+$/u.test(model) : TOKEN.test(model));
}

function decodeSeat(id: SeatId, value: unknown, code: string, fromSettingsRequest: boolean): SeatConfigV1 {
  const at = (name: string | null): never => invalid(code, name === null ? `seats.${id}` : `seats.${id}.${name}`);
  // A helper refusal carries no field, so each call names the field it decodes.
  const field = <T>(name: string | null, decode: () => T): T => { try { return decode(); } catch { return at(name); } };
  const record = field(null, () => object(value, ['runtime', 'model', 'advisor_model', 'effort', 'tools', 'fleet'], code, ['runtime', 'model', 'effort', 'tools', 'fleet']));
  if (!SEAT_RUNTIMES.includes(record.runtime as SeatRuntime)) at('runtime');
  if (record.runtime === 'agy' && !AGY_ALLOWED_SEAT_IDS.has(id)) throw new AgySeatSettingsError('seat_runtime_not_allowed', id, 'runtime');
  const advisor = record.advisor_model === undefined ? null : field('advisor_model', () => nullableToken(record.advisor_model, code));
  if (advisor !== null && record.runtime !== 'agy' && (record.runtime !== 'claude' || !Object.hasOwn(MODEL_FAMILY_LABELS, advisor))) at('advisor_model');
  const tools = field('tools', () => ascending(record.tools, isTool, code));
  if (record.runtime !== 'agy' && !tools.includes('read')) at('tools');
  const fleet = field('fleet', () => ascending(record.fleet, isRole, code));
  if (isReviewSeat(id) && tools.some(tool => !REVIEW_TOOLS.includes(tool))) at('tools');
  if (isCouncilSeat(id) && tools.some(tool => !COUNCIL_TOOLS.includes(tool))) at('tools');
  const model = record.model === null ? null
    : seatModelShapeValid(record.runtime as SeatRuntime, record.model) ? record.model
      : record.runtime === 'agy' ? null : at('model');
  // Let the Settings save return its typed fleet refusal when the request contains a retired or disallowed role.
  const disallowedFleetRequest = fromSettingsRequest && fleet.some(role => isDisallowedFleetRole(id, role));
  if (fleet.length > 0 && !disallowedFleetRequest && isReviewSeat(id)) at('fleet');
  if (record.runtime !== 'agy' && !fromSettingsRequest && fleet.some(role => !SEAT_ALLOWED_FLEET[id].includes(role as SeatScaffoldSubAgent))) at('fleet');
  const seat: SeatConfigV1 = {
    runtime: record.runtime as SeatRuntime,
    model,
    advisor_model: advisor,
    effort: field('effort', () => nullableToken(record.effort, code)),
    tools,
    fleet,
  };
  if (seat.runtime === 'agy') checkAgySeat(id, seat);
  if (!fromSettingsRequest && !isCouncilSeat(id) && isCouncilOnlyModel(seat)) at('model');
  return seat;
}

const REQUIRED_SECTION_KEYS = [...SEAT_IDS, 'routing'];
const SECTION_KEYS = [...REQUIRED_SECTION_KEYS, 'pi_sub_agent_models'];

const LEGACY_SEAT_RENAMES = Object.freeze([
  ['planner', 'council'],
  ['worker-important', 'worker-opus'],
  ['worker-important-fast', 'worker-neon'],
] as const);
const LEGACY_DROPPED_SEAT_KEYS = Object.freeze(['gatekeeper-deep'] as const);
const LEGACY_SEAT_KEYS = [...LEGACY_SEAT_RENAMES.map(([oldKey]) => oldKey), ...LEGACY_DROPPED_SEAT_KEYS];
const LEGACY_ROUTING_SEAT_MAP: Readonly<Record<string, WorkerSeatId>> = Object.freeze({
  'worker-important': 'worker-opus',
  'worker-important-fast': 'worker-neon',
});

function decodePiSubAgentModels(value: unknown, code: string): PiSubAgentModels {
  const record = object(value, SEAT_SCAFFOLD_SUB_AGENTS, code, []);
  const models: Partial<Record<SeatScaffoldSubAgent, string>> = {};
  for (const role of SEAT_SCAFFOLD_SUB_AGENTS) {
    if (!Object.hasOwn(record, role)) continue;
    const model = record[role];
    if (!seatModelShapeValid('pi', model)) invalid(code, `seats.pi_sub_agent_models.${role}`);
    models[role] = model;
  }
  return models;
}

function decodeModel(value: unknown, code: string): SeatModelV1 {
  const record = object(value, ['model', 'effort'], code);
  return { model: nullableToken(record.model, code), effort: nullableToken(record.effort, code) };
}

function decodeRouting(value: unknown, code: string): SeatRoutingV1 {
  const record = object(value, ROUTING_KEYS, code);
  const percent = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : invalid(code);
  // The exhaustion line has its own range (#2909); see EXHAUSTED_AT_OR_ABOVE_USED_RANGE.
  const exhaustedAtOrAboveUsed = typeof record.exhausted_at_or_above_used === 'number' && Number.isFinite(record.exhausted_at_or_above_used)
    && record.exhausted_at_or_above_used >= EXHAUSTED_AT_OR_ABOVE_USED_RANGE.min
    && record.exhausted_at_or_above_used <= EXHAUSTED_AT_OR_ABOVE_USED_RANGE.max ? record.exhausted_at_or_above_used : invalid(code);
  const routes = Object.fromEntries(ROUTING_CLASSES.map(task => {
    const seats = record[task];
    const allowed = task === 'frontend' ? FRONTEND_SEAT_IDS : WORKER_SEAT_IDS;
    if (!Array.isArray(seats) || seats.length === 0 || new Set(seats).size !== seats.length
      || seats.some(seat => !(allowed as readonly unknown[]).includes(seat))) invalid(code);
    return [task, seats as readonly WorkerSeatId[]];
  })) as Pick<SeatRoutingV1, RoutingClass>;
  return { ...routes, claude_saving_below_remaining: percent(record.claude_saving_below_remaining),
    claude_hyper_at_or_above_remaining: percent(record.claude_hyper_at_or_above_remaining),
    agy_saving_below_remaining: percent(record.agy_saving_below_remaining),
    exhausted_at_or_above_used: exhaustedAtOrAboveUsed,
    codex_credit_mode: CODEX_CREDIT_MODES.includes(record.codex_credit_mode as CodexCreditMode) ? record.codex_credit_mode as CodexCreditMode : invalid(code),
    codex_credit_floor: typeof record.codex_credit_floor === 'number' && Number.isFinite(record.codex_credit_floor) && record.codex_credit_floor >= 0
      ? record.codex_credit_floor : invalid(code),
    low_quota_explorer: decodeModel(record.low_quota_explorer, code),
    unavailable_pi_providers: ascending(record.unavailable_pi_providers, isPiProvider, code) };
}

function decodeSeatsRecord(record: Record<string, unknown>, code: string, fromSettingsRequest = false): SeatsConfigV1 {
  const seats = Object.fromEntries(SEAT_IDS.filter(id => id in record)
    .map(id => [id, isOptionalSeat(id) && record[id] === null ? null : decodeSeat(id, record[id], code, fromSettingsRequest)])) as Partial<Pick<SeatsConfigV1, SeatId>>;
  const routing = 'routing' in record ? decodeRouting(record.routing, code) : undefined;
  if (routing !== undefined) {
    if (!fromSettingsRequest && routing.low_quota_explorer.model === null) invalid(code);
    if (ROUTING_CLASSES.some(task => routing[task].some(id => seats[id] === null))) invalid(code);
    if (routing.frontend.some(id => seats[id] !== undefined && !isClaudeOrNeonSeat(seats[id]!))) invalid(code);
  }
  if (REQUIRED_SECTION_KEYS.some(key => !(key in record))) throw new SeatsConfigMigrationRequiredError();
  const piModels = 'pi_sub_agent_models' in record ? decodePiSubAgentModels(record.pi_sub_agent_models, code) : undefined;
  return {
    ...(seats as Pick<SeatsConfigV1, SeatId>), routing: routing!,
    ...(piModels === undefined || Object.keys(piModels).length === 0 ? {} : { pi_sub_agent_models: piModels }),
  };
}

function decodeSeats(value: unknown, code: string): SeatsConfigV1 {
  return decodeSeatsRecord(object(value, SECTION_KEYS, code, REQUIRED_SECTION_KEYS), code);
}

/** Prepare the candidate for the update migration. The caller must decode it before use or write. */
export function stripRetiredSeatFleetRoles(record: Record<string, unknown>): Record<string, unknown> {
  let changed: Record<string, unknown> | undefined;
  for (const id of SEAT_IDS) {
    const value = record[id];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const seat = value as Record<string, unknown>;
    if (!Array.isArray(seat.fleet)) continue;
    const fleet = seat.fleet.filter(role => !isDisallowedFleetRole(id, role));
    if (fleet.length !== seat.fleet.length) (changed ??= { ...record })[id] = { ...seat, fleet };
  }
  return changed ?? record;
}

/**
 * One-shot 12-to-11 seat migration transform shared by `decodeSeatsConfig` (validation) and `migrateSeatsConfiguration` (apply).
 * Renames `planner` → `council`, `worker-important` → `worker-opus`, `worker-important-fast` → `worker-neon`,
 * drops `gatekeeper-deep`, remaps routing class seat names, strips disallowed fleet roles, and replaces the
 * retired default `claude/fable` advisor when `replacementAdvisor` is provided.
 */
export function normalizeLegacySeatsRecord(
  stored: Record<string, unknown>,
  replacementAdvisor?: SeatConfigV1,
): { readonly record: Record<string, unknown>; readonly migrated: boolean } {
  let migrated = false;
  const next: Record<string, unknown> = { ...stored };
  for (const [oldKey, newKey] of LEGACY_SEAT_RENAMES) {
    if (oldKey in next) {
      if (newKey in next) invalid('seats_config_invalid', `seats.${oldKey}`);
      next[newKey] = next[oldKey];
      delete next[oldKey];
      migrated = true;
    }
  }
  for (const dropped of LEGACY_DROPPED_SEAT_KEYS) {
    if (dropped in next) {
      delete next[dropped];
      migrated = true;
    }
  }
  if (replacementAdvisor !== undefined && isLegacyDefaultAdvisor(next.advisor)) {
    next.advisor = replacementAdvisor;
    migrated = true;
  }
  if (typeof next.routing === 'object' && next.routing !== null && !Array.isArray(next.routing)) {
    const routing = next.routing as Record<string, unknown>;
    let routingChanged = false;
    const nextRouting: Record<string, unknown> = { ...routing };
    for (const task of ROUTING_CLASSES) {
      const list = routing[task];
      if (!Array.isArray(list)) continue;
      let listChanged = false;
      const mapped = list.map(entry => {
        if (typeof entry === 'string' && Object.hasOwn(LEGACY_ROUTING_SEAT_MAP, entry)) {
          listChanged = true;
          return LEGACY_ROUTING_SEAT_MAP[entry]!;
        }
        return entry;
      });
      if (listChanged) {
        nextRouting[task] = mapped;
        routingChanged = true;
      }
    }
    if (routingChanged) {
      next.routing = nextRouting;
      migrated = true;
    }
  }
  const stripped = stripRetiredSeatFleetRoles(next);
  if (stripped !== next) migrated = true;
  return { record: stripped, migrated };
}

/** The shape of the stored `seats` section. An absent section (`undefined`) reads as the defaults. */
export function decodeSeatsConfig(value: unknown): SeatsConfigV1 {
  if (value === undefined) return DEFAULT_SEATS_CONFIG;
  const code = 'seats_config_invalid';
  const stored = object(value, [...SECTION_KEYS, ...LEGACY_SEAT_KEYS], code, ['orchestrator', 'advisor', 'worker']);
  const { record, migrated } = normalizeLegacySeatsRecord(stored, DEFAULT_SEATS_CONFIG.advisor);
  const routing = record.routing;
  if (typeof routing === 'object' && routing !== null && !Array.isArray(routing)) {
    if ('mode' in routing || 'hyper' in routing) throw new SeatsConfigMigrationRequiredError();
    if ('codex_hyper_at_or_above_remaining' in routing) {
      const { codex_hyper_at_or_above_remaining: retired, ...kept } = routing;
      if (typeof retired !== 'number' || !Number.isFinite(retired) || retired < 0 || retired > 100) invalid(code);
      decodeSeatsRecord({ ...record, routing: { ...INTRODUCED_ROUTING_DEFAULTS, ...kept } }, code);
      throw new SeatsConfigMigrationRequiredError();
    }
    // A section without an introduced routing key needs the update only when the values it has are valid.
    if (Object.keys(INTRODUCED_ROUTING_DEFAULTS).some(key => !(key in routing))) {
      decodeSeatsRecord({ ...record, routing: { ...INTRODUCED_ROUTING_DEFAULTS, ...routing } }, code);
      throw new SeatsConfigMigrationRequiredError();
    }
  }
  const seats = decodeSeatsRecord(record, code);
  if (migrated) throw new SeatsConfigMigrationRequiredError();
  return seats;
}

function decodeRoutingRanges(value: unknown, code: string): SeatsRangesV1['routing'] {
  const record = object(value, ['classes', 'worker_seats', 'frontend_seats'], code);
  const ranges = { classes: ROUTING_CLASSES, worker_seats: WORKER_SEAT_IDS, frontend_seats: FRONTEND_SEAT_IDS };
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    if (JSON.stringify(record[key]) !== JSON.stringify(ranges[key])) invalid(code);
  }
  return ranges;
}

function decodeRanges(value: unknown, code: string): SeatsRangesV1 {
  const record = object(value, ['runtimes', 'efforts', 'roles', 'seats', 'routing'], code);
  if (!Array.isArray(record.runtimes) || !Array.isArray(record.efforts) || !Array.isArray(record.roles)) invalid(code);
  const runtimes = record.runtimes.map((entry) => {
    const runtime = object(entry, ['id', 'enabled', 'effort', 'fleet'], code);
    if (!SEAT_RUNTIMES.includes(runtime.id as SeatRuntime)) invalid(code);
    if (typeof runtime.enabled !== 'boolean' || typeof runtime.effort !== 'boolean' || typeof runtime.fleet !== 'boolean') invalid(code);
    return { id: runtime.id as SeatRuntime, enabled: runtime.enabled, effort: runtime.effort, fleet: runtime.fleet };
  });
  if (runtimes.map(runtime => runtime.id).join() !== SEAT_RUNTIMES.join()) invalid(code);
  const roles = record.roles.map((entry) => {
    const role = object(entry, ['name', 'writable'], code);
    if (!isRole(role.name) || typeof role.writable !== 'boolean') invalid(code);
    return { name: role.name, writable: role.writable };
  });
  const seats = object(record.seats, SEAT_IDS, code);
  const seat = (id: SeatId): SeatRangeV1 => {
    const range = object(seats[id], ['models', 'fleet', 'tools'], code);
    if (!Array.isArray(range.models) || !Array.isArray(range.fleet) || !Array.isArray(range.tools)) invalid(code);
    const models = range.models.map((item) => {
      const entry = object(item, ['runtime', 'model'], code);
      return SEAT_RUNTIMES.includes(entry.runtime as SeatRuntime) ? { runtime: entry.runtime as SeatRuntime, model: text(entry.model, code) } : invalid(code);
    });
    return { models, fleet: range.fleet.map(name => (isRole(name) ? name : invalid(code))), tools: range.tools.map(tool => (isTool(tool) ? tool : invalid(code))) };
  };
  return {
    runtimes,
    efforts: record.efforts.map(effort => text(effort, code)),
    roles,
    seats: Object.fromEntries(SEAT_IDS.map(id => [id, seat(id)])) as SeatsRangesV1['seats'],
    routing: decodeRoutingRanges(record.routing, code),
  };
}

export function decodeSeatsSettings(value: unknown): SeatsSettingsV1 {
  const code = 'seats_settings_invalid';
  const record = object(value, ['protocol', 'kind', 'config', 'defaults', 'ranges'], code);
  if (record.protocol !== 1 || record.kind !== 'operator_seats_settings') invalid(code);
  const config = object(record.config, ['revision', ...SECTION_KEYS], code, ['revision', ...REQUIRED_SECTION_KEYS]);
  const revision = text(config.revision, code);
  if (!REVISION.test(revision)) invalid(code);
  const { revision: _revision, ...section } = config;
  return {
    protocol: 1, kind: 'operator_seats_settings', config: { revision, ...decodeSeats(section, code) },
    defaults: decodeSeats(record.defaults, code), ranges: decodeRanges(record.ranges, code),
  };
}

/** The closed POST body without `request_id`. */
export function decodeSeatsSettingsRequest(fields: Readonly<Record<string, unknown>>): SeatsSettingsRequestV1 {
  const code = 'seats_settings_request_invalid';
  const record = object(fields, ['expected_revision', 'seats'], code);
  const expected = text(record.expected_revision, code);
  if (!REVISION.test(expected)) invalid(code);
  // The save checks fleet access and the explorer model so it can return structured 422 errors.
  return { expected_revision: expected, seats: decodeSeatsRecord(object(record.seats, SECTION_KEYS, code, REQUIRED_SECTION_KEYS), code, true) };
}

export function decodeSeatsSettingsResult(value: unknown): SeatsSettingsResultV1 {
  const code = 'seats_settings_result_invalid';
  const record = object(value, ['config_revision', 'changed_keys'], code);
  const revision = text(record.config_revision, code);
  if (!REVISION.test(revision) || !Array.isArray(record.changed_keys)) invalid(code);
  return { config_revision: revision, changed_keys: record.changed_keys.map(key => text(key, code)) };
}
