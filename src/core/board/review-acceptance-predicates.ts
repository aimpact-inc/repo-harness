import {
  commentId,
  field,
  parseRecordFindings,
  protocolComments,
  type AcceptanceDispositionV1,
  type AcceptanceRowV1,
  type BoardCommentV1,
  type BoardPullRequestReadV1,
} from './source';

export const ACCEPTANCE_CLAIM_HEADER = 'repo-harness acceptance claim';

/**
 * A FAIL row that a disposition resolves: the disposition names the row's record and subject and every finding of the record. A PASS
 * row, a record with an unreadable finding, or one unresolved finding keeps the row failing. No time or round supersedes a FAIL row.
 */
export function resolvedFail(record: BoardCommentV1, row: AcceptanceRowV1, dispositions: readonly AcceptanceDispositionV1[]): boolean {
  const findings = row.verdict === 'FAIL' ? parseRecordFindings(record) : null;
  if (findings === null) return false;
  const resolved = new Set(dispositions.filter(entry => entry.record === commentId(record.url) && entry.subject_sha === row.subject_sha).flatMap(entry => entry.findings));
  return findings.every(id => resolved.has(id));
}

/**
 * The rows of the head whose `Claim:` cites an `acceptance claim` comment of the pull request with the row's `Subject:` and `Round:`
 * (`review publish` writes both); the comment id is the claim identity.
 */
export function claimedRows(read: Pick<BoardPullRequestReadV1, 'comments'>, head: readonly AcceptanceRowV1[]): AcceptanceRowV1[] {
  const claims = new Map(protocolComments(read.comments, ACCEPTANCE_CLAIM_HEADER).map(claim => [commentId(claim.url), `${field(claim.body, 'Round')} ${field(claim.body, 'Subject')}`] as const));
  return head.filter(row => row.claim !== null && claims.get(row.claim) === `${row.round} ${row.subject_sha}`);
}

/**
 * The High rule (`acceptor.md` section 2.2), for High and unknown tiers: claimed PASS rows of the head from two distinct review claims,
 * and at least one of them recorded `Model relation: different-family` to the writer. An unknown writer family records `unknown`,
 * so it fails closed. A head with a `FAIL` row does not meet the rule.
 */
export function highRuleMet(read: BoardPullRequestReadV1, head: readonly AcceptanceRowV1[]): boolean {
  if (head.some(row => row.verdict === 'FAIL')) return false;
  const passes = claimedRows(read, head);
  return new Set(passes.map(row => row.claim)).size >= 2 && passes.some(row => row.different_family);
}

/** The Medium rule (`acceptor.md` section 2.2): one claimed PASS row of the head recorded `different-family`; `unknown` never counts. `acceptance` has ruled out a `FAIL` row. */
export function mediumRuleMet(read: BoardPullRequestReadV1, head: readonly AcceptanceRowV1[]): boolean {
  return claimedRows(read, head).some(row => row.different_family);
}
