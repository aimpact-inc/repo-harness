import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { parseRefactorDecisionFile, REFACTOR_DECISION_DIRECTORY } from 'archctx-contracts';
import { ArchitectureModelReader } from '../architecture/model-reader';
import { readArchitectureHistory } from '../architecture/architecture-read';
import { ArchctxClientError } from '../../core/architecture/projection';
import type { ArchctxProviderOptions } from '../../core/architecture/contracts';
import { readRepoHarnessRegistryStrictSnapshot } from '../repo-registry';
import { ModuleReadError } from '../../core/architecture/module-view';
import { containsSecret } from '../../core/security/secret-patterns';
import { publicValue } from '../../core/operator/architecture-public-value';
import {
  ARCHITECTURE_REFACTOR_STATUS_ORDER,
  architectureRefactorVerifyCommand,
  compareArchitectureRefactorDecisions,
  decodeArchitectureModuleIndex,
  decodeArchitectureModuleDetail,
  decodeArchitectureRefactorDecisions,
  decodeArchitectureReviewPrompt,
  isArchitectureRequest,
  type ArchitectureRefactorCountsV1,
  type ArchitectureRefactorDecisionV1,
  type ArchitectureRefactorDecisionsV1,
  type ArchitectureRequest,
} from '../../core/operator/architecture';

const TRANSIENT_DECISION_FILE = /\.(?:archctx-backup|archctx-tmp-[^/]+|tmp-\d+-\d+)$/u;

function lstatOrNull(target: string): Stats | null {
  try { return lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new ModuleReadError('unavailable');
  }
}

function zeroRefactorCounts(): ArchitectureRefactorCountsV1 {
  return { accepted: 0, acknowledged: 0, deferred: 0, resolved: 0, rejected: 0, waived: 0 };
}

export function readRefactorDecisions(repoPath: string): ArchitectureRefactorDecisionsV1 {
  const rootStat = lstatOrNull(repoPath);
  if (!rootStat) throw new ModuleReadError('git_read_failed');
  if (rootStat.isSymbolicLink()) throw new ModuleReadError('path_escape');
  if (!rootStat.isDirectory()) throw new ModuleReadError('path_invalid');
  const root = realpathSync(repoPath);
  const archDir = join(root, '.archcontext');
  const archStat = lstatOrNull(archDir);
  if (!archStat) return { schema_version: 'repo-harness.architecture-refactor.v1', adopted: false, counts: zeroRefactorCounts(), decisions: [] };
  if (archStat.isSymbolicLink()) throw new ModuleReadError('path_escape', '.archcontext');
  if (!archStat.isDirectory()) throw new ModuleReadError('model_invalid', '.archcontext');
  const manifestStat = lstatOrNull(join(archDir, 'manifest.yaml'));
  if (!manifestStat) return { schema_version: 'repo-harness.architecture-refactor.v1', adopted: false, counts: zeroRefactorCounts(), decisions: [] };
  if (manifestStat.isSymbolicLink()) throw new ModuleReadError('path_escape', '.archcontext/manifest.yaml');
  if (!manifestStat.isFile()) throw new ModuleReadError('model_invalid', '.archcontext/manifest.yaml');

  const decisionsDir = join(root, REFACTOR_DECISION_DIRECTORY);
  const dirStat = lstatOrNull(decisionsDir);
  if (!dirStat) return { schema_version: 'repo-harness.architecture-refactor.v1', adopted: true, counts: zeroRefactorCounts(), decisions: [] };
  if (dirStat.isSymbolicLink()) throw new ModuleReadError('path_escape', REFACTOR_DECISION_DIRECTORY);
  if (!dirStat.isDirectory()) throw new ModuleReadError('model_invalid', REFACTOR_DECISION_DIRECTORY);

  const items: ArchitectureRefactorDecisionV1[] = [];
  for (const name of readdirSync(decisionsDir).sort()) {
    const entryPath = join(decisionsDir, name);
    const relPath = `${REFACTOR_DECISION_DIRECTORY}/${name}`;
    const entryStat = lstatOrNull(entryPath);
    if (!entryStat) continue;
    if (entryStat.isSymbolicLink()) throw new ModuleReadError('path_escape', relPath);
    if (!entryStat.isFile()) throw new ModuleReadError('model_invalid', relPath);
    if (TRANSIENT_DECISION_FILE.test(name)) continue;
    let parsed;
    try { parsed = parseRefactorDecisionFile(relPath, readFileSync(entryPath, 'utf8')); }
    catch { throw new ModuleReadError('model_invalid', relPath); }
    items.push({
      recommendation_id: parsed.recommendationId,
      category: parsed.category,
      kind: parsed.kind,
      subject: parsed.subject.stableKey,
      affected_node_ids: parsed.affectedNodeIds,
      status: parsed.status,
      metrics: parsed.observationMetrics,
      reason: parsed.reason,
      decided_at: parsed.decidedAt,
      head_sha: parsed.provenance.headSha,
      cli_verify_command: architectureRefactorVerifyCommand(parsed.recommendationId),
    });
  }
  items.sort(compareArchitectureRefactorDecisions);
  const counts = Object.fromEntries(
    ARCHITECTURE_REFACTOR_STATUS_ORDER.map(status => [status, items.filter(item => item.status === status).length]),
  ) as unknown as ArchitectureRefactorCountsV1;
  const redacted = publicValue(publicValue({
    schema_version: 'repo-harness.architecture-refactor.v1' as const,
    adopted: true,
    counts,
    decisions: items,
  }, root), repoPath);
  return decodeArchitectureRefactorDecisions(redacted);
}

export function readArchitecture(input: ArchitectureRequest, env?: NodeJS.ProcessEnv): unknown {
  if (!isArchitectureRequest(input)) throw new ModuleReadError('invalid_request');
  let registry;
  try { registry = readRepoHarnessRegistryStrictSnapshot({ env }); }
  catch { throw new ModuleReadError('unavailable'); }
  const repo = registry.repos.find(repo => repo.id === input.repository_id);
  if (!repo) throw new ModuleReadError('repository_not_found');
  if (input.kind === 'architecture_refactor') return readRefactorDecisions(repo.path);
  if (input.kind === 'architecture_history') return publicValue(readHistory(repo.path, input, { env: env ?? process.env }), repo.path);
  const reader = new ArchitectureModelReader(repo.path);
  if (input.kind === 'architecture_modules') return decodeArchitectureModuleIndex(publicValue(reader.list(), reader.root));
  if (input.kind === 'architecture_module') return decodeArchitectureModuleDetail(publicValue(reader.detail(input.capability_id), reader.root));
  // Resolve only validated full SHAs. Missing commits have a distinct public failure.
  if (input.base !== undefined && input.head !== undefined) {
    try { reader.resolveCommit(input.base); reader.resolveCommit(input.head); }
    catch { throw new ModuleReadError('commit_not_found'); }
  }
  // GET routes run no probe: no projection check and no docs anchors, so generated_summary stays unknown.
  // Diff mode still needs `archctx resolve`, because ArchContext owns path ownership.
  const packet = reader.reviewPrompt(input.capability_id, { shard: input.shard, base: input.base, head: input.head, archctx: { env: env ?? process.env } });
  const home = env?.HOME ?? process.env.HOME;
  if (containsSecret(packet.prompt) || packet.prompt.includes(reader.root) || (home && home.length > 1 && packet.prompt.includes(home))) throw new ModuleReadError('secret_detected');
  return decodeArchitectureReviewPrompt(packet);
}

/** The public code for an archctx history failure. archctx decides each failure; this only names it. */
export function readHistory(root: string, input: Extract<ArchitectureRequest, { kind: 'architecture_history' }>, options: ArchctxProviderOptions): unknown {
  try { return readArchitectureHistory(root, input, options); }
  catch (error) {
    if (!(error instanceof ArchctxClientError)) throw error;
    if (error.reasonCode === 'history-shallow-repository') throw new ModuleReadError('history_shallow_repository');
    if (error.reasonCode === 'native-context-ref-unavailable') throw new ModuleReadError('commit_not_found');
    if (error.code === 'RH_ARCHCTX_TIMEOUT') throw new ModuleReadError('timeout');
    throw error;
  }
}
