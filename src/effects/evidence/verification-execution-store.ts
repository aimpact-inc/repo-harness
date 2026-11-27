import { isAbsolute, resolve } from "path";

import { canonicalize } from "../../core/evidence/canonical-json";
import { redactPayloadStrings } from "../../core/evidence/redaction";
import { sha256Prefixed } from "../../core/evidence/sha256";
import type { AdmittedReviewSubjectIdentity, EvalCatalogSubjectIdentity, JsonValue } from "../../core/evidence/types";
import {
  fingerprintVerificationCheck,
  fingerprintVerificationCheckExecution,
  type VerificationCheck,
} from "../../core/evidence/verification-plan";
import { createFileExclusiveDurably, writeFileDurably } from "../atomic-append";
import { resolveInsideRepo } from "../path-safety";
import { LEDGER_EPOCH_START_SHA } from "./epoch";
import { appendEvidenceEvent, appendGenesisRecord, readGenesisRecord } from "./event-log";
import { collectDenylistSecretValues } from "./secret-env";
import {
  EVENT_TYPE,
  PRODUCER,
  type ExecutionPayload,
  type ExecutionReport,
  type VerificationExecutionResult,
} from "./verification-ledger-view";
import {
  declaredEnvironmentHash,
  redactKnownEnvironmentValues,
  type PreparedContext,
} from "./verification-toolchain";

function subjectIdentity(
  context: PreparedContext,
  check: VerificationCheck,
): AdmittedReviewSubjectIdentity | EvalCatalogSubjectIdentity {
  return {
    authority_commit: context.snapshot.head_commit,
    base_commit: context.snapshot.head_commit,
    target_commit: context.snapshot.tree_hash,
    scope_hash: context.planHash,
    subject_hash: context.snapshot.snapshot_hash,
    ...context.binding,
    plan_hash: context.planHash,
    command_hash: fingerprintVerificationCheck(check),
    env_provider_id: context.envProviderId,
  };
}

function ensureGenesis(context: PreparedContext): void {
  if (readGenesisRecord(context.repoRoot)) return;
  const worktreeId = `verification-${sha256Prefixed(canonicalize(context.binding)).slice(7, 27)}`;
  appendGenesisRecord(context.repoRoot, LEDGER_EPOCH_START_SHA, { worktreeId });
}

export interface RecordExecutedCheckInput {
  readonly context: PreparedContext;
  readonly check: VerificationCheck;
  readonly cacheKey: string;
  readonly executionId: string;
  readonly runFile: string;
  readonly failureLogFile: string | null;
  readonly message: string;
  readonly run: {
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: string | null;
  };
  readonly result: VerificationExecutionResult;
  readonly assertLockOwned: () => void;
}

/** Persist the immutable failure log, durable run record, and ledger event for one executed check. */
export function recordExecutedCheck(input: RecordExecutedCheckInput): void {
  const { context, check, cacheKey, executionId, runFile, failureLogFile, message, run, result, assertLockOwned } = input;
  if (failureLogFile) {
    const failureLogPath = resolveInsideRepo(context.repoRoot, failureLogFile);
    if (!failureLogPath.ok || !failureLogPath.path) throw new Error(failureLogPath.error ?? "invalid failure log path");
    const diagnostics = redactKnownEnvironmentValues(
      [message, run.stdout, run.stderr || run.error].filter(Boolean).join("\n"),
      context.env,
    );
    createFileExclusiveDurably(failureLogPath.path, Buffer.from(`${diagnostics}\n`, "utf8"));
  }
  const durableRecord = {
    protocol: 1,
    kind: "verification_execution_record",
    execution_id: executionId,
    cache_key: cacheKey,
    result,
  } as const;
  const runPath = resolveInsideRepo(context.repoRoot, runFile);
  if (!runPath.ok || !runPath.path) throw new Error(runPath.error ?? "invalid verification run path");
  const durableBytes = Buffer.from(`${JSON.stringify(durableRecord, null, 2)}\n`, "utf8");
  createFileExclusiveDurably(runPath.path, durableBytes);
  ensureGenesis(context);
  const genesis = readGenesisRecord(context.repoRoot)!;
  const payload: ExecutionPayload = {
    protocol: 2,
    ...context.binding,
    plan_hash: context.planHash,
    check_id: check.id,
    check_fingerprint: fingerprintVerificationCheck(check),
    execution_spec_hash: fingerprintVerificationCheckExecution(check),
    inputs_hash: declaredEnvironmentHash(check, context.env),
    toolchain_hash: context.toolchainHash,
    snapshot_hash: context.snapshot.snapshot_hash,
    cache_key: cacheKey,
    execution_id: executionId,
    run_file: runFile,
    run_record_hash: sha256Prefixed(durableBytes),
    passed: result.passed,
  };
  assertLockOwned();
  if (result.passed) context.assertCurrent();
  // SAFETY: ExecutionPayload contains only JSON-serializable primitive fields.
  const payloadJson = payload as unknown as JsonValue;
  appendEvidenceEvent(context.repoRoot, {
    worktreeId: genesis.worktree_id,
    eventType: EVENT_TYPE,
    trustClass: "authoritative_machine",
    producer: PRODUCER,
    correlationRunId: executionId,
    subjectIdentity: subjectIdentity(context, check),
    payload: { kind: "json", value: payloadJson },
  });
}

export function redactExecutionReport<T extends ExecutionReport>(report: T): T {
  // SAFETY: ExecutionReport is a plain JSON structure and redactPayloadStrings preserves its shape while replacing secret strings.
  return redactPayloadStrings(report as unknown as JsonValue, collectDenylistSecretValues()) as unknown as T;
}

export function writeRedactedExecutionReport(
  repoRoot: string,
  relativePath: string,
  report: ExecutionReport,
): void {
  const outputPath = isAbsolute(relativePath) ? relativePath : resolve(repoRoot, relativePath);
  writeFileDurably(outputPath, `${JSON.stringify(redactExecutionReport(report), null, 2)}\n`);
}
