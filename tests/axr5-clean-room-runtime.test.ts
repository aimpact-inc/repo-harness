import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoDaemonArtifacts, cleanRoomEnvironment, finishCleanRoom } from '../scripts/lib/axr5-clean-room-runtime';

describe('AXR5 isolated in-process runtime lifecycle', () => {
  test('overrides inherited state root and removes a host database override without mutating the parent', () => {
    const inherited = { HOME: '/host', ARCHCONTEXT_STATE_DIR: '/host/state', ARCHCONTEXT_LOCAL_STORE_PATH: '/host/data.sqlite', PATH: '/tools' };
    const env = cleanRoomEnvironment('/fixture', inherited);
    expect(env.HOME).toBe(join('/fixture', 'host-home'));
    expect(env.ARCHCONTEXT_STATE_DIR).toBe(join('/fixture', 'runtime-state'));
    expect(env.ARCHCONTEXT_LOCAL_STORE_PATH).toBeUndefined();
    expect(env.PATH).toBe('/tools');
    expect(inherited.ARCHCONTEXT_LOCAL_STORE_PATH).toBe('/host/data.sqlite');
    expect(inherited.ARCHCONTEXT_STATE_DIR).toBe('/host/state');
  });

  test('runs cleanup on failure and preserves both errors when cleanup throws', () => {
    let cleaned = false;
    const failure = new Error('projection failed');
    expect(() => {
      try { throw failure; } finally {
        finishCleanRoom({ failure: { error: failure }, cleanup: () => { cleaned = true; } });
      }
    }).toThrow('projection failed');
    expect(cleaned).toBe(true);

    const cleanupFailure = new Error('EBUSY');
    let caught: unknown;
    try {
      finishCleanRoom({ failure: { error: failure }, cleanup: () => { throw cleanupFailure; } });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([failure, cleanupFailure]);
  });

  test('rejects daemon control, pid and socket artifacts in the isolated state directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'axr5-no-daemon-'));
    try {
      expect(() => assertNoDaemonArtifacts(join(dir, 'absent'))).not.toThrow();
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(join(dir, 'nested', 'cache.sqlite'), '');
      expect(() => assertNoDaemonArtifacts(dir)).not.toThrow();
      for (const name of ['archctxd.json', 'daemon.pid', 'runtime.sock']) {
        const file = join(dir, 'nested', name);
        writeFileSync(file, '');
        expect(() => assertNoDaemonArtifacts(dir)).toThrow('unexpected daemon artifact');
        rmSync(file);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
