import { AdvisorSeatError, advisorTurnState, resolveAdvisorSeat } from './advisor-seat';
import type {
  AutopilotBoardAuthorityV1,
  AutopilotQuotaAuthorityV1,
  AutopilotStateV1,
  AutopilotStatusDocumentV1,
  AutopilotTickPlanV1,
} from './autopilot';
import type { BoardHostPortsV1, BoardSeatTerminalReadV1 } from './board';
import type { QuotaReport } from './quota';

export function utcPlanStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
}

export function checkQuotaReportAccounts(
  report: QuotaReport,
): { readonly reason: 'quota_unknown'; readonly detail: string } | null {
  if (report.accounts.length === 0) {
    return { reason: 'quota_unknown', detail: 'quota report has no accounts' };
  }
  const unknown = report.accounts.filter(account => account.state === 'unknown');
  if (unknown.length > 0) {
    const summary = unknown
      .map(account => account.reason === null ? `${account.account}: unknown` : `${account.account}: ${account.reason}`)
      .join('; ');
    return { reason: 'quota_unknown', detail: `required quota unknown (${summary})` };
  }
  return null;
}

export function checkAutopilotTickDue(
  dueAtMs: number | null,
  now: Date,
  board: AutopilotBoardAuthorityV1,
  quota: AutopilotQuotaAuthorityV1,
  checkQuota: (q: AutopilotQuotaAuthorityV1) => { readonly reason: 'quota_unavailable' | 'quota_unknown'; readonly detail: string } | null,
): AutopilotTickPlanV1 | null {
  if (dueAtMs === null) {
    return { action: 'skip', reason: 'disabled', terminal: null, detail: 'auto-pilot is off', next_due_ms: null };
  }
  const nowMs = now.getTime();
  if (nowMs < dueAtMs) {
    return {
      action: 'skip',
      reason: 'not_due',
      terminal: null,
      detail: `next advisor tick in ${Math.ceil((dueAtMs - nowMs) / 60_000)}m`,
      next_due_ms: dueAtMs - nowMs,
    };
  }
  if (board.status === 'unavailable') {
    return { action: 'skip', reason: 'board_unavailable', terminal: null, detail: board.reason, next_due_ms: null };
  }
  const quotaIssue = checkQuota(quota);
  if (quotaIssue !== null) {
    return { action: 'skip', reason: quotaIssue.reason, terminal: null, detail: quotaIssue.detail, next_due_ms: null };
  }
  return null;
}

export function planAdvisorSeatDelivery(
  input: {
    readonly state: AutopilotStateV1;
    readonly repository_id: number;
    readonly parent: number;
    readonly now: Date;
    readonly terminals: ReturnType<BoardHostPortsV1['seatTerminals']>;
    readonly advisor_in_reset: boolean;
    readonly defer_ms: number;
  },
  formatMessage: (args: { readonly repository_id: number; readonly parent: number; readonly now: Date; readonly state: AutopilotStateV1 }) => string,
): AutopilotTickPlanV1 {
  if (input.terminals.status === 'unavailable') {
    return { action: 'skip', reason: 'hc_unavailable', terminal: null, detail: `hc did not list seat terminals: ${input.terminals.reason}`, next_due_ms: input.defer_ms };
  }
  let advisor: BoardSeatTerminalReadV1;
  try {
    advisor = resolveAdvisorSeat(input.terminals.terminals);
  } catch (error) {
    if (error instanceof AdvisorSeatError && (error.code === 'advisor_seat_absent' || error.code === 'advisor_seat_ambiguous')) {
      return { action: 'skip', reason: error.code, terminal: null, detail: error.message, next_due_ms: input.defer_ms };
    }
    throw error;
  }
  if (input.advisor_in_reset) {
    return { action: 'skip', reason: 'advisor_in_reset', terminal: advisor.address, detail: `advisor ${advisor.address} has an open reset request`, next_due_ms: input.defer_ms };
  }
  const turn = advisorTurnState(advisor.status);
  if (turn === 'running') {
    return { action: 'skip', reason: 'advisor_busy', terminal: advisor.address, detail: `advisor ${advisor.address} is ${advisor.status ?? 'busy'}`, next_due_ms: input.defer_ms };
  }
  if (turn !== 'over') {
    return { action: 'skip', reason: 'advisor_status_unknown', terminal: advisor.address, detail: `advisor ${advisor.address} status is ${advisor.status ?? 'unreported'}`, next_due_ms: input.defer_ms };
  }
  return {
    action: 'send',
    terminal: advisor.address,
    text: formatMessage({
      repository_id: input.repository_id,
      parent: input.parent,
      now: input.now,
      state: input.state,
    }),
    next_due_ms: input.state.cadence_minutes * 60_000,
  };
}

export function formatAutopilotParkedLines(doc: AutopilotStatusDocumentV1): string[] {
  if (doc.parked_unavailable !== undefined) {
    return [`Parked (Needs Owner): unavailable (${doc.parked_unavailable})`];
  }
  if (doc.parked.length === 0) {
    return ['Parked (Needs Owner): none'];
  }
  return [
    `Parked (Needs Owner): ${doc.parked.length}`,
    ...doc.parked.map(item => `- ${item.kind} #${item.number} [${item.category}]: ${item.reason}`),
  ];
}
