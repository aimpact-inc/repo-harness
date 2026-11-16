/**
 * The host-config ledger. It keeps two levels: a file record per host file
 * that rh wrote, and a fragment record per owned text edit. Owner Plan B
 * (#2841): long-term state keeps hashes, rh's own text edits, and backups of
 * the user bytes that rh replaced. The threat model is accidents (#2841
 * Decisions): user links are followed.
 */

export type HostConfigErrorCode =
  | 'host_config_fragment_overlap'
  | 'host_config_target_changed'
  | 'host_config_invalid_path'
  | 'host_config_invalid_state';

export class HostConfigError extends Error {
  constructor(readonly code: HostConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HostConfigError';
  }
}

/** `sha256:<hex>` of the exact bytes. */
export type Sha256 = string;

declare const hostPathBrand: unique symbol;
/** A path with the user's links followed, outside `~/.repo-harness/`. */
export type HostPath = string & { readonly [hostPathBrand]: true };

export type FileBaseline =
  | { readonly state: 'known'; readonly existed: false }
  | { readonly state: 'known'; readonly existed: true; readonly sha256: Sha256 }
  /** An earlier rh version wrote the path before the ledger existed. */
  | { readonly state: 'unknown' };

/**
 * What a revert does with the file: `created` removes the file rh created,
 * `text_block` removes rh's text from a user file, `replaced` restores the
 * backup of the user file that a writer replaced.
 */
export type FileRecordKind = 'created' | 'text_block' | 'replaced';

export type FileCommitted =
  | { readonly type: 'file'; readonly sha256: Sha256 }
  | { readonly type: 'absent' };

export interface FileRecord {
  readonly kind: FileRecordKind;
  readonly baseline: FileBaseline;
  /**
   * The file as rh last wrote it, or as it was when rh last recorded a
   * fragment in it. Fragment offsets refer to these bytes; a revert acts only
   * while the file still hashes to them.
   */
  readonly committed: FileCommitted;
  /** Vault reference of the bytes that rh did not write and that a delegated writer then replaced; required for `replaced`. */
  readonly backup: Sha256 | null;
  /** Sticky: set once the file differed from `committed` when rh wrote it again. */
  readonly external_change: boolean;
}

export type FragmentKind = 'add' | 'refresh' | 'override';

/** One text edit. `at` is the offset in the content that the edit applies to. */
export interface FragmentEdit {
  readonly at: number;
  readonly removed: string;
  readonly inserted: string;
}

/**
 * A recorded edit: rh's inserted text and the text it replaced. An override
 * keeps the replaced user text in the vault, not a second copy in the ledger.
 */
export type StoredFragmentEdit =
  | { readonly removed: string; readonly inserted: string }
  | { readonly removed_vault: Sha256; readonly inserted: string };

export interface FragmentRecord {
  readonly file: string;
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentKind;
  /**
   * Offset of the inserted text in the committed bytes; null when a write over
   * a user edit lost it. A file's records are in the text order of the file,
   * so records at one offset keep the order of their original text.
   */
  readonly at: number | null;
  readonly edit: StoredFragmentEdit;
}

export interface HostConfigLedger {
  readonly protocol: 1;
  readonly files: Readonly<Record<string, FileRecord>>;
  readonly fragments: readonly FragmentRecord[];
  /** Directories that rh created and did not remove yet; a revert drops one only when it removes it. */
  readonly directories: readonly string[];
}

export const EMPTY_LEDGER: HostConfigLedger = { protocol: 1, files: {}, fragments: [], directories: [] };

/** The observed state of one path. Only regular files are writable targets. */
export type FileObservation =
  | { readonly existed: false }
  | { readonly existed: true; readonly type: 'file'; readonly sha256: Sha256 }
  | { readonly existed: true; readonly type: 'directory' | 'symlink' | 'other' };

/** The expected state of a path: absent, or a regular file with this hash. */
export type ExpectedFile = { readonly existed: false } | { readonly existed: true; readonly sha256: Sha256 };

export function matchesExpected(observed: FileObservation, expected: ExpectedFile): boolean {
  if (!expected.existed) return !observed.existed;
  return observed.existed && observed.type === 'file' && observed.sha256 === expected.sha256;
}

export function sameExpected(a: ExpectedFile, b: ExpectedFile): boolean {
  return a.existed ? b.existed && a.sha256 === b.sha256 : !b.existed;
}

export function expectedFromCommitted(committed: FileCommitted): ExpectedFile {
  return committed.type === 'absent' ? { existed: false } : { existed: true, sha256: committed.sha256 };
}

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * A strategy owns one file format. It locates a fragment by its selector and
 * returns the text edit that sets the fragment; it never writes a file.
 */
export interface HostConfigStrategy<V = unknown> {
  locate(content: string, selector: string): TextRange | null;
  apply(content: string, selector: string, value: V): FragmentEdit;
}

export interface FragmentRequest<V = unknown> {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentKind;
  readonly strategy: HostConfigStrategy<V>;
  readonly value: V;
  /** An override, or a refresh over a user's change, applies only with this explicit selection. */
  readonly selected?: boolean;
}

/**
 * A fragment that the plan input did not select: an override, or a refresh
 * over a value that the user changed at the recorded selector.
 */
export interface SkippedOverride {
  readonly code: 'host_config_override_skipped' | 'host_config_user_value_kept';
  readonly file: string;
  readonly owner: string;
  readonly selector: string;
}
