import * as fs from 'fs';
import * as path from 'path';
import { getRoute, routeSupportsHost, type HookEvent, type HookHandlerId, type RouteHost, type RouteId } from './route-registry';
import { AntigravityToolInputError, HOST_ADAPTERS, antigravityEnvironment, resolveAntigravityRepository } from './host-adapter';
import { getHandlerForRoute } from './handler-registry';
import { budgetSessionContext, errorHash } from './session-context-budget';
import { writeAllSync } from '../../effects/write-all-sync';
import {
  createStateInputCollector,
  type EffectiveStateResolution,
} from '../../effects/loop/state-input-collector';
import { createHookEventTelemetry } from './event-telemetry';
import {
  resolveEffectiveStateReadOnly,
  StateResolutionUnstableError,
} from '../../effects/state/resolve-effective-state';
import type { EffectiveState } from '../../core/state/types';
import type { HookHandlerResult, HookPermission } from './handler-contract';
import { HookPayloadError, hookIdentity, payloadString, type HookIdentity, type HookPayload } from './hook-input';
import type { HookOutcome } from './hook-protocol';
import { WORKFLOW_CONTRACT_MARKER_PATH, WORKFLOW_MARKER_GATE_EVENTS } from '../../core/adoption/minimum-harness-version';
import { inspectWorkflowMarker } from '../../effects/adoption/workflow-marker';
import { gitExecFileSync } from '../../effects/git/runner';

export const HOOK_COMMAND_NAME = 'repo-harness-hook';
const HOOK_HOSTS = Object.keys(HOST_ADAPTERS);

export interface RunHookOptions {
  readonly event: HookEvent;
  readonly routeId: RouteId;
  readonly cwd?: string;
  readonly input?: string | Buffer;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunHookResult {
  readonly exitCode: number;
  readonly reason: string;
  readonly repoRoot?: string;
  readonly handler?: HookHandlerId;
}

export function resolveRepoRoot(cwd: string): string | null {
  try {
    const out = gitExecFileSync(['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The managed command already ran `git rev-parse --show-toplevel` in the hook
 * cwd and exported the result, so a managed call spawns no second git. A
 * direct call without `HOOK_REPO_ROOT` resolves from its cwd.
 */
export function resolveHookRepoRoot(cwd: string, env: NodeJS.ProcessEnv): string | null {
  const explicit = env.HOOK_REPO_ROOT?.trim();
  if (!explicit) return resolveRepoRoot(cwd);
  try {
    return fs.realpathSync(explicit);
  } catch {
    return null;
  }
}

/**
 * The repository opt-in decision. The managed host command repeats this test
 * in sh so that a repository without the marker never starts the hook bin.
 */
export function isOptIn(repoRoot: string): boolean {
  return fs.existsSync(path.join(repoRoot, WORKFLOW_CONTRACT_MARKER_PATH));
}

const EFFECTIVE_STATE_RESOLUTION_MAX_ATTEMPTS = 3;

/**
 * The transient throw signature of the read-only resolution: the stability
 * contract's re-read exhaustion under concurrent authority writes. A bounded
 * retry can clear it. The read-only resolution takes no lock, so lock
 * contention cannot reach this classifier. It checks the error type, never
 * message text.
 */
function isTransientResolutionInstability(error: unknown): boolean {
  return error instanceof StateResolutionUnstableError;
}

type EffectiveStateResolver = (repoRoot: string, nowMs: number) => EffectiveState;

/**
 * The single Effective State policy for every hook event: the read-only
 * resolution, one timestamp, at most three attempts for transient instability,
 * and a hashed failure that each handler renders in its own advisory. A hook
 * writes no state. It reports the last published `state_version`; only
 * `rh state resolve` publishes one.
 */
export function resolveHookEffectiveState(
  repoRoot: string,
  nowMs: number,
  resolve: EffectiveStateResolver = resolveEffectiveStateReadOnly,
): EffectiveStateResolution {
  let failure: unknown = null;
  for (let attempt = 1; attempt <= EFFECTIVE_STATE_RESOLUTION_MAX_ATTEMPTS; attempt += 1) {
    try {
      return { ok: true, state: resolve(repoRoot, nowMs) };
    } catch (error) {
      failure = error;
      if (!isTransientResolutionInstability(error)) break;
    }
  }
  return {
    ok: false,
    reason_code: isTransientResolutionInstability(failure) ? 'state_resolution_unstable' : 'state_resolution_failed',
    error_hash: errorHash(failure),
    message: failure instanceof Error ? failure.message : String(failure),
  };
}

function hostFrom(env: NodeJS.ProcessEnv): RouteHost | null {
  const host = env.HOOK_HOST;
  return host && Object.hasOwn(HOST_ADAPTERS, host) ? host as RouteHost : null;
}

function writeText(fd: 1 | 2, value: string): void {
  if (value) writeAllSync(fd, value);
}

function outcomeReason(result: HookHandlerResult): string {
  if (result.reason) return result.reason;
  if (result.exitCode === 0) return result.permission?.decision === 'deny' ? 'blocked' : 'ok';
  return result.exitCode === 2 ? 'blocked' : 'handler-exit';
}

export function runHook(opts: RunHookOptions): RunHookResult {
  const inputEnv = opts.env ?? process.env;
  const route = getRoute(opts.event, opts.routeId);
  const host = hostFrom(inputEnv);
  if (!host) {
    writeText(2, `${HOOK_COMMAND_NAME}: HOOK_HOST must be one of ${HOOK_HOSTS.join(', ')}\n`);
    return { exitCode: route?.failClosed ? 2 : 1, reason: 'unknown-host' };
  }
  const adapter = HOST_ADAPTERS[host];
  const antigravity = host === 'antigravity';
  const env = antigravity ? antigravityEnvironment(inputEnv) : inputEnv;
  const emit = (outcome: HookOutcome): number => {
    const output = adapter.render(outcome);
    writeText(2, output.stderr);
    writeText(1, output.stdout);
    return output.exitCode;
  };
  const early = (code: number, reason: string, repoRoot: string | null, diagnostics = '', permission?: HookPermission): RunHookResult => {
    const exitCode = emit({
      event: opts.event, routeId: opts.routeId, repoRoot, exitCode: code, reason, additionalContext: null, diagnostics, permission,
    });
    return { exitCode, reason, ...(repoRoot ? { repoRoot } : {}) };
  };

  let repoRoot: string;
  let payload: HookPayload | undefined;
  if (antigravity) {
    try {
      payload = adapter.decode(opts.input, opts);
    } catch (error) {
      const permission = error instanceof AntigravityToolInputError ? { decision: 'deny' as const, reason: error.message } : undefined;
      return early(1, 'invalid-payload', null, '', permission);
    }
    try {
      const repository = resolveAntigravityRepository(payload);
      if (repository.status !== 'opted-in') return early(0, repository.status, repository.repoRoot);
      repoRoot = repository.repoRoot;
      payload = { ...payload, cwd: repository.cwd };
    } catch {
      return early(1, 'repo-lookup-failed', null);
    }
  } else {
    const resolved = resolveHookRepoRoot(opts.cwd ?? process.cwd(), env);
    if (!resolved) return early(0, 'not-in-git-repo', null);
    if (!isOptIn(resolved)) return early(0, 'non-opt-in', resolved);
    repoRoot = resolved;
  }
  const repair = `Run rh install --target ${host} --location global.`;
  if (!route) {
    return early(2, 'unknown-route', repoRoot, `${HOOK_COMMAND_NAME}: unknown route ${opts.event}.${opts.routeId}. ${repair}\n`);
  }
  if (!routeSupportsHost(route, host)) {
    return early(2, 'unsupported-host-route', repoRoot,
      `${HOOK_COMMAND_NAME}: unsupported-host-route: ${opts.event}.${opts.routeId} is not installed for ${host}. ${repair}\n`);
  }
  // Session and turn events report the gate with exit 1, which does not block. Tool events skip it, so every guard still runs.
  const markerGate = WORKFLOW_MARKER_GATE_EVENTS.has(opts.event) ? inspectWorkflowMarker(repoRoot) : null;
  if (markerGate) return early(1, markerGate.code, repoRoot, `${HOOK_COMMAND_NAME}: ${markerGate.message}\n`);

  const handler = getHandlerForRoute(route);
  const telemetry = createHookEventTelemetry({ repoRoot, event: opts.event, routeId: opts.routeId, pathValue: env.PATH });
  const now = new Date();
  const collector = createStateInputCollector({
    repoRoot,
    resolveEffectiveState: () =>
      resolveHookEffectiveState(repoRoot, now.getTime()),
  });

  let identity: HookIdentity = { host, sessionId: null, runId: null, turnId: null };
  let shellCommand = '';
  let result: HookHandlerResult;
  let reason: string;
  try {
    payload ??= adapter.decode(opts.input, opts);
    identity = hookIdentity(payload, host);
    if (!antigravity && opts.event === 'PreToolUse') shellCommand = payloadString(payload, 'tool_input.command');
    result = handler.run({ event: opts.event, repoRoot, payload, identity, env, now, collector });
    reason = outcomeReason(result);
  } catch (error) {
    reason = error instanceof HookPayloadError ? 'invalid-payload' : 'handler-failed';
    // A crash of an admission route must not admit the tool call: hosts read
    // only exit 2 as a block. The text is fixed: an exception message can
    // carry a path or a value from the command (#3267).
    result = {
      exitCode: route.failClosed ? 2 : 1,
      diagnostics: `${HOOK_COMMAND_NAME}: ${handler.id} failed (${reason})\n`,
    };
  }

  const additionalContext = result.sessionContexts
    ? budgetSessionContext(result.sessionContexts) || null
    : result.additionalContext ?? null;
  const exitCode = emit({
    event: opts.event,
    routeId: opts.routeId,
    repoRoot,
    exitCode: result.exitCode,
    reason,
    permission: result.permission,
    additionalContext,
    systemMessage: result.systemMessage,
    diagnostics: result.diagnostics ?? '',
  });
  telemetry.finalize({
    identity,
    exitCode,
    blocked: result.exitCode === 2 || result.permission?.decision === 'deny',
    reason,
    command: shellCommand,
  });
  return { exitCode, reason, repoRoot, handler: handler.id };
}
