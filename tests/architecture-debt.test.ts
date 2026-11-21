import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestJson, errorEnvelope, okEnvelope, type ArchitectureDebtReportV1, type Json } from 'archctx-contracts';
import { ARCHCTX_REQUIRED_VERSION, ArchctxClientError, decodeArchitectureDebtReport } from '../src/core/architecture/projection';
import type { ArchctxProcessResult, ArchitectureProjectionPolicy, RunArchctxProcess } from '../src/core/architecture/contracts';
import { checkpointArchitectureDebt } from '../src/effects/architecture/archctx-provider';
import { architectureDebtReport, architectureDebtSummary } from '../src/cli/commands/architecture-debt-report';

/**
 * Recorded from archctx@0.8.0 `complete --head-sha <sha> --json` in a disposable
 * repository with one capability, one unproven flow and one unowned source path.
 */
const recorded = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'architecture-debt', 'complete-envelope.archctx-0.8.0.json'), 'utf8')) as {
  data: { snapshot: { headSha: string }; debt: ArchitectureDebtReportV1 } & Record<string, unknown>;
} & Record<string, unknown>;
// archctx 0.13.0 reports a sixth check, `state-machines`, after `flows`; the 0.8.0 record has none.
const flowsAt = recorded.data.debt.checks.findIndex((entry) => entry.check === 'flows');
const recordedDebt = redigest({ ...recorded.data.debt, checks: [...recorded.data.debt.checks.slice(0, flowsAt + 1), { check: 'state-machines', coverage: 'complete', reasonCodes: [] }, ...recorded.data.debt.checks.slice(flowsAt + 1)] });
recorded.data.debt = recordedDebt;
const policy: ArchitectureProjectionPolicy = { provider: 'archctx', applyMode: 'manual', requiredVersion: ARCHCTX_REQUIRED_VERSION, timeoutMs: 120_000 };
const roots: string[] = [];

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const clone = <T>(value: T): T => structuredClone(value);
/** Re-binds a derived report so that only the property under test is invalid. */
function redigest(report: Omit<ArchitectureDebtReportV1, 'digest'> & { digest?: string }): ArchitectureDebtReportV1 {
  const { digest: _digest, ...body } = report;
  return { ...body, digest: digestJson(body as unknown as Json) };
}
const ok = (value: unknown): ArchctxProcessResult => ({ status: 0, signal: null, stdout: JSON.stringify(value), stderr: '' });
const failed = (value: unknown): ArchctxProcessResult => ({ status: 1, signal: null, stdout: JSON.stringify(value), stderr: '' });
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

/** A fake package-local archctx with its declared CodeGraph, and a real two-commit Git repository. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-architecture-debt-')));
  roots.push(root);
  const consumerRoot = join(root, 'consumer');
  const archctxRoot = join(consumerRoot, 'node_modules', 'archctx');
  const codegraphRoot = join(consumerRoot, 'node_modules', '@colbymchenry', 'codegraph');
  mkdirSync(join(archctxRoot, 'bin'), { recursive: true });
  mkdirSync(codegraphRoot, { recursive: true });
  writeFileSync(join(archctxRoot, 'package.json'), JSON.stringify({ name: 'archctx', version: ARCHCTX_REQUIRED_VERSION, engines: { node: '>=22.22 <26' }, bin: { archctx: './bin/archctx' }, dependencies: { '@colbymchenry/codegraph': '1.6.2' } }));
  writeFileSync(join(archctxRoot, 'bin', 'archctx'), '#!/bin/sh\nexit 99\n');
  chmodSync(join(archctxRoot, 'bin', 'archctx'), 0o755);
  writeFileSync(join(codegraphRoot, 'package.json'), JSON.stringify({ name: '@colbymchenry/codegraph', version: '1.6.2', bin: { codegraph: 'npm-shim.js' } }));
  writeFileSync(join(codegraphRoot, 'npm-shim.js'), 'process.exit(99);\n');
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  git(repoRoot, ['init', '-q']);
  writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
  const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);
  writeFileSync(join(repoRoot, 'src', 'b.ts'), 'export const b = 2;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'head']);
  const headSha = git(repoRoot, ['rev-parse', 'HEAD']);
  return { consumerRoot, repoRoot, baseSha, headSha };
}

describe('architecture debt report decoder', () => {
  test('accepts the recorded archctx@0.8.0 report with the 0.13.0 state-machines check row', () => {
    expect(decodeArchitectureDebtReport(clone(recordedDebt))).toEqual(recordedDebt);
    expect(recordedDebt.items.map((item) => item.kind)).toEqual(['flow-proof-failed', 'unowned-path']);
  });

  test('rejects a tampered digest, unsorted items, an unknown kind and extra keys', () => {
    expect(() => decodeArchitectureDebtReport({ ...clone(recordedDebt), digest: `sha256:${'0'.repeat(64)}` })).toThrow('digest must bind the debt report');
    expect(() => decodeArchitectureDebtReport(redigest({ ...clone(recordedDebt), items: [...clone(recordedDebt.items)].reverse() }))).toThrow('items must be sorted and unique');
    const unknownKind = clone(recordedDebt);
    (unknownKind.items[0] as { kind: string }).kind = 'made-up-debt';
    expect(() => decodeArchitectureDebtReport(redigest(unknownKind))).toThrow('architecture debt report invalid');
    expect(() => decodeArchitectureDebtReport(redigest({ ...clone(recordedDebt), extra: true } as never))).toThrow('additional property denied');
    const itemExtra = clone(recordedDebt);
    (itemExtra.items[0] as unknown as Record<string, unknown>).extra = true;
    expect(() => decodeArchitectureDebtReport(redigest(itemExtra))).toThrow('additional property denied');
  });
});

describe('architecture-debt command', () => {
  function delta(f: ReturnType<typeof fixture>) {
    return {
      schemaVersion: 'archcontext.architecture-debt-delta/v1',
      head: { sha: f.headSha, debt: recordedDebt },
      base: { ref: f.baseSha, sha: f.baseSha, debtDigest: recordedDebt.digest, coverage: recordedDebt.coverage, coverageReasonCodes: recordedDebt.coverageReasonCodes },
      introduced: [recordedDebt.items[0]!], resolvedIds: [`debt.${'c'.repeat(64)}`],
    };
  }
  const envelope = (data: unknown) => ok(okEnvelope('debt', data as Json));

  test('without a base it reports only the complete-mode HEAD debt', () => {
    const f = fixture();
    const run: RunArchctxProcess = (_binary, args) => {
      expect(args).toEqual(['debt', '--complete', '--json']);
      return envelope(recordedDebt);
    };
    const output = architectureDebtReport(f.repoRoot, undefined, { consumerRoot: f.consumerRoot, policy, run });
    expect(output).toEqual({ kind: 'repo-harness-architecture-debt', head: { sha: f.headSha, debt: recordedDebt }, base: null, introduced: null, resolvedIds: null });
    expect(architectureDebtSummary(output)).toContain('2 items, coverage partial');
  });

  test('projects the pinned native delta from a single complete-mode call', () => {
    const f = fixture();
    const { schemaVersion: _schemaVersion, ...data } = delta(f);
    const calls: string[][] = [];
    const run: RunArchctxProcess = (_binary, args, options) => {
      expect(options.cwd).toBe(f.repoRoot);
      calls.push([...args]);
      return envelope(delta(f));
    };
    const output = architectureDebtReport(f.repoRoot, 'HEAD~1', { consumerRoot: f.consumerRoot, policy, run });
    expect(output).toEqual({ kind: 'repo-harness-architecture-debt', ...data, base: { ...data.base, ref: 'HEAD~1' } });
    expect(calls).toEqual([['debt', '--base', f.baseSha, '--complete', '--json']]);
    expect(architectureDebtSummary(output)).toContain('introduced 1, resolved 1');
  });

  test('resolves a Git reflog date and preserves the original base expression', () => {
    const f = fixture();
    const ref = 'HEAD@{1 hour ago}';
    const output = architectureDebtReport(f.repoRoot, ref, {
      consumerRoot: f.consumerRoot, policy,
      run: (_binary, args) => {
        expect(args).toEqual(['debt', '--base', f.baseSha, '--complete', '--json']);
        return envelope(delta(f));
      },
    });
    expect(output.base).toMatchObject({ ref, sha: f.baseSha });
  });

  test('refuses malformed envelopes, invalid deltas and a delta bound to another commit', () => {
    const f = fixture();
    const measure = (answer: ArchctxProcessResult) => architectureDebtReport(f.repoRoot, 'HEAD~1', { consumerRoot: f.consumerRoot, policy, run: () => answer });
    expect(() => measure(ok({ ok: true, data: delta(f) }))).toThrow('invalid envelope');
    expect(() => measure(envelope({ ...delta(f), resolvedIds: [false] }))).toThrow('architecture debt delta invalid');
    expect(() => measure(envelope({ ...delta(f), head: { sha: f.baseSha, debt: recordedDebt } }))).toThrow('snapshot mismatch');
    expect(() => measure(envelope({ ...delta(f), base: { ...delta(f).base, sha: f.headSha } }))).toThrow('snapshot mismatch');
    expect(() => measure(failed(errorEnvelope('debt', 'AC_SCHEMA_INVALID', 'bad debt input')))).toThrow(ArchctxClientError);
  });

  test('reports a base index gap when sync cannot make the comparison measurable', () => {
    const f = fixture();
    const data = delta(f);
    data.base.coverageReasonCodes = ['dependencies:index-missing'];
    const calls: string[] = [];
    const run: RunArchctxProcess = (_binary, args) => {
      calls.push(args[0]!);
      return args[0] === 'sync' ? ok(okEnvelope('sync', { codeGraphBase: 'not-primary' })) : envelope(data);
    };
    expect(() => architectureDebtReport(f.repoRoot, 'HEAD~1', { consumerRoot: f.consumerRoot, policy, run })).toThrow('base has no CodeGraph index after sync');
    expect(calls).toEqual(['debt', 'sync', 'debt']);
  });

  test('an unresolvable base, disabled provider or package mismatch runs no archctx process', () => {
    const f = fixture();
    let calls = 0;
    const options = { consumerRoot: f.consumerRoot, policy, run: () => { calls++; return envelope(delta(f)); } };
    expect(() => architectureDebtReport(f.repoRoot, 'missing', options)).toThrow('missing does not resolve to a commit');
    expect(() => architectureDebtReport(f.repoRoot, 'HEAD~1', { ...options, policy: { ...policy, provider: 'disabled' } })).toThrow('provider is disabled');
    const manifest = join(f.consumerRoot, 'node_modules/archctx/package.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: '0.16.0' }));
    expect(() => architectureDebtReport(f.repoRoot, 'HEAD~1', options)).toThrow('expected archctx@0.17.0, got archctx@0.16.0');
    expect(calls).toBe(0);
  });
});

describe('checkpointArchitectureDebt', () => {
  function ownership(f: ReturnType<typeof fixture>) {
    return { review_base: f.baseSha, capability_ids: ['test-module'], capabilities: [{ id: 'test-module', module_document: 'docs/module.md', paths: ['src/a.ts', 'src/b.ts'] }], unowned_paths: [] };
  }
  function envelope(paths: string[]) {
    return { schemaVersion: 'archcontext.envelope/v1', ok: true, requestId: 'checkpoint', data: redigest({
      ...clone(recordedDebt), scope: { kind: 'changed-paths', changedPaths: paths, capabilityIds: [] }, items: [], actionsRequired: [],
    }) };
  }

  test('uses the merge-base and changed owned paths, including dirty paths; never calls doctor or complete', () => {
    const f = fixture();
    git(f.repoRoot, ['branch', 'feature']);
    git(f.repoRoot, ['checkout', '-qb', 'review', f.baseSha]);
    writeFileSync(join(f.repoRoot, 'src/a.ts'), 'export const a = 99;\n');
    git(f.repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=t@t', 'commit', '-qam', 'review-only change']);
    git(f.repoRoot, ['checkout', '-q', 'feature']);
    writeFileSync(join(f.repoRoot, 'src/space name.ts'), 'export const added = 1;\n');
    const owned = { ...ownership(f), review_base: 'review', capabilities: [{ ...ownership(f).capabilities[0]!, paths: ['src/a.ts', 'src/b.ts', 'src/space name.ts'] }] };
    const calls: Array<readonly string[]> = [];
    const run: RunArchctxProcess = (_binary, args, opts) => {
      calls.push(args);
      expect(opts.timeoutMs).toBeGreaterThan(0);
      expect(opts.timeoutMs).toBeLessThanOrEqual(3_000);
      return ok(envelope(['src/b.ts', 'src/space name.ts']));
    };
    expect(checkpointArchitectureDebt(f.repoRoot, owned, { consumerRoot: f.consumerRoot, policy, run })?.report.scope.changedPaths).toEqual(['src/b.ts', 'src/space name.ts']);
    expect(calls).toEqual([['checkpoint', '--changed-path', 'src/b.ts', '--changed-path', 'src/space name.ts', '--json']]);
  });

  test('invalid bases, malformed reports, different subjects and expired deadlines fail closed', () => {
    const f = fixture();
    const owned = ownership(f);
    let calls = 0;
    const run: RunArchctxProcess = () => { calls++; return ok(envelope(['src/b.ts'])); };
    const options = { consumerRoot: f.consumerRoot, policy, run };
    expect(() => checkpointArchitectureDebt(f.repoRoot, { ...owned, review_base: 'absent' }, options)).toThrow();
    expect(calls).toBe(0);
    expect(() => checkpointArchitectureDebt(f.repoRoot, owned, { ...options, run: () => ok(envelope(['src/a.ts'])) })).toThrow('different path subject');
    expect(() => checkpointArchitectureDebt(f.repoRoot, owned, { ...options, run: () => ok({ ...envelope(['src/b.ts']), data: {} }) })).toThrow();
    let now = 0;
    expect(() => checkpointArchitectureDebt(f.repoRoot, owned, { ...options, nowMs: () => now, run: () => { now = 3_001; return ok(envelope(['src/b.ts'])); } })).toThrow('timeout');
    expect(() => checkpointArchitectureDebt(f.repoRoot, owned, { ...options, deadlineMs: 0 })).toThrow('timeout');
  });
});
