import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { buildBoardCommand } from '../src/cli/commands/board';
import { decodePlanBlock } from '../src/core/board/plan-block';
import { decodeTriageManifest, planTriageApply, TRIAGE_MANIFEST_SCHEMA_VERSION, TriageApplyValidationError } from '../src/core/board/triage-apply';
import { runTriageApply, type TriageApplyPorts } from '../src/effects/board/triage-apply';
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
  expect(plan.operations.map(op => op.kind)).toEqual(['add_labels', 'add_sub_issue', 'add_labels', 'add_sub_issue', 'add_labels', 'close_duplicate', 'post_plan']);

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

test('runTriageApply shares one operation list between --dry-run and apply and stops before writing when supersedes check fails', () => {
  const calls: string[] = [];
  const ports = (existingPlan = false): TriageApplyPorts => ({
    comments: () => ({
      truncated: false,
      comments: existingPlan
        ? [{ url: PLAN_URL, created_at: '2026-11-20T00:00:00Z', author_association: 'OWNER', body: 'repo-harness plan\n\n```json\n{"protocol":3,"kind":"repo-harness.plan","merge_order":[],"holds":[],"seat_limits":{"worker":1}}\n```' }]
        : [],
    }),
    read_issue_node_ids: (_repo, nums) => {
      calls.push(`ids:${nums.join(',')}`);
      return new Map(nums.map(n => [n, `ID_${n}`]));
    },
    add_labels: (_repo, issue, labels) => { calls.push(`labels:${issue}:${labels.join(',')}`); },
    add_sub_issue: (parentId, childId) => { calls.push(`sub:${parentId}->${childId}`); },
    close_duplicate: (_repo, issue, comment) => { calls.push(`close:${issue}:${comment}`); },
    post_plan: (parent, body) => { calls.push(`plan:${parent}:${body.split('\n')[0]}`); return PLAN_URL; },
  });

  const dry = runTriageApply({ repo_root: process.cwd(), manifest: baseManifest(), dry_run: true, ports: ports(), env: {} });
  expect(dry.dry_run).toBe(true);
  expect(dry.plan_comment_url).toBeNull();
  expect(calls).toEqual([]);

  expect(() => runTriageApply({ repo_root: process.cwd(), manifest: baseManifest(), dry_run: false, ports: ports(true), env: {} })).toThrow('supersedes');
  expect(calls).toEqual([]);

  const dryWithSupersedes = runTriageApply({ repo_root: process.cwd(), manifest: baseManifest({ supersedes: PLAN_URL }), dry_run: true, ports: ports(true), env: {} });
  const applied = runTriageApply({ repo_root: process.cwd(), manifest: baseManifest({ supersedes: PLAN_URL }), dry_run: false, ports: ports(true), env: {} });
  expect(applied.dry_run).toBe(false);
  expect(applied.plan_comment_url).toBe(PLAN_URL);
  expect(applied.operations).toEqual(dryWithSupersedes.operations);
  expect(calls).toEqual([
    'ids:3343,101,102',
    'labels:101:module:organization/board,tier:medium,route:simple_fast',
    'sub:ID_3343->ID_101',
    'labels:102:module:organization/board,tier:low,route:important_fast,pattern:clean-up',
    'sub:ID_3343->ID_102',
    'labels:103:module:organization/board,tier:high,route:simple_deep',
    'close:104:Duplicate of #101. covered by #101',
    'plan:3343:repo-harness plan',
  ]);
});

test('CLI rh board triage-apply --manifest --dry-run --json validates red lines and writes nothing', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: string[] = [];
  const ports: TriageApplyPorts = {
    comments: () => ({ truncated: false, comments: [] }),
    read_issue_node_ids: () => new Map(),
    add_labels: () => { calls.push('add_labels'); },
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
