import { lstatSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { HostConfigError, type HostConfigLedger, type HostPath, type ToolId, type ToolRecord } from '../../core/host-config/types';
import { listsUserPathEntry, removeUserPathEntry, type UserPathPort, type UserPathValue } from '../../core/host-config/path-entry';
import { spawnSync } from 'node:child_process';
import { hostConfigPaths, hostPathKey, observeFile, pathRecordOf, readLedger, removeCreatedDirectories, validToolRecord, writeLedger } from './store';
import { observePathEntry, removePathEntry, sameCommitted } from './whole-path';
import { observeEntryIdentity, retireThenDestroy, userPathLabel, type RevertStep } from './gate';

/**
 * The shared tools of the host-config ledger (#2853): the Windows user `Path`
 * value behind `gate.addUserPathEntry` and `gate.releaseAbsentTools`, and the check
 * that an hc on PATH is the one that rh recorded.
 */

/** True when the tool record holds `path` and every recorded entry still holds its recorded bytes. */
export function recordedToolIsCurrent(env: NodeJS.ProcessEnv, tool: ToolId, path: string): boolean {
  const paths = hostConfigPaths(env);
  const record = readLedger(paths).tools[tool];
  if (!record || !(hostPathKey(paths, path) in record.paths)) return false;
  return Object.entries(record.paths).every(([key, { committed }]) => sameCommitted(observePathEntry(key), committed));
}

/** The Windows PowerShell that reads and writes the user `Path` value; null without `SystemRoot`. */
export function windowsPowershellPath(env: NodeJS.ProcessEnv): string | null {
  return env.SystemRoot ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
}

/** The first line names the operation, so a test double can read the command that it gets. */
const READ_SCRIPT = [
  '# rh-user-path read',
  "$ErrorActionPreference = 'Stop'",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
  'try {',
  "  $existed = $key.GetValueNames() -contains 'Path'",
  "  $kind = if ($existed) { $key.GetValueKind('Path').ToString() } else { 'ExpandString' }",
  "  $raw = if ($existed) { [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { '' }",
  '  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((@{ existed = $existed; kind = $kind; raw = $raw } | ConvertTo-Json -Compress)))',
  '} finally { $key.Close() }',
].join('\n');

/**
 * Compare and set: the value changes only while it is still the one read, in
 * the kind of `next`. Then a user variable is set and cleared, so running
 * programs reread the environment. Not `setx`: it cuts the value at 1024
 * characters. The two values come on stdin, never in the command line, which
 * a timeout report can show.
 */
const WRITE_SCRIPT = [
    '# rh-user-path write',
    "$ErrorActionPreference = 'Stop'",
    '$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json',
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    'try {',
    "  $existed = $key.GetValueNames() -contains 'Path'",
    "  $raw = if ($existed) { [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { '' }",
    "  $kind = if ($existed) { $key.GetValueKind('Path').ToString() } else { 'ExpandString' }",
    "  if ($existed -ne $p.expected.existed -or -not ([string]$raw -ceq [string]$p.expected.raw) -or ($existed -and $kind -ne $p.expected.kind)) { 'changed' } else {",
    "    if ($p.next.existed) { $key.SetValue('Path', [string]$p.next.raw, [Microsoft.Win32.RegistryValueKind]$p.next.kind) } else { $key.DeleteValue('Path') }",
    "    [Environment]::SetEnvironmentVariable('HC_INSTALLING', '1', 'User')",
    "    [Environment]::SetEnvironmentVariable('HC_INSTALLING', $null, 'User')",
    "    'written'",
    '  }',
    '} finally { $key.Close() }',
  ].join('\n');

function decodeValue(stdout: string): UserPathValue {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf8')); } catch { value = null; }
  const record = value as Record<string, unknown> | null;
  if (record === null || typeof record !== 'object' || typeof record.existed !== 'boolean' || typeof record.raw !== 'string'
    || (record.kind !== 'String' && record.kind !== 'ExpandString')) {
    throw new HostConfigError('host_config_invalid_state', 'the user Path value is not a REG_SZ or REG_EXPAND_SZ string, so rh does not change it');
  }
  return { existed: record.existed, kind: record.kind, raw: record.raw };
}

/**
 * The user `Path` value through Windows PowerShell. No output carries the
 * value: a failure names the operation and its exit status only, and the
 * child's diagnostics, which can echo its input, are dropped.
 */
export function windowsUserPathPort(powershell: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): UserPathPort {
  const run = (operation: 'read' | 'write', script: string, input: string): string => {
    // UTF-16LE base64: Windows PowerShell 5.1 splits the quotes of a -Command argument.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { cwd, env, input, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
      const how = code === 'ETIMEDOUT' ? `timed out after ${timeoutMs} ms` : result.error ? 'could not run' : `exited with status ${result.status ?? result.signal}`;
      throw new HostConfigError('host_config_invalid_state', `the user Path ${operation} ${how}`);
    }
    return result.stdout;
  };
  return {
    read: () => decodeValue(run('read', READ_SCRIPT, '')),
    write: (expected, next) => {
      const outcome = run('write', WRITE_SCRIPT, Buffer.from(JSON.stringify({ expected, next }), 'utf8').toString('base64')).trim();
      if (outcome === 'changed') throw new HostConfigError('host_config_target_changed', 'the user Path value changed before the write; nothing written');
      if (outcome !== 'written') throw new HostConfigError('host_config_invalid_state', 'the user Path write gave no result');
    },
  };
}

/** Written by install.sh and install.ps1 when they installed Bun (JD 6913505420 on #2853); 0600. */
export function bunBootstrapRecordPath(env: NodeJS.ProcessEnv): string {
  return join(hostConfigPaths(env).harness, 'bootstrap', 'bun.json');
}

const BOOTSTRAP_KEYS = new Set(['installed_by', 'version', 'path', 'sha256', 'directories', 'profile', 'path_entry', 'registry_keys']);

function bootstrapRecord(bytes: Buffer, file: string): { readonly path: string; readonly record: ToolRecord } {
  const malformed = () => new HostConfigError('host_config_invalid_state', `the Bun bootstrap record is malformed, so rh does not import it; it stays: ${file}`);
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw malformed(); }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !BOOTSTRAP_KEYS.has(key))
    || value.installed_by !== 'rh-bootstrap' || typeof value.path !== 'string' || !isAbsolute(value.path)) throw malformed();
  const { path, sha256, ...rest } = value;
  const record = { ...rest, paths: { [path]: { committed: { type: 'file', sha256 } } }, removable: false };
  if (!validToolRecord(record)) throw malformed();
  return { path, record: record as unknown as ToolRecord };
}

/**
 * The first `rh install` moves the bootstrap's Bun record into the ledger,
 * once: a ledger record of the same path and hash is not added again, and the
 * file goes only after the ledger holds the record, so a stop between the two
 * imports nothing new. A binary that no longer holds the measured bytes gets
 * no record. A recorded Bun whose binary is gone is replaced. A malformed
 * file, or a ledger record of another Bun that is still there, stops with a
 * named error, and the file stays.
 */
export function importBunBootstrapRecord(env: NodeJS.ProcessEnv): 'imported' | 'already_recorded' | 'changed' | 'none' {
  const file = bunBootstrapRecordPath(env);
  const { bytes } = observeFile(file);
  if (bytes === null) return 'none';
  const parsed = bootstrapRecord(bytes, file);
  const paths = hostConfigPaths(env);
  const key = hostPathKey(paths, parsed.path);
  const record: ToolRecord = { ...parsed.record, paths: { [key]: parsed.record.paths[parsed.path]! } };
  // The claim holds only for the bytes that the bootstrap measured: a Bun that changed since then gets no record, and the claim goes.
  if (!sameCommitted(observePathEntry(key), record.paths[key]!.committed)) { rmSync(file); return 'changed'; }
  const ledger = readLedger(paths);
  let existing = ledger.tools.bun;
  // A recorded Bun binary that is gone loses its claim before the conflict test, so a bootstrap into another
  // BUN_INSTALL imports. The old record's PATH entry, profile text and registry key never granted an action: they
  // stay on disk, unclaimed, and do not keep the old binary claim alive.
  if (existing && Object.keys(existing.paths).every((path) => observePathEntry(path) === null)) existing = undefined;
  if (existing && JSON.stringify(existing.paths) !== JSON.stringify(record.paths)) {
    throw new HostConfigError('host_config_invalid_state', `the ledger records another Bun binary than the bootstrap record; the file stays: ${file}`);
  }
  if (!existing) {
    if (pathRecordOf(ledger, key as HostPath) !== null || ledger.files[key]) throw new HostConfigError('host_config_invalid_state', `another ledger record owns the Bun binary; the file stays: ${file}`);
    writeLedger(paths, { ...ledger, tools: { ...ledger.tools, bun: record } });
  }
  rmSync(file);
  return existing ? 'already_recorded' : 'imported';
}

/**
 * One entry of `rh uninstall --with-tools`. `removed`: it still holds what rh
 * wrote, so it goes. `already_absent`: it is gone, so its record goes.
 * `kept_edited`: it changed since rh wrote it, so it and its record stay.
 */
export interface ToolRemovalEntry {
  readonly tool: ToolId;
  /** The entry key, or `userPathLabel(entry)` for the user PATH entry. */
  readonly path: string;
  readonly kind: 'entry' | 'directory' | 'user_path';
  readonly action: 'removed' | 'already_absent' | 'kept_edited';
}

/** A removal whose claim went but whose write did not land: the entry stays, unclaimed. */
export interface ToolRemovalFailure {
  readonly tool: ToolId;
  readonly path: string;
  readonly reason: string;
}

interface PlannedRemoval {
  readonly entries: ToolRemovalEntry[];
  readonly steps: RevertStep[];
  readonly failures: ToolRemovalFailure[];
}

/** The ledger with one tool record changed; a record with no path and no PATH entry left goes, as in `releaseAbsentTools`. */
function withTool(ledger: HostConfigLedger, tool: ToolId, change: (record: ToolRecord) => ToolRecord): HostConfigLedger {
  const current = ledger.tools[tool];
  if (!current) return ledger;
  const { [tool]: _old, ...tools } = ledger.tools;
  const record = change(current);
  return { ...ledger, tools: Object.keys(record.paths).length || record.path_entry ? { ...tools, [tool]: record } : tools };
}

/** The entry is still the object that rh wrote (identity) and holds the bytes that rh wrote (content). */
function isRecordedEntry(key: string, entry: ToolRecord['paths'][string]): boolean {
  return entry.identity !== undefined && sameCommitted(observePathEntry(key), entry.committed) && observeEntryIdentity(key) === entry.identity;
}

/**
 * The plan of every tool record. A removable tool loses each entry that holds
 * what rh wrote; a tool that is not removable (Bun) loses nothing. Each record
 * releases the entries that are gone, as `releaseAbsentTools` does. The user
 * PATH value is read once; each entry removal writes from the value that the
 * one before it left, so the compare and set of each write holds.
 */
function planRemoval(ledger: HostConfigLedger, port: () => UserPathPort): PlannedRemoval {
  const planned: PlannedRemoval = { entries: [], steps: [], failures: [] };
  /** The directories whose claims go in the first ledger write: the absent ones, and those of a removable tool, which go after the entries when empty. */
  const directories: { readonly tool: ToolId; readonly directory: string; readonly present: boolean }[] = [];
  let user: { readonly port: UserPathPort; value: UserPathValue } | null = null;
  for (const [tool, record] of Object.entries(ledger.tools) as [ToolId, ToolRecord][]) {
    for (const [key, entry] of Object.entries(record.paths)) {
      const action = observePathEntry(key) === null ? 'already_absent' : isRecordedEntry(key, entry) ? 'removed' : 'kept_edited';
      if (!record.removable && action !== 'already_absent') continue;
      planned.entries.push({ tool, path: key, kind: 'entry', action });
      if (action === 'kept_edited') continue;
      const commit = (state: HostConfigLedger) => withTool(state, tool, (current) => {
        const { [key]: _gone, ...paths } = current.paths;
        return { ...current, paths };
      });
      if (action === 'already_absent') { planned.steps.push({ kind: 'release', commit }); continue; }
      planned.steps.push({ kind: 'delete', commit, write: () => {
        // The claim is gone already: an entry that changed since the plan, or that cannot go, stays unclaimed.
        if (!isRecordedEntry(key, entry)) {
          planned.failures.push({ tool, path: key, reason: 'changed before the removal; preserved, and rh no longer records it' });
          return;
        }
        try { removePathEntry(key); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? 'error';
          planned.failures.push({ tool, path: key, reason: `could not be removed (${code}): it can be in use; rh no longer records it; stop hc, then remove it by hand` });
        }
      } });
    }
    for (const directory of record.directories) {
      const present = lstatSync(directory, { throwIfNoEntry: false }) !== undefined;
      if (!present) planned.entries.push({ tool, path: directory, kind: 'directory', action: 'already_absent' });
      if (!present || record.removable) directories.push({ tool, directory, present });
    }
    const pathEntry = record.path_entry;
    if (!pathEntry) continue;
    const label = userPathLabel(pathEntry.entry);
    const commit = (state: HostConfigLedger) => withTool(state, tool, ({ path_entry: _gone, ...current }) => current);
    if (user === null) { const opened = port(); user = { port: opened, value: opened.read() }; }
    if (!listsUserPathEntry(user.value.raw, pathEntry.entry)) {
      planned.entries.push({ tool, path: label, kind: 'user_path', action: 'already_absent' });
      planned.steps.push({ kind: 'release', commit });
      continue;
    }
    if (!record.removable) continue;
    const next = removeUserPathEntry(user.value, pathEntry);
    if (next === null) { planned.entries.push({ tool, path: label, kind: 'user_path', action: 'kept_edited' }); continue; }
    const expected = user.value;
    const opened = user.port;
    user.value = next;
    planned.entries.push({ tool, path: label, kind: 'user_path', action: 'removed' });
    planned.steps.push({ kind: 'delete', commit, write: () => {
      try { opened.write(expected, next); }
      catch (error) {
        planned.failures.push({ tool, path: label, reason: `${(error as Error).message}; rh no longer records the entry; remove it by hand` });
      }
    } });
  }
  if (directories.length) {
    const present = directories.filter((entry) => entry.present);
    planned.steps.push({
      kind: present.length ? 'delete' : 'release',
      commit: (state) => directories.reduce((current, { tool, directory }) =>
        withTool(current, tool, (record) => ({ ...record, directories: record.directories.filter((entry) => entry !== directory) })), state),
      // Innermost first, after every entry: only an empty directory goes, and one that holds content stays, unclaimed.
      write: () => {
        for (const { tool, directory } of [...present].sort((left, right) => right.directory.length - left.directory.length)) {
          try { removeCreatedDirectories([directory]); }
          catch (error) {
            planned.failures.push({ tool, path: directory, reason: `the empty directory could not be removed (${(error as NodeJS.ErrnoException).code ?? 'error'}); rh no longer records it` });
          }
        }
      },
    });
  }
  return planned;
}

/** The entries that `removeTools` would take now, with no write. */
export function planToolRemoval(ledger: HostConfigLedger, port: () => UserPathPort): readonly ToolRemovalEntry[] {
  return planRemoval(ledger, port).entries;
}

/**
 * `rh uninstall --with-tools`: the plan must equal `expected`, the dry run of
 * the same run. One ledger write retires every claim of the run, the
 * directory claims and the empty tool records included, before the first
 * unlink, registry write or directory removal (P4, `retireThenDestroy`). It is
 * the only write: a failure or a stop leaves an entry with no claim, never a
 * claim without its entry.
 */
export function removeTools(env: NodeJS.ProcessEnv, port: () => UserPathPort, expected: readonly ToolRemovalEntry[]): readonly ToolRemovalFailure[] {
  const paths = hostConfigPaths(env);
  const ledger = readLedger(paths);
  const planned = planRemoval(ledger, port);
  if (JSON.stringify(planned.entries) !== JSON.stringify(expected)) {
    throw new HostConfigError('host_config_target_changed', 'the shared tools changed after the preview; nothing removed');
  }
  retireThenDestroy(paths, ledger, planned.steps);
  return planned.failures;
}
