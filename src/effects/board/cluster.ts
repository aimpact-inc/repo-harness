import { bodyLinks } from '../../core/board/board';
import { clusterIssues, type BoardClusterV1, type ClusterIssue } from '../../core/board/cluster';
import { GITHUB_REPOSITORY } from '../../core/board/github-repository';
import { BOARD_PAGE, BoardSourceError, issueClaim, type BoardCommentPageV1, type BoardSubIssueReadV1 } from '../../core/board/source';
import { isRecord } from '../../core/evidence/is-record';
import { readGhJson, readParent, readPullRequests, type GhInput } from './collect';

const OPEN_ISSUE_PAGE_SIZE = 50;
const OPEN_ISSUE_PAGE_CAP = 10;

const OPEN_CLUSTER_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(states: OPEN, first: ${OPEN_ISSUE_PAGE_SIZE}, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title parent { number } subIssuesSummary { total }
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

interface ClusterSourceIssue {
  readonly number: number;
  readonly title: string;
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
    number: issue.number, title: issue.title, labels: issue.labels,
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
    number: issue, title: string(node.title, `${path}.title`), labels, blocked_by,
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

export function collectBoardCluster(input: GhInput & { readonly parent: number | null; readonly max_size?: number }): BoardClusterV1 {
  const { parent: parentNumber, max_size } = input;
  if (parentNumber === null) {
    const { issues, truncated } = collectOpen(input);
    return clusterIssues({ issues, max_size, scope: { mode: 'open', parent: null, truncated } });
  }
  const { parent } = readParent({ ...input, parent: parentNumber });
  const repository = parent.repository.name_with_owner;
  const [owner, name] = repository.split('/') as [string, string];
  const candidates = [...new Set(parent.sub_issues.flatMap(issue => issue.pull_request_candidates))];
  const linked = new Set<number>();
  for (const pr of readPullRequests(input, owner, name, candidates)) {
    if (pr.state === 'open') addLinkedIssues(linked, repository, pr.body);
  }
  const issues = parent.sub_issues.filter(issue => issue.state === 'open').map(issue => projectIssue(issue, linked));
  return clusterIssues({ issues, max_size, scope: { mode: 'parent', parent: parent.parent.number, truncated: false } });
}
