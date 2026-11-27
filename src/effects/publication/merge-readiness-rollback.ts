import {
  rollbackParent,
  type ProviderMergeReadinessFactsV1,
} from '../../core/publication/merge-readiness';
import {
  validSha,
  type ProviderIdentityData,
  type ProviderReader,
} from './merge-readiness-transport';

/** Read protocol for the rollback boundary; reads only the current commit boundary. */
function* rollbackBoundary(
  identity: ProviderIdentityData,
  reader: ProviderReader,
): Generator<string, ProviderMergeReadinessFactsV1['rollback_boundary'], unknown> {
  if (!validSha(identity.base_sha)) reader.fail('provider_data_incomplete', 'rollback base SHA is invalid');
  const root = `repos/${identity.repo_name_with_owner}`;
  const activation = reader.object(
    yield `${root}/contents/.github/workflows/ci-report.yml?ref=${identity.base_sha}`,
    'rollback reporter activation',
  );
  if (activation.status === '404') return Object.freeze({ status: 'not_active' });
  if (activation.status || activation.type !== 'file' || activation.path !== '.github/workflows/ci-report.yml' || !validSha(activation.sha)) {
    reader.fail('provider_data_incomplete', 'rollback reporter activation unavailable');
  }
  const associations = yield `${root}/commits/${identity.base_sha}/pulls?per_page=100`;
  if (!Array.isArray(associations) || associations.length >= 100) {
    reader.fail('provider_data_incomplete', 'parent PR associations incomplete');
  }
  const merged = associations.map(entry => {
    const pr = reader.object(entry, 'parent PR association');
    const base = reader.object(pr.base, 'parent PR base');
    if (typeof base.ref !== 'string' || (pr.merged_at !== null && (typeof pr.merged_at !== 'string' || pr.merged_at.trim() === ''))
      || (pr.merge_commit_sha !== null && !validSha(pr.merge_commit_sha))) {
      reader.fail('provider_data_incomplete', 'parent PR association is incomplete');
    }
    return pr;
  }).filter(pr => pr.merged_at !== null && (pr.base as Record<string, unknown>).ref === identity.base_ref && pr.merge_commit_sha === identity.base_sha);
  const prNumber = merged[0]?.number;
  if (merged.length !== 1 || typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    reader.fail('provider_data_incomplete', 'activated reporter parent is not an exact single merged PR');
  }
  const commit = reader.object(yield `${root}/git/commits/${identity.base_sha}`, 'base parent commit');
  if (commit.sha !== identity.base_sha || !Array.isArray(commit.parents)) {
    reader.fail('provider_data_incomplete', 'rollback base commit is incomplete');
  }
  const detail = reader.object(yield `${root}/pulls/${prNumber}`, 'merged parent PR detail');
  if (detail.number !== prNumber || detail.merged !== true || detail.merge_commit_sha !== identity.base_sha
    || reader.object(detail.base, 'merged parent PR detail base').ref !== identity.base_ref) {
    reader.fail('provider_data_incomplete', 'merged parent PR detail does not match the rollback boundary');
  }
  const before = rollbackParent(identity.base_sha, commit.parents);
  if (before === null) {
    reader.fail('provider_data_incomplete', 'rollback parent is not a single commit');
  }
  const parentAssociations = yield `${root}/commits/${before}/pulls?per_page=100`;
  if (!Array.isArray(parentAssociations) || parentAssociations.length >= 100) {
    reader.fail('provider_data_incomplete', 'rollback parent PR associations incomplete');
  }
  const parentPRs = parentAssociations.map(entry => {
    const pr = reader.object(entry, 'rollback parent PR association');
    if (typeof pr.number !== 'number' || !Number.isSafeInteger(pr.number) || pr.number < 1) {
      reader.fail('provider_data_incomplete', 'rollback parent PR number unavailable');
    }
    return pr.number;
  });
  if (parentPRs.includes(prNumber)) {
    reader.fail(
      'provider_data_incomplete',
      `Automatic rollback cannot revert only the last commit of multi-commit rebase PR #${prNumber}`,
      undefined,
      'rollback parent PR is a multi-commit rebase PR',
    );
  }
  return Object.freeze({ status: 'ready', pr_number: prNumber, before_sha: before, after_sha: identity.base_sha });
}

export function observeRollbackBoundary(
  identity: ProviderIdentityData,
  reader: ProviderReader,
): ProviderMergeReadinessFactsV1['rollback_boundary'] {
  const boundary = rollbackBoundary(identity, reader);
  let request = boundary.next();
  while (!request.done) {
    request = boundary.next(reader.gh(['api', request.value], request.value.includes('/contents/') ? [0, 1] : [0]));
  }
  return request.value;
}
