import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DispatchError, bundleRouteClass, planDispatch, type DispatchPlanV1 } from '../src/core/board/dispatch';
import { WORKER_AUTHORITY, executeDispatch, runDispatch, type DispatchPorts } from '../src/effects/board/dispatch';
import { withSeatLine } from '../src/core/board/seat-line';
import { HerdrCoreError } from '../src/effects/terminal/herdr-core';
import type { SeatAccountQuotas } from '../src/core/board/seat-routing';
import { emptySeatPoolProbe, seatModelBlock, type SeatPoolProbe } from '../src/core/board/seat-pool';
import { DEFAULT_SEATS_CONFIG, NATIVE_SEATS_PRESET } from '../src/core/board/seats-settings';
import type { BoardCommentV1, BoardParentReadV1, BoardSubIssueReadV1 } from '../src/core/board/source';
import { agyCatalogScript } from './helpers/agy-cli-fixture';
import { run, withTempRepo } from './helpers/repo-fixture';

const NORMAL: SeatAccountQuotas = {
  claude: { state: 'normal', remaining: 80, mode: 'normal' },
  chatgpt: { state: 'normal', remaining: 30, mode: 'normal', credits: 'off' },
  agy_gemini: { state: 'unknown', remaining: null, mode: 'unknown' },
  agy_other: { state: 'unknown', remaining: null },
};
const comment = (body: string, created_at = '2026-11-09T10:00:00Z'): BoardCommentV1 =>
  ({ url: `https://example.test/${created_at}`, created_at, author_association: 'OWNER', body });
const coordinator = comment('repo-harness issue claim\nStatus: active\nRole: coordinator', '2026-11-09T09:00:00Z');
type Order = readonly (number | readonly number[])[];
const ORDER: Order = [1, 2, 3, 4, 5, 6, 7, 8];
const planBody = (limit: number, order: Order = ORDER) => `repo-harness plan\n\n\`\`\`json\n${JSON.stringify({
  protocol: 3, kind: 'repo-harness.plan', merge_order: order, holds: [{ issue: 2, reason: 'owner first' }],
  seat_limits: { worker: limit },
})}\n\`\`\``;

function issue(number: number, extra: Partial<BoardSubIssueReadV1> = {}): BoardSubIssueReadV1 {
  return {
    number, title: `issue ${number}`, url: '', state: 'open', labels: ['route:important_deep'], milestone: null,
    comments: { truncated: false, comments: [] }, blocked_by: [], pull_request_candidates: [], ...extra,
  };
}
const withComments = (...comments: BoardCommentV1[]) => ({ comments: { truncated: false, comments } });

function read(subIssues: BoardSubIssueReadV1[], limit = 4, order: Order = ORDER): BoardParentReadV1 {
  return {
    repository: { database_id: 1, name_with_owner: 'o/r', default_branch: 'main' },
    parent: { number: 100, title: 'parent', url: '', state: 'open', labels: [], milestone: null, comments: { truncated: false, comments: [coordinator, comment(planBody(limit, order))] } },
    sub_issues: subIssues, repair_candidates: [],
  };
}
const reasons = (plan: ReturnType<typeof planDispatch>) => plan.decisions.map(d => d.action === 'skip' ? `${d.issue}:${d.reason}` : `${d.issue}:dispatch`);

test('a ready issue dispatches to its route seat; every other state is skipped with its reason', () => {
  const plan = planDispatch({
    seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [],
    parent: read([
      issue(1),
      issue(2),
      issue(3, { blocked_by: [{ number: 9, state: 'open' }] }),
      issue(4, withComments(comment('repo-harness issue claim\nStatus: active'))),
      issue(5, { labels: [] }),
      issue(6, { state: 'closed' }),
      // A released claim frees the issue; a closed blocker no longer blocks.
      issue(7, { blocked_by: [{ number: 9, state: 'closed' }], ...withComments(
        comment('repo-harness issue claim\nStatus: active', '2026-11-09T10:00:00Z'),
        comment('repo-harness issue claim status\nClaim: https://example.test/2026-11-09T10:00:00Z\nStatus: released', '2026-11-09T11:00:00Z')) }),
    ]),
  });
  expect(reasons(plan)).toEqual(['1:dispatch', '2:held', '3:blocked', '4:claimed', '5:kind_label_invalid', '6:closed', '7:dispatch', '8:not_sub_issue']);
  expect(plan.decisions[0]).toMatchObject({ seat: 'worker-opus', route_class: 'important_deep' });
});

test('early start dispatches an explicitly selected blocked bundle and records the override on each claim', async () => {
  const labels = ['route:important_deep', 'tier:medium'];
  const parent = read([issue(1, { labels }), issue(3, { labels, blocked_by: [{ number: 9, state: 'open' }] })], 4, [[3, 1]]);
  const input = { seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent };
  expect(reasons(planDispatch({ ...input, bundle: [1, 3] }))).toEqual(['3:blocked', '1:blocked']);
  expect(reasons(planDispatch({ ...input, earlyStart: true }))).toEqual(['3:blocked', '1:blocked']);
  const plan = planDispatch({ ...input, bundle: [1, 3], earlyStart: true });
  const claims: string[] = [];
  const dispatch = ports({ comment: (number, body) => { claims.push(body); return `claim-${number}`; } });
  expect((await executeDispatch(plan, context, dispatch.base)).map(entry => entry.issue)).toEqual([3, 1]);
  for (const claim of claims) expect(claim).toMatch(/^Dispatch reading: .+\(early start\)$/m);
});

test('the CLI refuses early start without --issues', () => {
  withTempRepo('dispatch-early-start-', cwd => {
    const cli = join(import.meta.dir, '../src/cli/index.ts');
    const result = run(process.execPath, [cli, 'board', 'dispatch', '--parent', '100', '--space', 's1', '--early-start'], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--early-start requires --issues');
  });
});

test('dispatch skips a signed-out worker and uses the next available seat in that route', () => {
  const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-deep': { ...DEFAULT_SEATS_CONFIG['worker-deep'], runtime: 'codex' as const, model: 'gpt-6.2-sol' } };
  const probes: SeatPoolProbe[] = [
    { ...emptySeatPoolProbe('claude', 'available'), sign_in: 'logged_out' },
    { id: 'codex', installation: 'available', sign_in: 'logged_in', models: 'ok', listed: [{ id: 'gpt-6.2-sol', disabled: false }] },
  ];
  const plan = planDispatch({ seats, quota: NORMAL, terminals: [], parent: read([issue(1), issue(3, { labels: ['route:frontend'] })]),
    modelBlock: (id, seat) => seatModelBlock(id, seat, seats, probes, () => false) });
  expect(plan.decisions[0]).toMatchObject({ action: 'dispatch', seat: 'worker-deep',
    route_line: expect.stringContaining('skipped worker-opus: claude: Runtime signed out. See seats.worker-opus.model.') });
  expect(plan.decisions.find(decision => decision.issue === 3)).toMatchObject({ action: 'skip', reason: 'no_route',
    detail: expect.stringContaining('claude: Runtime signed out. See seats.worker-opus.model.') });
});

test('the worker limit counts live seats of the parent and stops further dispatch', () => {
  const live = (issueNumber: string) => ({ state: 'live' as const, labels: { seat: 'worker', issue: issueNumber, parent: '100' } });
  const plan = planDispatch({
    seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [live('50'), live('51'), { state: 'finished', labels: { seat: 'worker', issue: '52', parent: '100' } }],
    parent: read([issue(1), issue(3), issue(4)], 3),
  });
  expect(plan.live_workers).toBe(2);
  expect(reasons(plan).slice(0, 4)).toEqual(['1:dispatch', '2:not_sub_issue', '3:over_limit', '4:over_limit']);
});

test('a live seat that carries the issue label blocks a second dispatch, with or without the parent label', () => {
  const plan = planDispatch({
    seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [{ state: 'live', labels: { seat: 'worker', issue: '1' } }],
    parent: read([issue(1)]),
  });
  expect(reasons(plan)[0]).toBe('1:claimed');
});

test('work that touches credentials never routes to a Pi seat', () => {
  const saving: SeatAccountQuotas = { ...NORMAL, claude: { state: 'normal', remaining: 5, mode: 'saving' } };
  const parent = (labels: string[]) => read([issue(1, { labels })]);
  const plain = planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: saving, terminals: [], parent: parent(['route:important_deep']) });
  const secret = planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: saving, terminals: [], parent: parent(['route:important_deep', 'touches:credentials']) });
  expect(plain.decisions[0]).toMatchObject({ action: 'dispatch', seat: 'worker-deep' });
  expect(secret.decisions[0]).toMatchObject({ action: 'skip', reason: 'no_route' });
});

test('a parent without a plan comment fails closed', () => {
  const parent = read([issue(1)]);
  expect(() => planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent: { ...parent, parent: { ...parent.parent, comments: { truncated: false, comments: [] } } } }))
    .toThrow(DispatchError);
});

test('a closing status counts only for the claim it names, also within the same second', () => {
  const claimA = comment('repo-harness issue claim\nStatus: active', '2026-11-09T10:00:00Z');
  const claimB = comment('repo-harness issue claim\nStatus: active', '2026-11-09T11:00:00Z');
  const released = (claim: BoardCommentV1, at: string) => comment(`repo-harness issue claim status\nClaim: ${claim.url}\nStatus: released`, at);
  const [delayed, tie, own] = [
    // A late release of claim A arrives after claim B.
    issue(1, withComments(claimA, claimB, released(claimA, '2026-11-09T12:00:00Z'))),
    // The release of claim A carries the timestamp of claim B.
    issue(1, withComments(claimA, claimB, released(claimA, '2026-11-09T11:00:00Z'))),
    issue(1, withComments(claimA, claimB, released(claimB, '2026-11-09T11:00:00Z'))),
  ].map(sub => reasons(planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent: read([sub]) }))[0]);
  expect([delayed, tie, own]).toEqual(['1:claimed', '1:claimed', '1:dispatch']);
});

test('zero or several route labels, and an unknown route class, skip the issue', () => {
  const plan = planDispatch({
    seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [],
    parent: read([issue(1, { labels: [] }), issue(3, { labels: ['route:simple_fast', 'route:frontend'] }), issue(4, { labels: ['route:urgent'] })]),
  });
  expect(reasons(plan).filter((_, index) => index !== 1).slice(0, 3)).toEqual(['1:kind_label_invalid', '3:kind_label_invalid', '4:kind_label_invalid']);
});

const medium = (route: string, extra: Partial<BoardSubIssueReadV1> = {}) => (number: number) => issue(number, { labels: [route, 'tier:medium'], ...extra });

test('a bundle unit keeps its plan order, takes one seat and one route, and does not block on a blocker inside it', () => {
  const plan = planDispatch({
    seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], bundle: [1, 4, 3],
    parent: read([medium('route:simple_fast')(1), medium('route:important_deep', { blocked_by: [{ number: 4, state: 'open' }] })(3), medium('route:important_deep')(4)], 1, [[3, 4, 1], 5]),
  });
  expect(reasons(plan)).toEqual(['3:dispatch', '4:dispatch', '1:dispatch']);
  expect(plan.units).toEqual([[3, 4, 1]]);
  expect(new Set(plan.decisions.map(decision => decision.action === 'dispatch' && `${decision.seat} ${decision.route_class}`))).toEqual(new Set(['worker-opus important_deep']));
});

test('--issues selects one declared plan unit by its member set; every other set is refused with one error', () => {
  const parent = read([101, 102, 103].map(medium('route:important_deep')), 4, [[101, 102], 103]);
  const dispatch = (bundle: number[]) => planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], bundle, parent });
  for (const bundle of [[101], [101, 103], [101, 102, 103], [101, 110]]) expect(() => dispatch(bundle)).toThrow(new DispatchError('not a plan unit; post the plan again with rh board post plan'));
  expect(reasons(dispatch([102, 101]))).toEqual(['101:dispatch', '102:dispatch']);
});

test('the plan dispatches each unit as one seat; a unit that is not ready in part starts nothing and takes no seat', () => {
  const units: Order = [[101, 102], 103, [104, 105], 106];
  const plan = (subIssues: BoardSubIssueReadV1[], limit: number) => planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent: read(subIssues, limit, units) });
  const ready = plan([101, 102, 103, 104, 105, 106].map(medium('route:important_deep')), 2);
  expect(reasons(ready)).toEqual(['101:dispatch', '102:dispatch', '103:dispatch', '104:over_limit', '105:over_limit', '106:over_limit']);
  expect(ready.units).toEqual([[101, 102], [103]]);
  // #105 is claimed, so its unit skips as a whole and leaves the seat to #106.
  const partial = plan([...[101, 102, 103, 104].map(medium('route:important_deep')), medium('route:important_deep', withComments(comment('repo-harness issue claim\nStatus: active')))(105), medium('route:important_deep')(106)], 3);
  expect(reasons(partial)).toEqual(['101:dispatch', '102:dispatch', '103:dispatch', '104:claimed', '105:claimed', '106:dispatch']);
  expect(partial.decisions[3]).toMatchObject({ detail: expect.stringContaining('#105') });
  expect(partial.units).toEqual([[101, 102], [103], [106]]);
});

test('a bundle unit joins its route classes, and a mixed tier, a missing tier or a frontend mix skips the whole unit without a seat', () => {
  const unit = (first: BoardSubIssueReadV1, second: BoardSubIssueReadV1) => planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [],
    parent: read([first, second, medium('route:simple_fast')(103)], 1, [[101, 102], 103]) });
  const escalated = unit(medium('route:simple_deep')(101), medium('route:important_fast')(102));
  expect(escalated.decisions.slice(0, 2).map(decision => decision.action === 'dispatch' && decision.route_class)).toEqual(['important_deep', 'important_deep']);
  for (const [first, second, reason] of [
    [issue(101, { labels: ['route:simple_fast', 'tier:high'] }), medium('route:simple_fast')(102), 'tier_mixed'],
    [medium('route:simple_fast')(101), issue(102, { labels: ['route:simple_fast'] }), 'tier_invalid'],
    [medium('route:simple_fast')(101), issue(102, { labels: ['route:simple_fast', 'tier:low', 'tier:medium'] }), 'tier_invalid'],
    [medium('route:frontend')(101), medium('route:simple_fast')(102), 'route_conflict'],
  ] as const) expect(reasons(unit(first, second))).toEqual([`101:${reason}`, `102:${reason}`, '103:dispatch']);
  expect(bundleRouteClass(['frontend', 'frontend'])).toEqual({ kind: 'frontend' });
  expect(bundleRouteClass(['simple_fast', 'simple_fast'])).toEqual({ kind: 'simple_fast' });
});

test('a unit is its open members: a closed member does not stop it and gets no claim or Closes line', async () => {
  const parent = read([medium('route:important_deep')(101), medium('route:important_deep', { state: 'closed' })(102)], 2, [[101, 102]]);
  for (const bundle of [undefined, [101, 102]]) {
    const plan = planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent, ...(bundle === undefined ? {} : { bundle }) });
    expect([reasons(plan), plan.units]).toEqual([['101:dispatch', '102:closed'], [[101]]]);
    const bodies: string[] = [];
    const tasks: string[] = [];
    const run = ports({ comment: (_issue, body) => { bodies.push(body); return 'claim'; }, openTab: args => { tasks.push(String(args.task)); } });
    expect((await executeDispatch(plan, context, run.base)).map(entry => entry.issue)).toEqual([101]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('Issues:');
    expect(tasks[0]).toStartWith('Task: issue #101 ');
  }
});

function ports(overrides: Partial<DispatchPorts> = {}) {
  const calls: string[] = [];
  const base: DispatchPorts = {
    startWorktree: issueNumber => { calls.push(`worktree ${issueNumber}`); return { path: `/tmp/wt-${issueNumber}`, branch: `feat/${issueNumber}` }; },
    comment: (issueNumber, body) => { calls.push(`comment ${issueNumber}: ${body.split('\n')[0]} ${body.split('\n').find(line => line.startsWith('Status:'))}`); return `https://example.test/claim-${issueNumber}`; },
    openTab: args => { calls.push(`tab ${String(args.folder)}`); },
    launch: async () => ({ argv: ['agent'], tab: 'tab-name', runtime: 'claude' }),
    ...overrides,
  };
  return { calls, base };
}
const context = { repositoryId: '9', parent: 100, space: 's1', dry_run: false, model: (): string | null => 'opus' };
const planOf = (labels: string[]): DispatchPlanV1 => planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent: read([issue(1, { labels })]) });

test('execute starts the worktree, posts the claim, then opens the tab; a dry run writes nothing', async () => {
  const run = ports();
  const started = await executeDispatch(planOf(['route:important_deep']), context, run.base);
  expect(started.map(entry => entry.claim_url)).toEqual(['https://example.test/claim-1']);
  expect(run.calls).toEqual(['worktree 1', 'comment 1: repo-harness issue claim Status: active', 'tab /tmp/wt-1']);
  const dry = ports();
  expect(await executeDispatch(planOf(['route:important_deep']), { ...context, dry_run: true }, dry.base)).toEqual([]);
  expect(dry.calls).toEqual([]);
});

test('dispatch writes the earliest active coordinator claim URL', async () => {
  const parent = read([issue(1)]);
  const newer = comment('repo-harness issue claim\nStatus: active\nRole: coordinator', '2026-11-09T11:00:00Z');
  const released = comment('repo-harness issue claim\nStatus: active\nRole: coordinator', '2026-11-09T12:00:00Z');
  const status = comment(`repo-harness issue claim status\nClaim: ${released.url}\nStatus: released`, '2026-11-09T13:00:00Z');
  const plan = planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent: { ...parent, parent: { ...parent.parent, comments: { truncated: false, comments: [...parent.parent.comments.comments, newer, released, status] } } } });
  let body = '';
  const run = ports({ comment: (_issue, text) => { body = text; return 'claim'; } });
  await executeDispatch(plan, context, run.base);
  expect(body).toContain(`\nCoordinator: ${coordinator.url}\n`);
});

test('the claim names the model from the context; a seat with no model writes no Model line', async () => {
  const bodies: string[] = [];
  const run = ports({ comment: (_issue, text) => { bodies.push(text); return 'claim'; } });
  await executeDispatch(planOf(['route:important_deep']), context, run.base);
  await executeDispatch(planOf(['route:important_deep']), { ...context, model: () => null }, run.base);
  expect(bodies.map(body => body.split('\n').filter(line => line.startsWith('Model: ')))).toEqual([['Model: opus'], []]);
  // A user-set id can be a pasted secret (#3250), even one whose last segment looks like a model family: the claim names the seat field, in the Model and the Dispatch reading lines.
  const secret = 'magpie/o3sk-live-0123456789';
  const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-opus': { ...DEFAULT_SEATS_CONFIG['worker-opus'], model: secret } };
  await executeDispatch(planDispatch({ seats, quota: NORMAL, terminals: [], parent: read([issue(1, { labels: ['route:important_deep'] })]) }), { ...context, model: () => secret }, run.base);
  expect(bodies[2]).not.toContain(secret);
  expect(bodies[2]).toContain('\nModel: seats.worker-opus.model\n');
  expect(bodies[2]).toContain('Dispatch reading: route important_deep: worker-opus (claude seats.worker-opus.model');
});

test('dispatch refuses before any writes without an active coordinator claim', async () => {
  const parent = read([issue(1)]);
  const status = comment(`repo-harness issue claim status\nClaim: ${coordinator.url}\nStatus: released`);
  const plan = planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent: { ...parent, parent: { ...parent.parent, comments: { truncated: false, comments: [...parent.parent.comments.comments, status] } } } });
  const run = ports();
  await expect(executeDispatch(plan, context, run.base)).rejects.toThrow(/no active coordinator claim/);
  expect(run.calls).toEqual([]);
});

test('a released successor does not reactivate its predecessor; dry run reports truncated comments', async () => {
  const parent = read([issue(1)]);
  const successor = comment(`repo-harness issue claim\nStatus: active\nRole: coordinator\nPrior claim: ${coordinator.url}`, '2026-11-09T11:00:00Z');
  const status = comment(`repo-harness issue claim status\nClaim: ${successor.url}\nStatus: released`, '2026-11-09T12:00:00Z');
  const plan = planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent: { ...parent, parent: { ...parent.parent, comments: { truncated: true, comments: [...parent.parent.comments.comments, successor, status] } } } });
  const run = ports();
  for (const dry_run of [false, true]) {
    await expect(executeDispatch(plan, { ...context, dry_run }, run.base)).rejects.toThrow(/no active coordinator claim.*older parent comments were not read/);
  }
  expect(run.calls).toEqual([]);
});

test('coordinator ties use comment IDs and a handoff selects the successor', () => {
  const parent = read([issue(1)]);
  const first = { ...coordinator, url: 'https://github.com/o/r/issues/100#issuecomment-9' };
  const second = { ...coordinator, url: 'https://github.com/o/r/issues/100#issuecomment-10' };
  const selected = (claims: BoardCommentV1[]) => planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent: { ...parent, parent: { ...parent.parent, comments: { truncated: false, comments: [comment(planBody(4)), ...claims] } } } }).coordinator;
  expect(selected([second, first])).toBe(first.url);
  expect(selected([first, { ...second, body: `${second.body}\nPrior claim: ${first.url}` }])).toBe(second.url);
});

test('the packet carries the worker Authority line, and templates.md quotes the same text', async () => {
  const tasks: string[] = [];
  const run = ports({ openTab: args => { tasks.push(String(args.task)); } });
  await executeDispatch(planOf(['route:important_deep']), context, run.base);
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toContain(`Authority: ${WORKER_AUTHORITY}`);
  const templates = readFileSync(join(import.meta.dir, '..', 'assets/skills/repo-harness-issue-flow/references/templates.md'), 'utf8');
  expect(templates).toContain(`\nAuthority: ${WORKER_AUTHORITY}\n`);
});

test('a tab failure before the request releases the claim; an ambiguous one keeps it and reports launch_unknown', async () => {
  const fail = (reason: 'missing' | 'timeout') => ports({ openTab: () => { throw new HerdrCoreError('herdr-app', reason); } });
  const before = fail('missing');
  await expect(executeDispatch(planOf(['route:important_deep']), context, before.base)).rejects.toBeInstanceOf(HerdrCoreError);
  expect(before.calls.at(-1)).toBe('comment 1: repo-harness issue claim status Status: released');
  const ambiguous = fail('timeout');
  await expect(executeDispatch(planOf(['route:important_deep']), context, ambiguous.base)).rejects.toThrow(/launch_unknown for #1/);
  expect(ambiguous.calls.some(call => call.includes('released'))).toBe(false);
});

test('a credentials issue whose launch resolves to Pi starts no claim and no tab', async () => {
  const run = ports({ launch: async () => ({ argv: ['agent'], tab: null, runtime: 'pi' }) });
  await expect(executeDispatch(planOf(['route:important_deep', 'touches:credentials']), context, run.base)).rejects.toThrow(/Pi seat/);
  expect(run.calls).toEqual(['worktree 1']);
});

test('a seat comment gets the Seat line only when the seat env and the hc address are both set', () => {
  expect(withSeatLine('body', { REPO_HARNESS_SEAT: 'advisor', HC_TERMINAL_ID: 't5' })).toBe('body\nSeat: advisor t5');
  expect(withSeatLine('body', { REPO_HARNESS_SEAT: 'advisor' })).toBe('body');
  expect(withSeatLine('body', { HC_TERMINAL_ID: 't5' })).toBe('body');
});

test('the plan starts one worktree and one tab with a bundle claim on each issue of a unit; --issues starts only as a whole and releases every claim when the tab fails before the request', async () => {
  const parent = read([1, 2, 3, 4, 5].map(medium('route:important_deep')), 2, [[1, 3], 5, [2, 4]]);
  const bundlePlan = (bundle?: number[]) => planDispatch({ seats: DEFAULT_SEATS_CONFIG, quota: NORMAL, terminals: [], parent, ...(bundle === undefined ? {} : { bundle }) });
  const bodies: string[] = [];
  const tasks: string[] = [];
  const run = ports({ comment: (issueNumber, body) => { bodies.push(body); run.calls.push(`comment ${issueNumber}`); return `https://example.test/claim-${issueNumber}`; },
    openTab: args => { tasks.push(String(args.task)); run.calls.push(`tab ${String(args.folder)}`); } });
  // Default dispatch: the unit [1, 3] and the unit [5] take the two seats; the held unit [2, 4] starts nothing and throws nothing.
  const started = await executeDispatch(bundlePlan(), context, run.base);
  expect(run.calls).toEqual(['worktree 1', 'comment 1', 'comment 3', 'tab /tmp/wt-1', 'worktree 5', 'comment 5', 'tab /tmp/wt-5']);
  expect(started.map(entry => [entry.issue, entry.worktree])).toEqual([[1, '/tmp/wt-1'], [3, '/tmp/wt-1'], [5, '/tmp/wt-5']]);
  expect(bodies.slice(0, 2).map(body => body.split('\n').filter(line => /^(Issues|Branch): /u.test(line)))).toEqual([['Branch: feat/1', 'Issues: #1, #3'], ['Branch: feat/1', 'Issues: #1, #3']]);
  expect(tasks[0]).toContain('Closes #1 / Closes #3');
  const held = ports();
  await expect(executeDispatch(bundlePlan([2, 4]), context, held.base)).rejects.toThrow(/starts only as a whole; #2 held/);
  expect(held.calls).toEqual([]);
  const lost = ports({ openTab: () => { throw new HerdrCoreError('herdr-app', 'missing'); } });
  await expect(executeDispatch(bundlePlan([1, 3]), context, lost.base)).rejects.toBeInstanceOf(HerdrCoreError);
  expect(lost.calls.slice(-2)).toEqual(['comment 1: repo-harness issue claim status Status: released', 'comment 3: repo-harness issue claim status Status: released']);
});

test('executeDispatch passes -i <task> in argv and omits task when launching an agy worker seat', async () => {
  const tabs: Record<string, unknown>[] = [];
  const run = ports({
    launch: async () => ({ argv: ['agy', '--model', 'gemini-4-neon-high'], tab: '#100', runtime: 'agy' }),
    openTab: args => { tabs.push({ ...args }); },
  });
  await executeDispatch(planOf(['route:important_deep']), context, run.base);
  expect(tabs).toHaveLength(1);
  expect(tabs[0]!.task).toBeUndefined();
  expect((tabs[0]!.argv as string[]).slice(0, 4)).toEqual(['agy', '--model', 'gemini-4-neon-high', '-i']);
  expect((tabs[0]!.argv as string[])[4]).toContain('Task: issue #1 ');
});

test.skipIf(process.platform === 'win32')('runDispatch includes agy probes and dispatches a healthy native agy worker seat, while skipping read-only legacy agy workers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dispatch-agy-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, '.repo-harness'), { recursive: true });
    const agy = join(bin, 'agy');
    writeFileSync(agy, `#!${process.execPath}
${agyCatalogScript([{ id: 'gemini-4-neon', efforts: ['high'] }, { id: 'gemini-4-hydrogen', efforts: ['high'] }],
  undefined, "process.exit(command === 'models' ? 0 : 93);")}
`, { mode: 0o755 });
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: [bin, '/usr/bin', '/bin'].join(delimiter),
      TMPDIR: home,
      OAR_ANTIGRAVITY_BIN: agy,
    };
    const ghRunner = (args: readonly string[]) => {
      if (args.includes('repos/{owner}/{repo}')) return { status: 0, stdout: JSON.stringify({ id: 1 }), stderr: '' };
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          data: {
            repository: {
              databaseId: 1,
              nameWithOwner: 'o/r',
              defaultBranchRef: { name: 'main' },
              issue: {
                number: 100,
                title: 'parent',
                url: 'https://github.com/o/r/issues/100',
                state: 'OPEN',
                labels: { pageInfo: { hasNextPage: false }, nodes: [] },
                milestone: null,
                comments: {
                  pageInfo: { hasPreviousPage: false, startCursor: null },
                  nodes: [
                    { url: coordinator.url, createdAt: coordinator.created_at, authorAssociation: 'OWNER', body: coordinator.body },
                    { url: 'https://example.test/plan', createdAt: '2026-11-09T10:00:00Z', authorAssociation: 'OWNER', body: planBody(4, [1]) },
                  ],
                },
                subIssues: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{
                    number: 1,
                    title: 'issue 1',
                    url: 'https://github.com/o/r/issues/1',
                    state: 'OPEN',
                    labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'route:simple_deep' }] },
                    milestone: null,
                    comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
                    blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
                    timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
                  }],
                },
              },
            },
            repairs: { issueCount: 0, nodes: [] },
          },
        }),
      };
    };
    const host = {
      seatTerminals: () => ({ status: 'observed' as const, terminals: [] }),
    } as unknown as Parameters<typeof runDispatch>[0]['host'];
    const baseInput = {
      repo_root: home,
      repository: 'o/r',
      parent: 100,
      space: 's1',
      host,
      launch: async () => ({ argv: ['agy'], tab: '#100', runtime: 'agy' as const }),
      dry_run: true,
      bundle: null,
      gh_runner: ghRunner,
      env,
    };

    // Writable native agy worker-neon is probed and dispatched (not skipped as unknown / no_route).
    const nativeOnly = {
      ...NATIVE_SEATS_PRESET,
      routing: { ...NATIVE_SEATS_PRESET.routing, simple_deep: ['worker-neon'] as const },
    };
    writeFileSync(join(home, '.repo-harness', 'config.json'), JSON.stringify({
      agents: { enabled: ['antigravity', 'claude', 'codex'], uses: { docs: [], review: [] }, default_docs: null },
      seats: nativeOnly,
    }));
    const writable = await runDispatch(baseInput);
    expect(writable.plan.decisions[0]).toMatchObject({ action: 'dispatch', issue: 1, seat: 'worker-neon', route_class: 'simple_deep' });

    // Legacy read-only agy worker-neon (main@76675c2 shape) is skipped cleanly with actionable guidance.
    const readonlyLegacy = {
      ...nativeOnly,
      'worker-neon': { ...nativeOnly['worker-neon'], tools: ['net', 'read', 'shell'] as const },
    };
    writeFileSync(join(home, '.repo-harness', 'config.json'), JSON.stringify({
      agents: { enabled: ['antigravity', 'claude', 'codex'], uses: { docs: [], review: [] }, default_docs: null },
      seats: readonlyLegacy,
    }));
    const skipped = await runDispatch(baseInput);
    expect(skipped.plan.decisions[0]).toMatchObject({
      action: 'skip',
      issue: 1,
      reason: 'no_route',
      detail: expect.stringContaining('worker-neon is configured read-only (missing edit)'),
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
