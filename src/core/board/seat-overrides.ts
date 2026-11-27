// Owner-authorized seat route overrides (#3641): stored in `~/.repo-harness/config.json#seat_overrides`
// beside `seats`. Base catalog routes stay in `seats`; active overrides overlay runtime, model and effort
// in the single seat resolver without widening tool or fleet authority.
import { isRecord } from '../evidence/is-record';
import {
  AGY_ADVISOR_ALLOWED_SEAT_TOOLS,
  AGY_READONLY_SEAT_TOOLS,
  AGY_WORKER_SEAT_TOOLS,
  AgySeatSettingsError,
  SEAT_IDS,
  SEAT_RUNTIMES,
  agyEffortValid,
  agySeatTools,
  decodeSeatsConfig,
  isAgyAllowedSeat,
  isAgyToolsValid,
  isRetiredSeatModel,
  isWorkerSeat,
  seatModelShapeValid,
  seatsConfigInvalidMessage,
  type SeatConfigV1,
  type SeatId,
  type SeatRuntime,
  type SeatTool,
  type SeatsConfigV1,
} from './seats-settings';

export const SEAT_OVERRIDES_PROTOCOL = 1 as const;
export const SEAT_OVERRIDES_KIND = 'operator_seat_overrides' as const;
export const SEAT_OVERRIDE_INSTRUCTION_MAX_LENGTH = 280;

const TOKEN = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const REVISION = /^(?:absent|sha256:[0-9a-f]{64})$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export interface SeatRouteOverrideV1 {
  readonly runtime: SeatRuntime;
  readonly model: string | null;
  readonly effort: string | null;
  readonly authorized_at: string;
  readonly instruction: string;
}

export type SeatOverridesV1 = Readonly<Partial<Record<SeatId, SeatRouteOverrideV1>>>;

export interface SeatOverridesResponseV1 {
  readonly protocol: typeof SEAT_OVERRIDES_PROTOCOL;
  readonly kind: typeof SEAT_OVERRIDES_KIND;
  readonly config_revision: string;
  readonly overrides: SeatOverridesV1;
}

export interface SeatOverrideSetRequestV1 {
  readonly expected_revision: string;
  readonly seat: SeatId;
  readonly runtime: SeatRuntime;
  readonly model: string | null;
  readonly effort: string | null;
  readonly instruction: string;
  readonly owner_approved: true;
}

export interface SeatOverrideRevokeRequestV1 {
  readonly expected_revision: string;
  readonly seat: SeatId;
  readonly owner_approved: true;
}

export interface SeatOverrideResultV1 {
  readonly config_revision: string;
  readonly seat: SeatId;
  readonly active: boolean;
  readonly authorized_at: string | null;
  readonly changed_keys: readonly string[];
}

export type SeatOverrideValidationCode =
  | 'owner_approval_required'
  | 'seat_override_instruction_invalid'
  | 'seat_runtime_not_allowed'
  | 'seat_model_invalid'
  | 'seat_model_retired'
  | 'seat_effort_invalid';

/** Structured validation failure for override write requests. Never includes submitted free-text values. */
export class SeatOverrideValidationError extends Error {
  constructor(
    readonly code: SeatOverrideValidationCode,
    readonly field: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'SeatOverrideValidationError';
  }
}

/** Closed decoder refusal for stored or wire `seat_overrides` documents. */
export class SeatOverridesDecodeError extends Error {
  constructor(readonly code: string, readonly field: string | null = null) {
    super(field === null ? code : `${code}: ${field}`);
    this.name = 'SeatOverridesDecodeError';
  }
}

export function seatOverridesInvalidMessage(error: unknown): string {
  const field = error instanceof SeatOverridesDecodeError ? error.field : null;
  return `The seat_overrides section of the repo-harness configuration is not valid${field === null ? '' : ` at ${field}`}.`;
}

export function effectiveSeatsInvalidMessage(error: unknown): string {
  return error instanceof SeatOverridesDecodeError ? seatOverridesInvalidMessage(error) : seatsConfigInvalidMessage(error);
}

function invalid(code: string, field: string | null = null): never {
  throw new SeatOverridesDecodeError(code, field);
}

function exactObject(value: unknown, keys: readonly string[], code: string, field: string | null = null): Record<string, unknown> {
  if (!isRecord(value)) invalid(code, field);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(code, field);
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid(code, field);
  return value;
}

function isSeatId(value: unknown): value is SeatId {
  return typeof value === 'string' && (SEAT_IDS as readonly string[]).includes(value);
}

function isSeatRuntime(value: unknown): value is SeatRuntime {
  return typeof value === 'string' && (SEAT_RUNTIMES as readonly string[]).includes(value);
}

function isValidIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  const iso = parsed.toISOString();
  return iso === value || iso.replace(/\.000Z$/u, 'Z') === value || iso.replace(/0+Z$/u, 'Z') === value;
}

export function normalizeOverrideInstruction(value: unknown): string | null {
  if (typeof value !== 'string' || CONTROL_CHARS.test(value)) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > SEAT_OVERRIDE_INSTRUCTION_MAX_LENGTH) return null;
  return trimmed;
}

const OVERRIDE_KEYS = ['runtime', 'model', 'effort', 'authorized_at', 'instruction'] as const;

function decodeOverrideModel(id: SeatId, runtime: SeatRuntime, raw: unknown, code: string, prefix: string): string | null {
  if (runtime === 'agy') {
    if (!seatModelShapeValid('agy', raw)) throw new AgySeatSettingsError('seat_model_invalid', id, 'model');
    return raw;
  }
  if (raw === null) return null;
  if (seatModelShapeValid(runtime, raw)) return raw;
  invalid(code, `${prefix}.model`);
}

function decodeOverrideEffort(id: SeatId, runtime: SeatRuntime, model: string | null, raw: unknown, code: string, prefix: string): string | null {
  let effort: string | null;
  if (raw === null) {
    effort = null;
  } else if (typeof raw === 'string' && TOKEN.test(raw)) {
    effort = raw;
  } else {
    invalid(code, `${prefix}.effort`);
  }
  if (runtime === 'agy' && (model === null || !agyEffortValid(model, effort))) {
    throw new AgySeatSettingsError('seat_effort_invalid', id, 'effort');
  }
  return effort;
}

function decodeSeatOverrideEntry(id: SeatId, value: unknown, code: string): SeatRouteOverrideV1 {
  const prefix = `seat_overrides.${id}`;
  const record = exactObject(value, OVERRIDE_KEYS, code, prefix);
  if (!isSeatRuntime(record.runtime)) invalid(code, `${prefix}.runtime`);
  const runtime = record.runtime;
  if (runtime === 'agy' && !isAgyAllowedSeat(id)) {
    throw new AgySeatSettingsError('seat_runtime_not_allowed', id, 'runtime');
  }
  const model = decodeOverrideModel(id, runtime, record.model, code, prefix);
  const effort = decodeOverrideEffort(id, runtime, model, record.effort, code, prefix);
  if (!isValidIsoUtc(record.authorized_at)) invalid(code, `${prefix}.authorized_at`);
  const normalizedInstruction = normalizeOverrideInstruction(record.instruction);
  if (normalizedInstruction === null || normalizedInstruction !== record.instruction) {
    invalid(code, `${prefix}.instruction`);
  }
  return Object.freeze({
    runtime,
    model,
    effort,
    authorized_at: record.authorized_at,
    instruction: normalizedInstruction,
  });
}

/** Decode stored or wire `seat_overrides`. Absent (`undefined`) reads as no active overrides. */
export function decodeSeatOverrides(value: unknown, code = 'seat_overrides_invalid'): SeatOverridesV1 {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) invalid(code);
  const overrides: Partial<Record<SeatId, SeatRouteOverrideV1>> = {};
  for (const key of Object.keys(value)) {
    if (!isSeatId(key)) invalid(code, `seat_overrides.${key}`);
    overrides[key] = decodeSeatOverrideEntry(key, value[key], code);
  }
  return Object.freeze(overrides);
}

export function decodeSeatOverridesResponse(value: unknown): SeatOverridesResponseV1 {
  const code = 'seat_overrides_response_invalid';
  const record = exactObject(value, ['protocol', 'kind', 'config_revision', 'overrides'], code);
  if (record.protocol !== SEAT_OVERRIDES_PROTOCOL || record.kind !== SEAT_OVERRIDES_KIND) invalid(code);
  if (typeof record.config_revision !== 'string' || !REVISION.test(record.config_revision)) invalid(code, 'config_revision');
  return Object.freeze({
    protocol: SEAT_OVERRIDES_PROTOCOL,
    kind: SEAT_OVERRIDES_KIND,
    config_revision: record.config_revision,
    overrides: decodeSeatOverrides(record.overrides, code),
  });
}

const SET_REQUEST_KEYS = ['expected_revision', 'seat', 'runtime', 'model', 'effort', 'instruction', 'owner_approved'] as const;
const REVOKE_REQUEST_KEYS = ['expected_revision', 'seat', 'owner_approved'] as const;

/** Closed decoder for `POST /api/v1/settings/seats/overrides` without `request_id`. */
export function decodeSeatOverrideSetRequest(fields: Readonly<Record<string, unknown>>): SeatOverrideSetRequestV1 {
  const code = 'seat_override_request_invalid';
  const record = exactObject(fields, SET_REQUEST_KEYS, code);
  if (typeof record.expected_revision !== 'string' || !REVISION.test(record.expected_revision)) invalid(code, 'expected_revision');
  if (!isSeatId(record.seat)) invalid(code, 'seat');
  if (!isSeatRuntime(record.runtime)) invalid(code, 'runtime');
  if (typeof record.owner_approved !== 'boolean') invalid(code, 'owner_approved');
  if (typeof record.instruction !== 'string') invalid(code, 'instruction');
  if (record.model !== null && typeof record.model !== 'string') invalid(code, 'model');
  if (record.effort !== null && typeof record.effort !== 'string') invalid(code, 'effort');

  const seat = record.seat;
  const runtime = record.runtime;
  if (!record.owner_approved) {
    throw new SeatOverrideValidationError(
      'owner_approval_required',
      'owner_approved',
      'Explicit owner approval is required to authorize a seat route override.',
    );
  }
  const instruction = normalizeOverrideInstruction(record.instruction);
  if (instruction === null) {
    throw new SeatOverrideValidationError(
      'seat_override_instruction_invalid',
      'instruction',
      `Provide a single-line owner instruction between 1 and ${SEAT_OVERRIDE_INSTRUCTION_MAX_LENGTH} characters.`,
    );
  }
  if (runtime === 'agy' && !isAgyAllowedSeat(seat)) {
    throw new SeatOverrideValidationError(
      'seat_runtime_not_allowed',
      `seat_overrides.${seat}.runtime`,
      `The ${seat} seat cannot use the agy runtime.`,
    );
  }
  if (runtime === 'agy' ? !seatModelShapeValid('agy', record.model) : (record.model !== null && !seatModelShapeValid(runtime, record.model))) {
    throw new SeatOverrideValidationError(
      'seat_model_invalid',
      `seat_overrides.${seat}.model`,
      `The model at seat_overrides.${seat}.model is not valid for ${runtime}.`,
    );
  }
  if (isRetiredSeatModel(record.model)) {
    throw new SeatOverrideValidationError(
      'seat_model_retired',
      `seat_overrides.${seat}.model`,
      `The model at seat_overrides.${seat}.model is retired. Choose another model.`,
    );
  }
  if (record.effort !== null && !TOKEN.test(record.effort)) {
    throw new SeatOverrideValidationError(
      'seat_effort_invalid',
      `seat_overrides.${seat}.effort`,
      `The effort at seat_overrides.${seat}.effort is not valid for ${runtime}.`,
    );
  }
  if (runtime === 'agy' && typeof record.model === 'string' && !agyEffortValid(record.model, record.effort)) {
    throw new SeatOverrideValidationError(
      'seat_effort_invalid',
      `seat_overrides.${seat}.effort`,
      `The effort at seat_overrides.${seat}.effort is not valid for agy.`,
    );
  }
  return Object.freeze({
    expected_revision: record.expected_revision,
    seat,
    runtime,
    model: record.model,
    effort: record.effort,
    instruction,
    owner_approved: true,
  });
}

/** Closed decoder for `POST /api/v1/settings/seats/overrides/revoke` without `request_id`. */
export function decodeSeatOverrideRevokeRequest(fields: Readonly<Record<string, unknown>>): SeatOverrideRevokeRequestV1 {
  const code = 'seat_override_request_invalid';
  const record = exactObject(fields, REVOKE_REQUEST_KEYS, code);
  if (typeof record.expected_revision !== 'string' || !REVISION.test(record.expected_revision)) invalid(code, 'expected_revision');
  if (!isSeatId(record.seat)) invalid(code, 'seat');
  if (typeof record.owner_approved !== 'boolean') invalid(code, 'owner_approved');
  if (!record.owner_approved) {
    throw new SeatOverrideValidationError(
      'owner_approval_required',
      'owner_approved',
      'Explicit owner approval is required to revoke a seat route override.',
    );
  }
  return Object.freeze({
    expected_revision: record.expected_revision,
    seat: record.seat,
    owner_approved: true,
  });
}

export function decodeSeatOverrideResult(value: unknown): SeatOverrideResultV1 {
  const code = 'seat_override_result_invalid';
  const record = exactObject(value, ['config_revision', 'seat', 'active', 'authorized_at', 'changed_keys'], code);
  if (typeof record.config_revision !== 'string' || !REVISION.test(record.config_revision)) invalid(code, 'config_revision');
  if (!isSeatId(record.seat)) invalid(code, 'seat');
  if (typeof record.active !== 'boolean') invalid(code, 'active');
  let authorizedAt: string | null;
  if (record.active) {
    if (!isValidIsoUtc(record.authorized_at)) invalid(code, 'authorized_at');
    authorizedAt = record.authorized_at;
  } else {
    if (record.authorized_at !== null) invalid(code, 'authorized_at');
    authorizedAt = null;
  }
  if (!Array.isArray(record.changed_keys) || !record.changed_keys.every(key => typeof key === 'string')) invalid(code, 'changed_keys');
  return Object.freeze({
    config_revision: record.config_revision,
    seat: record.seat,
    active: record.active,
    authorized_at: authorizedAt,
    changed_keys: Object.freeze([...record.changed_keys]),
  });
}

function withTools(tools: readonly SeatTool[], required: readonly SeatTool[]): readonly SeatTool[] {
  const merged = new Set<SeatTool>(tools);
  for (const tool of required) merged.add(tool);
  return Object.freeze([...merged].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
}

/**
 * Derive agy-valid tools for an overridden seat without silently granting `edit`, `gh`, `mcp`, or `schedule`
 * beyond what the base seat already holds.
 */
function agyOverrideTools(id: SeatId, baseTools: readonly SeatTool[]): readonly SeatTool[] {
  if (id === 'advisor') {
    const narrowed = baseTools.filter(tool => (AGY_ADVISOR_ALLOWED_SEAT_TOOLS as readonly SeatTool[]).includes(tool));
    return isAgyToolsValid(id, narrowed) ? narrowed : withTools(narrowed, AGY_READONLY_SEAT_TOOLS);
  }
  if (isWorkerSeat(id)) {
    const narrowed = baseTools.filter(tool => (AGY_WORKER_SEAT_TOOLS as readonly SeatTool[]).includes(tool));
    if (isAgyToolsValid(id, narrowed)) return narrowed;
    const required: readonly SeatTool[] = baseTools.includes('edit')
      ? ['edit', 'net', 'read', 'shell']
      : AGY_READONLY_SEAT_TOOLS;
    return withTools(narrowed, required);
  }
  return agySeatTools(id, baseTools);
}

/** Overlay one owner-authorized route override onto a configured base seat without widening tool or fleet grants. */
export function applySeatOverrideToConfig(id: SeatId, base: SeatConfigV1, override: SeatRouteOverrideV1): SeatConfigV1 {
  let tools: readonly SeatTool[];
  if (override.runtime === 'agy') tools = agyOverrideTools(id, base.tools);
  else if (override.runtime === 'codex') tools = withTools(base.tools, ['shell']);
  else tools = base.tools;
  return Object.freeze({
    runtime: override.runtime,
    model: override.model,
    advisor_model: override.runtime === 'claude' ? base.advisor_model : null,
    effort: override.effort,
    tools,
    fleet: override.runtime === 'agy' ? Object.freeze([]) : base.fleet,
  });
}

function resolveRequiredSeat(id: Exclude<SeatId, 'worker-neon-deep' | 'worker-light' | 'gatekeeper-fallback' | 'council'>, seats: SeatsConfigV1, overrides: SeatOverridesV1): SeatConfigV1 {
  const override = overrides[id];
  return override === undefined ? seats[id] : applySeatOverrideToConfig(id, seats[id], override);
}

function resolveOptionalSeat(id: 'worker-neon-deep' | 'worker-light' | 'gatekeeper-fallback' | 'council', seats: SeatsConfigV1, overrides: SeatOverridesV1): SeatConfigV1 | null {
  const base = seats[id];
  const override = overrides[id];
  if (override === undefined) return base;
  if (base === null) invalid('seat_overrides_invalid', `seat_overrides.${id}`);
  return applySeatOverrideToConfig(id, base, override);
}

/** Project effective seats by overlaying active owner overrides onto decoded base catalog seats. */
export function applySeatOverrides(seats: SeatsConfigV1, overrides: SeatOverridesV1): SeatsConfigV1 {
  if (SEAT_IDS.every(id => overrides[id] === undefined)) return seats;
  return Object.freeze({
    ...seats,
    orchestrator: resolveRequiredSeat('orchestrator', seats, overrides),
    advisor: resolveRequiredSeat('advisor', seats, overrides),
    council: resolveOptionalSeat('council', seats, overrides),
    worker: resolveRequiredSeat('worker', seats, overrides),
    'worker-deep': resolveRequiredSeat('worker-deep', seats, overrides),
    'worker-opus': resolveRequiredSeat('worker-opus', seats, overrides),
    'worker-neon': resolveRequiredSeat('worker-neon', seats, overrides),
    'worker-neon-deep': resolveOptionalSeat('worker-neon-deep', seats, overrides),
    'worker-light': resolveOptionalSeat('worker-light', seats, overrides),
    gatekeeper: resolveRequiredSeat('gatekeeper', seats, overrides),
    'gatekeeper-fallback': resolveOptionalSeat('gatekeeper-fallback', seats, overrides),
    reviewer: resolveRequiredSeat('reviewer', seats, overrides),
  });
}

export interface EffectiveSeatsDocumentV1 {
  /** Effective seats with active owner overrides applied. */
  readonly seats: SeatsConfigV1;
  /** Stored base catalog seats (before overrides). */
  readonly base_seats: SeatsConfigV1;
  /** Active owner-authorized route overrides. */
  readonly overrides: SeatOverridesV1;
}

/**
 * Single authoritative seat resolver (#3641): decodes `config.seats` with `decodeSeatsConfig`
 * and overlays valid `config.seat_overrides` without creating a second seat parser.
 */
export function decodeEffectiveSeats(config: Readonly<Record<string, unknown>>): EffectiveSeatsDocumentV1 {
  const base_seats = decodeSeatsConfig(config.seats);
  const overrides = decodeSeatOverrides(config.seat_overrides);
  const seats = applySeatOverrides(base_seats, overrides);
  return Object.freeze({ seats, base_seats, overrides });
}

export function seatOverrideIds(overrides: SeatOverridesV1): readonly SeatId[] {
  return SEAT_IDS.filter(id => overrides[id] !== undefined);
}
