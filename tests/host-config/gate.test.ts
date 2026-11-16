import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FragmentEdit, HostConfigStrategy, HostPath } from '../../src/core/host-config/types';
import { openHostConfigGate, type HostConfigFileChange } from '../../src/effects/host-config/gate';
import { replaceTarget } from '../../src/effects/host-config/store';

/** A `key=value` line format: the selector is the key. */
function keyLineEdit(content: string, selector: string, value: string): FragmentEdit {
  const match = new RegExp(`^${selector.replace(/\./g, '\\.')}=.*\\n`, 'm').exec(content);
  const inserted = `${selector}=${value}\n`;
  return match ? { at: match.index, removed: match[0], inserted } : { at: content.length, removed: '', inserted };
}
const keyLine: HostConfigStrategy<string> = { locate: () => null, apply: keyLineEdit };

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rh-host-config-')));
  homes.push(home);
  const a = join(home, '.alpha.conf');
  const b = join(home, '.tool', 'sub', 'b.conf');
  writeFileSync(a, 'keep=1\n');
  chmodSync(a, 0o640);
  const root = join(home, '.repo-harness', 'config');
  const gate = () => openHostConfigGate({ env: { HOME: home } });
  const change = (path: string, value: string, extra: Partial<HostConfigFileChange['fragments'][number]> = {}): HostConfigFileChange =>
    ({ path, fragments: [{ owner: 'o1', selector: 'rh', kind: 'add', strategy: keyLine, value, ...extra }] });
  const ledger = () => JSON.parse(readFileSync(join(root, 'ledger.json'), 'utf8'));
  return { home, a, b, root, gate, change, ledger };
}

test('every write has a ledger record before a revert, and a revert touches no path without one', () => {
  const f = fixture();
  const c = join(f.home, '.charlie.conf');
  writeFileSync(c, 'rh=user\n');
  expect(f.gate().apply([f.change(f.a, 'on'), f.change(f.b, 'on')]).written).toEqual([f.a, f.b]);
  const files = f.ledger().files;
  expect({ a: files[f.a].kind, b: files[f.b].kind, dirs: files[f.b].created_dirs, c: files[c] })
    .toEqual({ a: 'text_block', b: 'created', dirs: [join(f.home, '.tool'), join(f.home, '.tool', 'sub')], c: undefined });
  expect(f.gate().revert().map((entry) => [entry.path, entry.action])).toEqual([[f.a, 'text_removed'], [f.b, 'removed']]);
  expect({ a: readFileSync(f.a, 'utf8'), mode: statSync(f.a).mode & 0o777, tool: existsSync(join(f.home, '.tool')), c: readFileSync(c, 'utf8') })
    .toEqual({ a: 'keep=1\n', mode: 0o640, tool: false, c: 'rh=user\n' });
  expect(f.ledger()).toEqual({ protocol: 1, files: {}, fragments: [] });
});

test('rh backs up user bytes before it replaces them, and a revert restores the backup', () => {
  const f = fixture();
  // A delegated writer replaces a user file: the old bytes go to the vault first.
  f.gate().delegate([f.a], ([destination]) => writeFileSync(destination!, 'external\n'));
  const { kind, backup } = f.ledger().files[f.a];
  expect({ kind, vault: readFileSync(join(f.root, 'vault', String(backup).replace('sha256:', '')), 'utf8') }).toEqual({ kind: 'replaced', vault: 'keep=1\n' });
  expect(f.gate().revert([f.a]).map((entry) => entry.action)).toEqual(['restored']);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');

  // An explicit override keeps the replaced user text in the vault, and a revert puts it back.
  const skipped = f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'override' })]);
  expect(skipped).toEqual({ written: [], skipped: [{ code: 'host_config_override_skipped', file: f.a, owner: 'o1', selector: 'keep' }] });
  f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'override', selected: true })]);
  const override = f.ledger().fragments[0];
  expect(override.edit).toEqual({ removed_vault: expect.stringMatching(/^sha256:/), inserted: 'keep=x\n' });
  f.gate().apply([f.change(f.a, 'y', { selector: 'keep', kind: 'refresh', selected: true })]);
  expect(f.ledger().fragments[0].edit.removed_vault).toBe(override.edit.removed_vault);
  expect(f.gate().revert().map((entry) => entry.action)).toEqual(['text_removed']);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');
  for (const entry of [f.root, join(f.root, 'vault')]) expect(statSync(entry).mode & 0o777).toBe(0o700);
});

test('a revert keeps and reports a file whose rh bytes the user edited', () => {
  const f = fixture();
  f.gate().apply([f.change(f.a, 'on'), f.change(f.b, 'on')]);
  writeFileSync(f.a, 'keep=1\nrh=user\n');
  writeFileSync(f.b, 'rh=on\nmine=1\n');
  expect(f.gate().revert().map((entry) => [entry.path, entry.action])).toEqual([[f.a, 'kept_edited'], [f.b, 'kept_edited']]);
  expect({ a: readFileSync(f.a, 'utf8'), b: readFileSync(f.b, 'utf8') }).toEqual({ a: 'keep=1\nrh=user\n', b: 'rh=on\nmine=1\n' });
  expect(Object.keys(f.ledger().files)).toEqual([f.a, f.b]);
  // The write itself re-reads the target: bytes that rh did not see are never overwritten.
  expect(() => replaceTarget(f.a as HostPath, Buffer.from('rh\n'), { existed: true, sha256: `sha256:${'0'.repeat(64)}` }))
    .toThrow(expect.objectContaining({ code: 'host_config_target_changed' }));
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\nrh=user\n');
});

test('an edit since rh last wrote a file is a sticky external change, also when rh writes nothing now', () => {
  const f = fixture();
  f.gate().apply([f.change(f.a, 'on')]);
  const committed = f.ledger().files[f.a].committed;
  writeFileSync(f.a, 'keep=1\nrh=on\nuser=1\n');
  expect(f.gate().apply([f.change(f.a, 'on')]).written).toEqual([]);
  expect(f.ledger().files[f.a]).toMatchObject({ external_change: true, committed });

  const g = fixture();
  g.gate().apply([g.change(g.a, 'on')]);
  writeFileSync(g.a, 'keep=1\nrh=on\nuser=1\n');
  expect(g.gate().delegate([g.a], () => {}).changed).toEqual([]);
  expect(g.ledger().files[g.a].external_change).toBe(true);
});

test('A8: another owner on a recorded selector, a parent and a child selector, or one selector twice write nothing', () => {
  const f = fixture();
  const owners = { path: f.a, fragments: [
    { owner: 'o1', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '1' },
    { owner: 'o2', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '2' },
  ] };
  const nested = { path: f.b, fragments: [
    { owner: 'o1', selector: 'mcp', kind: 'add' as const, strategy: keyLine, value: '1' },
    { owner: 'o1', selector: 'mcp.codegraph', kind: 'add' as const, strategy: keyLine, value: '2' },
  ] };
  const twice = { path: f.a, fragments: [
    { owner: 'o1', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '1' },
    { owner: 'o1', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '1' },
  ] };
  for (const change of [owners, nested, twice]) {
    expect(() => f.gate().apply([change])).toThrow(expect.objectContaining({ code: 'host_config_fragment_overlap' }));
  }
  expect({ a: readFileSync(f.a, 'utf8'), b: existsSync(f.b) }).toEqual({ a: 'keep=1\n', b: false });
  f.gate().apply([f.change(f.a, '1')]);
  expect(() => f.gate().apply([f.change(f.a, '2', { owner: 'o2' })])).toThrow(expect.objectContaining({ code: 'host_config_fragment_overlap' }));
  // A fragment whose text is already in place is still recorded, without a file write.
  expect(f.gate().apply([f.change(f.a, '1', { selector: 'keep' })]).written).toEqual([]);
  expect(() => f.gate().apply([f.change(f.a, '2', { owner: 'o2', selector: 'keep' })])).toThrow(expect.objectContaining({ code: 'host_config_fragment_overlap' }));
});

test('a target inside ~/.repo-harness is refused, also through a user link', () => {
  const f = fixture();
  mkdirSync(join(f.home, '.repo-harness'), { recursive: true });
  symlinkSync(join(f.home, '.repo-harness'), join(f.home, '.into-harness'));
  for (const path of [join(f.home, '.repo-harness', 'config.json'), join(f.home, '.into-harness', 'x.conf')]) {
    expect(() => f.gate().apply([f.change(path, 'on')])).toThrow(expect.objectContaining({ code: 'host_config_invalid_path' }));
  }
});

test('user links are followed: the real file is written and the link stays', () => {
  const f = fixture();
  mkdirSync(join(f.home, 'dotfiles'));
  symlinkSync(join(f.home, 'dotfiles'), join(f.home, '.linked'));
  symlinkSync(join(f.home, 'dotfiles', 'later.conf'), join(f.home, '.dangling.conf'));
  linkSync(f.a, join(f.home, '.hard'));
  const real = join(f.home, 'dotfiles', 'x.conf'), later = join(f.home, 'dotfiles', 'later.conf');
  expect(f.gate().apply([f.change(join(f.home, '.linked', 'x.conf'), 'on'), f.change(join(f.home, '.dangling.conf'), 'on'), f.change(f.a, 'on')]).written)
    .toEqual([real, later, f.a]);
  expect({ keys: Object.keys(f.ledger().files), linked: lstatSync(join(f.home, '.linked')).isSymbolicLink(), dangling: readFileSync(join(f.home, '.dangling.conf'), 'utf8') })
    .toEqual({ keys: [real, later, f.a], linked: true, dangling: 'rh=on\n' });
  let destinations: readonly string[] = [];
  f.gate().delegate([join(f.home, '.linked', 'y.conf')], (resolved) => { destinations = resolved; });
  expect(destinations).toEqual([join(f.home, 'dotfiles', 'y.conf')]);
  expect(() => f.gate().apply([f.change(real, 'a'), f.change(join(f.home, '.linked', 'x.conf'), 'b')])).toThrow(expect.objectContaining({ code: 'host_config_invalid_state' }));
});
