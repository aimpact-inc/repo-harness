import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { architecturePort, isArchitectureUnavailable, type ArchctxProviderOptions } from '../../core/architecture/contracts';
import { bodyLinks } from '../../core/board/board';
import {
  clusterIssues,
  extractIssueTargetPaths,
  type BoardClusterV1,
  type ClusterIssue,
  type ClusterPathOwner,
  type OwnershipStatus,
} from '../../core/board/cluster';
import { GITHUB_REPOSITORY } from '../../core/board/github-repository';
import {
  BOARD_PAGE,
  BOARD_SUB_ISSUE_PAGES,
  BoardSourceError,
  decodeParentRead,
  decodePullRequestsRead,
  issueClaim,
  parentCommentsPreviousCursor,
  parentReadNextCursor,
  type BoardCommentPageV1,
  type BoardParentReadV1,
  type BoardSubIssueReadV1,
} from '../../core/board/source';
import { normalizeCapabilityPath } from '../../core/capabilities/registry';
import { isRecord } from '../../core/evidence/is-record';
import { BoardCollectError, readGhJson, readPullRequests, type GhInput } from './collect';

const OPEN_ISSUE_PAGE_SIZE = 50;
const OPEN_ISSUE_PAGE_CAP = 10;

const COMMENT_NODES = 'nodes { url createdAt authorAssociation body }';
const COMMENTS = `comments(last: ${BOARD_PAGE.comments}) { pageInfo { hasPreviousPage } ${COMMENT_NODES} }`;
const ISSUE_FIELDS = `number title url state labels(first: ${BOARD_PAGE.labels}) { pageInfo { hasNextPage } nodes { name } } milestone { title }`;
const parentComments = (before: string) => `comments(last: ${BOARD_PAGE.parent_comments}${before}) { pageInfo { hasPreviousPage startCursor } ${COMMENT_NODES} }`;

const OPEN_CLUSTER_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(states: OPEN, first: ${OPEN_ISSUE_PAGE_SIZE}, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body parent { number } subIssuesSummary { total }
        labels(first: ${BOARD_PAGE.labels}) { pageInfo { hasNextPage } nodes { name } }
        blockedBy(first: ${BOARD_PAGE.blocked_by}) { pageInfo { hasNextPage } nodes { number state } }
        comments(last: ${BOARD_PAGE.comments}) { pageInfo { hasPreviousPage } nodes { url createdAt authorAssociation body } }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: ${BOARD_PAGE.timeline}) {
          pageInfo { hasPreviousPage }
          nodes { ... on CrossReferencedEvent { source {
            __typename
            ... on PullRequest { state body repository { nameWithOwner } }
          } } }
        }
      }
    }
  }
}`;

const CLUSTER_PARENT_QUERY = `query($owner: String!, $name: String!, $number: Int!, $repairs: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    databaseId nameWithOwner defaultBranchRef { name }
    issue(number: $number) {
      ${ISSUE_FIELDS} ${parentComments('')}
      subIssues(first: ${BOARD_PAGE.sub_issues}, after: $after) { pageInfo { hasNextPage endCursor } nodes {
        ${ISSUE_FIELDS} body ${COMMENTS}
        blockedBy(first: ${BOARD_PAGE.blocked_by}) { pageInfo { hasNextPage } nodes { number state } }
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: ${BOARD_PAGE.timeline}) { pageInfo { hasPreviousPage } nodes {
          ... on CrossReferencedEvent { source { ... on PullRequest { number repository { nameWithOwner } } } }
        } }
      } }
    }
  }
  repairs: search(query: $repairs, type: ISSUE, first: ${BOARD_PAGE.repairs}) { issueCount nodes { ... on Issue { number body } } }
}`;

const CLUSTER_PARENT_COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${parentComments(', before: $before')} } }
}`;

interface ClusterSourceIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly blocked_by: BoardSubIssueReadV1['blocked_by'];
  readonly comments: BoardCommentPageV1;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BoardSourceError(`${field} is not an object`);
  return value;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new BoardSourceError(`${field} is not a string`);
  return value;
}

function optionalBody(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  return string(value, field);
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new BoardSourceError(`${field} is not an issue number`);
  return value;
}

function connection(value: unknown, field: string, flag: 'hasNextPage' | 'hasPreviousPage'): {
  nodes: unknown[]; more: boolean; endCursor: unknown;
} {
  const list = record(value, field);
  const info = record(list.pageInfo, `${field}.pageInfo`);
  const more = info[flag];
  if (!Array.isArray(list.nodes) || typeof more !== 'boolean') throw new BoardSourceError(`${field} has invalid nodes or pageInfo`);
  return { nodes: list.nodes, more, endCursor: info.endCursor };
}

function completeNodes(value: unknown, field: string, flag: 'hasNextPage' | 'hasPreviousPage'): unknown[] {
  const { more, nodes } = connection(value, field, flag);
  if (more) throw new BoardSourceError(`${field} has more pages than one read returns`);
  return nodes;
}

function addLinkedIssues(linked: Set<number>, repository: string, body: string): void {
  const { closes, refs } = bodyLinks(repository, body);
  for (const issue of [...closes, ...refs]) linked.add(issue);
}

function projectIssue(issue: ClusterSourceIssue, linked: ReadonlySet<number>): ClusterIssue {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels,
    blocked_by: issue.blocked_by.filter(blocker => blocker.state === 'open').map(blocker => blocker.number),
    // An unread claim can still hold the issue. Dispatch also withholds it.
    in_flight: linked.has(issue.number) || issueClaim(issue.comments, issue.number).status !== 'none',
  };
}

function decodeOpenIssue(node: Record<string, unknown>, repository: string, linked: Set<number>): ClusterSourceIssue | null {
  const issue = number(node.number, 'issue.number');
  if (node.parent !== null) {
    number(record(node.parent, `#${issue}.parent`).number, `#${issue}.parent.number`);
    return null;
  }
  const path = `#${issue}`;
  const { total } = record(node.subIssuesSummary, `${path}.subIssuesSummary`);
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) throw new BoardSourceError(`${path}.subIssuesSummary.total is not a count`);
  if (total > 0) return null;

  const labels = completeNodes(node.labels, `${path}.labels`, 'hasNextPage')
    .map(label => string(record(label, `${path}.label`).name, `${path}.labels.name`));
  const blocked_by = completeNodes(node.blockedBy, `${path}.blockedBy`, 'hasNextPage').map(blocker => {
    const edge = record(blocker, `${path}.blocker`);
    const { state } = edge;
    if (state !== 'OPEN' && state !== 'CLOSED') throw new BoardSourceError(`${path}.blockedBy.state is not OPEN or CLOSED`);
    return { number: number(edge.number, `${path}.blockedBy.number`), state: state === 'OPEN' ? 'open' as const : 'closed' as const };
  });
  const comments = connection(node.comments, `${path}.comments`, 'hasPreviousPage');
  for (const event of completeNodes(node.timelineItems, `${path}.timelineItems`, 'hasPreviousPage')) {
    if (event === null) continue;
    const sourceValue = record(event, `${path}.timelineItems.node`).source;
    if (sourceValue == null) continue;
    const source = record(sourceValue, `${path}.timelineItems.source`);
    if (string(source.__typename, `${path}.timelineItems.source.__typename`) !== 'PullRequest') continue;
    if (source.state === 'CLOSED' || source.state === 'MERGED') continue;
    if (source.state !== 'OPEN') throw new BoardSourceError(`${path}.timelineItems.source has an invalid pull request state`);
    const prRepository = string(record(source.repository, `${path}.pullRequest.repository`).nameWithOwner, `${path}.pullRequest.repository.nameWithOwner`);
    if (prRepository.toLowerCase() === repository.toLowerCase()) addLinkedIssues(linked, repository, string(source.body, `${path}.pullRequest.body`));
  }
  return {
    number: issue,
    title: string(node.title, `${path}.title`),
    body: optionalBody(node.body, `${path}.body`),
    labels,
    blocked_by,
    comments: { truncated: comments.more, comments: comments.nodes.map(value => {
      const comment = record(value, `${path}.comment`);
      return {
        url: string(comment.url, `${path}.comments.url`),
        created_at: string(comment.createdAt, `${path}.comments.createdAt`),
        author_association: string(comment.authorAssociation, `${path}.comments.authorAssociation`),
        body: string(comment.body, `${path}.comments.body`),
      };
    }) },
  };
}

function collectOpen(input: GhInput): { issues: ClusterIssue[]; truncated: boolean } {
  const issues: ClusterSourceIssue[] = [];
  const linked = new Set<number>();
  const cursors = new Set<string>();
  let after: string | null = null;
  let repository: string | null = null;
  for (let page = 0; page < OPEN_ISSUE_PAGE_CAP; page++) {
    const response = record(readGhJson(input, ['api', 'graphql', '--hostname', 'github.com',
      '-f', `query=${OPEN_CLUSTER_QUERY}`, '-F', 'owner={owner}', '-F', 'name={repo}',
      ...(after === null ? [] : ['-f', `after=${after}`])]), 'GraphQL response');
    if (response.errors !== undefined) throw new BoardSourceError('GitHub GraphQL returned errors for the open issue read');
    const repo = record(record(response.data, 'data').repository, 'repository');
    const current = string(repo.nameWithOwner, 'repository.nameWithOwner');
    if (!GITHUB_REPOSITORY.test(current) || (repository !== null && repository !== current)) throw new BoardSourceError('the open issue read changed repository identity or returned an invalid name');
    repository = current;
    const { nodes, more, endCursor } = connection(repo.issues, 'repository.issues', 'hasNextPage');
    for (const node of nodes) {
      const issue = decodeOpenIssue(record(node, 'repository.issues.node'), repository, linked);
      if (issue !== null) issues.push(issue);
    }
    if (!more) return { issues: issues.map(issue => projectIssue(issue, linked)), truncated: false };
    after = string(endCursor, 'repository.issues.pageInfo.endCursor');
    if (after === '' || cursors.has(after)) throw new BoardSourceError('the open issue cursor is empty or repeats');
    cursors.add(after);
  }
  return { issues: issues.map(issue => projectIssue(issue, linked)), truncated: true };
}

function graphqlData(input: GhInput, query: string, variables: Readonly<Record<string, string | number>>): unknown {
  const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`,
    ...Object.entries(variables).flatMap(([key, value]) => [typeof value === 'number' ? '-F' : '-f', `${key}=${value}`])];
  const response = record(readGhJson(input, args), 'GraphQL response');
  if (response.errors !== undefined) throw new BoardSourceError(`GitHub GraphQL refused the board read: ${JSON.stringify(response.errors).slice(0, 500)}`);
  return response.data;
}

function readClusterParent(input: GhInput & { readonly parent: number }): {
  readonly parent: BoardParentReadV1;
  readonly bodies: ReadonlyMap<number, string>;
} {
  const repository = (readGhJson(input, ['repo', 'view', '--json', 'nameWithOwner']) as { nameWithOwner?: unknown } | null)?.nameWithOwner;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new BoardCollectError('the local GitHub repository is unknown');
  }
  const [owner, name] = repository.split('/') as [string, string];
  const variables = { owner, name, number: input.parent, repairs: `repo:${repository} is:issue is:open in:title "CI repair"` };
  const first = graphqlData(input, CLUSTER_PARENT_QUERY, variables);
  const pages = [first];
  const subCursors = new Set<string>();
  for (let next = parentReadNextCursor(first, 0); next !== null; next = parentReadNextCursor(pages.at(-1), pages.length - 1)) {
    if (subCursors.has(next)) throw new BoardSourceError(`issue.subIssues cursor ${next} repeats`);
    if (pages.length === BOARD_SUB_ISSUE_PAGES) throw new BoardSourceError(`issue.subIssues has more than ${BOARD_SUB_ISSUE_PAGES} pages of ${BOARD_PAGE.sub_issues}`);
    subCursors.add(next);
    pages.push(graphqlData(input, CLUSTER_PARENT_QUERY, { ...variables, after: next }));
  }
  const commentPages = [first];
  const commentCursors = new Set<string>();
  for (let next = parentCommentsPreviousCursor(first, 0); next !== null; next = parentCommentsPreviousCursor(commentPages.at(-1), commentPages.length - 1)) {
    if (commentCursors.has(next)) throw new BoardSourceError(`issue.comments cursor ${next} repeats`);
    commentCursors.add(next);
    commentPages.push(graphqlData(input, CLUSTER_PARENT_COMMENTS_QUERY, { owner, name, number: input.parent, before: next }));
  }
  const parent = decodeParentRead(pages, commentPages, repository);
  const bodies = new Map<number, string>();
  for (const page of pages) {
    const repo = record(record(page, 'page').repository, 'page.repository');
    const issueNode = record(repo.issue, 'page.issue');
    const subIssues = record(issueNode.subIssues, 'page.issue.subIssues');
    if (!Array.isArray(subIssues.nodes)) continue;
    for (const rawNode of subIssues.nodes) {
      const node = record(rawNode, 'subIssue');
      const issueNumber = number(node.number, 'subIssue.number');
      bodies.set(issueNumber, optionalBody(node.body, `#${issueNumber}.body`));
    }
  }
  return { parent, bodies };
}

function collectParentIssues(input: GhInput & { readonly parent: number }): ClusterIssue[] {
  const { parent, bodies } = readClusterParent(input);
  const repository = parent.repository.name_with_owner;
  const [owner, name] = repository.split('/') as [string, string];
  const candidates = [...new Set(parent.sub_issues.flatMap(issue => issue.pull_request_candidates))];
  const linked = new Set<number>();
  for (const pr of readPullRequests(input, owner, name, candidates)) {
    if (pr.state === 'open') addLinkedIssues(linked, repository, pr.body);
  }
  return parent.sub_issues
    .filter(issue => issue.state === 'open')
    .map(issue => projectIssue({ ...issue, body: bodies.get(issue.number) ?? '' }, linked));
}

function resolveClusterPathOwners(
  repoRoot: string,
  issues: readonly ClusterIssue[],
  archctx?: ArchctxProviderOptions,
): { readonly ownership_status: OwnershipStatus; readonly path_owners: ClusterPathOwner[] } {
  const candidates = [...new Set(issues.flatMap(issue => extractIssueTargetPaths(issue.body ?? '')))].sort();
  const existing = candidates.filter(path => existsSync(join(repoRoot, path)));
  if (existing.length === 0) {
    const display = architecturePort('display');
    return isArchitectureUnavailable(display)
      ? { ownership_status: 'unavailable', path_owners: [] }
      : { ownership_status: 'observed', path_owners: [] };
  }
  const display = architecturePort('display');
  if (isArchitectureUnavailable(display)) return { ownership_status: 'unavailable', path_owners: [] };
  let read;
  try {
    read = display.pathOwners(repoRoot, existing, archctx);
  } catch {
    return { ownership_status: 'unavailable', path_owners: [] };
  }
  if (read.status === 'failed') return { ownership_status: 'unavailable', path_owners: [] };
  const { resolution } = read;
  const fault = resolution.diagnostics.find(diagnostic => diagnostic.code !== 'AMBIGUOUS_MATCH');
  if (fault !== undefined) return { ownership_status: 'unavailable', path_owners: [] };
  const owners = new Map<string, ClusterPathOwner>();
  for (const match of resolution.matches) owners.set(match.filePath, { path: match.filePath, status: 'owned', capability: match.prefix });
  for (const path of resolution.unmappedPaths) owners.set(path, { path, status: 'unowned' });
  for (const diagnostic of resolution.diagnostics) owners.set(diagnostic.path, { path: diagnostic.path, status: 'ambiguous' });
  const resolvedOwners = existing.flatMap(path => {
    const entry = owners.get(normalizeCapabilityPath(path, repoRoot));
    return entry === undefined ? [] : [{ ...entry, path }];
  });
  return { ownership_status: 'observed', path_owners: resolvedOwners };
}

export function collectBoardCluster(input: GhInput & {
  readonly parent: number | null;
  readonly max_size?: number;
  readonly include_loose?: boolean;
  readonly archctx?: ArchctxProviderOptions;
}): BoardClusterV1 {
  const { parent: parentNumber, max_size, include_loose = false, archctx } = input;
  if (parentNumber === null && include_loose) {
    throw new BoardCollectError('--include-loose requires --parent <issue number>');
  }
  if (parentNumber === null) {
    const { issues, truncated } = collectOpen(input);
    const { ownership_status, path_owners } = resolveClusterPathOwners(input.repo_root, issues, archctx);
    return clusterIssues({ issues, max_size, scope: { mode: 'open', parent: null, truncated }, ownership_status, path_owners });
  }
  const parentIssues = collectParentIssues({ ...input, parent: parentNumber });
  let issues = parentIssues;
  let truncated = false;
  if (include_loose) {
    const open = collectOpen(input);
    truncated = open.truncated;
    const seen = new Set(parentIssues.map(issue => issue.number));
    issues = [...parentIssues, ...open.issues.filter(issue => !seen.has(issue.number))];
  }
  const { ownership_status, path_owners } = resolveClusterPathOwners(input.repo_root, issues, archctx);
  return clusterIssues({
    issues,
    max_size,
    scope: { mode: 'parent', parent: parentNumber, ...(include_loose ? { include_loose: true } : {}), truncated },
    ownership_status,
    path_owners,
  });
}
