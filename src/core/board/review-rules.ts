import { PROJECTION_WRITER_DEFAULT_BRANCH } from 'archctx-contracts';
import { documentationOnly } from '../ci/documentation-path';
import { modelFamily } from '../review/model-family';
import { pathHighHits, pathSecondReviewHits } from './hazards';
import {
  ACCEPTANCE_DISPOSITION_HEADER,
  BoardSourceError,
  commentId,
  field,
  newestProtocolComment,
  parseAcceptanceDisposition,
  parseAcceptanceRecord,
  parseRecordFindings,
  protocolComments,
  type BoardCommentV1,
  type BoardParentReadV1,
  type BoardPullRequestReadV1,
  type BoardRollupContextV1,
  type AcceptanceDispositionV1,
  type AcceptanceRowV1,
} from './source';

export type BoardTier = 'low' | 'medium' | 'high';
const TIER_LABELS: Readonly<Record<string, BoardTier>> = { 'tier:low': 'low', 'tier:medium': 'medium', 'tier:high': 'high' };
const CLAIM_HEADER = 'repo-harness issue claim';
export const ACCEPTANCE_RECORD_HEADER = 'repo-harness acceptance record';
const ACCEPTANCE_CLAIM_HEADER = 'repo-harness acceptance claim';

/** One required status context of the base protection and the state of its newest check run on the head. */
export interface BoardRequiredContextV1 {
  readonly name: string;
  readonly status: 'success' | 'failure' | 'pending' | 'missing';
}

/**
 * The join of every required context: `missing` when one has no run, else `pending` when one is not complete, else `failure` when one
 * failed, else `success`. `completed_at` is the newest completion of the failed runs, or of all runs on success. `unavailable`: the
 * protection read of the base gave no context list.
 */
export type BoardRequiredCheckV1 =
  | { readonly status: 'success' | 'failure'; readonly completed_at: string; readonly contexts: readonly BoardRequiredContextV1[] }
  | { readonly status: 'pending' | 'missing'; readonly contexts: readonly BoardRequiredContextV1[] }
  | { readonly status: 'unavailable'; readonly reason: string };

/** The required status contexts of one base branch, from the `required_status_checks.contexts` of its protection read. */
export type BoardRequiredContextsV1 =
  | { readonly status: 'observed'; readonly contexts: readonly string[] }
  | { readonly status: 'unavailable'; readonly reason: string };

export type BoardAcceptanceV1 =
  /**
   * `record`: an acceptance record has a PASS row for the head and no record has a FAIL row for it; an open High or unknown-tier pull request
   * also needs PASS rows of two distinct claims, one recorded `different-family`; an open Medium one needs one claimed PASS row recorded `different-family` (`acceptor.md` section 2.2). `tier_low`: every closed issue is `tier:low` and the required check passed. */
  | { readonly status: 'accepted'; readonly via: 'record' | 'tier_low'; readonly accepted_at: string; readonly evidence_url: string }
  | { readonly status: 'not_accepted' }
  | { readonly status: 'unknown'; readonly reason: 'acceptance_record_unparsed' | 'comments_truncated'; readonly evidence_url: string | null };

export type BoardSecondReviewV1 = 'not_required' | 'pending' | 'recorded';

/**
 * The verdict of `BoardPullRequestV1.gatekeeper_review`, the relay order of the second review (#2910): the reviewer seat starts for this head
 * only after the seat that is not the reviewer reviewed it. `pass`: a `PASS` row of the head that is not the reviewer's, and no unresolved `FAIL`
 * row of the head that is not the reviewer's. `fail`: such a `FAIL` row. `none`: no `PASS` row of the head that is not the reviewer's. `unknown`: an
 * older comment outside the read, or a record without a table row, can change either answer.
 */
export type BoardGatekeeperReviewV1 = 'pass' | 'fail' | 'none' | 'unknown';

/**
 * The comment time of the newest acceptance record with a row of each review seat, any subject SHA; null when no record has one.
 * A row is the reviewer's when the family of its model is `BoardV1.reviewer_family`; any other known family is the gatekeeper's
 * (the gatekeeper, gatekeeper-fallback and gatekeeper-deep seats). A row with no known model belongs to no seat.
 * `unknown`: an older comment outside the read, or a record without a table row, can hold a row of any seat.
 */
export type BoardReviewRecordsV1 =
  | { readonly status: 'observed'; readonly gatekeeper: string | null; readonly reviewer: string | null }
  | { readonly status: 'unknown'; readonly reason: 'comments_truncated' | 'acceptance_record_unparsed' };

/** The model family of a writer, from `modelFamily` on the `Model:` line of its claim. */
export type BoardWriterFamily = string;

/**
 * The head reports of one required name that `gh pr checks` keeps (cli/cli `pkg/cmd/pr/checks/aggregate.go`, `eliminateDuplicates`):
 * the newest commit status of the context by creation, and the newest check run of each workflow name and event by start. A check
 * run and a commit status of one name both stay.
 */
function contextReports(read: BoardPullRequestReadV1, name: string): BoardRollupContextV1[] {
  const kept = new Map<string, BoardRollupContextV1>();
  for (const report of read.readiness_inputs.rollup.filter(context => context.name === name)) {
    const key = report.type === 'StatusContext' ? 'status' : JSON.stringify(['run', report.workflow?.name ?? '', report.workflow?.event ?? '']);
    const current = kept.get(key);
    if (current === undefined || reportTime(report) > reportTime(current)) kept.set(key, report);
  }
  return [...kept.values()];
}

/** A check run that has not started is the oldest of its group, as in `gh pr checks`. */
const reportTime = (report: BoardRollupContextV1): string => (report.type === 'StatusContext' ? report.completed_at : report.started_at) ?? '';

/** The commit status states as the `gh pr checks` bucket that publication readiness reads: pass, pending or fail. */
const STATUS_STATES: ReadonlyMap<string, BoardRequiredContextV1['status']> = new Map([['SUCCESS', 'success'], ['PENDING', 'pending'], ['EXPECTED', 'pending'], ['FAILURE', 'failure'], ['ERROR', 'failure']]);

function reportStatus(report: BoardRollupContextV1): BoardRequiredContextV1['status'] {
  // GitHub defines no other state; one would fail closed.
  if (report.type === 'StatusContext') return STATUS_STATES.get(report.status) ?? 'failure';
  if (report.status !== 'COMPLETED' || report.completed_at === null) return 'pending';
  return report.conclusion === 'SUCCESS' ? 'success' : 'failure';
}

/** The join of the reports of a name, and of the names of a required check: `missing` (or no status), then `pending`, then `failure`, else `success`. */
function joinStatuses(statuses: readonly BoardRequiredContextV1['status'][]): BoardRequiredContextV1['status'] {
  if (statuses.length === 0) return 'missing';
  return (['missing', 'pending', 'failure'] as const).find(status => statuses.includes(status)) ?? 'success';
}

export function requiredCheck(read: BoardPullRequestReadV1, required: BoardRequiredContextsV1): BoardRequiredCheckV1 {
  if (required.status === 'unavailable') return Object.freeze({ status: 'unavailable', reason: required.reason });
  const named = required.contexts.map(name => ({ name, reports: contextReports(read, name) }));
  const contexts = Object.freeze(named.map(({ name, reports }) => Object.freeze({ name, status: joinStatuses(reports.map(reportStatus)) })));
  const status = joinStatuses(contexts.map(context => context.status));
  if (status === 'missing' || status === 'pending') return Object.freeze({ status, contexts });
  const completedAt = named.flatMap(({ reports }) => reports).filter(report => reportStatus(report) === status).map(report => report.completed_at!)
    .reduce((newest, at) => (at > newest ? at : newest));
  return Object.freeze({ status, completed_at: completedAt, contexts });
}

/**
 * A FAIL row that a disposition resolves: the disposition names the row's record and subject and every finding of the record. A PASS
 * row, a record with an unreadable finding, or one unresolved finding keeps the row failing. No time or round supersedes a FAIL row.
 */
function resolvedFail(record: BoardCommentV1, row: AcceptanceRowV1, dispositions: readonly AcceptanceDispositionV1[]): boolean {
  const findings = row.verdict === 'FAIL' ? parseRecordFindings(record) : null;
  if (findings === null) return false;
  const resolved = new Set(dispositions.filter(entry => entry.record === commentId(record.url) && entry.subject_sha === row.subject_sha).flatMap(entry => entry.findings));
  return findings.every(id => resolved.has(id));
}

/** The newest acceptance record with a FAIL row for the head that no disposition resolves, by the test of `acceptance`. An unparsed record has no row. */
export function reviewFail(read: BoardPullRequestReadV1): { readonly url: string; readonly recorded_at: string } | null {
  const dispositions = protocolComments(read.comments, ACCEPTANCE_DISPOSITION_HEADER).flatMap(comment => parseAcceptanceDisposition(comment) ?? []);
  const failing = protocolComments(read.comments, ACCEPTANCE_RECORD_HEADER).filter(record => (parseAcceptanceRecord(record) ?? [])
    .some(row => row.subject_sha === read.head_sha && row.verdict === 'FAIL' && !resolvedFail(record, row, dispositions)));
  const newest = failing.reduce<BoardCommentV1 | null>((latest, record) => (latest === null || record.created_at >= latest.created_at ? record : latest), null);
  return newest === null ? null : Object.freeze({ url: newest.url, recorded_at: newest.created_at });
}

/**
 * The verdict of the rows of the head that are not the reviewer's (`BoardPullRequestV1.gatekeeper_review`). A row is the reviewer's when the
 * family of its model is `reviewerFamily`; every other row of the head, a row with no known model included, counts here, so the relay opens
 * for a head that any other seat reviewed. Only a `PASS` row opens the relay: a `FAIL` row that a disposition resolves stops failing the head,
 * but a cleared failure is no review, so it sets no pass either. A `FAIL` row that no disposition resolves fails the head. With no row of
 * the head, a carried PASS of another seat (`carriedPasses`) opens the relay, so a fix round starts only the seat that failed.
 */
export function gatekeeperReview(read: BoardPullRequestReadV1, reviewerFamily: string | null): BoardGatekeeperReviewV1 {
  if (read.comments.truncated) return 'unknown';
  const dispositions = protocolComments(read.comments, ACCEPTANCE_DISPOSITION_HEADER).flatMap(comment => parseAcceptanceDisposition(comment) ?? []);
  let verdict: BoardGatekeeperReviewV1 = 'none';
  for (const record of protocolComments(read.comments, ACCEPTANCE_RECORD_HEADER)) {
    const rows = parseAcceptanceRecord(record);
    if (rows === null) return 'unknown';
    for (const row of rows.filter(row => row.subject_sha === read.head_sha && (row.model === null || modelFamily(row.model) !== reviewerFamily))) {
      if (row.verdict === 'PASS') verdict = 'pass';
      else if (!resolvedFail(record, row, dispositions)) return 'fail';
    }
  }
  return verdict === 'none' && carriedPasses(read).some(row => modelFamily(row.model!) !== reviewerFamily) ? 'pass' : verdict;
}

/**
 * The round-1 PASS rows that count for the head under the High rule (#3187): in a fix round only the seat that returned FAIL reviews
 * again. Only claimed rows (`claimedRows`) take part, so publication order and unclaimed rows change nothing. The carry needs one
 * round-1 subject with a claimed PASS of one model family and a claimed FAIL of another family and claim. The PASS carries only to the
 * fix head: the one subject of the failing family's claimed round-2 rows, or the head while that family has no round-2 row. It never reaches a later head, and
 * a family with a row of the head carries nothing. Whether the fix stays inside the findings is the orchestrator's scope call.
 */
function carriedPasses(read: BoardPullRequestReadV1): AcceptanceRowV1[] {
  const rows = claimedRows(read, protocolComments(read.comments, ACCEPTANCE_RECORD_HEADER).flatMap(record => parseAcceptanceRecord(record) ?? []));
  const family = (row: AcceptanceRowV1): string | null => (row.model === null ? null : modelFamily(row.model));
  const round1 = rows.filter(row => row.round === 1);
  const answered = (pass: AcceptanceRowV1): boolean => pass.verdict === 'PASS' && family(pass) !== null
    && round1.some(fail => fail.subject_sha === pass.subject_sha && fail.verdict === 'FAIL' && family(fail) !== family(pass) && fail.claim !== pass.claim);
  const subjects = [...new Set(round1.filter(answered).map(row => row.subject_sha))];
  if (subjects.length !== 1) return [];
  const failing = new Set(round1.filter(row => row.subject_sha === subjects[0] && row.verdict === 'FAIL').map(family));
  const fixes = [...new Set(rows.filter(row => row.round === 2 && failing.has(family(row))).map(row => row.subject_sha))];
  const fix = fixes.length === 0 ? read.head_sha : fixes.length === 1 ? fixes[0] : null;
  if (fix !== read.head_sha || fix === subjects[0]) return [];
  const onHead = new Set(protocolComments(read.comments, ACCEPTANCE_RECORD_HEADER).flatMap(record => parseAcceptanceRecord(record) ?? [])
    .filter(row => row.subject_sha === read.head_sha).map(family));
  return round1.filter(row => row.subject_sha === subjects[0] && answered(row) && !onHead.has(family(row)));
}

/** The newest acceptance record of each review seat (`BoardPullRequestV1.review_records`). */
export function reviewRecords(read: BoardPullRequestReadV1, reviewerFamily: string | null): BoardReviewRecordsV1 {
  if (read.comments.truncated) return Object.freeze({ status: 'unknown', reason: 'comments_truncated' });
  const newest = { gatekeeper: '', reviewer: '' };
  for (const record of protocolComments(read.comments, ACCEPTANCE_RECORD_HEADER)) {
    const rows = parseAcceptanceRecord(record);
    if (rows === null) return Object.freeze({ status: 'unknown', reason: 'acceptance_record_unparsed' });
    for (const row of rows) {
      const family = row.model === null ? null : modelFamily(row.model);
      if (family === null) continue;
      const seat = family === reviewerFamily ? 'reviewer' : 'gatekeeper';
      if (record.created_at > newest[seat]) newest[seat] = record.created_at;
    }
  }
  return Object.freeze({ status: 'observed', gatekeeper: newest.gatekeeper || null, reviewer: newest.reviewer || null });
}

export function acceptance(read: BoardPullRequestReadV1, check: BoardRequiredCheckV1, closedTiers: readonly (BoardTier | null)[], rule: ReviewRule): BoardAcceptanceV1 {
  // One round is one subject SHA, and a High round has two reviews of it (`acceptor.md`, section 2): every record counts.
  const records = protocolComments(read.comments, ACCEPTANCE_RECORD_HEADER);
  const passes: BoardCommentV1[] = [];
  const head: AcceptanceRowV1[] = [];
  const dispositions = protocolComments(read.comments, ACCEPTANCE_DISPOSITION_HEADER).flatMap(comment => parseAcceptanceDisposition(comment) ?? []);
  let failed = false;
  for (const record of records) {
    const rows = parseAcceptanceRecord(record);
    if (rows === null) return { status: 'unknown', reason: 'acceptance_record_unparsed', evidence_url: record.url };
    const own = rows.filter(row => row.subject_sha === read.head_sha && !resolvedFail(record, row, dispositions));
    head.push(...own);
    if (own.some(row => row.verdict === 'FAIL')) failed = true;
    else if (own.length > 0) passes.push(record);
  }
  if (!failed && passes.length > 0) {
    // An older comment outside the read can hold a FAIL on the head.
    if (read.comments.truncated) return { status: 'unknown', reason: 'comments_truncated', evidence_url: null };
    if (rule === 'none' || (rule === 'medium' ? mediumRuleMet(read, head) : highRuleMet(read, [...head, ...carriedPasses(read)]))) {
      const newest = passes.reduce((latest, record) => (record.created_at >= latest.created_at ? record : latest));
      return { status: 'accepted', via: 'record', accepted_at: newest.created_at, evidence_url: newest.url };
    }
  }
  if (records.length === 0 && read.comments.truncated) return { status: 'unknown', reason: 'comments_truncated', evidence_url: null };
  // A Low pull request has no accept seat (`agentic-development-flow.md`, Review by risk).
  if (check.status === 'success' && closedTiers.length > 0 && closedTiers.every(tier => tier === 'low')) {
    return { status: 'accepted', via: 'tier_low', accepted_at: check.completed_at, evidence_url: read.url };
  }
  return { status: 'not_accepted' };
}

/**
 * The rows of the head whose `Claim:` cites an `acceptance claim` comment of the pull request with the row's `Subject:` and `Round:`
 * (`review publish` writes both); the comment id is the claim identity.
 */
function claimedRows(read: BoardPullRequestReadV1, head: readonly AcceptanceRowV1[]): AcceptanceRowV1[] {
  const claims = new Map(protocolComments(read.comments, ACCEPTANCE_CLAIM_HEADER).map(claim => [commentId(claim.url), `${field(claim.body, 'Round')} ${field(claim.body, 'Subject')}`] as const));
  return head.filter(row => row.claim !== null && claims.get(row.claim) === `${row.round} ${row.subject_sha}`);
}

/**
 * The High rule (`acceptor.md` section 2.2), for High and unknown tiers: claimed PASS rows of the head from two distinct review claims,
 * and at least one of them recorded `Model relation: different-family` to the writer. An unknown writer family records `unknown`,
 * so it fails closed. A head with a `FAIL` row does not meet the rule.
 */
function highRuleMet(read: BoardPullRequestReadV1, head: readonly AcceptanceRowV1[]): boolean {
  if (head.some(row => row.verdict === 'FAIL')) return false;
  const passes = claimedRows(read, head);
  return new Set(passes.map(row => row.claim)).size >= 2 && passes.some(row => row.different_family);
}

/** The Medium rule (`acceptor.md` section 2.2): one claimed PASS row of the head recorded `different-family`; `unknown` never counts. `acceptance` has ruled out a `FAIL` row. */
function mediumRuleMet(read: BoardPullRequestReadV1, head: readonly AcceptanceRowV1[]): boolean {
  return claimedRows(read, head).some(row => row.different_family);
}

/** The review rule of a pull request: `high` for an open pull request of High or unknown tier, `medium` for an open Medium one, `none` otherwise. */
type ReviewRule = 'high' | 'medium' | 'none';
export function reviewRule(read: BoardPullRequestReadV1, tier: BoardTier | null): ReviewRule {
  if (read.state !== 'open') return 'none';
  return tier === null || tier === 'high' ? 'high' : tier === 'medium' ? 'medium' : 'none';
}

/** The Low bound of a fix in added plus deleted lines (`agentic-development-flow.md`, Review by risk). */
const LOW_FIX_MAX_LINES = 50;

/** Docs only, tests only and the projection pull request are Low at any size; every other change is a fix that the size bound applies to. */
function sizeExempt(read: BoardPullRequestReadV1, files: readonly string[]): boolean {
  return read.head_ref === PROJECTION_WRITER_DEFAULT_BRANCH || documentationOnly(files) || files.every(path => path.startsWith('tests/'));
}

/** The diff evidence of one open pull request that the tier reads beyond its path list. */
export interface BoardPullRequestTierEvidenceV1 {
  /** The source path of each renamed file; null when the PR files read failed. Read only while I3 globs exist. */
  readonly rename_sources: readonly string[] | null;
  /**
   * The modified workflow files whose diff the board read at both commits and proved on the workflow edit allowlist
   * (`workflowEditAllowed`). A failed or incomplete read proves no file, so its `.github/**` hit stays.
   */
  readonly cleared_paths: readonly string[];
}

/** The review evidence of a board read: the I3 globs of the default-branch policy and the diff evidence of each open pull request. */
export interface BoardReviewEvidenceV1 {
  /** `review.i3_paths`; null when the policy read or the value failed. */
  readonly i3_paths: readonly string[] | null;
  readonly pull_requests: ReadonlyMap<number, BoardPullRequestTierEvidenceV1>;
}

/** A closed pull request takes no review, so the board reads no diff evidence for it and its path list alone sets its tier. */
const NO_DIFF_EVIDENCE: BoardPullRequestTierEvidenceV1 = { rename_sources: [], cleared_paths: [] };

/** The paths of a pull request that the workflow edit allowlist cleared; the tier and R3 read the same list. */
export function clearedHazardPaths(read: BoardPullRequestReadV1, evidence: BoardReviewEvidenceV1): readonly string[] {
  return (read.state === 'open' ? evidence.pull_requests.get(read.number) : NO_DIFF_EVIDENCE)?.cleared_paths ?? [];
}

/**
 * The one effective tier of a pull request, for the Low acceptance path and the review planner alike; High takes the second review
 * row (#3190 section 2.3). High, whatever the labels say: a changed path, or the source of a renamed path, on the I1/I2 High-list
 * signals, on a path-visible change hazard (`.github/**`, except a file that the workflow edit allowlist cleared) or on a repository
 * I3 glob. Incomplete evidence can hide such a hit, so it
 * sets High too: an incomplete file list, an I3 list that the board could not read, or no rename sources while I3 globs exist. Any
 * other High-list hit, or a cleared workflow edit, sets at least Medium; R3 and R5 name the labels to fix. Otherwise null
 * unless every linked issue (the parent excluded) is on the board with a tier label. Low labels on a fix of more than 50 changed lines,
 * or of unknown size, give Medium.
 */
export function effectiveTier(read: BoardPullRequestReadV1, closes: readonly number[], refs: readonly number[], parent: BoardParentReadV1, tiers: ReadonlyMap<number, BoardTier | null>, evidence: BoardReviewEvidenceV1): BoardTier | null {
  const files = read.files;
  const diff = read.state === 'open' ? evidence.pull_requests.get(read.number) : NO_DIFF_EVIDENCE;
  const i3 = evidence.i3_paths;
  if (files === null || i3 === null || diff === undefined) return 'high';
  if (i3.length > 0 && diff.rename_sources === null) return 'high';
  if (pathSecondReviewHits([...files, ...(diff.rename_sources ?? [])], i3, diff.cleared_paths).length > 0) return 'high';
  const linked = [...new Set([...closes, ...refs])].filter(number => number !== parent.parent.number);
  const known = linked.map(number => tiers.get(number) ?? null);
  if (linked.length === 0 || known.includes(null)) return null;
  if (known.includes('high')) return 'high';
  if (known.includes('medium') || pathHighHits(files).length > 0 || diff.cleared_paths.length > 0) return 'medium';
  return sizeExempt(read, files) || (read.changed_lines !== null && read.changed_lines <= LOW_FIX_MAX_LINES) ? 'low' : 'medium';
}

/**
 * The second-review state of a pull request: a projection of the High rule, not a second rule. `recorded`: a row of the configured
 * reviewer's model family exists for the head, or carries to it (`carriedPasses`). `pending`: the High rule is not met for the head and no such row exists, so the reviewer
 * seat supplies the missing review. A reviewer with no known family, or a row with no known model, matches no row.
 */
export function secondReview(read: BoardPullRequestReadV1, tier: BoardTier | null, reviewerFamily: string | null): BoardSecondReviewV1 {
  if (reviewRule(read, tier) !== 'high') return 'not_required';
  const head = [...protocolComments(read.comments, ACCEPTANCE_RECORD_HEADER).flatMap(record => parseAcceptanceRecord(record) ?? [])
    .filter(row => row.subject_sha === read.head_sha), ...carriedPasses(read)];
  if (reviewerFamily !== null && head.some(row => row.model !== null && modelFamily(row.model) === reviewerFamily)) return 'recorded';
  return highRuleMet(read, head) ? 'not_required' : 'pending';
}

/**
 * The writer family of a pull request (`BoardPullRequestV1.writer_family`): the one model family of the newest writer claims of the head
 * branch on its linked issues. A bundle links issues without their own claim, so an unclaimed linked issue is ignored. Null when no linked
 * issue has such a claim, when a claim names no known family, when two claims disagree, or when a linked issue is off the board.
 */
export function writerFamily(read: BoardPullRequestReadV1, closes: readonly number[], refs: readonly number[], parent: BoardParentReadV1): BoardWriterFamily | null {
  const issues = new Map(parent.sub_issues.map(issue => [issue.number, issue]));
  const linked = [...new Set([...closes, ...refs])].filter(number => number !== parent.parent.number);
  const families = new Set<string | null>();
  for (const number of linked) {
    const issue = issues.get(number);
    if (issue === undefined) return null;
    const claims = protocolComments(issue.comments, CLAIM_HEADER).filter(claim => field(claim.body, 'Role') === 'writer' && field(claim.body, 'Branch') === read.head_ref);
    if (claims.length === 0) continue;
    const model = field(newestProtocolComment({ ...issue.comments, comments: claims }, CLAIM_HEADER)!.body, 'Model');
    families.add(model === null ? null : modelFamily(model));
  }
  const [family] = families;
  return families.size === 1 && family !== undefined ? family : null;
}

export function tierOf(labels: readonly string[]): BoardTier | null {
  const tiers = [...new Set(labels.flatMap(label => (TIER_LABELS[label] ? [TIER_LABELS[label]] : [])))];
  if (tiers.length > 1) throw new BoardSourceError(`an issue carries more than one tier label: ${tiers.join(', ')}`);
  return tiers[0] ?? null;
}
