import { GITHUB_REPOSITORY } from './github-repository';
import { isMergePark } from './merge';
import type { BoardGatekeeperReviewV1, BoardSecondReviewV1 } from './review-rules';
import type { BoardAcceptanceMergeV1, BoardItemV1, BoardPullRequestV1, BoardV1 } from './board';

const SECOND_REVIEWS: ReadonlySet<unknown> = new Set<BoardSecondReviewV1>(['not_required', 'pending', 'recorded']);

const GATEKEEPER_REVIEWS: ReadonlySet<unknown> = new Set<BoardGatekeeperReviewV1>(['pass', 'fail', 'none', 'unknown']);

export const SWITCH_VALUES: ReadonlySet<unknown> = new Set<BoardAcceptanceMergeV1>(['off', 'on', 'unknown']);

const isBoardRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isTime = (value: unknown): boolean => typeof value === 'string' && !Number.isNaN(Date.parse(value));

function isIssueClaim(value: unknown): boolean {
  if (!isBoardRecord(value)) return false;
  if (value.status === 'none' || value.status === 'unknown') return true;
  return value.status === 'active' && typeof value.url === 'string' && isTime(value.created_at) && (value.role === null || typeof value.role === 'string')
    && (value.branch === null || typeof value.branch === 'string')
    && (value.bundle === null || (Array.isArray(value.bundle) && value.bundle.length > 1 && value.bundle.every(number => Number.isSafeInteger(number) && number > 0)));
}

function isWriterCompletion(value: unknown): boolean {
  return value === null || (isBoardRecord(value) && Number.isSafeInteger(value.pr) && (value.pr as number) > 0
    && typeof value.head_sha === 'string' && /^[0-9a-f]{7,40}$/u.test(value.head_sha)
    && (value.branch === null || typeof value.branch === 'string'));
}

function isReviewRecords(value: unknown): boolean {
  if (!isBoardRecord(value)) return false;
  if (value.status === 'unknown') return value.reason === 'comments_truncated' || value.reason === 'acceptance_record_unparsed';
  return value.status === 'observed' && [value.gatekeeper, value.reviewer].every(time => time === null || isTime(time))
    && isBoardRecord(value.head) && typeof value.head.gatekeeper === 'boolean' && typeof value.head.reviewer === 'boolean';
}

function isOpenQuestions(value: unknown): boolean {
  if (!isBoardRecord(value)) return false;
  if (value.status === 'unknown') return true;
  return value.status === 'observed' && Array.isArray(value.questions)
    && value.questions.every((question: unknown) => isBoardRecord(question) && typeof question.url === 'string' && isTime(question.created_at));
}

function isSeatLiveness(value: unknown): boolean {
  if (!isBoardRecord(value)) return false;
  if (value.status === 'unavailable') return typeof value.reason === 'string';
  return value.status === 'observed' && Array.isArray(value.probes) && value.probes.every((probe: unknown) => isBoardRecord(probe) && typeof probe.address === 'string'
    && (probe.status_ms === null || Number.isSafeInteger(probe.status_ms)) && Number.isSafeInteger(probe.turn) && Number.isSafeInteger(probe.children) && (probe.children as number) >= 0
    && (probe.screen_hash === null || (typeof probe.screen_hash === 'string' && /^[0-9a-f]{64}$/u.test(probe.screen_hash))));
}

function isBlockerEdge(value: unknown): boolean {
  return isBoardRecord(value) && typeof value.number === 'number' && Number.isSafeInteger(value.number) && value.number > 0
    && (value.state === 'open' || value.state === 'closed')
    && (value.repository === undefined || (typeof value.repository === 'string' && GITHUB_REPOSITORY.test(value.repository)));
}

function isExternalBlocker(value: unknown): boolean {
  return isBoardRecord(value) && isBlockerEdge(value) && typeof value.repository === 'string' && typeof value.parked === 'boolean'
    && Array.isArray(value.blocked_by) && value.blocked_by.every(isBlockerEdge);
}

export function validateBoardEnvelope(board: Partial<BoardV1>): void {
  if (board.plan?.status === 'observed') {
    const { revision } = board.plan;
    if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error(`invalid board plan revision: ${String(revision)}`);
  }
  if (!isSeatLiveness(board.seat_liveness)) throw new Error('invalid board seat_liveness');
  if (board.autopilot !== undefined && (!isBoardRecord(board.autopilot) || typeof board.autopilot.low_tier_skip !== 'boolean')) throw new Error('invalid board autopilot');
  const external: unknown = board.autopilot_external_blockers;
  if (external !== undefined && (!Array.isArray(external) || !external.every(isExternalBlocker))) throw new Error('invalid board autopilot_external_blockers');
}

export function validateBoardItems(items: readonly BoardItemV1[]): void {
  for (const item of items) {
    if (!isIssueClaim(item.claim)) throw new Error(`invalid board claim on #${item.number}`);
    if (!isWriterCompletion(item.writer_completion)) throw new Error(`invalid board writer_completion on #${item.number}`);
    if (!isOpenQuestions(item.open_questions)) throw new Error(`invalid board open_questions on #${item.number}`);
  }
}

export function validateBoardPullRequests(pullRequests: readonly BoardPullRequestV1[], autopilotEnabled: boolean): void {
  for (const pr of pullRequests) {
    if (!isOpenQuestions(pr.open_questions)) throw new Error(`invalid board open_questions on PR #${pr.number}`);
    const merge: unknown = pr.autopilot_merge;
    if (autopilotEnabled && pr.state === 'open' && !(isBoardRecord(merge) && typeof merge.rollback === 'boolean'
      && (merge.required_park === null || isMergePark(merge.required_park)))) throw new Error(`invalid board autopilot_merge on PR #${pr.number}`);
    const fail: unknown = pr.review_fail;
    if (fail !== null && !(isBoardRecord(fail) && typeof fail.url === 'string' && isTime(fail.recorded_at))) throw new Error(`invalid board review_fail on PR #${pr.number}`);
    const cleared: unknown = pr.cleared_hazard_paths;
    if (!Array.isArray(cleared) || !cleared.every(path => typeof path === 'string')) throw new Error(`invalid board cleared_hazard_paths on PR #${pr.number}`);
    if (!SECOND_REVIEWS.has(pr.second_review)) throw new Error(`invalid board second_review on PR #${pr.number}`);
    if (!GATEKEEPER_REVIEWS.has(pr.gatekeeper_review)) throw new Error(`invalid board gatekeeper_review on PR #${pr.number}`);
    if (!isReviewRecords(pr.review_records)) throw new Error(`invalid board review_records on PR #${pr.number}`);
    const observedAt: unknown = pr.merge_readiness_observed_at;
    if (pr.merge_readiness === null ? observedAt !== null : typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
      throw new Error(`invalid board merge_readiness_observed_at on PR #${pr.number}: ${String(observedAt)}`);
    }
  }
}
