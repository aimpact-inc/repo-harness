import type { ArchitectureDebtDeltaReportV1, ArchitectureDebtItemV1, ArchitectureDebtReportV1 } from 'archctx-contracts';
import { ARCHCTX_REQUIRED_VERSION, ArchctxClientError, decodeArchitectureDebtDelta, decodeArchitectureDebtReport } from '../../core/architecture/projection';
import type { ArchctxProviderOptions } from '../../core/architecture/contracts';
import { ArchctxClient } from '../../effects/architecture/archctx-provider';
import { loadArchitectureProjectionPolicy } from '../../effects/architecture/projection-config';
import { resolveCommit, resolveWorktreeRoot } from './arch-verify';

export interface ArchitectureDebtOutputV1 {
  kind: 'repo-harness-architecture-debt';
  head: { sha: string; debt: ArchitectureDebtReportV1 };
  base: ArchitectureDebtDeltaReportV1['base'] | null;
  introduced: ArchitectureDebtItemV1[] | null;
  resolvedIds: string[] | null;
}

/** Measure the checkout and optional Git base in complete mode. ArchContext owns delta coverage and item identity. */
export function architectureDebtReport(repoRoot: string, baseRef: string | undefined, options: ArchctxProviderOptions = {}): ArchitectureDebtOutputV1 {
  const headSha = requireCommit(repoRoot, 'HEAD');
  const base = baseRef === undefined ? null : { ref: baseRef, sha: requireCommit(repoRoot, baseRef) };
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  if (policy.provider === 'disabled') throw new Error('architecture projection provider is disabled');
  const client = new ArchctxClient(repoRoot, ARCHCTX_REQUIRED_VERSION, options);
  if (base === null) {
    const debt = decodeArchitectureDebtReport(client.data(['debt', '--complete', '--json'], policy.timeoutMs));
    if (resolveCommit(repoRoot, 'HEAD') !== headSha) throw new Error('architecture debt checkout changed during measurement');
    return { kind: 'repo-harness-architecture-debt', head: { sha: headSha, debt }, base: null, introduced: null, resolvedIds: null };
  }
  const report = readDebtDelta(client, base.sha, headSha, policy.timeoutMs);
  return { kind: 'repo-harness-architecture-debt', ...report, base: { ...report.base, ref: base.ref } };
}

function readDebtDelta(client: ArchctxClient, baseSha: string, headSha: string, timeoutMs: number) {
  const measure = () => {
    const { head, base, introduced, resolvedIds } = decodeArchitectureDebtDelta(client.data(['debt', '--base', baseSha, '--complete', '--json'], timeoutMs));
    if (head.sha !== headSha || base.sha !== baseSha || base.ref !== baseSha) throw new Error('architecture debt delta snapshot mismatch');
    return { head, base, introduced, resolvedIds };
  };
  const indexMissing = (base: ArchitectureDebtDeltaReportV1['base']) => base.coverageReasonCodes.some(code => code.endsWith(':index-missing'));
  const first = measure();
  if (!indexMissing(first.base)) return first;

  // ArchContext can seed its detached base after sync publishes the shared CodeGraph snapshot.
  client.data(['sync', '--json'], timeoutMs);
  const retried = measure();
  if (indexMissing(retried.base)) {
    throw new Error('Architecture debt base has no CodeGraph index after sync. Run `rh arch sync --json` in the primary checkout and retry.');
  }
  return retried;
}

export function architectureDebtSummary(output: ArchitectureDebtOutputV1): string {
  const debt = output.head.debt;
  const counts = new Map<string, number>();
  for (const item of debt.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const lines = [`architecture debt at HEAD ${output.head.sha.slice(0, 12)}: ${debt.items.length} items, coverage ${debt.coverage}`];
  for (const [kind, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${kind}: ${count}`);
  if (debt.coverageReasonCodes.length > 0) lines.push(`  coverage gaps: ${debt.coverageReasonCodes.join(', ')}`);
  if (output.base && output.introduced && output.resolvedIds) {
    lines.push(`base ${output.base.ref} ${output.base.sha.slice(0, 12)}: coverage ${output.base.coverage}; introduced ${output.introduced.length}, resolved ${output.resolvedIds.length}`);
    if (output.base.coverageReasonCodes.length > 0) lines.push(`  base coverage gaps: ${output.base.coverageReasonCodes.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function requireCommit(repoRoot: string, ref: string): string {
  const sha = resolveCommit(repoRoot, ref);
  if (sha === null) {
    throw new ArchctxClientError({ code: 'RH_ARCHITECTURE_DEBT_REF_UNRESOLVED', action: 'pass-a-commit-ref', reasonCode: 'ref-unresolved', details: { ref }, message: `${ref} does not resolve to a commit` });
  }
  return sha;
}

/** `rh arch debt` loads this module only after the architecture selection check. */
export function runArchitectureDebtCommand(options: { json?: boolean; base?: string }): void {
  try {
    const root = resolveWorktreeRoot(process.cwd());
    if (root === null) throw new Error('not inside a Git worktree');
    const output = architectureDebtReport(root, options.base);
    process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : architectureDebtSummary(output));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
