import { execFile, spawnSync, type ExecFileException } from 'child_process';
import { architecturePort, isArchitectureUnavailable, type ArchctxProviderOptions } from '../../core/architecture/contracts';
import { linkedPullRequests, planFromComments, projectBoard, type BoardDailyRunInputV1, type BoardHostPortsV1,
  type BoardPathOwnerV1, type BoardPathOwnersV1, type BoardRequiredContextsV1, type BoardSeatTerminalInputV1, type BoardSeatTerminalReadV1, type BoardV1,
} from '../../core/board/board';
import { isAutopilotEnabled } from '../../core/board/autopilot';
import { sha256Hex } from '../../core/evidence/sha256';
import { mergeHoldNeedsFullThread } from '../../core/board/merge';
import {
  BOARD_PAGE, BOARD_PARENT_COMMENT_PAGES, BOARD_SUB_ISSUE_PAGES, BoardSourceError, decodeIssueComments, decodeParentRead,
  decodePullRequestsRead, parentCommentsPreviousCursor, parentReadNextCursor, type BoardCommentPageV1, type BoardCommentV1, type BoardParentReadV1, type BoardPullRequestReadV1,
} from '../../core/board/source';
import { normalizeCapabilityPath } from '../../core/capabilities/registry';
import type { PullRequestReadinessV2, PullRequestSelectionV2 } from '../../core/publication/merge-readiness';
import { GitExecError, gitExecFile, gitSpawnSync, withoutRepositorySelectingGitEnv } from '../git/runner';
import { collectPullRequestMergeReadiness } from '../publication/merge-readiness';
import { readAutopilotStateIfGitRepo } from './autopilot-store';
import { BLOCKED_BY, COMMENTS, ISSUE_FIELDS, PULL_REQUEST_FIELDS, decodeDailyRun, decodeRequiredContexts, followCursor, parentComments, readExternalBlockers } from './collect-github';
import { acceptanceMerge, boardReadinessTransport, defaultBranchPolicy, i3Paths, tierEvidence } from './collect-review-evidence';
import { execution, seatBranch, tooling } from './collect-seat-observations';
import { createKeyedSources, readinessKey, type KeyedSources } from './keyed-sources';

const GH_TIMEOUT_MS = 30_000;
/**
 * The stdout limit of one gh call. A read that reaches it fails with this
 * number, because the child is killed and its cut output is no JSON. The
 * process default of 1 MiB cut the pull request read of a parent with 92 PRs.
 */
export const GH_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/**
 * The pull requests of one query of the pull request read. One PR printed
 * about 13 kB at #2207 (1 229 986 bytes for 96 PRs), so a group prints about
 * 260 kB, 1.6% of `GH_MAX_BUFFER_BYTES`.
 */
const PULL_REQUEST_GROUP = 20;

/** One older comment page of the parent; `$before` is the start cursor of the newer page. */
export const PARENT_COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${parentComments(', before: $before')} } }
}`;

/** One page of the parent read: its sub-issues with blocked-by edges, claim comments and cross-referenced PR numbers. `$after` selects the sub-issue page. */
export const PARENT_QUERY = `query($owner: String!, $name: String!, $number: Int!, $repairs: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    databaseId nameWithOwner defaultBranchRef { name }
    issue(number: $number) {
      ${ISSUE_FIELDS} ${parentComments('')}
      subIssues(first: ${BOARD_PAGE.sub_issues}, after: $after) { pageInfo { hasNextPage endCursor } nodes {
        ${ISSUE_FIELDS} ${COMMENTS}
        ${BLOCKED_BY}
        timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: ${BOARD_PAGE.timeline}) { pageInfo { hasPreviousPage } nodes {
          ... on CrossReferencedEvent { source { ... on PullRequest { number repository { nameWithOwner } } } }
        } }
      } }
    }
  }
  repairs: search(query: $repairs, type: ISSUE, first: ${BOARD_PAGE.repairs}) { issueCount nodes { ... on Issue { number body } } }
}`;

/** One group of the cross-referenced pull requests, each once, so a PR that names several sub-issues is read once. */
export function pullRequestsQuery(numbers: readonly number[]): string {
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${
    numbers.map(number => `  pr${number}: pullRequest(number: ${number}) { ${PULL_REQUEST_FIELDS} }`).join('\n')}\n} }`;
}

/**
 * A failed board read. `httpStatus` is the provider status of the failed gh
 * call, and `endedWithoutExit` marks a gh call that a signal or the call
 * timeout ended. Both are short availability, not a broken board. A gh call
 * that never started (a launch error such as ENOENT) also has no exit status,
 * but it is a real failure, so it leaves `endedWithoutExit` false.
 */
export class BoardCollectError extends Error {
  constructor(message: string, readonly httpStatus: number | null = null, readonly endedWithoutExit = false) {
    super(message);
    this.name = 'BoardCollectError';
  }
}

/** A gh stdout that reached `GH_MAX_BUFFER_BYTES`: the product cannot take the answer in full, so no read reports it as an unavailable provider. */
class GhOutputLimitError extends BoardCollectError {}

/** Whether one failed board read is short provider availability: a provider 5xx, or a gh call that ended with no exit status. */
export function boardAvailabilityFailure(error: unknown): error is BoardCollectError {
  return error instanceof BoardCollectError
    && (error.endedWithoutExit || (error.httpStatus !== null && error.httpStatus >= 500 && error.httpStatus <= 599));
}

/** One finished gh call, as spawnSync reports it. `signal`, the timeout error and a launch error explain a null status. */
export interface GhCallResult {
  readonly status: number | null; readonly stdout: string; readonly stderr?: string;
  readonly signal?: NodeJS.Signals | null; readonly error?: Error;
}

export interface BoardCollectInput {
  readonly repo_root: string;
  /** Explicit owner/name for reads whose repository is already known. */
  readonly repository?: string;
  readonly parent: number;
  readonly gh_bin?: string;
  /** Effect seam for tests: answers each gh argument list, as spawnSync reports one: no exit status with the signal, the timeout error or the launch error. */
  readonly gh_runner?: (args: readonly string[]) => GhCallResult;
  /** Effect seam for tests: the single-PR readiness projection. */
  readonly readiness?: (selection: PullRequestSelectionV2) => PullRequestReadinessV2;
  /** Effect seam for tests: the archctx process of the path owner read. */
  readonly archctx?: ArchctxProviderOptions;
  readonly host: BoardHostPortsV1;
  readonly now?: () => Date;
}

export type GhInput = Pick<BoardCollectInput, 'repo_root' | 'gh_bin' | 'gh_runner'>;

function bufferLimitError(args: readonly string[]): GhOutputLimitError {
  return new GhOutputLimitError(`gh ${args.slice(0, 2).join(' ')} printed more than the ${GH_MAX_BUFFER_BYTES}-byte maxBuffer limit`);
}

/** A gh call killed at `GH_MAX_BUFFER_BYTES` is a `BoardCollectError` that names the limit: its signal is no short availability. */
export function runGh(input: GhInput, args: readonly string[]): GhCallResult {
  const result = input.gh_runner?.(args) ?? spawnSync(input.gh_bin ?? process.env.REPO_HARNESS_GH_BIN ?? 'gh', [...args], {
    cwd: input.repo_root, env: { ...process.env, GH_HOST: 'github.com' }, encoding: 'utf-8', timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GH_MAX_BUFFER_BYTES,
  });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') throw bufferLimitError(args);
  return result;
}

/** One gh call that prints JSON; a failed call or invalid JSON is a `BoardCollectError`. */
export function readGhJson(input: GhInput, args: readonly string[]): unknown {
  return ghJson(args, runGh(input, args));
}

// A page of 20 comment bodies fits under the gh stdout limit even with JSON escaping.
const ISSUE_COMMENT_PAGE_SIZE = 20;

/** The issues endpoint reads both issue and PR threads in oldest-first order. */
export function readIssueComments(input: GhInput, repository: string, number: number): BoardCommentPageV1 {
  const subject = `repos/${repository}/issues/${number}/comments`;
  const comments: BoardCommentV1[] = [];
  for (let page = 1; ; page += 1) {
    const endpoint = `${subject}?per_page=${ISSUE_COMMENT_PAGE_SIZE}&page=${page}`;
    const batch = decodeIssueComments(readGhJson(input, ['api', '--hostname', 'github.com', endpoint]), endpoint);
    comments.push(...batch);
    if (batch.length < ISSUE_COMMENT_PAGE_SIZE) return { truncated: false, comments };
  }
}

/** One gh call that prints text; the board review and the board dispatch post their comments with it. A failed call is a `BoardCollectError`. */
export function runGhText(input: { readonly repo_root: string }, args: readonly string[], stdin?: string): string {
  const run = spawnSync(process.env.REPO_HARNESS_GH_BIN ?? 'gh', [...args], {
    cwd: input.repo_root, env: { ...process.env, GH_HOST: 'github.com' }, encoding: 'utf-8', input: stdin, timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GH_MAX_BUFFER_BYTES,
  });
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOBUFS') throw bufferLimitError(args);
  if (run.error !== undefined || run.status !== 0) throw new BoardCollectError(`gh ${args.slice(0, 2).join(' ')} failed: ${(run.stderr || run.error?.message || '').trim().slice(0, 300)}`);
  return run.stdout.trim();
}

/** A gh call that a signal or the call timeout ended; a launch error has neither a signal nor the timeout code. */
function endedWithoutExitStatus(result: GhCallResult): boolean {
  return result.status === null && (result.signal != null || (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT');
}

function ghJson(args: readonly string[], result: GhCallResult): unknown {
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const status = /\(HTTP (\d{3})\)$/u.exec(stderr) ?? /^gh: HTTP (\d{3})$/mu.exec(stderr) ?? /^HTTP (\d{3}):/mu.exec(stderr);
    throw new BoardCollectError(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr || `exit ${result.status}`}`, status === null ? null : Number(status[1]),
      endedWithoutExitStatus(result));
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new BoardCollectError(`gh ${args.slice(0, 2).join(' ')} returned invalid JSON`);
  }
}

function graphql(input: GhInput, query: string, variables: Readonly<Record<string, string | number>>): unknown {
  const args = ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`,
    ...Object.entries(variables).flatMap(([key, value]) => [typeof value === 'number' ? '-F' : '-f', `${key}=${value}`])];
  const response = readGhJson(input, args) as { data?: unknown; errors?: unknown } | null;
  if (response === null || typeof response !== 'object' || response.errors !== undefined) {
    throw new BoardCollectError(`GitHub GraphQL refused the board read: ${JSON.stringify(response?.errors ?? response).slice(0, 500)}`);
  }
  return response.data;
}

function dailyRun(input: BoardCollectInput, repository: string, branch: string): BoardDailyRunInputV1 {
  let body: unknown;
  try {
    body = readGhJson(input, ['api', '--hostname', 'github.com',
      `repos/${repository}/actions/workflows/ci.yml/runs?event=schedule&status=completed&per_page=1&branch=${encodeURIComponent(branch)}`]);
  } catch (error) {
    if (error instanceof BoardCollectError && !(error instanceof GhOutputLimitError)) return { status: 'unavailable', reason: 'github_unavailable' };
    throw error;
  }
  return decodeDailyRun(body, branch);
}

/**
 * The required status contexts of one base branch: `required_status_checks.contexts` of its protection, the read that the publication
 * readiness also makes. GitHub is the only authority for the names, so a failed read or a missing, empty or non-string list is
 * `unavailable`, never a default name.
 */
function requiredContexts(input: BoardCollectInput, repository: string, base: string): BoardRequiredContextsV1 {
  let body: unknown;
  try {
    body = readGhJson(input, ['api', '--hostname', 'github.com', `repos/${repository}/branches/${encodeURIComponent(base)}/protection`]);
  } catch (error) {
    // Every failed protection read, an output-limit one included, is the board state `unavailable`; the message keeps the cause.
    if (error instanceof BoardCollectError) return { status: 'unavailable', reason: error.message };
    throw error;
  }
  return decodeRequiredContexts(body, base);
}

/** Each terminal with the current branch of its directory, read with git in that directory. The directory stays here. */
export function seatTerminalsWithBranches(terminals: readonly BoardSeatTerminalReadV1[]): readonly BoardSeatTerminalInputV1[] {
  return terminals.map(({ cwd, agent_pid: _agentPid, ...terminal }) => ({ ...terminal, branch: seatBranch(cwd) }));
}

const SPINNER_FRAMES = /[\u2800-\u28FF]/gu;
/** Elapsed-time counters such as `12s`, `1m 05s`, `2h`, `340ms` and `03:12`; they move while a stream hangs. Token counters such as `↓ 2.1k` stay. */
const ELAPSED_COUNTERS = /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/gu;

/** The hash of a seat screen without its Braille spinner frames and elapsed-time counters, which change while the agent makes no progress. */
export function seatScreenHash(text: string): string {
  return sha256Hex(text.replace(SPINNER_FRAMES, '').replace(ELAPSED_COUNTERS, ''));
}

/**
 * The owners of the changed paths of the open pull requests, from one
 * `archctx resolve` batch on the local model. An ambiguous path keeps its
 * entry. A failed run, a rejected model or an owner that is no capability
 * node makes every owner unavailable, because it does not name its path.
 */
export function pathOwners(input: Pick<BoardCollectInput, 'repo_root' | 'archctx'>, reads: readonly BoardPullRequestReadV1[]): BoardPathOwnersV1 {
  const paths = [...new Set(reads.filter(read => read.state === 'open').flatMap(read => read.files ?? []))].sort();
  if (paths.length === 0) return { status: 'observed', owners: [] };
  const display = architecturePort('display');
  if (isArchitectureUnavailable(display)) return { status: 'unavailable', reason: display.code };
  const read = display.pathOwners(input.repo_root, paths, input.archctx);
  if (read.status === 'failed') return { status: 'unavailable', reason: read.code };
  const { resolution } = read;
  const fault = resolution.diagnostics.find(diagnostic => diagnostic.code !== 'AMBIGUOUS_MATCH');
  if (fault !== undefined) return { status: 'unavailable', reason: fault.code };
  const owners = new Map<string, BoardPathOwnerV1>();
  for (const match of resolution.matches) owners.set(match.filePath, { path: match.filePath, status: 'owned', capability: match.prefix });
  for (const path of resolution.unmappedPaths) owners.set(path, { path, status: 'unowned' });
  for (const diagnostic of resolution.diagnostics) owners.set(diagnostic.path, { path: diagnostic.path, status: 'ambiguous' });
  // The resolver answers each path in its normalized form; the board keys the owner by the GitHub path.
  return { status: 'observed', owners: Object.freeze(paths.map(path => ({ ...owners.get(normalizeCapabilityPath(path, input.repo_root))!, path }))) };
}

const REPOSITORY_ID_ARGS = ['api', '--hostname', 'github.com', 'repos/{owner}/{repo}'] as const;

function repositoryId(value: unknown): number {
  const id = (value as { id?: unknown } | null)?.id;
  if (!Number.isSafeInteger(id) || (id as number) < 1) throw new BoardCollectError('the local GitHub repository id is unknown');
  return id as number;
}

/** The GitHub numeric id of the local repository: the value of the `repo-harness.repository` label. */
export function readRepositoryId(input: GhInput): number {
  return repositoryId(readGhJson(input, REPOSITORY_ID_ARGS));
}

function hasGitHubRemote(remotes: string, isGitHubRemote: (url: string) => boolean): boolean {
  return remotes.split('\n').some(line => line !== '' && isGitHubRemote(line.slice(line.indexOf(' ') + 1)));
}

/** The repository id of a checkout, or null when no remote URL of it is a GitHub URL: gh then has no repository to read. */
export function readLocalRepositoryId(input: GhInput, isGitHubRemote: (url: string) => boolean): number | null {
  const remotes = gitSpawnSync(['config', '--local', '--get-regexp', '^remote\\..*\\.url$'], { cwd: input.repo_root, encoding: 'utf8' });
  // Exit 1: the checkout has no remote URL.
  if (remotes.error !== undefined || (remotes.status !== 0 && remotes.status !== 1)) throw new BoardCollectError('git did not list the remote URLs of this checkout');
  return hasGitHubRemote(remotes.stdout, isGitHubRemote) ? readRepositoryId(input) : null;
}

/** The same local admission, query and decoders, with cancellable children for resident observers. */
export async function readLocalRepositoryIdAsync(input: {
  readonly repo_root: string; readonly gh_bin?: string; readonly env: NodeJS.ProcessEnv; readonly signal: AbortSignal;
}, isGitHubRemote: (url: string) => boolean): Promise<number | null> {
  let remotes: string;
  try {
    remotes = await gitExecFile(['config', '--local', '--get-regexp', '^remote\\..*\\.url$'], { cwd: input.repo_root, env: input.env, signal: input.signal });
  } catch (error) {
    if (error instanceof GitExecError && error.status === 1) remotes = '';
    else throw error;
  }
  if (!hasGitHubRemote(remotes, isGitHubRemote)) return null;
  if (input.signal.aborted) throw new DOMException('repository read aborted', 'AbortError');
  const env = withoutRepositorySelectingGitEnv(input.env);
  delete env.GH_REPO;
  const result = await new Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    let output: { readonly error: ExecFileException | null; readonly stdout: string; readonly stderr: string };
    const child = execFile(input.gh_bin ?? input.env.REPO_HARNESS_GH_BIN ?? 'gh', [...REPOSITORY_ID_ARGS], {
      cwd: input.repo_root, env: { ...env, GH_HOST: 'github.com' }, signal: input.signal, timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: GH_MAX_BUFFER_BYTES, encoding: 'utf8',
    }, (error, stdout, stderr) => { output = { error, stdout, stderr }; });
    // The abort callback can run before exit. Reap the child before this read settles.
    child.once('close', () => {
      if (input.signal.aborted) reject(new DOMException('repository read aborted', 'AbortError'));
      else if (output.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(bufferLimitError(REPOSITORY_ID_ARGS));
      else if (output.error && typeof output.error.code !== 'number') reject(output.error);
      else resolve({ status: output.error?.code as number ?? 0, stdout: output.stdout, stderr: output.stderr });
    });
  });
  return repositoryId(ghJson(REPOSITORY_ID_ARGS, result));
}

/** The read of the parent issue, every page of its sub-issues and their comments; the board and dispatch share it. */
export function readParent(input: Pick<BoardCollectInput, 'repo_root' | 'repository' | 'gh_bin' | 'gh_runner' | 'parent' | 'now'>): { readonly parent: BoardParentReadV1; readonly observed_at: string } {
  const repository = input.repository
    ?? (readGhJson(input, ['repo', 'view', '--json', 'nameWithOwner']) as { nameWithOwner?: unknown } | null)?.nameWithOwner;
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new BoardCollectError('the local GitHub repository is unknown');
  const [owner, name] = repository.split('/') as [string, string];
  const observedAt = (input.now?.() ?? new Date()).toISOString();
  const variables = { owner, name, number: input.parent, repairs: `repo:${repository} is:issue is:open in:title "CI repair"` };
  const first = graphql(input, PARENT_QUERY, variables);
  const pages = followCursor(first, parentReadNextCursor, after => graphql(input, PARENT_QUERY, { ...variables, after }),
    'issue.subIssues', BOARD_PAGE.sub_issues, BOARD_SUB_ISSUE_PAGES);
  const commentPages = followCursor(first, parentCommentsPreviousCursor, before => graphql(input, PARENT_COMMENTS_QUERY, { owner, name, number: input.parent, before }),
    'issue.comments', BOARD_PAGE.parent_comments, BOARD_PARENT_COMMENT_PAGES);
  const parent = decodeParentRead(pages, commentPages, repository);
  return { parent, observed_at: observedAt };
}

/** The pull request read in groups of `PULL_REQUEST_GROUP`, one query each; the decoder gets the aliases of all groups as one answer. */
export function readPullRequests(input: GhInput, owner: string, name: string, numbers: readonly number[]): BoardPullRequestReadV1[] {
  if (numbers.length === 0) return [];
  const repository: Record<string, unknown> = {};
  for (let at = 0; at < numbers.length; at += PULL_REQUEST_GROUP) {
    const data = graphql(input, pullRequestsQuery(numbers.slice(at, at + PULL_REQUEST_GROUP)), { owner, name }) as { repository?: unknown } | null;
    if (data === null || typeof data !== 'object' || data.repository === null || typeof data.repository !== 'object') {
      throw new BoardSourceError('repository is not an object');
    }
    Object.assign(repository, data.repository);
  }
  return decodePullRequestsRead({ repository }, numbers);
}

/** One board read through a fresh keyed source store: the path of every act. */
export function collectBoard(input: BoardCollectInput): BoardV1 {
  return collectBoardThrough(input, createKeyedSources());
}

/** One board read through `sources`. Only the attention watcher keeps a store across reads. */
export function collectBoardThrough(input: BoardCollectInput, sources: KeyedSources): BoardV1 {
  const autopilot = readAutopilotStateIfGitRepo(input.repo_root)?.state ?? null;
  const autopilotEnabled = autopilot !== null && isAutopilotEnabled(autopilot);
  const { parent, observed_at: observedAt } = readParent(input);
  const repository = parent.repository.name_with_owner;
  const [owner, name] = repository.split('/') as [string, string];
  const candidates = [...new Set(parent.sub_issues.flatMap(issue => issue.pull_request_candidates))].sort((left, right) => left - right);
  const reads = readPullRequests(input, owner, name, candidates);
  const linked = linkedPullRequests(parent, reads);
  const open = linked.filter(read => read.state === 'open');
  const holdComments = new Map([...parent.sub_issues, ...open].filter(read => mergeHoldNeedsFullThread(read.comments))
    .map(read => [read.number, readIssueComments(input, repository, read.number)] as const));
  const externalBlockers = autopilotEnabled && planFromComments(parent.parent.comments).status === 'observed'
    ? readExternalBlockers(parent, open, (query, variables) => graphql(input, query, variables), (repo, number) => readIssueComments(input, repo, number)) : [];
  const gh = (args: readonly string[]) => runGh(input, args);
  const readinessTransport = boardReadinessTransport(gh, repository);
  const readiness = open.map((read) => {
    const selection: PullRequestSelectionV2 = {
      provider_repository_id: String(parent.repository.database_id), repository, pr_number: read.number,
      expected_head_sha: read.head_sha, expected_base_sha: read.base_sha,
    };
    const key = readinessKey({ repository_id: parent.repository.database_id, default_branch: parent.repository.default_branch, read, reads });
    const now = input.now?.() ?? new Date();
    return sources.readiness(key, now, () => input.readiness?.(selection) ?? collectPullRequestMergeReadiness({
      ...selection, repo_root: input.repo_root, gh_bin: input.gh_bin, gh_runner: sources.transport(read, now, readinessTransport),
      fatal_read_error: error => error instanceof GhOutputLimitError,
    }));
  });
  const policy = defaultBranchPolicy(gh, repository, parent.repository.default_branch);
  const i3 = i3Paths(policy);
  const evidence = new Map(open.map(read => [read.number, tierEvidence(gh, repository, read, i3, autopilotEnabled)] as const));
  const seats = execution(input.host, String(input.parent), parent.repository.database_id, new Set(parent.sub_issues.map(issue => String(issue.number))),
    new Set(linked.map(read => String(read.number))), observedAt, seatTerminalsWithBranches, seatScreenHash);
  return projectBoard({
    observed_at: observedAt,
    parent,
    acceptance_merge: acceptanceMerge(policy),
    autopilot,
    hold_comments: holdComments,
    ...(externalBlockers.length === 0 ? {} : { autopilot_external_blockers: externalBlockers }),
    review_evidence: { i3_paths: i3, pull_requests: evidence },
    pull_requests: reads,
    readiness,
    required_contexts: new Map([...new Set(linked.map(read => read.base_ref))].map(base => [base, requiredContexts(input, repository, base)] as const)),
    path_owners: pathOwners(input, linked),
    ...seats,
    daily_run: dailyRun(input, repository, parent.repository.default_branch),
    tooling: tooling(input.host),
  });
}
