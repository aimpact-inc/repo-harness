import { isRecord } from '../evidence/is-record';
import { GITHUB_REPOSITORY } from './github-repository';
import { BoardSourceError, type BoardCommentPageV1 } from './protocol-comments';
import type { BoardIssueDependencyV1, BoardIssueReadV1 } from './source';

export type Json = Record<string, unknown>;

export function fail(message: string): never {
  throw new BoardSourceError(message);
}

export function obj(value: unknown, label: string): Json {
  if (!isRecord(value)) fail(`${label} is not an object`);
  return value;
}

export function str(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} is not a string`);
  return value;
}

export function nullableStr(value: unknown, label: string): string | null {
  return value === null ? null : str(value, label);
}

export function int(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} is not a positive integer`);
  return value as number;
}

export function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${label} is not a count`);
  return value as number;
}

export function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) fail(`${label} is not a commit SHA`);
  return value;
}

export function time(value: unknown, label: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${label} is not a time`);
  return value;
}

export function nodes(connection: unknown, label: string, more: 'hasNextPage' | 'hasPreviousPage' | null): unknown[] {
  const value = obj(connection, label);
  if (more !== null && obj(value.pageInfo, `${label}.pageInfo`)[more] !== false) fail(`${label} has more pages than one read returns`);
  if (!Array.isArray(value.nodes)) fail(`${label}.nodes is not an array`);
  return value.nodes;
}

export function complete(connection: unknown, label: string): unknown[] | null {
  const value = obj(connection, label);
  const more = obj(value.pageInfo, `${label}.pageInfo`).hasNextPage;
  if (typeof more !== 'boolean') fail(`${label}.pageInfo.hasNextPage is not a boolean`);
  return more ? null : nodes(value, label, null);
}

export function issueState(value: unknown, label: string): 'open' | 'closed' {
  if (value === 'OPEN') return 'open';
  if (value === 'CLOSED') return 'closed';
  return fail(`${label} is not OPEN or CLOSED`);
}

export function comments(connection: unknown, label: string): BoardCommentPageV1 {
  const value = obj(connection, label);
  const truncated = obj(value.pageInfo, `${label}.pageInfo`).hasPreviousPage;
  if (typeof truncated !== 'boolean') fail(`${label}.pageInfo.hasPreviousPage is not a boolean`);
  return Object.freeze({
    truncated,
    comments: Object.freeze(nodes(value, label, null).map((entry, index) => {
      const comment = obj(entry, `${label}[${index}]`);
      return Object.freeze({
        url: str(comment.url, `${label}[${index}].url`),
        created_at: time(comment.createdAt, `${label}[${index}].createdAt`),
        author_association: str(comment.authorAssociation, `${label}[${index}].authorAssociation`),
        body: str(comment.body, `${label}[${index}].body`),
      });
    })),
  });
}

export function issue(value: unknown, label: string): BoardIssueReadV1 {
  const node = obj(value, label);
  const milestone = node.milestone === null ? null : str(obj(node.milestone, `${label}.milestone`).title, `${label}.milestone.title`);
  return {
    number: int(node.number, `${label}.number`),
    title: str(node.title, `${label}.title`),
    url: str(node.url, `${label}.url`),
    state: issueState(node.state, `${label}.state`),
    labels: Object.freeze(nodes(node.labels, `${label}.labels`, 'hasNextPage')
      .map((entry, index) => str(obj(entry, `${label}.labels[${index}]`).name, `${label}.labels[${index}].name`))),
    milestone,
    comments: comments(node.comments, `${label}.comments`),
  };
}

export function repositoryName(value: unknown, label: string): string {
  const name = str(obj(value, label).nameWithOwner, `${label}.nameWithOwner`);
  if (!GITHUB_REPOSITORY.test(name)) fail(`${label}.nameWithOwner is not owner/name`);
  return name;
}

export function blockedBy(connection: unknown, label: string, repository: string): readonly BoardIssueDependencyV1[] {
  return Object.freeze(nodes(connection, label, 'hasNextPage').map((edge, at) => {
    const blocker = obj(edge, `${label}[${at}]`);
    const target = blocker.repository === undefined ? repository : repositoryName(blocker.repository, `${label}[${at}].repository`);
    return Object.freeze({
      number: int(blocker.number, `${label} number`), state: issueState(blocker.state, `${label} state`),
      ...(target.toLowerCase() === repository.toLowerCase() ? {} : { repository: target }),
    });
  }));
}
