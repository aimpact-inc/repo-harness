import type { AcceptanceReceipt } from './acceptance-receipt';
import type { ReviewAdmission } from './authority-context';
import type { UserWaiverGrant } from './waiver-grant';

/**
 * Stable identifiers for every rule the shared synchronous validator applies.
 * They exist so a second reader can enumerate the rule set and declare, per
 * rule, how it is covered on its own path.
 */
export type AcceptanceValidatorRuleId =
  | 'receipt_protocol_kind'
  | 'check_failure_evidence'
  | 'required_check_coverage_evidence'
  | 'repository_root'
  | 'campaign_identity'
  | 'admission_binding'
  | 'reviewer_policy'
  | 'grant_digest_shape'
  | 'goal_fingerprint'
  | 'verification_file_shape'
  | 'verification_evidence_shape'
  | 'benchmark_evidence_present'
  | 'subject_sha256_shape'
  | 'subject_scope'
  | 'target_ref_present'
  | 'target_revision_shape'
  | 'reviewed_paths_shape'
  | 'summary_present'
  | 'issued_at_shape'
  | 'disposition_not_reject'
  | 'waiver_grant_present'
  | 'waiver_policy_allowed'
  | 'waiver_grant_repository'
  | 'waiver_grant_admission'
  | 'waiver_grant_goal'
  | 'waiver_grant_owner'
  | 'waiver_grant_fingerprint'
  | 'waiver_binding_symmetry'
  | 'disposition_policy'
  | 'validator_threw';

export const ACCEPTANCE_VALIDATOR_RULE_IDS: readonly AcceptanceValidatorRuleId[] = [
  'receipt_protocol_kind', 'check_failure_evidence', 'required_check_coverage_evidence', 'repository_root', 'campaign_identity', 'admission_binding',
  'reviewer_policy', 'grant_digest_shape', 'goal_fingerprint', 'verification_file_shape',
  'verification_evidence_shape', 'benchmark_evidence_present', 'subject_sha256_shape',
  'subject_scope', 'target_ref_present', 'target_revision_shape', 'reviewed_paths_shape',
  'summary_present', 'issued_at_shape', 'disposition_not_reject', 'waiver_grant_present',
  'waiver_policy_allowed', 'waiver_grant_repository', 'waiver_grant_admission',
  'waiver_grant_goal', 'waiver_grant_owner', 'waiver_grant_fingerprint',
  'waiver_binding_symmetry', 'disposition_policy', 'validator_threw',
];

export type AcceptanceReceiptPolicyVerdict =
  | { ok: true }
  | { ok: false; rule: AcceptanceValidatorRuleId; reason: string };

export type AcceptanceReceiptPolicyInput = {
  receipt: AcceptanceReceipt;
  repositoryRoot: string;
  admission: ReviewAdmission;
  grantSha256: string;
  waiverGrant: UserWaiverGrant | null;
};

/**
 * Every AcceptanceReceipt key the shared synchronous validator below consumes.
 * A test asserts against this list so a key added to the receipt without a
 * rule, or a rule silently dropped, fails rather than quietly widening what
 * this gate counts as accepted.
 */
export const CONSUMED_RECEIPT_KEYS: readonly (keyof AcceptanceReceipt)[] = [
  'protocol', 'kind', 'repository_root', 'campaign_sha256', 'admission_sha256',
  'grant_sha256', 'goal_sha256', 'verification_file', 'verification_evidence_sha256',
  'benchmark_evidence_sha256', 'subject_sha256', 'subject_scope', 'target_ref',
  'target_revision', 'reviewed_paths', 'disposition', 'expected_reviewer',
  'reviewer', 'source', 'actor', 'summary', 'findings', 'failures', 'required_check_coverage', 'waiver_grant_sha256',
  'issued_at', 'request_id', 'context_sha256', 'result_sha256', 'actual_harness', 'actual_role', 'actual_model',
  'author_session_binding_sha256', 'author_actual_models', 'model_relation',
];
