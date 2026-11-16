import { readdirSync, readFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { hcGet, RH_LABEL } from '../terminal/herdr-core';
import { piAgentDir } from '../pi-agent-dir';
import { osAccountHome } from '../runtime/os-account-home';
import { parseReviewPacket } from '../../core/board/review';
import { errorMessage } from '../../core/evidence/error-message';
import {
  parseReceipt, publishReceipt, ReviewPublishError, type ReviewPublishInput, type ReviewPublishResult,
} from './review-publish';

const MARKER = 'RECEIPT-JSON';
const RECEIPT_KIND = 'repo-harness-review-publish-receipt';

export interface ReviewCollectInput extends ReviewPublishInput {
  /** The review seat's `hc` terminal address (Pi or Claude). */
  readonly seat: string;
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

function claudeConfigDir(home: string): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  return configured === undefined || configured === '' ? join(home, '.claude') : configured;
}

function sessionFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => name.endsWith('.jsonl')).map((name) => join(directory, name));
  } catch {
    return [];
  }
}

interface SessionRecord { readonly path: string; readonly packet: string; readonly assistant: readonly string[] }

function textOf(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
}

/** Pi and Claude Code both write one JSON object per line with `message.role` and `message.content`. */
function readSession(path: string): SessionRecord {
  let packet = '';
  const assistant: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.message;
    if (message?.role === 'user' && packet === '') {
      // Claude Code writes other user entries before the task; the packet is the first one that parses as a packet.
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

/**
 * The session of the seat is the one whose packet names this seat and this PR. Two review seats of one PR share a worktree, so
 * one session directory holds both, and file age says nothing about which is which.
 */
export function collectReview(input: ReviewCollectInput): ReviewPublishResult {
  const terminal = hcGet(input.seat);
  const cwd = terminal.cwd;
  if (cwd == null) throw invalid('terminal ' + input.seat + ' reports no working directory');
  const seat = terminal.labels[RH_LABEL.seat];
  if (seat === undefined) throw invalid('terminal ' + input.seat + ' carries no ' + RH_LABEL.seat + ' label');
  let realCwd: string;
  try { realCwd = realpathSync(cwd); } catch (error) { throw invalid('the seat working directory is unreadable: ' + errorMessage(error)); }
  const home = osAccountHome();
  const directories = [piSessionDirectory(piAgentDir(home), realCwd), claudeSessionDirectory(claudeConfigDir(home), realCwd)];
  const bound = directories.flatMap(sessionFiles).map(readSession).filter((session) => {
    const packet = parseReviewPacket(session.packet);
    return packet !== null && packet.pr === input.prNumber && packet.seat === seat;
  });
  if (bound.length === 0) {
    throw invalid('the seat session record is missing: no Pi or Claude session in ' + directories.join(' or ') + ' holds the review packet of the ' + seat + ' for PR #' + input.prNumber);
  }
  // One bound session reports its own errors. Several (an earlier round in this worktree) narrow to the one whose receipt is for its packet head.
  const matching = bound.length === 1 ? bound : bound.filter((session) => {
    try { return parseReceipt(lastReceiptValue(session.assistant)).subject_sha === parseReviewPacket(session.packet)!.head_sha; } catch { return false; }
  });
  if (matching.length !== 1) {
    throw invalid(matching.length === 0
      ? 'no session of the ' + seat + ' for PR #' + input.prNumber + ' ends with a receipt for its packet head'
      : matching.length + ' sessions of the ' + seat + ' for PR #' + input.prNumber + ' end with a receipt for their packet head: ' + matching.map((session) => session.path).join(', '));
  }
  return publishReceipt(input, parseReceipt(lastReceiptValue(matching[0]!.assistant)));
}
