import type { BoardPullRequestReadV1, BoardReadinessInputsV1, BoardRollupContextV1 } from './source';
import { complete, fail, nodes, nullableStr, obj, str, time, type Json } from './source-primitives';

export function pullRequestState(value: unknown, label: string): BoardPullRequestReadV1['state'] {
  if (value === 'OPEN') return 'open';
  if (value === 'CLOSED') return 'closed';
  if (value === 'MERGED') return 'merged';
  return fail(`${label} is not OPEN, CLOSED or MERGED`);
}

function workflowOf(value: unknown, label: string): BoardRollupContextV1['workflow'] {
  if (value === null) return null;
  const run = obj(value, label);
  return Object.freeze({ name: str(obj(run.workflow, `${label}.workflow`).name, `${label}.workflow.name`), event: str(run.event, `${label}.event`) });
}

export function rollupContexts(rollup: Json, label: string): BoardRollupContextV1[] {
  return nodes(rollup.contexts, `${label}.contexts`, 'hasNextPage').map((entry, index) => {
    const context = obj(entry, `${label}.contexts[${index}]`);
    const at = `${label}.contexts[${index}]`;
    if (context.name !== undefined) {
      return Object.freeze({
        type: 'CheckRun', name: str(context.name, `${at}.name`), status: str(context.status, `${at}.status`),
        conclusion: nullableStr(context.conclusion, `${at}.conclusion`),
        completed_at: context.completedAt === null ? null : time(context.completedAt, `${at}.completedAt`),
        details_url: nullableStr(context.detailsUrl, `${at}.detailsUrl`),
        started_at: context.startedAt === null ? null : time(context.startedAt, `${at}.startedAt`),
        workflow: workflowOf(obj(context.checkSuite, `${at}.checkSuite`).workflowRun, `${at}.checkSuite.workflowRun`),
      } as const);
    }
    if (context.context !== undefined) {
      return Object.freeze({
        type: 'StatusContext', name: str(context.context, `${at}.context`), status: str(context.state, `${at}.state`), conclusion: null,
        completed_at: time(context.createdAt, `${at}.createdAt`), details_url: nullableStr(context.targetUrl, `${at}.targetUrl`),
        started_at: null, workflow: null,
      } as const);
    }
    return fail(`${at} is neither a check run nor a commit status`);
  });
}

export function readinessInputs(node: Json, rollup: readonly BoardRollupContextV1[], label: string): BoardReadinessInputsV1 {
  if (!Number.isSafeInteger(node.changedFiles) || (node.changedFiles as number) < 0) fail(`${label}.changedFiles is not a count`);
  if (typeof node.isCrossRepository !== 'boolean') fail(`${label}.isCrossRepository is not a boolean`);
  const reviews = complete(node.latestOpinionatedReviews, `${label}.latestOpinionatedReviews`);
  const threads = obj(node.reviewThreads, `${label}.reviewThreads`);
  const threadNodes = complete(threads, `${label}.reviewThreads`);
  if (!Number.isSafeInteger(threads.totalCount) || (threads.totalCount as number) < 0) fail(`${label}.reviewThreads.totalCount is not a count`);
  return Object.freeze({
    changed_files: node.changedFiles as number,
    mergeable: str(node.mergeable, `${label}.mergeable`),
    review_decision: nullableStr(node.reviewDecision, `${label}.reviewDecision`),
    cross_repository: node.isCrossRepository,
    review_states: reviews === null ? null : Object.freeze(reviews.map((entry, index) => str(obj(entry, `${label}.latestOpinionatedReviews[${index}]`).state, `${label}.latestOpinionatedReviews[${index}].state`))),
    threads: threadNodes === null ? null : Object.freeze({
      total: threads.totalCount as number,
      resolved: Object.freeze(threadNodes.map((entry, index) => {
        const resolved = obj(entry, `${label}.reviewThreads[${index}]`).isResolved;
        if (typeof resolved !== 'boolean') fail(`${label}.reviewThreads[${index}].isResolved is not a boolean`);
        return resolved;
      })),
    }),
    rollup: Object.freeze([...rollup]),
  });
}
