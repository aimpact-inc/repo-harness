import { autopilotTriageWriterLimit, type AutopilotStateV1 } from './autopilot';
import { ISSUE_FLOW_WORKER_LIMIT } from './desk';
import { GITHUB_REPOSITORY } from './github-repository';
import { decodePlanBlock, decodePlanBlockValue, PLAN_BLOCK_KIND, PLAN_BLOCK_PROTOCOL, renderPlanComment, type PlanBlockV3, type PlanOrderEntryV3 } from './plan-block';
import { BoardPostFieldsError, checkPlanSupersedes, checkPostBody, decodePostFields, renderPostBody, type BoardPostFieldsV1 } from './post';
import type { BoardTier } from './review-rules';
import { ROUTING_CLASSES, type RoutingClass } from './seats-settings';
import { commentId, type BoardCommentPageV1 } from './source';

export const TRIAGE_MANIFEST_SCHEMA_VERSION = 'repo-harness.triage-manifest/v1' as const;
export const DEFAULT_MAX_PARALLEL_WRITERS = 3;

const MODULE_VALUE = /^[a-z0-9][a-z0-9._/-]{0,63}$/u;
const PATTERN_VALUE = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const REFACTOR_ID_VALUE = /^recommendation\.[a-f0-9]{16}$/u;
const TIERS: readonly BoardTier[] = ['low', 'medium', 'high'];

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function fail(message: string): never {
  throw new TriageApplyValidationError(message);
}

function positiveInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be a positive integer`);
  return value as number;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  return value.trim();
}

function normalizePath(raw: string, label: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') fail(`${label} must be a non-empty path`);
  return raw.trim().replace(/^\.\//u, '').replace(/\/+$/u, '');
}

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'repository',
  'parent',
  'coordinator',
  'baseline',
  'supersedes',
  'issues',
  'duplicates',
  'merge_order',
  'max_parallel_writers',
]);

const ISSUE_KEYS = new Set(['number', 'module', 'tier', 'route', 'pattern', 'attach_to_parent', 'target_files', 'refactor_ids']);
const DUPLICATE_KEYS = new Set(['number', 'canonical', 'reason']);

function decodeIssue(raw: unknown, index: number): TriageManifestIssue {
  if (!isRecord(raw)) fail(`issues[${index}] must be an object`);
  for (const key of Object.keys(raw)) {
    if (!ISSUE_KEYS.has(key)) fail(`issues[${index}].${key} is not a supported field`);
  }
  const number = positiveInt(raw.number, `issues[${index}].number`);
  const module = nonEmptyString(raw.module, `issues[${index}].module`);
  if (!MODULE_VALUE.test(module)) fail(`issues[${index}].module ${JSON.stringify(module)} is invalid`);
  const tier = nonEmptyString(raw.tier, `issues[${index}].tier`) as BoardTier;
  if (!TIERS.includes(tier)) fail(`issues[${index}].tier must be one of ${TIERS.join(', ')}`);
  const route = nonEmptyString(raw.route, `issues[${index}].route`) as RoutingClass;
  if (!ROUTING_CLASSES.includes(route)) fail(`issues[${index}].route must be one of ${ROUTING_CLASSES.join(', ')}`);
  let pattern: string | null | undefined = undefined;
  if (raw.pattern !== undefined && raw.pattern !== null) {
    const p = nonEmptyString(raw.pattern, `issues[${index}].pattern`);
    if (!PATTERN_VALUE.test(p)) fail(`issues[${index}].pattern ${JSON.stringify(p)} is invalid`);
    pattern = p;
  } else if (raw.pattern === null) {
    pattern = null;
  }
  if (raw.attach_to_parent !== undefined && typeof raw.attach_to_parent !== 'boolean') {
    fail(`issues[${index}].attach_to_parent must be a boolean`);
  }
  let targetFiles: string[] | undefined = undefined;
  if (raw.target_files !== undefined) {
    if (!Array.isArray(raw.target_files)) fail(`issues[${index}].target_files must be an array`);
    targetFiles = [...new Set(raw.target_files.map((entry, pos) => normalizePath(entry as string, `issues[${index}].target_files[${pos}]`)))].sort();
  }
  let refactorIds: string[] | undefined = undefined;
  if (raw.refactor_ids !== undefined) {
    if (!Array.isArray(raw.refactor_ids)) fail(`issues[${index}].refactor_ids must be an array`);
    refactorIds = [...new Set(raw.refactor_ids.map((entry, pos) => {
      const id = nonEmptyString(entry, `issues[${index}].refactor_ids[${pos}]`);
      if (!REFACTOR_ID_VALUE.test(id)) fail(`issues[${index}].refactor_ids[${pos}] ${JSON.stringify(id)} must match recommendation.<16-hex>`);
      return id;
    }))].sort();
  }
  return {
    number,
    module,
    tier,
    route,
    ...(pattern === undefined ? {} : { pattern }),
    ...(raw.attach_to_parent === undefined ? {} : { attach_to_parent: raw.attach_to_parent }),
    ...(targetFiles === undefined ? {} : { target_files: targetFiles }),
    ...(refactorIds === undefined ? {} : { refactor_ids: refactorIds }),
  };
}

function decodeDuplicate(raw: unknown, index: number): TriageManifestDuplicate {
  if (!isRecord(raw)) fail(`duplicates[${index}] must be an object`);
  for (const key of Object.keys(raw)) {
    if (!DUPLICATE_KEYS.has(key)) fail(`duplicates[${index}].${key} is not a supported field`);
  }
  const number = positiveInt(raw.number, `duplicates[${index}].number`);
  const canonical = positiveInt(raw.canonical, `duplicates[${index}].canonical`);
  if (number === canonical) fail(`duplicates[${index}] cannot mark #${number} as a duplicate of itself`);
  const reason = nonEmptyString(raw.reason, `duplicates[${index}].reason`);
  if (/[\r\n]/u.test(reason)) fail(`duplicates[${index}].reason must be one line`);
  return { number, canonical, reason };
}

export function decodeTriageManifest(value: unknown): TriageManifestV1 {
  if (!isRecord(value)) fail('manifest must be a JSON object');
  for (const key of Object.keys(value)) {
    if (!MANIFEST_KEYS.has(key)) fail(`manifest.${key} is not a supported field`);
  }
  if (value.schemaVersion !== TRIAGE_MANIFEST_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${JSON.stringify(value.schemaVersion)}; expected ${TRIAGE_MANIFEST_SCHEMA_VERSION}`);
  }
  const repository = nonEmptyString(value.repository, 'repository');
  if (!GITHUB_REPOSITORY.test(repository)) fail(`repository ${JSON.stringify(repository)} must be owner/name`);
  const parent = positiveInt(value.parent, 'parent');
  const coordinator = nonEmptyString(value.coordinator, 'coordinator');
  if (commentId(coordinator) === null) fail('coordinator must be a GitHub comment URL');
  const baseline = nonEmptyString(value.baseline, 'baseline');
  if (!/^\S+@[0-9a-f]{7,40}$/u.test(baseline)) fail('baseline must be <branch>@<sha>');
  let supersedes: string | null | undefined = undefined;
  if (value.supersedes !== undefined && value.supersedes !== null) {
    const sup = nonEmptyString(value.supersedes, 'supersedes');
    if (commentId(sup) === null) fail('supersedes must be a GitHub comment URL');
    supersedes = sup;
  } else if (value.supersedes === null) {
    supersedes = null;
  }
  if (!Array.isArray(value.issues)) fail('issues must be an array');
  const issues = value.issues.map(decodeIssue);
  if (new Set(issues.map(issue => issue.number)).size !== issues.length) fail('issues repeats an issue number');
  if (issues.some(issue => issue.number === parent)) fail(`issues cannot contain parent #${parent}`);

  let duplicates: TriageManifestDuplicate[] | undefined = undefined;
  if (value.duplicates !== undefined) {
    if (!Array.isArray(value.duplicates)) fail('duplicates must be an array');
    duplicates = value.duplicates.map(decodeDuplicate);
    if (new Set(duplicates.map(dup => dup.number)).size !== duplicates.length) fail('duplicates repeats an issue number');
    if (duplicates.some(dup => dup.number === parent)) fail(`duplicates cannot close parent #${parent}`);
  }

  let maxParallel = DEFAULT_MAX_PARALLEL_WRITERS;
  if (value.max_parallel_writers !== undefined) {
    maxParallel = positiveInt(value.max_parallel_writers, 'max_parallel_writers');
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

  // Validate the three ADR-0006 §6 split red lines before planning any mutation.
  const units = planBlock.merge_order.map(entry => (typeof entry === 'number' ? [entry] : [...entry]));
  for (const unit of units) {
    if (unit.length < 2) continue;
    const members = unit.map(num => issueByNumber.get(num)!);
    // Red line (a): tier:high never mixes with low/medium and <= 2 issues.
    const hasHigh = members.some(m => m.tier === 'high');
    const hasLower = members.some(m => m.tier !== 'high');
    if (hasHigh && hasLower) {
      fail(`red line violation (tier): bundle [${unit.join(', ')}] mixes tier:high with lower tiers`);
    }
    if (hasHigh && unit.length > 2) {
      fail(`red line violation (tier): tier:high bundle [${unit.join(', ')}] has ${unit.length} issues (max 2)`);
    }
    // Red line (b): route:frontend never mixes with non-frontend routes.
    const hasFrontend = members.some(m => m.route === 'frontend');
    const hasBackend = members.some(m => m.route !== 'frontend');
    if (hasFrontend && hasBackend) {
      fail(`red line violation (route): bundle [${unit.join(', ')}] mixes route:frontend with non-frontend routes`);
    }
  }

  // Red line (c): distinct units that have no dependency ordering edge must not share a target_files entry or refactor_ids entry.
  const unitFiles = units.map(unit => new Set(unit.flatMap(num => issueByNumber.get(num)!.target_files ?? [])));
  const unitRefactors = units.map(unit => new Set(unit.flatMap(num => issueByNumber.get(num)!.refactor_ids ?? [])));
  for (let i = 0; i < units.length; i += 1) {
    const leftFiles = unitFiles[i]!;
    const leftRefactors = unitRefactors[i]!;
    for (let j = i + 1; j < units.length; j += 1) {
      if (leftFiles.size > 0) {
        const rightFiles = unitFiles[j]!;
        const overlap = [...leftFiles].filter(file => rightFiles.has(file)).sort();
        if (overlap.length > 0) {
          fail(`red line violation (target_files): units [${units[i]!.join(', ')}] and [${units[j]!.join(', ')}] share target file ${overlap[0]} with no dependency edge`);
        }
      }
      if (leftRefactors.size > 0) {
        const rightRefactors = unitRefactors[j]!;
        const overlapRefactor = [...leftRefactors].filter(id => rightRefactors.has(id)).sort();
        if (overlapRefactor.length > 0) {
          fail(`red line violation (refactor_ids): units [${units[i]!.join(', ')}] and [${units[j]!.join(', ')}] share refactor decision ${overlapRefactor[0]} with no dependency edge`);
        }
      }
    }
  }

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
