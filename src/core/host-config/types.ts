/**
 * The host-config ledger. It keeps two levels: a file record per host file
 * that rh wrote, and a fragment record per owned text edit. Owner Plan B
 * (#2841): long-term state keeps hashes, rh's own text, and whole-file
 * backups of the user bytes before rh wrote over them. The threat model is accidents (#2841
 * Decisions): user links are followed.
 */

export type HostConfigErrorCode =
  | 'host_config_fragment_overlap'
  | 'host_config_target_changed'
  | 'host_config_invalid_path'
  | 'host_config_invalid_state'
  | 'host_config_replacement_refused'
  | 'host_config_repository_unrecorded'
  | 'host_config_restore_mismatch'
  | 'host_config_unparseable_target';

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
 * How rh first wrote the file: `created` (a new file, a revert removes it) or
 * `text_block` (`apply` edited a user file; a revert restores the backup when
 * the record has one).
 */
export type FileRecordKind = 'created' | 'text_block';

/**
 * When `apply` puts the whole file into the vault: `whole-file` before any
 * write over bytes that rh did not write last; `overrides-only` only when a
 * fragment replaces such bytes, so a file that rh only adds to keeps no copy
 * and a revert removes rh's fragments instead.
 */
export type HostConfigBackupPolicy = 'whole-file' | 'overrides-only';

export type FileCommitted =
  | { readonly type: 'file'; readonly sha256: Sha256 }
  | { readonly type: 'absent' };

export interface FileRecord {
  readonly kind: FileRecordKind;
  readonly baseline: FileBaseline;
  /**
   * The file as rh last wrote it, or as it was when rh last recorded a
   * fragment in it. A revert acts only while the file still hashes to it.
   */
  readonly committed: FileCommitted;
  /**
   * Vault reference of the whole file before rh first wrote over bytes that
   * rh did not write (or the adopted state before rh); null for `created` and
   * for a `text_block` that rh only added to under `overrides-only`. It is the
   * restore target and never changes while the record lives.
   */
  readonly backup: Sha256 | null;
  /** Vault reference of the file as an outside edit left it, from the last rh write over it; for the report, never a restore target. */
  readonly external_backup?: Sha256;
  /** Sticky: set once the file differed from `committed` when rh wrote it again. */
  readonly external_change: boolean;
  /**
   * The format of the file's fragments, from the name of the path that rh was
   * asked to write: a linked config can have a target with no extension.
   * Absent on older records and on a file that no name gives a format.
   */
  readonly format?: FileFormat;
}

/** The fragment formats that a file name decides; a marked-block selector names its own format. */
export type FileFormat = 'toml' | 'json';

export type FragmentKind = 'add' | 'refresh' | 'override';

/** One text edit. `at` is the offset in the content that the edit applies to. */
export interface FragmentEdit {
  readonly at: number;
  readonly removed: string;
  readonly inserted: string;
}

export interface FragmentRecord {
  readonly file: string;
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentKind;
  /** The text rh wrote at the selector: a refresh over other text is a user's change. Empty when rh's text is not known: the fragment stays. */
  readonly inserted: string;
  /** A leading line break in `inserted` that rh cannot prove it wrote; a TOML removal or restore keeps it. Absent on older records. */
  readonly separator?: '\n' | '\r\n';
  /** The outermost container that rh's insert created on the selector's path; a revert removes an emptied container only on this proof. */
  readonly created?: string;
  /** For a fragment that the one-shot migration adopted: its text when adopted, kept across refreshes so that a refreshed value stays recoverable. */
  readonly preimage?: string;
}

/** The host root that a path record lives under, from the path before links are followed: an uninstall selects by it. */
export type PathRecordHost = 'claude' | 'codex' | 'pi' | 'staged' | 'bin';

/**
 * `created`: an install wrote the whole path and an uninstall removes it while
 * it is current. `replaced`: rh wrote a file over a user file on the user's
 * word (`--force`); the user file is in the vault, and a revert puts it back
 * while the path still holds what rh wrote. `user_managed`: the user keeps the
 * file; rh never writes or removes it, and dropping the record releases it.
 */
export type PathRecordKind = 'created' | 'replaced' | 'user_managed';

export type PathCommitted =
  | { readonly type: 'file'; readonly sha256: Sha256 }
  | { readonly type: 'symlink'; readonly target: string }
  /** `hashManagedTree` of the directory. */
  | { readonly type: 'directory'; readonly sha256: Sha256 }
  /** A Herdr skill: Herdr rewrites it, so its marker proof (`ownedSkillIsIntact`) and not a tree hash shows it is rh's. */
  | { readonly type: 'directory'; readonly proof: 'herdr-skill-marker' };

/** A whole path that an install owns: a skill directory, a link, a CLI link or a generated file. */
export interface PathRecord {
  /** `core` or the plugin id. */
  readonly owner: string;
  readonly host: PathRecordHost;
  readonly kind: PathRecordKind;
  readonly baseline: FileBaseline;
  /** The path as rh last recorded it; a removal acts only while the path still matches it. */
  readonly committed: PathCommitted;
  /** Vault reference of the user file that a `replaced` record replaced; only `replaced` has it. */
  readonly backup?: Sha256;
  /**
   * The file that a user link at the key names, links followed. A `created`
   * or `replaced` file record with it acts on this file and keeps the link;
   * `committed` is the hash of this file. Absent: the key is the entry.
   */
  readonly link_target?: string;
}

/** Vault material that a finished revert released; `rh config gc` deletes it 30 days after `at` while no record references it. */
export interface RetiredMaterial {
  readonly sha256: Sha256;
  /** ISO 8601 time of the revert. */
  readonly at: string;
}

/** The whole file before `rh uninstall --remove-edited-block` took out a block that the user edited: it holds user bytes, so GC keeps it. */
export interface RecoveryCopy {
  readonly file: string;
  readonly sha256: Sha256;
  readonly at: string;
}

/** The shared tools that rh installs outside the host roots: they serve both hosts. */
export type ToolId = 'herdr-core' | 'bun';

/**
 * The entry that rh appended to the Windows user `Path` value
 * (`HKCU\Environment`). A revert takes out `inserted` only while exactly one
 * entry equals `entry`, and deletes the value only when rh created it.
 */
export interface UserPathEntryRecord {
  /** The directory as rh wrote it. */
  readonly entry: string;
  /** The exact text that rh appended: `;<entry>`, or `<entry>` after an empty value or a trailing `;`. */
  readonly inserted: string;
  readonly kind: UserPathValueKind;
  /** False: the `Path` value did not exist before rh created it. */
  readonly value_existed: boolean;
}

export type UserPathValueKind = 'String' | 'ExpandString';

/** A line block that an installer appended to a shell profile; rh never removes it. */
export interface ProfileTextRecord {
  readonly file: string;
  readonly inserted: string;
}

/**
 * A shared tool that an rh run installed. Each path is a whole entry that
 * the run created; an entry that existed before is never in a record.
 * `rh uninstall` keeps the tools; an entry that is gone loses its record.
 */
export interface ToolRecord {
  /** `rh-install`: `rh install` or `rh update`; `rh-bootstrap`: install.sh or install.ps1. */
  readonly installed_by: 'rh-install' | 'rh-bootstrap';
  readonly version: string;
  /**
   * Keyed by `hostPathKey`. `identity` (`observeEntryIdentity` when the run
   * wrote the entry) ties the claim to that file-system object: an identical
   * copy that replaced it, such as a copy in place of the Windows `hc.exe`
   * hard link, is another object and is not rh's. A record with no identity
   * (the Bun bootstrap) grants no removal.
   */
  readonly paths: Readonly<Record<string, { readonly committed: PathCommitted; readonly identity?: string }>>;
  /** Directories that the run created, for a removal innermost first. */
  readonly directories: readonly string[];
  readonly path_entry?: UserPathEntryRecord;
  readonly profile?: ProfileTextRecord;
  /** Registry keys that the installer wrote, for the report (the Bun `Uninstall\\Bun` key); rh never removes them. */
  readonly registry_keys?: readonly string[];
  /** False for Bun: no command removes it. */
  readonly removable: boolean;
}

/**
 * Protocol 2 added `paths` (#2896); protocol 3 adds `retired` and `recovery`
 * (#2851); protocol 4 adds `tools` (#2853). `migrateLedgerSchema` moves an
 * older ledger once at a mutating entry.
 */
export const HOST_CONFIG_LEDGER_PROTOCOL = 4;

export interface HostConfigLedger {
  readonly protocol: typeof HOST_CONFIG_LEDGER_PROTOCOL;
  readonly files: Readonly<Record<string, FileRecord>>;
  readonly fragments: readonly FragmentRecord[];
  /** Directories that rh created and did not remove yet; a revert drops one only when it removes it. */
  readonly directories: readonly string[];
  /** Keyed by the path with its parent links followed and the leaf kept (`hostPathKey`). The gate refuses a path that has one. */
  readonly paths: Readonly<Record<string, PathRecord>>;
  readonly retired: readonly RetiredMaterial[];
  readonly recovery: readonly RecoveryCopy[];
  /** No key of a tool path is also a key of `files` or `paths`; the gate refuses a write to it. */
  readonly tools: Readonly<Partial<Record<ToolId, ToolRecord>>>;
}

export const EMPTY_LEDGER: HostConfigLedger = { protocol: HOST_CONFIG_LEDGER_PROTOCOL, files: {}, fragments: [], directories: [], paths: {}, retired: [], recovery: [], tools: {} };

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
  /** The outermost container that an insert at the selector would create in the content; null when there is none. */
  created?(content: string, selector: string): string | null;
}

export interface FragmentRequest<V = unknown> {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentKind;
  readonly strategy: HostConfigStrategy<V>;
  readonly value: V;
  /** An override, a refresh over a user's change, or a refresh with no recorded fragment applies only with this explicit selection. */
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
