import type { UserPathEntryRecord, UserPathValueKind } from './types';

/**
 * The Windows user `Path` value as text (#2853 T4): the raw value with its
 * environment names unexpanded, its registry kind, and whether it exists.
 * These rules compute the next value; the caller reads and writes the registry.
 */
export interface UserPathValue {
  readonly existed: boolean;
  readonly kind: UserPathValueKind;
  readonly raw: string;
}

/** Reads and writes the user `Path` value; `write` changes it only while it still equals `expected`, and deletes it for `existed: false`. */
export interface UserPathPort {
  read(): UserPathValue;
  write(expected: UserPathValue, next: UserPathValue): void;
}

const normalized = (entry: string): string => entry.trim().replace(/\\+$/u, '').toLowerCase();

/** The match of install.ps1: no case, and surrounding space and a trailing backslash ignored. */
export function listsUserPathEntry(raw: string, entry: string): boolean {
  return raw.split(';').some((part) => normalized(part) === normalized(entry));
}

/** Append the entry and keep every other byte: no `;` after an empty value or a trailing `;`. */
export function insertUserPathEntry(value: UserPathValue, entry: string): { readonly next: UserPathValue; readonly record: UserPathEntryRecord } {
  const inserted = value.raw === '' || value.raw.endsWith(';') ? entry : `;${entry}`;
  return {
    next: { existed: true, kind: value.kind, raw: value.raw + inserted },
    record: { entry, inserted, kind: value.kind, value_existed: value.existed },
  };
}

/**
 * The value without the entry that rh appended, or null when the value no
 * longer holds it as rh wrote it: the kind changed, or not exactly one entry
 * equals the recorded text byte for byte. The `;` that rh wrote goes with the
 * entry, and every other byte stays. A value that rh created and that is now
 * empty is deleted.
 */
export function removeUserPathEntry(value: UserPathValue, record: UserPathEntryRecord): UserPathValue | null {
  if (!value.existed || value.kind !== record.kind) return null;
  const parts = value.raw.split(';');
  const matches = parts.flatMap((part, index) => (part === record.entry ? [index] : []));
  if (matches.length !== 1) return null;
  const index = matches[0]!;
  let start = parts.slice(0, index).reduce((offset, part) => offset + part.length + 1, 0);
  let end = start + record.entry.length;
  if (record.inserted.startsWith(';') && index > 0) start -= 1;
  else if (end < value.raw.length) end += 1;
  const raw = value.raw.slice(0, start) + value.raw.slice(end);
  return { existed: raw !== '' || record.value_existed, kind: value.kind, raw };
}
