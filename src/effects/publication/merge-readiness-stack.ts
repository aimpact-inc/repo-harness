import type {
  MergeReadinessStackDetailV1,
  MergeReadinessStackEntryV1,
} from '../../core/publication/merge-readiness';
import {
  validSha,
  type ProviderIdentityData,
  type ProviderReader,
} from './merge-readiness-transport';

const STACK_DEPTH_LIMIT = 20;
/** GitHub returns at most 100 PRs for one list request; a full page is not exhaustive. */
const STACK_PR_LIST_LIMIT = 100;
const STACK_PR_FIELDS = 'number,state,headRefOid,headRefName,baseRefOid,baseRefName,isCrossRepository';

interface ProviderStackPullRequest {
  readonly pr_number: number;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly head_ref: string;
  readonly head_sha: string;
  readonly base_ref: string;
  readonly base_sha: string;
  readonly cross_repository: boolean;
}

function providerStackPullRequest(value: unknown, reader: ProviderReader): ProviderStackPullRequest {
  const pr = reader.object(value, 'provider stack pull request');
  if (!Number.isSafeInteger(pr.number) || Number(pr.number) < 1
    || !['OPEN', 'CLOSED', 'MERGED'].includes(String(pr.state))
    || typeof pr.headRefName !== 'string' || pr.headRefName.trim() === ''
    || typeof pr.baseRefName !== 'string' || pr.baseRefName.trim() === ''
    || !validSha(pr.headRefOid) || !validSha(pr.baseRefOid)
    || typeof pr.isCrossRepository !== 'boolean') {
    reader.fail('provider_data_incomplete', 'provider stack pull request is incomplete');
  }
  return Object.freeze({
    pr_number: Number(pr.number), state: String(pr.state) as ProviderStackPullRequest['state'],
    head_ref: pr.headRefName, head_sha: pr.headRefOid, base_ref: pr.baseRefName, base_sha: pr.baseRefOid,
    cross_repository: pr.isCrossRepository,
  });
}

function providerStackList(value: unknown, reader: ProviderReader): readonly ProviderStackPullRequest[] {
  if (!Array.isArray(value)) reader.fail('provider_data_incomplete', 'provider stack pull request list is invalid');
  if (value.length >= STACK_PR_LIST_LIMIT) reader.fail('provider_data_incomplete', 'provider stack pull request list is not exhaustive');
  return Object.freeze(value.map(entry => providerStackPullRequest(entry, reader)));
}

function stackFailure(
  status: MergeReadinessStackDetailV1['status'],
  chain: readonly MergeReadinessStackEntryV1[],
): MergeReadinessStackDetailV1 {
  return Object.freeze({ member: true, depth: chain.length - 1, chain: Object.freeze([...chain]), final_base_sha: null, status });
}

/**
 * Follow the baseRefName chain from the observed PR to the default branch.
 * Every request names the branch observed on the previous link. The loop stops
 * on a repeated PR number or branch, a missing or closed base PR, a foreign PR,
 * or the depth bound; none of these returns a complete chain.
 */
function* stackProtocol(
  identity: ProviderIdentityData,
  defaultBranch: string,
  reader: ProviderReader,
): Generator<string, MergeReadinessStackDetailV1, readonly ProviderStackPullRequest[]> {
  if (identity.base_ref === defaultBranch) {
    return Object.freeze({ member: false, depth: 0, chain: Object.freeze([]), final_base_sha: null, status: 'not_member' as const });
  }
  const member: MergeReadinessStackEntryV1 = Object.freeze({
    pr_number: identity.pr_number, head_ref: identity.head_ref, head_sha: identity.head_sha,
    base_ref: identity.base_ref, base_sha: identity.base_sha,
  });
  const chain: MergeReadinessStackEntryV1[] = [member];
  const seenNumbers = new Set<number>([identity.pr_number]);
  // Only branches used as a lookup key form the chain; a head ref is not a cycle
  // by itself, and a PR from the default branch is still a member.
  const seenRefs = new Set<string>([identity.base_ref]);
  let baseRef = identity.base_ref;
  for (;;) {
    if (baseRef === defaultBranch) {
      return Object.freeze({
        member: true, depth: chain.length - 1, chain: Object.freeze([...chain]),
        final_base_sha: chain[chain.length - 1]!.base_sha, status: 'complete' as const,
      });
    }
    if (chain.length - 1 >= STACK_DEPTH_LIMIT) return stackFailure('depth_exceeded', chain);
    const matching = (yield baseRef).filter(pr => pr.head_ref === baseRef);
    const open = matching.filter(pr => pr.state === 'OPEN');
    if (open.length === 0) return stackFailure(matching.length === 0 ? 'base_pr_missing' : 'base_pr_not_open', chain);
    if (open.length > 1) {
      reader.fail(
        'provider_data_incomplete',
        `provider returned ${open.length} open pull requests for stack base ${baseRef}`,
        undefined,
        'stack base has more than one open pull request',
      );
    }
    const base = open[0]!;
    if (base.cross_repository) return stackFailure('foreign_pr', chain);
    if (seenNumbers.has(base.pr_number) || seenRefs.has(base.base_ref)) return stackFailure('cycle', chain);
    const entry: MergeReadinessStackEntryV1 = Object.freeze({
      pr_number: base.pr_number, head_ref: base.head_ref, head_sha: base.head_sha,
      base_ref: base.base_ref, base_sha: base.base_sha,
    });
    chain.push(entry);
    seenNumbers.add(entry.pr_number);
    seenRefs.add(entry.base_ref);
    baseRef = entry.base_ref;
  }
}

export function observeStack(
  identity: ProviderIdentityData,
  defaultBranch: string,
  reader: ProviderReader,
): MergeReadinessStackDetailV1 {
  const protocol = stackProtocol(identity, defaultBranch, reader);
  let request = protocol.next();
  while (!request.done) {
    const list = reader.gh(['pr', 'list', '--head', request.value, '--state', 'all', '--json', STACK_PR_FIELDS, '--limit', String(STACK_PR_LIST_LIMIT)]);
    request = protocol.next(providerStackList(list, reader));
  }
  return request.value;
}
