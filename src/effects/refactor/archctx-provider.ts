import { ARCHCTX_REQUIRED_VERSION, ArchctxClientError } from "../../core/architecture/projection";
import type { ArchctxProviderOptions } from "../../core/architecture/contracts";
import {
  assertRefactorReason,
  assertRefactorRecommendationId,
  assertResolutionDigest,
  decodeRefactorDecideListResult,
  decodeRefactorDecideResult,
  decodeRefactorDecideShowResult,
  decodeRefactorResolveResult,
  decodeRefactorScanV2,
  decodeRefactorVerifyV2,
  normalizeRefactorScope,
  REFACTOR_DECISIONS,
  REFACTOR_DEFAULT_TIMEOUT_MS,
  REFACTOR_LIST_STATUSES,
  REFACTOR_MAX_TIMEOUT_MS,
  RefactorProviderError,
  validateRefactorKillListFlags,
  type RecommendationStatus,
  type RefactorDecideListResultV1,
  type RefactorDecideResultV1,
  type RefactorDecideShowResultV1,
  type RefactorDecision,
  type RefactorKillListFlags,
  type RefactorResolveResultV1,
  type RefactorScanV2,
  type RefactorScopeV1,
  type RefactorVerifyV2,
} from "../../core/refactor/provider-contract";
import { commandLabel, runPackageLocalArchctxJson } from "../architecture/archctx-provider";

const MUTATING_DECIDE_ACTIONS = new Set<string>(["accept", "defer", "reject", "acknowledge", "waive", "resolve"]);

/** Package resolution refuses an installed archctx whose manifest is not the pinned version. */
function invoke(repoRoot: string, args: readonly string[], options: ArchctxProviderOptions, timeoutMs: number): unknown {
  try {
    return runPackageLocalArchctxJson(repoRoot, ARCHCTX_REQUIRED_VERSION, args, options, timeoutMs).value;
  } catch (error) {
    if (error instanceof RefactorProviderError) throw error;
    if (error instanceof ArchctxClientError) {
      if (error.code === "RH_ARCHCTX_TIMEOUT") {
        // Only mutating `decide <verb|resolve>` calls write `.archcontext/refactor-decisions/`.
        const isMutating = args[0] === "decide" && MUTATING_DECIDE_ACTIONS.has(args[1] ?? "");
        const outcome = isMutating
          ? " Decision outcome unknown: archctx may already have written `.archcontext/refactor-decisions/`. Run `rh arch refactor show <id>` or `git status` to check before retrying."
          : "";
        throw new RefactorProviderError(
          "refactor_provider_timeout",
          `${commandLabel(args)} timed out after ${timeoutMs} ms.${outcome} Retry with --timeout-ms <larger value> (max ${REFACTOR_MAX_TIMEOUT_MS}).`,
          "raise-timeout-and-retry",
          error.reasonCode,
        );
      }
      throw new RefactorProviderError(error.code, error.providerMessage, error.action, error.reasonCode);
    }
    throw new RefactorProviderError("refactor_provider_unavailable", error instanceof Error ? error.message : String(error));
  }
}

function scopeArgs(scope: RefactorScopeV1): string[] {
  const normalized = scope.kind === "node"
    ? normalizeRefactorScope({ node: scope.nodeId })
    : scope.kind === "paths"
      ? normalizeRefactorScope({ paths: scope.paths })
      : { kind: "repository" as const };
  if (normalized.kind === "node") return ["--node", normalized.nodeId];
  if (normalized.kind === "paths") return normalized.paths.flatMap((path) => ["--path", path]);
  return [];
}

function importNodeLimitArgs(importNodeLimit: number | undefined): string[] {
  return importNodeLimit === undefined ? [] : ["--import-node-limit", String(importNodeLimit)];
}

/** Pure-Git v2 refactor radar scan (`archctx scan --json`). Read-only. */
export function runRefactorScan(
  repoRoot: string,
  options: ArchctxProviderOptions = {},
  importNodeLimit?: number,
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
  scope: RefactorScopeV1 = { kind: "repository" },
): RefactorScanV2 {
  const args = ["scan", ...scopeArgs(scope), ...importNodeLimitArgs(importNodeLimit), "--json"];
  return decodeRefactorScanV2(invoke(repoRoot, args, options, timeoutMs));
}

export interface DecideRecommendationInput extends RefactorKillListFlags {
  readonly recommendationId: string;
  readonly decision: RefactorDecision;
  readonly reason: string;
  readonly importNodeLimit?: number;
}

/** Write a Git-tracked human decision in `.archcontext/refactor-decisions/<id>.json` via `archctx decide <verb>`. */
export function decideRecommendation(
  repoRoot: string,
  input: DecideRecommendationInput,
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorDecideResultV1 {
  const recommendationId = assertRefactorRecommendationId(input.recommendationId);
  if (!REFACTOR_DECISIONS.includes(input.decision)) {
    throw new RefactorProviderError("refactor_invalid_input", `decision must be one of ${REFACTOR_DECISIONS.join("|")}`);
  }
  const reason = assertRefactorReason(input.reason);
  const kill = validateRefactorKillListFlags(input);
  const hasKillList = kill.killSymbols.length > 0 || kill.killPaths.length > 0 || kill.killRelations.length > 0;
  if (hasKillList && input.decision !== "accept") {
    throw new RefactorProviderError("refactor_invalid_input", "--kill-symbol, --kill-path, and --kill-relation are only valid with decision \"accept\"");
  }
  const args = [
    "decide",
    input.decision,
    recommendationId,
    "--reason",
    reason,
    ...kill.killSymbols.flatMap((symbol) => ["--kill-symbol", symbol]),
    ...kill.killPaths.flatMap((path) => ["--kill-path", path]),
    ...kill.killRelations.flatMap((relation) => ["--kill-relation", relation]),
    ...importNodeLimitArgs(input.importNodeLimit),
    "--json",
  ];
  return decodeRefactorDecideResult(invoke(repoRoot, args, options, timeoutMs), input.decision, recommendationId);
}

export interface VerifyRefactorInput {
  readonly recommendationId: string;
  readonly importNodeLimit?: number;
}

/** Re-measure HEAD live against one recorded refactor decision (`archctx verify <id> --json`). Read-only. */
export function runRefactorVerify(
  repoRoot: string,
  input: VerifyRefactorInput,
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorVerifyV2 {
  const recommendationId = assertRefactorRecommendationId(input.recommendationId);
  const args = ["verify", recommendationId, ...importNodeLimitArgs(input.importNodeLimit), "--json"];
  return decodeRefactorVerifyV2(invoke(repoRoot, args, options, timeoutMs), recommendationId);
}

export interface ResolveRecommendationInput {
  readonly recommendationId: string;
  readonly resolutionDigest: string;
  readonly reason: string;
  readonly importNodeLimit?: number;
}

/** Mark a verified refactor decision resolved in `.archcontext/refactor-decisions/<id>.json` using its attested resolution digest. */
export function resolveRecommendation(
  repoRoot: string,
  input: ResolveRecommendationInput,
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorResolveResultV1 {
  const recommendationId = assertRefactorRecommendationId(input.recommendationId);
  const resolutionDigest = assertResolutionDigest(input.resolutionDigest);
  const reason = assertRefactorReason(input.reason);
  const args = [
    "decide",
    "resolve",
    recommendationId,
    "--resolution-digest",
    resolutionDigest,
    "--reason",
    reason,
    ...importNodeLimitArgs(input.importNodeLimit),
    "--json",
  ];
  return decodeRefactorResolveResult(invoke(repoRoot, args, options, timeoutMs), recommendationId, resolutionDigest);
}

export interface ListRefactorInput {
  readonly status?: RecommendationStatus;
  readonly importNodeLimit?: number;
}

/**
 * List Git-tracked decisions and best-effort open findings via `archctx decide list --json`. Read-only.
 * Note: upstream `archctx decide list` swallows scan errors into `openFindings: []`; use
 * `rh arch refactor recommendations` for authoritative scan results with coverage.
 */
export function listRefactorRecommendations(
  repoRoot: string,
  input: ListRefactorInput = {},
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorDecideListResultV1 {
  if (input.status !== undefined && !REFACTOR_LIST_STATUSES.includes(input.status)) {
    throw new RefactorProviderError("refactor_invalid_input", `--status must be one of ${REFACTOR_LIST_STATUSES.join("|")}`);
  }
  const args = [
    "decide",
    "list",
    ...(input.status === undefined ? [] : ["--status", input.status]),
    ...importNodeLimitArgs(input.importNodeLimit),
    "--json",
  ];
  return decodeRefactorDecideListResult(invoke(repoRoot, args, options, timeoutMs), input.status);
}

export interface ShowRefactorInput {
  readonly recommendationId: string;
  readonly importNodeLimit?: number;
}

/**
 * Show one Git-tracked decision and best-effort live finding via `archctx decide show <id> --json`. Read-only.
 * Note: upstream `archctx decide show` swallows scan errors into `finding: null`; use
 * `rh arch refactor recommendations` for authoritative scan coverage.
 */
export function showRefactorRecommendation(
  repoRoot: string,
  input: ShowRefactorInput,
  options: ArchctxProviderOptions = {},
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorDecideShowResultV1 {
  const recommendationId = assertRefactorRecommendationId(input.recommendationId);
  const args = ["decide", "show", recommendationId, ...importNodeLimitArgs(input.importNodeLimit), "--json"];
  return decodeRefactorDecideShowResult(invoke(repoRoot, args, options, timeoutMs), recommendationId);
}
