import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RULES_LEDGER_PATH, type RuleStatusV1 } from '../../core/ci/rule-candidates';
import {
  groupRuleProposals, observeRuleProposals, type RuleObservation, type RuleProposalFilters,
  type RuleProposalReport, type RuleReviewThread,
} from '../../core/ci/rule-proposals';
import { isRecord } from '../../core/evidence/is-record';
import { BoardCollectError, readGhJson, type GhInput } from '../board/collect';
import { gitExecFileSync } from '../git/runner';

export const RULES_PROPOSALS_GH_CALL_LIMIT = 100;

export class RulesProposalsError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

class GhCallLimit extends Error {}

type ProposalReadInput = GhInput & RuleProposalFilters & { readonly since?: string; readonly ghCallLimit?: number };
type JsonRead = (path: string, paginate?: boolean) => unknown;

function invalid(resource: string): never {
  throw new RulesProposalsError('proposals_github_invalid', `GitHub returned invalid ${resource} data`);
}

function budgetedReads(input: ProposalReadInput): JsonRead {
  let remaining = input.ghCallLimit ?? RULES_PROPOSALS_GH_CALL_LIMIT;
  return (path, paginate = false) => {
    if (remaining <= 0) throw new GhCallLimit();
    remaining -= 1;
    try {
      return readGhJson(input, ['api', '--hostname', 'github.com', '--method', 'GET', path, ...(paginate ? ['--paginate', '--slurp'] : [])]);
    } catch (error) {
      if (!(error instanceof BoardCollectError)) throw error;
      throw new RulesProposalsError('proposals_github_unavailable', `GitHub read failed for ${path}`);
    }
  };
}

function readRows(value: unknown, resource: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) return invalid(resource);
  return value;
}

function readPages(read: JsonRead, path: string): Record<string, unknown>[] {
  const pages = read(`${path}${path.includes('?') ? '&' : '?'}per_page=100`, true);
  if (!Array.isArray(pages) || !pages.length) return invalid(path);
  return pages.flatMap(page => readRows(page, path));
}

function git(cwd: string, args: readonly string[]): string {
  try {
    return gitExecFileSync(args, {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    }).trim();
  } catch {
    throw new RulesProposalsError('proposals_history_unavailable', `git ${args[0]} failed while reading the default branch range from the local checkout`);
  }
}

function watermark(cwd: string): string {
  let ledger: string;
  try {
    ledger = readFileSync(resolve(cwd, RULES_LEDGER_PATH), 'utf-8');
  } catch {
    throw new RulesProposalsError('proposals_watermark_invalid', `could not read ${RULES_LEDGER_PATH}`);
  }
  const header = ledger.split(/^- Date:/mu, 1)[0];
  const rows = header.split(/\r?\n/u).filter(line => line.startsWith('reviewed-through:'));
  const match = rows.length === 1 && /^reviewed-through: ([a-f0-9]{7,64})$/u.exec(rows[0]);
  if (!match) throw new RulesProposalsError('proposals_watermark_invalid', `expected one reviewed-through commit in ${RULES_LEDGER_PATH}`);
  return match[1];
}

function readRange(cwd: string, to: string, since: string | undefined): { from: string; commits: string[] } {
  const commit = (ref: string) => git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  const start = commit(watermark(cwd));
  const list = git(cwd, ['rev-list', '--first-parent', '--reverse', `${start}..${to}`]);
  const commits = list === '' ? [] : list.split('\n');
  if (start !== to && (!commits.length || commit(`${commits[0]}^1`) !== start)) {
    throw new RulesProposalsError('proposals_watermark_outside_range', 'the ledger watermark is outside the default branch first-parent history');
  }
  if (since === undefined) return { from: start, commits };
  const from = commit(since);
  if (from === start) return { from, commits };
  const index = commits.indexOf(from);
  if (index < 0) throw new RulesProposalsError('proposals_since_outside_range', '--since must be on the default branch at or after the ledger watermark');
  return { from, commits: commits.slice(index + 1) };
}

function body(value: unknown, resource: string): string {
  if (value !== null && typeof value !== 'string') return invalid(resource);
  return value ?? '';
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** The pull review-comments endpoint contains thread roots and replies, each with its REST id. */
function readThreads(rows: readonly Record<string, unknown>[]): RuleReviewThread[] {
  const roots = new Map<number, RuleReviewThread & { replies: string[] }>();
  for (const row of rows) {
    if (row.in_reply_to_id != null) continue;
    if (!positiveInteger(row.id) || typeof row.path !== 'string' || (row.user !== null && !isRecord(row.user))) return invalid('review comment');
    const line = row.line ?? row.original_line;
    roots.set(row.id, { body: body(row.body, 'review comment'), path: row.path, line: positiveInteger(line) ? line : null,
      bot: row.user?.type === 'Bot', replies: [] });
  }
  for (const row of rows) {
    if (row.in_reply_to_id == null) continue;
    if (!positiveInteger(row.in_reply_to_id)) return invalid('review reply');
    roots.get(row.in_reply_to_id)?.replies.push(body(row.body, 'review reply'));
  }
  return [...roots.values()];
}

export function collectRulesProposals(status: RuleStatusV1, input: ProposalReadInput): RuleProposalReport {
  const repository = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u.exec(status.repository_id)?.[1];
  if (!repository) throw new RulesProposalsError('proposals_repository_unavailable', 'a GitHub remote is required');
  const read = budgetedReads(input);
  const repoPath = `repos/${repository}`;
  const repo = read(repoPath);
  if (!isRecord(repo) || typeof repo.default_branch !== 'string') return invalid('default branch');
  const [tip] = readRows(read(`${repoPath}/commits?per_page=1&sha=${encodeURIComponent(repo.default_branch)}`), 'default branch head');
  const to = tip?.sha;
  if (typeof to !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(to)) return invalid('default branch head');
  const root = git(input.repo_root, ['rev-parse', '--show-toplevel']);
  const { from, commits } = readRange(root, to, input.since);
  const observations: RuleObservation[] = [];
  let malformed = 0;
  let pullRequests = 0;
  let truncated: RuleProposalReport['truncated'] = null;
  for (const sha of commits) {
    try {
      const candidates = readPages(read, `${repoPath}/commits/${sha}/pulls`);
      const merged = candidates.find(pr => pr.merge_commit_sha === sha && typeof pr.merged_at === 'string'
        && isRecord(pr.base) && pr.base.ref === repo.default_branch);
      if (!merged) continue;
      if (!positiveInteger(merged.number)) return invalid('pull request number');
      const path = `${repoPath}/pulls/${merged.number}`;
      const reviews = readPages(read, `${path}/reviews`).map(review => body(review.body, 'review'));
      const threads = readThreads(readPages(read, `${path}/comments`));
      const result = observeRuleProposals({ number: merged.number, body: body(merged.body, 'pull request'), reviews, threads }, input);
      observations.push(...result.observations);
      malformed += result.malformed;
      pullRequests += 1;
    } catch (error) {
      if (!(error instanceof GhCallLimit)) throw error;
      truncated = { unread_from: sha };
      break;
    }
  }
  return { experimental: true, range: { from, to, pull_requests: pullRequests }, truncated, malformed, observations,
    proposals: groupRuleProposals(observations, new Set(status.themes.map(theme => theme.key))) };
}
