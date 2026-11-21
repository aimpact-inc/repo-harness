import type { RecommendationStatus } from 'archctx-contracts';
import type {
  RefactorDecision,
  RefactorLifecycleResultV1,
  RefactorRecommendationListResultV1,
  RefactorRecommendationShowResultV1,
  RefactorRecordResultV1,
  RefactorVerifyResultV1,
} from '../../core/refactor/provider-contract';
import {
  decideRecommendation,
  listRefactorRecommendations,
  resolveRecommendation,
  runRefactorRecord,
  runRefactorVerify,
  showRefactorRecommendation,
} from '../../effects/refactor/archctx-provider';

/** `refactor decide` loads this module only after the architecture selection check. One archctx call decides a recorded suggestion or a fresh scan candidate. */
export function decideRefactorRecommendation(
  root: string,
  recommendationId: string,
  decision: RefactorDecision,
  reason: string,
  snapshotDigest: string,
  importNodeLimit?: number,
  timeoutMs?: number,
): string {
  return decideRecommendation(recommendationId, decision, reason, snapshotDigest, root, {}, importNodeLimit, timeoutMs).status;
}

export function verifyRefactorRecommendation(
  root: string,
  recommendationId: string,
  options: { expectedHeadSha?: string; expectedWorktreeDigest?: string; importNodeLimit?: number; timeoutMs?: number } = {},
): RefactorVerifyResultV1 {
  return runRefactorVerify(
    root,
    {
      recommendationId,
      expectedHeadSha: options.expectedHeadSha,
      expectedWorktreeDigest: options.expectedWorktreeDigest,
      importNodeLimit: options.importNodeLimit,
    },
    {},
    options.timeoutMs,
  );
}

export function resolveRefactorRecommendation(
  root: string,
  recommendationId: string,
  evidenceDigest: string,
  reason: string,
  snapshotDigest?: string,
  importNodeLimit?: number,
  timeoutMs?: number,
): RefactorLifecycleResultV1 {
  return resolveRecommendation(
    root,
    { recommendationId, evidenceDigest, reason, snapshotDigest, importNodeLimit },
    {},
    timeoutMs,
  );
}

export function recordRefactorAssessment(
  root: string,
  assessmentDigest: string,
  expectedWorktreeDigest: string,
  timeoutMs?: number,
): RefactorRecordResultV1 {
  return runRefactorRecord(root, assessmentDigest, expectedWorktreeDigest, {}, timeoutMs);
}

export function listRecordedRefactorRecommendations(
  root: string,
  status?: RecommendationStatus,
  timeoutMs?: number,
): RefactorRecommendationListResultV1 {
  return listRefactorRecommendations(root, status, {}, timeoutMs);
}

export function showRecordedRefactorRecommendation(
  root: string,
  recommendationId: string,
  importNodeLimit?: number,
  timeoutMs?: number,
): RefactorRecommendationShowResultV1 {
  return showRefactorRecommendation(root, recommendationId, {}, importNodeLimit, timeoutMs);
}
