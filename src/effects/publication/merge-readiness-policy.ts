import {
  PUBLICATION_POLICY_PATH,
  policyFileFromContents,
  publicationPolicyBlocksAtRef,
  type PolicyFileAtRef,
} from '../../core/publication/acceptance-merge-policy';
import type { GeneratedArtifactsFactsV1 } from '../../core/publication/generated-artifacts';
import type {
  RequiredCheckBucketV1,
  RequiredCheckCoverageFactsV1,
} from '../../core/publication/merge-readiness';
import { observeGeneratedArtifacts } from './generated-artifacts';
import { checkArray, type ProviderCheck } from './merge-readiness-checks';
import type { ProviderIdentityData, ProviderReader, ProviderRequest } from './merge-readiness-transport';

export interface PolicyObservationInput {
  readonly repo_root: string;
  readonly repository?: string;
  readonly git_bin?: string;
  readonly policy_file_at_base?: PolicyFileAtRef;
}

const CHANGED_FILE_PAGE_SIZE = 100;
/** GitHub caps the PR file list at 3000 entries; a longer list fails closed instead of looping. */
const CHANGED_FILE_LIMIT = 3000;

interface ChangedFilePage {
  readonly files: readonly { readonly filename: string; readonly previous_filename?: string }[];
}

/**
 * One page of the REST pull-request files view. It is the only provider view
 * that reports a rename source (`previous_filename`), so a protected path
 * cannot be lost by a rename.
 *
 * The page cannot carry a head/base SHA. The enclosing identity fence binds it:
 * readiness reads the PR identity before and after the facts, and a head or
 * base move during the read discards the round as `changed_during_read`.
 */
function changedFilePage(value: unknown, reader: ProviderReader): ChangedFilePage {
  if (!Array.isArray(value)) reader.fail('provider_data_incomplete', 'changed files must be an array');
  const files = value.map((entry) => {
    const file = reader.object(entry, 'changed file');
    return Object.freeze({
      filename: reader.string(file.filename, 'changed file name'),
      ...(file.previous_filename === undefined || file.previous_filename === null
        ? {} : { previous_filename: reader.string(file.previous_filename, 'changed file previous name') }),
    });
  });
  return Object.freeze({ files: Object.freeze(files) });
}

/**
 * Every changed path of the PR head, including rename sources. Read only when
 * the coverage block is active. The page count comes from the provider's
 * changed-file count in the identity read, so it is exactly
 * ceil(changed_files / 100): 0 files cost no page and 3000 files cost 30.
 */
function* changedPaths(
  identity: ProviderIdentityData,
  reader: ProviderReader,
): Generator<ProviderRequest, string[], unknown> {
  if (identity.changed_files > CHANGED_FILE_LIMIT) {
    reader.fail(
      'provider_data_incomplete',
      `the PR reports ${identity.changed_files} changed files; the provider lists at most ${CHANGED_FILE_LIMIT}`,
      undefined,
      'provider PR changedFiles exceeds the file list limit',
    );
  }
  const pages = Math.ceil(identity.changed_files / CHANGED_FILE_PAGE_SIZE);
  const files: { readonly filename: string; readonly previous_filename?: string }[] = [];
  for (let page = 1; page <= pages; page++) {
    const parsed = changedFilePage(yield {
      args: ['api', `repos/${identity.repo_name_with_owner}/pulls/${identity.pr_number}/files?per_page=${CHANGED_FILE_PAGE_SIZE}&page=${page}`],
    }, reader);
    files.push(...parsed.files);
  }
  if (files.length !== identity.changed_files) {
    reader.fail(
      'provider_data_incomplete',
      `the PR reported ${identity.changed_files} changed files but the provider listed ${files.length}`,
      undefined,
      'provider PR file list does not match changedFiles',
    );
  }
  const paths = files.flatMap((file) => file.previous_filename === undefined ? [file.filename] : [file.filename, file.previous_filename]);
  return [...new Set(paths)].sort();
}

function policyAtRef(contents: unknown, ref: string, reader: ProviderReader): PolicyFileAtRef {
  const file = policyFileFromContents(contents);
  if (file === null) {
    reader.fail(
      'provider_data_incomplete',
      `${PUBLICATION_POLICY_PATH} at ${ref} is not a readable file`,
      undefined,
      `${PUBLICATION_POLICY_PATH} at the base is not a readable file`,
    );
  }
  return file;
}

function reusedPolicyFile(input: PolicyObservationInput, ref: string): PolicyFileAtRef | null {
  if (input.policy_file_at_base === undefined) return null;
  const expectedBase = 'expected_base_sha' in input ? (input as { readonly expected_base_sha?: unknown }).expected_base_sha : undefined;
  // The executor read this file at the expected base. A moved base is a cache
  // miss, not a refusal: the normal read reports base_moved_since_verification.
  return expectedBase === ref ? input.policy_file_at_base : null;
}

type PublicationPolicyBlocks = ReturnType<typeof publicationPolicyBlocksAtRef>;

/** One policy read per readiness round answers the declared blocks at the base. */
function publicationPolicyFile(input: PolicyObservationInput, ref: string, reader: ProviderReader): PolicyFileAtRef {
  const reused = reusedPolicyFile(input, ref);
  if (reused !== null) return reused;
  const contents = reader.ghOptional(['api', `repos/${input.repository}/contents/${PUBLICATION_POLICY_PATH}?ref=${ref}`]);
  return contents === null ? { status: 'missing' } : policyAtRef(contents, ref, reader);
}

/**
 * The all-checks read is the only view that shows a declared check which branch
 * protection does not require. A declared matrix job is usually such a check:
 * it appears in the PR rollup as skipped, and the required list never names it.
 *
 * Read budget for one readiness round:
 * - inactive block: zero extra reads when the executor passes
 *   `policy_file_at_base`, otherwise one policy contents read;
 * - active block: that policy read, exactly ceil(changed_files / 100) REST file
 *   pages from the provider's changed-file count (0 files cost no page, 100
 *   files cost one, 3000 files cost 30) and one all-checks read.
 * So an active PR costs two extra reads with one file page and three with two
 * pages on the executor path, plus the policy read on the standalone path.
 */
function observedCheckFacts(checks: readonly ProviderCheck[]): readonly { readonly name: string; readonly bucket: RequiredCheckBucketV1 }[] {
  return Object.freeze(checks.map(({ name, bucket }) => Object.freeze({ name, bucket })));
}

const ALL_CHECKS_ARGS = (identity: ProviderIdentityData): string[] =>
  ['pr', 'checks', String(identity.pr_number), '--json', 'name,bucket,link'];

function coverageFacts(
  identity: ProviderIdentityData,
  policy: PublicationPolicyBlocks,
  reader: ProviderReader,
): RequiredCheckCoverageFactsV1 {
  if (policy.coverage.status !== 'active') return policy.coverage;
  const changed = reader.driveRequests(changedPaths(identity, reader));
  const observed = observedCheckFacts(checkArray(reader.gh(ALL_CHECKS_ARGS(identity), [0, 1, 8]), reader));
  return Object.freeze({ status: 'active', policy: policy.coverage.policy, changed_paths: Object.freeze(changed), observed_checks: observed });
}

/**
 * Run the declared regeneration on the merge tree. The check is synchronous
 * and bounded by the declared timeout: the child runs in a process group and
 * is killed at the deadline. Every failure is a typed blocker, never a
 * provider outage.
 */
function generatedArtifactsFacts(
  identity: ProviderIdentityData,
  input: PolicyObservationInput,
  policy: PublicationPolicyBlocks,
): GeneratedArtifactsFactsV1 {
  const block = policy.generated_artifacts;
  if (block.status !== 'active') return block;
  return Object.freeze({
    status: 'active',
    policy: block.policy,
    check: observeGeneratedArtifacts({
      repo_root: input.repo_root,
      base_sha: identity.base_sha,
      head_sha: identity.head_sha,
      policy: block.policy,
      ...(input.git_bin === undefined ? {} : { git_bin: input.git_bin }),
    }),
  });
}

export function observeBasePolicyFacts(
  identity: ProviderIdentityData,
  input: PolicyObservationInput,
  reader: ProviderReader,
): { readonly coverage: RequiredCheckCoverageFactsV1; readonly generated: GeneratedArtifactsFactsV1 } {
  const policyFile = publicationPolicyFile(input, identity.base_sha, reader);
  const policy = publicationPolicyBlocksAtRef(policyFile);
  return {
    coverage: coverageFacts(identity, policy, reader),
    generated: generatedArtifactsFacts(identity, input, policy),
  };
}
