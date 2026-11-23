/**
 * The candidate side of an update handoff: the installed candidate package
 * runs the setup inside the parent's transaction and returns its receipt.
 */
import { globalRuntimeScope, parentRuntimeTransactionContext } from '../effects/locking/runtime-transaction-lock';
import { realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { assertOverridesCarried } from './commands/install';
import { migrateRuntimeHostConfig } from './installer/install-profile';
import { migrateInstallState } from './installer/install-state-migration';
import { pathRecordsDigest, readPathRecords } from '../effects/host-config/path-records';
import { GLOBAL_RULES_REFRESH_STEP, RETIRED_AGENT_FLEET_STEP, RETIRED_CLI_LINK_STEP, RETIRED_CLI_REFERENCES_STEP, HERDR_CORE_STEP, runGlobalRuntimeSetup, type GlobalRuntimeResult } from './commands/global-runtime';
import { assertCandidateReconciliationReceipt, assertInstalledAdapterProjection, CANDIDATE_RECONCILIATION_PROTOCOL, STAGED_SKILLS_HANDOFF_ENV, candidatePackageIdentity, consumeCandidateReconciliationCapability, parseCandidateRequest, routeRegistryDigest, type CandidateReconciliationReceipt } from './commands/candidate-reconciliation';
import { applyInstallSelection, commandPluginRepairLines, rollbackRuntimeHostConfig, migrateInParentTransaction, requireInstallState, resolveRecordedSelection } from './installer/install-profile';
import { mcpLocalConfigCheck, refusedPaths, registerArchitecturePlugin, selectionLines } from './runtime-transaction';

function candidateSourceRoot(): string {
  return realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
}

/**
 * Internal candidate entrypoint. It intentionally never acquires the global
 * runtime lock: the predecessor process owns that lock and its transaction.
 */
export function runCandidateRuntimeReconciliation(
  encodedRequest: string,
  handoffEnv: NodeJS.ProcessEnv = process.env,
): CandidateReconciliationReceipt {
  const sourceRoot = candidateSourceRoot();
  const candidate = candidatePackageIdentity(sourceRoot);
  const request = parseCandidateRequest(encodedRequest, candidate.version);
  if (
    handoffEnv.REPO_HARNESS_RUNTIME_RECONCILIATION_PARENT !== '1'
    || handoffEnv.REPO_HARNESS_RUNTIME_RECONCILIATION_TOKEN !== request.parent_token
  ) {
    throw new Error('candidate reconciliation requires an explicit parent transaction capability');
  }
  const scope = globalRuntimeScope(handoffEnv);
  const capability = consumeCandidateReconciliationCapability(request, scope);
  const runtimeLock = parentRuntimeTransactionContext(scope, { pid: capability.parent_pid, lockPath: capability.lock_path, ownerToken: capability.lock_owner_token });
  if (
    candidate.root !== request.candidate.root
    || candidate.version !== request.candidate.version
    || candidate.package_digest !== request.candidate.package_digest
  ) {
    throw new Error('candidate reconciliation package authority mismatch');
  }
  const { [STAGED_SKILLS_HANDOFF_ENV]: stagedSkillsTransaction, ...env } = handoffEnv;
  // Subprocesses can inherit process.env in addition to the supplied environment.
  delete process.env[STAGED_SKILLS_HANDOFF_ENV];
  const externalSkills = request.external_skills === false && stagedSkillsTransaction === request.transaction_id
    ? undefined
    : request.external_skills;
  // This package version owns the resolution: it knows the plugins that it ships.
  // The parent reads and writes no install state after this handoff: this commit owns
  // the whole state, including the Pi package and Pi skill-root receipts.
  const complete = request.sync_skill && request.host_adapters;
  // This version's own requests must carry the selection before any write.
  assertOverridesCarried(request.host_adapters ? request.target : null, request.overrides ?? [], env);
  // A released parent holds the lock; its transaction keeps the state, and the ledger keeps the records.
  migrateInParentTransaction(request.transaction_backup_root, env, () => {
    migrateInstallState(env, request.transaction_backup_root);
    if (request.host_adapters) migrateRuntimeHostConfig(env);
  });
  const state = requireInstallState(env);
  const resolved = resolveRecordedSelection(state, request.target, env, { partial: !complete });
  const plugins = resolved.run;
  if (plugins.includes('architecture')) registerArchitecturePlugin();
  // Stdout is the receipt; the parent shows this stderr in its reconcile step.
  for (const line of [...selectionLines(resolved), ...commandPluginRepairLines(state.selection)]) console.error(line);
  let runtime: GlobalRuntimeResult | undefined;
  try {
    runtime = runGlobalRuntimeSetup({
      transaction: request.transaction_backup_root,
      runtimeLock,
      sourceRoot,
      cwd: request.cwd,
      env,
      target: request.target,
      plugins,
      installCli: false,
      installSpec: `repo-harness@${candidate.version}`,
      syncSkill: request.sync_skill,
      hostAdapters: request.host_adapters,
      externalSkills,
      obsidianSkills: request.obsidian_skills,
      codegraph: request.codegraph,
      reportLanguage: request.report_language,
      overrides: request.overrides,
      updateMode: true,
      mcpLocalConfigCheck,
    });
    if (runtime.exitCode !== 0) {
      throw new Error(`candidate reconciliation failed: ${runtime.lines.join('; ')}`);
    }
    // Stdout is the receipt. Keep maintenance advice visible without
    // changing the receipt parsed by an already released parent.
    const daemon = runtime.steps.find(step => step.step === 'check shared ArchContext daemon');
    if (daemon?.status === 'skipped') console.error(daemon.detail);
    // The parent shows candidate stderr in its reconcile step. Files that update
    // did not sync must stay visible with their next action.
    const globalRules = runtime.steps.find(step => step.step === GLOBAL_RULES_REFRESH_STEP);
    if (globalRules) console.error(`[runtime] ${globalRules.status}: ${globalRules.step} - ${globalRules.detail}`);
    // Keep path and recovery notices visible through the parent handoff.
    for (const name of ['back up global configuration', HERDR_CORE_STEP, RETIRED_AGENT_FLEET_STEP, RETIRED_CLI_LINK_STEP, RETIRED_CLI_REFERENCES_STEP]) {
      const shown = runtime.steps.find(step => step.step === name);
      if (shown) console.error(`[runtime] ${shown.status}: ${shown.step} - ${shown.detail}`);
    }

    const adapterDigests = request.host_adapters
      ? assertInstalledAdapterProjection(request.target, env)
      : {};
    let ownershipManifestDigest: string | null = null;
    if (complete) {
      applyInstallSelection(state.selection, resolved.record, env, new Date(), { backup_root: request.transaction_backup_root }, {
        kept: resolved.kept.map(entry => entry.id), refused: refusedPaths(runtime),
      });
      // Released parents parse this receipt field by name in a handoff and its rollback; its value is now the path-record digest.
      ownershipManifestDigest = pathRecordsDigest(readPathRecords(env));
    }
    const receipt: CandidateReconciliationReceipt = {
      protocol: CANDIDATE_RECONCILIATION_PROTOCOL,
      transaction_id: request.transaction_id,
      candidate_package_root: candidate.root,
      candidate_version: candidate.version,
      candidate_package_digest: candidate.package_digest,
      route_registry_digest: routeRegistryDigest(),
      selected_target: request.target,
      adapter_projection_digests: adapterDigests,
      ownership_manifest_digest: ownershipManifestDigest,
      reconciliation_scope: complete ? 'complete' : 'partial',
      verified_at: new Date().toISOString(),
      ...(request.overrides?.length ? { overrides: request.overrides } : {}),
    };
    assertCandidateReconciliationReceipt(receipt, {
      transaction_id: request.transaction_id,
      candidate,
      target: request.target,
      require_complete: complete,
      require_adapter_projection: request.host_adapters,
    }, env);
    return receipt;
  } catch (error) {
    // The ledger rollback also takes out a Pi package entry and the staged skills that this run recorded.
    try { rollbackRuntimeHostConfig(request.transaction_backup_root, env); }
    catch (rollbackError) {
      const errors = [error, rollbackError];
      throw new AggregateError(errors, `candidate reconciliation failed: ${errors.map(item => item instanceof Error ? item.message : String(item)).join('; ')}`);
    }
    throw error;
  }
}
