import { Command } from 'commander';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { fileURLToPath } from 'url';
import { AdvisorSeatError, advisorSeatSendFailure, readAdvisorSeat, sendToAdvisorSeat } from '../../core/board/advisor-seat';
import { AttentionWatchError, attentionLogPath, runAttentionWindow, serviceTerminalRepository, startAttentionWatch } from '../../effects/board/attention-watch';
import { evaluateBoardAttention, renderAttentionText } from '../../core/board/attention';
import type { AttentionHostPortsV1, AttentionSentV1 } from '../../core/board/attention-delivery';
import type { BoardHostPortsV1, BoardV1 } from '../../core/board/board';
import { BoardSourceError } from '../../core/board/source';
import { BoardCollectError, collectBoard, collectBoardThrough, readGhJson, readParent, readPullRequests, readRepositoryId } from '../../effects/board/collect';
import { createKeyedSources } from '../../effects/board/keyed-sources';
import { renderDependencyMigrationPlan } from '../../core/board/dependency-migration';
import { DependencyMigrationError, runDependencyMigration, type DependencyMigrationResultV1 } from '../../effects/board/dependency-migration';
import { BoardParentsError, collectBoardParents } from '../../effects/board/parents';
import { DEFAULT_CLUSTER_MAX_SIZE } from '../../core/board/cluster';
import { collectBoardCluster } from '../../effects/board/cluster';
import { BoardSeatsError, collectBoardSeats } from '../../effects/board/seats';
import { gitHubPostPorts, runBoardPost, type BoardPostPorts } from '../../effects/board/post';
import { BoardPostFieldsError, BoardPostRoundtripError, BoardPostSupersedesError, BOARD_POST_KINDS } from '../../core/board/post';
import { TriageApplyValidationError } from '../../core/board/triage-apply';
import { gitHubTriageApplyPorts, readTriageManifestFile, runTriageApply, type TriageApplyPorts, type TriageApplyResultV1 } from '../../effects/board/triage-apply';
import { DispatchError, type DispatchPlanV1 } from '../../core/board/dispatch';
import { runDispatch } from '../../effects/board/dispatch';
import { runReview, type ReviewObserver, type ReviewResultV1 } from '../../effects/board/review';
import { runBoardMerge, type BoardMergeResultV1 } from '../../effects/board/merge';
import { seatLaunch, SeatProviderUnavailableError } from './seats';
import { runBoardCloseout, stopArchitectureDaemons, stopCodegraphServers } from '../../effects/board/closeout';
import { worktreeProcesses } from '../../effects/git/worktree-processes';
import { LIFECYCLE_EVENT_PROTOCOL, lifecycleIndexPath, recordLifecycleEvents, sanitized, summarizeWorktreeHooks, type CliFrictionEvent, type LifecycleEvent } from '../../effects/board/lifecycle-index';
import { bodyLinks, linkedPullRequests } from '../../core/board/board';
import { projectBoardRetro, type RetroEventV1, type RetroPullRequestInputV1, type RetroRunV1 } from '../../core/board/retro';
import type { BoardPullRequestReadV1 } from '../../core/board/source';
import { HOOK_EVENT_TELEMETRY_PATH, HOOK_EVENT_TELEMETRY_PROTOCOL } from '../hook/event-telemetry';
import { ROUTES } from '../hook/route-registry';
import type { BoardCloseoutV1 } from '../../effects/board/closeout';
import type { DispatchResultV1 } from '../../effects/board/dispatch';
import type { DispatchSkipReason } from '../../core/board/dispatch';
import type { ReviewSkipReason } from '../../core/board/review';

interface BoardOptions {
  readonly parent?: string;
  readonly json?: boolean;
}

interface ClusterOptions extends BoardOptions {
  readonly open?: boolean;
  readonly includeLoose?: boolean;
  readonly maxSize: string;
}

interface AttentionOptions extends BoardOptions {
  readonly watch?: boolean;
  readonly deliver?: boolean;
  readonly review?: boolean;
  readonly space?: string;
}

const CLI_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));

interface MigrateDependenciesOptions extends BoardOptions {
  readonly apply?: boolean;
  readonly plan?: string;
}

interface PostOptions extends BoardOptions {
  readonly target: string;
  readonly fieldsFile: string;
  readonly dryRun?: boolean;
}

interface TriageApplyOptions extends BoardOptions {
  readonly manifest: string;
  readonly dryRun?: boolean;
}

function parentNumber(options: BoardOptions): number {
  if (options.parent === undefined || !/^[1-9][0-9]*$/u.test(options.parent)) throw new BoardCollectError('--parent <issue number> is required');
  return Number(options.parent);
}

/** `--issues a,b,c`: two or more distinct issue numbers. */
function bundleIssues(value: string): readonly number[] {
  const entries = value.split(',');
  if (entries.length < 2 || entries.some(entry => !/^[1-9][0-9]*$/u.test(entry)) || new Set(entries).size !== entries.length) {
    throw new BoardCollectError('--issues takes two or more distinct issue numbers separated by commas, such as 12,13');
  }
  return entries.map(Number);
}

/** The one JSON object of `--fields-file`; a path that does not read, or that holds no JSON object, is refused input. */
function readFieldsFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new BoardPostFieldsError('fields', `the file ${path} cannot be read`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BoardPostFieldsError('fields', `the file ${path} is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BoardPostFieldsError('fields', 'not a JSON object');
  return value as Record<string, unknown>;
}

/** A collect or source failure is the whole result; the board has no partial form. */
function guarded<T extends BoardOptions>(action: (options: T) => void): (options: T) => void {
  return (options) => {
    try {
      action(options);
    } catch (error) {
      if (!(error instanceof BoardCollectError || error instanceof BoardSourceError || error instanceof AttentionWatchError)) throw error;
      process.stderr.write(`${JSON.stringify({ ok: false, error: error.name, message: error.message })}\n`);
      process.exitCode = 1;
    }
  };
}

function migrationText(result: DependencyMigrationResultV1): string {
  return [...result.labels.map(label => `label ${label.name}: ${label.result}`),
    ...result.edges.map(edge => `#${edge.issue} blocked by #${edge.blocker}: ${edge.result} (line ${edge.line_number}: ${edge.line.trim()})`),
    ...result.skipped.map(line => `#${line.issue} line ${line.line_number}: skipped (${line.line.trim()})`)].join('\n') + '\n';
}

function dispatchText(plan: DispatchPlanV1, started: readonly number[]): string {
  return plan.decisions.map(decision => decision.action === 'skip'
    ? `#${decision.issue} skipped (${decision.reason}): ${decision.detail}`
    : `#${decision.issue} ${started.includes(decision.issue) ? 'started' : 'ready'} on ${decision.seat}: ${decision.route_line}`).join('\n') + '\n';
}

function reviewText(result: ReviewResultV1): string {
  const started = new Set(result.started.map(entry => `${entry.pr}:${entry.seat}`));
  const refused = new Map(result.refused.map(entry => [entry.pr, entry.reason]));
  const lines = result.decisions.map(decision => decision.action === 'skip'
    ? `PR #${decision.pr} skipped (${decision.reason}): ${decision.detail}`
    : refused.has(decision.pr) ? `PR #${decision.pr} refused: ${refused.get(decision.pr)}`
      : `PR #${decision.pr} ${decision.seats.map(({ seat, delta_from }) => `${started.has(`${decision.pr}:${seat}`) ? 'started' : 'ready'} on ${seat} (${delta_from === null ? 'full review' : `delta review since ${delta_from}`})`).join('; ')}`);
  return `${lines.join('\n')}\n`;
}

function mergeText(result: BoardMergeResultV1, requested: number | null, dryRun: boolean): string {
  const lines = result.decisions.map(decision => (decision.eligible ? `PR #${decision.pr} eligible` : `PR #${decision.pr} not eligible (${decision.reason}): ${decision.detail}`));
  if (requested !== null && !result.decisions.some(decision => decision.pr === requested)) lines.push(`PR #${requested} is not an open pull request of the board`);
  if (result.target === null) lines.push('no eligible pull request selected; nothing merged');
  else if (dryRun) lines.push(`PR #${result.target} would merge`);
  else lines.push(JSON.stringify(result.merge));
  return `${lines.join('\n')}\n`;
}

/** Skip reasons that show a routing, quota or plan problem; the other reasons are ordinary board state. */
const DISPATCH_FRICTION: ReadonlySet<DispatchSkipReason> = new Set(['kind_label_invalid', 'tier_invalid', 'tier_mixed', 'route_conflict', 'no_route', 'over_limit']);
const REVIEW_FRICTION: ReadonlySet<ReviewSkipReason> = new Set(['acceptance_unknown', 'writer_family_unknown', 'review_family_unavailable', 'plan_unavailable']);

/** The closed error code of a refused board command; the message is free text and never leaves the command. */
function boardErrorCode(error: Error): string {
  if (error instanceof SeatProviderUnavailableError) return error.code;
  return error instanceof DispatchError ? 'dispatch_refused' : error instanceof BoardSourceError ? 'board_source_invalid' : 'board_collect_failed';
}

const friction = (command: CliFrictionEvent['command'], fields: Partial<Pick<CliFrictionEvent, 'issue' | 'pr'>> & { readonly error_code: string }): CliFrictionEvent =>
  ({ kind: 'cli.friction', command, issue: fields.issue ?? null, pr: fields.pr ?? null, error_code: fields.error_code, blocker_codes: [] });

const seatEvent = (phase: 'launch' | 'close', seat: string, fields: { readonly terminal?: string; readonly issue?: number; readonly pr?: number | null }): LifecycleEvent => ({
  kind: 'seat.lifecycle', phase, seat, terminal: fields.terminal ?? null, issues: fields.issue === undefined ? [] : [fields.issue], pr: fields.pr ?? null,
  model: null, duration_ms: null, transcript_path: null,
});

function dispatchEvents(result: DispatchResultV1): LifecycleEvent[] {
  return [...result.started.map(entry => seatEvent('launch', entry.seat, { issue: entry.issue })),
    ...result.plan.decisions.flatMap(decision => decision.action === 'skip' && DISPATCH_FRICTION.has(decision.reason)
      ? [friction('board_dispatch', { issue: decision.issue, error_code: decision.reason })] : [])];
}

function reviewEvents(result: ReviewResultV1): LifecycleEvent[] {
  return [...result.started.map(entry => seatEvent('launch', entry.seat, { pr: entry.pr })),
    ...result.decisions.flatMap(decision => decision.action === 'skip' && REVIEW_FRICTION.has(decision.reason)
      ? [friction('board_review', { pr: decision.pr, error_code: decision.reason })] : []),
    ...result.refused.map(entry => friction('board_review', { pr: entry.pr, error_code: 'review_start_refused' }))];
}

/** A closed seat terminal, and the hook counts of a worktree whose checkout is gone; a kept checkout keeps its log for a later closeout. */
export function closeoutEvents(result: BoardCloseoutV1): LifecycleEvent[] {
  const closed = [...result.panes.map(pane => ({ pane, pr: result.pr })), ...result.stale_terminals.map(pane => ({ pane, pr: null }))]
    .flatMap(({ pane, pr }) => pane.outcome === 'closed' && pane.seat !== null ? [seatEvent('close', pane.seat, { terminal: pane.address, pr })] : []);
  const hooks = result.hook_summary !== null && result.worktree.checkout_present === false ? [{
    kind: 'worktree.hook_summary' as const, worktree_id: basename(result.worktree.path), pr: result.pr, branch: result.hook_summary.branch, counts_by_code: result.hook_summary.counts_by_code,
  }] : [];
  return [...closed, ...hooks];
}

type IndexedEvent = LifecycleEvent & { readonly at: string };

/** One record of the lifecycle index of `repositoryId` that the writer's own I1 shape gate accepts. */
function indexedEvent(record: unknown, repositoryId: number): record is IndexedEvent {
  if (typeof record !== 'object' || record === null) return false;
  const { protocol, repository_id: repository, at } = record as Record<string, unknown>;
  if (protocol !== LIFECYCLE_EVENT_PROTOCOL || repository !== repositoryId || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return false;
  // A record with a missing list throws inside the gate; it is refused like any other shape.
  try { return sanitized(record as LifecycleEvent); } catch { return false; }
}

/** The events of the lifecycle index. The file is user-writable input: a missing file or any line that the gate refuses ends the retro. */
function readLifecycleIndex(repositoryId: number, env: NodeJS.ProcessEnv): IndexedEvent[] {
  const path = lifecycleIndexPath(repositoryId, env);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new BoardCollectError(`the lifecycle index ${path} cannot be read; run rh board commands that record events first`); }
  return text.split('\n').flatMap((line, at) => {
    if (line === '') return [];
    let record: unknown = null;
    try { record = JSON.parse(line); } catch { /* refused below */ }
    if (!indexedEvent(record, repositoryId)) throw new BoardCollectError(`the lifecycle index ${path} line ${at + 1} is not a lifecycle event of repository ${repositoryId}`);
    return [record];
  });
}

/** The most Actions runs that one read returns for a pull request. */
const RETRO_RUN_PAGE = 100;
/** The most merged pull requests or closed issues of one `--since` window. */
const RETRO_LIST_LIMIT = 500;
const CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,127}$/u;
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Scope the Actions page and its count to the lifetime of the merged pull request. */
function readRetroRuns(repo_root: string, repository: string, read: BoardPullRequestReadV1): RetroRunV1[] {
  const pull = readGhJson({ repo_root }, ['api', '--hostname', 'github.com', `repos/${repository}/pulls/${read.number}`]) as { created_at?: unknown } | null;
  if (!isTime(pull?.created_at) || read.merged_at === null) throw new BoardCollectError(`the lifetime of PR #${read.number} is unavailable`);
  const created = encodeURIComponent(`${pull.created_at}..${read.merged_at}`);
  const body = readGhJson({ repo_root }, ['api', '--hostname', 'github.com',
    `repos/${repository}/actions/runs?branch=${encodeURIComponent(read.head_ref)}&event=pull_request&created=${created}&per_page=${RETRO_RUN_PAGE}`]) as { total_count?: unknown; workflow_runs?: unknown } | null;
  const runs = body?.workflow_runs;
  if (!Array.isArray(runs) || typeof body?.total_count !== 'number') throw new BoardCollectError(`the Actions runs of PR #${read.number} are not a run list`);
  if (body.total_count > runs.length) throw new BoardCollectError(`PR #${read.number} has more than ${RETRO_RUN_PAGE} Actions runs`);
  return runs.map((value: Record<string, unknown>) => {
    const { id, name, status, conclusion, created_at, run_started_at, updated_at } = value ?? {};
    if (!Number.isSafeInteger(id) || typeof status !== 'string' || (conclusion !== null && typeof conclusion !== 'string') || !isTime(created_at) || !isTime(run_started_at) || !isTime(updated_at)) {
      throw new BoardCollectError(`an Actions run of PR #${read.number} has an invalid field`);
    }
    return { id: id as number, name: typeof name === 'string' && CHECK_NAME.test(name) ? name : null, conclusion, created_at, started_at: run_started_at, updated_at, completed: status === 'completed' };
  });
}

/** The numbers of a `gh pr list` or `gh issue list` answer; a full page refuses the window, because a count would be short. */
function listedNumbers(repo_root: string, kind: 'pr' | 'issue', search: string): number[] {
  const list = readGhJson({ repo_root }, [kind, 'list', '--state', kind === 'pr' ? 'merged' : 'closed', '--search', search, '--json', 'number', '--limit', String(RETRO_LIST_LIMIT + 1)]);
  if (!Array.isArray(list) || !list.every(entry => Number.isSafeInteger(entry?.number))) throw new BoardCollectError(`gh ${kind} list did not return numbers`);
  if (list.length > RETRO_LIST_LIMIT) throw new BoardCollectError(`the window holds more than ${RETRO_LIST_LIMIT} ${kind === 'pr' ? 'merged pull requests' : 'closed issues'}; pass a shorter --since`);
  return list.map(entry => entry.number as number);
}

const DURATION_MS = { h: 3_600_000, d: 86_400_000 } as const;

/** `--since <n>h|<n>d`: the start of the window. */
function sinceStart(value: string, now: Date): string {
  const match = /^([1-9][0-9]{0,4})([hd])$/u.exec(value);
  if (match === null) throw new BoardCollectError('--since takes a duration such as 48h or 14d');
  // GitHub search dates take whole seconds.
  return new Date(now.getTime() - Number(match[1]) * DURATION_MS[match[2] as 'h' | 'd']).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** `rh board retro`: one read of GitHub and the lifecycle index, no write. Exactly one of `--parent` and `--since` selects the scope. */
function collectRetro(options: BoardOptions & { readonly since?: string }, env: NodeJS.ProcessEnv): ReturnType<typeof projectBoardRetro> {
  if ((options.parent === undefined) === (options.since === undefined)) throw new BoardCollectError('board retro takes exactly one of --parent <issue number> and --since <duration>');
  const repo_root = process.cwd();
  const now = new Date();
  const repositoryId = readRepositoryId({ repo_root });
  const events = readLifecycleIndex(repositoryId, env);
  const pullRequests = (repository: string, reads: readonly BoardPullRequestReadV1[], scope: (issue: number) => boolean): RetroPullRequestInputV1[] =>
    reads.filter(read => read.state === 'merged').map((read) => {
      const { closes, refs } = bodyLinks(repository, read.body);
      return { read, issues: [...new Set([...closes, ...refs])].filter(scope), runs: readRetroRuns(repo_root, repository, read) };
    });
  if (options.since === undefined) {
    const { parent } = readParent({ repo_root, parent: parentNumber(options) });
    const [owner, name] = parent.repository.name_with_owner.split('/') as [string, string];
    const candidates = [...new Set(parent.sub_issues.flatMap(issue => issue.pull_request_candidates))].sort((left, right) => left - right);
    const linked = linkedPullRequests(parent, readPullRequests({ repo_root }, owner, name, candidates));
    const issues = new Set(parent.sub_issues.map(issue => issue.number));
    const prs = new Set(linked.map(read => read.number));
    const related = (event: IndexedEvent): boolean => event.kind === 'seat.lifecycle' ? (event.pr !== null && prs.has(event.pr)) || event.issues.some(issue => issues.has(issue))
      : event.kind === 'cli.friction' ? (event.pr !== null && prs.has(event.pr)) || (event.issue !== null && issues.has(event.issue)) : prs.has(event.pr);
    return projectBoardRetro({
      observed_at: now.toISOString(), repository_id: repositoryId, scope: { parent: parent.parent.number },
      closed_issues: parent.sub_issues.filter(issue => issue.state === 'closed').length,
      pull_requests: pullRequests(parent.repository.name_with_owner, linked, issue => issues.has(issue)), events: events.filter(related) satisfies RetroEventV1[],
    });
  }
  const since = sinceStart(options.since, now);
  const repository = (readGhJson({ repo_root }, ['repo', 'view', '--json', 'nameWithOwner']) as { nameWithOwner?: unknown } | null)?.nameWithOwner;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new BoardCollectError('the local GitHub repository is unknown');
  const [owner, name] = repository.split('/') as [string, string];
  const merged = listedNumbers(repo_root, 'pr', `merged:>=${since}`);
  return projectBoardRetro({
    observed_at: now.toISOString(), repository_id: repositoryId, scope: { since },
    closed_issues: listedNumbers(repo_root, 'issue', `closed:>=${since}`).length,
    pull_requests: pullRequests(repository, readPullRequests({ repo_root }, owner, name, merged), () => true), events: events.filter(event => Date.parse(event.at) >= Date.parse(since)),
  });
}

/**
 * `--parent` and `--json` belong to `board`. The root program does not use
 * positional options, so Commander binds them to `board` wherever they
 * appear; `board attention` reads them with `optsWithGlobals()`. They are not
 * mandatory options, because Commander would then check them for the
 * subcommand's ancestors too; `parentNumber` checks `--parent`.
 *
 * `postPorts` is the seam of `board post`: the composition root leaves it out, so the command reads and posts through `gh`, and a test
 * passes its own ports to prove that `--dry-run` writes nothing.
 */
function triageApplyText(result: TriageApplyResultV1): string {
  const lines = result.operations.map((op) => {
    switch (op.kind) {
      case 'set_labels': return `set_labels #${op.issue}: ${op.labels.join(', ')}`;
      case 'add_sub_issue': return `add_sub_issue #${op.parent} <- #${op.issue}`;
      case 'close_duplicate': return `close_duplicate #${op.issue} -> #${op.canonical}`;
      case 'post_plan': return result.dry_run
        ? `post_plan #${op.parent}: dry-run (${op.body.split('\n').length} lines)`
        : `post_plan #${op.parent}: ${result.plan_comment_url}`;
    }
  });
  return `${lines.join('\n')}\n`;
}

export function buildBoardCommand(host: BoardHostPortsV1, attentionHost: AttentionHostPortsV1,
  postPorts: (repo_root: string) => BoardPostPorts = gitHubPostPorts,
  triagePorts: (repo_root: string) => TriageApplyPorts = repoRoot => gitHubTriageApplyPorts(repoRoot)): Command {
  const board = new Command('board')
    .description('Read a parent issue board, or list the parents and seats of this repository')
    .option('--parent <number>', 'Parent issue number')
    .option('--json', 'Output JSON: the repo-harness.board document, or with attention the repo-harness.board-attention document')
    .action(guarded((options: BoardOptions) => {
      if (options.json !== true) throw new BoardCollectError('board prints JSON only; pass --json');
      process.stdout.write(`${JSON.stringify(collectBoard({ repo_root: process.cwd(), parent: parentNumber(options), host }))}\n`);
    }));
  const attention = board.command('attention')
    .description('Run the attention rules on the board of one parent issue (takes the board options --parent and --json)')
    .option('--watch', 'Stay resident: one board read per window (15 min while a worker seat runs, else 60 min); runs only in the terminal that `attention start` opens')
    .option('--deliver', 'With --watch: send the findings to the seat terminals with hc send')
    .option('--review', 'With --watch --deliver: run `board review` once per window and report each start or refusal (needs --space)')
    .option('--space <id>', 'With --review: the Herdr space that receives the review tabs')
    .action(async (_options: AttentionOptions, command: Command) => {
      const options = command.optsWithGlobals<AttentionOptions>();
      if (options.watch === true) return watchAttention(options, host, attentionHost);
      guarded((options: AttentionOptions) => {
        if (options.deliver === true) throw new AttentionWatchError('--deliver needs --watch');
        if (options.review === true) throw new AttentionWatchError('--review needs --watch');
        const attention = evaluateBoardAttention(collectBoard({ repo_root: process.cwd(), parent: parentNumber(options), host }));
        process.stdout.write(options.json === true ? `${JSON.stringify(attention)}\n` : renderAttentionText(attention));
      })(options);
    });
  attention.command('start')
    .description('Start the resident watcher (--watch --deliver) of one parent issue in a new hc terminal, unless one is live (takes --parent)')
    .option('--review', 'Start the watcher with --review (needs --space)')
    .option('--space <id>', 'With --review: the Herdr space that receives the review tabs')
    .action((_options: AttentionOptions, command: Command) => guarded((options: AttentionOptions) => {
      if (options.review === true && options.space === undefined) throw new AttentionWatchError('--review needs --space');
      const parent = parentNumber(options);
      const result = startAttentionWatch({ parent, repository_id: readRepositoryId({ repo_root: process.cwd() }), repo_root: process.cwd(), cli: [process.execPath, CLI_ENTRY], host: attentionHost, ...(options.review === true ? { review_space: options.space } : {}) });
      process.stdout.write(`${result.started ? 'Started' : 'Already live:'} the attention watcher of #${parent} in hc terminal ${result.address}.\n`);
    })(command.optsWithGlobals<AttentionOptions>()));
  board.command('parents')
    .description('List the open parent issues of this repository: open issues with sub-issues, their progress and live hc seat count (takes --json)')
    .action((_options: BoardOptions, command: Command) => {
      try {
        if (command.optsWithGlobals<BoardOptions>().json !== true) throw new BoardCollectError('board parents prints JSON only; pass --json');
        process.stdout.write(`${JSON.stringify(collectBoardParents({ repo_root: process.cwd(), host }))}\n`);
      } catch (error) {
        if (!(error instanceof BoardParentsError || error instanceof BoardSourceError || error instanceof BoardCollectError)) throw error;
        const code = error instanceof BoardParentsError ? { code: error.code } : {};
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.name, ...code, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  board.command('cluster')
    .description('Group loose open issues or one parent’s open sub-issues (takes --parent and --json)')
    .option('--open', 'Scan loose open issues of this repository')
    .option('--include-loose', 'With --parent: combine unclaimed parent sub-issues with loose open issues')
    .option('--max-size <n>', 'Maximum size of a standard-tier bundle', String(DEFAULT_CLUSTER_MAX_SIZE))
    .action((_options: ClusterOptions, command: Command) => guarded((options: ClusterOptions) => {
      if (options.json !== true) throw new BoardCollectError('board cluster prints JSON only; pass --json');
      if ((options.open === true) === (options.parent !== undefined)) throw new BoardCollectError('board cluster takes exactly one of --open and --parent <issue number>');
      if (options.includeLoose === true && options.parent === undefined) throw new BoardCollectError('--include-loose requires --parent <issue number>');
      const max_size = Number(options.maxSize);
      if (!/^[1-9][0-9]*$/u.test(options.maxSize) || !Number.isSafeInteger(max_size)) throw new BoardCollectError('--max-size must be a positive integer');
      const parent = options.open === true ? null : parentNumber(options);
      if (parent !== null && !Number.isSafeInteger(parent)) throw new BoardCollectError('--parent must be an issue number');
      process.stdout.write(`${JSON.stringify(collectBoardCluster({ repo_root: process.cwd(), parent, max_size, include_loose: options.includeLoose === true }))}\n`);
    })(command.optsWithGlobals<ClusterOptions>()));
  board.command('triage-apply')
    .description('Validate a triage bundle manifest against ADR-0006 §6 split red lines and apply labels, sub-issue links, duplicate closures, and the plan comment')
    .requiredOption('--manifest <path>', 'Path to the repo-harness.triage-manifest/v1 JSON file')
    .option('--dry-run', 'Validate manifest and print the planned operations without writing to GitHub')
    .action((_options: TriageApplyOptions, command: Command) => {
      const options = command.optsWithGlobals<TriageApplyOptions>();
      try {
        const repo_root = process.cwd();
        const manifest = readTriageManifestFile(options.manifest);
        const result = runTriageApply({
          repo_root,
          manifest,
          dry_run: options.dryRun === true,
          ...(options.dryRun === true ? {} : { ports: triagePorts(repo_root) }),
        });
        process.stdout.write(options.json === true ? `${JSON.stringify(result)}\n` : triageApplyText(result));
      } catch (error) {
        if (!(error instanceof TriageApplyValidationError || error instanceof BoardPostFieldsError || error instanceof BoardPostRoundtripError
          || error instanceof BoardPostSupersedesError || error instanceof BoardCollectError)) throw error;
        const code = error instanceof BoardCollectError ? null : error.code;
        process.stderr.write(`${JSON.stringify({ ok: false, error: code ?? error.name, message: code === null ? error.message : `${code}: ${error.message}` })}\n`);
        process.exitCode = error instanceof TriageApplyValidationError || error instanceof BoardPostFieldsError || error instanceof BoardPostSupersedesError ? 2 : 1;
      }
    });
  board.command('dispatch')
    .description('Start a seat for each ready unit of the plan (takes --parent): worktree, claim comment on each open issue of the unit and worker tab, on the seat that the quota route names')
    .requiredOption('--space <id>', 'Herdr space that receives the worker tabs')
    .option('--dry-run', 'Print the decision for each plan issue and start nothing')
    .option('--issues <a,b,c>', 'Start only the plan unit with exactly these issues; each claim names the bundle, and nothing starts unless every open issue of the unit is ready')
    .option('--early-start', 'Allow the plan unit selected by --issues to start before its blockers close')
    .action(async (options: { space: string; dryRun?: boolean; issues?: string; earlyStart?: boolean }, command: Command) => {
      if (options.earlyStart && options.issues === undefined) command.error('--early-start requires --issues');
      try {
        const parent = parentNumber(command.optsWithGlobals<BoardOptions>());
        const result = await runDispatch({
          repo_root: process.cwd(), parent, space: options.space, host, dry_run: options.dryRun === true,
          bundle: options.issues === undefined ? null : bundleIssues(options.issues), earlyStart: options.earlyStart,
          launch: (seat, labels, cwd) => seatLaunch(seat, labels, process.env, cwd),
        });
        process.stdout.write(dispatchText(result.plan, result.started.map(entry => entry.issue)));
        if (options.dryRun !== true) recordLifecycleEvents(() => readRepositoryId({ repo_root: process.cwd() }), dispatchEvents(result), process.env);
      } catch (error) {
        if (!(error instanceof BoardCollectError || error instanceof BoardSourceError || error instanceof DispatchError || error instanceof SeatProviderUnavailableError)) throw error;
        recordLifecycleEvents(() => readRepositoryId({ repo_root: process.cwd() }), [friction('board_dispatch', { error_code: boardErrorCode(error) })], process.env);
        process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof SeatProviderUnavailableError ? error.code : error.name, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  board.command('review')
    .description('Start the review seat of each ready, green pull request with no start marker for its head (takes --parent): marker comment and review tab in the writer worktree')
    .requiredOption('--space <id>', 'Herdr space that receives the review tabs')
    .option('--pr <number>', 'Review this pull request only')
    .option('--dry-run', 'Print the decision for each pull request and start nothing')
    .action(async (options: { space: string; pr?: string; dryRun?: boolean }, command: Command) => {
      try {
        if (options.pr !== undefined && !/^[1-9][0-9]*$/u.test(options.pr)) throw new BoardCollectError('--pr must be a pull request number');
        const result = await runReview({
          repo_root: process.cwd(), parent: parentNumber(command.optsWithGlobals<BoardOptions>()), space: options.space, host, dry_run: options.dryRun === true,
          ...(options.pr === undefined ? {} : { pr: Number(options.pr) }),
          launch: (seat, labels, cwd, gatekeeper) => seatLaunch(seat, labels, process.env, cwd, gatekeeper),
        });
        process.stdout.write(reviewText(result));
        if (options.dryRun !== true) recordLifecycleEvents(() => readRepositoryId({ repo_root: process.cwd() }), reviewEvents(result), process.env);
      } catch (error) {
        if (!(error instanceof BoardCollectError || error instanceof BoardSourceError || error instanceof SeatProviderUnavailableError)) throw error;
        recordLifecycleEvents(() => readRepositoryId({ repo_root: process.cwd() }), [friction('board_review', { error_code: boardErrorCode(error) })], process.env);
        process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof SeatProviderUnavailableError ? error.code : error.name, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  board.command('merge')
    .description('Merge one eligible pull request of the parent with publication merge (takes --parent): PASS record for the head, Required / CI, readiness, plan order and no hold. Start it from the orchestrator seat; exit codes follow publication merge, 4 when none is eligible')
    .option('--pr <number>', 'The pull request to merge; default: the first eligible one in plan merge order')
    .option('--dry-run', 'Print the decision for each pull request and merge nothing')
    .action((options: { pr?: string; dryRun?: boolean }, command: Command) => {
      try {
        if (options.pr !== undefined && !/^[1-9][0-9]*$/u.test(options.pr)) throw new BoardCollectError('--pr must be a pull request number');
        const pr = options.pr === undefined ? null : Number(options.pr);
        const result = runBoardMerge({ repo_root: process.cwd(), parent: parentNumber(command.optsWithGlobals<BoardOptions>()), host, pr, dry_run: options.dryRun === true });
        process.stdout.write(mergeText(result, pr, options.dryRun === true));
        process.exitCode = result.exit_code;
      } catch (error) {
        if (!(error instanceof BoardCollectError || error instanceof BoardSourceError)) throw error;
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.name, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  board.command('seats')
    .description('List every live seat of this repository, with or without a parent label (takes --json)')
    .action((_options: BoardOptions, command: Command) => {
      try {
        if (command.optsWithGlobals<BoardOptions>().json !== true) throw new BoardCollectError('board seats prints JSON only; pass --json');
        process.stdout.write(`${JSON.stringify(collectBoardSeats({ repo_root: process.cwd(), host }))}\n`);
      } catch (error) {
        if (!(error instanceof BoardSeatsError || error instanceof BoardCollectError)) throw error;
        const code = error instanceof BoardSeatsError ? { code: error.code } : {};
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.name, ...code, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  board.command('retro')
    .description('Read-only retro of one parent (--parent) or of a window (--since 48h|14d): merged pull requests, their Actions runs and the lifecycle index; prints JSON')
    .option('--since <duration>', 'The window that ends now, in hours or days, such as 48h or 14d')
    .action((_options: { since?: string }, command: Command) => guarded((options: BoardOptions & { since?: string }) => {
      if (options.json !== true) throw new BoardCollectError('board retro prints JSON only; pass --json');
      process.stdout.write(`${JSON.stringify(collectRetro(options, process.env))}\n`);
    })(command.optsWithGlobals()));
  board.command('closeout')
    .description('After a merge, in the primary checkout: close each seat terminal of the pull request whose checkout is clean and pushed, then remove its merged worktree; prints JSON, exit 1 when anything is kept')
    .requiredOption('--pr <number>', 'The merged pull request')
    .action(async (options: { pr: string }) => {
      try {
        if (!/^[1-9][0-9]*$/u.test(options.pr)) throw new BoardCollectError('--pr must be a pull request number');
        const repo_root = process.cwd();
        const result = await runBoardCloseout({ repo_root, pr: Number(options.pr), host, caller_terminal: process.env.HC_TERMINAL_ID ?? null,
          stopDaemons: worktree => stopArchitectureDaemons(repo_root, worktree), processes: worktreeProcesses, stopCodegraphServers,
          summarizeHooks: worktree => summarizeWorktreeHooks(worktree, { path: HOOK_EVENT_TELEMETRY_PATH, protocol: HOOK_EVENT_TELEMETRY_PROTOCOL, routes: ROUTES }) });
        process.stdout.write(`${JSON.stringify(result)}\n`);
        recordLifecycleEvents(() => readRepositoryId({ repo_root }), closeoutEvents(result), process.env);
        if (result.panes.some(pane => pane.outcome === 'kept') || result.worktree.outcome !== 'removed' || result.daemon_stop_failures.length > 0) process.exitCode = 1;
      } catch (error) {
        if (!(error instanceof BoardCollectError)) throw error;
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.name, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  // The operator advisor seat routes (#1756) run these two commands in the registered root.
  const advisor = board.command('advisor')
    .description('The advisor seat of one parent issue: the one live terminal with the advisor seat label (takes --parent and --json)');
  // A failed send also reports the scope and the resolved terminal, so the operator audit names the seat.
  const advisorAction = (action: (scope: Parameters<typeof readAdvisorSeat>[0]) => unknown, reportsSend = false) => (_options: BoardOptions, command: Command) => {
    let scope: Parameters<typeof readAdvisorSeat>[0] | undefined;
    try {
      const options = command.optsWithGlobals<BoardOptions>();
      if (options.json !== true) throw new BoardCollectError('board advisor prints JSON only; pass --json');
      const parent = parentNumber(options);
      scope = { github_repository_id: readRepositoryId({ repo_root: process.cwd() }), parent, host };
      process.stdout.write(`${JSON.stringify(action(scope))}\n`);
    } catch (error) {
      if (!(error instanceof AdvisorSeatError || error instanceof BoardCollectError)) throw error;
      const code = error instanceof AdvisorSeatError ? { code: error.code } : {};
      const failure = reportsSend && scope !== undefined && error instanceof AdvisorSeatError ? { failure: advisorSeatSendFailure(scope, error) } : {};
      process.stderr.write(`${JSON.stringify({ ok: false, error: error.name, ...code, ...failure, message: error.message })}\n`);
      process.exitCode = 1;
    }
  };
  advisor.command('send')
    .description('Send stdin as plain text to the advisor seat terminal with hc send')
    .action(advisorAction(scope => sendToAdvisorSeat(scope, readFileSync(0, 'utf8')), true));
  advisor.command('transcript')
    .description('Read the last lines of the advisor seat terminal with hc read; every line is redacted')
    .action(advisorAction(readAdvisorSeat));
  board.command('post <kind>')
    .description(`Write one protocol comment that the board parses (${BOARD_POST_KINDS.join(', ')}), checked with its parser before it is posted`)
    .requiredOption('--target <number>', 'The issue or pull request number that receives the comment')
    .requiredOption('--fields-file <path>', 'A JSON object of the field names of the matching template in templates.md; plan also takes block, the plan block object')
    .option('--dry-run', 'Print the checked comment and post nothing')
    .action((kind: string, _options: PostOptions, command: Command) => {
      const options = command.optsWithGlobals<PostOptions>();
      try {
        if (!/^[1-9][0-9]*$/u.test(options.target)) throw new BoardPostFieldsError('target', 'not an issue or pull request number');
        const result = runBoardPost({ target: Number(options.target), kind, fields: readFieldsFile(options.fieldsFile), dry_run: options.dryRun === true }, postPorts(process.cwd()));
        if (options.json === true) process.stdout.write(`${JSON.stringify({ ok: true, kind: result.kind, url: result.url })}\n`);
        else process.stdout.write(result.url === null ? `${result.body}\n` : `${result.url}\n`);
      } catch (error) {
        if (!(error instanceof BoardPostFieldsError || error instanceof BoardPostRoundtripError || error instanceof BoardPostSupersedesError
          || error instanceof BoardCollectError)) throw error;
        // Refused fields and a plan without supersedes are refused input (exit 2); a parser that refuses the rendered text, or a failed
        // GitHub read or write, is a failure (exit 1). Neither case posted a comment.
        const code = error instanceof BoardCollectError ? null : error.code;
        process.stderr.write(`${JSON.stringify({ ok: false, error: code ?? error.name, message: code === null ? error.message : `${code}: ${error.message}` })}\n`);
        process.exitCode = error instanceof BoardPostFieldsError || error instanceof BoardPostSupersedesError ? 2 : 1;
      }
    });
  board.command('migrate-dependencies')
    .description('One-shot operator migration: plan the blocked-by links for the Depends on / 依赖 lines of the open sub-issues of one parent and the tier labels, with no write; --apply applies the plan (takes --parent and --json)')
    .option('--apply', 'Apply the plan: create the planned labels and blocked-by links (requires --plan)')
    .option('--plan <digest>', 'The plan digest that the checked run without --apply printed')
    .action((_options: MigrateDependenciesOptions, command: Command) => {
      const options = command.optsWithGlobals<MigrateDependenciesOptions>();
      try {
        const outcome = runDependencyMigration({ repo_root: process.cwd(), parent: parentNumber(options) }, { write: options.apply === true, plan: options.plan });
        if (options.json === true) process.stdout.write(`${JSON.stringify(outcome)}\n`);
        else process.stdout.write(outcome.kind === 'repo-harness.dependency-migration-plan' ? renderDependencyMigrationPlan(outcome) : migrationText(outcome));
      } catch (error) {
        if (!(error instanceof DependencyMigrationError || error instanceof BoardCollectError)) throw error;
        const done = error instanceof DependencyMigrationError ? { code: error.code, labels: error.labels, edges: error.edges } : {};
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.name, ...done, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  return board;
}

function reviewRunner(options: AttentionOptions, parent: number, host: BoardHostPortsV1): (observe: ReviewObserver) => Promise<unknown> {
  if (options.deliver !== true) throw new AttentionWatchError('--review needs --deliver');
  const space = options.space;
  if (space === undefined) throw new AttentionWatchError('--review needs --space');
  return observe => runReview({ repo_root: process.cwd(), parent, space, host, dry_run: false, observe, launch: (seat, labels, cwd, gatekeeper) => seatLaunch(seat, labels, process.env, cwd, gatekeeper) });
}

/** The resident loop. A provider 5xx or a gh call with no exit status skips one window; other board read or hc failures end it with exit 1. */
async function watchAttention(options: AttentionOptions, host: BoardHostPortsV1, attentionHost: AttentionHostPortsV1): Promise<void> {
  try {
    const parent = parentNumber(options);
    const repositoryId = serviceTerminalRepository(parent, attentionHost);
    const review = options.review === true ? reviewRunner(options, parent, host) : undefined;
    // The watcher keeps one keyed source store for its process lifetime; its review run reads its own board through a fresh one.
    const sources = createKeyedSources();
    const input = {
      parent, deliver: options.deliver === true, review, log_path: attentionLogPath(repositoryId, parent),
      collect: () => collectBoardThrough({ repo_root: process.cwd(), parent, host }, sources), host: attentionHost,
    };
    // The sent slots live in this process only: a new watcher sends each open finding once.
    let sent: AttentionSentV1 = new Map();
    // A22 compares each board read with the one before; a window whose read failed keeps the older board.
    let previous: BoardV1 | null = null;
    for (;;) {
      let read: BoardV1 | null = null;
      sent = await runAttentionWindow({ ...input, collect: () => (read = input.collect()), previous, sent });
      previous = read ?? previous;
    }
  } catch (error) {
    if (!(error instanceof BoardCollectError || error instanceof BoardSourceError || error instanceof AttentionWatchError)) throw error;
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.name, message: error.message })}\n`);
    process.exitCode = 1;
  }
}
