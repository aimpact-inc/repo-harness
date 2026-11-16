/**
 * The host-config ledger and transaction record. The ledger keeps two levels:
 * a file record per host file and a fragment record per owned text edit.
 * Owner Plan B (#2841): long-term state keeps only hashes, rh's own text edits
 * and the user text that an explicit override replaced; a whole-file preimage
 * exists only inside a transaction record.
 */

export type HostConfigErrorCode =
  | 'host_config_fragment_overlap'
  | 'host_config_target_changed'
  | 'host_config_unresolved_external_change'
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
/** An absolute path under HOME, outside `~/.repo-harness/`, that passed the store's path check. */
export type HostPath = string & { readonly [hostPathBrand]: true };

declare const preimageCopyBrand: unique symbol;
/** `preimage-<n>`: the only file name the gate writes for a preimage copy inside a transaction directory. */
export type PreimageCopyName = string & { readonly [preimageCopyBrand]: true };

export type FileBaseline =
  | { readonly state: 'known'; readonly existed: false }
  | { readonly state: 'known'; readonly existed: true; readonly type: 'file'; readonly mode: number; readonly sha256: Sha256 }
  /** An earlier rh version wrote the path before the ledger existed. */
  | { readonly state: 'unknown' };

export type FileCommitted =
  | { readonly type: 'file'; readonly sha256: Sha256; readonly mode: number; readonly txn: string }
  | { readonly type: 'absent'; readonly txn: string };

export interface FileRecord {
  readonly baseline: FileBaseline;
  readonly committed: FileCommitted;
  /** Sticky: set once content, mode, type or existence differed from `committed`. */
  readonly external_change: boolean;
  /** Directories that an rh transaction created for this file, outermost first. */
  readonly created_dirs: readonly string[];
}

export type FragmentKind = 'add' | 'refresh' | 'override';

/** One text edit. `at` is the offset in the file content that the edit applied to. */
export interface FragmentEdit {
  readonly at: number;
  readonly removed: string;
  readonly inserted: string;
}

/** An override keeps the replaced user text in the vault, not a second copy in the ledger. */
export type StoredFragmentEdit =
  | FragmentEdit
  | { readonly at: number; readonly removed_vault: Sha256; readonly inserted: string };

export interface FragmentRecord {
  readonly file: string;
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentKind;
  readonly edit: StoredFragmentEdit;
  readonly state: 'active';
}

export interface HostConfigLedger {
  readonly protocol: 1;
  readonly committed_transactions: readonly string[];
  readonly files: Readonly<Record<string, FileRecord>>;
  readonly fragments: readonly FragmentRecord[];
}

export const EMPTY_LEDGER: HostConfigLedger = { protocol: 1, committed_transactions: [], files: {}, fragments: [] };

/** The observed state of one path. Only regular files are writable targets. */
export type FileObservation =
  | { readonly existed: false }
  | { readonly existed: true; readonly type: 'file'; readonly mode: number; readonly sha256: Sha256 }
  | { readonly existed: true; readonly type: 'directory' | 'symlink' | 'other' };

/** The expected state of a path: absent, or a regular file with this hash and mode. */
export type ExpectedFile = { readonly existed: false } | { readonly existed: true; readonly mode: number; readonly sha256: Sha256 };

export interface TransactionFileEntry {
  readonly path: HostPath;
  readonly preimage: ExpectedFile;
  /** File name inside the transaction directory; null when the preimage is absent. */
  readonly preimage_copy: PreimageCopyName | null;
  /**
   * A delegated write starts with null, because the gate does not know the
   * result in advance. After the writer runs, the gate records the observed
   * result, or `unchanged` when the path is still its preimage; settlement
   * never touches an `unchanged` path.
   */
  readonly intended: ExpectedFile | 'unchanged' | null;
  /** Written before the first mkdir, outermost first. */
  readonly created_dirs: readonly HostPath[];
}

export interface TransactionRecord {
  readonly protocol: 1;
  readonly txn: string;
  readonly intended: 'write' | 'delegated';
  /** Diagnosis only. No decision reads it. */
  readonly stage: string;
  readonly files: readonly TransactionFileEntry[];
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
  /** An override applies only with an explicit selection in the plan input. */
  readonly selected?: boolean;
}

export interface SkippedOverride {
  readonly code: 'host_config_override_skipped';
  readonly file: string;
  readonly owner: string;
  readonly selector: string;
}
