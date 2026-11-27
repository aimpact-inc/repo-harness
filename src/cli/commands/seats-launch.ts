import { CLAUDE_BUILTIN_AGENT_TYPES, buildSeatLaunch, type SeatLaunchV1 } from '../../core/board/seat-launch';
import { SeatPaneNameError, seatPaneName, seatTabName } from '../../core/board/seat-pane-name';
import {
  AgySeatSettingsError,
  RETIRED_SEAT_FLEET_ROLES,
  SEAT_IDS,
  isCouncilSeat,
  isReviewSeat,
  isWorkerSeat,
  unavailablePiSeat,
  type LaunchSeatId,
  type SeatConfigV1,
  type SeatId,
} from '../../core/board/seats-settings';
import { SeatsConfigMigrationRequiredError } from '../../core/board/seats-settings-migration';
import { shownModel, type SeatRouteV1 } from '../../core/board/seat-routing';
import { readAgyQuota } from '../../effects/board/quota';
import { ClaudeAgentTypesError, claudeHostAgentTypes } from '../../effects/board/claude-agent-types';
import { RepoHarnessRegistryStrictError } from '../../effects/repo-registry';
import { HERDR_APP_NOT_SENT, HerdrCoreError, boardHostPorts, buildHerdrSeatPlacement, executeHerdrSeatPlacement, hcCallerSpace, hcLabelPairs, herdrAppSpaceTabs, recordPendingTabPlacement, seatLoginShell, withPendingTabPlacements, type HerdrAppTab } from '../../effects/terminal/herdr-core';
import { matchingWorkerTerminals } from '../../effects/board/review';
import { PiFleetRolesError, writePiFleetRoles } from '../../effects/board/pi-fleet-roles';
import { PiShellError, assertPiShell } from '../../effects/board/pi-shell';
import { MANAGED_AGENTS } from '../../effects/terminal/task-role-profiles';
import { CouncilConsultError } from '../../core/board/planner-consult';
import { seatModelBlock, seatPoolHint, seatRuntimeBlock } from '../../core/board/seat-pool';
import { agySeatAgentSpec, collectSeatPoolProbes, magpieExtensionInstalled, resolveAgyInstallation, SeatsConfigurationError, writeAgySeatAgent } from '../../effects/board/seats-configuration';
import { HostConfigError } from '../../core/host-config/types';
import { AntigravityHooksPathError } from '../../effects/host-config/gate';
import { SeatsCommandError, checkOwnerException, panePrefix, seatId, seatLabels, selfLabelingArgv, type SeatLabelInput } from './seats-labels';
import { checkAgyLaunchTarget, checkedAgyRuntime, configuredSeats, installedPiExtension, plannedGatekeeper, quotaCheckedSeat } from './seats-runtime';

export type SeatLaunchResult = SeatLaunchV1 & {
  readonly labels: readonly string[];
  readonly name: string | null;
  readonly tab: string | null;
  /** The owner decision URL that lifted the quota reservation for this launch (#2769). */
  readonly ownerException: string | null;
};

/** The launch and the effective seat config that it starts. */
export async function effectiveSeatLaunch(seat: string, labels: SeatLabelInput, env: NodeJS.ProcessEnv, cwd: string,
  { planned, terminal = 'new', prepareFleet = true, checkAvailability = false, configuredOverride, providerUnavailable }: {
    readonly planned?: SeatRouteV1; readonly terminal?: 'new' | 'existing'; readonly prepareFleet?: boolean; readonly checkAvailability?: boolean;
    readonly configuredOverride?: SeatConfigV1; readonly providerUnavailable: (message: string) => Error;
  }): Promise<{
  readonly launch: SeatLaunchResult; readonly agentArgv: readonly string[];
  readonly effective: SeatConfigV1; readonly effectiveId: LaunchSeatId | 'gatekeeper-fallback'; readonly modeKnown: boolean;
}> {
  const id = seatId(seat);
  const { config, seats } = configuredSeats(env);
  const configured = configuredOverride ?? seats[id];
  if (configured === null) throw new SeatsCommandError('seat_not_configured', `The ${id} seat is not configured. Configure it in the seats section before launch.`);
  // The board review passes the gatekeeper route that its plan checked: the launched seat is the planned one, with no second quota read.
  // The config is still read for the source of the brief and for the migration error.
  if (labels.ownerException !== undefined) {
    if (planned !== undefined) throw new SeatsCommandError('owner_exception_invalid', 'A planned gatekeeper launch takes no owner exception.');
    checkOwnerException(labels.ownerException, cwd, env);
  }
  const labelSet = seatLabels(id, labels);
  const plannedSeat = id === 'gatekeeper' && planned !== undefined ? plannedGatekeeper(planned) : null;
  const runtimeSeat: SeatId = plannedSeat?.id === 'gatekeeper-fallback' ? plannedSeat.id : id;
  const initialCandidate = plannedSeat?.seat ?? configured;
  let agyProbe = prepareFleet && initialCandidate.runtime === 'agy'
    ? checkedAgyRuntime(runtimeSeat, config, initialCandidate, env)
    : undefined;
  const checkPool = checkAvailability && agyProbe === undefined;
  const probes = checkPool ? collectSeatPoolProbes(env, SEAT_IDS.some(seatId => seats[seatId]?.runtime === 'agy')) : [];
  const unavailable = (modelSeat: SeatId, reason: string) => {
    throw providerUnavailable(`The ${id} seat cannot launch. ${reason} ${seatPoolHint(modelSeat, seats, probes)}`);
  };
  if (checkPool) {
    const reason = seatRuntimeBlock(runtimeSeat, initialCandidate.runtime, probes);
    if (reason !== null) unavailable(runtimeSeat, reason);
  }
  let agyInstallation: ReturnType<typeof resolveAgyInstallation> | undefined;
  const readAgy = () => {
    agyInstallation ??= agyProbe === undefined ? resolveAgyInstallation(env) : Promise.resolve(agyProbe.installation);
    return readAgyQuota(env, agyInstallation);
  };
  // A planned gatekeeper route reserves no Claude seat while Claude is saving or exhausted.
  const { id: effectiveId, seat: effective, modeKnown, claudeSaving } = plannedSeat !== null
    ? { id: runtimeSeat, seat: plannedSeat.seat, modeKnown: true, claudeSaving: false }
    : await quotaCheckedSeat(id, seats, configured, env, labels.ownerException, readAgy);
  if (prepareFleet && effective.runtime === 'agy') {
    if (agyProbe === undefined) {
      const installation = await agyInstallation?.catch(() => undefined);
      const probeEnv = installation?.kind === 'available' && installation.via === 'executable'
        ? { ...env, OAR_ANTIGRAVITY_BIN: installation.command } : env;
      agyProbe = checkedAgyRuntime(effectiveId, config, effective, probeEnv);
    }
    checkAgyLaunchTarget(effectiveId, effective, agyProbe.models, env, cwd);
  }
  if (checkPool && effective.runtime !== 'agy') {
    const reason = seatModelBlock(effectiveId, effective, seats, probes, () => magpieExtensionInstalled(env));
    if (reason !== null) unavailable(effectiveId, reason);
  } else if (effective.runtime !== 'agy') {
    const reason = unavailablePiSeat(effective, seats.routing);
    if (reason !== null) throw new SeatsCommandError('seat_provider_unavailable', `The ${id} seat cannot launch: ${reason}. See the quota routes.`);
  }
  if (effective.runtime === 'pi') await assertPiShell(env, cwd);
  // The pane name needs the registry prefix, so it comes only with the seat labels; the base tab name does not.
  const name = labels.repositoryId === undefined ? null : seatPaneName({
    prefix: panePrefix(cwd, env), seat: id, issue: isWorkerSeat(id) || isCouncilSeat(id) ? labels.issue : undefined,
    pr: isReviewSeat(id) ? labels.pr : undefined, release: labels.release, qualifier: labels.qualifier,
  });
  const tab = seatTabName(id, { issue: labels.issue, pr: labels.pr });
  const agentTypes = effective.runtime === 'claude' && effective.fleet.length > 0
    ? [...MANAGED_AGENTS, ...RETIRED_SEAT_FLEET_ROLES, ...CLAUDE_BUILTIN_AGENT_TYPES, ...claudeHostAgentTypes(env)]
    : [];
  const piRoleDirectory = prepareFleet && effective.runtime === 'pi' && effective.fleet.length > 0 ? writePiFleetRoles(effective.fleet, env, seats.pi_sub_agent_models) : undefined;
  const piHookExtension = effective.runtime === 'pi' && isReviewSeat(id) ? installedPiExtension(env) : undefined;
  const agy = effective.runtime !== 'agy'
    ? undefined
    : prepareFleet
      ? { executable: agyProbe!.installation.command, agentName: writeAgySeatAgent(id, effective, env), cwd }
      : { executable: 'agy', agentName: agySeatAgentSpec(id, effective).name, cwd };
  const launch = buildSeatLaunch(id, effective, config.seats === undefined ? 'defaults' : 'seats', agentTypes, {
    paneName: name ?? undefined, repositoryId: labels.repositoryId, piRoleDirectory, piHookExtension, claudeSaving, agy,
  });
  const argv = [...launch.argv];
  if (terminal === 'existing' && effective.runtime !== 'agy' && effective.runtime !== 'codex') {
    const executable = Bun.which(effective.runtime, { PATH: env.PATH ?? '' });
    if (executable === null) throw new SeatsCommandError('seat_runtime_missing', `${effective.runtime} is missing from the launch PATH.`);
    // Run the checked executable even when the requester's parent shell has a different PATH.
    argv[argv.indexOf(effective.runtime)] = executable;
  }
  const labeledArgv = labelSet === undefined ? argv : selfLabelingArgv(id, labels, argv, env);
  return { effective, effectiveId, modeKnown, agentArgv: argv, launch: {
    ...launch,
    argv: labelSet === undefined ? argv : (terminal === 'new' ? seatLoginShell(labeledArgv) : labeledArgv),
    labels: labelSet === undefined ? [] : hcLabelPairs(labelSet), name, tab, ownerException: labels.ownerException ?? null,
  } };
}

/** The space of the calling terminal: Herdr.app writes it as a label on each terminal that a pane shows. */
export function callerSpace(env: NodeJS.ProcessEnv): string | null {
  try { return hcCallerSpace({ env }); } catch (error) {
    if (error instanceof HerdrCoreError) throw new SeatsCommandError('seat_space_missing', `No Herdr.app space: hc cannot read the calling terminal (${error.message}). Pass --space <id>, or run the launch in a terminal that a Herdr.app pane shows.`);
    throw error;
  }
}

export interface SeatTabInput {
  readonly cwd: string;
  readonly task: string;
  readonly space?: string;
  readonly focus: boolean;
}

function reviewPreferredWorkers(labels: SeatLabelInput, cwd: string, env: NodeJS.ProcessEnv): readonly string[] {
  if (labels.repositoryId === undefined) return [];
  const read = boardHostPorts({ env }).seatTerminals(labels.repositoryId);
  if (read.status !== 'observed') return [];
  return matchingWorkerTerminals({
    terminals: read.terminals,
    issues: labels.issue === undefined ? [] : [labels.issue],
    pr: labels.pr,
    cwd,
  });
}

/**
 * `seats launch` (#3166): place the `seats argv` launch in a Herdr.app pane (explicit-ID `pane.split` up to 3 panes
 * per tab, else `tab.new`). A seat that no pane shows is invisible to the person, so a refused placement fails the
 * launch and no headless terminal starts in its place.
 */
export async function seatTabLaunch(
  seat: string,
  labels: SeatLabelInput,
  input: SeatTabInput,
  providerUnavailable: (message: string) => Error,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  readonly launch: Omit<SeatLaunchResult, 'argv'> & { readonly argv?: readonly string[] }; readonly model: string | null;
  readonly modelField: string | null; readonly space: string; readonly placement: Record<string, unknown>;
}> {
  const space = input.space ?? callerSpace(env);
  if (space === null || space.trim() === '') {
    throw new SeatsCommandError('seat_space_missing', `No Herdr.app space: ${space === null ? 'the calling terminal has no herdr.space label, so no Herdr.app pane shows it' : 'the space is blank'}. Pass --space <id>, or run the launch in a terminal that a Herdr.app pane shows.`);
  }
  const { launch, effective, effectiveId } = await effectiveSeatLaunch(seat, labels, env, input.cwd, { checkAvailability: true, providerUnavailable });
  const field = `seats.${effectiveId}.model`;
  const modelField = shownModel(field, effective.model) === field ? field : null;
  const agy = launch.runtime === 'agy';
  const preferredTerminals = isReviewSeat(launch.seat) && labels.repositoryId !== undefined
    ? reviewPreferredWorkers(labels, input.cwd, env)
    : undefined;
  const { placement, tabName } = openSeatTab({
    ...(launch.tab === null ? {} : { name: launch.tab }),
    space,
    folder: input.cwd,
    focus: input.focus,
    ...(preferredTerminals === undefined ? {} : { preferredTerminals }),
    ...(agy ? { argv: [...launch.argv, '-i', input.task] } : { argv: launch.argv, task: input.task }),
  }, env, modelField, agy);
  const updatedLaunch = { ...launch, tab: tabName };
  const { argv: _argv, ...summary } = updatedLaunch;
  return { launch: modelField === null ? updatedLaunch : summary, model: modelField ?? effective.model, modelField, space, placement };
}

interface SeatPlacementRequest {
  readonly space: string;
  readonly folder: string;
  readonly argv: readonly string[];
  readonly name?: string;
  readonly task?: string;
  readonly focus?: boolean;
  readonly preferredTerminals?: readonly string[];
}

const sanitizePlacement = (raw: Record<string, unknown>, privateTask: boolean): Record<string, unknown> => (
  !privateTask
    ? raw
    : Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
      ['tab', 'pane', 'terminal', 'space'].includes(key) && typeof value === 'string' && /^[a-z0-9/_-]+$/iu.test(value)))
);

export function openSeatTab(
  request: SeatPlacementRequest,
  env: NodeJS.ProcessEnv,
  modelField: string | null = null,
  privateTask = false,
  pendingByTab?: Map<string, Set<string>>,
): { readonly placement: Record<string, unknown>; readonly tabName: string | null } {
  const { space } = request;
  const formatDetail = (error: HerdrCoreError) =>
    modelField !== null ? `${error.reason}. See ${modelField}` : privateTask ? error.reason : error.message;
  let tabs: readonly HerdrAppTab[];
  try {
    tabs = herdrAppSpaceTabs(space, { env });
  } catch (error) {
    if (!(error instanceof HerdrCoreError)) throw error;
    // `herdr-app ls` is read-only: no tab or split request was sent yet.
    throw new SeatsCommandError('seat_tab_failed', `Herdr.app opened no tab in space ${space}: ${formatDetail(error)}. No seat started. Run the launch on the machine that shows the Herdr.app window.`);
  }
  const effectiveTabs = pendingByTab === undefined ? tabs : withPendingTabPlacements(tabs, pendingByTab);
  try {
    const planned = buildHerdrSeatPlacement({
      space,
      folder: request.folder,
      argv: request.argv,
      ...(request.task === undefined ? {} : { task: request.task }),
      ...(request.focus === undefined ? {} : { focus: request.focus }),
      baseTabName: request.name ?? null,
      tabs: effectiveTabs,
      preferredTerminals: request.preferredTerminals,
    });
    const raw = executeHerdrSeatPlacement(planned, { env });
    if (pendingByTab !== undefined) recordPendingTabPlacement(pendingByTab, planned, raw);
    return { placement: sanitizePlacement(raw, privateTask), tabName: planned.tabName };
  } catch (error) {
    if (!(error instanceof HerdrCoreError)) throw error;
    const detail = formatDetail(error);
    if (HERDR_APP_NOT_SENT.has(error.reason)) {
      throw new SeatsCommandError('seat_tab_failed', `Herdr.app opened no tab in space ${space}: ${detail}. No seat started. Run the launch on the machine that shows the Herdr.app window.`);
    }
    throw new SeatsCommandError('seat_tab_unknown', `Herdr.app did not confirm the tab in space ${space}: ${detail}. The tab may exist: check hc ls before a retry. No headless seat was started.`);
  }
}

/** The structured error line of the seat launch commands. */
export function writeLaunchError(error: unknown): void {
  const code = error instanceof SeatsCommandError || error instanceof ClaudeAgentTypesError || error instanceof PiFleetRolesError || error instanceof PiShellError || error instanceof SeatPaneNameError
    || error instanceof RepoHarnessRegistryStrictError || error instanceof SeatsConfigMigrationRequiredError || error instanceof CouncilConsultError
    || error instanceof SeatsConfigurationError || error instanceof AgySeatSettingsError
    || error instanceof AntigravityHooksPathError || error instanceof HostConfigError ? error.code : 'seat_launch_failed';
  process.stderr.write(`${JSON.stringify({ ok: false, error: code, message: (error as Error).message,
    ...(error instanceof SeatsConfigMigrationRequiredError ? { next_action: error.next_action } : {}) })}\n`);
  process.exitCode = 1;
}
