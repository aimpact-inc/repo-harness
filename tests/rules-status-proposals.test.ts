import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuleProposalReport } from '../src/core/ci/rule-proposals';
import * as proposals from '../src/effects/rules/proposals';
import recorded from './fixtures/rules-proposals/prs-3240-3243.json';
import { runCliInProcess } from './helpers/cli-in-process';
import { commitAll, initGitRepo, run, sandboxEnv, tmpWorkspace } from './helpers/repo-fixture';

const repository = 'aimpact-inc/repo-harness';
const remote = `repos/${repository}`;

function git(repo: string, ...args: string[]): string {
  const result = run('git', args, repo);
  expect(result.stderr).not.toContain('fatal:');
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function checkout(repo: string) {
  initGitRepo(repo);
  git(repo, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  git(repo, 'commit', '--allow-empty', '-m', 'Before the watermark');
  const before = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'commit', '--allow-empty', '-m', 'Ledger watermark');
  const watermark = git(repo, 'rev-parse', 'HEAD');
  mkdirSync(join(repo, 'tasks'));
  writeFileSync(join(repo, 'tasks/lessons.md'), ['# Lessons', '', `reviewed-through: ${watermark}`, '',
    '- Date: 2026-11-19', '- Name: Guard file path', '- Mistake pattern: guard-file-path',
    '- Prevention rule: Check the file path.', '- Why: Detect a missing guard.', '- Triggered by correction: #3240',
    '- Enforced by: judgment', '- Seen: 3×', ''].join('\n'));
  commitAll(repo, 'Merge PR #3240');
  const first = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-c', 'side');
  git(repo, 'commit', '--allow-empty', '-m', 'PR #3243 branch commit');
  const side = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', 'main');
  git(repo, 'merge', '--no-ff', 'side', '-m', 'Merge PR #3243');
  const second = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-c', 'feature');
  git(repo, 'commit', '--allow-empty', '-m', 'Unmerged feature work');
  return { before, watermark, first, side, second };
}

test('rules status reads the recorded PRs on the default branch and emits complete results up to the gh budget', async () => {
  const repo = tmpWorkspace('rules-status-proposals');
  const original = proposals.collectRulesProposals;
  const calls: string[] = [];
  const routes = new Map<string, unknown>();
  let budget: number | undefined;
  const collect = spyOn(proposals, 'collectRulesProposals').mockImplementation((status, input) => original(status, {
    ...input, ghCallLimit: budget,
    gh_runner: args => {
      const path = args[5];
      expect(args).toEqual(['api', '--hostname', 'github.com', '--method', 'GET', path,
        ...(path.endsWith('per_page=100') ? ['--paginate', '--slurp'] : [])]);
      expect(routes.has(path)).toBe(true);
      calls.push(path);
      return { status: 0, stdout: JSON.stringify(routes.get(path)) };
    },
  }));
  const cli = async (...flags: string[]) => {
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await runCliInProcess(['rules', 'status', '--target', join(repo, 'tasks'), ...flags], repo, sandboxEnv());
      return { ...result, status: process.exitCode ?? result.status };
    } finally { process.exitCode = previous; }
  };
  const scan = async (...flags: string[]) => {
    const run = await cli('--proposals', '--json', ...flags);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout) as RuleProposalReport & { themes: { seen: number }[] };
  };
  try {
    const { before, watermark, first, side, second } = checkout(repo);
    routes.set(remote, { default_branch: 'main' });
    routes.set(`${remote}/commits?per_page=1&sha=main`, [{ sha: second }]);
    for (const [number, sha] of [[3240, first], [3243, second]] as const) {
      const pull = recorded[number];
      const rows = pull.commits.flat().map(row => ({ ...row, merge_commit_sha: sha }));
      routes.set(`${remote}/commits/${sha}/pulls?per_page=100`, [rows]);
      routes.set(`${remote}/pulls/${number}/reviews?per_page=100`, pull.reviews);
      const comments = pull.comments.flat();
      routes.set(`${remote}/pulls/${number}/comments?per_page=100`, [comments.slice(0, 1), comments.slice(1)]);
    }
    const clean = () => git(repo, '--no-optional-locks', 'status', '--porcelain', '--untracked-files=all');
    expect(clean()).toBe('');
    const plain = await cli('--json');
    expect(plain.status).toBe(0);
    expect(JSON.parse(plain.stdout)).not.toHaveProperty('experimental');
    expect(calls).toEqual([]);

    const result = await scan();
    expect(result).toMatchObject({ experimental: true, range: { from: watermark, to: second, pull_requests: 2 },
      truncated: null, malformed: 0, proposals: [] });
    expect(result.observations).toEqual([{
      theme_key: null, pull_request: 3240, finding_id: 'init-retirement-discards-staged-user-bytes', severity: 'P1',
      path: 'src/effects/fs-transaction.ts', line: 634, source: 'review_thread', check: null,
      fix: { state: 'confirmed', sha: 'a7acf6c24261e72be7e657008cd042a70be0b6a2' },
    }]);
    const all = await scan('--include-low', '--include-bot');
    const nits = all.observations.filter(row => row.source === 'review_body');
    expect(nits.map(row => row.finding_id).sort()).toEqual([
      'RH2903R1-F1', 'RH2903R1-F2', 'RH2903R1-F3', 'RH2903R1-F4', 'init-dry-run-omits-staged-retirement-guard',
      'init-preview-omits-gate-refusals', 'init-retirement-discards-staged-mode-only-change', 'init-retirement-hash-argv-includes-repo-root',
      'intent-to-add-coverage-removed', 'project-refresh-bypasses-repository-record', 'repository-restore-skips-standalone-directories',
    ]);
    expect(nits.every(row => row.severity === 'P3')).toBe(true);
    expect(all.observations.filter(row => row.source === 'bot')).toEqual([
      expect.objectContaining({ pull_request: 3240, severity: 'P2', fix: { state: 'none' } }),
      expect.objectContaining({ pull_request: 3243, severity: 'P2', line: 122, fix: { state: 'claimed' } }),
    ]);
    expect(all.proposals).toEqual([]);
    expect((await scan('--since', first.slice(0, 12))).range).toEqual({ from: first, to: second, pull_requests: 1 });
    for (const commit of [before, side]) {
      const refused = await cli('--proposals', '--json', '--since', commit);
      expect(refused.status).toBe(1);
      expect(JSON.parse(refused.stdout).error.code).toBe('proposals_since_outside_range');
    }

    budget = 7;
    calls.splice(0);
    const limited = await scan();
    expect(calls).toHaveLength(budget);
    expect(limited.range).toEqual({ from: watermark, to: second, pull_requests: 1 });
    expect(limited.truncated).toEqual({ unread_from: second });
    expect(limited.observations).toEqual(result.observations);
    budget = undefined;

    for (const [number, sha] of [[3240, first], [3243, second]] as const) {
      const example = 'Rule-opportunity: guard-file-path | example: src/main.ts:23 | check: test — Exercise the guard.';
      const rows = recorded[number].commits.flat().map(row => ({ ...row, merge_commit_sha: sha,
        body: `${row.body}\n${example}${number === 3240 ? `\n${example}\n${example.replace('check: test', 'check: lint')}` : ''}` }));
      routes.set(`${remote}/commits/${sha}/pulls?per_page=100`, [rows]);
    }
    const marked = await scan();
    expect(marked.malformed).toBe(1);
    expect(marked.themes[0]?.seen).toBe(3);
    expect(marked.proposals).toEqual([{ theme_key: 'guard-file-path', pull_requests: [3240, 3243], in_ledger: true }]);
    const text = await cli('--proposals');
    expect(text.status).toBe(0);
    expect(text.stdout).toContain(`${watermark}..${second}`);
    expect(text.stdout).toContain('PRs 2 · observations 4 · proposals 1 · malformed markers 1');
    expect(text.stdout).toContain('guard-file-path in #3240, #3243 (in ledger)');
    expect((await cli('--help')).stdout).toMatch(/--proposals[^\n]*\(experimental\)/u);
    expect((await cli('--json')).stdout).toBe(plain.stdout);
    expect(clean()).toBe('');
  } finally {
    collect.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  }
}, 60_000);
