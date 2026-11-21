import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RecommendationV3, RefactorKillListEntryV1, RefactorProposalPayloadV1, RefactorScopeV1, RefactorTargetOutcomeV1 } from 'archctx-contracts';
import { normalizeRefactorScope, RefactorProviderError, type RefactorScanResultV1 } from '../../core/refactor/provider-contract';
import type { ArchctxProviderOptions } from '../../core/architecture/contracts';
import { runRefactorScan } from './archctx-provider';

type Observation = RecommendationV3 & { category: 'structural_observation' };
type ProposalRecommendation = RecommendationV3 & { category: 'refactor_proposal'; payload: RefactorProposalPayloadV1 };
type ModuleStatistics = RefactorScanResultV1['snapshot']['modules'][number];

/** Measured facts behind one suggestion, taken from the same scan that produced it. */
export interface RefactorModuleEvidence {
  nodeId: string;
  files: number | null;
  lines: number | null;
  fanIn: number | null;
  fanOut: number | null;
  cycles: number | null;
  /** Filled only when the model declares constraints; archctx 0.9.1 leaves instability and test files unmeasured. */
  directionViolations: number | null;
  unresolvedImports: number;
  ambiguousOwnership?: boolean;
}

export interface RefactorProposalSummary {
  scale: RefactorProposalPayloadV1['scale'];
  majorChangeReasons: readonly RefactorProposalPayloadV1['majorChangeReasons'][number][];
  targetOutcomes: readonly RefactorTargetOutcomeV1[];
  killList: readonly RefactorKillListEntryV1[];
}

export interface RefactorRecommendation {
  recommendationId: string;
  category?: 'structural_observation' | 'refactor_proposal';
  kind: Observation['payload']['kind'] | 'refactor-proposal';
  subject: string;
  affectedNodeIds: readonly string[];
  confidence: string;
  risk: string;
  uncertainty: string;
  explanation: readonly string[];
  metrics: Readonly<Record<string, number | null>>;
  /** Bounded by archctx: `totalCount` is the population, `truncated` says the item list is a prefix of it. */
  evidence?: Observation['payload']['evidence'];
  proposal?: RefactorProposalSummary;
  /** True when this observation reports contested ownership or touches a module with multiply-owned files. */
  ambiguousOwnership?: boolean;
  /** The snapshot the metrics and evidence were measured on. */
  baselineSnapshotDigest: string;
  /** `current` when that snapshot is the scan just taken. `earlier` marks a record from an older scan, whose module statistics are left out. */
  snapshot: 'current' | 'earlier';
  modules: readonly RefactorModuleEvidence[];
}
export interface RefactorRecommendationResult {
  schemaVersion: 'repo-harness.refactor-recommendations/v2';
  status: 'recommended' | 'no_action' | 'proof_required' | 'unavailable';
  candidates: readonly RefactorRecommendation[];
  /** The scan identity to pass to decide. It binds open and proposed recommendations. */
  snapshotDigest?: string;
  /** Assessment and worktree digests so callers can record the scan via `rh arch refactor record`. */
  assessmentDigest?: string;
  worktreeDigest?: string;
  /** Non-zero when one or more files match multiple capability globs; clean modules remain visible. */
  multiplyOwnedFileCount?: number;
  message?: string;
  /** Provider error code, reasonCode, and the remedy archctx names for it, kept when status is `unavailable`. */
  code?: string;
  reasonCode?: string;
  action?: string;
}
export interface RefactorRecommendationOptions {
  env?: NodeJS.ProcessEnv;
  /** Raises the CodeGraph import read cap. `rh arch refactor decide` must pass the same value. */
  importNodeLimit?: number;
  /** Per archctx call limit in ms; the default is 120000. `rh arch refactor decide` takes the same option. */
  timeoutMs?: number;
  /** Limits scan observations to a declared node or repository-relative paths. */
  scope?: RefactorScopeV1;
  discover?: (repoRoot: string, provider: ArchctxProviderOptions, importNodeLimit?: number, timeoutMs?: number, scope?: RefactorScopeV1) => RefactorScanResultV1;
}

const result = (status: RefactorRecommendationResult['status'], message?: string): RefactorRecommendationResult => ({
  schemaVersion: 'repo-harness.refactor-recommendations/v2', status, candidates: [], ...(message ? { message } : {}),
});

export function refactorCandidates(scan: RefactorScanResultV1): RefactorRecommendation[] {
  const modules = new Map(scan.snapshot.modules.map((entry) => [entry.nodeId, entry]));
  const listed = new Set(scan.openRecommendations.map((entry) => entry.recommendationId));
  return [...scan.openRecommendations, ...scan.proposedRecommendations.filter((entry) => !listed.has(entry.recommendationId))]
    .flatMap((entry) => {
      if (entry.category === 'structural_observation') return [presentObservation(entry as Observation, modules, scan.snapshot.snapshotDigest)];
      if (entry.category === 'refactor_proposal') return [presentProposal(entry as ProposalRecommendation, modules, scan.snapshot.snapshotDigest)];
      return [];
    });
}

/** Module statistics come from the current scan, so they join only a suggestion measured on that same snapshot. */
function presentObservation(value: Observation, modules: ReadonlyMap<string, ModuleStatistics>, currentSnapshotDigest: string): RefactorRecommendation {
  const current = value.payload.baselineSnapshotDigest === currentSnapshotDigest;
  const moduleList = current ? value.payload.affectedNodeIds.flatMap((nodeId) => {
    const entry = modules.get(nodeId);
    return entry ? [moduleEvidence(entry)] : [];
  }) : [];
  const ambiguous = value.payload.kind === 'ownership-ambiguous' || moduleList.some((m) => m.ambiguousOwnership === true);
  return {
    recommendationId: value.recommendationId,
    category: 'structural_observation',
    kind: value.payload.kind,
    subject: value.subject,
    affectedNodeIds: value.payload.affectedNodeIds,
    confidence: value.confidence,
    risk: value.risk,
    uncertainty: value.uncertainty,
    explanation: value.explanation,
    metrics: value.payload.metrics,
    evidence: value.payload.evidence,
    ...(ambiguous ? { ambiguousOwnership: true } : {}),
    baselineSnapshotDigest: value.payload.baselineSnapshotDigest,
    snapshot: current ? 'current' : 'earlier',
    modules: moduleList,
  };
}

function presentProposal(value: ProposalRecommendation, modules: ReadonlyMap<string, ModuleStatistics>, currentSnapshotDigest: string): RefactorRecommendation {
  const current = value.payload.baselineSnapshotDigest === currentSnapshotDigest;
  const moduleList = current ? value.payload.affectedNodeIds.flatMap((nodeId) => {
    const entry = modules.get(nodeId);
    return entry ? [moduleEvidence(entry)] : [];
  }) : [];
  const ambiguous = moduleList.some((m) => m.ambiguousOwnership === true);
  return {
    recommendationId: value.recommendationId,
    category: 'refactor_proposal',
    kind: 'refactor-proposal',
    subject: value.subject,
    affectedNodeIds: value.payload.affectedNodeIds,
    confidence: value.confidence,
    risk: value.risk,
    uncertainty: value.uncertainty,
    explanation: value.explanation,
    metrics: {},
    proposal: {
      scale: value.payload.scale,
      majorChangeReasons: value.payload.majorChangeReasons,
      targetOutcomes: value.payload.targetOutcomes,
      killList: value.payload.killList,
    },
    ...(ambiguous ? { ambiguousOwnership: true } : {}),
    baselineSnapshotDigest: value.payload.baselineSnapshotDigest,
    snapshot: current ? 'current' : 'earlier',
    modules: moduleList,
  };
}

function moduleEvidence(entry: ModuleStatistics): RefactorModuleEvidence {
  return {
    nodeId: entry.nodeId, files: entry.footprint?.fileCount ?? null, lines: entry.footprint?.lineCount ?? null,
    fanIn: entry.dependencyGraph?.fanIn ?? null, fanOut: entry.dependencyGraph?.fanOut ?? null,
    cycles: entry.dependencyGraph?.cycleCount ?? null, directionViolations: entry.dependencyGraph?.directionViolationCount ?? null,
    unresolvedImports: entry.uncertainty.unresolvedImports,
    ...(entry.uncertainty.ambiguousOwnership ? { ambiguousOwnership: true } : {}),
  };
}

/**
 * Evidence only: it never records, decides, schedules or executes anything.
 * The Bot reads this result and decides whether to schedule work or ask the user.
 */
export function observeRefactorRecommendations(repoRoot: string, options: RefactorRecommendationOptions = {}): RefactorRecommendationResult {
  try {
    return discoverRefactorRecommendations(repoRoot, options);
  } catch (error) {
    if (error instanceof RefactorProviderError) {
      return {
        ...result('unavailable', error.message),
        code: error.code,
        ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}),
        ...(error.action ? { action: error.action } : {}),
      };
    }
    return result('unavailable', error instanceof Error ? error.message : String(error));
  }
}

function discoverRefactorRecommendations(repoRoot: string, options: RefactorRecommendationOptions): RefactorRecommendationResult {
  const scope = options.scope === undefined
    ? undefined
    : options.scope.kind === 'node'
      ? normalizeRefactorScope({ node: options.scope.nodeId })
      : options.scope.kind === 'paths'
        ? normalizeRefactorScope({ paths: options.scope.paths })
        : { kind: 'repository' as const };
  const root = realpathSync(repoRoot);
  if (!existsSync(join(root, '.archcontext/manifest.yaml'))) return result('unavailable', 'repository architecture model is not initialized');
  const provider = { env: options.env };
  const scan = options.discover
    ? options.discover(root, provider, options.importNodeLimit, options.timeoutMs, scope)
    : runRefactorScan(root, provider, options.importNodeLimit, options.timeoutMs, scope);
  const { codeFacts: facts, repositorySummary } = scan.snapshot;
  if (facts.reasonCodes.includes('code-facts-import-limit')) {
    return result('proof_required', importLimitRemedy(facts));
  }
  if (facts.coverage !== 'complete' || facts.truncated) {
    return result('proof_required', 'code facts are incomplete; run `codegraph init` and scan again');
  }
  const candidates = refactorCandidates(scan);
  const multiplyOwned = repositorySummary.multiplyOwnedFileCount;
  const ambiguityNote = multiplyOwned > 0
    ? `${multiplyOwned} files have more than one owning capability; affected candidates mark ambiguousOwnership=true`
    : undefined;
  return {
    ...result(candidates.length ? 'recommended' : 'no_action', ambiguityNote),
    candidates,
    snapshotDigest: scan.snapshotDigest,
    ...(scan.assessment?.assessmentDigest ? { assessmentDigest: scan.assessment.assessmentDigest } : {}),
    ...(scan.worktree?.worktreeDigest ? { worktreeDigest: scan.worktree.worktreeDigest } : {}),
    ...(multiplyOwned > 0 ? { multiplyOwnedFileCount: multiplyOwned } : {}),
  };
}

/** A new CodeGraph index cannot fix this: only a larger read limit can. `rh arch refactor decide` needs the same limit as the scan. */
function importLimitRemedy(facts: RefactorScanResultV1['snapshot']['codeFacts']): string {
  const counted = typeof facts.importNodeCount === 'number' ? `${facts.importNodeCount} import nodes` : 'more import nodes';
  return `the index holds ${counted}, more than the scan import node limit of ${facts.edgeLimit ?? 'unknown'}; run \`rh arch refactor recommendations --import-node-limit <n>\` with a larger limit, and pass the same limit to \`rh arch refactor decide\``;
}
