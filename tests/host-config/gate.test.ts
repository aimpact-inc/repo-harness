import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FragmentEdit, HostConfigStrategy, HostPath } from '../../src/core/host-config/types';
import {
  AntigravityHooksPathError,
  antigravityAgentsDirPath,
  antigravityGlobalRulesPath,
  antigravityMcpConfigPath,
  antigravitySkillsDirPath,
  openHostConfigGate,
  resolveUserConfigFile,
  openRepositoryFileGate,
  rollbackHostConfigTransaction,
  type HostConfigFileChange,
} from '../../src/effects/host-config/gate';
import { configDiff, configStatus } from '../../src/effects/host-config/inspect';
import { pathRecordHost } from '../../src/effects/host-config/path-records';
import { openRepositoryGate, repositoryConfigPaths, repositoryExcludePath } from '../../src/effects/host-config/repository';
import { observeEntryIdentity, type PathEntry } from '../../src/effects/host-config/whole-path';
import { hostConfigPaths, hostConfigPathsAt, migrateLedgerSchema, parseLedger, putVault, readProjectedLedger, replaceTarget } from '../../src/effects/host-config/store';
import { hookRenderingKey, jsonFragment, removeJsonHookCommand } from '../../src/core/host-config/json-fragment';
import { sha256Prefixed } from '../../src/core/evidence/sha256';
import { tomlFragment } from '../../src/core/host-config/toml-fragment';
import { markedBlock } from '../../src/core/host-config/marked-block';
import { insertUserPathEntry, listsUserPathEntry, removeUserPathEntry } from '../../src/core/host-config/path-entry';

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
    [{ ...textRecords, protocol: 4, paths, ...retirement, tools: {} }, 'the ledger is protocol 4, which has no entry identity; run: rh update', paths, retirement],
  ] as const) {
    writeFileSync(join(f.root, 'ledger.json'), JSON.stringify(old));
    expect(() => f.gate().recorded(f.a)).toThrow(refusal);
    // A preview reads the ledger as the move would leave it, and writes nothing.
    expect(openHostConfigGate({ env: { HOME: f.home }, preview: true }).recorded(f.a)).toEqual(textRecords.fragments.filter((entry: { file: string }) => entry.file === f.a));
    // The one-shot move keeps every record and adds the empty new maps; a second run writes nothing.
    migrateLedgerSchema(hostConfigPaths({ HOME: f.home }));
    expect(f.ledger()).toEqual({ ...textRecords, protocol: 5, paths: moved, ...kept, tools: {} });
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
  expect(f.ledger()).toEqual({ protocol: 5, files: {}, fragments: [], directories: [], paths: {}, recovery: [], tools: {},
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

test('a whole-path write refuses a dangling link, the user\'s word to replace through a link, and a link below the install root', () => {
  const f = fixture();
  const agents = join(f.home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(f.home, 'dotfiles', 'rules'), { recursive: true });
  const [linked, dangling] = [join(agents, 'l.md'), join(agents, 'd.md')];
  const [target, created] = [join(f.home, 'dotfiles', 'l.md'), join(f.home, 'dotfiles', 'new', 'd.md')];
  writeFileSync(target, 'mine\n');
  symlinkSync(target, linked);
  symlinkSync(created, dangling);
  const rules = join(f.home, '.claude', 'rules');
  symlinkSync(join(f.home, 'dotfiles', 'rules'), rules);
  symlinkSync(join(f.home, 'missing'), join(f.home, '.bun'));
  const write = (path: string, replace = false) => ({ path, owner: 'core', entry: { type: 'file', bytes: Buffer.from('rh\n') } as PathEntry, replace });
  for (const [path, replace, message] of [
    [linked, false, `rh has no record of it, so rh does not replace it: ${linked}`],
    [linked, true, `the user's word to replace a file does not reach through a link: ${linked}`],
    [dangling, false, `this path is a link to the missing ${created}, so rh creates nothing through it: ${dangling}`],
    [join(rules, 'english.md'), false, `${rules} is a link below the install root ${join(f.home, '.claude')}`],
    [join(f.home, '.bun', 'bin', 'rh'), false, `${join(f.home, '.bun')} is a link to a missing path`],
  ] as const) {
    expect(() => f.gate().writePaths([write(path, replace)])).toThrow(message);
    // A user-state refusal: each caller reports it per path, as any other refusal.
    expect(() => f.gate().writePaths([write(path, replace)])).toThrow(expect.objectContaining({ code: 'host_config_replacement_refused' }));
  }
  expect({ target: readFileSync(target, 'utf8'), created: existsSync(join(f.home, 'dotfiles', 'new')), rules: readdirSync(join(f.home, 'dotfiles', 'rules')), missing: existsSync(join(f.home, 'missing')) })
    .toEqual({ target: 'mine\n', created: false, rules: [], missing: false });
  // A link at the install root itself is the user's layout: rh writes below the directory that it names and records the path.
  mkdirSync(join(f.home, 'dotfiles', 'codex'));
  symlinkSync(join(f.home, 'dotfiles', 'codex'), join(f.home, '.codex'));
  const codex = join(f.home, 'dotfiles', 'codex', 'agents', 'a.md');
  expect(f.gate().writePaths([write(join(f.home, '.codex', 'agents', 'a.md'))])).toEqual([codex]);
  expect(Object.keys(f.ledger().paths)).toEqual([codex]);

  // A dangling link above the innermost root (`~/.claude` for `~/.claude/skills`) refuses a skill write and a delegated one.
  const g = fixture();
  symlinkSync(join(g.home, 'missing'), join(g.home, '.claude'));
  const skill = join(g.home, '.claude', 'skills', 'herdr');
  const source = mkdtempSync(join(g.home, 'src-'));
  writeFileSync(join(source, 'SKILL.md'), 'rh\n');
  expect(() => g.gate().writePaths([{ path: skill, owner: 'core', entry: { type: 'directory', source } }])).toThrow(`${join(g.home, '.claude')} is a link to a missing path`);
  expect(() => g.gate().delegate([{ path: skill, owner: 'core' }], () => {})).toThrow(`${join(g.home, '.claude')} is a link to a missing path`);
  expect(existsSync(join(g.home, 'missing'))).toBe(false);
});

test('a record that an earlier release wrote at a user link keeps the link through refresh, rollback and revert', () => {
  const f = fixture();
  const agents = join(f.home, '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  mkdirSync(join(f.home, 'dotfiles'));
  const [linked, owned, repointed] = [join(agents, 'l.md'), join(agents, 'o.md'), join(agents, 'r.md')];
  const [target, ownedTarget, first, other] = ['l.md', 'o.md', 'first.md', 'r.md'].map((name) => join(f.home, 'dotfiles', name)) as [string, string, string, string];
  for (const file of [target, ownedTarget, first, other]) writeFileSync(file, 'rh\n');
  symlinkSync(target, linked);
  symlinkSync(ownedTarget, owned);
  symlinkSync(first, repointed);
  const write = (path: string, text: string) => ({ path, owner: 'core', entry: { type: 'file', bytes: Buffer.from(text) } as PathEntry });
  f.gate().writePaths([write(join(agents, 'seed.md'), 'seed\n')]);
  const sha = sha256Prefixed(Buffer.from('rh\n'));
  const backup = putVault(hostConfigPathsAt(join(f.home, '.repo-harness')), Buffer.from('mine\n'));
  const record = (link_target: string) => ({ owner: 'core', host: 'claude', kind: 'created', baseline: { state: 'known', existed: false }, committed: { type: 'file', sha256: sha }, link_target,
    identity: observeEntryIdentity(link_target) });
  writeFileSync(join(f.root, 'ledger.json'), JSON.stringify({ ...f.ledger(), paths: {
    [linked]: { ...record(target), kind: 'replaced', baseline: { state: 'known', existed: true, sha256: sha256Prefixed(Buffer.from('mine\n')) }, backup },
    [owned]: record(ownedTarget), [repointed]: record(first),
  } }));
  const links = () => [linked, owned, repointed].map((path) => lstatSync(path).isSymbolicLink());

  // A refresh writes the file that the link names; a rollback puts rh's earlier bytes back there.
  const snapshot = readFileSync(join(f.root, 'ledger.json'));
  const transaction = mkdtempSync(join(f.home, 'tx-'));
  expect(f.gate().writePaths([write(owned, 'rh2\n')], { transaction })).toEqual([owned]);
  expect({ bytes: readFileSync(ownedTarget, 'utf8'), links: links() }).toEqual({ bytes: 'rh2\n', links: [true, true, true] });
  expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, transaction).unresolved).toEqual([]);
  expect({ bytes: readFileSync(ownedTarget, 'utf8'), links: links() }).toEqual({ bytes: 'rh\n', links: [true, true, true] });

  // A revert gives the user file back and removes the created file; a link that now names another file with the same bytes is not rh's entry.
  rmSync(repointed);
  symlinkSync(other, repointed);
  expect(f.gate().revertPaths([linked, owned, repointed]).map((entry) => [entry.path, entry.action]))
    .toEqual([[linked, 'restored'], [owned, 'removed'], [repointed, 'kept_edited']]);
  expect({ target: readFileSync(target, 'utf8'), owned: existsSync(ownedTarget), links: links() }).toEqual({ target: 'mine\n', owned: false, links: [true, true, true] });
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
  expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, transaction).unresolved).toEqual([edited]);
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

  // A replaced file that is gone releases its record at that read; its vault copy retires, and a later revert never touches a new file there.
  writeFileSync(user, 'mine\n');
  f.gate().writePaths([w(user, bytes('rh\n'), true)]);
  const backup = f.ledger().paths[user].backup;
  rmSync(user);
  expect(f.gate().revertPaths([user])).toEqual([{ path: user, action: 'released' }]);
  expect({ record: f.ledger().paths[user], retired: f.ledger().retired.map((entry: { sha256: string }) => entry.sha256) }).toEqual({ record: undefined, retired: [backup] });
  writeFileSync(user, 'rh\n');
  expect(f.gate().revertPaths([user])).toEqual([]);
  expect(readFileSync(user, 'utf8')).toBe('rh\n');
});

test('a whole-path write checks every destination before it writes any: a refusal on the last leaf leaves no entry and no record', () => {
  const f = fixture();
  const rules = join(f.home, '.claude', 'rules');
  const leaves = ['a.md', 'b.md', 'c.md', 'english.md'].map((name) => join(rules, name));
  mkdirSync(rules, { recursive: true });
  writeFileSync(leaves[3]!, 'mine\n');
  const writes = leaves.map((path) => ({ path, owner: 'core', entry: { type: 'file' as const, bytes: Buffer.from('rh\n') } }));
  expect(() => f.gate().writePaths(writes)).toThrow(`rh has no record of it, so rh does not replace it: ${leaves[3]}`);
  expect({ entries: readdirSync(rules), mine: readFileSync(leaves[3]!, 'utf8'), paths: existsSync(join(f.root, 'ledger.json')) ? f.ledger().paths : {} })
    .toEqual({ entries: ['english.md'], mine: 'mine\n', paths: {} });
  // A link and a file below it in one call: the first publish would change the path that the second plan checked.
  const user = join(f.home, 'dotfiles');
  mkdirSync(user);
  writeFileSync(join(user, 'x.md'), 'mine\n');
  const agents = join(f.home, '.claude', 'agents');
  expect(() => f.gate().writePaths([{ path: agents, owner: 'core', entry: { type: 'symlink', target: user } }, { ...writes[0]!, path: join(agents, 'x.md') }]))
    .toThrow(`a call names this path and a path above it, so rh writes neither: ${join(agents, 'x.md')}`);
  expect({ agents: existsSync(agents), mine: readFileSync(join(user, 'x.md'), 'utf8') }).toEqual({ agents: false, mine: 'mine\n' });
  let ran = false;
  expect(() => f.gate().delegate([{ path: agents, owner: 'core' }, { path: join(agents, 'x.md'), owner: 'core' }], () => { ran = true; }))
    .toThrow(`a call names this path and a path above it, so rh writes neither: ${join(agents, 'x.md')}`);
  expect(ran).toBe(false);
});

test('a whole path is rh\'s only while it is the entry that rh wrote: a same-bytes copy and a re-made directory are the user\'s', () => {
  const f = fixture();
  const claude = join(f.home, '.claude');
  const [english, skill, inner] = [join(claude, 'rules', 'english.md'), join(claude, 'skills', 's'), join(claude, 'newdir', 'sub', 'x.md')];
  const source = mkdtempSync(join(f.home, 'src-'));
  writeFileSync(join(source, 'SKILL.md'), 'v1\n');
  const w = (path: string, text: string, replace = false) => ({ path, owner: 'core', entry: { type: 'file', bytes: Buffer.from(text) } as PathEntry, replace });
  f.gate().writePaths([w(english, 'rh\n'), { path: skill, owner: 'core', entry: { type: 'directory', source } }, w(inner, 'rh\n')]);
  // A write and a revert of the entry that rh wrote still act on it.
  expect(f.gate().writePaths([w(english, 'rh\n')])).toEqual([]);

  // The user restores the same bytes from a backup: another file-system entry, so rh neither replaces nor removes it. The old
  // file stays aside, so the new one cannot reuse its file id.
  renameSync(english, `${english}.old`);
  writeFileSync(english, 'rh\n');
  const copy = 'it holds the bytes that rh wrote, but it is another file-system entry (a copy or a restore), so rh does not replace it';
  expect(() => f.gate().writePaths([w(english, 'rh2\n')])).toThrow(`${copy}: ${english}. To let rh write it, run the command again with --force: rh keeps this file in the vault first`);
  expect(f.gate().revertPaths([english])).toEqual([{ path: english, action: 'kept_edited', code: 'host_config_entry_replaced' }]);
  expect(readFileSync(english, 'utf8')).toBe('rh\n');
  // On the user's word the copy goes to the vault, and rh records the path as replaced.
  f.gate().writePaths([w(english, 'rh2\n', true)]);
  expect({ kind: f.ledger().paths[english].kind, vault: f.vault(f.ledger().paths[english].backup) }).toEqual({ kind: 'replaced', vault: 'rh\n' });

  // A copied skill directory with rh's tree is kept; the user moves it aside.
  renameSync(skill, `${skill}.moved`);
  mkdirSync(skill);
  writeFileSync(join(skill, 'SKILL.md'), 'v1\n');
  expect(() => f.gate().writePaths([{ path: skill, owner: 'core', entry: { type: 'directory', source } }])).toThrow(`${copy}: ${skill}. Move it aside, then run rh install`);

  // A directory that rh created goes only by rmdir (JD 7001233478): a re-made one that holds a user file stays; an empty one goes.
  rmSync(join(claude, 'newdir'), { recursive: true });
  mkdirSync(join(claude, 'newdir', 'sub'), { recursive: true });
  writeFileSync(join(claude, 'newdir', 'notes.txt'), 'mine\n');
  expect(f.gate().revertPaths([inner])).toEqual([{ path: inner, action: 'released' }]);
  expect({ notes: readFileSync(join(claude, 'newdir', 'notes.txt'), 'utf8'), sub: existsSync(join(claude, 'newdir', 'sub')) }).toEqual({ notes: 'mine\n', sub: false });

  // --force always publishes: over a same-bytes copy of a file whose vault copy has rh's bytes, the record follows the new entry.
  const same = join(claude, 'rules', 'same.md');
  writeFileSync(same, 'rh\n');
  f.gate().writePaths([w(same, 'rh\n', true)]);
  renameSync(same, `${same}.old`);
  writeFileSync(same, 'rh\n');
  f.gate().writePaths([w(same, 'rh\n', true)]);
  expect(f.gate().writePaths([w(same, 'rh2\n')])).toEqual([same]);
});

test('the protocol 5 move adopts each record that its entry still proves, once; a record with no identity is kept and reported on every run', () => {
  const f = fixture();
  const rules = join(f.home, '.claude', 'rules');
  const [proved, edited, added] = ['proved.md', 'edited.md', 'added.md'].map((name) => join(rules, name)) as [string, string, string];
  const w = (path: string, text: string, replace = false) => ({ path, owner: 'core', entry: { type: 'file', bytes: Buffer.from(text) } as PathEntry, replace });
  f.gate().writePaths([w(proved, 'rh\n'), w(edited, 'rh\n')]);
  // A protocol 4 ledger: the records of 0.35 have no identity, and the user edited one file.
  const { protocol: _protocol, ...current } = f.ledger();
  const paths = Object.fromEntries(Object.entries(current.paths as Record<string, Record<string, unknown>>).map(([key, { identity: _identity, ...record }]) => [key, record]));
  const protocol4 = Buffer.from(JSON.stringify({ ...current, protocol: 4, paths }));
  writeFileSync(join(f.root, 'ledger.json'), protocol4);
  writeFileSync(edited, 'rh\nuser\n');
  const projected = readProjectedLedger(hostConfigPaths({ HOME: f.home })).paths;
  migrateLedgerSchema(hostConfigPaths({ HOME: f.home }));
  expect({ proved: f.ledger().paths[proved].identity, edited: f.ledger().paths[edited].identity, projected: projected[proved].identity })
    .toEqual({ proved: observeEntryIdentity(proved)!, edited: undefined, projected: observeEntryIdentity(proved)! });

  // The user puts rh's bytes back: with no identity the record proves nothing, on this run and the next.
  writeFileSync(edited, 'rh\n');
  for (let run = 0; run < 2; run += 1) {
    expect(() => f.gate().writePaths([w(edited, 'rh2\n')])).toThrow(`rh recorded no identity for it, so nothing proves that rh wrote it, so rh does not replace it: ${edited}. To let rh write it, run the command again with --force`);
    expect(f.gate().revertPaths([edited])).toEqual([{ path: edited, action: 'kept_edited', code: 'host_config_identity_missing' }]);
  }
  expect(readFileSync(edited, 'utf8')).toBe('rh\n');

  // A clean rollback to the protocol 4 snapshot puts its bytes back, so a 0.35 parent reads its ledger again; the next move adopts again.
  const transaction = mkdtempSync(join(f.home, 'tx-'));
  f.gate().writePaths([w(added, 'rh\n')], { transaction });
  expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), protocol4, transaction).unresolved).toEqual([]);
  expect({ ledger: readFileSync(join(f.root, 'ledger.json')).equals(protocol4), added: existsSync(added) }).toEqual({ ledger: true, added: false });
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
  expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, transaction).unresolved).toEqual([]);
  // The file that came back is a new file-system entry, so its record has the snapshot's fields and the new identity.
  expect({ bytes: readFileSync(user, 'utf8'), record: { ...f.ledger().paths[user], identity: undefined }, identity: f.ledger().paths[user].identity })
    .toEqual({ bytes: 'rh\n', record: { ...JSON.parse(snapshot.toString()).paths[user], identity: undefined }, identity: observeEntryIdentity(user) });

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
    expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, transaction).unresolved).toEqual(edited ? [path] : []);
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
  expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, mkdtempSync(join(f.home, 'tx-'))).unresolved).toEqual([]);
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
  expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, transaction).unresolved).toEqual([]);
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
] as const)('the user PATH entry goes into %s and keeps the value kind', (_label, before, after) => {
  expect(listsUserPathEntry(before.raw, DIR)).toBe(false);
  const { next } = insertUserPathEntry(before, DIR);
  expect(next).toEqual({ existed: true, kind: before.kind, raw: after });
  expect(listsUserPathEntry(next.raw, `${DIR.toUpperCase()}\\`)).toBe(true);
});

// The removal takes out the text that rh appended and keeps every other byte; a value that rh created goes. It keeps a value whose
// kind changed or that does not list the recorded text exactly once.
test.each([
  ['an absent value', { existed: false, kind: 'ExpandString', raw: '' }, (raw: string) => raw, { existed: false, kind: 'ExpandString', raw: '' }],
  ['an empty value', { existed: true, kind: 'String', raw: '' }, (raw: string) => raw, { existed: true, kind: 'String', raw: '' }],
  ['a trailing separator, then a user entry', { existed: true, kind: 'ExpandString', raw: 'a;' }, (raw: string) => `${raw};b`, { existed: true, kind: 'ExpandString', raw: 'a;b' }],
  ['one entry, then a user entry', { existed: true, kind: 'ExpandString', raw: 'a' }, (raw: string) => `${raw};b`, { existed: true, kind: 'ExpandString', raw: 'a;b' }],
  ['one entry, with the earlier entries gone', { existed: true, kind: 'ExpandString', raw: 'a' }, (raw: string) => raw.slice(2), { existed: true, kind: 'ExpandString', raw: '' }],
  ['an entry in upper case', { existed: true, kind: 'ExpandString', raw: 'a' }, (raw: string) => raw.toUpperCase(), null],
  ['the entry listed twice', { existed: true, kind: 'ExpandString', raw: 'a' }, (raw: string) => `${raw};${DIR}`, null],
] as const)('the user PATH entry comes out of %s', (_label, before, edit, after) => {
  const { next, record } = insertUserPathEntry(before, DIR);
  expect(removeUserPathEntry({ ...next, raw: edit(next.raw) }, record)).toEqual(after);
  expect(removeUserPathEntry({ ...next, kind: next.kind === 'String' ? 'ExpandString' : 'String' }, record)).toBeNull();
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
  expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, mkdtempSync(join(f.home, 'tx-'))).unresolved).toEqual([]);
  const tools = existsSync(join(f.root, 'ledger.json')) ? f.ledger().tools : {};
  const stat = record ? lstatSync(join(dir, 'tool'), { bigint: true }) : null;
  expect(tools).toEqual(record ? { 'herdr-core': { installed_by: 'rh-install', removable: true, version: '1.0.0', directories: [join(f.home, '.local'), dir],
    paths: { [join(dir, 'tool')]: { committed: { type: 'file', sha256: sha256Prefixed(Buffer.from('rh\n')) }, identity: `${stat!.dev}:${stat!.ino}:${stat!.birthtimeNs}` } } } } : {});
});

// Ownership probe P4: a claim released on observation (its target was absent) stays released through a rollback.
test.each([
  { label: 'the whole tool', gone: ['a', 'b'], left: [] },
  { label: 'one path', gone: ['a'], left: ['b'] },
] as const)('tool record: a release of %s survives a rollback', ({ gone, left }) => {
  const f = fixture();
  const dir = join(f.home, '.local', 'bin');
  mkdirSync(dir, { recursive: true });
  f.gate().delegate([{ tool: 'herdr-core', version: '1.0.0', directory: dir, entries: ['a', 'b'] }], ([at]) => {
    for (const name of ['a', 'b']) writeFileSync(join(at!, name), `${name}\n`);
  });
  const snapshot = readFileSync(join(f.root, 'ledger.json'));
  for (const name of gone) rmSync(join(dir, name));
  f.gate().releaseAbsentTools(null);
  expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, mkdtempSync(join(f.home, 'tx-'))).unresolved).toEqual([]);
  expect(Object.keys(f.ledger().tools['herdr-core']?.paths ?? {})).toEqual(left.map((name) => join(dir, name)));
});

// Revert order (P4, #2854): a claim whose write deletes an entry leaves the ledger before the write; a restore keeps its claim and vault
// copy until it lands; a rollback never brings back a claim released on observation. A locked directory forces the failure.
// An `add` taken out of a user file with no backup is a removal too (#3227); a restore of backup bytes still writes first.
test.each(['created path', 'replaced restore fails', 'replaced ledger write fails', 'created file', 'rollback',
  'added text ledger write fails', 'added text write fails', 'added text rollback', 'backed-up added text ledger write fails', 'backed-up added text write fails',
  'override restore ledger write fails'] as const)('revert order: %s', (label) => {
  const f = fixture();
  const agents = join(f.home, '.claude', 'agents');
  const [file, user] = [join(agents, 'a.md'), join(agents, 'u.md')];
  const entry = (text: string): PathEntry => ({ type: 'file', bytes: Buffer.from(text) });
  const locked = (dir: string, run: () => void) => { chmodSync(dir, 0o500); try { run(); } finally { chmodSync(dir, 0o700); } };
  mkdirSync(agents, { recursive: true });
  writeFileSync(user, 'mine\n');
  if (label === 'created path') {
    f.gate().writePaths([{ path: file, owner: 'core', entry: entry('rh\n') }]);
    locked(agents, () => expect(() => f.gate().revertPaths([file])).toThrow());
    // The claim went before the unlink: the entry stays with no claim, and a later revert keeps it.
    expect(f.ledger().paths[file]).toBeUndefined();
    expect(f.gate().revertPaths([file])).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('rh\n');
  } else if (label === 'created file') {
    f.gate().apply([f.change(f.b, 'on')]);
    locked(join(f.home, '.tool', 'sub'), () => expect(() => f.gate().revert([f.b])).toThrow());
    expect(f.ledger().files[f.b]).toBeUndefined();
    expect(f.gate().revert([f.b])).toEqual([]);
    expect(readFileSync(f.b, 'utf8')).toBe('rh=on\n');
  } else if (label.startsWith('added text')) {
    // The global-working-rules block that rh added to the user's file, with no backup.
    const text = join(agents, 'rules.md');
    writeFileSync(text, 'mine\n');
    f.gate().apply([{ path: text, backup: 'overrides-only', fragments: [{ owner: 'o1', selector: 'global-working-rules', kind: 'add', strategy: markedBlock, value: RULES }] }]);
    const added = readFileSync(text, 'utf8');
    expect({ kind: f.ledger().files[text].kind, backup: f.ledger().files[text].backup, block: added.includes(RULES) }).toEqual({ kind: 'text_block', backup: null, block: true });
    if (label === 'added text ledger write fails') {
      // The retire fails first, so the block and its claim both stay; a rerun takes the block out.
      locked(f.root, () => expect(() => f.gate().revert([text])).toThrow());
      expect({ bytes: readFileSync(text, 'utf8'), fragments: f.ledger().fragments.length }).toEqual({ bytes: added, fragments: 1 });
      expect(f.gate().revert([text])).toEqual([{ path: text, action: 'text_removed', baseline: 'proved' }]);
      expect(readFileSync(text, 'utf8')).toBe('mine\n');
    } else if (label === 'added text write fails') {
      // The claim went before the write, as after a kill there: the identical block is no longer rh's, and a later revert keeps it.
      locked(agents, () => expect(() => f.gate().revert([text])).toThrow());
      expect({ record: f.ledger().files[text], fragments: f.ledger().fragments }).toEqual({ record: undefined, fragments: [] });
      expect(f.gate().revert([text])).toEqual([]);
      expect(readFileSync(text, 'utf8')).toBe(added);
    } else {
      // A claim released on observation (the file is gone) stays released through a rollback; a released backup stays retired, so gc can delete it.
      f.gate().apply([f.change(f.a, 'on')]);
      const backup = f.ledger().files[f.a].backup;
      const snapshot = readFileSync(join(f.root, 'ledger.json'));
      rmSync(text);
      rmSync(f.a);
      expect(f.gate().revert([text, f.a]).map((entry) => entry.action)).toEqual(['already_absent', 'already_absent']);
      expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, mkdtempSync(join(f.home, 'tx-'))).unresolved).toEqual([]);
      expect({ files: f.ledger().files, fragments: f.ledger().fragments, retired: f.ledger().retired.map((entry: { sha256: string }) => entry.sha256) })
        .toEqual({ files: {}, fragments: [], retired: [backup] });
      writeFileSync(text, added);
      expect(f.gate().revert([text])).toEqual([]);
      expect(readFileSync(text, 'utf8')).toBe(added);
    }
  } else if (label.startsWith('backed-up added text')) {
    // Only `add` fragments in a file with a backup: the whole-file write of the backup takes out rh's bytes only, so it is a removal too.
    const text = join(agents, 'k.conf');
    writeFileSync(text, 'keep=1\n');
    f.gate().apply([f.change(text, 'on')]);
    const record = f.ledger().files[text];
    expect({ kind: record.kind, backup: f.vault(record.backup) }).toEqual({ kind: 'text_block', backup: 'keep=1\n' });
    if (label === 'backed-up added text ledger write fails') {
      // The retire fails first: no write lands while the claim stays, so no later run can take out a line that the user put back.
      locked(f.root, () => expect(() => f.gate().revert([text])).toThrow());
      expect({ bytes: readFileSync(text, 'utf8'), record: f.ledger().files[text] }).toEqual({ bytes: 'keep=1\nrh=on\n', record });
      expect(f.gate().revert([text]).map((entry) => entry.action)).toEqual(['text_removed']);
      expect(readFileSync(text, 'utf8')).toBe('keep=1\n');
    } else {
      // The claim went before the write, as after a kill there: the identical line is the user's now, and a later revert keeps it.
      locked(agents, () => expect(() => f.gate().revert([text])).toThrow());
      expect(f.ledger().files[text]).toBeUndefined();
      expect(f.gate().revert([text])).toEqual([]);
      expect(readFileSync(text, 'utf8')).toBe('keep=1\nrh=on\n');
    }
  } else if (label === 'override restore ledger write fails') {
    // A whole-file restore of user bytes that an override replaced writes first; the stale record then no longer matches, so a rerun writes nothing.
    f.select(keyLine, { keep: '2' });
    const record = f.ledger().files[f.a];
    expect(readFileSync(f.a, 'utf8')).toBe('keep=2\n');
    locked(f.root, () => expect(() => f.gate().revert([f.a])).toThrow());
    expect({ bytes: readFileSync(f.a, 'utf8'), record: f.ledger().files[f.a] }).toEqual({ bytes: 'keep=1\n', record });
    f.gate().revert([f.a]);
    expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');
  } else if (label === 'rollback') {
    f.gate().writePaths([{ path: file, owner: 'core', entry: entry('rh\n') }, { path: user, owner: 'core', entry: entry('rh\n'), replace: true }]);
    const snapshot = readFileSync(join(f.root, 'ledger.json'));
    rmSync(file);
    rmSync(user);
    const transaction = mkdtempSync(join(f.home, 'tx-'));
    expect(f.gate().revertPaths([file, user], { transaction }).map((reverted) => reverted.action)).toEqual(['released', 'released']);
    expect(rollbackHostConfigTransaction(hostConfigPathsAt(join(f.home, '.repo-harness')), snapshot, transaction).unresolved).toEqual([]);
    expect(f.ledger().paths).toEqual({});
    // A hand reinstall of the same bytes is the user's: a later revert leaves it.
    writeFileSync(file, 'rh\n');
    writeFileSync(user, 'rh\n');
    expect(f.gate().revertPaths([file, user])).toEqual([]);
    expect([readFileSync(file, 'utf8'), readFileSync(user, 'utf8')]).toEqual(['rh\n', 'rh\n']);
  } else {
    f.gate().writePaths([{ path: user, owner: 'core', entry: entry('rh\n'), replace: true }]);
    const record = f.ledger().paths[user];
    if (label === 'replaced restore fails') {
      locked(agents, () => expect(() => f.gate().revertPaths([user])).toThrow());
      expect({ bytes: readFileSync(user, 'utf8'), record: f.ledger().paths[user], vault: f.vault(record.backup) }).toEqual({ bytes: 'rh\n', record, vault: 'mine\n' });
      expect(f.gate().revertPaths([user])).toEqual([{ path: user, action: 'restored' }]);
    } else {
      locked(f.root, () => expect(() => f.gate().revertPaths([user])).toThrow());
      // The user's bytes are back; the stale claim no longer matches them, so a rerun only reports.
      expect({ bytes: readFileSync(user, 'utf8'), record: f.ledger().paths[user] }).toEqual({ bytes: 'mine\n', record });
      expect(f.gate().revertPaths([user])).toEqual([{ path: user, action: 'kept_edited', vault: join(f.root, 'vault', record.backup.slice('sha256:'.length)) }]);
    }
    expect(readFileSync(user, 'utf8')).toBe('mine\n');
  }
});

// Repository records (#2854): `replaced` path records in the ledger of one clone, outside the working tree. P1 `absent`, P2 `edited`,
// P3 `planned bytes changed` (a record needs the planned bytes on disk now). The same relative path under HOME is another file.
test.each([
  { label: 'restored', change: 'none' },
  { label: 'P1 absent', change: 'absent' },
  { label: 'P2 edited', change: 'edited' },
  { label: 'P3 planned bytes changed', change: 'planned' },
  { label: 'D10 the user ledger records it', change: 'user-recorded' },
  { label: 'rh state is never a repository record (#2903)', change: 'outside' },
  { label: 'P6 a link on the way', change: 'link' },
  { label: 'P6 a nested checkout on the way', change: 'nested' },
] as const)('repository record: $label', ({ change }) => {
  const f = fixture();
  const env = { HOME: f.home };
  const worktree = join(f.home, 'repo');
  const repository = { repositoryId: join(worktree, '.git'), worktree };
  const paths = repositoryConfigPaths(env, repository);
  const gate = openRepositoryGate(env, repository);
  const name = change === 'outside' ? '.repo-harness/settings.json' : '.claude/settings.json';
  const [file, home] = [join(worktree, name), join(f.home, name)];
  for (const [path, text] of [[file, 'user\n'], [home, 'home\n']] as const) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); chmodSync(path, 0o640); }
  if (change === 'link') { renameSync(join(worktree, '.claude'), join(worktree, 'elsewhere')); symlinkSync(join(worktree, 'elsewhere'), join(worktree, '.claude')); }
  if (change === 'nested') writeFileSync(join(worktree, '.claude', '.git'), 'gitdir: /elsewhere\n');
  if (change === 'user-recorded') f.gate().apply([f.change(file, 'on')]);
  const userLedger = existsSync(join(f.root, 'ledger.json')) ? readFileSync(join(f.root, 'ledger.json')) : null;
  const expected = sha256Prefixed(readFileSync(file));
  if (change === 'planned') writeFileSync(file, 'user edit\n');
  const write = () => gate.writePaths([{ path: file, owner: 'core', replace: true, expected, entry: { type: 'file', bytes: Buffer.from('stripped\n'), mode: 0o640 } }]);
  const refusals = { planned: 'the file changed since rh planned its write', 'user-recorded': 'the user-level ledger records this file', outside: 'rh records no repository file in .git, .repo-harness, .ai/harness/backups',
    link: `${join(worktree, '.claude')} is a link`, nested: `${join(worktree, '.claude')} holds .git` } as const;
  if (change === 'planned' || change === 'user-recorded' || change === 'outside' || change === 'link' || change === 'nested') {
    expect(write).toThrow(refusals[change]);
    expect({ ledger: existsSync(paths.ledger), vault: existsSync(paths.vault) && readdirSync(paths.vault).length > 0 }).toEqual({ ledger: false, vault: false });
    return;
  }
  expect(write()).toEqual([file]);
  const record = JSON.parse(readFileSync(paths.ledger, 'utf8')).paths[file];
  expect(record).toMatchObject({ owner: 'core', host: 'claude', kind: 'replaced', baseline: { state: 'known', existed: true, sha256: expected } });
  expect([paths.root, join(paths.ledger), join(paths.vault, record.backup.slice('sha256:'.length))].map((path) => statSync(path).mode & 0o777)).toEqual([0o700, 0o600, 0o600]);
  expect(paths.root).toBe(join(f.home, '.repo-harness', 'config', 'repos', sha256Prefixed(Buffer.from(repository.repositoryId)).slice('sha256:'.length)));
  if (change === 'absent') rmSync(file);
  if (change === 'edited') writeFileSync(file, 'stripped\nuser\n');
  const action = ({ none: 'restored', absent: 'released', edited: 'kept_edited' } as const)[change];
  expect(gate.revertPaths([file])).toEqual([{ path: file, action, ...(change === 'edited' ? { vault: join(paths.vault, record.backup.slice('sha256:'.length)) } : {}) }]);
  // Both writes staged in a guarded directory that went with the call: nothing beside the target, no staging left.
  if (change === 'none') expect({ bytes: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777, beside: readdirSync(join(worktree, '.claude')), staging: readdirSync(join(worktree, '.ai/harness/backups/staging')) })
    .toEqual({ bytes: 'user\n', mode: 0o640, beside: ['settings.json'], staging: [] });
  if (change === 'edited') expect({ bytes: readFileSync(file, 'utf8'), record: JSON.parse(readFileSync(paths.ledger, 'utf8')).paths[file] }).toEqual({ bytes: 'stripped\nuser\n', record });
  if (change === 'absent') {
    writeFileSync(file, 'stripped\n');
    expect(gate.revertPaths([file])).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe('stripped\n');
  }
  // Neither ledger reaches the other's file: HOME keeps its bytes and the user ledger is unchanged, and a user revert there leaves the worktree alone.
  expect({ home: readFileSync(home, 'utf8'), user: existsSync(join(f.root, 'ledger.json')) ? readFileSync(join(f.root, 'ledger.json')) : null }).toEqual({ home: 'home\n', user: userLedger });
  const worktreeBytes = readFileSync(file, 'utf8');
  f.gate().apply([f.change(home, 'on')]);
  f.gate().revert([home]);
  expect({ home: readFileSync(home, 'utf8'), worktree: readFileSync(file, 'utf8') }).toEqual({ home: 'home\n', worktree: worktreeBytes });
});

// The repository exclude file (#3080): one `text_block` record with an `add` runtime-state block in the ledger of its clone, no vault copy.
// P1 a file that is gone releases its record; P2 an edited block stays; P6 a link below the common dir, or the exclude file of another
// clone, is refused for the write and for the revert; D10 a file that the user ledger records stays with it.
test.each([
  { label: 'written and reverted', change: 'none' },
  { label: 'P1 absent, then put back by hand', change: 'absent' },
  { label: 'P2 edited block', change: 'edited' },
  { label: 'a note after the END line', change: 'annotated' },
  { label: 'P6 info/ becomes a link after the record', change: 'link-later' },
  { label: 'P6 a linked info/', change: 'link' },
  { label: 'P6 the exclude file of another clone', change: 'other' },
  { label: 'D10 the user ledger records it', change: 'user-recorded' },
] as const)('repository exclude: $label', ({ change }) => {
  const f = fixture();
  const env = { HOME: f.home };
  const repository = { repositoryId: join(f.home, 'repo', '.git'), worktree: join(f.home, 'repo') };
  const paths = repositoryConfigPaths(env, repository);
  const gate = openRepositoryFileGate(env, paths);
  const exclude = repositoryExcludePath(repository);
  const info = join(repository.repositoryId, 'info');
  mkdirSync(info, { recursive: true });
  writeFileSync(exclude, '# git ls-files --others --exclude-from=.git/info/exclude\n*.tmp\n');
  const user = readFileSync(exclude, 'utf8');
  const block = '# BEGIN: repo-harness runtime-state\n.ai/harness/\n# END: repo-harness runtime-state';
  const target = change === 'other' ? join(f.home, 'other', '.git', 'info', 'exclude') : exclude;
  if (change === 'other') { mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, user); }
  if (change === 'link') { renameSync(info, join(f.home, 'elsewhere')); symlinkSync(join(f.home, 'elsewhere'), info); }
  if (change === 'user-recorded') f.gate().apply([f.change(exclude, 'on')]);
  const write = () => gate.apply([{ path: target, backup: 'overrides-only', fragments: [{ owner: 'core', selector: 'runtime-state', kind: 'add', strategy: markedBlock, value: block }] }]);
  const refusals = { link: `${info} is a link`, other: `is not the ledger of ${join(f.home, 'other', '.git')}`, 'user-recorded': 'the user-level ledger records this file' } as const;
  if (change === 'link' || change === 'other' || change === 'user-recorded') {
    const before = readFileSync(target, 'utf8');
    expect(write).toThrow(refusals[change]);
    expect({ ledger: existsSync(paths.ledger), bytes: readFileSync(target, 'utf8') }).toEqual({ ledger: false, bytes: before });
    return;
  }
  expect(write().written).toEqual([exclude]);
  expect(readFileSync(exclude, 'utf8')).toBe(`${user}\n${block}\n`);
  const ledger = JSON.parse(readFileSync(paths.ledger, 'utf8'));
  expect({ record: ledger.files[exclude], fragments: ledger.fragments, vault: existsSync(paths.vault) && readdirSync(paths.vault).length > 0 }).toEqual({
    record: { kind: 'text_block', baseline: { state: 'known', existed: true, sha256: sha256Prefixed(Buffer.from(user)) }, committed: { type: 'file', sha256: sha256Prefixed(readFileSync(exclude)) }, backup: null, external_change: false },
    fragments: [expect.objectContaining({ file: exclude, owner: 'core', selector: 'runtime-state', kind: 'add', inserted: block })], vault: false });
  if (change === 'absent') rmSync(exclude);
  if (change === 'edited') writeFileSync(exclude, readFileSync(exclude, 'utf8').replace('.ai/harness/\n', '.ai/harness/\nmine/\n'));
  if (change === 'link-later') { renameSync(info, join(f.home, 'elsewhere')); symlinkSync(join(f.home, 'elsewhere'), info); }
  if (change === 'annotated') writeFileSync(exclude, `${user}\n${block} (local note)\n`);
  if (change === 'annotated') {
    // A marker is a whole line, so the strategy cannot read the block: it stays, with no join of the note to the rule before it.
    expect(gate.revert().map((entry) => entry.action)).toEqual(['kept_edited']);
    expect(readFileSync(exclude, 'utf8')).toBe(`${user}\n${block} (local note)\n`);
    return;
  }
  if (change === 'link-later') {
    expect(() => gate.revert()).toThrow(`${info} is a link`);
    expect({ bytes: readFileSync(exclude, 'utf8'), record: JSON.parse(readFileSync(paths.ledger, 'utf8')).files[exclude] }).toEqual({ bytes: `${user}\n${block}\n`, record: ledger.files[exclude] });
    return;
  }
  const action = ({ none: 'text_removed', absent: 'already_absent', edited: 'kept_edited' } as const)[change];
  expect(gate.revert({ dryRun: true }).map((entry) => entry.action)).toEqual([action]);
  expect(gate.revert().map((entry) => entry.action)).toEqual([action]);
  if (change === 'none') expect({ bytes: readFileSync(exclude, 'utf8'), files: JSON.parse(readFileSync(paths.ledger, 'utf8')).files }).toEqual({ bytes: user, files: {} });
  if (change === 'edited') expect(readFileSync(exclude, 'utf8')).toContain('mine/');
  if (change === 'absent') {
    writeFileSync(exclude, `${user}\n${block}\n`);
    expect(gate.revert()).toEqual([]);
    expect(readFileSync(exclude, 'utf8')).toBe(`${user}\n${block}\n`);
  }
});

// Storage that holds user bytes ignores itself (#2854 P7, R2): a guard (`.gitignore` with `*`) goes into each vault and preimage
// directory before the first copy, and only into a directory that rh owns. A linked directory without the guard, or a foreign
// `.gitignore`, stops the write with nothing written there. Git reads no user or system config, so a host rule cannot hide a copy.
test.each(['git-managed HOME', 'bare repository with --work-tree=HOME', 'linked vault', 'foreign .gitignore'] as const)('storage guard: %s', (label) => {
  const f = fixture();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const bare = `${f.home}.git`;
  homes.push(bare);
  const gitArgs = label === 'bare repository with --work-tree=HOME' ? ['--git-dir', bare, '--work-tree', f.home] : ['-C', f.home];
  const git = (...args: string[]) => Bun.spawnSync(['git', ...gitArgs, ...args], { env });
  const [vault, dotfiles] = [join(f.root, 'vault'), join(f.home, 'dotfiles')];
  const [agents, user, own] = [join(f.home, '.claude', 'agents'), join(f.home, '.claude', 'agents', 'u.md'), join(f.home, '.claude', 'agents', 'rh.md')];
  mkdirSync(agents, { recursive: true });
  writeFileSync(user, 'sentinel-user-bytes\n');
  mkdirSync(f.root, { recursive: true });
  if (label === 'linked vault') { mkdirSync(dotfiles); symlinkSync(dotfiles, vault); }
  if (label === 'foreign .gitignore') { mkdirSync(vault); writeFileSync(join(vault, '.gitignore'), 'node_modules/\n'); }
  const write = () => f.gate().writePaths([{ path: user, owner: 'core', replace: true, entry: { type: 'file', bytes: Buffer.from('rh\n') } }]);
  if (label === 'linked vault' || label === 'foreign .gitignore') {
    expect(write).toThrow(label === 'foreign .gitignore' ? 'is not the rh guard' : 'which rh does not own');
    const real = label === 'foreign .gitignore' ? vault : dotfiles;
    expect({ user: readFileSync(user, 'utf8'), storage: readdirSync(real).map((name) => [name, readFileSync(join(real, name), 'utf8')]) })
      .toEqual({ user: 'sentinel-user-bytes\n', storage: label === 'foreign .gitignore' ? [['.gitignore', 'node_modules/\n']] : [] });
    return;
  }
  expect(write()).toEqual([user]);
  expect((label === 'git-managed HOME' ? git('init', '-q') : Bun.spawnSync(['git', 'init', '-q', '--bare', bare], { env })).exitCode).toBe(0);
  // A transaction preimage of a path that rh owns: its copy goes into the guarded `host-config-paths/`.
  const transaction = join(f.home, '.repo-harness', 'transactions', 'install-x');
  mkdirSync(transaction, { recursive: true });
  f.gate().writePaths([{ path: own, owner: 'core', entry: { type: 'file', bytes: Buffer.from('sentinel-rh-first\n') } }]);
  f.gate().writePaths([{ path: own, owner: 'core', entry: { type: 'file', bytes: Buffer.from('rh second\n') } }], { transaction });
  expect(readdirSync(join(transaction, 'host-config-paths')).length).toBe(2);
  expect(git('add', '-A').exitCode).toBe(0);
  const staged = new TextDecoder().decode(git('ls-files', '--cached').stdout).split('\n').filter(Boolean);
  expect(staged.filter((path) => path.startsWith('.repo-harness/config/vault/') || path.startsWith('.repo-harness/transactions/'))).toEqual([]);
  expect(staged).toContain('.claude/agents/rh.md');
});

test.each(['.gemini', 'config', 'mcp_config.json'] as const)('Antigravity MCP refuses a symlink at %s', (linked) => {
  if (process.platform === 'win32') return;
  const f = fixture();
  const env = { HOME: f.home };
  const path = antigravityMcpConfigPath(env);
  const change: HostConfigFileChange = { path, fragments: [{
    owner: 'architecture', selector: 'mcpServers.codegraph', kind: 'add', strategy: jsonFragment,
    value: { command: 'codegraph', args: ['serve', '--mcp', '--path', '.'] },
  }] };
  const gate = f.gate();
  gate.apply([change]);
  const before = readFileSync(path);
  const gemini = join(f.home, '.gemini');
  const entries = { '.gemini': gemini, config: join(gemini, 'config'), 'mcp_config.json': path };
  const entry = entries[linked];
  const parked = join(f.home, 'parked');
  renameSync(entry, parked);
  symlinkSync(parked, entry, entry === path ? 'file' : 'dir');

  expect(() => resolveUserConfigFile(env, path)).toThrow(AntigravityHooksPathError);
  expect(() => gate.apply([change])).toThrow(AntigravityHooksPathError);
  expect(() => gate.revert([path])).toThrow(AntigravityHooksPathError);
  expect(() => gate.revert()).toThrow(AntigravityHooksPathError);
  expect(readFileSync(path)).toEqual(before);
  expect(f.ledger().fragments).toContainEqual(expect.objectContaining({ file: path, selector: 'mcpServers.codegraph' }));
});

test.skipIf(process.platform === 'win32')('Antigravity AGENTS.md and narrow skills root enforce no-symlink guards and preserve ~/.gemini/config', () => {
  const f = fixture();
  const env = { HOME: f.home };
  const rulesPath = antigravityGlobalRulesPath(env);
  const skillsDir = antigravitySkillsDirPath(env);
  const configDir = join(f.home, '.gemini', 'config');
  const skillDest = join(skillsDir, 'repo-harness');
  const sourceDir = join(f.home, 'skill-src');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'SKILL.md'), '# test\n');

  // Narrow root: only ~/.gemini/config/skills/* maps to host 'antigravity', never all of ~/.gemini.
  expect(pathRecordHost(env, skillDest)).toBe('antigravity');
  expect(pathRecordHost(env, join(f.home, '.gemini', 'other'))).toBeNull();
  expect(pathRecordHost(env, join(configDir, 'other'))).toBeNull();
  expect(() => f.gate().writePaths([{ path: join(f.home, '.gemini', 'other'), owner: 'core', entry: { type: 'symlink', target: sourceDir } }]))
    .toThrow('not inside an install root');

  // Write AGENTS.md block and skill symlink through the gate.
  const block = '<!-- BEGIN: repo-harness global-working-rules -->\n# Global Working Rules\n<!-- END: repo-harness global-working-rules -->';
  f.gate().apply([{ path: rulesPath, backup: 'overrides-only', fragments: [{ owner: 'core', selector: 'global-working-rules', kind: 'add', strategy: markedBlock, value: block }] }]);
  expect(f.gate().writePaths([{ path: skillDest, owner: 'core', entry: { type: 'symlink', target: sourceDir } }])).toEqual([skillDest]);
  expect(f.ledger().paths[skillDest]?.host).toBe('antigravity');
  expect(f.ledger().directories).not.toContain(configDir);
  expect(f.ledger().directories).not.toContain(join(f.home, '.gemini'));

  // Pre-existing unowned user skill directory is refused without overwriting.
  const userSkill = join(skillsDir, 'repo-harness-check');
  mkdirSync(userSkill, { recursive: true });
  writeFileSync(join(userSkill, 'SKILL.md'), '# user skill\n');
  expect(() => f.gate().writePaths([{ path: userSkill, owner: 'core', entry: { type: 'symlink', target: sourceDir } }]))
    .toThrow('rh has no record of it');
  expect(readFileSync(join(userSkill, 'SKILL.md'), 'utf8')).toBe('# user skill\n');

  // Symlinked AGENTS.md or skills directory fails closed across gate and inspect operations.
  const parkedRules = join(f.home, 'parked-agents.md');
  renameSync(rulesPath, parkedRules);
  symlinkSync(parkedRules, rulesPath);
  expect(() => f.gate().apply([{ path: rulesPath, backup: 'overrides-only', fragments: [{ owner: 'core', selector: 'global-working-rules', kind: 'refresh', strategy: markedBlock, value: block }] }])).toThrow(AntigravityHooksPathError);
  expect(() => f.gate().revert([rulesPath])).toThrow(AntigravityHooksPathError);
  expect(() => configStatus(env)).toThrow(AntigravityHooksPathError);
  expect(() => configDiff(env, rulesPath)).toThrow(AntigravityHooksPathError);
  rmSync(rulesPath);
  renameSync(parkedRules, rulesPath);

  const parkedSkills = join(f.home, 'parked-skills');
  renameSync(skillsDir, parkedSkills);
  symlinkSync(parkedSkills, skillsDir, 'dir');
  expect(() => f.gate().writePaths([{ path: skillDest, owner: 'core', entry: { type: 'symlink', target: sourceDir } }])).toThrow(AntigravityHooksPathError);
  expect(() => f.gate().revertPaths([skillDest])).toThrow(AntigravityHooksPathError);
  expect(() => configStatus(env)).toThrow(AntigravityHooksPathError);
  rmSync(skillsDir);
  renameSync(parkedSkills, skillsDir);

  // Revert removes only rh-owned entries and preserves ~/.gemini/config and user skills.
  expect(f.gate().revertPaths([skillDest]).map((entry) => entry.action)).toEqual(['removed']);
  expect(f.gate().revert([rulesPath]).map((entry) => entry.action)).toEqual(['removed']);
  expect(lstatSync(configDir).isDirectory()).toBe(true);
  expect(readFileSync(join(userSkill, 'SKILL.md'), 'utf8')).toBe('# user skill\n');
});

test.skipIf(process.platform === 'win32')('Antigravity agentsDir enforces root-specific no-symlink guards independently of skillsDir and tracks file + container identities', () => {
  const f = fixture();
  const env = { HOME: f.home };
  const skillsDir = antigravitySkillsDirPath(env);
  const agentsDir = antigravityAgentsDirPath(env);
  const configDir = join(f.home, '.gemini', 'config');
  const agentDir = join(agentsDir, 'rh-advisor-0123456789ab');
  const agentFile = join(agentDir, 'agent.md');
  const agentBytes = Buffer.from('---\nname: rh-advisor-0123456789ab\n---\n', 'utf8');
  mkdirSync(skillsDir, { recursive: true });

  expect(pathRecordHost(env, agentFile)).toBe('antigravity');
  expect(pathRecordHost(env, agentsDir)).toBeNull();
  expect(pathRecordHost(env, join(configDir, 'other', 'x'))).toBeNull();

  // Write agent.md as a file PathRecord: records both agentsDir and agentDir in ledger.directories + directory_identities, never ~/.gemini or ~/.gemini/config.
  expect(f.gate().writePaths([{ path: agentFile, owner: 'core', entry: { type: 'file', bytes: agentBytes, mode: 0o600 } }])).toEqual([agentFile]);
  const createdAgentsIdentity = observeEntryIdentity(agentsDir);
  const createdAgentDirIdentity = observeEntryIdentity(agentDir);
  const createdAgentFileIdentity = observeEntryIdentity(agentFile);
  expect(f.ledger().paths[agentFile]).toMatchObject({ host: 'antigravity', owner: 'core', kind: 'created', committed: { type: 'file' }, identity: createdAgentFileIdentity });
  expect(f.ledger().directories).toContain(agentsDir);
  expect(f.ledger().directories).toContain(agentDir);
  expect(f.ledger().directory_identities?.[agentsDir]).toBe(createdAgentsIdentity);
  expect(f.ledger().directory_identities?.[agentDir]).toBe(createdAgentDirIdentity);
  expect(f.ledger().directories).not.toContain(configDir);
  expect(f.ledger().directories).not.toContain(join(f.home, '.gemini'));

  // Symlinked agentsDir while skillsDir is a clean real directory fails closed across planPaths, writePaths, revertPaths, and configStatus.
  const parkedAgents = join(f.home, 'parked-agents');
  renameSync(agentsDir, parkedAgents);
  symlinkSync(parkedAgents, agentsDir, 'dir');
  expect(f.gate().planPaths([{ path: agentFile, owner: 'core', entry: { type: 'file', bytes: agentBytes, mode: 0o600 } }]).refusals[0]).toBeInstanceOf(AntigravityHooksPathError);
  expect(() => f.gate().writePaths([{ path: agentFile, owner: 'core', entry: { type: 'file', bytes: agentBytes, mode: 0o600 } }])).toThrow(AntigravityHooksPathError);
  expect(() => f.gate().revertPaths([agentFile])).toThrow(AntigravityHooksPathError);
  expect(() => configStatus(env)).toThrow(AntigravityHooksPathError);
  rmSync(agentsDir);
  renameSync(parkedAgents, agentsDir);

  // Same-bytes inode replacement of agent.md is rejected by revert (kept_edited, host_config_entry_replaced) and keeps agent.md and both directories.
  const copyFile = join(f.home, 'agent-copy.md');
  writeFileSync(copyFile, agentBytes);
  renameSync(copyFile, agentFile);
  const replacedFileId = observeEntryIdentity(agentFile);
  expect(replacedFileId).not.toBe(createdAgentFileIdentity);
  expect(f.gate().revertPaths([agentFile])).toEqual([{ path: agentFile, action: 'kept_edited', code: 'host_config_entry_replaced' }]);
  expect(observeEntryIdentity(agentFile)).toBe(replacedFileId);
  expect(lstatSync(agentDir).isDirectory()).toBe(true);
  expect(lstatSync(agentsDir).isDirectory()).toBe(true);

  // Clean revert of an untouched file removes agent.md, agentDir, and rh-created empty agentsDir when identities match, preserving ~/.gemini/config.
  rmSync(agentsDir, { recursive: true, force: true });
  writeFileSync(join(f.root, 'ledger.json'), JSON.stringify({ ...f.ledger(), paths: {}, directories: [], directory_identities: undefined }));
  expect(f.gate().writePaths([{ path: agentFile, owner: 'core', entry: { type: 'file', bytes: agentBytes, mode: 0o600 } }])).toEqual([agentFile]);
  expect(f.gate().revertPaths([agentFile]).map((entry) => entry.action)).toEqual(['removed']);
  expect(existsSync(agentFile)).toBe(false);
  expect(existsSync(agentDir)).toBe(false);
  expect(existsSync(agentsDir)).toBe(false);
  expect(f.ledger().directory_identities).toBeUndefined();
  expect(lstatSync(configDir).isDirectory()).toBe(true);

  // Replacing an rh-created agentsDir with a new empty directory (different identity) keeps the replacement on revert.
  expect(f.gate().writePaths([{ path: agentFile, owner: 'core', entry: { type: 'file', bytes: agentBytes, mode: 0o600 } }])).toEqual([agentFile]);
  const origAgentsId = observeEntryIdentity(agentsDir);
  expect(f.ledger().directory_identities?.[agentsDir]).toBe(origAgentsId);
  const movedAgents = join(f.home, 'moved-agents');
  renameSync(agentsDir, movedAgents);
  mkdirSync(agentsDir);
  const replacementAgentsId = observeEntryIdentity(agentsDir);
  expect(replacementAgentsId).not.toBe(origAgentsId);
  expect(f.gate().revertPaths([agentFile]).map((entry) => entry.action)).toEqual(['released']);
  expect(lstatSync(agentsDir).isDirectory()).toBe(true);
  expect(observeEntryIdentity(agentsDir)).toBe(replacementAgentsId);
  expect(f.ledger().directories).not.toContain(agentsDir);
  expect(f.ledger().directory_identities).toBeUndefined();
  rmSync(movedAgents, { recursive: true, force: true });

  // An unproved agentDir/agentsDir entry in ledger.directories without directory_identities fails safe and is not removed.
  rmSync(agentsDir, { recursive: true, force: true });
  expect(f.gate().writePaths([{ path: agentFile, owner: 'core', entry: { type: 'file', bytes: agentBytes, mode: 0o600 } }])).toEqual([agentFile]);
  const unprovedLedger = f.ledger();
  delete unprovedLedger.directory_identities;
  writeFileSync(join(f.root, 'ledger.json'), JSON.stringify(unprovedLedger, null, 2));
  expect(f.gate().revertPaths([agentFile]).map((entry) => entry.action)).toEqual(['removed']);
  expect(existsSync(agentFile)).toBe(false);
  expect(lstatSync(agentDir).isDirectory()).toBe(true);
  expect(lstatSync(agentsDir).isDirectory()).toBe(true);
  expect(f.ledger().directories).not.toContain(agentDir);
  expect(f.ledger().directories).not.toContain(agentsDir);

  // Pre-existing user agentsDir is not recorded in ledger.directories and stays even when empty after revert.
  rmSync(agentDir, { recursive: true, force: true });
  expect(f.gate().writePaths([{ path: agentFile, owner: 'core', entry: { type: 'file', bytes: agentBytes, mode: 0o600 } }])).toEqual([agentFile]);
  expect(f.ledger().directories).not.toContain(agentsDir);
  expect(f.ledger().directories).toContain(agentDir);
  expect(f.gate().revertPaths([agentFile]).map((entry) => entry.action)).toEqual(['removed']);
  expect(existsSync(agentFile)).toBe(false);
  expect(existsSync(agentDir)).toBe(false);
  expect(lstatSync(agentsDir).isDirectory()).toBe(true);
});
