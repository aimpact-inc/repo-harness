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

type TierBucket = 'standard' | 'high';
type Scope = { readonly mode: 'open'; readonly parent: null } | { readonly mode: 'parent'; readonly parent: number };

export interface ClusterIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  /** Open blocked-by edges. Closed blockers have already cleared. */
  readonly blocked_by: readonly number[];
  readonly in_flight: boolean;
}

interface ClassifiedIssue extends ClusterIssue {
  readonly module: string;
  readonly tier_bucket: TierBucket;
  readonly route: RoutingClass;
  readonly pattern: string | null;
}

interface UnclassifiedIssue {
  readonly issue: number;
  readonly title: string;
  readonly missing: readonly string[];
  readonly errors: readonly string[];
}

interface ModuleBundle {
  readonly module: string;
  readonly tier_bucket: TierBucket;
  readonly route_class: RoutingClass;
  readonly credentials: boolean;
  readonly issues: readonly number[];
  readonly external_blockers: readonly number[];
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
  readonly in_flight: readonly number[];
  readonly unclassified: readonly UnclassifiedIssue[];
  readonly module_bundles: readonly ModuleBundle[];
  readonly orphans: readonly number[];
  readonly cycles: readonly number[];
  readonly pattern_groups: readonly PatternGroup[];
  readonly suggested_merge_order: readonly PlanOrderEntryV3[];
}

const byNumber = (left: number, right: number): number => left - right;
const distinctNumbers = (values: readonly number[]): number[] => [...new Set(values)].sort(byNumber);

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

function classify(issue: ClusterIssue): ClassifiedIssue | UnclassifiedIssue {
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
  const module = read('module', () => moduleOf(labels));
  const tier = read('tier', () => labelValue(labels, 'tier:', label => tierOf([label])));
  const route = read('route', () => labelValue(labels, ROUTE_LABEL_PREFIX,
    label => ROUTING_CLASSES.find(kind => label === ROUTE_LABEL_PREFIX + kind) ?? null));
  const pattern = read('pattern', () => patternOf(labels), false);
  if (module === null || tier === null || route === null || errors.length > 0) {
    return { issue: issue.number, title: issue.title, missing, errors };
  }
  return { ...issue, module, tier_bucket: tier === 'high' ? 'high' : 'standard', route, pattern };
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

export function clusterIssues(input: {
  readonly issues: readonly ClusterIssue[];
  readonly max_size?: number;
  readonly scope: Scope & { readonly truncated: boolean };
}): BoardClusterV1 {
  const maxSize = input.max_size ?? DEFAULT_CLUSTER_MAX_SIZE;
  if (!Number.isSafeInteger(maxSize) || maxSize <= 0) throw new BoardSourceError('max_size must be a positive integer');
  const issues = [...input.issues].sort((left, right) => byNumber(left.number, right.number));
  if (new Set(issues.map(issue => issue.number)).size !== issues.length) throw new BoardSourceError('the cluster read repeats an issue');

  const inFlight: number[] = [];
  const classified: ClassifiedIssue[] = [];
  const unclassified: UnclassifiedIssue[] = [];
  for (const issue of issues) {
    if (issue.in_flight) {
      inFlight.push(issue.number);
      continue;
    }
    const result = classify(issue);
    if ('missing' in result) unclassified.push(result);
    else classified.push(result);
  }

  const buckets = groupBy(classified, issue => `${issue.module}:${issue.tier_bucket}:${issue.route === 'frontend' ? 'frontend' : 'backend'}`);
  const bundles: ModuleBundle[] = [];
  const orphans: number[] = [];
  const cycles: number[] = [];
  const byIssue = new Map(classified.map(issue => [issue.number, issue]));
  const units = new Map<number, readonly ClassifiedIssue[]>();
  for (const bucket of buckets.values()) {
    const { module, tier_bucket } = bucket[0]!;
    const size = tier_bucket === 'high' ? 2 : maxSize;
    const { ordered, stalled } = dependencyOrder(new Map(bucket.map(issue => [issue.number, issue.blocked_by])));
    cycles.push(...stalled);
    for (let at = 0; at < ordered.length; at += size) {
      const numbers = ordered.slice(at, at + size);
      const members = numbers.map(number => byIssue.get(number)!);
      units.set(Math.min(...numbers), members);
      if (numbers.length === 1) {
        orphans.push(numbers[0]!);
        continue;
      }
      const memberNumbers = new Set(numbers);
      const route = bundleRouteClass(members.map(issue => issue.route));
      if ('error' in route) throw new BoardSourceError(route.error);
      bundles.push({
        module, tier_bucket, route_class: route.kind, issues: numbers,
        credentials: members.some(issue => issue.labels.includes(CREDENTIALS_LABEL)),
        external_blockers: distinctNumbers(members.flatMap(issue => issue.blocked_by.filter(blocker => !memberNumbers.has(blocker)))),
      });
    }
  }
  const { order, stalled } = planUnitOrders(units);
  const plan = decodePlanBlockValue({ protocol: PLAN_BLOCK_PROTOCOL, kind: PLAN_BLOCK_KIND, merge_order: order, holds: [], seat_limits: { worker: 1 } });
  return {
    protocol: BOARD_CLUSTER_PROTOCOL, kind: BOARD_CLUSTER_KIND,
    scope: { ...input.scope, max_size: maxSize }, in_flight: inFlight, unclassified,
    module_bundles: bundles, orphans: orphans.sort(byNumber), cycles: distinctNumbers([...cycles, ...stalled]),
    pattern_groups: patternGroups(classified), suggested_merge_order: plan.merge_order,
  };
}
