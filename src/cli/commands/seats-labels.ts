import { Command } from 'commander';
import { delimiter, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { SeatPaneNameError } from '../../core/board/seat-pane-name';
import { LAUNCH_SEAT_IDS, isCouncilSeat, isReviewSeat, type LaunchSeatId } from '../../core/board/seats-settings';
import { githubRemoteRepository } from '../../core/board/source';
import { resolveGitCommonDirectory } from '../../effects/git/common-directory';
import { gitExecFileSync } from '../../effects/git/runner';
import { AGY_REVIEW_BINDING_ENV, AGY_REVIEW_LAUNCH_ENV, type AgyReviewBinding } from '../../effects/board/agy-review-session';
import { canonicalRepoPath, readRepoHarnessRegistryStrictSnapshot, repoCheckoutProbeEnv } from '../../effects/repo-registry';
import { RH_LABEL, hcLabel, type HcLabels } from '../../effects/terminal/herdr-core';

const CLI_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));

export class SeatsCommandError extends Error {
  constructor(readonly code: 'seat_unknown' | 'seat_not_configured' | 'seat_quota_exhausted' | 'seat_quota_reserved' | 'seat_provider_unavailable' | 'owner_exception_invalid' | 'config_invalid' | 'label_value_invalid' | 'repository_id_required' | 'terminal_unknown' | 'seat_identity_missing' | 'seat_session_unknown' | 'seat_context_unknown' | 'pi_extension_missing' | 'seat_space_missing' | 'seat_tab_failed' | 'seat_tab_unknown'
    | 'seat_runtime_missing' | 'seat_runtime_unsupported' | 'seat_runtime_signed_out' | 'seat_runtime_unknown' | 'seat_model_unavailable'
    | 'seat_checkout_not_opted_in' | 'antigravity_guard_unready' | 'seat_handoff_request_unavailable' | 'seat_handoff_write_failed', message: string) {
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
  /** An owner decision URL on this repository (#2769): it lifts the quota reservation for this one launch. */
  readonly ownerException?: string;
  /** Internal input from the native board review launch. */
  readonly agyReview?: AgyReviewBinding;
}

const POSITIVE = /^[1-9][0-9]*$/u;

export function consultIssueNumber(value: string, flag: '--issue' | '--parent'): number {
  const number = Number(value);
  if (!POSITIVE.test(value) || !Number.isSafeInteger(number)) {
    throw new SeatsCommandError('label_value_invalid', `${flag} must be a positive decimal integer.`);
  }
  return number;
}

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
export function checkOwnerException(url: string, cwd: string, env: NodeJS.ProcessEnv): void {
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

export function seatLabels(seat: LaunchSeatId, input: SeatLabelInput): HcLabels | undefined {
  const { repositoryId, release, qualifier, ownerException, agyReview: _agyReview, ...dispatch } = input;
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
  if (isCouncilSeat(seat) && (input.issue === undefined || input.pr !== undefined || release !== undefined)) {
    throw new SeatPaneNameError('The council seat needs --issue and takes no --pr or --release.');
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
export function seatId(seat: string): LaunchSeatId {
  if (!LAUNCH_SEAT_IDS.includes(seat as LaunchSeatId)) throw new SeatsCommandError('seat_unknown', `Unknown seat ${seat}. Use one of: ${LAUNCH_SEAT_IDS.join(', ')}.`);
  return seat as LaunchSeatId;
}

/**
 * Label the terminal before starting the agent. Keep the login shell's PATH order and append caller bun, rh,
 * and hc directories in caller PATH order before the launcher's Bun directory fallback for smaller-PATH panes.
 */
export function selfLabelingArgv(seat: LaunchSeatId, input: SeatLabelInput, agent: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const flags = ([['--repository-id', input.repositoryId], ['--issue', input.issue], ['--pr', input.pr], ['--parent', input.parent]] as const)
    .flatMap(([flag, value]) => value === undefined ? [] : [flag, value]);
  const pathOrder = new Map<string, number>();
  for (const [index, entry] of (env.PATH ?? '').split(delimiter).entries()) {
    const normalized = resolve(entry);
    if (!pathOrder.has(normalized)) pathOrder.set(normalized, index);
  }
  const toolDirs = [...new Set(['bun', 'rh', 'hc'].flatMap(tool => {
    const path = Bun.which(tool, { PATH: env.PATH ?? '' });
    return path === null ? [] : [dirname(path)];
  }))].sort((left, right) =>
    (pathOrder.get(resolve(left)) ?? Number.MAX_SAFE_INTEGER) - (pathOrder.get(resolve(right)) ?? Number.MAX_SAFE_INTEGER),
  );
  const pathSetup = 'export PATH="${PATH:+$PATH:}${2:+$2:}${0%/*}"';
  const label = `"$0" "$1" seats label ${[seat, ...flags].join(' ')}`;
  const args = [process.execPath, CLI_ENTRY, toolDirs.join(delimiter)];
  if (input.agyReview !== undefined) {
    const { label: binding, startup } = input.agyReview;
    const bind = `if ! ${AGY_REVIEW_BINDING_ENV}="$3" ${label}; then /bin/mkdir "$4/failed"; exit 1; fi`;
    return ['/bin/sh', '-c', `${pathSetup}; ${bind}; /bin/mkdir "$4/bound" && shift 4 && exec "$@"`, ...args, binding, startup, ...agent];
  }
  // The owner exception URL is positional, so only checked seat and dispatch values enter the script.
  return input.ownerException === undefined
    ? ['/bin/sh', '-c', `${pathSetup}; ${label} && shift 2 && exec "$@"`, ...args, ...agent]
    : ['/bin/sh', '-c', `${pathSetup}; ${label} --owner-exception "$3" && shift 3 && exec "$@"`, ...args, input.ownerException, ...agent];
}

/** `seats label`: set the seat labels on the calling hc terminal. The seat argv runs it before the agent starts. */
export function labelOwnTerminal(seat: string, input: SeatLabelInput, env: NodeJS.ProcessEnv = process.env): void {
  const labels = seatLabels(seatId(seat), input);
  if (labels === undefined) throw new SeatsCommandError('repository_id_required', 'seats label needs --repository-id.');
  const terminal = env.HC_TERMINAL_ID;
  if (!terminal) throw new SeatsCommandError('terminal_unknown', 'HC_TERMINAL_ID is not set: start the seat argv with herdr-app do tab.new or pane.split.');
  const { [AGY_REVIEW_BINDING_ENV]: binding, [AGY_REVIEW_LAUNCH_ENV]: _launchId, ...hcEnv } = env;
  const boundLabels = seat === 'gatekeeper' && binding !== undefined ? { ...labels, [RH_LABEL.agyReview]: binding } : labels;
  hcLabel(terminal, boundLabels, { env: hcEnv });
}

/** The registry entry of the primary checkout of `cwd` holds the pane prefix; a linked worktree resolves to its primary root. */
export function panePrefix(cwd: string, env: NodeJS.ProcessEnv): string {
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

/** The label and pane name options that `seats argv` and `seats launch` share. */
export function withSeatLabelOptions(command: Command): Command {
  return command
    .argument('<seat>', LAUNCH_SEAT_IDS.join('|'))
    .option('--repository-id <id>', 'GitHub numeric repository id; the argv then labels its own terminal before the agent starts')
    .option('--issue <n>', 'Issue number for the seat labels')
    .option('--pr <n>', 'PR number for the seat labels')
    .option('--parent <n>', 'Parent issue number for the seat labels and the tab name')
    .option('--release <digits>', 'Release item of a worker pane name, for example 0252 for rh-w-rel0252')
    .option('--qualifier <word>', 'Slice word of a worker or council pane name')
    .option('--owner-exception <url>', 'Owner decision URL on an issue or PR of this repository: lifts the quota reservation for this one launch; needs --repository-id');
}

export const labelInput = (options: SeatLabelInput): SeatLabelInput => ({
  repositoryId: options.repositoryId, issue: options.issue, pr: options.pr, parent: options.parent, release: options.release, qualifier: options.qualifier,
  ownerException: options.ownerException,
});
