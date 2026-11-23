import { afterEach, describe, expect, test } from "bun:test";
import { digestJson, errorEnvelope, serializeRefactorDecision, type RefactorDecisionV1, type RefactorScanFindingV2, type RefactorScanV2, type RefactorVerifyV2 } from "archctx-contracts";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHCTX_REQUIRED_VERSION } from "../src/core/architecture/projection";
import { RefactorProviderError } from "../src/core/refactor/provider-contract";
import { formatRefactorVerify, resolveDecisionCommitRoot } from "../src/cli/commands/refactor";
import { resolveCompatibleNodeRuntime } from "../src/effects/architecture/archctx-provider";
import { recordPluginSelection } from "./helpers/install-ownership";
import {
  decideRecommendation,
  listRefactorRecommendations,
  resolveRecommendation,
  runRefactorScan,
  runRefactorVerify,
  showRefactorRecommendation,
} from "../src/effects/refactor/archctx-provider";
import { observeRefactorRecommendations } from "../src/effects/refactor/recommendations";

const REPO_ROOT = join(import.meta.dir, "..");
const RUNTIME_GITIGNORE = readFileSync(join(REPO_ROOT, "assets/templates/runtime.gitignore"), "utf8");
const CODEGRAPH_BIN = (() => {
  const pkgPath = createRequire(import.meta.url).resolve("@colbymchenry/codegraph/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: { codegraph: string } };
  return resolve(dirname(pkgPath), pkg.bin.codegraph);
})();

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchDir(prefix = "refactor-provider-"): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

const shippedDecision = (): RefactorDecisionV1 =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("archctx-contracts"))), "../fixtures/valid/refactor-decision.json"), "utf8")) as RefactorDecisionV1;

const HEAD_SHA = "a".repeat(40);
const SNAPSHOT_DIGEST = `sha256:${"1".repeat(64)}`;
const RESOLUTION_DIGEST = `sha256:${"2".repeat(64)}`;
const REC_ID = shippedDecision().recommendationId;

function sampleFinding(overrides: Partial<RefactorScanFindingV2> = {}): RefactorScanFindingV2 {
  return {
    recommendationId: REC_ID,
    fingerprint: shippedDecision().fingerprint,
    detector: "component-cycle",
    severity: "error",
    blocking: true,
    capabilityId: "capability.test.alpha",
    affectedNodeIds: ["capability.test.alpha", "capability.test.beta"],
    affectedPaths: ["src/alpha/index.ts", "src/beta/index.ts"],
    killList: [],
    metrics: { thinDirectionEdgeCount: 1, totalEdgeCount: 2 },
    evidence: { summary: "Bidirectional import cycle between alpha and beta.", thinDirectionEdgeCount: 1 },
    ...overrides,
  };
}

function sampleScan(overrides: Partial<RefactorScanV2> = {}): RefactorScanV2 {
  return {
    schemaVersion: "archcontext.refactor-scan/v2",
    scope: { kind: "repository" },
    headSha: HEAD_SHA,
    snapshotDigest: SNAPSHOT_DIGEST,
    coverage: { imports: "complete", gitHistory: "complete", reasonCodes: [] },
    findings: [sampleFinding()],
    suppressed: [],
    ...overrides,
  };
}

function sampleVerify(overrides: Partial<RefactorVerifyV2> = {}): RefactorVerifyV2 {
  return {
    schemaVersion: "archcontext.refactor-verify/v2",
    recommendationId: REC_ID,
    headSha: HEAD_SHA,
    snapshotDigest: SNAPSHOT_DIGEST,
    disposition: "resolved",
    resolutionDigest: RESOLUTION_DIGEST,
    killListChecks: [{ kind: "path", target: "src/beta/legacy.ts", required: true, status: "removed" }],
    metricChecks: [{ metric: "moduleDependencies.pairThinDirectionEdgeCount", before: 1, after: 0, satisfied: true }],
    blockingReasons: [],
    historicalReceipt: { status: "accepted", headSha: HEAD_SHA, resolutionDigest: null },
    ...overrides,
  };
}

const envelope = (requestId: string, data: Record<string, unknown>) => ({
  schemaVersion: "archcontext.envelope/v1",
  ok: true,
  requestId,
  data,
});

function runner(calls: string[][], respond: (args: readonly string[]) => unknown) {
  return (_binary: string, args: readonly string[]) => {
    calls.push([...args]);
    return { status: 0, signal: null, stderr: "", stdout: JSON.stringify(respond(args)) };
  };
}

describe("refactor v2 archctx provider", () => {
  test("routes repository-scoped scan with optional import-node-limit and validates against refactor-scan-v2 schema", () => {
    const root = scratchDir();
    const calls: string[][] = [];
    const run = runner(calls, (args) => {
      if (args.includes("--import-node-limit")) return envelope("scan", sampleScan({ importNodeLimit: 500 }));
      return envelope("scan", sampleScan());
    });

    const repoScan = runRefactorScan(root, { consumerRoot: REPO_ROOT, run });
    expect(repoScan.findings).toHaveLength(1);
    runRefactorScan(root, { consumerRoot: REPO_ROOT, run }, 500);

    expect(calls).toEqual([
      ["scan", "--json"],
      ["scan", "--import-node-limit", "500", "--json"],
    ]);

    const malformed = runner([], () => envelope("scan", { ...sampleScan(), coverage: { imports: "bogus", gitHistory: "complete", reasonCodes: [] } }));
    expect(() => runRefactorScan(root, { consumerRoot: REPO_ROOT, run: malformed })).toThrow(RefactorProviderError);
    const wrongRequestId = runner([], () => envelope("refactor.scan", sampleScan()));
    expect(() => runRefactorScan(root, { consumerRoot: REPO_ROOT, run: wrongRequestId })).toThrow("mismatched requestId");
  });

  test("classifies only mutating decide commands as outcome-unknown on timeout and forwards timeoutMs", () => {
    const root = scratchDir();
    const timedOut = () => ({ status: null, signal: null, stdout: "", stderr: "", timedOut: true });

    for (const invokeReadOnly of [
      () => runRefactorScan(root, { consumerRoot: REPO_ROOT, run: timedOut }, undefined, 5_000),
      () => runRefactorVerify(root, { recommendationId: REC_ID }, { consumerRoot: REPO_ROOT, run: timedOut }, 5_000),
      () => listRefactorRecommendations(root, {}, { consumerRoot: REPO_ROOT, run: timedOut }, 5_000),
      () => showRefactorRecommendation(root, { recommendationId: REC_ID }, { consumerRoot: REPO_ROOT, run: timedOut }, 5_000),
    ]) {
      try {
        invokeReadOnly();
        throw new Error("expected timeout");
      } catch (error) {
        expect(error).toBeInstanceOf(RefactorProviderError);
        expect(error).toMatchObject({ code: "refactor_provider_timeout", action: "raise-timeout-and-retry" });
        expect((error as Error).message).not.toContain("outcome unknown");
      }
    }

    for (const invokeMutating of [
      () => decideRecommendation(root, { recommendationId: REC_ID, decision: "accept", reason: "fix cycle" }, { consumerRoot: REPO_ROOT, run: timedOut }, 5_000),
      () => resolveRecommendation(root, { recommendationId: REC_ID, resolutionDigest: RESOLUTION_DIGEST, reason: "fixed" }, { consumerRoot: REPO_ROOT, run: timedOut }, 5_000),
    ]) {
      try {
        invokeMutating();
        throw new Error("expected timeout");
      } catch (error) {
        expect(error).toMatchObject({ code: "refactor_provider_timeout", action: "raise-timeout-and-retry" });
        expect((error as Error).message).toContain("outcome unknown");
      }
    }

    const seenTimeouts: number[] = [];
    const recordTimeout = (_binary: string, args: readonly string[], runOptions: { timeoutMs: number }) => {
      seenTimeouts.push(runOptions.timeoutMs);
      const data = args[0] === "scan"
        ? envelope("scan", sampleScan())
        : envelope("verify", sampleVerify());
      return { status: 0, signal: null, stderr: "", stdout: JSON.stringify(data) };
    };
    runRefactorScan(root, { consumerRoot: REPO_ROOT, run: recordTimeout });
    runRefactorVerify(root, { recommendationId: REC_ID }, { consumerRoot: REPO_ROOT, run: recordTimeout }, 45_000);
    expect(seenTimeouts).toEqual([120_000, 45_000]);
  });

  test("refuses mismatched archctx version before invocation and preserves ArchctxClientError fields", () => {
    const consumerRoot = scratchDir();
    const calls: string[][] = [];
    const packageRoot = join(consumerRoot, "node_modules", "archctx");
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "archctx", version: "0.0.1", engines: { node: ">=22.22 <26" }, bin: { archctx: "./bin/archctx" } }));
    writeFileSync(join(packageRoot, "bin", "archctx"), "#!/bin/sh\nexit 99\n");
    chmodSync(join(packageRoot, "bin", "archctx"), 0o755);

    expect(() => runRefactorScan(scratchDir(), { consumerRoot, run: runner(calls, () => envelope("scan", sampleScan())) }))
      .toThrow(`expected archctx@${ARCHCTX_REQUIRED_VERSION}, got archctx@0.0.1`);
    expect(calls).toEqual([]);

    const withReason = runner([], () => errorEnvelope("decide.accept", "AC_REFACTOR_STALE", "recommendation not found", "recommendation-not-found"));
    try {
      decideRecommendation(scratchDir(), { recommendationId: REC_ID, decision: "accept", reason: "accepted" }, { consumerRoot: REPO_ROOT, run: withReason });
      throw new Error("expected error");
    } catch (error) {
      expect(error).toBeInstanceOf(RefactorProviderError);
      expect(error).toMatchObject({ code: "AC_REFACTOR_STALE", reasonCode: "recommendation-not-found", action: "rerun-refactor-scan", message: "recommendation not found" });
    }
  });

  test("routes decide, verify, resolve, list, and show exclusively through canonical v2 commands and validates payloads", () => {
    const root = scratchDir();
    const calls: string[][] = [];
    const decisionPath = `.archcontext/refactor-decisions/${REC_ID}.json`;
    const acceptedDecision: RefactorDecisionV1 = {
      ...shippedDecision(),
      status: "accepted",
      killList: [
        { kind: "symbol", target: "src/beta/legacy.ts#legacyBridge", required: true },
        { kind: "path", target: "src/beta/legacy.ts", required: true },
        { kind: "relation", target: "relation.beta.alpha", required: true },
      ],
    };
    const resolvedDecision: RefactorDecisionV1 = {
      ...acceptedDecision,
      status: "resolved",
      reason: "Resolved in #3388",
      resolutionDigest: RESOLUTION_DIGEST,
    };

    const run = runner(calls, (args) => {
      if (args[0] === "decide" && args[1] === "accept") {
        return envelope("decide.accept", {
          schemaVersion: "archcontext.refactor-decide-write/v1",
          decision: acceptedDecision,
          filePath: decisionPath,
        });
      }
      if (args[0] === "verify") {
        return envelope("verify", sampleVerify());
      }
      if (args[0] === "decide" && args[1] === "resolve") {
        return envelope("decide.resolve", {
          schemaVersion: "archcontext.refactor-decide-write/v1",
          decision: resolvedDecision,
          filePath: decisionPath,
          verification: sampleVerify(),
        });
      }
      if (args[0] === "decide" && args[1] === "list") {
        return envelope("decide.list", {
          schemaVersion: "archcontext.refactor-decide-list/v1",
          status: "accepted",
          count: 1,
          decisions: [acceptedDecision],
          openFindings: [],
        });
      }
      if (args[0] === "decide" && args[1] === "show") {
        return envelope("decide.show", {
          schemaVersion: "archcontext.refactor-decide-show/v1",
          recommendationId: REC_ID,
          decision: acceptedDecision,
          finding: sampleFinding(),
        });
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const decided = decideRecommendation(root, {
      recommendationId: REC_ID,
      decision: "accept",
      reason: "Break cycle cleanly",
      killSymbols: ["src/beta/legacy.ts#legacyBridge"],
      killPaths: ["src/beta/legacy.ts"],
      killRelations: ["relation.beta.alpha"],
      importNodeLimit: 500,
    }, { consumerRoot: REPO_ROOT, run });
    expect(decided).toEqual({ recommendationId: REC_ID, status: "accepted", filePath: decisionPath, decision: acceptedDecision });

    const verified = runRefactorVerify(root, { recommendationId: REC_ID, importNodeLimit: 500 }, { consumerRoot: REPO_ROOT, run });
    expect(verified.disposition).toBe("resolved");
    expect(verified.resolutionDigest).toBe(RESOLUTION_DIGEST);

    const resolved = resolveRecommendation(root, {
      recommendationId: REC_ID,
      resolutionDigest: RESOLUTION_DIGEST,
      reason: "Resolved in #3388",
      importNodeLimit: 500,
    }, { consumerRoot: REPO_ROOT, run });
    expect(resolved.status).toBe("resolved");
    expect(resolved.decision.resolutionDigest).toBe(RESOLUTION_DIGEST);
    expect(resolved.verification.disposition).toBe("resolved");

    const listed = listRefactorRecommendations(root, { status: "accepted", importNodeLimit: 500 }, { consumerRoot: REPO_ROOT, run });
    expect(listed.count).toBe(1);
    expect(listed.decisions).toHaveLength(1);

    const shown = showRefactorRecommendation(root, { recommendationId: REC_ID, importNodeLimit: 500 }, { consumerRoot: REPO_ROOT, run });
    expect(shown.decision?.recommendationId).toBe(REC_ID);
    expect(shown.finding?.detector).toBe("component-cycle");

    expect(calls).toEqual([
      [
        "decide", "accept", REC_ID, "--reason", "Break cycle cleanly",
        "--kill-symbol", "src/beta/legacy.ts#legacyBridge",
        "--kill-path", "src/beta/legacy.ts",
        "--kill-relation", "relation.beta.alpha",
        "--import-node-limit", "500", "--json",
      ],
      ["verify", REC_ID, "--import-node-limit", "500", "--json"],
      ["decide", "resolve", REC_ID, "--resolution-digest", RESOLUTION_DIGEST, "--reason", "Resolved in #3388", "--import-node-limit", "500", "--json"],
      ["decide", "list", "--status", "accepted", "--import-node-limit", "500", "--json"],
      ["decide", "show", REC_ID, "--import-node-limit", "500", "--json"],
    ]);

    expect(() => decideRecommendation(root, {
      recommendationId: REC_ID,
      decision: "defer",
      reason: "later",
      killPaths: ["src/beta/legacy.ts"],
    }, { consumerRoot: REPO_ROOT, run })).toThrow('only valid with decision "accept"');

    expect(() => resolveRecommendation(root, {
      recommendationId: REC_ID,
      resolutionDigest: "not-a-digest",
      reason: "invalid",
    }, { consumerRoot: REPO_ROOT, run })).toThrow("--resolution-digest must be sha256:<64-hex>");
  });
});

describe("real archctx 0.18.2 pure-Git refactor lifecycle (end-to-end)", () => {
  function runGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string {
    return execFileSync("git", [...args], { cwd, env, encoding: "utf8" }).trim();
  }

  function runCodeGraph(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
    const nodeBin = resolveCompatibleNodeRuntime(env);
    const result = spawnSync(nodeBin, [CODEGRAPH_BIN, ...args], {
      cwd,
      env: { ...env, CODEGRAPH_NO_DOWNLOAD: "1", CODEGRAPH_TELEMETRY: "0" },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`codegraph ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}\n${result.stdout}`);
    }
  }

  function writeRepoFile(repoRoot: string, relPath: string, content: string): void {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  test("executes scan -> decide accept -> git track -> verify (unresolved & stale) -> fix -> sync -> verify (resolved) -> resolve -> shallow clean-clone check", () => {
    const base = scratchDir("refactor-v2-e2e-");
    const home = join(base, "home");
    const stateDir = join(base, "archctx-state");
    const repoRoot = join(base, "repo");
    const shallowClone = join(base, "shallow-clone");
    mkdirSync(home, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repoRoot, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      ARCHCONTEXT_STATE_DIR: stateDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };

    runGit(repoRoot, ["init", "-q"], env);
    runGit(repoRoot, ["config", "maintenance.auto", "false"], env);
    runGit(repoRoot, ["config", "gc.auto", "0"], env);

    writeRepoFile(repoRoot, ".gitignore", RUNTIME_GITIGNORE);
    writeRepoFile(repoRoot, ".archcontext/manifest.yaml", JSON.stringify({
      schemaVersion: "archcontext.manifest/v1",
      product: { id: "product.test-refactor", name: "Test Refactor" },
      model: { layout: "split", root: ".archcontext/model" },
      runtime: { contextBudgetBytes: 12288 },
    }, null, 2) + "\n");
    writeRepoFile(repoRoot, ".archcontext/model/nodes/capability.test.alpha.yaml", JSON.stringify({
      schemaVersion: "archcontext.node/v2",
      id: "capability.test.alpha",
      kind: "capability",
      name: "Alpha",
      status: "active",
      summary: "Alpha capability.",
      responsibilities: ["Own alpha logic."],
      source: { include: ["src/alpha/**"] },
    }, null, 2) + "\n");
    writeRepoFile(repoRoot, ".archcontext/model/nodes/capability.test.beta.yaml", JSON.stringify({
      schemaVersion: "archcontext.node/v2",
      id: "capability.test.beta",
      kind: "capability",
      name: "Beta",
      status: "active",
      summary: "Beta capability.",
      responsibilities: ["Own beta logic."],
      source: { include: ["src/beta/**"] },
    }, null, 2) + "\n");
    mkdirSync(join(repoRoot, ".archcontext/model/relations"), { recursive: true });
    mkdirSync(join(repoRoot, ".archcontext/model/flows"), { recursive: true });

    // Create a real mutual import cycle between capability.test.alpha and capability.test.beta.
    writeRepoFile(repoRoot, "src/alpha/index.ts", 'import { betaValue } from "../beta/index";\nexport const alphaValue = () => betaValue() + 1;\nexport const alphaBase = () => 1;\n');
    writeRepoFile(repoRoot, "src/beta/legacy.ts", 'import { alphaBase } from "../alpha/index";\nexport function legacyCycleBridge(): number { return alphaBase(); }\n');
    writeRepoFile(repoRoot, "src/beta/index.ts", 'import { legacyCycleBridge } from "./legacy";\nexport const betaValue = () => legacyCycleBridge() + 1;\n');

    runGit(repoRoot, ["add", "."], env);
    runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial cycle fixture"], env);

    // 1. Before indexing CodeGraph, scan reports proof_required with incomplete import coverage.
    const unindexed = observeRefactorRecommendations(repoRoot, { env });
    expect(unindexed.schemaVersion).toBe("repo-harness.refactor-recommendations/v3");
    expect(unindexed.status).toBe("proof_required");
    expect(unindexed.coverage?.imports).not.toBe("complete");
    expect(unindexed.message).toContain("codegraph init");

    // Index with real package-local CodeGraph.
    runCodeGraph(repoRoot, ["init", "-y", "."], env);

    // 2. Low import-node-limit triggers code-facts-import-limit proof_required with actionable guidance.
    const limited = observeRefactorRecommendations(repoRoot, { env, importNodeLimit: 1 });
    expect(limited.status).toBe("proof_required");
    expect(limited.coverage?.reasonCodes).toContain("code-facts-import-limit");
    expect(limited.message).toContain("--import-node-limit");
    expect(limited.message).not.toContain("codegraph init");

    // 3. Full scan discovers the real component-cycle finding; show returns the open finding before a decision exists.
    const scanned = observeRefactorRecommendations(repoRoot, { env });
    expect(scanned.status).toBe("recommended");
    expect(scanned.coverage?.imports).toBe("complete");
    const cycleFinding = scanned.findings.find((finding) => finding.detector === "component-cycle");
    expect(cycleFinding).toBeDefined();
    expect(cycleFinding!.evidence.observation).toMatchObject({ kind: "cycle" });
    const recId = cycleFinding!.recommendationId;

    const shownBefore = showRefactorRecommendation(repoRoot, { recommendationId: recId }, { consumerRoot: REPO_ROOT, env });
    expect(shownBefore.decision).toBeNull();
    expect(shownBefore.finding?.recommendationId).toBe(recId);

    // 3b. Noncanonical kill-path and kill-symbol spellings against an existing tracked file are refused before invoking archctx.
    for (const badPath of ["./src/beta/legacy.ts", "src/./beta/legacy.ts", "src//beta/legacy.ts", "C:/src/beta/legacy.ts"]) {
      expect(() => decideRecommendation(repoRoot, {
        recommendationId: recId,
        decision: "accept",
        reason: "Noncanonical kill-path must be rejected",
        killPaths: [badPath],
      }, { consumerRoot: REPO_ROOT, env })).toThrow("canonical repo-relative POSIX path");
      expect(() => decideRecommendation(repoRoot, {
        recommendationId: recId,
        decision: "accept",
        reason: "Noncanonical kill-symbol must be rejected",
        killSymbols: [`${badPath}#legacyCycleBridge`],
      }, { consumerRoot: REPO_ROOT, env })).toThrow("canonical <repo-relative-path>#<symbol>");
    }

    // 4. Decide accept with explicit kill-symbol and kill-path targets.
    const decided = decideRecommendation(repoRoot, {
      recommendationId: recId,
      decision: "accept",
      reason: "Break alpha/beta cycle and remove legacy bridge",
      killSymbols: ["src/beta/legacy.ts#legacyCycleBridge"],
      killPaths: ["src/beta/legacy.ts"],
    }, { consumerRoot: REPO_ROOT, env });
    expect(decided.status).toBe("accepted");
    expect(decided.filePath).toBe(`.archcontext/refactor-decisions/${recId}.json`);
    expect(existsSync(join(repoRoot, decided.filePath))).toBe(true);

    // 5. Verify runtime.gitignore tracks `.archcontext/refactor-decisions/<id>.json` (exit 1) and ignores atomic temp files (exit 0),
    // and confirm the canonical archctx CLI still reads the valid decision when an orphan temp file exists.
    const ignoreCheck = spawnSync("git", ["check-ignore", "-q", decided.filePath], { cwd: repoRoot, env });
    expect(ignoreCheck.status).toBe(1);
    const orphanTmpPath = `${decided.filePath}.tmp-12345-1700000000000`;
    writeRepoFile(repoRoot, orphanTmpPath, "{interrupted write");
    const tmpIgnoreCheck = spawnSync("git", ["check-ignore", "-q", orphanTmpPath], { cwd: repoRoot, env });
    expect(tmpIgnoreCheck.status).toBe(0);

    runGit(repoRoot, ["add", decided.filePath], env);
    runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Accept cycle refactor decision"], env);

    const listed = listRefactorRecommendations(repoRoot, { status: "accepted" }, { consumerRoot: REPO_ROOT, env });
    expect(listed.decisions.map((entry) => entry.recommendationId)).toContain(recId);
    const shownAfter = showRefactorRecommendation(repoRoot, { recommendationId: recId }, { consumerRoot: REPO_ROOT, env });
    expect(shownAfter.decision?.status).toBe("accepted");
    expect(shownAfter.finding).toBeNull();
    unlinkSync(join(repoRoot, orphanTmpPath));

    // 6. Verify before code fix -> unresolved (cycle metric unsatisfied + killList still-present).
    const unresolved = runRefactorVerify(repoRoot, { recommendationId: recId }, { consumerRoot: REPO_ROOT, env });
    expect(unresolved.disposition).toBe("unresolved");
    expect(unresolved.killListChecks.every((check) => check.status === "still-present")).toBe(true);
    expect(unresolved.metricChecks.some((check) => !check.satisfied)).toBe(true);

    // 6b. Stored decision with a noncanonical required kill-path target (`./src/beta/legacy.ts`) cannot be verified as removed or resolved.
    const noncanonicalFp = digestJson({ kind: "stored-noncanonical-kill-target" });
    const noncanonicalRecId = `recommendation.${digestJson({ fingerprint: noncanonicalFp, regressesFrom: null }).slice("sha256:".length, "sha256:".length + 16)}`;
    const noncanonicalDecision: RefactorDecisionV1 = {
      ...decided.decision,
      recommendationId: noncanonicalRecId,
      fingerprint: noncanonicalFp,
      category: "refactor_proposal",
      kind: null,
      observationMetrics: null,
      targetOutcomes: undefined,
      killList: [{ kind: "path", target: "./src/beta/legacy.ts", required: true }],
    };
    const noncanonicalRelPath = `.archcontext/refactor-decisions/${noncanonicalRecId}.json`;
    const noncanonicalBody = serializeRefactorDecision(noncanonicalDecision);
    writeRepoFile(repoRoot, noncanonicalRelPath, noncanonicalBody);
    expect(() => runRefactorVerify(repoRoot, { recommendationId: noncanonicalRecId }, { consumerRoot: REPO_ROOT, env }))
      .toThrow("noncanonical required path target: ./src/beta/legacy.ts");
    expect(() => resolveRecommendation(repoRoot, {
      recommendationId: noncanonicalRecId,
      resolutionDigest: `sha256:${"a".repeat(64)}`,
      reason: "Must fail closed before archctx resolve",
    }, { consumerRoot: REPO_ROOT, env })).toThrow("noncanonical required path target: ./src/beta/legacy.ts");
    expect(readFileSync(join(repoRoot, noncanonicalRelPath), "utf8")).toBe(noncanonicalBody);
    unlinkSync(join(repoRoot, noncanonicalRelPath));

    // 7. Apply fix and commit WITHOUT syncing CodeGraph -> verify reports stale index.
    unlinkSync(join(repoRoot, "src/beta/legacy.ts"));
    writeRepoFile(repoRoot, "src/beta/index.ts", "export const betaValue = () => 2;\n");
    runGit(repoRoot, ["add", "-A"], env);
    runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Break cycle and remove legacy bridge"], env);

    const stale = runRefactorVerify(repoRoot, { recommendationId: recId }, { consumerRoot: REPO_ROOT, env });
    expect(stale.disposition).toBe("stale");
    expect(stale.blockingReasons).toContain("after-index-stale");

    // 8. Sync CodeGraph -> verify reports resolved with attested resolutionDigest.
    runCodeGraph(repoRoot, ["sync", "."], env);
    const verified = runRefactorVerify(repoRoot, { recommendationId: recId }, { consumerRoot: REPO_ROOT, env });
    expect(verified.disposition).toBe("resolved");
    expect(verified.blockingReasons).toEqual([]);
    expect(verified.killListChecks.every((check) => check.status === "removed")).toBe(true);
    expect(verified.metricChecks.every((check) => check.satisfied)).toBe(true);

    // 9. Resolve with exact --resolution-digest and commit decision file.
    const resolved = resolveRecommendation(repoRoot, {
      recommendationId: recId,
      resolutionDigest: verified.resolutionDigest,
      reason: "Cycle broken and legacy bridge removed",
    }, { consumerRoot: REPO_ROOT, env });
    expect(resolved.status).toBe("resolved");
    expect(resolved.decision.resolutionDigest).toBe(verified.resolutionDigest);
    runGit(repoRoot, ["add", resolved.filePath], env);
    runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Resolve cycle refactor decision"], env);

    // 10. Shallow clean clone proves pure-Git verification without prior state and surfaces shallow gitHistory coverage.
    runGit(base, ["clone", "--depth=1", `file://${repoRoot}`, shallowClone], env);
    runCodeGraph(shallowClone, ["init", "-y", "."], env);
    const shallowScan = observeRefactorRecommendations(shallowClone, { env });
    expect(shallowScan.status).toBe("no_action");
    expect(shallowScan.coverage?.imports).toBe("complete");
    expect(shallowScan.coverage?.gitHistory).toBe("shallow");

    const cleanCloneVerify = runRefactorVerify(shallowClone, { recommendationId: recId }, { consumerRoot: REPO_ROOT, env });
    expect(cleanCloneVerify.disposition).toBe("resolved");
    expect(cleanCloneVerify.historicalReceipt).toMatchObject({
      status: "resolved",
      resolutionDigest: verified.resolutionDigest,
    });

    // 11. Real 0.17.1-shape `refactor_proposal` decisions (null observationMetrics, no targetOutcomes/killList):
    // verify reports stale + baseline-metadata-missing with explicit retire/replace next-step;
    // operators can either attach a verifiable kill-list via `decide accept --kill-path` and resolve, or retire via `decide reject`.
    writeRepoFile(repoRoot, "src/beta/legacy-retire.ts", "export const legacyRetire = 1;\n");
    const makeLegacyProposal = (seed: string): { recId: string; relPath: string } => {
      const fp = digestJson({ legacy0171Proposal: seed });
      const id = `recommendation.${digestJson({ fingerprint: fp, regressesFrom: null }).slice("sha256:".length, "sha256:".length + 16)}`;
      const decision: RefactorDecisionV1 = {
        ...decided.decision,
        recommendationId: id,
        fingerprint: fp,
        category: "refactor_proposal",
        kind: null,
        status: "accepted",
        observationMetrics: null,
        targetOutcomes: undefined,
        killList: undefined,
        resolutionDigest: undefined,
      };
      const relPath = `.archcontext/refactor-decisions/${id}.json`;
      writeRepoFile(repoRoot, relPath, serializeRefactorDecision(decision));
      return { recId: id, relPath };
    };
    const legacyUpgrade = makeLegacyProposal("upgrade-via-kill-list");
    const legacyRetire = makeLegacyProposal("retire-via-reject");
    runGit(repoRoot, ["add", "src/beta/legacy-retire.ts", legacyUpgrade.relPath, legacyRetire.relPath], env);
    runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Add 0.17.1 legacy proposals"], env);
    runCodeGraph(repoRoot, ["sync", "."], env);

    const legacyStale = runRefactorVerify(repoRoot, { recommendationId: legacyUpgrade.recId }, { consumerRoot: REPO_ROOT, env });
    expect(legacyStale.disposition).toBe("stale");
    expect(legacyStale.blockingReasons).toEqual(["baseline-metadata-missing"]);
    const legacyHint = formatRefactorVerify(legacyStale, { repo: repoRoot, repoRoot });
    expect(legacyHint).toContain("legacy decision lacks baseline proof metadata");
    expect(legacyHint).toContain(`rh arch refactor decide ${legacyUpgrade.recId} accept --reason "<reason>" --kill-path <path> --repo ${repoRoot}`);
    expect(legacyHint).toContain(`rh arch refactor decide ${legacyUpgrade.recId} reject --reason "<reason>" --repo ${repoRoot}`);
    expect(legacyHint).toContain(`git -C ${repoRoot} rm -- ${legacyUpgrade.relPath}`);

    // Execute the rendered CLI verify -> decide reject & root-bound git rm hints from a second checkout holding the same ID.
    const secondCheckout = join(base, "second-checkout");
    mkdirSync(secondCheckout, { recursive: true });
    runGit(secondCheckout, ["init", "-q"], env);
    writeRepoFile(secondCheckout, legacyRetire.relPath, readFileSync(join(repoRoot, legacyRetire.relPath), "utf8"));
    runGit(secondCheckout, ["add", legacyRetire.relPath], env);
    runGit(secondCheckout, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Track same legacy proposal ID in second checkout"], env);
    const secondBodyBefore = readFileSync(join(secondCheckout, legacyRetire.relPath), "utf8");

    recordPluginSelection(env);
    mkdirSync(join(home, ".repo-harness"), { recursive: true });
    writeFileSync(join(home, ".repo-harness/config.json"), JSON.stringify({ architecture: { projection_provider: "archctx", projection_apply: "manual" } }));
    const cliEntry = join(REPO_ROOT, "src/cli/index.ts");
    const verifyCliRes = spawnSync(process.execPath, [cliEntry, "arch", "refactor", "verify", legacyRetire.recId, "--repo", repoRoot], {
      cwd: secondCheckout,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(verifyCliRes.status).toBe(1);
    const rejectCmdMatch = /`((?:rh arch refactor decide [^`]+ reject [^`]+))`/.exec(verifyCliRes.stdout);
    const removeCmdMatch = /`(git -C [^`]+ rm [^`]+)`/.exec(verifyCliRes.stdout);
    expect(rejectCmdMatch?.[1]).toBeDefined();
    expect(removeCmdMatch?.[1]).toBeDefined();

    const shimDir = join(base, "bin");
    mkdirSync(shimDir, { recursive: true });
    const rhShim = join(shimDir, "rh");
    writeFileSync(rhShim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliEntry)} "$@"\n`);
    chmodSync(rhShim, 0o755);
    const execEnv = { ...env, PATH: `${shimDir}:${env.PATH ?? ""}` };

    const rejectExec = spawnSync("sh", ["-c", rejectCmdMatch![1]!.replace('"<reason>"', '"Retire legacy proposal from second checkout"')], {
      cwd: secondCheckout,
      env: execEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(rejectExec.status, rejectExec.stderr + rejectExec.stdout).toBe(0);
    expect((JSON.parse(readFileSync(join(repoRoot, legacyRetire.relPath), "utf8")) as RefactorDecisionV1).status).toBe("rejected");
    expect(readFileSync(join(secondCheckout, legacyRetire.relPath), "utf8")).toBe(secondBodyBefore);

    // Restore clean committed state before exercising the alternative `git -C ... rm` branch from secondCheckout.
    runGit(repoRoot, ["checkout", "HEAD", "--", legacyRetire.relPath], env);
    const removeExec = spawnSync("sh", ["-c", removeCmdMatch![1]!], {
      cwd: secondCheckout,
      env: execEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(removeExec.status, removeExec.stderr + removeExec.stdout).toBe(0);
    expect(existsSync(join(repoRoot, legacyRetire.relPath))).toBe(false);
    expect(existsSync(join(secondCheckout, legacyRetire.relPath))).toBe(true);
    expect(readFileSync(join(secondCheckout, legacyRetire.relPath), "utf8")).toBe(secondBodyBefore);
    runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Retire legacy proposal via rm"], env);
    runCodeGraph(repoRoot, ["sync", "."], env);

    // Upgrade legacy proposal A with canonical kill-path, remove target, sync, verify -> resolved -> resolve!
    const upgraded = decideRecommendation(repoRoot, {
      recommendationId: legacyUpgrade.recId,
      decision: "accept",
      reason: "Attach verifiable kill-path to 0.17.1 legacy proposal",
      killPaths: ["src/beta/legacy-retire.ts"],
    }, { consumerRoot: REPO_ROOT, env });
    expect(upgraded.decision.killList).toEqual([{ kind: "path", target: "src/beta/legacy-retire.ts", required: true }]);
    unlinkSync(join(repoRoot, "src/beta/legacy-retire.ts"));
    runGit(repoRoot, ["add", "-A"], env);
    runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Remove legacy-retire file and commit upgraded decision"], env);
    runCodeGraph(repoRoot, ["sync", "."], env);
    const upgradedVerified = runRefactorVerify(repoRoot, { recommendationId: legacyUpgrade.recId }, { consumerRoot: REPO_ROOT, env });
    expect(upgradedVerified.disposition).toBe("resolved");
    const upgradedResolved = resolveRecommendation(repoRoot, {
      recommendationId: legacyUpgrade.recId,
      resolutionDigest: upgradedVerified.resolutionDigest,
      reason: "Legacy proposal upgraded with kill-path and verified resolved",
    }, { consumerRoot: REPO_ROOT, env });
    expect(upgradedResolved.status).toBe("resolved");

    // 12. Sibling checkouts `project`, `project `, and (POSIX) `project\r`: refactor writes & commit root fail closed without touching `project`.
    const wsParent = scratchDir("refactor-ws-sibling-");
    const cleanSibling = join(wsParent, "project");
    const spacedSibling = join(wsParent, "project ");
    const unsafeSiblings = [spacedSibling, ...(process.platform === "win32" ? [] : [join(wsParent, "project\r")])];
    for (const sibling of [cleanSibling, ...unsafeSiblings]) {
      mkdirSync(join(sibling, "src"), { recursive: true });
      runGit(sibling, ["init", "-q"], env);
      writeRepoFile(sibling, "src/index.ts", "export const v = 1;\n");
      runGit(sibling, ["add", "-A"], env);
      runGit(sibling, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init"], env);
    }
    const siblingHeadBefore = runGit(cleanSibling, ["rev-parse", "HEAD"], env);
    for (const unsafeSibling of unsafeSiblings) {
      for (const target of [unsafeSibling, join(unsafeSibling, "src")]) {
        expect(() => decideRecommendation(target, {
          recommendationId: recId,
          decision: "reject",
          reason: "Must fail closed on unsafe checkout root",
        }, { consumerRoot: REPO_ROOT, env })).toThrow("whitespace");
        expect(() => runRefactorVerify(target, { recommendationId: recId }, { consumerRoot: REPO_ROOT, env })).toThrow("whitespace");
        expect(() => resolveRecommendation(target, {
          recommendationId: recId,
          resolutionDigest: verified.resolutionDigest,
          reason: "Must fail closed",
        }, { consumerRoot: REPO_ROOT, env })).toThrow("whitespace");
        expect(() => resolveDecisionCommitRoot(target)).toThrow("whitespace");
      }
      expect(existsSync(join(unsafeSibling, ".archcontext"))).toBe(false);
    }
    expect(runGit(cleanSibling, ["rev-parse", "HEAD"], env)).toBe(siblingHeadBefore);
    expect(existsSync(join(cleanSibling, ".archcontext"))).toBe(false);

    // 13. Case-aliased kill targets (`agents.md` beside tracked `AGENTS.md` on `core.ignorecase=true`) fail closed before decide, verify, and resolve.
    const caseRepo = scratchDir("refactor-case-alias-");
    runGit(caseRepo, ["init", "-q"], env);
    runGit(caseRepo, ["config", "core.ignorecase", "true"], env);
    writeRepoFile(caseRepo, "AGENTS.md", "# Agents\n");
    runGit(caseRepo, ["add", "AGENTS.md"], env);
    runGit(caseRepo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Track uppercase AGENTS.md"], env);

    const caseFp = digestJson({ kind: "case-alias-kill-path" });
    const caseRecId = `recommendation.${digestJson({ fingerprint: caseFp, regressesFrom: null }).slice("sha256:".length, "sha256:".length + 16)}`;
    expect(() => decideRecommendation(caseRepo, {
      recommendationId: caseRecId,
      decision: "accept",
      reason: "Case-aliased path must be rejected",
      killPaths: ["agents.md"],
    }, { consumerRoot: REPO_ROOT, env })).toThrow("differs only in case");
    expect(() => decideRecommendation(caseRepo, {
      recommendationId: caseRecId,
      decision: "accept",
      reason: "Case-aliased symbol path must be rejected",
      killSymbols: ["agents.md#Heading"],
    }, { consumerRoot: REPO_ROOT, env })).toThrow("differs only in case");
    expect(existsSync(join(caseRepo, ".archcontext/refactor-decisions"))).toBe(false);

    const caseDecisionRel = `.archcontext/refactor-decisions/${caseRecId}.json`;
    const caseDecision: RefactorDecisionV1 = {
      ...decided.decision,
      recommendationId: caseRecId,
      fingerprint: caseFp,
      killList: [{ kind: "path", target: "agents.md", required: true }],
    };
    writeRepoFile(caseRepo, caseDecisionRel, serializeRefactorDecision(caseDecision));
    expect(() => runRefactorVerify(caseRepo, { recommendationId: caseRecId }, { consumerRoot: REPO_ROOT, env }))
      .toThrow("differs only in case");
    expect(() => resolveRecommendation(caseRepo, {
      recommendationId: caseRecId,
      resolutionDigest: `sha256:${"b".repeat(64)}`,
      reason: "Must fail closed before archctx resolve",
    }, { consumerRoot: REPO_ROOT, env })).toThrow("differs only in case");
  }, 60_000);
});
