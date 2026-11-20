import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clusterIssues, extractIssueTargetPaths, type ClusterIssue } from '../src/core/board/cluster';
import { decodePlanBlockValue, PLAN_BLOCK_KIND, PLAN_BLOCK_PROTOCOL } from '../src/core/board/plan-block';
import { collectBoardCluster } from '../src/effects/board/cluster';
import { run, tmpWorkspace } from './helpers/repo-fixture';

const scope = { mode: 'open', parent: null, truncated: false } as const;
const labels = (module = 'billing', tier = 'medium', route = 'simple_fast'): string[] => [`module:${module}`, `tier:${tier}`, `route:${route}`];
const issue = (number: number, labels_: readonly string[] = labels(), blocked_by: readonly number[] = []): ClusterIssue => ({
  number, title: `Issue ${number}`, labels: labels_, blocked_by, in_flight: false,
});

const roots: string[] = [];
function workspace(prefix: string): string {
  const root = tmpWorkspace(prefix);
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('splits the mixed backlog into deterministic plan units and reports cross-module patterns', () => {
  const pattern = 'json-migration-released-rendering';
  const issues = [
    issue(1, ['tier:medium', 'route:simple_fast']), issue(2, ['module:billing', 'tier:medium']),
    issue(3, labels(), [7]), issue(4, labels('billing', 'medium', 'important_fast')),
    issue(5, [...labels('billing', 'medium', 'simple_deep'), 'touches:credentials']), issue(6), issue(7),
    issue(8, labels(), [50, 6]), issue(9), issue(10, labels('billing', 'high'), [60]),
    issue(11, [...labels('storage', 'high'), `pattern:${pattern}`]),
    issue(12, [...labels('platform/tokens', 'high'), `pattern:${pattern}`]),
  ];
  const result = clusterIssues({ issues: issues.reverse(), scope, max_size: 5 });
  expect(result.unclassified).toEqual([
    { issue: 1, title: 'Issue 1', missing: ['module'], errors: [] },
    { issue: 2, title: 'Issue 2', missing: ['route'], errors: [] },
  ]);
  expect(result.module_bundles).toEqual([
    { module: 'billing', tier_bucket: 'standard', route_class: 'important_deep', credentials: true, issues: [4, 5, 6, 7, 3], external_blockers: [] },
    { module: 'billing', tier_bucket: 'standard', route_class: 'simple_fast', credentials: false, issues: [8, 9], external_blockers: [6, 50] },
  ]);
  expect(result.orphans).toEqual([{ issue: 10, external_blockers: [60] }]);
  expect(result.pattern_groups).toEqual([{ pattern, issues: [11, 12], modules: ['platform/tokens', 'storage'], tier_buckets: ['high'] }]);
  const plan = decodePlanBlockValue({
    protocol: PLAN_BLOCK_PROTOCOL, kind: PLAN_BLOCK_KIND,
    merge_order: result.suggested_merge_order, holds: [], seat_limits: { worker: 2 },
  });
  expect(plan.merge_order).toEqual([[4, 5, 6, 7, 3], [8, 9], 10, [11, 12]]);
});

test('caps high units at two and keeps frontend separate from backend', () => {
  const issues = [
    issue(1, labels('billing', 'high')), issue(2, labels('billing', 'high')), issue(3, labels('billing', 'high')),
    issue(4, labels('billing', 'low', 'frontend')), issue(5, labels('billing', 'medium', 'frontend')),
    issue(6), issue(7, labels('billing', 'low')),
  ];
  const result = clusterIssues({ issues, scope });
  expect(result.module_bundles.map(bundle => [bundle.tier_bucket, bundle.route_class, bundle.issues])).toEqual([
    ['high', 'simple_fast', [1, 2]], ['standard', 'frontend', [4, 5]], ['standard', 'simple_fast', [6, 7]],
  ]);
  expect(result.orphans).toEqual([{ issue: 3, external_blockers: [] }]);
});

test('max_size 1 splits two high issues into singletons', () => {
  const high = labels('billing', 'high');
  const result = clusterIssues({ issues: [issue(1, high), issue(2, high)], scope, max_size: 1 });
  expect(result.module_bundles).toEqual([]);
  expect(result.suggested_merge_order).toEqual([1, 2]);
});

test('collects label errors across families and withholds in-flight issues before classification', () => {
  const issues = [
    issue(1, ['module:Billing', 'tier:urgent', 'route:unknown', 'pattern:a--b']),
    issue(2, [...labels(), 'module:storage', 'tier:urgent', 'route:frontend', 'pattern:one', 'pattern:two']),
    { ...issue(3, []), in_flight: true },
  ];
  const result = clusterIssues({ issues, scope });
  expect(result.in_flight).toEqual([3]);
  expect(result.unclassified.map(entry => entry.missing)).toEqual([[], []]);
  expect(result.unclassified[0]?.errors).toEqual(['module:', 'tier:', 'route:', 'pattern:'].map(prefix => expect.stringContaining(`invalid ${prefix}`)));
  expect(result.unclassified[1]?.errors).toEqual(['module:', 'tier:', 'route:', 'pattern:'].map(prefix => expect.stringContaining(`more than one ${prefix}`)));
  expect(result.suggested_merge_order).toEqual([]);
});

test('omits an in-bucket cycle and a cycle between contracted units from the suggested order', () => {
  const issues = [
    issue(1), issue(2, labels('storage')), issue(3, labels('storage'), [1]), issue(4, labels(), [2]),
    issue(5, labels('cycle'), [6]), issue(6, labels('cycle'), [5]),
    issue(7, labels('api'), [9]), issue(8, labels('billing', 'low', 'frontend')), issue(9, labels('web')),
  ];
  const result = clusterIssues({ issues, scope });
  expect(result.cycles).toEqual([1, 2, 3, 4, 5, 6]);
  expect(result.module_bundles.map(bundle => bundle.issues)).toEqual([[1, 4], [2, 3]]);
  expect(result.suggested_merge_order).toEqual([8, 9, 7]);
});

test('groups same-module issues by target-file overlap before slicing and guards cross-capability issues', () => {
  const issues: ClusterIssue[] = [
    { ...issue(1, ['tier:medium', 'route:simple_fast']), body: 'Change: `src/effects/refactor/recommendations.ts:10-20`' },
    { ...issue(2, labels('runtime-harness/refactor-program')), target_files: ['src/effects/refactor/recommendations.ts'] },
    { ...issue(3, labels('billing', 'medium', 'simple_fast')), target_files: ['src/a.ts'] },
    { ...issue(4, labels('billing', 'medium', 'simple_fast')), target_files: ['src/b.ts'] },
    { ...issue(5, labels('billing', 'medium', 'simple_fast')), target_files: ['src/a.ts'] },
    { ...issue(6, labels('billing', 'medium', 'simple_fast')), target_files: ['src/b.ts'] },
    { ...issue(7, labels('billing', 'high', 'simple_fast')), target_files: ['src/h.ts'] },
    { ...issue(8, labels('billing', 'high', 'simple_fast')), target_files: ['src/h.ts'] },
    { ...issue(9, labels('billing', 'high', 'simple_fast')), target_files: ['src/h.ts'] },
    { ...issue(10, labels('organization/board', 'medium', 'simple_fast')), body: 'Touch `src/core/board/review.ts` and `src/operator-web/SeatsPage.tsx`.\n## Out of scope\n- `src/ignore/me.ts`' },
  ];
  const result = clusterIssues({
    issues, scope, max_size: 2, ownership_status: 'observed',
    path_owners: [
      { path: 'src/effects/refactor/recommendations.ts', status: 'owned', capability: 'capability.runtime-harness.refactor-program' },
      { path: 'src/core/board/review.ts', status: 'owned', capability: 'capability.organization.board' },
      { path: 'src/operator-web/SeatsPage.tsx', status: 'owned', capability: 'capability.runtime-harness.operator' },
      { path: 'src/a.ts', status: 'owned', capability: 'capability.billing.core' },
      { path: 'src/b.ts', status: 'owned', capability: 'capability.billing.core' },
      { path: 'src/h.ts', status: 'owned', capability: 'capability.billing.core' },
    ],
  });
  expect(result.ownership_status).toBe('observed');
  expect(result.issue_metadata.find(m => m.issue === 1)?.inferred_module).toBe('runtime-harness/refactor-program');
  expect(result.issue_metadata.find(m => m.issue === 10)?.cross_capability).toEqual(['organization/board', 'runtime-harness/operator']);
  expect(extractIssueTargetPaths('## Module and files\n`./src/x.ts:5-9`\n## Out of scope\n`src/y.ts`')).toEqual(['src/x.ts']);
  expect(result.module_bundles.map(bundle => [bundle.module, bundle.tier_bucket, bundle.issues, bundle.shared_files])).toEqual([
    ['runtime-harness/refactor-program', 'standard', [1, 2], ['src/effects/refactor/recommendations.ts']],
    ['billing', 'standard', [3, 5], ['src/a.ts']],
    ['billing', 'standard', [4, 6], ['src/b.ts']],
    ['billing', 'high', [7, 8], ['src/h.ts']],
  ]);
  expect(result.orphans).toEqual([
    { issue: 9, external_blockers: [] },
    { issue: 10, external_blockers: [], cross_capability: ['organization/board', 'runtime-harness/operator'] },
  ]);
});

test('keeps transitively dependent overlapping issues separate when an intermediate touches another file', () => {
  const issues: ClusterIssue[] = [
    { ...issue(1, labels('billing', 'medium', 'simple_fast')), target_files: ['src/a.ts'] },
    { ...issue(2, labels('billing', 'medium', 'simple_fast'), [1]), target_files: ['src/b.ts'] },
    { ...issue(3, labels('billing', 'medium', 'simple_fast'), [2]), target_files: ['src/a.ts'] },
  ];
  const result = clusterIssues({ issues, scope, max_size: 2 });
  expect(result.cycles).toEqual([]);
  expect(result.module_bundles).toEqual([
    { module: 'billing', tier_bucket: 'standard', route_class: 'simple_fast', credentials: false, issues: [1, 2], external_blockers: [] },
  ]);
  expect(result.orphans).toEqual([{ issue: 3, external_blockers: [2] }]);
  expect(result.suggested_merge_order).toEqual([[1, 2], 3]);
});

const repository = 'Ancienttwo/repo-harness';
const response = (value: unknown) => ({ status: 0, stdout: JSON.stringify(value) });
const forward = (nodes: readonly unknown[]) => ({ pageInfo: { hasNextPage: false }, nodes });
const backward = (nodes: readonly unknown[]) => ({ pageInfo: { hasPreviousPage: false }, nodes });
const openIssue = (number: number, fields: Record<string, unknown> = {}) => ({
  number, title: `Issue ${number}`, body: '', parent: null, subIssuesSummary: { total: 0 },
  labels: forward(labels().map(name => ({ name }))), blockedBy: forward([]), comments: backward([]), timelineItems: backward([]),
  ...fields,
});
const openPage = (nodes: readonly unknown[], after: string | null) => ({ data: { repository: {
  nameWithOwner: repository, issues: { nodes, pageInfo: { hasNextPage: after !== null, endCursor: after } },
} } });

function readQuery(args: readonly string[]): string {
  const query = args.find(arg => arg.startsWith('query='))?.slice('query='.length);
  if (args[0] !== 'api' || args[1] !== 'graphql' || !query?.startsWith('query(')
    || args.some(arg => ['--method', '-X', '--cache', '--input', '--paginate'].includes(arg))) {
    throw new Error('unexpected gh call');
  }
  return query;
}

test('--open follows a bounded read-only scan and reports a truncated scope', () => {
  const checkout = workspace('board-cluster-checkout');
  const tracked = join(checkout, 'README.md');
  writeFileSync(tracked, 'unchanged\n');
  const openPr = (body: string) => ({ source: { __typename: 'PullRequest', state: 'OPEN', body, repository: { nameWithOwner: repository } } });
  const pages = [
    [openIssue(1, { timelineItems: backward([null, { source: null }, {}, openPr('Closes #5')]) }),
      openIssue(2, { blockedBy: forward([{ number: 90, state: 'CLOSED' }, { number: 91, state: 'OPEN' }]) }),
      openIssue(3, { comments: backward([{
        url: 'https://github.com/Ancienttwo/repo-harness/issues/3#issuecomment-1', createdAt: '2026-11-19T00:00:00Z',
        authorAssociation: 'MEMBER', body: 'repo-harness issue claim\nRole: writer',
      }]) }), openIssue(4, { parent: { number: 99 } })],
    [openIssue(5)],
  ];
  let reads = 0;
  const result = collectBoardCluster({ repo_root: checkout, parent: null, gh_runner: args => {
    expect(readQuery(args)).toContain('issues(states: OPEN');
    expect(args.find(arg => arg.startsWith('after='))).toBe(reads === 0 ? undefined : `after=page-${reads}`);
    const nodes = pages[reads] ?? [openIssue(100 + reads, { parent: { number: 99 } })];
    reads += 1;
    return response(openPage(nodes, `page-${reads}`));
  } });
  expect(reads).toBe(10);
  expect(result.scope).toEqual({ ...scope, max_size: 5, truncated: true });
  expect(result.in_flight).toEqual([3, 5]);
  expect(result.suggested_merge_order).toEqual([[1, 2]]);
  expect(result.module_bundles[0]?.external_blockers).toEqual([91]);
  expect(readdirSync(checkout)).toEqual(['README.md']);
  expect(readFileSync(tracked, 'utf8')).toBe('unchanged\n');
});

test('--open skips a batch parent before it reads the truncated timeline', () => {
  const batchParent = openIssue(1, {
    subIssuesSummary: { total: 2 },
    timelineItems: { pageInfo: { hasPreviousPage: true }, nodes: [] },
  });
  const result = collectBoardCluster({ repo_root: workspace('board-cluster-open'), parent: null, gh_runner: args => {
    expect(readQuery(args)).toContain('subIssuesSummary { total }');
    return response(openPage([batchParent, openIssue(2)], null));
  } });
  expect(result.suggested_merge_order).toEqual([2]);
});

test('--parent reuses the board read for open sub-issues, claims and PR body links', () => {
  const checkout = workspace('board-cluster-parent');
  const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/board', name), 'utf8'));
  const board = fixture('parent-1474.graphql.json');
  const pulls = fixture('pull-requests-1474.graphql.json');
  const nodes = board.data.repository.issue.subIssues.nodes;
  for (const node of nodes) node.labels = forward(labels().map(name => ({ name })));
  nodes.find((node: { number: number }) => node.number === 1479).comments = backward([]);
  nodes.find((node: { number: number }) => node.number === 1480).state = 'CLOSED';
  pulls.data.repository.pr1499.body = 'Refs #1474';
  const result = collectBoardCluster({ repo_root: checkout, parent: 1474, gh_runner: args => {
    if (args.join(' ') === 'repo view --json nameWithOwner') return response({ nameWithOwner: repository });
    const query = readQuery(args);
    if (query.includes('subIssues(')) return response(board);
    if (query.includes(': pullRequest(number:')) return response(pulls);
    throw new Error('unexpected board read');
  } });
  expect(result.scope).toEqual({ mode: 'parent', parent: 1474, max_size: 5, truncated: false });
  // #1476 has a claim alone, #1479 has a PR alone, and the closed #1480 is out of scope.
  expect(result.in_flight).toEqual([1475, 1476, 1479]);
  expect(result.suggested_merge_order).toEqual([[1477, 1478, 1481, 1482, 1483]]);
  expect(readdirSync(checkout)).toEqual([]);
});

test('collectBoardCluster batches existing paths in one pathOwners call and --include-loose deduplicates', () => {
  const checkout = workspace('board-cluster-resolve');
  for (const rel of ['src/effects/refactor/recommendations.ts', 'src/core/board/review.ts', 'src/operator-web/SeatsPage.tsx']) {
    mkdirSync(join(checkout, rel, '..'), { recursive: true });
    writeFileSync(join(checkout, rel), '// stub\n');
  }
  const board = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/board/parent-1474.graphql.json'), 'utf8'));
  const pulls = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/board/pull-requests-1474.graphql.json'), 'utf8'));
  const nodes = board.data.repository.issue.subIssues.nodes;
  for (const node of nodes) {
    node.state = node.number === 1477 || node.number === 1478 ? 'OPEN' : 'CLOSED';
    node.comments = backward([]);
    node.labels = forward(['tier:medium', 'route:simple_fast'].map(name => ({ name })));
  }
  nodes.find((n: { number: number }) => n.number === 1477).body = 'Change: `src/effects/refactor/recommendations.ts:10`, `src/missing.ts`';
  const issue1478 = nodes.find((n: { number: number }) => n.number === 1478);
  issue1478.labels = forward(['module:organization/board', 'tier:medium', 'route:simple_fast'].map(name => ({ name })));
  issue1478.body = 'Touch `src/core/board/review.ts` and `src/operator-web/SeatsPage.tsx`';
  pulls.data.repository.pr1499.body = 'Refs #1474';
  const looseNodes = [
    openIssue(1477, { labels: forward(['tier:medium', 'route:simple_fast'].map(name => ({ name }))) }),
    openIssue(2001, { labels: forward(['tier:medium', 'route:simple_fast'].map(name => ({ name }))), body: 'See `src/effects/refactor/recommendations.ts`' }),
  ];
  let archctxCalls = 0;
  let requestedPaths: string[] = [];
  const capMap: Record<string, string> = {
    'src/effects/refactor/recommendations.ts': 'capability.runtime-harness.refactor-program',
    'src/core/board/review.ts': 'capability.organization.board',
    'src/operator-web/SeatsPage.tsx': 'capability.runtime-harness.operator',
  };
  const result = collectBoardCluster({
    repo_root: checkout, parent: 1474, include_loose: true,
    gh_runner: args => {
      if (args.join(' ') === 'repo view --json nameWithOwner') return response({ nameWithOwner: repository });
      const query = readQuery(args);
      if (query.includes('subIssues(')) return response(board);
      if (query.includes(': pullRequest(number:')) return response(pulls);
      if (query.includes('issues(states: OPEN')) return response(openPage(looseNodes, null));
      throw new Error('unexpected gh call');
    },
    archctx: {
      run: (_bin, args) => {
        archctxCalls += 1;
        expect(args[0]).toBe('resolve');
        requestedPaths = readFileSync(args[2]!, 'utf8').trim().split('\n');
        return {
          status: 0, signal: null, stderr: '',
          stdout: JSON.stringify({
            schemaVersion: 'archcontext.envelope/v1', ok: true, requestId: 'resolve',
            data: { results: requestedPaths.map(path => ({ path, matched: true, ambiguous: false, stableId: capMap[path]!, kind: 'capability', name: path, owningCapabilityId: capMap[path]! })) },
          }),
        };
      },
    },
  });
  expect(archctxCalls).toBe(1);
  expect(requestedPaths).toEqual(['src/core/board/review.ts', 'src/effects/refactor/recommendations.ts', 'src/operator-web/SeatsPage.tsx']);
  expect(result.scope).toEqual({ mode: 'parent', parent: 1474, include_loose: true, max_size: 5, truncated: false });
  expect(result.ownership_status).toBe('observed');
  expect(result.module_bundles).toEqual([{
    module: 'runtime-harness/refactor-program', tier_bucket: 'standard', route_class: 'simple_fast',
    credentials: false, issues: [1477, 2001], external_blockers: [], shared_files: ['src/effects/refactor/recommendations.ts'],
  }]);
  expect(result.orphans).toEqual([{ issue: 1478, external_blockers: [], cross_capability: ['organization/board', 'runtime-harness/operator'] }]);

  const degraded = collectBoardCluster({
    repo_root: checkout, parent: 1474,
    gh_runner: args => {
      if (args.join(' ') === 'repo view --json nameWithOwner') return response({ nameWithOwner: repository });
      const query = readQuery(args);
      if (query.includes('subIssues(')) return response(board);
      if (query.includes(': pullRequest(number:')) return response(pulls);
      throw new Error('unexpected gh call');
    },
    archctx: { run: () => ({ status: 1, signal: null, stdout: '', stderr: 'archctx unavailable' }) },
  });
  expect(degraded.ownership_status).toBe('unavailable');
  expect(degraded.unclassified.map(entry => [entry.issue, entry.missing])).toEqual([[1477, ['module']]]);
  expect(degraded.orphans).toEqual([{ issue: 1478, external_blockers: [] }]);
});

const cli = join(import.meta.dir, '../src/cli/index.ts');

test.skipIf(process.platform === 'win32')('CLI prints the cluster document with a custom standard size', () => {
  const checkout = workspace('board-cluster-cli');
  const home = workspace('board-cluster-home');
  const gh = join(home, 'gh');
  const page = openPage([openIssue(1), openIssue(2)], null);
  writeFileSync(gh, `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'api' || args[1] !== 'graphql' || !args.some(arg => arg.startsWith('query=query('))) process.exit(2);
console.log(JSON.stringify(${JSON.stringify(page)}));
`, { mode: 0o755 });
  const result = run(process.execPath, [cli, 'board', '--json', 'cluster', '--open', '--max-size', '1'], checkout, {
    HOME: home, REPO_HARNESS_HOME: join(home, 'rh'), REPO_HARNESS_GH_BIN: gh,
    // Measure the CLI's writes with Bun's startup transpiler cache disabled.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    protocol: 1, kind: 'repo-harness.board-cluster', scope: { ...scope, max_size: 1 },
    module_bundles: [], orphans: [{ issue: 1, external_blockers: [] }, { issue: 2, external_blockers: [] }], suggested_merge_order: [1, 2],
  });
  expect(readdirSync(checkout)).toEqual([]);
  expect(readdirSync(home)).toEqual(['gh']);
});

test.each([
  { flags: ['--open', '--parent', '9', '--json'], message: 'exactly one' },
  { flags: ['--open', '--include-loose', '--json'], message: '--include-loose requires --parent' },
  { flags: ['--include-loose', '--json'], message: 'exactly one' },
  { flags: ['--json'], message: 'exactly one' },
  { flags: ['--open'], message: 'pass --json' },
  { flags: ['--open', '--json', '--max-size', '0'], message: 'positive integer' },
  { flags: ['--open', '--json', '--max-size', '1.5'], message: 'positive integer' },
])('CLI refuses invalid flags before attempting a provider read ($flags)', ({ flags, message }) => {
  const checkout = workspace('board-cluster-cli');
  const home = workspace('board-cluster-home');
  const result = run(process.execPath, [cli, 'board', 'cluster', ...flags], checkout, {
    HOME: home, REPO_HARNESS_HOME: join(home, 'rh'), REPO_HARNESS_GH_BIN: join(home, 'no-gh'),
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: 'BoardCollectError', message: expect.stringContaining(message) });
});
