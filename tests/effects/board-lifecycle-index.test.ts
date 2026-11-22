import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeoutEvents } from '../../src/cli/commands/board';
import { lifecycleIndexPath, recordLifecycleEvents, summarizeWorktreeHooks, type LifecycleEvent } from '../../src/effects/board/lifecycle-index';

const scratch = mkdtempSync(join(tmpdir(), 'repo-harness-lifecycle-index-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const close: LifecycleEvent = { kind: 'seat.lifecycle', phase: 'close', seat: 'worker', terminal: 't12', issues: [3204], pr: 3210, model: null, duration_ms: null, transcript_path: null };

test('the index keeps only sanitized events in an owner-only file', () => {
  const env = { ...process.env, REPO_HARNESS_HOME: join(scratch, 'home') };
  recordLifecycleEvents(() => 77, [
    close,
    // Error prose and a relative transcript path fail the I1 shape gate, so these two events are dropped.
    { kind: 'cli.friction', command: 'board_review', issue: null, pr: 3210, error_code: 'gh pr view failed: token ghp_x', blocker_codes: [] },
    { ...close, phase: 'reset', transcript_path: 'session.jsonl' },
  ], env, new Date('2026-11-18T00:00:00.000Z'));
  const path = lifecycleIndexPath(77, env);
  expect(readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
    .toEqual([{ protocol: 'repo-harness.lifecycle-event/v1', at: '2026-11-18T00:00:00.000Z', repository_id: 77, ...close }]);
  if (process.platform !== 'win32') {
    expect(statSync(join(scratch, 'home', 'lifecycle')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
});

test('a failed repository read or append drops the events without a throw', () => {
  const blocked = join(scratch, 'blocked');
  writeFileSync(blocked, '');
  recordLifecycleEvents(() => { throw new Error('gh failed'); }, [close], { ...process.env, REPO_HARNESS_HOME: join(scratch, 'unread') });
  recordLifecycleEvents(() => 77, [close], { ...process.env, REPO_HARNESS_HOME: blocked });
  expect(existsSync(join(scratch, 'unread'))).toBe(false);
});

test('the hook summary counts declared routes by outcome and never throws', () => {
  const source = { path: '.ai/harness/runs/hook-events.jsonl', protocol: 'loop-engine-hook-event/v2', routes: [{ event: 'PreToolUse', routeId: 'bash' }] };
  const worktree = join(scratch, 'worktree');
  mkdirSync(join(worktree, '.ai/harness/runs'), { recursive: true });
  expect(summarizeWorktreeHooks(worktree, source)).toBeNull();
  const record = (fields: Record<string, unknown>) => JSON.stringify({ protocol: source.protocol, host: 'claude', event: 'PreToolUse', route_id: 'bash', exit_code: 0, blocked: false, reason: 'ok', ...fields });
  writeFileSync(join(worktree, source.path), [
    record({}), record({ exit_code: 2, blocked: true, reason: 'I2: would remove /Users/x/secret' }), record({ exit_code: 1, reason: 'handler-failed' }),
    record({ route_id: 'edit' }), record({ protocol: 'old' }), 'not json',
  ].join('\n') + '\n');
  expect(summarizeWorktreeHooks(worktree, source)).toEqual({ 'PreToolUse.bash.ok': 1, 'PreToolUse.bash.blocked': 1, 'PreToolUse.bash.failed': 1 });
  // An unsafe log (a directory in place of the file) makes the segmented log reader throw; the summary is null instead.
  const unsafe = join(scratch, 'unsafe');
  mkdirSync(join(unsafe, source.path), { recursive: true });
  expect(summarizeWorktreeHooks(unsafe, source)).toBeNull();
});

test('closeout records a closed seat pane, and the hook counts only when the checkout is gone', () => {
  const pane = (address: string, seat: string | null, outcome: 'closed' | 'kept') => ({ address, seat, outcome, reason: outcome === 'kept' ? 'dirty' : null });
  const worktree = (checkout_present: boolean) => ({ path: '/tmp/repo-harness-wt-3204-x', outcome: checkout_present ? 'kept' as const : 'removed' as const, reason: null, checkout_present, branch_present: checkout_present });
  const result = (checkout_present: boolean) => ({ kind: 'repo-harness.board-closeout' as const, pr: 3210, merge_commit: 'c'.repeat(40), codegraph_stop_failures: [], stopped_codegraph_servers: [],
    panes: [pane('t1', 'worker', 'closed'), pane('t2', 'reviewer', 'kept')], stale_terminals: [pane('t9', 'gatekeeper', 'closed'), pane('t8', null, 'closed')],
    worktree: worktree(checkout_present), hook_summary: { branch: 'feat/3204-x', counts_by_code: { 'PreToolUse.bash.blocked': 2 } } });
  const closes = [{ ...close, terminal: 't1', issues: [] }, { ...close, seat: 'gatekeeper', terminal: 't9', issues: [], pr: null }];
  expect(closeoutEvents(result(false))).toEqual([...closes,
    { kind: 'worktree.hook_summary', worktree_id: 'repo-harness-wt-3204-x', pr: 3210, branch: 'feat/3204-x', counts_by_code: { 'PreToolUse.bash.blocked': 2 } }]);
  // A kept checkout keeps its log, so a later closeout records the counts once.
  expect(closeoutEvents(result(true))).toEqual(closes);
});
