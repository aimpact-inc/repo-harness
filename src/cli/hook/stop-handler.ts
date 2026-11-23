/** Stop publishes the evidence checkpoint and reports notices; it never grants publication permission. */
import { HOST_ADAPTERS } from './host-adapter';
import { readAntigravityTranscript } from '../../effects/board/antigravity-transcript';
import { collectArchitectureNotice } from './hook-protocol';
import { collectProtectedPathNotice } from './protected-path-notice';
import { publishCheckpointFromLedger } from '../../effects/evidence/checkpoint-store';
import type { StateInputCollector } from '../../effects/loop/state-input-collector';
import { resolveCapabilityOwnership } from '../../effects/state/resolve-effective-state';
import { payloadString, payloadValue, type HookIdentity, type HookPayload } from './hook-input';
import { SEAT_RESET_CONTEXT_TOKENS, seatResetAction, seatResetIdentity, seatResetReason } from '../../core/board/seat-reset';
import { readTranscriptUsage, seatResetRequestState, writeSeatResetRequest } from '../../effects/board/seat-reset';

export type StopCollector = Pick<StateInputCollector, 'getRepoRoot'>;

export interface StopHandlerDependencies {
  readonly now?: () => Date;
}

export interface StopHandlerInput {
  readonly collector: StopCollector;
  readonly payload: HookPayload;
  readonly identity: HookIdentity;
  readonly env?: NodeJS.ProcessEnv;
  readonly dependencies?: StopHandlerDependencies;
}

export interface StopHandlerResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly systemMessage?: string;
  /** The hook event log reason; the runtime records it in `hook-events.jsonl`. */
  readonly reason?: string;
}

/**
 * Stop publishes the evidence checkpoint, then reports changes under _ops/ and
 * _ref/ that no edit guard decision covered. A failed publish must not block
 * the turn: the next Stop publishes again from the same ledger.
 */
export function runStopHandler(opts: StopHandlerInput): StopHandlerResult {
  const repoRoot = opts.collector.getRepoRoot();
  const env = opts.env ?? process.env;
  const dependencies = opts.dependencies ?? {};
  const now = dependencies.now?.() ?? new Date();
  const stopHookActive = payloadValue(opts.payload, 'stop_hook_active');
  if (stopHookActive === true || stopHookActive === 'true') {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  try { publishCheckpointFromLedger(repoRoot, () => now); } catch { /* a failed publish never blocks the turn */ }
  const { handoff } = HOST_ADAPTERS[opts.identity.host].capabilities;
  if (!handoff) return codexNotices(repoRoot, env);
  const reset = seatReset(opts.payload, env, now, handoff, opts.identity.host);
  if ('block' in reset) return reset.block;
  return handoff === 'relaunch' ? codexNotices(repoRoot, env) : claudeNotices(repoRoot, env, reset.notices);
}

interface StopNotice {
  readonly content?: string;
  readonly systemMessage?: string;
  readonly diagnostics?: string;
}

/**
 * A reset seat at the threshold records a request and asks for a handoff. Claude
 * asks once per session segment. Antigravity repeats an open request once per
 * user turn until the peer releases it or the seat starts a new segment.
 */
function seatReset(payload: HookPayload, env: NodeJS.ProcessEnv, now: Date, handoff: 'compact-or-clear' | 'relaunch', host: HookIdentity['host']): { readonly block: StopHandlerResult } | { readonly notices: readonly StopNotice[] } {
  const relaunch = handoff === 'relaunch';
  const resetHost = host === 'codex' ? 'claude' : host;
  try {
    const identity = seatResetIdentity(env);
    const transcript = payloadString(payload, 'transcript_path');
    if (identity === null || transcript === '') return { notices: [] };
    const request = seatResetRequestState(identity, transcript);
    if (request === 'released' || (request === 'open' && !relaunch)) return { notices: [] };
    const usage = relaunch
      ? readAntigravityTranscript(payloadString(payload, 'session_id'), transcript, env)
      : readTranscriptUsage(transcript);
    if (!usage || usage.contextTokens === null || usage.contextTokens < SEAT_RESET_CONTEXT_TOKENS) return { notices: [] };
    const { contextTokens, bytes } = usage;
    const action = seatResetAction(bytes, resetHost);
    if (request === 'absent') writeSeatResetRequest(identity, now, { contextTokens, transcriptPath: transcript, transcriptBytes: bytes, action,
      host: resetHost });
    const message = seatResetReason(identity, contextTokens, bytes, action, resetHost);
    return { block: { exitCode: 2, stdout: '', stderr: `${message}\n` } };
  } catch (error) {
    return { notices: relaunch ? [] : [{ systemMessage: `repo-harness: seat reset skipped: ${(error as Error).message}` }] };
  }
}

/** The architecture and protected path notices fail independently. A quiet architecture failure is logged, not shown. */
function claudeNotices(repoRoot: string, env: NodeJS.ProcessEnv, extra: readonly StopNotice[]): StopHandlerResult {
  const architecture = collectArchitectureNotice(repoRoot, options => resolveCapabilityOwnership(repoRoot, undefined, options), { env });
  const notices: StopNotice[] = [architecture, collectProtectedPathNotice(repoRoot, env), ...extra];
  const joined = (field: 'content' | 'systemMessage') => notices.map(notice => notice[field]).filter(Boolean).join('\n');
  const systemMessage = joined('systemMessage');
  return {
    exitCode: 0,
    stdout: joined('content'),
    stderr: notices.map(notice => notice.diagnostics ?? '').join(''),
    ...(systemMessage ? { systemMessage } : {}),
    ...(architecture.logReason ? { reason: architecture.logReason } : {}),
  };
}

/** Codex Stop writes no stdout, so the protected path report is one operator line on stderr. */
function codexNotices(repoRoot: string, env: NodeJS.ProcessEnv): StopHandlerResult {
  const notice = collectProtectedPathNotice(repoRoot, env);
  const line = notice.systemMessage ? `repo-harness: ${notice.systemMessage}\n` : '';
  return { exitCode: 0, stdout: '', stderr: `${notice.diagnostics ?? ''}${line}` };
}
