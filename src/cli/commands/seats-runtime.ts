import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'path';
import {
  AGY_READONLY_SEAT_TOOLS,
  ALLOWED_SEAT_FLEET_ROLES,
  AgySeatSettingsError,
  COUNCIL_TOOLS,
  decodeSeatsConfig,
  isAgyAllowedSeat,
  isCouncilSeat,
  isWorkerSeat,
  seatHostId,
  seatsConfigInvalidMessage,
  unavailablePiSeat,
  type AgyCatalogModel,
  type LaunchSeatId,
  type SeatConfigV1,
  type SeatId,
  type SeatsConfigV1,
} from '../../core/board/seats-settings';
import { SeatsConfigMigrationRequiredError } from '../../core/board/seats-settings-migration';
import { resolveCatalogRoute } from '../../core/board/model-catalog';
import { agyReserved, claudeReserved, effectiveGatekeeper, effectiveSeatConfig, seatAccount, seatAccountQuotas, seatState, type SeatRouteV1 } from '../../core/board/seat-routing';
import { AGY_QUOTA_ACCOUNTS, classifyQuotaReading, type QuotaAccount, type QuotaReading } from '../../core/board/quota';
import { readClaudeQuota, readCodexQuota } from '../../effects/board/quota';
import { version as PACKAGE_VERSION } from '../../../package.json';
import { readGlobalConfiguration } from '../../effects/configuration/global-configuration';
import { bunGlobalPackageRoot } from '../installer/skill-projection';
import { SEAT_ENV, SEAT_REPOSITORY_ENV } from '../../core/board/seat-reset';
import { isRecord } from '../../core/evidence/is-record';
import { type CouncilMember } from '../../core/board/planner-consult';
import { enabledRuntimesOf, magpieExtensionInstalled, probeAgySeat, SeatsConfigurationError } from '../../effects/board/seats-configuration';
import { checkAntigravityHooks } from '../installer/targets/antigravity';
import { resolveAntigravityRepository } from '../hook/host-adapter';
import { EDIT_GUARD_SCOPE_SECTION } from '../hook/session-context';
import { SeatsCommandError } from './seats-labels';

export function plannedGatekeeper(route: SeatRouteV1): Exclude<SeatRouteV1, { id: null }> {
  if (route.id === null) throw new SeatsCommandError('seat_quota_exhausted', `No gatekeeper seat can launch. Route ${route.line}`);
  return route;
}

/**
 * The seat config that launches for `id` under the current quota, or the quota refusal. `modeKnown` is false when the
 * account of the launched seat has no fresh weekly reading (missing, unreadable or stale capture), so its mode is unknown.
 */
export async function quotaCheckedSeat(id: LaunchSeatId, seats: SeatsConfigV1, configured: SeatConfigV1, env: NodeJS.ProcessEnv,
  ownerException: string | undefined, readAgy: () => Promise<QuotaReading[]>): Promise<{
  readonly id: LaunchSeatId | 'gatekeeper-fallback'; readonly seat: SeatConfigV1; readonly modeKnown: boolean;
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
        readings.push(...await readAgy());
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
  const gatekeeper = id === 'gatekeeper' ? effectiveGatekeeper(seats, quota) : null;
  const launchedId = gatekeeper?.id === 'gatekeeper-fallback' ? 'gatekeeper-fallback' : id;
  const seat = gatekeeper?.id === 'gatekeeper-fallback'
    ? gatekeeper.seat
    : isCouncilSeat(id) ? configured : effectiveSeatConfig(id, { ...seats, [id]: configured }, quota)!;
  const account = seatAccount(seat);
  if (account !== null && seatState(launchedId, seat, quota) === 'exhausted') {
    throw new SeatsCommandError('seat_quota_exhausted', `The ${account} account is exhausted. Wait for quota before launching ${id}.${gatekeeper === null ? '' : ` Route ${gatekeeper.line}`}`);
  }
  const reservedClaude = account === 'claude' && id !== 'advisor' && id !== 'orchestrator' && claudeReserved(quota);
  const reservedAgy = account === 'agy_gemini' && id !== 'advisor' && !isCouncilSeat(id) && agyReserved(quota);
  const reserved = reservedClaude || reservedAgy;
  if (reserved && ownerException === undefined) {
    throw new SeatsCommandError(
      'seat_quota_reserved',
      reservedClaude
        ? 'Claude is reserved for the advisor and the orchestrator. Use the quota routes, or pass --owner-exception <owner decision URL> for one launch.'
        : 'Google Ultra (agy_gemini) is reserved for the advisor below seats.routing.agy_saving_below_remaining. Use the quota routes, or pass --owner-exception <owner decision URL> for one launch.',
    );
  }
  // The exception lifts only this refusal, so a launch without one has nothing to record.
  if (!reserved && ownerException !== undefined) {
    throw new SeatsCommandError('owner_exception_invalid', `The ${id} launch has no quota reservation to lift. Launch it without --owner-exception.`);
  }
  return { id: launchedId, seat, modeKnown: account === null || quota[account].remaining !== null, claudeSaving: !isCouncilSeat(id) && quota.claude.mode === 'saving' };
}

const runStartupProbe = promisify(execFile);
// Claude gives each startup hook up to 30 seconds, then still has to close the stream.
const STARTUP_PROBE_TIMEOUT_MS = 45_000;

function claudeStartupHookConfirmed(stdout: string): boolean {
  return stdout.split('\n').some(line => {
    try {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event) || event.type !== 'system' || event.subtype !== 'hook_response' || event.hook_event !== 'SessionStart'
        || event.hook_name !== 'SessionStart:startup' || event.outcome !== 'success' || event.exit_code !== 0 || typeof event.stdout !== 'string') return false;
      const response: unknown = JSON.parse(event.stdout);
      if (!isRecord(response) || !isRecord(response.hookSpecificOutput)) return false;
      const { hookEventName, additionalContext } = response.hookSpecificOutput;
      return hookEventName === 'SessionStart' && typeof additionalContext === 'string'
        && additionalContext.split('\n').includes(EDIT_GUARD_SCOPE_SECTION.content);
    } catch { return false; }
  });
}

export async function probeClaudeResetStartup(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<string[]> {
  // Use the same executable, CLI flags, settings roots, and tool PATH in the probe and replacement.
  const names = ['HOME', 'PATH',
    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_PERSONAL_HOOKS_OFF',
    'CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'CLAUDE_CODE_REMOTE_SETTINGS_PATH',
  ];
  const binding = [
    ...names.flatMap(name => ['-u', name]), '-u', 'CLAUDECODE',
    ...names.flatMap(name => env[name] === undefined ? [] : [`${name}=${env[name]}`]),
  ];
  const probe = [...argv.filter(arg => !arg.startsWith(`${SEAT_ENV}=`) && !arg.startsWith(`${SEAT_REPOSITORY_ENV}=`)),
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--no-session-persistence'];
  const unavailable = new Error('claude did not confirm the repo-harness SessionStart integration');
  const execution = runStartupProbe('/usr/bin/env', [...binding, ...probe], {
    cwd, env, timeout: STARTUP_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
  });
  execution.child.stdin?.end();
  const { stdout } = await execution.catch(() => { throw unavailable; });
  if (!claudeStartupHookConfirmed(stdout)) throw unavailable;
  return ['/usr/bin/env', ...binding, ...argv];
}

/** The rh Pi extension of the installed package. A Pi review seat without it would run with no hook, so a missing file stops the launch. */
export function installedPiExtension(env: NodeJS.ProcessEnv): string {
  const root = bunGlobalPackageRoot(env);
  const extension = root === null ? null : join(root, 'src', 'pi', 'extension.ts');
  if (extension === null || !existsSync(extension)) {
    throw new SeatsCommandError('pi_extension_missing', 'The installed repo-harness package has no Pi extension (src/pi/extension.ts); a Pi review seat needs it for the hook. Install the package with bun add -g repo-harness.');
  }
  return extension;
}

function councilMemberRoute(member: CouncilMember, seats: SeatsConfigV1, env: NodeJS.ProcessEnv) {
  const nativeRoute = resolveCatalogRoute(member, 'native');
  if (seats.council?.runtime === 'agy' && nativeRoute?.runtime === 'agy') return nativeRoute;
  const magpieRoute = resolveCatalogRoute(member, 'magpie');
  if (magpieRoute === null) return nativeRoute!;
  if (magpieRoute.runtime !== 'pi') return magpieRoute;
  const piAvailable = Bun.which('pi', { PATH: env.PATH ?? '' }) !== null
    && magpieExtensionInstalled(env)
    && unavailablePiSeat(magpieRoute, seats.routing) === null;
  return piAvailable ? magpieRoute : (nativeRoute ?? magpieRoute);
}

export function resolveCouncilMemberSeat(member: CouncilMember, seats: SeatsConfigV1, env: NodeJS.ProcessEnv): SeatConfigV1 {
  const selected = councilMemberRoute(member, seats, env);
  const stored = seats.council;
  const matchesStored = stored !== null && stored.runtime === selected.runtime && stored.model === selected.model;
  return {
    runtime: selected.runtime,
    model: selected.model,
    advisor_model: null,
    effort: matchesStored ? stored.effort : (selected.effort ?? null),
    tools: selected.runtime === 'agy' ? AGY_READONLY_SEAT_TOOLS : (stored?.tools ?? COUNCIL_TOOLS),
    fleet: selected.runtime === 'agy' ? [] : (stored?.fleet ?? ALLOWED_SEAT_FLEET_ROLES.council),
  };
}

export function configuredSeats(env: NodeJS.ProcessEnv): { config: Record<string, unknown>; seats: SeatsConfigV1 } {
  let config: Record<string, unknown>;
  try { config = readGlobalConfiguration(env).config; } catch (error) { throw new SeatsCommandError('config_invalid', (error as Error).message); }
  try { return { config, seats: decodeSeatsConfig(config.seats) }; } catch (error) {
    if (error instanceof SeatsConfigMigrationRequiredError || error instanceof AgySeatSettingsError) throw error;
    throw new SeatsCommandError('config_invalid', seatsConfigInvalidMessage(error));
  }
}

export function checkedAgyRuntime(id: SeatId, config: Record<string, unknown>, seat: SeatConfigV1, env: NodeJS.ProcessEnv) {
  if (!isAgyAllowedSeat(id)) {
    throw new SeatsCommandError('seat_runtime_unsupported', `Direct agy launch is not supported on the ${id} seat.`);
  }
  if (isWorkerSeat(id) && !seat.tools.includes('edit')) {
    throw new SeatsConfigurationError(
      'seat_tool_not_allowed',
      `The ${id} agy worker seat is configured read-only (missing edit). Enable edit for seats.${id}.tools in Settings before launching it.`,
    );
  }
  if (!enabledRuntimesOf(config).includes(seatHostId('agy'))) {
    throw new SeatsConfigurationError('seat_runtime_not_enabled', `Enable Antigravity in Hosts before launching the ${id}.`);
  }
  const probe = probeAgySeat(env);
  switch (probe.kind) {
    case 'not_installed': throw new SeatsCommandError('seat_runtime_missing', `Install agy before launching the ${id}. See seats.${id}.model.`);
    case 'unsupported': throw new SeatsCommandError('seat_runtime_unsupported', `The ${id} requires stable agy 1.5.0 or later. See seats.${id}.model.`);
    case 'signed_out': throw new SeatsCommandError('seat_runtime_signed_out', `Sign in through agy before launching the ${id}. See seats.${id}.model.`);
    case 'unknown':
    case 'catalog_unknown': throw new SeatsCommandError('seat_runtime_unknown', `The agy installation or model catalog could not be checked. Retry the launch. See seats.${id}.model.`);
    case 'available': return probe;
  }
}

export function checkAgyLaunchTarget(id: SeatId, seat: SeatConfigV1, models: readonly AgyCatalogModel[], env: NodeJS.ProcessEnv, cwd: string): void {
  const model = models.find(item => item.id === seat.model);
  if (model === undefined) {
    throw new SeatsCommandError('seat_model_unavailable', `agy does not list the selected ${id} model. See seats.${id}.model.`);
  }
  if (seat.effort !== null && !(model.efforts ?? []).includes(seat.effort)) {
    throw new AgySeatSettingsError('seat_effort_invalid', id, 'effort');
  }
  let optedIn = false;
  try { optedIn = resolveAntigravityRepository({ cwd }).status === 'opted-in'; } catch { /* refuse unresolved checkouts */ }
  if (!optedIn) throw new SeatsCommandError('seat_checkout_not_opted_in', `Start the agy ${id} in a repo-harness opt-in checkout.`);
  const [activation, direct] = checkAntigravityHooks(env);
  if (activation.status !== 'ok' || direct.status !== 'ok') {
    throw new SeatsCommandError('antigravity_guard_unready', `On-disk activation: ${activation.status}. Direct guard: ${direct.status}. Run rh doctor for details.`);
  }
}
