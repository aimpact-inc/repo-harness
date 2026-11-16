import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiReviewSeatIsolation } from '../../core/board/seat-launch';
import { piAgentDir } from '../pi-agent-dir';
import { repoHarnessHome } from '../repo-harness-home';
import { writeOnlyRule } from '../review/review-isolation';

/** A directory that the seat shares with other processes; it is created when absent and returned resolved. */
function resolvedDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

/**
 * The Seatbelt write isolation of a Pi review seat on darwin (#2905). Pi has no sandbox, so the profile
 * denies each write outside the entries that the write trace of a review run found: the seat output
 * directory (TMPDIR and the JUnit reports of `bun run test:files`), the Pi session records that
 * `rh review collect` reads, the locks of the Pi `auth.json` and `trust.json`, the host test queue,
 * `/dev/null` and the terminals. Reads and network stay as they are. The profile sits beside the
 * output, where the seat cannot write it.
 */
export function preparePiReviewSeatIsolation(env: NodeJS.ProcessEnv): PiReviewSeatIsolation {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repo-harness-pi-review-seat-')));
  const output = join(root, 'output');
  const temporaryDirectory = join(output, 'tmp');
  mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  const agent = piAgentDir(env.HOME ?? homedir(), env);
  const sessions = resolvedDirectory(join(agent, 'sessions'));
  // proper-lockfile locks the resolved auth.json, so a linked auth.json locks beside its target.
  const auth = join(agent, 'auth.json');
  const authLock = `${existsSync(auth) ? realpathSync(auth) : join(realpathSync(agent), 'auth.json')}.lock`;
  // Pi takes the trust store lock on each start, also to read trust.json; trust.json itself stays denied.
  const trustLock = join(realpathSync(agent), 'trust.json.lock');
  const testQueue = resolvedDirectory(join(repoHarnessHome(env), 'host-test-queue'));
  const profile = join(root, 'write-isolation.sb');
  writeFileSync(profile, `(version 1)\n(allow default)\n${writeOnlyRule({
    subpaths: [output, sessions, testQueue], literals: ['/dev/null', '/dev/tty', authLock, trustLock], regexes: ['^/dev/ttys[0-9]+$'],
  })}`, { flag: 'wx', mode: 0o600 });
  return { profile, temporaryDirectory, junitDirectory: join(output, 'junit') };
}
