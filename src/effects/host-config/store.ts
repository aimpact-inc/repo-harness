import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sha256Hex, sha256Prefixed } from '../../core/evidence/sha256';
import { matchesExpected } from '../../core/host-config/recovery';
import {
  EMPTY_LEDGER,
  HostConfigError,
  type ExpectedFile,
  type FileObservation,
  type HostConfigLedger,
  type Sha256,
  type TransactionRecord,
} from '../../core/host-config/types';
import { createFileExclusiveDurably, publishFileByRename, retryWindowsSharingRace, syncDirectoryDurably } from '../atomic-append';
import { globalConfigurationPath } from '../configuration/global-configuration';
import { assertNoSymlinkInPath } from '../fs-transaction';
import { isPathInside } from '../path-containment';

/** Storage beside the global configuration file: `~/.repo-harness/config/`. */
export interface HostConfigPaths {
  readonly home: string;
  readonly root: string;
  readonly ledger: string;
  readonly vault: string;
  readonly journal: string;
}

export function hostConfigPaths(env: NodeJS.ProcessEnv): HostConfigPaths {
  const harness = dirname(globalConfigurationPath(env));
  const root = join(harness, 'config');
  return { home: dirname(harness), root, ledger: join(root, 'ledger.json'), vault: join(root, 'vault'), journal: join(root, 'journal') };
}

function invalidState(message: string): HostConfigError {
  return new HostConfigError('host_config_invalid_state', message);
}

/** A host target is an absolute path under HOME, outside the gate's own storage, with no symlink on the way. */
export function assertHostPath(paths: HostConfigPaths, path: string): void {
  const rel = relative(paths.home, path);
  if (!isAbsolute(path) || resolve(path) !== path || !rel || rel.startsWith('..') || isAbsolute(rel) || isPathInside(paths.root, path)) {
    throw new HostConfigError('host_config_invalid_path', `not a host configuration path: ${path}`);
  }
  const symlink = assertNoSymlinkInPath(paths.home, rel);
  if (symlink) throw new HostConfigError('host_config_invalid_path', symlink);
}

/** Create a 0700 directory under HOME; refuse a symlink or a non-directory on the way. */
export function ensurePrivateDirectory(paths: HostConfigPaths, directory: string): void {
  const symlink = assertNoSymlinkInPath(paths.home, relative(paths.home, directory));
  if (symlink) throw new HostConfigError('host_config_invalid_path', symlink);
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw invalidState(`not a directory: ${directory}`);
  if (created !== undefined) syncDirectoryDurably(dirname(created));
}

/** Windows keeps only the owner write bit; compare modes in the form the platform reports. */
export function platformMode(mode: number): number {
  if (process.platform !== 'win32') return mode & 0o7777;
  return mode & 0o200 ? 0o666 : 0o444;
}

export function observeFile(path: string): { readonly observation: FileObservation; readonly bytes: Buffer | null } {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { observation: { existed: false }, bytes: null };
    throw error;
  }
  if (stat.isSymbolicLink()) return { observation: { existed: true, type: 'symlink' }, bytes: null };
  if (stat.isDirectory()) return { observation: { existed: true, type: 'directory' }, bytes: null };
  if (!stat.isFile()) return { observation: { existed: true, type: 'other' }, bytes: null };
  const bytes = readFileSync(path);
  return { observation: { existed: true, type: 'file', mode: platformMode(stat.mode), sha256: sha256Prefixed(bytes) }, bytes };
}

export function expectedOf(observation: FileObservation, path: string): ExpectedFile {
  if (!observation.existed) return { existed: false };
  if (observation.type !== 'file') throw invalidState(`not a regular file: ${path}`);
  return { existed: true, mode: observation.mode, sha256: observation.sha256 };
}

/** The temporary file of one transaction beside its target, so recovery can find a leftover by name. */
export function targetTemporary(path: string, txn: string): string {
  return `${path}.${txn}.tmp`;
}

function removeIfFile(path: string): void {
  const { observation } = observeFile(path);
  if (observation.existed && observation.type === 'file') unlinkSync(path);
}

/**
 * Replace the target: temp, fsync, re-read, rename, directory fsync. The
 * re-read must still match `expected`; otherwise nothing is written.
 */
export function replaceTarget(path: string, txn: string, bytes: Buffer, mode: number, expected: ExpectedFile, beforeRename: () => void): void {
  const temporary = targetTemporary(path, txn);
  removeIfFile(temporary);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength) throw invalidState(`partial write: ${path}`);
      fchmodSync(fd, mode);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (!matchesExpected(observeFile(path).observation, expected)) {
      throw new HostConfigError('host_config_target_changed', `the target changed before the write: ${path}`);
    }
    beforeRename();
    retryWindowsSharingRace(() => renameSync(temporary, path));
    syncDirectoryDurably(dirname(path));
  } finally { rmSync(temporary, { force: true }); }
}

export function removeTarget(path: string, expected: ExpectedFile): void {
  if (!matchesExpected(observeFile(path).observation, expected)) {
    throw new HostConfigError('host_config_target_changed', `the target changed before the restore: ${path}`);
  }
  retryWindowsSharingRace(() => unlinkSync(path));
  syncDirectoryDurably(dirname(path));
}

/** Missing ancestors between HOME and the target's directory, outermost first. */
export function missingDirectories(paths: HostConfigPaths, path: string): string[] {
  const missing: string[] = [];
  for (let current = dirname(path); current !== paths.home; current = dirname(current)) {
    if (observeFile(current).observation.existed) break;
    missing.unshift(current);
  }
  return missing;
}

export function createDirectories(directories: readonly string[]): void {
  for (const directory of directories) {
    mkdirSync(directory, { mode: 0o700 });
    syncDirectoryDurably(dirname(directory));
  }
}

/** Remove the directories a transaction created, innermost first; a directory that holds other content stays. */
export function removeCreatedDirectories(directories: readonly string[]): void {
  for (const directory of [...directories].reverse()) {
    try { rmdirSync(directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
      if (code !== 'ENOENT') throw error;
    }
    syncDirectoryDurably(dirname(directory));
  }
}

function publishPrivate(path: string, value: unknown): void {
  publishFileByRename(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'), `${path}.${randomUUID()}.tmp`);
}

// ---- ledger -------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSha = (value: unknown): value is Sha256 => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const isMode = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o7777;
const isText = (value: unknown): value is string => typeof value === 'string';

function validBaseline(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.state === 'unknown') return true;
  if (value.state !== 'known') return false;
  return value.existed === false || (value.existed === true && value.type === 'file' && isMode(value.mode) && isSha(value.sha256));
}

function validCommitted(value: unknown): boolean {
  if (!isObject(value) || !isText(value.txn)) return false;
  return value.type === 'absent' || (value.type === 'file' && isSha(value.sha256) && isMode(value.mode));
}

function validFragment(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.edit)) return false;
  const edit = value.edit;
  const removed = 'removed_vault' in edit ? isSha(edit.removed_vault) : isText(edit.removed);
  return isText(value.file) && isText(value.owner) && isText(value.selector) && ['add', 'refresh', 'override'].includes(value.kind as string)
    && value.state === 'active' && Number.isInteger(edit.at) && removed && isText(edit.inserted);
}

export function readLedger(paths: HostConfigPaths): HostConfigLedger {
  const { observation, bytes } = observeFile(paths.ledger);
  if (!observation.existed) return EMPTY_LEDGER;
  if (bytes === null) throw invalidState(`the ledger is not a regular file: ${paths.ledger}`);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw invalidState(`the ledger is not valid JSON: ${paths.ledger}`); }
  const valid = isObject(value) && value.protocol === 1
    && Array.isArray(value.committed_transactions) && value.committed_transactions.every(isText)
    && isObject(value.files) && Object.entries(value.files).every(([path, record]) => isAbsolute(path) && isObject(record)
      && validBaseline(record.baseline) && validCommitted(record.committed) && typeof record.external_change === 'boolean'
      && Array.isArray(record.created_dirs) && record.created_dirs.every(isText))
    && Array.isArray(value.fragments) && value.fragments.every(validFragment);
  if (!valid) throw invalidState(`the ledger has an invalid shape: ${paths.ledger}`);
  return value as unknown as HostConfigLedger;
}

/** The commit point: one atomic replace of `ledger.json`. */
export function writeLedger(paths: HostConfigPaths, ledger: HostConfigLedger): void {
  publishPrivate(paths.ledger, ledger);
}

// ---- vault --------------------------------------------------------------

/** Content-addressed and shared: a second put of the same bytes reuses the stored copy. */
export function putVault(paths: HostConfigPaths, bytes: Buffer): Sha256 {
  const hex = sha256Hex(bytes);
  const target = join(paths.vault, hex);
  const { observation, bytes: stored } = observeFile(target);
  if (observation.existed) {
    if (stored === null || sha256Hex(stored) !== hex) throw invalidState(`the vault entry does not match its name: ${target}`);
  } else {
    publishFileByRename(target, bytes, `${target}.${randomUUID()}.tmp`);
  }
  return `sha256:${hex}`;
}

// ---- journal ------------------------------------------------------------

export function transactionDirectory(paths: HostConfigPaths, txn: string): string {
  return join(paths.journal, txn);
}

const RECORD = 'record.json';

export function writePreimageCopy(paths: HostConfigPaths, txn: string, name: string, bytes: Buffer): void {
  createFileExclusiveDurably(join(transactionDirectory(paths, txn), name), bytes);
}

export function readPreimageCopy(paths: HostConfigPaths, txn: string, name: string, expected: Sha256): Buffer {
  const bytes = readFileSync(join(transactionDirectory(paths, txn), name));
  if (sha256Prefixed(bytes) !== expected) throw invalidState(`the preimage copy does not match its hash: ${txn}/${name}`);
  return bytes;
}

/** fsync the record, its directory and the journal before the first target write. */
export function writeTransactionRecord(paths: HostConfigPaths, record: TransactionRecord): void {
  const directory = transactionDirectory(paths, record.txn);
  publishPrivate(join(directory, RECORD), record);
  syncDirectoryDurably(paths.journal);
}

export function removeTransaction(paths: HostConfigPaths, txn: string): void {
  rmSync(transactionDirectory(paths, txn), { recursive: true, force: true });
  syncDirectoryDurably(paths.journal);
}

export function removePreimageCopy(paths: HostConfigPaths, txn: string, name: string): void {
  rmSync(join(transactionDirectory(paths, txn), name), { force: true });
}

function validExpected(value: unknown): boolean {
  return isObject(value) && (value.existed === false || (value.existed === true && isMode(value.mode) && isSha(value.sha256)));
}

function parseRecord(txn: string, raw: string): TransactionRecord {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalidState(`invalid transaction record: ${txn}`); }
  const valid = isObject(value) && value.protocol === 1 && value.txn === txn && (value.intended === 'write' || value.intended === 'delegated')
    && isText(value.stage) && Array.isArray(value.files) && value.files.every((entry) => isObject(entry) && isText(entry.path) && isAbsolute(entry.path)
      && validExpected(entry.preimage) && (entry.preimage_copy === null || isText(entry.preimage_copy))
      && (entry.preimage_copy === null) === ((entry.preimage as { existed: boolean }).existed === false)
      && (entry.intended === null ? value.intended === 'delegated' : validExpected(entry.intended))
      && Array.isArray(entry.created_dirs) && entry.created_dirs.every(isText));
  if (!valid) throw invalidState(`invalid transaction record: ${txn}`);
  return value as unknown as TransactionRecord;
}

/**
 * Every transaction record in the journal. A directory without a record died
 * before its record was durable, so no target write happened: it is removed.
 */
export function listTransactionRecords(paths: HostConfigPaths): TransactionRecord[] {
  const records: TransactionRecord[] = [];
  for (const txn of readdirSync(paths.journal).sort()) {
    const directory = transactionDirectory(paths, txn);
    if (!lstatSync(directory).isDirectory()) throw invalidState(`unexpected journal entry: ${directory}`);
    let raw: string;
    try { raw = readFileSync(join(directory, RECORD), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      removeTransaction(paths, txn);
      continue;
    }
    records.push(parseRecord(txn, raw));
  }
  return records;
}
