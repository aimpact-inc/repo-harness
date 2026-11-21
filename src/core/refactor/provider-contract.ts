import {
  isRepoRelativePosixPath,
  type ArchitectureRepositoryIdentityV1,
  type ArchitectureWorktreeIdentityV1,
  type ModuleStatisticsSnapshotV1,
  type RecommendationStatus,
  type RecommendationV3,
  type RefactorAssessmentV1,
  type RefactorDecisionV1,
  type RefactorResolutionDisposition,
  type RefactorResolutionEvidenceV1,
  type RefactorRequestV1,
  type RefactorScopeV1,
} from "archctx-contracts";

export const REFACTOR_DECISIONS = ["accept", "defer", "reject", "acknowledge", "waive"] as const;
export type RefactorDecision = (typeof REFACTOR_DECISIONS)[number];
export type { RefactorScopeV1 };

export const REFACTOR_MIN_TIMEOUT_MS = 1_000;
export const REFACTOR_DEFAULT_TIMEOUT_MS = 120_000;
export const REFACTOR_MAX_TIMEOUT_MS = 600_000;

export const SHA256_PREFIXED_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const GIT_COMMIT_SHA = /^[a-f0-9]{40}$/;
export const REFACTOR_RECOMMENDATION_ID = /^recommendation\.[a-f0-9]{16}$/;

export class RefactorProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly action?: string,
    readonly reasonCode?: string,
  ) {
    super(message);
    this.name = "RefactorProviderError";
  }
}

export interface RefactorScanResultV1 {
  schemaVersion: "archcontext.runtime-refactor-scan/v1";
  repository: ArchitectureRepositoryIdentityV1;
  worktree: ArchitectureWorktreeIdentityV1;
  requestId: string;
  request: RefactorRequestV1;
  snapshot: ModuleStatisticsSnapshotV1;
  assessment: RefactorAssessmentV1;
  proposedRecommendations: RecommendationV3[];
  openRecommendations: RecommendationV3[];
  snapshotDigest: string;
}

export interface RefactorVerifyResultV1 {
  schemaVersion: "archcontext.runtime-refactor-verify/v1";
  repository: ArchitectureRepositoryIdentityV1;
  worktree: ArchitectureWorktreeIdentityV1;
  recommendationId: string;
  recommendationStatus: RecommendationStatus;
  disposition: RefactorResolutionDisposition | null;
  resolutionDigest: string | null;
  evidence: RefactorResolutionEvidenceV1 | null;
  resolveCommand: string | null;
  evidenceItemIds: string[];
  evidenceBindingIds: string[];
}

export interface RefactorRecordResultV1 {
  schemaVersion: "archcontext.runtime-refactor-record/v1";
  repository: ArchitectureRepositoryIdentityV1;
  worktree: ArchitectureWorktreeIdentityV1;
  assessmentDigest: string;
  runId: string;
  recommendationIds: string[];
  recommendations: RecommendationV3[];
}

export interface RefactorRecommendationListResultV1 {
  schemaVersion: "archcontext.runtime-recommendation-list/v1";
  status: RecommendationStatus;
  count: number;
  recommendations: RecommendationV3[];
  decisions: RefactorDecisionV1[];
}

export interface RefactorRecommendationShowResultV1 {
  schemaVersion: "archcontext.runtime-recommendation-show/v1";
  recommendationId: string;
  source: string;
  status: RecommendationStatus;
  statusAuthority: string;
  gitDecision?: RefactorDecisionV1;
  recommendation: RecommendationV3 | null;
  baseline: { status: string; snapshotDigest: string | null };
}

export interface RefactorLifecycleResultV1 {
  schemaVersion: "archcontext.runtime-recommendation-lifecycle/v1";
  action: string;
  recommendationId: string;
  previousStatus: RecommendationStatus;
  nextStatus: RecommendationStatus;
  recommendation: RecommendationV3;
  decisionFile: string | null;
}

export function normalizeRefactorScope(input: { node?: string; paths?: readonly string[] }): RefactorScopeV1 {
  const nodeId = input.node?.trim();
  const paths = input.paths;
  if (nodeId !== undefined && paths !== undefined && paths.length > 0) {
    throw new RefactorProviderError("refactor_invalid_scope", "--node and --path cannot be combined");
  }
  if (input.node !== undefined) {
    if (!nodeId) throw new RefactorProviderError("refactor_invalid_scope", "--node requires a non-empty node id");
    return { kind: "node", nodeId };
  }
  if (paths !== undefined && paths.length > 0) {
    const uniqueSorted = [...new Set(paths)].sort();
    for (const path of uniqueSorted) {
      if (!isRepoRelativePosixPath(path)) {
        throw new RefactorProviderError("refactor_invalid_scope", `--path must be a repo-relative POSIX path: ${path}`);
      }
    }
    return { kind: "paths", paths: uniqueSorted };
  }
  return { kind: "repository" };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RefactorProviderError("refactor_provider_result_invalid", `${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Rewrite any upstream `archctx recommendations resolve` hint to the repo-harness `rh arch refactor resolve` CLI surface. */
export function rewriteRefactorResolveCommand(resolveCommand: string | null): string | null {
  if (resolveCommand === null) return null;
  return resolveCommand.replace(
    /^archctx recommendations resolve --id (\S+)/u,
    "rh arch refactor resolve $1",
  );
}

/** `ArchctxClient.json()` already proved the envelope and refused error envelopes; this checks the payload schemaVersion. */
export function refactorEnvelopeData(value: unknown, requestId: string, schemaVersion: string): Record<string, unknown> {
  const envelope = record(value, requestId);
  const data = record(envelope.data, `${requestId}.data`);
  if (data.schemaVersion !== schemaVersion) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned an unexpected result shape`);
  }
  return data;
}
