import { expect, test } from 'bun:test';
import { groupRuleProposals, observeRuleProposals, parseRuleOpportunity } from '../src/core/ci/rule-proposals';
import { renderInlineComment, reviewPayloadFromReceipt, type ReviewPublishBlockingFinding, type ReviewPublishReceipt } from '../src/core/review/review-publish';

const blocker: ReviewPublishBlockingFinding = {
  id: 'missing-guard', severity: 'P1', path: 'src/guard.ts', line: 17, evidence: 'Missing file check.', fix: 'Check the file.',
};
const low: ReviewPublishBlockingFinding = { ...blocker, id: 'unclear-error', severity: 'P2', line: 28 };
const nit = { id: 'long-description', severity: 'P3', message: 'Shorten the description.' } as const;
const receipt: ReviewPublishReceipt = {
  protocol: 2, kind: 'repo-harness-review-publish-receipt', round: 1, subject_sha: 'a'.repeat(40), risk_tier: 'medium',
  reviewer: { harness: 'pi', actual_model: null }, model_relation: 'same-family', verdict: 'FAIL',
  summary: 'Review summary.', findings: [low, nit], confirmed_fixed: [],
};

const reviewMarker = 'Rule-opportunity: guard-file-path | finding: unclear-error | check: type — Check the path type.';
const exampleMarker = 'Rule-opportunity: guard-file-path | example: src/main.ts:23 | check: test — Exercise the guard.';

test('reads exactly the review finding and PR example marker fields', () => {
  expect(parseRuleOpportunity(reviewMarker, 'review_body')).toEqual({ theme_key: 'guard-file-path', finding_id: 'unclear-error', check: 'type' });
  expect(parseRuleOpportunity(exampleMarker, 'pr_body')).toEqual({ theme_key: 'guard-file-path', path: 'src/main.ts', line: 23, check: 'test' });
  expect(parseRuleOpportunity('A comment about Rule-opportunity: guard-file-path', 'pr_body')).toBeUndefined();
  for (const line of [
    exampleMarker.replace('guard-file-path', 'Guard_file_path'),
    exampleMarker.replace('check: test', 'check: lint'),
    exampleMarker.replace('example:', 'location:'),
    exampleMarker.replace('src/main.ts:23', 'src/main.ts:0'),
    exampleMarker.replace('src/main.ts:23', '../src/main.ts:23'),
    reviewMarker,
  ]) expect(parseRuleOpportunity(line, 'pr_body')).toBeNull();
});

test('joins a marked outside-diff finding, deduplicates its id and filters unmarked NITs', () => {
  const firstReview = reviewPayloadFromReceipt({ ...receipt, summary: `${receipt.summary}\n\n${reviewMarker}` }, new Map());
  const nextReview = reviewPayloadFromReceipt({ ...receipt, round: 2, findings: [blocker, low, nit] }, new Map());
  const pull = {
    number: 3240, body: `${exampleMarker}\n${exampleMarker}\n${exampleMarker.replace('check: test', 'check: lint')}`,
    reviews: [firstReview.body, nextReview.body, 'repo-harness acceptance record\n\n## NITs\n\n- omitted: No acceptance comment read.'],
    threads: [{ ...renderInlineComment(blocker), bot: false, replies: [`Disposition: confirmed fixed in round 2 on ${'b'.repeat(40)}`] }],
  };
  const result = observeRuleProposals(pull);
  expect(result.malformed).toBe(1);
  const example = { pull_request: 3240, theme_key: 'guard-file-path', finding_id: null, source: 'pr_body', severity: null,
    path: 'src/main.ts', line: 23, check: 'test', fix: { state: 'none' } } as const;
  expect(result.observations).toEqual([
    { pull_request: 3240, theme_key: null, finding_id: blocker.id, source: 'review_thread', severity: 'P1',
      path: blocker.path, line: blocker.line, check: null, fix: { state: 'none' } },
    { pull_request: 3240, theme_key: 'guard-file-path', finding_id: low.id, source: 'review_body', severity: 'P2',
      path: low.path, line: low.line, check: 'type', fix: { state: 'none' } },
    example, example,
  ]);
  expect(observeRuleProposals(pull, { includeLow: true }).observations.filter(row => row.severity === 'P3').map(row => row.finding_id)).toEqual([nit.id]);
  expect(groupRuleProposals(result.observations, new Set())).toEqual([]);
  const later = observeRuleProposals({ ...pull, number: 3243, body: exampleMarker, reviews: [] });
  const combined = [...later.observations, ...result.observations];
  expect(groupRuleProposals(combined, new Set(['guard-file-path']))).toEqual([
    { theme_key: 'guard-file-path', pull_requests: [3240, 3243], in_ledger: true },
  ]);
  expect(groupRuleProposals(combined, new Set())[0]?.in_ledger).toBe(false);
});
