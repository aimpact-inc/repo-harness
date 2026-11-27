import { assertValidDate, CONTROL_OR_NEWLINE, decodeAutopilotStateFields, decodeBoundedInt, validateAutopilotStateRecord } from './autopilot-state-validation';
import { checkAutopilotTickDue, checkQuotaReportAccounts, formatAutopilotParkedLines, planAdvisorSeatDelivery, utcPlanStamp } from './autopilot-tick-delivery';
import type { BoardHostPortsV1 } from './board';
import { ISSUE_FLOW_WORKER_LIMIT } from './desk';
import { decodeQuotaReport, type QuotaReport } from './quota';

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
  | 'autopilot_store_failed'
  | 'autopilot_parked_read_failed';

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

export const AUTOPILOT_PARK_CATEGORIES = [
  'high_security_uncertain',
  'deployment_request',
  'owner_question',
] as const;

export type AutopilotParkCategory = typeof AUTOPILOT_PARK_CATEGORIES[number];

export function isAutopilotParkCategory(value: unknown): value is AutopilotParkCategory {
  return typeof value === 'string' && (AUTOPILOT_PARK_CATEGORIES as readonly string[]).includes(value);
}

/** Merge-gate projection of local auto-pilot state carried on `BoardV1` only while enabled. */
export interface AutopilotMergeGateV1 {
  readonly low_tier_skip: boolean;
}

/** Parked item entry rendered by `rh autopilot status`. */
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
  readonly parked_unavailable?: string;
}

export type AutopilotBoardAuthorityV1 =
  | { readonly status: 'observed' }
  | { readonly status: 'unavailable'; readonly reason: string };

export type AutopilotQuotaAuthorityV1 =
  | { readonly status: 'observed'; readonly report: QuotaReport }
  | { readonly status: 'unavailable'; readonly reason: string };

export type AutopilotTickSkipReason =
  | 'disabled'
  | 'not_due'
  | 'board_unavailable'
  | 'quota_unavailable'
  | 'quota_unknown'
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

function failAutopilot(code: AutopilotErrorCode, message: string): never {
  throw new AutopilotError(code, message);
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
    return decodeBoundedInt(raw, 'cadence', MIN_AUTOPILOT_CADENCE_MINUTES, MAX_AUTOPILOT_CADENCE_MINUTES, 'autopilot_invalid_option', failAutopilot);
  }
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/u.test(raw.trim())) {
    throw new AutopilotError(
      'autopilot_invalid_option',
      `cadence must be an integer between ${MIN_AUTOPILOT_CADENCE_MINUTES} and ${MAX_AUTOPILOT_CADENCE_MINUTES}`,
    );
  }
  return decodeBoundedInt(Number(raw.trim()), 'cadence', MIN_AUTOPILOT_CADENCE_MINUTES, MAX_AUTOPILOT_CADENCE_MINUTES, 'autopilot_invalid_option', failAutopilot);
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

/** Strict boundary decoder for `<git-common-dir>/repo-harness/autopilot.json`. Fails closed on unknown fields or non-local authority. */
export function decodeAutopilotState(value: unknown): AutopilotStateV1 {
  const record = validateAutopilotStateRecord(value, AUTOPILOT_PROTOCOL, failAutopilot);
  const fields = decodeAutopilotStateFields(record, {
    localAuthority: AUTOPILOT_LOCAL_AUTHORITY,
    assertLocalAuthority: assertLocalAutopilotAuthority,
    normalizeStopReason: normalizeAutopilotStopReason,
    minCadence: MIN_AUTOPILOT_CADENCE_MINUTES,
    maxCadence: MAX_AUTOPILOT_CADENCE_MINUTES,
    mergePolicy: AUTOPILOT_MERGE_POLICY,
    maxCouncilMembers: MAX_AUTOPILOT_COUNCIL_MEMBERS,
    maxWorkers: ISSUE_FLOW_WORKER_LIMIT,
  }, failAutopilot);
  return Object.freeze({ protocol: AUTOPILOT_PROTOCOL, merge_policy: AUTOPILOT_MERGE_POLICY, ...fields });
}

export function startAutopilotState(
  current: AutopilotStateV1,
  input: { readonly now: Date; readonly source: unknown; readonly cadence_minutes?: number },
): AutopilotStateV1 {
  const activated_by = assertLocalAutopilotAuthority(input.source);
  const activated_at = assertValidDate(input.now, 'now', failAutopilot);
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
  const stopped_at = assertValidDate(input.now, 'now', failAutopilot);
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
    last_advisor_tick_at: assertValidDate(now, 'now', failAutopilot),
  });
}

/** Next epoch-ms instant when the advisor tick becomes due, or null while auto-pilot is off. */
export function nextAutopilotAdvisorTickAtMs(state: AutopilotStateV1): number | null {
  if (!isAutopilotEnabled(state) || state.activated_at === null) return null;
  const activatedMs = Date.parse(state.activated_at);
  const lastTickMs = state.last_advisor_tick_at === null ? activatedMs : Date.parse(state.last_advisor_tick_at);
  return Math.max(activatedMs, lastTickMs) + state.cadence_minutes * 60_000;
}

/**
 * Single-line hourly trigger sent to the label-resolved live advisor terminal.
 * Covers both batch parents and standalone open issues, uses the existing advisor handoff envelope,
 * scopes the plan path by repository ID, and resolves the orchestrator by labels only.
 */
export function formatAutopilotAdvisorTickMessage(input: {
  readonly repository_id: number;
  readonly parent: number;
  readonly now: Date;
  readonly state: AutopilotStateV1;
}): string {
  assertValidDate(input.now, 'now', failAutopilot);
  const planPath = `/tmp/repo-harness-advisor/plans/${input.repository_id}-${utcPlanStamp(input.now)}.md`;
  return `[rh-autopilot] tick repository=${input.repository_id} parent=#${input.parent} cadence=${input.state.cadence_minutes}m target_workers=${input.state.target_parallel_workers} target_ci=${input.state.target_parallel_ci}: `
    + `Read open issues (batch parents and standalone open issues), open PRs, CI/review state, \`rh quota\`, read-only archctx refactor recommendations, and parked items. `
    + `Write the plan (Ready to dispatch, Ready to review / merge, Council candidates, Parked (Needs Owner)) to ${planPath} and send \`[rh-notice] advisor-plan #${input.parent} ${planPath}\` to the live orchestrator resolved by labels (\`hc ls --label repo-harness.repository=${input.repository_id} --label repo-harness.seat=orchestrator\`). `
    + `Soft target: up to ${input.state.target_parallel_workers} parallel workers and ${input.state.target_parallel_ci} CI runs when disjoint ready issues exist; no synthetic issues; council default max ${input.state.council_max_members_default} member(s).`;
}

/**
 * Fail-closed quota authority check for an auto-pilot advisor tick.
 * Reuses the canonical `decodeQuotaReport` decoder (no second parser) and refuses when the read
 * failed, has no accounts, or any required provider account reports `unknown`.
 */
export function autopilotQuotaProblem(
  quota: AutopilotQuotaAuthorityV1,
): { readonly reason: 'quota_unavailable' | 'quota_unknown'; readonly detail: string } | null {
  if (quota.status === 'unavailable') {
    return { reason: 'quota_unavailable', detail: `quota read failed: ${quota.reason}` };
  }
  let report: QuotaReport;
  try {
    report = decodeQuotaReport(quota.report);
  } catch (error) {
    return { reason: 'quota_unavailable', detail: `quota report invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  return checkQuotaReportAccounts(report);
}

/**
 * Pure decision for one watcher check of the hourly advisor tick.
 * Requires observed board and non-unknown quota authorities, resolves the advisor strictly from
 * `repo-harness.repository` + `repo-harness.seat=advisor` labels, and skips while working,
 * blocked, unknown, or in an open seat reset.
 */
export function planAutopilotAdvisorTick(input: {
  readonly state: AutopilotStateV1;
  readonly repository_id: number;
  readonly parent: number;
  readonly now: Date;
  readonly board: AutopilotBoardAuthorityV1;
  readonly quota: AutopilotQuotaAuthorityV1;
  readonly terminals: ReturnType<BoardHostPortsV1['seatTerminals']>;
  readonly advisor_in_reset: boolean;
}): AutopilotTickPlanV1 {
  const skipped = checkAutopilotTickDue(nextAutopilotAdvisorTickAtMs(input.state), input.now, input.board, input.quota, autopilotQuotaProblem);
  if (skipped !== null) return skipped;
  const deferMs = Math.min(AUTOPILOT_BUSY_RETRY_MS, input.state.cadence_minutes * 60_000);
  return planAdvisorSeatDelivery({ ...input, defer_ms: deferMs }, formatAutopilotAdvisorTickMessage);
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
  readonly parked_unavailable?: string;
}): AutopilotStatusDocumentV1 {
  return Object.freeze({
    ...input.state,
    kind: AUTOPILOT_STATUS_KIND,
    state_path: input.path,
    state_exists: input.exists,
    parked: Object.freeze([...(input.parked ?? [])]),
    ...(input.parked_unavailable === undefined ? {} : { parked_unavailable: input.parked_unavailable }),
  });
}

export function formatAutopilotStatusText(doc: AutopilotStatusDocumentV1): string {
  return [
    `Auto-pilot: ${doc.enabled ? `ON (${doc.activated_by})` : 'OFF'}`,
    `Activated at: ${doc.activated_at ?? 'never'}`,
    ...(doc.stopped_at === null ? [] : [`Stopped at: ${doc.stopped_at}${doc.stop_reason === null ? '' : ` (${doc.stop_reason})`}`]),
    `Last advisor tick: ${doc.last_advisor_tick_at ?? 'none'}`,
    `Cadence: ${doc.cadence_minutes}m | Merge policy: ${doc.merge_policy} | Low skip: ${doc.low_tier_skip ? 'on' : 'off'} | Council default max: ${doc.council_max_members_default}`,
    `Targets: workers=${doc.target_parallel_workers} ci=${doc.target_parallel_ci}`,
    `State file: ${doc.state_path}`,
    ...formatAutopilotParkedLines(doc),
  ].join('\n');
}
