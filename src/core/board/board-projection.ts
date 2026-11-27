import { isCiRepairIssueBody } from '../ci/test-report';
import { isAutopilotEnabled, type AutopilotMergeGateV1 } from './autopilot';
import { CREDENTIALS_LABEL } from './dispatch';
import { autopilotParkRequirement, prMergeNotes, readMergeHold } from './merge';
import {
  acceptance,
  clearedHazardPaths,
  effectiveTier,
  gatekeeperReview,
  requiredCheck,
  reviewFail,
  reviewRecords,
  reviewRule,
  secondReview,
  tierOf,
  writerFamily,
  type BoardTier,
} from './review-rules';
import {
  issueClaim,
  newestProtocolComment,
  openQuestions,
  parseClaimStatus,
  writerCompletion,
  type BoardCommentPageV1,
  type BoardParentReadV1,
  type BoardPullRequestReadV1,
  type BoardSubIssueReadV1,
} from './source';
import type {
  BoardClaimStatusV1,
  BoardDailyRunInputV1,
  BoardDailyRunV1,
  BoardInputV1,
  BoardItemV1,
  BoardPathOwnersV1,
  BoardPullRequestV1,
} from './board';

const CLAIM_STATUS_HEADER = 'repo-harness issue claim status';

function claimStatus(issue: BoardSubIssueReadV1): BoardClaimStatusV1 {
  const comment = newestProtocolComment(issue.comments, CLAIM_STATUS_HEADER);
  const status = comment === null ? null : parseClaimStatus(comment);
  if (status !== null) return { status_kind: 'observed', ...status };
  return issue.comments.truncated ? { status_kind: 'unknown' } : { status_kind: 'none' };
}

export function projectBoardCollections(
  input: BoardInputV1,
  linkedReads: readonly BoardPullRequestReadV1[],
  linksFor: (read: BoardPullRequestReadV1) => { readonly closes: number[]; readonly refs: number[] },
): {
  readonly autopilot: AutopilotMergeGateV1 | undefined;
  readonly pullRequests: BoardPullRequestV1[];
  readonly items: BoardItemV1[];
  readonly daily: BoardDailyRunV1;
} {
  const autopilot: AutopilotMergeGateV1 | undefined = input.autopilot != null && isAutopilotEnabled(input.autopilot)
    ? Object.freeze({ low_tier_skip: input.autopilot.low_tier_skip }) : undefined;
  const tiers = new Map(input.parent.sub_issues.map(issue => [issue.number, tierOf(issue.labels)] as const));
  const pullRequests = projectBoardPullRequests(linkedReads, linksFor, input, tiers, autopilot);
  const items = projectBoardItems(input.parent.sub_issues, tiers, pullRequests, input.hold_comments);
  const daily = projectBoardDailyRun(input.daily_run, input.parent.repair_candidates);
  return { autopilot, pullRequests, items, daily };
}

function projectBoardPullRequests(
  reads: readonly BoardPullRequestReadV1[],
  linksFor: (read: BoardPullRequestReadV1) => { readonly closes: number[]; readonly refs: number[] },
  input: BoardInputV1,
  tiers: ReadonlyMap<number, BoardTier | null>,
  autopilot: AutopilotMergeGateV1 | undefined,
): BoardPullRequestV1[] {
  const pullRequests = reads
    .map(read => projectBoardPullRequest(read, linksFor(read), input, tiers, autopilot))
    .sort((left, right) => left.number - right.number);
  assertBoardPathOwners(input.path_owners, pullRequests);
  return pullRequests;
}

function projectBoardItems(
  issues: readonly BoardSubIssueReadV1[],
  tiers: ReadonlyMap<number, BoardTier | null>,
  pullRequests: readonly BoardPullRequestV1[],
  holdComments: ReadonlyMap<number, BoardCommentPageV1> | undefined,
): BoardItemV1[] {
  return issues
    .map(issue => projectBoardItem(issue, tiers, pullRequests, holdComments))
    .sort((left, right) => left.number - right.number);
}

function projectBoardPullRequest(
  read: BoardPullRequestReadV1,
  links: { readonly closes: number[]; readonly refs: number[] },
  input: BoardInputV1,
  tiers: ReadonlyMap<number, BoardTier | null>,
  autopilot: AutopilotMergeGateV1 | undefined,
): BoardPullRequestV1 {
  const { closes, refs } = links;
  const required = input.required_contexts.get(read.base_ref);
  if (required === undefined) throw new Error(`board input has no required contexts for base ${read.base_ref} of PR #${read.number}`);
  const check = requiredCheck(read, required);
  const tier = effectiveTier(read, closes, refs, input.parent, tiers, input.review_evidence);
  const rule = reviewRule(read, tier, autopilot);
  const second = secondReview(read, tier, autopilot);
  const notes = autopilot === undefined || read.state !== 'open' ? null : prMergeNotes(read.body);
  const renameSources = input.review_evidence.pull_requests.get(read.number)?.rename_sources;
  const requiredPark = notes === null ? null : autopilotParkRequirement(
    read.files === null || renameSources == null ? null : [...read.files, ...renameSources],
    input.parent.sub_issues.some(issue => (closes.includes(issue.number) || refs.includes(issue.number)) && issue.labels.includes(CREDENTIALS_LABEL)),
  );
  const readiness = read.state === 'open' ? input.readiness.find(entry => entry.readiness.pr_number === read.number) : undefined;
  if (read.state === 'open' && readiness === undefined) throw new Error(`board input has no merge readiness for open PR #${read.number}`);
  return Object.freeze({
    number: read.number,
    url: read.url,
    state: read.state,
    is_draft: read.is_draft,
    base_ref: read.base_ref,
    base_sha: read.base_sha,
    head_ref: read.head_ref,
    head_sha: read.head_sha,
    head_committed_at: read.head_committed_at,
    merged_at: read.merged_at,
    closes: Object.freeze(closes),
    refs: Object.freeze(refs),
    files: read.files,
    cleared_hazard_paths: Object.freeze([...clearedHazardPaths(read, input.review_evidence)]),
    required_check: check,
    // An issue outside this board has no observed tier, so it withholds the Low path; so does any non-Low linked issue.
    acceptance: acceptance(read, check, [tier], rule, notes?.verification),
    review_fail: reviewFail(read),
    review_records: reviewRecords(read),
    open_questions: openQuestions(read.comments),
    merge_readiness: readiness?.readiness ?? null,
    merge_readiness_observed_at: readiness?.observed_at ?? null,
    tier,
    second_review: second,
    gatekeeper_review: gatekeeperReview(read, autopilot === undefined),
    writer_family: writerFamily(read, closes, refs, input.parent),
    merge_hold: readMergeHold(input.hold_comments?.get(read.number) ?? read.comments, false),
    ...(notes === null ? {} : { autopilot_merge: Object.freeze({ required_park: requiredPark, rollback: notes.rollback }) }),
  });
}

function projectBoardItem(
  issue: BoardSubIssueReadV1,
  tiers: ReadonlyMap<number, BoardTier | null>,
  pullRequests: readonly BoardPullRequestV1[],
  holdComments: ReadonlyMap<number, BoardCommentPageV1> | undefined,
): BoardItemV1 {
  return Object.freeze({
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    labels: issue.labels,
    tier: tiers.get(issue.number) ?? null,
    milestone: issue.milestone,
    blocked_by: issue.blocked_by,
    claim: issueClaim(issue.comments, issue.number),
    claim_status: claimStatus(issue),
    writer_completion: writerCompletion(issue.comments, issue.number),
    open_questions: openQuestions(issue.comments),
    pull_requests: Object.freeze(pullRequests.filter(pr => pr.closes.includes(issue.number) || pr.refs.includes(issue.number)).map(pr => pr.number)),
    merge_hold: readMergeHold(holdComments?.get(issue.number) ?? issue.comments, false),
  });
}

function assertBoardPathOwners(pathOwners: BoardPathOwnersV1, pullRequests: readonly BoardPullRequestV1[]): void {
  if (pathOwners.status !== 'observed') return;
  const owned = new Set(pathOwners.owners.map(owner => owner.path));
  const missing = pullRequests.filter(pr => pr.state === 'open').flatMap(pr => pr.files ?? []).find(path => !owned.has(path));
  if (missing !== undefined) throw new Error(`board input has no path owner for ${missing}`);
}

function projectBoardDailyRun(
  dailyRun: BoardDailyRunInputV1,
  repairCandidates: BoardParentReadV1['repair_candidates'],
): BoardDailyRunV1 {
  return dailyRun.status === 'unavailable' ? dailyRun : {
    ...dailyRun,
    open_repair_issues: Object.freeze(repairCandidates.filter(issue => isCiRepairIssueBody(issue.body)).map(issue => issue.number).sort((left, right) => left - right)),
  };
}
