import {
  validateRequiredCheckFailureEvidence,
  type RequiredCheckFailureEvidenceV1,
} from '../evidence/required-check-evidence';
import {
  GENERATED_ARTIFACTS_FAILURE_CODES,
  type GeneratedArtifactsFactsV1,
  type GeneratedArtifactsFailureCode,
} from './generated-artifacts';
import { validSha } from './merge-readiness-stack';

export function validateCheckFailureEvidenceList(
  checkFailures: readonly RequiredCheckFailureEvidenceV1[],
  expectedHeadSha: string,
  expectedBaseSha: string,
  onIncomplete: (detail: string) => void,
): void {
  // An indexed loop visits every slot: a hole in a sparse array is validated as undefined and fails closed.
  for (let index = 0; index < checkFailures.length; index++) {
    const failure = checkFailures[index]!;
    try {
      validateRequiredCheckFailureEvidence(failure);
    } catch {
      onIncomplete(`provider check_failures[${index}] is invalid`);
      continue;
    }
    const mismatched = [
      ...(failure.head_sha === expectedHeadSha ? [] : [`check_failures[${index}].head_sha`]),
      ...(failure.base_sha === expectedBaseSha ? [] : [`check_failures[${index}].base_sha`]),
    ];
    if (mismatched.length > 0) {
      onIncomplete(`provider ${mismatched.join(' and ')} does not match the expected value`);
    }
  }
}

export function isValidRollbackBoundary(
  boundary: unknown,
  providerBaseSha: string,
  expectedBaseSha: string,
): boolean {
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) return false;
  const candidate = boundary as Record<string, unknown>;
  if (candidate.status === 'not_active') return true;
  if (candidate.status !== 'ready') return false;
  return Number.isSafeInteger(candidate.pr_number)
    && Number(candidate.pr_number) >= 1
    && validSha(candidate.before_sha)
    && validSha(candidate.after_sha)
    && candidate.before_sha !== candidate.after_sha
    && candidate.after_sha === providerBaseSha
    && candidate.after_sha === expectedBaseSha;
}

export function evaluateGeneratedArtifactsFacts(
  generated: GeneratedArtifactsFactsV1 | null,
  providerHeadSha: string,
  providerBaseSha: string,
  expectedHeadSha: string,
  expectedBaseSha: string,
  onBlocker: (code: 'provider_data_incomplete' | GeneratedArtifactsFailureCode, detail: string) => void,
): void {
  if (generated?.status === 'invalid') {
    onBlocker(
      'generated_artifacts_policy_invalid',
      `generated-artifact policy is invalid: ${generated.message}; fix publication.generated_artifacts in .ai/harness/policy.json on the base branch`,
    );
  } else if (generated?.status === 'active') {
    const check = generated.check;
    if (!check || typeof check !== 'object' || Array.isArray(check)
      || check.head_sha !== providerHeadSha || check.base_sha !== providerBaseSha
      || check.head_sha !== expectedHeadSha || check.base_sha !== expectedBaseSha) {
      onBlocker('provider_data_incomplete', 'generated-artifact check does not bind the expected head and base');
    } else if (check.failure !== null) {
      const failure = check.failure;
      if (!GENERATED_ARTIFACTS_FAILURE_CODES.includes(failure?.code as GeneratedArtifactsFailureCode)
        || typeof failure.message !== 'string' || failure.message.trim() === '') {
        onBlocker('provider_data_incomplete', 'generated-artifact check failure is malformed');
      } else {
        onBlocker(failure.code, failure.message);
      }
    }
  }
}
