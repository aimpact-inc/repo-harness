import { BOARD_PRIORITY_ORDER, type BoardAttentionRoute, type BoardAttentionV1 } from './attention';
import type { BoardV1 } from './board';
import { WORKER_SEAT_IDS } from './seats-settings';

/**
 * The delivery plan of the resident attention watcher (#1509). It is a pure
 * function of one board, its attention result and the advisor wakes of the
 * last 24 hours. The watcher is a program, not a seat: it sends findings to
 * the seat terminals and never decides for them.
 */
const MINUTE = 60_000;
/** The window while a worker seat terminal is live. */
export const WINDOW_WITH_WORKERS_MS = 15 * MINUTE;
/** The window while no worker seat terminal is live. */
export const WINDOW_WITHOUT_WORKERS_MS = 60 * MINUTE;
/** Minimum cooldown before a persistent P0/P1 finding re-reminds on the same route. */
export const RENUDGE_INTERVAL_MS = 30 * MINUTE;
/** Maximum total sends (initial send plus re-reminders) per persistent P0/P1 finding per terminal slot. */
export const MAX_SENDS_PER_FINDING = 3;
/** The advisor seat wakes at most once per window, and at most this many times in a rolling 24 hours. */
export const ADVISOR_WAKES_PER_DAY = 8;
export const ADVISOR_CAP_SPAN_MS = 24 * 60 * MINUTE;

/** `now`: idle or done. `after_wait`: blocked, so `hc wait` first. `window_end`: working, error or no status. */
export type AttentionDeliveryTiming = 'now' | 'after_wait' | 'window_end';

export interface AttentionDeliveryV1 {
  readonly route: BoardAttentionRoute;
  readonly terminal: string;
  readonly timing: AttentionDeliveryTiming;
  readonly rules: readonly string[];
  /** The finding keys that the text carries (`attentionFindingKey`). */
  readonly keys: readonly string[];
  readonly text: string;
}

type BoardFinding = BoardAttentionV1['findings'][number];

/**
 * A finding is the same finding while its rule and its subjects stay. The
 * message is not in the key: it holds the minutes, which change each window.
 * Comments join the key only when the finding names some, so the key of a
 * finding with no comments, and the sent state that holds it, stay valid.
 */
export function attentionFindingKey(finding: BoardFinding): string {
  const subjects = [finding.rule, finding.issues, finding.pull_requests, finding.terminals];
  return JSON.stringify(finding.comments.length === 0 ? subjects : [...subjects, finding.comments]);
}

export type AttentionSentEntryV1 = { readonly count: number; readonly last_sent_ms: number };

/**
 * The finding send counts and last send timestamps that each seat terminal of
 * a route got in `sent` deliveries, by `attentionSentSlot`. The watcher keeps
 * it in its process between windows: a new watcher sends each open finding
 * once, and persistent P0/P1 findings re-remind up to `MAX_SENDS_PER_FINDING`
 * times after `RENUDGE_INTERVAL_MS`.
 */
export type AttentionSentV1 = ReadonlyMap<string, ReadonlyMap<string, AttentionSentEntryV1>>;

export const attentionSentSlot = (route: BoardAttentionRoute, terminal: string): string => `${route} ${terminal}`;

/** A route with findings that gets no send in this window, and why: the advisor daily cap, the renudge cap, no live seat terminal, or the board's execution reason. */
export interface AttentionSkipV1 {
  readonly route: BoardAttentionRoute;
  readonly reason: string;
}

export interface AttentionDeliveryPlanV1 {
  readonly window_ms: number;
  readonly deliveries: readonly AttentionDeliveryV1[];
  readonly skipped: readonly AttentionSkipV1[];
}

export function liveSeatTerminals(board: BoardV1, seat: string) {
  if (board.execution.status !== 'observed') return [];
  return board.execution.terminals.filter(terminal => terminal.seat_status === 'observed' && terminal.seat === seat && terminal.state === 'live');
}

export function attentionWindowMs(board: BoardV1): number {
  return WORKER_SEAT_IDS.some(seat => liveSeatTerminals(board, seat).length > 0) ? WINDOW_WITH_WORKERS_MS : WINDOW_WITHOUT_WORKERS_MS;
}

export function deliveryTiming(status: string | null): AttentionDeliveryTiming {
  if (status === 'idle' || status === 'done') return 'now';
  if (status === 'blocked') return 'after_wait';
  return 'window_end';
}

/**
 * One line: `hc send` pastes the text and presses Enter once. Each entry
 * reads `<priority> <rule>: <message>`, highest priority first; entries of one
 * priority keep the order of `evaluateBoardAttention`. The seat reads the
 * priority of the entry, so the skill text needs no copy of the rule table.
 */
function deliveryText(parent: number, findings: readonly BoardFinding[]): string {
  const rank = (finding: BoardFinding): number => BOARD_PRIORITY_ORDER.indexOf(finding.priority);
  const ordered = [...findings].sort((left, right) => rank(left) - rank(right));
  return `[rh-attention] #${parent} ${ordered.map(finding => `${finding.priority} ${finding.rule}: ${finding.message}`).join('; ')}`;
}

const isRenudgePriority = (finding: BoardFinding): boolean => finding.priority === 'P0' || finding.priority === 'P1';

function isDeliveryEligible(finding: BoardFinding, entry: AttentionSentEntryV1 | undefined, nowMs: number): boolean {
  if (entry === undefined) return true;
  return isRenudgePriority(finding) && entry.count < MAX_SENDS_PER_FINDING && nowMs - entry.last_sent_ms >= RENUDGE_INTERVAL_MS;
}

function isFindingCappedAndDue(finding: BoardFinding, entry: AttentionSentEntryV1 | undefined, nowMs: number): boolean {
  return isRenudgePriority(finding) && entry !== undefined && entry.count >= MAX_SENDS_PER_FINDING && nowMs - entry.last_sent_ms >= RENUDGE_INTERVAL_MS;
}

/**
 * One message per live seat terminal of each route that has eligible findings.
 * A route names its seat: A findings stay on orchestrator, R findings stay on
 * advisor (no cross-route escalation). P2 and P3 findings send once per
 * terminal slot; persistent P0/P1 findings re-remind up to
 * `MAX_SENDS_PER_FINDING` after `RENUDGE_INTERVAL_MS`. With no live seat
 * terminal, `no_seat_terminal` is emitted while any finding on the route is
 * fresh or due for a P0/P1 re-reminder. When live terminals exist and no
 * delivery is queued, `renudge_cap` is emitted once per route if any P0/P1
 * finding on a live terminal reached `MAX_SENDS_PER_FINDING` with cooldown elapsed.
 */
export function planAttentionDeliveries(
  board: BoardV1,
  attention: BoardAttentionV1,
  advisorWakesLastDay: number,
  sent: AttentionSentV1 = new Map(),
  nowMs: number = Date.parse(board.observed_at),
): AttentionDeliveryPlanV1 {
  const deliveries: AttentionDeliveryV1[] = [];
  const skipped: AttentionSkipV1[] = [];
  for (const route of ['orchestrator', 'advisor'] as const) {
    const findings = attention.findings.filter(finding => finding.route === route);
    if (findings.length === 0) continue;
    const terminals = liveSeatTerminals(board, route);
    const pending = terminals.map((terminal) => {
      const slotSent = sent.get(attentionSentSlot(route, terminal.address));
      return {
        terminal,
        findings: findings.filter(finding => isDeliveryEligible(finding, slotSent?.get(attentionFindingKey(finding)), nowMs)),
      };
    }).filter(entry => entry.findings.length > 0);
    const routePrefix = attentionSentSlot(route, '');
    const slots = [...sent.keys()].filter(slot => slot.startsWith(routePrefix));
    const fresh = terminals.length === 0
      ? findings.some((finding) => {
        const key = attentionFindingKey(finding);
        const entries = slots.map(slot => sent.get(slot)?.get(key)).filter((entry): entry is AttentionSentEntryV1 => entry !== undefined);
        return entries.length === 0 || entries.some(entry => isDeliveryEligible(finding, entry, nowMs));
      })
      : pending.length > 0;
    if (!fresh) {
      if (terminals.length > 0 && terminals.some((terminal) => {
        const slotSent = sent.get(attentionSentSlot(route, terminal.address));
        return findings.some(finding => isFindingCappedAndDue(finding, slotSent?.get(attentionFindingKey(finding)), nowMs));
      })) {
        skipped.push({ route, reason: 'renudge_cap' });
      }
      continue;
    }
    if (route === 'advisor' && advisorWakesLastDay >= ADVISOR_WAKES_PER_DAY) {
      skipped.push({ route, reason: 'advisor_daily_cap' });
      continue;
    }
    if (board.execution.status === 'unavailable') {
      skipped.push({ route, reason: board.execution.reason });
      continue;
    }
    if (terminals.length === 0) skipped.push({ route, reason: 'no_seat_terminal' });
    for (const entry of pending) {
      deliveries.push({
        route, terminal: entry.terminal.address, timing: deliveryTiming(entry.terminal.status),
        rules: entry.findings.map(finding => finding.rule), keys: entry.findings.map(attentionFindingKey), text: deliveryText(attention.parent, entry.findings),
      });
    }
  }
  return { window_ms: attentionWindowMs(board), deliveries, skipped };
}

/** One attention watcher terminal, as the host reads it from its labels. */
export interface AttentionWatcherV1 {
  readonly address: string;
  readonly state: 'live' | 'finished';
  /** The raw `repo-harness.repository` and `repo-harness.parent` label values; null when the label is absent. */
  readonly repository: string | null;
  readonly parent: string | null;
}

export type AttentionHostFailureV1 = { readonly status: 'failed'; readonly reason: string; readonly detail: string };

/**
 * The terminal host calls of the watcher, as a core contract. The terminal
 * host is a plugin, so only the composition root (`src/cli/index.ts`) passes
 * its implementation in.
 */
export interface AttentionHostPortsV1 {
  /** The terminal that runs this process; `not_watcher` when it does not carry the attention service label. */
  readonly ownTerminal: () => ({ readonly status: 'observed' } & AttentionWatcherV1) | AttentionHostFailureV1;
  /** Watcher terminals, finished ones too; with a scope, only those of one repository id and parent. Reason `hc_missing`: no hc on PATH. */
  readonly watchers: (scope?: { readonly repository: number; readonly parent: number }) =>
    { readonly status: 'observed'; readonly watchers: readonly AttentionWatcherV1[] } | AttentionHostFailureV1;
  /** Start argv in a new watcher terminal of one repository id and parent that outlives the caller. */
  readonly startWatcher: (scope: { readonly repository: number; readonly parent: number }, cwd: string, argv: readonly [string, ...string[]]) =>
    { readonly status: 'started'; readonly address: string } | AttentionHostFailureV1;
  readonly send: (terminal: string, text: string) => { readonly status: 'sent' } | AttentionHostFailureV1;
  /** A seat terminal now. `ended`: its program ended. `state`: its status word; null when it never reported one. */
  readonly state: (terminal: string) => { readonly status: 'observed'; readonly ended: boolean; readonly state: string | null } | AttentionHostFailureV1;
  /** Wait at most `seconds` until the terminal stops working. `ended`: its program ended. `state`: its status word when the wait ended. */
  readonly wait: (terminal: string, seconds: number) =>
    { readonly status: 'observed'; readonly ended: boolean; readonly reason: string; readonly state: string | null } | AttentionHostFailureV1;
}

