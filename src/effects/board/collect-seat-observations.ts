import { ADVISOR_SEAT } from '../../core/board/advisor-seat';
import { isA22TaskSeat, STALLED_WORKING_MS } from '../../core/board/attention';
import { seatTerminal, type BoardExecutionV1, type BoardHostPortsV1, type BoardSeatLivenessV1, type BoardSeatTerminalInputV1, type BoardSeatTerminalReadV1, type BoardToolingV1 } from '../../core/board/board';
import { HC_MIN_VERSION } from '../../core/terminal/herdr-pin';
import { gitSpawnSync, withoutRepositorySelectingGitEnv } from '../git/runner';

const SEAT_GIT_TIMEOUT_MS = 10_000;

export function tooling(host: BoardHostPortsV1): BoardToolingV1 {
  const herdrApp = { status: 'not_pinned' } as const;
  const version = host.hcVersion();
  return { hc: version.status === 'unavailable' ? version : { status: 'observed', version: version.version, min_version: HC_MIN_VERSION }, herdr_app: herdrApp };
}

/** One orchestrator and one advisor serve the whole repository (#1780): the board of every parent shows them. */
const REPOSITORY_SEATS: ReadonlySet<string> = new Set(['orchestrator', ADVISOR_SEAT]);

export function seatBranch(cwd: string | null): string | null {
  if (cwd === null) return null;
  // The directory selects the repository, so a git variable of this process must not.
  const read = gitSpawnSync(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd, env: withoutRepositorySelectingGitEnv(), encoding: 'utf8', timeout: SEAT_GIT_TIMEOUT_MS });
  return read.error === undefined && read.status === 0 ? read.stdout.trim() : null;
}

/**
 * The seat terminals of this repository and parent: the orchestrator and the
 * advisor by their seat label with any parent label or none; a terminal with
 * an issue or pr label when that issue is an item of this board or that pull
 * request is a pull request of this board, because the sub-issue list owns
 * "this seat belongs to this parent" and a seat can start with no parent
 * label; and a terminal with neither label by this parent label. No such
 * terminal means the seat labels are not written, which the board does not
 * read as "no stuck seats".
 */
export function execution(
  host: BoardHostPortsV1,
  parent: string,
  repositoryId: number,
  items: ReadonlySet<string>,
  pullRequests: ReadonlySet<string>,
  observedAt: string,
  seatTerminalsWithBranches: (terminals: readonly BoardSeatTerminalReadV1[]) => readonly BoardSeatTerminalInputV1[],
  seatScreenHash: (text: string) => string,
): { readonly execution: BoardExecutionV1; readonly seat_liveness: BoardSeatLivenessV1 } {
  const read = host.seatTerminals(String(repositoryId));
  if (read.status === 'unavailable') return { execution: read, seat_liveness: read };
  const ofBoard = ({ seat, issue, pr, parent: label }: BoardSeatTerminalReadV1['labels']): boolean => {
    if (seat !== undefined && REPOSITORY_SEATS.has(seat)) return true;
    if (issue === undefined && pr === undefined) return label === parent;
    return (issue !== undefined && items.has(issue)) || (pr !== undefined && pullRequests.has(pr));
  };
  const terminals = read.terminals.filter(({ labels }) => ofBoard(labels));
  if (terminals.length === 0) {
    const none = { status: 'unavailable', reason: 'no_seat_terminals' } as const;
    return { execution: none, seat_liveness: none };
  }
  return {
    execution: { status: 'observed', terminals: Object.freeze(seatTerminalsWithBranches(terminals).map(seatTerminal)) },
    seat_liveness: seatLiveness(host, terminals, Date.parse(observedAt), seatScreenHash),
  };
}

/** The screen lines that a liveness probe reads. */
const SEAT_SCREEN_LINES = 40;
/** Probe working seats past the bound and task seats with no reported status. Read the process table once. */
function seatLiveness(host: BoardHostPortsV1, terminals: readonly BoardSeatTerminalReadV1[], now: number, seatScreenHash: (text: string) => string): BoardSeatLivenessV1 {
  const candidates = terminals.filter(({ state, status, status_ms, labels }) => {
    if (state !== 'live' || labels.seat === undefined) return false;
    if (status === null) return isA22TaskSeat(labels.seat);
    return status === 'working' && status_ms !== null && now - status_ms > STALLED_WORKING_MS;
  });
  if (candidates.length === 0) return { status: 'observed', probes: [] };
  const table = host.childProcessCounts();
  if (table.status === 'unavailable') return table;
  return {
    status: 'observed',
    probes: Object.freeze(candidates.flatMap((terminal) => {
      if (terminal.agent_pid === null) return [];
      const screen = host.seatRead(terminal.address, SEAT_SCREEN_LINES);
      const usable = screen.status === 'observed' && screen.text.trim() !== '';
      return [Object.freeze({ address: terminal.address, status_ms: terminal.status === null ? null : terminal.status_ms, turn: terminal.turn,
        children: table.counts.get(terminal.agent_pid) ?? 0, screen_hash: usable ? seatScreenHash(screen.text) : null })];
    })),
  };
}
