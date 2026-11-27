import { PANE_PREFIX } from '../terminal/pane-prefix';
import { isCouncilSeat, isReviewSeat, isWorkerSeat, type LaunchSeatId } from './seats-settings';

const PANE_ROLE = { orchestrator: 'orch', advisor: 'adv', council: 'cn', worker: 'w', 'worker-deep': 'w', 'worker-opus': 'w', 'worker-neon': 'w', 'worker-neon-deep': 'w', 'worker-light': 'w', gatekeeper: 'gk', reviewer: 'rv' } as const;
const PANE_NAME_MAX = 32;
const POSITIVE = /^[1-9][0-9]*$/u;
const WORD = /^[a-z][a-z0-9]*$/u;

export class SeatPaneNameError extends Error {
  readonly code = 'pane_name_invalid';
}

export interface SeatPaneNameInput {
  /** The `panePrefix` of the repository's registry entry (#1544). */
  readonly prefix: string;
  readonly seat: LaunchSeatId;
  readonly issue?: string;
  readonly pr?: string;
  /** The digits of a release item, for example `0252`. */
  readonly release?: string;
  readonly qualifier?: string;
}

/**
 * The hc `--name` and Claude `-n` of a seat pane: `<prefix>-<role>[-<item>][-<qualifier>]`. The worker item is its
 * issue or `rel<digits>`; the council item is its issue; the reviewer item is its PR.
 */
export function seatPaneName(input: SeatPaneNameInput): string {
  const fail = (why: string): never => { throw new SeatPaneNameError(`Pane name: ${why}.`); };
  const { prefix, seat, issue, pr, release, qualifier } = input;
  if (!PANE_PREFIX.test(prefix)) fail(`prefix ${JSON.stringify(prefix)} must match ${PANE_PREFIX.source}`);
  const role: string | undefined = PANE_ROLE[seat];
  if (role === undefined) fail(`unknown seat ${JSON.stringify(seat)}`);
  let item: string | undefined;
  if (isWorkerSeat(seat)) {
    if ((issue === undefined) === (release === undefined)) fail('a worker needs exactly one of an issue and a release item');
    if (pr !== undefined) fail('a worker takes no PR');
    if (issue !== undefined && !POSITIVE.test(issue)) fail('the issue must be a positive decimal integer');
    if (release !== undefined && !/^[0-9]+$/u.test(release)) fail('the release item must be digits');
    item = issue ?? `rel${release}`;
  } else if (isReviewSeat(seat)) {
    if (pr === undefined || !POSITIVE.test(pr)) fail(`a ${seat} needs a PR, a positive decimal integer`);
    if (issue !== undefined || release !== undefined) fail(`a ${seat} takes only a PR`);
    item = pr;
  } else if (isCouncilSeat(seat)) {
    if (issue === undefined || !POSITIVE.test(issue)) fail('a council seat needs an issue, a positive decimal integer');
    if (pr !== undefined || release !== undefined) fail('a council seat takes only an issue');
    item = issue;
  } else if (issue !== undefined || pr !== undefined || release !== undefined || qualifier !== undefined) {
    fail(`the ${seat} pane takes no item and no qualifier`);
  }
  if (qualifier !== undefined && !WORD.test(qualifier)) fail(`qualifier ${JSON.stringify(qualifier)} must match ${WORD.source}`);
  const name = [prefix, role, item, qualifier].filter(part => part !== undefined).join('-');
  if (name.length > PANE_NAME_MAX) fail(`${name} is longer than ${PANE_NAME_MAX} characters`);
  return name;
}

export interface SeatTabNameInput {
  readonly issue?: string;
  readonly pr?: string;
}

/**
 * The Herdr.app base tab name of a seat pane, before any fullness suffix (` 2`, ` 3`):
 * - worker seats: `#<issue>` when `--issue` is provided, else `other`
 * - review seats (`gatekeeper`, `reviewer`): fallback `PR#<pr>` when `--pr` is provided, else `review`
 * - council seats: `council`
 * - orchestrator / advisor: `orch`
 */
export function seatTabName(seat: LaunchSeatId, item: SeatTabNameInput = {}): string {
  if (item.issue !== undefined && !POSITIVE.test(item.issue)) throw new SeatPaneNameError('Tab name: the issue must be a positive decimal integer.');
  if (item.pr !== undefined && !POSITIVE.test(item.pr)) throw new SeatPaneNameError('Tab name: the PR must be a positive decimal integer.');
  if (isCouncilSeat(seat)) return 'council';
  if (isReviewSeat(seat)) return item.pr === undefined ? 'review' : `PR#${item.pr}`;
  if (isWorkerSeat(seat)) return item.issue === undefined ? 'other' : `#${item.issue}`;
  return 'orch';
}
