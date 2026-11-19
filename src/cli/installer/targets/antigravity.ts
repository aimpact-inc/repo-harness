import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseJsonText } from '../../../core/evidence/file-syntax';
import { shellQuote } from '../../../core/shell-quote';
import { ANTIGRAVITY_GUARD_DENIAL, antigravityHookMatcher } from '../../hook/host-adapter';
import { isRecord } from '../../../core/evidence/is-record';
import { jsonFragment, jsonFragmentValue } from '../../../core/host-config/json-fragment';
import {
  ANTIGRAVITY_HOOK_SELECTOR, AntigravityHooksPathError, antigravityHooksPath, decode, openHostConfigGate, resolveUserConfigFile,
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

interface AntigravityHookCheck {
  readonly id: string;
  readonly describe: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'na';
  readonly detail: string;
}

function probeAntigravityGuard(command: string): boolean {
  const root = mkdtempSync(join(tmpdir(), 'rh-antigravity-doctor-'));
  try {
    const home = join(root, 'home');
    const bun = join(root, 'bun');
    const bin = join(root, 'bin');
    const repo = join(root, 'fake');
    for (const dir of [home, bun, bin, join(repo, '.git'), join(repo, '.ai', 'harness')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(repo, '.ai', 'harness', 'workflow-contract.json'), '{}\n');
    const fakeEnv = join(repo, '.env');
    writeFileSync(fakeEnv, 'FAKE=antigravity-doctor\n');
    const input = JSON.stringify({ cwd: repo, toolCall: { name: 'run_command', args: { CommandLine: `cat ${shellQuote(fakeEnv)}` } } });
    const probe = spawnSync('/bin/sh', ['-c', command], {
      cwd: repo, env: { HOME: home, PATH: bin, BUN_INSTALL: bun, TMPDIR: root }, input, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    });
    if (probe.status !== 0 || probe.stderr !== '') return false;
    const output = parseJsonText(probe.stdout, null);
    return isRecord(output) && output.decision === 'deny' && output.reason === ANTIGRAVITY_GUARD_DENIAL;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function checkAntigravityHooks(env: NodeJS.ProcessEnv = process.env): readonly [AntigravityHookCheck, AntigravityHookCheck] {
  const native = { id: 'antigravity-native-activation', describe: 'Antigravity on-disk hook activation' };
  const direct = { id: 'antigravity-direct-command', describe: 'Antigravity direct Bash guard' };
  const live = 'Live-session reload is unverified.';
  if (process.platform === 'win32') return [
    { ...native, status: 'na', detail: `${ANTIGRAVITY_WINDOWS_UNSUPPORTED} ${live}` },
    { ...direct, status: 'na', detail: ANTIGRAVITY_WINDOWS_UNSUPPORTED },
  ];
  let member: unknown;
  try { member = readAntigravityHooks(env).value; }
  catch (error) {
    const detail = error instanceof AntigravityHooksPathError ? error.message : 'Cannot read the Antigravity hook file.';
    return [{ ...native, status: 'fail', detail: `${detail} ${live}` }, { ...direct, status: 'na', detail: 'Hook file unavailable.' }];
  }
  if (member === undefined) return [
    { ...native, status: 'na', detail: `repo-harness hook member is absent. ${live}` },
    { ...direct, status: 'na', detail: 'No configured repo-harness hook command.' },
  ];
  const active = isRecord(member) && member.enabled !== false;
  const activation: AntigravityHookCheck = { ...native, status: active ? 'ok' : 'warn', detail: `repo-harness hook member is ${active ? 'enabled on disk' : 'disabled or invalid'}. ${live}` };
  try {
    const expected = buildAntigravityHooks(env);
    const routes = isRecord(member) ? member : {};
    const current = Object.entries(expected).every(([event, value]) => isDeepStrictEqual(value, routes[event]));
    const onDisk: AntigravityHookCheck = active && !current ? {
      ...native, status: 'fail', detail: `Enabled on disk with missing or stale hooks. Run rh update --target antigravity. ${live}`,
    } : activation;
    const matcher = antigravityHookMatcher('bash');
    const bash = expected.PreToolUse.find(entry => entry.matcher === matcher);
    const configured = Array.isArray(routes.PreToolUse) ? routes.PreToolUse.filter(entry => isRecord(entry) && entry.matcher === matcher) : [];
    const command = bash?.hooks[0]?.command;
    if (!command || configured.length !== 1 || !isDeepStrictEqual(bash, configured[0])) return [onDisk, {
      ...direct, status: 'fail', detail: 'The configured Bash hook differs from the current rendering. Run rh update --target antigravity.',
    }];
    const denied = probeAntigravityGuard(command);
    return [onDisk, { ...direct, status: denied ? 'ok' : 'fail', detail: denied ? 'The direct command denied a synthetic .env read.' : 'The direct command did not return the expected guard denial.' }];
  } catch {
    return [activation, { ...direct, status: 'fail', detail: 'Cannot render or run the Antigravity Bash hook. Check the Bun runtime and hook bundle.' }];
  }
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
