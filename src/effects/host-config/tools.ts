import { rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { HostConfigError, type HostPath, type ToolId, type ToolRecord } from '../../core/host-config/types';
import type { UserPathPort, UserPathValue } from '../../core/host-config/path-entry';
import { runProcess } from '../process-runner';
import { hostConfigPaths, hostPathKey, observeFile, pathRecordOf, readLedger, validToolRecord, writeLedger } from './store';
import { observePathEntry, sameCommitted } from './whole-path';

/**
 * The shared tools of the host-config ledger (#2853): the Windows user `Path`
 * value behind `gate.addUserPathEntry` and `gate.revertTools`, and the check
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
 * characters.
 */
function writeScript(expected: UserPathValue, next: UserPathValue): string {
  const payload = Buffer.from(JSON.stringify({ expected, next }), 'utf8').toString('base64');
  return [
    `# rh-user-path write ${payload}`,
    "$ErrorActionPreference = 'Stop'",
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
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
}

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

/** The user `Path` value through Windows PowerShell. No output names the value: it can hold user paths. */
export function windowsUserPathPort(powershell: string, cwd: string, env: NodeJS.ProcessEnv): UserPathPort {
  const run = (script: string): string => {
    // UTF-16LE base64: Windows PowerShell 5.1 splits the quotes of a -Command argument.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = runProcess(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd, env, timeoutMs: 30_000 });
    if (!result.ok) throw new HostConfigError('host_config_invalid_state', `the user Path step failed: ${(result.stderr || result.error || '').trim() || `exit ${result.status}`}`);
    return result.stdout;
  };
  return {
    read: () => decodeValue(run(READ_SCRIPT)),
    write: (expected, next) => {
      const outcome = run(writeScript(expected, next)).trim();
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
 * no record. A malformed file, or a ledger record of another Bun, stops with
 * a named error, and the file stays.
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
  const existing = ledger.tools.bun;
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
