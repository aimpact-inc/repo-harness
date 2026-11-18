/**
 * The sanitized lifecycle index of one repository (#3204): `<repo-harness home>/lifecycle/<repository id>.jsonl`, an
 * append-only JSONL file outside every task worktree, so seat, friction and hook clues outlive `board closeout`.
 * Telemetry is not an authority: only the read-only `rh board retro` reads it back (#3205), and a failed append never changes a command result.
 * I1: an event holds closed-enum codes, numeric IDs, seat and model IDs, durations and a transcript path only. It holds no
 * operator-typed SHA: a refused command has not confirmed it, and a hex secret has the same shape.
 * The shape gate drops any event with another value, so no stdout, stderr, file content or error prose reaches the file.
 */
import { mkdirSync } from 'fs';
import { isAbsolute, join } from 'path';
import { appendLineDurably } from '../atomic-append';
import { repoHarnessHome } from '../repo-harness-home';
import { readSegmentedLog } from '../segmented-log';

export const LIFECYCLE_EVENT_PROTOCOL = 'repo-harness.lifecycle-event/v1' as const;

export type SeatLifecyclePhase = 'launch' | 'reset' | 'close';
export type FrictionCommand = 'publication_merge' | 'board_dispatch' | 'board_review';

export interface SeatLifecycleEvent {
  readonly kind: 'seat.lifecycle';
  readonly phase: SeatLifecyclePhase;
  readonly seat: string;
  /** The hc terminal address or the pane name; null when the producer has neither. */
  readonly terminal: string | null;
  readonly issues: readonly number[];
  readonly pr: number | null;
  readonly model: string | null;
  /** The age of the session that the event ends. */
  readonly duration_ms: number | null;
  /** The local transcript of the session that the event ends. */
  readonly transcript_path: string | null;
}

export interface CliFrictionEvent {
  readonly kind: 'cli.friction';
  readonly command: FrictionCommand;
  readonly issue: number | null;
  readonly pr: number | null;
  readonly error_code: string;
  readonly blocker_codes: readonly string[];
}

export interface WorktreeHookSummaryEvent {
  readonly kind: 'worktree.hook_summary';
  /** The worktree directory name. */
  readonly worktree_id: string;
  readonly pr: number;
  readonly branch: string;
  readonly counts_by_code: WorktreeHookCounts;
}

export type LifecycleEvent = SeatLifecycleEvent | CliFrictionEvent | WorktreeHookSummaryEvent;

/** `<hook event>.<route id>.<ok|blocked|failed>` to its record count. */
export type WorktreeHookCounts = Readonly<Record<string, number>>;

const CODE = /^[a-z][a-z0-9_]{0,63}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
const HOOK_CODE = /^[A-Za-z]+\.[a-z]+\.(?:ok|blocked|failed)$/u;
const TRANSCRIPT_LIMIT = 1024;

const id = (value: number | null): boolean => value === null || (Number.isSafeInteger(value) && value > 0);
const count = (value: number | null): boolean => value === null || (Number.isSafeInteger(value) && value >= 0);
const token = (value: string | null): boolean => value === null || TOKEN.test(value);

function transcriptPath(value: string | null): boolean {
  return value === null || (value.length <= TRANSCRIPT_LIMIT && isAbsolute(value) && value.endsWith('.jsonl') && !/[\u0000-\u001f\u007f]/u.test(value));
}

/** The I1 shape gate: true only when every value is one of the allowed kinds. The writer and the retro reader share it. */
export function sanitized(event: LifecycleEvent): boolean {
  switch (event.kind) {
    case 'seat.lifecycle':
      return ['launch', 'reset', 'close'].includes(event.phase) && TOKEN.test(event.seat) && token(event.terminal) && event.issues.every(id) && id(event.pr)
        && token(event.model) && count(event.duration_ms) && transcriptPath(event.transcript_path);
    case 'cli.friction':
      return ['publication_merge', 'board_dispatch', 'board_review'].includes(event.command) && id(event.issue) && id(event.pr)
        && CODE.test(event.error_code) && event.blocker_codes.every(code => CODE.test(code));
    case 'worktree.hook_summary':
      return TOKEN.test(event.worktree_id) && id(event.pr) && TOKEN.test(event.branch)
        && Object.entries(event.counts_by_code).every(([code, value]) => HOOK_CODE.test(code) && count(value));
    default:
      return false;
  }
}

export function lifecycleIndexPath(repositoryId: number, env: NodeJS.ProcessEnv): string {
  return join(repoHarnessHome(env), 'lifecycle', `${repositoryId}.jsonl`);
}

/**
 * Appends each sanitized event to the index of the repository. `repositoryId` runs only when there is an event, because
 * some producers read it from GitHub. Every failure, a failed id read included, drops the events silently: the command's
 * stdout and stderr are parsed JSON, and its exit code belongs to the command.
 */
export function recordLifecycleEvents(repositoryId: () => number, events: readonly LifecycleEvent[], env: NodeJS.ProcessEnv, now: Date = new Date()): void {
  if (events.length === 0) return;
  try {
    const repository = repositoryId();
    if (!id(repository)) return;
    const path = lifecycleIndexPath(repository, env);
    mkdirSync(join(repoHarnessHome(env), 'lifecycle'), { recursive: true, mode: 0o700 });
    for (const event of events) {
      if (sanitized(event)) appendLineDurably(path, JSON.stringify({ protocol: LIFECYCLE_EVENT_PROTOCOL, at: now.toISOString(), repository_id: repository, ...event }), 0o600);
    }
  } catch {
    // Telemetry never fails the primary command.
  }
}

/** The hook layer owns the telemetry log: its path relative to the worktree, its protocol and its declared routes. */
export interface HookTelemetrySource {
  readonly path: string;
  readonly protocol: string;
  readonly routes: readonly { readonly event: string; readonly routeId: string }[];
}

/**
 * The hook event counts of a worktree, read before its removal. A record counts only for a declared route; the
 * free-text `reason` is never read. Never throws: null when the log is missing or unreadable.
 */
export function summarizeWorktreeHooks(worktree: string, source: HookTelemetrySource): WorktreeHookCounts | null {
  try {
    const lines = readSegmentedLog(join(worktree, source.path), worktree);
    if (lines === null) return null;
    const declared = new Set(source.routes.map(route => `${route.event}.${route.routeId}`));
    const counts: Record<string, number> = {};
    for (const line of lines) {
      let record: Record<string, unknown>;
      try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (typeof record !== 'object' || record === null || record.protocol !== source.protocol) continue;
      const { event, route_id: routeId, blocked, exit_code: exitCode } = record;
      const route = `${String(event)}.${String(routeId)}`;
      if (!declared.has(route)) continue;
      const code = `${route}.${blocked === true ? 'blocked' : exitCode === 0 ? 'ok' : 'failed'}`;
      counts[code] = (counts[code] ?? 0) + 1;
    }
    return counts;
  } catch {
    return null;
  }
}
