/** Stop publishes the evidence checkpoint and reports notices; it never grants publication permission. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'fs';
import { isAbsolute, join, normalize, relative, sep } from 'path';
import { ANTIGRAVITY_HANDOFF, HOST_ADAPTERS } from './host-adapter';
import { collectArchitectureNotice } from './hook-protocol';
import { collectProtectedPathNotice } from './protected-path-notice';
import { publishCheckpointFromLedger } from '../../effects/evidence/checkpoint-store';
import type { StateInputCollector } from '../../effects/loop/state-input-collector';
import { resolveCapabilityOwnership } from '../../effects/state/resolve-effective-state';
import { payloadString, payloadValue, type HookIdentity, type HookPayload } from './hook-input';
import { SEAT_RESET_CONTEXT_TOKENS, seatResetAction, seatResetIdentity, seatResetReason } from '../../core/board/seat-reset';
import { readTranscriptUsage, seatResetRequested, writeSeatResetRequest, type TranscriptUsage } from '../../effects/board/seat-reset';
import { requireHome } from '../../effects/repo-harness-home';

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
 * user turn until the seat relaunches.
 */
function seatReset(payload: HookPayload, env: NodeJS.ProcessEnv, now: Date, handoff: 'compact-or-clear' | 'relaunch', host: HookIdentity['host']): { readonly block: StopHandlerResult } | { readonly notices: readonly StopNotice[] } {
  const relaunch = handoff === 'relaunch';
  const resetHost = host === 'antigravity' ? 'antigravity' : host === 'pi' ? 'pi' : 'claude';
  try {
    const identity = seatResetIdentity(env);
    const transcript = payloadString(payload, 'transcript_path');
    if (identity === null || transcript === '') return { notices: [] };
    const open = seatResetRequested(identity, transcript);
    if (open && !relaunch) return { notices: [] };
    const usage = relaunch ? readAntigravityTranscript(payload, env) : readTranscriptUsage(transcript);
    if (!usage || usage.contextTokens === null || usage.contextTokens < SEAT_RESET_CONTEXT_TOKENS) return { notices: [] };
    const { contextTokens, bytes } = usage;
    const action = relaunch ? 'reset' : seatResetAction(bytes);
    if (!open) writeSeatResetRequest(identity, now, { contextTokens, transcriptPath: transcript, transcriptBytes: bytes, action,
      host: resetHost });
    const message = relaunch ? ANTIGRAVITY_HANDOFF : seatResetReason(identity, contextTokens, bytes, action, resetHost === 'pi' ? 'pi' : 'claude');
    return { block: { exitCode: 2, stdout: '', stderr: `${message}\n` } };
  } catch (error) {
    return { notices: relaunch ? [] : [{ systemMessage: `repo-harness: seat reset skipped: ${(error as Error).message}` }] };
  }
}

function readAntigravityTranscript(payload: HookPayload, env: NodeJS.ProcessEnv): TranscriptUsage | null {
  const id = payloadValue(payload, 'session_id');
  const transcript = payloadString(payload, 'transcript_path');
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id) || !isAbsolute(transcript) || normalize(transcript) !== transcript) return null;
  const home = requireHome(env);
  const logs = join('.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs');
  const fromLogs = relative(join(home, logs), transcript);
  if (!fromLogs || isAbsolute(fromLogs) || fromLogs === '..' || fromLogs.startsWith(`..${sep}`)) return null;
  const entry = lstatSync(transcript);
  const expected = join(realpathSync(home), logs, fromLogs);
  if (!entry.isFile() || realpathSync(transcript) !== expected) return null;

  const fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.dev !== entry.dev || file.ino !== entry.ino) return null;
    const bytes = file.size;
    for (let window = Math.min(1024 * 1024, bytes); ; window = Math.min(window * 2, bytes)) {
      const buffer = Buffer.alloc(window);
      if (readSync(fd, buffer, 0, window, bytes - window) !== window) return null;
      const lines = buffer.toString('utf8').split('\n');
      // A partial tail can begin inside a JSON line.
      for (let index = lines.length - 1; index >= (window < bytes ? 1 : 0); index -= 1) {
        const contextTokens = plannerContext(lines[index]!);
        if (contextTokens !== undefined) return { bytes, contextTokens };
      }
      if (window === bytes) return { bytes, contextTokens: null };
    }
  } finally {
    closeSync(fd);
  }
}

/** Undefined skips other lines. Null means the latest planner entry has invalid counts. */
function plannerContext(line: string): number | null | undefined {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return undefined; }
  if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'PLANNER_RESPONSE') return undefined;
  const input = 'input_tokens' in entry ? entry.input_tokens : 0;
  const cached = 'cache_read_tokens' in entry ? entry.cache_read_tokens : 0;
  if (typeof input !== 'number' || typeof cached !== 'number' || !Number.isSafeInteger(input) || !Number.isSafeInteger(cached) || input < 0 || cached < 0) return null;
  const total = input + cached;
  return Number.isSafeInteger(total) ? total : null;
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
