import { worktreeUid } from './worktree-trash';
import { randomUUID } from 'crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { publishFileByRename, syncDirectoryDurably } from '../atomic-append';

export interface PrunedWorktreeIntent {
  readonly worktree: string;
  readonly branch: string;
  readonly head: string;
  readonly git_directory: string;
  readonly git_directory_dev: number;
  readonly git_directory_ino: number;
}
export function prunedIntentKey(entry: PrunedWorktreeIntent): string {
  return JSON.stringify([entry.worktree, entry.branch, entry.head]);
}
function file(common: string): string { return join(common, 'repo-harness/coordination/pruned-worktrees.json'); }
function assertParent(common: string): void {
  let path = common;
  for (const part of ['repo-harness', 'coordination']) {
    path = join(path, part); const stat = lstatSync(path); const uid = worktreeUid();
    if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o002)) throw new Error('pruned worktree intent directory is unsafe');
  }
}
function assertFile(path: string): void {
  const stat = lstatSync(path);
  const uid = worktreeUid();
  if (!stat.isFile() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o002)) throw new Error('pruned worktree intent file is unsafe');
}
export interface WorktreeSweepCursor {
  readonly pending: string;
  readonly live: string;
  readonly first: 'pending' | 'live';
}

interface PrunedWorktreeState {
  readonly entries: PrunedWorktreeIntent[];
  readonly sweepCursor?: unknown;
}

function readState(common: string): PrunedWorktreeState {
  const path = file(common);
  if (!existsSync(path)) { try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] }; throw error; } }
  assertParent(common);
  assertFile(path);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  if (!saved || saved.protocol !== 1 || saved.common !== common || !Array.isArray(saved.entries)) throw new Error('pruned worktree intent file is invalid');
  assertEntries(common, saved.entries);
  return { entries: saved.entries, sweepCursor: saved.sweepCursor };
}

export function readPrunedWorktreeIntents(common: string): PrunedWorktreeIntent[] {
  return readState(common).entries;
}

export function readPrunedWorktreeSweepState(common: string): { intents: PrunedWorktreeIntent[]; cursor: WorktreeSweepCursor } {
  const { entries: intents, sweepCursor } = readState(common);
  if (sweepCursor === undefined) return { intents, cursor: { pending: '', live: '', first: 'pending' } };
  if (!sweepCursor || typeof sweepCursor !== 'object' || !('pending' in sweepCursor) || typeof sweepCursor.pending !== 'string'
    || !('live' in sweepCursor) || typeof sweepCursor.live !== 'string'
    || !('first' in sweepCursor) || (sweepCursor.first !== 'pending' && sweepCursor.first !== 'live')) throw new Error('worktree sweep cursor is invalid');
  return { intents, cursor: { pending: sweepCursor.pending, live: sweepCursor.live, first: sweepCursor.first } };
}

/** The caller holds the topology lock. The cursor is only a scheduling hint. */
export function writeWorktreeSweepCursor(common: string, sweepCursor: WorktreeSweepCursor): void {
  writeState(common, { entries: readState(common).entries, sweepCursor });
}
function assertEntries(common: string, entries: readonly PrunedWorktreeIntent[]): void {
  for (const entry of entries) {
    if (!entry || typeof entry.worktree !== 'string' || !isAbsolute(entry.worktree) || resolve(entry.worktree) !== entry.worktree
      || typeof entry.branch !== 'string' || !entry.branch || /[\x00-\x20\x7f]/.test(entry.branch)
      || typeof entry.head !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.head)
      || typeof entry.git_directory !== 'string' || dirname(entry.git_directory) !== join(common, 'worktrees') || resolve(entry.git_directory) !== entry.git_directory
      || !Number.isSafeInteger(entry.git_directory_dev) || !Number.isSafeInteger(entry.git_directory_ino)) throw new Error('pruned worktree intent entry is invalid');
  }
  if (new Set(entries.map(prunedIntentKey)).size !== entries.length) throw new Error('pruned worktree intent entries are ambiguous');
}
/** The caller holds the topology lock. Publish before native global prune. */
export function writePrunedWorktreeIntents(common: string, entries: readonly PrunedWorktreeIntent[]): void {
  assertEntries(common, entries);
  const path = file(common);
  assertParent(common);
  const beforeWrite = Date.now();
  const temporaryNames = readdirSync(dirname(path)).filter(name => /^pruned-worktrees\.json\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(name));
  for (const name of temporaryNames.slice(0, 8)) {
    const orphan = join(dirname(path), name); const stat = lstatSync(orphan);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === worktreeUid() && (stat.mode & 0o777) === 0o600 && stat.mtimeMs < beforeWrite) unlinkSync(orphan);
  }
  const { sweepCursor } = readState(common);
  writeState(common, { entries, sweepCursor });
}

function writeState(common: string, { entries, sweepCursor }: { readonly entries: readonly PrunedWorktreeIntent[]; readonly sweepCursor?: unknown }): void {
  const path = file(common);
  assertParent(common);
  if (existsSync(path)) assertFile(path);
  if (!entries.length && !sweepCursor) { if (existsSync(path)) unlinkSync(path); syncDirectoryDurably(dirname(path)); return; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  publishFileByRename(path, Buffer.from(JSON.stringify({ protocol: 1, common, entries, sweepCursor })), temporary);
}
