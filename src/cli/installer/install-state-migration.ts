import { existsSync, readFileSync, rmSync } from 'node:fs';
import { isRecord } from '../../core/evidence/is-record';
import type { PathRecord } from '../../core/host-config/types';
import { hostConfigPaths, migrateLedgerSchema, projectedLedgerPaths, repositoryLedgers } from '../../effects/host-config/store';
import { partitionPathRecords, pathRecordHost, pathRecordIsCurrent, pathRecordKey, writePathRecords, type PathRecords } from '../../effects/host-config/path-records';
import { adoptedIdentity } from '../../effects/host-config/whole-path';
import { migrateCodexConfigRecords } from './codex-config-migration';
import { agentFleetTargetPaths, fleetReceiptPath, isLegacyOwnershipSurface, validPiPackage, writeState, type InstallState } from './install-profile';
import { enabledPlugins, installProfileStatePath, InstallStateError, invalidOwnership, parseProtocol3InstallState, parseProtocol4InstallState, readRawInstallState, type Protocol3Snapshot, type RecordedInstallSnapshot } from './install-state';
import { adoptPiPackage, piPackageEntryPresent } from './pi-package';
import { migrateJsonConfigRecords } from './json-config-migration';

/**
 * The one-shot move of ownership to the host-config ledger, as one chained
 * step to protocol 5: the protocol 3 `ownership_manifest` and
 * `agent-fleet-user-managed.json` become path records, and the Pi package
 * claims of protocol 3 or 4 become `pi` fragment records of the Pi settings
 * entry (#2852). It runs at the lock-holding entry points before any other
 * state read; every other reader fails closed on protocols 3 and 4.
 */

/** True when the state still is protocol 3 or 4, so the next entry point migrates it. */
export function installStatePendingMigration(env: NodeJS.ProcessEnv): boolean {
  const raw = readRawInstallState(env);
  const path = installProfileStatePath(env);
  return parseProtocol3InstallState(raw, path) !== null || parseProtocol4InstallState(raw, path) !== null;
}

/** The fleet files that the user keeps, by path; null without a receipt. A malformed receipt stops: rh must not overwrite those files. */
function readFleetReceipt(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> | null {
  const path = fleetReceiptPath(env);
  if (!existsSync(path)) return null;
  const allowed = new Set(agentFleetTargetPaths(env));
  const malformed = () => new InstallStateError('install_state_invalid', path, `the agent fleet receipt is malformed; fix or remove it, then run rh update: ${path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf-8')); } catch { throw malformed(); }
  if (!isRecord(parsed) || parsed.protocol !== 1 || parsed.authority !== 'user-managed-agent-fleet' || !Array.isArray(parsed.files)) throw malformed();
  const hashes = new Map<string, string>();
  for (const entry of parsed.files) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !allowed.has(entry.path) || typeof entry.sha256 !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256) || hashes.has(entry.path)) throw malformed();
    hashes.set(entry.path, entry.sha256);
  }
  return hashes;
}

/** One manifest surface as a path record, or as a Pi package source; null for a section record or a marker that never proved currency. */
function convertSurface(env: NodeJS.ProcessEnv, surface: Record<string, unknown>, statePath: string):
  { readonly key: string; readonly record: PathRecord } | { readonly pi: string } | null {
  const path = surface.path as string;
  if (surface.type === 'pi-package') return { pi: path };
  const marker = surface.managed_marker;
  let committed: PathRecord['committed'];
  if (surface.type === 'symlink') committed = { type: 'symlink', target: surface.symlink_target as string };
  else if (surface.type === 'managed-file') {
    // The #2847 and #2848 migrations own the section records of the host files; no other marker made a file current.
    if (marker !== 'transaction-created-file') return null;
    committed = { type: 'file', sha256: surface.content_hash as string };
  } else if (marker === 'herdr-skill-marker') committed = { type: 'directory', proof: 'herdr-skill-marker' };
  else committed = { type: 'directory', sha256: surface.content_hash as string };
  const host = pathRecordHost(env, path);
  if (host === null) throw invalidOwnership(statePath);
  const key = pathRecordKey(env, path);
  const record: PathRecord = { owner: surface.owner as string, host, kind: 'created', baseline: { state: 'unknown' }, committed };
  // The one-shot adoption of the protocol 5 ledger move (JD 7001045792); a Herdr skill keeps its marker proof.
  const identity = 'proof' in committed ? null : adoptedIdentity(key, record);
  return { key, record: identity === null ? record : { ...record, identity } };
}

function checkedManifest(env: NodeJS.ProcessEnv, snapshot: Protocol3Snapshot, statePath: string): Record<string, unknown>[] {
  const plugins = enabledPlugins(snapshot.fields);
  if (!snapshot.manifest.every((surface) => isLegacyOwnershipSurface(surface, env, plugins))) throw invalidOwnership(statePath);
  return snapshot.manifest as Record<string, unknown>[];
}

/** A Pi claim of an older state must name the Bun global package root with the pi plugin of the same snapshot enabled; any other claim stops the move. */
function checkedPiSources(env: NodeJS.ProcessEnv, snapshot: RecordedInstallSnapshot, sources: readonly string[], statePath: string): readonly string[] {
  if (sources.some((source) => !validPiPackage(source, env, enabledPlugins(snapshot)))) throw invalidOwnership(statePath);
  return sources;
}

/**
 * Run the move once. While the state is protocol 3 its manifest is the only
 * authority for `created` records, so they are replaced, not merged: a released
 * parent's rollback restores the state but not the ledger, and the next run
 * then rebuilds the records from the restored manifest. `user_managed` records
 * stay. Order: ledger, receipt removal, protocol 4 state; a stop between them
 * leaves a state that the next run migrates again.
 */
export function migrateInstallState(env: NodeJS.ProcessEnv): void {
  // The ledger gains its `paths` map before any gate or path-record write reads it; each repository ledger moves with it.
  migrateLedgerSchema(hostConfigPaths(env));
  for (const ledger of repositoryLedgers(env)) migrateLedgerSchema(ledger);
  if (parseProtocol3InstallState(readRawInstallState(env), installProfileStatePath(env)) !== null) {
    // The section records of the host files leave with the manifest, so their migrations read it first.
    migrateCodexConfigRecords(env);
    migrateJsonConfigRecords(env);
  }
  const plan = planInstallStateMigration(env);
  if (plan === null) return;
  writePathRecords(env, plan.records);
  for (const source of plan.piPackages) adoptPiPackage(source, env);
  if (plan.receipt) rmSync(fleetReceiptPath(env), { force: true });
  if (plan.state) writeState(plan.state, env);
}

/** What the move writes: the path records, the Pi package entries to record, whether the receipt goes, and the protocol 5 state; null when nothing moves. It writes nothing, so a dry run uses it too. */
export interface InstallStateMigrationPlan {
  readonly records: PathRecords;
  /** The claimed Pi package sources whose entry is in the Pi settings now: only these get a record. */
  readonly piPackages: readonly string[];
  readonly receipt: boolean;
  readonly state: InstallState | null;
}

export function planInstallStateMigration(env: NodeJS.ProcessEnv): InstallStateMigrationPlan | null {
  const statePath = installProfileStatePath(env);
  const raw = readRawInstallState(env);
  const legacy = parseProtocol3InstallState(raw, statePath);
  const protocol4 = parseProtocol4InstallState(raw, statePath);
  const receipt = readFleetReceipt(env);
  if (legacy === null && protocol4 === null && receipt === null) return null;
  const records: Record<string, PathRecord> = Object.fromEntries(Object.entries(partitionPathRecords(env, projectedLedgerPaths(hostConfigPaths(env))).records)
    .filter(([, record]) => legacy === null || record.kind === 'user_managed'));
  const pi: string[] = [];
  if (legacy) {
    for (const surface of checkedManifest(env, legacy.current, statePath)) {
      const converted = convertSurface(env, surface, statePath);
      if (converted === null) continue;
      if ('pi' in converted) { pi.push(converted.pi); continue; }
      const existing = records[converted.key];
      if (existing && (existing.kind === 'user_managed' || pathRecordIsCurrent(converted.key, existing))) continue;
      records[converted.key] = converted.record;
    }
  }
  for (const [path, sha256] of receipt ?? []) {
    const host = pathRecordHost(env, path);
    if (host === null) throw invalidOwnership(statePath);
    records[pathRecordKey(env, path)] = { owner: 'core', host, kind: 'user_managed', baseline: { state: 'unknown' }, committed: { type: 'file', sha256 } };
  }
  // Only the current snapshot claims an active entry: a previous snapshot is the state before a switch, and Pi may have been switched off since.
  // The previous snapshot is still checked, so an invalid one stops the move.
  if (legacy?.previous) checkedManifest(env, legacy.previous, statePath);
  if (protocol4?.previous) checkedPiSources(env, protocol4.previous.fields, protocol4.previous.pi_packages, statePath);
  if (protocol4) pi.push(...checkedPiSources(env, protocol4.current.fields, protocol4.current.pi_packages, statePath));
  const older = legacy ?? protocol4;
  return {
    records,
    piPackages: [...new Set(pi)].filter((source) => piPackageEntryPresent(source, env)),
    receipt: receipt !== null,
    state: older && { ...older.current.fields, previous: older.previous?.fields ?? null },
  };
}
