import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHCONTEXT_NODE_RANGE, ARCHITECTURE_DEBT_DELTA_SCHEMA_VERSION, digestJson, errorEnvelope, type ArchitectureDebtDeltaReportV1, type ArchitectureDebtReportV1, type Json } from 'archctx-contracts';
import { ARCHCTX_REQUIRED_VERSION, ArchctxClientError, decodeArchitectureDebtReport } from '../src/core/architecture/projection';
import type { ArchctxProcessResult, ArchitectureProjectionPolicy, RunArchctxProcess } from '../src/core/architecture/contracts';
import { completeArchitectureDebt, checkpointArchitectureDebt } from '../src/effects/architecture/archctx-provider';
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
const completeEnvelope = (headSha: string, debt: unknown) => ({ ...clone(recorded), data: { ...clone(recorded.data), snapshot: { ...recorded.data.snapshot, headSha }, debt } });
// The code facts shape comes from package-local archctx@0.8.0 doctor in a disposable repository.
const doctorEnvelope = (state = 'ready', issues: Array<{ code: string; message: string }> = []) => ({
  schemaVersion: 'archcontext.envelope/v1', ok: true, requestId: 'doctor',
  data: { codeFacts: { schemaVersion: 'archcontext.repository-code-facts/v1', state, indexPresent: state !== 'index-missing', requiredVersion: '1.6.4', codeGraphVersion: '1.6.4', issues } },
});

function git(cwd: string, args: string[], date?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  } }).trim();
}

/** A fake package-local archctx and a real two-commit Git repository. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-architecture-debt-')));
  roots.push(root);
  const consumerRoot = join(root, 'consumer');
  const archctxRoot = join(consumerRoot, 'node_modules', 'archctx');
  mkdirSync(join(archctxRoot, 'bin'), { recursive: true });
  writeFileSync(join(archctxRoot, 'package.json'), JSON.stringify({ name: 'archctx', version: ARCHCTX_REQUIRED_VERSION, engines: { node: ARCHCONTEXT_NODE_RANGE }, bin: { archctx: './bin/archctx' } }));
  writeFileSync(join(archctxRoot, 'bin', 'archctx'), '#!/bin/sh\nexit 99\n');
  chmodSync(join(archctxRoot, 'bin', 'archctx'), 0o755);
  const repoRoot = join(root, 'repo');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  git(repoRoot, ['init', '-q']);
  const commit = (message: string, date: string) => {
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message], date);
    return git(repoRoot, ['rev-parse', 'HEAD']);
  };
  writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  const baseSha = commit('base', '2020-01-01T00:00:00Z');
  writeFileSync(join(repoRoot, 'src', 'b.ts'), 'export const b = 2;\n');
  const headSha = commit('head', '2020-01-03T00:00:00Z');
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

describe('completeArchitectureDebt', () => {
  test('doctor not-ready stops HEAD-only debt with a typed fix before complete', () => {
    const f = fixture();
    const calls: Array<readonly string[]> = [];
    const issues = [{ code: 'version-mismatch', message: 'CodeGraph repository status version mismatch' }, { code: 'pending-source-changes', message: 'CodeGraph repository index has pending source changes' }];
    const run: RunArchctxProcess = (_binary, args) => { calls.push(args); return ok(doctorEnvelope('not-ready', issues)); };
    let caught: unknown;
    try { architectureDebtReport(f.repoRoot, undefined, { consumerRoot: f.consumerRoot, policy, run }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ArchctxClientError);
    expect(caught).toMatchObject({ code: 'RH_ARCHCTX_CODE_FACTS_NOT_READY', reasonCode: 'code-facts-not-ready', details: { state: 'not-ready', issues } });
    expect((caught as Error).message).toContain('version-mismatch, pending-source-changes');
    expect((caught as Error).message).toContain('codegraph index .');
    expect((caught as Error).message).toContain(f.repoRoot);
    expect(calls).toEqual([['doctor', '--json']]);
  });

  test('doctor unknown or malformed code facts fail closed before complete', () => {
    const f = fixture();
    const valid = doctorEnvelope();
    const variants = [
      { ...valid, requestId: 'other' },
      { ...valid, data: {} },
      doctorEnvelope('unknown'),
      { ...valid, data: { codeFacts: { ...valid.data.codeFacts, schemaVersion: 'archcontext.repository-code-facts/v2' } } },
      { ...valid, data: { codeFacts: { ...valid.data.codeFacts, issues: [{ code: 1 }] } } },
      { ...valid, data: { codeFacts: { ...valid.data.codeFacts, issues: undefined } } },
    ];
    for (const envelope of variants) {
      const calls: Array<readonly string[]> = [];
      const run: RunArchctxProcess = (_binary, args) => { calls.push(args); return ok(envelope); };
      expect(() => completeArchitectureDebt(f.repoRoot, f.headSha, { consumerRoot: f.consumerRoot, policy, run })).toThrow('RH_ARCHCTX_DOCTOR_INVALID');
      expect(calls).toEqual([['doctor', '--json']]);
    }
  });

  test('a ready doctor keeps the recorded complete report unchanged', () => {
    const f = fixture();
    const calls: Array<readonly string[]> = [];
    const run: RunArchctxProcess = (_binary, args) => { calls.push(args); return ok(args[0] === 'doctor' ? doctorEnvelope() : recorded); };
    expect(completeArchitectureDebt(f.repoRoot, recorded.data.snapshot.headSha, { consumerRoot: f.consumerRoot, policy, run })).toEqual(recordedDebt);
    expect(calls).toEqual([['doctor', '--json'], ['complete', '--head-sha', recorded.data.snapshot.headSha, '--json']]);
  });

  test('an error envelope stays a typed ArchctxClientError', () => {
    const f = fixture();
    const run: RunArchctxProcess = (_binary, args) => args[0] === 'doctor' ? ok(doctorEnvelope()) : failed(errorEnvelope('complete', 'AC_UNCLASSIFIED_FAILURE', 'code facts unavailable', 'code-facts-unavailable'));
    let caught: unknown;
    try { completeArchitectureDebt(f.repoRoot, f.headSha, { consumerRoot: f.consumerRoot, policy, run }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ArchctxClientError);
    expect({ code: (caught as ArchctxClientError).code, action: (caught as ArchctxClientError).action, reasonCode: (caught as ArchctxClientError).reasonCode })
      .toEqual({ code: 'AC_UNCLASSIFIED_FAILURE', action: 'inspect-diagnostics', reasonCode: 'code-facts-unavailable' });
  });

  test('malformed, missing or unbound debt fails closed', () => {
    const f = fixture();
    const attempt = (envelope: unknown, sha = f.headSha): ArchctxClientError => {
      const run: RunArchctxProcess = (_binary, args) => ok(args[0] === 'doctor' ? doctorEnvelope() : envelope);
      try { completeArchitectureDebt(f.repoRoot, sha, { consumerRoot: f.consumerRoot, policy, run }); } catch (error) { return error as ArchctxClientError; }
      throw new Error('expected a failure');
    };
    const malformed = attempt(completeEnvelope(f.headSha, { ...clone(recordedDebt), coverage: 'complete' }));
    expect([malformed.code, malformed.reasonCode]).toEqual(['RH_ARCHCTX_DEBT_INVALID', 'architecture-debt-invalid']);
    const { debt: _debt, ...withoutDebt } = completeEnvelope(f.headSha, undefined).data;
    const missing = attempt({ ...clone(recorded), data: { ...withoutDebt, result: 'fail_action_required', actionsRequired: ['archctx validate'] } });
    expect([missing.code, missing.reasonCode, missing.details]).toEqual(['RH_ARCHCTX_DEBT_MISSING', 'architecture-debt-missing', { headSha: f.headSha, result: 'fail_action_required', actionsRequired: ['archctx validate'] }]);
    const otherCommit = attempt(completeEnvelope(f.baseSha, clone(recordedDebt)));
    expect([otherCommit.code, otherCommit.reasonCode]).toEqual(['RH_ARCHCTX_DEBT_INVALID', 'review-result-mismatch']);
  });

  test('a wrong pinned version or a disabled provider fails before any process call', () => {
    const f = fixture();
    const calls: Array<readonly string[]> = [];
    const run: RunArchctxProcess = (_binary, args) => { calls.push(args); return ok(recorded); };
    const manifest = join(f.consumerRoot, 'node_modules', 'archctx', 'package.json');
    const pinned = readFileSync(manifest, 'utf8');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(pinned), version: '0.0.1' }));
    expect(() => completeArchitectureDebt(f.repoRoot, f.headSha, { consumerRoot: f.consumerRoot, policy, run })).toThrow(`expected archctx@${ARCHCTX_REQUIRED_VERSION}, got archctx@0.0.1`);
    writeFileSync(manifest, pinned);
    expect(() => completeArchitectureDebt(f.repoRoot, f.headSha, { consumerRoot: f.consumerRoot, policy: { ...policy, provider: 'disabled', applyMode: 'disabled' }, run }))
      .toThrow('architecture projection provider is disabled');
    expect(calls).toEqual([]);
  });

  test('doctor index-missing and unavailable use the same typed error without complete', () => {
    const f = fixture();
    const unavailable = { ...doctorEnvelope(), data: { codeFacts: { schemaVersion: 'archcontext.repository-code-facts/v1', state: 'unavailable', requiredVersion: '1.6.4', reasonCode: 'codegraph-unavailable', message: 'CodeGraph binary is unavailable' } } };
    for (const envelope of [doctorEnvelope('index-missing'), unavailable]) {
      const calls: Array<readonly string[]> = [];
      const run: RunArchctxProcess = (_binary, args) => { calls.push(args); return ok(envelope); };
      let caught: unknown;
      try { completeArchitectureDebt(f.repoRoot, f.headSha, { consumerRoot: f.consumerRoot, policy, run }); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'RH_ARCHCTX_CODE_FACTS_NOT_READY', details: { state: envelope.data.codeFacts.state } });
      expect((caught as Error).message).toContain(envelope.data.codeFacts.state === 'index-missing' ? 'codegraph init -y .' : 'rh update');
      expect((caught as Error).message).toContain(envelope.data.codeFacts.state === 'unavailable' ? 'codegraph-unavailable' : 'index-missing');
      if (envelope.data.codeFacts.state === 'unavailable') {
        expect((caught as ArchctxClientError).action).toBe('update-repo-harness');
        expect((caught as Error).message).toContain('CodeGraph binary is unavailable');
      }
      expect(calls).toEqual([['doctor', '--json']]);
    }
  });
});

describe('architecture-debt command', () => {
  function delta(f: ReturnType<typeof fixture>): ArchitectureDebtDeltaReportV1 {
    const unowned = recordedDebt.items.find(item => item.kind === 'unowned-path')!;
    const resolved: ArchitectureDebtReportV1['items'][number] = { ...unowned, id: `debt.${'c'.repeat(64)}`, paths: ['src/gone.ts'] };
    const baseDebt = redigest({
      ...recordedDebt,
      checks: recordedDebt.checks.map(check => check.check === 'flows' ? { ...check, coverage: 'unknown', reasonCodes: ['index-missing'] } : check),
      coverageReasonCodes: ['flows:index-missing', ...recordedDebt.coverageReasonCodes],
      items: [resolved],
      actionsRequired: [resolved.action],
    });
    return {
      schemaVersion: ARCHITECTURE_DEBT_DELTA_SCHEMA_VERSION,
      head: { sha: f.headSha, debt: recordedDebt },
      base: { ref: f.baseSha, sha: f.baseSha, debtDigest: baseDebt.digest, coverage: baseDebt.coverage, coverageReasonCodes: baseDebt.coverageReasonCodes },
      introduced: [unowned],
      resolvedIds: [resolved.id],
    };
  }

  test('without a base it reports only the HEAD debt', () => {
    const f = fixture();
    const calls: Array<readonly string[]> = [];
    const run: RunArchctxProcess = (_binary, args) => {
      calls.push(args);
      return ok(args[0] === 'doctor' ? doctorEnvelope() : completeEnvelope(f.headSha, recordedDebt));
    };
    const output = architectureDebtReport(f.repoRoot, undefined, { consumerRoot: f.consumerRoot, policy, run });
    expect(output).toEqual({ kind: 'repo-harness-architecture-debt', head: { sha: f.headSha, debt: recordedDebt }, base: null, introduced: null, resolvedIds: null });
    expect(calls).toEqual([['doctor', '--json'], ['complete', '--head-sha', f.headSha, '--json']]);
    expect(architectureDebtSummary(output)).toContain('2 items, coverage partial');
  });

  test('passes the exact SHA for a dated Git selector and reports the native delta', () => {
    const f = fixture();
    const ref = 'HEAD@{2020-01-02 00:00:00 +0000}';
    const { head, base, introduced, resolvedIds } = delta(f);
    const calls: Array<readonly string[]> = [];
    const run: RunArchctxProcess = (_binary, args, opts) => {
      calls.push(args);
      expect(opts.cwd).toBe(f.repoRoot);
      return ok({ schemaVersion: 'archcontext.envelope/v1', ok: true, requestId: 'debt', data: delta(f) });
    };
    const before = git(f.repoRoot, ['worktree', 'list', '--porcelain']);
    const output = architectureDebtReport(f.repoRoot, ref, { consumerRoot: f.consumerRoot, policy, run });
    expect(output).toEqual({ kind: 'repo-harness-architecture-debt', head, base: { ...base, ref }, introduced, resolvedIds });
    expect(calls).toEqual([['debt', '--base', f.baseSha, '--complete', '--json']]);
    expect(git(f.repoRoot, ['worktree', 'list', '--porcelain'])).toBe(before);
    expect(architectureDebtSummary(output)).toContain('introduced 1, resolved 1');
  });

  test('rejects malformed or unbound native deltas', () => {
    const f = fixture();
    const data = delta(f);
    const measure = (response: unknown) => architectureDebtReport(f.repoRoot, f.baseSha, { consumerRoot: f.consumerRoot, policy,
      run: () => ok({ schemaVersion: 'archcontext.envelope/v1', ok: true, requestId: 'debt', data: response }) });
    expect(() => measure({ ...data, introduced: [{}] })).toThrow('architecture debt delta invalid');
    expect(() => measure({ ...data, head: { ...data.head, debt: { ...data.head.debt, digest: 'sha256:' + '0'.repeat(64) } } })).toThrow('digest must bind the debt report');
    expect(() => measure({ ...data, head: { ...data.head, sha: f.baseSha } })).toThrow('architecture debt delta snapshot mismatch');
    expect(() => measure({ ...data, base: { ...data.base, sha: f.headSha } })).toThrow('architecture debt delta snapshot mismatch');
    expect(() => measure({ ...data, base: { ...data.base, ref: 'HEAD~1' } })).toThrow('architecture debt delta snapshot mismatch');
  });

  test('surfaces a native debt failure after one call', () => {
    const f = fixture();
    const calls: Array<readonly string[]> = [];
    const run: RunArchctxProcess = (_binary, args) => {
      calls.push(args);
      return failed(errorEnvelope('debt', 'AC_PRECONDITION_FAILED', 'sparse checkout', 'debt-head-sparse-checkout'));
    };
    expect(() => architectureDebtReport(f.repoRoot, f.baseSha, { consumerRoot: f.consumerRoot, policy, run })).toThrow('AC_PRECONDITION_FAILED');
    expect(calls).toEqual([['debt', '--base', f.baseSha, '--complete', '--json']]);
  });

  test('an unresolvable base fails before archctx runs', () => {
    const f = fixture();
    const calls: Array<readonly string[]> = [];
    const run: RunArchctxProcess = (_binary, args) => { calls.push(args); return ok({}); };
    expect(() => architectureDebtReport(f.repoRoot, 'no-such-ref', { consumerRoot: f.consumerRoot, policy, run })).toThrow('RH_ARCHITECTURE_DEBT_REF_UNRESOLVED');
    expect(calls).toEqual([]);
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
