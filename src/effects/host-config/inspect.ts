import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { fragmentFormat } from '../../core/host-config/registry';
import { HostConfigError, type FileRecord, type FragmentRecord, type HostConfigLedger, type Sha256 } from '../../core/host-config/types';
import { globalRuntimeScope, runtimeTransactionRoot } from '../locking/runtime-transaction-lock';
import { pathRecordIsCurrent } from './path-records';
import { hostConfigPaths, observeFile, readLedger, resolveHostPath, writeLedger, type HostConfigPaths } from './store';

/**
 * Read-only views of the host-config ledger for `rh config`, and the GC of
 * retired vault copies. A view never prints a value that rh cannot prove it
 * wrote (owner decision D6 on #2851): a user value is its size and hash only.
 * A view reads the ledger strictly and creates no vault or lock.
 */

/** `missing` when the file is absent, `other` when it is not a regular file. */
export type CurrentFile = Sha256 | 'missing' | 'other';

export interface FragmentStatus {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentRecord['kind'];
  /** `rh`: the file holds the text rh recorded. `changed`: other text. `absent`: no text at the selector. `unreadable`: the strategy cannot read the file. */
  readonly state: 'rh' | 'changed' | 'absent' | 'unreadable';
}

export interface FileStatus {
  readonly path: string;
  readonly current: CurrentFile;
  /** `unknown` when an earlier rh version wrote the file before the ledger existed. */
  readonly baseline: Sha256 | 'missing' | 'unknown';
  /** The file is as rh last wrote it. */
  readonly committed: boolean;
  readonly externalChange: boolean;
  readonly fragments: readonly FragmentStatus[];
}

export interface PathStatus {
  readonly path: string;
  readonly owner: string;
  readonly kind: string;
  readonly current: boolean;
}

export interface ConfigStatus {
  readonly ledger: string;
  readonly files: readonly FileStatus[];
  readonly paths: readonly PathStatus[];
  /** Vault paths of the whole-file copies that `--remove-edited-block` made. */
  readonly recovery: readonly { readonly file: string; readonly copy: string; readonly at: string }[];
  readonly retired: number;
  /** Old global-context backups: listed only, never read or used as a baseline. */
  readonly baselineCandidates: readonly string[];
}

function currentOf(path: string): { current: CurrentFile; bytes: Buffer | null } {
  const { observation, bytes } = observeFile(path);
  if (!observation.existed) return { current: 'missing', bytes: null };
  return observation.type === 'file' ? { current: observation.sha256, bytes } : { current: 'other', bytes: null };
}

function decoded(bytes: Buffer | null): string | null {
  if (bytes === null) return null;
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

/** The text at the selector: null when absent, undefined when the file cannot be read by its strategy. */
function located(path: string, content: string | null, selector: string): string | null | undefined {
  const format = fragmentFormat(path, selector);
  if (content === null || format === null) return undefined;
  try {
    const range = format.strategy.locate(content, selector);
    return range ? content.slice(range.start, range.end) : null;
  } catch (error) {
    if (error instanceof HostConfigError) return undefined;
    throw error;
  }
}

function fragmentState(text: string | null | undefined, record: FragmentRecord): FragmentStatus['state'] {
  if (text === undefined) return 'unreadable';
  if (text === null) return 'absent';
  return record.inserted !== '' && text === record.inserted ? 'rh' : 'changed';
}

function baselineOf(record: FileRecord): FileStatus['baseline'] {
  if (record.baseline.state === 'unknown') return 'unknown';
  return record.baseline.existed ? record.baseline.sha256 : 'missing';
}

function committedMatches(record: FileRecord, current: CurrentFile): boolean {
  return record.committed.type === 'absent' ? current === 'missing' : record.committed.sha256 === current;
}

function vaultPath(paths: HostConfigPaths, reference: Sha256): string {
  return join(paths.vault, reference.slice('sha256:'.length));
}

export function configStatus(env: NodeJS.ProcessEnv): ConfigStatus {
  const paths = hostConfigPaths(env);
  const ledger = readLedger(paths);
  const files = Object.entries(ledger.files).map(([path, record]): FileStatus => {
    const { current, bytes } = currentOf(path);
    const content = decoded(bytes);
    return {
      path, current, baseline: baselineOf(record), committed: committedMatches(record, current), externalChange: record.external_change,
      fragments: ledger.fragments.filter((entry) => entry.file === path)
        .map((entry) => ({ owner: entry.owner, selector: entry.selector, kind: entry.kind, state: fragmentState(located(path, content, entry.selector), entry) })),
    };
  });
  const backups = join(paths.harness, 'global-context-backups');
  return {
    ledger: paths.ledger,
    files,
    paths: Object.entries(ledger.paths).map(([path, record]) => ({ path, owner: record.owner, kind: record.kind, current: pathRecordIsCurrent(path, record) })),
    recovery: ledger.recovery.map((entry) => ({ file: entry.file, copy: vaultPath(paths, entry.sha256), at: entry.at })),
    retired: ledger.retired.length,
    baselineCandidates: existsSync(backups) ? readdirSync(backups).filter((name) => name.endsWith('.bak')).sort().map((name) => join(backups, name)) : [],
  };
}

/** A value with no proof that rh wrote it: its size and hash only. */
export function userValue(text: string): string {
  return `<user value, ${Buffer.byteLength(text, 'utf8')} bytes, ${sha256Prefixed(Buffer.from(text, 'utf8'))}>`;
}

export interface FragmentDiff {
  readonly owner: string;
  readonly selector: string;
  readonly kind: FragmentRecord['kind'];
  readonly state: FragmentStatus['state'];
  readonly rh: Sha256 | null;
  readonly current: Sha256 | null;
  /** With `showValues` only: rh's text when the ledger proves rh wrote what the file holds, else `userValue`; null when the file holds no text there. */
  readonly value?: string | null;
}

/**
 * The ledger proves that rh wrote the text: the file holds the recorded text,
 * and the record is not a migration's adopted text (`preimage` equal to it),
 * which an earlier rh version or the user may have written.
 */
function provedRhText(record: FragmentRecord, text: string): boolean {
  return record.inserted !== '' && text === record.inserted && record.preimage !== record.inserted;
}

export function configDiff(env: NodeJS.ProcessEnv, target: string, options: { readonly showValues?: boolean } = {}): { readonly path: string; readonly fragments: readonly FragmentDiff[] } {
  const paths = hostConfigPaths(env);
  const path = resolveHostPath(paths, target);
  const ledger = readLedger(paths);
  if (!ledger.files[path]) throw new HostConfigError('host_config_invalid_state', `rh has no record of this file: ${path}`);
  const content = decoded(currentOf(path).bytes);
  const hash = (text: string) => sha256Prefixed(Buffer.from(text, 'utf8'));
  const fragments = ledger.fragments.filter((entry) => entry.file === path).map((entry): FragmentDiff => {
    const text = located(path, content, entry.selector);
    const diff = { owner: entry.owner, selector: entry.selector, kind: entry.kind, state: fragmentState(text, entry),
      rh: entry.inserted === '' ? null : hash(entry.inserted), current: typeof text === 'string' ? hash(text) : null };
    if (!options.showValues) return diff;
    return { ...diff, value: typeof text !== 'string' ? null : provedRhText(entry, text) ? text : userValue(text) };
  });
  return { path, fragments };
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Every vault copy that a live record still needs. */
function liveReferences(ledger: HostConfigLedger): Set<Sha256> {
  const live = new Set<Sha256>();
  for (const record of Object.values(ledger.files)) {
    if (record.backup) live.add(record.backup);
    if (record.external_backup) live.add(record.external_backup);
  }
  for (const record of Object.values(ledger.paths)) if (record.backup) live.add(record.backup);
  for (const entry of ledger.recovery) live.add(entry.sha256);
  return live;
}

export interface GcResult {
  /** Vault paths deleted (or, in a dry run, to delete). */
  readonly deleted: readonly string[];
  /** Retired entries younger than 30 days. */
  readonly waiting: number;
}

/**
 * A kept install transaction (incomplete, or of an earlier rh version) holds
 * a ledger snapshot that a rollback restores, and its records can reference a
 * copy that the current ledger retired. GC waits until no such transaction is
 * left (owner decision on #2851).
 */
function keptTransactions(env: NodeJS.ProcessEnv): string[] {
  const root = runtimeTransactionRoot(globalRuntimeScope(env));
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name.startsWith('install-') || entry.name.startsWith('.staging-')))
    .map((entry) => join(root, entry.name));
}

/**
 * Delete the vault copy of each retired entry 30 days after its revert, unless
 * a record references it again. Only retired entries are candidates: an
 * orphan copy, an unknown vault file and a recovery copy stay. The caller
 * holds the runtime lock.
 */
export function collectRetired(env: NodeJS.ProcessEnv, options: { readonly now?: Date; readonly dryRun?: boolean } = {}): GcResult {
  const kept = keptTransactions(env);
  if (kept.length) throw new HostConfigError('host_config_invalid_state', `a kept install transaction can still need retired vault copies: ${kept.join(', ')}; finish or remove it, then run rh config gc again`);
  const paths = hostConfigPaths(env);
  const ledger = readLedger(paths);
  const now = (options.now ?? new Date()).getTime();
  const live = liveReferences(ledger);
  const due = ledger.retired.filter((entry) => now - Date.parse(entry.at) >= RETENTION_MS);
  const deleted = due.filter((entry) => !live.has(entry.sha256)).map((entry) => vaultPath(paths, entry.sha256));
  if (options.dryRun || !due.length) return { deleted, waiting: ledger.retired.length - due.length };
  // The ledger drops the entries first: a stop before the deletion leaves an orphan copy, never a record of a missing one.
  writeLedger(paths, { ...ledger, retired: ledger.retired.filter((entry) => !due.includes(entry)) });
  for (const path of deleted) rmSync(path, { force: true });
  return { deleted, waiting: ledger.retired.length - due.length };
}
