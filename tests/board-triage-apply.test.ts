import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { buildBoardCommand } from '../src/cli/commands/board';
import { decodePlanBlock } from '../src/core/board/plan-block';
import { decodeTriageManifest, planTriageApply, TRIAGE_MANIFEST_SCHEMA_VERSION, TriageApplyValidationError } from '../src/core/board/triage-apply';
import { gitHubTriageApplyPorts, runTriageApply, type TriageApplyPorts } from '../src/effects/board/triage-apply';
import { attentionHostPorts, boardHostPorts } from '../src/effects/terminal/herdr-core';

const COORDINATOR = 'https://github.com/aimpact-inc/repo-harness/issues/3343#issuecomment-1';
const PLAN_URL = 'https://github.com/aimpact-inc/repo-harness/issues/3343#issuecomment-2';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifestFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'rh-triage-apply-'));
  roots.push(dir);
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function baseManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: TRIAGE_MANIFEST_SCHEMA_VERSION,
    repository: 'aimpact-inc/repo-harness',
    parent: 3343,
    coordinator: COORDINATOR,
    baseline: 'main@2812605',
    supersedes: null,
    issues: [
      { number: 101, module: 'organization/board', tier: 'medium', route: 'simple_fast', target_files: ['src/a.ts'] },
      { number: 102, module: 'organization/board', tier: 'low', route: 'important_fast', target_files: ['src/a.ts'], pattern: 'clean-up' },
      { number: 103, module: 'organization/board', tier: 'high', route: 'simple_deep', target_files: ['src/b.ts'], attach_to_parent: false },
    ],
    duplicates: [{ number: 104, canonical: 101, reason: 'covered by #101' }],
    merge_order: [[101, 102], 103],
    max_parallel_writers: 2,
    ...overrides,
  };
}

test('planTriageApply validates all three ADR-0006 §6 red lines and rejects invalid manifests before any mutation', () => {
  const plan = planTriageApply(baseManifest());
  expect(decodePlanBlock(plan.rendered_plan)).toEqual({
    protocol: 3,
    kind: 'repo-harness.plan',
    merge_order: [[101, 102], 103],
    holds: [],
    seat_limits: { worker: 2 },
  });
  expect(plan.operations.map(op => op.kind)).toEqual(['set_labels', 'add_sub_issue', 'set_labels', 'add_sub_issue', 'set_labels', 'close_duplicate', 'post_plan']);

  expect(() => decodeTriageManifest(baseManifest({
    issues: [
      { number: 101, module: 'organization/board', tier: 'high', route: 'simple_deep' },
      { number: 102, module: 'organization/board', tier: 'medium', route: 'simple_deep' },
    ],
    duplicates: [],
    merge_order: [[101, 102]],
  }))).toThrow(TriageApplyValidationError);

  expect(() => decodeTriageManifest(baseManifest({
    issues: [
      { number: 101, module: 'organization/board', tier: 'high', route: 'simple_deep' },
      { number: 102, module: 'organization/board', tier: 'high', route: 'simple_deep' },
      { number: 103, module: 'organization/board', tier: 'high', route: 'simple_deep' },
    ],
    duplicates: [],
    merge_order: [[101, 102, 103]],
  }))).toThrow('max 2');

  expect(() => decodeTriageManifest(baseManifest({
    issues: [
      { number: 101, module: 'organization/board', tier: 'medium', route: 'frontend' },
      { number: 102, module: 'organization/board', tier: 'medium', route: 'simple_fast' },
    ],
    duplicates: [],
    merge_order: [[101, 102]],
  }))).toThrow('frontend');

  expect(() => decodeTriageManifest(baseManifest({
    issues: [
      { number: 101, module: 'organization/board', tier: 'medium', route: 'simple_fast', target_files: ['src/shared.ts'] },
      { number: 102, module: 'organization/board', tier: 'medium', route: 'simple_fast', target_files: ['src/shared.ts'] },
    ],
    duplicates: [],
    merge_order: [101, 102],
  }))).toThrow('share target file src/shared.ts');
});

test('runTriageApply shares one operation list between --dry-run and apply, binds manifest.repository, and removes conflicting labels', () => {
  const calls: string[] = [];
  const ports = (existingPlan = false): TriageApplyPorts => ({
    comments: (repo) => {
      calls.push(`comments:${repo}`);
      return {
        truncated: false,
        comments: existingPlan
          ? [{ url: PLAN_URL, created_at: '2026-11-20T00:00:00Z', author_association: 'OWNER', body: 'repo-harness plan\n\n```json\n{"protocol":3,"kind":"repo-harness.plan","merge_order":[],"holds":[],"seat_limits":{"worker":1}}\n```' }]
          : [],
      };
    },
    read_issue_metadata: (_repo, nums) => {
      calls.push(`ids:${nums.join(',')}`);
      return new Map(nums.map(n => [n, {
        id: `ID_${n}`,
        labels: n === 101 ? ['enhancement', 'tier:low', 'route:simple_fast', 'pattern:old'] : [],
      }]));
    },
    set_labels: (_repo, issue, add, remove) => { calls.push(`labels:${issue}:+${add.join(',')}:-${remove.join(',')}`); },
    add_sub_issue: (parentId, childId) => { calls.push(`sub:${parentId}->${childId}`); },
    close_duplicate: (_repo, issue, comment) => { calls.push(`close:${issue}:${comment}`); },
    post_plan: (repo, parent, body) => { calls.push(`plan:${repo}#${parent}:${body.split('\n')[0]}`); return PLAN_URL; },
  });

  const dry = runTriageApply({ repo_root: process.cwd(), manifest: baseManifest(), dry_run: true, ports: ports(), env: {} });
  expect(dry.dry_run).toBe(true);
  expect(dry.plan_comment_url).toBeNull();
  expect(calls).toEqual([]);

  expect(() => runTriageApply({ repo_root: process.cwd(), manifest: baseManifest(), dry_run: false, ports: ports(true), env: {} })).toThrow('supersedes');
  expect(calls).toEqual(['comments:aimpact-inc/repo-harness']);
  calls.length = 0;

  const dryWithSupersedes = runTriageApply({ repo_root: process.cwd(), manifest: baseManifest({ supersedes: PLAN_URL }), dry_run: true, ports: ports(true), env: {} });
  const applied = runTriageApply({ repo_root: process.cwd(), manifest: baseManifest({ supersedes: PLAN_URL }), dry_run: false, ports: ports(true), env: {} });
  expect(applied.dry_run).toBe(false);
  expect(applied.plan_comment_url).toBe(PLAN_URL);
  expect(applied.operations).toEqual(dryWithSupersedes.operations);
  expect(calls).toEqual([
    'comments:aimpact-inc/repo-harness',
    'ids:101,102,103,3343',
    'labels:101:+module:organization/board,tier:medium:-pattern:old,tier:low',
    'sub:ID_3343->ID_101',
    'labels:102:+module:organization/board,tier:low,route:important_fast,pattern:clean-up:-',
    'sub:ID_3343->ID_102',
    'labels:103:+module:organization/board,tier:high,route:simple_deep:-',
    'close:104:Duplicate of #101. covered by #101',
    'plan:aimpact-inc/repo-harness#3343:repo-harness plan',
  ]);

  const ghCalls: string[][] = [];
  const ghPorts = gitHubTriageApplyPorts(process.cwd(), {
    repo_root: process.cwd(),
    gh_runner: (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'api' && args.at(-1)?.includes('/comments')) return { status: 0, stdout: '[[]]' };
      if (args[0] === 'api' && args[1] === 'graphql' && args.some(a => a.includes('labels('))) {
        return {
          status: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                i101: { id: 'ID_101', number: 101, labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: 'enhancement' }, { name: 'tier:low' }, { name: 'route:simple_fast' }, { name: 'pattern:old' }] } },
                i3343: { id: 'ID_3343', number: 3343, labels: { pageInfo: { hasNextPage: false }, nodes: [] } },
              },
            },
          }),
        };
      }
      if (args[0] === 'issue' && args[1] === 'comment') return { status: 0, stdout: PLAN_URL };
      return { status: 0, stdout: '{}' };
    },
  });
  const foreignResult = runTriageApply({
    repo_root: process.cwd(),
    manifest: baseManifest({
      repository: 'other-org/other-repo',
      issues: [{ number: 101, module: 'organization/board', tier: 'medium', route: 'important_fast', attach_to_parent: false }],
      duplicates: [],
      merge_order: [101],
    }),
    dry_run: false,
    ports: ghPorts,
    env: {},
  });
  expect(foreignResult.plan_comment_url).toBe(PLAN_URL);
  expect(ghCalls).toEqual([
    ['api', '--hostname', 'github.com', '--paginate', '--slurp', 'repos/other-org/other-repo/issues/3343/comments?per_page=100'],
    ['api', 'graphql', '--hostname', 'github.com', '-f', expect.stringContaining('labels(first: 100)'), '-f', 'owner=other-org', '-f', 'name=other-repo'],
    ['issue', 'edit', '101', '--repo', 'other-org/other-repo', '--add-label', 'module:organization/board', '--add-label', 'tier:medium', '--add-label', 'route:important_fast', '--remove-label', 'pattern:old', '--remove-label', 'route:simple_fast', '--remove-label', 'tier:low'],
    ['issue', 'comment', '3343', '--repo', 'other-org/other-repo', '--body-file', '-'],
  ]);
});

test('CLI rh board triage-apply --manifest --dry-run --json validates red lines and writes nothing', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[] = [];
  const ports: TriageApplyPorts = {
    comments: () => ({ truncated: false, comments: [] }),
    read_issue_metadata: () => new Map(),
    set_labels: () => { calls.push('set_labels'); },
    add_sub_issue: () => { calls.push('add_sub_issue'); },
    close_duplicate: () => { calls.push('close_duplicate'); },
    post_plan: () => { calls.push('post_plan'); return PLAN_URL; },
  };
  const runCli = async (args: readonly string[]) => {
    stdout.length = 0;
    stderr.length = 0;
    const program = new Command().name('rh');
    program.addCommand(buildBoardCommand(boardHostPorts(), attentionHostPorts(), undefined, () => ports));
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
  };

  const ok = await runCli(['board', 'triage-apply', '--manifest', manifestFile(baseManifest()), '--dry-run', '--json']);
  expect(ok.exitCode).toBe(0);
  expect(JSON.parse(ok.stdout)).toMatchObject({ dry_run: true, plan_comment_url: null });
  expect(calls).toEqual([]);

  const bad = await runCli(['board', 'triage-apply', '--manifest', manifestFile(baseManifest({ merge_order: [[101, 103]], duplicates: [] })), '--dry-run', '--json']);
  expect(bad.exitCode).toBe(2);
  expect(JSON.parse(bad.stderr)).toMatchObject({ ok: false, error: 'triage_apply_validation_failed' });
  expect(calls).toEqual([]);
});

test('triage-apply validates refactor_ids format, blocks cross-unit refactor_ids overlap, and posts bind_refactor comments', () => {
  const recA = 'recommendation.4aa8477d81e9d473';
  const recB = 'recommendation.abcdef0123456789';

  expect(() => decodeTriageManifest(baseManifest({
    issues: [{ number: 101, module: 'organization/board', tier: 'medium', route: 'simple_fast', refactor_ids: ['bad-id'] }],
    duplicates: [],
    merge_order: [101],
  }))).toThrow('recommendation.<16-hex>');

  expect(() => decodeTriageManifest(baseManifest({
    issues: [
      { number: 101, module: 'organization/board', tier: 'medium', route: 'simple_fast', refactor_ids: [recA] },
      { number: 102, module: 'organization/board', tier: 'medium', route: 'simple_fast', refactor_ids: [recA] },
    ],
    duplicates: [],
    merge_order: [101, 102],
  }))).toThrow(`share refactor decision ${recA}`);

  const boundCalls: string[] = [];
  const result = runTriageApply({
    repo_root: process.cwd(),
    manifest: baseManifest({
      issues: [
        { number: 101, module: 'organization/board', tier: 'medium', route: 'simple_fast', refactor_ids: [recB, recA] },
      ],
      duplicates: [],
      merge_order: [101],
    }),
    dry_run: false,
    env: { REPO_HARNESS_SEAT: 'advisor', HC_TERMINAL_ID: 't1ad' },
    ports: {
      comments: () => ({ truncated: false, comments: [] }),
      read_issue_metadata: (_repo, nums) => new Map(nums.map((n) => [n, { id: `ID_${n}`, labels: [] }])),
      set_labels: () => {},
      add_sub_issue: () => {},
      bind_refactor: (repo, issue, body) => { boundCalls.push(`${repo}#${issue}:${body}`); },
      close_duplicate: () => {},
      post_plan: () => PLAN_URL,
    },
  });
  expect(result.operations.find((op) => op.kind === 'bind_refactor')).toMatchObject({
    kind: 'bind_refactor',
    issue: 101,
    refactor_ids: [recA, recB],
  });
  expect(boundCalls).toHaveLength(1);
  expect(boundCalls[0]).toContain(`aimpact-inc/repo-harness#101:repo-harness refactor binding\nRefactor IDs: ${recA}, ${recB}`);
  expect(boundCalls[0]).toContain('Seat: advisor t1ad');
});
