import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReviewPacket, planReview, reviewPacket, type ReviewDecisionV1, type ReviewSeat } from '../src/core/board/review';
import { executeReview, matchingWorkerTerminals, withReviewLock, type ReviewPorts } from '../src/effects/board/review';
import { AGY_REVIEW_LAUNCH_ENV, AGY_REVIEW_LAUNCH_LINE, AGY_REVIEW_PROMPT_OPTION } from '../src/effects/board/agy-review-session';
import { effectiveGatekeeper, seatAccountQuotas } from '../src/core/board/seat-routing';
import { HerdrCoreError, RH_LABEL, seatLoginShell, type HerdrAppTab, type HerdrSeatPlacement } from '../src/effects/terminal/herdr-core';
import type { BoardPullRequestV1, BoardSeatTerminalReadV1, BoardV1 } from '../src/core/board/board';
import type { BoardCommentPageV1, BoardCommentV1, BoardPullRequestReadV1 } from '../src/core/board/source';
import { parseAcceptanceRecord, renderAcceptanceDispositionComment } from '../src/core/board/protocol-comments';
import { labeledSeatArgv, SeatProviderUnavailableError } from '../src/cli/commands/seats';
import type { SeatRouteV1 } from '../src/core/board/seat-routing';
import { DEFAULT_SEATS_CONFIG, type SeatConfigV1, type SeatId } from '../src/core/board/seats-settings';
import { acceptance, gatekeeperReview, reviewRule, secondReview } from '../src/core/board/review-rules';
import { renderAcceptanceClaim, renderAcceptanceRecord, type ReviewPublishReceipt } from '../src/core/review/review-publish';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const pr = (number: number, extra: Partial<BoardPullRequestV1> = {}): BoardPullRequestV1 => ({
  number, url: '', state: 'open', is_draft: false, base_ref: 'main', base_sha: SHA, head_ref: `feat/${number}`, head_sha: SHA, head_committed_at: '', merged_at: null,
  closes: [number * 10], refs: [], files: [], cleared_hazard_paths: [], required_check: { status: 'success', completed_at: '', contexts: [] }, acceptance: { status: 'not_accepted' }, merge_readiness: null, merge_readiness_observed_at: null,
  tier: 'high', second_review: 'not_required', gatekeeper_review: 'none', writer_family: null, merge_hold: { status: 'none' }, review_fail: null, review_records: { status: 'observed', gatekeeper: null, reviewer: null, head: { gatekeeper: false, reviewer: false } }, open_questions: { status: 'observed', questions: [] }, ...extra,
});
const board = (prs: BoardPullRequestV1[], holds: { issue: number; reason: string }[] = []): BoardV1 =>
  ({ pull_requests: prs, parent: { number: 1 }, plan: { status: 'observed', block: { holds } } }) as unknown as BoardV1;
const comment = (body: string, url = 'https://example.test/c'): BoardCommentV1 => ({ url, created_at: '2026-11-09T10:00:00Z', author_association: 'OWNER', body });
const marker = (head: string, url = 'https://example.test/m1', seat = 'gatekeeper') => comment(`repo-harness review start\nSubject: ${head}\nSeat: ${seat}`, url);
const record = (head: string, role = 'pi (gpt-6.1-sol)', verdict: 'PASS' | 'FAIL' = 'FAIL', seat?: 'gatekeeper' | 'reviewer') =>
  comment(`repo-harness acceptance record\n${seat === undefined ? '' : `Seat: ${seat}\n`}\n| Round | Role | Subject | Verdict |\n|---|---|---|---|\n| 1 | ${role} | \`${head}\` | ${verdict}: 1 P1 |`);
const page = (...comments: BoardCommentV1[]): BoardCommentPageV1 => ({ truncated: false, comments });

const GATEKEEPER: SeatRouteV1 = { id: 'gatekeeper', seat: DEFAULT_SEATS_CONFIG.gatekeeper, line: 'gatekeeper: gatekeeper (codex gpt-6.1-terra high)' };
function plan(prs: BoardPullRequestV1[], comments: BoardCommentPageV1 = page(), holds: { issue: number; reason: string }[] = [], gatekeeper = GATEKEEPER, reviewer: SeatConfigV1 = DEFAULT_SEATS_CONFIG.reviewer): readonly ReviewDecisionV1[] {
  return planReview({ board: board(prs, holds), comments: new Map(prs.map(entry => [entry.number, comments])), gatekeeper, reviewer });
}
const label = (decisions: readonly ReviewDecisionV1[]) => decisions.map(decision => decision.action === 'skip' ? `${decision.pr}:${decision.reason}` : `${decision.pr}:start`);

test('a ready, green pull request starts; every other state is skipped with its reason', () => {
  expect(label(plan([
    pr(1), pr(2, { is_draft: true }), pr(3, { required_check: { status: 'failure', completed_at: '', contexts: [] } }),
    pr(4, { acceptance: { status: 'accepted', via: 'record', accepted_at: '', evidence_url: '' } }), pr(5, { tier: 'low' }), pr(6, { state: 'closed' }),
    pr(7, { acceptance: { status: 'unknown', reason: 'comments_truncated', evidence_url: null } }),
  ]))).toEqual(['1:start', '2:draft', '3:ci_not_green', '4:accepted', '5:accepted', '6:not_open', '7:acceptance_unknown']);
});

const seatsOf = (decision: ReviewDecisionV1 | undefined) => decision?.action === 'start' ? decision.seats.map(entry => entry.seat) : [];

test('an unknown tier is reviewed as High; a head that no seat reviewed starts both seats, and the reviewer alone after a gatekeeper PASS', () => {
  const [start] = plan([pr(1, { tier: null, second_review: 'pending' })]);
  expect(start).toMatchObject({ action: 'start', tier: 'high' });
  expect(seatsOf(start)).toEqual(['gatekeeper', 'reviewer']);
  // A gatekeeper PASS of the head, also a carried one: that run starts the reviewer only.
  expect(seatsOf(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], page(record(SHA, undefined, 'PASS', 'gatekeeper')))[0])).toEqual(['reviewer']);
  // A gatekeeper FAIL of the head starts no reviewer: the fix goes back to the gatekeeper.
  expect(seatsOf(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'fail' })])[0])).toEqual(['gatekeeper']);
  expect(seatsOf(plan([pr(1, { tier: 'high', second_review: 'recorded', gatekeeper_review: 'pass' })])[0])).toEqual(['gatekeeper']);
});

test('a Medium head prefers the gatekeeper unless the writer shares its family; an unknown writer family starts none', () => {
  const medium = (writer_family: BoardPullRequestV1['writer_family']) => plan([pr(1, { tier: 'medium', writer_family })]);
  expect(medium('anthropic')[0]).toMatchObject({ action: 'start', seats: [{ seat: 'gatekeeper' }] });
  expect(medium('google')[0]).toMatchObject({ action: 'start', seats: [{ seat: 'gatekeeper' }] });
  expect(medium('zhipu')[0]).toMatchObject({ action: 'start', seats: [{ seat: 'gatekeeper' }] });
  expect(medium('deepseek')[0]).toMatchObject({ action: 'start', seats: [{ seat: 'gatekeeper' }] });
  expect(medium('openai')[0]).toMatchObject({ action: 'start', seats: [{ seat: 'reviewer' }] });
  expect(label(medium(null))).toEqual(['1:writer_family_unknown']);
  const pull = pr(1, { tier: 'medium', writer_family: 'anthropic', second_review: 'pending' });
  const active = { ...board([pull]), autopilot: { low_tier_skip: true } };
  expect(seatsOf(planReview({ board: active, comments: new Map([[1, page()]]), gatekeeper: GATEKEEPER })[0])).toEqual(['gatekeeper', 'reviewer']);
});

test('a pull request that links a plan-held issue is skipped; the others still start', () => {
  expect(label(plan([pr(1), pr(2)], page(), [{ issue: 10, reason: 'owner decision' }]))).toEqual(['1:plan_hold', '2:start']);
});

test('an absent plan skips every pull request of a parent with more than two children and none of a smaller parent', () => {
  const unplanned = (children: number) => ({ ...board([pr(1), pr(2)]), items: Array.from({ length: children }, (_, at) => ({ number: 10 + at })), plan: { status: 'absent', truncated: false } }) as unknown as BoardV1;
  const comments = new Map([[1, page()], [2, page()]]);
  expect(label(planReview({ board: unplanned(3), comments, gatekeeper: GATEKEEPER }))).toEqual(['1:plan_unavailable', '2:plan_unavailable']);
  expect(planReview({ board: unplanned(3), comments, gatekeeper: GATEKEEPER })[0])
    .toMatchObject({ reason: 'plan_unavailable', detail: 'the plan is absent and #1 has 3 children; a parent with more than two children needs a plan' });
  expect(label(planReview({ board: unplanned(2), comments, gatekeeper: GATEKEEPER }))).toEqual(['1:start', '2:start']);
});

test('an unavailable plan names why the plan block does not decode', () => {
  const reason = 'plan block invalid: unsupported protocol 1';
  const undecoded = { ...board([pr(1)]), plan: { status: 'unavailable', comment_url: 'https://example.test/p1', reason } } as unknown as BoardV1;
  expect(planReview({ board: undecoded, comments: new Map([[1, page()]]), gatekeeper: GATEKEEPER })[0])
    .toMatchObject({ action: 'skip', reason: 'plan_unavailable', detail: `the plan is unavailable: ${reason}` });
});

test('a marker covers one seat: a started gatekeeper leaves the reviewer of a fresh head free, and a marker without a seat covers none', () => {
  const pending = pr(1, { second_review: 'pending' });
  // No gatekeeper row yet: the reviewer still starts beside the started gatekeeper.
  expect(seatsOf(plan([pending], page(marker(SHA)))[0])).toEqual(['reviewer']);
  // A gatekeeper FAIL of the head holds the reviewer until a PASS.
  expect(plan([{ ...pending, gatekeeper_review: 'fail' }], page(marker(SHA)))[0]).toMatchObject({ reason: 'started', detail: `the gatekeeper started for ${SHA} and recorded fail; the reviewer starts after a PASS` });
  expect(seatsOf(plan([{ ...pending, gatekeeper_review: 'pass' }], page(marker(SHA), record(SHA, undefined, 'PASS')))[0])).toEqual(['reviewer']);
  expect(label(plan([{ ...pending, gatekeeper_review: 'pass' }], page(marker(SHA), marker(SHA, 'https://example.test/m2', 'reviewer'))))).toEqual(['1:started']);
  expect(seatsOf(plan([pr(1)], page(comment(`repo-harness review start\nSubject: ${SHA}`)))[0])).toEqual(['gatekeeper']);
});

test('a start marker covers its head; a truncated or missing comment page starts nothing', () => {
  expect(label(plan([pr(1)], page(marker(SHA))))).toEqual(['1:started']);
  expect(label(planReview({ board: board([pr(1)]), comments: new Map(), gatekeeper: GATEKEEPER }))).toEqual(['1:started']);
  expect(label(plan([pr(1)], { truncated: true, comments: [] }))).toEqual(['1:started']);
});

test('a released marker frees its head', () => {
  const released = comment('repo-harness review start status\nClaim: https://example.test/m1\nStatus: released', 'https://example.test/s');
  expect(label(plan([pr(1)], page(marker(SHA), released)))).toEqual(['1:start']);
});

test('the delta base of a seat is an earlier head that the seat reviewed by Seat:, start marker, or legacy model family; otherwise the whole diff', () => {
  const seatConfig = (model: string | null): SeatConfigV1 => ({ ...DEFAULT_SEATS_CONFIG.reviewer, runtime: model === null || model.startsWith('claude') || model === 'opus' ? 'claude' : 'pi', model });
  const base = (seat: ReviewSeat, comments: BoardCommentPageV1, reviewerModel: string | null = 'opus') => {
    const reviewerStart = seat === 'reviewer';
    const evidence = reviewerStart ? page(...comments.comments, record(SHA, undefined, 'PASS', 'gatekeeper')) : comments;
    const started = plan([pr(1, { second_review: 'pending', gatekeeper_review: reviewerStart ? 'pass' : 'none' })], evidence, [], GATEKEEPER, seatConfig(reviewerModel))[0];
    const entry = started.action === 'start' ? started.seats.find(candidate => candidate.seat === seat) : undefined;
    return entry === undefined ? `not ${seat}` : entry.delta_from;
  };
  const reviewerMarker = marker(OLD, 'https://example.test/m2', 'reviewer');
  const both = (comments: BoardCommentPageV1, reviewerModel: string | null = 'opus') => [base('gatekeeper', comments, reviewerModel), base('reviewer', comments, reviewerModel)];
  expect(both(page(marker(OLD)))).toEqual([null, null]);
  // One live start marker on OLD establishes the row's seat; a second marker on OLD leaves an unestablished row to model-family matching.
  expect(both(page(marker(OLD), record(OLD)))).toEqual([OLD, null]);
  expect(both(page(marker(OLD), reviewerMarker, record(OLD, 'claude (opus)')))).toEqual([null, OLD]);
  expect(both(page(marker(OLD), reviewerMarker, record(OLD, 'acceptor')))).toEqual([null, null]);
  // Explicit Seat: header overrides model-family attribution (e.g. a Pi DeepSeek reviewer vs a Pi DeepSeek gatekeeper-fallback).
  expect(both(page(marker(OLD), reviewerMarker, record(OLD, 'pi (magpie/cursor/deepseek-v41-flash-1017)', 'FAIL', 'reviewer')))).toEqual([null, OLD]);
  expect(both(page(marker(OLD), reviewerMarker, record(OLD, 'pi (magpie/cursor/deepseek-v41-flash-1017)', 'FAIL', 'gatekeeper')))).toEqual([OLD, null]);
  // Pre-#3353 legacy records without Seat: on a two-marker head still attribute via configured seat families.
  expect(both(page(marker(OLD), reviewerMarker, record(OLD, 'pi (magpie/cursor/deepseek-v41-flash-1017)')), 'magpie/cursor/deepseek-v41-flash-1017')).toEqual([null, OLD]);
  expect(both(page(marker(OLD), reviewerMarker, record(OLD)), 'magpie/cursor/deepseek-v41-flash-1017')).toEqual([OLD, null]);
});

function ports(overrides: Partial<ReviewPorts> = {}): ReviewPorts & { comments: string[]; tabs: Record<string, unknown>[] } {
  const comments: string[] = [];
  const tabs: Record<string, unknown>[] = [];
  return {
    comments, tabs,
    worktree: () => ({ path: '/tmp/w' }),
    comment: (_pr, body) => { comments.push(body); return `https://example.test/c${comments.length}`; },
    listSpaceTabs: () => [],
    seatTerminals: () => [],
    placePane: placement => { if (placement.command === 'tab.new') tabs.push(placement.args); },
    launch: async seat => ({ argv: ['agent'], tab: 'review', runtime: seat === 'reviewer' ? 'claude' : 'codex' }),
    ...overrides,
  };
}
const high = plan([pr(1)]);
const context = { repositoryId: '1', parent: 100, space: 's', dry_run: false, gatekeeper: GATEKEEPER };

test('each required seat opens its tab with its launch argv in the writer worktree, after its own marker; the launch gets the planned gatekeeper', async () => {
  const seats: string[] = [];
  const routes: SeatRouteV1[] = [];
  const p = ports({ launch: async (seat, _labels, _cwd, gatekeeper) => { seats.push(seat); routes.push(gatekeeper); return { argv: [seat], tab: seat, runtime: seat === 'reviewer' ? 'claude' : 'codex' }; } });
  // A High head that no seat reviewed starts both seats in one run (#3190 section 2.3).
  const pending = pr(1, { second_review: 'pending' });
  expect(await executeReview(plan([pending]), context, p)).toMatchObject({ started: [{ pr: 1, seat: 'gatekeeper' }, { pr: 1, seat: 'reviewer' }] });
  expect(seats).toEqual(['gatekeeper', 'reviewer']);
  expect(routes[0]).toBe(GATEKEEPER);
  expect(p.comments[0]).toContain(`Subject: ${SHA}\nSeat: gatekeeper`);
  expect(p.comments[1]).toContain('Seat: reviewer');
  expect(p.tabs[1]).toMatchObject({ argv: ['reviewer'], folder: '/tmp/w', name: 'reviewer', space: 's' });
});

test('a signed-out reviewer leaves the whole High start decision without markers or tabs', async () => {
  const unavailable = new SeatProviderUnavailableError('The reviewer seat cannot launch. claude: Runtime signed out.');
  const checked: SeatId[] = [];
  const p = ports({ launch: async seat => {
    checked.push(seat);
    if (seat === 'reviewer') throw unavailable;
    return { argv: [seat], tab: seat, runtime: 'codex' };
  } });
  const decisions = plan([pr(1, { second_review: 'pending' })]);
  await expect(executeReview(decisions, context, p)).rejects.toBe(unavailable);
  expect(checked).toEqual(['gatekeeper', 'reviewer']);
  expect([p.comments, p.tabs]).toEqual([[], []]);
});

// Native gatekeeper-fallback launch (#3448).
test('agy still refuses a primary gatekeeper or reviewer before the marker or tab', async () => {
  const expectedMessage = 'agy review launches require the effective gatekeeper-fallback seat.';
  const decisions = plan([pr(1, { second_review: 'pending' })]);
  for (const agySeat of ['gatekeeper', 'reviewer']) {
    const p = ports({ launch: async seat => ({ argv: [seat], tab: seat, runtime: seat === agySeat ? 'agy' : 'codex' }) });
    await expect(executeReview(decisions, context, p)).rejects.toThrow(expectedMessage);
    expect([p.comments, p.tabs]).toEqual([[], []]);
  }
});

function nativeGatekeeperRoute() {
  const seats = { ...DEFAULT_SEATS_CONFIG, 'gatekeeper-fallback': {
    ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'agy', model: 'gemini-4-hydrogen-high', effort: null,
  } } as const;
  const quotas = seatAccountQuotas([], seats.routing);
  return effectiveGatekeeper(seats, { ...quotas,
    chatgpt: { ...quotas.chatgpt, state: 'exhausted', remaining: 0 },
    agy_gemini: { state: 'normal', remaining: 90, mode: 'normal' },
  });
}

test.skipIf(process.platform === 'win32').each([0, 1])('an agy launch reports the production seat labeling result (hc exit %i)', async (bindExit) => {
  const gatekeeper = nativeGatekeeperRoute();
  expect(gatekeeper.id).toBe('gatekeeper-fallback');
  const root = mkdtempSync(join(tmpdir(), 'rh-agy-review-'));
  const hc = join(root, 'hc');
  const agy = join(root, 'agy');
  const labelCalls = join(root, 'labels');
  const env = { HOME: root, ZDOTDIR: root, PATH: `${root}:/usr/bin:/bin`, HC_TERMINAL_ID: 't9' };
  writeFileSync(hc, `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const [command, json, separator, address, ...pairs] = process.argv.slice(2);
appendFileSync(${JSON.stringify(labelCalls)}, JSON.stringify([command, json, separator, address, ...pairs]) + '\\n');
if (${bindExit}) process.exit(${bindExit});
const labels = Object.fromEntries(pairs.map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
console.log(JSON.stringify({ address, state: 'live', turn: 0, labels }));
`, { mode: 0o700 });
  writeFileSync(agy, `#!/bin/sh\nprintf '%s\\n' "$${AGY_REVIEW_LAUNCH_ENV}"\n`, { mode: 0o700 });
  const tab = Promise.withResolvers<Readonly<Record<string, unknown>>>();
  const events: string[] = [];
  const p = ports({ agy: { hc, env }, placePane: placement => { if (placement.command === 'tab.new') tab.resolve(placement.args); }, launch: async (seat, labels, _cwd, route) => {
    expect(seat).toBe('gatekeeper');
    expect(route).toBe(gatekeeper);
    return { argv: labeledSeatArgv(seat, labels, [agy, '--agent', 'rh-gatekeeper-fallback'], env, 'new'), tab: 'review', runtime: 'agy' };
  } });
  const decisions = plan([pr(1)], page(), [], gatekeeper);
  const run = executeReview(decisions, { ...context, gatekeeper, observe: ({ kind }) => events.push(kind) }, p);
  try {
    const placement = await Promise.race([tab.promise, run.then(() => { throw new Error('the review finished without placing a tab'); })]);
    expect(placement).toMatchObject({ folder: '/tmp/w', name: 'review', space: 's' });
    expect(placement).not.toHaveProperty('task');
    expect(placement).not.toHaveProperty('labels');
    expect(events).toEqual([]);
    const [shell, ...args] = placement.argv as [string, ...string[]];
    const packet = args.at(-1)!;
    const launchId = packet.split(AGY_REVIEW_LAUNCH_LINE).at(-1)!;
    expect(packet).toContain('"reviewer":{"harness":"agy"');
    expect(args.at(-2)).toBe(AGY_REVIEW_PROMPT_OPTION);
    expect(args).toContain(`${AGY_REVIEW_LAUNCH_ENV}=${launchId}`);
    const expected = { pr: 1, seat: 'gatekeeper', head_sha: SHA, tier: 'high', round: 1 } as const;
    expect(parseReviewPacket(packet)).toEqual(expected);
    const result = spawnSync(shell, args, { env, cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(bindExit);
    const calls: string[][] = readFileSync(labelCalls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.slice(0, -1)).toEqual(['label', '--json', '--', 't9',
      `${RH_LABEL.seat}=gatekeeper`, `${RH_LABEL.repository}=1`, `${RH_LABEL.pr}=1`, `${RH_LABEL.parent}=100`]);
    const binding = call.at(-1)!;
    expect(binding).toStartWith(`${RH_LABEL.agyReview}=${launchId} `);
    expect(parseReviewPacket(binding)).toEqual(expected);
    expect(result.stdout.trim()).toBe(bindExit === 0 ? launchId : '');
    if (bindExit === 0) {
      expect(await run).toMatchObject({ started: [{ pr: 1, seat: 'gatekeeper' }], refused: [] });
      expect(events).toEqual(['started']);
      expect(p.comments).toHaveLength(1);
    } else {
      expect(await run).toMatchObject({ started: [], refused: [{ pr: 1, reason: 'the agy review launch could not bind its terminal' }] });
      expect(events).toEqual(['refused']);
      expect(p.comments[1]).toContain('Claim: https://example.test/c1\nStatus: released');
      const comments = p.comments.map((body, index) => comment(body, `https://example.test/c${index + 1}`));
      expect(plan([pr(1)], page(...comments), [], gatekeeper)[0]).toMatchObject({ action: 'start' });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dry run, and a worktree off the head, write no marker and open no seat', async () => {
  const dry = ports();
  await executeReview(high, { ...context, dry_run: true }, dry);
  const off = ports({ worktree: () => ({ refusal: 'not at head' }) });
  expect(await executeReview(high, context, off)).toMatchObject({ started: [], refused: [{ pr: 1, reason: 'not at head' }] });
  expect([dry.comments, dry.tabs, off.comments, off.tabs]).toEqual([[], [], [], []]);
});

test('a launch that sent nothing releases the marker; an ambiguous one keeps it', async () => {
  const failing = (reason: 'missing' | 'timeout') => ports({ placePane: () => { throw new HerdrCoreError('herdr-app', reason); } });
  const notSent = failing('missing');
  await expect(executeReview(high, context, notSent)).rejects.toThrow();
  expect(notSent.comments[1]).toContain('Claim: https://example.test/c1\nStatus: released');
  const unknown = failing('timeout');
  await expect(executeReview(high, context, unknown)).rejects.toThrow('launch_unknown');
  expect(unknown.comments).toHaveLength(1);
});

test('a reviewer seat on Pi starts after its marker and gets a packet for its own harness', async () => {
  const p = ports({ launch: async seat => ({ argv: [seat], tab: seat, runtime: 'pi' }) });
  const deepseekReviewer: SeatConfigV1 = { ...DEFAULT_SEATS_CONFIG.reviewer, runtime: 'pi', model: 'magpie/cursor/deepseek-v41-flash-1017', effort: null };
  const result = await executeReview(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], page(marker(SHA), record(SHA, 'pi (gpt-6.1-sol)', 'PASS', 'gatekeeper')), [], GATEKEEPER, deepseekReviewer), context, p);
  expect(result.started).toMatchObject([{ seat: 'reviewer' }]);
  expect(p.tabs[0]!.task).toContain('"reviewer":{"harness":"pi"');
});

test('the gatekeeper starts only when the effective gatekeeper is of another known family than the writer, and not Claude where the head needs that', () => {
  const route = (seat: SeatConfigV1, id: SeatRouteV1['id'] = 'gatekeeper-fallback'): SeatRouteV1 => (id === null ? { id, line: 'gatekeeper: none (chatgpt exhausted)' } : { id, seat, line: `gatekeeper: ${id}` });
  const seatConfig = (model: string | null): SeatConfigV1 => ({ ...DEFAULT_SEATS_CONFIG.reviewer, runtime: model === null || model.startsWith('claude') || model === 'opus' ? 'claude' : 'pi', model });
  const pi = route({ ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'pi', model: 'magpie/cursor/deepseek-v41-flash-1017', effort: null });
  const claude = route({ ...DEFAULT_SEATS_CONFIG.reviewer });
  const medium = pr(1, { tier: 'medium', writer_family: 'anthropic' });
  expect(label(plan([medium], page(), [], pi))).toEqual(['1:start']);
  // When the effective gatekeeper matches the writer family, Medium routing falls back to the reviewer seat; it skips only if the reviewer also matches or has no known family.
  expect(plan([medium], page(), [], claude)[0]).toMatchObject({ action: 'skip', reason: 'review_family_unavailable', detail: 'the reviewer family anthropic is the writer family' });
  expect(label(plan([medium], page(), [], claude, seatConfig('gpt-6.1-terra')))).toEqual(['1:start']);
  // A High head with a pending Claude review needs a non-Claude gatekeeper; one with no second review takes a Claude gatekeeper.
  expect(label(plan([pr(1, { second_review: 'pending' }), pr(2)], page(), [], claude))).toEqual(['1:review_family_unavailable', '2:start']);
  // There the Claude reviewer gives the different-family row, so a gatekeeper of the writer family still starts.
  expect(label(plan([pr(1, { writer_family: 'openai', second_review: 'pending' })]))).toEqual(['1:start']);
  expect(label(plan([pr(1, { tier: 'high', writer_family: 'openai' })], page(), [], route({ ...DEFAULT_SEATS_CONFIG.gatekeeper, model: null })))).toEqual(['1:review_family_unavailable']);
  // A gatekeeper model with no known family is named by its field; the route line that holds the value stays out of the skip.
  const pasted = { id: 'gatekeeper', seat: { ...DEFAULT_SEATS_CONFIG.gatekeeper, model: 'sk-live-0123456789' }, line: 'gatekeeper: gatekeeper (codex sk-live-0123456789 high; chatgpt ok)' } as const;
  expect(plan([pr(1, { tier: 'high', writer_family: 'openai' })], page(), [], pasted)[0])
    .toMatchObject({ detail: 'the model of seats.gatekeeper.model has no known family; gatekeeper: gatekeeper' });
  expect(plan([pr(1)], page(), [], route(DEFAULT_SEATS_CONFIG.gatekeeper, null))[0]).toMatchObject({ reason: 'review_family_unavailable', detail: 'no gatekeeper seat can launch; gatekeeper: none (chatgpt exhausted)' });
  // The reviewer and the gatekeeper of one family are not independent; an unknown reviewer family starts no reviewer.
  const sameFamily = plan([pr(1, { second_review: 'pending' })], page(), [], GATEKEEPER, seatConfig('gpt-6.1-terra'))[0];
  expect(sameFamily).toMatchObject({ action: 'skip', reason: 'review_family_unavailable' });
  // After the gatekeeper PASS the reviewer is the seat of the head, so its own family check applies.
  const passedPage = page(marker(SHA), record(SHA, undefined, 'PASS', 'gatekeeper'));
  const passed = (reviewerModel: string | null) => label(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], passedPage, [], GATEKEEPER, seatConfig(reviewerModel)));
  expect(passed('gpt-6.1-terra')).toEqual(['1:review_family_unavailable']);
  expect(passed(null)).toEqual(['1:review_family_unavailable']);
  // The skip names the field, never the value: a credential pasted as the model stays out of the output.
  const unknownReviewer = plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], passedPage, [], GATEKEEPER, seatConfig('sk-live-secret'))[0];
  expect(unknownReviewer).toMatchObject({ detail: 'the model of seats.reviewer.model has no known family, so its row cannot count as another family' });
  expect(passed('magpie/cursor/deepseek-v41-flash-1017')).toEqual(['1:start']);
  // A started gatekeeper counts by its recorded row, not by the current route: a fallback gatekeeper of another family than the reviewer opens the relay; a gatekeeper of the reviewer family does not.
  const fallback = route({ ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'pi', model: 'magpie/cursor/deepseek-v41-flash-1017', effort: null });
  const pending = pr(1, { second_review: 'pending', gatekeeper_review: 'pass' });
  expect(label(plan([pending], page(marker(SHA), record(SHA, 'pi (gpt-6.1-sol)', 'PASS', 'gatekeeper')), [], fallback, seatConfig('magpie/cursor/deepseek-v41-flash-1017')))).toEqual(['1:start']);
  expect(label(plan([pending], page(marker(SHA), record(SHA, 'pi (magpie/cursor/deepseek-v41-flash-1017)', 'PASS', 'gatekeeper')), [], fallback, seatConfig('magpie/cursor/deepseek-v41-flash-1017')))).toEqual(['1:review_family_unavailable']);
  expect(plan([pending], page(marker(SHA), record(SHA, 'pi', 'PASS', 'gatekeeper')))[0]).toMatchObject({
    action: 'skip', reason: 'review_family_unavailable', detail: 'the gatekeeper PASS has no recorded model family',
  });
  // A Medium head written by OpenAI selects the reviewer even if no gatekeeper can launch, and fails closed if reviewer matches writer family.
  expect(label(plan([pr(1, { tier: 'medium', writer_family: 'openai' })], page(), [], route(DEFAULT_SEATS_CONFIG.gatekeeper, null)))).toEqual(['1:start']);
  expect(plan([pr(1, { tier: 'medium', writer_family: 'openai' })], page(), [], GATEKEEPER, seatConfig('gpt-6.1-terra'))[0]).toMatchObject({
    action: 'skip', reason: 'review_family_unavailable', detail: 'the reviewer family openai is the writer family',
  });
  expect(plan([pr(1, { tier: 'medium', writer_family: 'anthropic' })], page(), [], route(DEFAULT_SEATS_CONFIG.gatekeeper, null))[0]).toMatchObject({
    action: 'skip', reason: 'review_family_unavailable', detail: 'no gatekeeper seat can launch; gatekeeper: none (chatgpt exhausted)',
  });
});

test('a disposed gatekeeper FAIL supplies no family to a model-less gatekeeper PASS', () => {
  const url = 'https://github.com/example/repo/pull/1#issuecomment-10';
  const fail = comment(`${record(SHA).body}\n\nFindings:\n\n- P1 resolved-finding at src/review.ts:1: Resolved.`, url);
  const disposition = comment(renderAcceptanceDispositionComment({
    record: url, subject: SHA, findings: ['resolved-finding'], decision: 'https://github.com/example/repo/issues/1#issuecomment-11',
  }));
  const comments = page(fail, disposition, record(SHA, 'pi', 'PASS', 'gatekeeper'));
  const verdict = gatekeeperReview({ head_sha: SHA, comments } as BoardPullRequestReadV1);
  expect(verdict).toBe('pass');
  expect(plan([pr(1, { second_review: 'pending', gatekeeper_review: verdict })], comments)[0]).toMatchObject({
    action: 'skip', reason: 'review_family_unavailable', detail: 'the gatekeeper PASS has no recorded model family',
  });
});

test('a reviewer that sent nothing releases its own marker and leaves the started gatekeeper alone', async () => {
  // The gatekeeper's marker and PASS row of an earlier run stay; only the failed reviewer marker is released.
  const passed = page(marker(SHA), record(SHA, 'pi (gpt-6.1-sol)', 'PASS'));
  const p = ports({ placePane: () => { throw new HerdrCoreError('herdr-app', 'missing'); } });
  await expect(executeReview(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], passed), context, p)).rejects.toThrow();
  expect(p.comments).toHaveLength(2);
  expect(p.comments[1]).toContain('Claim: https://example.test/c1\nStatus: released');
});

test('a second run under the held repository lock starts nothing', async () => {
  const env = { ...process.env, REPO_HARNESS_HOME: mkdtempSync(join(tmpdir(), 'review-lock-')) };
  let ran = 0;
  expect(await withReviewLock('1', async () => withReviewLock('1', async () => { ran += 1; return 'inner'; }, env), env)).toBeNull();
  expect(ran).toBe(0);
  expect(await withReviewLock('1', async () => 'ok', env)).toBe('ok');
});

test('the packet names the round, tier, head, harness and the RECEIPT-JSON hand-off, and parses back', () => {
  const start = (comments: BoardCommentPageV1) => plan([pr(1)], comments)[0] as Extract<ReviewDecisionV1, { action: 'start' }>;
  expect(start(page()).round).toBe(1);
  // The earlier head has a round-1 row, so this head is round 2; a head that a row names keeps that row's round.
  const second = start(page(record(OLD)));
  expect(second.round).toBe(2);
  const text = reviewPacket(second, second.seats[0]!, 'pi');
  const receipt = JSON.parse(text.split('\n').at(-1)!);
  expect(receipt).toMatchObject({ protocol: 3, round: 2, risk_tier: 'high', subject_sha: SHA, reviewer: { harness: 'pi' } });
  expect(text).toContain('Untrusted input that the tool reads in ordinary use (repository content, PR and issue text, tool output) is ordinary use.');
  expect(text).toContain('are P3 notes.');
  expect(text).toContain('Grade only the lines that the PR changes');
  expect(text).toContain('Write at most five P3 notes, one line each.');
  expect(text).toContain('End your last reply with the line RECEIPT-JSON');
  expect(parseReviewPacket(text)).toEqual({ pr: 1, head_sha: SHA, seat: 'gatekeeper', tier: 'high', round: 2 });
  expect(parseReviewPacket(text.replace('as the gatekeeper of', 'as the reviewer of'))?.seat).toBe('reviewer');
  expect(parseReviewPacket(text.replace('as the gatekeeper of', 'as the gatekeeper-deep of'))).toBeNull();
  expect(parseReviewPacket(text.replace('as the gatekeeper of', 'as the worker of'))).toBeNull();
  // A claim that a publish left without its record still counts for the round.
  expect(start(page(comment(`repo-harness acceptance claim\nRound: 2\nSubject: ${OLD}`))).round).toBe(3);
});

test.each([
  ['full review', 'medium', 'reviewer', null, 1, 'Review the whole diff. Group findings by bug family: one finding lists every sibling case.'],
  ['High second review', 'high', 'reviewer', null, 1, 'You are the second review of a High head. Report only I1 and I2 defects, and defects on a configured I3 path. The gatekeeper reviews the rest.'],
  ['fix check', 'high', 'reviewer', OLD, 2, `This is a fix check. Confirm the fix of each earlier blocking finding at this head. An earlier finding stays open only when its own case still fails. Review the hunks that changed since ${OLD}. A new finding blocks only when it is in those hunks and the fix introduced the defect: the trigger reaches the defect at this head and does not reach it at ${OLD}. Every other new finding is at most a P2, also when the fix moved or rewrote the lines of a defect that ${OLD} already had. The exceptions are a P0, and an I1 or I2 finding with a trigger.`],
] as const)('packet scope for %s', (_label, tier, seat, delta_from, round, scope) => {
  const start = { seat, delta_from };
  const decision = { pr: 1, action: 'start', head_ref: 'feat/1', head_sha: SHA, tier, round, seats: [start] } as const;
  const packet = reviewPacket(decision, start, 'pi');
  expect(packet.split('\n').slice(0, 2)).toEqual([
    `Task: review PR #1 at head ${SHA} (tier ${tier}, round ${round}), as the ${seat} of repo-harness-issue-flow.`,
    `The worktree is at that head. ${scope}`,
  ]);
  expect(parseReviewPacket(packet)).toEqual({ pr: 1, head_sha: SHA, seat, tier, round });
});

test('a round-1 PASS carries only to the fix head of the claimed FAIL, in either publication order; never to a later head or from an unclaimed row (#3187)', () => {
  const FIX = 'c'.repeat(40);
  const LATER = 'd'.repeat(40);
  // `custom` is a Pi seat on a user-set model id with no known family (#3250).
  const models = { pi: 'magpie/codex/gpt-6.1-sol', claude: 'claude-opus-5-5', agy: 'gemini-4-hydrogen-high', custom: 'acme/mystery-1' } as const;
  type Row = readonly [harness: keyof typeof models, subject: string, round: number, verdict: 'PASS' | 'FAIL', claimed?: boolean];
  const read = (head: string, rows: readonly Row[]) => {
    const comments = rows.flatMap(([harness, subject, round, verdict, claimed = true], at) => {
      const seat = harness === 'claude' ? 'reviewer' : 'gatekeeper';
      const receipt: ReviewPublishReceipt = { protocol: 3, kind: 'repo-harness-review-publish-receipt', confirmed_fixed: [], round, subject_sha: subject, risk_tier: 'high',
        reviewer: { harness: harness === 'custom' ? 'pi' : harness, actual_model: models[harness] }, verdict, model_relation: 'different-family', summary: 'Reviewed.', findings: [] };
      const claimUrl = `https://github.com/example/repo/pull/1#issuecomment-${100 + at}`;
      const made = (body: string, url: string, minute: number): BoardCommentV1 => ({ url, created_at: `2026-11-18T10:${String(minute).padStart(2, '0')}:00Z`, author_association: 'OWNER', body });
      return [
        ...(claimed ? [made(renderAcceptanceClaim(receipt, undefined, seat), claimUrl, at * 2)] : []),
        made(renderAcceptanceRecord(receipt, claimUrl, undefined, seat), `https://github.com/example/repo/pull/1#issuecomment-${200 + at}`, at * 2 + 1),
      ];
    });
    return { state: 'open', head_sha: head, comments: page(...comments) } as unknown as BoardPullRequestReadV1;
  };
  const view = (head: string, rows: readonly Row[]) => {
    const pr = read(head, rows);
    return [gatekeeperReview(pr), secondReview(pr, 'high'), acceptance(pr, { status: 'pending', contexts: [] }, ['high'], 'high').status];
  };
  const passThenFail: Row[] = [['pi', OLD, 1, 'PASS'], ['claude', OLD, 1, 'FAIL']];
  const failThenPass: Row[] = [['claude', OLD, 1, 'FAIL'], ['pi', OLD, 1, 'PASS']];
  // Both orders carry the gatekeeper PASS to the fix head, so only the failed reviewer starts there.
  expect(view(FIX, passThenFail)).toEqual(['pass', 'pending', 'not_accepted']);
  expect(view(FIX, failThenPass)).toEqual(['pass', 'pending', 'not_accepted']);
  const changedRoute: SeatRouteV1 = { ...GATEKEEPER, id: 'gatekeeper-fallback', seat: DEFAULT_SEATS_CONFIG.reviewer };
  const carried = plan([pr(1, { head_sha: FIX, gatekeeper_review: 'pass', second_review: 'pending' })], read(FIX, passThenFail).comments, [], changedRoute);
  expect(seatsOf(carried[0])).toEqual(['reviewer']);
  const agyPass: Row[] = [['agy', OLD, 1, 'PASS'], ['claude', OLD, 1, 'FAIL']];
  const agyRead = read(FIX, agyPass);
  const agyPr = pr(1, { head_sha: FIX, gatekeeper_review: gatekeeperReview(agyRead), second_review: secondReview(agyRead, 'high') });
  const agyRecord = agyRead.comments.comments[1]!;
  expect(parseAcceptanceRecord(agyRecord)?.[0]).toMatchObject({ harness: 'agy', model: models.agy, seat: 'gatekeeper' });
  expect(seatsOf(plan([agyPr], agyRead.comments, [], nativeGatekeeperRoute())[0])).toEqual(['reviewer']);
  expect(view(FIX, [...agyPass, ['claude', FIX, 2, 'PASS']])).toEqual(['pass', 'recorded', 'accepted']);
  // The reviewer's round-2 PASS of the fix head meets the High rule with the carried row.
  expect(view(FIX, [...failThenPass, ['claude', FIX, 2, 'PASS']])).toEqual(['pass', 'recorded', 'accepted']);
  const fixed = read(FIX, [...failThenPass, ['claude', FIX, 2, 'PASS']]);
  const dual = reviewRule(fixed, 'high', { low_tier_skip: true });
  expect(acceptance(fixed, { status: 'pending', contexts: [] }, ['high'], dual).status).toBe('not_accepted');
  // A later head after round 2 gets no carry: both seats review it.
  expect(view(LATER, [...passThenFail, ['claude', FIX, 2, 'PASS']])).toEqual(['none', 'pending', 'not_accepted']);
  // Unclaimed rows carry nothing.
  expect(view(FIX, passThenFail.map(([harness, subject, round, verdict]) => [harness, subject, round, verdict, false] as const))).toEqual(['none', 'pending', 'not_accepted']);
  // An unknown family is never the other family: its FAIL carries no PASS, and its PASS of the head does not open the relay.
  expect(view(FIX, [['pi', OLD, 1, 'PASS'], ['custom', OLD, 1, 'FAIL']])).toEqual(['none', 'pending', 'not_accepted']);
  expect(view(FIX, [['custom', FIX, 1, 'PASS']])).toEqual(['none', 'pending', 'not_accepted']);
});

test('Seat: attributes records across mixed Seat: and legacy rows on one head and fails closed on invalid or conflicting Seat:', () => {
  const mkRecord = (head: string, role: string, verdict: 'PASS' | 'FAIL', seat?: 'gatekeeper' | 'reviewer') => {
    const receipt: ReviewPublishReceipt = { protocol: 3, kind: 'repo-harness-review-publish-receipt', confirmed_fixed: [], round: 1, subject_sha: head, risk_tier: 'high',
      reviewer: { harness: 'pi', actual_model: role }, verdict, model_relation: 'different-family', summary: 'Reviewed.', findings: [] };
    return { receipt, seat };
  };
  const prWith = (comments: BoardCommentV1[]) => ({ state: 'open', head_sha: SHA, comments: page(...comments) }) as unknown as BoardPullRequestReadV1;
  const stripSeat = (text: string) => text.replace(/^Seat: .*\n/gmu, '');
  const ghUrl = (n: number) => `https://github.com/example/repo/pull/1#issuecomment-${n}`;
  // Mixed head: Seat: reviewer FAIL (from claim) + Seat: gatekeeper PASS on a custom model, then Seat: gatekeeper PASS with known model.
  const c1 = comment(renderAcceptanceClaim(mkRecord(SHA, 'claude-opus-5-5', 'FAIL').receipt, undefined, 'reviewer'), ghUrl(101));
  const c2 = comment(renderAcceptanceClaim(mkRecord(SHA, 'acme/custom-model', 'PASS').receipt, undefined, 'gatekeeper'), ghUrl(102));
  const c3 = comment(renderAcceptanceClaim(mkRecord(SHA, 'gpt-6.2-sol', 'PASS').receipt, undefined, 'gatekeeper'), ghUrl(103));
  const reviewerFail = comment(stripSeat(renderAcceptanceRecord(mkRecord(SHA, 'claude-opus-5-5', 'FAIL').receipt, c1.url)), '2026-11-09T10:01:00Z');
  const customGatekeeperPass = comment(renderAcceptanceRecord(mkRecord(SHA, 'acme/custom-model', 'PASS').receipt, c2.url, undefined, 'gatekeeper'), '2026-11-09T10:02:00Z');
  const knownGatekeeperPass = comment(renderAcceptanceRecord(mkRecord(SHA, 'gpt-6.2-sol', 'PASS').receipt, c3.url, undefined, 'gatekeeper'), '2026-11-09T10:03:00Z');
  const mixed = prWith([c1, c2, c3, reviewerFail, customGatekeeperPass, knownGatekeeperPass]);
  expect(gatekeeperReview(mixed)).toBe('pass');
  expect(secondReview(mixed, 'high')).toBe('recorded');
  expect(acceptance(mixed, { status: 'pending', contexts: [] }, ['high'], 'high').status).toBe('not_accepted');
  // Without an established Seat: on claim/record/single-start, an unattributed FAIL still blocks the relay, while an unattributed PASS never opens it.
  const unattributedClaim = comment(stripSeat(renderAcceptanceClaim(mkRecord(SHA, 'claude-opus-5-5', 'FAIL').receipt)), ghUrl(104));
  const unattributedFail = comment(stripSeat(renderAcceptanceRecord(mkRecord(SHA, 'claude-opus-5-5', 'FAIL').receipt, unattributedClaim.url)), '2026-11-09T10:01:00Z');
  const unattributedPass = comment(stripSeat(renderAcceptanceRecord(mkRecord(SHA, 'gpt-6.2-sol', 'PASS').receipt, unattributedClaim.url)), '2026-11-09T10:02:00Z');
  expect(gatekeeperReview(prWith([unattributedClaim, unattributedFail]))).toBe('fail');
  expect(gatekeeperReview(prWith([unattributedClaim, unattributedPass]))).toBe('none');
  // Explicit Seat: reviewer on a DeepSeek PASS satisfies secondReview without reading config, while Model relation stays checked by acceptance.
  const seatReviewerPass = comment(renderAcceptanceRecord({
    protocol: 3, kind: 'repo-harness-review-publish-receipt', confirmed_fixed: [], round: 1, subject_sha: SHA, risk_tier: 'high',
    reviewer: { harness: 'pi', actual_model: 'magpie/group/deepseek-v4.1-flash' }, verdict: 'PASS', model_relation: 'different-family', summary: 'Ok.', findings: [],
  }, c1.url, undefined, 'reviewer'), '2026-11-09T10:03:00Z');
  const onlyReviewer = prWith([c1, seatReviewerPass]);
  expect([gatekeeperReview(onlyReviewer), secondReview(onlyReviewer, 'high')]).toEqual(['none', 'recorded']);
  // Malformed or conflicting Seat: line fails closed as acceptance_record_unparsed rather than misattributing.
  const badSeat = comment(renderAcceptanceRecord(mkRecord(SHA, 'gpt-6.2-sol', 'PASS').receipt, c1.url).replace('Seat: gatekeeper', 'Seat: worker'), '2026-11-09T10:04:00Z');
  expect(acceptance(prWith([c1, badSeat]), { status: 'pending', contexts: [] }, ['high'], 'high')).toMatchObject({ status: 'unknown', reason: 'acceptance_record_unparsed' });
  const conflictSeat = comment(renderAcceptanceRecord(mkRecord(SHA, 'gpt-6.2-sol', 'PASS').receipt, c1.url, undefined, 'reviewer').replace('| pi (gpt-6.2-sol), read-only |', '| gatekeeper (gpt-6.2-sol), read-only |'), '2026-11-09T10:05:00Z');
  expect(acceptance(prWith([c1, conflictSeat]), { status: 'pending', contexts: [] }, ['high'], 'high')).toMatchObject({ status: 'unknown', reason: 'acceptance_record_unparsed' });
});

test.each([
  ['seatless', 'pending'],
  ['explicit', 'recorded'],
] as const)('High round-1 reviewer PASS and gatekeeper FAIL with %s records start only gatekeeper on the fix head', (seatMode, reviewerState) => {
  const round1Body = (body: string) => seatMode === 'seatless' ? body.replace(/^Seat: .*\n/gmu, '') : body;
  const ghUrl = (n: number) => `https://github.com/example/repo/pull/1#issuecomment-${n}`;
  const gkConfig: SeatRouteV1 = {
    id: 'gatekeeper',
    seat: { ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'codex', model: 'gpt-6.2-sol' },
    line: 'gatekeeper: gatekeeper (codex gpt-6.2-sol high)',
  };
  const deepseekReviewer: SeatConfigV1 = { ...DEFAULT_SEATS_CONFIG.reviewer, runtime: 'pi', model: 'magpie/group/deepseek-v4.1-flash', effort: null };
  const deepseekPass: ReviewPublishReceipt = {
    protocol: 3, kind: 'repo-harness-review-publish-receipt', confirmed_fixed: [], round: 1, subject_sha: OLD, risk_tier: 'high',
    reviewer: { harness: 'pi', actual_model: 'magpie/group/deepseek-v4.1-flash' }, verdict: 'PASS', model_relation: 'different-family', summary: 'Reviewer passed.', findings: [],
  };
  const solFail: ReviewPublishReceipt = {
    protocol: 3, kind: 'repo-harness-review-publish-receipt', confirmed_fixed: [], round: 1, subject_sha: OLD, risk_tier: 'high',
    reviewer: { harness: 'codex', actual_model: 'gpt-6.2-sol' }, verdict: 'FAIL', model_relation: 'different-family', summary: 'Gatekeeper failed.',
    findings: [{ id: 'F1', severity: 'P1', path: 'src/a.ts', line: 1, trigger: 'Run the default command.', evidence: 'Broken.', fix: 'Fix it.' }],
  };
  const r1Comments: BoardCommentV1[] = [
    marker(OLD, 'https://example.test/m-gk', 'gatekeeper'),
    marker(OLD, 'https://example.test/m-rv', 'reviewer'),
    comment(round1Body(renderAcceptanceClaim(deepseekPass, undefined, 'reviewer')), ghUrl(201)),
    comment(round1Body(renderAcceptanceRecord(deepseekPass, ghUrl(201), undefined, 'reviewer')), ghUrl(202)),
    comment(round1Body(renderAcceptanceClaim(solFail, undefined, 'gatekeeper')), ghUrl(203)),
    comment(round1Body(renderAcceptanceRecord(solFail, ghUrl(203), undefined, 'gatekeeper')), ghUrl(204)),
  ];
  const fixRead = { state: 'open', head_sha: SHA, comments: page(...r1Comments) } as unknown as BoardPullRequestReadV1;
  expect(gatekeeperReview(fixRead)).toBe('none');
  expect(secondReview(fixRead, 'high')).toBe(reviewerState);
  expect(acceptance(fixRead, { status: 'pending', contexts: [] }, ['high'], 'high').status).toBe('not_accepted');
  const fixPr = pr(1, { head_sha: SHA, tier: 'high', writer_family: 'anthropic', gatekeeper_review: gatekeeperReview(fixRead), second_review: secondReview(fixRead, 'high') });
  expect(plan([fixPr], fixRead.comments, [], gkConfig, deepseekReviewer)).toEqual([
    { pr: 1, action: 'start', head_ref: 'feat/1', head_sha: SHA, tier: 'high', round: 2, seats: [{ seat: 'gatekeeper', delta_from: OLD }] },
  ]);
  // The Round-2 gatekeeper PASS completes acceptance with the carried reviewer PASS.
  const solPass: ReviewPublishReceipt = {
    protocol: 3, kind: 'repo-harness-review-publish-receipt', confirmed_fixed: [], round: 2, subject_sha: SHA, risk_tier: 'high',
    reviewer: { harness: 'codex', actual_model: 'gpt-6.2-sol' }, verdict: 'PASS', model_relation: 'different-family', summary: 'Gatekeeper passed.', findings: [],
  };
  const r2Comments = [
    ...r1Comments,
    comment(renderAcceptanceClaim(solPass, undefined, 'gatekeeper'), ghUrl(205)),
    comment(renderAcceptanceRecord(solPass, ghUrl(205), undefined, 'gatekeeper'), ghUrl(206)),
  ];
  const acceptedRead = { state: 'open', head_sha: SHA, comments: page(...r2Comments) } as unknown as BoardPullRequestReadV1;
  expect(gatekeeperReview(acceptedRead)).toBe('pass');
  expect(acceptance(acceptedRead, { status: 'pending', contexts: [] }, ['high'], 'high').status).toBe('accepted');
});

test('matchingWorkerTerminals orders live worker matches by closing issue, PR label, then canonical worktree cwd', () => {
  const mk = (address: string, seat: string, extra: Partial<BoardSeatTerminalReadV1> = {}): BoardSeatTerminalReadV1 => ({
    address, name: null, agent: 'pi', state: 'live', status: 'idle', status_kind: null, status_msg: null, status_ms: null,
    turn: 0, cwd: null, where: null, agent_pid: null, labels: { seat }, ...extra,
  });
  const terminals: BoardSeatTerminalReadV1[] = [
    mk('t1', 'orchestrator', { cwd: '/tmp/wt-2479' }),
    mk('t2', 'worker-deep', { state: 'finished', cwd: '/tmp/wt-2479', labels: { seat: 'worker-deep', issue: '2479' } }),
    mk('t3', 'worker-neon', { cwd: '/tmp/wt-2479', labels: { seat: 'worker-neon' } }),
    mk('t4', 'worker', { labels: { seat: 'worker', pr: '2485' } }),
    mk('t5', 'worker-opus', { labels: { seat: 'worker-opus', issue: '2479' } }),
  ];
  expect(matchingWorkerTerminals({ terminals, issues: ['2479'], pr: '2485', cwd: '/tmp/wt-2479' })).toEqual(['t5', 't4', 't3']);
  expect(matchingWorkerTerminals({ terminals, issues: ['9999'], pr: '2485', cwd: '/tmp/wt-2479' })).toEqual(['t4', 't3']);
  expect(matchingWorkerTerminals({ terminals, issues: [], pr: '9999', cwd: '/tmp/wt-2479' })).toEqual(['t3']);
});

test('executeReview joins the worker tab via hc.run in the PR worktree (even when the worker ran in the primary checkout), respects the 3-pane cap across pending adoptions, and falls back to PR#<pr> / PR#<pr> 2', async () => {
  const mkTab = (id: string, name: string, panes: readonly [string, string][]): HerdrAppTab => ({
    id, name, active: false, paneCount: panes.length,
    terminals: panes.map(([terminal, pane]) => ({ terminal, pane, name: null, status: null, app: null })),
  });
  // Worker t10 was started in the primary checkout while the PR head lives in /tmp/wt-2479 (P1 trigger).
  const worker: BoardSeatTerminalReadV1 = {
    address: 't10', name: null, agent: 'pi', state: 'live', status: 'idle', status_kind: null, status_msg: null, status_ms: null,
    turn: 0, cwd: '/repo/primary', where: 'repo / #2479', agent_pid: null, labels: { seat: 'worker-deep', issue: '2479', parent: '2457' },
  };
  let tabsState: HerdrAppTab[] = [mkTab('tb1', '#2479', [['t10', 'p1']])];
  const calls: HerdrSeatPlacement[] = [];
  let nextPane = 2;
  const p = ports({
    worktree: () => ({ path: '/tmp/wt-2479' }),
    listSpaceTabs: () => tabsState,
    seatTerminals: () => [worker],
    closingIssues: new Map([[2485, [2479]]]),
    launch: async seat => ({
      argv: seatLoginShell(['/bin/sh', '-c', `export PATH="\${PATH:+$PATH:}"; "$0" "$1" seats label ${seat} --repository-id 1 --pr 2485 && shift 2 && exec "$@"`, 'bun', 'cli.ts', '', seat]),
      tab: 'PR#2485', runtime: seat === 'reviewer' ? 'claude' : 'codex',
    }),
    placePane: placement => {
      calls.push(placement);
      if (placement.command === 'hc.run') {
        const paneId = `p${nextPane++}`;
        const termId = `t${10 + nextPane}`;
        tabsState = tabsState.map(t => t.id === placement.tabId
          ? { ...t, paneCount: t.paneCount + 1, terminals: [...t.terminals, { terminal: termId, pane: paneId, name: null, status: null, app: null }] }
          : t);
        return { space: placement.space, tab: placement.tabId, terminal: termId };
      }
      return { tab: 'tb-new', terminal: 't99' };
    },
  });
  const pending = pr(2485, { closes: [2479], second_review: 'pending' });
  expect(await executeReview(plan([pending]), context, p)).toMatchObject({ started: [{ pr: 2485, seat: 'gatekeeper' }, { pr: 2485, seat: 'reviewer' }] });
  expect(calls.map(c => c.command === 'hc.run' ? [c.command, c.space, c.tabId, c.folder] : [c.command])).toEqual([
    ['hc.run', 's', 'tb1', '/tmp/wt-2479'],
    ['hc.run', 's', 'tb1', '/tmp/wt-2479'],
  ]);
  for (const call of calls) {
    expect(call.command).toBe('hc.run');
    const argv = (call as Extract<HerdrSeatPlacement, { command: 'hc.run' }>).argv;
    expect(argv.join(' ')).not.toContain('cd --');
    expect(argv.at(-2)).toBe('--');
    expect(parseReviewPacket(argv.at(-1)!)).toMatchObject({ pr: 2485 });
  }

  // Async adoption race: worker tab has 2 panes and herdr-app ls does not reflect the 3rd pane yet -> gatekeeper joins tb1 via hc.run, reviewer opens tab.new PR#2485 instead of overflowing to 4 panes.
  const staleTwoPanes: HerdrAppTab[] = [mkTab('tb1', '#2479', [['t10', 'p1'], ['t11', 'p2']])];
  const pendingCalls: HerdrSeatPlacement[] = [];
  const pPending = ports({
    worktree: () => ({ path: '/tmp/wt-2479' }),
    listSpaceTabs: () => staleTwoPanes,
    seatTerminals: () => [worker],
    closingIssues: new Map([[2485, [2479]]]),
    launch: async seat => ({ argv: [seat], tab: 'PR#2485', runtime: seat === 'reviewer' ? 'claude' : 'codex' }),
    placePane: placement => {
      pendingCalls.push(placement);
      return placement.command === 'hc.run' ? { space: placement.space, tab: placement.tabId, terminal: 't20' } : { tab: 'tb-new', terminal: 't21' };
    },
  });
  await executeReview(plan([pending]), context, pPending);
  expect(pendingCalls[0]).toMatchObject({ command: 'hc.run', tabId: 'tb1', folder: '/tmp/wt-2479' });
  expect(pendingCalls[1]).toMatchObject({ command: 'tab.new', args: { name: 'PR#2485', space: 's', folder: '/tmp/wt-2479' } });

  // Worker tab full (3 panes) and existing PR#2485 also full (3 panes) -> opens tab.new named 'PR#2485 2', then second seat joins 'PR#2485 2' via hc.run.
  let overflowState: HerdrAppTab[] = [
    mkTab('tb1', '#2479', [['t10', 'p1'], ['t11', 'p2'], ['t12', 'p3']]),
    mkTab('tb2', 'PR#2485', [['t13', 'p4'], ['t14', 'p5'], ['t15', 'p6']]),
  ];
  const overflowCalls: HerdrSeatPlacement[] = [];
  const pOverflow = ports({
    worktree: () => ({ path: '/tmp/wt-2479' }),
    listSpaceTabs: () => overflowState,
    seatTerminals: () => [worker],
    closingIssues: new Map([[2485, [2479]]]),
    launch: async seat => ({ argv: [seat], tab: 'PR#2485', runtime: seat === 'reviewer' ? 'claude' : 'codex' }),
    placePane: placement => {
      overflowCalls.push(placement);
      if (placement.command === 'tab.new') {
        overflowState = [...overflowState, mkTab('tb3', String(placement.args.name), [['t16', 'p7']])];
        return { tab: 'tb3', terminal: 't16' };
      }
      return { space: placement.space, tab: placement.tabId, terminal: 't17' };
    },
  });
  await executeReview(plan([pending]), context, pOverflow);
  expect(overflowCalls[0]).toMatchObject({ command: 'tab.new', args: { name: 'PR#2485 2', space: 's', folder: '/tmp/wt-2479' } });
  expect(overflowCalls[1]).toMatchObject({ command: 'hc.run', space: 's', tabId: 'tb3', folder: '/tmp/wt-2479' });

  // Fail-closed split: HERDR_APP_NOT_SENT releases marker; timeout keeps marker as launch_unknown; listSpaceTabs failure writes no marker.
  const splitNotSent = ports({
    listSpaceTabs: () => [mkTab('tb1', '#2479', [['t10', 'p1']])],
    seatTerminals: () => [worker],
    closingIssues: new Map([[1, [2479]]]),
    placePane: () => { throw new HerdrCoreError('hc', 'invalid_address'); },
  });
  await expect(executeReview(high, context, splitNotSent)).rejects.toBeInstanceOf(HerdrCoreError);
  expect(splitNotSent.comments).toHaveLength(2);
  expect(splitNotSent.comments[1]).toContain('Status: released');

  const splitUnknown = ports({
    listSpaceTabs: () => [mkTab('tb1', '#2479', [['t10', 'p1']])],
    seatTerminals: () => [worker],
    closingIssues: new Map([[1, [2479]]]),
    placePane: () => { throw new HerdrCoreError('hc', 'timeout'); },
  });
  await expect(executeReview(high, context, splitUnknown)).rejects.toThrow('launch_unknown');
  expect(splitUnknown.comments).toHaveLength(1);

  const listFailed = ports({ listSpaceTabs: () => { throw new HerdrCoreError('herdr-app', 'failed', 2); } });
  await expect(executeReview(high, context, listFailed)).rejects.toBeInstanceOf(HerdrCoreError);
  expect(listFailed.comments).toEqual([]);
});

test.skipIf(process.platform === 'win32')('agy gatekeeper-fallback tab split targets the worktree cwd via hc.run and binds in the worktree directory', async () => {
  const gatekeeper = nativeGatekeeperRoute();
  const root = mkdtempSync(join(tmpdir(), 'rh-agy-split-'));
  const worktree = join(root, 'wt-2479');
  mkdirSync(worktree);
  const hc = join(root, 'hc');
  const agy = join(root, 'agy');
  const env = { HOME: root, ZDOTDIR: root, PATH: `${root}:/usr/bin:/bin`, HC_TERMINAL_ID: 't9' };
  writeFileSync(hc, `#!${process.execPath}
const [,,, address, ...pairs] = process.argv.slice(2);
const labels = Object.fromEntries(pairs.map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]));
console.log(JSON.stringify({ address, state: 'live', turn: 0, labels }));
`, { mode: 0o700 });
  writeFileSync(agy, '#!/bin/sh\npwd\n', { mode: 0o700 });
  const split = Promise.withResolvers<HerdrSeatPlacement>();
  const worker: BoardSeatTerminalReadV1 = {
    address: 't10', name: null, agent: 'pi', state: 'live', status: 'idle', status_kind: null, status_msg: null, status_ms: null,
    turn: 0, cwd: root, where: null, agent_pid: null, labels: { seat: 'worker-deep', issue: '10' },
  };
  const workerTab: HerdrAppTab = { id: 'tb1', name: '#10', active: true, paneCount: 1, terminals: [{ terminal: 't10', pane: 'p1', name: null, status: null, app: null }] };
  const p = ports({
    agy: { hc, env },
    worktree: () => ({ path: worktree }),
    listSpaceTabs: () => [workerTab],
    seatTerminals: () => [worker],
    closingIssues: new Map([[1, [10]]]),
    placePane: placement => { split.resolve(placement); return { space: 's', tab: 'tb1', terminal: 't9' }; },
    launch: async (seat, labels) => ({
      argv: labeledSeatArgv(seat, labels, [agy, '--agent', 'rh-gatekeeper-fallback'], env, 'new'),
      tab: 'PR#1', runtime: 'agy',
    }),
  });
  const run = executeReview(plan([pr(1)], page(), [], gatekeeper), { ...context, gatekeeper }, p);
  try {
    const placed = await Promise.race([split.promise, run.then(() => { throw new Error('finished without placing'); })]);
    expect(placed).toMatchObject({ command: 'hc.run', space: 's', tabId: 'tb1', folder: worktree });
    const [shell, ...args] = (placed as Extract<HerdrSeatPlacement, { command: 'hc.run' }>).argv;
    expect(args.join(' ')).not.toContain('cd --');
    const result = spawnSync(shell, args, { env, cwd: (placed as Extract<HerdrSeatPlacement, { command: 'hc.run' }>).folder, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(realpathSync(worktree));
    expect(await run).toMatchObject({ started: [{ pr: 1, seat: 'gatekeeper' }], refused: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
