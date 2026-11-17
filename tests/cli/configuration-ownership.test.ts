import { test, expect } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configurationReceiptPath } from '../../src/cli/installer/configuration-ownership';
import { planCodexConfigMigration } from '../../src/cli/installer/codex-config-migration';
import { migrateJsonConfigRecords, planJsonConfigMigration } from '../../src/cli/installer/json-config-migration';
import { buildManagedHooks, canonicalManagedHookProjection } from '../../src/cli/installer/managed-entries';
import { versions, writeState } from '../../src/cli/installer/install-profile';
import { MANAGED_TAG } from '../../src/core/adoption/managed-hook-config';
import { managedHookSelectors } from '../../src/core/host-config/json-fragment';
import { sha256Prefixed } from '../../src/core/evidence/sha256';
import { claudeTarget } from '../../src/cli/installer/targets/claude';
import { runUserUninstall } from '../../src/cli/installer/uninstall';
import { codexConfigFragment, tomlFragment } from '../../src/core/host-config/toml-fragment';
import { planFile } from '../../src/core/host-config/plan';
import { openHostConfigGate } from '../../src/effects/host-config/gate';
import { seedGlobalPackageFixture } from '../helpers/install-ownership';
import { acquireRuntimeTransactionLock, globalRuntimeScope, runtimeTransactionRoot, withRuntimeTransactionLock } from '../../src/effects/locking/runtime-transaction-lock';

function fixture(run: (home: string, env: NodeJS.ProcessEnv) => void) {
  const home = mkdtempSync(join(tmpdir(), 'configuration-ownership-'));
  try { run(home, { HOME: home }); } finally { rmSync(home, { recursive: true, force: true }); }
}
/** A Claude install under a temporary HOME, as `rh install` runs it. */
function withClaudeHome(run: (home: string, settings: string) => void) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'json-fragment-')));
  const previous = { HOME: process.env.HOME, BUN_INSTALL: process.env.BUN_INSTALL };
  process.env.HOME = home;
  process.env.BUN_INSTALL = join(home, '.bun');
  try {
    seedGlobalPackageFixture();
    mkdirSync(join(home, '.claude'));
    run(home, join(home, '.claude/settings.json'));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(home, { recursive: true, force: true });
  }
}
/** Every byte of `before` is still in `after`, in order: the edit only inserted text. */
function onlyInserted(before: string, after: string): boolean {
  let at = 0;
  for (const char of after) if (char === before[at]) at += 1;
  return at === before.length;
}

test('issue 698 TOML fragment selects the root key and preserves profile keys', () => {
  const raw = 'default_mode_request_user_input = false\n[profiles.work]\ndefault_mode_request_user_input = false\n';
  expect(codexConfigFragment(raw, 'default_mode_request_user_input')).toBe('default_mode_request_user_input = false\n');
  const { result } = planFile('config.toml', raw, [{ owner: 'core', selector: 'default_mode_request_user_input', kind: 'override', selected: true, strategy: tomlFragment, value: 'default_mode_request_user_input = true\n' }], []);
  expect(result).toBe('default_mode_request_user_input = true\n[profiles.work]\ndefault_mode_request_user_input = false\n');
});

test('an appended CodeGraph table refreshes as rh text and its removal gives back the exact bytes, with or without a final newline', () => {
  const table = '[mcp_servers.codegraph]\ncommand = "cg"\n';
  const request = (kind: 'add' | 'refresh', value: string) => ({ owner: 'architecture', selector: 'mcp_servers.codegraph', kind, strategy: tomlFragment, value });
  for (const raw of ['model = "user"', 'model = "user"\n']) {
    const added = planFile('config.toml', raw, [request('add', table)], []);
    const record = { file: 'config.toml', owner: 'architecture', selector: 'mcp_servers.codegraph', kind: 'add' as const, inserted: added.fragments[0]!.edit.inserted };
    const refreshed = planFile('config.toml', added.result, [request('refresh', table)], [record]);
    expect({ skipped: refreshed.skipped, unchanged: refreshed.result === added.result }, JSON.stringify(raw)).toEqual({ skipped: [], unchanged: true });
    expect(planFile('config.toml', added.result, [request('refresh', '')], [record]).result).toBe(raw);
  }
});

test('issue 698 ambiguous top-level TOML keys refuse a fragment mutation', () => {
  for (const raw of ['default_mode_request_user_input = false\ndefault_mode_request_user_input = true\n', '"default_mode_request_user_input" = false\n']) {
    expect(() => tomlFragment.apply(raw, 'default_mode_request_user_input', 'default_mode_request_user_input = true\n')).toThrow();
  }
});
test('A1: a Claude install only inserts text into settings.json, and a revert gives back its exact bytes', () => {
  // A 4-space file, a one-line file, and a file without a final newline that holds a user hook of an event that rh also uses.
  for (const original of ['{\n    "theme": "dark"\n}\n', '{"theme":"dark"}', '{\n  "hooks": {\n    "UserPromptSubmit": [\n      {"hooks": [{"type": "command", "command": "rtk hook claude"}]}\n    ]\n  }\n}']) withClaudeHome((home, settings) => {
    writeFileSync(settings, original);
    claudeTarget.install('global', {});
    const installed = readFileSync(settings, 'utf8');
    expect(onlyInserted(original, installed), installed).toBe(true);
    expect(JSON.parse(installed).hooks.UserPromptSubmit.at(-1).hooks[0].command === 'rtk hook claude').toBe(original.includes('rtk'));
    expect(openHostConfigGate({ env: process.env }).revert().map((entry) => entry.action)).toEqual(['text_removed']);
    expect(readFileSync(settings, 'utf8')).toBe(original);
  });
});

test('A9: after a user edit, uninstall removes the intact managed entries, keeps the user hook, the edited entry and a hook array of the user, and reports the edited one', () => withClaudeHome((home, settings) => {
  // The empty SessionStart array was there before rh; the other event arrays and the statusLine are rh's.
  writeFileSync(settings, '{\n    "theme": "dark",\n    "hooks": {\n        "SessionStart": []\n    }\n}\n');
  claudeTarget.install('global', {});
  const data = JSON.parse(readFileSync(settings, 'utf8'));
  data.hooks.Stop.push({ hooks: [{ type: 'command', command: 'user-stop-hook' }] });
  data.hooks.PreToolUse[0].hooks[0].timeout = 99;
  writeFileSync(settings, `${JSON.stringify(data, null, 4)}\n`);
  const result = runUserUninstall({ target: 'claude', env: process.env });
  expect(result.status).toBe('partial');
  expect(result.lines).toContain(`[unresolved] ${settings}: changed since rh wrote it; preserved: hooks.PreToolUse[edit]`);
  const after = JSON.parse(readFileSync(settings, 'utf8'));
  expect({ theme: after.theme, statusLine: after.statusLine, events: Object.keys(after.hooks).sort() }).toEqual({ theme: 'dark', statusLine: undefined, events: ['PreToolUse', 'SessionStart', 'Stop'] });
  expect(after.hooks.SessionStart).toEqual([]);
  expect(after.hooks.PreToolUse).toEqual([data.hooks.PreToolUse[0]]);
  expect(after.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-stop-hook' }] }]);
}));

test('the JSON migration adopts tagged hooks only while the old manifest hash matches; an edited file keeps every hook, reports it and frees it on deletion', () => {
  const edits: Record<string, (hooks: any) => void> = {
    intact: () => {},
    timeout: (hooks) => { hooks.PreToolUse[0].hooks[0].timeout = 99; },
    matcher: (hooks) => { hooks.PreToolUse[0].matcher = 'Edit'; },
    command: (hooks) => { hooks.PreToolUse[0].hooks[0].command = hooks.PreToolUse[0].hooks[0].command.replace('HOOK_HOST=claude', 'HOOK_HOST=claude X=1'); },
  };
  for (const [name, edit] of Object.entries(edits)) withClaudeHome((home, settings) => {
    const env = process.env;
    const hooks = buildManagedHooks('claude', env);
    writeState({ protocol: 3, ...versions([]), selection: [], transaction_id: 'seeded', applied_at: '2026-11-01T00:00:00.000Z', previous: null, ownership_manifest: [{
      owner: 'core', path: settings, type: 'managed-file', authority: 'repo-harness-install-transaction', removal: 'managed-surfaces-only',
      content_hash: sha256Prefixed(JSON.stringify(canonicalManagedHookProjection(hooks))), managed_marker: MANAGED_TAG, symlink_target: null,
    }] }, env);
    const data = { theme: 'dark', hooks: structuredClone(hooks) };
    edit(data.hooks);
    const original = `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(settings, original);
    const result = runUserUninstall({ target: 'claude', env });
    const selectors = managedHookSelectors(original);
    if (name === 'intact') {
      expect([result.status, readFileSync(settings, 'utf8')], name).toEqual(['complete', '{\n  "theme": "dark"\n}\n']);
      return;
    }
    expect(result.status, name).toBe('partial');
    expect(result.lines, name).toContain(`[unresolved] ${settings}: changed since rh wrote it; preserved: ${selectors.join(', ')}`);
    expect(readFileSync(settings, 'utf8'), name).toBe(original);
    expect(() => claudeTarget.install('global', {}), name).toThrow(`${settings}: ${selectors.join(', ')} are not rh's text any more, so rh kept them. Delete those hook entries, then run rh install again; rh writes them anew`);
    if (name !== 'timeout') return;
    writeFileSync(settings, '{\n  "theme": "dark"\n}\n');
    claudeTarget.install('global', {});
    expect(JSON.parse(readFileSync(settings, 'utf8')).hooks, name).toEqual(hooks);
  });
});

test('the JSON migration fails closed on an interrupted receipt entry and on an rh command inside a user hook entry', () => withClaudeHome((home, settings) => {
  const env = process.env;
  mkdirSync(join(home, '.repo-harness'));
  writeFileSync(configurationReceiptPath(home), JSON.stringify({ protocol: 1, changes: [], pending: { id: 'x', before: [{ path: settings, selector: 'allowedTools.codegraph', value: null }] } }));
  expect(() => planJsonConfigMigration(env)).toThrow(`interrupted configuration change (allowedTools.codegraph in ${settings}). Restore each fragment from its value in the "pending" block of ${configurationReceiptPath(home)}, then remove those entries from the block`);
  rmSync(configurationReceiptPath(home));
  const managed = buildManagedHooks('claude', env).Stop![0]!.hooks[0]!;
  const original = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop-hook' }, managed] }] } });
  writeFileSync(settings, original);
  expect(() => migrateJsonConfigRecords(env)).toThrow('a hook entry in Stop holds a repo-harness command together with other commands. Move that command into its own entry, or delete it, then run rh again');
  expect(readFileSync(settings, 'utf8')).toBe(original);
}));

test('refuses a configuration receipt with the retired Codex MCP selector', () => fixture((home, env) => {
  mkdirSync(join(home, '.repo-harness'));
  writeFileSync(configurationReceiptPath(home), JSON.stringify({
    protocol: 1,
    changes: [{ path: join(home, '.codex/config.toml'), selector: 'mcp_servers.repo_harness', before: null, installed: null, active: true }],
  }));
  expect(() => planCodexConfigMigration(env)).toThrow(`invalid Codex configuration receipt entry: ${configurationReceiptPath(home)}`);
}));
test('refuses a receipt path symlink before the migration writes anything', () => fixture((home, env) => {
  mkdirSync(join(home, '.repo-harness'));
  const victim = join(home, 'victim'); writeFileSync(victim, 'untouched');
  symlinkSync(victim, configurationReceiptPath(home));
  expect(() => migrateJsonConfigRecords(env)).toThrow();
  expect(readFileSync(victim, 'utf8')).toBe('untouched');
  expect(existsSync(join(home, '.repo-harness/config'))).toBe(false);
}));

test.skipIf(process.platform === 'win32')('issue 922 the account scope keeps global-runtime.lock', () => fixture((home, env) => {
  const global = globalRuntimeScope(env);
  expect(global).toEqual({ kind: 'global', root: home });
  expect(runtimeTransactionRoot(global)).toBe(join(home, '.repo-harness', 'transactions'));
  withRuntimeTransactionLock(global, (lock) => {
    expect(lock.lockPath).toBe(join(realpathSync(home), '.repo-harness/transactions/global-runtime.lock'));
  });
}));


test('candidate parent context accepts EPERM, rejects ESRCH and preserves unexpected probe errors', () => fixture((home) => {
  const lock = acquireRuntimeTransactionLock({ kind: 'global', root: home });
  try {
    const modulePath = join(import.meta.dir, '../../src/effects/locking/runtime-transaction-lock.ts');
    const result = Bun.spawnSync([process.execPath, '-e', `
      import { strict as assert } from 'assert';
      import { parentRuntimeTransactionContext } from ${JSON.stringify(modulePath)};
      const scope = { kind: 'global', root: ${JSON.stringify(home)} };
      const parent = ${JSON.stringify({ pid: process.pid, lockPath: lock.lockPath, ownerToken: lock.ownerToken })};
      for (const code of ['EPERM', 'ESRCH', 'EIO']) {
        const failure = Object.assign(new Error(code), { code });
        process.kill = () => { throw failure; };
        const create = () => parentRuntimeTransactionContext(scope, parent);
        if (code === 'EPERM') create().assertOwned();
        else if (code === 'ESRCH') assert.throws(create, /candidate parent no longer owns the global runtime lock/);
        else assert.throws(create, error => error === failure);
      }
    `], { stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally { lock.release(); }
}));

test('installer rollback refuses a competing configuration writer before it can report success', async () => {
  const home = mkdtempSync(join(tmpdir(), 'configuration-rollback-lock-'));
  const env = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  const path = join(home, '.repo-harness/config.json');
  const modulePath = join(import.meta.dir, '../../src/effects/configuration/global-configuration.ts');
  const code = `import {mutateGlobalConfiguration} from ${JSON.stringify(modulePath)}; try { mutateGlobalConfiguration(process.env, (config) => ({ config: { ...config, security: { mode: 'relaxed' } }, value: undefined })); } catch (error) { console.error(error.code); process.exit(75); }`;
  const { beginInstallHostTransaction, rollbackInstallHostTransaction } = await import('../../src/cli/installer/install-profile');
  try {
    mkdirSync(join(home, '.repo-harness'));
    const original = JSON.stringify({ security: { mode: 'strict' } });
    writeFileSync(path, original);
    const lock = acquireRuntimeTransactionLock(globalRuntimeScope(env));
    try {
      const transaction = beginInstallHostTransaction([path], env, { runtimeLock: lock });
      const child = Bun.spawn([process.execPath, '-e', code], { env, stdout: 'pipe', stderr: 'pipe' });
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).toBe(75);
      expect(stderr).toContain('busy');
      expect(readFileSync(path, 'utf8')).toBe(original);
      lock.assertOwned();
      rollbackInstallHostTransaction(transaction);
      expect(readFileSync(path, 'utf8')).toBe(original);
    } finally { lock.release(); }
    const child = Bun.spawn([process.execPath, '-e', code], { env, stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ security: { mode: 'relaxed' } });
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('failed commit cleanup retains its lock and permits rollback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'configuration-commit-cleanup-'));
  const env = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  const path = join(home, '.repo-harness/config.json');
  const { beginInstallHostTransaction, commitInstallHostTransaction, rollbackInstallHostTransaction } = await import('../../src/cli/installer/install-profile');
  let transaction: ReturnType<typeof beginInstallHostTransaction> | undefined;
  try {
    mkdirSync(join(home, '.repo-harness'));
    const original = JSON.stringify({ security: { mode: 'strict' } });
    writeFileSync(path, original);
    transaction = beginInstallHostTransaction([path], env);
    writeFileSync(path, JSON.stringify({ security: { mode: 'during-install' } }));
    chmodSync(transaction.backup_root, 0o500);
    try {
      expect(() => commitInstallHostTransaction(transaction!)).toThrow();
    } finally { if (existsSync(transaction.backup_root)) chmodSync(transaction.backup_root, 0o700); }
    const modulePath = join(import.meta.dir, '../../src/effects/configuration/global-configuration.ts');
    const child = Bun.spawn([process.execPath, '-e', `import {mutateGlobalConfiguration} from ${JSON.stringify(modulePath)}; try { mutateGlobalConfiguration(process.env, (config) => ({ config: { ...config, security: { mode: 'competing' } }, value: undefined })); } catch (error) { console.error(error.code); process.exit(75); }`], { env, stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(75);
    expect(stderr).toContain('busy');
    rollbackInstallHostTransaction(transaction);
    transaction = undefined;
    expect(readFileSync(path, 'utf8')).toBe(original);
    const { mutateGlobalConfiguration } = await import('../../src/effects/configuration/global-configuration');
    mutateGlobalConfiguration(env, (config) => ({ config: { ...config, security: { mode: 'after-rollback' } }, value: undefined }));
    expect(JSON.parse(readFileSync(path, 'utf8')).security.mode).toBe('after-rollback');
  } finally {
    if (transaction && existsSync(transaction.backup_root)) {
      chmodSync(transaction.backup_root, 0o700);
      rollbackInstallHostTransaction(transaction);
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test('configuration writes preserve sibling sections and reject invalid input or foreign lock contexts', async () => {
  const { ensureGlobalArchitectureProjection } = await import('../../src/cli/commands/architecture-configuration');
  const { applyAgentsSettings } = await import('../../src/effects/configuration/agents-configuration');
  const { globalConfigurationWriter, readGlobalConfiguration, mutateGlobalConfiguration } = await import('../../src/effects/configuration/global-configuration');
  fixture((home, env) => {
    const path = join(home, '.repo-harness/config.json');
    mkdirSync(join(home, '.repo-harness'));
    writeFileSync(path, JSON.stringify({ security: { mode: 'strict' } }));
    expect(ensureGlobalArchitectureProjection(env, globalConfigurationWriter(env)).status).toBe('ok');
    const before = readGlobalConfiguration(env);
    // A review use is a valid agents write; a new docs use is refused while no runtime has verified docs isolation.
    applyAgentsSettings({ expected_revision: before.revision, changes: [{ runtime: 'codex', enabled: true, uses: ['review'] }] }, ['codex'], env);
    const result = readGlobalConfiguration(env);
    expect(result.config).toMatchObject({ security: { mode: 'strict' }, architecture: { projection_provider: 'archctx' }, agents: { enabled: ['codex'], uses: { review: ['codex'] } } });
    expect(() => applyAgentsSettings({ expected_revision: before.revision, changes: [] }, ['codex'], env)).toThrow('changed after it was read');
    expect(readGlobalConfiguration(env).revision).toBe(result.revision);
    expect(() => mutateGlobalConfiguration(env, () => ({ config: {}, value: undefined }), {
      runtimeLock: { scope: globalRuntimeScope(env), assertOwned() {} },
    })).toThrow('does not own this scope');
    expect(readGlobalConfiguration(env).revision).toBe(result.revision);
    writeFileSync(path, '{invalid');
    expect(() => mutateGlobalConfiguration(env, () => ({ config: {}, value: undefined }))).toThrow('not a valid JSON object');
    expect(readFileSync(path, 'utf8')).toBe('{invalid');
  });
});


test.skipIf(process.platform !== 'win32')('Windows explicit configuration targets share the account lock', async () => {
  const { mutateGlobalConfiguration } = await import('../../src/effects/configuration/global-configuration');
  const write = (env: NodeJS.ProcessEnv, mode: string) => mutateGlobalConfiguration(env, (config) => ({ config: { ...config, security: { mode } }, value: undefined }));
  fixture((home) => {
    const firstHome = join(home, 'first');
    const secondHome = join(home, 'second');
    mkdirSync(firstHome); mkdirSync(secondHome);
    const first = { HOME: firstHome }, second = { HOME: secondHome };
    expect(globalRuntimeScope(first)).toEqual(globalRuntimeScope(second));
    const lock = acquireRuntimeTransactionLock(globalRuntimeScope(first));
    try {
      expect(() => write(second, 'locked')).toThrow('runtime transaction');
      expect(existsSync(join(firstHome, '.repo-harness/config.json'))).toBe(false);
      expect(existsSync(join(secondHome, '.repo-harness/config.json'))).toBe(false);
    } finally { lock.release(); }
    const result = write(second, 'unlocked');
    expect(result.path).toBe(join(secondHome, '.repo-harness/config.json'));
    expect(JSON.parse(readFileSync(result.path, 'utf8')).security.mode).toBe('unlocked');
    expect(existsSync(join(firstHome, '.repo-harness/config.json'))).toBe(false);
  });
});
