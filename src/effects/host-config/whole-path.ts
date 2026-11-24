import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { sha256Hex, sha256Prefixed } from '../../core/evidence/sha256';
import { HostConfigError, type PathCommitted, type PathRecord } from '../../core/host-config/types';
import { retryWindowsSharingRace } from '../atomic-append';
import { hashManagedTree, OWNER_MARKER } from '../managed-tree';
import { ownedSkillIsIntact } from './herdr-skill-marker';
import { ensureSelfIgnoringDirectory } from '../self-ignoring-directory';

/** The whole entry that a path write puts at a path: a file, a link, or a copy of a directory tree. */
export type PathEntry =
  | { readonly type: 'file'; readonly bytes: Buffer; readonly mode?: number }
  | { readonly type: 'symlink'; readonly target: string }
  | { readonly type: 'directory'; readonly source: string };

/** The entry at a path as a record would commit it; null when nothing is there. A special file is not a whole-path entry. */
export function observePathEntry(path: string): PathCommitted | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { type: 'symlink', target: readlinkSync(path) };
  if (stat.isFile()) return { type: 'file', sha256: sha256Prefixed(readFileSync(path)) };
  if (stat.isDirectory()) return { type: 'directory', sha256: hashManagedTree(path) };
  throw new HostConfigError('host_config_invalid_state', `not a file, link or directory: ${path}`);
}

export function sameCommitted(left: PathCommitted | null, right: PathCommitted | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The device, file id and birth time of the entry itself (its links not
 * followed): two names of one hard link share it, and a copy has its own.
 */
export function observeEntryIdentity(path: string): string | null {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : null;
}

/** The entry that a path record acts on: the file that its user link names, or the key itself. */
export function pathRecordEntry(key: string, record: PathRecord): string {
  return record.link_target ?? key;
}

/** Empty directories and special entries have no entry in the recorded tree hash. */
function treeEntriesAreCovered(path: string): boolean {
  let covered = false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === OWNER_MARKER) {
      if (!entry.isFile()) return false;
    } else if (entry.isDirectory()) {
      if (!treeEntriesAreCovered(join(path, entry.name))) return false;
      covered = true;
    } else if (entry.isFile() || entry.isSymbolicLink()) covered = true;
    else return false;
  }
  return covered;
}

/** Antigravity seat agent directories live directly under `.gemini/config/agents` and hold only a regular `agent.md`. */
function isAntigravityAgentRecordPath(key: string): boolean {
  const parent = dirname(key);
  const configDir = dirname(parent);
  const geminiDir = dirname(configDir);
  return basename(parent).toLowerCase() === 'agents'
    && basename(configDir).toLowerCase() === 'config'
    && basename(geminiDir).toLowerCase() === '.gemini';
}

function agySeatAgentTreeHolds(key: string, expectedSha256: string): boolean {
  const entries = readdirSync(key, { withFileTypes: true });
  if (entries.length !== 1) return false;
  const entry = entries[0]!;
  if (entry.name !== 'agent.md' || !entry.isFile()) return false;
  const agentPath = join(key, 'agent.md');
  if (!lstatSync(agentPath).isFile()) return false;
  const digest = sha256Prefixed(Buffer.concat([Buffer.from('F\0agent.md\0', 'utf8'), readFileSync(agentPath), Buffer.from('\0', 'utf8')]));
  return digest === expectedSha256;
}

/**
 * The entry at the key holds what rh recorded, by content only. For a linked
 * record the key must still be a link that names `link_target`, and that file
 * must hold `committed`. Ownership needs the identity too (`pathRecordProof`);
 * only the one-shot adoption (`adoptedIdentity`) reads content alone.
 */
export function pathRecordContentHolds(key: string, record: PathRecord): boolean {
  const stat = lstatSync(key, { throwIfNoEntry: false });
  if (!stat) return false;
  const committed = record.committed;
  try {
    if (record.link_target !== undefined) {
      if (!stat.isSymbolicLink() || realpathSync.native(key) !== record.link_target || committed.type !== 'file') return false;
      return lstatSync(record.link_target).isFile() && sha256Prefixed(readFileSync(record.link_target)) === committed.sha256;
    }
    if (committed.type === 'symlink') return stat.isSymbolicLink() && readlinkSync(key) === committed.target;
    if (committed.type === 'file') return stat.isFile() && sha256Prefixed(readFileSync(key)) === committed.sha256;
    if (!stat.isDirectory()) return false;
    if (record.host === 'antigravity' && 'sha256' in committed && isAntigravityAgentRecordPath(key)) {
      return agySeatAgentTreeHolds(key, committed.sha256);
    }
    if (!treeEntriesAreCovered(key)) return false;
    return 'proof' in committed ? ownedSkillIsIntact(key) : hashManagedTree(key) === committed.sha256;
  } catch {
    return false;
  }
}

/**
 * The one-shot adoption of a record that has no identity (JD 7001045792): the
 * identity of an entry that holds what rh recorded, observed before and after
 * its content check. Null when the content differs or the entry changed during
 * the check. Only the ledger move and the install-state migration call it.
 */
export function adoptedIdentity(key: string, record: PathRecord): string | null {
  const entry = pathRecordEntry(key, record);
  const before = observeEntryIdentity(entry);
  return before !== null && pathRecordContentHolds(key, record) && observeEntryIdentity(entry) === before ? before : null;
}

/** Write the entry beside the path, or at `staged`; the caller records it and then publishes it. */
export function stagePathEntry(path: string, entry: PathEntry, staged = `${path}.${randomUUID()}.rh-stage`): { readonly staged: string; readonly committed: PathCommitted } {
  try {
    if (entry.type === 'file') {
      writeFileSync(staged, entry.bytes, { flag: 'wx', mode: 0o600 });
      chmodSync(staged, (entry.mode ?? 0o644) & 0o777);
    } else if (entry.type === 'symlink') symlinkSync(entry.target, staged);
    else cpSync(entry.source, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    return { staged, committed: observePathEntry(staged)! };
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Put the staged entry at the path. A file or link replaces the old entry by
 * one rename; a directory cannot, so the old tree moves aside first and goes
 * after the new one is in place.
 */
export function publishPathEntry(staged: string, path: string): void {
  const old = lstatSync(path, { throwIfNoEntry: false });
  if (!old?.isDirectory() || old.isSymbolicLink()) {
    retryWindowsSharingRace(() => renameSync(staged, path));
    return;
  }
  const aside = `${path}.${randomUUID()}.rh-old`;
  retryWindowsSharingRace(() => renameSync(path, aside));
  try { retryWindowsSharingRace(() => renameSync(staged, path)); }
  catch (error) { renameSync(aside, path); throw error; }
  rmSync(aside, { recursive: true, force: true });
}

export function discardStagedEntry(staged: string): void {
  rmSync(staged, { recursive: true, force: true });
}

/** Remove a whole entry; a tree moves aside first, so a failure never leaves half a tree. */
export function removePathEntry(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) { retryWindowsSharingRace(() => rmSync(path, { force: true })); return; }
  const aside = `${path}.${randomUUID()}.rh-old`;
  retryWindowsSharingRace(() => renameSync(path, aside));
  rmSync(aside, { recursive: true, force: true });
}

/** Where a transaction keeps the entry that rh wrote at a path before this transaction replaced or removed it. */
export function preimagePath(transaction: string, key: string): string {
  return join(transaction, 'host-config-paths', sha256Hex(Buffer.from(key, 'utf8')));
}

/** Keep the first entry of the transaction at the path: a later write in the same transaction does not replace it. */
export function keepPreimage(transaction: string, key: string): void {
  const target = preimagePath(transaction, key);
  if (lstatSync(target, { throwIfNoEntry: false }) || lstatSync(target + '.absent', { throwIfNoEntry: false })) return;
  mkdirSync(transaction, { recursive: true, mode: 0o700 });
  ensureSelfIgnoringDirectory(dirname(target));
  if (!lstatSync(key, { throwIfNoEntry: false })) {
    writeFileSync(target + '.absent', '', { flag: 'wx', mode: 0o600 });
    return;
  }
  cpSync(key, target, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
}

/** True when the transaction holds an entry for the path. */
export function hasPreimage(transaction: string, key: string): boolean {
  const path = preimagePath(transaction, key);
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined || lstatSync(path + '.absent', { throwIfNoEntry: false }) !== undefined;
}

/** Put the transaction's entry back at the path, in place of what is there; the copy waits at `staged` before the rename. */
export function restorePreimage(transaction: string, key: string, staged = `${key}.${randomUUID()}.rh-stage`): void {
  const source = preimagePath(transaction, key);
  if (lstatSync(source + '.absent', { throwIfNoEntry: false })) { removePathEntry(key); return; }
  cpSync(source, staged, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  if (lstatSync(key, { throwIfNoEntry: false })) publishPathEntry(staged, key);
  else retryWindowsSharingRace(() => renameSync(staged, key));
}
