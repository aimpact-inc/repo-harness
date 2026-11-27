import { randomUUID } from 'crypto';
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { publishFileByRename } from '../../effects/atomic-append';
import { hostConfigPaths, repositoryLedgers } from '../../effects/host-config/store';

export function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function keepOlderParentCopy(backupRoot: string, name: string, path: string): void {
  if (lstatExists(path)) writeFileSync(join(backupRoot, `${name}.json`), readFileSync(path), { mode: 0o600, flag: 'wx' });
  else writeFileSync(join(backupRoot, `${name}.absent`), '', { mode: 0o600, flag: 'wx' });
}

export function readOlderParentCopy(backupRoot: string, name: string): Buffer | null {
  const copy = join(backupRoot, `${name}.json`);
  if (lstatExists(copy)) return readFileSync(copy);
  if (lstatExists(join(backupRoot, `${name}.absent`))) return null;
  throw new Error(`runtime transaction of an earlier rh version has no ${name} copy; run rh update`);
}

/**
 * Every copy is read before the first write, so a missing copy changes no
 * file. A file that still holds its copy's bytes is one that the run did not
 * change (a migration can stop before it), so its entry, link and mode stay.
 */
export function restoreOlderParentFiles(backupRoot: string, paths: Readonly<Record<string, string>>): void {
  const files = Object.entries(paths).map(([name, path]) => ({ path, bytes: readOlderParentCopy(backupRoot, `${name}-before-migration`) }));
  for (const { path, bytes } of files) {
    // The copy followed a link, so the comparison does too.
    const current = lstatExists(path) ? readFileSync(path) : null;
    if (bytes === null ? current === null : current?.equals(bytes) === true) continue;
    if (bytes === null) rmSync(path, { force: true });
    else publishFileByRename(path, bytes, `${path}.${randomUUID()}.tmp`);
  }
}

const REPOSITORY_LEDGER_COPY = /^repository-ledger-(.+)-after-migration\.json$/;

/**
 * No parent snapshots a repository ledger, and a parent of an older protocol cannot read a moved one. The candidate keeps
 * each ledger that its move changed, before and after the move, in the parent's transaction directory, so the copies
 * leave with the transaction.
 */
export function keepMovedRepositoryLedgers(backupRoot: string, env: NodeJS.ProcessEnv, migrate: () => void): void {
  const before = repositoryLedgers(env).map(({ ledger }) => ({ ledger, key: basename(dirname(ledger)), bytes: readFileSync(ledger) }));
  for (const { key, ledger } of before) keepOlderParentCopy(backupRoot, `repository-ledger-${key}-before-migration`, ledger);
  const keepMoved = () => {
    for (const { key, ledger, bytes } of before) {
      if (lstatExists(ledger) && !readFileSync(ledger).equals(bytes)) keepOlderParentCopy(backupRoot, `repository-ledger-${key}-after-migration`, ledger);
    }
  };
  try { migrate(); } catch (error) {
    // A move that stops part way runs no candidate rollback: the ledgers that it moved go back now.
    keepMoved();
    const kept = restoreMovedRepositoryLedgers(backupRoot, env);
    throw kept.length ? new AggregateError([error], `${error instanceof Error ? error.message : String(error)}; ${movedLedgersKept(kept)}`) : error;
  }
  keepMoved();
}

export function movedLedgersKept(kept: readonly string[]): string {
  return `these repository ledgers changed after their move, so they stay at the current protocol: ${kept.join(', ')}; run rh update`;
}

/**
 * A failed candidate puts back each repository ledger that still holds the bytes of its move. A ledger that the run
 * also wrote stays as it is; its paths are returned for the report.
 */
export function restoreMovedRepositoryLedgers(backupRoot: string, env: NodeJS.ProcessEnv): string[] {
  const kept: string[] = [];
  for (const name of readdirSync(backupRoot)) {
    const key = REPOSITORY_LEDGER_COPY.exec(name)?.[1];
    if (key === undefined) continue;
    const ledger = join(hostConfigPaths(env).harness, 'config', 'repos', key, 'ledger.json');
    const after = readOlderParentCopy(backupRoot, `repository-ledger-${key}-after-migration`)!;
    const earlier = readOlderParentCopy(backupRoot, `repository-ledger-${key}-before-migration`)!;
    if (lstatExists(ledger) && readFileSync(ledger).equals(after)) publishFileByRename(ledger, earlier, `${ledger}.${randomUUID()}.tmp`);
    else kept.push(ledger);
  }
  return kept;
}
