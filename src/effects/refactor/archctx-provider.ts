import type { RecommendationStatus, RecommendationV3, RefactorScopeV1 } from "archctx-contracts";
import { ARCHCTX_REQUIRED_VERSION, ArchctxClientError } from "../../core/architecture/projection";
import type { ArchctxProviderOptions } from "../../core/architecture/contracts";
import { canonicalize } from "../../core/evidence/canonical-json";
import {
  GIT_COMMIT_SHA,
  REFACTOR_DEFAULT_TIMEOUT_MS,
  REFACTOR_MAX_TIMEOUT_MS,
  refactorEnvelopeData,
  RefactorProviderError,
  rewriteRefactorResolveCommand,
  SHA256_PREFIXED_DIGEST,
  type RefactorDecision,
  type RefactorLifecycleResultV1,
  type RefactorRecommendationListResultV1,
  type RefactorRecommendationShowResultV1,
  type RefactorRecordResultV1,
  type RefactorScanResultV1,
  type RefactorVerifyResultV1,
} from "../../core/refactor/provider-contract";
import { commandLabel, runPackageLocalArchctxJson } from "../architecture/archctx-provider";

const MUTATING_REFACTOR_COMMANDS = new Set(["record", "verify"]);
const READ_ONLY_RECOMMENDATION_COMMANDS = new Set(["list", "show", "metrics"]);

/** Package resolution refuses an installed archctx whose manifest is not the pinned version. */
function invoke(repoRoot: string, args: readonly string[], options: ArchctxProviderOptions, timeoutMs: number): unknown {
  try {
    return runPackageLocalArchctxJson(repoRoot, ARCHCTX_REQUIRED_VERSION, args, options, timeoutMs).value;
  } catch (error) {
    if (error instanceof RefactorProviderError) throw error;
    if (error instanceof ArchctxClientError) {
      if (error.code === "RH_ARCHCTX_TIMEOUT") {
        // Mutating recommendation/refactor calls can finish inside archctx after repo-harness stops waiting.
        const isMutating = (args[0] === "recommendations" && !READ_ONLY_RECOMMENDATION_COMMANDS.has(args[1] ?? ""))
          || (args[0] === "refactor" && MUTATING_REFACTOR_COMMANDS.has(args[1] ?? ""));
        const outcome = isMutating ? " Decision outcome unknown: archctx may already have recorded the change. Run `rh arch refactor recommendations` or `rh arch refactor show <id>` to check before retrying." : "";
        throw new RefactorProviderError("refactor_provider_timeout", `${commandLabel(args)} timed out after ${timeoutMs} ms.${outcome} Retry with --timeout-ms <larger value> (max ${REFACTOR_MAX_TIMEOUT_MS}).`, "raise-timeout-and-retry", error.reasonCode);
      }
      throw new RefactorProviderError(error.code, error.providerMessage, error.action, error.reasonCode);
    }
    throw new RefactorProviderError("refactor_provider_unavailable", error instanceof Error ? error.message : String(error));
  }
}

export function runRefactorScan(
  repoRoot: string,
  options: ArchctxProviderOptions = {},
  importNodeLimit?: number,
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
  scope: RefactorScopeV1 = { kind: "repository" },
): RefactorScanResultV1 {
  const request = { schemaVersion: "archcontext.refactor-request/v1", scope };
  const value = invoke(repoRoot, ["refactor", "scan", "--request-json", canonicalize(request as never), ...importNodeLimitArgs(importNodeLimit), "--json"], options, timeoutMs);
  const data = refactorEnvelopeData(value, "refactor.scan", "archcontext.runtime-refactor-scan/v1");
  if (typeof data.snapshotDigest !== "string" || !SHA256_PREFIXED_DIGEST.test(data.snapshotDigest) || !Array.isArray(data.openRecommendations)) {
    throw new RefactorProviderError("refactor_provider_result_invalid", "refactor.scan returned no decision snapshot digest or open recommendations array");
  }
  return data as unknown as RefactorScanResultV1;
}

/** Decide against the exact scan that returned the suggestion. */
export function decideRecommendation(
  recommendationId: string,
  decision: RefactorDecision,
  reason: string,
  snapshotDigest: string,
  repoRoot: string,
  options: ArchctxProviderOptions = {},
  importNodeLimit?: number,
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RecommendationV3 {
  const data = refactorEnvelopeData(
    invoke(repoRoot, ["recommendations", decision, "--id", recommendationId, "--reason", reason, "--snapshot-digest", snapshotDigest, ...importNodeLimitArgs(importNodeLimit), "--json"], options, timeoutMs),
    `recommendations.${decision}`,
    "archcontext.runtime-recommendation-lifecycle/v1",
  );
  return data.recommendation as RecommendationV3;
}

export interface VerifyRefactorInput {
  readonly recommendationId: string;
  readonly expectedHeadSha?: string;
  readonly expectedWorktreeDigest?: string;
  readonly importNodeLimit?: number;
}

/** Re-measure HEAD against one recorded recommendation and return the resolution verdict. */
export function runRefactorVerify(
  repoRoot: string,
  input: VerifyRefactorInput,
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorVerifyResultV1 {
  if (!input.recommendationId.trim()) {
    throw new RefactorProviderError("refactor_invalid_input", "recommendationId must be non-empty");
  }
  if (input.expectedHeadSha !== undefined && !GIT_COMMIT_SHA.test(input.expectedHeadSha)) {
    throw new RefactorProviderError("refactor_invalid_input", "--expected-head-sha must be a 40-hex Git SHA");
  }
  if (input.expectedWorktreeDigest !== undefined && !SHA256_PREFIXED_DIGEST.test(input.expectedWorktreeDigest)) {
    throw new RefactorProviderError("refactor_invalid_input", "--expected-worktree-digest must be sha256:<64-hex>");
  }
  const request = {
    schemaVersion: "archcontext.refactor-verification-request/v1",
    recommendationId: input.recommendationId,
    ...(input.expectedHeadSha === undefined ? {} : { expectedHeadSha: input.expectedHeadSha }),
    ...(input.expectedWorktreeDigest === undefined ? {} : { expectedWorktreeDigest: input.expectedWorktreeDigest }),
  };
  const value = invoke(
    repoRoot,
    ["refactor", "verify", "--request-json", canonicalize(request as never), ...importNodeLimitArgs(input.importNodeLimit), "--json"],
    options,
    timeoutMs,
  );
  const data = refactorEnvelopeData(value, "refactor.verify", "archcontext.runtime-refactor-verify/v1") as unknown as RefactorVerifyResultV1;
  return {
    ...data,
    resolveCommand: rewriteRefactorResolveCommand(data.resolveCommand),
  };
}

export interface ResolveRecommendationInput {
  readonly recommendationId: string;
  readonly evidenceDigest: string;
  readonly reason: string;
  readonly snapshotDigest?: string;
  readonly importNodeLimit?: number;
}

/** Close a verified refactor recommendation in `.archcontext/refactor-decisions/<id>.json` using its resolution evidence digest. */
export function resolveRecommendation(
  repoRoot: string,
  input: ResolveRecommendationInput,
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorLifecycleResultV1 {
  if (!SHA256_PREFIXED_DIGEST.test(input.evidenceDigest)) {
    throw new RefactorProviderError("refactor_invalid_input", "--evidence-digest must be sha256:<64-hex>");
  }
  if (input.snapshotDigest !== undefined && !SHA256_PREFIXED_DIGEST.test(input.snapshotDigest)) {
    throw new RefactorProviderError("refactor_invalid_input", "--snapshot-digest must be sha256:<64-hex>");
  }
  const args = [
    "recommendations",
    "resolve",
    "--id",
    input.recommendationId,
    "--evidence-digest",
    input.evidenceDigest,
    "--reason",
    input.reason,
    ...(input.snapshotDigest === undefined ? [] : ["--snapshot-digest", input.snapshotDigest]),
    ...importNodeLimitArgs(input.importNodeLimit),
    "--json",
  ];
  const data = refactorEnvelopeData(invoke(repoRoot, args, options, timeoutMs), "recommendations.resolve", "archcontext.runtime-recommendation-lifecycle/v1");
  return data as unknown as RefactorLifecycleResultV1;
}

/** Persist a scanned refactor assessment into the local ArchContext ledger before verification. */
export function runRefactorRecord(
  repoRoot: string,
  assessmentDigest: string,
  expectedWorktreeDigest: string,
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorRecordResultV1 {
  if (!SHA256_PREFIXED_DIGEST.test(assessmentDigest)) {
    throw new RefactorProviderError("refactor_invalid_input", "--assessment-digest must be sha256:<64-hex>");
  }
  if (!SHA256_PREFIXED_DIGEST.test(expectedWorktreeDigest)) {
    throw new RefactorProviderError("refactor_invalid_input", "--expected-worktree-digest must be sha256:<64-hex>");
  }
  const value = invoke(
    repoRoot,
    ["refactor", "record", "--assessment-digest", assessmentDigest, "--expected-worktree-digest", expectedWorktreeDigest, "--json"],
    options,
    timeoutMs,
  );
  return refactorEnvelopeData(value, "refactor.record", "archcontext.runtime-refactor-record/v1") as unknown as RefactorRecordResultV1;
}

export function listRefactorRecommendations(
  repoRoot: string,
  status?: RecommendationStatus,
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorRecommendationListResultV1 {
  const args = ["recommendations", "list", ...(status === undefined ? [] : ["--status", status]), "--json"];
  return refactorEnvelopeData(invoke(repoRoot, args, options, timeoutMs), "recommendations.list", "archcontext.runtime-recommendation-list/v1") as unknown as RefactorRecommendationListResultV1;
}

export function showRefactorRecommendation(
  repoRoot: string,
  recommendationId: string,
  options: ArchctxProviderOptions = {},
  importNodeLimit?: number,
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorRecommendationShowResultV1 {
  const args = ["recommendations", "show", "--id", recommendationId, ...importNodeLimitArgs(importNodeLimit), "--json"];
  return refactorEnvelopeData(invoke(repoRoot, args, options, timeoutMs), "recommendations.show", "archcontext.runtime-recommendation-show/v1") as unknown as RefactorRecommendationShowResultV1;
}

function importNodeLimitArgs(importNodeLimit: number | undefined): string[] {
  return importNodeLimit === undefined ? [] : ["--import-node-limit", String(importNodeLimit)];
}
