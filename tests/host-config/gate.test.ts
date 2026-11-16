import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { classifyFile, recoveryAction } from '../../src/core/host-config/recovery';
import { HostConfigError, type FragmentEdit, type HostConfigStrategy } from '../../src/core/host-config/types';
import { openHostConfigGate, type HostConfigFileChange, type HostConfigGateOptions } from '../../src/effects/host-config/gate';

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
  const gate = (options: Omit<HostConfigGateOptions, 'env'> = {}) => openHostConfigGate({ env: { HOME: home }, ...options });
  const change = (path: string, value: string, extra: Partial<HostConfigFileChange['fragments'][number]> = {}): HostConfigFileChange =>
    ({ path, fragments: [{ owner: 'o1', selector: 'rh', kind: 'add', strategy: keyLine, value, ...extra }] });
  const journal = () => readdirSync(join(root, 'journal'));
  const ledger = () => JSON.parse(readFileSync(join(root, 'ledger.json'), 'utf8'));
  return { home, a, b, root, gate, change, journal, ledger };
}

const gatePath = resolve(import.meta.dir, '../../src/effects/host-config/gate.ts');

/** Run one gate call in a child process that SIGKILLs itself at the fault point. */
function killAt(home: string, body: string, point: string, path = ''): void {
  const script = `
    import { openHostConfigGate } from ${JSON.stringify(gatePath)};
    ${keyLineEdit.toString()}
    const keyLine = { locate: () => null, apply: keyLineEdit };
    const faults = { at(point, path) { if (point === ${JSON.stringify(point)} && (${JSON.stringify(path)} === '' || path === ${JSON.stringify(path)})) process.kill(process.pid, 'SIGKILL'); } };
    const gate = openHostConfigGate({ env: { HOME: ${JSON.stringify(home)} }, faults });
    ${body}
    process.exit(3);
  `;
  const child = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  expect({ signal: child.signal, stderr: child.stderr }).toEqual({ signal: 'SIGKILL', stderr: '' });
}

test('A5: a kill at each fault point recovers by the table', () => {
  const applyBoth = (f: ReturnType<typeof fixture>) => `gate.apply([
    { path: ${JSON.stringify(f.a)}, fragments: [{ owner: 'o1', selector: 'rh', kind: 'add', strategy: keyLine, value: 'on' }] },
    { path: ${JSON.stringify(f.b)}, fragments: [{ owner: 'o1', selector: 'rh', kind: 'add', strategy: keyLine, value: 'on' }] },
  ]);`;
  const cases = [
    { point: 'after-record', path: '', committed: false },
    { point: 'after-rename', path: 'a', committed: false },
    { point: 'after-rename', path: 'b', committed: false },
    { point: 'after-ledger', path: '', committed: true },
    { point: 'after-cleanup', path: '', committed: true },
  ];
  for (const { point, path, committed } of cases) {
    const f = fixture();
    killAt(f.home, applyBoth(f), point, path === '' ? '' : f[path as 'a' | 'b']);
    expect(f.gate().recover()).toEqual({ unresolved: [] });
    expect(f.journal()).toEqual([]);
    const label = `${point} ${path}`;
    if (committed) {
      expect({ label, a: readFileSync(f.a, 'utf8'), b: readFileSync(f.b, 'utf8') }).toEqual({ label, a: 'keep=1\nrh=on\n', b: 'rh=on\n' });
      expect(f.ledger().committed_transactions).toHaveLength(1);
    } else {
      expect({ label, a: readFileSync(f.a, 'utf8'), mode: statSync(f.a).mode & 0o777, tool: existsSync(join(f.home, '.tool')) })
        .toEqual({ label, a: 'keep=1\n', mode: 0o640, tool: false });
      expect(existsSync(join(f.root, 'ledger.json'))).toBe(false);
    }
  }

  // Delegated record, killed after the record: the path is still the preimage, so the record goes.
  const d = fixture();
  killAt(d.home, `gate.delegate([${JSON.stringify(d.a)}], () => {});`, 'after-record');
  expect(d.gate().recover()).toEqual({ unresolved: [] });
  expect(d.journal()).toEqual([]);

  // Delegated record, killed during run: changed content is never guessed to be the writer's.
  killAt(d.home, `import { writeFileSync } from 'node:fs';
    gate.delegate([${JSON.stringify(d.a)}], () => { writeFileSync(${JSON.stringify(d.a)}, 'external\\n'); process.kill(process.pid, 'SIGKILL'); });`, 'none');
  const report = d.gate().recover();
  expect(report.unresolved.map((entry) => [entry.code, entry.path])).toEqual([['host_config_unresolved_external_change', d.a]]);
  expect(readFileSync(d.a, 'utf8')).toBe('external\n');
  const [txn] = d.journal();
  expect(readFileSync(join(d.root, 'journal', txn!, 'preimage-0'), 'utf8')).toBe('keep=1\n');
});

test('recovery decision is one pure table', () => {
  const pre = { existed: true as const, mode: 0o600, sha256: `sha256:${'a'.repeat(64)}` };
  const intended = { ...pre, sha256: `sha256:${'b'.repeat(64)}` };
  const observe = (sha256: string) => ({ existed: true as const, type: 'file' as const, mode: 0o600, sha256 });
  const rows = [
    [classifyFile(observe(pre.sha256), pre, intended), false, 'resolved'],
    [classifyFile(observe(intended.sha256), pre, intended), false, 'restore_preimage'],
    [classifyFile(observe(intended.sha256), pre, intended), true, 'resolved'],
    [classifyFile(observe(pre.sha256), pre, intended), true, 'mark_external_change'],
    [classifyFile(observe(`sha256:${'c'.repeat(64)}`), pre, intended), false, 'unresolved'],
    [classifyFile({ existed: false }, pre, null), true, 'unresolved'],
  ] as const;
  for (const [state, committed, action] of rows) expect(recoveryAction(state, committed)).toBe(action);
});

test('A3: a failure after the write restores the state before this transaction, not the baseline', () => {
  const f = fixture();
  f.gate().apply([f.change(f.a, '1')]);
  const failing = f.gate({ faults: { at: (point) => { if (point === 'after-rename') throw new Error('disk full'); } } });
  expect(() => failing.apply([f.change(f.a, '2')])).toThrow('disk full');
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\nrh=1\n');
  expect(f.journal()).toEqual([]);
  expect(f.ledger().committed_transactions).toHaveLength(1);
});

test('A4/A6: a change by another process after the write blocks the rollback and keeps the preimage', () => {
  const f = fixture();
  const racing = f.gate({ faults: { at: (point) => {
    if (point !== 'after-rename') return;
    writeFileSync(f.a, 'other writer\n');
    throw new Error('late failure');
  } } });
  const error = (() => { try { racing.apply([f.change(f.a, 'on')]); } catch (caught) { return caught; } })();
  expect(error).toBeInstanceOf(HostConfigError);
  expect((error as HostConfigError).code).toBe('host_config_unresolved_external_change');
  expect(readFileSync(f.a, 'utf8')).toBe('other writer\n');
  const [txn] = f.journal();
  expect(readFileSync(join(f.root, 'journal', txn!, 'preimage-0'), 'utf8')).toBe('keep=1\n');
  // A later transaction on the held path fails closed; recovery keeps the preimage.
  expect(() => f.gate().apply([f.change(f.a, 'again')])).toThrow(/preimage stays/);
  expect(f.gate().recover().unresolved).toHaveLength(1);
});

test('a target changed before its rename aborts with nothing written for that file', () => {
  const f = fixture();
  const racing = f.gate({ faults: { at: (point) => { if (point === 'after-record') writeFileSync(f.a, 'user edit\n'); } } });
  expect(() => racing.apply([f.change(f.a, 'on')])).toThrow(expect.objectContaining({ code: 'host_config_target_changed' }));
  expect(readFileSync(f.a, 'utf8')).toBe('user edit\n');
  expect(f.journal()).toEqual([]);
});

test('A8: two owners on one selector, or a parent and a child selector, write nothing', () => {
  const f = fixture();
  const owners = { path: f.a, fragments: [
    { owner: 'o1', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '1' },
    { owner: 'o2', selector: 'rh', kind: 'add' as const, strategy: keyLine, value: '2' },
  ] };
  const nested = { path: f.b, fragments: [
    { owner: 'o1', selector: 'mcp', kind: 'add' as const, strategy: keyLine, value: '1' },
    { owner: 'o1', selector: 'mcp.codegraph', kind: 'add' as const, strategy: keyLine, value: '2' },
  ] };
  for (const change of [owners, nested]) {
    expect(() => f.gate().apply([change])).toThrow(expect.objectContaining({ code: 'host_config_fragment_overlap' }));
  }
  expect(readFileSync(f.a, 'utf8')).toBe('keep=1\n');
  expect(existsSync(f.b)).toBe(false);
  expect(f.journal()).toEqual([]);
  // A recorded fragment counts: another owner cannot take its selector later.
  f.gate().apply([f.change(f.a, '1')]);
  expect(() => f.gate().apply([f.change(f.a, '2', { owner: 'o2' })])).toThrow(expect.objectContaining({ code: 'host_config_fragment_overlap' }));
});

test('a commit records baseline, fragments and the override backup, and leaves no preimage in the journal', () => {
  const f = fixture();
  const skipped = f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'override' })]);
  expect(skipped).toEqual({ txn: null, written: [], skipped: [{ code: 'host_config_override_skipped', file: f.a, owner: 'o1', selector: 'keep' }] });

  mkdirSync(join(f.home, '.tool'));
  const result = f.gate().apply([f.change(f.a, 'x', { selector: 'keep', kind: 'override', selected: true }), f.change(f.b, 'on')]);
  expect(result.written).toEqual([f.a, f.b]);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=x\n');
  expect(statSync(f.a).mode & 0o777).toBe(0o640);
  expect(f.journal()).toEqual([]);
  const ledger = f.ledger();
  expect(ledger.committed_transactions).toEqual([result.txn]);
  expect(ledger.files[f.a].baseline).toEqual({ state: 'known', existed: true, type: 'file', mode: 0o640, sha256: expect.stringMatching(/^sha256:/) });
  expect(ledger.files[f.b]).toMatchObject({ baseline: { state: 'known', existed: false }, created_dirs: [join(f.home, '.tool', 'sub')], external_change: false });
  const override = ledger.fragments.find((record: { file: string }) => record.file === f.a);
  expect(override.edit).toEqual({ at: 0, removed_vault: expect.stringMatching(/^sha256:/), inserted: 'keep=x\n' });
  expect(readFileSync(join(f.root, 'vault', override.edit.removed_vault.slice(7)), 'utf8')).toBe('keep=1\n');
  for (const entry of [f.root, join(f.root, 'vault'), join(f.root, 'journal')]) expect(statSync(entry).mode & 0o777).toBe(0o700);
  expect(statSync(join(f.root, 'ledger.json')).mode & 0o777).toBe(0o600);

  // A refresh keeps the first removed text; an outside edit becomes a sticky external change.
  writeFileSync(f.a, 'keep=x\nuser=1\n');
  f.gate().apply([f.change(f.a, 'y', { selector: 'keep', kind: 'refresh', selected: true })]);
  const next = f.ledger();
  expect(next.files[f.a].external_change).toBe(true);
  expect(next.fragments.find((record: { file: string }) => record.file === f.a).edit.removed_vault).toBe(override.edit.removed_vault);
  expect(readFileSync(f.a, 'utf8')).toBe('keep=y\nuser=1\n');
});
