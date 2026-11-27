import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AUTOPILOT_LOCK_RELATIVE_PATH,
  AUTOPILOT_STATE_RELATIVE_PATH,
  AutopilotError,
  decodeAutopilotState,
  defaultAutopilotState,
  isAutopilotEnabled,
  recordAdvisorTickState,
  startAutopilotState,
  stopAutopilotState,
  type AutopilotStateV1,
} from '../../core/board/autopilot';
import { publishFileByRename } from '../atomic-append';
import { resolveGitCommonDirectory } from '../git/common-directory';
import { withExclusiveDirectoryLock } from '../locking/exclusive-directory-lock';
import { readRequest, seatResetRequestState } from './seat-reset-store';

export interface AutopilotStateReadV1 {
  readonly path: string;
  readonly exists: boolean;
  readonly state: AutopilotStateV1;
}

function assertSafeLocalPath(target: string): void {
  const dir = dirname(target);
  const dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (dirStat !== undefined && (!dirStat.isDirectory() || dirStat.isSymbolicLink())) {
    throw new AutopilotError('autopilot_store_failed', `autopilot state directory is not a regular directory: ${dir}`);
  }
  const fileStat = lstatSync(target, { throwIfNoEntry: false });
  if (fileStat !== undefined && (!fileStat.isFile() || fileStat.isSymbolicLink())) {
    throw new AutopilotError('autopilot_store_failed', `autopilot state path is not a regular file: ${target}`);
  }
}

function resolveCommonDir(repoRoot: string): string {
  try {
    return resolveGitCommonDirectory(repoRoot);
  } catch (error) {
    throw new AutopilotError(
      'autopilot_store_failed',
      `cannot resolve git common directory for ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function hasGitDiscoveryMetadata(cwd: string): boolean {
  const start = resolve(cwd);
  const startStat = statSync(start, { throwIfNoEntry: false });
  if (startStat === undefined || !startStat.isDirectory()) return false;
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true;
  let current = start;
  for (;;) {
    if (lstatSync(join(current, '.git'), { throwIfNoEntry: false }) !== undefined) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Local per-repository path: `<git-common-dir>/repo-harness/autopilot.json` (shared across linked worktrees, never committed). */
export function autopilotStatePath(repoRoot: string): string {
  return join(resolveCommonDir(repoRoot), AUTOPILOT_STATE_RELATIVE_PATH);
}

/** Read and strictly validate an explicit autopilot state file; missing file returns default OFF state. */
export function readAutopilotStateAtPath(path: string): AutopilotStateReadV1 {
  assertSafeLocalPath(path);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, state: defaultAutopilotState() };
    }
    throw new AutopilotError(
      'autopilot_store_failed',
      `failed to read autopilot state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AutopilotError('autopilot_invalid_state', `autopilot state at ${path} is not valid JSON`);
  }
  return { path, exists: true, state: decodeAutopilotState(parsed) };
}

/** Read the local autopilot state for `repoRoot`; fails closed if the file exists and is invalid. */
export function readAutopilotState(repoRoot: string): AutopilotStateReadV1 {
  return readAutopilotStateAtPath(autopilotStatePath(repoRoot));
}

/**
 * Read local autopilot state when `repoRoot` is inside a git repository; returns null outside a git repo.
 * Invalid or tampered `autopilot.json` inside a git repo still throws `AutopilotError` (fail closed).
 */
export function readAutopilotStateIfGitRepo(repoRoot: string): AutopilotStateReadV1 | null {
  if (!hasGitDiscoveryMetadata(repoRoot)) return null;
  return readAutopilotState(repoRoot);
}

function writeAutopilotStateAtomically(target: string, state: AutopilotStateV1): void {
  assertSafeLocalPath(target);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  publishFileByRename(target, Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8'), temporary);
}

/** Activate auto-pilot locally. Refuses any non-`owner_local` activation source before touching disk. */
export function startAutopilot(input: {
  readonly repo_root: string;
  readonly source: unknown;
  readonly cadence_minutes?: number;
  readonly now?: Date;
}): AutopilotStateReadV1 {
  const now = input.now ?? new Date();
  // Validate local authority and options before acquiring lock or touching disk.
  startAutopilotState(defaultAutopilotState(), { now, source: input.source, cadence_minutes: input.cadence_minutes });
  const commonDir = resolveCommonDir(input.repo_root);
  const target = join(commonDir, AUTOPILOT_STATE_RELATIVE_PATH);
  return withExclusiveDirectoryLock(commonDir, AUTOPILOT_LOCK_RELATIVE_PATH, () => {
    const current = readAutopilotStateAtPath(target);
    const next = startAutopilotState(current.state, { now, source: input.source, cadence_minutes: input.cadence_minutes });
    writeAutopilotStateAtomically(target, next);
    return { path: target, exists: true, state: next };
  });
}

/** Disable auto-pilot locally at once, preserving activation history and recording stop time/reason. */
export function stopAutopilot(input: {
  readonly repo_root: string;
  readonly reason?: string | null;
  readonly now?: Date;
}): AutopilotStateReadV1 {
  const now = input.now ?? new Date();
  stopAutopilotState(defaultAutopilotState(), { now, reason: input.reason });
  const commonDir = resolveCommonDir(input.repo_root);
  const target = join(commonDir, AUTOPILOT_STATE_RELATIVE_PATH);
  return withExclusiveDirectoryLock(commonDir, AUTOPILOT_LOCK_RELATIVE_PATH, () => {
    const current = readAutopilotStateAtPath(target);
    const next = stopAutopilotState(current.state, { now, reason: input.reason });
    writeAutopilotStateAtomically(target, next);
    return { path: target, exists: true, state: next };
  });
}

/**
 * Record `last_advisor_tick_at` after a confirmed advisor tick send.
 * Re-reads under lock so a concurrent local `stop` is never overwritten back to `enabled: true`.
 */
export function recordAutopilotAdvisorTick(input: {
  readonly repo_root: string;
  readonly now: Date;
}): AutopilotStateReadV1 {
  const commonDir = resolveCommonDir(input.repo_root);
  const target = join(commonDir, AUTOPILOT_STATE_RELATIVE_PATH);
  return withExclusiveDirectoryLock(commonDir, AUTOPILOT_LOCK_RELATIVE_PATH, () => {
    const current = readAutopilotStateAtPath(target);
    if (!current.exists || !isAutopilotEnabled(current.state)) return current;
    const next = recordAdvisorTickState(current.state, input.now);
    writeAutopilotStateAtomically(target, next);
    return { path: target, exists: true, state: next };
  });
}

/** True when the repository's advisor seat has an open handoff/reset request. */
export function isAdvisorSeatInReset(repositoryId: number): boolean {
  const identity = { seat: 'advisor' as const, repository: String(repositoryId) };
  const request = readRequest(identity);
  return request !== null && seatResetRequestState(identity, request).state === 'open';
}
