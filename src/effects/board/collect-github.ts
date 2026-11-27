import { bodyLinks, type BoardDailyRunInputV1, type BoardRequiredContextsV1 } from '../../core/board/board';
import { blockerKey, reachableOpenBlockers, readParkedItem, type BoardExternalBlockerV1 } from '../../core/board/merge';
import { BOARD_PAGE, BoardSourceError, decodeExternalBlocker, type BoardCommentPageV1, type BoardParentReadV1, type BoardPullRequestReadV1 } from '../../core/board/source';

const COMMENT_NODES = 'nodes { url createdAt authorAssociation body }';
export const COMMENTS = `comments(last: ${BOARD_PAGE.comments}) { pageInfo { hasPreviousPage } ${COMMENT_NODES} }`;
export const BLOCKED_BY = `blockedBy(first: ${BOARD_PAGE.blocked_by}) { pageInfo { hasNextPage } nodes { number state repository { nameWithOwner } } }`;
export const ISSUE_FIELDS = `number title url state labels(first: ${BOARD_PAGE.labels}) { pageInfo { hasNextPage } nodes { name } } milestone { title }`;
/** The parent thread holds the plan, the coordinator claim and the merge holds, so the read follows its comment cursor to the oldest page. */
export const parentComments = (before: string) => `comments(last: ${BOARD_PAGE.parent_comments}${before}) { pageInfo { hasPreviousPage startCursor } ${COMMENT_NODES} }`;

const EXTERNAL_BLOCKER_QUERY = `query ExternalBlocker($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    number state repository { nameWithOwner } ${BLOCKED_BY} ${COMMENTS}
  } }
}`;

/** The identity, review and head-rollup fields are the readiness inputs of the keyed source store; nested thread comments stay out. */
export const PULL_REQUEST_FIELDS = `number url state isDraft body baseRefName baseRefOid headRefName headRefOid mergedAt
  changedFiles mergeable reviewDecision isCrossRepository
  latestOpinionatedReviews(first: ${BOARD_PAGE.reviews}) { pageInfo { hasNextPage } nodes { state } }
  reviewThreads(first: ${BOARD_PAGE.threads}) { totalCount pageInfo { hasNextPage } nodes { isResolved } }
  files(first: ${BOARD_PAGE.files}) { totalCount nodes { path additions deletions } }
  commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup {
    contexts(first: ${BOARD_PAGE.checks}) { pageInfo { hasNextPage } nodes {
      ... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { event workflow { name } } } }
      ... on StatusContext { context state targetUrl createdAt }
    } }
  } } } }
  ${COMMENTS}`;

/** `first` and each page that a cursor of the page before it selects, up to `cap` pages. */
export function followCursor(first: unknown, cursor: (data: unknown, at: number) => string | null, read: (cursor: string) => unknown,
  connection: string, size: number, cap: number): unknown[] {
  const pages = [first];
  // The decoder runs after the last page, so a repeated cursor or an endless stream must stop the loop here.
  const cursors = new Set<string>();
  for (let next = cursor(first, 0); next !== null; next = cursor(pages.at(-1), pages.length - 1)) {
    if (cursors.has(next)) throw new BoardSourceError(`${connection} cursor ${next} repeats`);
    if (pages.length === cap) throw new BoardSourceError(`${connection} has more than ${cap} pages of ${size}`);
    cursors.add(next);
    pages.push(read(next));
  }
  return pages;
}

export function decodeDailyRun(body: unknown, branch: string): BoardDailyRunInputV1 {
  const runs = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) return { status: 'unavailable', reason: 'github_unavailable' };
  const run = runs[0] as Record<string, unknown> | undefined;
  if (run === undefined) return { status: 'unavailable', reason: 'no_daily_run' };
  // The response must be the run the query asked for (same rule as the operator tests collector).
  if (run.event !== 'schedule' || run.head_branch !== branch || run.path !== '.github/workflows/ci.yml' || run.status !== 'completed'
    || typeof run.html_url !== 'string' || typeof run.created_at !== 'string' || (run.conclusion !== null && typeof run.conclusion !== 'string')) {
    return { status: 'unavailable', reason: 'daily_run_invalid' };
  }
  return { status: 'observed', run_url: run.html_url, conclusion: run.conclusion as string | null, created_at: run.created_at };
}

export function decodeRequiredContexts(body: unknown, base: string): BoardRequiredContextsV1 {
  const contexts = (body as { required_status_checks?: { contexts?: unknown } | null } | null)?.required_status_checks?.contexts;
  if (!Array.isArray(contexts) || contexts.length === 0 || !contexts.every(context => typeof context === 'string' && context !== '')) {
    return { status: 'unavailable', reason: `the protection of ${base} requires no status check context list` };
  }
  return { status: 'observed', contexts: Object.freeze([...contexts as string[]]) };
}

/** Resolve the live graph from the issues of open PRs. An external vertex is read once per board. */
export function readExternalBlockers(
  parent: BoardParentReadV1,
  prs: readonly BoardPullRequestReadV1[],
  graphql: (query: string, variables: Readonly<Record<string, string | number>>) => unknown,
  readIssueComments: (repository: string, number: number) => BoardCommentPageV1,
): readonly BoardExternalBlockerV1[] {
  const repository = parent.repository.name_with_owner;
  const items = new Map(parent.sub_issues.map(item => [item.number, item] as const));
  const seeds = prs.flatMap(pr => {
    const { closes, refs } = bodyLinks(repository, pr.body);
    const linked = [...closes, ...refs].filter(number => items.has(number));
    const open = linked.filter(number => items.get(number)?.state === 'open');
    return open.length > 0 ? open : linked;
  });
  const external = new Map<string, BoardExternalBlockerV1>();
  reachableOpenBlockers(repository, [...new Set(seeds)], ref => {
    const local = ref.repository.toLowerCase() === repository.toLowerCase() ? items.get(ref.number) : undefined;
    if (local !== undefined) return local;
    const key = blockerKey(ref);
    const known = external.get(key);
    if (known !== undefined) return known;
    const [owner, name] = ref.repository.split('/') as [string, string];
    const read = decodeExternalBlocker(graphql(EXTERNAL_BLOCKER_QUERY, { owner, name, number: ref.number }), ref.repository, ref.number);
    const comments = read.state === 'open' && read.comments.truncated ? readIssueComments(ref.repository, ref.number) : read.comments;
    const blocker = { ...ref, state: read.state, blocked_by: read.blocked_by,
      parked: read.state === 'open' && readParkedItem('issue', ref.number, comments) !== null };
    external.set(key, blocker);
    return blocker;
  });
  return [...external.values()];
}
