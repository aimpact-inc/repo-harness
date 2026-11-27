import { CLI_NAME } from '../../core/skill-surface/cli-name';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { existsSync, readFileSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, resolve } from 'path';

import type { InstallTargetSpec } from './install';
import { REPORT_LANGUAGE_FLAG_VALUES, type ReportLanguageFlag } from '../installer/global-context';
import type { OverrideSelection } from '../../core/host-config/override';
import {
  buildManagedHooks,
  canonicalManagedHookProjection,
  type HookHost,
  type HooksByEvent,
} from '../installer/managed-entries';
import { ROUTES } from '../hook/route-registry';
import type { RuntimeTransactionScope } from '../../effects/locking/runtime-transaction-lock';
import { readCandidatePackageIdentity } from './candidate-package-identity';
import {
  claimCandidateCapabilityFile,
  writeCandidateCapabilityFile,
} from './candidate-reconciliation-capability';

/** Protocol 2 drops the request profile: the candidate reads the recorded plugin selection from the install state. */
export const CANDIDATE_RECONCILIATION_PROTOCOL = 3;
export const STAGED_SKILLS_HANDOFF_ENV = 'REPO_HARNESS_RUNTIME_RECONCILIATION_STAGED_SKILLS';
export const CANDIDATE_RECONCILIATION_CAPABILITY_PROTOCOL = 1;

export interface CandidateReconciliationCapability {
  readonly protocol: typeof CANDIDATE_RECONCILIATION_CAPABILITY_PROTOCOL;
  readonly transaction_id: string;
  readonly parent_token: string;
  readonly parent_pid: number;
  readonly lock_path: string;
  readonly lock_owner_token: string;
  readonly created_at: string;
}

export interface CandidateReconciliationCapabilityInput {
  readonly transactionId: string;
  readonly transactionBackupRoot: string;
  readonly parentToken: string;
  readonly parentPid: number;
  readonly lockPath: string;
  readonly lockOwnerToken: string;
}

export interface CandidatePackageIdentity {
  readonly root: string;
  readonly version: string;
  readonly package_digest: string;
}

export interface CandidateReconciliationReceipt {
  readonly protocol: typeof CANDIDATE_RECONCILIATION_PROTOCOL;
  readonly transaction_id: string;
  readonly candidate_package_root: string;
  readonly candidate_version: string;
  readonly candidate_package_digest: string;
  readonly route_registry_digest: string;
  readonly selected_target: InstallTargetSpec;
  readonly adapter_projection_digests: Readonly<Partial<Record<HookHost, string>>>;
  readonly ownership_manifest_digest: string | null;
  readonly reconciliation_scope: 'complete' | 'partial';
  readonly verified_at: string;
  /** The `--override` selection that the candidate applied; absent when the request had none. A released candidate never writes it. */
  readonly overrides?: OverrideSelection;
}

export interface CandidateReconciliationRequest {
  readonly protocol: typeof CANDIDATE_RECONCILIATION_PROTOCOL;
  readonly transaction_id: string;
  readonly transaction_backup_root: string;
  readonly parent_token: string;
  readonly candidate: CandidatePackageIdentity;
  readonly cwd: string;
  readonly target: InstallTargetSpec;
  readonly sync_skill: boolean;
  readonly host_adapters: boolean;
  readonly external_skills: boolean;
  readonly obsidian_skills: boolean;
  readonly codegraph: boolean;
  readonly report_language?: ReportLanguageFlag;
  /** The user's `--override` selection, paths resolved by the parent; the candidate checks it against its own requests. */
  readonly overrides?: OverrideSelection;
}

export interface CandidateReceiptExpectation {
  readonly transaction_id: string;
  readonly candidate: CandidatePackageIdentity;
  readonly target: InstallTargetSpec;
  readonly require_complete: boolean;
  readonly require_adapter_projection?: boolean;
}

/**
 * Publish the one-shot capability only while the predecessor owns the global
 * runtime lock. A hard-link publication avoids replacing a concurrently
 * created capability file.
 */
export function publishCandidateReconciliationCapability(
  input: CandidateReconciliationCapabilityInput,
): CandidateReconciliationCapability {
  const record: CandidateReconciliationCapability = {
    protocol: CANDIDATE_RECONCILIATION_CAPABILITY_PROTOCOL,
    transaction_id: input.transactionId,
    parent_token: input.parentToken,
    parent_pid: input.parentPid,
    lock_path: input.lockPath,
    lock_owner_token: input.lockOwnerToken,
    created_at: new Date().toISOString(),
  };
  return writeCandidateCapabilityFile(input.transactionBackupRoot, record);
}

/**
 * Consume a parent-published capability before candidate code mutates any
 * managed surface. The parent PID, one-shot token, and live global lock must
 * all agree; argv/env values alone are never authority.
 */
export function consumeCandidateReconciliationCapability(
  request: CandidateReconciliationRequest,
  scope: RuntimeTransactionScope,
): CandidateReconciliationCapability {
  if (request.transaction_id !== sha256Prefixed(request.transaction_backup_root)) {
    throw new Error('candidate reconciliation transaction identifier is not bound to its backup root');
  }
  if (scope.kind !== 'global') throw new Error('candidate reconciliation requires the global runtime scope');
  return claimCandidateCapabilityFile(
    {
      transactionId: request.transaction_id,
      transactionBackupRoot: request.transaction_backup_root,
      parentToken: request.parent_token,
      expectedProtocol: CANDIDATE_RECONCILIATION_CAPABILITY_PROTOCOL,
    },
    scope,
  );
}

export function candidatePackageIdentity(packageRoot: string): CandidatePackageIdentity {
  const resolved = resolve(packageRoot);
  if (!existsSync(join(resolved, 'package.json'))) {
    throw new Error(`candidate package is missing package.json: ${resolved}`);
  }
  return readCandidatePackageIdentity(realpathSync(resolved));
}

export function routeRegistryDigest(): string {
  return sha256Prefixed(JSON.stringify(ROUTES));
}

export function managedProjectionDigest(hooks: HooksByEvent | unknown): string {
  return sha256Prefixed(JSON.stringify(canonicalManagedHookProjection(hooks)));
}

export function hostsForTarget(target: InstallTargetSpec): readonly HookHost[] {
  return target === 'both' ? ['claude', 'codex'] : [target];
}

export function expectedAdapterProjectionDigests(
  target: InstallTargetSpec,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<HookHost, string>> {
  return Object.fromEntries(hostsForTarget(target).map((host) => [
    host,
    managedProjectionDigest(buildManagedHooks(host, env)),
  ])) as Record<HookHost, string>;
}

export function adapterPath(host: HookHost, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME ?? homedir();
  return host === 'codex' ? join(home, '.codex', 'hooks.json') : join(home, '.claude', 'settings.json');
}

export function installedAdapterProjectionDigest(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: HooksByEvent };
    return managedProjectionDigest(parsed.hooks ?? {});
  } catch {
    return null;
  }
}

export function assertInstalledAdapterProjection(
  target: InstallTargetSpec,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<Record<HookHost, string>> {
  const expected = expectedAdapterProjectionDigests(target, env);
  for (const host of hostsForTarget(target)) {
    const actual = installedAdapterProjectionDigest(adapterPath(host, env));
    if (actual !== expected[host]) {
      throw new Error(`adapter projection mismatch for ${host}: expected=${expected[host]}; actual=${actual ?? 'missing'}`);
    }
  }
  return expected;
}

/**
 * Candidate-side proof. This intentionally calculates expected projection from
 * the currently executing package, never the predecessor that launched it.
 */
export function assertCandidateReconciliationReceipt(
  receipt: CandidateReconciliationReceipt,
  expected: CandidateReceiptExpectation,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (receipt.protocol !== CANDIDATE_RECONCILIATION_PROTOCOL) {
    throw new Error(`candidate reconciliation protocol mismatch: expected=${CANDIDATE_RECONCILIATION_PROTOCOL}; actual=${String(receipt.protocol)}`);
  }
  if (receipt.transaction_id !== expected.transaction_id) {
    throw new Error('candidate reconciliation transaction mismatch');
  }
  if (
    receipt.candidate_package_root !== expected.candidate.root
    || receipt.candidate_version !== expected.candidate.version
    || receipt.candidate_package_digest !== expected.candidate.package_digest
  ) {
    throw new Error('candidate reconciliation package identity mismatch');
  }
  if (receipt.route_registry_digest !== routeRegistryDigest()) {
    throw new Error('candidate reconciliation route registry mismatch');
  }
  if (receipt.selected_target !== expected.target) {
    throw new Error('candidate reconciliation target mismatch');
  }
  if (expected.require_complete && receipt.reconciliation_scope !== 'complete') {
    throw new Error('candidate reconciliation is partial');
  }
  if (expected.require_adapter_projection !== false) {
    const expectedDigests = expectedAdapterProjectionDigests(expected.target, env);
    for (const host of hostsForTarget(expected.target)) {
      if (receipt.adapter_projection_digests[host] !== expectedDigests[host]) {
        throw new Error(`adapter projection mismatch for ${host}`);
      }
    }
  }
  if (expected.require_complete && receipt.ownership_manifest_digest === null) {
    throw new Error('candidate reconciliation ownership ledger is missing');
  }
}

/**
 * The parent's check that the candidate applied the selection it sent. A
 * released candidate ignores an unknown request field, so a selection with no
 * echo in the receipt was dropped: the step fails and the transaction rolls back.
 */
export function assertReceiptSelection(requested: OverrideSelection | undefined, receipt: CandidateReconciliationReceipt): void {
  if (JSON.stringify(requested ?? []) !== JSON.stringify(receipt.overrides ?? [])) {
    throw new Error(`candidate ${receipt.candidate_version} did not apply the --override selection; run rh update without --override, then rh install --override`);
  }
}

export function parseCandidateReceipt(stdout: string): CandidateReconciliationReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error('candidate reconciliation did not emit a JSON receipt');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('candidate reconciliation receipt is not an object');
  }
  const receipt = parsed as Record<string, unknown>;
  const digestKeys = ['candidate_package_digest', 'route_registry_digest'];
  if (
    receipt.protocol !== CANDIDATE_RECONCILIATION_PROTOCOL
    || typeof receipt.transaction_id !== 'string'
    || typeof receipt.candidate_package_root !== 'string'
    || typeof receipt.candidate_version !== 'string'
    || digestKeys.some((key) => typeof receipt[key] !== 'string' || !(receipt[key] as string).startsWith('sha256:'))
    || !['codex', 'claude', 'both'].includes(String(receipt.selected_target))
    || !['complete', 'partial'].includes(String(receipt.reconciliation_scope))
    || typeof receipt.verified_at !== 'string'
    || typeof receipt.adapter_projection_digests !== 'object'
    || receipt.adapter_projection_digests === null
    || Array.isArray(receipt.adapter_projection_digests)
    || (receipt.ownership_manifest_digest !== null && (
      typeof receipt.ownership_manifest_digest !== 'string'
      || !receipt.ownership_manifest_digest.startsWith('sha256:')
    ))
    || (receipt.overrides !== undefined && !isOverrideSelection(receipt.overrides))
  ) {
    throw new Error('candidate reconciliation receipt has invalid shape');
  }
  for (const [host, digest] of Object.entries(receipt.adapter_projection_digests as Record<string, unknown>)) {
    if (!['codex', 'claude'].includes(host) || typeof digest !== 'string' || !digest.startsWith('sha256:')) {
      throw new Error('candidate reconciliation receipt has invalid adapter projection digests');
    }
  }
  return receipt as unknown as CandidateReconciliationReceipt;
}

export function encodeCandidateRequest(request: CandidateReconciliationRequest): string {
  return Buffer.from(JSON.stringify(request), 'utf-8').toString('base64url');
}

/**
 * A released parent that predates request protocol 2 still sends a profile.
 * Its own update re-reads the install state after this candidate returns and
 * cannot read protocol 3, so the cutover cannot run under it. The candidate
 * refuses before any write and names the direct bootstrap.
 */
export class CandidateRequestProtocolRetiredError extends Error {
  readonly code = 'candidate_request_protocol_retired';
  constructor(protocol: number, candidateVersion: string) {
    super(`repo-harness ${candidateVersion} does not accept a reconciliation request of protocol ${protocol} from an older repo-harness. `
      + `Install the new CLI directly, then update: bun add -g repo-harness@${candidateVersion} --no-cache && ${CLI_NAME} update`);
    this.name = 'CandidateRequestProtocolRetiredError';
  }
}

function isOverrideSelection(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && Object.keys(entry).length === 2
    && typeof entry.path === 'string' && isAbsolute(entry.path)
    && typeof entry.selector === 'string' && entry.selector.length > 0);
}

export function parseCandidateRequest(encoded: string, candidateVersion: string): CandidateReconciliationRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
  } catch {
    throw new Error('candidate reconciliation request is not valid base64url JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('candidate reconciliation request is not an object');
  }
  const request = parsed as Record<string, unknown>;
  if (request.protocol === 1 || request.protocol === 2) {
    throw new CandidateRequestProtocolRetiredError(request.protocol, candidateVersion);
  }
  const requiredStrings = ['transaction_id', 'transaction_backup_root', 'parent_token', 'cwd'];
  const booleans = [
    'sync_skill', 'host_adapters', 'external_skills', 'obsidian_skills', 'codegraph',
  ];
  // A field that this version does not read (a retired one, or one of a newer parent) is refused, not dropped.
  const known = new Set([...requiredStrings, ...booleans, 'protocol', 'candidate', 'target', 'report_language', 'overrides']);
  if (
    request.protocol !== CANDIDATE_RECONCILIATION_PROTOCOL
    || requiredStrings.some((key) => typeof request[key] !== 'string' || !(request[key] as string).length)
    || typeof request.candidate !== 'object'
    || request.candidate === null
    || Array.isArray(request.candidate)
    || !['codex', 'claude', 'both'].includes(String(request.target))
    || Object.keys(request).some((key) => !known.has(key))
    || booleans.some((key) => typeof request[key] !== 'boolean')
    || (request.report_language !== undefined
      && !REPORT_LANGUAGE_FLAG_VALUES.includes(request.report_language as ReportLanguageFlag))
    || (request.overrides !== undefined && !isOverrideSelection(request.overrides))
  ) {
    throw new Error('candidate reconciliation request has invalid shape');
  }
  const candidate = request.candidate as Record<string, unknown>;
  if (
    typeof candidate.root !== 'string'
    || typeof candidate.version !== 'string'
    || typeof candidate.package_digest !== 'string'
    || !candidate.package_digest.startsWith('sha256:')
  ) {
    throw new Error('candidate reconciliation request has invalid package identity');
  }
  return request as unknown as CandidateReconciliationRequest;
}
