import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { CLAUDE_BUILTIN_AGENT_TYPES, SeatPaneNameError, buildSeatLaunch, seatPaneName, seatTabName, type SeatLaunchV1 } from '../../core/board/seat-launch';
import { LAUNCH_SEAT_IDS, RETIRED_SEAT_FLEET_ROLES, SeatsConfigMigrationRequiredError, decodeSeatsConfig, seatsConfigInvalidMessage, isReviewSeat, isWorkerSeat, unavailablePiSeat, type LaunchSeatId, type SeatConfigV1, type SeatsConfigV1 } from '../../core/board/seats-settings';
import { claudeReserved, deepGatekeeperRepeatsGatekeeper, effectiveGatekeeper, effectiveSeatConfig, seatAccount, seatAccountQuotas, seatState, type SeatRouteV1 } from '../../core/board/seat-routing';
import { AGY_QUOTA_ACCOUNTS, classifyQuotaReading, type QuotaAccount, type QuotaReading } from '../../core/board/quota';
import { readAgyQuota, readClaudeQuota, readCodexQuota } from '../../effects/board/quota';
import { version as PACKAGE_VERSION } from '../../../package.json';
import { readGlobalConfiguration } from '../../effects/configuration/global-configuration';
import { resolveGitCommonDirectory } from '../../effects/git/common-directory';
import { gitExecFileSync } from '../../effects/git/runner';
import { githubRemoteRepository } from '../../core/board/source';
import { ClaudeAgentTypesError, claudeHostAgentTypes } from '../../effects/board/claude-agent-types';
import { RepoHarnessRegistryStrictError, canonicalRepoPath, readRepoHarnessRegistryStrictSnapshot, repoCheckoutProbeEnv, setRepoHarnessPanePrefix } from '../../effects/repo-registry';
import { HERDR_APP_NOT_SENT, HerdrCoreError, RH_LABEL, hcCallerSpace, hcLabel, hcLabelPairs, herdrAppDo, type HcLabels } from '../../effects/terminal/herdr-core';
import { bunGlobalPackageRoot } from '../installer/skill-projection';
import { PiFleetRolesError, writePiFleetRoles } from '../../effects/board/pi-fleet-roles';
import { PiShellError, assertPiShell } from '../../effects/board/pi-shell';
import { MANAGED_AGENTS } from '../../effects/terminal/task-role-profiles';
import { SeatResetError, readSeatSession, readTranscriptUsage, runSeatReset, writeSeatResetRequest, type SeatRelaunch, type SeatResetNotify, type TranscriptUsage } from '../../effects/board/seat-reset';
import { handoffIdentity, seatResetAction, seatResetIdentity, seatResetSteps, type SeatResetIdentity } from '../../core/board/seat-reset';
import { recordLifecycleEvents } from '../../effects/board/lifecycle-index';
import { formatSeatPool } from '../../core/board/seat-pool';
import { refreshSeatPool, SeatsConfigurationError } from '../../effects/board/seats-configuration';

const CLI_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));

class SeatsCommandError extends Error {
  constructor(readonly code: 'seat_unknown' | 'seat_not_configured' | 'seat_quota_exhausted' | 'seat_quota_reserved' | 'seat_provider_unavailable' | 'seat_model_repeats_gatekeeper' | 'owner_exception_invalid' | 'config_invalid' | 'label_value_invalid' | 'repository_id_required' | 'terminal_unknown' | 'seat_identity_missing' | 'seat_session_unknown' | 'seat_context_unknown' | 'pi_extension_missing' | 'seat_space_missing' | 'seat_tab_failed' | 'seat_tab_unknown', message: string) {
    super(message);
  }
}

/** The dispatch values of the seat labels. Each is a positive decimal integer. */
export interface SeatLabelInput {
  readonly repositoryId?: string;
  readonly issue?: string;
  readonly pr?: string;
  readonly parent?: string;
  /** Pane name inputs only (#1544): the release item digits and the slice word. */
  readonly release?: string;
  readonly qualifier?: string;
  /** An owner decision URL on this repository (#2769): it lifts the Claude quota reservation for this one launch. */
  readonly ownerException?: string;
}

const POSITIVE = /^[1-9][0-9]*$/u;

/** The seat labels that the board reads (#1505), or none without `--repository-id`. The GitHub numeric repository id identifies the repository. */
const OWNER_DECISION_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/[1-9][0-9]*(?:#(?:issuecomment-|pullrequestreview-|discussion_r)[1-9][0-9]*)?$/u;

/** The `owner/name` of an owner decision URL, or the refusal. The URL shape keeps the label value free of shell and label syntax. */
function ownerDecisionRepository(url: string): string {
  const match = OWNER_DECISION_URL.exec(url);
  if (match === null) {
    throw new SeatsCommandError('owner_exception_invalid', '--owner-exception must be a https://github.com/<owner>/<repo>/issues/<n> or /pull/<n> URL, optionally with a comment or review anchor.');
  }
  return match[1]!.toLowerCase();
}

/** The owner exception must name an issue or PR of the origin repository of `cwd`. */
function checkOwnerException(url: string, cwd: string, env: NodeJS.ProcessEnv): void {
  const repository = ownerDecisionRepository(url);
  let origin: string | null;
  try {
    origin = githubRemoteRepository(gitExecFileSync(['remote', 'get-url', 'origin'], { cwd, env: repoCheckoutProbeEnv(env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    origin = null;
  }
  if (origin !== repository) {
    throw new SeatsCommandError('owner_exception_invalid', `--owner-exception names ${repository}, but the origin of ${cwd} is ${origin ?? 'no GitHub repository'}.`);
  }
}

function seatLabels(seat: LaunchSeatId, input: SeatLabelInput): HcLabels | undefined {
  const { repositoryId, release, qualifier, ownerException, ...dispatch } = input;
  if (ownerException !== undefined) {
    ownerDecisionRepository(ownerException);
    if (repositoryId === undefined) throw new SeatsCommandError('repository_id_required', '--owner-exception needs --repository-id, so the seat label records it.');
  }
  for (const [name, value] of Object.entries({ repositoryId, ...dispatch })) {
    if (value !== undefined && !POSITIVE.test(value)) throw new SeatsCommandError('label_value_invalid', `--${name === 'repositoryId' ? 'repository-id' : name} must be a positive decimal integer.`);
  }
  if (isReviewSeat(seat) && (input.pr === undefined || input.issue !== undefined || release !== undefined)) {
    throw new SeatPaneNameError(`The ${seat} seat needs --pr and takes no --issue or --release.`);
  }
  if (repositoryId === undefined) {
    if (isReviewSeat(seat) && input.parent === undefined && qualifier === undefined) return undefined;
    if ([...Object.values(dispatch), release, qualifier].some(value => value !== undefined)) {
      throw new SeatsCommandError('repository_id_required', '--issue, --pr, --parent, --release and --qualifier need --repository-id.');
    }
    return undefined;
  }
  return {
    [RH_LABEL.seat]: seat,
    [RH_LABEL.repository]: repositoryId,
    ...(dispatch.issue === undefined ? {} : { [RH_LABEL.issue]: dispatch.issue }),
    ...(dispatch.pr === undefined ? {} : { [RH_LABEL.pr]: dispatch.pr }),
    ...(dispatch.parent === undefined ? {} : { [RH_LABEL.parent]: dispatch.parent }),
    ...(ownerException === undefined ? {} : { [RH_LABEL.ownerException]: ownerException }),
  };
}

/** The gatekeeper-fallback seat is no launch target: `seats argv gatekeeper` launches it when it is the effective gatekeeper. */
function seatId(seat: string): LaunchSeatId {
  if (!LAUNCH_SEAT_IDS.includes(seat as LaunchSeatId)) throw new SeatsCommandError('seat_unknown', `Unknown seat ${seat}. Use one of: ${LAUNCH_SEAT_IDS.join(', ')}.`);
  return seat as LaunchSeatId;
}

/**
 * Label the terminal before starting the agent. Keep the login shell's PATH order and add the launcher's Bun
 * directory and the caller's rh and hc directories for panes that start with a smaller PATH.
 */
function selfLabelingArgv(seat: LaunchSeatId, input: SeatLabelInput, agent: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const flags = ([['--repository-id', input.repositoryId], ['--issue', input.issue], ['--pr', input.pr], ['--parent', input.parent]] as const)
    .flatMap(([flag, value]) => value === undefined ? [] : [flag, value]);
  const toolDirs = ['rh', 'hc'].flatMap(tool => {
    const path = Bun.which(tool, { PATH: env.PATH ?? '' });
    return path === null ? [] : [dirname(path)];
  });
  const pathSetup = 'export PATH="${PATH:+$PATH:}${2:+$2:}${0%/*}"';
  const label = `"$0" "$1" seats label ${[seat, ...flags].join(' ')}`;
  const args = [process.execPath, CLI_ENTRY, [...new Set(toolDirs)].join(delimiter)];
  // The owner exception URL is positional, so only checked seat and dispatch values enter the script.
  return input.ownerException === undefined
    ? ['/bin/sh', '-c', `${pathSetup}; ${label} && shift 2 && exec "$@"`, ...args, ...agent]
    : ['/bin/sh', '-c', `${pathSetup}; ${label} --owner-exception "$3" && shift 3 && exec "$@"`, ...args, input.ownerException, ...agent];
}

/** Keep a foreground shell available after the agent exits, including in a direct Herdr pane split. */
function seatLoginShell(argv: readonly string[]): string[] {
  const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
  return [shell, '-lic', '"$@"; result=$?; [ ! -t 0 ] || exec "$0" -li; exit "$result"', shell, ...argv];
}

/** `seats label`: set the seat labels on the calling hc terminal. The seat argv runs it before the agent starts. */
function labelOwnTerminal(seat: string, input: SeatLabelInput, env: NodeJS.ProcessEnv = process.env): void {
  const labels = seatLabels(seatId(seat), input);
  if (labels === undefined) throw new SeatsCommandError('repository_id_required', 'seats label needs --repository-id.');
  const terminal = env.HC_TERMINAL_ID;
  if (!terminal) throw new SeatsCommandError('terminal_unknown', 'HC_TERMINAL_ID is not set: start the seat argv with herdr-app do tab.new or pane.split.');
  hcLabel(terminal, labels, { env });
}

/** The registry entry of the primary checkout of `cwd` holds the pane prefix; a linked worktree resolves to its primary root. */
function panePrefix(cwd: string, env: NodeJS.ProcessEnv): string {
  let root: string;
  try {
    root = canonicalRepoPath(dirname(resolveGitCommonDirectory(cwd, undefined, undefined, repoCheckoutProbeEnv(env))));
  } catch {
    throw new SeatPaneNameError(`Pane name: ${cwd} is not in a git repository, so its registry entry is unknown.`);
  }
  const registry = readRepoHarnessRegistryStrictSnapshot({ env });
  const prefix = registry.repos.find(repo => repo.path === root)?.panePrefix;
  if (prefix === undefined) throw new SeatPaneNameError(`Pane name: run rh seats prefix --repo ${root} --pane-prefix <prefix>.`);
  return prefix;
}

function plannedGatekeeper(route: SeatRouteV1): SeatConfigV1 {
  if (route.id === null) throw new SeatsCommandError('seat_quota_exhausted', `No gatekeeper seat can launch. Route ${route.line}`);
  return route.seat;
}

/**
 * The seat config that launches for `id` under the current quota, or the quota refusal. `modeKnown` is false when the
 * account of the launched seat has no fresh weekly reading (missing, unreadable or stale capture), so its mode is unknown.
 */
async function quotaCheckedSeat(id: LaunchSeatId, seats: SeatsConfigV1, configured: SeatConfigV1, env: NodeJS.ProcessEnv, ownerException: string | undefined): Promise<{
  readonly seat: SeatConfigV1; readonly modeKnown: boolean;
  /** The Claude mode that `effectiveSeatConfig` read for this launch (#3091). */
  readonly claudeSaving: boolean;
}> {
  const readings: QuotaReading[] = [];
  const done = new Set<QuotaAccount>();
  const read = async (account: QuotaAccount | null) => {
    if (account !== null && !done.has(account)) {
      done.add(account);
      if (account === 'claude') readings.push(readClaudeQuota(env));
      else if (account === 'chatgpt') readings.push(await readCodexQuota(env, PACKAGE_VERSION));
      else {
        for (const agyAccount of AGY_QUOTA_ACCOUNTS) done.add(agyAccount);
        readings.push(...await readAgyQuota(env));
      }
    }
    return seatAccountQuotas(readings.map(reading => classifyQuotaReading(reading, Date.now(), seats.routing.exhausted_at_or_above_used)), seats.routing);
  };
  const own = seatAccount(configured);
  let quota = await read(own);
  // The fallback account is read only when the gatekeeper account is exhausted, the one state in which the fallback can launch.
  const fallback = seats['gatekeeper-fallback'];
  if (id === 'gatekeeper' && fallback !== null && own !== null && quota[own].state === 'exhausted' && seatAccount(fallback) !== own) {
    quota = await read(seatAccount(fallback));
  }
  // The duplicate-model check compares with the route that the gatekeeper launch selects, so it reads the accounts of that selection.
  if (id === 'gatekeeper-deep') {
    const gatekeeperAccount = seatAccount(seats.gatekeeper);
    quota = await read(gatekeeperAccount);
    if (gatekeeperAccount !== null && quota[gatekeeperAccount].state === 'exhausted' && fallback !== null) quota = await read(seatAccount(fallback));
  }
  const gatekeeper = id === 'gatekeeper' ? effectiveGatekeeper(seats, quota) : null;
  const launchedId = gatekeeper?.id === 'gatekeeper-fallback' ? 'gatekeeper-fallback' : id;
  const seat = gatekeeper?.id === 'gatekeeper-fallback' ? gatekeeper.seat : effectiveSeatConfig(id, seats, quota)!;
  const account = seatAccount(seat);
  if (account !== null && seatState(launchedId, seat, quota) === 'exhausted') {
    throw new SeatsCommandError('seat_quota_exhausted', `The ${account} account is exhausted. Wait for quota before launching ${id}.${gatekeeper === null ? '' : ` Route ${gatekeeper.line}`}`);
  }
  const reserved = account === 'claude' && id !== 'advisor' && id !== 'orchestrator' && claudeReserved(quota);
  if (reserved && ownerException === undefined) {
    throw new SeatsCommandError('seat_quota_reserved', 'Claude is reserved for the advisor and the orchestrator. Use the quota routes, or pass --owner-exception <owner decision URL> for one launch.');
  }
  // The exception lifts only this refusal, so a launch without one has nothing to record.
  if (!reserved && ownerException !== undefined) {
    throw new SeatsCommandError('owner_exception_invalid', `The ${id} launch has no Claude quota reservation to lift. Launch it without --owner-exception.`);
  }
  if (id === 'gatekeeper-deep' && deepGatekeeperRepeatsGatekeeper(seats, quota)) {
    throw new SeatsCommandError('seat_model_repeats_gatekeeper', 'The gatekeeper-deep seat runs the same model as the gatekeeper. Set a different model on the Seats page. See the quota routes.');
  }
  const unavailable = unavailablePiSeat(seat, seats.routing);
  if (unavailable !== null) throw new SeatsCommandError('seat_provider_unavailable', `The ${id} seat cannot launch: ${unavailable}. See the quota routes.`);
  return { seat, modeKnown: account === null || quota[account].remaining !== null, claudeSaving: quota.claude.mode === 'saving' };
}

type SeatLaunchResult = SeatLaunchV1 & {
  readonly labels: readonly string[]; readonly name: string | null; readonly tab: string | null;
  /** The owner decision URL that lifted the Claude quota reservation for this launch (#2769). */
  readonly ownerException: string | null;
};

export async function seatLaunch(seat: string, labels: SeatLabelInput = {}, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), planned?: SeatRouteV1): Promise<SeatLaunchResult> {
  return (await effectiveSeatLaunch(seat, labels, env, cwd, { planned })).launch;
}

/**
 * The launch of a reset seat for `seats reset` (#2633): its argv, its effective model and effort, and whether the quota
 * mode that chose them is known. The checkout comes from the requester selected by the seat identity.
 */
export async function seatResetLaunch(identity: SeatResetIdentity, env: NodeJS.ProcessEnv, checkout: string): Promise<SeatRelaunch> {
  // The terminal already has a waiting shell. Run only the agent command to keep one shell across resets.
  const { launch, effective, modeKnown } = await effectiveSeatLaunch(identity.seat, { repositoryId: identity.repository }, env, checkout, { terminal: 'existing' });
  return { argv: launch.argv, model: effective.model, effort: effective.effort, modeKnown };
}

/** The rh Pi extension of the installed package. A Pi review seat without it would run with no hook, so a missing file stops the launch. */
function installedPiExtension(env: NodeJS.ProcessEnv): string {
  const root = bunGlobalPackageRoot(env);
  const extension = root === null ? null : join(root, 'src', 'pi', 'extension.ts');
  if (extension === null || !existsSync(extension)) {
    throw new SeatsCommandError('pi_extension_missing', 'The installed repo-harness package has no Pi extension (src/pi/extension.ts); a Pi review seat needs it for the hook. Install the package with bun add -g repo-harness.');
  }
  return extension;
}

/** The launch and the effective seat config that it starts; the seat reset compares the config with the session record (#2633). */
async function effectiveSeatLaunch(seat: string, labels: SeatLabelInput, env: NodeJS.ProcessEnv, cwd: string,
  { planned, terminal = 'new' }: { readonly planned?: SeatRouteV1; readonly terminal?: 'new' | 'existing' } = {}): Promise<{
  readonly launch: SeatLaunchResult; readonly effective: SeatConfigV1; readonly modeKnown: boolean;
}> {
  const id = seatId(seat);
  let config: Record<string, unknown>;
  try { config = readGlobalConfiguration(env).config; } catch (error) { throw new SeatsCommandError('config_invalid', (error as Error).message); }
  let seats;
  try { seats = decodeSeatsConfig(config.seats); } catch (error) {
    if (error instanceof SeatsConfigMigrationRequiredError) throw error;
    throw new SeatsCommandError('config_invalid', seatsConfigInvalidMessage(error));
  }
  const configured = seats[id];
  if (configured === null) throw new SeatsCommandError('seat_not_configured', `The ${id} seat is not configured. Configure it in the seats section before launch.`);
  // The board review passes the gatekeeper route that its plan checked: the launched seat is the planned one, with no second quota read.
  // The config is still read for the source of the brief and for the migration error.
  if (labels.ownerException !== undefined) {
    if (planned !== undefined) throw new SeatsCommandError('owner_exception_invalid', 'A planned gatekeeper launch takes no owner exception.');
    checkOwnerException(labels.ownerException, cwd, env);
  }
  // A planned gatekeeper route reserves no Claude seat while Claude is saving or exhausted, so its launch is never a
  // Claude seat in saving mode.
  const { seat: effective, modeKnown, claudeSaving } = id === 'gatekeeper' && planned !== undefined ? { seat: plannedGatekeeper(planned), modeKnown: true, claudeSaving: false }
    : await quotaCheckedSeat(id, seats, configured, env, labels.ownerException);
  if (effective.runtime === 'pi') await assertPiShell(env, cwd);
  const labelSet = seatLabels(id, labels);
  // The pane name needs the registry prefix, so it comes only with the seat labels.
  const name = labels.repositoryId === undefined ? null : seatPaneName({
    prefix: panePrefix(cwd, env), seat: id, issue: isWorkerSeat(id) ? labels.issue : undefined,
    pr: isReviewSeat(id) ? labels.pr : undefined, release: labels.release, qualifier: labels.qualifier,
  });
  const tab = labels.repositoryId === undefined ? null : seatTabName(id, labels.parent);
  const agentTypes = effective.runtime === 'claude' && effective.fleet.length > 0
    ? [...MANAGED_AGENTS, ...RETIRED_SEAT_FLEET_ROLES, ...CLAUDE_BUILTIN_AGENT_TYPES, ...claudeHostAgentTypes(env)]
    : [];
  const piRoleDirectory = effective.runtime === 'pi' && effective.fleet.length > 0 ? writePiFleetRoles(effective.fleet, env, seats.pi_sub_agent_models) : undefined;
  const piHookExtension = effective.runtime === 'pi' && isReviewSeat(id) ? installedPiExtension(env) : undefined;
  const launch = buildSeatLaunch(id, effective, config.seats === undefined ? 'defaults' : 'seats', agentTypes, name ?? undefined, labels.repositoryId, piRoleDirectory, piHookExtension, claudeSaving);
  const argv = labelSet === undefined ? launch.argv : selfLabelingArgv(id, labels, launch.argv, env);
  return { effective, modeKnown, launch: {
    ...launch,
    argv: labelSet !== undefined && terminal === 'new' ? seatLoginShell(argv) : argv,
    labels: labelSet === undefined ? [] : hcLabelPairs(labelSet), name, tab, ownerException: labels.ownerException ?? null,
  } };
}

/** The space of the calling terminal: Herdr.app writes it as a label on each terminal that a pane shows. */
function callerSpace(env: NodeJS.ProcessEnv): string | null {
  try { return hcCallerSpace({ env }); } catch (error) {
    if (error instanceof HerdrCoreError) throw new SeatsCommandError('seat_space_missing', `No Herdr.app space: hc cannot read the calling terminal (${error.message}). Pass --space <id>, or run the launch in a terminal that a Herdr.app pane shows.`);
    throw error;
  }
}

interface SeatTabInput {
  readonly cwd: string;
  readonly task: string;
  readonly space?: string;
  readonly focus: boolean;
}

/**
 * `seats launch` (#3166): open the `seats argv` launch in a Herdr.app tab. A seat that no pane shows is invisible to the
 * person, so a refused tab fails the launch and no headless terminal starts in its place.
 */
async function seatTabLaunch(seat: string, labels: SeatLabelInput, input: SeatTabInput, env: NodeJS.ProcessEnv = process.env): Promise<{
  readonly launch: SeatLaunchResult; readonly model: string | null; readonly space: string; readonly placement: Record<string, unknown>;
}> {
  const space = input.space ?? callerSpace(env);
  if (space === null || space.trim() === '') {
    throw new SeatsCommandError('seat_space_missing', `No Herdr.app space: ${space === null ? 'the calling terminal has no herdr.space label, so no Herdr.app pane shows it' : 'the space is blank'}. Pass --space <id>, or run the launch in a terminal that a Herdr.app pane shows.`);
  }
  const { launch, effective } = await effectiveSeatLaunch(seat, labels, env, input.cwd);
  const args = { ...(launch.tab === null ? {} : { name: launch.tab }), space, folder: input.cwd, argv: launch.argv, task: input.task, focus: input.focus };
  try {
    return { launch, model: effective.model, space, placement: herdrAppDo('tab.new', args, { env }) };
  } catch (error) {
    if (!(error instanceof HerdrCoreError)) throw error;
    if (HERDR_APP_NOT_SENT.has(error.reason)) {
      throw new SeatsCommandError('seat_tab_failed', `Herdr.app opened no tab in space ${space}: ${error.message}. No seat started. Run the launch on the machine that shows the Herdr.app window.`);
    }
    throw new SeatsCommandError('seat_tab_unknown', `Herdr.app did not confirm the tab in space ${space}: ${error.message}. The tab may exist: check hc ls before a retry. No headless seat was started.`);
  }
}

/** The `ok: false` line of `seats argv` and `seats launch`. */
function writeLaunchError(error: unknown): void {
  const code = error instanceof SeatsCommandError || error instanceof ClaudeAgentTypesError || error instanceof PiFleetRolesError || error instanceof PiShellError || error instanceof SeatPaneNameError
    || error instanceof RepoHarnessRegistryStrictError || error instanceof SeatsConfigMigrationRequiredError ? error.code : 'seat_launch_failed';
  process.stderr.write(`${JSON.stringify({ ok: false, error: code, message: (error as Error).message,
    ...(error instanceof SeatsConfigMigrationRequiredError ? { next_action: error.next_action } : {}) })}\n`);
  process.exitCode = 1;
}

/** The label and pane name options that `seats argv` and `seats launch` share. */
function withSeatLabelOptions(command: Command): Command {
  return command
    .argument('<seat>', LAUNCH_SEAT_IDS.join('|'))
    .option('--repository-id <id>', 'GitHub numeric repository id; the argv then labels its own terminal before the agent starts')
    .option('--issue <n>', 'Issue number for the seat labels')
    .option('--pr <n>', 'PR number for the seat labels')
    .option('--parent <n>', 'Parent issue number for the seat labels and the tab name')
    .option('--release <digits>', 'Release item of a worker pane name, for example 0252 for rh-w-rel0252')
    .option('--qualifier <word>', 'Slice word of a worker pane name when one issue has two live worker panes')
    .option('--owner-exception <url>', 'Owner decision URL on an issue or PR of this repository: lifts the Claude quota reservation for this one launch; needs --repository-id');
}

const labelInput = (options: SeatLabelInput): SeatLabelInput => ({
  repositoryId: options.repositoryId, issue: options.issue, pr: options.pr, parent: options.parent, release: options.release, qualifier: options.qualifier,
  ownerException: options.ownerException,
});

/**
 * `seats handoff`: an on-demand reset. It records a reset request for the current session, as the Stop hook does at
 * the threshold, so the peer's `seats reset` accepts the handoff, and returns the steps that the hook prints.
 */
export function seatHandoff(env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  const identity = seatResetIdentity(env);
  if (identity === null) {
    throw new SeatsCommandError('seat_identity_missing', 'REPO_HARNESS_SEAT and REPO_HARNESS_SEAT_REPOSITORY name no orchestrator or advisor seat: start the seat with rh seats argv <seat> --repository-id <id>.');
  }
  const transcript = readSeatSession(identity)?.transcriptPath;
  if (transcript === undefined) throw new SeatsCommandError('seat_session_unknown', `The SessionStart record of the ${identity.seat} seat is missing or not valid, so the session transcript is unknown.`);
  let usage: TranscriptUsage;
  try { usage = readTranscriptUsage(transcript); } catch (error) {
    throw new SeatsCommandError('seat_context_unknown', `The transcript ${transcript} cannot be read: ${(error as Error).message}`);
  }
  const { contextTokens, bytes } = usage;
  if (contextTokens === null) throw new SeatsCommandError('seat_context_unknown', `The transcript ${transcript} has no assistant entry with a context size.`);
  const action = seatResetAction(bytes);
  writeSeatResetRequest(identity, now, { contextTokens, transcriptPath: transcript, transcriptBytes: bytes, action });
  return seatResetSteps(identity, action);
}

/** `loadNotify` comes from the composition root, only when peer-runtime is selected. */
export function buildSeatsCommand(loadNotify?: () => Promise<SeatResetNotify>): Command {
  const seats = new Command('seats').description('Seat model pools and launch commands for Herdr panes');
  seats.command('pool')
    .description('Check which recommended seat models are available in this environment')
    .option('--json', 'Print the seat pools and exclusions as JSON')
    .action(async ({ json }: { json?: boolean }) => {
      try {
        const { report, stored } = await refreshSeatPool();
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
    .description('Print the argv that starts a seat, from the seats section of ~/.repo-harness/config.json'))
    .option('--json', 'Print the argv, the seat brief, the source, the limits, the labels, the pane name and the tab name as JSON')
    .action(async (seat: string, options: SeatLabelInput & { json?: boolean }) => {
      let launch: Awaited<ReturnType<typeof seatLaunch>>;
      try {
        launch = await seatLaunch(seat, labelInput(options), process.env, process.cwd());
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
        result = await seatTabLaunch(seat, labelInput(options), { cwd: resolve(options.cwd), task: options.task, space: options.space, focus: options.focus === true }, process.env);
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
      const { model: _model, ...shown } = result;
      process.stdout.write(options.json === true ? `${JSON.stringify({ ok: true, ...shown }, null, 2)}\n`
        : `${JSON.stringify({ ok: true, seat, name: result.launch.name, tab: result.launch.tab, space: result.space, placement: result.placement })}\n`);
    });
  seats
    .command('label')
    .description('Set the seat labels on the calling hc terminal; the seat argv runs it before the agent starts')
    .argument('<seat>', LAUNCH_SEAT_IDS.join('|'))
    .option('--repository-id <id>', 'GitHub numeric repository id')
    .option('--issue <n>', 'Issue number')
    .option('--pr <n>', 'PR number')
    .option('--parent <n>', 'Parent issue number')
    .option('--owner-exception <url>', 'Owner decision URL that lifted the Claude quota reservation for this launch')
    .action((seat: string, options: SeatLabelInput) => {
      try {
        labelOwnTerminal(seat, { repositoryId: options.repositoryId, issue: options.issue, pr: options.pr, parent: options.parent, ownerException: options.ownerException });
      } catch (error) {
        if (!(error instanceof SeatsCommandError || error instanceof HerdrCoreError)) throw error;
        const code = error instanceof SeatsCommandError ? error.code : 'label_failed';
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
    .description('In the orchestrator or advisor seat: record a reset request now and print the handoff steps of the Stop hook')
    .action(() => {
      try {
        process.stdout.write(`${seatHandoff()}\n`);
      } catch (error) {
        if (!(error instanceof SeatsCommandError)) throw error;
        process.stderr.write(`${JSON.stringify({ ok: false, error: error.code, message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  seats
    .command('reset')
    .description('On a RESET-REQUEST from the orchestrator or advisor seat: check its handoff, ask for a rewrite or send /clear, then resume it; run it in the background')
    .argument('<handoff>', 'The handoff path of the RESET-REQUEST')
    .argument('<sha256>', 'The handoff sha256 of the RESET-REQUEST')
    .action(async (handoff: string, sha256: string) => {
      try {
        // The session that the reset ends; its record is replaced when the new session starts.
        const identity = handoffIdentity(handoff);
        const ending = identity === null ? null : readSeatSession(identity);
        const result = await runSeatReset(handoff, sha256, {
          ...(loadNotify === undefined ? {} : { notify: await loadNotify() }),
          relaunch: (identity, checkout) => seatResetLaunch(identity, process.env, checkout),
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
