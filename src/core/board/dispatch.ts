import { PlanBlockError, decodePlanBlock, planOrderUnits, type PlanBlockV3 } from './plan-block';
import { tierOf } from './review-rules';
import { selectSeatRoute, type SeatAccountQuotas } from './seat-routing';
import { ROUTING_CLASSES, isWorkerSeat, type RoutingClass, type SeatId, type SeatsConfigV1 } from './seats-settings';
import { closedClaimUrls, commentId, field, issueClaim, newestProtocolComment, protocolComments, type BoardCommentV1, type BoardParentReadV1, type BoardSubIssueReadV1, type IssueClaimV1 } from './source';

/**
 * Dispatch (#2004): which sub-issues of a parent are ready, and which seat each one gets. It is a pure
 * projection of the plan block, the sub-issues, the live seat labels and the quota route. It writes nothing.
 */
const PLAN_HEADER = 'repo-harness plan';
const CLAIM_HEADER = 'repo-harness issue claim';

/** An issue states its task class by one `route:<class>` label. */
export const ROUTE_LABEL_PREFIX = 'route:';
/** Work that touches credentials never goes to a Pi seat, which runs without a sandbox. */
export const CREDENTIALS_LABEL = 'touches:credentials';

export class DispatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchError';
  }
}

export type DispatchSkipReason = 'not_sub_issue' | 'closed' | 'held' | 'blocked' | 'claimed' | 'kind_label_invalid' | 'tier_invalid' | 'tier_mixed' | 'route_conflict' | 'no_route' | 'over_limit';

export type DispatchDecisionV1 =
  | { readonly issue: number; readonly action: 'dispatch'; readonly title: string; readonly route_class: RoutingClass; readonly credentials: boolean; readonly seat: SeatId; readonly route_line: string }
  | { readonly issue: number; readonly action: 'skip'; readonly reason: DispatchSkipReason; readonly detail: string };

/** A live terminal with its raw labels, as the board host reads it. */
export interface DispatchTerminalV1 {
  readonly state: 'live' | 'finished';
  readonly labels: { readonly seat?: string; readonly issue?: string; readonly parent?: string };
}

export interface DispatchInputV1 {
  readonly parent: BoardParentReadV1;
  readonly terminals: readonly DispatchTerminalV1[];
  readonly seats: SeatsConfigV1;
  readonly quota: SeatAccountQuotas;
  /** `--issues`: the member set of one plan unit; absent dispatches every unit of the plan. */
  readonly bundle?: readonly number[];
}

export interface DispatchPlanV1 {
  readonly plan: PlanBlockV3;
  /** The `--issues` set of the input. Its decisions follow the order of its plan unit. */
  readonly bundle: readonly number[] | null;
  /** The ready units in plan order, each its open members: one seat, one worktree and one pull request for each. */
  readonly units: readonly (readonly number[])[];
  /** Live worker seats that carry this parent's label before this dispatch. */
  readonly live_workers: number;
  readonly coordinator: string | null;
  readonly parent_comments_truncated: boolean;
  readonly decisions: readonly DispatchDecisionV1[];
}

function planOf(parent: BoardParentReadV1): PlanBlockV3 {
  const comment = newestProtocolComment(parent.parent.comments, PLAN_HEADER);
  if (comment === null) throw new DispatchError(`#${parent.parent.number} has no plan comment${parent.parent.comments.truncated ? ' in the comments that were read' : ''}`);
  try {
    return decodePlanBlock(comment.body);
  } catch (error) {
    if (error instanceof PlanBlockError) throw new DispatchError(error.message);
    throw error;
  }
}

function claimOrder(a: BoardCommentV1, b: BoardCommentV1): number {
  const time = a.created_at.localeCompare(b.created_at);
  if (time !== 0) return time;
  const aId = commentId(a.url) ?? a.url;
  const bId = commentId(b.url) ?? b.url;
  return aId.length - bId.length || aId.localeCompare(bId);
}

/** Claimed: the newest claim is active, or the comments are cut and a claim cannot be ruled out. */
function claimHolder(claim: IssueClaimV1): string | null {
  if (claim.status === 'unknown') return 'older comments were not read, so a claim cannot be ruled out';
  return claim.status === 'active' ? `active claim ${claim.url}` : null;
}

/** The one route class that the labels name, or the reason that they do not. */
function routeClass(labels: readonly string[]): { readonly kind: RoutingClass } | { readonly error: string } {
  const names = labels.filter(label => label.startsWith(ROUTE_LABEL_PREFIX)).map(label => label.slice(ROUTE_LABEL_PREFIX.length));
  if (names.length !== 1) return { error: names.length === 0 ? 'the issue has no route label' : `the issue has several route labels: ${names.join(', ')}` };
  const kind = ROUTING_CLASSES.find(candidate => candidate === names[0]);
  return kind === undefined ? { error: `${names[0]} is not a route class (${ROUTING_CLASSES.join(', ')})` } : { kind };
}

/** `--issues` that is not the member set of one plan unit: the plan block is the only authority for bundle membership. */
const NOT_A_PLAN_UNIT = 'not a plan unit; post the plan again with rh board post plan';

/**
 * The route class of a bundle unit: frontend only with frontend, otherwise the join of the two axes, so one important or deep
 * member makes the unit important or deep.
 */
export function bundleRouteClass(classes: readonly RoutingClass[]): { readonly kind: RoutingClass } | { readonly error: string } {
  if (classes.every(kind => kind === 'frontend')) return { kind: 'frontend' };
  if (classes.includes('frontend')) return { error: 'cannot mix frontend and non-frontend route classes in one bundle' };
  const important = classes.some(kind => kind.startsWith('important_'));
  const deep = classes.some(kind => kind.endsWith('_deep'));
  return { kind: `${important ? 'important' : 'simple'}_${deep ? 'deep' : 'fast'}` as RoutingClass };
}

type Failure = { readonly reason: DispatchSkipReason; readonly detail: string };
const CLOSED: Failure = { reason: 'closed', detail: 'the issue is closed' };
/** One member of a unit after the per-issue checks. */
type CheckedMember =
  | { readonly number: number; readonly closed: true }
  | { readonly number: number; readonly failure: Failure }
  | { readonly number: number; readonly issue: BoardSubIssueReadV1; readonly kind: RoutingClass };

/** The tier guard of a bundle unit: every member has one tier label, and High never shares a unit with a lower tier. */
function unitTierFailure(members: readonly { readonly issue: BoardSubIssueReadV1 }[]): Failure | null {
  const tiers: { readonly number: number; readonly tier: string }[] = [];
  for (const { issue } of members) {
    let tier: string | null;
    try {
      tier = tierOf(issue.labels);
    } catch (error) {
      return { reason: 'tier_invalid', detail: `#${issue.number}: ${(error as Error).message}` };
    }
    if (tier === null) return { reason: 'tier_invalid', detail: `#${issue.number} has no tier label` };
    tiers.push({ number: issue.number, tier });
  }
  const high = tiers.find(entry => entry.tier === 'high');
  const lower = tiers.find(entry => entry.tier !== 'high');
  return high !== undefined && lower !== undefined
    ? { reason: 'tier_mixed', detail: `#${high.number} is tier:high and #${lower.number} is tier:${lower.tier}; a High unit holds only High issues` }
    : null;
}

export function planDispatch(input: DispatchInputV1): DispatchPlanV1 {
  const { parent, seats, quota } = input;
  const bundle = input.bundle ?? null;
  const plan = planOf(parent);
  const comments = parent.parent.comments;
  const closed = closedClaimUrls(comments);
  const claims = protocolComments(comments, CLAIM_HEADER)
    .filter(comment => field(comment.body, 'Role') === 'coordinator' && field(comment.body, 'Status') === 'active');
  const coordinator = claims.filter(claim => !closed.has(claim.url) && !claims.some(next =>
    field(next.body, 'Prior claim') === claim.url && claimOrder(claim, next) < 0)).sort(claimOrder)[0];
  const parentLabel = String(parent.parent.number);
  const liveWorkers = input.terminals.filter(({ state, labels }) => state === 'live' && labels.parent === parentLabel
    && labels.seat !== undefined && isWorkerSeat(labels.seat as SeatId));
  // A seat started without a parent label still occupies its issue, so occupancy reads every live worker of the repository.
  const liveIssues = new Set(input.terminals.filter(({ state, labels }) => state === 'live' && labels.seat !== undefined && isWorkerSeat(labels.seat as SeatId))
    .map(({ labels }) => labels.issue));
  const held = new Map(plan.holds.map(hold => [hold.issue, hold.reason]));
  const issues = new Map(parent.sub_issues.map(issue => [issue.number, issue]));
  const planned = planOrderUnits(plan);
  let selected = planned;
  if (bundle !== null) {
    const wanted = new Set(bundle);
    const unit = planned.find(entry => entry.length === wanted.size && entry.every(number => wanted.has(number)));
    if (unit === undefined || wanted.size !== bundle.length) throw new DispatchError(NOT_A_PLAN_UNIT);
    selected = [unit];
  }
  let running = liveWorkers.length;
  const decisions: DispatchDecisionV1[] = [];
  const ready: (readonly number[])[] = [];
  for (const unit of selected) {
    const members = new Set(unit);
    // A closed member is not work: it keeps its own skip and neither stops the unit nor joins its claim.
    const checked = unit.map((number): CheckedMember => {
      const issue = issues.get(number);
      if (issue === undefined) return { number, failure: { reason: 'not_sub_issue', detail: `#${number} is not a sub-issue of #${parent.parent.number}` } };
      if (issue.state === 'closed') return { number, closed: true };
      const hold = held.get(number);
      if (hold !== undefined) return { number, failure: { reason: 'held', detail: hold } };
      // A blocker inside the unit lands in the same pull request, so it does not block.
      const open = issue.blocked_by.filter(blocker => blocker.state === 'open' && !members.has(blocker.number)).map(blocker => `#${blocker.number}`);
      if (open.length > 0) return { number, failure: { reason: 'blocked', detail: `blocked by ${open.join(', ')}` } };
      const claim = claimHolder(issueClaim(issue.comments, number)) ?? (liveIssues.has(String(number)) ? 'a live worker seat carries the issue label' : null);
      if (claim !== null) return { number, failure: { reason: 'claimed', detail: claim } };
      const kind = routeClass(issue.labels);
      if ('error' in kind) return { number, failure: { reason: 'kind_label_invalid', detail: kind.error } };
      return { number, issue, kind: kind.kind };
    });
    // All or nothing: a member with its own failure keeps it, and every other open member skips with the unit's failure.
    const skipAll = (failure: Failure): void => {
      for (const entry of checked) decisions.push({ issue: entry.number, action: 'skip', ...('closed' in entry ? CLOSED : 'failure' in entry ? entry.failure : failure) });
    };
    const failed = checked.find((entry): entry is Extract<CheckedMember, { readonly failure: Failure }> => 'failure' in entry);
    if (failed !== undefined) {
      skipAll({ reason: failed.failure.reason, detail: `unit member #${failed.number}: ${failed.failure.detail}` });
      continue;
    }
    const open = checked.filter((entry): entry is Extract<CheckedMember, { readonly issue: BoardSubIssueReadV1 }> => 'issue' in entry);
    if (open.length === 0) {
      skipAll(CLOSED);
      continue;
    }
    let kind: RoutingClass = open[0]!.kind;
    if (unit.length >= 2) {
      const tier = unitTierFailure(open);
      if (tier !== null) {
        skipAll(tier);
        continue;
      }
      const joined = bundleRouteClass(open.map(entry => entry.kind));
      if ('error' in joined) {
        skipAll({ reason: 'route_conflict', detail: joined.error });
        continue;
      }
      kind = joined.kind;
    }
    const credentials = open.some(entry => entry.issue.labels.includes(CREDENTIALS_LABEL));
    const route = selectSeatRoute(kind, seats, quota, credentials ? seat => seat.runtime !== 'pi' : undefined);
    if (route.id === null) {
      skipAll({ reason: 'no_route', detail: route.line });
      continue;
    }
    if (running >= plan.seat_limits.worker) {
      skipAll({ reason: 'over_limit', detail: `${running} of ${plan.seat_limits.worker} worker seats run` });
      continue;
    }
    running += 1;
    for (const entry of checked) {
      decisions.push('issue' in entry
        ? { issue: entry.number, action: 'dispatch', title: entry.issue.title, route_class: kind, credentials, seat: route.id, route_line: route.line }
        : { issue: entry.number, action: 'skip', ...CLOSED });
    }
    ready.push(Object.freeze(open.map(entry => entry.number)));
  }
  return Object.freeze({ plan, bundle, units: Object.freeze(ready), live_workers: liveWorkers.length, coordinator: coordinator?.url ?? null, parent_comments_truncated: comments.truncated, decisions: Object.freeze(decisions) });
}
