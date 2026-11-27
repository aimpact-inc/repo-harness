import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { attentionSentSlot, deliveryTiming, liveSeatTerminals, type AttentionDeliveryV1, type AttentionSentEntryV1, type planAttentionDeliveries } from '../../core/board/attention-delivery';
import type { AutopilotBoardAuthorityV1 } from '../../core/board/autopilot';
import type { BoardV1 } from '../../core/board/board';
import type { AttentionAutopilotTickResultV1, AttentionLogRecordV1, AttentionSendOutcome, AttentionWindowInput, ReviewCollectLine } from './attention-watch';
import type { ReviewObserver } from './review';

export function appendAttentionLog(path: string, record: AttentionLogRecordV1): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function reviewCollectMessage(line: ReviewCollectLine): string {
  switch (line.kind) {
    case 'published': return 'PASS published; run rh board merge';
    case 'fail_held': return `FAIL held on ${line.terminal}: ${line.blocking} blocking; challenge once or run rh review collect`;
    case 'refused': return `refused: ${line.error}`;
  }
}

export const sleepFor = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

interface AutopilotSleepController {
  readonly nextCheckAt: () => number | null;
  readonly tick: () => Promise<void>;
}

function nextWindowSleepMs(
  current: number,
  end: number,
  reviewIntervalMs: number | undefined,
  autopilot: AutopilotSleepController | undefined,
): number {
  const remaining = end - current;
  const checkAt = autopilot?.nextCheckAt() ?? null;
  const autopilotStep = checkAt !== null && checkAt > current && checkAt < end ? checkAt - current : remaining;
  const reviewStep = reviewIntervalMs ?? remaining;
  return Math.min(remaining, reviewStep, autopilotStep);
}

export async function sleepThroughWindow(
  end: number,
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
  reviewIntervalMs: number,
  tick?: () => void,
  autopilot?: AutopilotSleepController,
): Promise<void> {
  if (tick === undefined && autopilot === undefined) {
    await sleep(end - now().getTime());
    return;
  }
  let lastAutopilotAt = Number.NEGATIVE_INFINITY;
  const checkAutopilot = async (at: number): Promise<void> => {
    const checkAt = autopilot?.nextCheckAt() ?? null;
    if (autopilot === undefined || checkAt === null || checkAt > at || at <= lastAutopilotAt) return;
    lastAutopilotAt = at;
    await autopilot.tick();
  };
  for (let current = now().getTime(); current < end; current = now().getTime()) {
    await checkAutopilot(current);
    current = now().getTime();
    if (current >= end) break;
    await sleep(nextWindowSleepMs(current, end, tick === undefined ? undefined : reviewIntervalMs, autopilot));
    const after = now().getTime();
    if (after <= current) break;
    if (after < end) {
      tick?.();
      await checkAutopilot(after);
    }
  }
}

export function notifyReviewReceipts(input: AttentionWindowInput, tick: ReturnType<NonNullable<AttentionWindowInput['review_collect']>>, log: (record: Record<string, unknown>) => void): void {
  for (const line of tick.lines) {
    log({ kind: 'review_collect', line });
    const text = `[rh-attention] #${input.parent} P1 review: PR #${line.pr} ${line.seat} ${reviewCollectMessage(line)}`;
    for (const terminal of tick.orchestrators) {
      const result = input.host.send(terminal, text);
      log({ kind: 'send', route: 'orchestrator', terminal, rules: ['review'],
        outcome: result.status === 'sent' ? 'sent' : 'send_failed', detail: result.status === 'sent' ? null : result.detail });
    }
  }
}

/**
 * One review pass: one log line and one message line per start or refusal. A
 * refused run (the lock, `gh`, an unknown launch) is a line too, so it never
 * ends the watcher; the marker of a started seat keeps the next window from a
 * second start for the same head.
 */
export async function reviewWindow(review: (observe: ReviewObserver) => Promise<unknown>, log: (record: Record<string, unknown>) => void): Promise<string[]> {
  const lines: string[] = [];
  const note = (pr: number | null, seat: string | null, outcome: 'started' | 'refused', detail: string | null) => {
    log({ kind: 'review', pr, seat, outcome, detail });
    lines.push(pr === null ? `refused: ${detail}` : `PR #${pr} ${outcome}${seat === null ? '' : ` on ${seat}`}${detail === null ? '' : `: ${detail}`}`);
  };
  try {
    // Each event is noted as it happens: a later throw keeps every start that completed before it.
    await review(event => event.kind === 'started' ? note(event.pr, event.seat, 'started', event.marker_url) : note(event.pr, null, 'refused', event.reason));
  } catch (error) {
    note(null, null, 'refused', error instanceof Error ? error.message : String(error));
  }
  return lines;
}

function isQuotaAuthorityFailure(result: AttentionAutopilotTickResultV1): boolean {
  return result.outcome === 'skipped' && (result.reason === 'quota_unknown' || result.reason === 'quota_unavailable');
}

interface AutopilotWindowLoop {
  readonly nextCheckAt: () => number | null;
  readonly tick: (board: AutopilotBoardAuthorityV1, midWindow: boolean) => Promise<void>;
}

export function createAutopilotWindowLoop(
  deliver: boolean,
  tick: AttentionWindowInput['autopilot_tick'],
  now: () => Date,
  log: (record: Record<string, unknown>) => void,
  refreshIntervalMs: number,
): AutopilotWindowLoop | undefined {
  if (!deliver || tick === undefined) return undefined;
  let nextCheckAt: number | null = null;
  let windowBlocked = false;
  return {
    nextCheckAt: () => nextCheckAt,
    tick: async (board, midWindow) => {
      if (windowBlocked) return;
      const startedAt = now();
      const result = await tick(startedAt, { board, mid_window: midWindow });
      if (result.outcome !== 'skipped' || (result.reason !== 'disabled' && result.reason !== 'not_due')) {
        log({ kind: 'autopilot_tick', outcome: result.outcome, terminal: result.terminal, reason: result.reason, detail: result.detail });
      }
      if (board.status === 'unavailable' || isQuotaAuthorityFailure(result)) {
        windowBlocked = true;
        nextCheckAt = null;
        return;
      }
      const completedMs = now().getTime();
      const refreshAt = completedMs + refreshIntervalMs;
      const dueAt = result.next_due_ms !== null && result.next_due_ms > 0
        ? startedAt.getTime() + result.next_due_ms
        : null;
      nextCheckAt = dueAt !== null && dueAt < refreshAt
        ? Math.max(dueAt, completedMs + 1)
        : refreshAt;
    },
  };
}

export async function deliverAttentionWindow(input: {
  readonly parent: number;
  readonly host: AttentionWindowInput['host'];
  readonly board: BoardV1;
  readonly plan: ReturnType<typeof planAttentionDeliveries>;
  readonly next: Map<string, Map<string, AttentionSentEntryV1>>;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly end: number;
  readonly reviewLines: readonly string[];
  readonly reviewTick?: () => void;
  readonly reviewIntervalMs: number;
  readonly autopilotLoop: AutopilotWindowLoop | undefined;
  readonly log: (record: Record<string, unknown>) => void;
}): Promise<void> {
  const { board, plan, next, now, sleep, end, reviewLines, reviewTick, reviewIntervalMs, autopilotLoop, log } = input;
  for (const skip of plan.skipped) log({ kind: 'skip', route: skip.route, reason: skip.reason });
  const record = (delivery: AttentionDeliveryV1, outcome: AttentionSendOutcome, detail: string | null = null) =>
    log({ kind: 'send', route: delivery.route, terminal: delivery.terminal, rules: delivery.rules, outcome, detail });
  // A failed host call is one failed send: the log keeps the host's message, and the other seats still get theirs.
  const send = (delivery: AttentionDeliveryV1) => {
    const sent = input.host.send(delivery.terminal, delivery.text);
    if (sent.status === 'sent') {
      record(delivery, 'sent');
      // The review delivery carries no key: it holds no finding, so it sets no slot.
      if (delivery.keys.length > 0) {
        const slot = attentionSentSlot(delivery.route, delivery.terminal);
        const updated = new Map(next.get(slot));
        const sentAt = now().getTime();
        for (const key of delivery.keys) {
          const prev = updated.get(key);
          updated.set(key, { count: (prev?.count ?? 0) + 1, last_sent_ms: sentAt });
        }
        next.set(slot, updated);
      }
    } else record(delivery, 'send_failed', sent.detail);
  };
  // The review message takes the delivery path of a finding: a blocked orchestrator gets `hc wait`, a working one the window end.
  // A review start or refusal is housekeeping: the entry carries P3, the priority of the A8 and A9 rules.
  // The message is one entry whatever the number of starts: its lines join with ` · `, not the `; ` of a finding entry.
  const reviewText = `[rh-attention] #${input.parent} P3 review: ${reviewLines.join(' · ')}`;
  const deliveries = [...plan.deliveries, ...(reviewLines.length === 0 ? [] : liveSeatTerminals(board, 'orchestrator').map((terminal): AttentionDeliveryV1 =>
    ({ route: 'orchestrator', terminal: terminal.address, timing: deliveryTiming(terminal.status), rules: ['review'], keys: [], text: reviewText })))];
  for (const delivery of deliveries.filter(entry => entry.timing === 'now')) send(delivery);
  const stillBlocked: AttentionDeliveryV1[] = [];
  for (const delivery of deliveries.filter(entry => entry.timing === 'after_wait')) {
    const seconds = Math.max(1, Math.floor((end - now().getTime()) / 1000));
    const waited = input.host.wait(delivery.terminal, seconds);
    if (waited.status === 'failed') record(delivery, 'send_failed', waited.detail);
    else if (waited.ended) record(delivery, 'terminal_ended', waited.reason);
    else if (waited.state === 'blocked') stillBlocked.push(delivery);
    else send(delivery);
  }
  const autopilotSleep = autopilotLoop === undefined
    ? undefined
    : { nextCheckAt: autopilotLoop.nextCheckAt, tick: () => autopilotLoop.tick({ status: 'observed' }, true) };
  await sleepThroughWindow(end, now, sleep, reviewIntervalMs, reviewTick, autopilotSleep);
  for (const delivery of stillBlocked) {
    const current = input.host.state(delivery.terminal);
    if (current.status === 'failed') record(delivery, 'send_failed', current.detail);
    else if (current.ended) record(delivery, 'terminal_ended', 'ended before the window end');
    else if (current.state === 'blocked') record(delivery, 'skipped_blocked', 'blocked at the window end');
    else send(delivery);
  }
  for (const delivery of deliveries.filter(entry => entry.timing === 'window_end')) send(delivery);
}
