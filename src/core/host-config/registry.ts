import { jsonFragment, jsonDocumentIsEmpty, removeJsonFragment } from './json-fragment';
import { tomlFragment } from './toml-fragment';
import type { FragmentEdit, HostConfigStrategy } from './types';

/** How the gate finds, and takes out, a recorded fragment in a file of one format. */
export interface FragmentFormat {
  readonly strategy: HostConfigStrategy<any>;
  /** The edit that takes the fragment at the selector out of the content. */
  remove(content: string, selector: string): FragmentEdit;
  /** True when nothing but an empty document is left. */
  empty(content: string): boolean;
}

const TOML: FragmentFormat = {
  strategy: tomlFragment,
  remove: (content, selector) => tomlFragment.apply(content, selector, ''),
  empty: (content) => content.trim() === '',
};

const JSON_FORMAT: FragmentFormat = {
  strategy: jsonFragment,
  remove: removeJsonFragment,
  empty: jsonDocumentIsEmpty,
};

/** The format of a host file follows from its name; null for a file that no strategy owns. */
export function fragmentFormat(path: string): FragmentFormat | null {
  if (path.endsWith('.toml')) return TOML;
  if (path.endsWith('.json')) return JSON_FORMAT;
  return null;
}
