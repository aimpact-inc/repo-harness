import { DispatchError, planDispatch, type DispatchDecisionV1, type DispatchPlanV1 } from '../../core/board/dispatch';
import type { BoardHostPortsV1 } from '../../core/board/board';
import { effectiveSeatConfig, seatAccountQuotas, shownModel } from '../../core/board/seat-routing';
import { seatModelBlock } from '../../core/board/seat-pool';
import { withSeatLine } from '../../core/board/seat-line';
import { renderBundleLine } from '../../core/board/source';
import { SEAT_IDS, isWorkerSeat, type SeatConfigV1, type SeatId } from '../../core/board/seats-settings';
import {
  HERDR_APP_NOT_SENT, HerdrCoreError, buildHerdrSeatPlacement, executeHerdrSeatPlacement, herdrAppSpaceTabs,
  planHerdrPlacement, recordPendingTabPlacement, withPendingTabPlacements,
  type HerdrAppTab, type HerdrSeatPlacement,
} from '../terminal/herdr-core';
import { runInternalHelper } from '../runtime/helper-runner';
import { readQuotaReport } from './quota';
import { collectSeatPoolProbes, magpieExtensionInstalled, readSeatsConfiguration } from './seats-configuration';
import { BoardCollectError, readParent, readRepositoryId, runGhText, type BoardCollectInput } from './collect';

type DispatchedV1 = Extract<DispatchDecisionV1, { action: 'dispatch' }>;
type SkippedV1 = Extract<DispatchDecisionV1, { action: 'skip' }>;

/** What `seatLaunch` (the `seats argv` command) answers for one seat; the command layer owns it, so the caller passes it in. */
export type DispatchLaunch = (seat: SeatId, labels: { readonly repositoryId: string; readonly issue: string; readonly parent: string }, cwd: string) =>
  Promise<{ readonly argv: readonly string[]; readonly tab: string | null; readonly runtime: SeatConfigV1['runtime'] }>;

export interface DispatchInput {
  readonly repo_root: string;
  readonly repository?: string;
  readonly parent: number;
  /** The Herdr space that receives the worker tabs. */
  readonly space: string;
  readonly host: BoardHostPortsV1;
  readonly launch: DispatchLaunch;
  /** Plan only: no worktree, no claim, no seat. */
  readonly dry_run: boolean;
  /** `--issues`: the issues that one seat and one pull request take; null dispatches the plan. */
  readonly bundle: readonly number[] | null;
  readonly earlyStart?: boolean;
  readonly gh_runner?: BoardCollectInput['gh_runner'];
  readonly env?: NodeJS.ProcessEnv;
}

/** The writes of one dispatch. Each is a process boundary, so tests replace them. */
export interface DispatchPorts {
  readonly startWorktree: (issue: number) => { readonly path: string; readonly branch: string };
  /** Posts an issue comment and returns its URL. */
  readonly comment: (issue: number, body: string) => string;
  /** Read the current tabs of `space` from `herdr-app ls`. */
  readonly listSpaceTabs: (space: string) => readonly HerdrAppTab[];
  /** Place one seat via `herdr-app do tab.new` or `hc run --keep --no-parent --cwd` tab adoption. */
  readonly placePane: (placement: HerdrSeatPlacement) => Record<string, unknown> | void;
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

/** The claim's `Model:` text (#3250): a shipped id, or else the seat field, which `writerFamily` reads as no known family. */
const claimModel = (seat: SeatId, model: string | null): string | null => (model === null ? null : shownModel(`seats.${seat}.model`, model));

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

/**
 * The seats to start: one for each ready plan unit. The plan skips a unit that is not ready in part; `--issues` names one unit and
 * throws instead, because the caller asked for that unit. A closed member is not work, so its skip does not stop the unit.
 */
function units(plan: DispatchPlanV1): DispatchedV1[][] {
  const dispatched = new Map(plan.decisions.flatMap(decision => (decision.action === 'dispatch' ? [[decision.issue, decision] as const] : [])));
  if (plan.bundle !== null && plan.units.length === 0) {
    const skipped = plan.decisions.filter((decision): decision is SkippedV1 => decision.action === 'skip' && decision.reason !== 'closed');
    const reasons = skipped.length === 0 ? 'every issue is closed' : skipped.map(decision => `#${decision.issue} ${decision.reason}: ${decision.detail}`).join('; ');
    throw new DispatchError(`the bundle ${plan.bundle.map(number => `#${number}`).join(', ')} starts only as a whole; ${reasons}; nothing was started`);
  }
  return plan.units.map(unit => unit.map(number => dispatched.get(number)!));
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
  const pendingByTab = new Map<string, Set<string>>();
  for (const unit of units(plan)) {
    const lead = unit[0]!;
    const worktree = ports.startWorktree(lead.issue);
    const labels = { repositoryId: context.repositoryId, issue: String(lead.issue), parent: String(context.parent) };
    const launch = await ports.launch(lead.seat, labels, worktree.path);
    // The launch reads the seats configuration again, so the runtime that will run is checked here, not the planned one.
    if (lead.credentials && launch.runtime === 'pi') throw new DispatchError(`${issueList(unit)} touches credentials and its launch resolved to a Pi seat; nothing was started`);
    // Read the target space layout before posting claims so a failing `herdr-app ls` leaves no orphaned claim.
    const tabs = withPendingTabPlacements(ports.listSpaceTabs(context.space), pendingByTab);
    const preview = planHerdrPlacement({ tabs, baseTabName: launch.tab });
    const resolvedTab = preview.action === 'tab.new' ? preview.name : (preview.tabName ?? launch.tab);
    const claims: { readonly issue: number; readonly url: string }[] = [];
    try {
      for (const decision of unit) claims.push({ issue: decision.issue, url: ports.comment(decision.issue, claimBody(decision, unit, worktree.branch, resolvedTab, launch.runtime, claimModel(lead.seat, context.model(lead.seat)), plan.coordinator!)) });
    } catch (error) {
      // No tab opened yet, so the claims of a bundle that posted only in part hold no seat.
      releaseClaims(ports, claims);
      throw error;
    }
    const task = packet(unit, worktree.path, claims.map(claim => claim.url));
    try {
      const placement = buildHerdrSeatPlacement({
        space: context.space,
        folder: worktree.path,
        baseTabName: launch.tab,
        tabs,
        ...(launch.runtime === 'agy' ? { argv: [...launch.argv, '-i', task] } : { argv: launch.argv, task }),
      });
      recordPendingTabPlacement(pendingByTab, placement, ports.placePane(placement));
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
  const env = input.env ?? process.env;
  const { parent } = readParent(input);
  const repositoryId = String(readRepositoryId(input));
  const terminals = input.host.seatTerminals(repositoryId);
  if (terminals.status === 'unavailable') throw new BoardCollectError(`hc could not list the seat terminals: ${terminals.reason}`);
  const { seats, overrides } = readSeatsConfiguration(env);
  const probes = collectSeatPoolProbes(env, SEAT_IDS.some(id => seats[id]?.runtime === 'agy'));
  const quota = seatAccountQuotas((await readQuotaReport(env, seats.routing.exhausted_at_or_above_used)).accounts, seats.routing);
  const plan = planDispatch({ parent, terminals: terminals.terminals, seats, quota, earlyStart: input.earlyStart,
    modelBlock: (id, seat) => (isWorkerSeat(id) && seat.runtime === 'agy' && !seat.tools.includes('edit')
      ? `agy: ${id} is configured read-only (missing edit). Enable edit for seats.${id}.tools in Settings.`
      : seatModelBlock(id, seat, seats, probes, () => magpieExtensionInstalled(env))),
    ...(input.bundle === null ? {} : { bundle: input.bundle }) });
  const started = await executeDispatch(plan, { repositoryId, parent: input.parent, space: input.space, dry_run: input.dry_run,
    // The same projection that `seatLaunch` uses for the argv, so the claim names the model that runs.
    model: seat => effectiveSeatConfig(seat, seats, quota, overrides)?.model ?? null,
  }, {
    startWorktree: issue => startWorktree(input, issue),
    comment: (issue, body) => runGhText(input, ['issue', 'comment', String(issue), '--body-file', '-'], withSeatLine(body, env)),
    listSpaceTabs: space => herdrAppSpaceTabs(space, { env }),
    placePane: placement => executeHerdrSeatPlacement(placement, { env }),
    launch: input.launch,
  });
  return { plan, started };
}
