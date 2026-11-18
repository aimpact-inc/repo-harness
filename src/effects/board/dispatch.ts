import { DispatchError, planDispatch, type DispatchDecisionV1, type DispatchPlanV1 } from '../../core/board/dispatch';
import type { BoardHostPortsV1 } from '../../core/board/board';
import { effectiveSeatConfig, seatAccountQuotas } from '../../core/board/seat-routing';
import { withSeatLine } from '../../core/board/seat-line';
import { renderBundleLine } from '../../core/board/source';
import type { SeatConfigV1, SeatId } from '../../core/board/seats-settings';
import { HERDR_APP_NOT_SENT, HerdrCoreError, herdrAppDo } from '../terminal/herdr-core';
import { runInternalHelper } from '../runtime/helper-runner';
import { readQuotaReport } from './quota';
import { readSeatsConfiguration } from './seats-configuration';
import { BoardCollectError, readParent, readRepositoryId, runGhText } from './collect';

type DispatchedV1 = Extract<DispatchDecisionV1, { action: 'dispatch' }>;

/** What `seatLaunch` (the `seats argv` command) answers for one seat; the command layer owns it, so the caller passes it in. */
export type DispatchLaunch = (seat: SeatId, labels: { readonly repositoryId: string; readonly issue: string; readonly parent: string }, cwd: string) =>
  Promise<{ readonly argv: readonly string[]; readonly tab: string | null; readonly runtime: SeatConfigV1['runtime'] }>;

export interface DispatchInput {
  readonly repo_root: string;
  readonly parent: number;
  /** The Herdr space that receives the worker tabs. */
  readonly space: string;
  readonly host: BoardHostPortsV1;
  readonly launch: DispatchLaunch;
  /** Plan only: no worktree, no claim, no seat. */
  readonly dry_run: boolean;
  /** `--issues`: the issues that one seat and one pull request take; null dispatches the plan. */
  readonly bundle: readonly number[] | null;
}

/** The writes of one dispatch. Each is a process boundary, so tests replace them. */
export interface DispatchPorts {
  readonly startWorktree: (issue: number) => { readonly path: string; readonly branch: string };
  /** Posts an issue comment and returns its URL. */
  readonly comment: (issue: number, body: string) => string;
  /** `herdr-app do tab.new` with these arguments. */
  readonly openTab: (args: Readonly<Record<string, unknown>>) => void;
  readonly launch: DispatchLaunch;
}

export interface DispatchResultV1 {
  readonly plan: DispatchPlanV1;
  readonly started: readonly { readonly issue: number; readonly seat: SeatId; readonly worktree: string; readonly claim_url: string }[];
}

function startWorktree(input: DispatchInput, issue: number): { readonly path: string; readonly branch: string } {
  const run = runInternalHelper({ helper: 'contract-worktree', args: ['start', '--issue', String(issue), '--json'], cwd: input.repo_root, stdio: 'pipe' });
  if (run.exitCode !== 0) throw new BoardCollectError(`rh worktrees start for #${issue} failed: ${(run.stderr ?? '').trim().slice(0, 300)}`);
  const start = JSON.parse(run.stdout ?? '') as { kind?: unknown; worktree_path?: unknown; branch?: unknown; disposition?: unknown };
  if (start.kind !== 'repo-harness-contract-worktree-start' || typeof start.worktree_path !== 'string' || typeof start.branch !== 'string') {
    throw new BoardCollectError(`rh worktrees start for #${issue} answered an unknown document`);
  }
  // Dispatch runs in the primary checkout. A linked worktree would answer with itself.
  if (start.disposition === 'already_linked') throw new BoardCollectError('dispatch must run in the primary checkout, not in a linked worktree');
  return { path: start.worktree_path, branch: start.branch };
}

const issueList = (unit: readonly DispatchedV1[]): string => unit.map(decision => `#${decision.issue}`).join(', ');

/** The claim of one issue of a unit. A bundle claim carries the `Issues:` line that the board reads (`issueClaim`). */
function claimBody(decision: DispatchedV1, unit: readonly DispatchedV1[], branch: string, tab: string | null, runtime: SeatConfigV1['runtime'], model: string | null, coordinator: string): string {
  const bundle = unit.length > 1;
  return [
    'repo-harness issue claim',
    'Status: active',
    'Role: writer',
    `Agent: ${decision.seat}, session ${tab ?? 'unnamed tab'}`,
    `Runtime: ${runtime}`,
    ...(model === null ? [] : [`Model: ${model}`]),
    `Branch: ${branch}`,
    ...(bundle ? [renderBundleLine(unit.map(entry => entry.issue))] : []),
    bundle ? `Scope: issues ${issueList(unit)} as their bodies state them` : `Scope: issue #${decision.issue} as its body states it`,
    'Not in scope: anything the issue body does not name',
    `Coordinator: ${coordinator}`,
    `Dispatch reading: ${decision.route_line}`,
  ].join('\n');
}

/**
 * The worker's authority, verbatim (#2923). A worker whose packet is silent applies its global push rule and waits for a push go.
 * `templates.md` § Dispatch packet quotes this text, and `tests/board-dispatch.test.ts` keeps the two equal.
 */
export const WORKER_AUTHORITY = 'implement, push the PR branch as soon as checks pass, open the PR, run your own fix rounds. No merge, no deletion outside the issue, no credentials.';

function packet(unit: readonly DispatchedV1[], worktree: string, claimUrls: readonly string[]): string {
  const authority = `Work as the writer of repo-harness-issue-flow and report to the orchestrator when done. Authority: ${WORKER_AUTHORITY}`;
  if (unit.length === 1) {
    const [decision] = unit;
    return `Task: issue #${decision!.issue} (${decision!.title}). Worktree: ${worktree}. Claim: ${claimUrls[0]}. Read the issue body and every comment first: gh issue view ${decision!.issue} --comments. ${authority}`;
  }
  // `Closes #a, #b` closes only #a (parseClosingReferences), so the packet asks for one closing line per issue.
  return `Task: one pull request for the bundle ${unit.map(decision => `#${decision.issue} (${decision.title})`).join(', ')}. Worktree: ${worktree}. Claims: ${claimUrls.join(' ')}. `
    + `Read each issue body and every comment first: ${unit.map(decision => `gh issue view ${decision.issue} --comments`).join('; ')}. `
    + `The pull request body has one line for each issue: ${unit.map(decision => `Closes #${decision.issue}`).join(' / ')}. ${authority}`;
}

function releaseClaims(ports: DispatchPorts, claims: readonly { readonly issue: number; readonly url: string }[]): void {
  for (const claim of claims) ports.comment(claim.issue, `repo-harness issue claim status\nClaim: ${claim.url}\nStatus: released`);
}

/** The seats to start: one for each dispatch decision, or one for the whole bundle, which starts only when every issue of it dispatches. */
function units(plan: DispatchPlanV1): DispatchedV1[][] {
  const dispatched = plan.decisions.filter((decision): decision is DispatchedV1 => decision.action === 'dispatch');
  if (plan.bundle === null) return dispatched.map(decision => [decision]);
  const skipped = plan.decisions.filter(decision => decision.action === 'skip');
  if (skipped.length > 0) {
    throw new DispatchError(`the bundle ${plan.bundle.map(number => `#${number}`).join(', ')} starts only as a whole; ${skipped.map(decision => `#${decision.issue} ${decision.reason}: ${decision.detail}`).join('; ')}; nothing was started`);
  }
  return [dispatched];
}

/**
 * Start each ready issue in plan order: worktree, claim comment, seat tab. The seat labels itself before its agent starts
 * (`seats argv`). A launch that failed before the request keeps no claim; one that may have created the tab keeps it and
 * stops, because a retry could start a second worker.
 */
export async function executeDispatch(plan: DispatchPlanV1, context: { readonly repositoryId: string; readonly parent: number; readonly space: string; readonly dry_run: boolean; readonly model: (seat: SeatId) => string | null }, ports: DispatchPorts): Promise<DispatchResultV1['started']> {
  const started: Array<DispatchResultV1['started'][number]> = [];
  if (plan.decisions.some(decision => decision.action === 'dispatch') && plan.coordinator === null) throw new DispatchError(`#${context.parent} has no active coordinator claim${plan.parent_comments_truncated ? ' in the comments that were read; older parent comments were not read' : ''}; nothing was started`);
  if (context.dry_run) return started;
  for (const unit of units(plan)) {
    const lead = unit[0]!;
    const worktree = ports.startWorktree(lead.issue);
    const labels = { repositoryId: context.repositoryId, issue: String(lead.issue), parent: String(context.parent) };
    const launch = await ports.launch(lead.seat, labels, worktree.path);
    // The launch reads the seats configuration again, so the runtime that will run is checked here, not the planned one.
    if (lead.credentials && launch.runtime === 'pi') throw new DispatchError(`${issueList(unit)} touches credentials and its launch resolved to a Pi seat; nothing was started`);
    const claims: { readonly issue: number; readonly url: string }[] = [];
    try {
      for (const decision of unit) claims.push({ issue: decision.issue, url: ports.comment(decision.issue, claimBody(decision, unit, worktree.branch, launch.tab, launch.runtime, context.model(lead.seat), plan.coordinator!)) });
    } catch (error) {
      // No tab opened yet, so the claims of a bundle that posted only in part hold no seat.
      releaseClaims(ports, claims);
      throw error;
    }
    try {
      ports.openTab({
        ...(launch.tab === null ? {} : { name: launch.tab }), space: context.space, folder: worktree.path, argv: launch.argv, task: packet(unit, worktree.path, claims.map(claim => claim.url)),
      });
    } catch (error) {
      if (error instanceof HerdrCoreError && HERDR_APP_NOT_SENT.has(error.reason)) {
        releaseClaims(ports, claims);
        throw error;
      }
      throw new DispatchError(`launch_unknown for ${issueList(unit)}: ${(error as Error).message}. The claims ${claims.map(claim => claim.url).join(' ')} stay; check hc ls for the tab before a retry`);
    }
    started.push(...unit.map((decision, index) => ({ issue: decision.issue, seat: decision.seat, worktree: worktree.path, claim_url: claims[index]!.url })));
  }
  return started;
}

/** Plan the dispatch of one parent and, unless `dry_run`, execute it. */
export async function runDispatch(input: DispatchInput): Promise<DispatchResultV1> {
  const { parent } = readParent(input);
  const repositoryId = String(readRepositoryId(input));
  const terminals = input.host.seatTerminals(repositoryId);
  if (terminals.status === 'unavailable') throw new BoardCollectError(`hc could not list the seat terminals: ${terminals.reason}`);
  const { seats } = readSeatsConfiguration(process.env);
  const quota = seatAccountQuotas((await readQuotaReport(process.env, seats.routing.exhausted_at_or_above_used)).accounts, seats.routing);
  const plan = planDispatch({ parent, terminals: terminals.terminals, seats, quota, ...(input.bundle === null ? {} : { bundle: input.bundle }) });
  const started = await executeDispatch(plan, { repositoryId, parent: input.parent, space: input.space, dry_run: input.dry_run,
    // The same projection that `seatLaunch` uses for the argv, so the claim names the model that runs.
    model: seat => effectiveSeatConfig(seat, seats, quota)?.model ?? null,
  }, {
    startWorktree: issue => startWorktree(input, issue),
    comment: (issue, body) => runGhText(input, ['issue', 'comment', String(issue), '--body-file', '-'], withSeatLine(body)),
    openTab: args => { herdrAppDo('tab.new', args); },
    launch: input.launch,
  });
  return { plan, started };
}
