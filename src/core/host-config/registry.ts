import { jsonFragment, jsonDocumentIsEmpty, jsonFragmentValue, removeJsonFragment } from './json-fragment';
import { isMarkedBlockSelector, markedBlock, markedBlockDocumentIsEmpty, removeMarkedBlock } from './marked-block';
import { tomlFragment } from './toml-fragment';
import type { FileFormat, FragmentEdit, FragmentRecord, HostConfigStrategy } from './types';

/** How the gate finds, and takes out, a recorded fragment in a file of one format. */
export interface FragmentFormat {
  readonly strategy: HostConfigStrategy<any>;
  /** The edit that takes the fragment at the selector out of the content; `records` are the file's records that may prove a container rh created. */
  remove(content: string, selector: string, records: readonly FragmentRecord[]): FragmentEdit;
  /** The edit that sets the fragment at the selector back to its text in `backup`; a removal when `backup` does not hold it. */
  restore(content: string, selector: string, backup: string, records: readonly FragmentRecord[]): FragmentEdit;
  /** True when nothing but an empty document is left. */
  empty(content: string): boolean;
}

function editTomlFragment(content: string, selector: string, value: string, records: readonly FragmentRecord[]): FragmentEdit {
  const separator = records.find((record) => record.selector === selector)?.separator;
  if (separator === undefined) return tomlFragment.apply(content, selector, value);
  const edit = tomlFragment.apply(content, selector, '');
  // The backup span can include its own leading separator. Keep the current one once,
  // and restore the table's exact bytes, including a final line break.
  return { ...edit, inserted: separator + value.replace(/^\r?\n/, '') };
}

const TOML: FragmentFormat = {
  strategy: tomlFragment,
  remove: (content, selector, records) => editTomlFragment(content, selector, '', records),
  restore: (content, selector, backup, records) => {
    const range = tomlFragment.locate(backup, selector);
    return editTomlFragment(content, selector, range ? backup.slice(range.start, range.end) : '', records);
  },
  empty: (content) => content.trim() === '',
};

const JSON_FORMAT: FragmentFormat = {
  strategy: jsonFragment,
  remove: removeJsonFragment,
  restore: (content, selector, backup, records) => {
    const before = jsonFragment.locate(backup, selector);
    if (!before) return removeJsonFragment(content, selector, records);
    // In place, the backup's own bytes come back, so a full revert can equal the file before rh.
    const range = jsonFragment.locate(content, selector);
    if (range) return { at: range.start, removed: content.slice(range.start, range.end), inserted: backup.slice(before.start, before.end) };
    return jsonFragment.apply(content, selector, jsonFragmentValue(backup, selector));
  },
  empty: jsonDocumentIsEmpty,
};

const MARKED_BLOCK: FragmentFormat = {
  strategy: markedBlock,
  remove: (content, selector) => removeMarkedBlock(content, selector),
  restore: (content, selector, backup) => {
    const range = markedBlock.locate(backup, selector);
    return range ? markedBlock.apply(content, selector, backup.slice(range.start, range.end)) : removeMarkedBlock(content, selector);
  },
  empty: markedBlockDocumentIsEmpty,
};

/** The format that a file name gives; rh records it at write time from the name that it was asked to write. */
export function fileFormatOf(path: string): FileFormat | undefined {
  if (path.endsWith('.toml')) return 'toml';
  if (path.endsWith('.json')) return 'json';
  return undefined;
}

/**
 * The runtime-state block of a repository exclude file (#3080). Emptiness
 * after a per-fragment revert never removes the file: that revert runs only
 * after an outside change, so rh cannot prove that the remaining bytes, also
 * blank lines, are its own. The whole-file revert of an unchanged file that
 * rh created still removes it.
 */
const RUNTIME_STATE_BLOCK: FragmentFormat = { ...MARKED_BLOCK, empty: () => false };

const FILE_FORMATS: Readonly<Record<FileFormat, FragmentFormat>> = { toml: TOML, json: JSON_FORMAT };

/**
 * The format of a fragment: a marked-block selector names its format, because
 * a linked rules file can have any name; else the file's format decides. Null
 * for a fragment that no strategy owns.
 */
export function fragmentFormat(format: FileFormat | undefined, selector: string): FragmentFormat | null {
  if (selector === 'runtime-state') return RUNTIME_STATE_BLOCK;
  if (isMarkedBlockSelector(selector)) return MARKED_BLOCK;
  return format ? FILE_FORMATS[format] : null;
}
