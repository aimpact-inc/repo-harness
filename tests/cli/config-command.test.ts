import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConfigDiff, runConfigGc, runConfigRestore, runConfigStatus } from '../../src/cli/commands/config';
import { runUserUninstall } from '../../src/cli/installer/uninstall';
import { jsonFragment } from '../../src/core/host-config/json-fragment';
import { openHostConfigGate } from '../../src/effects/host-config/gate';

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
  const { paths: _paths, retired: _retired, recovery: _recovery, ...text } = f.ledger();
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
  expect(readdirSync(vault).sort()).toEqual([live, kept, `sha256:${'c'.repeat(64)}`].map((reference) => reference.slice('sha256:'.length)).sort());
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
