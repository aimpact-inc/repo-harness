import { sha256Hex } from '../../core/evidence/sha256';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import {
  isSeatResetAction, missingHandoffSections, seatHandoffPath, seatResetLogPath, seatResetRequestPath, isSeatSessionSource, seatSessionPath,
  type InteractiveResetHost, type SeatLaunchModel, type SeatResetAction, type SeatResetIdentity, type SeatSessionSource,
} from '../../core/board/seat-reset';
import { withAntigravityTranscript } from './antigravity-transcript';

const TAIL_BYTES = 1024 * 1024;

/** The context of one assistant entry: every input token that the model read for it. */
function entryContext(line: string): number | null {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return null; }
  if (typeof entry !== 'object' || entry === null) return null;
  const { type, isSidechain, message } = entry as {
    type?: unknown;
    isSidechain?: unknown;
    message?: { role?: unknown; stopReason?: unknown; usage?: Record<string, unknown> };
  };
  const usage = message?.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  if (type === 'assistant' && isSidechain !== true) {
    const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(key => usage[key] ?? 0);
    return counts.every(count => Number.isSafeInteger(count)) ? (counts as number[]).reduce((sum, count) => sum + count, 0) : null;
  }
  if (type === 'message' && message?.role === 'assistant' && message.stopReason !== 'aborted' && message.stopReason !== 'error') {
    const keys = ['input', 'cacheRead', 'cacheWrite'] as const;
    if (!keys.every(key => Number.isSafeInteger(usage[key]))) return null;
    return keys.reduce((sum, key) => sum + (usage[key] as number), 0);
  }
  return null;
}

export interface TranscriptUsage {
  /** The context tokens of the last assistant entry, or null when the transcript has none. */
  readonly contextTokens: number | null;
  /** The transcript file size: the measure of the reset action (#2625). */
  readonly bytes: number;
}

/**
 * The context tokens of the last assistant entry of a Claude transcript and the file size. Transcripts grow to tens
 * of MB, so it reads the tail and doubles the window until it holds a complete assistant line.
 */
export function readTranscriptUsage(path: string): TranscriptUsage {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let window = Math.min(TAIL_BYTES, size); ; window = Math.min(window * 2, size)) {
      const buffer = Buffer.alloc(window);
      readSync(fd, buffer, 0, window, size - window);
      const lines = buffer.toString('utf8').split('\n');
      // The first line of a partial window can be cut.
      for (let index = lines.length - 1; index >= (window < size ? 1 : 0); index -= 1) {
        const context = entryContext(lines[index]!);
        if (context !== null) return { contextTokens: context, bytes: size };
      }
      if (window === size) return { contextTokens: null, bytes: size };
    }
  } finally {
    closeSync(fd);
  }
}

const RESET_HOSTS: ReadonlySet<unknown> = new Set<InteractiveResetHost>(['claude', 'pi', 'antigravity']);
const isResetHost = (host: unknown): host is InteractiveResetHost => RESET_HOSTS.has(host);

export interface SeatResetRequestRecord {
  readonly host?: InteractiveResetHost;
  readonly contextTokens: number;
  readonly transcriptPath: string;
  readonly transcriptBytes: number;
  readonly action: SeatResetAction;
}

/**
 * The Stop hook records when it asked for the reset, for which transcript and with which action; the reset command
 * refuses a handoff older than this and carries out the recorded action without a second measurement.
 */
export function writeSeatResetRequest(identity: SeatResetIdentity, now: Date, request: SeatResetRequestRecord): void {
  const path = seatResetRequestPath(identity);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    requested_at: now.toISOString(), context_tokens: request.contextTokens, transcript_path: request.transcriptPath,
    action: request.action, transcript_bytes: request.transcriptBytes, host: request.host ?? 'claude',
  })}\n`);
}

/** Replace only the current seat's handoff and return the digest of the bytes written. */
export function writeSeatHandoff(identity: SeatResetIdentity, markdown: Buffer): string {
  const missing = missingHandoffSections(markdown.toString('utf8'));
  if (missing.length > 0) throw new Error(`Missing handoff sections: ${missing.join(', ')}.`);
  const path = seatHandoffPath(identity);
  const directory = dirname(path);
  if (realpathSync(directory) !== join(realpathSync('/tmp'), relative('/tmp', directory))) {
    throw new Error('The seat handoff directory has a symbolic link.');
  }
  if (lstatSync(path, { throwIfNoEntry: false })?.isFile() === false) throw new Error('The seat handoff path is not a regular file.');
  const temporaryDirectory = mkdtempSync(join(directory, '.handoff-'));
  const temporary = join(temporaryDirectory, 'handoff.md');
  try {
    writeFileSync(temporary, markdown, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return `RESET-REQUEST ${path} ${sha256Hex(markdown)}`;
}

function seatResetEvents(identity: SeatResetIdentity, requestedAt: string): Record<string, unknown>[] {
  let lines: string[];
  try { lines = readFileSync(seatResetLogPath(identity), 'utf8').split('\n'); } catch { return []; }
  return lines.map(parseJsonObject).filter((entry): entry is Record<string, unknown> => entry?.requested_at === requestedAt);
}

export function seatResetEventCount(identity: SeatResetIdentity, requestedAt: string, kind: string): number {
  return seatResetEvents(identity, requestedAt).filter(entry => entry.kind === kind).length;
}

type SeatResetRequestState = { readonly state: 'open' } | { readonly state: 'released' }
  | { readonly state: 'closed'; readonly reason: 'request_changed' | 'session_started' | 'finished' };

/** Classify the current request for a transcript or check that a specific request can still be acted on. */
export function seatResetRequestState(identity: SeatResetIdentity, expected: string | SeatRequest, session = readSeatSession(identity)): SeatResetRequestState {
  const request = readRequest(identity);
  const matches = request !== null && (typeof expected === 'string' ? request.transcriptPath === expected
    : request.requestedAt === expected.requestedAt && request.transcriptPath === expected.transcriptPath
      && request.host === expected.host && request.action === expected.action);
  if (!matches) return { state: 'closed', reason: 'request_changed' };
  const events = seatResetEvents(identity, request.requestedAt);
  if (events.some(entry => entry.kind === 'reset')) return { state: 'closed', reason: 'finished' };
  const released = events.some(entry => entry.kind === 'no_reset');
  if (session !== null && Date.parse(session.startedAt) > Date.parse(request.requestedAt)) {
    return { state: 'closed', reason: released ? 'finished' : 'session_started' };
  }
  return { state: released ? 'released' : 'open' };
}

/**
 * The SessionStart hook records each new session segment of a reset seat (`source` startup, clear or compact): the
 * reset command sends the resume prompt only after this signal. The launch model of the session lets a tier-2 reset
 * see a mode change (#2633).
 */
export function recordSeatSession(identity: SeatResetIdentity, session: SeatLaunchModel & { readonly sessionId: string | null; readonly transcriptPath: string; readonly source: SeatSessionSource; readonly host?: InteractiveResetHost }, now: Date): void {
  const path = seatSessionPath(identity);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ session_id: session.sessionId, transcript_path: session.transcriptPath, source: session.source, started_at: now.toISOString(),
    model: session.model, effort: session.effort, host: session.host ?? 'claude' })}\n`);
}

export interface SeatSessionRecord extends SeatLaunchModel {
  readonly host: InteractiveResetHost;
  readonly sessionId: string | null;
  readonly transcriptPath: string;
  readonly source: SeatSessionSource;
  readonly startedAt: string;
}

/**
 * The seat session that the SessionStart hook recorded, or null when the record is missing or any field differs from what
 * `recordSeatSession` writes. A record without the launch model (the old hook) has a null model and effort.
 */
export function readSeatSession(identity: SeatResetIdentity): SeatSessionRecord | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(seatSessionPath(identity), 'utf8')); } catch { return null; }
  if (typeof value !== 'object' || value === null) return null;
  const { session_id: sessionId, transcript_path: transcriptPath, source, started_at: startedAt, model = null, effort = null, host = 'claude' } = value as Record<string, unknown>;
  const valid = isResetHost(host) && (sessionId === null || typeof sessionId === 'string') && typeof transcriptPath === 'string' && transcriptPath !== ''
    && isSeatSessionSource(source) && typeof startedAt === 'string' && isoInstant(startedAt)
    && (model === null || typeof model === 'string') && (effort === null || typeof effort === 'string');
  return valid ? { sessionId, transcriptPath, source, startedAt, model, effort, host } : null;
}

/** True for the exact `Date.toISOString()` form that `recordSeatSession` writes. */
function isoInstant(text: string): boolean {
  const time = Date.parse(text);
  return Number.isFinite(time) && new Date(time).toISOString() === text;
}

type HandoffCode = 'handoff_missing' | 'handoff_stale' | 'handoff_sha256_mismatch' | 'handoff_sections_missing';

export interface SeatRequest {
  readonly host: InteractiveResetHost;
  readonly requestedAt: string;
  readonly transcriptPath: string | null;
  readonly action: SeatResetAction;
}

/**
 * The one boundary validator of request.json for the Stop hook and `seats reset`. It returns a typed request only for
 * an object with a valid time and a recorded action; for any other content it returns null and never throws, so both
 * readers take their invalid-request path. Nothing chooses the action again.
 */
export function readRequest(identity: SeatResetIdentity): SeatRequest | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(seatResetRequestPath(identity), 'utf8')); } catch { return null; }
  // Any JSON value that is not a plain object (null, an array, a number, a string, a boolean) is not a request.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { requested_at: requestedAt, transcript_path: transcriptPath, action, host = 'claude' } = value as Record<string, unknown>;
  if (!isResetHost(host) || typeof requestedAt !== 'string' || !Number.isFinite(Date.parse(requestedAt)) || !isSeatResetAction(action)) return null;
  if (host === 'antigravity' && action !== 'reset') return null;
  return { requestedAt, transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : null, action, host };
}

/** The first failed check of the handoff of a `RESET-REQUEST`, or null when it passes. */
export function handoffProblem(path: string, sha256: string, request: SeatRequest): { readonly code: HandoffCode; readonly message: string } | null {
  if (!existsSync(path)) return { code: 'handoff_missing', message: `${path} does not exist.` };
  if (statSync(path).mtimeMs <= Date.parse(request.requestedAt)) return { code: 'handoff_stale', message: `${path} is older than the reset request of ${request.requestedAt}.` };
  const text = readFileSync(path);
  const actual = sha256Hex(text);
  if (actual !== sha256.toLowerCase()) return { code: 'handoff_sha256_mismatch', message: `${path} has sha256 ${actual}, not ${sha256}.` };
  const missing = missingHandoffSections(text.toString('utf8'));
  return missing.length === 0 ? null : { code: 'handoff_sections_missing', message: `${path} has no section ${missing.map(section => `"## ${section}"`).join(', ')}.` };
}

export type NewSession = { readonly transcript: string } & (
  | { readonly host: 'antigravity'; readonly sessionId: string }
  | { readonly host: Exclude<InteractiveResetHost, 'antigravity'>; readonly sessionId: string | null }
);

/**
 * The segment must match the expected host. Compaction keeps the transcript. A reset needs a different transcript,
 * and a process relaunch also needs a startup record.
 */
export function newSession(identity: SeatResetIdentity, since: number, previousTranscript: string | null, expectedHost: InteractiveResetHost, action: SeatResetAction | 'startup'): NewSession | null {
  const session = readSeatSession(identity);
  if (session === null || session.host !== expectedHost || Date.parse(session.startedAt) < since) return null;
  if (action === 'startup' && session.source !== 'startup') return null;
  const segment = action === 'compact'
    ? session.source === 'compact' && session.transcriptPath === previousTranscript
    : session.transcriptPath !== previousTranscript;
  if (!segment) return null;
  const { host, sessionId, transcriptPath: transcript } = session;
  if (host !== 'antigravity') return { host, sessionId, transcript };
  return session.source === 'startup' && sessionId ? { host, sessionId, transcript } : null;
}

function readAppended(fd: number, size: number, offset: number): string {
  const length = Math.max(0, size - offset);
  const buffer = Buffer.alloc(length);
  const bytes = readSync(fd, buffer, 0, length, offset);
  return buffer.toString('utf8', 0, bytes);
}

/** Capture the transcript offset before the prompt. Each poll reads only bytes appended after that offset. */
export function readResumeTranscript(session: NewSession, env: NodeJS.ProcessEnv): () => string {
  const { host, sessionId, transcript } = session;
  if (host === 'antigravity') {
    const read = <T>(reader: (fd: number, size: number) => T): T | null => {
      try { return withAntigravityTranscript(sessionId, transcript, env, reader); } catch (error) {
        // SessionStart can arrive before Antigravity creates the transcript.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const offset = read((_fd, size) => size) ?? 0;
    return () => read((fd, size) => readAppended(fd, size, offset)) ?? '';
  }
  let offset = 0;
  try { offset = statSync(transcript).size; } catch { /* transcript not yet present */ }
  return () => {
    let fd: number;
    try { fd = openSync(transcript, 'r'); } catch { return ''; }
    try { return readAppended(fd, fstatSync(fd).size, offset); } finally { closeSync(fd); }
  };
}

const RESUMED_WORDS: readonly string[] = ['RESUMED', "'RESUMED'", '"RESUMED"'];

/**
 * Only the one simple command `hc send <peer> RESUMED` counts, with the message bare or in plain quotes. A compound,
 * piped, background or substituted command, another address and a command that only prints the text all fail the
 * word compare.
 */
function isResumedSend(command: string, peer: string): boolean {
  const words = command.trim().split(/[ \t]+/u);
  return words.length === 4 && words[0] === 'hc' && words[1] === 'send' && words[2] === peer && RESUMED_WORDS.includes(words[3]!);
}

type Part = {
  type?: unknown;
  name?: unknown;
  text?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  input?: { command?: unknown };
  arguments?: { command?: unknown };
} | null;

/** The fields that the resume evidence reads from one transcript line. */
interface TranscriptLine {
  readonly type: unknown;
  readonly role: unknown;
  /** `message.content`: the prompt text, or the parts, of the entry. */
  readonly content: unknown;
  /** `attachment` of the entry: a prompt that arrives during a turn comes as a queued command here. */
  readonly attachment: { readonly type: unknown; readonly prompt: unknown } | null;
  readonly toolCallId: unknown;
  readonly isError: unknown;
}

/**
 * The evidence fields of one transcript line, or null for a line that is not a JSON object: a JSON null, an array, a
 * scalar and a cut line are skipped, never a throw.
 */
function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const entry: unknown = JSON.parse(line);
    return typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function transcriptLine(line: string): TranscriptLine | null {
  const entry = parseJsonObject(line);
  if (entry === null) return null;
  const { type, message, attachment } = entry as {
    type?: unknown;
    message?: { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown } | null;
    attachment?: unknown;
  };
  const queued = typeof attachment === 'object' && attachment !== null ? attachment as { type?: unknown; prompt?: unknown } : null;
  return {
    type,
    role: message?.role,
    content: message?.content,
    attachment: queued === null ? null : { type: queued.type, prompt: queued.prompt },
    toolCallId: message?.toolCallId,
    isError: message?.isError,
  };
}

/**
 * True when the line holds the resume prompt: a user entry, which hc may wrap, or the `queued_command` attachment of an
 * `attachment` entry, which Claude Code writes when the prompt arrives while the session is in a turn (#2637). The entry
 * type must be `attachment`, so an assistant line that carries an `attachment` field of its own is no prompt.
 */
function holdsPrompt(entry: TranscriptLine, parts: readonly Part[], prompt: string): boolean {
  const holds = (value: unknown) => typeof value === 'string' && value.includes(prompt);
  const queued = entry.type === 'attachment' && entry.attachment !== null && entry.attachment.type === 'queued_command'
    && holds(entry.attachment.prompt);
  const userText = holds(entry.content) || parts.some(part => holds(part?.text));
  return queued || ((entry.type === 'user' || (entry.type === 'message' && entry.role === 'user')) && userText);
}

function antigravityResumedCall(entry: Record<string, unknown>, peer: string): number | null {
  const { type, step_index: index, tool_calls: calls } = entry;
  if (type !== 'PLANNER_RESPONSE' || typeof index !== 'number' || !Number.isSafeInteger(index) || !Array.isArray(calls) || calls.length !== 1) return null;
  const [call] = calls as readonly ({ name?: unknown; args?: { CommandLine?: unknown } } | null)[];
  const command = call?.args?.CommandLine;
  return call?.name === 'run_command' && typeof command === 'string' && isResumedSend(command, peer) ? index + 1 : null;
}

function antigravityCommandSucceeded(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'GENERIC' || entry.error !== undefined || typeof entry.content !== 'string') return false;
  const summary = entry.content.split(/\r?\n\r?\n/u, 1)[0];
  return summary?.split(/\r?\n/u).at(-1) === 'Command exited with code 0.';
}

/** agy 1.5.14 writes the result of a single tool call at the next step index. */
function sentAntigravityResumed(appended: string, prompt: string, peer: string): boolean {
  let asked = false;
  let resultStep: number | null = null;
  for (const line of appended.split('\n')) {
    const entry = parseJsonObject(line);
    if (entry === null) continue;
    const { type, source, status, content, step_index: index } = entry;
    if (type === 'USER_INPUT' && source === 'USER_EXPLICIT' && status === 'DONE' && typeof content === 'string' && content.includes(prompt)) asked = true;
    const modelStep = source === 'MODEL' && status === 'DONE';
    if (modelStep && resultStep !== null && index === resultStep && antigravityCommandSucceeded(entry)) return true;
    resultStep = asked && modelStep ? antigravityResumedCall(entry, peer) : null;
  }
  return false;
}

/**
 * Mechanical resume evidence in the text appended after the prompt send: the entry that holds the resume prompt, then
 * an assistant Bash tool call whose command sends RESUMED to the peer with hc send, then its tool result without an
 * error. A refused, failed or missing result is no evidence.
 */
export function sentResumed(appended: string, prompt: string, peer: string, host: InteractiveResetHost): boolean {
  if (host === 'antigravity') return sentAntigravityResumed(appended, prompt, peer);
  let asked = false;
  const sends = new Set<unknown>();
  for (const line of appended.split('\n')) {
    const entry = transcriptLine(line);
    if (entry === null) continue;
    const parts = Array.isArray(entry.content) ? entry.content as Part[] : [];
    if (entry.type === 'user' && parts.some(part => part?.type === 'tool_result' && sends.has(part.tool_use_id) && part.is_error !== true)) return true;
    if (entry.type === 'message' && entry.role === 'toolResult' && sends.has(entry.toolCallId) && entry.isError !== true) return true;
    if (holdsPrompt(entry, parts, prompt)) asked = true;
    if (!asked) continue;
    const isAssistant = entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant');
    if (!isAssistant) continue;
    for (const part of parts) {
      const command = entry.type === 'assistant' && part?.type === 'tool_use' && part.name === 'Bash'
        ? part.input?.command
        : entry.type === 'message' && part?.type === 'toolCall' && part.name === 'bash'
          ? part.arguments?.command
          : undefined;
      if (typeof command === 'string' && isResumedSend(command, peer) && part?.id !== undefined && part.id !== null) sends.add(part.id);
    }
  }
  return false;
}
