#!/usr/bin/env bun
// Focused, deterministic validator/selector for the SSD skill-routing corpus.
// Deliberately separate from scripts/run-skill-evals.ts (a two-arm provider
// comparison harness over evals/evals.json) rather than an extension of it —
// see tasks/notes/20260715-1140-skill-surface-discovery-convergence.notes.md,
// "## SSD-01" for the rationale. No provider is invoked here; SSD-07 owns the
// one frozen provider-routing run.
import { readdirSync, readFileSync, readlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, relative } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const SKILL_ROUTING_DIR = join(REPO_ROOT, "evals", "skill-routing");
export const CORPUS_PATH = join(SKILL_ROUTING_DIR, "routing-corpus.json");
export const BASELINE_PATH = join(SKILL_ROUTING_DIR, "discovery-baseline.json");
export const SCHEMA_PATH = join(SKILL_ROUTING_DIR, "routing-corpus.schema.json");

export const CASE_KINDS = [
  "positive", "ambiguous", "quoted-name", "negated", "hypothetical", "status-only", "ordinary-qa",
] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

// The plan's overlap-vocabulary dimensions; "merge-gate vs cross-review" is one
// dimension covered by tagging both literal terms on the same case.
export const REQUIRED_OVERLAP_TERMS: readonly string[] =
  ["review", "check", "plan", "ship", "merge-gate", "architecture"];

export const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const LANGS = ["zh", "en"];
const CASE_FIELDS = ["id", "lang", "kind", "prompt", "expected_route", "overlap_terms", "notes"];

export interface RoutingCase {
  id: string;
  lang: "zh" | "en";
  kind: CaseKind;
  prompt: string;
  expected_route: string;
  overlap_terms?: string[];
  notes?: string;
}

export interface RoutingCorpus {
  version: number;
  cases: RoutingCase[];
}

export class CliError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}

export function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}
export function loadCorpus(path: string = CORPUS_PATH): RoutingCorpus {
  return loadJson(path) as RoutingCorpus;
}
export function loadBaseline(path: string = BASELINE_PATH): Record<string, unknown> {
  return loadJson(path) as Record<string, unknown>;
}
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalRoutesFromBaseline(baseline: Record<string, unknown>): string[] {
  const target = baseline.target_discovered_sets as { canonical_routes?: unknown } | undefined;
  const routes = target?.canonical_routes;
  if (!Array.isArray(routes) || routes.length === 0 || routes.some((r) => typeof r !== "string")) {
    throw new CliError("discovery-baseline.json target_discovered_sets.canonical_routes must be a non-empty string array");
  }
  return routes as string[];
}

/** Validates one case's shape. Returns human-readable issue strings, empty when valid. */
export function validateCaseShape(entry: unknown, index: number): string[] {
  const label = `case[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [`${label}: must be an object`];
  const c = entry as Record<string, unknown>;
  const id = typeof c.id === "string" && c.id.length > 0 ? c.id : label;
  const issues: string[] = [];
  if (typeof c.id !== "string" || !ID_PATTERN.test(c.id)) issues.push(`${label} (${id}): id must be a unique kebab-case string`);
  if (typeof c.lang !== "string" || !LANGS.includes(c.lang)) issues.push(`${id}: lang must be "zh" or "en"`);
  if (typeof c.kind !== "string" || !(CASE_KINDS as readonly string[]).includes(c.kind)) {
    issues.push(`${id}: kind must be one of ${CASE_KINDS.join(", ")}`);
  }
  if (typeof c.prompt !== "string" || c.prompt.trim().length === 0) issues.push(`${id}: prompt must be a non-empty string`);
  if (typeof c.expected_route !== "string" || c.expected_route.trim().length === 0) {
    issues.push(`${id}: expected_route must be a non-empty string`);
  }
  if (c.overlap_terms !== undefined) {
    const ok = Array.isArray(c.overlap_terms) && c.overlap_terms.every((t) => typeof t === "string" && t.length > 0);
    if (!ok) issues.push(`${id}: overlap_terms must be a non-empty string array when present`);
  }
  if (c.notes !== undefined && typeof c.notes !== "string") issues.push(`${id}: notes must be a string when present`);
  const extraKeys = Object.keys(c).filter((key) => !CASE_FIELDS.includes(key));
  if (extraKeys.length > 0) issues.push(`${id}: unexpected field(s) ${extraKeys.join(", ")}`);
  return issues;
}

/** Validates the whole corpus document shape (version + every case). */
export function validateCorpusShape(corpus: unknown): string[] {
  if (typeof corpus !== "object" || corpus === null || Array.isArray(corpus)) return ["corpus root must be an object"];
  const c = corpus as Record<string, unknown>;
  const issues: string[] = [];
  if (c.version !== 1) issues.push("corpus.version must be 1");
  if (!Array.isArray(c.cases) || c.cases.length === 0) {
    issues.push("corpus.cases must be a non-empty array");
    return issues;
  }
  c.cases.forEach((entry, index) => issues.push(...validateCaseShape(entry, index)));
  return issues;
}

/** Coverage requirements from the SSD-01 brief: per-route zh+en positives, kind
 * floors, overlap-term coverage, id uniqueness, and total case count in range. */
export function validateCoverage(corpus: RoutingCorpus, canonicalRoutes: readonly string[]): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  for (const c of corpus.cases) {
    if (seenIds.has(c.id)) issues.push(`duplicate case id: ${c.id}`);
    seenIds.add(c.id);
  }
  for (const route of canonicalRoutes) {
    if (!corpus.cases.some((c) => c.kind === "positive" && c.lang === "zh" && c.expected_route === route)) {
      issues.push(`route ${route}: missing a zh positive case`);
    }
    if (!corpus.cases.some((c) => c.kind === "positive" && c.lang === "en" && c.expected_route === route)) {
      issues.push(`route ${route}: missing an en positive case`);
    }
  }
  for (const kind of CASE_KINDS) {
    const count = corpus.cases.filter((c) => c.kind === kind).length;
    if (count < 3) issues.push(`kind ${kind}: only ${count} case(s), need at least 3`);
  }
  for (const term of REQUIRED_OVERLAP_TERMS) {
    if (!corpus.cases.some((c) => c.kind !== "positive" && (c.overlap_terms ?? []).includes(term))) {
      issues.push(`overlap term "${term}": no non-positive case tags it`);
    }
  }
  if (corpus.cases.length < 60 || corpus.cases.length > 90) {
    issues.push(`total case count ${corpus.cases.length} is outside the required [60, 90] range`);
  }
  return issues;
}

/**
 * SSD-01 carried advisory: routing-corpus.schema.json existed but nothing
 * ever loaded or cross-checked it against this runner's own constants, so it
 * could silently drift. This binds the schema's case-shape enums/pattern to
 * the runner's own CASE_KINDS/LANGS/ID_PATTERN/canonical-routes constants.
 */
export function schemaDriftIssues(canonicalRoutes: readonly string[]): string[] {
  const issues: string[] = [];
  let schema: unknown;
  try {
    schema = loadJson(SCHEMA_PATH);
  } catch (error) {
    return [`routing-corpus.schema.json: unreadable or invalid JSON: ${(error as Error).message}`];
  }
  const props = (schema as {
    definitions?: { case?: { properties?: Record<string, { enum?: unknown[]; pattern?: string }> } };
  }).definitions?.case?.properties;
  if (!props) {
    return ["routing-corpus.schema.json: definitions.case.properties is missing"];
  }

  const sameSet = (left: readonly unknown[], right: readonly string[]): boolean => {
    if (left.length !== right.length) return false;
    const a = [...left].map(String).sort();
    const b = [...right].sort();
    return a.every((value, index) => value === b[index]);
  };

  const kindEnum = props.kind?.enum;
  if (!Array.isArray(kindEnum) || !sameSet(kindEnum, CASE_KINDS)) {
    issues.push(`schema kind enum ${JSON.stringify(kindEnum)} drifted from runner CASE_KINDS ${JSON.stringify(CASE_KINDS)}`);
  }
  const langEnum = props.lang?.enum;
  if (!Array.isArray(langEnum) || !sameSet(langEnum, LANGS)) {
    issues.push(`schema lang enum ${JSON.stringify(langEnum)} drifted from runner LANGS ${JSON.stringify(LANGS)}`);
  }
  const expectedRouteEnum = props.expected_route?.enum;
  const runnerRoutes = [...canonicalRoutes, "none"];
  if (!Array.isArray(expectedRouteEnum) || !sameSet(expectedRouteEnum, runnerRoutes)) {
    issues.push(`schema expected_route enum ${JSON.stringify(expectedRouteEnum)} drifted from discovery-baseline canonical routes ${JSON.stringify(runnerRoutes)}`);
  }
  const idPattern = props.id?.pattern;
  if (idPattern !== ID_PATTERN.source) {
    issues.push(`schema id pattern ${JSON.stringify(idPattern)} drifted from runner ID_PATTERN ${JSON.stringify(ID_PATTERN.source)}`);
  }
  return issues;
}

// ============================================================================
// Provider mode (SSD-07 phase A / D1): executes the frozen 68-case corpus
// against a real provider ONCE per case, for one specified profile/host
// context, and scores canonical top-1 accuracy, per-route recall,
// double-trigger/ambiguous activation, and ordinary-QA false activation.
//
// This phase implements the mechanism but does NOT invoke a real provider —
// per the orchestrator's R3 ruling, the one authoritative matrix run happens
// only after an explicit user go. `--dry-run` exercises the full pipeline
// with a built-in stub provider; deterministic tests (below, in
// tests/skill-routing-eval.test.ts) exercise metrics/report-shape/hash-
// binding/threshold-evaluation via the same stub with configurable behavior.
//
// No single profile/host run discovers all canonical routes (see the
// notes file's D5 entry), so each run's metrics/thresholds are scoped to
// its OWN reachable route subset (RoutingRunRecord.excluded_unreachable,
// RouteRecallStat.reachable) and its overall_pass is labeled PARTIAL
// evidence, never package acceptance on its own (RoutingRunReport
// .evidence_scope/.evidence_note). The `aggregate` subcommand
// (buildAggregateReport, below) combines 2+ runs into an ADVISORY
// aggregate across all canonical routes: the provider harness has no
// routing preamble, so the measurement reflects direct model answers, not
// skill discovery. See AGGREGATE_ADVISORY_REASON.
// ============================================================================

import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import {
  parseSkillSurfaceCatalog,
  facadesForSelection,
  hostSkillPlacements,
  SKILL_SURFACE_HOSTS,
  type SkillSurfaceCatalog,
  type SkillSurfaceHost,
} from "../src/core/skill-surface/catalog";
import { PLUGIN_IDS, type PluginId } from "../src/core/skill-surface/plugin-manifest";
import {
  parseClaudeStructuredOutput,
  type ProviderStructuredEvidence,
} from "./run-skill-evals";
import { executeSkillRoutingCli } from "./skill-routing-eval-cli";
import { invokeProcessProvider, lastResultLine } from "./skill-routing-eval-process";

export const MANIFEST_PATH = join(REPO_ROOT, "assets", "skill-commands", "manifest.json");
const ROUTING_EVAL_HOSTS = SKILL_SURFACE_HOSTS.filter(host => host !== "antigravity");

export function loadLiveCatalog(manifestPath: string = MANIFEST_PATH): SkillSurfaceCatalog {
  const raw = readFileSync(manifestPath, "utf-8");
  const resolution = parseSkillSurfaceCatalog(raw, { declared: true });
  if (resolution.status !== "valid") {
    throw new CliError(
      `run: live manifest ${manifestPath} is invalid: ${resolution.diagnostics.map((d) => `${d.code} ${d.path}: ${d.message}`).join("; ")}`,
    );
  }
  return resolution.catalog;
}

// --- discovered skill surface (pure; no fs beyond the already-loaded catalog) ---

export type DiscoveryReason = "always" | "profile-facade" | "cross-model" | "cli-reference" | "explicit-setup";

export interface DiscoveredSkillSurfaceEntry {
  readonly name: string;
  readonly sourcePath: string;
  readonly reason: DiscoveryReason;
}

/**
 * The Skill directories a real host would actually project for this
 * plugin selection and host (root always; selected facades; host-aware
 * provider skills) -- exactly what installProfileHostMutationPaths()/
 * sync-codex-installed-copies.sh materialize today, computed from the same
 * catalog selectors (facadesForSelection/hostSkillPlacements) SSD-02 made the
 * runtime authority.
 */
export function buildDiscoveredSkillSurface(
  catalog: SkillSurfaceCatalog,
  plugins: readonly PluginId[],
  host: SkillSurfaceHost,
): DiscoveredSkillSurfaceEntry[] {
  const entries: DiscoveredSkillSurfaceEntry[] = [];
  const seen = new Set<string>();
  const add = (name: string, reason: DiscoveryReason): void => {
    if (seen.has(name)) return;
    const pkg = catalog.packages.find((p) => p.name === name);
    if (!pkg || pkg.source === null) return;
    seen.add(name);
    entries.push({ name, sourcePath: resolve(REPO_ROOT, pkg.source), reason });
  };
  for (const pkg of catalog.packages) {
    if (pkg.discoverability === "always" && pkg.hosts.includes(host)) add(pkg.name, "always");
  }
  for (const name of facadesForSelection(catalog, plugins)) add(name, "profile-facade");
  const placements = hostSkillPlacements(catalog, plugins);
  for (const name of host === "claude" ? placements.claude : placements.codex) add(name, "cross-model");
  // discoverability:"explicit-setup" (repo-harness-strategy today) is never
  // selection-gated -- neither facadesForSelection (kind:"facade" only) nor
  // hostSkillPlacements (kind:"provider-skill" only) covers it. Production
  // discovery is additive only after an explicit setup action, orthogonal
  // to the selection; this eval models it as always reachable regardless of
  // --plugins.
  for (const pkg of catalog.packages) {
    if (pkg.discoverability === "explicit-setup" && pkg.hosts.includes(host)) add(pkg.name, "explicit-setup");
  }
  return entries;
}

/**
 * Packages with discoverability:"cli-reference" (repo-harness-setup,
 * repo-harness-architecture today) are never separately projected as a host
 * Skill directory -- they are reachable only through the root router's own
 * routing prose plus direct file access under the eval workspace's
 * `--add-dir`-equivalent repo mount, exactly like a real npm-installed
 * package ships every source file while only a profile-gated subset gets
 * symlinked into `.claude/skills`/`.codex/skills`. merge-gate (source: null)
 * is excluded here by construction (no source to read) -- see
 * extractMergeGateTextualSignal below for how its selection is detected.
 */
export function referenceOnlySkillPackages(catalog: SkillSurfaceCatalog): DiscoveredSkillSurfaceEntry[] {
  return catalog.packages
    .filter((pkg) => pkg.discoverability === "cli-reference" && pkg.source !== null)
    .map((pkg) => ({ name: pkg.name, sourcePath: resolve(REPO_ROOT, pkg.source as string), reason: "cli-reference" as const }));
}

/** Symlinks every discovered package's directory into the host's native Skill root inside a disposable workspace (mirrors sync-codex-installed-copies.sh's real link-mode projection, not run-skill-evals.ts's older AGENTS.md-embedding convention, since the whole point of this eval is testing the real post-cutover native discovery mechanism). */
export function materializeDiscoveredSurface(
  workspacePath: string,
  host: SkillSurfaceHost,
  discovered: readonly DiscoveredSkillSurfaceEntry[],
): void {
  const skillsRoot = join(workspacePath, host === "claude" ? ".claude" : ".codex", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  for (const entry of discovered) {
    const dest = join(skillsRoot, entry.name);
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(entry.sourcePath, dest, "dir");
  }
}

// --- route-selection signal extraction ---

/**
 * Scans a provider's raw structured JSONL output for a route-invocation
 * signal against a candidate list (discovered + reference-only packages).
 * Two independent mechanisms, unioned, first-seen order preserved:
 *
 * 1. Precise: Claude's dedicated `Skill` tool_use block naming a candidate
 *    directly (Claude Code's own Skill tool takes a `skill`/`command` input).
 * 2. Coarse fallback (both hosts): the raw JSONL line's serialized text
 *    mentions a candidate's `<source>/SKILL.md` path. This is the ONLY
 *    signal available for cli-reference packages (no dedicated Skill-tool
 *    call exists for a non-projected Skill) and for Codex, which has no
 *    Skill-tool concept at all -- Codex instead reads SKILL.md files
 *    directly per the plan's Trace B ("SKILL.md loads one mode reference on
 *    demand"). Codex's exact tool/function-call JSONL event field names are
 *    NOT validated against a real session in this phase (R3: no real
 *    provider invoked) -- this coarse whole-line substring match is
 *    deliberately robust to that uncertainty at the cost of precision; spot
 *    check against one real Codex sample before trusting this signal in the
 *    Phase B authoritative run (see the notes file's SSD-07 phase A entry).
 */
export function extractToolInvokedRoutes(
  rawOutput: string,
  candidates: readonly DiscoveredSkillSurfaceEntry[],
): string[] {
  const found: string[] = [];
  const pushOnce = (name: string): void => {
    if (!found.includes(name)) found.push(name);
  };

  for (const line of rawOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;

    if (record.type === "assistant" && isSkillRecord(record.message)) {
      const content = (record.message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            isSkillRecord(block) &&
            (block as Record<string, unknown>).type === "tool_use" &&
            (block as Record<string, unknown>).name === "Skill"
          ) {
            const input = (block as Record<string, unknown>).input;
            const named = isSkillRecord(input)
              ? (typeof (input as Record<string, unknown>).skill === "string"
                  ? ((input as Record<string, unknown>).skill as string)
                  : typeof (input as Record<string, unknown>).command === "string"
                    ? ((input as Record<string, unknown>).command as string)
                    : null)
              : null;
            if (named && candidates.some((c) => c.name === named)) pushOnce(named);
          }
        }
      }
    }

    for (const candidate of candidates) {
      const needle = `${candidate.sourcePath}/SKILL.md`;
      if (trimmed.includes(needle)) pushOnce(candidate.name);
    }
  }
  return found;
}

function isSkillRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * merge-gate has no Skill file (kind:"judge", source:null in the manifest --
 * it is a CLI/workflow concept described in the root router's own prose, not
 * a projected Skill), so no tool/file signal is structurally possible for
 * it. This narrowly-scoped textual check against the PROVIDER'S OWN FINAL
 * RESPONSE TEXT ONLY (never the raw JSONL, which echoes the user's prompt --
 * several corpus cases, e.g. the merge-gate-vs-cross-review ambiguous case,
 * literally contain the word "merge-gate" in the PROMPT itself, so scanning
 * raw output would false-positive on every one of them) is the only
 * available mechanism. Flagged as needing Phase-B empirical review of
 * merge-gate-tagged case results specifically before trusting this metric.
 */
const MERGE_GATE_MENTION_PATTERN = /merge-gate/i;
export function extractMergeGateTextualSignal(finalResponseText: string): boolean {
  return MERGE_GATE_MENTION_PATTERN.test(finalResponseText);
}

// --- provider adapter ---

export type ProviderKind = "stub" | "claude" | "codex";

export interface RouteInvocationResult {
  readonly outcome: "routed" | "provider_error";
  readonly routes: readonly string[];
  readonly errorReason?: string;
  readonly rawExitCode: number | null;
  readonly durationMs: number;
  readonly finalResponseExcerpt?: string;
}

export interface ProviderInvokeParams {
  readonly routingCase: RoutingCase;
  readonly workspacePath: string;
  readonly host: SkillSurfaceHost;
  readonly discovered: readonly DiscoveredSkillSurfaceEntry[];
  readonly referenceOnly: readonly DiscoveredSkillSurfaceEntry[];
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  invoke(params: ProviderInvokeParams): RouteInvocationResult;
}

export interface StubProviderOptions {
  /** Defaults to always returning the single literal route "repo-harness" for every case (a genuinely FIXED, case-independent echo) -- the CLI's own `--dry-run` uses this default unmodified to smoke-test the pipeline end to end, including the FAIL path of threshold evaluation. Tests inject a custom routeFor to exercise other scenarios (perfect echo, double-trigger, small-sample, etc). */
  readonly routeFor?: (routingCase: RoutingCase) => readonly string[];
}

export function createStubProvider(options: StubProviderOptions = {}): ProviderAdapter {
  const routeFor = options.routeFor ?? ((): readonly string[] => ["repo-harness"]);
  return {
    kind: "stub",
    invoke({ routingCase }) {
      return { outcome: "routed", routes: routeFor(routingCase), rawExitCode: 0, durationMs: 0 };
    },
  };
}

/** Perfect-echo stub used by this file's own deterministic pipeline tests: always returns the case's own expected_route (empty array for "none"), proving the full pipeline computes ceiling metrics and an all-PASS threshold evaluation when routing is perfect. */
export function perfectEchoRouteFor(routingCase: RoutingCase): readonly string[] {
  return routingCase.expected_route === "none" ? [] : [routingCase.expected_route];
}

export interface ProcessProviderOptions {
  readonly claudeCommand?: string;
  readonly codexCommand?: string;
  readonly claudeArgs?: readonly string[];
  readonly codexArgs?: readonly string[];
  readonly timeoutMs?: number;
}

export function parseClaudeStreamJson(stdout: string): ProviderStructuredEvidence {
  return parseClaudeStructuredOutput(lastResultLine(stdout));
}

/**
 * Real (non-stub) provider adapter. NOT exercised by this phase's tests
 * (R3: no real provider invoked) -- reviewed for correctness of mechanism
 * only. Each case gets exactly one invocation, no retries (D5's stated
 * retry policy: none; a provider_error is recorded and excluded from
 * routing metrics rather than silently retried or coerced to "none").
 */
export function createProcessProvider(kind: "claude" | "codex", options: ProcessProviderOptions = {}): ProviderAdapter {
  return {
    kind,
    invoke({ routingCase, workspacePath, discovered, referenceOnly }) {
      const candidates = [...discovered, ...referenceOnly];
      return invokeProcessProvider(
        kind,
        { prompt: routingCase.prompt, workspacePath, candidates, options },
        {
          extractToolInvokedRoutes: (rawOutput, processCandidates) =>
            extractToolInvokedRoutes(rawOutput, processCandidates as readonly DiscoveredSkillSurfaceEntry[]),
          extractMergeGateTextualSignal,
          parseClaudeStreamJson,
        },
      );
    },
  };
}

// --- per-case records, metrics, thresholds ---

export interface RoutingRunRecord {
  readonly id: string;
  readonly lang: "zh" | "en";
  readonly kind: CaseKind;
  readonly expected_route: string;
  readonly outcome: "routed" | "provider_error";
  readonly selected_routes: readonly string[];
  readonly primary_route: string;
  readonly correct_top1: boolean;
  readonly double_trigger: boolean;
  /**
   * True when `expected_route` names a canonical route that is structurally
   * outside THIS run's reachable set (profile/host-gated discovered surface
   * plus reference-only packages plus merge-gate, which is always reachable
   * regardless of profile -- see runProviderEval's `reachableRoutes`).
   * Optional/absent means "not excluded" (false) -- kept optional so
   * hand-built fixtures in tests/skill-routing-eval.test.ts that predate this
   * field still type-check and behave exactly as before. A case marked true
   * here can never be routed to correctly no matter how good the provider is
   * (the candidate isn't even present in the environment), so it is removed
   * from top1/per-route denominators rather than mechanically scored as a
   * miss -- see computeRoutingMetrics.
   */
  readonly excluded_unreachable?: boolean;
  readonly error_reason?: string;
  readonly duration_ms: number;
}

export interface RateStat {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
}

/** Per-route recall plus whether the route was reachable at all in this run
 * (denominator > 0 after excluded_unreachable filtering). Unreachable routes
 * report {numerator: 0, denominator: 0, rate: null, reachable: false} rather
 * than being scored as a 0% miss -- see computeRoutingMetrics. */
export interface RouteRecallStat extends RateStat {
  readonly reachable: boolean;
}

export interface RoutingMetrics {
  readonly evaluated_cases: number;
  readonly provider_error_count: number;
  /** Visible count of positive cases excluded from top1/per-route denominators
   * because their expected_route was structurally unreachable in this run --
   * mirrors provider_error_count's honest-exclusion-with-visible-count shape. */
  readonly excluded_unreachable_count: number;
  readonly top1_accuracy: RateStat;
  readonly per_route_recall: Record<string, RouteRecallStat>;
  readonly double_trigger: { readonly count: number; readonly denominator: number; readonly rate: number };
  readonly ordinary_qa_false_activation: RateStat & { readonly small_sample: boolean };
  readonly non_positive_false_activation_by_kind: Record<string, RateStat>;
}

export const ROUTING_FLOORS = {
  top1AccuracyMin: 0.95,
  perRouteRecallMin: 0.9,
  doubleTriggerMax: 0.02,
  ordinaryQaFalseActivationMax: 0.01,
  smallSampleThreshold: 100,
} as const;

export interface ThresholdResult {
  readonly floor?: number;
  readonly ceiling?: number;
  readonly actual: number | null;
  readonly pass: boolean;
  readonly small_sample?: boolean;
  /** Per-route only: whether this route was reachable in this run. An
   * unreachable route is not gated (pass is vacuously true) so it cannot drag
   * down allRoutesPass/overall_pass -- see evaluateThresholds. */
  readonly reachable?: boolean;
}

export interface ThresholdEvaluation {
  readonly top1_accuracy: ThresholdResult;
  readonly per_route_recall: Record<string, ThresholdResult>;
  readonly double_trigger: ThresholdResult;
  readonly ordinary_qa_false_activation: ThresholdResult;
  readonly overall_pass: boolean;
}

export function computeRoutingMetrics(
  records: readonly RoutingRunRecord[],
  canonicalRoutes: readonly string[],
): RoutingMetrics {
  const routed = records.filter((r) => r.outcome === "routed");
  const providerErrorCount = records.length - routed.length;
  const excludedUnreachableCount = records.filter((r) => r.excluded_unreachable === true).length;

  // HIGH finding fix (SSD-07 phase A acceptance-gate): a case whose expected
  // route is structurally unreachable in this run (excluded_unreachable) can
  // never be routed to correctly regardless of provider quality, so it is
  // removed from the positives population entirely rather than mechanically
  // scored as a miss -- see RoutingRunRecord.excluded_unreachable.
  const positives = routed.filter((r) => r.expected_route !== "none" && r.excluded_unreachable !== true);
  const top1Correct = positives.filter((r) => r.correct_top1).length;

  const perRouteRecall: Record<string, RouteRecallStat> = {};
  for (const route of canonicalRoutes) {
    const routeCases = positives.filter((r) => r.expected_route === route);
    const correct = routeCases.filter((r) => r.correct_top1).length;
    perRouteRecall[route] = {
      numerator: correct,
      denominator: routeCases.length,
      rate: routeCases.length > 0 ? correct / routeCases.length : null,
      // routeCases is already positives-with-excluded_unreachable-removed, so
      // denominator 0 here means EVERY positive case for this route was
      // unreachable this run (reachability is all-or-nothing per route per
      // run) -- not a corpus gap (validateCoverage guarantees every canonical
      // route has real positives) and not a scored 0% miss.
      reachable: routeCases.length > 0,
    };
  }

  const doubleTriggerCount = routed.filter((r) => r.double_trigger).length;

  const ordinaryQaCases = routed.filter((r) => r.kind === "ordinary-qa");
  const ordinaryQaFalse = ordinaryQaCases.filter((r) => r.primary_route !== "none").length;

  const nonPositiveByKind: Record<string, RateStat> = {};
  for (const kind of CASE_KINDS) {
    if (kind === "positive") continue;
    const kindCases = routed.filter((r) => r.kind === kind);
    const falseCount = kindCases.filter((r) => r.primary_route !== "none").length;
    nonPositiveByKind[kind] = {
      numerator: falseCount,
      denominator: kindCases.length,
      rate: kindCases.length > 0 ? falseCount / kindCases.length : null,
    };
  }

  return {
    evaluated_cases: routed.length,
    provider_error_count: providerErrorCount,
    excluded_unreachable_count: excludedUnreachableCount,
    top1_accuracy: {
      numerator: top1Correct,
      denominator: positives.length,
      rate: positives.length > 0 ? top1Correct / positives.length : null,
    },
    per_route_recall: perRouteRecall,
    double_trigger: {
      count: doubleTriggerCount,
      denominator: routed.length,
      rate: routed.length > 0 ? doubleTriggerCount / routed.length : 0,
    },
    ordinary_qa_false_activation: {
      numerator: ordinaryQaFalse,
      denominator: ordinaryQaCases.length,
      rate: ordinaryQaCases.length > 0 ? ordinaryQaFalse / ordinaryQaCases.length : null,
      small_sample: ordinaryQaCases.length < ROUTING_FLOORS.smallSampleThreshold,
    },
    non_positive_false_activation_by_kind: nonPositiveByKind,
  };
}

/**
 * Every floor/ceiling below is the plan's own SSD-07 acceptance line, applied
 * verbatim: top-1 >=95%, per-route recall >=90% (every REACHABLE route, not
 * just the aggregate -- a single zero-recall reachable route fails the whole
 * gate even if everything else is perfect), double-trigger <=2%, ordinary-QA
 * false activation <=1% UNLESS the negative sample is below 100 (it always is
 * for this frozen 68-case/4-case-ordinary-qa corpus), in which case the rule
 * is "require zero false activations, report small-sample" rather than a raw
 * percentage comparison.
 *
 * HIGH finding fix (SSD-07 phase A acceptance-gate): no single profile/host
 * run discovers all canonical routes (see the notes file's D5 entry), so a
 * route that is structurally unreachable this run (per_route_recall[route]
 * .reachable === false, denominator 0) is NOT gated here -- it cannot drag
 * down allRoutesPass/overall_pass. This makes a single run's overall_pass
 * mean "all floors met over THIS run's reachable subset" -- PARTIAL evidence,
 * not package acceptance (see RoutingRunReport.evidence_scope/evidence_note).
 * Package acceptance across the full 10-route canonical set requires the
 * `aggregate` subcommand over 2+ runs (buildAggregateReport, below), which
 * reuses this exact function verbatim over the unioned records.
 */
export function evaluateThresholds(
  metrics: RoutingMetrics,
  floors: typeof ROUTING_FLOORS = ROUTING_FLOORS,
): ThresholdEvaluation {
  const top1Pass = metrics.top1_accuracy.rate !== null && metrics.top1_accuracy.rate >= floors.top1AccuracyMin;

  const perRoutePass: Record<string, ThresholdResult> = {};
  let allRoutesPass = true;
  for (const [route, stat] of Object.entries(metrics.per_route_recall)) {
    const pass = !stat.reachable || (stat.rate !== null && stat.rate >= floors.perRouteRecallMin);
    if (stat.reachable && !pass) allRoutesPass = false;
    perRoutePass[route] = { floor: floors.perRouteRecallMin, actual: stat.rate, pass, reachable: stat.reachable };
  }

  const doubleTriggerPass = metrics.double_trigger.rate <= floors.doubleTriggerMax;

  const oqa = metrics.ordinary_qa_false_activation;
  const oqaPass = oqa.small_sample
    ? oqa.numerator === 0
    : oqa.rate !== null && oqa.rate <= floors.ordinaryQaFalseActivationMax;

  return {
    top1_accuracy: { floor: floors.top1AccuracyMin, actual: metrics.top1_accuracy.rate, pass: top1Pass },
    per_route_recall: perRoutePass,
    double_trigger: { ceiling: floors.doubleTriggerMax, actual: metrics.double_trigger.rate, pass: doubleTriggerPass },
    ordinary_qa_false_activation: {
      ceiling: floors.ordinaryQaFalseActivationMax,
      actual: oqa.rate,
      small_sample: oqa.small_sample,
      pass: oqaPass,
    },
    overall_pass: top1Pass && allRoutesPass && doubleTriggerPass && oqaPass,
  };
}

// --- orchestration + report ---

/**
 * "single_run_partial": one run's overall_pass reflects floors met over ITS
 * OWN reachable route subset only (profile/host-gated) -- PARTIAL evidence,
 * never package acceptance on its own (see SINGLE_RUN_EVIDENCE_NOTE).
 * "aggregate_package_acceptance": buildAggregateReport's output, below --
 * the aggregate evaluates all canonical routes (each from a run where it
 * was actually reachable), but it is ADVISORY evidence, not a merge gate
 * (see AGGREGATE_ADVISORY_REASON).
 */
type EvidenceScope = "single_run_partial" | "aggregate_package_acceptance";

export const SINGLE_RUN_EVIDENCE_NOTE =
  "PARTIAL evidence only: no single profile/host run discovers all 10 " +
  "canonical routes, so this run's overall_pass reflects floors met over " +
  "ITS OWN reachable route subset only, not full package acceptance. " +
  "Package acceptance requires the `aggregate` subcommand over 2+ runs " +
  "whose union covers every canonical route.";

export interface RunOptions {
  readonly plugins: readonly PluginId[];
  readonly host: SkillSurfaceHost;
  readonly provider: ProviderKind;
  readonly reportPath: string;
  readonly dryRun: boolean;
  readonly stubOptions?: StubProviderOptions;
  readonly providerOverride?: ProviderAdapter;
  readonly corpus?: RoutingCorpus;
  readonly catalog?: SkillSurfaceCatalog;
  readonly workspaceRoot?: string;
  readonly processProviderOptions?: ProcessProviderOptions;
}

export interface RoutingRunReport {
  readonly protocol: 1;
  readonly evidence_scope: EvidenceScope;
  readonly evidence_note: string;
  readonly generated_at: string;
  readonly plugins: readonly PluginId[];
  readonly host: SkillSurfaceHost;
  readonly provider: ProviderKind;
  readonly dry_run: boolean;
  readonly corpus_sha256: string;
  readonly manifest_sha256: string;
  readonly discovered_surface: ReadonlyArray<{ readonly name: string; readonly reason: DiscoveryReason }>;
  readonly reference_only_surface: ReadonlyArray<{ readonly name: string; readonly reason: DiscoveryReason }>;
  readonly records: readonly RoutingRunRecord[];
  readonly metrics: RoutingMetrics;
  readonly thresholds: ThresholdEvaluation;
}

// ============================================================================
// Aggregate subcommand (SSD-07 phase A HIGH-finding fix, layer 2): the plan's
// acceptance line -- "Every canonical route meets its floor; aggregate
// accuracy cannot hide a zero-recall route" -- cannot be evaluated from any
// single run (no profile/host discovers all canonical routes). This consumes 2+
// single-run reports, verifies they are comparable (identical corpus/manifest
// sha256, fail closed otherwise), for each corpus case picks a record from a
// run where its expected route was reachable (deterministic tie-break when
// reachable in more than one: the OPERATOR'S GIVEN INPUT ORDER on the
// command line -- never a re-sort by file path; SSD-07 Phase B found the
// original path-sort tie-break silently discarded correct records purely
// because of file-naming accidents), fails closed if any canonical route is
// unreachable in EVERY input, and reuses
// computeRoutingMetrics/evaluateThresholds VERBATIM over the union so the
// four plan floors are applied identically to a single run -- just with zero
// excluded_unreachable records left (every route reachable somewhere).
// ============================================================================

export interface AggregateInputReport {
  readonly path: string;
  readonly report: RoutingRunReport;
}

export interface AggregateCaseSource {
  readonly id: string;
  readonly source_report: string;
}

export const AGGREGATE_ADVISORY_REASON =
  "The provider harness invokes claude -p / codex exec with the raw corpus " +
  "prompt and no routing preamble, so this measurement reflects direct model " +
  "answers, not skill discovery. overall_pass and the floors are reported " +
  "advisory evidence, not a merge gate, until a follow-up adds the routing " +
  "preamble and reconsiders gating.";

export const AGGREGATE_EVIDENCE_NOTE =
  "ADVISORY EVIDENCE, NOT A MERGE GATE: overall_pass here evaluates all four " +
  "plan floors over the union of 2+ runs, with every canonical route scored " +
  "from a run where it was actually reachable. A zero-recall route cannot " +
  "hide behind a flattering aggregate -- every canonical route is reported " +
  "independently. Gating waits for a follow-up that adds the routing " +
  "preamble and reconsiders the floors.";

export interface AggregateRunReport {
  readonly protocol: 1;
  readonly evidence_scope: EvidenceScope;
  readonly advisory: true;
  readonly advisory_reason: string;
  readonly evidence_note: string;
  readonly generated_at: string;
  readonly corpus_sha256: string;
  readonly manifest_sha256: string;
  readonly inputs: ReadonlyArray<{
    readonly path: string;
    readonly plugins: readonly PluginId[];
    readonly host: SkillSurfaceHost;
    readonly provider: ProviderKind;
  }>;
  readonly case_sources: readonly AggregateCaseSource[];
  readonly records: readonly RoutingRunRecord[];
  readonly metrics: RoutingMetrics;
  readonly thresholds: ThresholdEvaluation;
}

/**
 * Pure: takes already-loaded {path, report} pairs (path is a caller-supplied
 * identifier used only for the deterministic tie-break and case_sources
 * labeling, not read from disk here -- see runAggregate for the disk-reading
 * CLI wrapper). Fails closed (throws CliError) on: fewer than 2 inputs, an
 * input that isn't a single-run report, mismatched corpus_sha256 or
 * manifest_sha256 across inputs, or a canonical route unreachable in every
 * input. Does not throw on a floor violation in the union -- that is a normal
 * evaluation outcome surfaced as thresholds.overall_pass === false.
 */
export function buildAggregateReport(
  inputs: readonly AggregateInputReport[],
  canonicalRoutes: readonly string[],
): AggregateRunReport {
  if (inputs.length < 2) {
    throw new CliError(`aggregate: requires at least 2 input reports, got ${inputs.length}`);
  }

  // Precedence for a case reachable in more than one input is the ORDER THE
  // OPERATOR GAVE THE REPORTS ON THE COMMAND LINE -- an explicit, visible,
  // operator-chosen tie-break, never a re-sort by file path. An earlier
  // version sorted inputs lexicographically by path, which silently
  // discarded correct records whenever a report's path happened to sort
  // after another report covering the same case (found during SSD-07 Phase
  // B: "routing-report-full-claude.json" < "...-full-codex.json" meant every
  // case reachable on both hosts was always sourced from Claude, even when
  // Codex's own record was correct and Claude's was not). Preserving input
  // order makes the
  // precedence a deliberate choice the operator states on the command line,
  // not an accident of file naming.
  const sorted = inputs;
  const first = sorted[0];

  for (const entry of sorted) {
    if (entry.report.evidence_scope !== "single_run_partial") {
      throw new CliError(
        `aggregate: ${entry.path}: expected a single-run report (evidence_scope "single_run_partial"), got ${JSON.stringify((entry.report as { evidence_scope?: unknown }).evidence_scope)}`,
      );
    }
  }

  for (const entry of sorted) {
    if (entry.report.corpus_sha256 !== first.report.corpus_sha256) {
      throw new CliError(
        `aggregate: corpus_sha256 mismatch: ${first.path} has ${first.report.corpus_sha256}, ${entry.path} has ${entry.report.corpus_sha256} -- inputs must be evaluated against byte-identical corpus`,
      );
    }
    if (entry.report.manifest_sha256 !== first.report.manifest_sha256) {
      throw new CliError(
        `aggregate: manifest_sha256 mismatch: ${first.path} has ${first.report.manifest_sha256}, ${entry.path} has ${entry.report.manifest_sha256} -- inputs must be evaluated against byte-identical manifest`,
      );
    }
  }

  const unreachableEverywhere = canonicalRoutes.filter(
    (route) => !sorted.some((entry) => entry.report.metrics.per_route_recall[route]?.reachable === true),
  );
  if (unreachableEverywhere.length > 0) {
    throw new CliError(
      `aggregate: canonical route(s) unreachable in every input report, cannot evaluate package acceptance: ${unreachableEverywhere.join(", ")} (inputs: ${sorted.map((e) => e.path).join(", ")})`,
    );
  }

  const records: RoutingRunRecord[] = [];
  const caseSources: AggregateCaseSource[] = [];
  for (const caseId of first.report.records.map((r) => r.id)) {
    let picked: { path: string; record: RoutingRunRecord } | undefined;
    for (const entry of sorted) {
      const candidate = entry.report.records.find((r) => r.id === caseId);
      if (candidate && candidate.excluded_unreachable !== true) {
        picked = { path: entry.path, record: candidate };
        break;
      }
    }
    if (!picked) {
      // Defensive only: the route-level fail-closed check above already
      // guarantees every case's route is reachable in at least one input
      // (reachability is all-or-nothing per route per run), so this should
      // be unreachable in practice -- fail closed rather than silently drop
      // the case if it ever is.
      throw new CliError(`aggregate: case "${caseId}" has no input report where its expected route is reachable`);
    }
    records.push(picked.record);
    caseSources.push({ id: caseId, source_report: picked.path });
  }

  const metrics = computeRoutingMetrics(records, canonicalRoutes);
  const thresholds = evaluateThresholds(metrics);

  return {
    protocol: 1,
    evidence_scope: "aggregate_package_acceptance",
    advisory: true,
    advisory_reason: AGGREGATE_ADVISORY_REASON,
    evidence_note: AGGREGATE_EVIDENCE_NOTE,
    generated_at: new Date().toISOString(),
    corpus_sha256: first.report.corpus_sha256,
    manifest_sha256: first.report.manifest_sha256,
    inputs: sorted.map((entry) => ({
      path: entry.path,
      plugins: entry.report.plugins,
      host: entry.report.host,
      provider: entry.report.provider,
    })),
    case_sources: caseSources,
    records,
    metrics,
    thresholds,
  };
}

function evaluateRoutingCase(
  routingCase: RoutingCase,
  ctx: {
    readonly workspaceRoot: string;
    readonly host: SkillSurfaceHost;
    readonly provider: ProviderAdapter;
    readonly discovered: readonly DiscoveredSkillSurfaceEntry[];
    readonly referenceOnly: readonly DiscoveredSkillSurfaceEntry[];
    readonly candidates: readonly DiscoveredSkillSurfaceEntry[];
    readonly reachableRoutes: ReadonlySet<string>;
  },
): RoutingRunRecord {
  const casePath = join(ctx.workspaceRoot, routingCase.id);
  mkdirSync(casePath, { recursive: true });
  if (ctx.provider.kind !== "stub") materializeDiscoveredSurface(casePath, ctx.host, ctx.discovered);

  const result = ctx.provider.invoke({
    routingCase,
    workspacePath: casePath,
    host: ctx.host,
    discovered: ctx.discovered,
    referenceOnly: ctx.referenceOnly,
  });
  const selectedRoutes = result.routes.filter(
    (route) => ctx.candidates.some((c) => c.name === route) || route === "merge-gate",
  );
  const primaryRoute = selectedRoutes[0] ?? "none";

  return {
    id: routingCase.id,
    lang: routingCase.lang,
    kind: routingCase.kind,
    expected_route: routingCase.expected_route,
    outcome: result.outcome,
    selected_routes: selectedRoutes,
    primary_route: primaryRoute,
    correct_top1: result.outcome === "routed" && primaryRoute === routingCase.expected_route,
    double_trigger: result.outcome === "routed" && selectedRoutes.length > 1,
    excluded_unreachable: routingCase.expected_route !== "none" && !ctx.reachableRoutes.has(routingCase.expected_route),
    duration_ms: result.durationMs,
    ...(result.errorReason ? { error_reason: result.errorReason } : {}),
  };
}

export function runProviderEval(options: RunOptions): RoutingRunReport {
  const corpus = options.corpus ?? loadCorpus();
  const catalog = options.catalog ?? loadLiveCatalog();
  const canonicalRoutes = canonicalRoutesFromBaseline(loadBaseline());
  const discovered = buildDiscoveredSkillSurface(catalog, options.plugins, options.host);
  const referenceOnly = referenceOnlySkillPackages(catalog);
  const candidates = [...discovered, ...referenceOnly];
  // Mirrors the selectedRoutes filter below exactly (candidates by name, plus
  // merge-gate which is always reachable regardless of profile/host -- it has
  // no discovered-surface presence at all, kind:"judge", source: null, and is
  // detected purely via extractMergeGateTextualSignal): the set of expected
  // routes this run could possibly score correctly.
  const reachableRoutes = new Set<string>([...candidates.map((c) => c.name), "merge-gate"]);

  const provider: ProviderAdapter =
    options.providerOverride ??
    (options.provider === "stub" ? createStubProvider(options.stubOptions) : createProcessProvider(options.provider, options.processProviderOptions));

  const workspaceRoot = options.workspaceRoot ?? mkdtempSync(join(tmpdir(), "repo-harness-routing-run-"));

  const records: RoutingRunRecord[] = corpus.cases.map((routingCase) =>
    evaluateRoutingCase(routingCase, {
      workspaceRoot,
      host: options.host,
      provider,
      discovered,
      referenceOnly,
      candidates,
      reachableRoutes,
    }),
  );

  const metrics = computeRoutingMetrics(records, canonicalRoutes);
  const thresholds = evaluateThresholds(metrics);

  const report: RoutingRunReport = {
    protocol: 1,
    evidence_scope: "single_run_partial",
    evidence_note: SINGLE_RUN_EVIDENCE_NOTE,
    generated_at: new Date().toISOString(),
    plugins: options.plugins,
    host: options.host,
    provider: options.provider,
    dry_run: options.dryRun,
    corpus_sha256: sha256Hex(readFileSync(CORPUS_PATH)),
    manifest_sha256: sha256Hex(readFileSync(MANIFEST_PATH)),
    discovered_surface: discovered.map((d) => ({ name: d.name, reason: d.reason })),
    reference_only_surface: referenceOnly.map((d) => ({ name: d.name, reason: d.reason })),
    records,
    metrics,
    thresholds,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(options.reportPath, json, "utf-8");
  const sidecarPath = `${options.reportPath}.sha256`;
  writeFileSync(sidecarPath, `${sha256Hex(Buffer.from(json, "utf-8"))}  ${relative(REPO_ROOT, options.reportPath)}\n`, "utf-8");

  return report;
}

// ============================================================================
// Subject freeze (SSD-07 phase A / D3): evals/skill-routing/final-subject-
// freeze.json binds every commit-INDEPENDENT piece of evidence now (manifest
// sha256, corpus sha256, per-canonical-package tree hashes, discovered-set
// projections per profile/host) and records head_sha as null-with-note,
// since the commit that will carry phase A's own changes does not exist yet.
// The orchestrator re-runs `freeze --write` after committing to stamp
// head_sha and refresh changed_files_since_base (which is git-history-based
// and will then include this phase's own commit).
// ============================================================================

const WORK_PACKAGE_BASE_SHA = "314ee1a7b630e9016b4e184030129fbc9e00a9ef";
export const DEFAULT_FREEZE_PATH = join(SKILL_ROUTING_DIR, "final-subject-freeze.json");

/** Reproduces install-profile.ts's internal hashManagedTree algorithm
 * (sorted relative paths, "F\0<path>\0"+content+"\0" for files,
 * "L\0<path>\0<target>\0" for symlinks) exactly -- that function is not
 * exported, so this is a deliberate, faithful re-implementation of the same
 * pattern for freeze evidence, not an import. */
export function hashPackageTree(root: string): string {
  const entries: Array<{ path: string; type: "file" | "symlink" }> = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relativePath);
      else if (entry.isFile()) entries.push({ path: relativePath, type: "file" });
      else if (entry.isSymbolicLink()) entries.push({ path: relativePath, type: "symlink" });
    }
  };
  visit(root, "");
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    const absolute = join(root, entry.path);
    if (entry.type === "symlink") {
      hash.update(`L\0${entry.path}\0${readlinkSync(absolute)}\0`);
    } else {
      hash.update(`F\0${entry.path}\0`);
      hash.update(readFileSync(absolute));
      hash.update("\0");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function runGit(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export interface SubjectFreeze {
  readonly protocol: 1;
  readonly generated_at: string;
  readonly slice: "SSD-07 phase A";
  readonly work_package_base_sha: string;
  readonly head_sha: string | null;
  readonly head_sha_note: string;
  readonly manifest_sha256: string;
  readonly corpus_sha256: string;
  readonly package_tree_hashes: Record<string, string>;
  readonly discovered_set_projections: Record<string, ReadonlyArray<{ readonly name: string; readonly reason: string }>>;
  readonly changed_files_since_base: readonly string[];
  readonly changed_files_note: string;
  readonly uncommitted_changes_at_freeze_time: {
    readonly modified: readonly string[];
    readonly added_or_untracked: readonly string[];
  };
}

/** Keep only paths that still exist at HEAD. A work-package diff also names
 * every path deleted between the base and HEAD, including retired plan and
 * sprint files; those paths are not part of the live subject the freeze
 * binds. Membership is exact: no prefix or glob inference. */
export function filterPathsPresentAtHead(
  changedPaths: readonly string[],
  headPaths: ReadonlySet<string>,
): string[] {
  return changedPaths.filter((path) => headPaths.has(path));
}

export function buildSubjectFreeze(): SubjectFreeze {
  const catalog = loadLiveCatalog();

  const packageTreeHashes: Record<string, string> = {};
  for (const pkg of catalog.packages) {
    if (pkg.source === null) continue; // merge-gate (kind:"judge") and any future no-source entry: nothing to hash
    const absolute = pkg.source === "." ? REPO_ROOT : resolve(REPO_ROOT, pkg.source);
    if (pkg.source === ".") continue; // the root router's "source" is the whole repo tree, not a bounded package directory; SKILL.md itself is covered by the manifest_sha256/corpus_sha256 freeze fields instead
    packageTreeHashes[pkg.name] = hashPackageTree(absolute);
  }

  const discoveredSetProjections: SubjectFreeze["discovered_set_projections"] = {};
  for (const [label, plugins] of [["core", []], ["all", PLUGIN_IDS]] as const) {
    for (const host of ROUTING_EVAL_HOSTS) {
      const key = `${label}/${host}`;
      discoveredSetProjections[key] = buildDiscoveredSkillSurface(catalog, plugins, host).map((e) => ({ name: e.name, reason: e.reason }));
    }
  }

  const diffResult = runGit(["diff", "--name-only", `${WORK_PACKAGE_BASE_SHA}..HEAD`]);
  if (diffResult.status !== 0) {
    throw new CliError(`freeze: git diff --name-only ${WORK_PACKAGE_BASE_SHA}..HEAD failed: ${diffResult.stderr.trim()}`);
  }
  const headTree = runGit(["ls-tree", "-r", "--name-only", "-z", "HEAD"]);
  if (headTree.status !== 0) {
    throw new CliError(`freeze: git ls-tree -r --name-only HEAD failed: ${headTree.stderr.trim()}`);
  }
  const headPaths = new Set(headTree.stdout.split("\0").filter(Boolean));
  const changedFilesSinceBase = filterPathsPresentAtHead(
    diffResult.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
    headPaths,
  ).sort();

  const statusResult = runGit(["status", "--porcelain", "--untracked-files=all"]);
  const modified: string[] = [];
  const addedOrUntracked: string[] = [];
  for (const line of statusResult.stdout.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    if (code.includes("?") || code.includes("A")) addedOrUntracked.push(filePath);
    else modified.push(filePath);
  }
  modified.sort();
  addedOrUntracked.sort();

  return {
    protocol: 1,
    generated_at: new Date().toISOString(),
    slice: "SSD-07 phase A",
    work_package_base_sha: WORK_PACKAGE_BASE_SHA,
    head_sha: null,
    head_sha_note:
      "Null by design: the commit that will carry this phase's own changes " +
      "does not exist yet (Phase A does not commit). Every other field in " +
      "this freeze is commit-independent (file/tree bytes on disk right " +
      "now); the orchestrator stamps head_sha with `git rev-parse HEAD` " +
      "immediately after committing this phase's work, and should re-run " +
      "`bun scripts/run-skill-routing-eval.ts freeze --write` at that point " +
      "so changed_files_since_base also picks up the new commit.",
    manifest_sha256: sha256Hex(readFileSync(MANIFEST_PATH)),
    corpus_sha256: sha256Hex(readFileSync(CORPUS_PATH)),
    package_tree_hashes: packageTreeHashes,
    discovered_set_projections: discoveredSetProjections,
    changed_files_since_base: changedFilesSinceBase,
    changed_files_note:
      `git diff --name-only ${WORK_PACKAGE_BASE_SHA}..HEAD at freeze-generation time, filtered to paths ` +
      "that still exist at HEAD: deleted plan and sprint paths from earlier work packages are not part of " +
      "the live subject. The list reflects committed history only, NOT this phase's own still-uncommitted " +
      "changes (see uncommitted_changes_at_freeze_time below for those). Re-running the identical command " +
      "after the orchestrator commits phase A will include this phase's files too.",
    uncommitted_changes_at_freeze_time: { modified, added_or_untracked: addedOrUntracked },
  };
}

export function runCli(argv: string[]): number {
  return executeSkillRoutingCli(argv, {
    repoRoot: REPO_ROOT,
    corpusPath: CORPUS_PATH,
    baselinePath: BASELINE_PATH,
    defaultFreezePath: DEFAULT_FREEZE_PATH,
    routingEvalHosts: ROUTING_EVAL_HOSTS,
    cliError: (message, exitCode) => new CliError(message, exitCode),
    loadJson,
    loadCorpus,
    loadBaseline,
    sha256Hex,
    canonicalRoutesFromBaseline,
    validateCorpusShape,
    validateCoverage: (corpus, canonicalRoutes) => validateCoverage(corpus as RoutingCorpus, canonicalRoutes),
    schemaDriftIssues,
    runProviderEval,
    buildAggregateReport,
    buildSubjectFreeze,
  });
}

if (import.meta.main) {
  try {
    process.exit(runCli(process.argv.slice(2)));
  } catch (error) {
    console.error(`run-skill-routing-eval: ${(error as Error).message}`);
    process.exit(error instanceof CliError ? error.exitCode : 1);
  }
}
