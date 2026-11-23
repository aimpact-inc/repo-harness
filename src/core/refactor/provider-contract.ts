import {
  isRepoRelativePosixPath,
  isValidRefactorKillListSymbolTarget,
  RECOMMENDATION_STATUSES,
  REFACTOR_DECISION_FILE_PATTERN,
  REFACTOR_DECISION_REASON_MAX_LENGTH,
  REFACTOR_RECOMMENDATION_ID_PATTERN,
  REFACTOR_SCAN_V2_SCHEMA_VERSION,
  REFACTOR_VERIFY_V2_SCHEMA_VERSION,
  refactorDecisionInvariantIssues,
  validateJsonSchema,
  type Json,
  type RecommendationStatus,
  type RefactorDecisionStatus,
  type RefactorDecisionV1,
  type RefactorKillListTargetV2,
  type RefactorScanFindingV2,
  type RefactorScanV2,
  type RefactorScopeV1,
  type RefactorVerifyV2,
} from "archctx-contracts";
import refactorScanV2Schema from "archctx-contracts/schemas/runtime/refactor-scan-v2.schema.json";
import refactorVerifyV2Schema from "archctx-contracts/schemas/runtime/refactor-verify-v2.schema.json";

export const REFACTOR_DECISIONS = ["accept", "defer", "reject", "acknowledge", "waive"] as const;
export type RefactorDecision = (typeof REFACTOR_DECISIONS)[number];
export const REFACTOR_DECISION_STATUS_BY_ACTION: Readonly<Record<RefactorDecision | "resolve", RefactorDecisionStatus>> = {
  accept: "accepted",
  defer: "deferred",
  reject: "rejected",
  acknowledge: "acknowledged",
  waive: "waived",
  resolve: "resolved",
};

export const REFACTOR_DECIDE_WRITE_SCHEMA_VERSION = "archcontext.refactor-decide-write/v1" as const;
export const REFACTOR_DECIDE_LIST_SCHEMA_VERSION = "archcontext.refactor-decide-list/v1" as const;
export const REFACTOR_DECIDE_SHOW_SCHEMA_VERSION = "archcontext.refactor-decide-show/v1" as const;
export const REFACTOR_LIST_STATUSES: readonly RecommendationStatus[] = RECOMMENDATION_STATUSES;

export const REFACTOR_MIN_TIMEOUT_MS = 1_000;
export const REFACTOR_DEFAULT_TIMEOUT_MS = 120_000;
export const REFACTOR_MAX_TIMEOUT_MS = 600_000;

export const SHA256_PREFIXED_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const REFACTOR_RECOMMENDATION_ID = REFACTOR_RECOMMENDATION_ID_PATTERN;

export type {
  RecommendationStatus,
  RefactorDecisionStatus,
  RefactorDecisionV1,
  RefactorKillListTargetV2,
  RefactorScanFindingV2,
  RefactorScanV2,
  RefactorScopeV1,
  RefactorVerifyV2,
};

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

export interface RefactorDecideResultV1 {
  recommendationId: string;
  status: RefactorDecisionStatus;
  filePath: string;
  decision: RefactorDecisionV1;
}

export interface RefactorResolveResultV1 extends RefactorDecideResultV1 {
  status: "resolved";
  verification: RefactorVerifyV2;
}

export interface RefactorDecideListResultV1 {
  schemaVersion: typeof REFACTOR_DECIDE_LIST_SCHEMA_VERSION;
  status: "all" | RecommendationStatus;
  count: number;
  decisions: RefactorDecisionV1[];
  openFindings: RefactorScanFindingV2[];
}

export interface RefactorDecideShowResultV1 {
  schemaVersion: typeof REFACTOR_DECIDE_SHOW_SCHEMA_VERSION;
  recommendationId: string;
  decision: RefactorDecisionV1 | null;
  finding: RefactorScanFindingV2 | null;
}

export interface RefactorKillListFlags {
  readonly killSymbols?: readonly string[];
  readonly killPaths?: readonly string[];
  readonly killRelations?: readonly string[];
}

type JsonSchema = Parameters<typeof validateJsonSchema>[0];
const REFACTOR_SCAN_FINDING_V2_SCHEMA = refactorScanV2Schema.properties.findings.items as unknown as JsonSchema;

export function assertRefactorRecommendationId(value: string): string {
  if (!REFACTOR_RECOMMENDATION_ID.test(value)) {
    throw new RefactorProviderError("refactor_invalid_input", "recommendationId must match recommendation.<16-hex>");
  }
  return value;
}

export function assertRefactorReason(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RefactorProviderError("refactor_invalid_input", "--reason must be non-empty");
  }
  if (trimmed.length > REFACTOR_DECISION_REASON_MAX_LENGTH) {
    throw new RefactorProviderError("refactor_invalid_input", `--reason must be at most ${REFACTOR_DECISION_REASON_MAX_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new RefactorProviderError("refactor_invalid_input", "--reason must be one line without control characters");
  }
  return trimmed;
}

export function assertResolutionDigest(value: string): string {
  if (!SHA256_PREFIXED_DIGEST.test(value)) {
    throw new RefactorProviderError("refactor_invalid_input", "--resolution-digest must be sha256:<64-hex>");
  }
  return value;
}

/**
 * Canonical Git-style repo-relative POSIX path. Rejects leading/trailing whitespace, control chars,
 * backslashes, leading/trailing `/`, Windows drive prefixes (`C:/...`), empty segments (`//`),
 * and `.` or `..` segments so pinned `archctx@0.18.0`'s literal `trackedSet.has(...)` check
 * cannot treat a noncanonical spelling of an existing file as removed.
 */
export function isCanonicalRepoRelativePosixPath(path: string): boolean {
  if (!isRepoRelativePosixPath(path) || path !== path.trim()) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (path.endsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

export function isCanonicalKillListSymbolTarget(target: string): boolean {
  if (!isValidRefactorKillListSymbolTarget(target)) return false;
  const hashIndex = target.indexOf("#");
  if (hashIndex <= 0) return false;
  return isCanonicalRepoRelativePosixPath(target.slice(0, hashIndex));
}

export function assertCanonicalKillListTargets(
  entries: readonly { readonly kind: string; readonly target: string; readonly required?: boolean }[],
  label: string,
): void {
  for (const entry of entries) {
    if (entry.required === false) continue;
    if (entry.kind === "path" && !isCanonicalRepoRelativePosixPath(entry.target)) {
      throw new RefactorProviderError(
        "refactor_invalid_kill_list",
        `${label} contains a noncanonical required path target: ${entry.target}. Update or retire the decision so required path targets use canonical repo-relative POSIX paths (no ./, //, .., backslashes, or drive prefixes).`,
      );
    }
    if (entry.kind === "symbol" && !isCanonicalKillListSymbolTarget(entry.target)) {
      throw new RefactorProviderError(
        "refactor_invalid_kill_list",
        `${label} contains a noncanonical required symbol target: ${entry.target}. Update or retire the decision so required symbol targets use canonical <repo-relative-path>#<symbol> paths.`,
      );
    }
  }
}

export function validateRefactorKillListFlags(input: RefactorKillListFlags): {
  killSymbols: string[];
  killPaths: string[];
  killRelations: string[];
} {
  const killSymbols = [...(input.killSymbols ?? [])];
  const killPaths = [...(input.killPaths ?? [])];
  const killRelations = [...(input.killRelations ?? [])];
  for (const symbol of killSymbols) {
    if (!isCanonicalKillListSymbolTarget(symbol)) {
      throw new RefactorProviderError("refactor_invalid_input", `--kill-symbol must be a canonical <repo-relative-path>#<symbol>: ${symbol}`);
    }
  }
  for (const path of killPaths) {
    if (!isCanonicalRepoRelativePosixPath(path)) {
      throw new RefactorProviderError("refactor_invalid_input", `--kill-path must be a canonical repo-relative POSIX path: ${path}`);
    }
  }
  for (const relation of killRelations) {
    if (relation.trim() === "" || /[\u0000-\u001f\u007f]/.test(relation)) {
      throw new RefactorProviderError("refactor_invalid_input", `--kill-relation must be a non-empty relation id: ${relation}`);
    }
  }
  return { killSymbols, killPaths, killRelations };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertJsonSchema<T>(schema: JsonSchema, value: unknown, label: string): T {
  const validation = validateJsonSchema(schema, value as Json);
  if (!validation.valid) {
    const detail = validation.issues.slice(0, 5).map((issue) => `${issue.path} ${issue.message}`).join("; ");
    throw new RefactorProviderError("refactor_provider_result_invalid", `${label} failed schema validation: ${detail}`);
  }
  return value as T;
}

function assertDecision(value: unknown, label: string, expectedRecommendationId?: string): RefactorDecisionV1 {
  const issues = refactorDecisionInvariantIssues(value, label);
  if (issues.length > 0) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${label} failed contract validation: ${issues.slice(0, 5).join("; ")}`);
  }
  const decision = value as RefactorDecisionV1;
  if (expectedRecommendationId !== undefined && decision.recommendationId !== expectedRecommendationId) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${label} returned decision for ${decision.recommendationId}, expected ${expectedRecommendationId}`);
  }
  return decision;
}

function assertDecisionFilePath(value: unknown, expectedRecommendationId: string, label: string): string {
  if (typeof value !== "string") {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${label}.filePath must be a string`);
  }
  const match = REFACTOR_DECISION_FILE_PATTERN.exec(value);
  if (!match || match[1] !== expectedRecommendationId) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${label}.filePath does not match ${expectedRecommendationId}: ${value}`);
  }
  return value;
}

function assertVerifyData(value: unknown, expectedRecommendationId: string, label: string): RefactorVerifyV2 {
  const verified = assertJsonSchema<RefactorVerifyV2>(refactorVerifyV2Schema as unknown as JsonSchema, value, label);
  if (verified.recommendationId !== expectedRecommendationId) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${label} returned recommendationId ${verified.recommendationId}, expected ${expectedRecommendationId}`);
  }
  assertCanonicalKillListTargets(verified.killListChecks, `${label}.killListChecks`);
  return verified;
}

/** `ArchctxClient.json()` already proved the envelope and refused error envelopes; this checks requestId and payload schemaVersion. */
export function refactorEnvelopeData(value: unknown, requestId: string, schemaVersion: string): Record<string, unknown> {
  const envelope = record(value, requestId);
  if (envelope.requestId !== requestId) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned mismatched requestId ${String(envelope.requestId)}`);
  }
  const data = record(envelope.data, `${requestId}.data`);
  if (data.schemaVersion !== schemaVersion) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned an unexpected result shape`);
  }
  return data;
}

export function decodeRefactorScanV2(value: unknown): RefactorScanV2 {
  const data = refactorEnvelopeData(value, "scan", REFACTOR_SCAN_V2_SCHEMA_VERSION);
  return assertJsonSchema<RefactorScanV2>(refactorScanV2Schema as unknown as JsonSchema, data, "scan");
}

export function decodeRefactorVerifyV2(value: unknown, expectedRecommendationId: string): RefactorVerifyV2 {
  const data = refactorEnvelopeData(value, "verify", REFACTOR_VERIFY_V2_SCHEMA_VERSION);
  return assertVerifyData(data, expectedRecommendationId, "verify");
}

export function decodeRefactorDecideResult(
  value: unknown,
  action: RefactorDecision,
  expectedRecommendationId: string,
): RefactorDecideResultV1 {
  const requestId = `decide.${action}`;
  const data = refactorEnvelopeData(value, requestId, REFACTOR_DECIDE_WRITE_SCHEMA_VERSION);
  const filePath = assertDecisionFilePath(data.filePath, expectedRecommendationId, requestId);
  const decision = assertDecision(data.decision, `${requestId}.decision`, expectedRecommendationId);
  const expectedStatus = REFACTOR_DECISION_STATUS_BY_ACTION[action];
  if (decision.status !== expectedStatus) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned status ${decision.status}, expected ${expectedStatus}`);
  }
  return {
    recommendationId: decision.recommendationId,
    status: decision.status,
    filePath,
    decision,
  };
}

export function decodeRefactorResolveResult(
  value: unknown,
  expectedRecommendationId: string,
  expectedResolutionDigest: string,
): RefactorResolveResultV1 {
  const requestId = "decide.resolve";
  const data = refactorEnvelopeData(value, requestId, REFACTOR_DECIDE_WRITE_SCHEMA_VERSION);
  const filePath = assertDecisionFilePath(data.filePath, expectedRecommendationId, requestId);
  const decision = assertDecision(data.decision, `${requestId}.decision`, expectedRecommendationId);
  if (decision.killList) {
    assertCanonicalKillListTargets(decision.killList, `${requestId}.decision.killList`);
  }
  if (decision.status !== "resolved") {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned status ${decision.status}, expected resolved`);
  }
  if (decision.resolutionDigest !== expectedResolutionDigest) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned decision resolutionDigest ${String(decision.resolutionDigest)}, expected ${expectedResolutionDigest}`);
  }
  const verification = assertVerifyData(data.verification, expectedRecommendationId, `${requestId}.verification`);
  if (verification.disposition !== "resolved" || verification.resolutionDigest !== expectedResolutionDigest) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId}.verification did not attest resolved disposition for ${expectedResolutionDigest}`);
  }
  return {
    recommendationId: decision.recommendationId,
    status: "resolved",
    filePath,
    decision,
    verification,
  };
}

export function decodeRefactorDecideListResult(
  value: unknown,
  expectedStatus?: RecommendationStatus,
): RefactorDecideListResultV1 {
  const requestId = "decide.list";
  const data = refactorEnvelopeData(value, requestId, REFACTOR_DECIDE_LIST_SCHEMA_VERSION);
  const status = expectedStatus ?? "all";
  if (data.status !== status) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned status ${String(data.status)}, expected ${status}`);
  }
  if (!Array.isArray(data.decisions) || !Array.isArray(data.openFindings)) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} must return decisions and openFindings arrays`);
  }
  const decisions = data.decisions.map((entry, index) => assertDecision(entry, `${requestId}.decisions[${index}]`));
  const openFindings = data.openFindings.map((entry, index) =>
    assertJsonSchema<RefactorScanFindingV2>(REFACTOR_SCAN_FINDING_V2_SCHEMA, entry, `${requestId}.openFindings[${index}]`),
  );
  if (typeof data.count !== "number" || !Number.isInteger(data.count) || data.count !== decisions.length + openFindings.length) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId}.count does not match decisions + openFindings`);
  }
  return {
    schemaVersion: REFACTOR_DECIDE_LIST_SCHEMA_VERSION,
    status,
    count: data.count,
    decisions,
    openFindings,
  };
}

export function decodeRefactorDecideShowResult(
  value: unknown,
  expectedRecommendationId: string,
): RefactorDecideShowResultV1 {
  const requestId = "decide.show";
  const data = refactorEnvelopeData(value, requestId, REFACTOR_DECIDE_SHOW_SCHEMA_VERSION);
  if (data.recommendationId !== expectedRecommendationId) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned recommendationId ${String(data.recommendationId)}, expected ${expectedRecommendationId}`);
  }
  const decision = data.decision === null
    ? null
    : assertDecision(data.decision, `${requestId}.decision`, expectedRecommendationId);
  const finding = data.finding === null
    ? null
    : assertJsonSchema<RefactorScanFindingV2>(REFACTOR_SCAN_FINDING_V2_SCHEMA, data.finding, `${requestId}.finding`);
  if (finding !== null && finding.recommendationId !== expectedRecommendationId) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId}.finding returned recommendationId ${finding.recommendationId}, expected ${expectedRecommendationId}`);
  }
  if (decision === null && finding === null) {
    throw new RefactorProviderError("refactor_provider_result_invalid", `${requestId} returned neither a decision nor a finding`);
  }
  return {
    schemaVersion: REFACTOR_DECIDE_SHOW_SCHEMA_VERSION,
    recommendationId: expectedRecommendationId,
    decision,
    finding,
  };
}
