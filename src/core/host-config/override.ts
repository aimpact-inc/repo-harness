/**
 * The user's override selection (`--override <path>#<selector>`, #2851): the
 * fragments that may replace a value that rh did not write. The CLI parses
 * each argument once and resolves its path with the host-path resolver; this
 * module holds the data and its lookups and reads no file.
 */
export interface OverrideEntry {
  /** The host path with its links followed. */
  readonly path: string;
  readonly selector: string;
}

export type OverrideSelection = readonly OverrideEntry[];

export const NO_OVERRIDES: OverrideSelection = [];

/** Splits `<path>#<selector>` at the last `#`: a selector has no `#`, a path can. */
export function parseOverride(raw: string): OverrideEntry {
  const at = raw.lastIndexOf('#');
  const path = at < 0 ? '' : raw.slice(0, at);
  const selector = at < 0 ? '' : raw.slice(at + 1);
  if (!path || !selector) throw new Error(`--override needs <path>#<selector>: ${JSON.stringify(raw)}`);
  return { path, selector };
}

export function formatOverride(entry: OverrideEntry): string {
  return `${entry.path}#${entry.selector}`;
}

/** True when the selection names the fragment at `selector` of the resolved `path`. */
export function selected(selection: OverrideSelection, path: string, selector: string): boolean {
  return selection.some((entry) => entry.path === path && entry.selector === selector);
}

/** The entries that no offered request carries: `offered` lists each resolved path with the selectors of its requests. */
export function unmatchedOverrides(
  selection: OverrideSelection,
  offered: readonly { readonly path: string; readonly selectors: readonly string[] }[],
): OverrideEntry[] {
  return selection.filter((entry) => !offered.some((file) => file.path === entry.path && file.selectors.includes(entry.selector)));
}
