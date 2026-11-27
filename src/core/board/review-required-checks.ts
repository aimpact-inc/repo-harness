import type { BoardPullRequestReadV1, BoardRollupContextV1 } from './source';

type RequiredContextStatus = 'success' | 'failure' | 'pending' | 'missing';

/** A check run that has not started is the oldest of its group, as in `gh pr checks`. */
const reportTime = (report: BoardRollupContextV1): string => (report.type === 'StatusContext' ? report.completed_at : report.started_at) ?? '';

/**
 * The head reports of one required name that `gh pr checks` keeps (cli/cli `pkg/cmd/pr/checks/aggregate.go`, `eliminateDuplicates`):
 * the newest commit status of the context by creation, and the newest check run of each workflow name and event by start. A check
 * run and a commit status of one name both stay.
 */
export function contextReports(read: BoardPullRequestReadV1, name: string): BoardRollupContextV1[] {
  const kept = new Map<string, BoardRollupContextV1>();
  for (const report of read.readiness_inputs.rollup.filter(context => context.name === name)) {
    const key = report.type === 'StatusContext' ? 'status' : JSON.stringify(['run', report.workflow?.name ?? '', report.workflow?.event ?? '']);
    const current = kept.get(key);
    if (current === undefined || reportTime(report) > reportTime(current)) kept.set(key, report);
  }
  return [...kept.values()];
}

/** The commit status states as the `gh pr checks` bucket that publication readiness reads: pass, pending or fail. */
const STATUS_STATES: ReadonlyMap<string, RequiredContextStatus> = new Map([['SUCCESS', 'success'], ['PENDING', 'pending'], ['EXPECTED', 'pending'], ['FAILURE', 'failure'], ['ERROR', 'failure']]);

export function reportStatus(report: BoardRollupContextV1): RequiredContextStatus {
  // GitHub defines no other state; one would fail closed.
  if (report.type === 'StatusContext') return STATUS_STATES.get(report.status) ?? 'failure';
  if (report.status !== 'COMPLETED' || report.completed_at === null) return 'pending';
  return report.conclusion === 'SUCCESS' ? 'success' : 'failure';
}

/** The join of the reports of a name, and of the names of a required check: `missing` (or no status), then `pending`, then `failure`, else `success`. */
export function joinStatuses(statuses: readonly RequiredContextStatus[]): RequiredContextStatus {
  if (statuses.length === 0) return 'missing';
  return (['missing', 'pending', 'failure'] as const).find(status => statuses.includes(status)) ?? 'success';
}
