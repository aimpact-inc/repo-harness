import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchctxProviderOptions } from '../../core/architecture/contracts';
import {
  normalizeRefactorScope,
  RefactorProviderError,
  type RefactorScanFindingV2,
  type RefactorScanV2,
  type RefactorScopeV1,
} from '../../core/refactor/provider-contract';
import { runRefactorScan } from './archctx-provider';

export const REFACTOR_RECOMMENDATIONS_SCHEMA_VERSION = 'repo-harness.refactor-recommendations/v3' as const;

export type RefactorScanCoverage = RefactorScanV2['coverage'];
export type RefactorSuppressedFinding = RefactorScanV2['suppressed'][number];

export interface RefactorRecommendationResult {
  schemaVersion: typeof REFACTOR_RECOMMENDATIONS_SCHEMA_VERSION;
  status: 'recommended' | 'no_action' | 'proof_required' | 'unavailable';
  findings: readonly RefactorScanFindingV2[];
  suppressed: readonly RefactorSuppressedFinding[];
  headSha?: string;
  snapshotDigest?: string;
  scope?: RefactorScopeV1;
  importNodeLimit?: number;
  coverage?: RefactorScanCoverage;
  message?: string;
  /** Provider error code, reasonCode, and the remedy archctx names for it, kept when status is `unavailable`. */
  code?: string;
  reasonCode?: string;
  action?: string;
}

export interface RefactorRecommendationOptions {
  env?: NodeJS.ProcessEnv;
  /** Raises the CodeGraph import read cap. Pass the same value to `rh arch refactor decide` and `verify`. */
  importNodeLimit?: number;
  /** Per archctx call limit in ms; the default is 120000. */
  timeoutMs?: number;
  /** Limits scan observations to a declared node or repository-relative paths. */
  scope?: RefactorScopeV1;
  discover?: (
    repoRoot: string,
    provider: ArchctxProviderOptions,
    importNodeLimit?: number,
    timeoutMs?: number,
    scope?: RefactorScopeV1,
  ) => RefactorScanV2;
}

function emptyResult(status: RefactorRecommendationResult['status'], message?: string): RefactorRecommendationResult {
  return {
    schemaVersion: REFACTOR_RECOMMENDATIONS_SCHEMA_VERSION,
    status,
    findings: [],
    suppressed: [],
    ...(message ? { message } : {}),
  };
}

/**
 * Evidence only: it never decides, schedules or executes anything.
 * The Bot reads this result and decides whether to schedule work or ask the user.
 */
export function observeRefactorRecommendations(
  repoRoot: string,
  options: RefactorRecommendationOptions = {},
): RefactorRecommendationResult {
  try {
    return discoverRefactorRecommendations(repoRoot, options);
  } catch (error) {
    if (error instanceof RefactorProviderError) {
      return {
        ...emptyResult('unavailable', error.message),
        code: error.code,
        ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}),
        ...(error.action ? { action: error.action } : {}),
      };
    }
    return emptyResult('unavailable', error instanceof Error ? error.message : String(error));
  }
}

function discoverRefactorRecommendations(
  repoRoot: string,
  options: RefactorRecommendationOptions,
): RefactorRecommendationResult {
  const scope = options.scope === undefined
    ? undefined
    : options.scope.kind === 'node'
      ? normalizeRefactorScope({ node: options.scope.nodeId })
      : options.scope.kind === 'paths'
        ? normalizeRefactorScope({ paths: options.scope.paths })
        : { kind: 'repository' as const };
  const root = realpathSync(repoRoot);
  if (!existsSync(join(root, '.archcontext/manifest.yaml'))) {
    return emptyResult('unavailable', 'repository architecture model is not initialized');
  }
  const provider = { env: options.env };
  const scan = options.discover
    ? options.discover(root, provider, options.importNodeLimit, options.timeoutMs, scope)
    : runRefactorScan(root, provider, options.importNodeLimit, options.timeoutMs, scope);
  const common = {
    headSha: scan.headSha,
    snapshotDigest: scan.snapshotDigest,
    scope: scan.scope,
    ...(scan.importNodeLimit !== undefined ? { importNodeLimit: scan.importNodeLimit } : {}),
    coverage: scan.coverage,
    suppressed: scan.suppressed,
  };
  if (scan.coverage.reasonCodes.includes('code-facts-import-limit')) {
    return {
      schemaVersion: REFACTOR_RECOMMENDATIONS_SCHEMA_VERSION,
      status: 'proof_required',
      ...common,
      findings: [],
      message: importLimitRemedy(scan.importNodeLimit),
    };
  }
  if (scan.coverage.imports !== 'complete') {
    return {
      schemaVersion: REFACTOR_RECOMMENDATIONS_SCHEMA_VERSION,
      status: 'proof_required',
      ...common,
      findings: [],
      message: incompleteCoverageRemedy(scan.coverage),
    };
  }
  return {
    schemaVersion: REFACTOR_RECOMMENDATIONS_SCHEMA_VERSION,
    status: scan.findings.length > 0 ? 'recommended' : 'no_action',
    ...common,
    findings: scan.findings,
  };
}

/** A new CodeGraph index cannot fix this: only a larger read limit can. Pass the same limit to decide and verify. */
function importLimitRemedy(importNodeLimit: number | undefined): string {
  const limit = importNodeLimit === undefined ? 'the default limit' : `limit ${importNodeLimit}`;
  return `the CodeGraph index exceeded the scan import node cap (${limit}); run \`rh arch refactor recommendations --import-node-limit <n>\` with a larger limit, and pass the same limit to \`rh arch refactor decide\` and \`rh arch refactor verify\``;
}

function incompleteCoverageRemedy(coverage: RefactorScanCoverage): string {
  const reasons = coverage.reasonCodes.length > 0 ? ` (${coverage.reasonCodes.join(', ')})` : '';
  return `code facts import coverage is ${coverage.imports}${reasons}; run \`codegraph init\` and scan again`;
}
