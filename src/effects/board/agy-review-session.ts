import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isRecord } from '../../core/evidence/is-record';
import { requireHome } from '../repo-harness-home';
import { ensureSessionDirectory, readSessionArtifact, writeSessionArtifact } from '../terminal/task-session-io';

export const AGY_REVIEW_LAUNCH_ENV = 'REPO_HARNESS_SEAT_AGY_REVIEW_LAUNCH';
export const AGY_REVIEW_PROMPT_OPTION = '--prompt-interactive';
export const AGY_REVIEW_LAUNCH_LINE = '\nAgy review launch: ';
const LAUNCH_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SESSION_FILE = /^([\w-]+)\.json$/u;

interface AgyReviewSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
}

export function isAgyReviewLaunchId(value: string): boolean {
  return LAUNCH_ID.test(value);
}

function sessionDirectory(home: string, launchId: string): string {
  if (!isAgyReviewLaunchId(launchId)) throw new Error('invalid agy review launch ID');
  return join(home, '.repo-harness', 'board', 'agy-review-sessions', launchId);
}

/** Record each conversation the native process starts under this launch. A second conversation makes collection ambiguous. */
export function recordAgyReviewSession(launchId: string, session: AgyReviewSession, env: NodeJS.ProcessEnv): void {
  if (!/^[\w-]+$/u.test(session.sessionId) || session.transcriptPath === '') throw new Error('invalid agy review session');
  const home = realpathSync(requireHome(env));
  const directory = sessionDirectory(home, launchId);
  ensureSessionDirectory(home, directory);
  writeSessionArtifact(join(directory, `${session.sessionId}.json`), { transcriptPath: session.transcriptPath });
}

/** The launch record identifies the conversation. The recorded path still requires safe transcript admission. */
export function readAgyReviewSession(launchId: string, env: NodeJS.ProcessEnv): AgyReviewSession {
  const directory = sessionDirectory(realpathSync(requireHome(env)), launchId);
  let entries: string[];
  try {
    if (realpathSync(directory) !== directory) throw new Error('symlinked session directory');
    entries = readdirSync(directory);
  } catch {
    throw new Error('the agy review session record is missing or unreadable');
  }
  const sessions = entries.flatMap(entry => {
    const match = SESSION_FILE.exec(entry);
    return match === null ? [] : [{ name: entry, sessionId: match[1]! }];
  });
  if (sessions.length !== 1) throw new Error(`expected one agy review session record, found ${sessions.length}`);
  const { name, sessionId } = sessions[0]!;
  try {
    const path = join(directory, name);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > 8192) throw new Error('unsafe session record');
    const value = readSessionArtifact<unknown>(path);
    if (isRecord(value) && typeof value.transcriptPath === 'string' && value.transcriptPath !== '') return { sessionId, transcriptPath: value.transcriptPath };
  } catch { /* malformed or unreadable launch record */ }
  throw new Error('the agy review session record is invalid');
}

/** The launcher and hook use the same private directory. Startup signals are atomic directory entries. */
export function prepareAgyReviewStartup(launchId: string, env: NodeJS.ProcessEnv): string {
  const home = realpathSync(requireHome(env));
  const directory = sessionDirectory(home, launchId);
  ensureSessionDirectory(home, directory);
  return directory;
}

/** Placement can return before the child runs. Keep the marker when delivery is unknown. */
export async function waitForAgyReviewBinding(directory: string): Promise<'bound' | 'failed' | 'unknown'> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    if (existsSync(join(directory, 'failed'))) return 'failed';
    if (existsSync(join(directory, 'bound'))) return 'bound';
    if (performance.now() >= deadline) return 'unknown';
    await delay(50);
  }
}
