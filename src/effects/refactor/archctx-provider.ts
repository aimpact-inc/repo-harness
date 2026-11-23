import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHCTX_REQUIRED_VERSION, ArchctxClientError } from "../../core/architecture/projection";
import type { ArchctxProviderOptions } from "../../core/architecture/contracts";
import {
  assertCanonicalKillListTargets,
  assertRefactorReason,
  assertRefactorRecommendationId,
  assertResolutionDigest,
  decodeRefactorDecideListResult,
  decodeRefactorDecideResult,
  decodeRefactorDecideShowResult,
  decodeRefactorResolveResult,
  decodeRefactorScanV2,
  decodeRefactorVerifyV2,
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
  type RefactorVerifyV2,
} from "../../core/refactor/provider-contract";
import { assertSafeArchctxRepoRoot, commandLabel, runPackageLocalArchctxJson, sanitizeGitDiscoveryEnv } from "../architecture/archctx-provider";
import { gitSpawnSync } from "../git/runner";

const MUTATING_DECIDE_ACTIONS = new Set<string>(["accept", "defer", "reject", "acknowledge", "waive", "resolve"]);

function readNullDelimitedGitPaths(verifiedRoot: string, args: readonly string[], env: NodeJS.ProcessEnv): string[] | null {
  const result = gitSpawnSync(["-C", verifiedRoot, ...args], { encoding: "utf8", env });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.split("\0").filter(Boolean);
}

function requiredKillTargetPaths(
  entries: readonly { readonly kind: string; readonly target: string; readonly required?: boolean }[],
): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.required === false) continue;
    if (entry.kind === "path") {
      paths.push(entry.target);
    } else if (entry.kind === "symbol") {
      const hashIndex = entry.target.indexOf("#");
      if (hashIndex > 0) paths.push(entry.target.slice(0, hashIndex));
    }
  }
  return paths;
}

/**
 * Rejects required path/symbol targets whose spelling differs only in ASCII case from a live
 * tracked, HEAD, or untracked path in `verifiedRoot` so a case-insensitive checkout cannot treat
 * an alias (such as `agents.md` beside tracked `AGENTS.md`) as removed on verify/resolve.
 */
function assertNoCaseAliasedKillListTargets(
  verifiedRoot: string,
  entries: readonly { readonly kind: string; readonly target: string; readonly required?: boolean }[],
  label: string,
  env: NodeJS.ProcessEnv = process.env,
  baselineHeadSha?: string,
): void {
  const targets = requiredKillTargetPaths(entries);
  if (targets.length === 0) return;

  const cleanEnv = sanitizeGitDiscoveryEnv(env);
  const indexPaths = readNullDelimitedGitPaths(verifiedRoot, ["ls-files", "-z"], cleanEnv) ?? [];
  const headPaths = readNullDelimitedGitPaths(verifiedRoot, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], cleanEnv) ?? [];
  const untrackedPaths = readNullDelimitedGitPaths(verifiedRoot, ["ls-files", "--others", "--exclude-standard", "-z"], cleanEnv) ?? [];
  const exactPaths = new Set<string>([...indexPaths, ...headPaths, ...untrackedPaths]);
  const lowerToExact = new Map<string, string>();
  for (const path of exactPaths) {
    const lower = path.toLowerCase();
    if (!lowerToExact.has(lower)) lowerToExact.set(lower, path);
  }

  const ignoreCaseProbe = gitSpawnSync(["-C", verifiedRoot, "config", "--bool", "--get", "core.ignorecase"], {
    encoding: "utf8",
    env: cleanEnv,
  });
  const caseInsensitive = ignoreCaseProbe.status === 0 && ignoreCaseProbe.stdout.trim() === "true";

  let baselineExact: Set<string> | null | undefined;
  const loadBaselineExact = (): Set<string> | null => {
    if (baselineExact !== undefined) return baselineExact;
    if (!baselineHeadSha) {
      baselineExact = null;
      return baselineExact;
    }
    const entriesAtBase = readNullDelimitedGitPaths(verifiedRoot, ["ls-tree", "-r", "-z", "--name-only", baselineHeadSha], cleanEnv);
    baselineExact = entriesAtBase ? new Set(entriesAtBase) : null;
    return baselineExact;
  };

  for (const targetPath of targets) {
    if (exactPaths.has(targetPath)) continue;
    const conflicting = lowerToExact.get(targetPath.toLowerCase());
    if (!conflicting) continue;
    // On case-sensitive Git, allow a legitimately deleted distinct baseline spelling.
    if (baselineHeadSha !== undefined && !caseInsensitive) {
      const baseline = loadBaselineExact();
      if (baseline !== null && baseline.has(targetPath)) continue;
    }
    throw new RefactorProviderError(
      "refactor_invalid_kill_list",
      `${label} target ${JSON.stringify(targetPath)} differs only in case from tracked or live path ${JSON.stringify(conflicting)}; use the exact Git path spelling.`,
    );
  }
}

function assertStoredDecisionCanonicalKillList(
  verifiedRoot: string,
  recommendationId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const decisionPath = join(verifiedRoot, ".archcontext", "refactor-decisions", `${recommendationId}.json`);
  if (!existsSync(decisionPath)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(decisionPath, "utf8"));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const killList = (parsed as { killList?: unknown }).killList;
  if (!Array.isArray(killList)) return;
  const entries = killList.filter(
    (entry): entry is { kind: string; target: string; required?: boolean } =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
      && typeof (entry as { kind?: unknown }).kind === "string"
      && typeof (entry as { target?: unknown }).target === "string",
  );
  const label = `.archcontext/refactor-decisions/${recommendationId}.json killList`;
  assertCanonicalKillListTargets(entries, label);
  const provenance = (parsed as { provenance?: unknown }).provenance;
  const baselineHeadSha = provenance && typeof provenance === "object" && !Array.isArray(provenance)
    && typeof (provenance as { headSha?: unknown }).headSha === "string"
    ? (provenance as { headSha: string }).headSha
    : undefined;
  assertNoCaseAliasedKillListTargets(verifiedRoot, entries, label, env, baselineHeadSha);
}

function verifyRefactorRoot(repoRoot: string, options: ArchctxProviderOptions, label: string): string {
  try {
    return assertSafeArchctxRepoRoot(repoRoot, options.env ?? process.env, label);
  } catch (error) {
    if (error instanceof ArchctxClientError) {
      throw new RefactorProviderError(error.code, error.providerMessage, error.action, error.reasonCode);
    }
    throw new RefactorProviderError("refactor_provider_unavailable", error instanceof Error ? error.message : String(error));
  }
}

/** Package resolution refuses an installed archctx whose manifest is not the pinned version. */
function invoke(repoRoot: string, args: readonly string[], options: ArchctxProviderOptions, timeoutMs: number): unknown {
  try {
    const verifiedRoot = verifyRefactorRoot(repoRoot, options, `refactor ${commandLabel(args)}`);
    const cleanOptions: ArchctxProviderOptions = {
      ...options,
      env: sanitizeGitDiscoveryEnv(options.env ?? process.env),
    };
    return runPackageLocalArchctxJson(verifiedRoot, ARCHCTX_REQUIRED_VERSION, args, cleanOptions, timeoutMs).value;
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

function importNodeLimitArgs(importNodeLimit: number | undefined): string[] {
  return importNodeLimit === undefined ? [] : ["--import-node-limit", String(importNodeLimit)];
}

/** Pure-Git v2 refactor radar scan (`archctx scan --json`). Read-only, repository-scoped to match `decide` and `show`. */
export function runRefactorScan(
  repoRoot: string,
  options: ArchctxProviderOptions = {},
  importNodeLimit?: number,
  timeoutMs = REFACTOR_DEFAULT_TIMEOUT_MS,
): RefactorScanV2 {
  const args = ["scan", ...importNodeLimitArgs(importNodeLimit), "--json"];
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
  const verifiedRoot = verifyRefactorRoot(repoRoot, options, "refactor decide");
  if (hasKillList) {
    assertNoCaseAliasedKillListTargets(
      verifiedRoot,
      [
        ...kill.killPaths.map((target) => ({ kind: "path", target, required: true })),
        ...kill.killSymbols.map((target) => ({ kind: "symbol", target, required: true })),
      ],
      "refactor decide",
      options.env,
    );
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
  return decodeRefactorDecideResult(invoke(verifiedRoot, args, options, timeoutMs), input.decision, recommendationId);
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
  const verifiedRoot = verifyRefactorRoot(repoRoot, options, "refactor verify");
  assertStoredDecisionCanonicalKillList(verifiedRoot, recommendationId, options.env);
  const args = ["verify", recommendationId, ...importNodeLimitArgs(input.importNodeLimit), "--json"];
  return decodeRefactorVerifyV2(invoke(verifiedRoot, args, options, timeoutMs), recommendationId);
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
  const verifiedRoot = verifyRefactorRoot(repoRoot, options, "refactor decide resolve");
  assertStoredDecisionCanonicalKillList(verifiedRoot, recommendationId, options.env);
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
  return decodeRefactorResolveResult(invoke(verifiedRoot, args, options, timeoutMs), recommendationId, resolutionDigest);
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
