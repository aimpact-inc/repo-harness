import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FragmentEdit, HostConfigStrategy, HostPath } from '../../src/core/host-config/types';
import { openHostConfigGate, rollbackHostConfigTransaction, type HostConfigFileChange } from '../../src/effects/host-config/gate';
import type { PathEntry } from '../../src/effects/host-config/whole-path';
import { hostConfigPaths, migrateLedgerSchema, parseLedger, replaceTarget } from '../../src/effects/host-config/store';
import { hookRenderingKey, jsonFragment, removeJsonHookCommand } from '../../src/core/host-config/json-fragment';
import { sha256Prefixed } from '../../src/core/evidence/sha256';
import { tomlFragment } from '../../src/core/host-config/toml-fragment';
import { markedBlock } from '../../src/core/host-config/marked-block';
import { insertUserPathEntry, listsUserPathEntry, removeUserPathEntry, type UserPathValue } from '../../src/core/host-config/path-entry';

/** A `key=value` line format: the selector is the key. */
function keyLineMatch(content: string, selector: string): RegExpExecArray | null {
  return new RegExp(`^${selector.replace(/\./g, '\\.')}=.*\\n`, 'm').exec(content);
}
function keyLineEdit(content: string, selector: string, value: string): FragmentEdit {
  const match = keyLineMatch(content, selector);
  const inserted = `${selector}=${value}\n`;
  return match ? { at: match.index, removed: match[0], inserted } : { at: content.length, removed: '', inserted };
}
const keyLine: HostConfigStrategy<string> = {
  locate: (content, selector) => { const match = keyLineMatch(content, selector); return match ? { start: match.index, end: match.index + match[0].length } : null; },
  apply: keyLineEdit,
};

/** The same format with an edit of the value only: the inserted text does not name its selector. */
const valueOnly: HostConfigStrategy<string> = {
  locate: () => null,
  apply: (content, selector, value) => {
    const match = new RegExp(`^${selector}=(.*)$`, 'm').exec(content)!;
    return { at: match.index + selector.length + 1, removed: match[1]!, inserted: value };
  },
};

/** The whole `key=...` line is the value: '' deletes the line, and a missing key appends it. */
const wholeLine: HostConfigStrategy<string> = { locate: () => null, apply: (content, selector, value) => ({ ...keyLineEdit(content, selector, ''), inserted: value }) };

/** Replaces the first occurrence of the selector's own text: value '' deletes it. */
const ownText: HostConfigStrategy<string> = { locate: () => null, apply: (content, selector, value) => ({ at: content.indexOf(selector), removed: selector, inserted: value }) };

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

test('an install-owned whole path refuses every gate operation and stays in the ledger; a protocol 1 or 2 ledger names rh update', () => {
  const f = fixture();
  const skill = join(f.home, '.claude', 'skills', 'owned');
  const inside = join(skill, 'SKILL.md');
  mkdirSync(skill, { recursive: true });
  writeFileSync(inside, 'rh=user\n');
  f.gate().apply([f.change(f.a, 'on')]);
  const paths = { [skill]: { owner: 'core', host: 'claude', kind: 'created', baseline: { state: 'unknown' }, committed: { type: 'directory', sha256: `sha256:${'0'.repeat(64)}` } } };
  writeFileSync(join(f.root, 'ledger.json'), JSON.stringify({ ...f.ledger(), paths }));
  const operations = [
    () => f.gate().apply([f.change(inside, 'on')]),
    () => f.gate().adopt(inside, { backup: null, fragments: [], externalChange: false }),
    () => f.gate().revert([inside]),
    () => f.gate().removeUnrecordedText(inside, sha256Prefixed(readFileSync(inside)), []),
  ];
  for (const operation of operations) expect(operation).toThrow(`an install owns this whole path (${skill})`);
  expect(() => f.gate().writePaths([{ path: inside, owner: 'core', entry: { type: 'file', bytes: Buffer.from('x') } }])).toThrow(`the recorded directory ${skill} holds this path`);
  expect(readFileSync(inside, 'utf8')).toBe('rh=user\n');
  // A write elsewhere keeps the path records.
  f.gate().apply([f.change(f.b, 'on')]);
  expect(f.ledger().paths).toEqual(paths);

  const { paths: _paths, retired: _retired, recovery: _recovery, tools: _tools, ...textRecords } = f.ledger();
  const retirement = { retired: [{ sha256: `sha256:${'a'.repeat(64)}`, at: '2026-11-01T00:00:00.000Z' }], recovery: [] };
  for (const [old, refusal, moved, kept] of [
    [{ ...textRecords, protocol: 1 }, 'the ledger is protocol 1, which has no path records; run: rh update', {}, { retired: [], recovery: [] }],
    [{ ...textRecords, protocol: 2, paths }, 'the ledger is protocol 2, which has no retirement records; run: rh update', paths, { retired: [], recovery: [] }],
    [{ ...textRecords, protocol: 3, paths, ...retirement }, 'the ledger is protocol 3, which has no tool records; run: rh update', paths, retirement],
  ] as const) {
    writeFileSync(join(f.root, 'ledger.json'), JSON.stringify(old));
    expect(() => f.gate().recorded(f.a)).toThrow(refusal);
    // A preview reads the ledger as the move would leave it, and writes nothing.
    expect(openHostConfigGate({ env: { HOME: f.home }, preview: true }).recorded(f.a)).toEqual(textRecords.fragments.filter((entry: { file: string }) => entry.file === f.a));
    // The one-shot move keeps every record and adds the empty new maps; a second run writes nothing.
    migrateLedgerSchema(hostConfigPaths({ HOME: f.home }));
    expect(f.ledger()).toEqual({ ...textRecords, protocol: 4, paths: moved, ...kept, tools: {} });
    const bytes = readFileSync(join(f.root, 'ledger.json'));
    migrateLedgerSchema(hostConfigPaths({ HOME: f.home }));
    expect(readFileSync(join(f.root, 'ledger.json'))).toEqual(bytes);
  }
});

test.each([undefined, '\n', '\r\n', '\r', '\n\n', 'user text', null])('ledger checks fragment separator %p', (separator) => {
  const f = fixture();
  f.gate().apply([f.change(f.a, 'on')]);
  const ledger = f.ledger();
  ledger.fragments[0].separator = separator;
  const parse = () => parseLedger(Buffer.from(JSON.stringify(ledger)), 'fixture');
  if (separator === undefined || separator === '\n' || separator === '\r\n') expect(parse().fragments[0]?.separator).toBe(separator);
  else expect(parse).toThrow('the ledger has an invalid shape');
});

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
  const vault = (reference: unknown) => readFileSync(join(root, 'vault', String(reference).replace('sha256:', '')), 'utf8');
  /** Selected overrides in `a`, one per selector. */
  const select = (strategy: HostConfigStrategy<string>, values: Record<string, string>) => gate().apply([{ path: a, fragments: Object.entries(values)
    .map(([selector, value]) => ({ owner: 'o1', selector, kind: 'override' as const, strategy, value, selected: true })) }]);
  return { home, a, b, root, gate, change, ledger, vault, select };
}

test('every write has a ledger record before a revert, and a revert touches no path without one', () => {
  const f = fixture();
  const c = join(f.home, '.charlie.conf');
  const b2 = join(f.home, '.tool', 'sub', 'b2.conf');
  writeFileSync(c, 'rh=user\n');
  expect(f.gate().apply([f.change(f.a, 'on'), f.change(f.b, 'on'), f.change(b2, 'on')]).written).toEqual([f.a, f.b, b2]);
  const files = f.ledger().files;
  expect({ a: files[f.a].kind, b: files[f.b].kind, dirs: f.ledger().directories, c: files[c] })
    .toEqual({ a: 'text_block', b: 'created', dirs: [join(f.home, '.tool'), join(f.home, '.tool', 'sub')], c: undefined });
  // b and b2 share the created directories: they go after both files.
  expect(f.gate().revert().map((entry) => [entry.path, entry.action])).toEqual([[f.a, 'text_removed'], [f.b, 'removed'], [b2, 'removed']]);
  expect({ a: readFileSync(f.a, 'utf8'), mode: statSync(f.a).mode & 0o777, tool: existsSync(join(f.home, '.tool')), c: readFileSync(c, 'utf8') })
    .toEqual({ a: 'keep=1\n', mode: 0o640, tool: false, c: 'rh=user\n' });
  // The revert retires the backup of `a`, which no record references any more.
  expect(f.ledger()).toEqual({ protocol: 4, files: {}, fragments: [], directories: [], paths: {}, recovery: [], tools: {},
    retired: [{ sha256: files[f.a].backup, at: expect.any(String) }] });

  // A failed ledger write stops the file write.
  chmodSync(f.root, 0o500);
  try {
    expect(() => f.gate().apply([f.change(f.a, 'on')])).toThrow(expect.objectContaining({ code: 'EACCES' }));
    const removal = (content: string) => ({ at: 0, removed: content.slice(0, 7), inserted: '' });
    expect(() => f.gate().removeUnrecordedText(f.a, sha256Prefixed(readFileSync(f.a)), [removal])).toThrow(expect.objectContaining({ code: 'EACCES' }));
  } finally { chmodSync(f.root, 0o700); }
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');
});

test('rh backs up user bytes before it replaces them, and a revert restores the backup', () => {
  const f = fixture();
  // An explicit override backs up the whole user file, a refresh keeps that backup, and a revert puts it back.
  const skipped = f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'override' })]);
  expect(skipped).toEqual({ written: [], skipped: [{ code: 'host_config_override_skipped', file: f.a, owner: 'o1', selector: 'keep' }] });
  f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'override', selected: true })]);
  const overrideBackup = f.ledger().files[f.a].backup;
  expect(f.vault(overrideBackup)).toBe('keep=1\n');
  f.gate().apply([f.change(f.a, 'y', { selector: 'keep', kind: 'refresh', selected: true })]);
  expect(f.ledger().files[f.a].backup).toBe(overrideBackup);
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
});

test('a file that the user edited before a later rh write is kept by a revert; the first backup stays, and the edited file goes to the vault apart', () => {
  for (const first of ['created', 'text_block'] as const) {
    {
      const f = fixture();
      const path = first === 'created' ? join(f.home, '.new.conf') : f.a;
      f.gate().apply([f.change(path, '1')]);
      writeFileSync(path, 'rh=1\nuser=precious\n');
      f.gate().apply([f.change(path, '2')]);
      const record = f.ledger().files[path];
      expect({ kind: record.kind, backup: record.backup === null ? null : f.vault(record.backup), external: f.vault(record.external_backup), revert: f.gate().revert().map((entry) => entry.action), text: readFileSync(path, 'utf8') })
        .toEqual({ kind: first, backup: first === 'created' ? null : 'keep=1\n', external: 'rh=1\nuser=precious\n', revert: ['kept_edited'], text: 'rh=2\nuser=precious\n' });
    }
  }
});

test('a file with rh text blocks reverts to its backup only while it holds the bytes rh recorded', () => {
  const f = fixture();
  const set = (values: Record<string, string>) => f.select(valueOnly, values);
  // One value at two selectors and an empty insertion revert exactly.
  writeFileSync(f.a, 'a=false\nb=false\nc=x\n');
  set({ a: 'true', b: 'true', c: '' });
  expect(readFileSync(f.a, 'utf8')).toBe('a=true\nb=true\nc=\n');
  expect(f.gate().revert().map((entry) => entry.action)).toEqual(['text_removed']);
  expect(readFileSync(f.a, 'utf8')).toBe('a=false\nb=false\nc=x\n');
  // The user changed rh's value and put the same text at another selector: the file stays.
  set({ a: 'true' });
  writeFileSync(f.a, 'a=custom\nb=true\nc=x\n');
  expect(f.gate().revert().map((entry) => entry.action)).toEqual(['kept_edited']);
  expect(readFileSync(f.a, 'utf8')).toBe('a=custom\nb=true\nc=x\n');
});

test('a revert restores the exact bytes from before rh, whatever the order of rh edits at one offset', () => {
  const users = 'a=USER-A\nb=USER-B\n';
  const runs: [HostConfigStrategy<string>, string, Record<string, string>[]][] = [
    [ownText, 'ab', [{ a: '', b: '' }]], [ownText, 'ab', [{ b: '', a: '' }]], [ownText, 'ab', [{ a: '', b: 'x' }]],
    [ownText, 'ab', [{ a: '' }, { b: '' }]], [ownText, 'ab', [{ b: '' }, { a: '' }]], [ownText, 'ab', [{ b: 'x' }, { a: '' }]],
    // Deleted lines, then a refresh of the second one or of both in reverse request order.
    [wholeLine, users, [{ a: '', b: '' }, { b: 'b=RH\n' }]], [wholeLine, users, [{ a: '' }, { b: '' }, { b: 'b=RH\n' }]],
    [wholeLine, users, [{ a: '', b: '' }, { b: 'b=RH\n', a: 'a=RH\n' }]],
  ];
  for (const [strategy, start, calls] of runs) {
    const f = fixture();
    writeFileSync(f.a, start);
    for (const values of calls) f.select(strategy, values);
    expect({ revert: f.gate().revert().map((entry) => entry.action), text: readFileSync(f.a, 'utf8') }).toEqual({ revert: ['text_removed'], text: start });
  }
});

test('a created directory keeps its record until a revert removes it', () => {
  const f = fixture();
  const b2 = join(f.home, '.tool', 'sub', 'b2.conf');
  const created = [join(f.home, '.tool'), join(f.home, '.tool', 'sub')];
  f.gate().apply([f.change(f.b, 'on'), f.change(b2, 'on')]);
  writeFileSync(b2, 'rh=on\nmine=1\n');
  expect(f.gate().revert().map((entry) => entry.action)).toEqual(['removed', 'kept_edited']);
  expect(f.ledger().directories).toEqual(created);
  writeFileSync(b2, 'rh=on\n');
  expect(f.gate().revert([b2]).map((entry) => entry.action)).toEqual(['removed']);
  expect({ tool: existsSync(created[0]!), directories: f.ledger().directories }).toEqual({ tool: false, directories: [] });
});

test('a user value at a recorded selector stays unless selected, and its bytes go to the vault before rh writes over them', () => {
  const f = fixture();
  writeFileSync(f.a, 'setting=original\n');
  const setting = (value: string, extra: Partial<HostConfigFileChange['fragments'][number]>) => f.gate().apply([f.change(f.a, value, { selector: 'setting', ...extra })]);
  setting('rh1', { kind: 'override', selected: true });
  writeFileSync(f.a, 'setting=USER-EDIT\n');
  expect(setting('rh2', { kind: 'refresh' })).toEqual({ written: [], skipped: [{ code: 'host_config_user_value_kept', file: f.a, owner: 'o1', selector: 'setting' }] });
  expect(readFileSync(f.a, 'utf8')).toBe('setting=USER-EDIT\n');
  setting('rh2', { kind: 'refresh', selected: true });
  expect({ backup: f.vault(f.ledger().files[f.a].backup), external: f.vault(f.ledger().files[f.a].external_backup), revert: f.gate().revert().map((entry) => entry.action), text: readFileSync(f.a, 'utf8') })
    .toEqual({ backup: 'setting=original\n', external: 'setting=USER-EDIT\n', revert: ['kept_edited'], text: 'setting=rh2\n' });
});

test('a revert releases a fragment claim that needed no write, for a named path and for all', () => {
  for (const only of [[], undefined]) {
    const f = fixture();
    writeFileSync(f.a, 'rh=on\n');
    expect(f.gate().apply([f.change(f.a, 'on')]).written).toEqual([]);
    expect(f.gate().revert(only && [f.a])).toEqual([{ path: f.a, action: 'released', baseline: 'proved' }]);
    expect(f.gate().apply([f.change(f.a, 'on', { owner: 'o2' })]).written).toEqual([]);
    expect(readFileSync(f.a, 'utf8')).toBe('rh=on\n');
  }
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
  expect(() => f.gate().apply([f.change(real, 'a'), f.change(join(f.home, '.linked', 'x.conf'), 'b')])).toThrow(expect.objectContaining({ code: 'host_config_invalid_state' }));
});

const RULES = '<!-- BEGIN: repo-harness global-working-rules -->\nrules\n<!-- END: repo-harness global-working-rules -->';
test.each([
  ['an empty JSON document', 'c.json', [{ selector: 'mcpServers.codegraph', strategy: jsonFragment, value: { command: 'cg' } }], '{}\n'],
  ['a blank TOML file', 'c.toml', [{ selector: 'mcp_servers.codegraph', strategy: tomlFragment, value: '[mcp_servers.codegraph]\ncommand = "cg"\n' }], '\n'],
  ['a blank Markdown file', 'c.md', [{ selector: 'global-working-rules', strategy: markedBlock, value: RULES }], '\n'],
] as const)('a file that rh created and the user reset to %s loses only its records; the revert does not unlink it', (_name, name, fragments, reset) => {
  const f = fixture();
  const path = join(f.home, name);
  f.gate().apply([{ path, fragments: fragments.map((fragment) => ({ owner: 'o1', kind: 'add' as const, ...fragment })) }]);
  expect(f.ledger().files[path].kind).toBe('created');
  writeFileSync(path, reset);
  expect(f.gate().revert([path], { dryRun: true })).toEqual([{ path, action: 'released' }]);
  expect(f.gate().revert([path])).toEqual([{ path, action: 'released' }]);
  expect({ bytes: readFileSync(path, 'utf8'), recorded: Object.keys(f.ledger().files) }).toEqual({ bytes: reset, recorded: [] });
});

test('a created file with one fragment the user took out and one intact: the revert takes out the intact text and keeps the file', () => {
  const f = fixture();
  const path = join(f.home, 'c.toml');
  const root = 'default_mode_request_user_input = true\n';
  f.gate().apply([{ path, fragments: [
    { owner: 'o1', selector: 'default_mode_request_user_input', kind: 'add', strategy: tomlFragment, value: root },
    { owner: 'o1', selector: 'mcp_servers.codegraph', kind: 'add', strategy: tomlFragment, value: '[mcp_servers.codegraph]\ncommand = "cg"\n' },
  ] }]);
  writeFileSync(path, readFileSync(path, 'utf8').replace(root, ''));
  expect(f.gate().revert([path])).toEqual([{ path, action: 'text_removed' }]);
  expect({ exists: existsSync(path), bytes: readFileSync(path, 'utf8').trim(), recorded: Object.keys(f.ledger().files) }).toEqual({ exists: true, bytes: '', recorded: [] });
});

test('a linked config whose target has no extension reverts by the format recorded at write time; a dangling link keeps its records', () => {
  const f = fixture();
  const [config, target] = [join(f.home, '.claude.json'), join(f.home, 'dotfiles', 'claude-config')];
  mkdirSync(join(f.home, 'dotfiles'));
  writeFileSync(target, '{\n  "theme": "dark"\n}\n');
  symlinkSync(target, config);
  const statusLine = { owner: 'o1', selector: 'statusLine', kind: 'add' as const, strategy: jsonFragment, value: 'rh' };
  f.gate().apply([{ path: config, backup: 'overrides-only', fragments: [statusLine] }]);
  expect(f.ledger().files[target].format).toBe('json');
  expect(f.gate().revert([config])).toEqual([{ path: target, action: 'text_removed', baseline: 'proved' }]);
  expect({ bytes: readFileSync(target, 'utf8'), link: lstatSync(config).isSymbolicLink() }).toEqual({ bytes: '{\n  "theme": "dark"\n}\n', link: true });

  // The link stays when its target goes, so the file is not absent: the records stay for a later revert.
  f.gate().apply([{ path: config, backup: 'overrides-only', fragments: [statusLine] }]);
  rmSync(target);
  expect(f.gate().revert([config])).toEqual([{ path: target, action: 'kept_edited', kept: ['statusLine'] }]);
  expect(f.gate().recorded(config).map((entry) => entry.selector)).toEqual(['statusLine']);
});

test('a file written at a user link goes to the file that the link names; the link stays through write, rollback and revert', () => {
  const f = fixture();
  const agents = join(f.home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(f.home, 'dotfiles'));
  const [linked, dangling, repointed] = [join(agents, 'l.md'), join(agents, 'd.md'), join(agents, 'r.md')];
  const [target, created, other] = [join(f.home, 'dotfiles', 'l.md'), join(f.home, 'dotfiles', 'new', 'd.md'), join(f.home, 'dotfiles', 'r.md')];
  writeFileSync(target, 'mine\n');
  writeFileSync(other, 'rh\n');
  symlinkSync(target, linked);
  symlinkSync(created, dangling);
  symlinkSync(join(f.home, 'dotfiles', 'first.md'), repointed);
  const write = (path: string, replace = false) => ({ path, owner: 'core', entry: { type: 'file', bytes: Buffer.from('rh\n') } as PathEntry, replace });
  const state = () => ({ target: readFileSync(target, 'utf8'), created: existsSync(created) ? readFileSync(created, 'utf8') : null,
    links: [linked, dangling].map((path) => lstatSync(path).isSymbolicLink()) });
  expect(() => f.gate().writePaths([write(linked)])).toThrow(`rh has no record of it, so rh does not replace it: ${linked}`);

  // A rollback puts the user file back from the vault and takes out the file and directory that rh created.
  const transaction = mkdtempSync(join(f.home, 'tx-'));
  expect(f.gate().writePaths([write(linked, true), write(dangling)], { transaction })).toEqual([linked, dangling]);
  expect(state()).toEqual({ target: 'rh\n', created: 'rh\n', links: [true, true] });
  expect(rollbackHostConfigTransaction(join(f.home, '.repo-harness'), null, transaction).unresolved).toEqual([]);
  expect({ ...state(), directory: existsSync(join(f.home, 'dotfiles', 'new')) }).toEqual({ target: 'mine\n', created: null, links: [true, true], directory: false });

  // The record keys the link and names the file; a revert gives the user file back and removes only the created file.
  f.gate().writePaths([write(linked, true), write(dangling), write(repointed)]);
  const sha = sha256Prefixed(Buffer.from('rh\n'));
  expect(f.ledger().paths[linked]).toMatchObject({ kind: 'replaced', link_target: target, committed: { type: 'file', sha256: sha } });
  expect({ vault: f.vault(f.ledger().paths[linked].backup), dangling: f.ledger().paths[dangling] })
    .toMatchObject({ vault: 'mine\n', dangling: { kind: 'created', link_target: created, baseline: { state: 'known', existed: false } } });
  // A link that now names another file with the same bytes is not rh's entry.
  rmSync(repointed);
  symlinkSync(other, repointed);
  expect(f.gate().revertPaths([linked, dangling, repointed]).map((entry) => [entry.path, entry.action]))
    .toEqual([[linked, 'restored'], [dangling, 'removed'], [repointed, 'kept_edited']]);
  expect(state()).toEqual({ target: 'mine\n', created: null, links: [true, true] });
});

test('a refresh with no recorded fragment is an override, adopt records an old write once, and a dry-run revert writes nothing', () => {
  const f = fixture();
  expect(f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'refresh' })]).skipped.map((entry) => entry.code)).toEqual(['host_config_override_skipped']);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');

  writeFileSync(f.a, 'keep=1\nrh=old\n');
  const adoption = { backup: Buffer.from('keep=1\n'), fragments: [{ owner: 'o1', selector: 'rh', kind: 'add' as const, inserted: 'rh=old\n' }], externalChange: false };
  expect([f.gate().adopt(f.a, adoption), f.gate().adopt(f.a, { ...adoption, backup: null })]).toEqual(['adopted', 'recorded']);
  expect(f.ledger().files[f.a]).toMatchObject({ kind: 'text_block', baseline: { state: 'unknown' }, external_change: false });
  expect(f.gate().revert([f.a], { dryRun: true })).toEqual([{ path: f.a, action: 'text_removed', baseline: 'unknown' }]);
  expect({ text: readFileSync(f.a, 'utf8'), recorded: Object.keys(f.ledger().files) }).toEqual({ text: 'keep=1\nrh=old\n', recorded: [f.a] });
  expect(f.gate().revert([f.a]).map((entry) => entry.action)).toEqual(['text_removed']);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');
});

test('after a user edit, a revert removes intact add fragments, also after a refresh, restores an intact override from the first backup, and keeps an edited fragment', () => {
  const f = fixture();
  const path = join(f.home, 'conf.json');
  writeFileSync(path, '{"user":1,"o":"user"}');
  const json = (selector: string, kind: 'add' | 'refresh' | 'override', value: unknown) => ({ owner: 'o1', selector, kind, strategy: jsonFragment, value, selected: kind === 'override' });
  f.gate().apply([{ path, fragments: [json('a', 'add', 1), json('b', 'add', 1), json('o', 'override', 'rh')] }]);
  writeFileSync(path, readFileSync(path, 'utf8').replace('"user":1', '"user":2'));
  // The refresh after the outside edit keeps the first backup as the restore target and keeps the outside edit apart; the fragment kind stays `add`.
  const first = f.ledger().files[path].backup;
  f.gate().apply([{ path, fragments: [json('a', 'refresh', 2)] }]);
  expect([f.ledger().files[path].backup, typeof f.ledger().files[path].external_backup]).toEqual([first, 'string']);
  expect(f.ledger().fragments.map((entry: { selector: string; kind: string }) => [entry.selector, entry.kind])).toEqual([['b', 'add'], ['o', 'override'], ['a', 'add']]);
  writeFileSync(path, readFileSync(path, 'utf8').replace('"b":1', '"b":9'));
  expect(f.gate().revert([path])).toEqual([{ path, action: 'kept_edited', kept: ['b'] }]);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ user: 2, o: 'user', b: 9 });
  expect(f.ledger().fragments.map((entry: { selector: string }) => entry.selector)).toEqual(['b']);
});

test('a revert removes an emptied container only when the record proves rh created it, also under an owner filter; an override backup is 0600', () => {
  const f = fixture();
  const path = join(f.home, '.claude.json');
  const allow = { owner: 'o1', selector: 'permissions.allow[rule]', kind: 'add' as const, strategy: jsonFragment, value: 'rule' };
  for (const [original, filter, left] of [
    ['{"permissions":{"allow":[]},"theme":"dark"}', undefined, { permissions: { allow: [] }, theme: 'light' }],
    ['{"permissions":{"allow":[]},"theme":"dark"}', { owner: 'o1' }, { permissions: { allow: [] }, theme: 'light' }],
    ['{"permissions":{},"theme":"dark"}', { owner: 'o1' }, { permissions: {}, theme: 'light' }],
    ['{"theme":"dark"}', undefined, { theme: 'light' }],
    ['{"theme":"dark"}', { owner: 'o1' }, { theme: 'light' }],
  ] as const) {
    writeFileSync(path, original);
    f.gate().apply([{ path, backup: 'overrides-only', fragments: [allow] }]);
    writeFileSync(path, readFileSync(path, 'utf8').replace('dark', 'light'));
    expect(f.gate().revert([path], filter).map((entry) => entry.action), original).toEqual(['text_removed']);
    expect(JSON.parse(readFileSync(path, 'utf8')), original).toEqual(left);
    if (filter) f.gate().revert([path]);
  }
  writeFileSync(path, '{"mcpServers":{"codegraph":{"command":"user"}}}');
  const backup = f.gate().apply([{ path, backup: 'overrides-only', fragments: [{ owner: 'o1', selector: 'mcpServers.codegraph', kind: 'override', strategy: jsonFragment, value: { command: 'rh' }, selected: true }] }]);
  expect(backup.written.length).toBe(1);
  expect(statSync(join(f.root, 'vault', String(f.ledger().files[path].backup).replace('sha256:', ''))).mode & 0o777).toBe(0o600);
});

test('a removal of unrecorded text checks the hash and each step, keeps the file before in the vault, and a revert never puts the text back', () => {
  const f = fixture();
  const sha = (text: string) => sha256Prefixed(Buffer.from(text));
  const legacy = '{"type": "command", "command": "bash legacy.sh"}, ';
  const before = `{\n\t"user": 1,\n\t"hooks": {\n\t\t"Stop": [\n\t\t\t{ "hooks": [ ${legacy}{"type":"command","command":"echo user"} ] }\n\t\t]\n\t}\n}\n`;
  const after = before.replace(legacy, '');
  const rendering = hookRenderingKey({ event: 'Stop', block: {}, hook: { type: 'command', command: 'bash legacy.sh' } });
  const remove = [(content: string) => removeJsonHookCommand(content, { event: 'Stop', block: 0, index: 0, command: 'bash legacy.sh', rendering })];
  const path = join(f.home, 'hooks.json');
  writeFileSync(path, before);
  expect(() => f.gate().removeUnrecordedText(path, sha(`${before} `), remove)).toThrow('the file changed since rh planned its removal');
  expect(() => f.gate().removeUnrecordedText(path, sha(before), [() => ({ at: 0, removed: '{', inserted: '[' })])).toThrow('a removal must only take out text that is in the file');
  expect({ file: readFileSync(path, 'utf8'), ledger: existsSync(join(f.root, 'ledger.json')) }).toEqual({ file: before, ledger: false });

  // No record: the file is released by a revert, with no fragment record.
  expect(f.gate().removeUnrecordedText(path, sha(before), remove)).toBe(sha(after));
  expect(readFileSync(path, 'utf8')).toBe(after);
  expect(f.ledger()).toMatchObject({ fragments: [], files: { [path]: { kind: 'text_block', baseline: { state: 'unknown' }, committed: { type: 'file', sha256: sha(after) }, backup: null, external_backup: sha(before), external_change: false } } });
  expect(f.vault(sha(before))).toBe(before);
  expect(f.gate().revert([path], { dryRun: true })).toEqual([{ path, action: 'released', baseline: 'unknown' }]);

  // A recorded file whose backup still holds the legacy command: a revert takes out rh's fragment only.
  const recorded = join(f.home, 'settings.json');
  writeFileSync(recorded, before);
  f.gate().apply([{ path: recorded, fragments: [{ owner: 'o1', selector: 'statusLine', kind: 'add', strategy: jsonFragment, value: 'rh' }] }]);
  const added = readFileSync(recorded, 'utf8');
  expect(f.vault(f.ledger().files[recorded].backup)).toBe(before);
  expect(f.gate().removeUnrecordedText(recorded, sha(added), remove)).toBe(sha(added.replace(legacy, '')));
  expect(f.ledger().files[recorded]).toMatchObject({ external_backup: sha(added), external_change: true, committed: { type: 'file', sha256: sha(added.replace(legacy, '')) } });
  expect(f.gate().revert([recorded]).map((entry) => entry.action)).toEqual(['text_removed']);
  expect(readFileSync(recorded, 'utf8')).toBe(after);
});

test('a whole-path write records its entry first; delegate, a transaction rollback and a revert follow the records', () => {
  const f = fixture();
  const claude = join(f.home, '.claude');
  const [file, link, tree, user] = [join(claude, 'agents', 'a.md'), join(claude, 'commands', 'c.md'), join(claude, 'skills', 's'), join(claude, 'agents', 'u.md')];
  const source = (text: string) => { const dir = mkdtempSync(join(f.home, 'src-')); writeFileSync(join(dir, 'SKILL.md'), text); return dir; };
  const bytes = (text: string): PathEntry => ({ type: 'file', bytes: Buffer.from(text) });
  const w = (path: string, entry: PathEntry, replace = false) => ({ path, owner: 'core', entry, replace });
  expect(f.gate().writePaths([w(file, bytes('rh\n')), w(link, { type: 'symlink', target: file }), w(tree, { type: 'directory', source: source('v1\n') })])).toEqual([file, link, tree]);
  expect(f.gate().writePaths([w(file, bytes('rh\n'))])).toEqual([]);
  expect(f.ledger().paths[file]).toMatchObject({ owner: 'core', host: 'claude', kind: 'created', baseline: { state: 'known', existed: false } });
  // A file that rh has no record of stays without the user's word; with it, its bytes go to the vault first.
  writeFileSync(user, 'mine\n');
  expect(() => f.gate().writePaths([w(user, bytes('rh\n'))])).toThrow(`rh has no record of it, so rh does not replace it: ${user}`);
  f.gate().writePaths([w(user, bytes('rh\n'), true)]);
  expect({ kind: f.ledger().paths[user].kind, vault: f.vault(f.ledger().paths[user].backup) }).toEqual({ kind: 'replaced', vault: 'mine\n' });

  // In a transaction rh refreshes the tree in process and the file out of process, and adds two files; the user edits one.
  const snapshot = readFileSync(join(f.root, 'ledger.json'));
  const transaction = mkdtempSync(join(f.home, 'tx-'));
  const [added, edited] = [join(claude, 'agents', 'n.md'), join(claude, 'agents', 'e.md')];
  f.gate().writePaths([w(tree, { type: 'directory', source: source('v2\n') }), w(added, bytes('new\n')), w(edited, bytes('new\n'))], { transaction });
  expect(f.gate().delegate([{ path: file, owner: 'core' }], ([target]) => writeFileSync(target!, 'rh2\n'), { transaction }).changed).toEqual([file]);
  writeFileSync(edited, 'new\nuser\n');
  expect(rollbackHostConfigTransaction(join(f.home, '.repo-harness'), snapshot, transaction).unresolved).toEqual([edited]);
  expect({ tree: readFileSync(join(tree, 'SKILL.md'), 'utf8'), file: readFileSync(file, 'utf8'), added: existsSync(added), edited: readFileSync(edited, 'utf8') })
    .toEqual({ tree: 'v1\n', file: 'rh\n', added: false, edited: 'new\nuser\n' });
  expect(Object.keys(f.ledger().paths)).toEqual([file, link, tree, user, edited]);

  // A revert undoes each entry that is as rh recorded it; a changed entry stays with its record.
  rmSync(link);
  symlinkSync(user, link);
  expect(f.gate().revertPaths([file, link, tree, user, edited]).map((entry) => [entry.path, entry.action]))
    .toEqual([[file, 'removed'], [link, 'kept_edited'], [tree, 'removed'], [user, 'restored'], [edited, 'kept_edited']]);
  expect({ user: readFileSync(user, 'utf8'), file: existsSync(file), tree: existsSync(tree), paths: Object.keys(f.ledger().paths) })
    .toEqual({ user: 'mine\n', file: false, tree: false, paths: [link, edited] });
});

test('a delegated writer runs only on paths that rh may write; a replaced path stays a file; a rollback undoes a revert of a replaced file', () => {
  const f = fixture();
  const agents = join(f.home, '.claude', 'agents');
  const [unrecorded, edited, kept, foreign, user, blocks] = ['u', 'e', 'k', 'f', 'r', 't'].map((name) => join(agents, `${name}.md`)) as [string, string, string, string, string, string];
  const file = (text: string): PathEntry => ({ type: 'file', bytes: Buffer.from(text) });
  f.gate().writePaths([{ path: edited, owner: 'core', entry: file('rh\n') }, { path: foreign, owner: 'o2', entry: file('o2\n') }]);
  writeFileSync(edited, 'rh\nuser\n');
  writeFileSync(unrecorded, 'theirs\n');
  writeFileSync(kept, 'mine\n');
  f.gate().keepUserPaths('core', [kept], [kept]);
  const ledger = f.ledger();
  for (const [path, reason] of [[unrecorded, 'rh has no record of it'], [edited, 'it changed since rh wrote it'], [kept, 'the user keeps it'], [foreign, 'rh records it for o2']] as const) {
    const before = readFileSync(path, 'utf8');
    let ran = false;
    expect(() => f.gate().delegate([{ path, owner: 'core' }], () => { ran = true; })).toThrow(`${reason}, so rh does not replace it: ${path}`);
    expect({ ran, bytes: readFileSync(path, 'utf8') }).toEqual({ ran: false, bytes: before });
  }
  expect(f.ledger()).toEqual(ledger);

  // On the user's word the file goes to the vault before the writer runs, and the path stays a file.
  writeFileSync(user, 'original\n');
  expect(f.gate().delegate([{ path: user, owner: 'core', replace: true }], ([target]) => writeFileSync(target!, 'rh\n')).changed).toEqual([user]);
  expect({ kind: f.ledger().paths[user].kind, vault: f.vault(f.ledger().paths[user].backup) }).toEqual({ kind: 'replaced', vault: 'original\n' });
  expect(() => f.gate().writePaths([{ path: user, owner: 'core', entry: { type: 'symlink', target: edited } }]))
    .toThrow(`rh replaced a user file here, so it writes only a file at this path: ${user}`);
  expect({ bytes: readFileSync(user, 'utf8'), kind: f.ledger().paths[user].kind }).toEqual({ bytes: 'rh\n', kind: 'replaced' });

  // A rollback undoes a revert in its transaction: rh's file and its record come back.
  const snapshot = readFileSync(join(f.root, 'ledger.json'));
  const transaction = mkdtempSync(join(f.home, 'tx-'));
  expect(f.gate().revertPaths([user], { transaction }).map((entry) => entry.action)).toEqual(['restored']);
  expect(rollbackHostConfigTransaction(join(f.home, '.repo-harness'), snapshot, transaction).unresolved).toEqual([]);
  expect({ bytes: readFileSync(user, 'utf8'), record: f.ledger().paths[user] }).toEqual({ bytes: 'rh\n', record: JSON.parse(snapshot.toString()).paths[user] });

  // A file with rh text blocks is no whole path.
  writeFileSync(blocks, 'keep=1\n');
  f.gate().apply([f.change(blocks, 'on')]);
  expect(() => f.gate().writePaths([{ path: blocks, owner: 'core', entry: file('rh\n') }]))
    .toThrow(`rh text blocks are recorded in this file, so rh does not write it as a whole path: ${blocks}`);
});

test('an extra empty directory is kept as an edit during refresh and removal', () => {
  const f = fixture();
  const source = mkdtempSync(join(f.home, 'source-'));
  writeFileSync(join(source, 'SKILL.md'), 'rh\n');
  const path = join(f.home, '.claude/skills/with-drafts');
  const write = { path, owner: 'core', entry: { type: 'directory' as const, source } };
  f.gate().writePaths([write]);
  const record = f.ledger().paths[path];
  mkdirSync(join(path, 'drafts'));
  writeFileSync(join(source, 'SKILL.md'), 'next\n');
  expect(() => f.gate().writePaths([write])).toThrow('it changed since rh wrote it');
  expect(f.gate().revertPaths([path])).toEqual([{ path, action: 'kept_edited' }]);
  expect(readdirSync(join(path, 'drafts'))).toEqual([]);
  expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe('rh\n');
  expect(f.ledger().paths[path]).toEqual(record);
});

test('rollback restores pre-run absence and keeps a path edited after the write', () => {
  for (const delegated of [false, true]) for (const edited of [false, true]) {
    const f = fixture();
    const path = join(f.home, '.claude/agents/absent.md');
    const write = { path, owner: 'core', entry: { type: 'file' as const, bytes: Buffer.from('rh\n') } };
    f.gate().writePaths([write]);
    const snapshot = readFileSync(join(f.root, 'ledger.json'));
    rmSync(path);
    const transaction = mkdtempSync(join(f.home, 'tx-'));
    if (delegated) f.gate().delegate([{ path, owner: 'core' }], ([key]) => writeFileSync(key!, 'rh\n'), { transaction });
    else f.gate().writePaths([write], { transaction });
    if (edited) writeFileSync(path, 'user edit\n');
    expect(rollbackHostConfigTransaction(join(f.home, '.repo-harness'), snapshot, transaction).unresolved).toEqual(edited ? [path] : []);
    expect(existsSync(path)).toBe(edited);
    if (edited) expect(readFileSync(path, 'utf8')).toBe('user edit\n');
    expect(f.ledger().paths[path]).toBeDefined();
  }
});

test.each(['absent', 'symlink', 'directory'] as const)('delegate keeps the replacement record after an invalid %s result', result => {
  for (const alreadyReplaced of [false, true]) {
    const f = fixture();
    const path = join(f.home, '.claude/agents/replacement.md');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'user bytes\n');
    if (alreadyReplaced) f.gate().writePaths([{ path, owner: 'core', replace: true, entry: { type: 'file', bytes: Buffer.from('rh bytes\n') } }]);
    const before = alreadyReplaced ? f.ledger().paths[path] : undefined;
    expect(() => f.gate().delegate([{ path, owner: 'core', replace: true }], ([destination]) => {
      rmSync(destination!);
      if (result === 'symlink') symlinkSync(f.a, destination!);
      if (result === 'directory') { mkdirSync(destination!); writeFileSync(join(destination!, 'keep.txt'), 'keep\n'); }
    })).toThrow('the delegated writer did not leave a file');
    const record = f.ledger().paths[path];
    expect(record).toMatchObject({ kind: 'replaced', owner: 'core', committed: { type: 'file' } });
    expect(f.vault(record.backup)).toBe('user bytes\n');
    if (alreadyReplaced) expect(record).toEqual(before);
    if (result === 'absent') expect(existsSync(path)).toBe(false);
    if (result === 'symlink') expect(lstatSync(path).isSymbolicLink()).toBe(true);
    if (result === 'directory') expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('keep\n');
  }
});

test('an overrides-only file with an add before the override reverts by fragment to the bytes before rh', () => {
  const f = fixture();
  const path = join(f.home, '.claude.json');
  const before = '{\n  "user": 1,\n  "mcpServers": {"x": {"command": "user"}}\n}\n';
  writeFileSync(path, before);
  const apply = (selector: string, kind: 'add' | 'override', value: unknown) =>
    f.gate().apply([{ path, backup: 'overrides-only', fragments: [{ owner: 'o1', selector, kind, strategy: jsonFragment, value, selected: true }] }]);
  apply('mcpServers.codegraph', 'add', { command: 'codegraph' });
  apply('mcpServers.x', 'override', { command: 'rh' });
  // The backup came at the override, so it still holds rh's add: it is not the restore target.
  expect(f.ledger().files[path].backup).not.toBe(f.ledger().files[path].baseline.sha256);
  expect(f.gate().revert([path])).toEqual([{ path, action: 'text_removed', baseline: 'proved' }]);
  expect(readFileSync(path, 'utf8')).toBe(before);
});

test('a fragment already at its inverse loses its record with no write: a removed add, and an override set back to the backup', () => {
  const f = fixture();
  const path = join(f.home, '.claude.json');
  writeFileSync(path, '{\n  "x": "user"\n}\n');
  f.gate().apply([{ path, fragments: [
    { owner: 'o1', selector: 'added', kind: 'add', strategy: jsonFragment, value: 'rh' },
    { owner: 'o1', selector: 'x', kind: 'override', strategy: jsonFragment, value: 'rh', selected: true },
  ] }]);
  writeFileSync(path, '{\n  "x": "user",\n  "later": true\n}\n');
  const edited = statSync(path).mtimeMs;
  // The file changed after rh wrote it, so no baseline proof is claimed.
  expect(f.gate().revert([path])).toEqual([{ path, action: 'released' }]);
  expect([readFileSync(path, 'utf8'), statSync(path).mtimeMs, f.ledger().files, f.ledger().fragments]).toEqual(['{\n  "x": "user",\n  "later": true\n}\n', edited, {}, []]);
});

test('a rollback reads a ledger snapshot of an older protocol, which a parent took before a newer candidate moved the ledger', () => {
  const f = fixture();
  f.gate().apply([f.change(f.b, 'on')]);
  const { retired: _retired, recovery: _recovery, tools: _tools, ...older } = f.ledger();
  const snapshot = Buffer.from(JSON.stringify({ ...older, protocol: 2 }));
  f.gate().apply([f.change(f.a, 'on')]);
  expect(rollbackHostConfigTransaction(join(f.home, '.repo-harness'), snapshot, mkdtempSync(join(f.home, 'tx-'))).unresolved).toEqual([]);
  // A clean rollback leaves the snapshot's protocol 2 bytes, which the older parent reads.
  expect([readFileSync(f.a, 'utf8'), readFileSync(join(f.root, 'ledger.json'))]).toEqual(['keep=1\n', snapshot]);
});

test('a delegated installer gets records for the declared fragments that it created only; a change outside them is reported, and no revert touches it', () => {
  const f = fixture();
  const path = join(f.home, '.tool', 'settings.json');
  const entry = '../.bun/install/global/node_modules/pkg';
  const selector = `packages[${entry}]`;
  const declared = [{ path, owner: 'pi', selectors: [selector] }];
  const read = () => JSON.parse(readFileSync(path, 'utf8'));
  /** A stub installer: it rewrites the whole file, as Pi does. */
  const install = (extra: Record<string, unknown> = {}) => ([file]: readonly string[]) => {
    const settings = existsSync(file!) ? JSON.parse(readFileSync(file!, 'utf8')) : {};
    writeFileSync(file!, `${JSON.stringify({ ...settings, ...extra, packages: [...(settings.packages ?? []), entry] }, null, 2)}\n`);
  };
  const remove = ([file]: readonly string[]) => {
    const settings = JSON.parse(readFileSync(file!, 'utf8'));
    writeFileSync(file!, `${JSON.stringify({ ...settings, packages: settings.packages.filter((value: string) => value !== entry) }, null, 2)}\n`);
  };

  // A new file with one declared and one undeclared key: only the declared key is recorded, and a revert takes out only it.
  mkdirSync(join(path, '..'), { recursive: true });
  expect(f.gate().delegate(declared, install({ undeclared: true }))).toEqual({ changed: [path], unattributed: [{ code: 'host_config_unattributed_diff', path, sha256: sha256Prefixed(readFileSync(path)) }] });
  expect(f.ledger().fragments).toEqual([{ file: path, owner: 'pi', selector, kind: 'add', inserted: JSON.stringify(entry), created: 'packages' }]);
  expect(f.ledger().files[path]).toMatchObject({ kind: 'created', external_change: true });
  expect(f.gate().revert([path]).map((result) => result.action)).toEqual(['text_removed']);
  expect(read()).toEqual({ undeclared: true });

  // An existing file that the installer only adds to: the revert gives back its bytes.
  const before = `${JSON.stringify({ user: 1 }, null, 2)}\n`;
  writeFileSync(path, before);
  expect(f.gate().delegate(declared, install()).unattributed).toEqual([]);
  expect(f.ledger().files[path]).toMatchObject({ kind: 'text_block', backup: null, external_change: false });
  expect(f.gate().revert([path])).toEqual([{ path, action: 'text_removed', baseline: 'proved' }]);
  expect(readFileSync(path, 'utf8')).toBe(before);

  // An entry that was there before the call is never claimed.
  install()([path]);
  expect(f.gate().delegate(declared, () => {})).toEqual({ changed: [], unattributed: [] });
  expect(f.ledger().files[path]).toBeUndefined();

  // The tool's remove command: a leftover keeps the record; a removal drops it, and the file stays.
  writeFileSync(path, before);
  f.gate().delegate(declared, install());
  expect(f.gate().delegate(declared, () => {}).changed).toEqual([]);
  expect(f.gate().recorded(path).map((record) => record.selector)).toEqual([selector]);
  expect(f.gate().delegate(declared, remove).changed).toEqual([path]);
  expect([f.gate().recorded(path), f.ledger().files[path], read()]).toEqual([[], undefined, { user: 1, packages: [] }]);

  // A killed installer call: the records come first, so the rollback takes out the declared key and leaves the undeclared one.
  writeFileSync(path, before);
  const snapshot = readFileSync(join(f.root, 'ledger.json'));
  const transaction = mkdtempSync(join(f.home, 'tx-'));
  const script = `const fs = require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({ user: 1, undeclared: true, packages: [${JSON.stringify(entry)}] }, null, 2) + '\\n'); process.kill(process.pid, 'SIGKILL');`;
  expect(() => f.gate().delegate(declared, ([file]) => {
    const child = Bun.spawnSync([process.execPath, '-e', script, file!]);
    if (child.signalCode) throw new Error(`installer killed: ${child.signalCode}`);
  }, { transaction })).toThrow('installer killed: SIGKILL');
  expect(f.gate().recorded(path).map((record) => record.selector)).toEqual([selector]);
  expect(rollbackHostConfigTransaction(join(f.home, '.repo-harness'), snapshot, transaction).unresolved).toEqual([]);
  expect(read()).toEqual({ user: 1, undeclared: true });

  // Ownership probe P1: an entry that is gone now loses its record at that read, and a later revert never takes out a re-created entry.
  f.gate().delegate(declared, install());
  writeFileSync(path, `${JSON.stringify({ user: 1, undeclared: true, packages: [] }, null, 2)}\n`);
  expect(f.gate().revert([path]).map((result) => result.action)).toEqual(['released']);
  install()([path]);
  expect([f.gate().revert([path]), read()]).toEqual([[], { user: 1, undeclared: true, packages: [entry] }]);

  // Ownership probe P2: a declared fragment whose text differs from the record is reported and stays, with no whole-file action.
  const lock = join(f.home, '.tool', 'lock.json');
  writeFileSync(lock, `${JSON.stringify({ skills: { user: {} } }, null, 2)}\n`);
  f.gate().delegate([{ path: lock, owner: 'core', selectors: ['skills.think'] }], ([file]) => {
    writeFileSync(file!, `${JSON.stringify({ skills: { user: {}, think: { source: 'a' } } }, null, 2)}\n`);
  });
  const edited = `${JSON.stringify({ skills: { user: {}, think: { source: 'b' } } }, null, 2)}\n`;
  writeFileSync(lock, edited);
  expect([f.gate().revert([lock]), readFileSync(lock, 'utf8'), f.gate().recorded(lock).map((record) => record.selector)])
    .toEqual([[{ path: lock, action: 'kept_edited', kept: ['skills.think'] }], edited, ['skills.think']]);

  // A file that its strategy cannot read stops the call before the installer runs.
  writeFileSync(path, '{ not json');
  let ran = false;
  expect(() => f.gate().delegate(declared, () => { ran = true; })).toThrow('the file is not valid JSON');
  expect(ran).toBe(false);
});

const DIR = 'C:\\Users\\u\\AppData\\Local\\Programs\\herdr-core';
test.each([
  ['an absent value', { existed: false, kind: 'ExpandString', raw: '' }, DIR],
  ['an empty value', { existed: true, kind: 'String', raw: '' }, DIR],
  ['one entry', { existed: true, kind: 'ExpandString', raw: '%USERPROFILE%\\bin' }, `%USERPROFILE%\\bin;${DIR}`],
  ['a trailing separator', { existed: true, kind: 'ExpandString', raw: 'a;' }, `a;${DIR}`],
] as const)('the user PATH entry goes into %s and its removal gives the same value and kind back', (_label, before, after) => {
  expect(listsUserPathEntry(before.raw, DIR)).toBe(false);
  const { next, record } = insertUserPathEntry(before, DIR);
  expect(next).toEqual({ existed: true, kind: before.kind, raw: after });
  expect(listsUserPathEntry(next.raw, `${DIR.toUpperCase()}\\`)).toBe(true);
  expect(removeUserPathEntry(next, record)).toEqual(before);
});

test.each([
  ['a later append stays', `a;${DIR};b`, 'a;b'],
  ['a duplicate stays', `a;${DIR};${DIR}`, null],
  ['a case change stays', `a;${DIR.toLowerCase()}`, null],
  ['an edited entry stays', `a;${DIR}\\sub`, null],
  ['an entry moved to the front stays', `${DIR};a`, null],
] as const)('the user PATH entry after a user edit: %s', (_label, raw, left) => {
  const { record } = insertUserPathEntry({ existed: true, kind: 'ExpandString', raw: 'a' }, DIR);
  const value: UserPathValue = { existed: true, kind: 'ExpandString', raw };
  expect(removeUserPathEntry(value, record)).toEqual(left === null ? null : { ...value, raw: left });
});

// Tool records (#2853). P3: an entry that existed before the writer ran is never claimed, also when the writer rewrites it.
// The rollback keeps a tool record only while the entry that the transaction created holds the recorded bytes.
test.each([
  { label: 'a created entry, rolled back while unchanged', existing: false, after: 'none', record: true },
  { label: 'a created entry, changed before the rollback', existing: false, after: 'edit', record: false },
  { label: 'an entry that existed before the writer', existing: true, after: 'none', record: false },
] as const)('tool record: %s', ({ existing, after, record }) => {
  const f = fixture();
  const dir = join(f.home, '.local', 'bin');
  if (existing) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'tool'), 'user\n'); }
  const snapshot = existsSync(join(f.root, 'ledger.json')) ? readFileSync(join(f.root, 'ledger.json')) : null;
  f.gate().delegate([{ tool: 'herdr-core', version: '1.0.0', directory: dir, entries: ['tool'] }], ([at]) => {
    mkdirSync(at!, { recursive: true });
    writeFileSync(join(at!, 'tool'), 'rh\n');
  });
  if (after === 'edit') writeFileSync(join(dir, 'tool'), 'user edit\n');
  expect(rollbackHostConfigTransaction(join(f.home, '.repo-harness'), snapshot, mkdtempSync(join(f.home, 'tx-'))).unresolved).toEqual([]);
  const tools = existsSync(join(f.root, 'ledger.json')) ? f.ledger().tools : {};
  expect(tools).toEqual(record ? { 'herdr-core': { installed_by: 'rh-install', removable: true, version: '1.0.0', directories: [join(f.home, '.local'), dir],
    paths: { [join(dir, 'tool')]: { committed: { type: 'file', sha256: sha256Prefixed(Buffer.from('rh\n')) } } } } } : {});
});
