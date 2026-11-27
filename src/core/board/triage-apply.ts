import { autopilotTriageWriterLimit, type AutopilotStateV1 } from './autopilot';
import { ISSUE_FLOW_WORKER_LIMIT } from './desk';
import { GITHUB_REPOSITORY } from './github-repository';
import { decodePlanBlock, decodePlanBlockValue, PLAN_BLOCK_KIND, PLAN_BLOCK_PROTOCOL, renderPlanComment, type PlanBlockV3, type PlanOrderEntryV3 } from './plan-block';
import { BoardPostFieldsError, checkPlanSupersedes, checkPostBody, decodePostFields, type BoardPostFieldsV1 } from './post';
import type { BoardTier } from './review-rules';
import type { RoutingClass } from './seats-settings';
import { commentId, type BoardCommentPageV1 } from './source';
import {
  decodeDuplicate,
  decodeIssue,
  isTriageRecord,
  MANIFEST_KEYS,
  nonEmptyString,
  positiveInt,
  validateTriageSplitRedLines,
} from './triage-manifest-validation';

export const TRIAGE_MANIFEST_SCHEMA_VERSION = 'repo-harness.triage-manifest/v1' as const;
export const DEFAULT_MAX_PARALLEL_WRITERS = 3;

export interface TriageManifestIssue {
  readonly number: number;
  readonly module: string;
  readonly tier: BoardTier;
  readonly route: RoutingClass;
  readonly pattern?: string | null;
  readonly attach_to_parent?: boolean;
  readonly target_files?: readonly string[];
  readonly refactor_ids?: readonly string[];
}

export interface TriageManifestDuplicate {
  readonly number: number;
  readonly canonical: number;
  readonly reason: string;
}

export interface TriageManifestV1 {
  readonly schemaVersion: typeof TRIAGE_MANIFEST_SCHEMA_VERSION;
  readonly repository: string;
  readonly parent: number;
  readonly coordinator: string;
  readonly baseline: string;
  readonly supersedes?: string | null;
  readonly issues: readonly TriageManifestIssue[];
  readonly duplicates?: readonly TriageManifestDuplicate[];
  readonly merge_order: readonly PlanOrderEntryV3[];
  readonly max_parallel_writers?: number;
}

export const TRIAGE_LABEL_PREFIXES = ['module:', 'tier:', 'route:', 'pattern:'] as const;

export type TriageOperation =
  | { readonly kind: 'set_labels'; readonly issue: number; readonly labels: readonly string[] }
  | { readonly kind: 'add_sub_issue'; readonly parent: number; readonly issue: number }
  | { readonly kind: 'bind_refactor'; readonly issue: number; readonly refactor_ids: readonly string[]; readonly comment: string }
  | { readonly kind: 'close_duplicate'; readonly issue: number; readonly canonical: number; readonly reason: string; readonly comment: string }
  | { readonly kind: 'post_plan'; readonly parent: number; readonly body: string; readonly supersedes: string | null };

export function computeLabelDelta(
  existingLabels: readonly string[],
  desiredLabels: readonly string[],
): { readonly add: readonly string[]; readonly remove: readonly string[] } {
  const existing = new Set(existingLabels);
  const desired = new Set(desiredLabels);
  const add = desiredLabels.filter(label => !existing.has(label));
  const remove = [...existing]
    .filter(label => TRIAGE_LABEL_PREFIXES.some(prefix => label.startsWith(prefix)) && !desired.has(label))
    .sort();
  return { add, remove };
}

export interface TriageApplyPlanV1 {
  readonly manifest: TriageManifestV1;
  readonly operations: readonly TriageOperation[];
  readonly rendered_plan: string;
  readonly post_fields: Extract<BoardPostFieldsV1, { readonly kind: 'plan' }>['fields'];
}

export class TriageApplyValidationError extends Error {
  readonly code = 'triage_apply_validation_failed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TriageApplyValidationError';
  }
}

function fail(message: string): never {
  throw new TriageApplyValidationError(message);
}

export function decodeTriageManifest(value: unknown): TriageManifestV1 {
  if (!isTriageRecord(value)) fail('manifest must be a JSON object');
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) fail(`manifest.${key} is not a supported field`);
  }
  if (value.schemaVersion !== TRIAGE_MANIFEST_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}; expected ${TRIAGE_MANIFEST_SCHEMA_VERSION}`);
  }
  const repository = nonEmptyString(value.repository, 'repository', fail);
  if (!GITHUB_REPOSITORY.test(repository)) fail(`repository ${JSON.stringify(repository)} must be owner/name`);
  const parent = positiveInt(value.parent, 'parent', fail);
  const coordinator = nonEmptyString(value.coordinator, 'coordinator', fail);
  if (commentId(coordinator) === null) fail('coordinator must be a GitHub comment URL');
  const baseline = nonEmptyString(value.baseline, 'baseline', fail);
  if (!/^\S+@[0-9a-f]{7,40}$/u.test(baseline)) fail('baseline must be <branch>@<sha>');
  let supersedes: string | null | undefined = undefined;
  if (value.supersedes !== undefined && value.supersedes !== null) {
    const sup = nonEmptyString(value.supersedes, 'supersedes', fail);
    if (commentId(sup) === null) fail('supersedes must be a GitHub comment URL');
    supersedes = sup;
  } else if (value.supersedes === null) {
    supersedes = null;
  }
  if (!Array.isArray(value.issues)) fail('issues must be an array');
  const issues = value.issues.map((raw, index) => decodeIssue(raw, index, fail));
  if (new Set(issues.map(issue => issue.number)).size !== issues.length) fail('issues repeats an issue number');
  if (issues.some(issue => issue.number === parent)) fail(`issues cannot contain parent #${parent}`);

  let duplicates: TriageManifestDuplicate[] | undefined = undefined;
  if (value.duplicates !== undefined) {
    if (!Array.isArray(value.duplicates)) fail('duplicates must be an array');
    duplicates = value.duplicates.map((raw, index) => decodeDuplicate(raw, index, fail));
    if (new Set(duplicates.map(dup => dup.number)).size !== duplicates.length) fail('duplicates repeats an issue number');
    if (duplicates.some(dup => dup.number === parent)) fail(`duplicates cannot close parent #${parent}`);
  }

  let maxParallel = DEFAULT_MAX_PARALLEL_WRITERS;
  if (value.max_parallel_writers !== undefined) {
    maxParallel = positiveInt(value.max_parallel_writers, 'max_parallel_writers', fail);
    if (maxParallel > ISSUE_FLOW_WORKER_LIMIT) {
      fail(`max_parallel_writers cannot exceed ISSUE_FLOW_WORKER_LIMIT (${ISSUE_FLOW_WORKER_LIMIT})`);
    }
  }

  let planBlock: PlanBlockV3;
  try {
    planBlock = decodePlanBlockValue({
      protocol: PLAN_BLOCK_PROTOCOL,
      kind: PLAN_BLOCK_KIND,
      merge_order: value.merge_order,
      holds: [],
      seat_limits: { worker: maxParallel },
    });
  } catch (error) {
    fail((error as Error).message);
  }
  if (planBlock.merge_order.flat().some(num => num === parent)) {
    fail(`merge_order cannot contain parent #${parent}`);
  }

  const issueByNumber = new Map(issues.map(issue => [issue.number, issue] as const));
  const duplicateSet = new Set((duplicates ?? []).map(dup => dup.number));
  for (const dup of duplicates ?? []) {
    if (issueByNumber.has(dup.number)) fail(`duplicate issue #${dup.number} also appears in issues`);
  }
  for (const num of planBlock.merge_order.flat()) {
    if (duplicateSet.has(num)) fail(`duplicate issue #${num} cannot appear in merge_order`);
    if (!issueByNumber.has(num)) fail(`merge_order issue #${num} is missing from manifest.issues`);
  }

  const units = planBlock.merge_order.map(entry => (typeof entry === 'number' ? [entry] : [...entry]));
  validateTriageSplitRedLines(units, issueByNumber, fail);

  return {
    schemaVersion: TRIAGE_MANIFEST_SCHEMA_VERSION,
    repository,
    parent,
    coordinator,
    baseline,
    ...(supersedes === undefined ? {} : { supersedes }),
    issues,
    ...(duplicates === undefined ? {} : { duplicates }),
    merge_order: planBlock.merge_order,
    ...(value.max_parallel_writers === undefined ? {} : { max_parallel_writers: maxParallel }),
  };
}

export function issueLabelsForTriage(issue: TriageManifestIssue): string[] {
  return [
    `module:${issue.module}`,
    `tier:${issue.tier}`,
    `route:${issue.route}`,
    ...(issue.pattern ? [`pattern:${issue.pattern}`] : []),
  ];
}

export function planTriageApply(
  rawManifest: unknown,
  options: { readonly thread?: BoardCommentPageV1; readonly autopilot?: AutopilotStateV1 | null } = {},
): TriageApplyPlanV1 {
  const manifest = decodeTriageManifest(rawManifest);
  const workerLimit = manifest.max_parallel_writers
    ?? autopilotTriageWriterLimit(manifest.merge_order.length, DEFAULT_MAX_PARALLEL_WRITERS, options.autopilot);
  const block: PlanBlockV3 = {
    protocol: PLAN_BLOCK_PROTOCOL,
    kind: PLAN_BLOCK_KIND,
    merge_order: manifest.merge_order,
    holds: [],
    seat_limits: { worker: workerLimit },
  };
  let post: Extract<BoardPostFieldsV1, { readonly kind: 'plan' }>;
  try {
    const decoded = decodePostFields('plan', {
      coordinator: manifest.coordinator,
      baseline: manifest.baseline,
      supersedes: manifest.supersedes ?? null,
      block,
    });
    if (decoded.kind !== 'plan') throw new Error('expected plan post kind');
    post = decoded;
    if (options.thread !== undefined) checkPlanSupersedes(post.fields, options.thread);
  } catch (error) {
    if (error instanceof BoardPostFieldsError || error instanceof Error) {
      fail(error.message);
    }
    throw error;
  }

  const rendered = renderPlanComment(post.fields);
  try {
    checkPostBody(post, rendered);
    const decodedRoundtrip = decodePlanBlock(rendered);
    if (JSON.stringify(decodedRoundtrip) !== JSON.stringify(block)) {
      fail('rendered plan block failed roundtrip check');
    }
  } catch (error) {
    fail((error as Error).message);
  }

  const operations: TriageOperation[] = [];
  for (const issue of manifest.issues) {
    operations.push({
      kind: 'set_labels',
      issue: issue.number,
      labels: issueLabelsForTriage(issue),
    });
    if (issue.attach_to_parent !== false) {
      operations.push({
        kind: 'add_sub_issue',
        parent: manifest.parent,
        issue: issue.number,
      });
    }
    if (issue.refactor_ids && issue.refactor_ids.length > 0) {
      operations.push({
        kind: 'bind_refactor',
        issue: issue.number,
        refactor_ids: issue.refactor_ids,
        comment: `repo-harness refactor binding\nRefactor IDs: ${issue.refactor_ids.join(', ')}`,
      });
    }
  }
  for (const dup of manifest.duplicates ?? []) {
    operations.push({
      kind: 'close_duplicate',
      issue: dup.number,
      canonical: dup.canonical,
      reason: dup.reason,
      comment: `Duplicate of #${dup.canonical}. ${dup.reason}`,
    });
  }
  operations.push({
    kind: 'post_plan',
    parent: manifest.parent,
    body: rendered,
    supersedes: post.fields.supersedes,
  });

  return {
    manifest,
    operations,
    rendered_plan: rendered,
    post_fields: post.fields,
  };
}
