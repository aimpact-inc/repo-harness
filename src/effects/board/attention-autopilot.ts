import type { AttentionHostPortsV1 } from '../../core/board/attention-delivery';
import { AutopilotError, nextAutopilotAdvisorTickAtMs, type AutopilotQuotaAuthorityV1, type AutopilotStateV1, type planAutopilotAdvisorTick } from '../../core/board/autopilot';
import { decodeQuotaReport } from '../../core/board/quota';
import type { AutopilotStateReadV1 } from './autopilot-store';
import type { AttentionAutopilotPortsV1, AttentionAutopilotTickResultV1 } from './attention-watch';

export async function readAutopilotQuotaAuthority(
  readQuota: AttentionAutopilotPortsV1['readQuota'],
): Promise<AutopilotQuotaAuthorityV1> {
  try {
    return { status: 'observed', report: decodeQuotaReport(await readQuota()) };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function deliverAutopilotTick(
  host: Pick<AttentionHostPortsV1, 'send'>,
  recordTick: AttentionAutopilotPortsV1['recordTick'],
  plan: Extract<ReturnType<typeof planAutopilotAdvisorTick>, { readonly action: 'send' }>,
  now: Date,
  deferMs: number,
): AttentionAutopilotTickResultV1 {
  const sent = host.send(plan.terminal, plan.text);
  if (sent.status !== 'sent') {
    return { outcome: 'send_failed', terminal: plan.terminal, reason: sent.reason, detail: sent.detail, next_due_ms: deferMs };
  }
  try {
    recordTick(now);
  } catch (error) {
    if (error instanceof AutopilotError) {
      return { outcome: 'error', terminal: plan.terminal, reason: error.code, detail: error.message, next_due_ms: deferMs };
    }
    throw error;
  }
  return { outcome: 'sent', terminal: plan.terminal, reason: null, detail: null, next_due_ms: plan.next_due_ms };
}

export function readAutopilotTickState(
  readState: AttentionAutopilotPortsV1['readState'],
): { readonly ok: true; readonly read: AutopilotStateReadV1 } | { readonly ok: false; readonly result: AttentionAutopilotTickResultV1 } {
  try {
    return { ok: true, read: readState() };
  } catch (error) {
    if (error instanceof AutopilotError) {
      return { ok: false, result: { outcome: 'error', terminal: null, reason: error.code, detail: error.message, next_due_ms: null } };
    }
    throw error;
  }
}

export function checkAutopilotSchedule(
  state: AutopilotStateV1,
  nowMs: number,
  midWindow: boolean,
  deferred: { readonly scheduleKey: string; readonly retryAtMs: number } | null,
): { readonly ready: true; readonly scheduleKey: string }
  | { readonly ready: false; readonly clearDeferred: boolean; readonly result: AttentionAutopilotTickResultV1 } {
  const dueAtMs = nextAutopilotAdvisorTickAtMs(state);
  if (dueAtMs === null) {
    return { ready: false, clearDeferred: true, result: { outcome: 'skipped', terminal: null, reason: 'disabled', detail: 'auto-pilot is off', next_due_ms: null } };
  }
  const scheduleKey = `${state.enabled}:${state.activated_at ?? ''}:${state.cadence_minutes}:${state.last_advisor_tick_at ?? ''}`;
  if (midWindow && deferred !== null && deferred.scheduleKey === scheduleKey && nowMs < deferred.retryAtMs) {
    return { ready: false, clearDeferred: false, result: { outcome: 'skipped', terminal: null, reason: 'not_due', detail: null, next_due_ms: deferred.retryAtMs - nowMs } };
  }
  if (nowMs < dueAtMs) {
    return { ready: false, clearDeferred: true, result: { outcome: 'skipped', terminal: null, reason: 'not_due', detail: null, next_due_ms: dueAtMs - nowMs } };
  }
  return { ready: true, scheduleKey };
}
