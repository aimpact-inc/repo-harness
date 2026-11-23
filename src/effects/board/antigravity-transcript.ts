import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'fs';
import { isAbsolute, join, normalize, relative, sep } from 'path';
import { requireHome } from '../repo-harness-home';

export const ANTIGRAVITY_BRAIN_ROOTS = [
  '.gemini/antigravity/brain',
  '.gemini/antigravity-cli/brain',
  '.gemini/antigravity-ide/brain',
] as const;

/** Open only a regular file in the named conversation's logs, keeping the descriptor open for the read. */
export function withAntigravityTranscript<T>(sessionId: string, transcriptPath: string, env: NodeJS.ProcessEnv, read: (fd: number, bytes: number) => T): T | null {
  if (!/^[\w-]+$/.test(sessionId) || !isAbsolute(transcriptPath) || normalize(transcriptPath) !== transcriptPath) return null;
  const home = requireHome(env);
  const withinHome = relative(home, transcriptPath);
  const inLogs = ANTIGRAVITY_BRAIN_ROOTS.some(root => withinHome.startsWith(`${join(root, sessionId, '.system_generated', 'logs')}${sep}`));
  if (!inLogs) return null;
  const entry = lstatSync(transcriptPath);
  const expected = join(realpathSync(home), withinHome);
  if (!entry.isFile() || realpathSync(transcriptPath) !== expected) return null;

  const fd = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.dev !== entry.dev || file.ino !== entry.ino) return null;
    return read(fd, file.size);
  } finally {
    closeSync(fd);
  }
}

export function readAntigravityTranscript(sessionId: string, transcriptPath: string, env: NodeJS.ProcessEnv) {
  return withAntigravityTranscript(sessionId, transcriptPath, env, (fd, bytes) => {
    for (let window = Math.min(1024 * 1024, bytes); ; window = Math.min(window * 2, bytes)) {
      const buffer = Buffer.alloc(window);
      if (readSync(fd, buffer, 0, window, bytes - window) !== window) return null;
      const lines = buffer.toString('utf8').split('\n');
      // A partial tail can begin inside a JSON line.
      for (let index = lines.length - 1; index >= (window < bytes ? 1 : 0); index -= 1) {
        const contextTokens = plannerContext(lines[index]!);
        if (contextTokens !== undefined) return { bytes, contextTokens };
      }
      if (window === bytes) return { bytes, contextTokens: null };
    }
  });
}

/** Undefined skips other lines. Null means the latest planner entry has invalid counts. */
function plannerContext(line: string): number | null | undefined {
  let entry: unknown;
  try { entry = JSON.parse(line); } catch { return undefined; }
  if (typeof entry !== 'object' || entry === null || !('type' in entry) || entry.type !== 'PLANNER_RESPONSE') return undefined;
  const input = 'input_tokens' in entry ? entry.input_tokens : 0;
  const cached = 'cache_read_tokens' in entry ? entry.cache_read_tokens : 0;
  if (typeof input !== 'number' || typeof cached !== 'number' || !Number.isSafeInteger(input) || !Number.isSafeInteger(cached) || input < 0 || cached < 0) return null;
  const total = input + cached;
  return Number.isSafeInteger(total) ? total : null;
}
