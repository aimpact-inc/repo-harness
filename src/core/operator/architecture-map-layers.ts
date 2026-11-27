// The contract of the architecture map overlay layers (PRD G11, G22): changes
// and impact, violations, decisions, tests, and pull requests, with their
// reason codes and pure projections from archctx answers. The strict decoder
// and map projection stay in `architecture-map.ts`; this module never imports it.

import { REF_IMPACT_BATCH_UNAVAILABLE_REASONS, type RefImpactV1 } from 'archctx-contracts';
import { PULL_REQUEST_FILES_REASONS } from './pull-request-files';
import { TESTS_UNAVAILABLE_REASONS } from './tests';
import type { ArchitectureFlowProofsV1 } from './architecture-map-flows';
import {
  ARCHITECTURE_MAP_DEPENDENCY_REASONS,
  type ArchctxRefusalV1,
  type ArchitectureMapImportV1,
  type Section,
} from './architecture-map-model';

/**
 * Changed paths, owners, dependents and the model delta read only commits and
 * need no clean checkout. `flow_steps` uses the worktree CodeGraph index;
 * archctx reports unknown when its facts are missing or do not match the commit.
 * A first-parent history that starts after midnight has no base commit;
 * `archctx_failed`: archctx did not run, or its answer broke its contract or the map's grammar;
 * `path_not_public`: archctx's answer is valid, but a path in it fails the public-path guard.
 */
export const ARCHITECTURE_CHANGE_REASONS = ['git_read_failed', 'history_starts_today', 'archctx_failed', 'path_not_public'] as const;
export type ArchitectureChangeReason = typeof ARCHITECTURE_CHANGE_REASONS[number];
/** Each violation check reads the worktree model and the CodeGraph index, as import counts do. */
export const ARCHITECTURE_VIOLATION_REASONS = [...ARCHITECTURE_MAP_DEPENDENCY_REASONS, 'archctx_failed'] as const;
export type ArchitectureViolationReason = typeof ARCHITECTURE_VIOLATION_REASONS[number];
/** The tests collector's own reasons, a projection gap, or a projection that names a capability the map does not have. */
export const ARCHITECTURE_TEST_REASONS = [...TESTS_UNAVAILABLE_REASONS, 'projection_missing', 'projection_invalid', 'tests_model_mismatch'] as const;
export type ArchitectureTestReason = typeof ARCHITECTURE_TEST_REASONS[number];
/**
 * The Dev Activity cache has not collected yet, or has no complete GitHub read
 * for the repository. `archctx impact --batch-file` reads the worktree model,
 * so the model must be clean at the map commit.
 */
export const ARCHITECTURE_PR_LAYER_REASONS = ['model_worktree_dirty', 'checkout_changed', 'git_read_failed', 'dev_activity_pending', 'dev_activity_unavailable'] as const;
export type ArchitecturePullRequestsReason = typeof ARCHITECTURE_PR_LAYER_REASONS[number];
/** One open PR without impact: gh gave no head commit or no complete file list, archctx returned a batch unavailable reason or failed, or a path in its valid answer fails the public-path guard. */
export const ARCHITECTURE_PR_REASONS = ['head_missing', ...PULL_REQUEST_FILES_REASONS, 'archctx_failed', ...REF_IMPACT_BATCH_UNAVAILABLE_REASONS, 'path_not_public'] as const;
export type ArchitecturePullRequestReason = typeof ARCHITECTURE_PR_REASONS[number];
/**
 * Why imports against the layer order are not shown: a violation check reason;
 * the model declares no ordered `model.layers`; the committed model has no
 * `layer-direction` constraint; or archctx found an import endpoint that no
 * layered node owns, so its answer is undetermined.
 */
export const ARCHITECTURE_LAYER_DIRECTION_REASONS = [
  ...ARCHITECTURE_VIOLATION_REASONS, 'model_layers_undeclared', 'layer_direction_undeclared', 'layer_endpoint_unclassified',
] as const;
export type ArchitectureLayerDirectionReason = typeof ARCHITECTURE_LAYER_DIRECTION_REASONS[number];
/**
 * The archctx reads behind each violation part, as the map collector runs them.
 * The console shows the same arguments as the command that lists a finding;
 * archctx's answer names its own remedy.
 */
export const ARCHITECTURE_VIOLATION_READS = {
  debt: ['debt', '--json'],
  flows: ['flows', 'check', '--no-sync', '--json'],
  anchors: ['docs', 'anchors', '--json'],
  dependencies: ['deps', '--json'],
  layer_direction: ['constraints', 'check', '--json'],
} as const satisfies Record<keyof ArchitectureViolationsLayerV1, readonly string[]>;

/** The shell command for one violation part's read. */
export function architectureViolationCommand(part: keyof ArchitectureViolationsLayerV1): string {
  return ['rh', 'arch', ...ARCHITECTURE_VIOLATION_READS[part]].join(' ');
}

/** The debt kinds that `archctx debt` reports itself; it defers dependency, flow and practice checks. A stale anchor or a machine rule may name no path. */
export const ARCHITECTURE_DEBT_KINDS = ['unowned-path', 'ambiguous-owner', 'stale-anchor', 'state-machine-rule', 'state-machine-stale'] as const;
export type ArchitectureDebtKind = typeof ARCHITECTURE_DEBT_KINDS[number];

/** File imports from `source` into `target` that `archctx constraints check` reports against the layer order: `target_layer` is above `source_layer`. */
export interface ArchitectureLayerViolationV1 {
  readonly source: string;
  readonly target: string;
  readonly source_layer: string;
  readonly target_layer: string;
  readonly imports: number;
}

/** One changed path from `archctx impact`. Its reason codes say why a line count is null or an owner is contested. */
export interface ArchitectureImpactPathV1 {
  readonly path: string;
  readonly added: number | null;
  readonly deleted: number | null;
  /** The owning nodes at the base and the head; more than one when the owner moved or is contested, none when unowned. */
  readonly owners: readonly string[];
  readonly reason_codes: readonly string[];
}
/** A flow step that the change reaches, with archctx's reason codes for it. */
export interface ArchitectureFlowStepV1 { readonly flow: string; readonly step: string; readonly outcome: string | null; readonly reason_codes: readonly string[] }
/** Parts of the answer that archctx cut at its own limits; a cut part is a lower bound. */
export interface ArchitectureImpactTruncationV1 {
  readonly paths: boolean;
  readonly nodes: boolean;
  readonly relations: boolean;
  readonly flow_steps: boolean;
  readonly dependents: boolean;
  readonly model: boolean;
}
/** One `archctx impact` answer as the map carries it. */
export interface ArchitectureImpactV1 {
  readonly paths: readonly ArchitectureImpactPathV1[];
  readonly unowned_paths: readonly string[];
  /** Each owner of a changed path and its changed path count. */
  readonly nodes: readonly { readonly id: string; readonly files: number }[];
  /** Nodes that reach a changed node through `calls` or `depends-on` relations of the head model, with the relations of one shortest path. */
  readonly dependents: readonly { readonly id: string; readonly touched: string; readonly relations: readonly string[] }[];
  readonly dependency_coverage: 'complete' | 'partial';
  /** `unknown` with archctx's reason codes when its code facts cannot tie a flow step to the change. */
  readonly flow_steps: { readonly status: 'known' | 'unknown'; readonly reason_codes: readonly string[]; readonly items: readonly ArchitectureFlowStepV1[] | null };
  readonly truncated: ArchitectureImpactTruncationV1;
}
/** One model entity whose committed record differs between the base and the map commit, with the fields that differ. */
export interface ArchitectureModelChangeV1 {
  readonly kind: 'nodes' | 'relations' | 'flows';
  readonly id: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly fields: readonly string[];
}
export type ArchitectureChangesLayerV1 = Section<{
  /** Local midnight of the collector host, as an instant. */
  readonly since: string;
  /** The newest first-parent commit before `since`; archctx compares it with the map commit. */
  readonly base: string;
  /** The first-parent commits after `base`, newest first, with the owners that `paths` gives to the paths each commit changed. */
  readonly commits: readonly ArchitectureChangeCommitV1[];
  readonly model: readonly ArchitectureModelChangeV1[];
} & ArchitectureImpactV1, ArchitectureChangeReason> | ArchctxRefusalV1;

/**
 * One commit of today's window. `nodes` joins the commit's changed paths with
 * the layer's `paths`: a path that changed back inside the window is not in
 * `paths`, and a cut `paths` makes `nodes` a lower bound.
 */
export interface ArchitectureChangeCommitV1 { readonly sha: string; readonly subject: string; readonly nodes: readonly string[] }

/** The map's form of an `archctx impact` answer. Field names change; no value is derived. */
export function architectureImpact(report: RefImpactV1): ArchitectureImpactV1 {
  const { touchedFlowSteps: steps, truncated } = report;
  return {
    paths: report.changedPaths.map(entry => ({ path: entry.path, added: entry.added, deleted: entry.deleted, owners: entry.owners, reason_codes: entry.reasonCodes })),
    unowned_paths: report.unownedPaths,
    nodes: report.touchedNodes.map(entry => ({ id: entry.nodeId, files: entry.pathCount })),
    dependents: report.dependents.map(entry => ({ id: entry.nodeId, touched: entry.touchedNodeId, relations: entry.relationIds })),
    dependency_coverage: report.dependencyCoverage.status,
    flow_steps: {
      status: steps.status, reason_codes: steps.reasonCodes,
      items: steps.items === null ? null : steps.items.map(item => ({ flow: item.flowId, step: item.stepId, outcome: item.outcomeId, reason_codes: item.reasonCodes })),
    },
    truncated: {
      paths: truncated.changedPaths, nodes: truncated.touchedNodes, relations: truncated.relations,
      flow_steps: truncated.flowSteps, dependents: truncated.dependents, model: truncated.modelDelta,
    },
  };
}

export interface ArchitectureDebtItemV1 {
  readonly kind: ArchitectureDebtKind;
  readonly nodes: readonly string[];
  readonly paths: readonly string[];
  readonly severity?: string;
  readonly message?: string;
  readonly action?: string;
}

/**
 * One stale citation from `archctx docs anchors`. `path` and `line` come from a
 * document origin; a path that the public-path guard refuses is null.
 */
export interface ArchitectureAnchorFindingV1 {
  /** archctx's finding kind, for example `line-moved`. */
  readonly kind: string;
  readonly origin: 'document' | 'node-summary' | 'node-responsibility';
  readonly path: string | null;
  readonly line: number | null;
  /** The citation text, masked like model prose. */
  readonly citation: string;
}
export interface ArchitectureViolationsLayerV1 {
  /** `archctx debt`: unowned and contested paths, stale model anchors. */
  readonly debt: Section<{ readonly items: readonly ArchitectureDebtItemV1[] }, ArchitectureViolationReason>;
  /** Flow proofs from the existing CodeGraph index; the check writes no index. */
  readonly flows: Section<ArchitectureFlowProofsV1, ArchitectureViolationReason> | ArchctxRefusalV1;
  /** `archctx docs anchors`: citations in human-written module docs that no longer match the code. */
  readonly anchors: Section<{ readonly citations: number; readonly nodes: readonly { readonly id: string; readonly findings: readonly ArchitectureAnchorFindingV1[] }[] }, ArchitectureViolationReason>;
  /** `archctx deps` rows that archctx marks undeclared: imports with no model relation behind them. */
  readonly dependencies: Section<{ readonly edges: readonly ArchitectureMapImportV1[] }, ArchitectureViolationReason>;
  /** `archctx constraints check` for the committed `layer-direction` constraints: the import edges it read, and the node pairs that import against the layer order. */
  readonly layer_direction: Section<{ readonly imports: number; readonly edges: readonly ArchitectureLayerViolationV1[] }, ArchitectureLayerDirectionReason> | ArchctxRefusalV1;
}

/** One architecture decision record from `archctx export native`; free text is masked like model prose. */
export interface ArchitectureDecisionV1 {
  readonly id: string;
  readonly title: string;
  readonly status: string | null;
  readonly decided_at: string | null;
  /** Model nodes the decision applies to; archctx refuses an export that names an unknown node. */
  readonly applies_to: readonly string[];
  readonly supersedes: readonly string[];
  readonly path: string;
}
/** The decisions come from the same export as the model, so they have no gap of their own. */
export interface ArchitectureDecisionsLayerV1 { readonly state: 'ok'; readonly items: readonly ArchitectureDecisionV1[] }

/** Test files of one capability by their result in the daily run. `no_result`: the run has no report for the file. */
export interface ArchitectureTestCoverageV1 {
  readonly id: string;
  readonly files: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly no_result: number;
}
export type ArchitectureTestsLayerV1 = Section<{
  readonly run: { readonly id: number; readonly head_sha: string; readonly created_at: string };
  readonly results: 'ok' | 'junit_missing' | 'junit_invalid';
  readonly capabilities: readonly ArchitectureTestCoverageV1[];
}, ArchitectureTestReason>;

/**
 * The `archctx impact --paths-from` answer for one open PR's changed files at
 * its head, with owners from the map commit's model. A path list has no line
 * counts and no model change.
 */
export interface ArchitecturePullRequestImpactV1 {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** The head commit gh reported; the files are the PR's diff at this head. */
  readonly head_sha: string | null;
  readonly impact: Section<ArchitectureImpactV1, ArchitecturePullRequestReason> | ArchctxRefusalV1;
}
export type ArchitecturePullRequestsLayerV1 = Section<{
  /** When the Dev Activity collector read the PRs from GitHub. */
  readonly observed_at: string;
  readonly pull_requests: readonly ArchitecturePullRequestImpactV1[];
}, ArchitecturePullRequestsReason>;

export interface ArchitectureMapLayersV1 {
  readonly changes: ArchitectureChangesLayerV1;
  readonly violations: ArchitectureViolationsLayerV1;
  readonly pull_requests: ArchitecturePullRequestsLayerV1;
  readonly tests: ArchitectureTestsLayerV1;
  readonly decisions: ArchitectureDecisionsLayerV1;
}
