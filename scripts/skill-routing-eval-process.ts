import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { ProviderStructuredEvidence } from "./run-skill-evals";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 10 * 60 * 1000;

export interface ProcessCommandOptions {
  readonly claudeCommand?: string;
  readonly codexCommand?: string;
  readonly claudeArgs?: readonly string[];
  readonly codexArgs?: readonly string[];
}

export interface ProcessRouteCandidate {
  readonly name: string;
  readonly sourcePath: string;
}

export interface ProcessInvocationOutcome {
  readonly outcome: "routed" | "provider_error";
  readonly routes: readonly string[];
  readonly errorReason?: string;
  readonly rawExitCode: number | null;
  readonly durationMs: number;
  readonly finalResponseExcerpt?: string;
}

export interface ProcessInvocationDeps {
  readonly extractToolInvokedRoutes: (rawOutput: string, candidates: readonly ProcessRouteCandidate[]) => string[];
  readonly extractMergeGateTextualSignal: (finalResponseText: string) => boolean;
  readonly parseClaudeStreamJson: (stdout: string) => ProviderStructuredEvidence;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runBoundedProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf-8", timeout: timeoutMs });
  const timedOut = result.signal !== null && result.status === null;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut };
}

/**
 * Uses `--output-format stream-json` (not run-skill-evals.ts's `json`), a
 * deliberate divergence: the routing eval needs tool-use visibility to
 * detect which Skill got invoked, which the single-object `json` format
 * (final result only) never exposes and `--no-session-persistence`'s
 * companion session-transcript-file recovery would require guessing at
 * Claude Code's internal project-directory path-encoding scheme. The
 * streamed JSONL already contains everything needed directly in stdout, so
 * no side-channel file read is required at all. The final `type:"result"`
 * line has the IDENTICAL shape run-skill-evals.ts's own
 * parseClaudeStructuredOutput already parses.
 */
function buildClaudeRoutingCommand(prompt: string, opts: ProcessCommandOptions): { command: string; args: string[] } {
  return {
    command: opts.claudeCommand ?? "claude",
    args: [
      ...(opts.claudeArgs ?? []),
      "-p",
      "--setting-sources",
      "project",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode",
      "bypassPermissions",
      prompt,
    ],
  };
}

function buildCodexRoutingCommand(
  prompt: string,
  workspacePath: string,
  finalResponsePath: string,
  opts: ProcessCommandOptions,
): { command: string; args: string[] } {
  return {
    command: opts.codexCommand ?? "codex",
    args: [
      ...(opts.codexArgs ?? []),
      "exec",
      "-C",
      workspacePath,
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      finalResponsePath,
      "--json",
      prompt,
    ],
  };
}

export function lastResultLine(stdout: string): string {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (isPlainRecord(parsed) && parsed.type === "result") return lines[i];
    } catch {
      /* not JSON on this line; keep scanning backward */
    }
  }
  return "";
}

export function invokeProcessProvider(
  kind: "claude" | "codex",
  params: {
    readonly prompt: string;
    readonly workspacePath: string;
    readonly candidates: readonly ProcessRouteCandidate[];
    readonly options: ProcessCommandOptions;
    readonly timeoutMs: number;
  },
  deps: ProcessInvocationDeps,
): ProcessInvocationOutcome {
  const { timeoutMs } = params;
  const startedAt = Date.now();

  if (kind === "claude") {
    const { command, args } = buildClaudeRoutingCommand(params.prompt, params.options);
    const result = runBoundedProcess(command, args, params.workspacePath, timeoutMs);
    const durationMs = Date.now() - startedAt;
    if (result.timedOut) {
      return { outcome: "provider_error", routes: [], errorReason: "timeout", rawExitCode: result.status, durationMs };
    }
    const structured = deps.parseClaudeStreamJson(result.stdout);
    if (structured.usageAuthority === "unavailable" && result.status !== 0) {
      return {
        outcome: "provider_error",
        routes: [],
        errorReason: `provider_nonzero:${String(result.status)}`,
        rawExitCode: result.status,
        durationMs,
      };
    }
    const routes = deps.extractToolInvokedRoutes(result.stdout, params.candidates);
    const finalResponseText = structured.finalResponse ?? "";
    if (deps.extractMergeGateTextualSignal(finalResponseText) && !routes.includes("merge-gate")) routes.push("merge-gate");
    return { outcome: "routed", routes, rawExitCode: result.status, durationMs, finalResponseExcerpt: finalResponseText.slice(0, 200) };
  }

  const finalResponsePath = join(params.workspacePath, "final-response.md");
  const { command, args } = buildCodexRoutingCommand(params.prompt, params.workspacePath, finalResponsePath, params.options);
  const result = runBoundedProcess(command, args, params.workspacePath, timeoutMs);
  const durationMs = Date.now() - startedAt;
  if (result.timedOut) {
    return { outcome: "provider_error", routes: [], errorReason: "timeout", rawExitCode: result.status, durationMs };
  }
  if (result.status !== 0) {
    return {
      outcome: "provider_error",
      routes: [],
      errorReason: `provider_nonzero:${String(result.status)}`,
      rawExitCode: result.status,
      durationMs,
    };
  }
  const routes = deps.extractToolInvokedRoutes(result.stdout, params.candidates);
  const finalResponseText = existsSync(finalResponsePath) ? readFileSync(finalResponsePath, "utf-8") : "";
  if (deps.extractMergeGateTextualSignal(finalResponseText) && !routes.includes("merge-gate")) routes.push("merge-gate");
  return { outcome: "routed", routes, rawExitCode: result.status, durationMs, finalResponseExcerpt: finalResponseText.slice(0, 200) };
}
