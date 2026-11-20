import { readFileSync } from 'node:fs';
import { checkPlanSupersedes, checkPostBody } from '../../core/board/post';
import { withSeatLine } from '../../core/board/seat-line';
import type { BoardCommentPageV1 } from '../../core/board/source';
import {
  planTriageApply,
  TriageApplyValidationError,
  type TriageApplyPlanV1,
  type TriageOperation,
} from '../../core/board/triage-apply';
import { isRecord } from '../../core/evidence/is-record';
import { BoardCollectError, readGhJson, runGhText, type GhInput } from './collect';
import { gitHubPostPorts, type BoardPostPorts } from './post';

const ADD_SUB_ISSUE_MUTATION = `mutation($parent: ID!, $child: ID!) {
  addSubIssue(input: { issueId: $parent, subIssueId: $child, replaceParent: true }) {
    issue { number }
    subIssue { number }
  }
}`;

export interface TriageApplyResultV1 {
  readonly dry_run: boolean;
  readonly operations: readonly TriageOperation[];
  readonly rendered_plan: string;
  readonly plan_comment_url: string | null;
}

export interface TriageApplyPorts {
  readonly comments: (target: number) => BoardCommentPageV1;
  readonly read_issue_node_ids: (repository: string, numbers: readonly number[]) => ReadonlyMap<number, string>;
  readonly add_labels: (repository: string, issue: number, labels: readonly string[]) => void;
  readonly add_sub_issue: (parentId: string, childId: string) => void;
  readonly close_duplicate: (repository: string, issue: number, comment: string) => void;
  readonly post_plan: (parent: number, body: string) => string;
}

export function readTriageManifestFile(manifestPath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new TriageApplyValidationError(`manifest file ${manifestPath} cannot be read`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new TriageApplyValidationError(`manifest file ${manifestPath} is not valid JSON`);
  }
}

function resolveIssueNodeIds(
  input: GhInput,
  repository: string,
  numbers: readonly number[],
): ReadonlyMap<number, string> {
  const unique = [...new Set(numbers)].sort((left, right) => left - right);
  if (unique.length === 0) return new Map();
  const [owner, name] = repository.split('/') as [string, string];
  const fields = unique.map(num => `i${num}: issue(number: ${num}) { id number }`).join('\n    ');
  const query = `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`;
  const response = readGhJson(input, [
    'api', 'graphql', '--hostname', 'github.com',
    '-f', `query=${query}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
  ]);
  if (!isRecord(response) || response.errors !== undefined || !isRecord(response.data) || !isRecord(response.data.repository)) {
    throw new BoardCollectError(`GitHub GraphQL failed to resolve issue node IDs in ${repository}`);
  }
  const repo = response.data.repository;
  const ids = new Map<number, string>();
  for (const num of unique) {
    const node = repo[`i${num}`];
    if (!isRecord(node) || node.number !== num || typeof node.id !== 'string' || node.id === '') {
      throw new BoardCollectError(`issue #${num} did not resolve to an issue in ${repository}`);
    }
    ids.set(num, node.id);
  }
  return ids;
}

export function gitHubTriageApplyPorts(
  repoRoot: string,
  postPorts: (repoRoot: string) => BoardPostPorts = gitHubPostPorts,
  ghInput: GhInput = { repo_root: repoRoot },
): TriageApplyPorts {
  const posts = postPorts(repoRoot);
  return {
    comments: target => posts.comments(target),
    read_issue_node_ids: (repository, numbers) => resolveIssueNodeIds(ghInput, repository, numbers),
    add_labels: (repository, issue, labels) => {
      if (labels.length === 0) return;
      runGhText({ repo_root: repoRoot }, [
        'issue', 'edit', String(issue), '--repo', repository,
        ...labels.flatMap(label => ['--add-label', label]),
      ]);
    },
    add_sub_issue: (parentId, childId) => {
      const response = readGhJson(ghInput, [
        'api', 'graphql', '--hostname', 'github.com',
        '-f', `query=${ADD_SUB_ISSUE_MUTATION}`,
        '-f', `parent=${parentId}`,
        '-f', `child=${childId}`,
      ]);
      if (!isRecord(response) || response.errors !== undefined) {
        throw new BoardCollectError(`GitHub GraphQL addSubIssue failed: ${JSON.stringify((response as { errors?: unknown } | null)?.errors ?? response).slice(0, 300)}`);
      }
    },
    close_duplicate: (repository, issue, comment) => {
      runGhText({ repo_root: repoRoot }, [
        'issue', 'close', String(issue), '--repo', repository,
        '--reason', 'not planned',
        '--comment', comment,
      ]);
    },
    post_plan: (parent, body) => posts.comment(parent, body),
  };
}

export function runTriageApply(input: {
  readonly repo_root: string;
  readonly manifest: unknown;
  readonly dry_run: boolean;
  readonly ports?: TriageApplyPorts;
  readonly env?: NodeJS.ProcessEnv;
}): TriageApplyResultV1 {
  const plan = planTriageApply(input.manifest);
  const rendered = withSeatLine(plan.rendered_plan, input.env ?? process.env);
  checkPostBody({ kind: 'plan', fields: plan.post_fields }, rendered);
  const operations = plan.operations.map((op): TriageOperation =>
    op.kind === 'post_plan' ? { ...op, body: rendered } : op);

  if (input.dry_run) {
    return {
      dry_run: true,
      operations,
      rendered_plan: rendered,
      plan_comment_url: null,
    };
  }

  const ports = input.ports ?? gitHubTriageApplyPorts(input.repo_root);
  checkPlanSupersedes(plan.post_fields, ports.comments(plan.manifest.parent));
  const subIssueNumbers = operations
    .filter((op): op is Extract<TriageOperation, { readonly kind: 'add_sub_issue' }> => op.kind === 'add_sub_issue')
    .map(op => op.issue);
  const nodeIds = subIssueNumbers.length > 0
    ? ports.read_issue_node_ids(plan.manifest.repository, [plan.manifest.parent, ...subIssueNumbers])
    : new Map<number, string>();

  let planCommentUrl: string | null = null;
  for (const op of operations) {
    switch (op.kind) {
      case 'add_labels':
        ports.add_labels(plan.manifest.repository, op.issue, op.labels);
        break;
      case 'add_sub_issue': {
        const parentId = nodeIds.get(op.parent);
        const childId = nodeIds.get(op.issue);
        if (parentId === undefined || childId === undefined) {
          throw new BoardCollectError(`missing GitHub node ID for #${op.parent} or #${op.issue}`);
        }
        ports.add_sub_issue(parentId, childId);
        break;
      }
      case 'close_duplicate':
        ports.close_duplicate(plan.manifest.repository, op.issue, op.comment);
        break;
      case 'post_plan':
        planCommentUrl = ports.post_plan(op.parent, op.body);
        break;
    }
  }

  return {
    dry_run: false,
    operations,
    rendered_plan: rendered,
    plan_comment_url: planCommentUrl,
  };
}
