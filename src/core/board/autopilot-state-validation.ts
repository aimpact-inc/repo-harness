import type { AutopilotActivatedBy, AutopilotErrorCode } from './autopilot';

export type AutopilotFail = (code: AutopilotErrorCode, message: string) => never;

export const AUTOPILOT_STATE_KEYS = [
  'protocol',
  'enabled',
  'activated_at',
  'activated_by',
  'cadence_minutes',
  'merge_policy',
  'low_tier_skip',
  'council_max_members_default',
  'target_parallel_workers',
  'target_parallel_ci',
  'stopped_at',
  'stop_reason',
  'last_advisor_tick_at',
] as const;

const ISO_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
export const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f-\u009f]/u;

export function assertValidDate(date: Date, label: string, fail: AutopilotFail): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    fail('autopilot_invalid_option', `${label} must be a valid Date`);
  }
  return date.toISOString();
}

function decodeNullableIsoInstant(value: unknown, field: string, fail: AutopilotFail): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ISO_UTC_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('autopilot_invalid_state', `autopilot state ${field} must be a UTC ISO-8601 timestamp or null`);
  }
  return value;
}

export function decodeBoundedInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: AutopilotErrorCode,
  fail: AutopilotFail,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(code, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function validateAutopilotStateRecord(
  value: unknown,
  expectedProtocol: number,
  fail: AutopilotFail,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('autopilot_invalid_state', 'autopilot state must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== expectedProtocol) {
    fail('autopilot_invalid_state', `unsupported autopilot protocol ${JSON.stringify(record.protocol)}`);
  }
  const actual = Object.keys(record).sort().join(',');
  const expected = [...AUTOPILOT_STATE_KEYS].sort().join(',');
  if (actual !== expected) {
    fail('autopilot_invalid_state', `autopilot state fields are [${actual}], expected [${expected}]`);
  }
  if (typeof record.enabled !== 'boolean') {
    fail('autopilot_invalid_state', 'autopilot state enabled must be a boolean');
  }
  return record;
}

function decodeAutopilotAuthority(
  input: {
    readonly enabled: boolean;
    readonly activated_by: unknown;
    readonly activated_at: string | null;
    readonly stopped_at: string | null;
    readonly stop_reason: string | null;
    readonly last_advisor_tick_at: string | null;
  },
  localAuthority: AutopilotActivatedBy,
  assertLocalAuthority: (source: unknown) => AutopilotActivatedBy,
  fail: AutopilotFail,
): AutopilotActivatedBy | null {
  let activated_by: AutopilotActivatedBy | null;
  if (input.activated_by === null) {
    if (input.enabled || input.activated_at !== null) {
      fail(
        'autopilot_non_local_activation_refused',
        `autopilot state with enabled=${String(input.enabled)} requires activated_by="${localAuthority}"`,
      );
    }
    activated_by = null;
  } else {
    activated_by = assertLocalAuthority(input.activated_by);
    if (input.activated_at === null) {
      fail('autopilot_invalid_state', 'autopilot state with activated_by set requires activated_at');
    }
  }
  if (input.enabled && (input.stopped_at !== null || input.stop_reason !== null)) {
    fail('autopilot_invalid_state', 'enabled autopilot state cannot carry stopped_at or stop_reason');
  }
  if (input.stopped_at === null && input.stop_reason !== null) {
    fail('autopilot_invalid_state', 'autopilot state stop_reason requires stopped_at');
  }
  if (input.activated_at === null && input.last_advisor_tick_at !== null) {
    fail('autopilot_invalid_state', 'autopilot state last_advisor_tick_at requires activated_at');
  }
  return activated_by;
}

export function decodeAutopilotStateFields(
  record: Record<string, unknown>,
  options: {
    readonly localAuthority: AutopilotActivatedBy;
    readonly assertLocalAuthority: (source: unknown) => AutopilotActivatedBy;
    readonly normalizeStopReason: (raw: unknown, code: AutopilotErrorCode) => string | null;
    readonly minCadence: number;
    readonly maxCadence: number;
    readonly mergePolicy: string;
    readonly maxCouncilMembers: number;
    readonly maxWorkers: number;
  },
  fail: AutopilotFail,
): {
  readonly enabled: boolean;
  readonly activated_at: string | null;
  readonly activated_by: AutopilotActivatedBy | null;
  readonly cadence_minutes: number;
  readonly low_tier_skip: boolean;
  readonly council_max_members_default: number;
  readonly target_parallel_workers: number;
  readonly target_parallel_ci: number;
  readonly stopped_at: string | null;
  readonly stop_reason: string | null;
  readonly last_advisor_tick_at: string | null;
} {
  const enabled = record.enabled as boolean;
  const activated_at = decodeNullableIsoInstant(record.activated_at, 'activated_at', fail);
  const stopped_at = decodeNullableIsoInstant(record.stopped_at, 'stopped_at', fail);
  const last_advisor_tick_at = decodeNullableIsoInstant(record.last_advisor_tick_at, 'last_advisor_tick_at', fail);
  const stop_reason = options.normalizeStopReason(record.stop_reason, 'autopilot_invalid_state');
  const activated_by = decodeAutopilotAuthority(
    { enabled, activated_by: record.activated_by, activated_at, stopped_at, stop_reason, last_advisor_tick_at },
    options.localAuthority,
    options.assertLocalAuthority,
    fail,
  );
  const numeric = decodeAutopilotNumericConfig(record, options, fail);
  return { enabled, activated_at, activated_by, ...numeric, stopped_at, stop_reason, last_advisor_tick_at };
}

function decodeAutopilotNumericConfig(
  record: Record<string, unknown>,
  limits: {
    readonly minCadence: number;
    readonly maxCadence: number;
    readonly mergePolicy: string;
    readonly maxCouncilMembers: number;
    readonly maxWorkers: number;
  },
  fail: AutopilotFail,
): {
  readonly cadence_minutes: number;
  readonly low_tier_skip: boolean;
  readonly council_max_members_default: number;
  readonly target_parallel_workers: number;
  readonly target_parallel_ci: number;
} {
  const cadence_minutes = decodeBoundedInt(
    record.cadence_minutes,
    'cadence_minutes',
    limits.minCadence,
    limits.maxCadence,
    'autopilot_invalid_state',
    fail,
  );
  if (record.merge_policy !== limits.mergePolicy) {
    fail('autopilot_invalid_state', `unsupported merge_policy ${JSON.stringify(record.merge_policy)}`);
  }
  if (typeof record.low_tier_skip !== 'boolean') {
    fail('autopilot_invalid_state', 'autopilot state low_tier_skip must be a boolean');
  }
  const council_max_members_default = decodeBoundedInt(
    record.council_max_members_default,
    'council_max_members_default',
    0,
    limits.maxCouncilMembers,
    'autopilot_invalid_state',
    fail,
  );
  const target_parallel_workers = decodeBoundedInt(
    record.target_parallel_workers,
    'target_parallel_workers',
    1,
    limits.maxWorkers,
    'autopilot_invalid_state',
    fail,
  );
  const target_parallel_ci = decodeBoundedInt(
    record.target_parallel_ci,
    'target_parallel_ci',
    1,
    limits.maxWorkers,
    'autopilot_invalid_state',
    fail,
  );
  return {
    cadence_minutes,
    low_tier_skip: record.low_tier_skip,
    council_max_members_default,
    target_parallel_workers,
    target_parallel_ci,
  };
}
