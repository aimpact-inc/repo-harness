import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiReviewSeatIsolation } from '../../core/board/seat-launch';
import { piAgentDir } from '../pi-agent-dir';
import { repoHarnessHome } from '../repo-harness-home';
import { inside, writeOnlyRule } from '../review/review-isolation';

export class PiReviewSeatIsolationError extends Error {
  readonly code = 'pi_review_isolation_unsafe';
}

/**
 * The real directory `name` in `parent`, created when absent. A link there would turn the grant into its
 * target, for example `/`, so a link or a non-directory refuses the launch.
 */
function ownedLeaf(parent: string, name: string): string {
  mkdirSync(join(parent, name), { recursive: true, mode: 0o700 });
  const path = join(realpathSync(parent), name);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PiReviewSeatIsolationError(`${path} must be a real directory, not a link, for the Pi review seat profile.`);
  return path;
}

/**
 * The Seatbelt write isolation of a Pi review seat on darwin (#2905). Pi has no sandbox, so the profile
 * denies each write outside the entries that the write trace of a review run found: the seat directory
 * (TMPDIR, the JUnit reports and the test HOMEs of `bun run test:files`), the Pi session records that
 * `rh review collect` reads, the locks of the Pi `auth.json` and `trust.json`, the host test queue,
 * `/dev/null` and the terminals. Reads and network stay as they are. The seat directory is inside
 * /tmp, because the test isolation allocates only there, and short, because unix socket paths stay
 * below 104 bytes. The profile sits beside it, where the seat cannot write it.
 */
export function preparePiReviewSeatIsolation(env: NodeJS.ProcessEnv): PiReviewSeatIsolation {
  const agent = piAgentDir(env.HOME ?? homedir(), env);
  const sessions = ownedLeaf(agent, 'sessions');
  // proper-lockfile locks the resolved auth.json, so a linked auth.json locks beside its target.
  const auth = join(agent, 'auth.json');
  const authLock = `${existsSync(auth) ? realpathSync(auth) : join(realpathSync(agent), 'auth.json')}.lock`;
  // Pi takes the trust store lock on each start, also to read trust.json; trust.json itself stays denied.
  const trustLock = join(realpathSync(agent), 'trust.json.lock');
  const testQueue = ownedLeaf(repoHarnessHome(env), 'host-test-queue');
  // A TMPDIR inside /tmp (a test run, or a test inside a seat) holds the seat directory; else /tmp does.
  const temporary = realpathSync(tmpdir()), tmp = realpathSync('/tmp');
  const root = realpathSync(mkdtempSync(join(inside(temporary, tmp) ? temporary : tmp, 'rh-seat-')));
  const writableDirectory = join(root, 'w');
  mkdirSync(writableDirectory, { mode: 0o700 });
  const profile = join(root, 'write-isolation.sb');
  writeFileSync(profile, `(version 1)\n(allow default)\n${writeOnlyRule({
    subpaths: [writableDirectory, sessions, testQueue], literals: ['/dev/null', '/dev/tty', authLock, trustLock], regexes: ['^/dev/ttys[0-9]+$'],
  })}`, { flag: 'wx', mode: 0o600 });
  return { profile, writableDirectory, junitDirectory: join(writableDirectory, 'junit') };
}
