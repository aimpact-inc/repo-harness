import { afterEach, describe, expect, test } from "bun:test";
import { errorEnvelope } from "archctx-contracts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideRecommendation, runRefactorScan } from "../src/effects/refactor/archctx-provider";
import { RefactorProviderError } from "../src/core/refactor/provider-contract";
import { ARCHCTX_REQUIRED_VERSION } from "../src/core/architecture/projection";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo(): string { const root = mkdtempSync(join(tmpdir(), "refactor-provider-")); roots.push(root); return root; }

// The pinned archctx-contracts package ships these fixtures: a real scan result and one recorded open suggestion.
const shipped = (name: string) => JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("archctx-contracts"))), "../fixtures/valid", name), "utf8"));
const shippedScan = () => shipped("runtime-refactor-scan.json");
const shippedRecord = () => shipped("recommendation-v3.json");
const scanDigest = shippedScan().snapshotDigest;

const envelope = (requestId: string, data: Record<string, unknown>) => ({ schemaVersion: "archcontext.envelope/v1", ok: true, requestId, data });
const lifecycle = (decision: string, status: string) => envelope(`recommendations.${decision}`, {
  schemaVersion: "archcontext.runtime-recommendation-lifecycle/v1", action: decision, recommendation: { ...shippedRecord(), status },
});

function runner(calls: string[][], respond: (args: readonly string[]) => unknown) {
  return (_binary: string, args: readonly string[]) => {
    calls.push([...args]);
    return { status: 0, signal: null, stderr: "", stdout: JSON.stringify(respond(args)) };
  };
}

describe("refactor archctx provider", () => {
  test("gets proposed and open recommendations and the decision digest from one scan", () => {
    const root = repo(); const calls: string[][] = [];
    const run = runner(calls, () => envelope("refactor.scan", { ...shippedScan(), openRecommendations: [shippedRecord()] }));
    const scan = runRefactorScan(root, { consumerRoot: process.cwd(), run });
    expect(scan.proposedRecommendations).toHaveLength(2);
    expect(scan.openRecommendations.map((entry) => entry.recommendationId)).toEqual([shippedRecord().recommendationId]);
    expect(scan.snapshotDigest).toBe(scanDigest);
    expect(calls).toEqual([["refactor", "scan", "--request-json", expect.any(String), "--json"]]);
  });

  test("passes the import node limit to the scan only when one is set", () => {
    const root = repo(); const calls: string[][] = [];
    const run = runner(calls, () => envelope("refactor.scan", shippedScan()));
    runRefactorScan(root, { consumerRoot: process.cwd(), run });
    runRefactorScan(root, { consumerRoot: process.cwd(), run }, 100);
    const [unlimited, limited] = calls.filter((args) => args[0] === "refactor");
    expect(unlimited).not.toContain("--import-node-limit");
    expect(limited!.slice(-3)).toEqual(["--import-node-limit", "100", "--json"]);
  });

  test("reports a scan timeout with a timeout-specific code and action", () => {
    const timedOut = () => ({ status: null, signal: null, stdout: "", stderr: "", timedOut: true });
    try {
      runRefactorScan(repo(), { consumerRoot: process.cwd(), run: timedOut }, undefined, 5000);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RefactorProviderError);
      expect(error).toMatchObject({ code: "refactor_provider_timeout", action: "raise-timeout-and-retry" });
      const message = (error as Error).message;
      expect(message).toContain("archctx refactor scan timed out after 5000 ms");
      expect(message).toContain("--timeout-ms");
      expect(message).not.toContain("arch projection");
      expect(message).not.toContain("request id");
    }
    try {
      decideRecommendation("rec.x", "accept", "reason", scanDigest, repo(), { consumerRoot: process.cwd(), run: timedOut }, undefined, 5000);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "refactor_provider_timeout", action: "raise-timeout-and-retry" });
      expect((error as Error).message).toContain("outcome unknown");
    }
  });

  test("passes the timeout to the archctx runner and defaults to 120000 ms", () => {
    const seen: number[] = [];
    const run = (_binary: string, args: readonly string[], runOptions: { timeoutMs: number }) => {
      seen.push(runOptions.timeoutMs);
      return { status: 0, signal: null, stderr: "", stdout: JSON.stringify(args[0] === "refactor" ? envelope("refactor.scan", shippedScan()) : lifecycle("reject", "rejected")) };
    };
    runRefactorScan(repo(), { consumerRoot: process.cwd(), run });
    runRefactorScan(repo(), { consumerRoot: process.cwd(), run }, undefined, 300_000);
    decideRecommendation("rec.x", "reject", "no", scanDigest, repo(), { consumerRoot: process.cwd(), run }, undefined, 45_000);
    expect(seen).toEqual([120_000, 300_000, 45_000]);
  });

  test("fails on another installed archctx version before any call and preserves upstream error code, action and message", () => {
    const consumerRoot = repo(); const calls: string[][] = [];
    const packageRoot = join(consumerRoot, "node_modules", "archctx");
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "archctx", version: "0.0.1", engines: { node: ">=22.22 <26" }, bin: { archctx: "./bin/archctx" } }));
    writeFileSync(join(packageRoot, "bin", "archctx"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(packageRoot, "bin", "archctx"), 0o755);
    expect(() => runRefactorScan(repo(), { consumerRoot, run: runner(calls, () => envelope("refactor.scan", shippedScan())) })).toThrow(`expected archctx@${ARCHCTX_REQUIRED_VERSION}, got archctx@0.0.1`);
    expect(calls).toEqual([]);
    const failing = runner([], () => errorEnvelope("recommendations.accept", "AC_REFACTOR_STALE", "recommendation not found: rec.x"));
    try {
      decideRecommendation("rec.x", "accept", "user agreed", scanDigest, repo(), { consumerRoot: process.cwd(), run: failing });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RefactorProviderError);
      expect(error).toMatchObject({ code: "AC_REFACTOR_STALE", action: "rerun-refactor-scan", message: "recommendation not found: rec.x" });
    }
  });

  test("decides a recorded id in one call, with no book read and no pre-scan", () => {
    const root = repo(); const calls: string[][] = [];
    // The book lists at most 12 records and would answer "truncated" for an id beyond that budget; the decision never asks it.
    const run = runner(calls, () => lifecycle("reject", "rejected"));
    const outsideBookBudget = shippedRecord().recommendationId;
    expect(decideRecommendation(outsideBookBudget, "reject", "not worth it", scanDigest, root, { consumerRoot: process.cwd(), run }).status).toBe("rejected");
    expect(calls).toEqual([["recommendations", "reject", "--id", outsideBookBudget, "--reason", "not worth it", "--snapshot-digest", scanDigest, "--json"]]);
  });

  test("sends the scan import node limit with the user decision", () => {
    const root = repo(); const calls: string[][] = [];
    const run = runner(calls, () => lifecycle("defer", "deferred"));
    expect(decideRecommendation("rec.1", "defer", "after the release", scanDigest, root, { consumerRoot: process.cwd(), run }, 100).status).toBe("deferred");
    expect(calls).toEqual([["recommendations", "defer", "--id", "rec.1", "--reason", "after the release", "--snapshot-digest", scanDigest, "--import-node-limit", "100", "--json"]]);
  });

  test("forwards node and paths scopes to refactor scan", () => {
    const root = repo(); const calls: string[][] = [];
    const run = runner(calls, () => envelope("refactor.scan", shippedScan()));
    runRefactorScan(root, { consumerRoot: process.cwd(), run }, undefined, undefined, { kind: "node", nodeId: "capability.runtime-harness.architecture" });
    runRefactorScan(root, { consumerRoot: process.cwd(), run }, undefined, undefined, { kind: "paths", paths: ["src/core/refactor/provider-contract.ts", "src/effects/refactor/recommendations.ts"] });
    expect(calls.map((args) => JSON.parse(args[3]!))).toEqual([
      { schemaVersion: "archcontext.refactor-request/v1", scope: { kind: "node", nodeId: "capability.runtime-harness.architecture" } },
      { schemaVersion: "archcontext.refactor-request/v1", scope: { kind: "paths", paths: ["src/core/refactor/provider-contract.ts", "src/effects/refactor/recommendations.ts"] } },
    ]);
  });

  test("preserves ArchctxClientError code, reasonCode, action and message instead of flattening non-timeout errors", () => {
    const root = repo();
    const withReason = runner([], () => errorEnvelope("refactor.scan", "AC_SCHEMA_INVALID", "invalid scope node", "refactor-scan-invalid"));
    try {
      runRefactorScan(root, { consumerRoot: process.cwd(), run: withReason });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RefactorProviderError);
      expect(error).toMatchObject({ code: "AC_SCHEMA_INVALID", reasonCode: "refactor-scan-invalid", action: "repair-model", message: "invalid scope node" });
    }

    const missingPackageRoot = repo();
    try {
      runRefactorScan(root, { consumerRoot: missingPackageRoot, run: runner([], () => envelope("refactor.scan", shippedScan())) });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RefactorProviderError);
      expect(error).toMatchObject({ code: "RH_ARCHCTX_PACKAGE_MISSING", action: "update-repo-harness" });
    }
  });
});
