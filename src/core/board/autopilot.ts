import { AdvisorSeatError, advisorTurnState, resolveAdvisorSeat } from './advisor-seat';
import type { BoardHostPortsV1, BoardSeatTerminalReadV1 } from './board';
import { ISSUE_FLOW_WORKER_LIMIT } from './desk';

/**
 * Local auto-pilot control state, hourly advisor tick planner and status projection (#3574).
 * Pure domain logic only: file I/O lives in `src/effects/board/autopilot-store.ts`, and
 * no GitHub comment, webhook, PR body or issue text can ever flip `enabled` to true.
 */
export const AUTOPILOT_PROTOCOL = 1 as const;
export const AUTOPILOT_STATUS_KIND = 'repo-harness.autopilot-status' as const;
export const AUTOPILOT_STATE_RELATIVE_PATH = 'repo-harness/autopilot.json' as const;
export const AUTOPILOT_LOCK_RELATIVE_PATH = `${AUTOPILOT_STATE_RELATIVE_PATH}.lock` as const;

export const AUTOPILOT_LOCAL_AUTHORITY = 'owner_local' as const;
export const AUTOPILOT_MERGE_POLICY = 'ci_plus_dual_signoff' as const;

export const DEFAULT_AUTOPILOT_CADENCE_MINUTES = 60;
export const MIN_AUTOPILOT_CADENCE_MINUTES = 1;
export const MAX_AUTOPILOT_CADENCE_MINUTES = 1440;
export const DEFAULT_AUTOPILOT_LOW_TIER_SKIP = true;
export const DEFAULT_AUTOPILOT_COUNCIL_MAX_MEMBERS = 1;
export const MAX_AUTOPILOT_COUNCIL_MEMBERS = 3;
export const DEFAULT_AUTOPILOT_TARGET_PARALLEL_WORKERS = 5;
export const DEFAULT_AUTOPILOT_TARGET_PARALLEL_CI = 5;
export const MAX_AUTOPILOT_STOP_REASON_CHARS = 500;
/** Bounded defer interval when a due tick skips a busy or resetting advisor inside a longer watcher window. */
export const AUTOPILOT_BUSY_RETRY_MS = 15 * 60_000;

export type AutopilotActivatedBy = typeof AUTOPILOT_LOCAL_AUTHORITY;
export type AutopilotMergePolicy = typeof AUTOPILOT_MERGE_POLICY;

export type AutopilotErrorCode =
  | 'autopilot_invalid_state'
  | 'autopilot_invalid_option'
  | 'autopilot_non_local_activation_refused'
  | 'autopilot_store_failed';

export class AutopilotError extends Error {
  constructor(readonly code: AutopilotErrorCode, message: string) {
    super(message);
    this.name = 'AutopilotError';
  }
}

export interface AutopilotStateV1 {
  readonly protocol: typeof AUTOPILOT_PROTOCOL;
  readonly enabled: boolean;
  readonly activated_at: string | null;
  readonly activated_by: AutopilotActivatedBy | null;
  readonly cadence_minutes: number;
  readonly merge_policy: AutopilotMergePolicy;
  readonly low_tier_skip: boolean;
  readonly council_max_members_default: number;
  readonly target_parallel_workers: number;
  readonly target_parallel_ci: number;
  readonly stopped_at: string | null;
  readonly stop_reason: string | null;
  readonly last_advisor_tick_at: string | null;
}

export type AutopilotParkCategory = 'high_security_uncertain' | 'deployment_request' | 'owner_question';

/** Parked item entry rendered by `rh autopilot status`; populated once #3575 lands. */
export interface AutopilotParkedItemV1 {
  readonly kind: 'issue' | 'pull_request';
  readonly number: number;
  readonly category: AutopilotParkCategory;
  readonly reason: string;
}

export interface AutopilotStatusDocumentV1 {
  readonly protocol: typeof AUTOPILOT_PROTOCOL;
  readonly kind: typeof AUTOPILOT_STATUS_KIND;
  readonly state_path: string;
  readonly state_exists: boolean;
  readonly enabled: boolean;
  readonly activated_at: string | null;
  readonly activated_by: AutopilotActivatedBy | null;
  readonly cadence_minutes: number;
  readonly merge_policy: AutopilotMergePolicy;
  readonly low_tier_skip: boolean;
  readonly council_max_members_default: number;
  readonly target_parallel_workers: number;
  readonly target_parallel_ci: number;
  readonly stopped_at: string | null;
  readonly stop_reason: string | null;
  readonly last_advisor_tick_at: string | null;
  readonly parked: readonly AutopilotParkedItemV1[];
}

export type AutopilotTickSkipReason =
  | 'disabled'
  | 'not_due'
  | 'hc_unavailable'
  | 'advisor_seat_absent'
  | 'advisor_seat_ambiguous'
  | 'advisor_busy'
  | 'advisor_status_unknown'
  | 'advisor_in_reset';

export type AutopilotTickPlanV1 =
  | {
    readonly action: 'send';
    readonly terminal: string;
    readonly text: string;
    readonly next_due_ms: number;
  }
  | {
    readonly action: 'skip';
    readonly reason: AutopilotTickSkipReason;
    readonly terminal: string | null;
    readonly detail: string;
    readonly next_due_ms: number | null;
  };

const AUTOPILOT_STATE_KEYS = [
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
const CONTROL_OR_NEWLINE = /[\u0000-\u001f\u007f-\u009f]/u;

function assertValidDate(date: Date, label: string): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new AutopilotError('autopilot_invalid_option', `${label} must be a valid Date`);
  }
  return date.toISOString();
}

function decodeNullableIsoInstant(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ISO_UTC_INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new AutopilotError('autopilot_invalid_state', `autopilot state ${field} must be a UTC ISO-8601 timestamp or null`);
  }
  return value;
}

function decodeBoundedInt(value: unknown, field: string, min: number, max: number, code: AutopilotErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new AutopilotError(code, `${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Only local owner invocation may activate auto-pilot; remote/GitHub sources fail closed. */
export function assertLocalAutopilotAuthority(source: unknown): AutopilotActivatedBy {
  if (source !== AUTOPILOT_LOCAL_AUTHORITY) {
    throw new AutopilotError(
      'autopilot_non_local_activation_refused',
      `auto-pilot activation requires local authority "${AUTOPILOT_LOCAL_AUTHORITY}"; refused source ${JSON.stringify(source)}`,
    );
  }
  return AUTOPILOT_LOCAL_AUTHORITY;
}

/** Parse `--cadence <minutes>` from a CLI string or integer. */
export function parseAutopilotCadenceMinutes(raw: unknown): number {
  if (typeof raw === 'number') {
    return decodeBoundedInt(raw, 'cadence', MIN_AUTOPILOT_CADENCE_MINUTES, MAX_AUTOPILOT_CADENCE_MINUTES, 'autopilot_invalid_option');
  }
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/u.test(raw.trim())) {
    throw new AutopilotError(
      'autopilot_invalid_option',
      `cadence must be an integer between ${MIN_AUTOPILOT_CADENCE_MINUTES} and ${MAX_AUTOPILOT_CADENCE_MINUTES}`,
    );
  }
  return decodeBoundedInt(Number(raw.trim()), 'cadence', MIN_AUTOPILOT_CADENCE_MINUTES, MAX_AUTOPILOT_CADENCE_MINUTES, 'autopilot_invalid_option');
}

export function normalizeAutopilotStopReason(raw: unknown, code: AutopilotErrorCode = 'autopilot_invalid_option'): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new AutopilotError(code, 'stop reason must be a non-empty single-line string');
  }
  const trimmed = raw.trim();
  if (trimmed === '' || CONTROL_OR_NEWLINE.test(trimmed) || [...trimmed].length > MAX_AUTOPILOT_STOP_REASON_CHARS) {
    throw new AutopilotError(
      code,
      `stop reason must be a non-empty single line up to ${MAX_AUTOPILOT_STOP_REASON_CHARS} characters`,
    );
  }
  return trimmed;
}

export function defaultAutopilotState(): AutopilotStateV1 {
  return Object.freeze({
    protocol: AUTOPILOT_PROTOCOL,
    enabled: false,
    activated_at: null,
    activated_by: null,
    cadence_minutes: DEFAULT_AUTOPILOT_CADENCE_MINUTES,
    merge_policy: AUTOPILOT_MERGE_POLICY,
    low_tier_skip: DEFAULT_AUTOPILOT_LOW_TIER_SKIP,
    council_max_members_default: DEFAULT_AUTOPILOT_COUNCIL_MAX_MEMBERS,
    target_parallel_workers: DEFAULT_AUTOPILOT_TARGET_PARALLEL_WORKERS,
    target_parallel_ci: DEFAULT_AUTOPILOT_TARGET_PARALLEL_CI,
    stopped_at: null,
    stop_reason: null,
    last_advisor_tick_at: null,
  });
}

export function isAutopilotEnabled(state: AutopilotStateV1): boolean {
  return state.enabled === true && state.activated_by === AUTOPILOT_LOCAL_AUTHORITY;
}

function decodeAutopilotAuthority(input: {
  readonly enabled: boolean;
  readonly activated_by: unknown;
  readonly activated_at: string | null;
  readonly stopped_at: string | null;
  readonly stop_reason: string | null;
  readonly last_advisor_tick_at: string | null;
}): AutopilotActivatedBy | null {
  let activated_by: AutopilotActivatedBy | null;
  if (input.activated_by === null) {
    if (input.enabled || input.activated_at !== null) {
      throw new AutopilotError(
        'autopilot_non_local_activation_refused',
        `autopilot state with enabled=${String(input.enabled)} requires activated_by="${AUTOPILOT_LOCAL_AUTHORITY}"`,
      );
    }
    activated_by = null;
  } else {
    activated_by = assertLocalAutopilotAuthority(input.activated_by);
    if (input.activated_at === null) {
      throw new AutopilotError('autopilot_invalid_state', 'autopilot state with activated_by set requires activated_at');
    }
  }
  if (input.enabled && (input.stopped_at !== null || input.stop_reason !== null)) {
    throw new AutopilotError('autopilot_invalid_state', 'enabled autopilot state cannot carry stopped_at or stop_reason');
  }
  if (input.stopped_at === null && input.stop_reason !== null) {
    throw new AutopilotError('autopilot_invalid_state', 'autopilot state stop_reason requires stopped_at');
  }
  if (input.activated_at === null && input.last_advisor_tick_at !== null) {
    throw new AutopilotError('autopilot_invalid_state', 'autopilot state last_advisor_tick_at requires activated_at');
  }
  return activated_by;
}

/** Strict boundary decoder for `<git-common-dir>/repo-harness/autopilot.json`. Fails closed on unknown fields or non-local authority. */
export function decodeAutopilotState(value: unknown): AutopilotStateV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AutopilotError('autopilot_invalid_state', 'autopilot state must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== AUTOPILOT_PROTOCOL) {
    throw new AutopilotError('autopilot_invalid_state', `unsupported autopilot protocol ${JSON.stringify(record.protocol)}`);
  }
  const actual = Object.keys(record).sort().join(',');
  const expected = [...AUTOPILOT_STATE_KEYS].sort().join(',');
  if (actual !== expected) {
    throw new AutopilotError('autopilot_invalid_state', `autopilot state fields are [${actual}], expected [${expected}]`);
  }
  if (typeof record.enabled !== 'boolean') {
    throw new AutopilotError('autopilot_invalid_state', 'autopilot state enabled must be a boolean');
  }
  const enabled = record.enabled;
  const activated_at = decodeNullableIsoInstant(record.activated_at, 'activated_at');
  const stopped_at = decodeNullableIsoInstant(record.stopped_at, 'stopped_at');
  const last_advisor_tick_at = decodeNullableIsoInstant(record.last_advisor_tick_at, 'last_advisor_tick_at');
  const stop_reason = normalizeAutopilotStopReason(record.stop_reason, 'autopilot_invalid_state');
  const activated_by = decodeAutopilotAuthority({
    enabled,
    activated_by: record.activated_by,
    activated_at,
    stopped_at,
    stop_reason,
    last_advisor_tick_at,
  });

  const cadence_minutes = decodeBoundedInt(
    record.cadence_minutes,
    'cadence_minutes',
    MIN_AUTOPILOT_CADENCE_MINUTES,
    MAX_AUTOPILOT_CADENCE_MINUTES,
    'autopilot_invalid_state',
  );
  if (record.merge_policy !== AUTOPILOT_MERGE_POLICY) {
    throw new AutopilotError('autopilot_invalid_state', `unsupported merge_policy ${JSON.stringify(record.merge_policy)}`);
  }
  if (typeof record.low_tier_skip !== 'boolean') {
    throw new AutopilotError('autopilot_invalid_state', 'autopilot state low_tier_skip must be a boolean');
  }
  const council_max_members_default = decodeBoundedInt(
    record.council_max_members_default,
    'council_max_members_default',
    0,
    MAX_AUTOPILOT_COUNCIL_MEMBERS,
    'autopilot_invalid_state',
  );
  const target_parallel_workers = decodeBoundedInt(
    record.target_parallel_workers,
    'target_parallel_workers',
    1,
    ISSUE_FLOW_WORKER_LIMIT,
    'autopilot_invalid_state',
  );
  const target_parallel_ci = decodeBoundedInt(
    record.target_parallel_ci,
    'target_parallel_ci',
    1,
    ISSUE_FLOW_WORKER_LIMIT,
    'autopilot_invalid_state',
  );

  return Object.freeze({
    protocol: AUTOPILOT_PROTOCOL,
    enabled,
    activated_at,
    activated_by,
    cadence_minutes,
    merge_policy: AUTOPILOT_MERGE_POLICY,
    low_tier_skip: record.low_tier_skip,
    council_max_members_default,
    target_parallel_workers,
    target_parallel_ci,
    stopped_at,
    stop_reason,
    last_advisor_tick_at,
  });
}

export function startAutopilotState(
  current: AutopilotStateV1,
  input: { readonly now: Date; readonly source: unknown; readonly cadence_minutes?: number },
): AutopilotStateV1 {
  const activated_by = assertLocalAutopilotAuthority(input.source);
  const activated_at = assertValidDate(input.now, 'now');
  const cadence_minutes = input.cadence_minutes === undefined
    ? DEFAULT_AUTOPILOT_CADENCE_MINUTES
    : parseAutopilotCadenceMinutes(input.cadence_minutes);
  return Object.freeze({
    protocol: AUTOPILOT_PROTOCOL,
    enabled: true,
    activated_at,
    activated_by,
    cadence_minutes,
    merge_policy: AUTOPILOT_MERGE_POLICY,
    low_tier_skip: current.low_tier_skip,
    council_max_members_default: current.council_max_members_default,
    target_parallel_workers: current.target_parallel_workers,
    target_parallel_ci: current.target_parallel_ci,
    stopped_at: null,
    stop_reason: null,
    last_advisor_tick_at: current.last_advisor_tick_at,
  });
}

export function stopAutopilotState(
  current: AutopilotStateV1,
  input: { readonly now: Date; readonly reason?: string | null },
): AutopilotStateV1 {
  const stopped_at = assertValidDate(input.now, 'now');
  const stop_reason = normalizeAutopilotStopReason(input.reason, 'autopilot_invalid_option');
  return Object.freeze({
    ...current,
    enabled: false,
    stopped_at,
    stop_reason,
  });
}

/** Stamps `last_advisor_tick_at` without ever re-enabling a stopped state. */
export function recordAdvisorTickState(current: AutopilotStateV1, now: Date): AutopilotStateV1 {
  if (!isAutopilotEnabled(current)) return current;
  return Object.freeze({
    ...current,
    last_advisor_tick_at: assertValidDate(now, 'now'),
  });
}

/** Next epoch-ms instant when the advisor tick becomes due, or null while auto-pilot is off. */
export function nextAutopilotAdvisorTickAtMs(state: AutopilotStateV1): number | null {
  if (!isAutopilotEnabled(state) || state.activated_at === null) return null;
  const activatedMs = Date.parse(state.activated_at);
  const lastTickMs = state.last_advisor_tick_at === null ? activatedMs : Date.parse(state.last_advisor_tick_at);
  return Math.max(activatedMs, lastTickMs) + state.cadence_minutes * 60_000;
}

function utcPlanStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

/**
 * Single-line hourly trigger sent to the label-resolved live advisor terminal.
 * Covers both batch parents and standalone open issues, and resolves the orchestrator by labels only.
 */
export function formatAutopilotAdvisorTickMessage(input: {
  readonly repository_id: number;
  readonly parent: number;
  readonly now: Date;
  readonly state: AutopilotStateV1;
}): string {
  assertValidDate(input.now, 'now');
  const planPath = `/tmp/repo-harness-advisor/plans/${utcPlanStamp(input.now)}.md`;
  return `[rh-autopilot] tick repository=${input.repository_id} parent=#${input.parent} cadence=${input.state.cadence_minutes}m target_workers=${input.state.target_parallel_workers} target_ci=${input.state.target_parallel_ci}: `
    + `Read open issues (batch parents and standalone open issues), open PRs, CI/review state, \`rh quota\`, read-only archctx refactor recommendations, and parked items. `
    + `Write the plan to ${planPath} and send a structured \`[advisor-plan]\` (Ready to dispatch, Ready to review / merge, Council candidates, Parked (Needs Owner)) to the live orchestrator resolved by labels (\`hc ls --label repo-harness.repository=${input.repository_id} --label repo-harness.seat=orchestrator\`). `
    + `Soft target: up to ${input.state.target_parallel_workers} parallel workers and ${input.state.target_parallel_ci} CI runs when disjoint ready issues exist; no synthetic issues; council default max ${input.state.council_max_members_default} member(s).`;
}

/**
 * Pure decision for one watcher check of the hourly advisor tick.
 * Resolves the advisor strictly from `repo-harness.repository` + `repo-harness.seat=advisor` labels,
 * skipping while the advisor is working, blocked, in an unknown state, or in an open seat reset.
 */
export function planAutopilotAdvisorTick(input: {
  readonly state: AutopilotStateV1;
  readonly repository_id: number;
  readonly parent: number;
  readonly now: Date;
  readonly terminals: ReturnType<BoardHostPortsV1['seatTerminals']>;
  readonly advisor_in_reset: boolean;
}): AutopilotTickPlanV1 {
  const dueAtMs = nextAutopilotAdvisorTickAtMs(input.state);
  if (dueAtMs === null) {
    return { action: 'skip', reason: 'disabled', terminal: null, detail: 'auto-pilot is off', next_due_ms: null };
  }
  const nowMs = input.now.getTime();
  if (nowMs < dueAtMs) {
    return {
      action: 'skip',
      reason: 'not_due',
      terminal: null,
      detail: `next advisor tick in ${Math.ceil((dueAtMs - nowMs) / 60_000)}m`,
      next_due_ms: dueAtMs - nowMs,
    };
  }
  if (input.terminals.status === 'unavailable') {
    return {
      action: 'skip',
      reason: 'hc_unavailable',
      terminal: null,
      detail: `hc did not list seat terminals: ${input.terminals.reason}`,
      next_due_ms: null,
    };
  }
  let advisor: BoardSeatTerminalReadV1;
  try {
    advisor = resolveAdvisorSeat(input.terminals.terminals);
  } catch (error) {
    if (error instanceof AdvisorSeatError && (error.code === 'advisor_seat_absent' || error.code === 'advisor_seat_ambiguous')) {
      return {
        action: 'skip',
        reason: error.code,
        terminal: null,
        detail: error.message,
        next_due_ms: null,
      };
    }
    throw error;
  }
  const deferMs = Math.min(AUTOPILOT_BUSY_RETRY_MS, input.state.cadence_minutes * 60_000);
  if (input.advisor_in_reset) {
    return {
      action: 'skip',
      reason: 'advisor_in_reset',
      terminal: advisor.address,
      detail: `advisor ${advisor.address} has an open reset request`,
      next_due_ms: deferMs,
    };
  }
  const turn = advisorTurnState(advisor.status);
  if (turn === 'running') {
    return {
      action: 'skip',
      reason: 'advisor_busy',
      terminal: advisor.address,
      detail: `advisor ${advisor.address} is ${advisor.status ?? 'busy'}`,
      next_due_ms: deferMs,
    };
  }
  if (turn !== 'over') {
    return {
      action: 'skip',
      reason: 'advisor_status_unknown',
      terminal: advisor.address,
      detail: `advisor ${advisor.address} status is ${advisor.status ?? 'unreported'}`,
      next_due_ms: null,
    };
  }
  return {
    action: 'send',
    terminal: advisor.address,
    text: formatAutopilotAdvisorTickMessage({
      repository_id: input.repository_id,
      parent: input.parent,
      now: input.now,
      state: input.state,
    }),
    next_due_ms: input.state.cadence_minutes * 60_000,
  };
}

/**
 * Effective default `seat_limits.worker` for triage plans when the manifest omits `max_parallel_writers`.
 * Scales from `defaultWriters` up to `target_parallel_workers` (within `ISSUE_FLOW_WORKER_LIMIT`) only
 * for the disjoint units present in `merge_order`; never creates synthetic issues.
 */
export function autopilotTriageWriterLimit(
  disjointUnits: number,
  defaultWriters: number,
  state: AutopilotStateV1 | null | undefined,
): number {
  if (!state || !isAutopilotEnabled(state)) return defaultWriters;
  const softCap = Math.min(state.target_parallel_workers, ISSUE_FLOW_WORKER_LIMIT);
  if (disjointUnits <= 0) return Math.min(defaultWriters, softCap);
  return Math.min(softCap, Math.max(defaultWriters, disjointUnits));
}

export function buildAutopilotStatusDocument(input: {
  readonly path: string;
  readonly exists: boolean;
  readonly state: AutopilotStateV1;
  readonly parked?: readonly AutopilotParkedItemV1[];
}): AutopilotStatusDocumentV1 {
  return Object.freeze({
    ...input.state,
    kind: AUTOPILOT_STATUS_KIND,
    state_path: input.path,
    state_exists: input.exists,
    parked: Object.freeze([...(input.parked ?? [])]),
  });
}

export function formatAutopilotStatusText(doc: AutopilotStatusDocumentV1): string {
  const lines = [
    `Auto-pilot: ${doc.enabled ? `ON (${doc.activated_by})` : 'OFF'}`,
    `Activated at: ${doc.activated_at ?? 'never'}`,
    ...(doc.stopped_at === null ? [] : [`Stopped at: ${doc.stopped_at}${doc.stop_reason === null ? '' : ` (${doc.stop_reason})`}`]),
    `Last advisor tick: ${doc.last_advisor_tick_at ?? 'none'}`,
    `Cadence: ${doc.cadence_minutes}m | Merge policy: ${doc.merge_policy} | Low skip: ${doc.low_tier_skip ? 'on' : 'off'} | Council default max: ${doc.council_max_members_default}`,
    `Targets: workers=${doc.target_parallel_workers} ci=${doc.target_parallel_ci}`,
    `State file: ${doc.state_path}`,
  ];
  if (doc.parked.length === 0) {
    lines.push('Parked (Needs Owner): none');
  } else {
    lines.push(`Parked (Needs Owner): ${doc.parked.length}`);
    for (const item of doc.parked) {
      lines.push(`- ${item.kind} #${item.number} [${item.category}]: ${item.reason}`);
    }
  }
  return lines.join('\n');
}
