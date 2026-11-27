import { gitExecFileSync } from '../git/runner';
import type { RequiredCheckTestExecutionV1 } from '../../core/evidence/test-execution-evidence';
import {
  projectPullRequestMergeReadiness,
  unobservedStackDetail,
  type MergeReadinessObservation,
  type MergeReadinessStackDetailV1,
  type PullRequestReadinessV2,
  type PullRequestSelectionV2,
  type ProviderMergeReadinessFactsV1,
} from '../../core/publication/merge-readiness';
import type { PolicyFileAtRef } from '../../core/publication/acceptance-merge-policy';
import {
  collectRequiredCheckFailures,
  protectedChecks,
} from './merge-readiness-checks';
import { observeBasePolicyFacts } from './merge-readiness-policy';
import {
  identityBytes,
  parseProviderPullRequestIdentity,
  parseProviderReadinessFacts,
  providerReviewArgs,
} from './merge-readiness-reviews';
import { observeRollbackBoundary } from './merge-readiness-rollback';
import { observeStack } from './merge-readiness-stack';
import {
  createProviderReader,
  validSha,
  type ProviderReader,
} from './merge-readiness-transport';

export type MergeReadinessErrorCode =
  | 'provider_unavailable'
  | 'provider_data_incomplete';

export class MergeReadinessError extends Error {
  /**
   * The local field name that a readiness blocker may show. It never holds
   * provider text or gh arguments; a message that embeds them passes its own detail.
   */
  readonly detail: string;

  constructor(readonly code: MergeReadinessErrorCode, message: string, readonly cause?: unknown, detail?: string) {
    super(message);
    this.name = 'MergeReadinessError';
    this.detail = detail ?? message;
  }
}

function failReadiness(code: MergeReadinessErrorCode, message: string, cause?: unknown, detail?: string): never {
  throw new MergeReadinessError(code, message, cause, detail);
}

function readerFor(input: PublicationReadinessInput): ProviderReader {
  return createProviderReader(input, failReadiness);
}

/** Registry-bound adapters must bind local PR authority before querying the provider.
 * Independent explicit PR CLI observations do not use this registry restriction. */
export function assertLocalPullRequestRepository(repoRoot: string, repository: string): void {
  let remote: string;
  try {
    remote = gitExecFileSync(['remote', 'get-url', 'origin'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new MergeReadinessError('provider_data_incomplete', 'local GitHub origin is unavailable', error);
  }
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(remote);
  if (!match || match[1]!.toLowerCase() !== repository.toLowerCase()) {
    throw new MergeReadinessError('provider_data_incomplete', 'selected PR repository does not match local GitHub origin');
  }
}

/** One attempt whose test-level execution results the transport must answer. */
export interface TestExecutionReadRequest {
  readonly repository: string;
  readonly run_id: number;
  readonly attempt: number;
}

export interface PublicationReadinessInput {
  readonly repo_root: string;
  readonly repository?: string;
  readonly gh_bin?: string;
  readonly git_bin?: string;
  /** Internal effect/test seam; HTTP callers never choose an authority store. */
  readonly authority_home?: string;
  readonly now_ms?: number;
  /** Internal effect/test seam for caller-owned provider execution, such as a protected helper environment. */
  readonly gh_runner?: (args: readonly string[]) => { readonly status: number; readonly stdout: string; readonly stderr?: string };
  /** Internal effect/test seam for the rerun attempt's test-level execution source. */
  readonly test_execution_reader?: (request: TestExecutionReadRequest) => RequiredCheckTestExecutionV1;
  /**
   * Internal effect seam: the publication executor already read this file at
   * the base SHA for the acceptance-merge switch. Readiness reuses it instead
   * of a second contents read. The ref must be the expected base.
   */
  readonly policy_file_at_base?: PolicyFileAtRef;
  /** Internal effect seam: status checks from the executor's base protection read. */
  readonly required_status_checks_at_base?: unknown;
  /**
   * A read error that an optional request must not swallow; the caller that
   * owns the transport decides.
   */
  readonly fatal_read_error?: (error: unknown) => boolean;
}

export interface ProviderIdentity {
  readonly provider_repo_id: string;
  readonly repo_name_with_owner: string;
  readonly pr_number: number;
  readonly pr_url: string;
  readonly state: string;
  readonly is_draft: boolean;
  readonly head_sha: string;
  readonly head_ref: string;
  readonly base_sha: string;
  readonly base_ref: string;
  readonly body: string;
  readonly review_decision: string | null;
  /** Provider changed-file count for this head; drives exact REST file pagination. */
  readonly changed_files: number;
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
}

export function observeProviderReadinessFacts(
  identity: ProviderIdentity,
  receipt: Pick<PullRequestSelectionV2, 'pr_number'>,
  input: PublicationReadinessInput,
): ProviderMergeReadinessFactsV1 {
  const reader = readerFor(input);
  const checks = protectedChecks(identity, receipt.pr_number, input.required_status_checks_at_base, reader);
  const checkFailures = collectRequiredCheckFailures(identity, checks, reader);
  const { coverage, generated } = observeBasePolicyFacts(identity, input, reader);
  const boundary = observeRollbackBoundary(identity, reader);
  return parseProviderReadinessFacts(
    identity,
    checks,
    boundary,
    reader.gh(providerReviewArgs(identity)),
    checkFailures,
    coverage,
    generated,
    reader,
  );
}

export interface PullRequestReadinessInput extends PublicationReadinessInput {
  readonly repository: string;
  readonly provider_repository_id: string;
  readonly pr_number: number;
  readonly expected_head_sha: string;
  readonly expected_base_sha: string;
}

export function validatePullRequestSelection(value: unknown): PullRequestSelectionV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MergeReadinessError('provider_data_incomplete', 'PR selection must be an object');
  }
  const selection = value as Record<string, unknown>;
  if (Object.keys(selection).sort().join(',') !== ['provider_repository_id', 'repository', 'pr_number', 'expected_head_sha', 'expected_base_sha'].sort().join(',')) {
    throw new MergeReadinessError('provider_data_incomplete', 'PR selection fields are invalid');
  }
  if (typeof selection.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(selection.repository)
    || typeof selection.provider_repository_id !== 'string' || !/^[1-9][0-9]*$/.test(selection.provider_repository_id)
    || !Number.isSafeInteger(selection.pr_number) || Number(selection.pr_number) < 1
    || ![selection.expected_head_sha, selection.expected_base_sha].every(validSha)) {
    throw new MergeReadinessError('provider_data_incomplete', 'explicit PR identity and expected head/base are required');
  }
  return Object.freeze({
    provider_repository_id: selection.provider_repository_id,
    repository: selection.repository,
    pr_number: Number(selection.pr_number),
    expected_head_sha: selection.expected_head_sha as string,
    expected_base_sha: selection.expected_base_sha as string,
  });
}

function selectionOf(input: PullRequestReadinessInput): PullRequestSelectionV2 {
  if ('publication_id' in input) throw new MergeReadinessError('provider_data_incomplete', 'publication_id is not a provider selection');
  return validatePullRequestSelection({
    provider_repository_id: input.provider_repository_id,
    repository: input.repository,
    pr_number: input.pr_number,
    expected_head_sha: input.expected_head_sha,
    expected_base_sha: input.expected_base_sha,
  });
}

interface ProviderReadinessTarget {
  readonly identity: ProviderIdentity;
  readonly default_branch: string;
}

function confirmRepositoryIdentity(
  input: PullRequestReadinessInput,
  identity: ProviderIdentity,
  rest: unknown,
  reader: ProviderReader,
): string {
  const repository = reader.object(rest, 'REST repository');
  const defaultBranch = reader.string(repository.default_branch, 'REST repository default_branch');
  if (!Number.isSafeInteger(repository.id) || Number(repository.id) < 1 || String(repository.id) !== input.provider_repository_id
    || repository.node_id !== identity.provider_repo_id || repository.full_name !== input.repository
    || identity.repo_name_with_owner !== input.repository) {
    throw new MergeReadinessError('provider_data_incomplete', 'provider repository or default-branch target does not match selection');
  }
  return defaultBranch;
}

/**
 * The one PR identity read. Readiness, fleet feedback and product acceptance
 * all observe their identity through it, so every field here must be answered
 * by any provider stand-in: `changedFiles` sets the exact coverage page count.
 */
const PR_IDENTITY_FIELDS = 'number,url,state,isDraft,headRefOid,headRefName,baseRefOid,baseRefName,body,reviewDecision,changedFiles,mergeable';

/**
 * The readiness target keeps the repository default branch. Stack detection
 * needs it to decide membership; the strict identity adapter below rejects a
 * non-default base for every other consumer.
 */
function observeProviderReadinessTarget(input: PullRequestReadinessInput, reader: ProviderReader): ProviderReadinessTarget {
  selectionOf(input);
  const identity = parseProviderPullRequestIdentity(
    input.pr_number,
    reader.gh(['repo', 'view', '--json', 'id,nameWithOwner']),
    reader.gh(['pr', 'view', String(input.pr_number), '--json', PR_IDENTITY_FIELDS]),
    reader,
  );
  return { identity, default_branch: confirmRepositoryIdentity(input, identity, reader.gh(['api', `repos/${input.repository}`]), reader) };
}

export function observeProviderReadinessIdentity(input: PullRequestReadinessInput): ProviderIdentity {
  const target = observeProviderReadinessTarget(input, readerFor(input));
  if (target.identity.base_ref !== target.default_branch) {
    throw new MergeReadinessError('provider_data_incomplete', 'provider repository or default-branch target does not match selection');
  }
  return target.identity;
}

function readinessProjection(
  input: PullRequestReadinessInput,
  round: ReadinessRound | null,
  observation: MergeReadinessObservation,
  observationDetail?: string,
): PullRequestReadinessV2 {
  return Object.freeze({
    protocol: 2,
    kind: 'repo-harness-pull-request-readiness',
    ...selectionOf(input),
    ...projectPullRequestMergeReadiness({
      expected_head_sha: input.expected_head_sha,
      expected_base_sha: input.expected_base_sha,
      integration_mode: round?.facts?.state === 'MERGED' ? 'ancestor' : 'unmerged',
      observation,
      ...(observationDetail === undefined ? {} : { observation_detail: observationDetail }),
      provider: round?.facts ?? null,
      stack: round?.stack ?? unobservedStackDetail(),
    }),
  });
}

/** One observation loop for exact merged-PR evidence. The stack is fenced with the identity. */
function stablePullRequestRound<T>(
  input: PullRequestReadinessInput,
  reader: ProviderReader,
  observeExtra: (identity: ProviderIdentity) => T,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = observeProviderReadinessTarget(input, reader);
    const extra = observeExtra(before.identity);
    const stack = observeStack(before.identity, before.default_branch, reader);
    const facts = observeProviderReadinessFacts(before.identity, input, input);
    const after = observeProviderReadinessTarget(input, reader);
    const extraAfter = observeExtra(after.identity);
    const stackAfter = observeStack(after.identity, after.default_branch, reader);
    if (identityBytes(before.identity) === identityBytes(after.identity)
      && JSON.stringify(extra) === JSON.stringify(extraAfter)
      && JSON.stringify(stack) === JSON.stringify(stackAfter)) {
      return { identity: after.identity, facts, extra, stack: stackAfter };
    }
  }
  return null;
}

interface ReadinessRound {
  readonly facts: ProviderMergeReadinessFactsV1 | null;
  readonly stack: MergeReadinessStackDetailV1;
}

/**
 * Readiness observes only the identity and the chain for a stack member. Own-base
 * checks, reviews and coverage are not read: that evidence proves the PR only
 * against its feature base, not against the default branch.
 */
function stableReadinessRound(input: PullRequestReadinessInput, reader: ProviderReader): ReadinessRound | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = observeProviderReadinessTarget(input, reader);
    const stack = observeStack(before.identity, before.default_branch, reader);
    if (stack.member) {
      const after = observeProviderReadinessTarget(input, reader);
      const stackAfter = observeStack(after.identity, after.default_branch, reader);
      if (identityBytes(before.identity) === identityBytes(after.identity)
        && JSON.stringify(stack) === JSON.stringify(stackAfter)) return { facts: null, stack: stackAfter };
      continue;
    }
    const facts = observeProviderReadinessFacts(before.identity, input, input);
    const after = observeProviderReadinessTarget(input, reader);
    const stackAfter = observeStack(after.identity, after.default_branch, reader);
    if (identityBytes(before.identity) === identityBytes(after.identity)
      && JSON.stringify(stack) === JSON.stringify(stackAfter)) return { facts, stack: stackAfter };
  }
  return null;
}

/** Ordinary default-branch PRs consume the shared provider decoder without a receipt or Lease. */
export function collectPullRequestMergeReadiness(input: PullRequestReadinessInput): PullRequestReadinessV2 {
  selectionOf(input);
  const reader = readerFor(input);
  try {
    const round = stableReadinessRound(input, reader);
    return round ? readinessProjection(input, round, 'stable') : readinessProjection(input, null, 'changed_during_read');
  } catch (error) {
    if (!(error instanceof MergeReadinessError)) throw error;
    // Each provider field check names its field; the blocker keeps that local name so a refusal shows it.
    return readinessProjection(input, null, error.code, error.code === 'provider_data_incomplete' ? error.detail : undefined);
  }
}

export interface PullRequestIntegrationInput extends PullRequestReadinessInput {
  readonly issue_id: string;
  readonly issue_number: number;
}

/** Provider proof only. The integration consumer must also prove exact local tree and ancestry. */
export function collectPullRequestIntegration(
  input: PullRequestIntegrationInput,
): { readonly merge_commit_sha: string; readonly merge_tree_sha: string } {
  if (!Number.isSafeInteger(input.issue_number) || input.issue_number < 1 || !input.issue_id?.trim()) {
    throw new MergeReadinessError('provider_data_incomplete', 'explicit issue identity is required');
  }
  const reader = readerFor(input);
  const round = stablePullRequestRound(input, reader, identity => {
    const root = `repos/${input.repository}`;
    const issue = reader.object(reader.gh(['api', `${root}/issues/${input.issue_number}`]), 'selected issue');
    if (!Number.isSafeInteger(issue.id) || Number(issue.id) < 1 || String(issue.id) !== input.issue_id || issue.number !== input.issue_number || 'pull_request' in issue) {
      throw new MergeReadinessError('provider_data_incomplete', 'selected issue identity changed');
    }
    const detail = reader.object(reader.gh(['api', `${root}/pulls/${input.pr_number}`]), 'merged PR');
    const base = reader.object(detail.base, 'merged PR base');
    const head = reader.object(detail.head, 'merged PR head');
    if (identity.state !== 'MERGED' || detail.merged !== true || detail.number !== input.pr_number
      || String(reader.object(base.repo, 'merged PR repository').id) !== input.provider_repository_id
      || reader.object(base.repo, 'merged PR repository').node_id !== identity.provider_repo_id
      || base.ref !== identity.base_ref || base.sha !== input.expected_base_sha || head.sha !== input.expected_head_sha
      || !validSha(detail.merge_commit_sha)) {
      throw new MergeReadinessError('provider_data_incomplete', 'exact merged PR identity is unavailable');
    }
    const commit = reader.object(reader.gh(['api', `${root}/git/commits/${detail.merge_commit_sha}`]), 'provider merge commit');
    const tree = reader.object(commit.tree, 'provider merge tree');
    if (commit.sha !== detail.merge_commit_sha || !validSha(tree.sha) || !Array.isArray(commit.parents)
      || commit.parents.length === 0 || !commit.parents.every(parent => validSha(reader.object(parent, 'merge parent').sha))) {
      throw new MergeReadinessError('provider_data_incomplete', 'merge commit/tree or parents are unavailable');
    }
    return { issue_id: String(issue.id), issue_number: issue.number, merge_commit_sha: detail.merge_commit_sha, merge_tree_sha: tree.sha };
  });
  if (!round) throw new MergeReadinessError('provider_data_incomplete', 'integration selection changed during read');
  const verdict = projectPullRequestMergeReadiness({
    expected_head_sha: input.expected_head_sha,
    expected_base_sha: input.expected_base_sha,
    integration_mode: 'ancestor',
    observation: 'stable',
    provider: round.facts,
    stack: round.stack,
  });
  // These blockers describe merge lifecycle, not CI/review acceptance of an already merged PR.
  const blockers = verdict.blockers.filter(blocker => !['already_integrated', 'pr_not_open', 'not_mergeable', 'mergeability_pending'].includes(blocker.code));
  if (blockers.length) {
    throw new MergeReadinessError('provider_data_incomplete', `integrated PR evidence refused: ${blockers.map(blocker => blocker.code).join(', ')}`);
  }
  return Object.freeze({ merge_commit_sha: round.extra.merge_commit_sha, merge_tree_sha: round.extra.merge_tree_sha });
}
