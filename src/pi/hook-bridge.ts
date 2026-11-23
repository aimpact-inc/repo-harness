import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  BRIDGE_HOOK_INPUT_BYTES,
  BRIDGE_HOOK_OUTPUT_BYTES,
  HookBridge,
  bridgeHookEnvironment,
  type BridgeHookRequest,
} from '../cli/hook/bridge-client';

/**
 * Pi binding for the shared bridge client. Pi loads this package's TypeScript
 * sources directly, so the hook entry resolves from `src/pi/` to `dist/`.
 */

export const PI_HOOK_INPUT_BYTES = BRIDGE_HOOK_INPUT_BYTES;
export const PI_HOOK_OUTPUT_BYTES = BRIDGE_HOOK_OUTPUT_BYTES;

const HOOK_ENTRY = fileURLToPath(new URL('../../dist/hook-entry.js', import.meta.url));
const HOOK_BUN = 'bun';
const exec = promisify(execFile);

/** The loader reports readiness only if the bridge can read its entry and start Bun. */
export async function piHookStartupAvailable(cwd: string, env: NodeJS.ProcessEnv = process.env, entry = HOOK_ENTRY): Promise<boolean> {
  try {
    if (!(await stat(entry)).isFile()) return false;
    await access(entry, constants.R_OK);
    // execFile and the bridge's spawn use the same OS PATH lookup.
    await exec(HOOK_BUN, ['--version'], { cwd, env: piHookEnvironment(env), timeout: 3_000, killSignal: 'SIGKILL' });
    return true;
  } catch { return false; }
}

export type PiHookRequest = BridgeHookRequest;

export function piHookEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return bridgeHookEnvironment('pi', env);
}

export class PiHookBridge extends HookBridge {
  constructor(options: {
    readonly bun?: string;
    readonly entry?: string;
    readonly timeoutMs?: number;
    readonly env?: NodeJS.ProcessEnv;
  } = {}) {
    super({
      host: 'pi',
      codePrefix: 'PI',
      entry: options.entry ?? HOOK_ENTRY,
      bun: options.bun ?? HOOK_BUN,
      timeoutMs: options.timeoutMs,
      env: options.env,
    });
  }
}
