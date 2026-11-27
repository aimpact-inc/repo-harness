import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SEAT_POOL_KIND, type SeatPoolV1 } from '../../core/board/seat-pool';
import { isRecord } from '../../core/evidence/is-record';
import { publishFileByRename } from '../atomic-append';
import { globalConfigurationPath } from '../configuration/global-configuration';
import { withExclusiveDirectoryLock } from '../locking/exclusive-directory-lock';

const SEAT_POOL_FILE_LIMIT = 64 * 1024;

export function seatPoolPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(globalConfigurationPath(env)), 'seats', 'pool.json');
}

export function checkPoolDirectories(path: string, create: boolean): void {
  for (const directory of [dirname(dirname(path)), dirname(path)]) {
    if (create) {
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    if (!lstatSync(directory).isDirectory()) throw new Error('seat_pool_invalid_path');
  }
}

export function readPoolFile(path: string): Record<string, unknown> {
  if (!lstatSync(path).isFile()) throw new Error('seat_pool_invalid_path');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > SEAT_POOL_FILE_LIMIT) throw new Error('seat_pool_invalid_path');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!isRecord(value) || value.protocol !== 1 || value.kind !== SEAT_POOL_KIND) throw new Error('seat_pool_unowned_file');
    return value;
  } finally { closeSync(fd); }
}

export function storeSeatPool(report: SeatPoolV1): void {
  const path = seatPoolPath(process.env);
  checkPoolDirectories(path, true);
  withExclusiveDirectoryLock(realpathSync(dirname(path)), 'pool.lock', () => {
    checkPoolDirectories(path, false);
    // The protocol marker identifies the cache across changes to the recommended table.
    let previous: Record<string, unknown> | undefined;
    try { previous = readPoolFile(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (typeof previous?.collected_at === 'string' && Date.parse(previous.collected_at) > Date.parse(report.collected_at)
      && Date.parse(previous.collected_at) <= Date.now()) return;
    publishFileByRename(path, Buffer.from(`${JSON.stringify(report, null, 2)}\n`), `${path}.tmp-${randomUUID()}`);
  }, { reclaimStaleOwner: true });
}
