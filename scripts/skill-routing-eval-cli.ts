import { readFileSync, writeFileSync } from "fs";
import { relative } from "path";
import type { SkillSurfaceHost } from "../src/core/skill-surface/catalog";
import { parsePluginList, type PluginId } from "../src/core/skill-surface/plugin-manifest";

interface RateStatView {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
}

interface MetricsView {
  readonly evaluated_cases: number;
  readonly provider_error_count: number;
  readonly excluded_unreachable_count: number;
  readonly top1_accuracy: RateStatView;
  readonly per_route_recall: Record<string, RateStatView & { readonly reachable: boolean }>;
  readonly double_trigger: { readonly count: number; readonly denominator: number; readonly rate: number };
  readonly ordinary_qa_false_activation: RateStatView & { readonly small_sample: boolean };
}

interface ThresholdResultView {
  readonly floor?: number;
  readonly ceiling?: number;
  readonly pass: boolean;
}

interface ThresholdsView {
  readonly top1_accuracy: ThresholdResultView;
  readonly per_route_recall: Record<string, ThresholdResultView>;
  readonly double_trigger: ThresholdResultView;
  readonly ordinary_qa_false_activation: ThresholdResultView;
  readonly overall_pass: boolean;
}

interface RunReportView {
  readonly plugins: readonly PluginId[];
  readonly host: SkillSurfaceHost;
  readonly provider: "stub" | "claude" | "codex";
  readonly dry_run: boolean;
  readonly evidence_scope: string;
  readonly evidence_note: string;
  readonly metrics: MetricsView;
  readonly thresholds: ThresholdsView;
}

interface AggregateReportView {
  readonly inputs: ReadonlyArray<{
    readonly path: string;
    readonly plugins: readonly PluginId[];
    readonly host: SkillSurfaceHost;
    readonly provider: "stub" | "claude" | "codex";
  }>;
  readonly records: readonly unknown[];
  readonly metrics: MetricsView;
  readonly thresholds: ThresholdsView;
  readonly advisory: true;
  readonly advisory_reason: string;
  readonly evidence_scope: string;
  readonly evidence_note: string;
}

interface FreezeReportView {
  readonly package_tree_hashes: Record<string, string>;
  readonly changed_files_since_base: readonly string[];
}

interface CorpusView {
  readonly cases: ReadonlyArray<{ readonly id: string; readonly expected_route: string }>;
}

export interface CliRunArgs {
  readonly plugins: readonly PluginId[];
  readonly host: SkillSurfaceHost;
  readonly provider: "stub" | "claude" | "codex";
  readonly reportPath: string;
  readonly dryRun: boolean;
}

export interface SkillRoutingCliDeps<TReport extends RunReportView = RunReportView> {
  readonly repoRoot: string;
  readonly corpusPath: string;
  readonly baselinePath: string;
  readonly defaultFreezePath: string;
  readonly routingEvalHosts: readonly SkillSurfaceHost[];
  readonly cliError: (message: string, exitCode?: number) => Error;
  readonly loadJson: (path: string) => unknown;
  readonly loadCorpus: (path?: string) => CorpusView;
  readonly loadBaseline: (path?: string) => Record<string, unknown>;
  readonly sha256Hex: (bytes: Buffer) => string;
  readonly canonicalRoutesFromBaseline: (baseline: Record<string, unknown>) => string[];
  readonly validateCorpusShape: (corpus: unknown) => string[];
  readonly validateCoverage: (corpus: CorpusView, canonicalRoutes: readonly string[]) => string[];
  readonly schemaDriftIssues: (canonicalRoutes: readonly string[]) => string[];
  readonly runProviderEval: (options: CliRunArgs) => TReport;
  readonly buildAggregateReport: (
    inputs: ReadonlyArray<{ readonly path: string; readonly report: TReport }>,
    canonicalRoutes: readonly string[],
  ) => AggregateReportView;
  readonly buildSubjectFreeze: () => FreezeReportView;
}

function usage(): string {
  return [
    "Usage:",
    "  bun scripts/run-skill-routing-eval.ts validate",
    "  bun scripts/run-skill-routing-eval.ts hash [--write]",
    "  bun scripts/run-skill-routing-eval.ts dry-run",
    "  bun scripts/run-skill-routing-eval.ts run (--plugins <ids> | --no-plugins) --host <h> --report <path> [--dry-run] [--provider <claude|codex|stub>]",
    "  bun scripts/run-skill-routing-eval.ts aggregate --report <path> <run-report.json> <run-report.json> [...]",
    "",
    "validate: schema-shape plus coverage requirements (per-route zh+en positives,",
    "kind floors, overlap-term coverage, unique ids, total case count in [60,90]).",
    "hash: sha256 of routing-corpus.json vs discovery-baseline.json's corpus_sha256;",
    "verify-only by default, --write updates the baseline file in place.",
    "dry-run: asserts every expected_route is \"none\" or a baseline canonical route,",
    "then prints per-route case counts. No provider call; SSD-07 owns that run.",
    "run: executes the frozen corpus once per case against the post-cutover",
    "discovered Skill surface for --plugins/--host, scores canonical top-1",
    "accuracy / per-route recall / double-trigger / ordinary-QA false",
    "activation against the plan's floors, and writes a report + .sha256",
    "sidecar to --report. --dry-run always uses a built-in stub provider (no",
    "real provider call, no network); the real mode requires an explicit",
    "--provider claude|codex. No single profile/host discovers all canonical",
    "routes, so a route unreachable this run is excluded from top1/per-route",
    "denominators and not gated; overall_pass here is PARTIAL evidence over",
    "this run's reachable subset only, not package acceptance (see aggregate).",
    "aggregate --report <path> <report.json>...: consumes 2+ `run` reports,",
    "fails closed on mismatched corpus/manifest sha256 across inputs or a",
    "canonical route unreachable in every input, else evaluates all four plan",
    "floors over the union (each case scored from a run where its route was",
    "reachable) and writes a report + .sha256 sidecar. The report is marked",
    "advisory:true with advisory_reason: overall_pass is reported evidence,",
    "not a merge gate, because the provider invocation has no routing",
    "preamble and measures direct model answers rather than skill discovery.",
    "freeze [--write] [--out <path>]: computes the SSD-07 subject-freeze",
    "record (manifest/corpus sha256, per-package tree hashes, discovered-set",
    "projections per profile/host, changed-files-since-base, head_sha:null-",
    "with-note). Prints to stdout by default; --write persists to --out",
    "(default evals/skill-routing/final-subject-freeze.json).",
  ].join("\n");
}

function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

/** Shared by printRunSummary and printAggregateSummary so both print the
 * identical metrics/thresholds body -- one source of truth for the console
 * shape, not two copies that can drift. */
function printMetricsAndThresholds(metrics: MetricsView, thresholds: ThresholdsView): void {
  console.log(
    `  evaluated=${metrics.evaluated_cases} provider_errors=${metrics.provider_error_count} excluded_unreachable=${metrics.excluded_unreachable_count}`,
  );
  console.log(
    `  top1_accuracy=${formatRate(metrics.top1_accuracy.rate)} (${metrics.top1_accuracy.numerator}/${metrics.top1_accuracy.denominator}) floor=${String(thresholds.top1_accuracy.floor)} pass=${String(thresholds.top1_accuracy.pass)}`,
  );
  for (const [route, stat] of Object.entries(metrics.per_route_recall)) {
    const t = thresholds.per_route_recall[route];
    const reachTag = stat.reachable ? "" : " (unreachable this run, not gated)";
    console.log(`  recall[${route}]=${formatRate(stat.rate)} (${stat.numerator}/${stat.denominator}) pass=${String(t.pass)}${reachTag}`);
  }
  console.log(
    `  double_trigger=${formatRate(metrics.double_trigger.rate)} (${metrics.double_trigger.count}/${metrics.double_trigger.denominator}) ceiling=${String(thresholds.double_trigger.ceiling)} pass=${String(thresholds.double_trigger.pass)}`,
  );
  const oqa = metrics.ordinary_qa_false_activation;
  console.log(
    `  ordinary_qa_false_activation=${formatRate(oqa.rate)} (${oqa.numerator}/${oqa.denominator}) small_sample=${String(oqa.small_sample)} pass=${String(thresholds.ordinary_qa_false_activation.pass)}`,
  );
  console.log(`  overall_pass=${String(thresholds.overall_pass)}`);
}

function parseRunArgs<TReport extends RunReportView>(argv: string[], deps: SkillRoutingCliDeps<TReport>): CliRunArgs {
  let plugins: readonly PluginId[] | undefined;
  let host: SkillSurfaceHost | undefined;
  let provider: "stub" | "claude" | "codex" | undefined;
  let reportPath: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plugins") {
      const value = argv[++i] ?? "";
      try {
        plugins = parsePluginList(value);
      } catch (error) {
        throw deps.cliError(`run: ${(error as Error).message}`, 2);
      }
    } else if (arg === "--no-plugins") {
      plugins = [];
    } else if (arg === "--host") {
      const value = argv[++i];
      if (!(deps.routingEvalHosts as readonly string[]).includes(value)) {
        throw deps.cliError(`run: --host must be one of ${deps.routingEvalHosts.join(", ")}`, 2);
      }
      host = value as SkillSurfaceHost;
    } else if (arg === "--provider") {
      const value = argv[++i];
      if (value !== "claude" && value !== "codex" && value !== "stub") {
        throw deps.cliError("run: --provider must be one of claude, codex, stub", 2);
      }
      provider = value;
    } else if (arg === "--report") {
      reportPath = argv[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw deps.cliError(`run: unknown argument ${arg}`, 2);
    }
  }

  if (!plugins) throw deps.cliError("run: --plugins <ids> or --no-plugins is required", 2);
  if (!host) throw deps.cliError("run: --host is required", 2);
  if (!reportPath) throw deps.cliError("run: --report is required (both --dry-run and the real mode write a report + .sha256 sidecar)", 2);

  if (dryRun) {
    // --dry-run always overrides to the built-in stub, regardless of any
    // --provider value supplied alongside it (see StubProviderOptions'
    // default: a single fixed literal route, "repo-harness", echoed for
    // every case -- this smoke-tests the full pipeline including the FAIL
    // path of threshold evaluation, not just an artificially perfect run).
    return { plugins, host, provider: "stub", reportPath, dryRun: true };
  }

  if (!provider || provider === "stub") {
    throw deps.cliError("run: --provider claude|codex is required for the real (non-dry-run) mode", 2);
  }
  return { plugins, host, provider, reportPath, dryRun: false };
}

function printRunSummary(report: RunReportView, reportPath: string): void {
  console.log(
    `run-skill-routing-eval: run OK: plugins=${report.plugins.join(",") || "(core only)"} host=${report.host} provider=${report.provider}${report.dry_run ? " (dry-run)" : ""}`,
  );
  printMetricsAndThresholds(report.metrics, report.thresholds);
  console.log(`  evidence_scope=${report.evidence_scope} -- ${report.evidence_note}`);
  console.log(`  report: ${reportPath}`);
  console.log(`  sidecar: ${reportPath}.sha256`);
}

function runRun<TReport extends RunReportView>(argv: string[], deps: SkillRoutingCliDeps<TReport>): number {
  const options = parseRunArgs(argv, deps);
  const report = deps.runProviderEval(options);
  printRunSummary(report, options.reportPath);
  return 0;
}

function parseAggregateArgs<TReport extends RunReportView>(
  argv: string[],
  deps: SkillRoutingCliDeps<TReport>,
): { reportPath: string; inputPaths: string[] } {
  let reportPath: string | undefined;
  const inputPaths: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report") {
      reportPath = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw deps.cliError(`aggregate: unknown argument ${arg}`, 2);
    } else {
      inputPaths.push(arg);
    }
  }
  if (!reportPath) throw deps.cliError("aggregate: --report is required", 2);
  if (inputPaths.length < 2) {
    throw deps.cliError(`aggregate: at least 2 input report paths are required, got ${inputPaths.length}`, 2);
  }
  return { reportPath, inputPaths };
}

function printAggregateSummary(report: AggregateReportView, reportPath: string): void {
  console.log(`run-skill-routing-eval: aggregate OK: ${report.inputs.length} input reports, ${report.records.length} cases`);
  for (const input of report.inputs) {
    console.log(`  input: plugins=${input.plugins.join(",") || "(core only)"} host=${input.host} provider=${input.provider} path=${input.path}`);
  }
  printMetricsAndThresholds(report.metrics, report.thresholds);
  console.log(`  advisory=${String(report.advisory)} -- ${report.advisory_reason}`);
  console.log(`  evidence_scope=${report.evidence_scope} -- ${report.evidence_note}`);
  console.log(`  report: ${reportPath}`);
  console.log(`  sidecar: ${reportPath}.sha256`);
}

function runAggregate<TReport extends RunReportView>(argv: string[], deps: SkillRoutingCliDeps<TReport>): number {
  const { reportPath, inputPaths } = parseAggregateArgs(argv, deps);
  const canonicalRoutes = deps.canonicalRoutesFromBaseline(deps.loadBaseline());
  const inputs = inputPaths.map((path) => ({ path, report: deps.loadJson(path) as TReport }));
  const aggregate = deps.buildAggregateReport(inputs, canonicalRoutes);

  const json = `${JSON.stringify(aggregate, null, 2)}\n`;
  writeFileSync(reportPath, json, "utf-8");
  const sidecarPath = `${reportPath}.sha256`;
  writeFileSync(sidecarPath, `${deps.sha256Hex(Buffer.from(json, "utf-8"))}  ${relative(deps.repoRoot, reportPath)}\n`, "utf-8");

  printAggregateSummary(aggregate, reportPath);
  return 0;
}

function runFreeze<TReport extends RunReportView>(argv: string[], deps: SkillRoutingCliDeps<TReport>): number {
  let write = false;
  let outPath = deps.defaultFreezePath;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--write") write = true;
    else if (argv[i] === "--out") outPath = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(usage());
      return 0;
    } else throw deps.cliError(`freeze: unknown argument ${argv[i]}`, 2);
  }
  const freeze = deps.buildSubjectFreeze();
  const json = `${JSON.stringify(freeze, null, 2)}\n`;
  if (write) {
    writeFileSync(outPath, json, "utf-8");
    console.log(`run-skill-routing-eval: freeze written to ${relative(deps.repoRoot, outPath)}`);
  } else {
    console.log(json);
  }
  console.log(`run-skill-routing-eval: freeze OK: ${Object.keys(freeze.package_tree_hashes).length} package tree hashes, ${freeze.changed_files_since_base.length} changed files since base`);
  return 0;
}

interface Options {
  mode: "validate" | "hash" | "dry-run";
  write: boolean;
}

function parseArgs<TReport extends RunReportView>(argv: string[], deps: SkillRoutingCliDeps<TReport>): Options {
  const mode = argv[0];
  if (mode === "--help" || mode === "-h") {
    console.log(usage());
    process.exit(0);
  }
  if (mode !== "validate" && mode !== "hash" && mode !== "dry-run") {
    throw deps.cliError(`unknown or missing subcommand${mode ? ` "${mode}"` : ""}\n\n${usage()}`, 2);
  }
  let write = false;
  for (const arg of argv.slice(1)) {
    if (arg === "--write" && mode === "hash") { write = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(0); }
    throw deps.cliError(`unknown argument ${arg}`, 2);
  }
  return { mode, write };
}

function runValidate<TReport extends RunReportView>(deps: SkillRoutingCliDeps<TReport>): number {
  const corpusRaw = deps.loadJson(deps.corpusPath);
  const shapeIssues = deps.validateCorpusShape(corpusRaw);
  if (shapeIssues.length > 0) {
    for (const issue of shapeIssues) console.error(`run-skill-routing-eval: validate: ${issue}`);
    return 1;
  }
  const corpus = corpusRaw as CorpusView;
  const canonicalRoutes = deps.canonicalRoutesFromBaseline(deps.loadBaseline());
  const coverageIssues = deps.validateCoverage(corpus, canonicalRoutes);
  if (coverageIssues.length > 0) {
    for (const issue of coverageIssues) console.error(`run-skill-routing-eval: validate: ${issue}`);
    return 1;
  }
  const driftIssues = deps.schemaDriftIssues(canonicalRoutes);
  if (driftIssues.length > 0) {
    for (const issue of driftIssues) console.error(`run-skill-routing-eval: validate: ${issue}`);
    return 1;
  }
  console.log(`run-skill-routing-eval: validate OK: ${corpus.cases.length} cases`);
  return 0;
}

function runHash<TReport extends RunReportView>(write: boolean, deps: SkillRoutingCliDeps<TReport>): number {
  const computed = deps.sha256Hex(readFileSync(deps.corpusPath));
  const baseline = deps.loadBaseline();
  if (write) {
    if (baseline.corpus_sha256 === computed) {
      console.log(`run-skill-routing-eval: hash unchanged: ${computed}`);
      return 0;
    }
    baseline.corpus_sha256 = computed;
    writeFileSync(deps.baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
    console.log(`run-skill-routing-eval: wrote corpus_sha256=${computed} to ${relative(deps.repoRoot, deps.baselinePath)}`);
    return 0;
  }
  if (baseline.corpus_sha256 !== computed) {
    console.error("run-skill-routing-eval: hash mismatch");
    console.error(`  routing-corpus.json sha256            = ${computed}`);
    console.error(`  discovery-baseline.json corpus_sha256 = ${String(baseline.corpus_sha256)}`);
    console.error("  run with --write to update discovery-baseline.json, or regenerate the corpus");
    return 1;
  }
  console.log(`run-skill-routing-eval: hash OK: ${computed}`);
  return 0;
}

function runDryRun<TReport extends RunReportView>(deps: SkillRoutingCliDeps<TReport>): number {
  const corpus = deps.loadCorpus();
  const canonicalRoutes = deps.canonicalRoutesFromBaseline(deps.loadBaseline());
  const allowedRoutes = [...canonicalRoutes, "none"];
  const allowed = new Set(allowedRoutes);
  const counts = new Map<string, number>(allowedRoutes.map((name) => [name, 0]));
  const violations: string[] = [];
  for (const c of corpus.cases) {
    if (!allowed.has(c.expected_route)) {
      violations.push(`${c.id}: expected_route "${c.expected_route}" is not "none" or a target canonical route`);
      continue;
    }
    counts.set(c.expected_route, (counts.get(c.expected_route) ?? 0) + 1);
  }
  if (violations.length > 0) {
    for (const violation of violations) console.error(`run-skill-routing-eval: dry-run: ${violation}`);
    return 1;
  }
  console.log(`run-skill-routing-eval: dry-run selection OK: ${corpus.cases.length} cases`);
  for (const name of allowedRoutes) console.log(`  ${name}: ${counts.get(name)}`);
  return 0;
}

export function executeSkillRoutingCli<TReport extends RunReportView>(
  argv: string[],
  deps: SkillRoutingCliDeps<TReport>,
): number {
  if (argv[0] === "run") return runRun(argv.slice(1), deps);
  if (argv[0] === "freeze") return runFreeze(argv.slice(1), deps);
  if (argv[0] === "aggregate") return runAggregate(argv.slice(1), deps);
  const opts = parseArgs(argv, deps);
  if (opts.mode === "validate") return runValidate(deps);
  if (opts.mode === "hash") return runHash(opts.write, deps);
  return runDryRun(deps);
}
