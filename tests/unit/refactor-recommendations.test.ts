import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RefactorDecisionV1, RefactorScanFindingV2, RefactorScanV2, RefactorVerifyV2 } from 'archctx-contracts';
import {
  buildRefactorCommand,
  formatRefactorList,
  formatRefactorRecommendations,
  formatRefactorShow,
  formatRefactorVerify,
} from '../../src/cli/commands/refactor';
import { RefactorProviderError } from '../../src/core/refactor/provider-contract';
import { observeRefactorRecommendations } from '../../src/effects/refactor/recommendations';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'refactor-recommendation-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(home, '.repo-harness'), { recursive: true });
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.archcontext'), { recursive: true });
  writeFileSync(join(repo, '.archcontext/manifest.yaml'), 'fixture: true\n');
  return { root, repo, env: { ...process.env, HOME: home } };
}

const shippedDecision = (): RefactorDecisionV1 =>
  JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve('archctx-contracts'))), '../fixtures/valid/refactor-decision.json'), 'utf8')) as RefactorDecisionV1;

const HEAD_SHA = 'a'.repeat(40);
const SNAPSHOT_DIGEST = `sha256:${'1'.repeat(64)}`;
const RESOLUTION_DIGEST = `sha256:${'2'.repeat(64)}`;
const REC_ID = shippedDecision().recommendationId;

function scanFinding(overrides: Partial<RefactorScanFindingV2> = {}): RefactorScanFindingV2 {
  return {
    recommendationId: REC_ID,
    fingerprint: shippedDecision().fingerprint,
    detector: 'component-cycle',
    severity: 'error',
    blocking: true,
    capabilityId: 'capability.runtime-harness.architecture',
    affectedNodeIds: ['capability.runtime-harness.architecture', 'capability.runtime-harness.refactor-program'],
    affectedPaths: Array.from({ length: 7 }, (_, index) => `src/mod/file-${index}.ts`),
    killList: [{ kind: 'path', target: 'src/mod/legacy.ts', required: true }],
    metrics: { thinDirectionEdgeCount: 2, totalEdgeCount: 5 },
    evidence: {
      summary: 'Thin-direction edges form a cycle.',
      thinDirectionEdgeCount: 2,
      sccSize: 3,
      splitClusterCount: 2,
      lcomScore: 1.5,
      instabilitySource: 0.75,
      instabilityTarget: 0.25,
      coChangeSupport: 6,
      coChangeCoverageOk: true,
      testCallerCoverage: null,
    },
    ...overrides,
  };
}

function scanV2(overrides: Partial<RefactorScanV2> = {}): RefactorScanV2 {
  return {
    schemaVersion: 'archcontext.refactor-scan/v2',
    scope: { kind: 'repository' },
    headSha: HEAD_SHA,
    snapshotDigest: SNAPSHOT_DIGEST,
    coverage: { imports: 'complete', gitHistory: 'complete', reasonCodes: [] },
    findings: [scanFinding()],
    suppressed: [],
    ...overrides,
  };
}

test('maps RefactorScanV2 to v3 recommendations with typed evidence scalars, affectedPaths, killList, and suppressed entries without writing state', () => {
  const f = fixture();
  const value = observeRefactorRecommendations(f.repo, {
    env: f.env,
    discover: () => scanV2({
      suppressed: [{ recommendationId: 'recommendation.abcdef0123456789', detector: 'co-change-coupling', decisionStatus: 'deferred', reason: 'Planned after release.' }],
    }),
  });
  expect(value).toMatchObject({
    schemaVersion: 'repo-harness.refactor-recommendations/v3',
    status: 'recommended',
    headSha: HEAD_SHA,
    snapshotDigest: SNAPSHOT_DIGEST,
    coverage: { imports: 'complete', gitHistory: 'complete', reasonCodes: [] },
  });
  expect(value.findings).toHaveLength(1);
  expect(value.suppressed).toHaveLength(1);
  expect(existsSync(join(f.repo, '.ai/harness/runs'))).toBe(false);

  const text = formatRefactorRecommendations(value);
  expect(text).toContain(`head: ${HEAD_SHA}`);
  expect(text).toContain(`snapshot digest: ${SNAPSHOT_DIGEST}`);
  expect(text).toContain('coverage: imports=complete, gitHistory=complete');
  expect(text).toContain('1. component-cycle [error, blocking] (capability: capability.runtime-harness.architecture)');
  expect(text).toContain('summary: Thin-direction edges form a cycle.');
  expect(text).toContain('evidence: thinDirectionEdgeCount=2, sccSize=3, splitClusterCount=2, lcomScore=1.5, instabilitySource=0.75, instabilityTarget=0.25, coChangeSupport=6, coChangeCoverageOk=true, testCallerCoverage=n/a');
  expect(text).toContain('affectedPaths (7):');
  expect(text).toContain('- src/mod/file-0.ts');
  expect(text).toContain('- src/mod/file-4.ts');
  expect(text).toContain('... (+2 more)');
  expect(text).not.toContain('src/mod/file-5.ts');
  expect(text).toContain('- path: src/mod/legacy.ts');
  expect(text).toContain('suppressed (1):');
  expect(text).toContain('recommendation.abcdef0123456789 (co-change-coupling, deferred): Planned after release.');
});

test('empty findings with complete import coverage produces no_action while surfacing shallow gitHistory coverage', () => {
  const f = fixture();
  const value = observeRefactorRecommendations(f.repo, {
    env: f.env,
    discover: () => scanV2({
      findings: [],
      coverage: { imports: 'complete', gitHistory: 'shallow', reasonCodes: ['git-history-shallow'] },
    }),
  });
  expect(value.status).toBe('no_action');
  expect(value.coverage).toEqual({ imports: 'complete', gitHistory: 'shallow', reasonCodes: ['git-history-shallow'] });
  expect(formatRefactorRecommendations(value)).toContain('coverage: imports=complete, gitHistory=shallow (reasons: git-history-shallow)');
});

test('withholds findings with proof_required on code-facts-import-limit or incomplete import coverage', () => {
  const f = fixture();
  const limits: Array<number | undefined> = [];
  const limited = observeRefactorRecommendations(f.repo, {
    env: f.env,
    importNodeLimit: 100,
    discover: (_root, _provider, limit) => {
      limits.push(limit);
      return scanV2({
        importNodeLimit: 100,
        coverage: { imports: 'partial', gitHistory: 'complete', reasonCodes: ['code-facts-import-limit'] },
      });
    },
  });
  expect(limits).toEqual([100]);
  expect(limited).toMatchObject({ status: 'proof_required', findings: [], importNodeLimit: 100 });
  expect(limited.message).toContain('limit 100');
  expect(limited.message).toContain('`rh arch refactor recommendations --import-node-limit <n>`');
  expect(limited.message).not.toContain('codegraph init');

  const partial = observeRefactorRecommendations(f.repo, {
    env: f.env,
    discover: () => scanV2({
      coverage: { imports: 'unavailable', gitHistory: 'shallow', reasonCodes: ['code-facts-missing'] },
    }),
  });
  expect(partial).toMatchObject({
    status: 'proof_required',
    findings: [],
    coverage: { imports: 'unavailable', gitHistory: 'shallow', reasonCodes: ['code-facts-missing'] },
  });
  expect(partial.message).toContain('codegraph init');
});

test('preserves provider errors, timeouts, and missing-model unavailable states', () => {
  const f = fixture();
  const stale = observeRefactorRecommendations(f.repo, {
    env: f.env,
    discover: () => {
      throw new RefactorProviderError('AC_REFACTOR_STALE', 'stale scan', 'rerun-refactor-scan', 'refactor-measurement-changed');
    },
  });
  expect(stale).toMatchObject({
    schemaVersion: 'repo-harness.refactor-recommendations/v3',
    status: 'unavailable',
    findings: [],
    code: 'AC_REFACTOR_STALE',
    reasonCode: 'refactor-measurement-changed',
    action: 'rerun-refactor-scan',
  });
  expect(formatRefactorRecommendations(stale)).toBe(
    '[RefactorRecommendations] unavailable: AC_REFACTOR_STALE: stale scan (reasonCode: refactor-measurement-changed) (action: rerun-refactor-scan)\n',
  );

  const times: Array<number | undefined> = [];
  observeRefactorRecommendations(f.repo, {
    env: f.env,
    timeoutMs: 300_000,
    discover: (_root, _provider, _limit, timeoutMs) => { times.push(timeoutMs); return scanV2(); },
  });
  expect(times).toEqual([300_000]);

  rmSync(join(f.repo, '.archcontext'), { recursive: true });
  expect(observeRefactorRecommendations(f.repo, { env: f.env, discover: () => { throw new Error('must not scan'); } }).status).toBe('unavailable');
});

test('exposes only repository-scoped v2 CLI subcommands and options, and formats verify/list/show cleanly', () => {
  const command = buildRefactorCommand();
  expect(command.commands.map((sub) => sub.name())).toEqual(['recommendations', 'decide', 'verify', 'resolve', 'list', 'show']);

  const optionLongs = (name: string) => command.commands.find((sub) => sub.name() === name)!.options.map((opt) => opt.long);
  expect(optionLongs('recommendations')).not.toContain('--node');
  expect(optionLongs('recommendations')).not.toContain('--path');
  expect(optionLongs('decide')).toContain('--kill-symbol');
  expect(optionLongs('decide')).toContain('--kill-path');
  expect(optionLongs('decide')).toContain('--kill-relation');
  expect(optionLongs('decide')).toContain('--json');
  expect(optionLongs('decide')).not.toContain('--snapshot-digest');
  expect(optionLongs('verify')).not.toContain('--expected-head-sha');
  expect(optionLongs('verify')).not.toContain('--expected-worktree-digest');
  expect(optionLongs('resolve')).toContain('--resolution-digest');
  expect(optionLongs('resolve')).not.toContain('--evidence-digest');
  expect(optionLongs('resolve')).not.toContain('--snapshot-digest');
  expect(optionLongs('list')).toContain('--import-node-limit');

  const recommendations = command.commands.find((sub) => sub.name() === 'recommendations')!;
  recommendations.exitOverride();
  recommendations.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  expect(() => recommendations.parse(['--node', 'capability.a'], { from: 'user' })).toThrow();
  expect(() => recommendations.parse(['--path', 'src/a.ts'], { from: 'user' })).toThrow();

  const verifyResult: RefactorVerifyV2 = {
    schemaVersion: 'archcontext.refactor-verify/v2',
    recommendationId: REC_ID,
    headSha: HEAD_SHA,
    snapshotDigest: SNAPSHOT_DIGEST,
    disposition: 'resolved',
    resolutionDigest: RESOLUTION_DIGEST,
    killListChecks: [{ kind: 'symbol', target: 'src/mod/legacy.ts#oldFn', required: true, status: 'removed' }],
    metricChecks: [{ metric: 'moduleDependencies.pairThinDirectionEdgeCount', before: 2, after: 0, satisfied: true }],
    blockingReasons: [],
    historicalReceipt: { status: 'accepted', headSha: HEAD_SHA, resolutionDigest: null },
  };
  const verifyText = formatRefactorVerify(verifyResult);
  expect(verifyText).toContain(`disposition=resolved`);
  expect(verifyText).toContain(`next: rh arch refactor resolve ${REC_ID} --resolution-digest ${RESOLUTION_DIGEST} --reason "<reason>"\n`);
  expect(verifyText).toContain('historicalReceipt: status=accepted');
  expect(verifyText).toContain('symbol src/mod/legacy.ts#oldFn: removed');

  const verifyWithFlags = formatRefactorVerify(verifyResult, {
    repo: "/tmp/target repo/work's",
    importNodeLimit: 20_000,
    timeoutMs: 300_000,
  });
  expect(verifyWithFlags).toContain(
    `next: rh arch refactor resolve ${REC_ID} --resolution-digest ${RESOLUTION_DIGEST} --reason "<reason>" --repo '/tmp/target repo/work'\\''s' --import-node-limit 20000 --timeout-ms 300000\n`,
  );
  expect(formatRefactorVerify(verifyResult, { repo: '/tmp/target-repo', importNodeLimit: 5_000 })).toContain(
    `next: rh arch refactor resolve ${REC_ID} --resolution-digest ${RESOLUTION_DIGEST} --reason "<reason>" --repo /tmp/target-repo --import-node-limit 5000\n`,
  );

  const listText = formatRefactorList({
    schemaVersion: 'archcontext.refactor-decide-list/v1',
    status: 'all',
    count: 2,
    decisions: [shippedDecision()],
    openFindings: [scanFinding()],
  });
  expect(listText).toContain('openFindings is best-effort');
  expect(listText).toContain('rh arch refactor recommendations');

  const showText = formatRefactorShow({
    schemaVersion: 'archcontext.refactor-decide-show/v1',
    recommendationId: REC_ID,
    decision: shippedDecision(),
    finding: null,
  });
  expect(showText).toContain(`status=${shippedDecision().status}`);
  expect(showText).toContain('best-effort');
});
