import { planIssues, planOrderIssues, planOrderUnits } from './plan-block';
import { boardMergeDecisions, planSkipReason, prHasCommentHold } from './merge';
import type { BoardItemV1, BoardPullRequestV1, BoardTerminalV1, BoardV1 } from './board';
import { moduleOf } from './cluster';
import { hcStatusClass, liveSeats, seatItem, seatPullRequest } from './desk';
import { pathHazardHits, pathHighHits } from './hazards';
import { compareHcVersions } from '../terminal/herdr-pin';
import { SEAT_IDS, WORKER_SEAT_IDS, isReviewSeat } from './seats-settings';

/**
 * Attention rules over one board. Each rule is a pure function of the board
 * and its observation time. A rules route to the orchestrator seat, R rules
 * to the advisor seat. A rule whose input is unavailable is listed as
 * unevaluated with the reason; it never fires on a guess.
 */
export const BOARD_ATTENTION_PROTOCOL = 2 as const;
export const BOARD_ATTENTION_KIND = 'repo-harness.board-attention' as const;

const MINUTE = 60_000;
/** A1: an accepted, ready pull request waits this long unmerged. */
export const A1_UNMERGED_MS = 15 * MINUTE;
/** A3: a worker seat stays blocked or in error this long. */
export const A3_STUCK_MS = 10 * MINUTE;
/** A12: a writer claim has no pull request and no claim status for this long. */
export const A12_NO_PR_MS = 120 * MINUTE;
/** A13: a worker seat is done or idle this long while its item has no open or merged pull request. A19 reads a review seat with the same bound. */
export const A13_IDLE_MS = 10 * MINUTE;
/** A14: the failed required check of an open pull request is this old. */
export const A14_RED_MS = 30 * MINUTE;
/** A20: the required check of an open pull request is pending or missing this long after its head commit. A run of this repository ends in 10 to 20 min. */
export const A20_STUCK_MS = 60 * MINUTE;
/** A15: an unresolved FAIL record of the head is this old. */
export const A15_FAIL_MS = 60 * MINUTE;
/** A16: a question to the coordinator has no answer for this long. */
export const A16_QUESTION_MS = 15 * MINUTE;
/** A17: a blocked claim status is this old. */
export const A17_BLOCKED_MS = 15 * MINUTE;
/** A22 uses this window for working status and for two matching probes of an unreported task seat. */
export const STALLED_WORKING_MS = 5 * MINUTE;
/** R1: this many open items are not in the latest plan. */
export const R1_UNPLANNED_ITEMS = 3;
/** R4: an accepted pull request in the merge order waits this long unmerged. */
export const R4_STALLED_MS = 4 * 60 * MINUTE;
const WORKER_SEATS = new Set<string>(WORKER_SEAT_IDS);
/** The review seat ids of the seats config; the gatekeeper-fallback seat launches under the gatekeeper label (#2253). */
const REVIEW_SEATS = new Set<string>(SEAT_IDS.filter(isReviewSeat));
export const isA22TaskSeat = (seat: string): boolean => WORKER_SEATS.has(seat) || REVIEW_SEATS.has(seat);
const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);

export type BoardRuleId = 'A1' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'A9' | 'A10' | 'A11' | 'A12' | 'A13' | 'A14' | 'A15' | 'A16' | 'A17' | 'A18' | 'A19' | 'A20' | 'A21' | 'A22' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R7' | 'R8';
export type BoardAttentionRoute = 'orchestrator' | 'advisor';
/** P0: a seat cannot continue. P1: a worker or an issue waits for the coordinator, or a High change has a lower tier. P2: a pull request or the plan waits. P3: housekeeping. */
export type BoardPriority = 'P0' | 'P1' | 'P2' | 'P3';
/** Highest first. A delivery entry and a `board attention` line print the priority of their finding. */
export const BOARD_PRIORITY_ORDER: readonly BoardPriority[] = Object.freeze(['P0', 'P1', 'P2', 'P3']);
/**
 * The priority of each rule, the only source of a finding's priority. The
 * record names every rule, so a new rule without a priority fails the
 * typecheck. The skill text reads the priority from the message; it keeps no
 * copy of this table.
 */
export const BOARD_RULE_PRIORITY: Readonly<Record<BoardRuleId, BoardPriority>> = Object.freeze({
  A1: 'P2', A3: 'P0', A4: 'P1', A5: 'P1', A6: 'P1', A7: 'P2', A8: 'P3', A9: 'P3', A10: 'P2', A11: 'P2',
  A12: 'P1', A13: 'P1', A14: 'P2', A15: 'P2', A16: 'P1', A17: 'P1', A18: 'P2', A19: 'P1', A20: 'P2', A21: 'P1', A22: 'P1',
  R1: 'P2', R2: 'P2', R3: 'P1', R4: 'P2', R5: 'P1', R7: 'P2', R8: 'P2',
});

export interface BoardFindingV1 {
  readonly rule: BoardRuleId;
  readonly priority: BoardPriority;
  readonly route: BoardAttentionRoute;
  readonly issues: readonly number[];
  readonly pull_requests: readonly number[];
  readonly terminals: readonly string[];
  /** The comment URLs the finding is about: an A16 finding names its question, so each question is its own finding. */
  readonly comments: readonly string[];
  readonly message: string;
}

export interface BoardUnevaluatedV1 {
  readonly rule: BoardRuleId;
  readonly reason: string;
  readonly subject: string | null;
}

export interface BoardAttentionV1 {
  readonly protocol: typeof BOARD_ATTENTION_PROTOCOL;
  readonly kind: typeof BOARD_ATTENTION_KIND;
  readonly parent: number;
  readonly observed_at: string;
  readonly findings: readonly BoardFindingV1[];
  readonly unevaluated: readonly BoardUnevaluatedV1[];
}

interface Context {
  readonly board: BoardV1;
  /** The board read before this one, which A22 compares with; null for a single read. */
  readonly previous: BoardV1 | null;
  readonly now: number;
  readonly findings: BoardFindingV1[];
  readonly unevaluated: BoardUnevaluatedV1[];
}

function find(context: Context, rule: BoardRuleId, subject: { issues?: number[]; pull_requests?: number[]; terminals?: string[]; comments?: string[] }, message: string): void {
  context.findings.push(Object.freeze({
    rule,
    priority: BOARD_RULE_PRIORITY[rule],
    route: rule.startsWith('A') ? 'orchestrator' : 'advisor',
    issues: Object.freeze(subject.issues ?? []),
    pull_requests: Object.freeze(subject.pull_requests ?? []),
    terminals: Object.freeze(subject.terminals ?? []),
    comments: Object.freeze(subject.comments ?? []),
    message,
  }));
}

function skip(context: Context, rule: BoardRuleId, reason: string, subject: string | null = null): void {
  context.unevaluated.push(Object.freeze({ rule, reason, subject }));
}

const minutes = (ms: number): number => Math.floor(ms / MINUTE);

function itemsOf(board: BoardV1, pr: BoardPullRequestV1): number[] {
  const items = new Set(board.items.map(item => item.number));
  return [...new Set([...pr.closes, ...pr.refs])].filter(number => items.has(number)).sort((left, right) => left - right);
}

/** A dependency edge: one pull request stacks on the other, or one of its items is blocked by an item of the other. */
function hasEdge(board: BoardV1, left: BoardPullRequestV1, right: BoardPullRequestV1): boolean {
  if (left.base_ref === right.head_ref || right.base_ref === left.head_ref) return true;
  const leftItems = itemsOf(board, left);
  const rightItems = itemsOf(board, right);
  return board.items.some(item => (leftItems.includes(item.number) && item.blocked_by.some(blocker => rightItems.includes(blocker.number)))
    || (rightItems.includes(item.number) && item.blocked_by.some(blocker => leftItems.includes(blocker.number))));
}

function openPullRequests(board: BoardV1): BoardPullRequestV1[] {
  return board.pull_requests.filter(pr => pr.state === 'open');
}

/** Holds on the parent, an issue, or the pull request silence notices for that pull request. */
function held(board: BoardV1, pr: BoardPullRequestV1): boolean {
  if (prHasCommentHold(board, pr)) return true;
  if (board.plan.status !== 'observed') return false;
  const holds = new Set(board.plan.block.holds.map(hold => hold.issue));
  return itemsOf(board, pr).some(number => holds.has(number));
}

/** Open, not held pull requests with a known acceptance. An unknown one is listed for each rule that needs it. */
function accepted(context: Context, rule: BoardRuleId): (BoardPullRequestV1 & { readonly acceptance: { readonly status: 'accepted'; readonly accepted_at: string } })[] {
  return unheld(context.board).flatMap((pr) => {
    if (pr.acceptance.status === 'unknown') {
      skip(context, rule, pr.acceptance.reason, `#${pr.number}`);
      return [];
    }
    return pr.acceptance.status === 'accepted' ? [pr as BoardPullRequestV1 & { readonly acceptance: { readonly status: 'accepted'; readonly accepted_at: string } }] : [];
  });
}

function a1(context: Context): void {
  for (const pr of accepted(context, 'A1')) {
    const waited = context.now - Date.parse(pr.acceptance.accepted_at);
    if (pr.merge_readiness?.ready === true && waited > A1_UNMERGED_MS) {
      find(context, 'A1', { issues: itemsOf(context.board, pr), pull_requests: [pr.number] },
        `#${pr.number} is accepted and ready, unmerged for ${minutes(waited)} min`);
    }
  }
}

type SeatTerminal = BoardTerminalV1 & { readonly seat_status: 'observed' };

function workerTerminals(context: Context, rule: BoardRuleId): SeatTerminal[] {
  return seatTerminals(context, rule, WORKER_SEATS);
}

function seatTerminals(context: Context, rule: BoardRuleId, seats: ReadonlySet<string>): SeatTerminal[] {
  const execution = context.board.execution;
  if (execution.status === 'unavailable') {
    skip(context, rule, execution.reason);
    return [];
  }
  return execution.terminals.flatMap((terminal) => {
    if (terminal.seat_status === 'unavailable') {
      skip(context, rule, terminal.reason, terminal.address);
      return [];
    }
    return seats.has(terminal.seat) && terminal.state === 'live' ? [terminal] : [];
  });
}

function a3(context: Context): void {
  for (const terminal of workerTerminals(context, 'A3')) {
    const word = hcStatusClass(terminal.status);
    if (word !== 'blocked' && word !== 'error') continue;
    if (terminal.status_ms === null) {
      skip(context, 'A3', 'status_time_missing', terminal.address);
    } else if (context.now - terminal.status_ms > A3_STUCK_MS) {
      find(context, 'A3', { issues: terminal.issue === null ? [] : [terminal.issue], terminals: [terminal.address] },
        `worker ${terminal.address} is ${terminal.status} for ${minutes(context.now - terminal.status_ms)} min`);
    }
  }
}

/**
 * The items of one writer: the item itself, and for a bundle claim (`rh board dispatch --issues`) each board item that its `Issues:` line
 * names. One pull request and one claim status on any of them serve the whole bundle, so A4, A12 and A13 read the bundle.
 */
function bundleItems(board: BoardV1, item: BoardItemV1): BoardItemV1[] {
  const bundle = item.claim.status === 'active' ? item.claim.bundle : null;
  return bundle === null ? [item] : board.items.filter(entry => bundle.includes(entry.number));
}

/** The newest observed claim status of the bundle items; `unknown` when a read of one of them is truncated. */
function bundleClaimStatus(items: readonly BoardItemV1[]): { readonly status_kind: 'unknown' } | { readonly status_kind: 'none' } | { readonly status_kind: 'observed'; readonly created_at: string } {
  if (items.some(entry => entry.claim_status.status_kind === 'unknown')) return { status_kind: 'unknown' };
  const times = items.flatMap(entry => (entry.claim_status.status_kind === 'observed' ? [entry.claim_status.created_at] : [])).sort();
  return times.length === 0 ? { status_kind: 'none' } : { status_kind: 'observed', created_at: times.at(-1)! };
}

function a4(context: Context): void {
  for (const terminal of workerTerminals(context, 'A4')) {
    const word = hcStatusClass(terminal.status);
    if (word !== 'done' && word !== 'idle') continue;
    if (terminal.issue === null) {
      skip(context, 'A4', 'issue_label_missing', terminal.address);
      continue;
    }
    const item = context.board.items.find(entry => entry.number === terminal.issue);
    if (item === undefined) {
      skip(context, 'A4', 'issue_off_board', terminal.address);
      continue;
    }
    const members = bundleItems(context.board, item);
    const prs = context.board.pull_requests.filter(pr => pr.state === 'open'
      && (terminal.pr === null ? members.some(member => member.pull_requests.includes(pr.number)) : pr.number === terminal.pr));
    if (prs.length === 0) continue;
    const lastCommit = prs.map(pr => pr.head_committed_at).sort().at(-1)!;
    const status = bundleClaimStatus(members);
    if (status.status_kind === 'unknown') {
      skip(context, 'A4', 'comments_truncated', `#${item.number}`);
    } else if (status.status_kind === 'none' || status.created_at < lastCommit) {
      find(context, 'A4', { issues: [item.number], pull_requests: prs.map(pr => pr.number), terminals: [terminal.address] },
        `worker ${terminal.address} is ${terminal.status} and #${item.number} has no claim status after its last commit (${lastCommit})`);
    }
  }
}

function a5(context: Context): void {
  for (const item of context.board.items) {
    const status = item.claim_status;
    if (status.status_kind !== 'observed' || status.pr === null || !/^done\b/u.test(status.status)) continue;
    const pr = context.board.pull_requests.find(entry => entry.number === status.pr);
    if (pr === undefined) {
      skip(context, 'A5', 'claim_pr_off_board', `#${item.number}`);
    } else if (pr.state !== 'merged') {
      find(context, 'A5', { issues: [item.number], pull_requests: [pr.number] },
        `#${item.number} claim status says done, but #${pr.number} is ${pr.state} (${status.url})`);
    }
  }
}

function cycles(items: readonly BoardItemV1[]): number[][] {
  const edges = new Map(items.map(item => [item.number, item.blocked_by.map(blocker => blocker.number)] as const));
  const found = new Map<string, number[]>();
  const walk = (start: number, current: number, path: number[]): void => {
    for (const next of edges.get(current) ?? []) {
      if (next === start) {
        const cycle = [...path].sort((left, right) => left - right);
        found.set(cycle.join(','), cycle);
      } else if (!path.includes(next) && edges.has(next)) {
        walk(start, next, [...path, next]);
      }
    }
  };
  for (const item of items) walk(item.number, item.number, [item.number]);
  return [...found.values()];
}

function a6(context: Context): void {
  for (const item of context.board.items.filter(entry => entry.state === 'open')) {
    const closed = item.blocked_by.filter(blocker => blocker.state === 'closed').map(blocker => blocker.number);
    if (closed.length > 0) {
      find(context, 'A6', { issues: [item.number, ...closed] }, `#${item.number} is blocked by closed ${closed.map(number => `#${number}`).join(', ')}`);
    }
  }
  for (const cycle of cycles(context.board.items)) {
    find(context, 'A6', { issues: cycle }, `blocked-by cycle: ${cycle.map(number => `#${number}`).join(' ')}`);
  }
}

function a7(context: Context): void {
  const run = context.board.daily_run;
  if (run.status === 'unavailable') return skip(context, 'A7', run.reason);
  if (run.conclusion !== null && RED_CONCLUSIONS.has(run.conclusion) && run.open_repair_issues.length === 0) {
    find(context, 'A7', {}, `the daily full run is ${run.conclusion} (${run.run_url}) and no CI repair issue is open`);
  }
}

function a8(context: Context): void {
  const hc = context.board.tooling.hc;
  if (hc.status === 'unavailable') return skip(context, 'A8', hc.reason);
  if (compareHcVersions(hc.version, hc.min_version) < 0) find(context, 'A8', {}, `hc client ${hc.version} is below the repo-harness floor ${hc.min_version}; run hc update --version ${hc.min_version}`);
}

/** A9: a seat of a merged pull request is still open; the post-merge closeout closed it or kept it with a reason (#2005). */
function a9(context: Context): void {
  const execution = context.board.execution;
  if (execution.status === 'unavailable') return skip(context, 'A9', execution.reason);
  for (const terminal of liveSeats(execution.terminals)) {
    if (terminal.issue === null && terminal.pr === null) continue;
    const pr = seatPullRequest(context.board, terminal, seatItem(context.board, terminal));
    if (pr?.state !== 'merged') continue;
    find(context, 'A9', { issues: terminal.issue === null ? [] : [terminal.issue], pull_requests: [pr.number], terminals: [terminal.address] },
      `${terminal.seat} ${terminal.address} of merged #${pr.number} is still open; run rh board closeout --pr ${pr.number}`);
  }
}

/**
 * A21: a live seat has no Herdr.app pane (#3166), so the person cannot see its progress. `hc run --bg` starts such a seat;
 * `rh board dispatch`, `rh board review` and `rh seats launch` open a tab. The host read leaves out the watcher terminals.
 */
function a21(context: Context): void {
  const execution = context.board.execution;
  if (execution.status === 'unavailable') return skip(context, 'A21', execution.reason);
  for (const terminal of liveSeats(execution.terminals)) {
    if (terminal.where !== null) continue;
    const subject = terminal.pr !== null ? ` of #${terminal.pr}` : terminal.issue !== null ? ` of #${terminal.issue}` : '';
    find(context, 'A21', { issues: terminal.issue === null ? [] : [terminal.issue], pull_requests: terminal.pr === null ? [] : [terminal.pr], terminals: [terminal.address] },
      `${terminal.seat} ${terminal.address}${subject} has no Herdr.app pane: give it one with herdr-app do terminal.keep '{"terminal":"${terminal.address}"}'`);
  }
}

function workerA22PullRequest(board: BoardV1, seat: SeatTerminal, item: BoardItemV1 | undefined): BoardPullRequestV1 | undefined {
  if (seat.pr !== null) return board.pull_requests.find(pr => pr.number === seat.pr);
  if (seat.branch === null) return undefined;
  const matches = board.pull_requests.filter(pr => pr.head_ref === seat.branch);
  const items = item === undefined ? null : bundleItems(board, item);
  const linked = (pr: BoardPullRequestV1): boolean => items === null || items.some(entry => entry.pull_requests.includes(pr.number));
  const open = matches.filter(pr => pr.state === 'open' && linked(pr));
  if (open.length === 1) return open[0];

  // A branch name survives reuse. A merge can identify this assignment only if it follows the writer claim and the branch is unique.
  const [pr] = matches;
  const claim = item?.claim;
  return matches.length === 1 && pr?.state === 'merged' && linked(pr) && claim?.status === 'active' && claim.role === 'writer'
    && claim.branch === seat.branch && pr.merged_at !== null && Date.parse(pr.merged_at) > Date.parse(claim.created_at) ? pr : undefined;
}

function workerA22Completed(board: BoardV1, seat: SeatTerminal, pr: BoardPullRequestV1, item: BoardItemV1 | undefined): boolean {
  if (pr.state === 'merged') return true;
  if (pr.state !== 'open') return false;
  // A labeled issue owns its own status. Without that label, require one unambiguous issue for the pull request.
  const issues = seat.issue === null ? board.items.filter(entry => entry.pull_requests.includes(pr.number)) : [];
  const completion = (item ?? (issues.length === 1 ? issues[0] : undefined))?.writer_completion;
  return completion?.pr === pr.number && pr.head_sha.startsWith(completion.head_sha)
    && (completion.branch === pr.head_ref || (seat.pr !== null && completion.branch === null));
}

function unreportedA22(context: Context, seat: SeatTerminal, elapsed: number): void {
  const { board } = context;
  const item = board.items.find(entry => entry.number === seat.issue);
  const review = REVIEW_SEATS.has(seat.seat);
  const pr = review ? board.pull_requests.find(entry => entry.number === seat.pr) : workerA22PullRequest(board, seat, item);
  if (pr !== undefined) {
    if (review) {
      const records = pr.review_records;
      const role = seat.seat === 'reviewer' ? 'reviewer' : 'gatekeeper';
      if (records.status === 'observed' && records.head[role]) return;
    } else if (workerA22Completed(board, seat, pr, item)) return;
  }
  find(context, 'A22', { issues: seat.issue === null ? [] : [seat.issue], pull_requests: pr === undefined ? [] : [pr.number], terminals: [seat.address] },
    `${seat.seat} ${seat.address} has no reported status, no child process, and the same screen as ${minutes(elapsed)} min ago; read the pane, it may be stalled`);
}

/** A22 compares the screen and child count of two probes in the same turn after the stalled window. */
function a22(context: Context): void {
  const liveness = context.board.seat_liveness;
  if (liveness.status === 'unavailable') return skip(context, 'A22', liveness.reason);
  const execution = context.board.execution;
  const before = context.previous?.seat_liveness;
  for (const probe of liveness.probes) {
    const workingSince = probe.status_ms;
    if (probe.children > 0 || (workingSince !== null && context.now - workingSince <= STALLED_WORKING_MS)) continue;
    if (probe.screen_hash === null) {
      skip(context, 'A22', 'screen_unavailable', probe.address);
      continue;
    }
    if (context.previous === null || before?.status !== 'observed') {
      skip(context, 'A22', 'previous_read_missing', probe.address);
      continue;
    }
    const prior = before.probes.find(entry => entry.address === probe.address && entry.status_ms === workingSince && entry.turn === probe.turn);
    if (prior === undefined || prior.children > 0 || prior.screen_hash !== probe.screen_hash) continue;
    const terminal = execution.status === 'observed' ? execution.terminals.find(entry => entry.address === probe.address) : undefined;
    const seat = terminal?.seat_status === 'observed' ? terminal : null;
    if (workingSince === null) {
      const elapsed = context.now - Date.parse(context.previous.observed_at);
      if (seat !== null && isA22TaskSeat(seat.seat) && elapsed > STALLED_WORKING_MS) unreportedA22(context, seat, elapsed);
      continue;
    }
    find(context, 'A22', { issues: seat?.issue == null ? [] : [seat.issue], pull_requests: seat?.pr == null ? [] : [seat.pr], terminals: [probe.address] },
      `${seat?.seat ?? 'seat'} ${probe.address} is working for ${minutes(context.now - workingSince)} min with no child process and an unchanged screen since the read before; read the pane, it may be a stalled stream`);
  }
}

/** A10: an open High pull request whose head does not meet the High acceptance rule has no reviewer row for its head (`second_review: pending`) and its gatekeeper passed it. No merge gate holds it, so the board does. Before the gatekeeper PASS the head waits for a start, not for attention (#2910). */
function a10(context: Context): void {
  for (const pr of openPullRequests(context.board).filter(entry => !entry.is_draft && entry.second_review === 'pending' && entry.gatekeeper_review === 'pass')) {
    find(context, 'A10', { issues: itemsOf(context.board, pr), pull_requests: [pr.number] },
      `#${pr.number} is ${pr.tier === null ? 'of unknown tier (counted as High)' : 'High tier'}, the gatekeeper passed ${pr.head_sha.slice(0, 9)}, and it has no review of that head from the reviewer seat; start the reviewer seat`);
  }
}

/** A11: an open pull request meets every `board merge` condition. The watcher only wakes the orchestrator; the merge starts from its seat. */
function a11(context: Context): void {
  for (const decision of boardMergeDecisions(context.board).filter(entry => entry.eligible)) {
    const pr = context.board.pull_requests.find(entry => entry.number === decision.pr)!;
    find(context, 'A11', { issues: itemsOf(context.board, pr), pull_requests: [pr.number] },
      `eligible: run rh board merge --parent ${context.board.parent.number} --pr ${pr.number}`);
  }
}

/** A12: a writer holds an open item, and no item of its bundle has a pull request or a claim status after the claim. */
function a12(context: Context): void {
  for (const item of context.board.items.filter(entry => entry.state === 'open')) {
    const { claim } = item;
    if (claim.status === 'unknown') {
      skip(context, 'A12', 'comments_truncated', `#${item.number}`);
      continue;
    }
    if (claim.status !== 'active' || claim.role !== 'writer') continue;
    const members = bundleItems(context.board, item);
    if (members.some(member => member.pull_requests.length > 0)) continue;
    // The claim is in the read, so a later status is too: an unknown status holds none after the claim.
    if (members.some(member => member.claim_status.status_kind === 'observed' && member.claim_status.created_at > claim.created_at)) continue;
    const waited = context.now - Date.parse(claim.created_at);
    if (waited > A12_NO_PR_MS) {
      find(context, 'A12', { issues: [item.number] }, `#${item.number} has a writer claim for ${minutes(waited)} min, no PR and no claim status (${claim.url})`);
    }
  }
}

/** A13: a worker seat is done or idle and no item of its bundle has an open or merged pull request; A4 reads the seat once a pull request is open. */
function a13(context: Context): void {
  for (const terminal of workerTerminals(context, 'A13')) {
    const word = hcStatusClass(terminal.status);
    if (word !== 'done' && word !== 'idle') continue;
    if (terminal.issue === null) {
      skip(context, 'A13', 'issue_label_missing', terminal.address);
      continue;
    }
    const item = context.board.items.find(entry => entry.number === terminal.issue);
    if (item === undefined) {
      skip(context, 'A13', 'issue_off_board', terminal.address);
      continue;
    }
    const members = bundleItems(context.board, item);
    if (context.board.pull_requests.some(pr => members.some(member => member.pull_requests.includes(pr.number)) && pr.state !== 'closed')) continue;
    if (terminal.status_ms === null) {
      skip(context, 'A13', 'status_time_missing', terminal.address);
    } else if (context.now - terminal.status_ms > A13_IDLE_MS) {
      find(context, 'A13', { issues: [item.number], terminals: [terminal.address] },
        `worker ${terminal.address} is ${terminal.status} for ${minutes(context.now - terminal.status_ms)} min and #${item.number} has no PR`);
    }
  }
}

/**
 * A19: a review seat is done or idle on an open pull request that has no record of the seat's harness after the seat's status time.
 * A seat without the `net` tool cannot publish its row, and only the session that started it reads the pane (`acceptor.md`).
 */
function a19(context: Context): void {
  for (const terminal of seatTerminals(context, 'A19', REVIEW_SEATS)) {
    const word = hcStatusClass(terminal.status);
    if (word !== 'done' && word !== 'idle') continue;
    if (terminal.pr === null) {
      skip(context, 'A19', 'pr_label_missing', terminal.address);
      continue;
    }
    const pr = context.board.pull_requests.find(entry => entry.number === terminal.pr);
    if (pr === undefined) {
      skip(context, 'A19', 'pr_off_board', terminal.address);
      continue;
    }
    if (pr.state !== 'open') continue;
    if (terminal.status_ms === null) {
      skip(context, 'A19', 'status_time_missing', terminal.address);
      continue;
    }
    if (context.now - terminal.status_ms <= A13_IDLE_MS) continue;
    if (pr.review_records.status === 'unknown') {
      skip(context, 'A19', pr.review_records.reason, `#${pr.number}`);
      continue;
    }
    const recorded = pr.review_records[terminal.seat === 'reviewer' ? 'reviewer' : 'gatekeeper'];
    if (recorded !== null && Date.parse(recorded) > terminal.status_ms) continue;
    find(context, 'A19', { issues: itemsOf(context.board, pr), pull_requests: [pr.number], terminals: [terminal.address] },
      `review seat ${terminal.address} is ${terminal.status} for ${minutes(context.now - terminal.status_ms)} min and #${pr.number} has no record from it; read the pane and publish`);
  }
}

/** Open pull requests without a plan or comment hold. */
function unheld(board: BoardV1): BoardPullRequestV1[] {
  return openPullRequests(board).filter(pr => !held(board, pr));
}

/** A14: the required check of an open, ready-for-review pull request failed and stays red. */
function a14(context: Context): void {
  for (const pr of unheld(context.board).filter(entry => !entry.is_draft)) {
    const check = pr.required_check;
    if (check.status !== 'failure') continue;
    const waited = context.now - Date.parse(check.completed_at);
    if (waited > A14_RED_MS) {
      find(context, 'A14', { issues: itemsOf(context.board, pr), pull_requests: [pr.number] },
        `#${pr.number} has a failed required check on ${pr.head_sha.slice(0, 9)} for ${minutes(waited)} min`);
    }
  }
}

/** A20: the required check of an open, ready-for-review pull request stays pending or missing; the bound is the head commit time. */
function a20(context: Context): void {
  for (const pr of unheld(context.board).filter(entry => !entry.is_draft)) {
    const check = pr.required_check;
    if (check.status === 'unavailable') {
      skip(context, 'A20', check.reason, `#${pr.number}`);
      continue;
    }
    if (check.status !== 'pending' && check.status !== 'missing') continue;
    const waited = context.now - Date.parse(pr.head_committed_at);
    if (waited > A20_STUCK_MS) {
      const open = check.contexts.filter(entry => entry.status !== 'success').map(entry => entry.name).join(', ');
      find(context, 'A20', { issues: itemsOf(context.board, pr), pull_requests: [pr.number] },
        `#${pr.number} required check is ${check.status} for ${minutes(waited)} min after its head commit: ${open}`);
    }
  }
}

/** A15: an unresolved FAIL record of the head gets no new head. */
function a15(context: Context): void {
  for (const pr of unheld(context.board)) {
    if (pr.acceptance.status === 'unknown') {
      skip(context, 'A15', pr.acceptance.reason, `#${pr.number}`);
      continue;
    }
    if (pr.review_fail === null) continue;
    const waited = context.now - Date.parse(pr.review_fail.recorded_at);
    if (waited > A15_FAIL_MS) {
      find(context, 'A15', { issues: itemsOf(context.board, pr), pull_requests: [pr.number] },
        `#${pr.number} has a FAIL record on ${pr.head_sha.slice(0, 9)} for ${minutes(waited)} min and no new head (${pr.review_fail.url})`);
    }
  }
}

/** A16: a boundary question to the coordinator on an open item or an open pull request has no answer. */
function a16(context: Context): void {
  const threads = [
    ...context.board.items.filter(item => item.state === 'open').map(item => ({ number: item.number, questions: item.open_questions, subject: { issues: [item.number] } })),
    ...unheld(context.board).map(pr => ({ number: pr.number, questions: pr.open_questions, subject: { issues: itemsOf(context.board, pr), pull_requests: [pr.number] } })),
  ];
  for (const thread of threads) {
    if (thread.questions.status === 'unknown') {
      skip(context, 'A16', 'comments_truncated', `#${thread.number}`);
      continue;
    }
    for (const question of thread.questions.questions) {
      const waited = context.now - Date.parse(question.created_at);
      if (waited > A16_QUESTION_MS) {
        find(context, 'A16', { ...thread.subject, comments: [question.url] }, `#${thread.number} has a question to the coordinator with no answer for ${minutes(waited)} min (${question.url})`);
      }
    }
  }
}

/** A17: the claim status of an open item that the plan does not hold says blocked. An unobserved plan cannot rule out a hold. */
function a17(context: Context): void {
  const plan = context.board.plan;
  for (const item of context.board.items.filter(entry => entry.state === 'open')) {
    const status = item.claim_status;
    if (status.status_kind === 'unknown') {
      skip(context, 'A17', 'comments_truncated', `#${item.number}`);
      continue;
    }
    if (status.status_kind !== 'observed' || !status.status.startsWith('blocked')) continue;
    if (plan.status !== 'observed') {
      skip(context, 'A17', planSkipReason(plan.status), `#${item.number}`);
      continue;
    }
    if (plan.block.holds.some(hold => hold.issue === item.number)) continue;
    const waited = context.now - Date.parse(status.created_at);
    if (waited > A17_BLOCKED_MS) {
      find(context, 'A17', { issues: [item.number] }, `#${item.number} claim status is blocked for ${minutes(waited)} min (${status.url})`);
    }
  }
}

/** A18: an open, ready-for-review pull request does not merge into its base. */
function a18(context: Context): void {
  for (const pr of unheld(context.board).filter(entry => !entry.is_draft)) {
    if (pr.merge_readiness === null) {
      skip(context, 'A18', 'readiness_missing', `#${pr.number}`);
    } else if (pr.merge_readiness.blockers.some(blocker => blocker.code === 'not_mergeable')) {
      find(context, 'A18', { issues: itemsOf(context.board, pr), pull_requests: [pr.number] },
        `#${pr.number} does not merge into ${pr.base_ref}; the head owner merges main into the branch`);
    }
  }
}

function r1(context: Context): void {
  const plan = context.board.plan;
  if (plan.status === 'unavailable') return skip(context, 'R1', 'plan_unavailable', plan.comment_url);
  if (plan.status === 'absent' && plan.truncated) return skip(context, 'R1', 'comments_truncated');
  const planned = plan.status === 'observed' ? planIssues(plan.block) : new Set<number>();
  const unplanned = context.board.items.filter(item => item.state === 'open' && !planned.has(item.number)).map(item => item.number);
  if (unplanned.length >= R1_UNPLANNED_ITEMS) {
    find(context, 'R1', { issues: unplanned }, `${unplanned.length} open items are not in the latest plan: ${unplanned.map(number => `#${number}`).join(' ')}`);
  }
}

function r2(context: Context): void {
  const open = openPullRequests(context.board);
  for (const pr of open.filter(entry => entry.files === null)) skip(context, 'R2', 'files_incomplete', `#${pr.number}`);
  const complete = open.filter(pr => pr.files !== null);
  for (const [index, left] of complete.entries()) {
    for (const right of complete.slice(index + 1)) {
      const shared = left.files!.filter(path => right.files!.includes(path));
      if (shared.length > 0 && !hasEdge(context.board, left, right)) {
        find(context, 'R2', { pull_requests: [left.number, right.number] },
          `#${left.number} and #${right.number} both change ${shared.slice(0, 3).join(', ')}${shared.length > 3 ? ` and ${shared.length - 3} more` : ''} with no dependency edge`);
      }
    }
  }
}

/**
 * A path rule over open pull requests (R3, R5): a pull request whose changed paths hit the list, with an item that it closes or
 * refs whose tier label is below High. One hit sets High (`agentic-development-flow.md`, Review by risk). A pull request without a
 * complete file list, or an item without a tier label, is unevaluated, never a miss.
 */
function belowHighOnHits(context: Context, rule: 'R3' | 'R5', hitsOf: (files: readonly string[], pr: BoardPullRequestV1) => readonly { readonly path: string; readonly id: string }[], what: string): void {
  for (const pr of openPullRequests(context.board)) {
    if (pr.files === null) {
      skip(context, rule, 'files_incomplete', `#${pr.number}`);
      continue;
    }
    const hits = hitsOf(pr.files, pr);
    if (hits.length === 0) continue;
    const items = itemsOf(context.board, pr).map(number => context.board.items.find(item => item.number === number)!);
    for (const item of items.filter(entry => entry.tier === null)) skip(context, rule, 'tier_label_missing', `#${pr.number} #${item.number}`);
    const below = items.filter(item => item.tier === 'low' || item.tier === 'medium');
    if (below.length > 0) {
      find(context, rule, { issues: below.map(item => item.number), pull_requests: [pr.number] },
        `#${pr.number} changes ${hits.slice(0, 3).map(hit => `${hit.path} (${hit.id})`).join(', ')}${hits.length > 3 ? ` and ${hits.length - 3} more` : ''}, ${what}, but ${below.map(item => `#${item.number} is tier:${item.tier}`).join(', ')}`);
    }
  }
}

/** R3: an open pull request changes a path on the change hazard list that the workflow edit allowlist did not clear. */
function r3(context: Context): void {
  belowHighOnHits(context, 'R3', (files, pr) => pathHazardHits(files, pr.cleared_hazard_paths).map(hit => ({ path: hit.path, id: hit.hazard })), 'a High hazard');
}

/** R5: an open pull request changes a path on the High list (permissions, hooks, secrets, deletion, release, merge and push). */
function r5(context: Context): void {
  belowHighOnHits(context, 'R5', files => pathHighHits(files).map(hit => ({ path: hit.path, id: hit.signal })), 'a High signal');
}

function r4(context: Context): void {
  const plan = context.board.plan;
  if (plan.status !== 'observed') return skip(context, 'R4', planSkipReason(plan.status));
  const ordered = new Set(planOrderIssues(plan.block));
  for (const pr of accepted(context, 'R4')) {
    const waited = context.now - Date.parse(pr.acceptance.accepted_at);
    if (itemsOf(context.board, pr).some(number => ordered.has(number)) && waited > R4_STALLED_MS) {
      find(context, 'R4', { issues: itemsOf(context.board, pr), pull_requests: [pr.number] },
        `#${pr.number} in the merge order is accepted and unmerged for ${minutes(waited)} min`);
    }
  }
}

/** R7: an accepted pull request waits behind an open issue of an earlier plan unit that is held, which blocks each ready pull request behind it. */
function r7(context: Context): void {
  const { board } = context;
  if (board.plan.status !== 'observed') return skip(context, 'R7', planSkipReason(board.plan.status));
  const units = planOrderUnits(board.plan.block);
  const { holds } = board.plan.block;
  const onBoard = new Map(board.items.map(item => [item.number, item] as const));
  const refused = new Set(boardMergeDecisions(board).filter(decision => !decision.eligible && decision.reason === 'merge_order').map(decision => decision.pr));
  for (const pr of openPullRequests(board).filter(entry => refused.has(entry.number) && entry.acceptance.status === 'accepted')) {
    // The open items set the unit of the pull request, as in `board merge`; a closed ref in a later unit does not.
    const linked = itemsOf(board, pr);
    const open = linked.filter(number => onBoard.get(number)?.state !== 'closed');
    const last = Math.max(...(open.length > 0 ? open : linked).map(number => units.findIndex(unit => unit.includes(number))));
    const earlier = units.slice(0, last).flat().filter(number => onBoard.get(number)?.state !== 'closed');
    for (const number of earlier.filter(entry => !onBoard.has(entry))) skip(context, 'R7', 'item_off_board', `#${number}`);
    // An off-board entry has no observed state, so only an open board item is a held candidate.
    const hold = earlier.find(number => onBoard.get(number)?.state === 'open' && (holds.some(entry => entry.issue === number) || onBoard.get(number)!.merge_hold.status === 'held'));
    if (hold !== undefined) {
      find(context, 'R7', { issues: [hold], pull_requests: [pr.number] }, `#${pr.number} is accepted and waits behind held #${hold} in merge_order; move #${hold} to the tail`);
    }
  }
}

/**
 * R8: `board.plan` contains two or more unclaimed open single-issue plan units (`unit.length === 1`)
 * without open external blockers that share the same `module:` label and `tier_bucket` (`high` vs `standard`).
 */
function r8(context: Context): void {
  const { board } = context;
  if (board.plan.status !== 'observed') return skip(context, 'R8', planSkipReason(board.plan.status));
  const onBoard = new Map(board.items.map(item => [item.number, item] as const));
  const holds = new Set(board.plan.block.holds.map(entry => entry.issue));
  const units = planOrderUnits(board.plan.block);
  const singletons = units.filter(unit => unit.length === 1).map(unit => unit[0]!);
  const groups = new Map<string, number[]>();
  for (const number of singletons) {
    const item = onBoard.get(number);
    if (item === undefined) {
      skip(context, 'R8', 'item_off_board', `#${number}`);
      continue;
    }
    if (item.state !== 'open') continue;
    if (item.claim.status === 'unknown') {
      skip(context, 'R8', 'comments_truncated', `#${number}`);
      continue;
    }
    if (item.claim.status !== 'none') continue;
    if (holds.has(number) || item.merge_hold.status === 'held') continue;
    if (item.blocked_by.some(blocker => blocker.state === 'open')) continue;
    if (item.tier === null) continue;
    let moduleId: string | null;
    try {
      moduleId = moduleOf(item.labels);
    } catch {
      continue;
    }
    if (moduleId === null) continue;
    const tierBucket = item.tier === 'high' ? 'high' : 'standard';
    const key = `${moduleId}:${tierBucket}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [number]);
    else list.push(number);
  }
  for (const key of [...groups.keys()].sort()) {
    const issues = groups.get(key)!.sort((left, right) => left - right);
    if (issues.length < 2) continue;
    const [moduleId, tierBucket] = key.split(':') as [string, string];
    find(context, 'R8', { issues },
      `${issues.length} unclaimed ${moduleId} (${tierBucket}) single-issue plan units can bundle: ${issues.map(number => `#${number}`).join(' ')}`);
  }
}

/** One finding line of `rh board attention`: the priority first, so no line is without one. */
export function attentionFindingLine(finding: BoardFindingV1): string {
  return `${finding.priority} ${finding.rule} ${finding.route}: ${finding.message}`;
}

/** The text output of `rh board attention`: one line for each finding, then one for each unevaluated rule. */
export function renderAttentionText(attention: BoardAttentionV1): string {
  const lines = attention.findings.map(attentionFindingLine);
  if (lines.length === 0) lines.push(`no attention findings for #${attention.parent}`);
  for (const entry of attention.unevaluated) lines.push(`${entry.rule} not evaluated: ${entry.reason}${entry.subject === null ? '' : ` (${entry.subject})`}`);
  return `${lines.join('\n')}\n`;
}

/** `previous`: the board read before this one; A22 needs it, and a single read lists each candidate seat of A22 as unevaluated. */
export function evaluateBoardAttention(board: BoardV1, previous: BoardV1 | null = null): BoardAttentionV1 {
  const context: Context = { board, previous, now: Date.parse(board.observed_at), findings: [], unevaluated: [] };
  for (const rule of [a1, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, a17, a18, a19, a20, a21, a22, r1, r2, r3, r4, r5, r7, r8]) rule(context);
  return Object.freeze({
    protocol: BOARD_ATTENTION_PROTOCOL,
    kind: BOARD_ATTENTION_KIND,
    parent: board.parent.number,
    observed_at: board.observed_at,
    findings: Object.freeze(context.findings),
    unevaluated: Object.freeze(context.unevaluated),
  });
}
