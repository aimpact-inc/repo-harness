import { Command, InvalidArgumentError } from 'commander';
import {
  REFACTOR_DECISIONS,
  REFACTOR_DEFAULT_TIMEOUT_MS,
  REFACTOR_LIST_STATUSES,
  REFACTOR_MAX_TIMEOUT_MS,
  REFACTOR_MIN_TIMEOUT_MS,
  RefactorProviderError,
  type RecommendationStatus,
  type RefactorDecideListResultV1,
  type RefactorDecideResultV1,
  type RefactorDecideShowResultV1,
  type RefactorDecision,
  type RefactorResolveResultV1,
  type RefactorScanFindingV2,
  type RefactorVerifyV2,
} from '../../core/refactor/provider-contract';
import { shellQuote } from '../../core/shell-quote';
import { gitSpawnSync } from '../../effects/git/runner';
import { canonicalRepoPath } from '../../effects/repo-registry';
import type { RefactorRecommendationResult, RefactorScanCoverage } from '../../effects/refactor/recommendations';

const EVIDENCE_ITEMS_SHOWN = 5;

function formatCoverageLine(coverage: RefactorScanCoverage): string {
  const reasons = coverage.reasonCodes.length > 0 ? ` (reasons: ${coverage.reasonCodes.join(', ')})` : '';
  return `coverage: imports=${coverage.imports}, gitHistory=${coverage.gitHistory}${reasons}`;
}

function formatEvidenceScalars(evidence: RefactorScanFindingV2['evidence']): string[] {
  const scalars: string[] = [];
  if (evidence.thinDirectionEdgeCount !== undefined) scalars.push(`thinDirectionEdgeCount=${evidence.thinDirectionEdgeCount}`);
  if (evidence.sccSize !== undefined) scalars.push(`sccSize=${evidence.sccSize}`);
  if (evidence.splitClusterCount !== undefined) scalars.push(`splitClusterCount=${evidence.splitClusterCount}`);
  if (evidence.lcomScore !== undefined) scalars.push(`lcomScore=${evidence.lcomScore}`);
  if (evidence.instabilitySource !== undefined) scalars.push(`instabilitySource=${evidence.instabilitySource}`);
  if (evidence.instabilityTarget !== undefined) scalars.push(`instabilityTarget=${evidence.instabilityTarget}`);
  if (evidence.coChangeSupport !== undefined) scalars.push(`coChangeSupport=${evidence.coChangeSupport}`);
  if (evidence.coChangeCoverageOk !== undefined) scalars.push(`coChangeCoverageOk=${evidence.coChangeCoverageOk}`);
  if (evidence.testCallerCoverage !== undefined) scalars.push(`testCallerCoverage=${evidence.testCallerCoverage ?? 'n/a'}`);
  return scalars;
}

function formatFinding(finding: RefactorScanFindingV2, index: number): string {
  const scalars = formatEvidenceScalars(finding.evidence);
  const metrics = Object.entries(finding.metrics).map(([key, value]) => `${key}=${value ?? 'n/a'}`).join(', ');
  const pathsShown = finding.affectedPaths.slice(0, EVIDENCE_ITEMS_SHOWN);
  const hiddenPaths = finding.affectedPaths.length - pathsShown.length;
  const capability = finding.capabilityId ? ` (capability: ${finding.capabilityId})` : '';
  return [
    `${index + 1}. ${finding.detector} [${finding.severity}, ${finding.blocking ? 'blocking' : 'non-blocking'}]${capability}`,
    `  id: ${finding.recommendationId}`,
    ...(finding.affectedNodeIds.length > 0 ? [`  nodes: ${finding.affectedNodeIds.join(', ')}`] : []),
    `  summary: ${finding.evidence.summary}`,
    ...(scalars.length > 0 ? [`  evidence: ${scalars.join(', ')}`] : []),
    ...(metrics ? [`  metrics: ${metrics}`] : []),
    ...(finding.affectedPaths.length > 0 ? [
      `  affectedPaths (${finding.affectedPaths.length}):`,
      ...pathsShown.map((path) => `    - ${path}`),
      ...(hiddenPaths > 0 ? [`    ... (+${hiddenPaths} more)`] : []),
    ] : []),
    ...(finding.killList.length > 0 ? [
      `  killList (${finding.killList.length}):`,
      ...finding.killList.map((entry) => `    - ${entry.kind}: ${entry.target}${entry.required ? '' : ' (optional)'}`),
    ] : []),
    '',
  ].join('\n');
}

function formatSuppressedLines(suppressed: RefactorRecommendationResult['suppressed']): string[] {
  if (suppressed.length === 0) return [];
  return [
    `suppressed (${suppressed.length}):`,
    ...suppressed.map((entry) => `  - ${entry.recommendationId} (${entry.detector}, ${entry.decisionStatus}): ${entry.reason}`),
  ];
}

export function formatRefactorRecommendations(value: RefactorRecommendationResult): string {
  if (value.status !== 'recommended') {
    const detail = [value.code, value.message].filter(Boolean).join(': ');
    const reason = value.reasonCode ? ` (reasonCode: ${value.reasonCode})` : '';
    const action = value.action ? ` (action: ${value.action})` : '';
    const lines = [
      `[RefactorRecommendations] ${value.status}${detail ? `: ${detail}` : ''}${reason}${action}`,
      ...(value.coverage ? [`  ${formatCoverageLine(value.coverage)}`] : []),
      ...formatSuppressedLines(value.suppressed),
      '',
    ];
    return lines.join('\n');
  }
  const header = [
    ...(value.headSha ? [`head: ${value.headSha}`] : []),
    ...(value.snapshotDigest ? [`snapshot digest: ${value.snapshotDigest}`] : []),
    ...(value.coverage ? [formatCoverageLine(value.coverage)] : []),
    '',
  ].join('\n');
  const suppressed = formatSuppressedLines(value.suppressed);
  return [
    header,
    ...value.findings.map(formatFinding),
    ...(suppressed.length > 0 ? [...suppressed, ''] : []),
  ].join('\n');
}

export function resolveDecisionCommitRoot(targetPath: string): string {
  const probe = gitSpawnSync(['-C', targetPath, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const topLevel = probe.status === 0 ? probe.stdout.replace(/\r?\n$/, '') : '';
  const candidate = topLevel || targetPath;
  if (candidate !== candidate.trim()) {
    throw new RefactorProviderError(
      'refactor_unsafe_repo_root',
      `Refused Git checkout root with leading or trailing whitespace (${JSON.stringify(candidate)}); pinned archctx trims Git roots and could target an adjacent checkout.`,
    );
  }
  const canonical = canonicalRepoPath(candidate);
  if (canonical !== canonical.trim()) {
    throw new RefactorProviderError(
      'refactor_unsafe_repo_root',
      `Refused canonical Git checkout root with leading or trailing whitespace (${JSON.stringify(canonical)}); pinned archctx trims Git roots and could target an adjacent checkout.`,
    );
  }
  return canonical;
}

function quoteCommandArg(value: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : shellQuote(value);
}

function formatShellArg(value: string, platform: NodeJS.Platform = process.platform): string {
  const safePattern = platform === 'win32' ? /^[A-Za-z0-9_./:@%+=-]+$/ : /^[A-Za-z0-9_./:@%+=,-]+$/;
  return safePattern.test(value) ? value : quoteCommandArg(value, platform);
}

function formatDecisionCommitHint(
  repoRoot: string | undefined,
  filePath: string,
  message: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const gitPrefix = repoRoot ? `git -C ${formatShellArg(repoRoot, platform)}` : 'git';
  const quotedPath = formatShellArg(filePath, platform);
  const quotedMessage = quoteCommandArg(message, platform);
  if (platform === 'win32') {
    return `${gitPrefix} add '--' ${quotedPath}; if ($LASTEXITCODE -eq 0) { ${gitPrefix} commit --only -m ${quotedMessage} '--' ${quotedPath} }`;
  }
  return `${gitPrefix} add -- ${quotedPath} && ${gitPrefix} commit --only -m ${quotedMessage} -- ${quotedPath}`;
}

export function formatRefactorDecide(
  result: RefactorDecideResultV1,
  repoRoot?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const killCount = result.decision.killList?.length ?? 0;
  const commitMessage = `chore(architecture): record refactor decision ${result.recommendationId} (${result.status})`;
  return [
    `[RefactorDecide] ${result.recommendationId}: status=${result.status}`,
    `  file: ${result.filePath}`,
    ...(killCount > 0 ? [`  killList: ${killCount} target(s)`] : []),
    `  next: ${formatDecisionCommitHint(repoRoot, result.filePath, commitMessage, platform)}`,
    '',
  ].join('\n');
}

export interface RefactorVerifyFormatOptions {
  readonly repo?: string;
  readonly importNodeLimit?: number;
  readonly timeoutMs?: number;
  readonly platform?: NodeJS.Platform;
}

export function formatRefactorVerify(result: RefactorVerifyV2, invocation: RefactorVerifyFormatOptions = {}): string {
  const platform = invocation.platform ?? process.platform;
  const repoFlag = invocation.repo !== undefined && invocation.repo !== ''
    ? [`--repo ${formatShellArg(invocation.repo, platform)}`]
    : [];
  const nextParts = [
    `rh arch refactor resolve ${result.recommendationId}`,
    `--resolution-digest ${result.resolutionDigest}`,
    '--reason "<reason>"',
    ...repoFlag,
    ...(invocation.importNodeLimit !== undefined ? [`--import-node-limit ${invocation.importNodeLimit}`] : []),
    ...(invocation.timeoutMs !== undefined ? [`--timeout-ms ${invocation.timeoutMs}`] : []),
  ];
  const missingBaseline = result.disposition === 'stale' && result.blockingReasons.includes('baseline-metadata-missing');
  const legacyNext = missingBaseline
    ? [
      `  next: legacy decision lacks baseline proof metadata; attach a verifiable kill-list via \`rh arch refactor decide accept ${result.recommendationId} --reason "<reason>" --kill-path <path>${repoFlag.length > 0 ? ` ${repoFlag[0]}` : ''}\` or retire it via \`rh arch refactor decide reject ${result.recommendationId} --reason "<reason>"${repoFlag.length > 0 ? ` ${repoFlag[0]}` : ''}\` (or \`git rm .archcontext/refactor-decisions/${result.recommendationId}.json\`).`,
    ]
    : [];
  return [
    `[RefactorVerify] ${result.recommendationId}: disposition=${result.disposition}`,
    `  headSha: ${result.headSha}`,
    `  resolutionDigest: ${result.resolutionDigest}`,
    ...(result.historicalReceipt ? [
      `  historicalReceipt: status=${result.historicalReceipt.status}, headSha=${result.historicalReceipt.headSha}, resolutionDigest=${result.historicalReceipt.resolutionDigest ?? 'none'}`,
    ] : []),
    ...(result.metricChecks.length > 0 ? [
      '  metricChecks:',
      ...result.metricChecks.map((check) => `    - ${check.metric}: before=${check.before ?? 'n/a'}, after=${check.after ?? 'n/a'} [${check.satisfied ? 'ok' : 'unsatisfied'}]`),
    ] : []),
    ...(result.killListChecks.length > 0 ? [
      '  killListChecks:',
      ...result.killListChecks.map((check) => `    - ${check.kind} ${check.target}: ${check.status}${check.required ? '' : ' (optional)'}`),
    ] : []),
    ...(result.blockingReasons.length > 0 ? [`  blockingReasons: ${result.blockingReasons.join(', ')}`] : []),
    ...(result.disposition === 'resolved' ? [
      `  next: ${nextParts.join(' ')}`,
    ] : legacyNext),
    '',
  ].join('\n');
}

export function formatRefactorResolve(
  result: RefactorResolveResultV1,
  repoRoot?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const commitMessage = `chore(architecture): mark refactor decision ${result.recommendationId} resolved`;
  return [
    `[RefactorResolve] ${result.recommendationId}: status=${result.status}`,
    `  file: ${result.filePath}`,
    `  resolutionDigest: ${result.verification.resolutionDigest}`,
    `  next: ${formatDecisionCommitHint(repoRoot, result.filePath, commitMessage, platform)}`,
    '',
  ].join('\n');
}

export function formatRefactorList(result: RefactorDecideListResultV1): string {
  const showOpenNote = result.status === 'all' || result.status === 'open';
  return [
    `[RefactorList] status=${result.status} count=${result.count} (decisions=${result.decisions.length}, openFindings=${result.openFindings.length})`,
    ...result.decisions.map((decision) => `  - ${decision.recommendationId} (${decision.status}, git-decision) ${decision.subject.stableKey}`),
    ...result.openFindings.map((finding) => `  - ${finding.recommendationId} (open, ${finding.detector}, ${finding.severity}) ${finding.evidence.summary}`),
    ...(showOpenNote ? ['  note: openFindings is best-effort (scan errors are omitted by archctx decide list); run `rh arch refactor recommendations` for authoritative scan coverage.'] : []),
    '',
  ].join('\n');
}

export function formatRefactorShow(result: RefactorDecideShowResultV1): string {
  const lines = [`[RefactorShow] ${result.recommendationId}`];
  if (result.decision) {
    lines.push(`  decision: status=${result.decision.status}, kind=${result.decision.kind ?? 'n/a'}, decidedAt=${result.decision.decidedAt}, headSha=${result.decision.provenance.headSha}`);
    lines.push(`  reason: ${result.decision.reason}`);
    if (result.decision.resolutionDigest) lines.push(`  resolutionDigest: ${result.decision.resolutionDigest}`);
    if (result.decision.killList && result.decision.killList.length > 0) {
      lines.push(`  killList (${result.decision.killList.length}):`);
      for (const entry of result.decision.killList) {
        lines.push(`    - ${entry.kind}: ${entry.target}${entry.required ? '' : ' (optional)'}`);
      }
    }
  } else {
    lines.push('  decision: none');
  }
  if (result.finding) {
    lines.push(`  finding: ${result.finding.detector} [${result.finding.severity}, ${result.finding.blocking ? 'blocking' : 'non-blocking'}] — ${result.finding.evidence.summary}`);
    if (result.finding.affectedPaths.length > 0) {
      lines.push(`  affectedPaths: ${result.finding.affectedPaths.slice(0, EVIDENCE_ITEMS_SHOWN).join(', ')}`);
    }
  } else {
    lines.push('  finding: none (live scan findings are best-effort in archctx decide show; run `rh arch refactor recommendations` for authoritative scan coverage)');
  }
  lines.push('');
  return lines.join('\n');
}

function parseImportNodeLimit(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < 1) throw new InvalidArgumentError('must be a positive integer');
  return Number(value);
}

function parseTimeoutMs(value: string): number {
  if (!/^[0-9]+$/.test(value) || Number(value) < REFACTOR_MIN_TIMEOUT_MS || Number(value) > REFACTOR_MAX_TIMEOUT_MS) {
    throw new InvalidArgumentError(`must be an integer from ${REFACTOR_MIN_TIMEOUT_MS} to ${REFACTOR_MAX_TIMEOUT_MS}`);
  }
  return Number(value);
}

function collectValues(value: string, previous: string[] = []): string[] {
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
    .description('Show measured v2 refactor findings with coverage; never executes a refactor')
    .option('--repo <path>', 'Repository root', '.')
    .option('--import-node-limit <n>', 'Raise the CodeGraph import read cap; use the same value for decide and verify', parseImportNodeLimit)
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: { repo: string; importNodeLimit?: number; timeoutMs?: number; json?: boolean }) => {
      try {
        const { observeRefactorRecommendations } = await import('../../effects/refactor/recommendations');
        const value = observeRefactorRecommendations(canonicalRepoPath(options.repo), {
          importNodeLimit: options.importNodeLimit,
          timeoutMs: options.timeoutMs,
        });
        process.stdout.write(options.json ? `${JSON.stringify(value, null, 2)}\n` : formatRefactorRecommendations(value));
        if (value.status === 'unavailable' || value.status === 'proof_required') process.exitCode = 1;
      } catch (error) { fail(error); }
    });
  command.command('decide')
    .description('Record a Git-tracked user decision on one recommendation in .archcontext/refactor-decisions/')
    .argument('<recommendation-id>')
    .argument('<decision>', REFACTOR_DECISIONS.join('|'))
    .requiredOption('--reason <text>', 'Why the user decided this way')
    .option('--kill-symbol <path#symbol>', 'Require a symbol to be absent on verify (repeatable; accept only)', collectValues)
    .option('--kill-path <repo-relative-path>', 'Require a tracked file path to be absent on verify (repeatable; accept only)', collectValues)
    .option('--kill-relation <relation-id>', 'Require a model relation id to be absent on verify (repeatable; accept only)', collectValues)
    .option('--import-node-limit <n>', 'Same limit the suggestion was scanned with', parseImportNodeLimit)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (
      recommendationId: string,
      decision: string,
      options: {
        reason: string;
        killSymbol?: string[];
        killPath?: string[];
        killRelation?: string[];
        importNodeLimit?: number;
        repo: string;
        timeoutMs?: number;
        json?: boolean;
      },
    ) => {
      try {
        if (!REFACTOR_DECISIONS.includes(decision as RefactorDecision)) {
          throw new RefactorProviderError('refactor_invalid_input', `decision must be one of ${REFACTOR_DECISIONS.join('|')}`);
        }
        const { decideRefactorRecommendation } = await import('./refactor-actions');
        const targetRepo = canonicalRepoPath(options.repo);
        const result = decideRefactorRecommendation(
          targetRepo,
          recommendationId,
          decision as RefactorDecision,
          options.reason,
          {
            killSymbols: options.killSymbol,
            killPaths: options.killPath,
            killRelations: options.killRelation,
            importNodeLimit: options.importNodeLimit,
            timeoutMs: options.timeoutMs,
          },
        );
        process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatRefactorDecide(result, resolveDecisionCommitRoot(targetRepo)));
      } catch (error) { fail(error); }
    });
  command.command('verify')
    .description('Re-measure HEAD live against one recorded recommendation decision (read-only)')
    .argument('<recommendation-id>')
    .option('--import-node-limit <n>', 'Override the CodeGraph import read cap', parseImportNodeLimit)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (recommendationId: string, options: { importNodeLimit?: number; repo: string; timeoutMs?: number; json?: boolean }, cmd: Command) => {
      try {
        const { verifyRefactorRecommendation } = await import('./refactor-actions');
        const result = verifyRefactorRecommendation(canonicalRepoPath(options.repo), recommendationId, {
          importNodeLimit: options.importNodeLimit,
          timeoutMs: options.timeoutMs,
        });
        const formatOptions: RefactorVerifyFormatOptions = {
          ...(cmd.getOptionValueSource('repo') === 'cli' ? { repo: options.repo } : {}),
          ...(options.importNodeLimit !== undefined ? { importNodeLimit: options.importNodeLimit } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        };
        process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatRefactorVerify(result, formatOptions));
        if (result.disposition !== 'resolved') process.exitCode = 1;
      } catch (error) { fail(error); }
    });
  command.command('resolve')
    .description('Mark a verified recommendation resolved in .archcontext/refactor-decisions/')
    .argument('<recommendation-id>')
    .requiredOption('--resolution-digest <digest>', 'Attested resolution digest from rh arch refactor verify')
    .requiredOption('--reason <text>', 'Why this recommendation is resolved')
    .option('--import-node-limit <n>', 'Same limit the suggestion was scanned with', parseImportNodeLimit)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (
      recommendationId: string,
      options: { resolutionDigest: string; reason: string; importNodeLimit?: number; repo: string; timeoutMs?: number; json?: boolean },
    ) => {
      try {
        const { resolveRefactorRecommendation } = await import('./refactor-actions');
        const targetRepo = canonicalRepoPath(options.repo);
        const result = resolveRefactorRecommendation(
          targetRepo,
          recommendationId,
          options.resolutionDigest,
          options.reason,
          { importNodeLimit: options.importNodeLimit, timeoutMs: options.timeoutMs },
        );
        process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatRefactorResolve(result, resolveDecisionCommitRoot(targetRepo)));
      } catch (error) { fail(error); }
    });
  command.command('list')
    .description('List Git-tracked refactor decisions and best-effort open findings')
    .option('--status <status>', `Filter by status (${REFACTOR_LIST_STATUSES.join('|')})`)
    .option('--import-node-limit <n>', 'Same limit the suggestion was scanned with', parseImportNodeLimit)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: { status?: string; importNodeLimit?: number; repo: string; timeoutMs?: number; json?: boolean }) => {
      try {
        if (options.status !== undefined && !REFACTOR_LIST_STATUSES.includes(options.status as RecommendationStatus)) {
          throw new RefactorProviderError('refactor_invalid_input', `--status must be one of ${REFACTOR_LIST_STATUSES.join('|')}`);
        }
        const { listRecordedRefactorRecommendations } = await import('./refactor-actions');
        const result = listRecordedRefactorRecommendations(canonicalRepoPath(options.repo), {
          status: options.status as RecommendationStatus | undefined,
          importNodeLimit: options.importNodeLimit,
          timeoutMs: options.timeoutMs,
        });
        process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatRefactorList(result));
      } catch (error) { fail(error); }
    });
  command.command('show')
    .description('Show one Git-tracked refactor decision and best-effort live finding')
    .argument('<recommendation-id>')
    .option('--import-node-limit <n>', 'Same limit the suggestion was scanned with', parseImportNodeLimit)
    .option('--repo <path>', 'Repository root', '.')
    .option('--timeout-ms <ms>', `Per archctx call timeout in ms (default ${REFACTOR_DEFAULT_TIMEOUT_MS}, max ${REFACTOR_MAX_TIMEOUT_MS})`, parseTimeoutMs)
    .option('--json', 'Output machine-readable JSON')
    .action(async (recommendationId: string, options: { importNodeLimit?: number; repo: string; timeoutMs?: number; json?: boolean }) => {
      try {
        const { showRecordedRefactorRecommendation } = await import('./refactor-actions');
        const result = showRecordedRefactorRecommendation(canonicalRepoPath(options.repo), recommendationId, {
          importNodeLimit: options.importNodeLimit,
          timeoutMs: options.timeoutMs,
        });
        process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatRefactorShow(result));
      } catch (error) { fail(error); }
    });
  return command;
}
