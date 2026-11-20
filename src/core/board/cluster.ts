import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { capabilityIdentityFromNodeId } from '../capabilities/registry';
import { bundleRouteClass, CREDENTIALS_LABEL, ROUTE_LABEL_PREFIX } from './dispatch';
import { decodePlanBlockValue, PLAN_BLOCK_KIND, PLAN_BLOCK_PROTOCOL, type PlanOrderEntryV3 } from './plan-block';
import { tierOf } from './review-rules';
import { ROUTING_CLASSES, type RoutingClass } from './seats-settings';
import { BoardSourceError } from './source';

export const BOARD_CLUSTER_PROTOCOL = 1;
export const BOARD_CLUSTER_KIND = 'repo-harness.board-cluster';
export const DEFAULT_CLUSTER_MAX_SIZE = 5;
export const MODULE_LABEL_PREFIX = 'module:';
export const PATTERN_LABEL_PREFIX = 'pattern:';

export type OwnershipStatus = 'observed' | 'unavailable';
type TierBucket = 'standard' | 'high';
type Scope =
  | { readonly mode: 'open'; readonly parent: null }
  | { readonly mode: 'parent'; readonly parent: number; readonly include_loose?: boolean };

export interface ClusterPathOwner {
  readonly path: string;
  readonly status: 'owned' | 'unowned' | 'ambiguous';
  readonly capability?: string;
}

export interface ClusterIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  /** Open blocked-by edges. Closed blockers have already cleared. */
  readonly blocked_by: readonly number[];
  readonly in_flight: boolean;
  readonly body?: string;
  readonly target_files?: readonly string[];
}

export interface ClusterIssueMetadata {
  readonly issue: number;
  readonly target_files: readonly string[];
  readonly inferred_module: string | null;
  readonly cross_capability: readonly string[] | null;
}

interface ClassifiedIssue extends ClusterIssue {
  readonly module: string;
  readonly inferred_module: string | null;
  readonly cross_capability: readonly string[] | null;
  readonly resolved_target_files: readonly string[];
  readonly tier_bucket: TierBucket;
  readonly route: RoutingClass;
  readonly pattern: string | null;
}

interface UnclassifiedIssue {
  readonly issue: number;
  readonly title: string;
  readonly missing: readonly string[];
  readonly errors: readonly string[];
  readonly cross_capability?: readonly string[];
}

interface ModuleBundle {
  readonly module: string;
  readonly tier_bucket: TierBucket;
  readonly route_class: RoutingClass;
  readonly credentials: boolean;
  readonly issues: readonly number[];
  readonly external_blockers: readonly number[];
  readonly shared_files?: readonly string[];
}

interface Orphan {
  readonly issue: number;
  readonly external_blockers: readonly number[];
  readonly cross_capability?: readonly string[];
}

interface PatternGroup {
  readonly pattern: string;
  readonly issues: readonly number[];
  readonly modules: readonly string[];
  readonly tier_buckets: readonly TierBucket[];
}

export interface BoardClusterV1 {
  readonly protocol: typeof BOARD_CLUSTER_PROTOCOL;
  readonly kind: typeof BOARD_CLUSTER_KIND;
  readonly scope: Scope & { readonly max_size: number; readonly truncated: boolean };
  readonly ownership_status: OwnershipStatus;
  readonly in_flight: readonly number[];
  readonly unclassified: readonly UnclassifiedIssue[];
  readonly issue_metadata: readonly ClusterIssueMetadata[];
  readonly module_bundles: readonly ModuleBundle[];
  readonly orphans: readonly Orphan[];
  readonly cycles: readonly number[];
  readonly pattern_groups: readonly PatternGroup[];
  readonly suggested_merge_order: readonly PlanOrderEntryV3[];
}

const byNumber = (left: number, right: number): number => left - right;
const distinctNumbers = (values: readonly number[]): number[] => [...new Set(values)].sort(byNumber);

const REPO_PATH_PREFIXES = ['src/', 'scripts/', 'assets/', 'agents/'] as const;
const INLINE_PATH = /(?:^|[\s([{"'`])((?:\.\/)?(?:src|scripts|assets|agents)\/[A-Za-z0-9._/-]+(?:(?::\d+(?:(?:-\d+)|(?:,\d+))?)|(?:#L\d+(?:-L?\d+)?))?)/gu;

function normalizeCitedPath(raw: string): string | null {
  const stripped = raw.trim()
    .replace(/^\.\//u, '')
    .replace(/(?::\d+(?:-\d+|,\d+)*|#L\d+(?:-L?\d+)?)$/u, '')
    .replace(/[.,;:!?)'"`]+$/u, '')
    .replace(/\/+$/u, '');
  if (!REPO_PATH_PREFIXES.some(prefix => stripped.startsWith(prefix))) return null;
  if (stripped.includes('*') || stripped.includes('..') || stripped.includes('{') || stripped.includes('}') || stripped.includes('://')) return null;
  const parts = stripped.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some(part => part === '.' || part === '..')) return null;
  return parts.join('/');
}

/** Extracts normalized repo-relative paths (`src/`, `scripts/`, `assets/`, `agents/`) cited in an issue body. */
export function extractIssueTargetPaths(body: string): string[] {
  if (body.trim() === '') return [];
  const found = new Set<string>();
  const addCandidate = (value: string): void => {
    const normalized = normalizeCitedPath(value);
    if (normalized !== null) found.add(normalized);
  };
  const scanText = (text: string): void => {
    for (const match of text.matchAll(INLINE_PATH)) addCandidate(match[1]!);
  };
  let skipSection = false;
  let skipDepth = 0;
  const visit = (node: Nodes): void => {
    if (node.type === 'code' || node.type === 'blockquote') return;
    if (node.type === 'inlineCode') {
      if (!skipSection) addCandidate(node.value);
      return;
    }
    if (node.type === 'link') {
      if (!skipSection) addCandidate(node.url);
    }
    if (node.type === 'text') {
      if (!skipSection) scanText(node.value);
      return;
    }
    if ('children' in node) {
      for (const child of node.children) visit(child);
    }
  };
  const tree = fromMarkdown(body);
  for (const top of tree.children) {
    if (top.type === 'heading') {
      const heading = top.children
        .filter((child): child is { type: 'text' | 'inlineCode'; value: string } => 'value' in child && typeof child.value === 'string')
        .map(child => child.value)
        .join('')
        .trim()
        .toLowerCase();
      if (heading === 'out of scope' || heading === '不做' || heading === 'non-goals') {
        skipSection = true;
        skipDepth = top.depth;
      } else if (skipSection && top.depth <= skipDepth) {
        skipSection = false;
      }
    }
    visit(top);
  }
  return [...found].sort();
}

export function capabilityModuleId(capabilityId: string): string | null {
  const identity = capabilityIdentityFromNodeId(capabilityId);
  if (identity !== null) return `${identity.domain}/${identity.name}`;
  return /^[a-z0-9][a-z0-9._/-]{0,63}$/u.test(capabilityId) && capabilityId.includes('/') ? capabilityId : null;
}

function labelValue<T>(labels: readonly string[], prefix: string, parse: (label: string) => T | null): T | null {
  const matches = labels.filter(label => label.startsWith(prefix));
  if (matches.length > 1) throw new BoardSourceError(`an issue carries more than one ${prefix} label`);
  const [label] = matches;
  if (label === undefined) return null;
  const value = parse(label);
  if (value === null) throw new BoardSourceError(`invalid ${prefix} label ${JSON.stringify(label)}`);
  return value;
}

export function moduleOf(labels: readonly string[]): string | null {
  return labelValue(labels, MODULE_LABEL_PREFIX, label => {
    const value = label.slice(MODULE_LABEL_PREFIX.length);
    return /^[a-z0-9][a-z0-9._/-]{0,63}$/u.test(value) ? value : null;
  });
}

export function patternOf(labels: readonly string[]): string | null {
  return labelValue(labels, PATTERN_LABEL_PREFIX, label => {
    const value = label.slice(PATTERN_LABEL_PREFIX.length);
    return /^[a-z0-9]+(-[a-z0-9]+)*$/u.test(value) ? value : null;
  });
}

function issueTargetPaths(issue: ClusterIssue): string[] {
  const explicit = issue.target_files ?? [];
  const extracted = issue.body === undefined ? [] : extractIssueTargetPaths(issue.body);
  return [...new Set([...explicit, ...extracted].map(normalizeCitedPath).filter((path): path is string => path !== null))].sort();
}

function resolveIssueOwnership(
  paths: readonly string[],
  ownersByPath: ReadonlyMap<string, ClusterPathOwner> | null,
): { readonly capabilities: readonly string[] } {
  if (ownersByPath === null) return { capabilities: [] };
  const modules = new Set<string>();
  for (const path of paths) {
    const owner = ownersByPath.get(path);
    if (owner?.status !== 'owned' || owner.capability === undefined) continue;
    const moduleId = capabilityModuleId(owner.capability);
    if (moduleId !== null) modules.add(moduleId);
  }
  return { capabilities: [...modules].sort() };
}

function classify(
  issue: ClusterIssue,
  ownersByPath: ReadonlyMap<string, ClusterPathOwner> | null,
): { readonly result: ClassifiedIssue | UnclassifiedIssue; readonly metadata: ClusterIssueMetadata } {
  const { labels } = issue;
  const errors: string[] = [];
  const missing: string[] = [];
  function read<T>(name: string, parse: () => T | null, required = true): T | null {
    try {
      const value = parse();
      if (value === null && required) missing.push(name);
      return value;
    } catch (error) {
      if (!(error instanceof BoardSourceError)) throw error;
      errors.push(error.message);
      return null;
    }
  }
  const targetFiles = issueTargetPaths(issue);
  const ownership = resolveIssueOwnership(targetFiles, ownersByPath);
  const crossCapability = ownership.capabilities.length >= 2 ? ownership.capabilities : null;
  const declaredModule = read('module', () => moduleOf(labels), false);
  const inferredModule = declaredModule === null && ownership.capabilities.length === 1 ? ownership.capabilities[0]! : null;
  const module = declaredModule ?? inferredModule;
  if (module === null && !errors.some(message => message.includes(MODULE_LABEL_PREFIX))) {
    missing.push('module');
  }
  const tier = read('tier', () => labelValue(labels, 'tier:', label => tierOf([label])));
  const route = read('route', () => labelValue(labels, ROUTE_LABEL_PREFIX,
    label => ROUTING_CLASSES.find(kind => label === ROUTE_LABEL_PREFIX + kind) ?? null));
  const pattern = read('pattern', () => patternOf(labels), false);
  const metadata: ClusterIssueMetadata = {
    issue: issue.number,
    target_files: targetFiles,
    inferred_module: inferredModule,
    cross_capability: crossCapability,
  };
  if (module === null || tier === null || route === null || errors.length > 0) {
    return {
      result: {
        issue: issue.number,
        title: issue.title,
        missing,
        errors,
        ...(crossCapability === null ? {} : { cross_capability: crossCapability }),
      },
      metadata,
    };
  }
  return {
    result: {
      ...issue,
      module,
      inferred_module: inferredModule,
      cross_capability: crossCapability,
      resolved_target_files: targetFiles,
      tier_bucket: tier === 'high' ? 'high' : 'standard',
      route,
      pattern,
    },
    metadata,
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

/** Kahn order over the edges inside this graph. The smallest available key goes first. */
function dependencyOrder(graph: ReadonlyMap<number, readonly number[]>): { ordered: number[]; stalled: number[] } {
  const pending = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  const ready: number[] = [];
  for (const [item, blockers] of graph) {
    const local = new Set(blockers.filter(blocker => graph.has(blocker)));
    if (local.size === 0) ready.push(item);
    pending.set(item, local.size);
    for (const blocker of local) {
      const list = dependents.get(blocker);
      if (list === undefined) dependents.set(blocker, [item]);
      else list.push(item);
    }
  }
  const ordered: number[] = [];
  ready.sort(byNumber);
  while (ready.length > 0) {
    const item = ready.shift()!;
    ordered.push(item);
    for (const dependent of dependents.get(item) ?? []) {
      const count = pending.get(dependent)! - 1;
      pending.set(dependent, count);
      if (count === 0) {
        ready.push(dependent);
        ready.sort(byNumber);
      }
    }
  }
  return { ordered, stalled: [...pending.keys()].filter(item => pending.get(item)! > 0) };
}

function patternGroups(issues: readonly ClassifiedIssue[]): PatternGroup[] {
  const patterns = groupBy(issues.filter(issue => issue.pattern !== null), issue => issue.pattern!);
  return [...patterns.keys()].sort().flatMap(pattern => {
    const group = patterns.get(pattern)!;
    return group.length < 2 ? [] : [{
      pattern, issues: group.map(issue => issue.number),
      modules: [...new Set(group.map(issue => issue.module))].sort(),
      tier_buckets: [...new Set(group.map(issue => issue.tier_bucket))].sort(),
    }];
  });
}

function planUnitOrders(units: ReadonlyMap<number, readonly ClassifiedIssue[]>): { order: PlanOrderEntryV3[]; stalled: number[] } {
  const unitByIssue = new Map([...units].flatMap(([key, members]) => members.map(issue => [issue.number, key] as const)));
  const graph = new Map([...units].map(([key, members]) => [key, members.flatMap(issue => issue.blocked_by.flatMap(blocker => {
    const unit = unitByIssue.get(blocker);
    return unit === undefined || unit === key ? [] : [unit];
  }))]));
  const { ordered, stalled } = dependencyOrder(graph);
  const numbersOf = (key: number): number[] => units.get(key)!.map(issue => issue.number);
  return {
    order: ordered.map(key => {
      const numbers = numbersOf(key);
      return numbers.length === 1 ? numbers[0]! : numbers;
    }),
    stalled: stalled.flatMap(numbersOf),
  };
}

function sharedTargetFiles(members: readonly ClassifiedIssue[]): string[] {
  const counts = new Map<string, number>();
  for (const member of members) {
    for (const file of new Set(member.resolved_target_files)) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, count]) => count >= 2).map(([file]) => file).sort();
}

function overlapComponents(
  ordered: readonly number[],
  byIssue: ReadonlyMap<number, ClassifiedIssue>,
): { readonly components: number[][]; readonly nonOverlapping: number[] } {
  const orderIndex = new Map(ordered.map((num, idx) => [num, idx]));
  const byFile = new Map<string, number[]>();
  for (const num of ordered) {
    for (const file of byIssue.get(num)!.resolved_target_files) {
      const list = byFile.get(file);
      if (list === undefined) byFile.set(file, [num]);
      else list.push(num);
    }
  }
  const adj = new Map<number, Set<number>>(ordered.map(num => [num, new Set<number>()]));
  for (const group of byFile.values()) {
    if (group.length < 2) continue;
    for (const a of group) {
      for (const b of group) {
        if (a !== b) adj.get(a)!.add(b);
      }
    }
  }
  const visited = new Set<number>();
  const components: number[][] = [];
  const nonOverlapping: number[] = [];
  for (const start of ordered) {
    if (visited.has(start)) continue;
    const neighbors = adj.get(start)!;
    if (neighbors.size === 0) {
      visited.add(start);
      nonOverlapping.push(start);
      continue;
    }
    const comp: number[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      comp.push(current);
      for (const next of adj.get(current)!) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    comp.sort((a, b) => orderIndex.get(a)! - orderIndex.get(b)!);
    components.push(comp);
  }
  return { components, nonOverlapping };
}

function packPatternUnits(
  group: readonly ClassifiedIssue[],
  maxSize: number,
): { readonly chunks: ClassifiedIssue[][]; readonly stalled: number[] } | null {
  const eligible = group.filter(issue => issue.cross_capability === null);
  if (eligible.length < 2) return null;
  const tierSet = new Set(eligible.map(issue => issue.tier_bucket));
  if (tierSet.size > 1) return null;
  const tierBucket = eligible[0]!.tier_bucket;
  const hasFrontend = eligible.some(issue => issue.route === 'frontend');
  const hasBackend = eligible.some(issue => issue.route !== 'frontend');
  if (hasFrontend && hasBackend) return null;
  const size = tierBucket === 'high' ? Math.min(2, maxSize) : maxSize;
  const { ordered, stalled } = dependencyOrder(new Map(eligible.map(issue => [issue.number, issue.blocked_by])));
  const byNumberMap = new Map(eligible.map(issue => [issue.number, issue]));
  const chunks: ClassifiedIssue[][] = [];
  for (let at = 0; at < ordered.length; at += size) {
    const slice = ordered.slice(at, at + size).map(num => byNumberMap.get(num)!);
    if (slice.length >= 2) chunks.push(slice);
  }
  return chunks.length === 0 && stalled.length === 0 ? null : { chunks, stalled };
}

export function clusterIssues(input: {
  readonly issues: readonly ClusterIssue[];
  readonly max_size?: number;
  readonly scope: Scope & { readonly truncated: boolean };
  readonly ownership_status?: OwnershipStatus;
  readonly path_owners?: readonly ClusterPathOwner[];
}): BoardClusterV1 {
  const maxSize = input.max_size ?? DEFAULT_CLUSTER_MAX_SIZE;
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) throw new BoardSourceError('max_size must be a positive integer');
  const issues = [...input.issues].sort((left, right) => byNumber(left.number, right.number));
  if (new Set(issues.map(issue => issue.number)).size !== issues.length) throw new BoardSourceError('the cluster read repeats an issue');

  const ownershipStatus: OwnershipStatus = input.ownership_status ?? (input.path_owners === undefined ? 'unavailable' : 'observed');
  const ownersByPath = ownershipStatus === 'observed'
    ? new Map((input.path_owners ?? []).map(owner => [owner.path, owner] as const))
    : null;

  const inFlight: number[] = [];
  const classified: ClassifiedIssue[] = [];
  const unclassified: UnclassifiedIssue[] = [];
  const issueMetadata: ClusterIssueMetadata[] = [];
  for (const issue of issues) {
    if (issue.in_flight) {
      inFlight.push(issue.number);
      continue;
    }
    const { result, metadata } = classify(issue, ownersByPath);
    issueMetadata.push(metadata);
    if ('missing' in result) unclassified.push(result);
    else classified.push(result);
  }

  const byIssue = new Map(classified.map(issue => [issue.number, issue]));
  const patterns = patternGroups(classified);
  const cycles: number[] = [];
  const units = new Map<number, readonly ClassifiedIssue[]>();
  const reservedPatternIssues = new Set<number>();

  // Reserve eligible cross-module pattern groups first so issues are not duplicated across two bundles.
  for (const group of patterns) {
    if (group.modules.length < 2) continue;
    const members = group.issues.map(number => byIssue.get(number)!);
    const packed = packPatternUnits(members, maxSize);
    if (packed === null) continue;
    cycles.push(...packed.stalled);
    for (const chunk of packed.chunks) {
      if (chunk.some(issue => reservedPatternIssues.has(issue.number))) continue;
      if (new Set(chunk.map(issue => issue.module)).size < 2) continue;
      for (const issue of chunk) reservedPatternIssues.add(issue.number);
      units.set(Math.min(...chunk.map(issue => issue.number)), chunk);
    }
  }

  const remainingClassified = classified.filter(issue => !reservedPatternIssues.has(issue.number));
  const crossCapabilityIssues = remainingClassified.filter(issue => issue.cross_capability !== null);
  const singleCapabilityIssues = remainingClassified.filter(issue => issue.cross_capability === null);

  const buckets = groupBy(singleCapabilityIssues, issue => `${issue.module}:${issue.tier_bucket}:${issue.route === 'frontend' ? 'frontend' : 'backend'}`);
  const bundles: ModuleBundle[] = [];
  const orphans: Orphan[] = [];

  for (const issue of crossCapabilityIssues) {
    const external_blockers = distinctNumbers(issue.blocked_by);
    units.set(issue.number, [issue]);
    orphans.push({
      issue: issue.number,
      external_blockers,
      cross_capability: issue.cross_capability!,
    });
  }

  const emitChunk = (module: string, tier_bucket: TierBucket, numbers: readonly number[], shared: readonly string[]): void => {
    const members = numbers.map(number => byIssue.get(number)!);
    units.set(Math.min(...numbers), members);
    const memberNumbers = new Set(numbers);
    const external_blockers = distinctNumbers(members.flatMap(issue => issue.blocked_by.filter(blocker => !memberNumbers.has(blocker))));
    if (numbers.length === 1) {
      orphans.push({ issue: numbers[0]!, external_blockers });
      return;
    }
    const route = bundleRouteClass(members.map(issue => issue.route));
    if ('error' in route) throw new BoardSourceError(route.error);
    bundles.push({
      module, tier_bucket, route_class: route.kind, issues: numbers,
      credentials: members.some(issue => issue.labels.includes(CREDENTIALS_LABEL)),
      external_blockers,
      ...(shared.length > 0 ? { shared_files: shared } : {}),
    });
  };

  for (const bucket of buckets.values()) {
    const { module, tier_bucket } = bucket[0]!;
    const size = tier_bucket === 'high' ? Math.min(2, maxSize) : maxSize;
    const { ordered, stalled } = dependencyOrder(new Map(bucket.map(issue => [issue.number, issue.blocked_by])));
    cycles.push(...stalled);
    const { components, nonOverlapping } = overlapComponents(ordered, byIssue);
    for (const component of components) {
      for (let at = 0; at < component.length; at += size) {
        const chunk = component.slice(at, at + size);
        const members = chunk.map(number => byIssue.get(number)!);
        emitChunk(module, tier_bucket, chunk, sharedTargetFiles(members));
      }
    }
    for (let at = 0; at < nonOverlapping.length; at += size) {
      emitChunk(module, tier_bucket, nonOverlapping.slice(at, at + size), []);
    }
  }

  const { order, stalled } = planUnitOrders(units);
  const plan = decodePlanBlockValue({ protocol: PLAN_BLOCK_PROTOCOL, kind: PLAN_BLOCK_KIND, merge_order: order, holds: [], seat_limits: { worker: 1 } });
  return {
    protocol: BOARD_CLUSTER_PROTOCOL, kind: BOARD_CLUSTER_KIND,
    scope: { ...input.scope, max_size: maxSize },
    ownership_status: ownershipStatus,
    in_flight: inFlight,
    unclassified,
    issue_metadata: issueMetadata,
    module_bundles: bundles,
    orphans: orphans.sort((left, right) => byNumber(left.issue, right.issue)),
    cycles: distinctNumbers([...cycles, ...stalled]),
    pattern_groups: patterns,
    suggested_merge_order: plan.merge_order,
  };
}
