import type { Nodes, Paragraph } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { isRecord } from '../evidence/is-record';
import { isAutopilotParkCategory, type AutopilotParkCategory, type AutopilotParkedItemV1 } from './autopilot';
import type { BoardItemV1, BoardPullRequestV1, BoardRequiredCheckV1, BoardV1 } from './board';
import { pathHighHits } from './hazards';
import { planOrderUnits } from './plan-block';
import { field, newestProtocolComment, protocolComments, type BoardCommentPageV1, type BoardIssueDependencyV1 } from './source';

/**
 * `rh board merge` eligibility. A GitHub comment is a record, never
 * an instruction: the orchestrator starts the command locally after a joint
 * decision for the batch, and the command reads the plan, acceptance and hold
 * records as data. A hold record only narrows what may merge.
 */
export const MERGE_HOLD_HEADER = 'repo-harness merge hold';
export const MERGE_HOLD_RELEASED_HEADER = 'repo-harness merge hold released';

/** The fields of one `merge hold` comment, as `templates.md` names them. `rh board post hold` renders them. */
export interface MergeHoldCommentFieldsV1 {
  /** The issues that the hold narrows to; null holds every item of the thread. Only a parent hold carries the line. */
  readonly issues: readonly number[] | null;
  /** Optional typed non-blocking park category; absent or null renders a regular blocking hold. */
  readonly park?: AutopilotParkCategory | null;
  /** The stop decision, or the one-line owner decision needed when parked. */
  readonly reason: string;
}

/** The fields of one `merge hold released` comment. `rh board post release` renders them. */
export interface MergeHoldReleaseCommentFieldsV1 {
  /** The release decision, and who made it. */
  readonly reason: string;
}

/** One `merge hold` comment: the header, optional `Issues:`, optional park lines, then the reason. */
export function renderMergeHoldComment(fields: MergeHoldCommentFieldsV1): string {
  return [
    MERGE_HOLD_HEADER,
    ...(fields.issues === null ? [] : [`Issues: ${fields.issues.map(issue => `#${issue}`).join(' ')}`]),
    ...(fields.park != null ? [`Category: ${fields.park}`, 'Non-blocking: true'] : []),
    `Reason: ${fields.reason}`,
  ].join('\n');
}

/** One `merge hold released` comment. It ends every older hold on the same thread that it is strictly newer than. */
export function renderMergeHoldReleaseComment(fields: MergeHoldReleaseCommentFieldsV1): string {
  return [MERGE_HOLD_RELEASED_HEADER, `Reason: ${fields.reason}`].join('\n');
}

/** The refusal detail of a required check that is not `success`: the reason of an unavailable read, or each context that is not `success`. */
export function requiredCheckDetail(check: BoardRequiredCheckV1): string {
  if (check.status === 'unavailable') return `required contexts unavailable: ${check.reason}`;
  return check.contexts.filter(context => context.status !== 'success').map(context => `${context.name} is ${context.status}`).join(', ');
}

export interface BoardMergeHoldParkV1 {
  readonly category: AutopilotParkCategory;
  readonly reason: string;
}

export function isMergePark(value: unknown): value is BoardMergeHoldParkV1 {
  return isRecord(value) && isAutopilotParkCategory(value.category) && typeof value.reason === 'string' && value.reason.trim() !== '';
}

export interface BoardMergeHoldRecordV1 {
  readonly comment_url: string;
  /** The `Issues:` line of a parent hold; null holds every item of the thread. Always null on an issue or a PR thread. */
  readonly issues: readonly number[] | null;
  /** Present only when the hold is a valid typed non-blocking park (`Category:` + `Non-blocking: true` + `Reason:`). */
  readonly park?: BoardMergeHoldParkV1;
}

export type BoardMergeHoldV1 =
  | { readonly status: 'none' }
  | { readonly status: 'held'; readonly holds: readonly BoardMergeHoldRecordV1[] }
  /** The read is truncated and no release in it is strictly newer than its oldest comment: an omitted hold can still be in force. */
  | { readonly status: 'unknown'; readonly reason: 'comments_truncated' };

function parseParkFields(body: string): BoardMergeHoldParkV1 | undefined {
  const category = field(body, 'Category');
  const nonBlocking = field(body, 'Non-blocking');
  const reason = field(body, 'Reason');
  if (!isAutopilotParkCategory(category) || nonBlocking !== 'true' || reason === null || reason === '') return undefined;
  return Object.freeze({ category, reason });
}

function activeMergeHolds(page: BoardCommentPageV1, released: string | undefined) {
  return protocolComments(page, MERGE_HOLD_HEADER).filter(record => released === undefined || record.created_at >= released);
}

/** A visible active hold needs the older page to rule out another hold on the same thread. */
export function mergeHoldNeedsFullThread(page: BoardCommentPageV1): boolean {
  if (!page.truncated) return false;
  const released = newestProtocolComment(page, MERGE_HOLD_RELEASED_HEADER)?.created_at;
  return activeMergeHolds(page, released).length > 0;
}

/**
 * Every hold of one thread stays in force until a strictly newer release on
 * that thread. A release with the same time as a hold does not end it, so an
 * unknown order fails closed. On a truncated read, every omitted comment is
 * at or before the oldest comment read, so only a release strictly after
 * that boundary ends the omitted holds. `scoped` reads the `Issues:` line
 * (the parent).
 */
export function readMergeHold(page: BoardCommentPageV1, scoped: boolean): BoardMergeHoldV1 {
  const released = newestProtocolComment(page, MERGE_HOLD_RELEASED_HEADER)?.created_at;
  const boundary = page.comments.map(comment => comment.created_at).sort()[0];
  if (page.truncated && (released === undefined || boundary === undefined || released <= boundary)) return { status: 'unknown', reason: 'comments_truncated' };
  const holds = activeMergeHolds(page, released)
    .map((record) => {
      const line = record.body.replace(/\r\n/gu, '\n').split('\n').find(entry => entry.startsWith('Issues: '));
      const issues = !scoped || line === undefined ? [] : [...line.matchAll(/#([1-9][0-9]*)/gu)].map(match => Number(match[1]));
      const park = line === undefined ? parseParkFields(record.body) : undefined;
      return Object.freeze({
        comment_url: record.url,
        issues: issues.length === 0 ? null : Object.freeze(issues),
        ...(park === undefined ? {} : { park }),
      });
    });
  return holds.length === 0 ? { status: 'none' } : { status: 'held', holds: Object.freeze(holds) };
}

export type BoardMergeRefusalV1 =
  | 'acceptance_merge_off'
  | 'plan_unavailable'
  | 'draft'
  | 'item_off_board'
  | 'held'
  | 'hold_unknown'
  | 'autopilot_park_required'
  | 'plan_hold'
  | 'not_in_merge_order'
  | 'merge_order'
  | 'not_accepted'
  | 'required_check'
  | 'not_ready';

export type BoardMergeDecisionV1 =
  | { readonly pr: number; readonly eligible: true }
  | { readonly pr: number; readonly eligible: false; readonly reason: BoardMergeRefusalV1; readonly detail: string };

/** All threads whose hold can cover the pull request. A direct park on the parent covers the parent itself. */
function prHoldThreads(board: BoardV1, pr: BoardPullRequestV1, items: readonly number[]) {
  const parent = board.merge_hold;
  return [
    { where: `parent #${board.parent.number}`, hold: parent, records: parent.status === 'held' ? parent.holds.filter(record =>
      record.issues === null ? board.autopilot === undefined || record.park === undefined : record.issues.some(number => items.includes(number))) : [] },
    ...board.items.filter(item => items.includes(item.number)).map(item => ({ where: `issue #${item.number}`, hold: item.merge_hold,
      records: item.merge_hold.status === 'held' ? item.merge_hold.holds : [] })),
    { where: `PR #${pr.number}`, hold: pr.merge_hold, records: pr.merge_hold.status === 'held' ? pr.merge_hold.holds : [] },
  ];
}

export function prHasCommentHold(board: BoardV1, pr: BoardPullRequestV1): boolean {
  return prHoldThreads(board, pr, [...pr.closes, ...pr.refs]).some(thread => thread.records.length > 0);
}

/** The skip reason of a rule that needs an observed plan: the plan is absent, or it is unavailable. */
export function planSkipReason(status: BoardV1['plan']['status']): 'plan_absent' | 'plan_unavailable' {
  return status === 'absent' ? 'plan_absent' : 'plan_unavailable';
}

/**
 * The plan's refusal of a pull request, shared by `board merge` and `board review`: the plan does not decode, the plan is
 * absent on a parent with more than two children, or the plan holds an issue that the pull request links. A parent with two
 * children or fewer needs no plan (`orchestrator.md` §4), so its absent plan refuses nothing.
 */
export function planRefusal(board: BoardV1, pr: BoardPullRequestV1): { readonly reason: 'plan_unavailable' | 'plan_hold'; readonly detail: string } | null {
  // An unavailable plan keeps the decode error of its newest plan comment, so the reader
  // learns why the block does not decode without a second read of that comment.
  if (board.plan.status === 'unavailable') return { reason: 'plan_unavailable', detail: `the plan is unavailable: ${board.plan.reason}` };
  if (board.plan.status === 'absent') {
    // `items` holds every sub-issue of the parent, open and closed.
    const children = board.items.length;
    if (children <= 2) return null;
    return { reason: 'plan_unavailable', detail: `the plan is absent and #${board.parent.number} has ${children} children; a parent with more than two children needs a plan` };
  }
  const linked = new Set([...pr.closes, ...pr.refs]);
  const hold = board.plan.block.holds.find(entry => entry.issue !== board.parent.number && linked.has(entry.issue));
  return hold === undefined ? null : { reason: 'plan_hold', detail: `the plan holds #${hold.issue}: ${hold.reason}` };
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

function issueIsParked(board: BoardV1, item: BoardItemV1): boolean {
  if (item.merge_hold.status === 'unknown' || board.merge_hold.status === 'unknown') return false;
  if (board.plan.status === 'observed' && board.plan.block.holds.some(hold => hold.issue === item.number)) return false;
  const own = item.merge_hold.status === 'held' ? item.merge_hold.holds : [];
  const parent = board.merge_hold.status === 'held' ? board.merge_hold.holds.filter(record => record.park === undefined
    && (record.issues === null || record.issues.includes(item.number))) : [];
  if (parent.length > 0 || own.some(record => record.park === undefined)) return false;
  const prs = board.pull_requests.filter(pr => pr.state === 'open' && item.pull_requests.includes(pr.number));
  if (prs.length === 0) return isOnlyParked(own);
  return prs.every(pr => {
    if (planRefusal(board, pr) !== null) return false;
    const threads = prHoldThreads(board, pr, [...pr.closes, ...pr.refs]);
    return threads.every(thread => thread.hold.status !== 'unknown') && isOnlyParked(threads.flatMap(thread => thread.records));
  });
}

export interface BoardBlockerRefV1 {
  readonly repository: string;
  readonly number: number;
}

type BoardBlockerNode = { readonly state: 'open' | 'closed'; readonly blocked_by: readonly BoardIssueDependencyV1[] };

export interface BoardExternalBlockerV1 extends BoardBlockerRefV1, BoardBlockerNode {
  readonly parked: boolean;
}

export function blockerKey(ref: BoardBlockerRefV1): string {
  return `${ref.repository.toLowerCase()}#${ref.number}`;
}

/** Visit each reachable open dependency once, even if the graph crosses repositories or has a cycle. */
export function reachableOpenBlockers(
  repository: string,
  seeds: readonly number[],
  lookup: (ref: BoardBlockerRefV1) => BoardBlockerNode | undefined,
): ReadonlyMap<string, BoardBlockerRefV1> {
  const seen = new Set<string>();
  const blockers = new Map<string, BoardBlockerRefV1>();
  const follow = (ref: BoardBlockerRefV1, node: BoardBlockerNode | undefined): BoardBlockerRefV1[] =>
    (node?.blocked_by ?? []).filter(edge => edge.state === 'open').map(edge => ({ repository: edge.repository ?? ref.repository, number: edge.number }));
  const pending = seeds.flatMap(number => {
    const ref = { repository, number };
    return follow(ref, lookup(ref));
  });
  while (pending.length > 0) {
    const ref = pending.pop()!;
    const key = blockerKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const node = lookup(ref);
    if (node?.state === 'closed') continue;
    blockers.set(key, ref);
    pending.push(...follow(ref, node));
  }
  return blockers;
}

function inlineText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return 'children' in node ? node.children.map(inlineText).join('') : '';
}

function rollbackInstruction(text: string, section: string): boolean {
  const explicit = /(?:^|\n)[ \t]*Rollback:[ \t]*([^\n]*)/iu.exec(text)?.[1];
  const inline = section === 'risk and rollback' ? /\bRollback:[ \t]*([^\n]*)/iu.exec(text)?.[1] : undefined;
  const instruction = (explicit ?? inline ?? (section === 'rollback' ? text : '')).trim();
  return /[\p{L}\p{N}]/u.test(instruction)
    && !/^(?:<[^>]+>[.!]?$|(?:tbd|none|n\/?a|todo|not applicable|no rollback)\b)/iu.test(instruction);
}

function executedVerification(paragraph: Paragraph): boolean {
  const at = paragraph.children.findIndex(child => child.type === 'inlineCode' && child.value.trim() !== '');
  if (at < 0) return false;
  const outcome = paragraph.children.slice(at + 1).map(inlineText).join('').trimStart().replace(/^[:–—-]\s*/u, '');
  return /^(?:pass(?:ed)?\b|success(?:ful)?\b|succeeded\b|ok\b|exit(?: code| status)?[: ]+0\b|[1-9][0-9]*\s+(?:tests?\s+)?pass(?:ed)?\b|[1-9][0-9]*\/[1-9][0-9]*\b)/iu.test(outcome);
}

/** Read the rollback instruction and recorded successful commands from the PR body template. */
export function prMergeNotes(body: string): { readonly rollback: boolean; readonly verification: boolean } {
  let section = '';
  let rollback = false;
  let verification = false;
  for (const node of fromMarkdown(body).children) {
    if (node.type === 'heading' && node.depth <= 2) section = inlineText(node).trim().toLowerCase();
    if (node.type === 'paragraph') rollback ||= rollbackInstruction(inlineText(node), section);
    if (section === 'verification' && node.type === 'list') {
      verification ||= node.children.some(item => item.children.some(paragraph => paragraph.type === 'paragraph' && executedVerification(paragraph)));
    }
  }
  return { rollback, verification };
}

/** The board's explicit owner boundaries use both sides of renames and the existing credential label and High list. */
export function autopilotParkRequirement(
  paths: readonly string[] | null,
  touchesCredentials: boolean,
): BoardMergeHoldParkV1 | null {
  if (touchesCredentials) return { category: 'high_security_uncertain', reason: 'Decide the I1 scope for this credential item.' };
  if (paths === null) return { category: 'high_security_uncertain', reason: 'Confirm the changed paths and their owner boundary.' };
  const hits = pathHighHits(paths);
  const security = hits.filter(hit => hit.signal === 'secrets' || hit.signal === 'deletion');
  if (security.length > 0) {
    const affected = security.map(hit => `${hit.path} (${hit.signal})`).join(', ');
    return { category: 'high_security_uncertain', reason: `Decide the I1/I2 scope for ${affected}.` };
  }
  const release = hits.filter(hit => hit.signal === 'release');
  return release.length === 0 ? null : {
    category: 'deployment_request', reason: `Decide production publication for ${release.map(hit => hit.path).join(', ')}.`,
  };
}

function commentHoldRefusal(board: BoardV1, pr: BoardPullRequestV1, items: readonly number[]): {
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

function mergeOrderRefusal(
  board: BoardV1,
  pr: BoardPullRequestV1,
  items: readonly number[],
  onBoard: ReadonlyMap<number, BoardItemV1>,
): { readonly reason: 'plan_unavailable' | 'plan_hold' | 'not_in_merge_order' | 'merge_order'; readonly detail: string } | null {
  if (board.plan.status === 'observed') {
    const plan = board.plan.block;
    const planHold = planRefusal(board, pr);
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
    const external = new Map(board.autopilot_external_blockers?.map(blocker => [blockerKey(blocker), blocker] as const));
    const local = (ref: BoardBlockerRefV1): BoardItemV1 | undefined => ref.repository.toLowerCase() === board.repository.toLowerCase()
      ? onBoard.get(ref.number) : undefined;
    const blockers = board.autopilot === undefined ? null : reachableOpenBlockers(board.repository, open.length > 0 ? open : items,
      ref => local(ref) ?? external.get(blockerKey(ref)));
    const earlier = units.slice(0, prUnit).flatMap(unit => {
      const pending = unit.filter(number => onBoard.get(number)?.state !== 'closed');
      if (blockers === null || pending.length === 0) return pending;
      const stacks = board.pull_requests.some(other => other.state === 'open' && other.head_ref === pr.base_ref
        && pending.some(number => onBoard.get(number)?.pull_requests.includes(other.number)));
      return !stacks && pending.every(number => {
        const item = onBoard.get(number);
        return !blockers.has(blockerKey({ repository: board.repository, number })) && item !== undefined && issueIsParked(board, item);
      }) ? [] : pending;
    });
    if (earlier.length > 0) return { reason: 'merge_order', detail: `earlier in merge_order and not closed: ${earlier.map(number => `#${number}`).join(' ')}` };
    for (const [key, ref] of blockers ?? []) {
      const item = local(ref);
      const observed = external.get(key);
      if (item === undefined && observed === undefined) return { reason: 'merge_order', detail: `no park state for blocker ${ref.repository}#${ref.number}` };
      if (item === undefined ? observed?.parked : issueIsParked(board, item)) {
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

function refusal(board: BoardV1, pr: BoardPullRequestV1): { readonly reason: BoardMergeRefusalV1; readonly detail: string } | null {
  if (board.acceptance_merge !== 'on') return { reason: 'acceptance_merge_off', detail: `publication.acceptance_merge is ${board.acceptance_merge} on ${board.default_branch}` };
  if (board.plan.status !== 'observed') {
    const refused = planRefusal(board, pr);
    if (refused !== null) return refused;
  }
  if (pr.is_draft) return { reason: 'draft', detail: `#${pr.number} is a draft` };
  const onBoard = new Map(board.items.map(item => [item.number, item] as const));
  const linked = [...new Set([...pr.closes, ...pr.refs])].filter(number => number !== board.parent.number).sort((left, right) => left - right);
  // An issue outside the board has no observed state, holds or plan position, so it fails closed.
  const offBoard = linked.filter(number => !onBoard.has(number));
  if (offBoard.length > 0) return { reason: 'item_off_board', detail: `${offBoard.map(number => `#${number}`).join(' ')} not a sub-issue of #${board.parent.number}` };
  // A board PR always links an item of the parent (`linkedPullRequests`), so `items` is never empty.
  const items = linked;
  const holdRefusal = commentHoldRefusal(board, pr, items);
  if (holdRefusal !== null) return holdRefusal;
  if (board.autopilot !== undefined) {
    const park = pr.autopilot_merge?.required_park;
    if (park !== undefined && park !== null) return { reason: 'autopilot_park_required', detail: `Park #${pr.number} [${park.category}]. ${park.reason}` };
  }
  const orderRefusal = mergeOrderRefusal(board, pr, items, onBoard);
  if (orderRefusal !== null) return orderRefusal;
  const lowSkipAllowed = board.autopilot?.low_tier_skip === true && pr.tier === 'low';
  if (pr.acceptance.status !== 'accepted' || (pr.acceptance.via === 'tier_low' && !lowSkipAllowed)) {
    return { reason: 'not_accepted', detail: `#${pr.number} has no PASS acceptance record for ${pr.head_sha.slice(0, 9)} (${pr.acceptance.status === 'accepted' ? pr.acceptance.via : pr.acceptance.status})` };
  }
  if (board.autopilot !== undefined && pr.autopilot_merge?.rollback !== true) {
    return { reason: 'not_ready', detail: `#${pr.number} has no rollback instruction in its PR body` };
  }
  if (pr.required_check.status !== 'success') return { reason: 'required_check', detail: requiredCheckDetail(pr.required_check) };
  if (pr.merge_readiness?.ready !== true) {
    return { reason: 'not_ready', detail: `readiness blockers: ${pr.merge_readiness?.blockers.map(blocker => blocker.code).join(', ') || 'none observed'}` };
  }
  return null;
}

/** The newest active park on this thread, using the same release and write-access rules as merge. */
export function readParkedItem(kind: AutopilotParkedItemV1['kind'], number: number, comments: BoardCommentPageV1): AutopilotParkedItemV1 | null {
  const hold = readMergeHold(comments, true);
  if (hold.status !== 'held') return null;
  const park = hold.holds.filter(record => record.park !== undefined).at(-1)?.park;
  return park === undefined ? null : { kind, number, ...park };
}

/** One decision for each open pull request, in plan unit order when the plan is observed, else by number; blocked-by order is a refusal. */
export function boardMergeDecisions(board: BoardV1): BoardMergeDecisionV1[] {
  const units = board.plan.status === 'observed' ? planOrderUnits(board.plan.block) : [];
  const rank = (pr: BoardPullRequestV1): number => {
    const positions = [...pr.closes, ...pr.refs].map(number => units.findIndex(unit => unit.includes(number))).filter(index => index >= 0);
    return positions.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...positions);
  };
  return board.pull_requests.filter(pr => pr.state === 'open')
    .sort((left, right) => rank(left) - rank(right) || left.number - right.number)
    .map((pr) => {
      const refused = refusal(board, pr);
      return refused === null ? { pr: pr.number, eligible: true } : { pr: pr.number, eligible: false, ...refused };
    });
}
