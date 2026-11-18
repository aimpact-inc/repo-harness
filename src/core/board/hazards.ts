// Strict decoders for the two path lists of Review by risk: the change hazard
// list (assets/review-hazards.v1.json) and the High list
// (assets/review-high-list.v1.json). scripts/sync-reference-configs.ts renders
// both lists in agentic-development-flow.md; the board rule R3 reads the
// path-visible hazards and R5 the path-visible High signals. The package ships
// both files, so downstream boards read the same lists. Exact keys; an entry
// that a path cannot show has no paths.

import hazardsJson from '../../../assets/review-hazards.v1.json';
import highListJson from '../../../assets/review-high-list.v1.json';
import { decodeReaders } from '../evidence/decode-readers';
import { POLICY_ABSENT, policyValue, type DecodedWorkflowPolicy } from '../workflow/policy-schema';

export const REVIEW_HAZARDS_VERSION = 'repo-harness.review-hazards.v1';
export const REVIEW_HIGH_LIST_VERSION = 'repo-harness.review-high-list.v1';
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
/** One path segment: `**`, or literal characters with at most one `*`. */
const GLOB_SEGMENT = /^(?:\*\*|[A-Za-z0-9._-]*\*?[A-Za-z0-9._-]*)$/u;

function isGlob(value: unknown): value is string {
  const segments = typeof value === 'string' ? value.split('/') : [];
  return segments.length > 0 && segments.every(s => s !== '' && s !== '.' && s !== '..' && GLOB_SEGMENT.test(s));
}

export type ReviewPathEntry =
  | { readonly id: string; readonly text: string; readonly path_visible: true; readonly paths: readonly string[] }
  | { readonly id: string; readonly text: string; readonly path_visible: false };

export type ReviewHazard = ReviewPathEntry;

export interface ReviewHazardsV1 {
  readonly hazards_version: typeof REVIEW_HAZARDS_VERSION;
  readonly hazards: readonly ReviewHazard[];
}

export interface ReviewHighListV1 {
  readonly high_list_version: typeof REVIEW_HIGH_LIST_VERSION;
  readonly signals: readonly ReviewPathEntry[];
}

interface PathListShape {
  readonly label: string;
  readonly version_key: string;
  readonly version: string;
  readonly list_key: string;
  readonly entry: string;
}

function decodePathList(value: unknown, shape: PathListShape): ReviewPathEntry[] {
  const fail = (what: string): never => { throw new Error(`${shape.label} invalid: ${what}`); };
  const { obj } = decodeReaders(fail);
  // Text lands in a markdown table cell: one line, no pipe.
  const cell = (v: unknown, what: string): string =>
    (typeof v === 'string' && v.length > 0 && v.length <= 280 && v.trim() === v && !/[\x00-\x1f\x7f|]/u.test(v) ? v : fail(what));
  const glob = (v: unknown, what: string): string => (isGlob(v) ? v : fail(what));

  const root = obj(value, [shape.version_key, shape.list_key], 'list');
  if (root[shape.version_key] !== shape.version) fail(shape.version_key);
  const raws = root[shape.list_key];
  if (!Array.isArray(raws) || raws.length === 0) fail(shape.list_key);
  const ids = new Set<string>();
  return (raws as unknown[]).map((raw): ReviewPathEntry => {
    const visible = (raw as { path_visible?: unknown } | null)?.path_visible === true;
    const h = obj(raw, visible ? ['id', 'text', 'path_visible', 'paths'] : ['id', 'text', 'path_visible'], shape.entry);
    const id = typeof h.id === 'string' && ENTRY_ID.test(h.id) ? h.id : fail(`${shape.entry} id`);
    if (ids.has(id)) fail(`duplicate ${shape.entry} id ${id}`);
    ids.add(id);
    const text = cell(h.text, `${id} text`);
    if (!visible) return h.path_visible === false ? { id, text, path_visible: false } : fail(`${id} path_visible`);
    if (!Array.isArray(h.paths) || h.paths.length === 0) fail(`${id} paths`);
    const paths = (h.paths as unknown[]).map(p => glob(p, `${id} paths`));
    if (new Set(paths).size !== paths.length) fail(`${id} paths`);
    return { id, text, path_visible: true, paths };
  });
}

export function decodeReviewHazards(value: unknown): ReviewHazardsV1 {
  const hazards = decodePathList(value, { label: 'review hazards', version_key: 'hazards_version', version: REVIEW_HAZARDS_VERSION, list_key: 'hazards', entry: 'hazard' });
  return { hazards_version: REVIEW_HAZARDS_VERSION, hazards };
}

export function decodeReviewHighList(value: unknown): ReviewHighListV1 {
  const signals = decodePathList(value, { label: 'review high list', version_key: 'high_list_version', version: REVIEW_HIGH_LIST_VERSION, list_key: 'signals', entry: 'signal' });
  return { high_list_version: REVIEW_HIGH_LIST_VERSION, signals };
}

/** The packaged lists. A decode failure is a build error; the board and reference-config tests stop it. */
export const REVIEW_HAZARDS: ReviewHazardsV1 = decodeReviewHazards(hazardsJson);
export const REVIEW_HIGH_LIST: ReviewHighListV1 = decodeReviewHighList(highListJson);

/**
 * The High-list signals of invariant I1 (credentials) and I2 (deletion). A hit on
 * one of them, or on a repository I3 path, takes the second review row; another
 * High-list signal alone takes one row (#3190 section 2.3).
 */
const INVARIANT_SIGNALS: readonly ReviewPathEntry[] = ['secrets', 'deletion'].map((id) => {
  const signal = REVIEW_HIGH_LIST.signals.find(entry => entry.id === id);
  if (signal === undefined || !signal.path_visible) throw new Error(`review high list invalid: invariant signal ${id} is missing or not path-visible`);
  return signal;
});

/** `**` matches zero or more whole segments; `*` matches inside one segment. */
function globPattern(glob: string): RegExp {
  const segments = glob.split('/');
  const body = segments.map((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') return last ? '.+' : '(?:[^/]+/)*';
    return segment.replace(/\./gu, '\\.').replace('*', '[^/]*') + (last ? '' : '/');
  }).join('');
  return new RegExp(`^${body}$`, 'u');
}

function pathHits(entries: readonly ReviewPathEntry[], paths: readonly string[]): { readonly id: string; readonly path: string }[] {
  return entries.flatMap((entry) => {
    if (!entry.path_visible) return [];
    const patterns = entry.paths.map(globPattern);
    return paths.filter(path => patterns.some(pattern => pattern.test(path))).map(path => ({ id: entry.id, path }));
  });
}

export interface PathHazardHitV1 {
  readonly hazard: string;
  readonly path: string;
}

/** Hits of repository-relative paths on the path-visible hazards; the other hazards need a reviewer. */
export function pathHazardHits(paths: readonly string[]): PathHazardHitV1[] {
  return pathHits(REVIEW_HAZARDS.hazards, paths).map(hit => ({ hazard: hit.id, path: hit.path }));
}

export interface PathHighHitV1 {
  readonly signal: string;
  readonly path: string;
}

/** Hits of repository-relative paths on the path-visible High signals; a reviewer applies the whole list. */
export function pathHighHits(paths: readonly string[]): PathHighHitV1[] {
  return pathHits(REVIEW_HIGH_LIST.signals, paths).map(hit => ({ signal: hit.id, path: hit.path }));
}

export type ReviewI3PathsRead =
  | { readonly status: 'present'; readonly paths: readonly string[] }
  | { readonly status: 'invalid'; readonly message: string };

/**
 * `review.i3_paths` of a decoded policy: the repository's I3 paths (for example
 * server-side auth, RLS, entitlement or release SQL), as globs of the hazard
 * grammar. An absent key is no I3 path.
 */
export function readReviewI3Paths(document: DecodedWorkflowPolicy): ReviewI3PathsRead {
  let value: unknown;
  try {
    value = policyValue(document, 'review.i3_paths');
  } catch (error) {
    return { status: 'invalid', message: (error as Error).message };
  }
  if (value === POLICY_ABSENT) return { status: 'present', paths: [] };
  if (!Array.isArray(value) || !value.every(isGlob)) return { status: 'invalid', message: 'review.i3_paths must be an array of path globs' };
  if (new Set(value).size !== value.length) return { status: 'invalid', message: 'review.i3_paths has a duplicate glob' };
  return { status: 'present', paths: value };
}

/** Hits of repository-relative paths on the I1/I2 High-list signals and on the I3 globs (id `i3`): the paths that take a second review row. */
export function pathSecondReviewHits(paths: readonly string[], i3Paths: readonly string[]): PathHighHitV1[] {
  const entries: ReviewPathEntry[] = [...INVARIANT_SIGNALS];
  if (i3Paths.length > 0) entries.push({ id: 'i3', text: 'Repository I3 path.', path_visible: true, paths: i3Paths });
  return pathHits(entries, paths).map(hit => ({ signal: hit.id, path: hit.path }));
}

export type WorkflowHazardReason = 'permissions' | 'secrets' | 'pull_request_target' | 'required_job';

export interface WorkflowHazardHitV1 {
  readonly path: string;
  readonly reason: WorkflowHazardReason;
}

/** A workflow file: the paths whose diff lines the board classifies (`workflowHazardHits`). */
export function isWorkflowPath(path: string): boolean {
  return path.startsWith('.github/workflows/');
}

const LINE_HAZARDS: readonly (readonly [WorkflowHazardReason, RegExp])[] = [
  ['permissions', /\bpermissions\s*:/u],
  ['secrets', /\bsecrets\b/u],
  ['pull_request_target', /\bpull_request_target\b/u],
];

const indentOf = (line: string): number => line.length - line.trimStart().length;
const unquote = (value: string): string => value.trim().replace(/^(['"])(.*)\1$/u, '$2');

/** The 1-based head line ranges of the jobs whose `name:` or key is a required status context. */
function requiredJobRanges(lines: readonly string[], required: readonly string[]): (readonly [number, number])[] {
  const jobs = lines.findIndex(line => /^jobs\s*:\s*(?:#.*)?$/u.test(line));
  if (jobs < 0) return [];
  const body = lines.slice(jobs + 1).findIndex(line => line.trim() !== '' && !line.trimStart().startsWith('#'));
  if (body < 0) return [];
  const jobIndent = indentOf(lines[jobs + 1 + body]!);
  const ranges: (readonly [number, number])[] = [];
  for (let start = jobs + 1; start < lines.length; start++) {
    const line = lines[start]!;
    if (line.trim() === '' || line.trimStart().startsWith('#') || indentOf(line) !== jobIndent) continue;
    let end = start;
    while (end + 1 < lines.length && (lines[end + 1]!.trim() === '' || indentOf(lines[end + 1]!) > jobIndent)) end++;
    const key = unquote(line.trim().replace(/:\s*(?:#.*)?$/u, ''));
    const names = lines.slice(start + 1, end + 1).filter(entry => indentOf(entry) > jobIndent && /^\s*name\s*:/u.test(entry))
      .map(entry => unquote(entry.replace(/^\s*name\s*:/u, '').replace(/\s+#.*$/u, '')));
    if (required.includes(key) || names.some(name => required.includes(name))) ranges.push([start + 1, end + 1]);
  }
  return ranges;
}

/**
 * The hazard hits of one workflow file of a pull request diff (#3187): a changed line that touches `permissions:`, `secrets` or
 * `pull_request_target`, or a changed line inside a job that a required status context names. `patch` is the unified diff of the file
 * from the PR files read, `head` the file text at the head (null for a removed file) and `required` the required contexts of the base.
 * Null when the evidence is incomplete: no patch, an unparsable hunk, no required context list, or no head text for a kept file.
 */
export function workflowHazardHits(path: string, patch: string | null, head: string | null, removed: boolean, required: readonly string[] | null): WorkflowHazardHitV1[] | null {
  if (patch === null || required === null || (head === null && !removed)) return null;
  const ranges = head === null ? [] : requiredJobRanges(head.split(/\r?\n/u), required);
  const inJob = (line: number): boolean => ranges.some(([start, end]) => line >= start && line <= end);
  const reasons = new Set<WorkflowHazardReason>();
  let next: number | null = null;
  for (const line of patch.split(/\r?\n/u)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk !== null) { next = Number(hunk[1]); continue; }
    if (next === null) return null;
    const mark = line[0];
    if (mark === '+' || mark === '-') {
      const body = line.slice(1);
      for (const [reason, pattern] of LINE_HAZARDS) if (pattern.test(body)) reasons.add(reason);
      // An added line is head line `next`; a removed line sits between head lines `next - 1` and `next`.
      const inside = mark === '+' ? inJob(next) : inJob(next - 1) || inJob(next);
      const namesRequired = /^\s*name\s*:/u.test(body) && required.includes(unquote(body.replace(/^\s*name\s*:/u, '').replace(/\s+#.*$/u, '')));
      if (inside || namesRequired) reasons.add('required_job');
    }
    if (mark !== '-' && mark !== '\\') next += 1;
  }
  return [...reasons].sort().map(reason => ({ path, reason }));
}
