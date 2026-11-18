/**
 * The retro projection of `rh board retro` (#3205): merged pull requests, their Actions runs and protocol comments, joined with the
 * lifecycle index of the repository (#3204). Pure: the command reads and validates every input. I1: the document holds codes,
 * IDs, SHAs, durations, counts, check and model names of a fixed shape and validated transcript paths only; no URL and no comment text.
 * A metric with no source on the reads is `unavailable` with a reason code, never an estimate.
 */
import { ACCEPTANCE_RECORD_HEADER } from './review-rules';
import { REVIEW_START_HEADER } from './review';
import { commentId, parseAcceptanceRecord, protocolComments, type BoardPullRequestReadV1 } from './source';

export const BOARD_RETRO_PROTOCOL = 'repo-harness.board-retro/v1' as const;

/** The index events that the retro reads: a structural subset of the lifecycle event shapes, which the command validated. */
export type RetroEventV1 = { readonly at: string } & (
  | { readonly kind: 'seat.lifecycle'; readonly phase: string; readonly seat: string; readonly issues: readonly number[]; readonly pr: number | null; readonly duration_ms: number | null; readonly transcript_path: string | null }
  | { readonly kind: 'cli.friction'; readonly command: string; readonly issue: number | null; readonly pr: number | null; readonly error_code: string; readonly blocker_codes: readonly string[] }
  | { readonly kind: 'worktree.hook_summary'; readonly pr: number; readonly counts_by_code: Readonly<Record<string, number>> });

/** One Actions workflow run of a pull request branch. `name` is null when the workflow name has another shape. */
export interface RetroRunV1 {
  readonly id: number;
  readonly name: string | null;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly started_at: string;
  readonly updated_at: string;
  readonly completed: boolean;
}

export interface RetroPullRequestInputV1 {
  readonly read: BoardPullRequestReadV1;
  /** The issues of the scope that the pull request body names. */
  readonly issues: readonly number[];
  readonly runs: readonly RetroRunV1[];
}

export interface RetroInputV1 {
  readonly observed_at: string;
  readonly repository_id: number;
  readonly scope: { readonly parent: number } | { readonly since: string };
  readonly closed_issues: number;
  /** The merged pull requests of the scope. */
  readonly pull_requests: readonly RetroPullRequestInputV1[];
  /** The index events of the scope. */
  readonly events: readonly RetroEventV1[];
}

export interface RetroMedianV1 {
  readonly median_ms: number | null;
  readonly n: number;
}

export interface RetroOutlierV1 {
  readonly metric: 'wall_clock_ms' | 'ci_runs' | 'friction_count' | 'seat_duration_ms';
  readonly value: number;
  readonly pr: number | null;
  readonly seat: string | null;
  readonly error_codes: readonly string[];
  /** The comment IDs of the acceptance records with a FAIL row. */
  readonly comment_ids: readonly string[];
  /** The IDs of the failed Actions runs. */
  readonly run_ids: readonly number[];
  readonly transcript_paths: readonly string[];
}

export interface BoardRetroV1 {
  readonly protocol: typeof BOARD_RETRO_PROTOCOL;
  readonly observed_at: string;
  readonly repository_id: number;
  readonly scope: RetroInputV1['scope'];
  readonly closed_issues: number;
  readonly merged_prs: number;
  readonly consolidation_ratio: number | null;
  readonly spawned_issues_per_pr: { readonly status: 'unavailable'; readonly reason: 'no_spawn_link' };
  readonly ci_runs_per_pr: number | null;
  readonly top_failing_checks: readonly { readonly name: string | null; readonly failures: number; readonly run_ids: readonly number[] }[];
  readonly review_rounds_per_pr: number | null;
  readonly p1_fixed: { readonly status: 'unavailable'; readonly reason: 'record_findings_have_no_severity' };
  readonly p1_downgraded_by_jd: { readonly status: 'unavailable'; readonly reason: 'disposition_counts_records_not_findings' };
  /** Pull requests whose comment read is truncated: the review phases and rounds leave them out. */
  readonly comments_truncated: readonly number[];
  readonly phase_median_ms: Readonly<Record<'write' | 'ci' | 'review_wait' | 'review_run' | 'merge_wait', RetroMedianV1>>;
  readonly top_friction_codes: readonly { readonly code: string; readonly count: number }[];
  readonly outliers: readonly RetroOutlierV1[];
}

const TOP = 3;
const TOP_CODES = 10;

/** The median of the observed values; for an even count, the lower middle value, so the median is always an observed duration. */
function median(values: readonly number[]): RetroMedianV1 {
  const sorted = [...values].sort((left, right) => left - right);
  return { median_ms: sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!, n: sorted.length };
}

const ms = (time: string): number => Date.parse(time);
const ratio = (numerator: number, denominator: number): number | null => (denominator === 0 ? null : numerator / denominator);
// A cancelled run is left out: `cancel-in-progress` cancels each run that a newer push supersedes, and it has no failed log.
const FAILED_CONCLUSIONS: ReadonlySet<string | null> = new Set(['failure', 'timed_out', 'startup_failure']);
const failed = (run: RetroRunV1): boolean => run.completed && FAILED_CONCLUSIONS.has(run.conclusion);

/** The newest time of `times` before `limit`; null when there is none. */
function lastBefore(times: readonly number[], limit: number): number | null {
  return times.filter(time => time <= limit).reduce<number | null>((last, time) => (last === null || time > last ? time : last), null);
}

function relatedEvent(event: RetroEventV1, pr: RetroPullRequestInputV1): boolean {
  const issues = new Set(pr.issues);
  switch (event.kind) {
    case 'seat.lifecycle': return event.pr === pr.read.number || event.issues.some(issue => issues.has(issue));
    case 'cli.friction': return event.pr === pr.read.number || (event.issue !== null && issues.has(event.issue));
    case 'worktree.hook_summary': return event.pr === pr.read.number;
  }
}

/** The friction codes of an event, each with its count: refusal and blocker codes, and the blocked or failed hook counts. */
function frictionCodes(event: RetroEventV1): [string, number][] {
  if (event.kind === 'cli.friction') return [[event.error_code, 1], ...event.blocker_codes.map((code): [string, number] => [code, 1])];
  if (event.kind === 'worktree.hook_summary') return Object.entries(event.counts_by_code).filter(([code, count]) => !code.endsWith('.ok') && count > 0);
  return [];
}

/**
 * The phases of one pull request, from protocol comment, Actions run and index times; a phase without both of its ends is left out.
 * `write`: the first seat launch of the pull request or its issues, to its first run. `ci`: each completed run, start to last update.
 * `review_wait`: each review start, from the newest completed run before it. `review_run`: each acceptance record, from the newest
 * review start before it. `merge_wait`: the merge, from the newest acceptance record before it.
 */
function phases(pr: RetroPullRequestInputV1, events: readonly RetroEventV1[], truncated: boolean): Record<keyof BoardRetroV1['phase_median_ms'], number[]> {
  const launches = events.filter(event => event.kind === 'seat.lifecycle' && event.phase === 'launch').map(event => ms(event.at));
  const runStarts = pr.runs.map(run => ms(run.created_at));
  const runEnds = pr.runs.filter(run => run.completed).map(run => ms(run.updated_at));
  const write = launches.length > 0 && runStarts.length > 0 ? [Math.min(...runStarts) - Math.min(...launches)].filter(value => value >= 0) : [];
  const ci = pr.runs.filter(run => run.completed).map(run => ms(run.updated_at) - ms(run.started_at));
  if (truncated) return { write, ci, review_wait: [], review_run: [], merge_wait: [] };
  const starts = protocolComments(pr.read.comments, REVIEW_START_HEADER).map(comment => ms(comment.created_at));
  const records = protocolComments(pr.read.comments, ACCEPTANCE_RECORD_HEADER).filter(comment => parseAcceptanceRecord(comment) !== null).map(comment => ms(comment.created_at));
  const gap = (end: number, from: readonly number[]): number[] => { const begin = lastBefore(from, end); return begin === null ? [] : [end - begin]; };
  const merged = pr.read.merged_at === null ? [] : gap(ms(pr.read.merged_at), records);
  return { write, ci, review_wait: starts.flatMap(start => gap(start, runEnds)), review_run: records.flatMap(record => gap(record, starts)), merge_wait: merged };
}

function topCounts(entries: Iterable<[string, number]>): { code: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const [code, count] of entries) counts.set(code, (counts.get(code) ?? 0) + count);
  return [...counts].map(([code, count]) => ({ code, count })).sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)).slice(0, TOP_CODES);
}

export function projectBoardRetro(input: RetroInputV1): BoardRetroV1 {
  const prs = input.pull_requests.map((pr) => {
    const events = input.events.filter(event => relatedEvent(event, pr));
    const truncated = pr.read.comments.truncated;
    const records = protocolComments(pr.read.comments, ACCEPTANCE_RECORD_HEADER).flatMap(comment => { const rows = parseAcceptanceRecord(comment); return rows === null ? [] : [{ comment, rows }]; });
    const firstEvent = events.map(event => ms(event.at));
    const firstRun = pr.runs.map(run => ms(run.created_at));
    const start = [...firstEvent, ...firstRun];
    return {
      pr, events, truncated,
      phases: phases(pr, events, truncated),
      rounds: records.flatMap(({ rows }) => rows.map(row => row.round)).reduce((top, round) => Math.max(top, round), 0),
      fail_comment_ids: records.filter(({ rows }) => rows.some(row => row.verdict === 'FAIL')).flatMap(({ comment }) => { const id = commentId(comment.url); return id === null ? [] : [id]; }),
      friction: events.flatMap(frictionCodes),
      wall_clock_ms: pr.read.merged_at === null || start.length === 0 ? null : ms(pr.read.merged_at) - Math.min(...start),
    };
  });
  const clues = (entry: (typeof prs)[number]): Pick<RetroOutlierV1, 'error_codes' | 'comment_ids' | 'run_ids' | 'transcript_paths'> => ({
    error_codes: [...new Set(entry.friction.map(([code]) => code))].sort(),
    comment_ids: entry.fail_comment_ids,
    run_ids: entry.pr.runs.filter(failed).map(run => run.id),
    transcript_paths: [...new Set(entry.events.flatMap(event => event.kind === 'seat.lifecycle' && event.transcript_path !== null ? [event.transcript_path] : []))],
  });
  const prOutliers = (metric: 'wall_clock_ms' | 'ci_runs' | 'friction_count', value: (entry: (typeof prs)[number]) => number | null): RetroOutlierV1[] => prs
    .flatMap(entry => { const observed = value(entry); return observed === null || observed === 0 ? [] : [{ entry, observed }]; })
    .sort((left, right) => right.observed - left.observed || left.entry.pr.read.number - right.entry.pr.read.number).slice(0, TOP)
    .map(({ entry, observed }) => ({ metric, value: observed, pr: entry.pr.read.number, seat: null, ...clues(entry) }));
  const seatOutliers = input.events.flatMap(event => (event.kind === 'seat.lifecycle' && event.duration_ms !== null && event.duration_ms > 0 ? [event] : []))
    .sort((left, right) => right.duration_ms! - left.duration_ms! || left.at.localeCompare(right.at)).slice(0, TOP)
    .map((event): RetroOutlierV1 => ({ metric: 'seat_duration_ms', value: event.duration_ms!, pr: event.pr, seat: event.seat, error_codes: [], comment_ids: [], run_ids: [], transcript_paths: event.transcript_path === null ? [] : [event.transcript_path] }));
  const checks = new Map<string | null, number[]>();
  for (const run of prs.flatMap(entry => entry.pr.runs.filter(failed))) checks.set(run.name, [...(checks.get(run.name) ?? []), run.id]);
  const reviewed = prs.filter(entry => !entry.truncated);
  const phaseValues = (name: keyof BoardRetroV1['phase_median_ms']): number[] => prs.flatMap(entry => entry.phases[name]);
  return {
    protocol: BOARD_RETRO_PROTOCOL,
    observed_at: input.observed_at,
    repository_id: input.repository_id,
    scope: input.scope,
    closed_issues: input.closed_issues,
    merged_prs: prs.length,
    consolidation_ratio: ratio(input.closed_issues, prs.length),
    spawned_issues_per_pr: { status: 'unavailable', reason: 'no_spawn_link' },
    ci_runs_per_pr: ratio(prs.reduce((sum, entry) => sum + entry.pr.runs.length, 0), prs.length),
    top_failing_checks: [...checks].map(([name, ids]) => ({ name, failures: ids.length, run_ids: ids }))
      .sort((left, right) => right.failures - left.failures || String(left.name).localeCompare(String(right.name))).slice(0, TOP_CODES),
    review_rounds_per_pr: ratio(reviewed.reduce((sum, entry) => sum + entry.rounds, 0), reviewed.length),
    p1_fixed: { status: 'unavailable', reason: 'record_findings_have_no_severity' },
    p1_downgraded_by_jd: { status: 'unavailable', reason: 'disposition_counts_records_not_findings' },
    comments_truncated: prs.filter(entry => entry.truncated).map(entry => entry.pr.read.number),
    phase_median_ms: { write: median(phaseValues('write')), ci: median(phaseValues('ci')), review_wait: median(phaseValues('review_wait')), review_run: median(phaseValues('review_run')), merge_wait: median(phaseValues('merge_wait')) },
    top_friction_codes: topCounts(input.events.flatMap(frictionCodes)),
    outliers: [
      ...prOutliers('wall_clock_ms', entry => entry.wall_clock_ms),
      ...prOutliers('ci_runs', entry => entry.pr.runs.length),
      ...prOutliers('friction_count', entry => entry.friction.reduce((sum, [, count]) => sum + count, 0)),
      ...seatOutliers,
    ],
  };
}
