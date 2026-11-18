import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** The guard: Git ignores every entry of its directory, the guard included. */
export const SELF_IGNORE_NAME = '.gitignore';
const SELF_IGNORE_CONTENT = '*\n';

function isGuard(path: string): boolean | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return null;
  return stat.isFile() && readFileSync(path, 'utf8') === SELF_IGNORE_CONTENT;
}

/**
 * Why rh may not keep copies in `directory`, or null; it reads only, so a dry
 * run and the write share it. An absent directory is fine: rh creates it.
 * rh puts a guard only in a directory that it owns: one at its own path with
 * no link as the last component. A linked directory is the user's, so it must
 * already hold the guard. A guard name with other content, a link or another
 * type is the user's file.
 */
export function selfIgnoringRefusal(directory: string): string | null {
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat) return null;
  const linked = stat.isSymbolicLink();
  const real = linked ? realpathSync.native(directory) : directory;
  if (!lstatSync(real).isDirectory()) return `rh storage path is not a directory: ${directory}`;
  const guard = join(real, SELF_IGNORE_NAME);
  const present = isGuard(guard);
  if (present === true) return null;
  if (present === false) return `${guard} is not the rh guard ("*"); rh writes no copy into ${directory}. Move that file, then run again`;
  if (linked) return `${directory} links to ${real}, which rh does not own; rh writes no copy there. Create ${guard} with the single line "*", or remove the link, then run again`;
  return null;
}

/**
 * A directory that holds copies of user files ignores itself before the first
 * copy (#2854 P7, #3228): wherever its real directory is, Git reads its guard,
 * with no Git lookup. The parent must exist; a new directory gets mode 0700.
 * The guard is created exclusively by a hard link, so a file that appears
 * meanwhile is never replaced; any refusal writes nothing.
 */
export function ensureSelfIgnoringDirectory(directory: string): void {
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const refused = selfIgnoringRefusal(directory);
  if (refused !== null) throw new Error(refused);
  const guard = join(directory, SELF_IGNORE_NAME);
  if (isGuard(guard) === true) return;
  const temporary = join(directory, `${SELF_IGNORE_NAME}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeSync(fd, SELF_IGNORE_CONTENT);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try { linkSync(temporary, guard); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (isGuard(guard) !== true) throw new Error(selfIgnoringRefusal(directory) ?? `${guard} appeared while rh wrote its guard`);
    }
  } finally { rmSync(temporary, { force: true }); }
}
