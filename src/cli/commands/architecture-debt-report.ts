import type { ArchitectureDebtDeltaReportV1, ArchitectureDebtItemV1, ArchitectureDebtReportV1 } from 'archctx-contracts';
import { ArchctxClientError } from '../../core/architecture/projection';
import type { ArchctxProviderOptions } from '../../core/architecture/contracts';
import { completeArchitectureDebt, readArchitectureDebtDelta } from '../../effects/architecture/archctx-provider';
import { gitSpawnSync } from '../../effects/git/runner';

export interface ArchitectureDebtOutputV1 {
  kind: 'repo-harness-architecture-debt';
  head: { sha: string; debt: ArchitectureDebtReportV1 };
  base: ArchitectureDebtDeltaReportV1['base'] | null;
  introduced: ArchitectureDebtItemV1[] | null;
  resolvedIds: string[] | null;
}

/** Measure HEAD and, when requested, compare it with a resolved Git base. */
export function architectureDebtReport(repoRoot: string, baseRef: string | undefined, options: ArchctxProviderOptions = {}): ArchitectureDebtOutputV1 {
  const headSha = resolveCommit(repoRoot, 'HEAD');
  if (baseRef === undefined) {
    const debt = completeArchitectureDebt(repoRoot, headSha, options);
    return { kind: 'repo-harness-architecture-debt', head: { sha: headSha, debt }, base: null, introduced: null, resolvedIds: null };
  }
  const baseSha = resolveCommit(repoRoot, baseRef);
  const { head, base, introduced, resolvedIds } = readArchitectureDebtDelta(repoRoot, baseSha, headSha, options);
  return { kind: 'repo-harness-architecture-debt', head, base: { ...base, ref: baseRef }, introduced, resolvedIds };
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

function resolveCommit(repoRoot: string, ref: string): string {
  const result = gitSpawnSync(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  if (!/^[a-f0-9]{40,64}$/.test(sha)) {
    throw new ArchctxClientError({ code: 'RH_ARCHITECTURE_DEBT_REF_UNRESOLVED', action: 'pass-a-commit-ref', reasonCode: 'ref-unresolved', details: { ref }, message: `${ref} does not resolve to a commit` });
  }
  return sha;
}

/** `rh arch debt` loads this module only after the architecture selection check. */
export function runArchitectureDebtCommand(options: { json?: boolean; base?: string }): void {
  try {
    const output = architectureDebtReport(git(process.cwd(), ['rev-parse', '--show-toplevel']), options.base);
    process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : architectureDebtSummary(output));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function git(cwd: string, args: string[]): string {
  const result = gitSpawnSync(['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
