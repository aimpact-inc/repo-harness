import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync } from 'fs';
import { basename, join, resolve } from 'path';
import { withAntigravityTranscript } from '../board/antigravity-transcript';
import { AGY_REVIEW_PROMPT_OPTION, isAgyReviewLaunchId, readAgyReviewSession } from '../board/agy-review-session';
import { boardHostPorts, hcGet, HerdrCoreError, RH_LABEL, type HcTerminal } from '../terminal/herdr-core';
import { hcStatusClass } from '../../core/board/desk';
import { isReviewSeat, type SeatId } from '../../core/board/seats-settings';
import { piAgentDir } from '../pi-agent-dir';
import { osAccountHome } from '../runtime/os-account-home';
import { parseReviewPacket, type ReviewPacketBinding } from '../../core/board/review';
import { errorMessage } from '../../core/evidence/error-message';
import { isRecord } from '../../core/evidence/is-record';
import type { ReviewPublishReceipt, ReviewRecordSeat } from '../../core/review/review-publish';
import {
  parseReceipt, publishReceipt, readPrHeadSha, ReviewPublishError, type ReviewPublishInput, type ReviewPublishResult,
} from './review-publish';
import { createGhRunner, ghJson, prHead } from './review-publish-gh';

const MARKER = 'RECEIPT-JSON';
const RECEIPT_KIND = 'repo-harness-review-publish-receipt';

export interface ReviewCollectInput extends Omit<ReviewPublishInput, 'seat'> {
  /** The review seat's `hc` terminal address. */
  readonly seat: string;
}

/** What `collect` did with the review seat after the record published. It never turns a published record into a failure. */
export type ReviewSeatCloseV1 =
  | { readonly outcome: 'closed' }
  /** `not_review_seat`, `other_pr`, `caller_terminal`, `seat_not_done`, `launch_unbound`, or the hc reason of a close that failed. */
  | { readonly outcome: 'kept'; readonly reason: string };

export type ReviewCollectResult = ReviewPublishResult & { readonly seat_close: ReviewSeatCloseV1 };

export interface SeatReceipt {
  readonly terminal: HcTerminal;
  readonly seat: string;
  readonly reviewSeat: ReviewRecordSeat;
  readonly receipt: ReviewPublishReceipt;
}

/**
 * Close a done review seat of this pull request once its record is out (#3190), with the kill and remove of the board closeout.
 * Another seat, a seat of another pull request, a seat that still works and the caller's own terminal stay open. Launches for
 * different heads can share the worktree and the labels, so the seat closes only when its own launch packet (the task text in the
 * argv of its agent) names this seat, this pull request and the head of the published receipt.
 */
function closeReviewSeat(terminal: HcTerminal, seat: string, pr: number, head: string): ReviewSeatCloseV1 {
  if (!isReviewSeat(seat as SeatId)) return { outcome: 'kept', reason: 'not_review_seat' };
  if (terminal.labels[RH_LABEL.pr] !== String(pr)) return { outcome: 'kept', reason: 'other_pr' };
  if (terminal.address === process.env.HC_TERMINAL_ID) return { outcome: 'kept', reason: 'caller_terminal' };
  const status = hcStatusClass(terminal.status?.state ?? null);
  if (status !== 'done' && status !== 'idle') return { outcome: 'kept', reason: 'seat_not_done' };
  const launched = (terminal.foreground?.argv ?? []).some((arg) => {
    const packet = parseReviewPacket(arg);
    return packet !== null && packet.pr === pr && packet.seat === seat && packet.head_sha === head;
  });
  if (!launched) return { outcome: 'kept', reason: 'launch_unbound' };
  const closed = boardHostPorts().closeTerminal(terminal.address);
  return closed.status === 'closed' ? { outcome: 'closed' } : { outcome: 'kept', reason: closed.reason };
}

const invalid = (message: string) => new ReviewPublishError('review_receipt_invalid', message, 2);

/** The directory pi-coding-agent's `getDefaultSessionDirPath` names: agent dir, `sessions`, then the cwd without its leading separator, `/`, `\` and `:` as `-`, wrapped in `--`. */
function piSessionDirectory(agentDir: string, cwd: string): string {
  return join(agentDir, 'sessions', '--' + resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--');
}

/** Claude Code keeps a project's sessions under `projects/<cwd with every non-alphanumeric as '-'>`. */
function claudeSessionDirectory(configDir: string, cwd: string): string {
  return join(configDir, 'projects', resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'));
}

const envDirectory = (name: string, fallback: string): string => {
  const configured = process.env[name];
  return configured === undefined || configured === '' ? fallback : configured;
};

function jsonlIn(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.jsonl')).map((name) => join(directory, name));
  } catch {
    return [];
  }
}

/** The first line of a file, read in chunks: a Codex `session_meta` line carries the whole base instructions. */
function firstLine(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(65536);
    let text = '';
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0 && !text.includes('\n'); read = readSync(fd, chunk, 0, chunk.length, null)) text += chunk.toString('utf8', 0, read);
    return text.split('\n')[0]!;
  } finally { closeSync(fd); }
}

/** Codex writes `sessions/YYYY/MM/DD/rollout-*.jsonl` for every working directory; the `session_meta` line names the one of each. */
function codexSessionFiles(codexHome: string, cwd: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        try {
          const meta = JSON.parse(firstLine(path));
          if (meta?.type === 'session_meta' && typeof meta.payload?.cwd === 'string' && realpathSync(meta.payload.cwd) === cwd) found.push(path);
        } catch { /* a file that is no rollout of this working directory */ }
      }
    }
  };
  walk(join(codexHome, 'sessions'));
  return found;
}

interface SessionRecord { readonly path: string; readonly packet: string; readonly assistant: readonly string[] }

function textOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (typeof part?.text === 'string' && ['text', 'input_text', 'output_text'].includes(part.type) ? [part.text] : []));
}

/** Pi and Claude Code write `{ message: { role, content } }`; Codex writes `{ type: 'response_item', payload: { type: 'message', role, content } }`. */
function messageOf(entry: any): { role?: unknown; content?: unknown } | undefined {
  return entry?.type === 'response_item' && entry.payload?.type === 'message' ? entry.payload : entry?.message;
}

function readSession(path: string): SessionRecord {
  let packet = '';
  const assistant: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = messageOf(entry);
    if (message?.role === 'user' && packet === '') {
      // Other user entries (hooks, AGENTS.md) come before the task; the packet is the first one that parses as a packet.
      const text = textOf(message.content).join('\n');
      if (parseReviewPacket(text) !== null) packet = text;
    } else if (message?.role === 'assistant') assistant.push(...textOf(message.content));
  }
  return { path, packet, assistant };
}

/** The JSON value that starts right after a marker (past an optional code fence); the decoder, not a fence regex, finds where it ends. */
function decodeAfterMarker(text: string, markerEnd: number): unknown {
  const rest = text.slice(markerEnd).replace(/^:?\s*(```[a-z]*)?\s*/, '');
  if (!rest.startsWith('{') && !rest.startsWith('[')) return undefined;
  for (let end = 0; end < rest.length; end++) {
    if (rest[end] !== '}' && rest[end] !== ']') continue;
    try { return JSON.parse(rest.slice(0, end + 1)); } catch { /* the value ends later */ }
  }
  return undefined;
}

/** The last value after any marker that decodes to a receipt object; a marker inside a string decodes to nothing and is skipped. */
function lastReceiptValue(texts: readonly string[]): unknown {
  let marked = false;
  let found: unknown;
  for (const text of texts) {
    for (let at = text.indexOf(MARKER); at >= 0; at = text.indexOf(MARKER, at + MARKER.length)) {
      marked = true;
      const value = decodeAfterMarker(text, at + MARKER.length);
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && (value as { kind?: unknown }).kind === RECEIPT_KIND) found = value;
    }
  }
  if (!marked) throw invalid('the seat session has no ' + MARKER + ' block');
  if (found === undefined) throw invalid('no ' + MARKER + ' block decodes to a ' + RECEIPT_KIND + ' object');
  return found;
}

/** A user turn, model error or planner tool call supersedes visible planner text. */
function agyReply(transcript: string): string {
  let reply = '';
  for (const line of transcript.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { reply = ''; continue; }
    if (!isRecord(entry)) continue;
    if (entry.type === 'USER_INPUT' || entry.type === 'ERROR_MESSAGE') reply = '';
    if (entry.type === 'PLANNER_RESPONSE') {
      const callsTools = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
      reply = typeof entry.content === 'string' && !callsTools ? entry.content : '';
    }
  }
  return reply;
}

/** The native reply ends with one explicit receipt block. A later block supersedes any earlier one. */
function parseAgyReceipt(reply: string): ReviewPublishReceipt {
  const blocks = reply.split(/^[ \t]*RECEIPT-JSON[ \t]*:?[ \t]*\r?$/mu);
  if (blocks.length === 1) throw invalid('the agy session has no RECEIPT-JSON block');
  const final = blocks.at(-1)!.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/iu.exec(final);
  let value: unknown;
  try {
    value = JSON.parse(fenced?.[1] ?? final);
  } catch {
    throw invalid('the final RECEIPT-JSON block does not decode as JSON');
  }
  return parseReceipt(value);
}

function agyLaunchBinding(terminal: HcTerminal, pr: number): ReviewPacketBinding & { launchId: string } {
  const binding = terminal.labels[RH_LABEL.agyReview] ?? '';
  const separator = binding.indexOf(' ');
  const launchId = binding.slice(0, separator);
  const packet = parseReviewPacket(binding.slice(separator + 1));
  if (separator < 0 || !isAgyReviewLaunchId(launchId) || terminal.labels[RH_LABEL.seat] !== 'gatekeeper'
    || terminal.labels[RH_LABEL.pr] !== String(pr) || packet?.seat !== 'gatekeeper' || packet.pr !== pr) {
    throw invalid('the terminal has no complete agy gatekeeper-fallback launch packet for this PR');
  }
  return { ...packet, launchId };
}

function agyPrHead(input: Omit<ReviewPublishInput, 'seat'>, repository: string | undefined): string {
  const run = input.ghRunner ?? createGhRunner(input.repoRoot, input.ghBin);
  let target;
  let repositoryId: unknown;
  try {
    target = prHead(run, input.prNumber);
    repositoryId = ghJson(run, ['api', `repos/${target.slug}`]).id;
  } catch (error) {
    throw new ReviewPublishError('review_publish_provider_unavailable', errorMessage(error), 1);
  }
  if (!Number.isSafeInteger(repositoryId) || String(repositoryId) !== repository) throw invalid('the agy launch belongs to a different repository');
  return target.headSha.toLowerCase();
}

function agyReceipt(input: ReviewCollectInput, terminal: HcTerminal, home: string, watcher: boolean): ReviewPublishReceipt {
  const launch = agyLaunchBinding(terminal, input.prNumber);
  const head = watcher ? launch.head_sha : agyPrHead(input, terminal.labels[RH_LABEL.repository]);
  if (launch.head_sha !== head) {
    throw new ReviewPublishError('review_subject_stale', `the agy launch packet is for ${launch.head_sha}, but the PR head is ${head}; nothing was posted`, 2);
  }
  const env = { HOME: home };
  let session: ReturnType<typeof readAgyReviewSession>;
  try { session = readAgyReviewSession(launch.launchId, env); } catch (error) { throw invalid(errorMessage(error)); }
  const { sessionId, transcriptPath } = session;
  const name = basename(transcriptPath);
  if (name !== 'transcript.jsonl' && name !== 'transcript_full.jsonl') throw invalid('the recorded agy path must name a native transcript');
  let reply: string | null;
  try {
    reply = withAntigravityTranscript(sessionId, transcriptPath, env, fd => agyReply(readFileSync(fd, 'utf8')));
  } catch { throw invalid('the recorded agy transcript is unreadable'); }
  if (reply === null) throw invalid('the recorded agy transcript is outside the conversation logs or is not a regular transcript');
  const receipt = parseAgyReceipt(reply);
  if (receipt.reviewer.harness !== 'agy') throw invalid('the agy review receipt must name reviewer.harness agy');
  if (receipt.subject_sha !== head) throw invalid(`the receipt names ${receipt.subject_sha}, not the packet head ${head}`);
  if (receipt.round !== launch.round) throw invalid(`receipt round ${receipt.round} differs from packet round ${launch.round}`);
  if (receipt.risk_tier !== launch.tier) throw invalid(`receipt tier ${receipt.risk_tier} differs from packet tier ${launch.tier}`);
  return receipt;
}

function watcherSeatTerminal(address: string, pr: number, repositoryId: number): HcTerminal {
  let terminal: HcTerminal;
  try { terminal = hcGet(address); } catch (error) {
    if (!(error instanceof HerdrCoreError)) throw error;
    throw invalid(error.message);
  }
  const status = hcStatusClass(terminal.status?.state ?? null);
  if (terminal.labels[RH_LABEL.repository] !== String(repositoryId) || terminal.labels[RH_LABEL.pr] !== String(pr)
    || terminal.state !== 'live' || (status !== 'done' && status !== 'idle')) {
    throw invalid('the terminal is not a finished review seat of this repository and PR');
  }
  return terminal;
}

function launchHead(terminal: HcTerminal, pr: number, seat: string): string {
  for (const arg of terminal.foreground?.argv ?? []) {
    const packet = parseReviewPacket(arg);
    if (packet !== null && packet.pr === pr && packet.seat === seat) return packet.head_sha;
  }
  throw invalid('the terminal has no launch packet for this review seat and PR');
}

/**
 * Bind the session to its seat, PR and head and parse its receipt without posting.
 * The watcher uses the local launch head. Publication still checks the live PR head.
 */
export function readSeatReceipt(input: ReviewCollectInput, watcherRepositoryId?: number): SeatReceipt {
  const terminal = watcherRepositoryId === undefined ? hcGet(input.seat) : watcherSeatTerminal(input.seat, input.prNumber, watcherRepositoryId);
  const cwd = terminal.cwd;
  if (cwd == null) throw invalid('terminal ' + input.seat + ' reports no working directory');
  const seat = terminal.labels[RH_LABEL.seat];
  if (seat === undefined) throw invalid('terminal ' + input.seat + ' carries no ' + RH_LABEL.seat + ' label; launch the seat with `rh seats argv <seat> --repository-id <id> --pr <n>`');
  if (!isReviewSeat(seat as SeatId)) throw invalid('terminal ' + input.seat + ' carries non-review seat ' + seat);
  let realCwd: string;
  try { realCwd = realpathSync(cwd); } catch (error) { throw invalid('the seat working directory is unreadable: ' + errorMessage(error)); }
  const home = osAccountHome();
  const foreground = terminal.foreground;
  const nativeAgy = terminal.labels[RH_LABEL.agyReview] !== undefined
    || foreground?.name === 'agy' || foreground?.argv.includes(AGY_REVIEW_PROMPT_OPTION);
  const receipt = nativeAgy
    ? agyReceipt(input, terminal, home, watcherRepositoryId !== undefined)
    : jsonlReceipt(input.prNumber, seat, realCwd, home,
      () => watcherRepositoryId === undefined ? readPrHeadSha(input) : launchHead(terminal, input.prNumber, seat));
  const reviewSeat: ReviewRecordSeat = seat === 'reviewer' ? 'reviewer' : 'gatekeeper';
  return { terminal, seat, reviewSeat, receipt };
}

function jsonlReceipt(pr: number, seat: string, realCwd: string, home: string, readHead: () => string): ReviewPublishReceipt {
  const piDirectory = piSessionDirectory(piAgentDir(home), realCwd);
  const claudeDirectory = claudeSessionDirectory(envDirectory('CLAUDE_CONFIG_DIR', join(home, '.claude')), realCwd);
  const files = [...jsonlIn(piDirectory), ...jsonlIn(claudeDirectory), ...codexSessionFiles(envDirectory('CODEX_HOME', join(home, '.codex')), realCwd)];
  const bound = files.map(readSession).filter((session) => {
    const packet = parseReviewPacket(session.packet);
    return packet !== null && packet.pr === pr && packet.seat === seat;
  });
  if (bound.length === 0) {
    throw invalid('the seat session record is missing: no session in ' + piDirectory + ', in ' + claudeDirectory + ' or in a Codex rollout of ' + realCwd + ' holds the review packet of the ' + seat + ' for PR #' + pr);
  }
  const head = readHead();
  const atHead = bound.filter((session) => parseReviewPacket(session.packet)!.head_sha === head);
  if (atHead.length === 0) {
    throw new ReviewPublishError('review_subject_stale', 'no session of the ' + seat + ' for PR #' + pr + ' holds a packet for the PR head ' + head + '; nothing was posted', 2);
  }
  // A session that ends with no receipt (an aborted attempt) is no candidate and makes nothing ambiguous.
  const finished = atHead.flatMap((session) => {
    try {
      const receipt = parseReceipt(lastReceiptValue(session.assistant));
      return receipt.reviewer.harness === 'agy' ? [] : [{ session, receipt }];
    } catch { return []; }
  });
  if (finished.length > 1) throw invalid(finished.length + ' sessions of the ' + seat + ' for PR #' + pr + ' end with a receipt for the PR head ' + head + ': ' + finished.map(({ session }) => session.path).join(', '));
  // The one session at the head reports its own error when it holds no valid receipt.
  const receipt = finished.length === 1 ? finished[0]!.receipt : parseReceipt(lastReceiptValue(atHead[0]!.assistant));
  if (receipt.reviewer.harness === 'agy') throw invalid('an agy review receipt requires an agy gatekeeper-fallback launch');
  if (receipt.subject_sha !== head) throw invalid('the receipt names ' + receipt.subject_sha + ', not the packet head ' + head);
  return receipt;
}

/** Publish a bound receipt and close its seat after publication succeeds. */
export function publishSeatReceipt(input: ReviewCollectInput, read: SeatReceipt): ReviewCollectResult {
  const { terminal, seat, reviewSeat, receipt } = read;
  const published = publishReceipt({ ...input, seat: reviewSeat }, receipt);
  return { ...published, seat_close: closeReviewSeat(terminal, seat, input.prNumber, receipt.subject_sha) };
}

export function collectReview(input: ReviewCollectInput): ReviewCollectResult {
  return publishSeatReceipt(input, readSeatReceipt(input));
}
