import { isRecord } from '../../../core/evidence/is-record';
import { jsonFragment, jsonFragmentValue } from '../../../core/host-config/json-fragment';
import {
  ANTIGRAVITY_HOOK_SELECTOR, antigravityHooksPath, decode, openHostConfigGate, resolveUserConfigFile,
  type HostConfigFileChange,
} from '../../../effects/host-config/gate';
import { observeFile } from '../../../effects/host-config/store';
import { buildAntigravityHooks } from '../managed-entries';
import type { AgentTarget, WriteResult } from '../types';

export const ANTIGRAVITY_WINDOWS_UNSUPPORTED = 'Antigravity hooks are not supported on Windows. Antigravity uses cmd /c and rh renders POSIX sh hook commands.';

function readHooks(env: NodeJS.ProcessEnv) {
  const path = resolveUserConfigFile(env, antigravityHooksPath(env));
  const { observation, bytes } = observeFile(path);
  return { path, exists: observation.existed, content: decode(bytes, path) };
}

export function readAntigravityHooks(env: NodeJS.ProcessEnv): { path: string; value: unknown } {
  const { path, content } = readHooks(env);
  return { path, value: jsonFragmentValue(content, ANTIGRAVITY_HOOK_SELECTOR) };
}

function hookChange(path: string, content: string, env: NodeJS.ProcessEnv): HostConfigFileChange {
  return {
    path,
    backup: 'overrides-only',
    fragments: [{
      owner: 'core', selector: ANTIGRAVITY_HOOK_SELECTOR,
      kind: jsonFragment.locate(content, ANTIGRAVITY_HOOK_SELECTOR) ? 'refresh' : 'add',
      strategy: jsonFragment, value: buildAntigravityHooks(env),
    }],
  };
}

export const antigravityTarget: AgentTarget<'antigravity'> = {
  id: 'antigravity',
  displayName: 'Antigravity',
  supportsLocation: (location) => location === 'global',
  detect(location) {
    if (location !== 'global' || process.platform === 'win32') return { installed: false, alreadyConfigured: false };
    const { path, value } = readAntigravityHooks(process.env);
    return { installed: value !== undefined, alreadyConfigured: isRecord(value) && value.enabled !== false, configPath: path };
  },
  hostConfigChanges(_location, _opts, env = process.env) {
    if (process.platform === 'win32') throw new Error(ANTIGRAVITY_WINDOWS_UNSUPPORTED);
    const { path, content } = readHooks(env);
    return [hookChange(path, content, env)];
  },
  install(): WriteResult {
    if (process.platform === 'win32') throw new Error(ANTIGRAVITY_WINDOWS_UNSUPPORTED);
    const env = process.env;
    const { path, exists, content } = readHooks(env);
    const result = openHostConfigGate({ env }).apply([hookChange(path, content, env)]);
    const skipped = result.skipped[0];
    if (skipped) return { files: [{ path, action: 'kept', detail: `${skipped.code}: ${path}#${skipped.selector}` }] };
    return { files: [{ path, action: result.written.length ? (exists ? 'updated' : 'created') : 'unchanged' }] };
  },
};
