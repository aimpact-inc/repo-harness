import { afterEach, expect, spyOn, test } from 'bun:test';
import { readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { buildAutopilotCommand, type AutopilotCommandPorts } from '../src/cli/commands/autopilot';
import {
  AUTOPILOT_LOCAL_AUTHORITY,
  AUTOPILOT_MERGE_POLICY,
  AUTOPILOT_PROTOCOL,
  AUTOPILOT_STATUS_KIND,
  AutopilotError,
  decodeAutopilotState,
  defaultAutopilotState,
  formatAutopilotAdvisorTickMessage,
  isAutopilotEnabled,
} from '../src/core/board/autopilot';
import { WINDOW_WITHOUT_WORKERS_MS, WINDOW_WITH_WORKERS_MS, type AttentionHostPortsV1 } from '../src/core/board/attention-delivery';
import type { BoardSeatTerminalReadV1, BoardV1 } from '../src/core/board/board';
import {
  buildQuotaReport,
  decodeClaudeQuotaCapture,
  decodeCodexRateLimitsResult,
  type QuotaReport,
} from '../src/core/board/quota';
import {
  AUTOPILOT_STATE_REFRESH_MS,
  attentionAutopilotTicker,
  attentionLogPath,
  runAttentionWindow,
} from '../src/effects/board/attention-watch';
import { BoardCollectError, readGhJson } from '../src/effects/board/collect';
import {
  autopilotStatePath,
  readAutopilotState,
  readAutopilotStateAtPath,
  recordAutopilotAdvisorTick,
  startAutopilot,
  stopAutopilot,
} from '../src/effects/board/autopilot-store';
import { commitAll, initGitRepo, run, tmpWorkspace } from './helpers/repo-fixture';

const cleanupPaths: string[] = [];
afterEach(() => {
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createTempGitRepo(prefix = 'rh-autopilot-'): string {
  const dir = tmpWorkspace(prefix);
  cleanupPaths.push(dir);
  initGitRepo(dir);
  writeFileSync(join(dir, 'README.md'), 'autopilot fixture\n');
  commitAll(dir, 'init');
  return dir;
}

function minimalBoard(now: Date, execution: BoardV1['execution'] = { status: 'observed', terminals: [] }): BoardV1 {
  return {
    protocol: 15,
    kind: 'repo-harness.board',
    observed_at: now.toISOString(),
    repository: 'aimpact-inc/repo-harness',
    default_branch: 'main',
    acceptance_merge: 'on',
    parent: { number: 3581, title: 'Release 0.38.0', url: 'https://github.com/aimpact-inc/repo-harness/issues/3581', state: 'open', labels: [], milestone: null },
    plan: { status: 'absent', truncated: false },
    merge_hold: { status: 'none' },
    items: [],
    pull_requests: [],
    path_owners: { status: 'observed', owners: [] },
    execution,
    seat_liveness: { status: 'observed', probes: [] },
    daily_run: { status: 'unavailable', reason: 'test_fixture' },
    tooling: {
      hc: { status: 'observed', version: '0.1.25', min_version: '0.1.22' },
      herdr_app: { status: 'not_pinned' },
    },
  };
}

function healthyQuotaReport(nowMs: number): QuotaReport {
  const observedAt = new Date(nowMs - 60_000).toISOString();
  const reset5h = Math.floor((nowMs + 4 * 3_600_000) / 1000);
  const reset7d = Math.floor((nowMs + 5 * 86_400_000) / 1000);
  const claude = decodeClaudeQuotaCapture({
    observed_at: observedAt,
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: reset5h },
      seven_day: { used_percentage: 25, resets_at: reset7d },
    },
  });
  const chatgpt = decodeCodexRateLimitsResult({
    rateLimits: {
      primary: { windowDurationMins: 300, usedPercent: 15, resetsAt: reset5h },
      secondary: { windowDurationMins: 10080, usedPercent: 20, resetsAt: reset7d },
      credits: null,
      planType: 'pro',
      rateLimitReachedType: null,
    },
  }, observedAt);
  return buildQuotaReport([claude, chatgpt], nowMs);
}

function staleClaudeQuotaReport(nowMs: number): QuotaReport {
  const staleAt = new Date(nowMs - 45 * 60_000).toISOString();
  const freshAt = new Date(nowMs - 60_000).toISOString();
  const reset5h = Math.floor((nowMs + 4 * 3_600_000) / 1000);
  const reset7d = Math.floor((nowMs + 5 * 86_400_000) / 1000);
  const claude = decodeClaudeQuotaCapture({
    observed_at: staleAt,
    rate_limits: {
      five_hour: { used_percentage: 20, resets_at: reset5h },
      seven_day: { used_percentage: 25, resets_at: reset7d },
    },
  });
  const chatgpt = decodeCodexRateLimitsResult({
    rateLimits: {
      primary: { windowDurationMins: 300, usedPercent: 15, resetsAt: reset5h },
      secondary: { windowDurationMins: 10080, usedPercent: 20, resetsAt: reset7d },
      credits: null,
      planType: 'pro',
      rateLimitReachedType: null,
    },
  }, freshAt);
  return buildQuotaReport([claude, chatgpt], nowMs);
}

function fakeAdvisorTerminal(address: string, status: string | null, seat = 'advisor', state: 'live' | 'finished' = 'live'): BoardSeatTerminalReadV1 {
  return {
    address,
    name: `rh-${seat}`,
    agent: 'claude',
    state,
    status,
    status_kind: null,
    status_msg: null,
    status_ms: null,
    turn: 1,
    cwd: '/tmp/repo',
    where: null,
    agent_pid: 1234,
    labels: { seat, issue: undefined, pr: undefined, parent: undefined },
  };
}

function fakeAttentionHost(sent: Array<{ readonly terminal: string; readonly text: string }>, failSend = false): AttentionHostPortsV1 {
  return {
    ownTerminal: () => ({ status: 'failed', reason: 'not_watcher', detail: 'unused' }),
    watchers: () => ({ status: 'observed', watchers: [] }),
    startWatcher: () => ({ status: 'failed', reason: 'unused', detail: 'unused' }),
    send: (terminal, text) => {
      if (failSend) return { status: 'failed', reason: 'hc_failed', detail: 'terminal refused send' };
      sent.push({ terminal, text });
      return { status: 'sent' };
    },
    state: () => ({ status: 'observed', ended: false, state: 'idle' }),
    wait: () => ({ status: 'observed', ended: false, reason: 'timeout', state: 'idle' }),
  };
}

async function runAutopilotCli(args: readonly string[], ports: AutopilotCommandPorts) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = new Command().name('rh');
  program.addCommand(buildAutopilotCommand(ports));
  const out = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { stdout.push(String(chunk)); return true; });
  const err = spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
  const prev = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync([...args], { from: 'user' });
    return { exitCode: process.exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
  } finally {
    process.exitCode = prev;
    out.mockRestore();
    err.mockRestore();
  }
}

test('local autopilot store writes 0600 atomic state in git-common-dir shared across worktrees and enforces local-only authority', () => {
  const repo = createTempGitRepo();
  const worktree = join(tmpWorkspace('rh-autopilot-wt-'), 'wt');
  cleanupPaths.push(dirname(worktree));
  expect(run('git', ['worktree', 'add', '-b', 'feat/wt', worktree, 'HEAD'], repo).status).toBe(0);

  const initial = readAutopilotState(repo);
  expect(initial.exists).toBe(false);
  expect(initial.state).toEqual(defaultAutopilotState());
  expect(isAutopilotEnabled(initial.state)).toBe(false);

  // Refuse every non-local activation source before touching disk.
  for (const source of ['github_comment', 'webhook', 'pr_body', 'issue_text', '', null, undefined]) {
    expect(() => startAutopilot({ repo_root: repo, source, now: new Date('2026-11-27T10:00:00.000Z') })).toThrow(AutopilotError);
    try {
      startAutopilot({ repo_root: repo, source, now: new Date('2026-11-27T10:00:00.000Z') });
    } catch (error) {
      expect((error as AutopilotError).code).toBe('autopilot_non_local_activation_refused');
    }
  }
  expect(readAutopilotState(repo).exists).toBe(false);

  // Start locally from primary checkout and observe identical state from linked worktree.
  const t0 = new Date('2026-11-27T10:00:00.000Z');
  const started = startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, now: t0 });
  expect(started.path).toBe(autopilotStatePath(worktree));
  expect(started.exists).toBe(true);
  expect(started.state).toEqual({
    protocol: AUTOPILOT_PROTOCOL,
    enabled: true,
    activated_at: t0.toISOString(),
    activated_by: AUTOPILOT_LOCAL_AUTHORITY,
    cadence_minutes: 60,
    merge_policy: AUTOPILOT_MERGE_POLICY,
    low_tier_skip: true,
    council_max_members_default: 1,
    target_parallel_workers: 5,
    target_parallel_ci: 5,
    stopped_at: null,
    stop_reason: null,
    last_advisor_tick_at: null,
  });
  if (process.platform !== 'win32') {
    expect(statSync(started.path).mode & 0o777).toBe(0o600);
  }
  expect(readAutopilotState(worktree).state).toEqual(started.state);

  // Record an advisor tick, then stop locally; a later tick record never re-enables stopped state.
  const t1 = new Date('2026-11-27T11:00:00.000Z');
  const ticked = recordAutopilotAdvisorTick({ repo_root: worktree, now: t1 });
  expect(ticked.state.last_advisor_tick_at).toBe(t1.toISOString());

  const t2 = new Date('2026-11-27T11:15:00.000Z');
  const stopped = stopAutopilot({ repo_root: repo, reason: 'owner verbal stop', now: t2 });
  expect(stopped.state.enabled).toBe(false);
  expect(stopped.state.stopped_at).toBe(t2.toISOString());
  expect(stopped.state.stop_reason).toBe('owner verbal stop');
  expect(stopped.state.last_advisor_tick_at).toBe(t1.toISOString());

  const t3 = new Date('2026-11-27T12:00:00.000Z');
  const afterStopTick = recordAutopilotAdvisorTick({ repo_root: repo, now: t3 });
  expect(afterStopTick.state.enabled).toBe(false);
  expect(afterStopTick.state.last_advisor_tick_at).toBe(t1.toISOString());

  // Tampered state with non-local activated_by fails closed.
  expect(() => decodeAutopilotState({
    ...started.state,
    activated_by: 'github_comment',
  })).toThrow(AutopilotError);
  writeFileSync(started.path, `${JSON.stringify({ ...started.state, activated_by: 'webhook' })}\n`, { mode: 0o600 });
  expect(() => readAutopilotState(repo)).toThrow('owner_local');

  // Symlink state path fails closed.
  const decoy = join(repo, 'decoy.json');
  writeFileSync(decoy, `${JSON.stringify(started.state)}\n`);
  rmSync(started.path);
  symlinkSync(decoy, started.path);
  expect(() => readAutopilotState(repo)).toThrow('not a regular file');
});

test('attention watcher hourly advisor tick resolves advisor dynamically by labels, skips busy/resetting advisor, and respects injected clock and immediate stop', async () => {
  const repo = createTempGitRepo();
  const home = tmpWorkspace('rh-autopilot-home-');
  cleanupPaths.push(home);
  const logPath = attentionLogPath(1186405141, 3581, { REPO_HARNESS_HOME: home });
  const sent: Array<{ readonly terminal: string; readonly text: string }> = [];
  const queriedRepos: string[] = [];
  let terminals: BoardSeatTerminalReadV1[] = [fakeAdvisorTerminal('t10', 'idle')];
  let advisorInReset = false;

  let clock = Date.parse('2026-11-27T10:00:00.000Z');
  const tick = attentionAutopilotTicker({
    repository_id: 1186405141,
    parent: 3581,
    host: fakeAttentionHost(sent),
    ports: {
      readState: () => readAutopilotState(repo),
      recordTick: now => recordAutopilotAdvisorTick({ repo_root: repo, now }),
      readQuota: () => healthyQuotaReport(clock),
      seatTerminals: repoId => {
        queriedRepos.push(repoId);
        return { status: 'observed', terminals };
      },
      isAdvisorInReset: () => advisorInReset,
    },
  });

  const runWindow = (deliver = true) => runAttentionWindow({
    parent: 3581,
    deliver,
    log_path: logPath,
    autopilot_tick: tick,
    collect: () => minimalBoard(new Date(clock)),
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async () => {},
  });

  // OFF: no-op, never queries hc seats.
  await runWindow();
  expect(sent).toEqual([]);
  expect(queriedRepos).toEqual([]);

  // Enable at 10:00 with 60m cadence.
  startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, now: new Date(clock) });

  // 10:45: not due yet -> no hc query, no send.
  clock += 45 * 60_000;
  await runWindow();
  expect(sent).toEqual([]);
  expect(queriedRepos).toEqual([]);

  // 11:00: due, but advisor is working -> skipped, last_advisor_tick_at stays null.
  clock += 15 * 60_000;
  terminals = [fakeAdvisorTerminal('t10', 'working')];
  await runWindow();
  expect(sent).toEqual([]);
  expect(queriedRepos).toEqual(['1186405141']);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBeNull();

  // 11:15: still due (deferred), advisor is blocked -> skipped.
  clock += 15 * 60_000;
  terminals = [fakeAdvisorTerminal('t10', 'blocked')];
  await runWindow();
  expect(sent).toEqual([]);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBeNull();

  // 11:30: advisor is idle, but has an open reset request -> skipped.
  clock += 15 * 60_000;
  terminals = [fakeAdvisorTerminal('t10', 'idle')];
  advisorInReset = true;
  await runWindow();
  expect(sent).toEqual([]);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBeNull();

  // 11:35: no live advisor -> skipped as absent; two live advisors -> skipped as ambiguous.
  advisorInReset = false;
  terminals = [];
  await runWindow();
  terminals = [fakeAdvisorTerminal('t10', 'idle'), fakeAdvisorTerminal('t11', 'idle')];
  await runWindow();
  expect(sent).toEqual([]);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBeNull();

  // 11:45: reset ended, advisor moved to a new terminal address t99 (dynamic label resolution) -> sent!
  clock += 15 * 60_000;
  advisorInReset = false;
  terminals = [
    fakeAdvisorTerminal('t10', 'idle', 'advisor', 'finished'),
    fakeAdvisorTerminal('t99', 'done', 'advisor', 'live'),
    fakeAdvisorTerminal('t4cc', 'idle', 'orchestrator', 'live'),
  ];
  await runWindow();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.terminal).toBe('t99');
  expect(sent[0]!.text).toContain('[rh-notice] advisor-plan #3581 /tmp/repo-harness-advisor/plans/1186405141-20261127-1145.md');
  expect(sent[0]!.text).toContain('batch parents and standalone open issues');
  expect(sent[0]!.text).toContain('repo-harness.repository=1186405141');
  expect(sent[0]!.text).toContain('repo-harness.seat=orchestrator');
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBe('2026-11-27T11:45:00.000Z');

  // 12:15 (30m after tick): not due yet.
  clock += 30 * 60_000;
  await runWindow();
  expect(sent).toHaveLength(1);

  // Stop locally before 12:45: immediate effect, no send at 12:45.
  stopAutopilot({ repo_root: repo, reason: 'done', now: new Date(clock) });
  clock += 30 * 60_000;
  await runWindow();
  expect(sent).toHaveLength(1);

  // Verify attention log recorded skips and sent tick without counting against advisor attention wakes.
  const records = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ticks = records.filter(record => record.kind === 'autopilot_tick');
  expect(ticks.map(record => [record.outcome, record.reason, record.terminal])).toEqual([
    ['skipped', 'advisor_busy', 't10'],
    ['skipped', 'advisor_busy', 't10'],
    ['skipped', 'advisor_in_reset', 't10'],
    ['skipped', 'advisor_seat_absent', null],
    ['skipped', 'advisor_seat_ambiguous', null],
    ['sent', null, 't99'],
  ]);
});

test('shorter cadence fires mid-window with advancing clock and deliver=false never sends ticks', async () => {
  const repo = createTempGitRepo();
  const home = tmpWorkspace('rh-autopilot-cadence-');
  cleanupPaths.push(home);
  const logPath = attentionLogPath(1186405141, 3581, { REPO_HARNESS_HOME: home });
  const sent: Array<{ readonly terminal: string; readonly text: string }> = [];
  const tickTimes: string[] = [];

  let clock = Date.parse('2026-11-27T10:00:00.000Z');
  startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, cadence_minutes: 20, now: new Date(clock) });

  const statePath = autopilotStatePath(repo);
  const tick = attentionAutopilotTicker({
    repository_id: 1186405141,
    parent: 3581,
    host: fakeAttentionHost(sent),
    ports: {
      readState: () => readAutopilotStateAtPath(statePath),
      recordTick: now => {
        tickTimes.push(now.toISOString());
        return recordAutopilotAdvisorTick({ repo_root: repo, now });
      },
      readQuota: () => healthyQuotaReport(clock),
      seatTerminals: () => ({ status: 'observed', terminals: [fakeAdvisorTerminal('t42', 'idle')] }),
      isAdvisorInReset: () => false,
    },
  });

  // deliver=false: sleeps full 60m window without sending any tick even though cadence is 20m.
  const drySlept: number[] = [];
  await runAttentionWindow({
    parent: 3581,
    deliver: false,
    log_path: logPath,
    autopilot_tick: tick,
    collect: () => minimalBoard(new Date(clock)),
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async ms => { drySlept.push(ms); clock += ms; },
  });
  expect(drySlept).toEqual([WINDOW_WITHOUT_WORKERS_MS]);
  expect(sent).toEqual([]);

  // Reset clock to 10:00 and run with deliver=true: 20m cadence fires at 10:20 and 10:40 inside the 60m window, then 11:00 on window 2.
  clock = Date.parse('2026-11-27T10:00:00.000Z');
  const slept: number[] = [];
  const runLiveWindow = () => runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    autopilot_tick: tick,
    collect: () => minimalBoard(new Date(clock)),
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async ms => { slept.push(ms); clock += ms; },
  });
  await runLiveWindow();
  await runLiveWindow();
  expect(tickTimes).toEqual([
    '2026-11-27T10:20:00.000Z',
    '2026-11-27T10:40:00.000Z',
    '2026-11-27T11:00:00.000Z',
    '2026-11-27T11:20:00.000Z',
    '2026-11-27T11:40:00.000Z',
  ]);
  expect(slept.every(step => step > 0 && step <= AUTOPILOT_STATE_REFRESH_MS)).toBe(true);
  expect(slept.reduce((sum, step) => sum + step, 0)).toBe(2 * WINDOW_WITHOUT_WORKERS_MS);
  expect(WINDOW_WITH_WORKERS_MS).toBe(15 * 60_000);

  // Busy advisor defers inside a 60m no-worker window and retries after 15m once idle.
  const deferRepo = createTempGitRepo('rh-autopilot-defer-');
  const deferSent: Array<{ readonly terminal: string; readonly text: string }> = [];
  let deferClock = Date.parse('2026-11-27T10:00:00.000Z');
  startAutopilot({ repo_root: deferRepo, source: AUTOPILOT_LOCAL_AUTHORITY, cadence_minutes: 60, now: new Date(deferClock) });
  deferClock += 60 * 60_000; // 11:00: due now
  let advisorStatus: string = 'working';
  const deferStatePath = autopilotStatePath(deferRepo);
  const deferTicker = attentionAutopilotTicker({
    repository_id: 1186405141,
    parent: 3581,
    host: fakeAttentionHost(deferSent),
    ports: {
      readState: () => readAutopilotStateAtPath(deferStatePath),
      recordTick: now => recordAutopilotAdvisorTick({ repo_root: deferRepo, now }),
      readQuota: () => healthyQuotaReport(deferClock),
      seatTerminals: () => ({ status: 'observed', terminals: [fakeAdvisorTerminal('t77', advisorStatus)] }),
      isAdvisorInReset: () => false,
    },
  });
  await runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    autopilot_tick: deferTicker,
    collect: () => minimalBoard(new Date(deferClock)),
    host: fakeAttentionHost(deferSent),
    now: () => new Date(deferClock),
    sleep: async ms => {
      deferClock += ms;
      if (deferClock >= Date.parse('2026-11-27T11:15:00.000Z')) advisorStatus = 'idle';
    },
  });
  expect(deferSent).toHaveLength(1);
  expect(deferSent[0]!.terminal).toBe('t77');
  expect(readAutopilotState(deferRepo).state.last_advisor_tick_at).toBe('2026-11-27T11:15:00.000Z');
});

test('CLI rh autopilot start|stop|status handles cadence, stop reason, JSON/text output, and parked list', async () => {
  const repo = createTempGitRepo();
  let clock = new Date('2026-11-27T12:00:00.000Z');
  const ports: AutopilotCommandPorts = { cwd: () => repo, now: () => clock };

  const initialJson = await runAutopilotCli(['autopilot', 'status', '--json'], ports);
  expect(initialJson.exitCode).toBe(0);
  expect(JSON.parse(initialJson.stdout)).toMatchObject({
    protocol: AUTOPILOT_PROTOCOL,
    kind: AUTOPILOT_STATUS_KIND,
    state_exists: false,
    enabled: false,
    activated_at: null,
    last_advisor_tick_at: null,
    parked: [],
  });

  const badCadence = await runAutopilotCli(['autopilot', 'start', '--cadence', '0'], ports);
  expect(badCadence.exitCode).toBe(2);
  expect(JSON.parse(badCadence.stderr)).toMatchObject({ ok: false, error: 'autopilot_invalid_option' });

  const started = await runAutopilotCli(['autopilot', 'start', '--cadence', '45', '--json'], ports);
  expect(started.exitCode).toBe(0);
  expect(JSON.parse(started.stdout)).toMatchObject({
    enabled: true,
    activated_at: '2026-11-27T12:00:00.000Z',
    activated_by: AUTOPILOT_LOCAL_AUTHORITY,
    cadence_minutes: 45,
    target_parallel_workers: 5,
    target_parallel_ci: 5,
    parked: [],
  });

  const statusText = await runAutopilotCli(['autopilot', 'status'], {
    ...ports,
    readParked: () => [{ kind: 'pull_request', number: 3590, category: 'high_security_uncertain', reason: 'Confirm I1 scope' }],
  });
  expect(statusText.exitCode).toBe(0);
  expect(statusText.stdout).toContain('Auto-pilot: ON (owner_local)');
  expect(statusText.stdout).toContain('Activated at: 2026-11-27T12:00:00.000Z');
  expect(statusText.stdout).toContain('Last advisor tick: none');
  expect(statusText.stdout).toContain('pull_request #3590 [high_security_uncertain]: Confirm I1 scope');

  clock = new Date('2026-11-27T13:00:00.000Z');
  const stopped = await runAutopilotCli(['autopilot', 'stop', '--reason', 'manual check', '--json'], ports);
  expect(stopped.exitCode).toBe(0);
  expect(JSON.parse(stopped.stdout)).toMatchObject({
    enabled: false,
    stopped_at: '2026-11-27T13:00:00.000Z',
    stop_reason: 'manual check',
  });

  // Pure tick message formatting sanity check against advisor text limits (single line, repo-scoped plan path, [rh-notice] envelope).
  const msg = formatAutopilotAdvisorTickMessage({
    repository_id: 42,
    parent: 3581,
    now: clock,
    state: readAutopilotState(repo).state,
  });
  expect(msg).not.toContain('\n');
  expect(msg).toContain('repo-harness.repository=42');
  expect(msg).toContain('[rh-notice] advisor-plan #3581 /tmp/repo-harness-advisor/plans/42-20261127-1300.md');
});

test('board read failure sends nothing across the failed window and keeps last_advisor_tick_at unchanged', async () => {
  const repo = createTempGitRepo('rh-autopilot-board-fail-');
  const home = tmpWorkspace('rh-autopilot-board-fail-home-');
  cleanupPaths.push(home);
  const logPath = attentionLogPath(1186405141, 3581, { REPO_HARNESS_HOME: home });
  const sent: Array<{ readonly terminal: string; readonly text: string }> = [];
  let quotaReads = 0;

  let clock = Date.parse('2026-11-27T10:00:00.000Z');
  startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, cadence_minutes: 1, now: new Date(clock) });
  clock += 60_000; // 10:01: due now

  const ticker = attentionAutopilotTicker({
    repository_id: 1186405141,
    parent: 3581,
    host: fakeAttentionHost(sent),
    ports: {
      readState: () => readAutopilotState(repo),
      recordTick: now => recordAutopilotAdvisorTick({ repo_root: repo, now }),
      readQuota: () => {
        quotaReads += 1;
        return healthyQuotaReport(clock);
      },
      seatTerminals: () => ({ status: 'observed', terminals: [fakeAdvisorTerminal('t55', 'idle')] }),
      isAdvisorInReset: () => false,
    },
  });

  // Recoverable GitHub 503 via readGhJson: logs board_unavailable, sends nothing during the entire 15m failed window, keeps timestamp null.
  const slept: number[] = [];
  const errSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await runAttentionWindow({
      parent: 3581,
      deliver: true,
      log_path: logPath,
      autopilot_tick: ticker,
      collect: () => readGhJson({ repo_root: repo, gh_runner: () => ({ status: 1, stdout: '', stderr: 'gh: HTTP 503' }) }, ['api', 'graphql']) as BoardV1,
      host: fakeAttentionHost(sent),
      now: () => new Date(clock),
      sleep: async ms => { slept.push(ms); clock += ms; },
    });
  } finally {
    errSpy.mockRestore();
  }
  expect(slept).toEqual([WINDOW_WITH_WORKERS_MS]);
  expect(sent).toEqual([]);
  expect(quotaReads).toBe(0);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBeNull();

  // Fatal board error also fails before any send and keeps timestamp null.
  await expect(runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    autopilot_tick: ticker,
    collect: () => { throw new BoardCollectError('gh auth failed'); },
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async () => {},
  })).rejects.toBeInstanceOf(BoardCollectError);
  expect(sent).toEqual([]);
  expect(quotaReads).toBe(0);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBeNull();

  const records = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ticks = records.filter(record => record.kind === 'autopilot_tick');
  expect(ticks.map(record => [record.outcome, record.reason])).toEqual([
    ['skipped', 'board_unavailable'],
    ['skipped', 'board_unavailable'],
  ]);
});

test('unknown quota skips due tick without sending or stamping last_advisor_tick_at', async () => {
  const repo = createTempGitRepo('rh-autopilot-quota-unknown-');
  const home = tmpWorkspace('rh-autopilot-quota-unknown-home-');
  cleanupPaths.push(home);
  const logPath = attentionLogPath(1186405141, 3581, { REPO_HARNESS_HOME: home });
  const sent: Array<{ readonly terminal: string; readonly text: string }> = [];
  let seatQueries = 0;

  let clock = Date.parse('2026-11-27T10:00:00.000Z');
  startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, cadence_minutes: 1, now: new Date(clock) });
  clock += 60_000; // 10:01: due now

  let stale = true;
  const ticker = attentionAutopilotTicker({
    repository_id: 1186405141,
    parent: 3581,
    host: fakeAttentionHost(sent),
    ports: {
      readState: () => readAutopilotState(repo),
      recordTick: now => recordAutopilotAdvisorTick({ repo_root: repo, now }),
      readQuota: () => (stale ? staleClaudeQuotaReport(clock) : healthyQuotaReport(clock)),
      seatTerminals: () => {
        seatQueries += 1;
        return { status: 'observed', terminals: [fakeAdvisorTerminal('t61', 'idle')] };
      },
      isAdvisorInReset: () => false,
    },
  });

  await runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    autopilot_tick: ticker,
    collect: () => minimalBoard(new Date(clock)),
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async () => {},
  });
  expect(sent).toEqual([]);
  expect(seatQueries).toBe(0);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBeNull();

  // Once quota is fresh again on the next window, the due tick sends and stamps timestamp.
  stale = false;
  clock += 60_000;
  await runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    autopilot_tick: ticker,
    collect: () => minimalBoard(new Date(clock)),
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async () => {},
  });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.terminal).toBe('t61');
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBe('2026-11-27T10:02:00.000Z');

  const records = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ticks = records.filter(record => record.kind === 'autopilot_tick');
  expect(ticks.map(record => [record.outcome, record.reason])).toEqual([
    ['skipped', 'quota_unknown'],
    ['sent', null],
  ]);
  expect(ticks[0]!.detail).toContain('claude: reading older than 30 min');
});

test('unknown quota latches for the rest of the board window even when quota recovers before window end, then sends in the next window', async () => {
  const repo = createTempGitRepo('rh-autopilot-quota-latch-');
  const home = tmpWorkspace('rh-autopilot-quota-latch-home-');
  cleanupPaths.push(home);
  const logPath = attentionLogPath(1186405141, 3581, { REPO_HARNESS_HOME: home });
  const sent: Array<{ readonly terminal: string; readonly text: string }> = [];
  const statePath = autopilotStatePath(repo);
  let boardReads = 0;
  let quotaReads = 0;

  let clock = Date.parse('2026-11-27T10:00:00.000Z');
  startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, cadence_minutes: 1, now: new Date(clock) });
  clock += 60_000; // 10:01: first due time

  let stale = true;
  const ticker = attentionAutopilotTicker({
    repository_id: 1186405141,
    parent: 3581,
    host: fakeAttentionHost(sent),
    ports: {
      readState: () => readAutopilotStateAtPath(statePath),
      recordTick: now => recordAutopilotAdvisorTick({ repo_root: repo, now }),
      readQuota: () => {
        quotaReads += 1;
        return stale ? staleClaudeQuotaReport(clock) : healthyQuotaReport(clock);
      },
      seatTerminals: () => ({ status: 'observed', terminals: [fakeAdvisorTerminal('t62', 'idle')] }),
      isAdvisorInReset: () => false,
    },
  });

  // Window 1 (10:01 -> 11:01): quota is unknown at 10:01, becomes healthy at 10:02 while the sleep stub
  // advances the clock across every 30s review tick in the same board window. Nothing sends until window 2.
  await runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    review_collect: () => ({ orchestrators: [], lines: [] }),
    autopilot_tick: ticker,
    collect: () => {
      boardReads += 1;
      return minimalBoard(new Date(clock));
    },
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async ms => {
      clock += ms;
      if (clock >= Date.parse('2026-11-27T10:02:00.000Z')) stale = false;
    },
  });
  expect(clock).toBe(Date.parse('2026-11-27T11:01:00.000Z'));
  expect(stale).toBe(false);
  expect(boardReads).toBe(1);
  expect(quotaReads).toBe(1);
  expect(sent).toEqual([]);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBeNull();

  // Window 2 (11:01): fresh board read clears the latch and sends once.
  await runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    autopilot_tick: ticker,
    collect: () => {
      boardReads += 1;
      return minimalBoard(new Date(clock));
    },
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async () => {},
  });
  expect(boardReads).toBe(2);
  expect(quotaReads).toBe(2);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.terminal).toBe('t62');
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBe('2026-11-27T11:01:00.000Z');

  const records = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const ticks = records.filter(record => record.kind === 'autopilot_tick');
  expect(ticks.map(record => [record.outcome, record.reason])).toEqual([
    ['skipped', 'quota_unknown'],
    ['sent', null],
  ]);
});

test('already-due deadline passed during review work ticks before sleeping', async () => {
  const repo = createTempGitRepo('rh-autopilot-overdue-');
  const home = tmpWorkspace('rh-autopilot-overdue-home-');
  cleanupPaths.push(home);
  const logPath = attentionLogPath(1186405141, 3581, { REPO_HARNESS_HOME: home });
  const sent: Array<{ readonly terminal: string; readonly text: string }> = [];
  const timeline: string[] = [];

  let clock = Date.parse('2026-11-27T10:00:00.000Z');
  startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, cadence_minutes: 1, now: new Date(clock) });

  const ticker = attentionAutopilotTicker({
    repository_id: 1186405141,
    parent: 3581,
    host: {
      send: (terminal, text) => {
        timeline.push(`send@${new Date(clock).toISOString()}`);
        sent.push({ terminal, text });
        return { status: 'sent' };
      },
    },
    ports: {
      readState: () => readAutopilotState(repo),
      recordTick: now => recordAutopilotAdvisorTick({ repo_root: repo, now }),
      readQuota: () => healthyQuotaReport(clock),
      seatTerminals: () => ({ status: 'observed', terminals: [fakeAdvisorTerminal('t71', 'idle')] }),
      isAdvisorInReset: () => false,
    },
  });

  await runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    autopilot_tick: ticker,
    collect: () => minimalBoard(new Date(clock)),
    // Review work takes 2 minutes, passing the 10:01 deadline before sleepThroughWindow begins.
    review: async () => { clock = Date.parse('2026-11-27T10:02:00.000Z'); },
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async () => {
      timeline.push(`sleep@${new Date(clock).toISOString()}`);
    },
  });

  expect(timeline).toEqual([
    'send@2026-11-27T10:02:00.000Z',
    'sleep@2026-11-27T10:02:00.000Z',
  ]);
  expect(sent).toHaveLength(1);
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBe('2026-11-27T10:02:00.000Z');
});

test('starting autopilot during an OFF no-worker window ticks without restarting the watcher', async () => {
  const repo = createTempGitRepo('rh-autopilot-midstart-');
  const home = tmpWorkspace('rh-autopilot-midstart-home-');
  cleanupPaths.push(home);
  const logPath = attentionLogPath(1186405141, 3581, { REPO_HARNESS_HOME: home });
  const sent: Array<{ readonly terminal: string; readonly text: string }> = [];
  const tickTimes: string[] = [];

  const statePath = autopilotStatePath(repo);
  let clock = Date.parse('2026-11-27T10:00:00.000Z');
  let startedMidWindow = false;
  let shortenedCadence = false;
  const ticker = attentionAutopilotTicker({
    repository_id: 1186405141,
    parent: 3581,
    host: fakeAttentionHost(sent),
    ports: {
      readState: () => readAutopilotStateAtPath(statePath),
      recordTick: now => {
        tickTimes.push(now.toISOString());
        return recordAutopilotAdvisorTick({ repo_root: repo, now });
      },
      readQuota: () => healthyQuotaReport(clock),
      seatTerminals: () => ({ status: 'observed', terminals: [fakeAdvisorTerminal('t81', 'idle')] }),
      isAdvisorInReset: () => false,
    },
  });

  // Window starts at 10:00 with autopilot OFF and no review_collect poll; owner enables 60m cadence at 10:01,
  // then shortens cadence to 2m at 10:02: both take effect inside the same window without restarting the watcher.
  await runAttentionWindow({
    parent: 3581,
    deliver: true,
    log_path: logPath,
    autopilot_tick: ticker,
    collect: () => minimalBoard(new Date(clock)),
    host: fakeAttentionHost(sent),
    now: () => new Date(clock),
    sleep: async ms => {
      clock += ms;
      if (!startedMidWindow && clock >= Date.parse('2026-11-27T10:01:00.000Z')) {
        startedMidWindow = true;
        startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, cadence_minutes: 60, now: new Date(clock) });
      }
      if (!shortenedCadence && clock >= Date.parse('2026-11-27T10:02:00.000Z')) {
        shortenedCadence = true;
        startAutopilot({ repo_root: repo, source: AUTOPILOT_LOCAL_AUTHORITY, cadence_minutes: 2, now: new Date(clock) });
      }
      if (tickTimes.length >= 1) clock = Date.parse('2026-11-27T11:00:00.000Z');
    },
  });

  expect(tickTimes).toEqual(['2026-11-27T10:04:00.000Z']);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.terminal).toBe('t81');
  expect(readAutopilotState(repo).state.last_advisor_tick_at).toBe('2026-11-27T10:04:00.000Z');
});
