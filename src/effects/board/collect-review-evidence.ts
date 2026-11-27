import type { BoardAcceptanceMergeV1 } from '../../core/board/board';
import { isAllowedEditPath, readReviewI3Paths, workflowEditAllowed } from '../../core/board/hazards';
import type { BoardPullRequestTierEvidenceV1 } from '../../core/board/review-rules';
import type { BoardPullRequestReadV1 } from '../../core/board/source';
import { parsePublicationPolicy, policyFileFromContents, PUBLICATION_POLICY_PATH, type PolicyFileAtRef } from '../../core/publication/acceptance-merge-policy';
import { decodeWorkflowPolicy } from '../../core/workflow/policy-schema';
import type { GhCallResult } from './collect';
import type { GhRunner } from './keyed-sources';

type RunGh = (args: readonly string[]) => GhCallResult;

/**
 * The policy file on the default branch. GitHub answers an absent file with
 * exit 1 and a JSON body of status 404; every other failure is null.
 */
export function defaultBranchPolicy(runGh: RunGh, repository: string, branch: string): PolicyFileAtRef | null {
  const result = runGh(['api', '--hostname', 'github.com', `repos/${repository}/contents/${PUBLICATION_POLICY_PATH}?ref=${encodeURIComponent(branch)}`]);
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const absent = result.status === 1 && (body as { status?: unknown } | null)?.status === '404';
  return absent ? { status: 'missing' } : result.status === 0 ? policyFileFromContents(body) : null;
}

/** `publication.acceptance_merge`, decoded only by the publication policy parser; an unread file leaves it unknown. */
export function acceptanceMerge(file: PolicyFileAtRef | null): BoardAcceptanceMergeV1 {
  if (file === null) return 'unknown';
  const policy = parsePublicationPolicy(file);
  return policy.ok ? policy.acceptance_merge : 'unknown';
}

/** `review.i3_paths`; null for an unread file or an invalid value. */
export function i3Paths(file: PolicyFileAtRef | null): readonly string[] | null {
  if (file === null) return null;
  try {
    const read = readReviewI3Paths(decodeWorkflowPolicy(file.status === 'present' ? file.text : null));
    return read.status === 'present' ? read.paths : null;
  } catch {
    return null;
  }
}

const PULL_REQUEST_FILE_PAGE = 100;
/** The REST pull request files list stops at 3000 files. */
const PULL_REQUEST_FILE_LIMIT = 3000;

interface PullRequestFile {
  readonly path: string;
  readonly modified: boolean;
  readonly previous_path: string | null;
}

/** The REST files of a pull request, paged by its changed-file count; null when a read fails or the pages do not hold that count. */
function pullRequestFiles(runGh: RunGh, repository: string, read: BoardPullRequestReadV1): PullRequestFile[] | null {
  const count = read.readiness_inputs.changed_files;
  if (count > PULL_REQUEST_FILE_LIMIT) return null;
  const files: PullRequestFile[] = [];
  for (let page = 1; page <= Math.ceil(count / PULL_REQUEST_FILE_PAGE); page++) {
    const result = runGh(['api', '--hostname', 'github.com', `repos/${repository}/pulls/${read.number}/files?per_page=${PULL_REQUEST_FILE_PAGE}&page=${page}`]);
    let entries: unknown;
    try {
      entries = result.status === 0 ? JSON.parse(result.stdout) : null;
    } catch {
      return null;
    }
    if (!Array.isArray(entries)) return null;
    for (const entry of entries as { filename?: unknown; status?: unknown; previous_filename?: unknown }[]) {
      if (typeof entry?.filename !== 'string') return null;
      files.push({ path: entry.filename, modified: entry.status === 'modified', previous_path: typeof entry.previous_filename === 'string' ? entry.previous_filename : null });
    }
  }
  return files.length === count ? files : null;
}

/** The parsed YAML of a file at a commit; null when the read fails, GitHub returns no inline content, or the text does not parse. */
function yamlAt(runGh: RunGh, repository: string, path: string, sha: string): { readonly value: unknown } | null {
  const result = runGh(['api', '--hostname', 'github.com', `repos/${repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`]);
  try {
    const body = result.status === 0 ? JSON.parse(result.stdout) as { type?: unknown; encoding?: unknown; content?: unknown } : null;
    if (body?.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string') return null;
    return { value: Bun.YAML.parse(Buffer.from(body.content, 'base64').toString('utf-8')) };
  } catch {
    return null;
  }
}

/** The merge base of a pull request's base and head commits, the old side of its REST file diff; null when the compare read fails. */
function mergeBase(runGh: RunGh, repository: string, read: BoardPullRequestReadV1): string | null {
  const result = runGh(['api', '--hostname', 'github.com', `repos/${repository}/compare/${read.base_sha}...${read.head_sha}?per_page=1`]);
  try {
    const sha: unknown = result.status === 0 ? (JSON.parse(result.stdout) as { merge_base_commit?: { sha?: unknown } }).merge_base_commit?.sha : null;
    return typeof sha === 'string' && /^[0-9a-f]{40}$/u.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The diff evidence of one open pull request (#3187): the rename sources, read only while I3 globs exist, and the modified workflow
 * files that the edit allowlist clears, from their YAML at the merge base and the head commit. The base tip can hold changes that the
 * pull request does not make, so it is not the old side. A failed read clears no file.
 */
export function tierEvidence(runGh: RunGh, repository: string, read: BoardPullRequestReadV1, i3: readonly string[] | null, autopilotEnabled: boolean): BoardPullRequestTierEvidenceV1 {
  const renames = autopilotEnabled || (i3 !== null && i3.length > 0);
  if (read.files === null || (!renames && !read.files.some(isAllowedEditPath))) return { rename_sources: [], cleared_paths: [] };
  const files = pullRequestFiles(runGh, repository, read);
  const candidates = (files ?? []).filter(file => file.modified && isAllowedEditPath(file.path));
  const old = candidates.length === 0 ? null : mergeBase(runGh, repository, read);
  const cleared = old === null ? [] : candidates.flatMap((file) => {
    const base = yamlAt(runGh, repository, file.path, old);
    const head = base === null ? null : yamlAt(runGh, repository, file.path, read.head_sha);
    return base !== null && head !== null && workflowEditAllowed(file.path, base.value, head.value) ? [file.path] : [];
  });
  const sources = files === null ? null : files.flatMap(file => (file.previous_path === null ? [] : [file.previous_path]));
  return { rename_sources: renames ? sources : [], cleared_paths: cleared };
}

/**
 * The provider transport of the readiness reads of one board read. Every pull
 * request of the repository gets the same repository identity, so those reads
 * run once; the keyed source store answers the content-addressed reads. The
 * pull request identity, checks, reviews and stack lists run each time, so the
 * identity and stack fences of each read stay. A failure is not stored. The
 * answers live only as long as this function's return value.
 */
export function boardReadinessTransport(runGh: RunGh, repository: string): GhRunner {
  const root = `repos/${repository}`;
  const reusable = (args: readonly string[]): boolean => (args[0] === 'repo' && args[1] === 'view')
    || (args.length === 4 && args[0] === 'api' && args[1] === root && args[2] === '--hostname' && args[3] === 'github.com');
  const answers = new Map<string, ReturnType<GhRunner>>();
  return (args) => {
    const key = reusable(args) ? JSON.stringify(args) : null;
    const stored = key === null ? undefined : answers.get(key);
    if (stored !== undefined) return stored;
    const result = runGh(args);
    // No exit status (spawn error, timeout) is -1, which no reader accepts: the read reports provider_unavailable.
    const answer = { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr || result.error?.message || '' };
    if (key !== null && answer.status === 0) answers.set(key, answer);
    return answer;
  };
}
