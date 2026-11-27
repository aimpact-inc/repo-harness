import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve } from 'path';
import { SeatPaneNameError } from '../../core/board/seat-pane-name';
import { SEAT_OVERRIDES_PROTOCOL, seatOverrideIds, type SeatLaunchOverrideV1 } from '../../core/board/seat-overrides';
import { LAUNCH_SEAT_IDS, type LaunchSeatId } from '../../core/board/seats-settings';
import { shownModel, type SeatRouteV1 } from '../../core/board/seat-routing';
import { readAgyQuota } from '../../effects/board/quota';
import { readAntigravityTranscript } from '../../effects/board/antigravity-transcript';
import { setRepoHarnessPanePrefix } from '../../effects/repo-registry';
import { HerdrCoreError, seatLoginShell } from '../../effects/terminal/herdr-core';
import { SeatResetError, readSeatSession, readTranscriptUsage, runSeatReset, seatResetRequestState, writeSeatHandoff, writeSeatResetRequest, type SeatRelaunch, type SeatResetNotify, type SeatResetTarget, type TranscriptUsage } from '../../effects/board/seat-reset';
import { handoffIdentity, seatResetAction, seatResetIdentity, seatResetSteps, type SeatResetIdentity } from '../../core/board/seat-reset';
import { recordLifecycleEvents } from '../../effects/board/lifecycle-index';
import { COUNCIL_MEMBERS, parseCouncilMembers } from '../../core/board/planner-consult';
import { runCouncilConsult } from '../../effects/board/planner-consult';
import { formatSeatPool } from '../../core/board/seat-pool';
import { readSeatsConfiguration, refreshSeatPool, SeatsConfigurationError } from '../../effects/board/seats-configuration';
import { SeatsCommandError, consultIssueNumber, labelInput, labelOwnTerminal, selfLabelingArgv, withSeatLabelOptions, type SeatLabelInput } from './seats-labels';
import { configuredSeats, probeClaudeResetStartup, quotaCheckedSeat, resolveCouncilMemberSeat } from './seats-runtime';
import { callerSpace, effectiveSeatLaunch, openSeatTab, seatTabLaunch, writeLaunchError, type SeatLaunchResult } from './seats-launch';

export type { SeatLabelInput } from './seats-labels';

export class SeatProviderUnavailableError extends SeatsCommandError {
  override readonly code = 'seat_provider_unavailable';

  constructor(message: string) {
    super('seat_provider_unavailable', message);
  }
}

const providerUnavailable = (message: string): Error => new SeatProviderUnavailableError(message);

/** Wrap the agent with the production seat label command and, for a new pane, the login shell. */
export function labeledSeatArgv(seat: LaunchSeatId, input: SeatLabelInput, agent: readonly string[], env: NodeJS.ProcessEnv, terminal: 'new' | 'existing'): string[] {
  const argv = selfLabelingArgv(seat, input, agent, env);
  return terminal === 'new' ? seatLoginShell(argv) : argv;
}

export async function seatLaunch(seat: string, labels: SeatLabelInput = {}, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), planned?: SeatRouteV1): Promise<SeatLaunchResult> {
  return (await effectiveSeatLaunch(seat, labels, env, cwd, { planned, checkAvailability: true, providerUnavailable })).launch;
}

export function seatResetTarget(identity: SeatResetIdentity, env: NodeJS.ProcessEnv): SeatResetTarget {
  const { seats, overrides } = configuredSeats(env);
  const configured = seats[identity.seat];
  return {
    runtime: configured.runtime,
    model: async () => {
      const { seat, modeKnown } = await quotaCheckedSeat(identity.seat, seats, configured, env, undefined, () => readAgyQuota(env), overrides);
      return { model: seat.model, effort: seat.effort, modeKnown };
    },
  };
}

/** Prepare the relaunch only when reset will start a new process. */
export async function seatResetLaunch(identity: SeatResetIdentity, env: NodeJS.ProcessEnv, checkout: string, crossRuntime: boolean): Promise<SeatRelaunch> {
  // The terminal already has a waiting shell. Run only the agent command to keep one shell across resets.
  const labels = { repositoryId: identity.repository };
  const { launch, agentArgv, effective, modeKnown } = await effectiveSeatLaunch(identity.seat, labels, env, checkout,
    { terminal: 'existing', checkAvailability: true, providerUnavailable });
  let argv = launch.argv;
  if (crossRuntime) {
    if (launch.runtime !== 'claude') throw new Error('The prepared runtime provides no pre-exit SessionStart readiness evidence');
    const bound = await probeClaudeResetStartup(agentArgv, env, checkout);
    argv = labeledSeatArgv(identity.seat, labels, bound, env, 'existing');
  }
  return { argv, runtime: launch.runtime, model: effective.model, effort: effective.effort, modeKnown };
}

/**
 * `seats handoff`: an on-demand reset. It records a reset request for the current session, as the Stop hook does at
 * the threshold, so the peer's `seats reset` accepts the handoff, and returns the steps that the hook prints.
 */
export function seatHandoff(env: NodeJS.ProcessEnv = process.env, now = new Date(), markdown?: Buffer): string {
  const identity = seatResetIdentity(env);
  if (identity === null) {
    throw new SeatsCommandError('seat_identity_missing', 'REPO_HARNESS_SEAT and REPO_HARNESS_SEAT_REPOSITORY name no orchestrator or advisor seat: start the seat with rh seats argv <seat> --repository-id <id>.');
  }
  const session = readSeatSession(identity);
  if (session === null) throw new SeatsCommandError('seat_session_unknown', `The SessionStart record of the ${identity.seat} seat is missing or not valid, so the session transcript is unknown.`);
  const { host, sessionId, transcriptPath: transcript } = session;
  if (markdown !== undefined) {
    if (seatResetRequestState(identity, transcript, session).state !== 'open') {
      throw new SeatsCommandError('seat_handoff_request_unavailable', 'This session has no open reset request. Run rh seats handoff to record a request.');
    }
    try { return writeSeatHandoff(identity, markdown); } catch (error) {
      throw new SeatsCommandError('seat_handoff_write_failed', (error as Error).message);
    }
  }
  let usage: TranscriptUsage | null = null;
  try {
    if (host !== 'antigravity') usage = readTranscriptUsage(transcript);
    else if (sessionId !== null) usage = readAntigravityTranscript(sessionId, transcript, env);
  } catch (error) {
    throw new SeatsCommandError('seat_context_unknown', `The transcript ${transcript} cannot be read: ${(error as Error).message}`);
  }
  if (usage === null || usage.contextTokens === null) throw new SeatsCommandError('seat_context_unknown', `The transcript ${transcript} has no assistant entry with a context size.`);
  const { contextTokens, bytes } = usage;
  const action = seatResetAction(bytes, host);
  writeSeatResetRequest(identity, now, { contextTokens, transcriptPath: transcript, transcriptBytes: bytes, action, host });
  return seatResetSteps(identity, action, host);
}

function formatOwnerOverrideLine(override: SeatLaunchOverrideV1): string {
  const effort = override.effort === null ? '' : ` ${override.effort}`;
  return `owner override: ${override.runtime} ${override.model}${effort} (authorized ${override.authorized_at})`;
}

function renderSeatOverridesText(env: NodeJS.ProcessEnv): string {
  const { base_seats, overrides } = readSeatsConfiguration(env);
  const ids = seatOverrideIds(overrides);
  if (ids.length === 0) return 'No active owner seat overrides.';
  return ids.map(id => {
    const override = overrides[id]!;
    const base = base_seats[id];
    const effort = override.effort === null ? '' : ` ${override.effort}`;
    const model = shownModel(`seats.${id}.model`, override.model);
    const baseText = base === null ? 'unconfigured' : `${base.runtime} ${shownModel(`seats.${id}.model`, base.model)}`;
    return `${id}: ${override.runtime} ${model}${effort} (owner override; authorized ${override.authorized_at}; catalog ${baseText})`;
  }).join('\n');
}

/** `loadNotify` comes from the composition root, only when peer-runtime is selected. */
export function buildSeatsCommand(loadNotify?: () => Promise<SeatResetNotify>): Command {
  const seats = new Command('seats').description('Seat model pools and launch commands for Herdr panes');
  seats.command('pool')
    .description('Check which recommended seat models are available in this environment')
    .option('--json', 'Print the seat pools and exclusions as JSON')
    .action(({ json }: { json?: boolean }) => {
      try {
        const { report, stored } = refreshSeatPool();
        process.stdout.write(`${json === true ? JSON.stringify(report, null, 2) : formatSeatPool(report)}\n`);
        if (!stored) process.stderr.write('seat_pool_cache_write_failed: Could not save ~/.repo-harness/seats/pool.json for Settings.\n');
      } catch (error) {
        const failure = error instanceof SeatsConfigurationError
          ? { code: error.code, message: error.message }
          : { code: 'seat_pool_failed', message: 'Could not check seat model availability.' };
        process.stderr.write(`${JSON.stringify({ ok: false, error: failure.code, message: failure.message })}\n`);
        process.exitCode = 1;
      }
    });
  withSeatLabelOptions(seats
    .command('argv')
    .description('Print the argv that starts a seat from ~/.repo-harness/config.json; materializes Pi fleet role files and agy seat agent directories under ~/.gemini/config/agents when needed'))
    .option('--json', 'Print the argv, the seat brief, the source, the limits, the labels, the pane name and the tab name as JSON')
    .action(async (seat: string, options: SeatLabelInput & { json?: boolean }) => {
      let launch: Awaited<ReturnType<typeof seatLaunch>>;
      try {
        launch = (await effectiveSeatLaunch(seat, labelInput(options), process.env, process.cwd(), { providerUnavailable })).launch;
      } catch (error) {
        writeLaunchError(error);
        return;
      }
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(launch, null, 2)}\n`);
        return;
      }
      // stdout is the argv alone, so `--argv "$(rh seats argv <seat>)"` takes it as is.
      process.stdout.write(`${JSON.stringify(launch.argv)}\n`);
      process.stderr.write(`source: ${launch.source}\n`);
      for (const limit of launch.limits) {
        const note = limit.level === 'instructions_only' ? ' (written into the launch instructions only)' : '';
        process.stderr.write(`limit ${limit.subject}: ${limit.level}${note}\n`);
      }
      if (launch.labels.length > 0) process.stderr.write(`labels: ${launch.labels.join(' ')}\n`);
      if (launch.name !== null) process.stderr.write(`name: ${launch.name}\ntab: ${launch.tab}\n`);
      if (launch.ownerException !== null) process.stderr.write(`owner exception: ${launch.ownerException}\n`);
      if (launch.ownerOverride !== undefined) process.stderr.write(`${formatOwnerOverrideLine(launch.ownerOverride)}\n`);
    });
  seats.command('overrides')
    .description('Show active owner-authorized seat route overrides (read-only)')
    .option('--json', 'Print the active overrides as JSON')
    .action(({ json }: { json?: boolean }) => {
      try {
        if (json === true) {
          const { revision, overrides } = readSeatsConfiguration(process.env);
          process.stdout.write(`${JSON.stringify({ protocol: SEAT_OVERRIDES_PROTOCOL, kind: 'seat_overrides', config_revision: revision, overrides }, null, 2)}\n`);
          return;
        }
        process.stdout.write(`${renderSeatOverridesText(process.env)}\n`);
      } catch (error) {
        writeLaunchError(error);
      }
    });
  withSeatLabelOptions(seats
    .command('launch')
    .description('Open a seat in a Herdr.app tab with the argv of seats argv; fails closed when Herdr.app opens no tab'))
    .requiredOption('--cwd <path>', 'Working directory of the seat, usually its worktree')
    .requiredOption('--task <text>', 'First message of the seat')
    .option('--space <id>', 'Herdr space that receives the tab; default: the herdr.space label of the calling terminal')
    .option('--focus', 'Show the new tab at once')
    .option('--json', 'Print the launch, the space and the Herdr.app placement as JSON')
    .action(async (seat: string, options: SeatLabelInput & { cwd: string; task: string; space?: string; focus?: boolean; json?: boolean }) => {
      let result: Awaited<ReturnType<typeof seatTabLaunch>>;
      try {
        result = await seatTabLaunch(seat, labelInput(options), { cwd: resolve(options.cwd), task: options.task, space: options.space, focus: options.focus === true }, providerUnavailable, process.env);
      } catch (error) {
        writeLaunchError(error);
        return;
      }
      // Without --repository-id the launch names no repository, so it has no index.
      if (options.repositoryId !== undefined) {
        recordLifecycleEvents(() => Number(options.repositoryId), [{ kind: 'seat.lifecycle', phase: 'launch', seat, terminal: result.launch.name,
          issues: options.issue === undefined ? [] : [Number(options.issue)], pr: options.pr === undefined ? null : Number(options.pr),
          model: result.model, duration_ms: null, transcript_path: null }], process.env);
      }
      const { model: _model, modelField, ...shown } = result;
      const model = modelField === null ? {} : { model: modelField };
      const ownerOverride = result.launch.ownerOverride === undefined ? {} : { ownerOverride: result.launch.ownerOverride };
      process.stdout.write(options.json === true ? `${JSON.stringify({ ok: true, ...shown, ...model }, null, 2)}\n`
        : `${JSON.stringify({ ok: true, seat, name: result.launch.name, tab: result.launch.tab, space: result.space, placement: result.placement, ...model, ...ownerOverride })}\n`);
    });
  seats.command('council')
    .description(`Open 1 to 3 read-only council panes (${COUNCIL_MEMBERS.join(', ')}) for one issue and write proposals outside Git worktrees`)
    .requiredOption('--issue <number>', 'Issue number to consult on')
    .requiredOption('--members <csv>', `Comma-separated council members from: ${COUNCIL_MEMBERS.join(', ')}`)
    .option('--space <id>', 'Herdr space that receives the tab; defaults to the herdr.space label of the calling terminal')
    .option('--parent <number>', 'Parent issue number')
    .option('--qualifier <word>', 'Optional pane and file suffix for a separate consultation')
    .option('--out-dir <path>', 'Proposal directory, defaults to rh-council/<repo>/ under the system temp directory')
    .option('--out <path>', 'Single-member proposal file path')
    .option('--question <text>', 'Question for the council to focus on')
    .option('--repository-id <id>', 'GitHub numeric repository ID, defaults to the current checkout’s repository')
    .option('--dry-run', 'Print the resolved JSON without creating directories or opening tabs')
    .option('--json', 'Print the consultation as JSON')
    .action(async (options: { issue: string; members: string; space?: string; parent?: string; qualifier?: string; outDir?: string; out?: string; question?: string; repositoryId?: string; dryRun?: boolean; json?: boolean }) => {
      const env = process.env;
      try {
        const members = parseCouncilMembers(options.members);
        const dryRun = options.dryRun === true;
        const resolvedSpace = dryRun ? options.space : (options.space ?? callerSpace(env) ?? undefined);
        if (!dryRun && (!resolvedSpace || resolvedSpace.trim() === '')) {
          throw new SeatsCommandError('seat_space_missing', 'No Herdr.app space: pass --space <id>, or run the launch in a terminal that a Herdr.app pane shows.');
        }
        const { seats: decodedSeats, overrides } = configuredSeats(env);
        const hasCouncilOverride = overrides.council !== undefined;
        const pendingCouncilByTab = new Map<string, Set<string>>();
        const result = await runCouncilConsult({
          cwd: process.cwd(),
          issue: consultIssueNumber(options.issue, '--issue'),
          members,
          parent: options.parent === undefined ? undefined : consultIssueNumber(options.parent, '--parent'),
          qualifier: options.qualifier,
          repositoryId: options.repositoryId,
          space: resolvedSpace,
          outDir: options.outDir,
          out: options.out,
          question: options.question,
          dry_run: dryRun,
        }, {
          launch: async (member, labels, cwd, isDryRun) => {
            const { launch, effective } = await effectiveSeatLaunch('council', labels, env, cwd, {
              ...(hasCouncilOverride ? {} : { configuredOverride: resolveCouncilMemberSeat(member, decodedSeats, env) }),
              prepareFleet: !isDryRun,
              providerUnavailable,
            });
            const model = hasCouncilOverride ? shownModel('seats.council.model', effective.model) : effective.model;
            return { launch, model, shell: effective.tools.includes('shell') };
          },
          openTab: ({ task, ...rest }, opts) => {
            openSeatTab(task === undefined ? rest : { ...rest, task }, env, null, opts?.privateTask === true, pendingCouncilByTab);
          },
        });
        const activeOverride = result.members.find(row => row.ownerOverride !== undefined)?.ownerOverride;
        if (options.json === true || result.dry_run) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          if (options.json !== true && activeOverride !== undefined) {
            process.stderr.write(`${formatOwnerOverrideLine(activeOverride)}\n`);
          }
        } else {
          const lines = result.members.map(row => `${result.seat}(${row.member}) ${row.runtime}/${row.model ?? 'default'} ${row.pane_name} → ${row.out_path}`);
          if (activeOverride !== undefined) lines.push(formatOwnerOverrideLine(activeOverride));
          process.stdout.write(`${lines.join('\n')}\n`);
        }
      } catch (error) {
        writeLaunchError(error);
      }
    });
  seats
    .command('label')
    .description('Set the seat labels on the calling hc terminal; the seat argv runs it before the agent starts')
    .argument('<seat>', LAUNCH_SEAT_IDS.join('|'))
    .option('--repository-id <id>', 'GitHub numeric repository id')
    .option('--issue <n>', 'Issue number')
    .option('--pr <n>', 'PR number')
    .option('--parent <n>', 'Parent issue number')
    .option('--owner-exception <url>', 'Owner decision URL that lifted the quota reservation for this launch')
    .action((seat: string, options: SeatLabelInput) => {
      try {
        labelOwnTerminal(seat, { repositoryId: options.repositoryId, issue: options.issue, pr: options.pr, parent: options.parent, ownerException: options.ownerException });
      } catch (error) {
        if (!(error instanceof SeatsCommandError || error instanceof SeatPaneNameError || error instanceof HerdrCoreError)) throw error;
        const code = error instanceof HerdrCoreError ? 'label_failed' : error.code;
        process.stderr.write(`${JSON.stringify({ ok: false, error: code, message: `The seat did not start: ${error.message}` })}\n`);
        process.exitCode = 1;
      }
    });
  seats
    .command('prefix')
    .description('Set the pane prefix that labeled seat panes use for a repository')
    .requiredOption('--repo <path>', 'Adopted repository')
    .requiredOption('--pane-prefix <prefix>', 'Lowercase letter, then 1 to 5 lowercase letters or digits')
    .action((options: { repo: string; panePrefix: string }) => {
      try {
        const result = setRepoHarnessPanePrefix(options.repo, options.panePrefix);
        if (!result.registered) throw new Error(result.reason ?? 'repo is not adopted');
        process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ ok: false, error: 'pane_prefix_failed', message: (error as Error).message })}\n`);
        process.exitCode = 1;
      }
    });
  seats
    .command('handoff')
    .description('Record a reset request and print its steps, or write the handoff for an open request')
    .option('--write', 'Read Markdown from stdin, write this seat’s handoff and print its RESET-REQUEST line')
    .action((options: { write?: boolean }) => {
      try {
        const markdown = options.write ? readFileSync(0) : undefined;
        process.stdout.write(`${seatHandoff(process.env, new Date(), markdown)}\n`);
      } catch (error) {
        if (!(error instanceof SeatsCommandError)) throw error;
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.code, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  seats
    .command('reset')
    .description('Check and carry out a RESET-REQUEST from the peer seat, then send the resume prompt. Run in the background.')
    .argument('<handoff>', 'The handoff path of the RESET-REQUEST')
    .argument('<sha256>', 'The handoff sha256 of the RESET-REQUEST')
    .action(async (handoff: string, sha256: string) => {
      try {
        // The session that the reset ends; its record is replaced when the new session starts.
        const identity = handoffIdentity(handoff);
        const ending = identity === null ? null : readSeatSession(identity);
        const result = await runSeatReset(handoff, sha256, {
          ...(loadNotify === undefined ? {} : { notify: await loadNotify() }),
          resolveLaunch: identity => seatResetTarget(identity, process.env),
          relaunch: (identity, checkout, crossRuntime) => seatResetLaunch(identity, process.env, checkout, crossRuntime),
        });
        process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
        if (identity !== null) {
          recordLifecycleEvents(() => Number(identity.repository), [{ kind: 'seat.lifecycle', phase: 'reset', seat: identity.seat, terminal: result.requester || null,
            issues: [], pr: null, model: ending?.model ?? null, duration_ms: ending === null ? null : Date.now() - Date.parse(ending.startedAt),
            transcript_path: ending?.transcriptPath ?? null }], process.env);
        }
      } catch (error) {
        if (!(error instanceof SeatResetError)) throw error;
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.code, outcome: error.outcome, message: error.message, logErrors: error.logErrors })}\n`);
        process.exitCode = 1;
      }
    });
  return seats;
}
