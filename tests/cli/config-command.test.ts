import { spawnSync } from 'node:child_process';
import { seedGlobalPackageFixture } from '../helpers/install-ownership';
import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfigDiff, runConfigGc, runConfigRestore, runConfigStatus } from '../../src/cli/commands/config';
import { migrateInstallState } from '../../src/cli/installer/install-state-migration';
import { migrateInParentTransaction, rollbackRuntimeHostConfig } from '../../src/cli/installer/install-profile';
import { runUserUninstall } from '../../src/cli/installer/uninstall';
import { jsonFragment } from '../../src/core/host-config/json-fragment';
import { openHostConfigGate } from '../../src/effects/host-config/gate';
import { openRepositoryGate, repositoryConfigPaths, resolveHostConfigRepository } from '../../src/effects/host-config/repository';

/** A fake credential: no real token is ever read or written. */
const FAKE_TOKEN = 'sk-FAKE-2851-not-a-real-token';
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rh-config-command-')));
  homes.push(home);
  const env: NodeJS.ProcessEnv = { HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: process.env.PATH };
  const path = join(home, '.claude.json');
  const root = join(home, '.repo-harness', 'config');
  const ledgerPath = join(root, 'ledger.json');
  const ledger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'));
  const add = (owner: string, selector: string, value: unknown) =>
    openHostConfigGate({ env }).apply([{ path, fragments: [{ owner, selector, kind: 'add', strategy: jsonFragment, value }] }]);
  return { home, env, path, root, ledgerPath, ledger, add };
}

test.skipIf(process.platform === 'win32')('Antigravity keeps a user hook member and removes only its recorded member from restored containers', () => {
  const { home, env, ledger } = fixture();
  env.PATH = join(home, 'bin');
  env.TMPDIR = home;
  mkdirSync(env.PATH);
  seedGlobalPackageFixture(env);
  const cli = join(import.meta.dir, '../../src/cli/index.ts');
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', cli, ...args], { cwd: home, env, encoding: 'utf8' });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const dir = join(home, '.gemini', 'config');
  const hooks = join(dir, 'hooks.json');
  mkdirSync(dir, { recursive: true });
  const user = '{"repo-harness": {"enabled": false}, "custom": {"enabled": true}}\n';
  writeFileSync(hooks, user);
  const install = () => run('install', '--target', 'antigravity');
  expect(install()).toContain('host_config_override_skipped');
  expect(readFileSync(hooks, 'utf8')).toBe(user);
  writeFileSync(hooks, '{"custom": {"enabled": true}}\n');
  install();
  expect(Object.keys(JSON.parse(readFileSync(hooks, 'utf8')))).toEqual(['custom', 'repo-harness']);
  run('uninstall');
  expect(JSON.parse(readFileSync(hooks, 'utf8'))).toEqual({ custom: { enabled: true } });
  expect(ledger().files[hooks]).toBeUndefined();

  rmSync(join(home, '.gemini'), { recursive: true });
  for (const revert of [['uninstall', '--target', 'antigravity'], ['config', 'restore', hooks]]) {
    install();
    const installed = readFileSync(hooks, 'utf8');
    const restored = `\n ${installed.trim()} \n`;
    rmSync(hooks);
    writeFileSync(hooks, restored);
    expect(restored).not.toBe(installed);
    run(...revert, '--dry-run');
    expect(readFileSync(hooks, 'utf8')).toBe(restored);
    run(...revert);
    expect(JSON.parse(readFileSync(hooks, 'utf8'))).toEqual({});
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(ledger().files[hooks]).toBeUndefined();
    rmSync(join(home, '.gemini'), { recursive: true });
  }
}, 30_000);

test('status lists hashes and states with no value, names an unknown baseline and old backups, and creates no vault or lock', () => {
  const f = fixture();
  expect(runConfigStatus(f.env).exitCode).toBe(0);
  expect(readdirSync(f.home)).toEqual([]);

  writeFileSync(f.path, '{\n  "user": 1\n}\n');
  f.add('architecture', 'mcpServers.codegraph', { command: 'codegraph' });
  const other = join(f.home, '.codex', 'hooks.json');
  mkdirSync(join(f.home, '.codex'));
  writeFileSync(other, '{"hooks": {"rh": true}}\n');
  openHostConfigGate({ env: f.env }).adopt(other, { backup: null, fragments: [{ owner: 'core', selector: 'hooks.rh', kind: 'add', inserted: '"rh": true' }], externalChange: false });
  mkdirSync(join(f.home, '.repo-harness', 'global-context-backups'));
  writeFileSync(join(f.home, '.repo-harness', 'global-context-backups', 'CLAUDE.md.1.bak'), 'old');
  rmSync(join(f.root, 'vault'), { recursive: true, force: true });
  const status = runConfigStatus(f.env);
  expect(status.lines).toContain(`[file] ${other}: current sha256:${new Bun.CryptoHasher('sha256').update(readFileSync(other)).digest('hex')}; baseline unknown; as rh wrote it`);
  expect(status.lines).toContain('  architecture mcpServers.codegraph (add): rh');
  expect(status.lines).toContain(`[candidate] ${join(f.home, '.repo-harness', 'global-context-backups', 'CLAUDE.md.1.bak')}: an old global-context backup; rh does not use it as a baseline`);
  expect([existsSync(join(f.root, 'vault')), existsSync(join(f.home, '.repo-harness', 'transactions'))]).toEqual([false, false]);

  // A ledger of an older protocol names the update step; a read-only call does not move it.
  const { paths: _paths, retired: _retired, recovery: _recovery, tools: _tools, ...text } = f.ledger();
  writeFileSync(f.ledgerPath, JSON.stringify({ ...text, protocol: 1 }));
  const old = readFileSync(f.ledgerPath);
  expect(runConfigStatus(f.env)).toMatchObject({ exitCode: 2, lines: [expect.stringContaining('which has no path records; run: rh update')] });
  expect(readFileSync(f.ledgerPath)).toEqual(old);
});

test('a fake token in a user value reaches no default output; --show-values prints only text that rh is proved to have written', () => {
  const f = fixture();
  writeFileSync(f.path, '{\n  "user": 1\n}\n');
  f.add('architecture', 'mcpServers.codegraph', { command: 'codegraph' });
  f.add('o2', 'mcpServers.other', { command: 'rh-other' });
  const written = readFileSync(f.path, 'utf8');
  const userText = `"codegraph": {\n      "command": "codegraph",\n      "env": {"TOKEN": "${FAKE_TOKEN}"}\n    }`;
  writeFileSync(f.path, written.replace(/"codegraph": \{[^}]*\}/, userText));

  const shown = runConfigDiff(f.env, f.path, { showValues: true });
  const codegraph = (shown.json as { fragments: { selector: string; value?: string | null }[] }).fragments;
  const hash = `sha256:${new Bun.CryptoHasher('sha256').update(userText).digest('hex')}`;
  expect(codegraph.map(({ selector, value }) => [selector, value])).toEqual([
    ['mcpServers.codegraph', `<user value, ${Buffer.byteLength(userText)} bytes, ${hash}>`],
    ['mcpServers.other', '"other": {\n      "command": "rh-other"\n    }'],
  ]);
  const outputs = [
    runConfigStatus(f.env), runConfigDiff(f.env, f.path), shown,
    runConfigRestore(f.env, f.path, { dryRun: true }), runUserUninstall({ target: 'both', env: f.env, dryRun: true }), runUserUninstall({ target: 'both', env: f.env }),
  ];
  for (const output of outputs) expect(`${output.lines.join('\n')}\n${JSON.stringify('json' in output ? output.json : output)}`).not.toContain(FAKE_TOKEN);
  expect(runConfigDiff(f.env, f.path).lines.join('\n')).not.toContain('rh-other');
});

test('restore --owner takes out one owner and keeps the other; a dry run writes nothing', () => {
  const f = fixture();
  writeFileSync(f.path, '{\n  "user": 1\n}\n');
  f.add('architecture', 'mcpServers.codegraph', { command: 'codegraph' });
  f.add('o2', 'mcpServers.other', { command: 'rh-other' });
  const written = readFileSync(f.path, 'utf8');
  expect(runConfigRestore(f.env, f.path, { owner: 'architecture', dryRun: true }).lines).toEqual([
    `[reverted] ${f.path}: host-config ledger: rh text removed`,
    `[kept] ${f.path}: mcpServers.other: owned by o2`,
    '[restore] complete (dry-run)',
  ]);
  expect(readFileSync(f.path, 'utf8')).toBe(written);
  const result = runConfigRestore(f.env, f.path, { owner: 'architecture' });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual({ user: 1, mcpServers: { other: { command: 'rh-other' } } });
  expect(f.ledger().fragments.map((entry: { owner: string }) => entry.owner)).toEqual(['o2']);
  expect(runConfigRestore(f.env, f.path).lines).toEqual([`[restored] ${f.path}: host-config ledger: rh text removed`, '[restore] complete']);
  expect(readFileSync(f.path, 'utf8')).toBe('{\n  "user": 1\n}\n');
});

test('gc deletes a retired copy 30 days after its revert, and keeps a referenced, a recovery and an unknown vault copy', () => {
  const f = fixture();
  writeFileSync(f.path, '{\n  "user": 1\n}\n');
  f.add('architecture', 'mcpServers.codegraph', { command: 'codegraph' });
  const backup = f.ledger().files[f.path].backup as string;
  expect(runConfigRestore(f.env, f.path).exitCode).toBe(0);
  const vault = join(f.root, 'vault');
  const copy = (reference: string) => join(vault, reference.slice('sha256:'.length));
  const [retired] = f.ledger().retired as { sha256: string; at: string }[];
  expect(retired!.sha256).toBe(backup);
  // A live record that references the same bytes again, a recovery copy, and a vault file that no record names.
  const live = `sha256:${'a'.repeat(64)}`;
  const kept = `sha256:${'b'.repeat(64)}`;
  for (const reference of [live, kept, `sha256:${'c'.repeat(64)}`]) writeFileSync(copy(reference), 'x');
  const ledger = f.ledger();
  writeFileSync(f.ledgerPath, JSON.stringify({ ...ledger,
    retired: [...ledger.retired, { sha256: live, at: retired!.at }, { sha256: kept, at: retired!.at }],
    files: { [join(f.home, 'other.json')]: { kind: 'created', baseline: { state: 'known', existed: false }, committed: { type: 'absent' }, backup: live, external_change: false } },
    recovery: [{ file: f.path, sha256: kept, at: retired!.at }] }));
  const day = 24 * 60 * 60 * 1000;
  const at = Date.parse(retired!.at);
  // A kept install transaction can hold a ledger snapshot that still needs a retired copy: GC waits.
  const transaction = join(f.home, '.repo-harness', 'transactions', 'install-kept');
  mkdirSync(transaction, { recursive: true });
  expect(runConfigGc(f.env, { now: new Date(at + 31 * day) })).toMatchObject({ exitCode: 2, lines: [expect.stringContaining(`a kept install transaction can still need retired vault copies: ${transaction}`)] });
  expect(existsSync(copy(backup))).toBe(true);
  rmSync(transaction, { recursive: true });
  expect(runConfigGc(f.env, { now: new Date(at + 29 * day) }).json).toEqual({ deleted: [], changed: [], waiting: 3 });
  expect(runConfigGc(f.env, { now: new Date(at + 31 * day), dryRun: true }).json).toEqual({ deleted: [copy(backup)], changed: [], waiting: 0 });
  expect(existsSync(copy(backup))).toBe(true);
  expect(runConfigGc(f.env, { now: new Date(at + 31 * day) }).json).toEqual({ deleted: [copy(backup)], changed: [], waiting: 0 });
  expect(readdirSync(vault).sort()).toEqual(['.gitignore', ...[live, kept, `sha256:${'c'.repeat(64)}`].map((reference) => reference.slice('sha256:'.length)).sort()]);
  expect(f.ledger().retired).toEqual([]);
});

test('gc keeps a retired copy whose entry is no longer the retired bytes, in the dry run as in the apply, and keeps its retirement record', () => {
  const f = fixture();
  writeFileSync(f.path, '{\n  "user": 1\n}\n');
  f.add('architecture', 'mcpServers.codegraph', { command: 'codegraph' });
  expect(runConfigRestore(f.env, f.path).exitCode).toBe(0);
  const vault = join(f.root, 'vault');
  const copy = (reference: string) => join(vault, reference.slice('sha256:'.length));
  const [retired] = f.ledger().retired as { sha256: string; at: string }[];
  // A copy that the user saved edits into, and one that an editor replaced with a link.
  const edited = `sha256:${'d'.repeat(64)}`;
  const linked = `sha256:${'e'.repeat(64)}`;
  writeFileSync(copy(edited), 'my recovery edits');
  symlinkSync(copy(retired!.sha256), copy(linked));
  const ledger = f.ledger();
  writeFileSync(f.ledgerPath, JSON.stringify({ ...ledger, retired: [...ledger.retired, { sha256: edited, at: retired!.at }, { sha256: linked, at: retired!.at }] }));
  const now = new Date(Date.parse(retired!.at) + 31 * 24 * 60 * 60 * 1000);
  const expected = { deleted: [copy(retired!.sha256)], changed: [copy(edited), copy(linked)], waiting: 0 };
  expect(runConfigGc(f.env, { now, dryRun: true })).toMatchObject({ exitCode: 1, json: expected });
  expect(runConfigGc(f.env, { now })).toMatchObject({ exitCode: 1, json: expected });
  expect([readFileSync(copy(edited), 'utf8'), lstatSync(copy(linked)).isSymbolicLink()]).toEqual(['my recovery edits', true]);
  expect(f.ledger().retired.map((entry: { sha256: string }) => entry.sha256)).toEqual([edited, linked]);
});

// restore --repo (#2854): the dry run and the apply share one plan, so a record below a nested checkout is kept with the same
// reason and exit code in both; the apply writes nothing there and leaves no staging copy. Without the nested checkout it restores.
test('a protocol 4 repository ledger: the dry run projects it, rh update moves it, and restore --repo moves it when no update ran', () => {
  const f = fixture();
  const repo = join(f.home, 'repo');
  const file = join(repo, '.claude', 'settings.json');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0);
  writeFileSync(file, 'user\n');
  const repository = resolveHostConfigRepository(repo);
  openRepositoryGate(f.env, repository).writePaths([{ path: file, owner: 'core', replace: true, entry: { type: 'file', bytes: Buffer.from('stripped\n') } }]);
  // The repository ledger as 0.35.2 writes it: protocol 4, records with no identity.
  const ledgerPath = repositoryConfigPaths(f.env, repository).ledger;
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  for (const record of Object.values(ledger.paths) as Record<string, unknown>[]) delete record.identity;
  const protocol4 = JSON.stringify({ ...ledger, protocol: 4 });
  writeFileSync(ledgerPath, protocol4);
  const preview = runConfigRestore(f.env, undefined, { repo, dryRun: true });
  expect([preview.exitCode, JSON.parse(readFileSync(ledgerPath, 'utf8')).protocol]).toEqual([0, 4]);
  migrateInstallState(f.env);
  expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).protocol).toBe(5);
  writeFileSync(ledgerPath, protocol4);
  const restore = runConfigRestore(f.env, undefined, { repo });
  expect([restore.exitCode, readFileSync(file, 'utf8')]).toEqual([0, 'user\n']);
  expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).protocol).toBe(5);
});

test('a failed candidate puts back each repository ledger that holds only its move; a ledger that the run also wrote stays and is reported', () => {
  const f = fixture();
  const repositories = ['a', 'b'].map((name) => {
    const repo = join(f.home, name);
    const file = join(repo, '.claude', 'settings.json');
    mkdirSync(join(repo, '.claude'), { recursive: true });
    expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0);
    writeFileSync(file, 'user\n');
    const repository = resolveHostConfigRepository(repo);
    openRepositoryGate(f.env, repository).writePaths([{ path: file, owner: 'core', replace: true, entry: { type: 'file', bytes: Buffer.from('stripped\n') } }]);
    const ledger = repositoryConfigPaths(f.env, repository).ledger;
    const { paths, ...rest } = JSON.parse(readFileSync(ledger, 'utf8'));
    const protocol4 = Buffer.from(JSON.stringify({ ...rest, protocol: 4, paths: Object.fromEntries(Object.entries(paths as Record<string, Record<string, unknown>>)
      .map(([key, { identity: _identity, ...record }]) => [key, record])) }));
    writeFileSync(ledger, protocol4);
    return { repo, repository, ledger, protocol4 };
  });
  const [a, b] = [repositories[0]!, repositories[1]!];
  // The parent's transaction directory: the candidate keeps its copies there, so they leave with the transaction.
  const transaction = mkdtempSync(join(f.home, 'install-'));
  migrateInParentTransaction(transaction, f.env, () => migrateInstallState(f.env));
  expect([a, b].map(({ ledger }) => JSON.parse(readFileSync(ledger, 'utf8')).protocol)).toEqual([5, 5]);
  expect(readdirSync(transaction).filter((name) => name.startsWith('repository-ledger-')).length).toBe(4);
  // The failed candidate also writes repository b.
  openRepositoryGate(f.env, b.repository).writePaths([{ path: join(b.repo, '.claude', 'other.json'), owner: 'core', entry: { type: 'file', bytes: Buffer.from('rh\n') } }]);
  const written = readFileSync(b.ledger);
  expect(() => rollbackRuntimeHostConfig(transaction, f.env)).toThrow(`these repository ledgers changed after their move, so they stay at the current protocol: ${b.ledger}; run rh update`);
  expect([readFileSync(a.ledger).equals(a.protocol4), readFileSync(b.ledger).equals(written)]).toEqual([true, true]);
});

test('restore --repo keeps a record that the target rule refuses, in the dry run as in the apply', () => {
  const f = fixture();
  const repo = join(f.home, 'repo');
  const file = join(repo, '.claude', 'settings.json');
  mkdirSync(join(repo, '.claude'), { recursive: true });
  expect(Bun.spawnSync(['git', 'init', '-q', repo]).exitCode).toBe(0);
  writeFileSync(file, 'user\n');
  const repository = resolveHostConfigRepository(repo);
  openRepositoryGate(f.env, repository).writePaths([{ path: file, owner: 'core', replace: true, entry: { type: 'file', bytes: Buffer.from('stripped\n') } }]);
  writeFileSync(join(repo, '.claude', '.git'), 'gitdir: /elsewhere\n');
  const kept = `[kept] ${file}: ${join(repo, '.claude')} holds .git, so another checkout owns it`;
  const [preview, apply] = [runConfigRestore(f.env, undefined, { repo, dryRun: true }), runConfigRestore(f.env, undefined, { repo })];
  expect([preview.exitCode, preview.lines[0], apply.exitCode, apply.lines[0], readFileSync(file, 'utf8')]).toEqual([preview.exitCode, kept, preview.exitCode, kept, 'stripped\n']);
  rmSync(join(repo, '.claude', '.git'));
  const restore = runConfigRestore(f.env, undefined, { repo });
  expect([restore.exitCode, readFileSync(file, 'utf8'), readdirSync(join(repo, '.claude')), readdirSync(join(repo, '.ai/harness/backups/staging'))]).toEqual([0, 'user\n', ['settings.json'], []]);
  const paths = repositoryConfigPaths(f.env, repository);
  openRepositoryGate(f.env, repository).writePaths([{ path: file, owner: 'core', replace: true, entry: { type: 'file', bytes: Buffer.from('rh\n') } }]);
  const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
  const record = ledger.paths[file];
  delete record.identity;
  writeFileSync(paths.ledger, JSON.stringify(ledger));
  const copy = join(paths.vault, record.backup.slice('sha256:'.length));
  const line = `[unresolved] ${file}: rh recorded no identity for it, so nothing proves that rh wrote it; preserved; the file before rh is in ${copy}`;
  const dryRun = runConfigRestore(f.env, undefined, { repo, dryRun: true });
  expect([dryRun.exitCode, dryRun.lines[0], readFileSync(file, 'utf8'), readFileSync(copy, 'utf8')]).toEqual([1, line, 'rh\n', 'user\n']);
});
