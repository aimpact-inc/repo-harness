import { lstatSync, mkdirSync } from "fs";
import { relative, resolve, sep } from "path";
import { errorMessage } from "../core/evidence/error-message";
import { resolveInsideRepo, resolveParentInsideRepo } from "./path-safety";
import { ensureSelfIgnoringDirectory, SELF_IGNORE_NAME } from "./self-ignoring-directory";

export const FS_BACKUP_ROOT = ".ai/harness/backups";
export const FS_TRANSACTION_BACKUP_ROOT = `${FS_BACKUP_ROOT}/fs-transaction`;

export function assertNoSymlinkInPath(repoRoot: string, path: string): string | null {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) return target.error ?? "invalid path";
  const root = resolve(repoRoot);
  const rel = relative(root, target.path);
  let current = root;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    current = resolve(current, part);
    // lstat, not existsSync: existsSync follows links and misses a dangling one.
    // Return other lstat errors (for example EACCES) as a refusal, because callers
    // such as rollback expect a structured result and do not catch a throw.
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(current, { throwIfNoEntry: false });
    } catch (error) {
      return `cannot inspect adoption path: ${path} (${(error as NodeJS.ErrnoException).code ?? errorMessage(error)})`;
    }
    if (!stat) break;
    if (stat.isSymbolicLink()) return `symlink is not allowed in adoption path: ${path}`;
    if (!stat.isDirectory()) break;
  }
  return null;
}

export function ensureParent(repoRoot: string, path: string): string | null {
  const symlinkError = assertNoSymlinkInPath(repoRoot, path);
  if (symlinkError) return symlinkError;
  const parent = resolveParentInsideRepo(repoRoot, path);
  if (!parent.ok || !parent.path) return parent.error ?? "failed to resolve parent directory";
  mkdirSync(parent.path, { recursive: true });
  return null;
}

/**
 * The in-checkout backup root and each directory below it that holds copies ignore themselves before the first copy
 * (#3228, #2854): a checkout gets the runtime-state exclude block only at `rh update`. `directory` is repo-relative.
 */
export function ensureCheckoutBackupDirectory(repoRoot: string, directory: string = FS_BACKUP_ROOT): void {
  for (const level of new Set([FS_BACKUP_ROOT, directory])) {
    const symlinkError = assertNoSymlinkInPath(repoRoot, `${level}/${SELF_IGNORE_NAME}`);
    if (symlinkError) throw new Error(symlinkError);
    const parentError = ensureParent(repoRoot, level);
    if (parentError) throw new Error(parentError);
    ensureSelfIgnoringDirectory(resolveInsideRepo(repoRoot, level).path!);
  }
}
