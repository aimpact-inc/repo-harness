import type {
  RecommendationStatus,
  RefactorDecideListResultV1,
  RefactorDecideResultV1,
  RefactorDecideShowResultV1,
  RefactorDecision,
  RefactorKillListFlags,
  RefactorResolveResultV1,
  RefactorVerifyV2,
} from '../../core/refactor/provider-contract';
import {
  decideRecommendation,
  listRefactorRecommendations,
  resolveRecommendation,
  runRefactorVerify,
  showRefactorRecommendation,
} from '../../effects/refactor/archctx-provider';

export interface DecideRefactorOptions extends RefactorKillListFlags {
  readonly importNodeLimit?: number;
  readonly timeoutMs?: number;
}

/** `refactor decide` loads this module only after the architecture selection check. */
export function decideRefactorRecommendation(
  root: string,
  recommendationId: string,
  decision: RefactorDecision,
  reason: string,
  options: DecideRefactorOptions = {},
): RefactorDecideResultV1 {
  return decideRecommendation(
    root,
    {
      recommendationId,
      decision,
      reason,
      killSymbols: options.killSymbols,
      killPaths: options.killPaths,
      killRelations: options.killRelations,
      importNodeLimit: options.importNodeLimit,
    },
    {},
    options.timeoutMs,
  );
}

export function verifyRefactorRecommendation(
  root: string,
  recommendationId: string,
  options: { importNodeLimit?: number; timeoutMs?: number } = {},
): RefactorVerifyV2 {
  return runRefactorVerify(
    root,
    { recommendationId, importNodeLimit: options.importNodeLimit },
    {},
    options.timeoutMs,
  );
}

export function resolveRefactorRecommendation(
  root: string,
  recommendationId: string,
  resolutionDigest: string,
  reason: string,
  options: { importNodeLimit?: number; timeoutMs?: number } = {},
): RefactorResolveResultV1 {
  return resolveRecommendation(
    root,
    {
      recommendationId,
      resolutionDigest,
      reason,
      importNodeLimit: options.importNodeLimit,
    },
    {},
    options.timeoutMs,
  );
}

export function listRecordedRefactorRecommendations(
  root: string,
  options: { status?: RecommendationStatus; importNodeLimit?: number; timeoutMs?: number } = {},
): RefactorDecideListResultV1 {
  return listRefactorRecommendations(
    root,
    { status: options.status, importNodeLimit: options.importNodeLimit },
    {},
    options.timeoutMs,
  );
}

export function showRecordedRefactorRecommendation(
  root: string,
  recommendationId: string,
  options: { importNodeLimit?: number; timeoutMs?: number } = {},
): RefactorDecideShowResultV1 {
  return showRefactorRecommendation(
    root,
    { recommendationId, importNodeLimit: options.importNodeLimit },
    {},
    options.timeoutMs,
  );
}
