// Strict decoders for the two path lists of Review by risk: the change hazard
// list (assets/review-hazards.v1.json) and the High list
// (assets/review-high-list.v1.json). scripts/sync-reference-configs.ts renders
// both lists in agentic-development-flow.md; the board rule R3 reads the
// path-visible hazards and R5 the path-visible High signals. The package ships
// both files, so downstream boards read the same lists. Exact keys; an entry
// that a path cannot show has no paths. The hazard list also holds the one
// workflow edit allowlist (#3187): a hit that the board proves on it does not count.

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

/**
 * The edits of one path-visible hazard that do not count as a hit: a modified file on `paths` whose diff changes only YAML keys on or
 * under `keys`. A key glob is dot-separated; `*` matches one key or one list index.
 */
export interface ReviewAllowedEditsV1 {
  readonly hazard: string;
  readonly paths: readonly string[];
  readonly keys: readonly string[];
}

export interface ReviewHazardsV1 {
  readonly hazards_version: typeof REVIEW_HAZARDS_VERSION;
  readonly hazards: readonly ReviewHazard[];
  readonly allowed_edits: ReviewAllowedEditsV1;
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
  readonly extra_keys: readonly string[];
}

function decodePathList(value: unknown, shape: PathListShape): { readonly root: Record<string, unknown>; readonly entries: ReviewPathEntry[] } {
  const fail = (what: string): never => { throw new Error(`${shape.label} invalid: ${what}`); };
  const { obj } = decodeReaders(fail);
  // Text lands in a markdown table cell: one line, no pipe.
  const cell = (v: unknown, what: string): string =>
    (typeof v === 'string' && v.length > 0 && v.length <= 280 && v.trim() === v && !/[\x00-\x1f\x7f|]/u.test(v) ? v : fail(what));
  const glob = (v: unknown, what: string): string => (isGlob(v) ? v : fail(what));

  const root = obj(value, [shape.version_key, shape.list_key, ...shape.extra_keys], 'list');
  if (root[shape.version_key] !== shape.version) fail(shape.version_key);
  const raws = root[shape.list_key];
  if (!Array.isArray(raws) || raws.length === 0) fail(shape.list_key);
  const ids = new Set<string>();
  const entries = (raws as unknown[]).map((raw): ReviewPathEntry => {
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
  return { root, entries };
}

const KEY_GLOB = /^(?:\*|[A-Za-z0-9_-]+)(?:\.(?:\*|[A-Za-z0-9_-]+))*$/u;

export function decodeReviewHazards(value: unknown): ReviewHazardsV1 {
  const fail = (what: string): never => { throw new Error(`review hazards invalid: ${what}`); };
  const { obj } = decodeReaders(fail);
  const { root, entries: hazards } = decodePathList(value, { label: 'review hazards', version_key: 'hazards_version', version: REVIEW_HAZARDS_VERSION, list_key: 'hazards', entry: 'hazard', extra_keys: ['allowed_edits'] });
  const raw = obj(root.allowed_edits, ['hazard', 'paths', 'keys'], 'allowed_edits');
  const owner = hazards.find(hazard => hazard.id === raw.hazard);
  const ownerPaths = owner !== undefined && owner.path_visible ? owner.paths : fail('allowed_edits hazard');
  const list = (v: unknown, valid: (item: unknown) => boolean, what: string): string[] =>
    (Array.isArray(v) && v.length > 0 && v.every(valid) && new Set(v).size === v.length ? v as string[] : fail(what));
  // An allowed path lies under the hazard's own paths, so the allowlist can only narrow that hazard.
  const under = (path: unknown): boolean => isGlob(path) && ownerPaths.some(glob => globPattern(glob).test(path));
  const paths = list(raw.paths, under, 'allowed_edits paths');
  const keys = list(raw.keys, key => typeof key === 'string' && KEY_GLOB.test(key), 'allowed_edits keys');
  return { hazards_version: REVIEW_HAZARDS_VERSION, hazards, allowed_edits: { hazard: raw.hazard as string, paths, keys } };
}

export function decodeReviewHighList(value: unknown): ReviewHighListV1 {
  const { entries: signals } = decodePathList(value, { label: 'review high list', version_key: 'high_list_version', version: REVIEW_HIGH_LIST_VERSION, list_key: 'signals', entry: 'signal', extra_keys: [] });
  return { high_list_version: REVIEW_HIGH_LIST_VERSION, signals };
}

/** The packaged lists. A decode failure is a build error; the board and reference-config tests stop it. */
export const REVIEW_HAZARDS: ReviewHazardsV1 = decodeReviewHazards(hazardsJson);
export const REVIEW_HIGH_LIST: ReviewHighListV1 = decodeReviewHighList(highListJson);

/**
 * The High-list signals of invariant I1 (credentials) and I2 (deletion). A hit on
 * one of them, on a path-visible change hazard or on a repository I3 path takes the
 * second review row; another High-list signal alone takes one row (#3190 section 2.3).
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

/** A hit of the allowlist's hazard on a path that the board proved on the allowlist (`workflowEditAllowed`) does not count. */
function uncleared(hits: readonly { readonly id: string; readonly path: string }[], cleared: readonly string[]): { readonly id: string; readonly path: string }[] {
  return hits.filter(hit => hit.id !== REVIEW_HAZARDS.allowed_edits.hazard || !cleared.includes(hit.path));
}

/**
 * Hits of repository-relative paths on the path-visible hazards; the other hazards need a reviewer. `cleared`: the paths whose diff
 * the board proved on the workflow edit allowlist.
 */
export function pathHazardHits(paths: readonly string[], cleared: readonly string[]): PathHazardHitV1[] {
  return uncleared(pathHits(REVIEW_HAZARDS.hazards, paths), cleared).map(hit => ({ hazard: hit.id, path: hit.path }));
}

const ALLOWED_PATHS = REVIEW_HAZARDS.allowed_edits.paths.map(globPattern);
const ALLOWED_KEYS = REVIEW_HAZARDS.allowed_edits.keys.map(key => key.split('.'));

/** A path whose modification the workflow edit allowlist can clear; the board reads the diff of such a path only. */
export function isAllowedEditPath(path: string): boolean {
  return ALLOWED_PATHS.some(pattern => pattern.test(path));
}

/** The key paths where two parsed YAML values differ: a map key on one side only, a list index past the shorter list, or another value. */
function changedKeys(base: unknown, head: unknown, at: readonly string[]): string[][] {
  // Only a plain mapping recurses; any other object compares by identity, so it reads as changed.
  const map = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
  if (Array.isArray(base) && Array.isArray(head)) {
    return Array.from({ length: Math.max(base.length, head.length) }, (_, index) =>
      (index < base.length && index < head.length ? changedKeys(base[index], head[index], [...at, String(index)]) : [[...at, String(index)]])).flat();
  }
  if (map(base) && map(head)) {
    return [...new Set([...Object.keys(base), ...Object.keys(head)])].flatMap(key =>
      (Object.hasOwn(base, key) && Object.hasOwn(head, key) ? changedKeys(base[key], head[key], [...at, key]) : [[...at, key]]));
  }
  return Object.is(base, head) ? [] : [[...at]];
}

/**
 * True when a modified file on the allowlist paths changes only keys on or under an allowlist key: `base` and `head` are its YAML
 * documents at the merge base and the head commit. The caller passes only a file that it read and parsed at both commits; an added, removed or
 * renamed file is never cleared.
 */
export function workflowEditAllowed(path: string, base: unknown, head: unknown): boolean {
  return isAllowedEditPath(path) && changedKeys(base, head, []).every(key =>
    ALLOWED_KEYS.some(glob => glob.length <= key.length && glob.every((segment, index) => segment === '*' || segment === key[index])));
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

/**
 * Hits of repository-relative paths that take a second review row: the I1/I2 High-list signals, the path-visible change hazards
 * (`.github/**`, except the `cleared` paths) and the I3 globs (id `i3`).
 */
export function pathSecondReviewHits(paths: readonly string[], i3Paths: readonly string[], cleared: readonly string[]): PathHighHitV1[] {
  const entries: ReviewPathEntry[] = [...INVARIANT_SIGNALS, ...REVIEW_HAZARDS.hazards];
  if (i3Paths.length > 0) entries.push({ id: 'i3', text: 'Repository I3 path.', path_visible: true, paths: i3Paths });
  return uncleared(pathHits(entries, paths), cleared).map(hit => ({ signal: hit.id, path: hit.path }));
}
