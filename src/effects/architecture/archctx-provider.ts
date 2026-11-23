import { FileSyntaxError, parseJsonText } from '../../core/evidence/file-syntax';
import { DEFAULT_GLOBAL_ARCHITECTURE, loadArchitectureProjectionPolicy, readGlobalArchitectureConfiguration } from './projection-config';
import { Database } from 'bun:sqlite';
import { accessSync, chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ARCHCONTEXT_NODE_RANGE, ARCHITECTURE_DOCS_PROJECTION_MANIFEST_SCHEMA_VERSION, ARCHITECTURE_DOCS_PROJECTION_MANIFEST_UPGRADE_COMMAND, ERROR_CATALOG, PROJECTION_MANIFEST_UPGRADE_REQUIRED, failureIssues, architectureDocsProjectionCompatibilityIssues, PROJECTION_REQUEST_SCHEMA_VERSION, digestJson, type ArchContextError, type ArchctxCapabilitiesV1, type ArchitectureDebtDeltaReportV1, type ArchitectureDebtReportV1, type DocsAnchorsReportV1, type IndexSeedResultV1, type Json, type ProjectionExpectedSnapshotV1, type ProjectionMode, type ProjectionRequestV1, type ProjectionResultV3 } from 'archctx-contracts';
import { isRecord } from '../../core/evidence/is-record';
import { readWorkflowPolicyDocument } from '../state/resolve-effective-state';
import { POLICY_ABSENT, isPolicyObject, policyValue } from '../../core/workflow/policy-schema';
import { trustedNodeCandidates } from '../runtime/node-candidates';
import { selectCompatibleNode } from '../runtime/node-runtime';
import { runProcess } from '../process-runner';
import type { CapabilityOwnership } from '../../core/capabilities/registry';
import { ARCHCTX_REQUIRED_VERSION, ArchctxClientError, assertArchctxVersion, assertProjectionResult, decodeArchitectureDebtDelta, decodeArchitectureDebtReport, decodeDocsAnchorsReport, decodeIndexSeedResult, readArchitectureProjectionPolicy } from '../../core/architecture/projection';
import type { ArchctxProcessResult, ArchctxProviderOptions, ResolvedArchctxPackage, ArchitectureProjectionReadinessV1 } from '../../core/architecture/contracts';
import { gitExecFileSync, gitSpawnSync } from '../git/runner';

const ARCHCTX_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_RUNNER = (binary: string, args: readonly string[], options: { cwd: string; timeoutMs?: number; deadlineMs?: number; env: NodeJS.ProcessEnv }): ArchctxProcessResult => {
  const result = runProcess(binary, args, {
    cwd: options.cwd,
    env: options.env,
    inheritEnv: false,
    timeoutMs: options.timeoutMs,
    deadlineMs: options.deadlineMs,
    maxOutputBytes: ARCHCTX_MAX_OUTPUT_BYTES,
    redactions: [],
    processGroup: true,
  });
  const overflow = Buffer.byteLength(result.stdout, 'utf8') > ARCHCTX_MAX_OUTPUT_BYTES || Buffer.byteLength(result.stderr, 'utf8') > ARCHCTX_MAX_OUTPUT_BYTES;
  return {
    status: overflow ? 1 : result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    ...((overflow ? 'archctx output exceeded maxBuffer' : result.error) ? { error: overflow ? 'archctx output exceeded maxBuffer' : result.error } : {}),
    ...(result.launchFailed ? { launchFailed: true } : {}),
  };
};

const CODEGRAPH_INIT_ARGS = ['init', '-y', '.'] as const;
/** Bound for linked worktree `archctx index seed` waiting on an active base refresh or staged sync. */
const CODEGRAPH_INDEX_SEED_LINKED_TIMEOUT_MS = 5_000;

function capabilityAuthorityReady(repoRoot: string): boolean {
  return existsSync(join(repoRoot, '.archcontext', 'model', 'nodes'));
}

/**
 * Module resolution finds archctx from the running module, or from an explicit
 * consumer root. The base is a real module file in the source tree and in
 * `dist/hook-entry.js`, so both find the dependency that the install placed.
 */
export function resolvePackageLocalArchctx(consumerRoot?: string, requiredVersion: string = ARCHCTX_REQUIRED_VERSION, packageRoot?: string): ResolvedArchctxPackage {
  const origin = consumerRoot === undefined ? `module ${fileURLToPath(import.meta.url)}` : `consumer root ${resolve(consumerRoot)}`;
  const manifestPath = packageRoot === undefined
    ? resolvePackageManifest(consumerRoot === undefined ? import.meta.url : join(resolve(consumerRoot), 'package.json'), 'archctx', `package-local archctx@${requiredVersion} is missing from the dependency tree of ${origin}`)
    : join(packageRoot, 'package.json');
  const resolvedRoot = dirname(manifestPath);
  const manifest = parseJsonText(readFileSync(manifestPath, 'utf8'), manifestPath) as { name?: unknown; version?: unknown; bin?: unknown; engines?: unknown };
  if (manifest.name !== 'archctx' || manifest.version !== requiredVersion) throw new ArchctxClientError({ code: 'RH_ARCHCTX_PACKAGE_MISMATCH', action: 'update-repo-harness', message: `package-local archctx mismatch: expected archctx@${requiredVersion}, got ${String(manifest.name)}@${String(manifest.version)} (resolved from ${origin})` });
  const engines = isRecord(manifest.engines) ? manifest.engines : null;
  if (engines?.node !== ARCHCONTEXT_NODE_RANGE) throw new Error(`package-local archctx@${requiredVersion} Node runtime contract mismatch: expected ${ARCHCONTEXT_NODE_RANGE}, got ${String(engines?.node)}`);
  const bin = isRecord(manifest.bin) && typeof manifest.bin.archctx === 'string' ? manifest.bin.archctx : null;
  if (!bin) throw new Error(`package-local archctx@${requiredVersion} does not declare bin.archctx`);
  const binaryPath = resolve(resolvedRoot, bin);
  if (!existsSync(binaryPath)) throw new Error(`package-local archctx@${requiredVersion} binary is missing: ${binaryPath}`);
  const realBinary = realpathSync(binaryPath);
  const realPackage = realpathSync(resolvedRoot);
  const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
  if (!inside(realBinary, realPackage)) throw new Error('package-local archctx binary escapes the archctx package root');
  return { binaryPath: realBinary, nodeRange: ARCHCONTEXT_NODE_RANGE, packageRoot: realPackage, version: requiredVersion };
}

const DEFAULT_TRUSTED_NODE_CANDIDATE_SOURCE = () => trustedNodeCandidates(userInfo().homedir);
const compatibleNodeRuntimeCache = new Map<string, string>();

function compatibleNodeRuntimeCacheKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify([env.REPO_HARNESS_NODE_BIN ?? '', env.PATH ?? '', env.PATHEXT ?? '']);
}

export function clearCompatibleNodeRuntimeCacheForTests(): void {
  compatibleNodeRuntimeCache.clear();
}

function isCachedNodeRuntimeUsable(path: string): boolean {
  if (!existsSync(path)) return false;
  if (process.platform === 'win32') return true;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolution order: the explicit `REPO_HARNESS_NODE_BIN` authority, then the
 * inherited PATH, then the shared trusted-candidate scan. The third tier exists
 * because the bounded verifier's env scrub strips the `REPO_HARNESS_` prefix
 * whole, so a gate that reaches the architecture projection inside the sandbox
 * sees neither the explicit runtime nor an nvm-managed Node on its protected
 * PATH. Every tier applies the same `ARCHCONTEXT_NODE_RANGE` check and the
 * exhausted case still fails closed.
 */
export function resolveCompatibleNodeRuntime(
  env: NodeJS.ProcessEnv,
  trustedCandidateSource: () => readonly string[] = DEFAULT_TRUSTED_NODE_CANDIDATE_SOURCE,
  budget: Pick<ArchctxProviderOptions, 'deadlineMs' | 'nowMs'> = {},
): string {
  const callerLimitsProbe = budget.deadlineMs !== undefined && budget.deadlineMs - (budget.nowMs ?? Date.now)() <= 5_000;
  const cacheable = trustedCandidateSource === DEFAULT_TRUSTED_NODE_CANDIDATE_SOURCE && !callerLimitsProbe;
  const cacheKey = cacheable ? compatibleNodeRuntimeCacheKey(env) : null;
  if (cacheKey !== null) {
    const cached = compatibleNodeRuntimeCache.get(cacheKey);
    if (cached !== undefined) {
      if (isCachedNodeRuntimeUsable(cached)) return cached;
      compatibleNodeRuntimeCache.delete(cacheKey);
    }
  }
  const version = (candidate: string): string | null => {
    const timeoutMs = remainingTimeout(budget, 5_000, 'Node runtime selection');
    const deadlineMs = budget.deadlineMs === undefined ? undefined : budget.nowMs === undefined
      ? Math.min(budget.deadlineMs, Date.now() + timeoutMs)
      : Date.now() + timeoutMs;
    const result = runProcess(candidate, ['--version'], {
      env,
      inheritEnv: false,
      ...(deadlineMs === undefined ? { timeoutMs } : { deadlineMs }),
      maxOutputBytes: 4 * 1024,
      redactions: [],
      processGroup: true,
    });
    if (result.timedOut && callerLimitsProbe) {
      throw new ArchctxClientError({ code: 'RH_ARCHCTX_TIMEOUT', action: 'retry', message: 'architecture projection timeout before Node runtime selection' });
    }
    return result.ok ? result.stdout.trim().replace(/^v/, '') : null;
  };
  const pathValue = env.PATH ?? '';
  let trustedCandidates: readonly string[] = [];
  const selected = selectCompatibleNode({
    range: ARCHCONTEXT_NODE_RANGE,
    explicit: env.REPO_HARNESS_NODE_BIN,
    pathValue,
    pathExt: env.PATHEXT,
    candidates: () => (trustedCandidates = trustedCandidateSource()),
    versionOf: version,
  });
  if (selected.status === 'selected') {
    if (cacheKey !== null) compatibleNodeRuntimeCache.set(cacheKey, selected.path);
    return selected.path;
  }
  if (selected.status === 'explicit-rejected') {
    if (selected.reason === 'not-absolute') throw new Error('REPO_HARNESS_NODE_BIN must be an absolute path');
    if (selected.reason === 'not-executable') throw new Error('REPO_HARNESS_NODE_BIN is not an executable file');
    throw new Error(`REPO_HARNESS_NODE_BIN must satisfy Node ${ARCHCONTEXT_NODE_RANGE}`);
  }
  throw new Error(
    `archctx requires Node ${ARCHCONTEXT_NODE_RANGE}; no compatible node executable was found. `
    + `Scanned sources: REPO_HARNESS_NODE_BIN (unset), `
    + `PATH (${pathValue || '(empty)'}), `
    + `trusted candidates (${trustedCandidates.length > 0 ? trustedCandidates.join(', ') : '(none)'})`,
  );
}

function runArchctxProcess(
  resolved: ResolvedArchctxPackage,
  args: readonly string[],
  options: ArchctxProviderOptions,
  cwd: string,
  timeoutMs: number,
): ArchctxProcessResult {
  const env = options.env ?? process.env;
  if (options.run) return options.run(resolved.binaryPath, args, { cwd, timeoutMs, env });
  // Subprocess supervision uses epoch wall time. Translate an injected clock's
  // remaining budget once, then preserve that wall deadline through Node selection.
  const deadlineMs = options.nowMs === undefined
    ? Math.min(options.deadlineMs ?? Infinity, Date.now() + timeoutMs)
    : Date.now() + timeoutMs;
  const nodeExecutable = resolveCompatibleNodeRuntime(env, options.trustedNodeCandidateSource, { deadlineMs });
  remainingTimeout({ deadlineMs }, timeoutMs, commandLabel(args));
  return DEFAULT_RUNNER(nodeExecutable, [resolved.binaryPath, ...args], { cwd, deadlineMs, env });
}

/** One transport and envelope reader for projection, refactor and ownership. */
export class ArchctxClient {
  readonly resolved: ResolvedArchctxPackage;

  constructor(readonly repoRoot: string, requiredVersion: string, readonly options: ArchctxProviderOptions = {}, packageRoot?: string) {
    this.resolved = resolvePackageLocalArchctx(options.consumerRoot, requiredVersion, packageRoot);
  }

  json(args: readonly string[], maximumMs = 120_000, allowErrorEnvelope = false): unknown {
    const label = commandLabel(args);
    const result = runArchctxProcess(this.resolved, args, this.options, this.repoRoot, remainingTimeout(this.options, maximumMs, label));
    if (result.timedOut) {
      if (args[0] === 'checkpoint') {
        throw new ArchctxClientError({ code: 'RH_ARCHCTX_TIMEOUT', action: 'inspect-diagnostics', message: 'architecture checkpoint did not finish in the notice time budget' });
      }
      throw new ArchctxClientError({ code: 'RH_ARCHCTX_TIMEOUT', action: 'retry', message: `${label} timed out` });
    }
    if (Buffer.byteLength(result.stdout, 'utf8') > ARCHCTX_MAX_OUTPUT_BYTES || Buffer.byteLength(result.stderr, 'utf8') > ARCHCTX_MAX_OUTPUT_BYTES) throw new Error(`${label} output exceeded maxBuffer`);
    // Distinguish proven pre-launch spawn failures (no target started) from post-launch failures; never print argv/request-json.
    if (result.launchFailed === true) {
      throw new ArchctxClientError({ code: 'RH_ARCHCTX_LAUNCH_FAILED', action: 'inspect-diagnostics', message: `${label} failed to launch` });
    }
    // Process errors can contain argv, including request-json. Do not print them.
    if (result.signal || result.error) throw new Error(`${label} process failed${result.signal ? `: signal ${result.signal}` : ''}`);
    if (result.stdout.trim() === '') throw new Error(`${label} failed: exit ${result.status}: ${result.stderr.trim()}`);
    const value = parseJson(result, label);
    if (args[0] === 'capabilities' && result.status === 0) return value;
    if (!isRecord(value) || value.schemaVersion !== 'archcontext.envelope/v1' || typeof value.ok !== 'boolean' || typeof value.requestId !== 'string') throw new Error(`${label} returned an invalid envelope`);
    if (value.ok === false) {
      const error = decodeArchctxError(value.error);
      if (!allowErrorEnvelope) throw new ArchctxClientError(error);
    } else if (!isRecord(value.data)) throw new Error(`${label} returned an invalid envelope`);
    if (result.status !== 0 && !allowErrorEnvelope && value.ok) throw new Error(`${label} failed: exit ${result.status}`);
    return value;
  }

  data(args: readonly string[], maximumMs: number): unknown {
    return (this.json(args, maximumMs) as Record<string, unknown>).data;
  }
}

function decodeArchctxError(value: unknown): ArchContextError {
  if (!isRecord(value) || typeof value.code !== 'string' || !Object.hasOwn(ERROR_CATALOG, value.code)) throw new Error('archctx returned an invalid error envelope');
  const defaults = ERROR_CATALOG[value.code as ArchContextError['code']];
  const catalogDefault = typeof value.message === 'string'
    && value.action === defaults.action
    && value.retryable === defaults.retryable
    && value.severity === defaults.severity
    && (value.reasonCode === undefined || typeof value.reasonCode === 'string')
    && (value.details === undefined || (isRecord(value.details) && Buffer.byteLength(JSON.stringify(value.details), 'utf8') <= 256 * 1024));
  if (!catalogDefault && failureIssues(value).length !== 0) throw new Error('archctx returned an invalid error envelope');
  return value as unknown as ArchContextError;
}

export function commandLabel(args: readonly string[]): string { return `archctx ${args.slice(0, args[1]?.startsWith('-') ? 1 : 2).join(' ')}`; }

export function runPackageLocalArchctxJson(
  repoRoot: string,
  requiredVersion: string,
  args: readonly string[],
  options: ArchctxProviderOptions = {},
  maximumMs = 120_000,
  allowErrorEnvelope = false,
  packageRoot?: string,
): { resolved: ResolvedArchctxPackage; value: unknown } {
  const client = new ArchctxClient(repoRoot, requiredVersion, options, packageRoot);
  return { resolved: client.resolved, value: client.json(args, maximumMs, allowErrorEnvelope) };
}

type DoctorCodeFacts = {
  state: 'ready' | 'not-ready' | 'index-missing' | 'unavailable';
  issues: Array<{ code: string; message: string }>;
  reasonCode?: string;
  message?: string;
};

function codeFactsFixCommand(state: DoctorCodeFacts['state']): string {
  if (state === 'unavailable') return 'rh update';
  return state === 'index-missing' ? `codegraph ${CODEGRAPH_INIT_ARGS.join(' ')}` : 'codegraph index .';
}

/** Decode the code facts contract from archctx@0.9.1 doctor for both CLI callers. */
function readArchitectureCodeFacts(client: ArchctxClient, maximumMs: number): DoctorCodeFacts {
  const value = client.json(['doctor', '--json'], maximumMs);
  const facts = isRecord(value) && isRecord(value.data) ? value.data.codeFacts : null;
  const invalid = () => new ArchctxClientError({ code: 'RH_ARCHCTX_DOCTOR_INVALID', action: 'update-repo-harness', reasonCode: 'doctor-code-facts-invalid', message: 'archctx doctor returned invalid code facts' });
  if (!isRecord(value) || value.requestId !== 'doctor' || !isRecord(facts) || facts.schemaVersion !== 'archcontext.repository-code-facts/v1' || typeof facts.requiredVersion !== 'string' || facts.requiredVersion === '') throw invalid();
  if (facts.state === 'unavailable') {
    if (typeof facts.reasonCode !== 'string' || facts.reasonCode === '' || typeof facts.message !== 'string') throw invalid();
    return { state: facts.state, issues: [], reasonCode: facts.reasonCode, message: facts.message };
  }
  if (facts.state !== 'ready' && facts.state !== 'not-ready' && facts.state !== 'index-missing') throw invalid();
  if (facts.indexPresent !== (facts.state !== 'index-missing') || typeof facts.codeGraphVersion !== 'string' || !Array.isArray(facts.issues)) throw invalid();
  const issues = facts.issues.map((issue: unknown) => {
    if (!isRecord(issue) || typeof issue.code !== 'string' || issue.code === '' || typeof issue.message !== 'string') throw invalid();
    return { code: issue.code, message: issue.message };
  });
  if ((facts.state === 'ready' && issues.length !== 0) || (facts.state === 'not-ready' && issues.length === 0)) throw invalid();
  return { state: facts.state, issues };
}

export function archctxCapabilities(repoRoot: string, options: ArchctxProviderOptions = {}, packageRoot?: string): { resolved: ResolvedArchctxPackage; capabilities: ArchctxCapabilitiesV1 } {
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  if (policy.provider === 'disabled') throw new Error('architecture projection provider is disabled');
  const { resolved, value } = runPackageLocalArchctxJson(repoRoot, policy.requiredVersion, ['capabilities', '--json'], options, Math.min(policy.timeoutMs, 10_000), false, packageRoot);
  try { assertArchctxVersion(value, policy.requiredVersion); }
  catch (error) { throw new ArchctxClientError({ code: 'RH_ARCHCTX_PACKAGE_MISMATCH', action: 'update-repo-harness', message: error instanceof Error ? error.message : String(error) }); }
  return { resolved, capabilities: value as ArchctxCapabilitiesV1 };
}

/**
 * `rh arch`: the version handshake, then the package-local archctx with the caller's
 * arguments, inherited stdio and no output cap. Returns the archctx exit code; a signal exit is 1.
 */
export function runArchctxPassThrough(cwd: string, args: readonly string[], options: ArchctxProviderOptions = {}): number {
  let spawnCwd = cwd;
  let env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const isIndexSeed = args[0] === 'index' && args[1] === 'seed' && !args.includes('--help') && !args.includes('-h');
  if (isIndexSeed) {
    const seedRoot = resolveCodeGraphSeedRoot(cwd, env);
    spawnCwd = seedRoot;
    env = {
      // `archctx index seed` disables shared-base seeding if CODEGRAPH_DIR is set (`index-base.ts:189`).
      ...withoutEnvKeys(sanitizeGitDiscoveryEnv(env), CODEGRAPH_SEED_STRIPPED_ENV_KEYS),
      CODEGRAPH_FORCE_WATCH: '1',
    };
    assertSafeCodeGraphDestination(seedRoot, { env });
  }
  const { resolved } = archctxCapabilities(spawnCwd, { ...options, env });
  const nodeExecutable = resolveCompatibleNodeRuntime(env, options.trustedNodeCandidateSource);
  const result = spawnSync(nodeExecutable, [resolved.binaryPath, ...args], { cwd: spawnCwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (isIndexSeed && result.status === 0) {
    quiesceSeededCodeGraphSidecars(spawnCwd, nodeExecutable, env);
  }
  return result.status ?? 1;
}

const PROJECTION_MANIFEST_INCOMPATIBLE = 'projection-manifest-incompatible';
const COMMITTED_PROJECTION_MANIFEST = 'docs/architecture/.projection-manifest.json';

/**
 * archctx owns the manifest compatibility rule. The committed manifest must pass that rule
 * for the installed engine and then have the current schema, or readiness fails closed and
 * apply stays off. The rule runs first, as in archctx: a newer schema or an unmet floor needs
 * a newer repo-harness, and only a compatible superseded schema can be re-baselined. The rule
 * alone accepts that superseded schema, but every archctx command that reads it refuses it.
 */
function assertCommittedProjectionManifestCompatible(repoRoot: string, capabilities: ArchctxCapabilitiesV1): void {
  const path = join(repoRoot, COMMITTED_PROJECTION_MANIFEST);
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  let manifest: unknown;
  try { manifest = parseJsonText(text, COMMITTED_PROJECTION_MANIFEST); }
  catch (error) {
    if (!(error instanceof FileSyntaxError)) throw error;
    throw new ArchctxClientError({ code: 'RH_ARCHCTX_PROJECTION_MANIFEST_INVALID', action: 'inspect-projection-manifest', message: error.message });
  }
  if (!isRecord(manifest)) throw new ArchctxClientError({ code: 'RH_ARCHCTX_PROJECTION_MANIFEST_INVALID', action: 'inspect-projection-manifest', message: `${COMMITTED_PROJECTION_MANIFEST} is not a JSON object` });
  const issues = architectureDocsProjectionCompatibilityIssues(manifest, {
    rendererVersion: capabilities.renderers.architectureDocs,
    protocolVersion: capabilities.protocols.projectionRequest,
  });
  if (issues.length > 0) {
    throw new ArchctxClientError({ code: 'AC_PRECONDITION_FAILED', action: 'update-repo-harness', reasonCode: PROJECTION_MANIFEST_INCOMPATIBLE, details: { issues }, message: `${COMMITTED_PROJECTION_MANIFEST} is incompatible with the installed archctx: ${issues.join('; ')}` });
  }
  if (manifest.schemaVersion !== ARCHITECTURE_DOCS_PROJECTION_MANIFEST_SCHEMA_VERSION) {
    throw new ArchctxClientError({ code: 'AC_PRECONDITION_FAILED', action: 'upgrade-projection-manifest', reasonCode: PROJECTION_MANIFEST_UPGRADE_REQUIRED, message: `${COMMITTED_PROJECTION_MANIFEST} schema ${JSON.stringify(manifest.schemaVersion)} is not ${ARCHITECTURE_DOCS_PROJECTION_MANIFEST_SCHEMA_VERSION}; run ${ARCHITECTURE_DOCS_PROJECTION_MANIFEST_UPGRADE_COMMAND}` });
  }
}

/** `readModelReady` is the model read of `architecture-read.ts`; this module does not import that module. */
export function inspectArchitectureProjectionReadiness(
  repoRoot: string,
  readModelReady: (repoRoot: string, options: ArchctxProviderOptions) => boolean,
  options: ArchctxProviderOptions = {},
): ArchitectureProjectionReadinessV1 {
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  let source: ArchitectureProjectionReadinessV1['modelAuthority']['source'] = 'unadopted';
  let codeFacts: ArchitectureProjectionReadinessV1['codeFacts'] = { requirement: 'required', state: 'not-evaluated' };
  const base = () => ({
    schemaVersion: 'repo-harness.architecture-projection-readiness/v1' as const,
    modelAuthority: { source, ready: source !== 'unadopted' && capabilityAuthorityReady(repoRoot) },
    codeFacts,
    apply: { mode: policy.applyMode, enabled: false },
  });
  try {
    source = capabilitySource(repoRoot);
    if (policy.provider === 'disabled') return {
      ...base(),
      projectionProvider: { provider: 'disabled', state: 'disabled', binaryPath: null, nodePath: null, command: null, version: null, reason: readGlobalArchitectureConfiguration(options.env).initialized ? 'global architecture.projection_provider=disabled' : 'global architecture configuration is missing; run rh update once' },
      next: source === 'archcontext' && readModelReady(repoRoot, options) ? null : architectureAdoptionStep(),
    };
    if (source === 'unadopted') throw new ArchctxClientError({ code: 'RH_ARCHCTX_POLICY_MISSING', action: 'adopt-repository', message: 'repository policy is missing; run rh init' });
    const nodePath = resolveCompatibleNodeRuntime(options.env ?? process.env, options.trustedNodeCandidateSource);
    const handshake = archctxCapabilities(repoRoot, options);
    assertCommittedProjectionManifestCompatible(repoRoot, handshake.capabilities);
    const facts = readArchitectureCodeFacts(new ArchctxClient(repoRoot, policy.requiredVersion, options), policy.timeoutMs);
    codeFacts = { requirement: 'required', ...facts };
    const modelReady = readModelReady(repoRoot, options);
    return {
      ...base(),
      projectionProvider: { provider: 'archctx', state: 'ready', binaryPath: handshake.resolved.binaryPath, nodePath, command: [nodePath, handshake.resolved.binaryPath], version: handshake.resolved.version, reason: 'exact package-local handshake passed; code facts are reported separately' },
      apply: { mode: policy.applyMode, enabled: policy.applyMode !== 'disabled' && modelReady && codeFacts.state === 'ready' },
      next: facts.state !== 'ready' ? codeFactsFixCommand(facts.state) : source !== 'archcontext' || !modelReady ? architectureAdoptionStep() : null,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const state: ArchitectureProjectionReadinessV1['projectionProvider']['state'] = error instanceof ArchctxClientError
      ? ['RH_ARCHCTX_PACKAGE_MISSING', 'RH_ARCHCTX_POLICY_MISSING'].includes(error.code) ? 'missing'
        : ['RH_ARCHCTX_PACKAGE_MISMATCH', 'AC_RUNTIME_VERSION_UNSUPPORTED'].includes(error.code) || [PROJECTION_MANIFEST_INCOMPATIBLE, PROJECTION_MANIFEST_UPGRADE_REQUIRED].includes(error.reasonCode ?? '') ? 'mismatch' : 'error'
      : 'error';
    return {
      ...base(),
      projectionProvider: { provider: policy.provider, state, binaryPath: null, nodePath: null, command: null, version: null, reason, ...(error instanceof ArchctxClientError && error.reasonCode !== undefined ? { reasonCode: error.reasonCode } : {}) },
      next: error instanceof ArchctxClientError ? error.action === 'update-repo-harness' ? 'update repo-harness' : error.action : 'repair the reported provider error',
    };
  }
}

export interface ArchitectureProjectionRequestOptions {
  changedPaths?: readonly string[];
  requestId?: string;
  adoptionPlanId?: string;
  expectedWorktreeDigest?: string;
}

/** One immutable input identity for the whole call, including observed acceptance. */
export function architectureProjectionRequest(mode: ProjectionMode, repoRoot: string, options: ArchitectureProjectionRequestOptions & ArchctxProviderOptions = {}): ProjectionRequestV1 {
  const expected = readArchitectureProjectionSnapshot(repoRoot, options);
  if (options.expectedWorktreeDigest !== undefined && options.expectedWorktreeDigest !== expected.worktreeDigest) throw new ArchctxClientError({ code: 'RH_ARCHCTX_PLAN_MISMATCH', action: 'rebuild-plan', message: 'worktree differs from the reviewed plan; run rh arch projection plan --json' });
  const body: Omit<ProjectionRequestV1, 'requestId'> = {
    schemaVersion: PROJECTION_REQUEST_SCHEMA_VERSION,
    profile: 'repo-harness/v1', mode, targets: ['architecture-docs'],
    changedPaths: [...new Set(options.changedPaths ?? [])].sort(), expected,
    ...(mode === 'adopt' ? { adoptionPlanId: options.adoptionPlanId } : {}),
    ...(mode === 'apply' || mode === 'adopt' ? { acceptObservedMajorChange: true as const } : {}),
  };
  return { ...body, requestId: options.requestId ?? `repo-harness.${mode}.${digestJson(body as unknown as Json).slice('sha256:'.length)}` };
}

const PROJECTION_SNAPSHOT_FIELDS = ['repositoryId', 'workspaceId', 'headSha', 'worktreeDigest'] as const;

/**
 * archctx owns the expected snapshot identity, including which files the
 * worktree digest covers. repo-harness reads it and never recomputes it.
 */
export function readArchitectureProjectionSnapshot(repoRoot: string, options: ArchctxProviderOptions = {}): ProjectionExpectedSnapshotV1 {
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  if (policy.provider === 'disabled') throw new Error('architecture projection provider is disabled');
  const { value } = runPackageLocalArchctxJson(repoRoot, policy.requiredVersion, ['projection', 'snapshot', '--json'], options, policy.timeoutMs);
  return decodeProjectionExpectedSnapshot(value);
}

/** The client already proved the envelope and refused an error envelope with its typed fields. */
function decodeProjectionExpectedSnapshot(value: unknown): ProjectionExpectedSnapshotV1 {
  const issues: string[] = [];
  const envelope: Record<string, unknown> = isRecord(value) ? value : {};
  const data = isRecord(envelope.data) ? envelope.data : null;
  const expected = data && isRecord(data.expected) ? data.expected : null;
  if (envelope.requestId !== 'projection.snapshot') issues.push('requestId');
  if (!data || Object.keys(data).length !== 1 || !expected) issues.push('data.expected');
  else {
    if (Object.keys(expected).length !== PROJECTION_SNAPSHOT_FIELDS.length) issues.push('data.expected.keys');
    for (const field of PROJECTION_SNAPSHOT_FIELDS) {
      if (typeof expected[field] !== 'string' || expected[field] === '') issues.push(`data.expected.${field}`);
    }
    if (typeof expected.headSha === 'string' && !/^[a-f0-9]{40}$/.test(expected.headSha)) issues.push('data.expected.headSha');
    if (typeof expected.worktreeDigest === 'string' && !/^sha256:[a-f0-9]{64}$/.test(expected.worktreeDigest)) issues.push('data.expected.worktreeDigest');
  }
  if (issues.length > 0 || !expected) {
    const fields = [...new Set(issues)];
    throw new ArchctxClientError({
      code: 'RH_ARCHCTX_SNAPSHOT_INVALID', action: 'update-repo-harness', reasonCode: 'projection-snapshot-invalid', details: { fields },
      message: `archctx projection snapshot returned an invalid expected snapshot: ${fields.join(', ')}`,
    });
  }
  return {
    repositoryId: expected.repositoryId as string,
    workspaceId: expected.workspaceId as string,
    headSha: expected.headSha as string,
    worktreeDigest: expected.worktreeDigest as ProjectionExpectedSnapshotV1['worktreeDigest'],
  };
}

/** A package-relative name: the installed skill and the package carry the same file on every host. */
function architectureAdoptionStep(): string {
  return 'The repository has no complete ArchContext model. Follow "Adopt ArchContext in a repository" in references/worker.md of the repo-harness-architecture skill (assets/skill-commands/repo-harness-architecture/references/worker.md in the repo-harness package).';
}

export function runArchitectureProjection(request: ProjectionRequestV1, repoRoot: string, options: ArchctxProviderOptions = {}): ProjectionResultV3 {
  return runProjectionCommand(request, repoRoot, options);
}

/**
 * Runs the read-only `archctx docs anchors`. It reports stale citations in
 * human-owned document regions and node prose. It writes nothing.
 */
export function readArchitectureDocsAnchors(repoRoot: string, options: ArchctxProviderOptions = {}): DocsAnchorsReportV1 {
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  archctxCapabilities(repoRoot, { ...options, policy });
  const client = new ArchctxClient(repoRoot, policy.requiredVersion, options);
  return decodeDocsAnchorsReport(client.data(['docs', 'anchors', '--json'], policy.timeoutMs));
}

/** ArchContext measures and caches the base, and reports deltas for checks with comparable coverage. */
export function readArchitectureDebtDelta(repoRoot: string, baseSha: string, headSha: string, options: ArchctxProviderOptions = {}): ArchitectureDebtDeltaReportV1 {
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  if (policy.provider === 'disabled') throw new Error('architecture projection provider is disabled');
  const client = new ArchctxClient(repoRoot, policy.requiredVersion, options);
  return decodeArchitectureDebtDelta(client.data(['debt', '--base', baseSha, '--complete', '--json'], policy.timeoutMs), baseSha, headSha);
}

/**
 * Runs `archctx complete` for one commit and returns the architecture debt in
 * its review result. archctx omits the debt when it cannot measure it, so a
 * missing or invalid report fails closed. The checkout needs a CodeGraph index.
 * Package resolution already refuses an archctx that is not the pinned version.
 */
export function completeArchitectureDebt(repoRoot: string, headSha: string, options: ArchctxProviderOptions = {}): ArchitectureDebtReportV1 {
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  if (policy.provider === 'disabled') throw new Error('architecture projection provider is disabled');
  const client = new ArchctxClient(repoRoot, policy.requiredVersion, options);
  const facts = readArchitectureCodeFacts(client, policy.timeoutMs);
  if (facts.state !== 'ready') {
    const reasons = facts.issues.map((issue) => issue.code);
    if (facts.reasonCode) reasons.push(facts.reasonCode);
    const command = codeFactsFixCommand(facts.state);
    throw new ArchctxClientError({
      code: 'RH_ARCHCTX_CODE_FACTS_NOT_READY', action: facts.state === 'unavailable' ? 'update-repo-harness' : 'build-codegraph-index', reasonCode: 'code-facts-not-ready',
      details: { ...facts, command },
      message: `code facts for ${repoRoot} are ${facts.state} (${reasons.join(', ') || facts.state})${facts.message ? `: ${facts.message}` : ''}; run ${command} in this repository${facts.state === 'unavailable' ? '' : ' with the package-local CodeGraph'}`,
    });
  }
  return decodeCompleteArchitectureDebt(client.data(['complete', '--head-sha', headSha, '--json'], policy.timeoutMs), headSha);
}

/** One notice phase: each Git call gets the time left before the caller's deadline, at most 3 s. */
function noticeGit(repoRoot: string, bounded: ArchctxProviderOptions): (args: string[]) => string {
  return args => gitExecFileSync(['-C', repoRoot, ...args], {
    encoding: 'utf8', env: bounded.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: remainingTimeout(bounded, 3_000, 'notice git'), maxBuffer: 8 * 1024 * 1024,
  });
}

/**
 * Committed, staged, unstaged and untracked paths that differ from the merge-base
 * of HEAD and the review base. Q9 uses the policy target's merge-base, never the
 * manifest checkpoint.
 */
export function changedSinceReviewBase(repoRoot: string, reviewBase: string, options: ArchctxProviderOptions = {}): ReadonlySet<string> {
  const now = options.nowMs ?? Date.now;
  const git = noticeGit(repoRoot, { ...options, deadlineMs: Math.min(options.deadlineMs ?? Infinity, now() + 3_000) });
  const target = git(['rev-parse', '--verify', '--end-of-options', `${reviewBase}^{commit}`]).trim();
  const base = git(['merge-base', 'HEAD', target]).trim();
  return new Set([
    ...git(['diff', '--name-only', '--no-renames', '-z', base, '--']).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ]);
}

const AUTOMATIC_HOOK_ISOLATED_ENV_KEYS = ['ARCHCONTEXT_LOCAL_STORE_PATH', 'ARCHCONTEXT_STATE_DIR'] as const;
const CODEGRAPH_SEED_STRIPPED_ENV_KEYS = ['CODEGRAPH_DIR', 'CODEGRAPH_NO_WATCH', 'CODEGRAPH_FORCE_WATCH'] as const;

/**
 * Strips caller diagnostic store/state overrides before automatic hook invocations (`prepare`,
 * `checkpoint`). `archctx@0.18.4` isolates v2 cache at `local-cache-v2.sqlite` with zero legacy `DROP`
 * paths and enforces `PRAGMA table_xinfo` / `index` / DDL store ownership, and automatic hooks still
 * isolate `ARCHCONTEXT_LOCAL_STORE_PATH` and `ARCHCONTEXT_STATE_DIR` so user diagnostic paths are
 * never touched implicitly (I2).
 */
function sanitizeAutomaticHookArchctxOptions(options: ArchctxProviderOptions): ArchctxProviderOptions {
  const source = options.env ?? process.env;
  if (!hasAnyEnvKey(source, AUTOMATIC_HOOK_ISOLATED_ENV_KEYS)) return options;
  return { ...options, env: withoutEnvKeys(source, AUTOMATIC_HOOK_ISOLATED_ENV_KEYS) };
}

/** Changed owned paths only. */
export function checkpointArchitectureDebt(repoRoot: string, ownership: CapabilityOwnership | null, options: ArchctxProviderOptions = {}): {
  readonly branch: string;
  readonly report: ArchitectureDebtReportV1;
} | null {
  if (!ownership?.review_base || !ownership.capabilities.some(capability => capability.paths.length > 0)) return null;
  const now = options.nowMs ?? Date.now;
  const sanitized = sanitizeAutomaticHookArchctxOptions(options);
  const bounded = { ...sanitized, deadlineMs: Math.min(options.deadlineMs ?? Infinity, now() + 3_000) };
  const changed = changedSinceReviewBase(repoRoot, ownership.review_base, bounded);
  const paths = [...new Set(ownership.capabilities.flatMap(capability => capability.paths).filter(path => changed.has(path)))].sort();
  if (paths.length === 0) return null;
  const branch = noticeGit(repoRoot, bounded)(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  if (policy.provider === 'disabled') throw new Error('architecture projection provider is disabled');
  const client = new ArchctxClient(repoRoot, policy.requiredVersion, bounded);
  const report = decodeArchitectureDebtReport(client.data(['checkpoint', ...paths.flatMap(path => ['--changed-path', path]), '--json'], 3_000));
  remainingTimeout(bounded, 3_000, 'notice decode');
  if (report.scope.kind !== 'changed-paths' || JSON.stringify(report.scope.changedPaths) !== JSON.stringify(paths)) {
    throw new Error('architecture checkpoint returned a different path subject');
  }
  return { branch, report };
}

/** Read task context only when the repository has an adopted model authority. */
export function prepareArchitectureTask(repoRoot: string, task: string, options: ArchctxProviderOptions): { posture: string; constraints: number } | null {
  if (capabilitySource(repoRoot) !== 'archcontext' || !capabilityAuthorityReady(repoRoot)) return null;
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  if (policy.provider === 'disabled') return null;
  // In-process prepare measured ~2415 ms cold (~1910 ms warm). Skip when too little hook budget remains.
  if (remainingTimeout(options, 3_000, 'notice prepare') < 1_500) {
    throw new ArchctxClientError({ code: 'RH_ARCHCTX_TIMEOUT', action: 'retry', message: 'architecture prepare skipped: less than 1500 ms remains' });
  }
  const sanitized = sanitizeAutomaticHookArchctxOptions(options);
  const data = new ArchctxClient(repoRoot, policy.requiredVersion, sanitized).data(['prepare', '--task', task, '--json'], 3_000);
  remainingTimeout(options, 3_000, 'notice prepare decode');
  const context = isRecord(data) && isRecord(data.context) ? data.context : null;
  if (!context || context.schemaVersion !== 'archcontext.task-context/v1' || context.task !== task
    || !['normal', 'structural', 'intervention', 'proof-required'].includes(context.posture as string)
    || !Array.isArray(context.constraints) || !isRecord(data) || data.posture !== context.posture) {
    throw new Error('architecture prepare returned invalid task context');
  }
  return { posture: context.posture as string, constraints: context.constraints.length };
}

/** The client already refused an error envelope; this binds the review to the commit and decodes its debt. */
function decodeCompleteArchitectureDebt(data: unknown, headSha: string): ArchitectureDebtReportV1 {
  const review = isRecord(data) ? data : {};
  const snapshot = isRecord(review.snapshot) ? review.snapshot : {};
  if (review.schemaVersion !== 'archcontext.review/v1' || snapshot.headSha !== headSha) {
    throw new ArchctxClientError({ code: 'RH_ARCHCTX_DEBT_INVALID', action: 'update-repo-harness', reasonCode: 'review-result-mismatch', details: { headSha }, message: `archctx complete did not return a review result for ${headSha}` });
  }
  if (review.debt === undefined) {
    const actionsRequired = Array.isArray(review.actionsRequired) ? review.actionsRequired.filter((entry): entry is string => typeof entry === 'string') : [];
    throw new ArchctxClientError({
      code: 'RH_ARCHCTX_DEBT_MISSING', action: 'follow-review-actions', reasonCode: 'architecture-debt-missing',
      details: { headSha, result: typeof review.result === 'string' ? review.result : null, actionsRequired },
      message: `archctx complete measured no architecture debt for ${headSha}; required actions: ${actionsRequired.join(', ') || 'none'}`,
    });
  }
  try { return decodeArchitectureDebtReport(review.debt); }
  catch (error) {
    throw new ArchctxClientError({ code: 'RH_ARCHCTX_DEBT_INVALID', action: 'update-repo-harness', reasonCode: 'architecture-debt-invalid', details: { headSha }, message: error instanceof Error ? error.message : String(error) });
  }
}

const CODEGRAPH_GITIGNORE_MARKER = '# CodeGraph data files';
const SQLITE_HEADER_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
const SQLITE_HEADER_MIN_BYTES = 100;
const CODEGRAPH_LOCK_MAX_BYTES = 32;
const CODEGRAPH_PID_LOCK_PATTERN = /^[1-9]\d*$/;
const CODEGRAPH_SQLITE_SIDECARS = ['codegraph.db-wal', 'codegraph.db-shm', 'codegraph.db-journal'] as const;
const CODEGRAPH_LOCK_FILES = [
  'codegraph.lock',
  'codegraph.lock.break',
  'codegraph.lock.break.break',
  'codegraph.lock.break.break.break',
] as const;
const CODEGRAPH_LOCK_TEMP_PATTERN = /^codegraph\.lock(?:\.break){0,3}\.\d+\.\d+\.tmp$/;
const CODEGRAPH_ERROR_LOG_MARKER = 'CodeGraph Error Log - ';
export const GIT_DISCOVERY_ENV_KEYS = [
  'GIT_CEILING_DIRECTORIES',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
] as const;

/** Matches pinned CodeGraph 1.6.4 `isStaleDefaultGitignore` (`directory.js:491-495`). */
function codeGraphRewritesGitignore(content: string): boolean {
  if (!content.trimStart().startsWith(CODEGRAPH_GITIGNORE_MARKER)) return false;
  return !content.split('\n').some((line) => line.trim() === '*');
}

function unsafeCodeGraphDestination(message: string): ArchctxClientError {
  return new ArchctxClientError({
    code: 'RH_CODEGRAPH_DESTINATION_UNSAFE',
    action: 'inspect-codegraph-index',
    reasonCode: 'codegraph-destination-unsafe',
    message,
  });
}

function hasAnyEnvKey(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') {
    const upperKeys = new Set(keys.map((key) => key.toUpperCase()));
    return Object.keys(env).some((key) => upperKeys.has(key.toUpperCase()) && env[key] !== undefined);
  }
  return keys.some((key) => env[key] !== undefined);
}

function withoutEnvKeys(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  if (platform === 'win32') {
    // Git for Windows and PowerShell look up Env: case-insensitively while Bun enumerates original key casing.
    const upperKeys = new Set(keys.map((key) => key.toUpperCase()));
    for (const key of Object.keys(clean)) {
      if (upperKeys.has(key.toUpperCase())) delete clean[key];
    }
    return clean;
  }
  for (const key of keys) delete clean[key];
  return clean;
}

export function sanitizeGitDiscoveryEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return withoutEnvKeys(env, GIT_DISCOVERY_ENV_KEYS, platform);
}

/**
 * Removes only Git's single trailing line terminator (`\r\n` or `\n` on win32; single `\n` on POSIX)
 * so directory names ending in a literal `\r` or whitespace are never collapsed onto a sibling checkout.
 */
export function stripGitLineTerminator(value: string, platform: NodeJS.Platform = process.platform): string {
  if (!value.endsWith('\n')) return value;
  if (platform === 'win32' && value.endsWith('\r\n')) return value.slice(0, -2);
  return value.slice(0, -1);
}

function unsafeArchctxRepoRoot(message: string): ArchctxClientError {
  return new ArchctxClientError({
    code: 'RH_ARCHCTX_UNSAFE_REPO_ROOT',
    action: 'inspect-repository-root',
    reasonCode: 'archctx-unsafe-repo-root',
    message,
  });
}

function assertSafeCheckoutPath(path: string, contextLabel: string, fail: (message: string) => Error): void {
  if (path !== path.trim() || /[\u0000-\u001f\u007f]/.test(path)) {
    throw fail(
      `${contextLabel} refused checkout path with boundary whitespace or control characters (${JSON.stringify(path)}); checkout paths could target an adjacent checkout.`,
    );
  }
}

function readGitTopLevel(
  cwd: string,
  env: NodeJS.ProcessEnv,
  contextLabel: string,
  fail: (message: string) => Error,
): string | null {
  const probe = gitSpawnSync(['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
  if (probe.status !== 0) return null;
  if (!probe.stdout.endsWith('\n')) {
    throw fail(`${contextLabel} received malformed git rev-parse --show-toplevel output for ${JSON.stringify(cwd)}.`);
  }
  const stripped = stripGitLineTerminator(probe.stdout);
  if (!stripped) {
    throw fail(`${contextLabel} received empty git rev-parse --show-toplevel output for ${JSON.stringify(cwd)}.`);
  }
  return stripped;
}

function resolveVerifiedGitRoot(
  inputPath: string,
  callerEnv: NodeJS.ProcessEnv,
  contextLabel: string,
  fail: (message: string) => Error,
  allowMissingOrNonGit: boolean,
): string {
  assertSafeCheckoutPath(inputPath, contextLabel, fail);
  let fallbackRoot = inputPath;
  if (allowMissingOrNonGit) {
    if (!existsSync(inputPath)) return inputPath;
    fallbackRoot = realpathSync(inputPath);
    assertSafeCheckoutPath(fallbackRoot, contextLabel, fail);
  }
  const cleanRoot = readGitTopLevel(inputPath, sanitizeGitDiscoveryEnv(callerEnv), contextLabel, fail);
  const callerRoot = readGitTopLevel(inputPath, callerEnv, contextLabel, fail);
  if (!cleanRoot) {
    if (callerRoot !== null) {
      throw fail(
        `${contextLabel} refused ambiguous Git repository root (${JSON.stringify(callerRoot)}); unset GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_CEILING_DIRECTORIES or run inside the target checkout.`,
      );
    }
    if (allowMissingOrNonGit) return fallbackRoot;
    throw fail(
      `${contextLabel} requires a Git repository worktree; git rev-parse --show-toplevel failed in ${inputPath}.`,
    );
  }
  assertSafeCheckoutPath(cleanRoot, contextLabel, fail);
  const canonicalCleanRoot = realpathSync(cleanRoot);
  assertSafeCheckoutPath(canonicalCleanRoot, contextLabel, fail);
  if (!callerRoot) {
    throw fail(
      `${contextLabel} refused ambiguous Git repository root (git rev-parse --show-toplevel failed under caller Git environment for ${JSON.stringify(cleanRoot)}); unset GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_CEILING_DIRECTORIES or run inside the target checkout.`,
    );
  }
  assertSafeCheckoutPath(callerRoot, contextLabel, fail);
  const canonicalCallerRoot = realpathSync(callerRoot);
  assertSafeCheckoutPath(canonicalCallerRoot, contextLabel, fail);
  if (canonicalCallerRoot !== canonicalCleanRoot) {
    throw fail(
      `${contextLabel} refused ambiguous Git repository root (${JSON.stringify(callerRoot)} != ${JSON.stringify(cleanRoot)}); unset GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/GIT_ALTERNATE_OBJECT_DIRECTORIES/GIT_CEILING_DIRECTORIES or run inside the target checkout.`,
    );
  }
  return canonicalCleanRoot;
}

/**
 * Verifies a repository path before invoking pinned `archctx@0.18.4`.
 * Rejects leading/trailing whitespace, control characters (including literal `\r`),
 * and ambiguous Git discovery roots before canonicalizing or mutating state (I2).
 */
export function assertSafeArchctxRepoRoot(
  repoRoot: string,
  callerEnv: NodeJS.ProcessEnv = process.env,
  contextLabel = 'ArchContext operation',
): string {
  return resolveVerifiedGitRoot(repoRoot, callerEnv, contextLabel, unsafeArchctxRepoRoot, true);
}

/**
 * Resolves and proves the exact Git worktree root that `archctx index seed` will mutate.
 * Fails closed when Git discovery fails (never falling back to `cwd`), when the root has
 * boundary whitespace or control characters, or when caller Git environment overrides
 * disagree with the repository root at that directory (I2).
 */
function resolveCodeGraphSeedRoot(cwd: string, callerEnv: NodeJS.ProcessEnv): string {
  return resolveVerifiedGitRoot(cwd, callerEnv, 'CodeGraph index seed', unsafeCodeGraphDestination, false);
}

function readPrefixBytes(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function assertProvenCodeGraphLockFile(indexDirectory: string, name: string): void {
  const lockPath = join(indexDirectory, name);
  const stat = lstatSync(lockPath, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile()) {
    throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph/${name} must be a regular file, not a symlink or directory. Inspect .codegraph before seeding or running codegraph init.`);
  }
  if (stat.size === 0 || stat.size > CODEGRAPH_LOCK_MAX_BYTES) {
    throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph/${name} does not match the PID lock format and could be unlinked as stale. Inspect .codegraph/${name} before seeding.`);
  }
  let content: string;
  try {
    content = readPrefixBytes(lockPath, CODEGRAPH_LOCK_MAX_BYTES).toString('utf8').trim();
  } catch (error) {
    throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph/${name} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!CODEGRAPH_PID_LOCK_PATTERN.test(content)) {
    throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph/${name} does not match the PID lock format and could be unlinked as stale. Inspect .codegraph/${name} before seeding.`);
  }
}

const CODEGRAPH_DEFAULT_DIR = '.codegraph';
const CODEGRAPH_WSL_DIR = '.codegraph-wsl';
const WSL_WINDOWS_DRIVE_PATTERN = /^\/mnt\/[a-z](\/|$)/i;
const CODEGRAPH_REQUIRED_TABLES = [
  'schema_versions',
  'nodes',
  'edges',
  'files',
  'unresolved_refs',
  'name_segment_vocab',
  'synthesis_inputs',
  'project_metadata',
] as const;
const CODEGRAPH_REQUIRED_NODE_COLUMNS = [
  'id',
  'kind',
  'name',
  'qualified_name',
  'file_path',
  'language',
  'start_line',
  'end_line',
  'start_column',
  'end_column',
  'updated_at',
] as const;

export interface CodeGraphDestinationProbe {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly procVersion?: string;
  /** Optional logical path used only for WSL drive-mount classification in tests (never for filesystem I/O). */
  readonly pathForWslCheck?: string;
  /** True when the caller pins `CODEGRAPH_DIR=.codegraph` (e.g. direct `codegraph init`), false when `CODEGRAPH_DIR` stays unset for `archctx index seed`. */
  readonly pinDefaultDir?: boolean;
}

export type BootstrapWorktreeCodeGraphOptions = ArchctxProviderOptions & {
  readonly destinationProbe?: Omit<CodeGraphDestinationProbe, 'env' | 'pinDefaultDir'>;
};

function isWslRuntime(probe: CodeGraphDestinationProbe): boolean {
  const platform = probe.platform ?? process.platform;
  if (platform !== 'linux') return false;
  const env = probe.env ?? process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  if (probe.procVersion !== undefined) {
    const lower = probe.procVersion.toLowerCase();
    return lower.includes('microsoft') || lower.includes('wsl');
  }
  try {
    const version = readFileSync('/proc/version', 'utf8').toLowerCase();
    return version.includes('microsoft') || version.includes('wsl');
  } catch {
    return false;
  }
}

/**
 * Computes the effective CodeGraph data directory name that pinned CodeGraph 1.6.4
 * (`directory.js:102-117`, `watch-policy.js:47-76`) resolves when `CODEGRAPH_DIR` is unset.
 */
export function effectiveCodeGraphDirName(repoRoot: string, probe: CodeGraphDestinationProbe = {}): string {
  if (probe.pinDefaultDir) return CODEGRAPH_DEFAULT_DIR;
  const wslPath = probe.pathForWslCheck ?? resolve(repoRoot);
  if (!isWslRuntime(probe) || !WSL_WINDOWS_DRIVE_PATTERN.test(wslPath)) return CODEGRAPH_DEFAULT_DIR;
  try {
    if (statSync(join(repoRoot, CODEGRAPH_WSL_DIR)).isDirectory()) return CODEGRAPH_WSL_DIR;
  } catch { /* absent or unreadable */ }
  if (existsSync(join(repoRoot, CODEGRAPH_DEFAULT_DIR, 'codegraph.db'))) return CODEGRAPH_DEFAULT_DIR;
  return CODEGRAPH_WSL_DIR;
}

/**
 * Refuses any existing SQLite sidecar (`-wal`, `-shm`, `-journal`) beside `.codegraph/codegraph.db`.
 * SQLite WAL/SHM salts are not stored in `codegraph.db`, so sidecar ownership cannot be cryptographically
 * bound to the destination database; opening writable WAL mode beside a foreign sidecar could replay
 * foreign frames or overwrite/unlink the user's file (I2).
 */
function assertNoCodeGraphSidecars(indexDirectory: string): void {
  for (const sidecar of CODEGRAPH_SQLITE_SIDECARS) {
    const stat = lstatSync(join(indexDirectory, sidecar), { throwIfNoEntry: false });
    if (stat) {
      throw unsafeCodeGraphDestination(
        `CodeGraph destination .codegraph/${sidecar} is present. Stop active CodeGraph processes or inspect .codegraph/${sidecar} before seeding or running codegraph init.`,
      );
    }
  }
}

/**
 * After our own `index seed` succeeds (preflight already proved no sidecars existed beforehand),
 * quiesce any empty writable-WAL sidecars left behind in `.codegraph/` while `archctx@0.18.4`
 * keeps all read-only CodeGraph opens isolated inside private scratch copies (leaving sidecars
 * intact if another process holds `codegraph.db` open).
 */
function quiesceSeededCodeGraphSidecars(repoRoot: string, nodeExecutable: string, env: NodeJS.ProcessEnv): void {
  const dbPath = join(repoRoot, CODEGRAPH_DEFAULT_DIR, 'codegraph.db');
  const dbStat = lstatSync(dbPath, { throwIfNoEntry: false });
  if (!dbStat?.isFile()) return;
  const walStat = lstatSync(`${dbPath}-wal`, { throwIfNoEntry: false });
  const shmStat = lstatSync(`${dbPath}-shm`, { throwIfNoEntry: false });
  if (!walStat && !shmStat) return;
  if (walStat && (!walStat.isFile() || walStat.size > 0)) return;
  if (shmStat && !shmStat.isFile()) return;
  spawnSync(
    nodeExecutable,
    [
      '--no-warnings',
      '-e',
      'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); try { db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get(); } finally { db.close(); }',
      dbPath,
    ],
    { cwd: repoRoot, env, stdio: 'ignore', timeout: 10_000 },
  );
}

/**
 * Proves on a disposable private temp copy (zero workspace writes, zero `-wal`/`-shm` creation
 * inside `.codegraph/`, plain file path so Linux Bun SQLite without URI support works cleanly)
 * that an existing `codegraph.db` carries pinned CodeGraph 1.6.4's full schema signature. This
 * guarantees both `isInitialized(repoRoot) === true` (blocking parent-directory walk in
 * `codegraph sync`) and CodeGraph ownership (refusing foreign SQLite databases, even ones with
 * a `nodes` table).
 */
function assertProvenCodeGraphDatabase(dbPath: string): void {
  let probeDir: string | undefined;
  let db: Database | undefined;
  try {
    probeDir = mkdtempSync(join(tmpdir(), 'rh-codegraph-probe-'));
    const tempDb = join(probeDir, 'codegraph.db');
    copyFileSync(dbPath, tempDb, fsConstants.COPYFILE_FICLONE);
    chmodSync(tempDb, 0o600);
    db = new Database(tempDb, { create: false });
    db.exec('PRAGMA query_only = ON;');
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
    );
    const missingTables = CODEGRAPH_REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missingTables.length > 0) {
      throw unsafeCodeGraphDestination(
        `CodeGraph destination .codegraph/codegraph.db does not match the pinned CodeGraph 1.6.4 schema (missing tables: ${missingTables.join(', ')}). Inspect .codegraph/codegraph.db before seeding.`,
      );
    }
    const nodeColumns = new Set(
      (db.query('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((row) => row.name),
    );
    const missingColumns = CODEGRAPH_REQUIRED_NODE_COLUMNS.filter((column) => !nodeColumns.has(column));
    if (missingColumns.length > 0) {
      throw unsafeCodeGraphDestination(
        `CodeGraph destination .codegraph/codegraph.db nodes table does not match the pinned CodeGraph 1.6.4 schema (missing columns: ${missingColumns.join(', ')}). Inspect .codegraph/codegraph.db before seeding.`,
      );
    }
    const versionRow = db.query("SELECT 1 AS ok FROM schema_versions WHERE typeof(version) = 'integer' AND version >= 1 LIMIT 1").get();
    if (!versionRow) {
      throw unsafeCodeGraphDestination(
        'CodeGraph destination .codegraph/codegraph.db has no schema_versions entry matching pinned CodeGraph 1.6.4. Inspect .codegraph/codegraph.db before seeding.',
      );
    }
  } catch (error) {
    if (error instanceof ArchctxClientError) throw error;
    throw unsafeCodeGraphDestination(
      `CodeGraph destination .codegraph/codegraph.db failed read-only schema verification: ${error instanceof Error ? error.message : String(error)}. Inspect .codegraph/codegraph.db before seeding.`,
    );
  } finally {
    try {
      db?.close();
    } finally {
      if (probeDir !== undefined) rmSync(probeDir, { recursive: true, force: true });
    }
  }
}

/**
 * Verifies `<repoRoot>/.codegraph` before `archctx index seed` or worktree `codegraph init`.
 * Fails closed when pinned CodeGraph would select another directory (such as `.codegraph-wsl` on
 * WSL Windows drives), or on symlinks, non-directories, occupied directories without `codegraph.db`,
 * non-CodeGraph or schemaless `codegraph.db`, unproven SQLite sidecars, unproven lock or error-log
 * files that pinned CodeGraph could unlink/overwrite, or a `.gitignore` that pinned CodeGraph would rewrite.
 */
export function assertSafeCodeGraphDestination(repoRoot: string, probe: CodeGraphDestinationProbe = {}): void {
  const effectiveDir = effectiveCodeGraphDirName(repoRoot, probe);
  if (effectiveDir !== CODEGRAPH_DEFAULT_DIR) {
    throw unsafeCodeGraphDestination(
      `CodeGraph resolves ${effectiveDir} instead of ${CODEGRAPH_DEFAULT_DIR} for ${repoRoot}; refusing to seed an unchecked destination. Inspect ${CODEGRAPH_DEFAULT_DIR} and ${effectiveDir} (remove ${effectiveDir} if unused), or initialize linked worktrees via guarded rh worktrees start.`,
    );
  }
  const indexDirectory = join(repoRoot, CODEGRAPH_DEFAULT_DIR);
  let dirStat: ReturnType<typeof lstatSync> | undefined;
  try {
    dirStat = lstatSync(indexDirectory, { throwIfNoEntry: false });
  } catch (error) {
    throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!dirStat) return;
  if (!dirStat.isDirectory()) {
    throw unsafeCodeGraphDestination('CodeGraph destination .codegraph must be a regular directory, not a symlink or file. Inspect .codegraph before seeding or running codegraph init.');
  }

  let entries: string[];
  try {
    entries = readdirSync(indexDirectory);
  } catch (error) {
    throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph cannot be listed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const gitignorePath = join(indexDirectory, '.gitignore');
  const gitignoreStat = lstatSync(gitignorePath, { throwIfNoEntry: false });
  if (gitignoreStat) {
    if (!gitignoreStat.isFile()) {
      throw unsafeCodeGraphDestination('CodeGraph destination .codegraph/.gitignore must be a regular file, not a symlink or directory. Inspect .codegraph before seeding or running codegraph init.');
    }
    let content: string;
    try {
      content = readFileSync(gitignorePath, 'utf8');
    } catch (error) {
      throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph/.gitignore is unreadable and would be overwritten: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (codeGraphRewritesGitignore(content)) {
      throw unsafeCodeGraphDestination('CodeGraph destination .codegraph/.gitignore matches the stale-default pattern and would be overwritten. Inspect .codegraph/.gitignore before seeding or running codegraph init.');
    }
  }

  const dbPath = join(indexDirectory, 'codegraph.db');
  const dbStat = lstatSync(dbPath, { throwIfNoEntry: false });
  if (!dbStat) {
    if (entries.length > 0) {
      throw unsafeCodeGraphDestination('CodeGraph destination .codegraph is occupied without codegraph.db. Inspect .codegraph before seeding or running codegraph init.');
    }
    return;
  }
  if (!dbStat.isFile()) {
    throw unsafeCodeGraphDestination('CodeGraph destination .codegraph/codegraph.db must be a regular file, not a symlink or directory. Inspect .codegraph before seeding or running codegraph init.');
  }
  let header: Buffer;
  try {
    header = readPrefixBytes(dbPath, SQLITE_HEADER_MAGIC.length);
  } catch (error) {
    throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph/codegraph.db is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (dbStat.size < SQLITE_HEADER_MIN_BYTES || !header.equals(SQLITE_HEADER_MAGIC)) {
    throw unsafeCodeGraphDestination('CodeGraph destination .codegraph/codegraph.db is not a valid SQLite 3 database. Inspect .codegraph/codegraph.db before seeding.');
  }
  assertNoCodeGraphSidecars(indexDirectory);
  assertProvenCodeGraphDatabase(dbPath);
  for (const lockName of CODEGRAPH_LOCK_FILES) {
    assertProvenCodeGraphLockFile(indexDirectory, lockName);
  }
  for (const entry of entries) {
    if (CODEGRAPH_LOCK_TEMP_PATTERN.test(entry)) {
      assertProvenCodeGraphLockFile(indexDirectory, entry);
    }
  }

  const errorLogPath = join(indexDirectory, 'errors.log');
  const errorLogStat = lstatSync(errorLogPath, { throwIfNoEntry: false });
  if (errorLogStat) {
    if (!errorLogStat.isFile()) {
      throw unsafeCodeGraphDestination('CodeGraph destination .codegraph/errors.log must be a regular file, not a symlink or directory. Inspect .codegraph before seeding.');
    }
    let prefix: string;
    try {
      prefix = readPrefixBytes(errorLogPath, Buffer.byteLength(CODEGRAPH_ERROR_LOG_MARKER, 'utf8')).toString('utf8');
    } catch (error) {
      throw unsafeCodeGraphDestination(`CodeGraph destination .codegraph/errors.log is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (prefix !== CODEGRAPH_ERROR_LOG_MARKER) {
      throw unsafeCodeGraphDestination('CodeGraph destination .codegraph/errors.log is not a CodeGraph error log and could be overwritten or unlinked. Inspect .codegraph/errors.log before seeding.');
    }
  }
}

function hasPrivateCodeGraphIndex(directory: string): boolean {
  return lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === true
    && lstatSync(join(directory, 'codegraph.db'), { throwIfNoEntry: false })?.isFile() === true;
}

function runArchctxIndexSeed(
  repoRoot: string,
  requiredVersion: string,
  timeoutMs: number,
  options: ArchctxProviderOptions,
  processTimeoutMs = timeoutMs,
): IndexSeedResultV1 {
  const env: NodeJS.ProcessEnv = {
    // `archctx index seed` disables shared-base seeding when CODEGRAPH_DIR is set (`index-base.ts:189`).
    ...withoutEnvKeys(sanitizeGitDiscoveryEnv(options.env ?? process.env), CODEGRAPH_SEED_STRIPPED_ENV_KEYS),
    CODEGRAPH_FORCE_WATCH: '1',
  };
  assertSafeArchctxRepoRoot(repoRoot, env, 'CodeGraph index seed');
  assertSafeCodeGraphDestination(repoRoot, { env });
  const envelope = new ArchctxClient(repoRoot, requiredVersion, { ...options, env }).json(
    ['index', 'seed', '--timeout-ms', String(timeoutMs), '--json'],
    processTimeoutMs,
  );
  if (!isRecord(envelope) || envelope.requestId !== 'index.seed') {
    throw new ArchctxClientError({
      code: 'RH_ARCHCTX_INDEX_SEED_INVALID',
      action: 'update-repo-harness',
      reasonCode: 'index-seed-invalid',
      message: 'archctx index seed returned an unexpected requestId',
    });
  }
  const decoded = decodeIndexSeedResult(envelope.data);
  if (!options.run) {
    quiesceSeededCodeGraphSidecars(repoRoot, resolveCompatibleNodeRuntime(env, options.trustedNodeCandidateSource), env);
  }
  return decoded;
}

/** Called after the primary checkout and plugin have opted into CodeGraph. */
export function bootstrapWorktreeCodeGraph(primaryRoot: string, worktreeRoot: string, options: BootstrapWorktreeCodeGraphOptions = {}): void {
  const env: NodeJS.ProcessEnv = {
    ...withoutEnvKeys(sanitizeGitDiscoveryEnv(options.env ?? process.env), [
      ...CODEGRAPH_SEED_STRIPPED_ENV_KEYS,
      'CODEGRAPH_NO_DOWNLOAD',
      'DO_NOT_TRACK',
    ]),
    CODEGRAPH_NO_DOWNLOAD: '1',
    CODEGRAPH_FORCE_WATCH: '1',
    DO_NOT_TRACK: '1',
  };
  // Refuse leading/trailing-whitespace checkout roots before upstream archctx trims Git output onto a sibling checkout (I2).
  assertSafeArchctxRepoRoot(primaryRoot, env, 'CodeGraph primary checkout');
  assertSafeArchctxRepoRoot(worktreeRoot, env, 'CodeGraph worktree');
  const policy = options.policy ?? readArchitectureProjectionPolicy({ architecture: DEFAULT_GLOBAL_ARCHITECTURE });
  const indexDirectory = join(worktreeRoot, '.codegraph');
  const destinationProbe: CodeGraphDestinationProbe = { ...options.destinationProbe, env };
  const runtimePlatform = options.destinationProbe?.platform ?? process.platform;
  const wslPath = destinationProbe.pathForWslCheck ?? resolve(worktreeRoot);

  // On WSL /mnt/<drive>, ordinary CodeGraph readers prefer `.codegraph-wsl` whenever it exists; refuse that layout instead of writing an unconsulted `.codegraph`.
  if (isWslRuntime(destinationProbe) && WSL_WINDOWS_DRIVE_PATTERN.test(wslPath)) {
    if (lstatSync(join(worktreeRoot, CODEGRAPH_WSL_DIR), { throwIfNoEntry: false })) {
      throw unsafeCodeGraphDestination(
        `CodeGraph destination ${CODEGRAPH_WSL_DIR} already exists on this WSL drive mount; ordinary CodeGraph readers prefer ${CODEGRAPH_WSL_DIR} over ${CODEGRAPH_DEFAULT_DIR}. Inspect or remove ${CODEGRAPH_WSL_DIR} before bootstrapping the worktree.`,
      );
    }
  }

  // Validate `.codegraph` up front with pinDefaultDir: true so WSL /mnt/<drive> worktrees without `.codegraph-wsl` fall through cleanly to pinned `codegraph init`.
  assertSafeCodeGraphDestination(worktreeRoot, { ...destinationProbe, pinDefaultDir: true });

  if (runtimePlatform !== 'win32' && effectiveCodeGraphDirName(worktreeRoot, destinationProbe) === CODEGRAPH_DEFAULT_DIR) {
    // Only refresh primary when it already has a private CodeGraph index; never init primary.
    if (hasPrivateCodeGraphIndex(join(primaryRoot, '.codegraph'))) {
      try {
        runArchctxIndexSeed(primaryRoot, policy.requiredVersion, policy.timeoutMs, { ...options, env, policy });
      } catch (error) {
        reportBootstrapSyncFailure('CodeGraph base refresh', error);
      }
    }
    const linkedTimeoutMs = Math.min(policy.timeoutMs, CODEGRAPH_INDEX_SEED_LINKED_TIMEOUT_MS);
    const linkedProcessTimeoutMs = Math.max(policy.timeoutMs, linkedTimeoutMs + 15_000);
    try {
      runArchctxIndexSeed(worktreeRoot, policy.requiredVersion, linkedTimeoutMs, { ...options, env, policy }, linkedProcessTimeoutMs);
      if (!hasPrivateCodeGraphIndex(indexDirectory)) {
        throw new Error('archctx index seed did not create a worktree index');
      }
      return;
    } catch (error) {
      const fallbackEligible = error instanceof ArchctxClientError
        && error.code === 'AC_CODE_FACTS_UNAVAILABLE'
        && (error.reasonCode === 'index-missing' || error.reasonCode === 'index-base-building');
      if (!fallbackEligible) throw error;
      reportBootstrapSyncFailure('CodeGraph shared-base seed', error);
    }
  }

  // Init writes the ignore file and SQLite sidecars. Re-check safety and refuse an existing database.
  assertSafeCodeGraphDestination(worktreeRoot, { ...destinationProbe, pinDefaultDir: true });
  if (lstatSync(join(indexDirectory, 'codegraph.db'), { throwIfNoEntry: false })) {
    throw unsafeCodeGraphDestination('CodeGraph destination .codegraph already contains codegraph.db. Inspect .codegraph before running codegraph init.');
  }
  console.error('[ContractWorktree] Running CodeGraph init in the worktree');
  indexPackageLocalCodeGraph(worktreeRoot, { ...options, env: { ...env, CODEGRAPH_DIR: '.codegraph' }, policy });
  if (!hasPrivateCodeGraphIndex(indexDirectory)) throw new Error('codegraph init did not create a worktree index');
  const resolvedAfterInit = effectiveCodeGraphDirName(worktreeRoot, destinationProbe);
  if (resolvedAfterInit !== CODEGRAPH_DEFAULT_DIR) {
    throw unsafeCodeGraphDestination(
      `CodeGraph resolves ${resolvedAfterInit} instead of ${CODEGRAPH_DEFAULT_DIR} after worktree init; ordinary CodeGraph readers would bypass the new worktree index.`,
    );
  }
}

function reportBootstrapSyncFailure(step: string, error: unknown): void {
  const reason = error instanceof ArchctxClientError ? error.reasonCode ?? error.code : '';
  console.error(`[ContractWorktree] ${step} did not complete${/^[a-zA-Z0-9_-]+$/.test(reason) ? ` (${reason})` : ''}`);
}

/**
 * Builds the CodeGraph index of a checkout with the CodeGraph package that the
 * package-local archctx declares. It never uses a global binary or a download.
 */
export function indexPackageLocalCodeGraph(checkoutRoot: string, options: ArchctxProviderOptions = {}): void {
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  if (policy.provider === 'disabled') throw new Error('architecture projection provider is disabled');
  const binaryPath = resolvePackageLocalCodeGraph(resolvePackageLocalArchctx(options.consumerRoot, policy.requiredVersion));
  const env: NodeJS.ProcessEnv = {
    ...withoutEnvKeys(options.env ?? process.env, [
      ...CODEGRAPH_SEED_STRIPPED_ENV_KEYS,
      'CODEGRAPH_NO_DOWNLOAD',
      'CODEGRAPH_TELEMETRY',
      'DO_NOT_TRACK',
    ]),
    CODEGRAPH_DIR: '.codegraph',
    CODEGRAPH_NO_DOWNLOAD: '1',
    CODEGRAPH_FORCE_WATCH: '1',
    CODEGRAPH_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  };
  const args = CODEGRAPH_INIT_ARGS;
  const result = options.run
    ? options.run(binaryPath, args, { cwd: checkoutRoot, timeoutMs: policy.timeoutMs, env })
    : DEFAULT_RUNNER(resolveCompatibleNodeRuntime(env, options.trustedNodeCandidateSource), [binaryPath, ...args], { cwd: checkoutRoot, timeoutMs: policy.timeoutMs, env });
  if (result.timedOut || result.signal || result.error || result.status !== 0) {
    const outcome = result.timedOut ? 'timed out' : result.signal ? `signal ${result.signal}` : result.error ? 'process failed' : `exit ${result.status}`;
    throw new ArchctxClientError({ code: 'RH_CODEGRAPH_INDEX_FAILED', action: 'inspect-codegraph-index', reasonCode: 'codegraph-init-failed', details: { checkout: checkoutRoot }, message: `codegraph init in ${checkoutRoot} ${outcome}: ${result.stderr.trim().slice(-2000)}` });
  }
}

function resolvePackageLocalCodeGraph(archctx: ResolvedArchctxPackage): string {
  const name = '@colbymchenry/codegraph';
  const archctxManifest = join(archctx.packageRoot, 'package.json');
  const declared = (parseJsonText(readFileSync(archctxManifest, 'utf8'), archctxManifest) as { dependencies?: Record<string, unknown> }).dependencies?.[name];
  if (typeof declared !== 'string') throw new Error(`package-local archctx@${archctx.version} does not declare ${name}`);
  const packageRoot = dirname(resolvePackageManifest(join(archctx.packageRoot, 'package.json'), name, `package-local ${name}@${declared} is missing from the archctx dependency tree rooted at ${archctx.packageRoot}`));
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = parseJsonText(readFileSync(manifestPath, 'utf8'), manifestPath) as { name?: unknown; version?: unknown; bin?: unknown };
  if (manifest.name !== name || manifest.version !== declared) throw new ArchctxClientError({ code: 'RH_ARCHCTX_PACKAGE_MISMATCH', action: 'update-repo-harness', message: `package-local CodeGraph mismatch: archctx declares ${name}@${declared}, got ${String(manifest.name)}@${String(manifest.version)}` });
  const bin = isRecord(manifest.bin) && typeof manifest.bin.codegraph === 'string' ? manifest.bin.codegraph : null;
  if (!bin) throw new Error(`package-local ${name}@${declared} does not declare bin.codegraph`);
  const realPackage = realpathSync(packageRoot);
  const realBinary = realpathSync(resolve(packageRoot, bin));
  if (!realBinary.startsWith(`${realPackage}${sep}`)) throw new Error('package-local CodeGraph binary escapes its package root');
  return realBinary;
}

const PROJECTION_WRITE_RECONCILE_GUIDANCE =
  'outcome unknown. Run rh arch projection check --json and git diff to reconcile before authorizing a fresh apply.';

/**
 * Structured `archctx@0.18.4` error codes emitted exclusively before `changeSetEngine.apply`
 * writes files. Never include `AC_UNCLASSIFIED_FAILURE`, `AC_RUNTIME_UNAVAILABLE`,
 * or unvetted codes that can surface after partial or committed writes.
 */
const PRE_WRITE_PROJECTION_ERROR_CODES = new Set<string>([
  'AC_REPO_NOT_FOUND',
  'AC_RUNTIME_VERSION_UNSUPPORTED',
  'AC_NODE_VERSION_UNSUPPORTED',
  'AC_CODEGRAPH_UNAVAILABLE',
  'AC_CODE_FACTS_UNAVAILABLE',
  'AC_CODE_FACTS_NOT_READY',
  'AC_MODEL_ADOPTION_REQUIRED',
  'AC_POLICY_VIOLATION',
  'AC_PATH_DENIED',
  'AC_USER_CONFIRMATION_REQUIRED',
  'AC_CAPABILITY_UNSUPPORTED',
]);

/** `AC_SCHEMA_INVALID` reasons proven pre-write (explicitly excludes post-write `projection-result-invalid`). */
const PRE_WRITE_PROJECTION_SCHEMA_REASONS = new Set<string>([
  'projection-input-invalid',
  'projection-adoption-profile-invalid',
  'projection-adoption-approval-input-invalid',
  'plan-input-invalid',
  'apply-input-invalid',
  'constraint-model-invalid',
  'state-machine-model-invalid',
  'cli-input-invalid',
  'product-id-invalid',
  'workspace-exports-unsupported',
]);

/** `AC_PRECONDITION_FAILED` reasons proven pre-write (explicitly excludes post-write `changeset-rollback-conflict`). */
const PRE_WRITE_PROJECTION_PRECONDITION_REASONS = new Set<string>([
  'projection-snapshot-mismatch',
  'projection-inputs-changed-during-run',
  'projection-manifest-upgrade-required',
  'projection-manifest-invalid',
  'projection-manifest-incompatible',
  'architecture-model-ignored',
  'projection-footprint-uncovered',
  'projection-ownership-repair-required',
  'projection-orphan-review-required',
  'projection-adoption-refused',
  'projection-adoption-preimage-missing',
  'projection-adoption-preview-mismatch',
  'projection-adoption-fixed-point-unproven',
  'projection-accepted-fixed-point-unproven',
  'projection-ambiguous-ownership',
  'plan-worktree-changed',
  'plan-model-invalid',
  'apply-repository-mismatch',
  'apply-draft-missing',
  'apply-profile-missing',
  'apply-profile-changed',
  'apply-worktree-changed',
  'apply-head-changed',
  'apply-model-invalid',
  'apply-model-changed',
  'apply-preimage-changed',
  'runtime-writer-locked',
  'runtime-writer-owned',
]);

function isProvenPreWriteProjectionRefusal(error: ArchctxClientError): boolean {
  if (PRE_WRITE_PROJECTION_ERROR_CODES.has(error.code)) return true;
  if (error.code === 'AC_SCHEMA_INVALID') {
    return error.reasonCode !== undefined && PRE_WRITE_PROJECTION_SCHEMA_REASONS.has(error.reasonCode);
  }
  if (error.code === 'AC_PRECONDITION_FAILED') {
    return error.reasonCode !== undefined && PRE_WRITE_PROJECTION_PRECONDITION_REASONS.has(error.reasonCode);
  }
  return false;
}

function runProjectionCommand(request: ProjectionRequestV1, repoRoot: string, options: ArchctxProviderOptions): ProjectionResultV3 {
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  const writeMode = request.mode === 'apply' || request.mode === 'adopt';
  if (writeMode && policy.applyMode === 'disabled') throw new Error('architecture projection apply is disabled');
  archctxCapabilities(repoRoot, { ...options, policy });
  const client = new ArchctxClient(repoRoot, policy.requiredVersion, options);
  // Pre-launch deadline and runtime checks stay distinct from started write mutations.
  remainingTimeout(options, policy.timeoutMs, 'archctx projection run');
  if (!options.run) {
    resolveCompatibleNodeRuntime(options.env ?? process.env, options.trustedNodeCandidateSource);
  }
  try {
    const data = client.data(['projection', 'run', '--request-json', JSON.stringify(request)], policy.timeoutMs);
    return assertProjectionResult(data, request.requestId);
  } catch (error) {
    if (!writeMode) throw error;
    if (error instanceof ArchctxClientError && (
      error.code === 'RH_ARCHCTX_LAUNCH_FAILED'
      || isProvenPreWriteProjectionRefusal(error)
      || (error.code === 'RH_ARCHCTX_TIMEOUT' && error.providerMessage.startsWith('architecture projection timeout before '))
    )) {
      throw error;
    }
    const code = error instanceof ArchctxClientError ? error.code : 'RH_ARCHCTX_WRITE_OUTCOME_UNKNOWN';
    const detail = error instanceof ArchctxClientError
      ? error.providerMessage
      : error instanceof Error ? error.message : String(error);
    throw new ArchctxClientError({
      code,
      action: 'reconcile-projection-state',
      message: `${detail}; ${PROJECTION_WRITE_RECONCILE_GUIDANCE}`,
    });
  }
}

export function remainingTimeout(options: Pick<ArchctxProviderOptions, 'deadlineMs' | 'nowMs'>, maximumMs: number, phase: string): number {
  if (options.deadlineMs === undefined) return maximumMs;
  const remaining = Math.floor(options.deadlineMs - (options.nowMs ?? Date.now)());
  if (remaining <= 0) throw new ArchctxClientError({ code: 'RH_ARCHCTX_TIMEOUT', action: 'retry', message: `architecture projection timeout before ${phase}` });
  return Math.min(maximumMs, remaining);
}

function resolvePackageManifest(base: string, name: string, missingMessage: string): string {
  try { return createRequire(base).resolve(`${name}/package.json`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') throw new ArchctxClientError({ code: 'RH_ARCHCTX_PACKAGE_MISSING', action: 'update-repo-harness', message: missingMessage });
    throw error;
  }
}

export function capabilitySource(repoRoot: string): ArchitectureProjectionReadinessV1['modelAuthority']['source'] {
  const policy = readWorkflowPolicyDocument(repoRoot);
  if (!policy.present) return 'unadopted';
  const context = policy.rootIsObject ? policyValue(policy, 'context') : POLICY_ABSENT;
  const source = isPolicyObject(context) ? policyValue(policy, 'context.capability_source') : POLICY_ABSENT;
  return source === 'archcontext' ? 'archcontext' : 'registry';
}

function parseJson(result: ArchctxProcessResult, label: string): unknown {
  try { return JSON.parse(result.stdout); } catch (error) {
    if (label !== 'archctx resolve') throw new Error(`${label} returned corrupt JSON`);
    // Resolve output contains paths and owners. Keep bounded evidence without argv.
    const stdout = Buffer.from(result.stdout, 'utf8');
    const stderr = Buffer.from(result.stderr, 'utf8');
    throw new ArchctxClientError({
      code: 'RH_ARCHCTX_RESOLVE_CORRUPT_JSON',
      action: 'retry',
      message: `${label} returned corrupt JSON; exit ${result.status}; stdout bytes ${stdout.length}`
        + `; stdout head ${JSON.stringify(stdout.subarray(0, 128).toString('utf8'))}`
        + `; stdout tail ${JSON.stringify(stdout.subarray(-128).toString('utf8'))}`
        + `; stderr tail ${JSON.stringify(stderr.subarray(-128).toString('utf8'))}`
        + `; parse error ${JSON.stringify((error as Error).message.slice(0, 160))}`,
    });
  }
}
