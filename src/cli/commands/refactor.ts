import { Command, InvalidArgumentError, Option } from 'commander';
import type { RecommendationStatus } from 'archctx-contracts';
import {
  normalizeRefactorScope,
  REFACTOR_DECISIONS,
  REFACTOR_DEFAULT_TIMEOUT_MS,
  REFACTOR_MAX_TIMEOUT_MS,
  REFACTOR_MIN_TIMEOUT_MS,
  RefactorProviderError,
  type RefactorDecision,
} from '../../core/refactor/provider-contract';
import { canonicalRepoPath } from '../../effects/repo-registry';
import type { RefactorRecommendation, RefactorRecommendationResult } from '../../effects/refactor/recommendations';

const EVIDENCE_ITEMS_SHOWN = 5;
const LIST_STATUSES: readonly RecommendationStatus[] = [
  'open',
  'acknowledged',
  'accepted',
  'rejected',
  'deferred',
  'waived',
  'resolved',
  'superseded',
  'expired',
];

export function formatRefactorRecommendations(value: RefactorRecommendationResult): string {
  if (value.status !== 'recommended') {
    const detail = [value.code, value.message].filter(Boolean).join(': ');
    const reason = value.reasonCode ? ` (reasonCode: ${value.reasonCode})` : '';
    return `[RefactorRecommendations] ${value.status}${detail ? `: ${detail}` : ''}${reason}${value.action ? ` (action: ${value.action})` : ''}\n`;
  }
  const header = [
    `snapshot digest: ${value.snapshotDigest}`,
    ...(value.message ? [`note: ${value.message}`] : []),
    '',
  ].join('\n');
  return [header, ...value.candidates.map(formatCandidate)].join('\n');
}

/** First lines of the bounded evidence sample; `--json` carries all of it. */
function evidenceLines(evidence: RefactorRecommendation['evidence'], proposal: RefactorRecommendation['proposal']): string[] {
  if (proposal) {
    return [
      `  proposal: scale=${proposal.scale} (${proposal.targetOutcomes.length} target outcome(s), ${proposal.killList.length} kill entry/entries)`,
      ...proposal.killList.slice(0, EVIDENCE_ITEMS_SHOWN).map((entry) => `    - kill ${entry.kind}: ${entry.selectorId}`),
    ];
  }
  if (!evidence) return [];
  const items = (() => {
    switch (evidence.kind) {
      case 'cycle':
      case 'residual-cycle': return evidence.edges.map((edge) => `${edge.fromPath}:${edge.fromLine ?? '?'} -> ${edge.toPath}`);
      case 'direction-violation': return evidence.violations.map((entry) => `${entry.constraintId}: ${entry.fromPath}:${entry.fromLine ?? '?'} -> ${entry.toPath}`);
      case 'evidence-gap': return evidence.unresolvedImports.map((entry) => `${entry.fromPath}:${entry.fromLine ?? '?'} imports ${entry.specifier}`);
      case 'ownership-ambiguous':
      case 'undeclared-footprint':
      case 'unowned-paths': return evidence.paths.map((entry) => entry.path);
    }
  })();
  return [
    `  evidence: ${evidence.kind}, ${evidence.totalCount} total${evidence.truncated ? ' (sample is truncated)' : ''}`,
    ...items.slice(0, EVIDENCE_ITEMS_SHOWN).map((line) => `    - ${line}`),
  ];
}

function formatCandidate(entry: RefactorRecommendation, index: number): string {
  const metrics = Object.entries(entry.metrics).map(([key, metric]) => `${key}=${metric ?? 'n/a'}`).join(', ');
  const modules = entry.modules.map((module) => `  - ${module.nodeId}: ${module.files ?? '?'} files / ${module.lines ?? '?'} lines, fan-in ${module.fanIn ?? '?'}, fan-out ${module.fanOut ?? '?'}, cycles ${module.cycles ?? '?'}, direction violations ${module.directionViolations ?? '?'}, unresolved imports ${module.unresolvedImports}${module.ambiguousOwnership ? ' (ambiguous ownership)' : ''}`);
  return [
    `${index + 1}. ${entry.kind} on ${entry.subject} (risk ${entry.risk}, confidence ${entry.confidence}, uncertainty ${entry.uncertainty}${entry.ambiguousOwnership ? ', ambiguous ownership' : ''})`,
    `  id: ${entry.recommendationId}`,
    ...entry.explanation.map((line) => `  ${line}`),
    ...(metrics ? [`  metrics: ${metrics}`] : []),
    ...evidenceLines(entry.evidence, entry.proposal),
    ...(entry.snapshot === 'earlier' ? [`  recorded on an earlier snapshot (${entry.baselineSnapshotDigest}); current module statistics are not shown`] : []),
    ...(modules.length ? ['  modules:', ...modules.map((line) => `  ${line}`)] : []),
    '',
  ].join('\n');
}

function parseImportNodeLimit(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) throw new InvalidArgumentError('must be a positive integer');
  return Number(value);
}

function parseTimeoutMs(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < REFACTOR_MIN_TIMEOUT_MS || Number(value) > REFACTOR_MAX_TIMEOUT_MS) throw new InvalidArgumentError(`must be an integer from ${REFACTOR_MIN_TIMEOUT_MS} to ${REFACTOR_MAX_TIMEOUT_MS}`);
  return Number(value);
}

function collectScopePath(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const reason = error instanceof RefactorProviderError && error.reasonCode ? ` (reasonCode: ${error.reasonCode})` : '';
  process.stderr.write(`${error instanceof RefactorProviderError ? `${error.code}: ${message}${reason}${error.action ? ` (action: ${error.action})` : ''}` : message}\n`);
  process.exitCode = 1;
}

export function buildRefactorCommand(): Command {
  const command = new Command('refactor').description('Show measured refactor suggestions, verify outcomes, and record user decisions');
  command.command('recommendations')
    .description('Show measured suggestions with evidence; never executes a refactor')
    .option('--repo <path>', 'Repository root', '.')
    .addOption(new Option('--node <nodeId>', 'Limit scan observations to one declared architecture node').conflicts('path'))
    .addOption(new Option('--path <repo-relative-path>', 'Limit scan observations to the owners of these repository-relative POSIX paths (repeatable)').argParser(collectScopePath).conflicts('node'))
    .option('--import-node-limit <n>', 'Raise the CodeGraph import read cap; use the same value for decide', parseImportNodeLimit)
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: { repo: string; node?: string; path?: string[]; importNodeLimit?: number; timeoutMs?: number; json?: boolean }) => {
      try {
        const scope = normalizeRefactorScope({ node: options.node, paths: options.path });
        const { observeRefactorRecommendations } = await import('../../effects/refactor/recommendations');
        const value = observeRefactorRecommendations(canonicalRepoPath(options.repo), {
          importNodeLimit: options.importNodeLimit,
          timeoutMs: options.timeoutMs,
          ...(scope.kind === 'repository' ? {} : { scope }),
        });
        process.stdout.write(options.json ? `${JSON.stringify(value, null, 2)}\n` : formatRefactorRecommendations(value));
        if (value.status === 'unavailable' || value.status === 'proof_required') process.exitCode = 1;
      } catch (error) { fail(error); }
    });
  command.command('decide')
    .description('Record the user decision on one suggestion in ArchContext')
    .argument('<recommendation-id>')
    .argument('<decision>', REFACTOR_DECISIONS.join('|'))
    .requiredOption('--reason <text>', 'Why the user decided this way')
    .requiredOption('--snapshot-digest <digest>', 'Snapshot digest from rh arch refactor recommendations')
    .option('--repo <path>', 'Repository root', '.')
    .option('--import-node-limit <n>', 'Same limit the suggestion was scanned with', parseImportNodeLimit)
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .action(async (recommendationId: string, decision: string, options: { reason: string; snapshotDigest: string; repo: string; importNodeLimit?: number; timeoutMs?: number }) => {
      try {
        if (!REFACTOR_DECISIONS.includes(decision as RefactorDecision)) throw new Error(`decision must be one of ${REFACTOR_DECISIONS.join('|')}`);
        const { decideRefactorRecommendation } = await import('./refactor-actions');
        const status = decideRefactorRecommendation(canonicalRepoPath(options.repo), recommendationId, decision as RefactorDecision, options.reason, options.snapshotDigest, options.importNodeLimit, options.timeoutMs);
        process.stdout.write(`${JSON.stringify({ recommendationId, status }, null, 2)}\n`);
      } catch (error) { fail(error); }
    });
  command.command('verify')
    .description('Re-measure HEAD against one recorded recommendation and verify resolution outcomes')
    .argument('<recommendation-id>')
    .option('--expected-head-sha <sha>', '40-hex Git SHA expected at HEAD')
    .option('--expected-worktree-digest <digest>', 'Expected sha256:<64-hex> worktree digest')
    .option('--import-node-limit <n>', 'Override the CodeGraph import read cap', parseImportNodeLimit)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (recommendationId: string, options: { expectedHeadSha?: string; expectedWorktreeDigest?: string; importNodeLimit?: number; repo: string; timeoutMs?: number; json?: boolean }) => {
      try {
        const { verifyRefactorRecommendation } = await import('./refactor-actions');
        const result = verifyRefactorRecommendation(canonicalRepoPath(options.repo), recommendationId, {
          expectedHeadSha: options.expectedHeadSha,
          expectedWorktreeDigest: options.expectedWorktreeDigest,
          importNodeLimit: options.importNodeLimit,
          timeoutMs: options.timeoutMs,
        });
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write([
            `[RefactorVerify] ${result.recommendationId}: disposition=${result.disposition ?? 'none'} (status ${result.recommendationStatus})`,
            ...(result.resolutionDigest ? [`  resolutionDigest: ${result.resolutionDigest}`] : []),
            ...(result.resolveCommand ? [`  next: ${result.resolveCommand}`] : []),
            '',
          ].join('\n'));
        }
        if (result.disposition !== 'resolved') process.exitCode = 1;
      } catch (error) { fail(error); }
    });
  command.command('resolve')
    .description('Mark a verified recommendation resolved in .archcontext/refactor-decisions/')
    .argument('<recommendation-id>')
    .requiredOption('--evidence-digest <digest>', 'Resolution evidence digest from rh arch refactor verify')
    .requiredOption('--reason <text>', 'Why this recommendation is resolved')
    .option('--snapshot-digest <digest>', 'Optional scan snapshot digest')
    .option('--import-node-limit <n>', 'Same limit the suggestion was scanned with', parseImportNodeLimit)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (recommendationId: string, options: { evidenceDigest: string; reason: string; snapshotDigest?: string; importNodeLimit?: number; repo: string; timeoutMs?: number; json?: boolean }) => {
      try {
        const { resolveRefactorRecommendation } = await import('./refactor-actions');
        const result = resolveRefactorRecommendation(canonicalRepoPath(options.repo), recommendationId, options.evidenceDigest, options.reason, options.snapshotDigest, options.importNodeLimit, options.timeoutMs);
        process.stdout.write(`${JSON.stringify(options.json ? result : { recommendationId: result.recommendationId, status: result.nextStatus, decisionFile: result.decisionFile }, null, 2)}\n`);
      } catch (error) { fail(error); }
    });
  command.command('record')
    .description('Persist a scanned refactor assessment into the local ArchContext ledger')
    .requiredOption('--assessment-digest <digest>', 'Assessment digest from rh arch refactor recommendations --json')
    .requiredOption('--expected-worktree-digest <digest>', 'Worktree digest from rh arch refactor recommendations --json')
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: { assessmentDigest: string; expectedWorktreeDigest: string; repo: string; timeoutMs?: number; json?: boolean }) => {
      try {
        const { recordRefactorAssessment } = await import('./refactor-actions');
        const result = recordRefactorAssessment(canonicalRepoPath(options.repo), options.assessmentDigest, options.expectedWorktreeDigest, options.timeoutMs);
        process.stdout.write(`${JSON.stringify(options.json ? result : { runId: result.runId, recommendationIds: result.recommendationIds }, null, 2)}\n`);
      } catch (error) { fail(error); }
    });
  command.command('list')
    .description('List recorded refactor recommendations and Git decisions')
    .option('--status <status>', `Filter by status (${LIST_STATUSES.join('|')})`)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: { status?: string; repo: string; timeoutMs?: number; json?: boolean }) => {
      try {
        if (options.status !== undefined && !LIST_STATUSES.includes(options.status as RecommendationStatus)) {
          throw new Error(`--status must be one of ${LIST_STATUSES.join('|')}`);
        }
        const { listRecordedRefactorRecommendations } = await import('./refactor-actions');
        const result = listRecordedRefactorRecommendations(canonicalRepoPath(options.repo), options.status as RecommendationStatus | undefined, options.timeoutMs);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          const lines = [
            `[RefactorList] status=${result.status} count=${result.count}`,
            ...result.recommendations.map((r) => `  - ${r.recommendationId} (${r.status}) ${r.subject}`),
            ...result.decisions.map((d) => `  - ${d.recommendationId} (${d.status}, git-only) ${d.subject.stableKey}`),
            '',
          ];
          process.stdout.write(lines.join('\n'));
        }
      } catch (error) { fail(error); }
    });
  command.command('show')
    .description('Show one recorded refactor recommendation or Git decision')
    .argument('<recommendation-id>')
    .option('--import-node-limit <n>', 'Same limit the suggestion was scanned with', parseImportNodeLimit)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (recommendationId: string, options: { importNodeLimit?: number; repo: string; timeoutMs?: number; json?: boolean }) => {
      try {
        const { showRecordedRefactorRecommendation } = await import('./refactor-actions');
        const result = showRecordedRefactorRecommendation(canonicalRepoPath(options.repo), recommendationId, options.importNodeLimit, options.timeoutMs);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) { fail(error); }
    });
  return command;
}
