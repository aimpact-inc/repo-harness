import type { RequiredCheckFailureEvidenceV1 } from '../../core/evidence/required-check-evidence';
import type { GeneratedArtifactsFactsV1 } from '../../core/publication/generated-artifacts';
import type {
  ProviderMergeReadinessFactsV1,
  RequiredCheckCoverageFactsV1,
} from '../../core/publication/merge-readiness';
import { providerCheck } from './merge-readiness-checks';
import type { ProviderIdentityData, ProviderReader } from './merge-readiness-transport';

export function identityBytes(identity: ProviderIdentityData): string {
  const { body: _body, ...fences } = identity;
  return JSON.stringify(fences);
}

/** The provider's changed-file count; it must be present, because it sets the exact page count. */
function changedFiles(value: unknown, reader: ProviderReader): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    reader.fail('provider_data_incomplete', 'provider PR changedFiles is invalid');
  }
  return Number(value);
}

export function parseProviderPullRequestIdentity(
  prNumber: number,
  repoValue: unknown,
  prValue: unknown,
  reader: ProviderReader,
): ProviderIdentityData {
  const repo = reader.object(repoValue, 'provider repository');
  const pr = reader.object(prValue, 'provider PR');
  const number = pr.number;
  if (!Number.isInteger(number) || number !== prNumber) {
    reader.fail('provider_data_incomplete', 'provider PR number does not match the requested PR');
  }
  if (typeof pr.isDraft !== 'boolean') reader.fail('provider_data_incomplete', 'provider PR isDraft is invalid');
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(String(pr.state))) {
    reader.fail('provider_data_incomplete', 'provider PR state is unknown');
  }
  // gh pr view serializes an absent GraphQL review decision as an empty string.
  const reviewDecision = pr.reviewDecision === '' ? null : pr.reviewDecision;
  if (reviewDecision !== null && (typeof reviewDecision !== 'string'
    || !['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(reviewDecision))) {
    reader.fail('provider_data_incomplete', 'provider PR reviewDecision is unknown');
  }
  if (pr.mergeable !== 'MERGEABLE' && pr.mergeable !== 'CONFLICTING' && pr.mergeable !== 'UNKNOWN') {
    reader.fail('provider_data_incomplete', 'provider PR mergeable is invalid');
  }
  const identity: ProviderIdentityData = Object.freeze({
    provider_repo_id: reader.string(repo.id, 'provider repository id'),
    repo_name_with_owner: reader.string(repo.nameWithOwner, 'provider repository nameWithOwner'),
    pr_number: number as number,
    pr_url: reader.string(pr.url, 'provider PR URL'),
    state: reader.string(pr.state, 'provider PR state'),
    is_draft: pr.isDraft,
    head_sha: reader.string(pr.headRefOid, 'provider PR head OID'),
    head_ref: reader.string(pr.headRefName, 'provider PR head ref'),
    base_sha: reader.string(pr.baseRefOid, 'provider PR base OID'),
    base_ref: reader.string(pr.baseRefName, 'provider PR base ref'),
    body: typeof pr.body === 'string' ? pr.body : '',
    review_decision: reviewDecision,
    changed_files: changedFiles(pr.changedFiles, reader),
    mergeable: pr.mergeable,
  });
  return identity;
}

function threadComments(
  thread: Record<string, unknown>,
  reader: ProviderReader,
): { readonly connection: Record<string, unknown>; readonly nodes: readonly unknown[] } {
  const connection = reader.object(thread.comments, 'provider review thread comments');
  if (!Array.isArray(connection.nodes)) reader.fail('provider_data_incomplete', 'provider review thread comments are invalid');
  return { connection, nodes: connection.nodes };
}

function commentAuthorType(comment: unknown, reader: ProviderReader): string | null {
  const author = reader.object(comment, 'provider review thread comment').author;
  if (author === null) return null;
  const type = reader.object(author, 'provider review thread comment author').__typename;
  if (typeof type !== 'string') reader.fail('provider_data_incomplete', 'provider review thread comment author type is invalid');
  return type;
}

/**
 * Review bots (Codex, Copilot, CodeRabbit and others) post advisory threads, so
 * a thread that a GitHub App account started does not count as unresolved. A
 * thread with no first comment or a deleted author still does.
 */
function botStartedThread(comments: readonly unknown[], reader: ProviderReader): boolean {
  return comments[0] !== undefined && commentAuthorType(comments[0], reader) === 'Bot';
}

/**
 * Life-cycle rule (2) needs a response to each review-bot thread: a later
 * comment from an author that is not a bot. A deleted author is not proof of a
 * response. The comment pages matter only when the read nodes hold no response.
 */
function botThreadAnswered(comments: ReturnType<typeof threadComments>, reader: ProviderReader): boolean {
  if (comments.nodes.slice(1).some(comment => { const type = commentAuthorType(comment, reader); return type !== null && type !== 'Bot'; })) return true;
  if (reader.object(comments.connection.pageInfo, 'provider review thread comments pageInfo').hasNextPage !== false) {
    reader.fail('provider_data_incomplete', 'provider review thread comments were not exhaustively observed');
  }
  return false;
}

export function providerReviewArgs(identity: ProviderIdentityData): string[] {
  // Latest opinionated reviews preserve a change request across later comment-only reviews.
  const query = 'query($repoId:ID!,$number:Int!){node(id:$repoId){id ... on Repository{pullRequest(number:$number){number headRefOid baseRefOid reviewDecision latestOpinionatedReviews(first:100){pageInfo{hasNextPage}nodes{state}} reviewThreads(first:100){pageInfo{hasNextPage}nodes{isResolved comments(first:100){pageInfo{hasNextPage}nodes{author{__typename}}}}}}}}}';
  return ['api', 'graphql', '-f', `query=${query}`, '-F', `repoId=${identity.provider_repo_id}`, '-F', `number=${identity.pr_number}`];
}

export function parseProviderReadinessFacts(
  identity: ProviderIdentityData,
  checksValue: unknown,
  rollbackBoundary: ProviderMergeReadinessFactsV1['rollback_boundary'],
  graphValue: unknown,
  checkFailures: readonly RequiredCheckFailureEvidenceV1[],
  coverage: RequiredCheckCoverageFactsV1,
  generated: GeneratedArtifactsFactsV1,
  reader: ProviderReader,
): ProviderMergeReadinessFactsV1 {
  if (!Array.isArray(checksValue)) reader.fail('provider_data_incomplete', 'provider required checks must be an array');
  const checks = checksValue.map(entry => providerCheck(entry, reader)).map(({ name, bucket }) => Object.freeze({ name, bucket }));
  const graph = reader.object(graphValue, 'provider GraphQL result');
  if (graph.errors !== undefined && (!Array.isArray(graph.errors) || graph.errors.length > 0)) {
    reader.fail('provider_data_incomplete', 'provider review query has errors');
  }
  const node = reader.object(reader.object(graph.data, 'provider GraphQL data').node, 'provider repository node');
  const pr = reader.object(node.pullRequest, 'provider review PR');
  if (node.id !== identity.provider_repo_id || pr.number !== identity.pr_number
    || pr.headRefOid !== identity.head_sha || pr.baseRefOid !== identity.base_sha) {
    reader.fail('provider_data_incomplete', 'provider reviews do not bind this PR/head/base');
  }
  if (pr.reviewDecision !== identity.review_decision) {
    reader.fail('provider_data_incomplete', 'provider review decision changed during read');
  }
  const threads = reader.object(pr.reviewThreads, 'provider review threads');
  const reviews = reader.object(pr.latestOpinionatedReviews, 'provider latest opinionated reviews');
  for (const connection of [threads, reviews]) {
    if (reader.object(connection.pageInfo, 'provider review pageInfo').hasNextPage !== false || !Array.isArray(connection.nodes)) {
      reader.fail('provider_data_incomplete', 'provider reviews and threads were not exhaustively observed');
    }
  }
  let unresolved = 0;
  let unansweredBot = 0;
  for (const entry of threads.nodes as unknown[]) {
    const thread = reader.object(entry, 'provider review thread');
    if (typeof thread.isResolved !== 'boolean') reader.fail('provider_data_incomplete', 'provider review thread isResolved is invalid');
    if (thread.isResolved) continue;
    const comments = threadComments(thread, reader);
    if (!botStartedThread(comments.nodes, reader)) unresolved++;
    else if (!botThreadAnswered(comments, reader)) unansweredBot++;
  }
  let changesRequested = pr.reviewDecision === 'CHANGES_REQUESTED';
  for (const entry of reviews.nodes as unknown[]) {
    const review = reader.object(entry, 'provider review');
    if (!['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(String(review.state))) {
      reader.fail('provider_data_incomplete', 'provider review state is unknown');
    }
    if (review.state === 'CHANGES_REQUESTED') changesRequested = true;
  }
  return Object.freeze({
    state: identity.state,
    is_draft: identity.is_draft,
    head_sha: identity.head_sha,
    base_sha: identity.base_sha,
    review_decision: changesRequested ? 'CHANGES_REQUESTED' : identity.review_decision,
    unresolved_thread_count: unresolved,
    unanswered_bot_thread_count: unansweredBot,
    rollback_boundary: rollbackBoundary,
    checks: Object.freeze(checks),
    check_failures: Object.freeze([...checkFailures]),
    required_check_coverage: coverage,
    generated_artifacts: generated,
    mergeable: identity.mergeable,
  });
}
