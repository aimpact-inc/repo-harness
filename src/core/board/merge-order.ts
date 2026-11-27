import type { BoardItemV1, BoardPullRequestV1, BoardV1 } from './board';
import { planOrderUnits } from './plan-block';
import type {
  BoardBlockerRefV1,
  BoardMergeHoldRecordV1,
  blockerKey,
  planRefusal,
  reachableOpenBlockers,
} from './merge';

export interface MergeOrderDeps {
  readonly planRefusal: typeof planRefusal;
  readonly blockerKey: typeof blockerKey;
  readonly reachableOpenBlockers: typeof reachableOpenBlockers;
}

/** All threads whose hold can cover the pull request. A direct park on the parent covers the parent itself. */
export function prHoldThreads(board: BoardV1, pr: BoardPullRequestV1, items: readonly number[]) {
  const parent = board.merge_hold;
  return [
    { where: `parent #${board.parent.number}`, hold: parent, records: parent.status === 'held' ? parent.holds.filter(record =>
      record.issues === null ? board.autopilot === undefined || record.park === undefined : record.issues.some(number => items.includes(number))) : [] },
    ...board.items.filter(item => items.includes(item.number)).map(item => ({ where: `issue #${item.number}`, hold: item.merge_hold,
      records: item.merge_hold.status === 'held' ? item.merge_hold.holds : [] })),
    { where: `PR #${pr.number}`, hold: pr.merge_hold, records: pr.merge_hold.status === 'held' ? pr.merge_hold.holds : [] },
  ];
}

/**
 * The items that this pull request closes as one bundle on a parent without a plan: each item it closes whose active claim names the
 * pull request's head branch and lists exactly the board items that the pull request closes. The blocked-by order does not split such
 * items. With a plan, the plan unit decides the order and this claim line does not.
 */
function bundledItems(pr: BoardPullRequestV1, onBoard: ReadonlyMap<number, BoardItemV1>): ReadonlySet<number> {
  const closed = pr.closes.filter(number => onBoard.has(number));
  return new Set(closed.filter((number) => {
    const claim = onBoard.get(number)!.claim;
    return claim.status === 'active' && claim.branch === pr.head_ref && claim.bundle !== null
      && claim.bundle.length === closed.length && closed.every(entry => claim.bundle!.includes(entry));
  }));
}

/** A regular or unknown hold still holds a unit in merge order. */
function isOnlyParked(holds: readonly BoardMergeHoldRecordV1[]): boolean {
  return holds.length > 0 && holds.every(record => record.park !== undefined);
}

function issueIsParked(board: BoardV1, item: BoardItemV1, checkPlanRefusal: typeof planRefusal): boolean {
  if (item.merge_hold.status === 'unknown' || board.merge_hold.status === 'unknown') return false;
  if (board.plan.status === 'observed' && board.plan.block.holds.some(hold => hold.issue === item.number)) return false;
  const own = item.merge_hold.status === 'held' ? item.merge_hold.holds : [];
  const parent = board.merge_hold.status === 'held' ? board.merge_hold.holds.filter(record => record.park === undefined
    && (record.issues === null || record.issues.includes(item.number))) : [];
  if (parent.length > 0 || own.some(record => record.park === undefined)) return false;
  const prs = board.pull_requests.filter(pr => pr.state === 'open' && item.pull_requests.includes(pr.number));
  if (prs.length === 0) return isOnlyParked(own);
  return prs.every(pr => {
    if (checkPlanRefusal(board, pr) !== null) return false;
    const threads = prHoldThreads(board, pr, [...pr.closes, ...pr.refs]);
    return threads.every(thread => thread.hold.status !== 'unknown') && isOnlyParked(threads.flatMap(thread => thread.records));
  });
}

export function commentHoldRefusal(board: BoardV1, pr: BoardPullRequestV1, items: readonly number[]): {
  readonly reason: 'held' | 'hold_unknown'; readonly detail: string;
} | null {
  const threads = prHoldThreads(board, pr, items);
  for (const { where, records: [record] } of threads) {
    if (record === undefined) continue;
    return { reason: 'held', detail: `merge hold on ${where}: ${record.comment_url}` };
  }
  const unknown = threads.find(entry => entry.hold.status === 'unknown');
  return unknown === undefined ? null : { reason: 'hold_unknown', detail: `the comments of ${unknown.where} are truncated and hold no hold record` };
}

export function mergeOrderRefusal(
  board: BoardV1,
  pr: BoardPullRequestV1,
  items: readonly number[],
  onBoard: ReadonlyMap<number, BoardItemV1>,
  deps: MergeOrderDeps,
): { readonly reason: 'plan_unavailable' | 'plan_hold' | 'not_in_merge_order' | 'merge_order'; readonly detail: string } | null {
  if (board.plan.status === 'observed') {
    const plan = board.plan.block;
    const planHold = deps.planRefusal(board, pr);
    if (planHold !== null) return planHold;
    const units = planOrderUnits(plan);
    const unitOf = (number: number): number => units.findIndex(unit => unit.includes(number));
    const unordered = items.filter(number => unitOf(number) < 0);
    if (unordered.length > 0) return { reason: 'not_in_merge_order', detail: `${unordered.map(number => `#${number}`).join(' ')} not in the plan merge_order` };
    // A pull request across two units can never see the earlier unit closed first. A closed linked issue is done work: it spans no unit
    // and does not set the PR's unit, so the PR never waits for itself.
    const open = items.filter(number => onBoard.get(number)!.state !== 'closed');
    const spanned = new Set(open.map(unitOf));
    if (spanned.size > 1) return { reason: 'merge_order', detail: `${open.map(number => `#${number}`).join(' ')} span ${spanned.size} plan units; split the PR` };
    const prUnit = open.length > 0 ? unitOf(open[0]!) : Math.max(...items.map(unitOf));
    const external = new Map(board.autopilot_external_blockers?.map(blocker => [deps.blockerKey(blocker), blocker] as const));
    const local = (ref: BoardBlockerRefV1): BoardItemV1 | undefined => ref.repository.toLowerCase() === board.repository.toLowerCase()
      ? onBoard.get(ref.number) : undefined;
    const blockers = board.autopilot === undefined ? null : deps.reachableOpenBlockers(board.repository, open.length > 0 ? open : items,
      ref => local(ref) ?? external.get(deps.blockerKey(ref)));
    const earlier = units.slice(0, prUnit).flatMap(unit => {
      const pending = unit.filter(number => onBoard.get(number)?.state !== 'closed');
      if (blockers === null || pending.length === 0) return pending;
      const stacks = board.pull_requests.some(other => other.state === 'open' && other.head_ref === pr.base_ref
        && pending.some(number => onBoard.get(number)?.pull_requests.includes(other.number)));
      return !stacks && pending.every(number => {
        const item = onBoard.get(number);
        return !blockers.has(deps.blockerKey({ repository: board.repository, number })) && item !== undefined && issueIsParked(board, item, deps.planRefusal);
      }) ? [] : pending;
    });
    if (earlier.length > 0) return { reason: 'merge_order', detail: `earlier in merge_order and not closed: ${earlier.map(number => `#${number}`).join(' ')}` };
    for (const [key, ref] of blockers ?? []) {
      const item = local(ref);
      const observed = external.get(key);
      if (item === undefined && observed === undefined) return { reason: 'merge_order', detail: `no park state for blocker ${ref.repository}#${ref.number}` };
      if (item === undefined ? observed?.parked : issueIsParked(board, item, deps.planRefusal)) {
        const name = item === undefined ? `${ref.repository}#${ref.number}` : `#${ref.number}`;
        return { reason: 'merge_order', detail: `blocked by parked issue ${name}` };
      }
    }
    return null;
  }
  // A parent without a plan merges in blocked-by order: every blocker of each linked item must be closed.
  const bundle = bundledItems(pr, onBoard);
  const open = [...new Set(items.flatMap(number => onBoard.get(number)!.blocked_by.filter(blocker => blocker.state === 'open' && !bundle.has(blocker.number)).map(blocker => blocker.number)))]
    .sort((left, right) => left - right);
  const own = open.find(number => pr.closes.includes(number));
  if (own !== undefined) return { reason: 'merge_order', detail: `blocker #${own} is closed only by this PR; split the PR` };
  if (open.length > 0) return { reason: 'merge_order', detail: `blocked by issues that are not closed: ${open.map(number => `#${number}`).join(' ')}` };
  return null;
}
