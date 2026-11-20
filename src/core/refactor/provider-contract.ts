import {
  isRepoRelativePosixPath,
  type ArchitectureRepositoryIdentityV1,
  type ArchitectureWorktreeIdentityV1,
  type ModuleStatisticsSnapshotV1,
  type RecommendationV3,
  type RefactorAssessmentV1,
  type RefactorRequestV1,
  type RefactorScopeV1,
} from "archctx-contracts";

export type RefactorDecision = "accept" | "defer" | "reject";
export type { RefactorScopeV1 };

export const REFACTOR_MIN_TIMEOUT_MS = 1_000;
export const REFACTOR_DEFAULT_TIMEOUT_MS = 120_000;
export const REFACTOR_MAX_TIMEOUT_MS = 600_000;

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

/** `ArchctxClient.json()` already proved the envelope and refused error envelopes; this checks the payload schemaVersion. */
export function refactorEnvelopeData(value: unknown, requestId: string, schemaVersion: string): Record<string, unknown> {
  const envelope = record(value, requestId);
  const data = record(envelope.data, `${requestId}.data`);
  if (data.schemaVersion !== schemaVersion) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned an unexpected result shape`);
  }
  return data;
}
