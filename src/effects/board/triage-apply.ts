import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AutopilotStateV1 } from '../../core/board/autopilot';
import { checkPlanSupersedes, checkPostBody } from '../../core/board/post';
import { withSeatLine } from '../../core/board/seat-line';
import type { BoardCommentPageV1 } from '../../core/board/source';
import {
  computeLabelDelta,
  planTriageApply,
  TriageApplyValidationError,
  type TriageApplyPlanV1,
  type TriageOperation,
} from '../../core/board/triage-apply';
import { isRecord } from '../../core/evidence/is-record';
import { readAutopilotStateIfGitRepo } from './autopilot-store';
import { BoardCollectError, readGhJson, type GhCallResult, type GhInput } from './collect';

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const LABEL_PAGE = 100;

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

export interface IssuePreflightMetadata {
  readonly id: string;
  readonly labels: readonly string[];
}

export interface TriageApplyPorts {
  readonly comments: (repository: string, target: number) => BoardCommentPageV1;
  readonly read_issue_metadata: (repository: string, numbers: readonly number[]) => ReadonlyMap<number, IssuePreflightMetadata>;
  readonly set_labels: (repository: string, issue: number, add: readonly string[], remove: readonly string[]) => void;
  readonly add_sub_issue: (parentId: string, childId: string) => void;
  readonly bind_refactor?: (repository: string, issue: number, body: string) => void;
  readonly close_duplicate: (repository: string, issue: number, comment: string) => void;
  readonly post_plan: (repository: string, parent: number, body: string) => string;
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

function runGhTextWithRunner(input: GhInput, args: readonly string[], stdin?: string): string {
  let result: GhCallResult;
  if (input.gh_runner !== undefined) {
    result = input.gh_runner(args);
  } else {
    const run = spawnSync(input.gh_bin ?? process.env.REPO_HARNESS_GH_BIN ?? 'gh', [...args], {
      cwd: input.repo_root,
      env: { ...process.env, GH_HOST: 'github.com' },
      encoding: 'utf-8',
      input: stdin,
      timeout: GH_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: GH_MAX_BUFFER_BYTES,
    });
    if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') {
      throw new BoardCollectError(`gh ${args.slice(0, 2).join(' ')} printed more than the ${GH_MAX_BUFFER_BYTES}-byte maxBuffer limit`);
    }
    result = run;
  }
  if (result.error !== undefined || result.status !== 0) {
    throw new BoardCollectError(`gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.error?.message || '').trim().slice(0, 300)}`);
  }
  return result.stdout.trim();
}

function readRepositoryComments(input: GhInput, repository: string, target: number): BoardCommentPageV1 {
  const printed = runGhTextWithRunner(input, [
    'api', '--hostname', 'github.com', '--paginate', '--slurp',
    `repos/${repository}/issues/${target}/comments?per_page=100`,
  ]);
  let pages: { html_url: string; created_at: string; author_association: string; body: string }[][];
  try {
    pages = JSON.parse(printed) as typeof pages;
  } catch {
    throw new BoardCollectError(`gh api printed no comment page list for ${repository}#${target}`);
  }
  return {
    truncated: false,
    comments: pages.flat().map(({ html_url, created_at, author_association, body }) => ({
      url: html_url,
      created_at,
      author_association,
      body,
    })),
  };
}

function resolveIssueMetadata(
  input: GhInput,
  repository: string,
  numbers: readonly number[],
): ReadonlyMap<number, IssuePreflightMetadata> {
  const unique = [...new Set(numbers)].sort((left, right) => left - right);
  if (unique.length === 0) return new Map();
  const [owner, name] = repository.split('/') as [string, string];
  const fields = unique
    .map(num => `i${num}: issue(number: ${num}) { id number labels(first: ${LABEL_PAGE}) { pageInfo { hasNextPage } nodes { name } } }`)
    .join('\n    ');
  const query = `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}`;
  const response = readGhJson(input, [
    'api', 'graphql', '--hostname', 'github.com',
    '-f', `query=${query}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`,
  ]);
  if (!isRecord(response) || response.errors !== undefined || !isRecord(response.data) || !isRecord(response.data.repository)) {
    throw new BoardCollectError(`GitHub GraphQL failed to resolve issue metadata in ${repository}`);
  }
  const repo = response.data.repository;
  const metadata = new Map<number, IssuePreflightMetadata>();
  for (const num of unique) {
    const node = repo[`i${num}`];
    if (!isRecord(node) || node.number !== num || typeof node.id !== 'string' || node.id === '') {
      throw new BoardCollectError(`issue #${num} did not resolve to an issue in ${repository}`);
    }
    const labelsConn = node.labels;
    if (!isRecord(labelsConn) || !isRecord(labelsConn.pageInfo) || typeof labelsConn.pageInfo.hasNextPage !== 'boolean' || !Array.isArray(labelsConn.nodes)) {
      throw new BoardCollectError(`issue #${num} labels connection is invalid in ${repository}`);
    }
    if (labelsConn.pageInfo.hasNextPage) {
      throw new BoardCollectError(`issue #${num} has more than ${LABEL_PAGE} labels in ${repository}`);
    }
    const labels = labelsConn.nodes.map((entry, idx) => {
      if (!isRecord(entry) || typeof entry.name !== 'string') {
        throw new BoardCollectError(`issue #${num} label[${idx}] is not a name in ${repository}`);
      }
      return entry.name;
    });
    metadata.set(num, { id: node.id, labels });
  }
  return metadata;
}

export function gitHubTriageApplyPorts(
  repoRoot: string,
  ghInput: GhInput = { repo_root: repoRoot },
): TriageApplyPorts {
  return {
    comments: (repository, target) => readRepositoryComments(ghInput, repository, target),
    read_issue_metadata: (repository, numbers) => resolveIssueMetadata(ghInput, repository, numbers),
    set_labels: (repository, issue, add, remove) => {
      if (add.length === 0 && remove.length === 0) return;
      runGhTextWithRunner(ghInput, [
        'issue', 'edit', String(issue), '--repo', repository,
        ...add.flatMap(label => ['--add-label', label]),
        ...remove.flatMap(label => ['--remove-label', label]),
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
    bind_refactor: (repository, issue, body) => {
      runGhTextWithRunner(ghInput, ['issue', 'comment', String(issue), '--repo', repository, '--body-file', '-'], body);
    },
    close_duplicate: (repository, issue, comment) => {
      runGhTextWithRunner(ghInput, [
        'issue', 'close', String(issue), '--repo', repository,
        '--reason', 'not planned',
        '--comment', comment,
      ]);
    },
    post_plan: (repository, parent, body) =>
      runGhTextWithRunner(ghInput, ['issue', 'comment', String(parent), '--repo', repository, '--body-file', '-'], body),
  };
}

export function runTriageApply(input: {
  readonly repo_root: string;
  readonly manifest: unknown;
  readonly dry_run: boolean;
  readonly ports?: TriageApplyPorts;
  readonly env?: NodeJS.ProcessEnv;
  readonly autopilot?: AutopilotStateV1 | null;
}): TriageApplyResultV1 {
  const autopilot = input.autopilot !== undefined
    ? input.autopilot
    : readAutopilotStateIfGitRepo(input.repo_root)?.state ?? null;
  const plan = planTriageApply(input.manifest, { autopilot });
  const env = input.env ?? process.env;
  const rendered = withSeatLine(plan.rendered_plan, env);
  checkPostBody({ kind: 'plan', fields: plan.post_fields }, rendered);
  const operations = plan.operations.map((op): TriageOperation => {
    if (op.kind === 'post_plan') return { ...op, body: rendered };
    if (op.kind === 'bind_refactor') return { ...op, comment: withSeatLine(op.comment, env) };
    return op;
  });

  if (input.dry_run) {
    return {
      dry_run: true,
      operations,
      rendered_plan: rendered,
      plan_comment_url: null,
    };
  }

  const ports = input.ports ?? gitHubTriageApplyPorts(input.repo_root);
  checkPlanSupersedes(plan.post_fields, ports.comments(plan.manifest.repository, plan.manifest.parent));

  const labelNumbers = operations
    .filter((op): op is Extract<TriageOperation, { readonly kind: 'set_labels' }> => op.kind === 'set_labels')
    .map(op => op.issue);
  const subIssueNumbers = operations
    .filter((op): op is Extract<TriageOperation, { readonly kind: 'add_sub_issue' }> => op.kind === 'add_sub_issue')
    .map(op => op.issue);
  const preflightNumbers = [...new Set([
    ...labelNumbers,
    ...(subIssueNumbers.length > 0 ? [plan.manifest.parent, ...subIssueNumbers] : []),
  ])];
  const issueMetadata = preflightNumbers.length > 0
    ? ports.read_issue_metadata(plan.manifest.repository, preflightNumbers)
    : new Map<number, IssuePreflightMetadata>();

  let planCommentUrl: string | null = null;
  for (const op of operations) {
    switch (op.kind) {
      case 'set_labels': {
        const current = issueMetadata.get(op.issue);
        if (current === undefined) {
          throw new BoardCollectError(`missing GitHub metadata for #${op.issue}`);
        }
        const delta = computeLabelDelta(current.labels, op.labels);
        ports.set_labels(plan.manifest.repository, op.issue, delta.add, delta.remove);
        break;
      }
      case 'add_sub_issue': {
        const parentMeta = issueMetadata.get(op.parent);
        const childMeta = issueMetadata.get(op.issue);
        if (parentMeta === undefined || childMeta === undefined) {
          throw new BoardCollectError(`missing GitHub node ID for #${op.parent} or #${op.issue}`);
        }
        ports.add_sub_issue(parentMeta.id, childMeta.id);
        break;
      }
      case 'bind_refactor':
        if (ports.bind_refactor !== undefined) {
          ports.bind_refactor(plan.manifest.repository, op.issue, op.comment);
        } else {
          ports.post_plan(plan.manifest.repository, op.issue, op.comment);
        }
        break;
      case 'close_duplicate':
        ports.close_duplicate(plan.manifest.repository, op.issue, op.comment);
        break;
      case 'post_plan':
        planCommentUrl = ports.post_plan(plan.manifest.repository, op.parent, op.body);
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
