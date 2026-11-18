// No project imports: `herdr notify install` loads this module through a chain that plain Node also runs.
import { isAbsolute, join, resolve } from "node:path";

/**
 * An explicit account home is required before resolving an account write path:
 * HOME, or USERPROFILE when HOME is absent (a plain Windows shell sets only
 * USERPROFILE). Never `os.homedir()`: a process without either variable must
 * not reach the real home.
 */
export function requireHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE;
  if (!home || !isAbsolute(home)) throw new Error('HOME is required and must be an absolute path');
  return home;
}

/** The single account-level harness home; every host-owned authority store roots here. */
export function repoHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.REPO_HARNESS_HOME ?? join(requireHome(env), ".repo-harness"));
}
