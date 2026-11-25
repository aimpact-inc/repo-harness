import { mock } from 'bun:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as actualWorktreeProcesses from '../../src/effects/git/worktree-processes';
import type { WorktreeProcess } from '../../src/effects/git/worktree-processes';

type ControlledInventory = WorktreeProcess[] | null | (() => WorktreeProcess[] | null);
let processes: ControlledInventory = [];

// Cleanup fixtures exercise real Git and filesystem operations. Their process
// observation is a separate input, including in disposable CLI subprocesses.
// A function value is read at each observation, so a test can change the
// inventory between two observations without sleeping.
mock.module(fileURLToPath(new URL('../../src/effects/git/worktree-processes.ts', import.meta.url)), () => ({
  ...actualWorktreeProcesses,
  worktreeProcesses: () => typeof processes === 'function' ? processes() : processes,
}));

export const controlledWorktreeProcessPreload = fileURLToPath(import.meta.url);
export function setControlledWorktreeProcesses(value: ControlledInventory): void { processes = value; }

/** Give fresh Bun helper processes the fixture inventory from the primary scratch checkout. */
export function writeControlledWorktreeProcessesConfig(root: string, inventory?: WorktreeProcess[] | null): void {
  appendFileSync(join(root, '.git/info/exclude'), '\n/bunfig.toml\n');
  let preload = controlledWorktreeProcessPreload;
  if (inventory !== undefined) {
    preload = join(root, '.git/controlled-worktree-processes.ts');
    writeFileSync(preload, `import { setControlledWorktreeProcesses } from ${JSON.stringify(controlledWorktreeProcessPreload)};\nsetControlledWorktreeProcesses(${JSON.stringify(inventory)});\n`, { flag: 'wx' });
  }
  writeFileSync(join(root, 'bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n`, { flag: 'wx' });
}
