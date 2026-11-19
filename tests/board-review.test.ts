import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReviewPacket, planReview, reviewPacket, type ReviewDecisionV1, type ReviewSeat } from '../src/core/board/review';
import { executeReview, withReviewLock, type ReviewPorts } from '../src/effects/board/review';
import { HerdrCoreError } from '../src/effects/terminal/herdr-core';
import type { BoardPullRequestV1, BoardV1 } from '../src/core/board/board';
import type { BoardCommentPageV1, BoardCommentV1, BoardPullRequestReadV1 } from '../src/core/board/source';
import type { SeatRouteV1 } from '../src/core/board/seat-routing';
import { DEFAULT_SEATS_CONFIG, type SeatConfigV1 } from '../src/core/board/seats-settings';
import { acceptance, gatekeeperReview, secondReview } from '../src/core/board/review-rules';
import { renderAcceptanceClaim, renderAcceptanceRecord, type ReviewPublishReceipt } from '../src/core/review/review-publish';

const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const pr = (number: number, extra: Partial<BoardPullRequestV1> = {}): BoardPullRequestV1 => ({
  number, url: '', state: 'open', is_draft: false, base_ref: 'main', base_sha: SHA, head_ref: `feat/${number}`, head_sha: SHA, head_committed_at: '', merged_at: null,
  closes: [number * 10], refs: [], files: [], cleared_hazard_paths: [], required_check: { status: 'success', completed_at: '', contexts: [] }, acceptance: { status: 'not_accepted' }, merge_readiness: null, merge_readiness_observed_at: null,
  tier: 'high', second_review: 'not_required', gatekeeper_review: 'none', writer_family: null, merge_hold: { status: 'none' }, review_fail: null, review_records: { status: 'observed', gatekeeper: null, reviewer: null }, open_questions: { status: 'observed', questions: [] }, ...extra,
});
const board = (prs: BoardPullRequestV1[], holds: { issue: number; reason: string }[] = [], reviewer_family: string | null = 'anthropic'): BoardV1 =>
  ({ pull_requests: prs, reviewer_family, parent: { number: 1 }, plan: { status: 'observed', block: { holds } } }) as unknown as BoardV1;
const comment = (body: string, url = 'https://example.test/c'): BoardCommentV1 => ({ url, created_at: '2026-11-09T10:00:00Z', author_association: 'OWNER', body });
const marker = (head: string, url = 'https://example.test/m1', seat = 'gatekeeper') => comment(`repo-harness review start\nSubject: ${head}\nSeat: ${seat}`, url);
const record = (head: string, role = 'pi (gpt-6.1-sol)', verdict: 'PASS' | 'FAIL' = 'FAIL') => comment(`repo-harness acceptance record\n\n| Round | Role | Subject | Verdict |\n|---|---|---|---|\n| 1 | ${role} | \`${head}\` | ${verdict}: 1 P1 |`);
const page = (...comments: BoardCommentV1[]): BoardCommentPageV1 => ({ truncated: false, comments });

const GATEKEEPER: SeatRouteV1 = { id: 'gatekeeper', seat: DEFAULT_SEATS_CONFIG.gatekeeper, line: 'gatekeeper: gatekeeper (codex gpt-6.1-terra high)' };
function plan(prs: BoardPullRequestV1[], comments: BoardCommentPageV1 = page(), holds: { issue: number; reason: string }[] = [], gatekeeper = GATEKEEPER, reviewer: string | null = 'anthropic'): readonly ReviewDecisionV1[] {
  return planReview({ board: board(prs, holds, reviewer), comments: new Map(prs.map(entry => [entry.number, comments])), gatekeeper });
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
  expect(seatsOf(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], page(record(SHA, undefined, 'PASS')))[0])).toEqual(['reviewer']);
  // A gatekeeper FAIL of the head starts no reviewer: the fix goes back to the gatekeeper.
  expect(seatsOf(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'fail' })])[0])).toEqual(['gatekeeper']);
  expect(seatsOf(plan([pr(1, { tier: 'high', second_review: 'recorded', gatekeeper_review: 'pass' })])[0])).toEqual(['gatekeeper']);
});

test('a Medium head starts the one seat of the other family than the writer; an unknown writer family starts none', () => {
  const medium = (writer_family: BoardPullRequestV1['writer_family']) => plan([pr(1, { tier: 'medium', writer_family })]);
  expect(medium('anthropic')[0]).toMatchObject({ action: 'start', seats: [{ seat: 'gatekeeper' }] });
  expect(medium('openai')[0]).toMatchObject({ action: 'start', seats: [{ seat: 'reviewer' }] });
  expect(label(medium(null))).toEqual(['1:writer_family_unknown']);
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

test('the delta base of a seat is an earlier head that its own family reviewed; otherwise the seat reviews the whole diff', () => {
  // Each seat's base is read from the same earlier markers and rows, and each base comes from the seat's own family.
  const base = (seat: ReviewSeat, comments: BoardCommentPageV1, reviewer = 'anthropic') => {
    const reviewerStart = seat === 'reviewer';
    const evidence = reviewerStart ? page(...comments.comments, record(SHA, undefined, 'PASS')) : comments;
    const started = plan([pr(1, { second_review: 'pending', gatekeeper_review: reviewerStart ? 'pass' : 'none' })], evidence, [], GATEKEEPER, reviewer)[0];
    const entry = started.action === 'start' ? started.seats.find(candidate => candidate.seat === seat) : undefined;
    return entry === undefined ? `not ${seat}` : entry.delta_from;
  };
  const reviewerMarker = marker(OLD, 'https://example.test/m2', 'reviewer');
  const both = (comments: BoardCommentPageV1, reviewer = 'anthropic') => [base('gatekeeper', comments, reviewer), base('reviewer', comments, reviewer)];
  expect(both(page(marker(OLD)))).toEqual([null, null]);
  expect(both(page(marker(OLD), record(OLD)))).toEqual([OLD, null]);
  // A gatekeeper row alone gives the reviewer no base, and a reviewer-family row alone gives the gatekeeper none.
  expect(both(page(marker(OLD), reviewerMarker, record(OLD, 'claude (opus)')))).toEqual([null, OLD]);
  expect(both(page(marker(OLD), record(OLD, 'acceptor')))).toEqual([null, null]);
  // The family of the row's model decides, not the harness: with a DeepSeek reviewer, a Pi DeepSeek row is the reviewer's and a Pi Codex row the gatekeeper's.
  expect(both(page(marker(OLD), reviewerMarker, record(OLD, 'pi (magpie/cursor/deepseek-v41-flash-1017)')), 'deepseek')).toEqual([null, OLD]);
  expect(both(page(marker(OLD), reviewerMarker, record(OLD)), 'deepseek')).toEqual([OLD, null]);
});

function ports(overrides: Partial<ReviewPorts> = {}): ReviewPorts & { comments: string[]; tabs: Record<string, unknown>[] } {
  const comments: string[] = [];
  const tabs: Record<string, unknown>[] = [];
  return {
    comments, tabs,
    worktree: () => ({ path: '/tmp/w' }),
    comment: (_pr, body) => { comments.push(body); return `https://example.test/c${comments.length}`; },
    openTab: args => { tabs.push(args); },
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

test('a dry run, and a worktree off the head, write no marker and open no seat', async () => {
  const dry = ports();
  await executeReview(high, { ...context, dry_run: true }, dry);
  const off = ports({ worktree: () => ({ refusal: 'not at head' }) });
  expect(await executeReview(high, context, off)).toMatchObject({ started: [], refused: [{ pr: 1, reason: 'not at head' }] });
  expect([dry.comments, dry.tabs, off.comments, off.tabs]).toEqual([[], [], [], []]);
});

test('a launch that sent nothing releases the marker; an ambiguous one keeps it', async () => {
  const failing = (reason: 'missing' | 'timeout') => ports({ openTab: () => { throw new HerdrCoreError('herdr-app', reason); } });
  const notSent = failing('missing');
  await expect(executeReview(high, context, notSent)).rejects.toThrow();
  expect(notSent.comments[1]).toContain('Claim: https://example.test/c1\nStatus: released');
  const unknown = failing('timeout');
  await expect(executeReview(high, context, unknown)).rejects.toThrow('launch_unknown');
  expect(unknown.comments).toHaveLength(1);
});

test('a reviewer seat on Pi starts after its marker and gets a packet for its own harness', async () => {
  const p = ports({ launch: async seat => ({ argv: [seat], tab: seat, runtime: 'pi' }) });
  const result = await executeReview(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], page(marker(SHA), record(SHA, 'pi (gpt-6.1-sol)', 'PASS')), [], GATEKEEPER, 'deepseek'), context, p);
  expect(result.started).toMatchObject([{ seat: 'reviewer' }]);
  expect(p.tabs[0]!.task).toContain('reviewer.harness "pi"');
});

test('the gatekeeper starts only when the effective gatekeeper is of another known family than the writer, and not Claude where the head needs that', () => {
  const route = (seat: SeatConfigV1, id: SeatRouteV1['id'] = 'gatekeeper-fallback'): SeatRouteV1 => (id === null ? { id, line: 'gatekeeper: none (chatgpt exhausted)' } : { id, seat, line: `gatekeeper: ${id}` });
  const pi = route({ ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'pi', model: 'magpie/cursor/deepseek-v41-flash-1017', effort: null });
  const claude = route({ ...DEFAULT_SEATS_CONFIG.reviewer });
  const medium = pr(1, { tier: 'medium', writer_family: 'anthropic' });
  expect(label(plan([medium], page(), [], pi))).toEqual(['1:start']);
  expect(plan([medium], page(), [], claude)[0]).toMatchObject({ action: 'skip', reason: 'review_family_unavailable', detail: 'the gatekeeper family anthropic is the writer family; gatekeeper: gatekeeper-fallback' });
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
  const sameFamily = plan([pr(1, { second_review: 'pending' })], page(), [], GATEKEEPER, 'openai')[0];
  expect(sameFamily).toMatchObject({ action: 'skip', reason: 'review_family_unavailable' });
  // After the gatekeeper PASS the reviewer is the seat of the head, so its own family check applies.
  const passedPage = page(marker(SHA), record(SHA, undefined, 'PASS'));
  const passed = (reviewer: string | null) => label(plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], passedPage, [], GATEKEEPER, reviewer));
  expect(passed('openai')).toEqual(['1:review_family_unavailable']);
  expect(passed(null)).toEqual(['1:review_family_unavailable']);
  // The skip names the field, never the value: a credential pasted as the model stays out of the output.
  const unknownReviewer = plan([pr(1, { second_review: 'pending', gatekeeper_review: 'pass' })], passedPage, [], GATEKEEPER, null)[0];
  expect(unknownReviewer).toMatchObject({ detail: 'the model of seats.reviewer.model has no known family, so its row cannot count as another family' });
  expect(passed('deepseek')).toEqual(['1:start']);
  // A started gatekeeper counts by its recorded row, not by the current route: a fallback gatekeeper of another family than the reviewer opens the relay; a gatekeeper of the reviewer family does not.
  const fallback = route({ ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'pi', model: 'magpie/cursor/deepseek-v41-flash-1017', effort: null });
  const pending = pr(1, { second_review: 'pending', gatekeeper_review: 'pass' });
  expect(label(plan([pending], page(marker(SHA), record(SHA, 'pi (gpt-6.1-sol)', 'PASS')), [], fallback, 'deepseek'))).toEqual(['1:start']);
  expect(label(plan([pending], page(marker(SHA), record(SHA, 'pi (magpie/cursor/deepseek-v41-flash-1017)', 'PASS')), [], fallback, 'deepseek'))).toEqual(['1:review_family_unavailable']);
  expect(plan([pending], page(marker(SHA), record(SHA, 'pi', 'PASS')))[0]).toMatchObject({
    action: 'skip', reason: 'review_family_unavailable', detail: 'the gatekeeper PASS has no recorded model family',
  });
  // A Medium head of another writer family starts the Claude reviewer, which the gatekeeper check does not touch.
  expect(label(plan([pr(1, { tier: 'medium', writer_family: 'openai' })], page(), [], route(DEFAULT_SEATS_CONFIG.gatekeeper, null)))).toEqual(['1:start']);
});

test('a reviewer that sent nothing releases its own marker and leaves the started gatekeeper alone', async () => {
  // The gatekeeper's marker and PASS row of an earlier run stay; only the failed reviewer marker is released.
  const passed = page(marker(SHA), record(SHA, 'pi (gpt-6.1-sol)', 'PASS'));
  const p = ports({ openTab: () => { throw new HerdrCoreError('herdr-app', 'missing'); } });
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
  expect(text).toContain(`round 2, risk_tier "high", subject_sha ${SHA}, reviewer.harness "pi"`);
  expect(text).toContain('End your last reply with the line RECEIPT-JSON');
  expect(parseReviewPacket(text)).toEqual({ pr: 1, head_sha: SHA, seat: 'gatekeeper' });
  expect(parseReviewPacket(text.replace('as the gatekeeper of', 'as the gatekeeper-deep of'))?.seat).toBe('gatekeeper-deep');
  expect(parseReviewPacket(text.replace('as the gatekeeper of', 'as the worker of'))).toBeNull();
  // A claim that a publish left without its record still counts for the round.
  expect(start(page(comment(`repo-harness acceptance claim\nRound: 2\nSubject: ${OLD}`))).round).toBe(3);
});

test('a round-1 PASS carries only to the fix head of the claimed FAIL, in either publication order; never to a later head or from an unclaimed row (#3187)', () => {
  const FIX = 'c'.repeat(40);
  const LATER = 'd'.repeat(40);
  // `custom` is a Pi seat on a user-set model id with no known family (#3250).
  const models = { pi: 'magpie/codex/gpt-6.1-sol', claude: 'claude-opus-5-5', custom: 'acme/mystery-1' } as const;
  type Row = readonly [harness: keyof typeof models, subject: string, round: number, verdict: 'PASS' | 'FAIL', claimed?: boolean];
  const read = (head: string, rows: readonly Row[]) => {
    const comments = rows.flatMap(([harness, subject, round, verdict, claimed = true], at) => {
      const receipt: ReviewPublishReceipt = { protocol: 2, kind: 'repo-harness-review-publish-receipt', confirmed_fixed: [], round, subject_sha: subject, risk_tier: 'high',
        reviewer: { harness: harness === 'custom' ? 'pi' : harness, actual_model: models[harness] }, verdict, model_relation: 'different-family', summary: 'Reviewed.', findings: [] };
      const claimUrl = `https://github.com/example/repo/pull/1#issuecomment-${100 + at}`;
      const made = (body: string, url: string, minute: number): BoardCommentV1 => ({ url, created_at: `2026-11-18T10:${String(minute).padStart(2, '0')}:00Z`, author_association: 'OWNER', body });
      return [...(claimed ? [made(renderAcceptanceClaim(receipt), claimUrl, at * 2)] : []), made(renderAcceptanceRecord(receipt, claimUrl), `https://github.com/example/repo/pull/1#issuecomment-${200 + at}`, at * 2 + 1)];
    });
    return { state: 'open', head_sha: head, comments: page(...comments) } as unknown as BoardPullRequestReadV1;
  };
  const view = (head: string, rows: readonly Row[]) => {
    const pr = read(head, rows);
    return [gatekeeperReview(pr, 'anthropic'), secondReview(pr, 'high', 'anthropic'), acceptance(pr, { status: 'pending', contexts: [] }, ['high'], 'high').status];
  };
  const passThenFail: Row[] = [['pi', OLD, 1, 'PASS'], ['claude', OLD, 1, 'FAIL']];
  const failThenPass: Row[] = [['claude', OLD, 1, 'FAIL'], ['pi', OLD, 1, 'PASS']];
  // Both orders carry the gatekeeper PASS to the fix head, so only the failed reviewer starts there.
  expect(view(FIX, passThenFail)).toEqual(['pass', 'pending', 'not_accepted']);
  expect(view(FIX, failThenPass)).toEqual(['pass', 'pending', 'not_accepted']);
  const changedRoute: SeatRouteV1 = { ...GATEKEEPER, id: 'gatekeeper-fallback', seat: DEFAULT_SEATS_CONFIG.reviewer };
  const carried = plan([pr(1, { head_sha: FIX, gatekeeper_review: 'pass', second_review: 'pending' })], read(FIX, passThenFail).comments, [], changedRoute);
  expect(seatsOf(carried[0])).toEqual(['reviewer']);
  // The reviewer's round-2 PASS of the fix head meets the High rule with the carried row.
  expect(view(FIX, [...failThenPass, ['claude', FIX, 2, 'PASS']])).toEqual(['pass', 'recorded', 'accepted']);
  // A later head after round 2 gets no carry: both seats review it.
  expect(view(LATER, [...passThenFail, ['claude', FIX, 2, 'PASS']])).toEqual(['none', 'pending', 'not_accepted']);
  // Unclaimed rows carry nothing.
  expect(view(FIX, passThenFail.map(([harness, subject, round, verdict]) => [harness, subject, round, verdict, false] as const))).toEqual(['none', 'pending', 'not_accepted']);
  // An unknown family is never the other family: its FAIL carries no PASS, and its PASS of the head does not open the relay.
  expect(view(FIX, [['pi', OLD, 1, 'PASS'], ['custom', OLD, 1, 'FAIL']])).toEqual(['none', 'pending', 'not_accepted']);
  expect(view(FIX, [['custom', FIX, 1, 'PASS']])).toEqual(['none', 'pending', 'not_accepted']);
});
