import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BoardSeatTerminalReadV1 } from '../../core/board/board';
import { collectBoard, type BoardCollectInput, BoardCollectError, readRepositoryId, runGhText } from './collect';
import { planReview, reviewPacket, reviewPacketHeader, REVIEW_START_HEADER, REVIEW_START_STATUS_HEADER, type ReviewDecisionV1, type ReviewSeatStartV1 } from '../../core/board/review';
import type { BoardCommentPageV1 } from '../../core/board/source';
import { isWorkerSeat, type SeatConfigV1, type SeatId } from '../../core/board/seats-settings';
import type { SeatRouteV1 } from '../../core/board/seat-routing';
import { gitSpawnSync, withoutRepositorySelectingGitEnv } from '../git/runner';
import {
  HERDR_APP_NOT_SENT, HerdrCoreError, buildHerdrSeatPlacement, herdrAppDo, herdrAppSpaceTabs,
  type HerdrAppTab, type HerdrSeatPlacementCommand,
} from '../terminal/herdr-core';
import { AGY_REVIEW_LAUNCH_ENV, AGY_REVIEW_LAUNCH_LINE, AGY_REVIEW_PROMPT_OPTION, prepareAgyReviewStartup, waitForAgyReviewBinding, type AgyReviewBinding } from './agy-review-session';
import { acquireExclusiveDirectoryLock, ExclusiveLockContentionError } from '../locking/exclusive-directory-lock';
import { repoHarnessHome } from '../repo-harness-home';
import { effectiveGatekeeper, seatAccountQuotas } from '../../core/board/seat-routing';
import { readSeatsConfiguration } from './seats-configuration';
import { readQuotaReport } from './quota';

type StartDecision = Extract<ReviewDecisionV1, { action: 'start' }>;

/**
 * What `seatLaunch` (the `seats argv` command) answers for one review seat; the command layer owns it, so the caller passes it in.
 * `gatekeeper` is the effective gatekeeper that the plan checked: the launch starts that seat and reads quota no second time.
 */
export type ReviewLaunch = (seat: ReviewSeatStartV1['seat'], labels: { readonly repositoryId: string; readonly pr: string; readonly parent: string; readonly agyReview?: AgyReviewBinding }, cwd: string, gatekeeper: SeatRouteV1) =>
  Promise<{ readonly argv: readonly string[]; readonly tab: string | null; readonly runtime: SeatConfigV1['runtime'] }>;

export interface ReviewInput extends Pick<BoardCollectInput, 'repo_root' | 'parent' | 'host'> {
  /** The Herdr space that receives the review tabs. */
  readonly space: string;
  readonly launch: ReviewLaunch;
  /** Plan only: no marker, no seat. */
  readonly dry_run: boolean;
  /** Review this pull request only. */
  readonly pr?: number;
  /** Called at each start and refusal as it happens, so a caller keeps the completed ones when a later step throws. */
  readonly observe?: ReviewObserver;
}

export type ReviewObserver = (event: { readonly kind: 'started'; readonly pr: number; readonly seat: ReviewSeatStartV1['seat']; readonly marker_url: string } | { readonly kind: 'refused'; readonly pr: number; readonly reason: string }) => void;

/** The writes and reads of one start. Each is a process boundary, so tests replace them. */
export interface ReviewPorts {
  /** The directory of the worktree whose branch is `head_ref` and whose HEAD is `head_sha`, or the reason there is none. */
  readonly worktree: (head_ref: string, head_sha: string) => { readonly path: string } | { readonly refusal: string };
  /** Posts a pull request comment and returns its URL. */
  readonly comment: (pr: number, body: string) => string;
  /** Read the current tabs of `space` from `herdr-app ls`. */
  readonly listSpaceTabs: (space: string) => readonly HerdrAppTab[];
  /** Live seat terminals of this repository, used to locate a PR's existing worker tab. */
  readonly seatTerminals: () => readonly BoardSeatTerminalReadV1[];
  /** Closing issue numbers per PR (from the board read), used to match the worker's `repo-harness.issue` label. */
  readonly closingIssues?: ReadonlyMap<number, readonly number[]>;
  /** `herdr-app do tab.new` or explicit-ID `herdr-app do pane.split` with these arguments. */
  readonly placePane: (command: HerdrSeatPlacementCommand, args: Readonly<Record<string, unknown>>) => Record<string, unknown> | void;
  readonly launch: ReviewLaunch;
  readonly agy?: { readonly hc: string | null; readonly env: NodeJS.ProcessEnv };
}

export interface WorkerTerminalLookupInput {
  readonly terminals: readonly BoardSeatTerminalReadV1[];
  readonly issues?: readonly string[];
  readonly pr?: string;
  readonly cwd?: string;
}

function canonicalDir(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/**
 * Find live worker terminal addresses belonging to a PR, in priority order:
 * 1. `repo-harness.issue` matching a closing issue of the PR
 * 2. `repo-harness.pr` matching the PR number
 * 3. worktree `cwd` matching the PR worktree (canonicalized for symlinked temp dirs such as macOS `/tmp`)
 */
export function matchingWorkerTerminals(input: WorkerTerminalLookupInput): string[] {
  const workers = input.terminals.filter(terminal =>
    terminal.state === 'live' && terminal.labels.seat !== undefined && isWorkerSeat(terminal.labels.seat as SeatId));
  const found: string[] = [];
  const add = (address: string) => { if (!found.includes(address)) found.push(address); };
  for (const issue of input.issues ?? []) {
    for (const worker of workers) {
      if (worker.labels.issue === issue) add(worker.address);
    }
  }
  if (input.pr !== undefined) {
    for (const worker of workers) {
      if (worker.labels.pr === input.pr) add(worker.address);
    }
  }
  if (input.cwd !== undefined && input.cwd !== '') {
    const target = canonicalDir(input.cwd);
    for (const worker of workers) {
      if (worker.cwd !== null && worker.cwd !== '' && canonicalDir(worker.cwd) === target) add(worker.address);
    }
  }
  return found;
}

export interface ReviewResultV1 {
  readonly decisions: readonly ReviewDecisionV1[];
  readonly started: readonly { readonly pr: number; readonly seat: ReviewSeatStartV1['seat']; readonly marker_url: string }[];
  readonly refused: readonly { readonly pr: number; readonly reason: string }[];
}

/** Every comment of one pull request: `--paginate` returns the whole thread, so the page is never truncated. */
function readComments(input: Pick<ReviewInput, 'repo_root'>, pr: number): BoardCommentPageV1 {
  const pages = JSON.parse(runGhText(input, ['api', '--hostname', 'github.com', '--paginate', '--slurp', `repos/{owner}/{repo}/issues/${pr}/comments?per_page=100`])) as
    { html_url: string; created_at: string; author_association: string; body: string }[][];
  return { truncated: false, comments: pages.flat().map(({ html_url, created_at, author_association, body }) => ({ url: html_url, created_at, author_association, body })) };
}

function worktreeAt(input: Pick<ReviewInput, 'repo_root'>, headRef: string, headSha: string): { readonly path: string } | { readonly refusal: string } {
  const run = gitSpawnSync(['worktree', 'list', '--porcelain'], { cwd: input.repo_root, env: withoutRepositorySelectingGitEnv(), encoding: 'utf8' });
  if (run.error !== undefined || run.status !== 0) return { refusal: 'git did not list the worktrees' };
  const block = run.stdout.split('\n\n').find(entry => entry.split('\n').includes(`branch refs/heads/${headRef}`));
  const path = block?.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length);
  if (path === undefined) return { refusal: `no worktree has the branch ${headRef}` };
  const head = gitSpawnSync(['rev-parse', 'HEAD'], { cwd: path, env: withoutRepositorySelectingGitEnv(), encoding: 'utf8' });
  if (head.error !== undefined || head.status !== 0) return { refusal: `git could not read HEAD of the worktree of ${headRef}` };
  return head.stdout.trim() === headSha ? { path } : { refusal: `the worktree of ${headRef} is at ${head.stdout.trim()}, not at the PR head ${headSha}` };
}

function markerBody(decision: StartDecision, start: ReviewSeatStartV1): string {
  const reading = start.delta_from === null ? 'full review' : `delta review since ${start.delta_from}`;
  return [REVIEW_START_HEADER, `Subject: ${decision.head_sha}`, `Seat: ${start.seat}`, `PR: #${decision.pr}`, `Reading: ${reading}`].join('\n');
}

function agyBinding(header: string, ports: ReviewPorts): AgyReviewBinding & { readonly launchId: string } {
  const agy = ports.agy;
  if (agy?.hc == null) throw new BoardCollectError('hc is required to bind the agy review launch to its terminal.');
  const launchId = randomUUID();
  return { launchId, startup: prepareAgyReviewStartup(launchId, agy.env), label: `${launchId} ${header}` };
}

/**
 * Resolve every launch for a `start` decision in the writer's worktree before posting a marker or opening a tab.
 * A tab request that failed before sending releases that seat's marker only, so a retry starts that seat
 * without a second one of the other. A launch that may have created the tab keeps its marker and stops, because a retry could
 * start a second seat of that role for the head.
 */
export async function executeReview(decisions: readonly ReviewDecisionV1[], context: { readonly repositoryId: string; readonly parent: number; readonly space: string; readonly dry_run: boolean; readonly gatekeeper: SeatRouteV1; readonly observe?: ReviewObserver }, ports: ReviewPorts): Promise<Omit<ReviewResultV1, 'decisions'>> {
  const started: Array<ReviewResultV1['started'][number]> = [];
  const refused: Array<ReviewResultV1['refused'][number]> = [];
  if (context.dry_run) return { started, refused };
  const refuse = (pr: number, reason: string) => { refused.push({ pr, reason }); context.observe?.({ kind: 'refused', pr, reason }); };
  for (const decision of decisions) {
    if (decision.action !== 'start') continue;
    const worktree = ports.worktree(decision.head_ref, decision.head_sha);
    if ('refusal' in worktree) {
      refuse(decision.pr, worktree.refusal);
      continue;
    }
    const launches: Array<{
      readonly start: ReviewSeatStartV1;
      readonly argv: readonly string[];
      readonly task?: string;
      readonly baseTabName: string | null;
      readonly startup?: AgyReviewBinding['startup'];
    }> = [];
    const labels = { repositoryId: context.repositoryId, pr: String(decision.pr), parent: String(context.parent) };
    for (const start of decision.seats) {
      const gatekeeper = context.gatekeeper;
      const native = start.seat === 'gatekeeper' && gatekeeper.id === 'gatekeeper-fallback' && gatekeeper.seat.runtime === 'agy'
        ? agyBinding(reviewPacketHeader(decision, start), ports)
        : undefined;
      const launchLabels = native === undefined ? labels : { ...labels, agyReview: native };
      const { runtime, argv, tab } = await ports.launch(start.seat, launchLabels, worktree.path, gatekeeper);
      const packet = reviewPacket(decision, start, runtime);
      if (runtime === 'agy') {
        if (native === undefined) throw new BoardCollectError('agy review launches require the effective gatekeeper-fallback seat.');
        const { launchId, startup } = native;
        const nativeArgv = ['/usr/bin/env', `${AGY_REVIEW_LAUNCH_ENV}=${launchId}`, ...argv, AGY_REVIEW_PROMPT_OPTION, packet + AGY_REVIEW_LAUNCH_LINE + launchId];
        launches.push({ start, argv: nativeArgv, baseTabName: tab, startup });
      } else {
        launches.push({ start, argv, task: packet, baseTabName: tab });
      }
    }
    const preferredTerminals = matchingWorkerTerminals({
      terminals: ports.seatTerminals(),
      issues: (ports.closingIssues?.get(decision.pr) ?? []).map(String),
      pr: String(decision.pr),
      cwd: worktree.path,
    });
    for (const { start, argv, task, baseTabName, startup } of launches) {
      // Read the current space layout before posting the marker so a failing `herdr-app ls` posts no orphaned marker,
      // and so a second seat in the same run sees the pane the first seat just created.
      const tabs = ports.listSpaceTabs(context.space);
      const markerUrl = ports.comment(decision.pr, markerBody(decision, start));
      const release = () => ports.comment(decision.pr, `${REVIEW_START_STATUS_HEADER}\nClaim: ${markerUrl}\nStatus: released`);
      try {
        const placement = buildHerdrSeatPlacement({
          space: context.space,
          folder: worktree.path,
          argv,
          ...(task === undefined ? {} : { task }),
          baseTabName,
          tabs,
          preferredTerminals,
        });
        ports.placePane(placement.command, placement.args);
      } catch (error) {
        if (!(error instanceof HerdrCoreError) || HERDR_APP_NOT_SENT.has(error.reason)) {
          release();
          throw error;
        }
        throw new BoardCollectError(`launch_unknown for the ${start.seat} of PR #${decision.pr}: ${error.message}. The marker ${markerUrl} stays; check hc ls for the tab before a retry`);
      }
      if (startup !== undefined) {
        const binding = await waitForAgyReviewBinding(startup);
        if (binding === 'failed') {
          release();
          refuse(decision.pr, 'the agy review launch could not bind its terminal');
          continue;
        }
        if (binding === 'unknown') {
          throw new BoardCollectError(`launch_unknown for the ${start.seat} of PR #${decision.pr}: no agy terminal binding result. The marker ${markerUrl} stays; check hc ls for the tab before a retry`);
        }
      }
      started.push({ pr: decision.pr, seat: start.seat, marker_url: markerUrl });
      context.observe?.({ kind: 'started', pr: decision.pr, seat: start.seat, marker_url: markerUrl });
    }
  }
  return { started, refused };
}

/** One start run per repository at a time: two runs that read the same markers would both start the head. Null when another run holds the lock. */
export async function withReviewLock<T>(repositoryId: string, run: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T | null> {
  let lock;
  const root = join(repoHarnessHome(env), 'board');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    lock = acquireExclusiveDirectoryLock(root, `review-start-${repositoryId}.lock`, { waitTimeoutMs: 1, reclaimStaleOwner: true });
  } catch (error) {
    if (error instanceof ExclusiveLockContentionError) return null;
    throw error;
  }
  try {
    lock.assertOwned();
    return await run();
  } finally {
    lock.release();
  }
}

/** Plan the review start of one parent's pull requests and, unless `dry_run`, execute it. The board is read inside the lock, so the eligibility that the plan acts on is current. */
export async function runReview(input: ReviewInput): Promise<ReviewResultV1> {
  const repositoryId = String(readRepositoryId(input));
  const result = await withReviewLock(repositoryId, async () => {
    const board = collectBoard({ repo_root: input.repo_root, parent: input.parent, host: input.host });
    if (input.pr !== undefined && !board.pull_requests.some(pr => pr.number === input.pr)) throw new BoardCollectError(`#${input.pr} is not a pull request of #${input.parent}`);
    const open = board.pull_requests.filter(pr => (input.pr === undefined || pr.number === input.pr) && pr.state === 'open' && !pr.is_draft && pr.required_check.status === 'success' && pr.acceptance.status === 'not_accepted');
    const comments = new Map(open.map(pr => [pr.number, readComments(input, pr.number)]));
    const { seats } = readSeatsConfiguration(process.env);
    // The same projection that `seatLaunch` uses for `seats argv gatekeeper`, so the family check names the seat that launches.
    const gatekeeper = effectiveGatekeeper(seats, seatAccountQuotas((await readQuotaReport(process.env, seats.routing.exhausted_at_or_above_used)).accounts, seats.routing));
    const decisions = planReview({ board, comments, gatekeeper, reviewer: seats.reviewer }).filter(decision => input.pr === undefined || decision.pr === input.pr);
    const terminalsRead = input.host.seatTerminals(repositoryId);
    const seatTerminals = terminalsRead.status === 'observed' ? terminalsRead.terminals : [];
    const closingIssues = new Map(board.pull_requests.map(pr => [pr.number, pr.closes]));
    return { decisions, ...await executeReview(decisions, { repositoryId, parent: input.parent, space: input.space, dry_run: input.dry_run, gatekeeper, observe: input.observe }, {
      worktree: (ref, sha) => worktreeAt(input, ref, sha),
      comment: (pr, body) => runGhText(input, ['pr', 'comment', String(pr), '--body-file', '-'], body),
      listSpaceTabs: space => herdrAppSpaceTabs(space),
      seatTerminals: () => seatTerminals,
      closingIssues,
      placePane: (command, args) => herdrAppDo(command, args),
      agy: { hc: Bun.which('hc'), env: process.env },
      launch: input.launch,
    }) };
  });
  if (result === null) throw new BoardCollectError('another board review run holds the lock of this repository; nothing was started');
  return result;
}
