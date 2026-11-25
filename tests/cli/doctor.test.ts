import { CLI_PORTS } from '../../src/cli/index';
import { registerArchitecturePlugin } from '../../src/cli/runtime-transaction';
import { ownerForInstallPath, versions } from '../../src/cli/installer/install-profile';
import { installSelectionCommand, type PluginId } from '../../src/core/skill-surface/plugin-manifest';
import { hashManagedTree } from '../../src/effects/managed-tree';
import { DEFAULT_SEATS_CONFIG } from '../../src/core/board/seats-settings';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync, execSync, spawnSync } from 'child_process';
import {
  checkAgyHost,
  checkRetiredPiExtension,
  checkSkillProjection,
  clearRegisteredChecks,
  formatDoctor,
  notifyRelayDoctorCheck,
  registerCheck,
  runDoctor,
  type CheckStatus,
} from '../../src/cli/commands/doctor';
import { compareVersions, readLatestPackageVersion } from '../../src/cli/commands/package-version';
import { writeShellExecutableFixture } from '../helpers/repo-fixture';
import { writeFakeHc } from '../helpers/fake-hc';
import { installStateFixturePath, recordPluginSelection, seedGlobalPackageFixture, seedPathRecords, withTempHome } from '../helpers/install-ownership';
import type { PathCommitted } from '../../src/core/host-config/types';
import { pathRecordHost, pathRecordKey } from '../../src/effects/host-config/path-records';
import { hostConfigPaths } from '../../src/effects/host-config/store';

/** A protocol 5 state and one `created` path record per entry, as an install leaves them. */
function seedRecordedInstall(env: NodeJS.ProcessEnv, plugins: readonly PluginId[], selection: 'all' | readonly PluginId[],
  records: readonly { readonly path: string; readonly owner: string; readonly committed: PathCommitted }[]): void {
  recordPluginSelection(env, plugins, selection === 'all' ? 'all' : [...selection]);
  seedPathRecords(env, Object.fromEntries(records.map(({ path: entry, owner, committed }) => [pathRecordKey(env, entry),
    { owner, host: pathRecordHost(env, entry)!, kind: 'created' as const, baseline: { state: 'unknown' as const }, committed }])));
}
import { expectedSkillProjections, type SkillProjection } from '../../src/cli/installer/skill-projection';
import { buildManagedHooks, MANAGED_TAG } from '../../src/cli/installer/managed-entries';
import { parseSkillSurfaceCatalog } from '../../src/core/skill-surface/catalog';
import { writeNotifyInstallRecord } from '../../src/effects/terminal/herdr-notify-install';
import { HC_MIN_VERSION } from '../../src/core/terminal/herdr-pin';

const DOCTOR_CHECK_TIMEOUT_MS = 15000;
// The default selection on a host without `pi` on PATH.
const FULL_PLUGINS: readonly PluginId[] = ['architecture', 'cross-review', 'mcp', 'operator', 'peer-runtime', 'platform', 'product', 'strategy-memory'];
// No ledger: the doctor judges the install default `all`, so the repair is a bare install.
const DEFAULT_FIX = installSelectionCommand('all');
const DEFAULT_FIX_LINE = /run: rh install(?:;|$)/m;

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeExecutable(temporaryRoot: string, filePath: string, content: string): void {
  writeShellExecutableFixture(temporaryRoot, filePath, content);
}

function withTempRepo(
  opts: { optIn: boolean; scripts?: readonly string[] },
  fn: (repoRoot: string) => void,
): void {
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-harness-doctor-repo-')));
  try {
    execSync('git init', { cwd: repoRoot, stdio: 'ignore' });
    fs.mkdirSync(path.join(repoRoot, '.ai/hooks'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, '.ai/harness'), { recursive: true });
    if (opts.optIn) {
      fs.writeFileSync(path.join(repoRoot, '.ai/harness/workflow-contract.json'), '{}\n');
    }
    for (const script of opts.scripts ?? []) {
      writeExecutable(repoRoot, path.join(repoRoot, '.ai/hooks', script), '#!/bin/bash\nexit 0\n');
    }
    fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

function setupFakeEnvironment(prefix: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'fakebin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  return { root, home, fakeBin };
}

function seedAntigravitySkillInputs(home: string, bin: string): void {
  writeFakeHc(bin);
  for (const skill of ['think', 'hunt', 'check', 'health']) {
    const staged = path.join(home, '.agents', 'skills', skill);
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, 'SKILL.md'), `# ${skill} fixture\n`);
  }
}

test.skipIf(process.platform === 'win32')('doctor measures agy on PATH with a version-only probe', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('rh-agy-version');
  try {
    withEnv({ HOME: home, PATH: fakeBin }, () => {
      expect(checkAgyHost().map(check => [check.id, check.status])).toEqual([['agy-path', 'na'], ['agy-cli-version', 'na']]);
      const executable = path.join(fakeBin, 'agy');
      writeExecutable(root, executable, '#!/bin/sh\n[ "$#:$1" = "1:--version" ] || exit 2\nprintf "1.5.15\\n"\n');
      expect(checkAgyHost()).toMatchObject([
        { id: 'agy-path', status: 'ok', detail: executable },
        { id: 'agy-cli-version', status: 'ok', version: '1.5.15' },
      ]);
      writeExecutable(root, executable, '#!/bin/sh\nprintf "1.4.9\\n"\n');
      expect(checkAgyHost()[1]).toMatchObject({ status: 'ok', version: '1.4.9' });
      writeExecutable(root, executable, '#!/bin/sh\nprintf "unexpected version output\\n"\n');
      expect(checkAgyHost()[1]).toMatchObject({ status: 'warn', detail: 'agy --version did not return a release version.' });
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === 'win32')('doctor measures the installed Antigravity Bash command separately from native activation', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('rh-antigravity-doctor');
  try {
    seedAntigravitySkillInputs(home, fakeBin);
    const bunInstall = path.join(root, 'bun');
    const env = { HOME: home, PATH: fakeBin, BUN_INSTALL: bunInstall, TMPDIR: root };
    seedGlobalPackageFixture(env, { mutable: true });
    const cli = path.join(import.meta.dir, '../../src/cli/index.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', cli, ...args], { cwd: root, env, encoding: 'utf8' });
    const install = run('install', '--target', 'antigravity');
    expect(install.status, install.stderr).toBe(0);
    const doctor = (native: CheckStatus, direct: CheckStatus) => {
      const report = run('doctor', '--json');
      const { checks } = JSON.parse(report.stdout) as ReturnType<typeof runDoctor>;
      expect(checks.find((check) => check.id === 'antigravity-native-activation')).toMatchObject({ status: native, detail: expect.stringContaining('Live-session reload is unverified.') });
      expect(checks.find((check) => check.id === 'antigravity-direct-command')?.status).toBe(direct);
    };
    doctor('ok', 'ok');
    const hooks = path.join(home, '.gemini/config/hooks.json');
    const installed = JSON.parse(fs.readFileSync(hooks, 'utf8'));
    installed['repo-harness'].enabled = false;
    fs.writeFileSync(hooks, JSON.stringify(installed));
    doctor('warn', 'ok');
    installed['repo-harness'].enabled = true;
    const guards = installed['repo-harness'].PreToolUse as { matcher: string }[];
    const editIndex = guards.findIndex(entry => entry.matcher === 'write_file|edit_file');
    expect(editIndex).toBeGreaterThanOrEqual(0);
    const [originalEdit] = guards.splice(editIndex, 1);
    fs.writeFileSync(hooks, JSON.stringify(installed));
    doctor('fail', 'ok');
    guards.splice(editIndex, 0, originalEdit!);
    fs.writeFileSync(hooks, JSON.stringify(installed));
    const bundle = path.join(seedGlobalPackageFixture(env, { mutable: true }), 'dist/hook-entry.js');
    const entry = fs.readFileSync(bundle);
    fs.writeFileSync(bundle, 'console.log(JSON.stringify({ decision: "allow" }));');
    doctor('ok', 'fail');
    // A cwd-only hook that ignores workspacePaths reproduces #3473 and must fail the multi-workspace probe.
    fs.writeFileSync(bundle, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
      "let dir = input.cwd;",
      "while (typeof dir === 'string') {",
      "  if (fs.existsSync(path.join(dir, '.git'))) { console.log(JSON.stringify({ decision: 'deny', reason: 'rh hook: the tool call is refused' })); break; }",
      "  if (path.dirname(dir) === dir) break;",
      "  dir = path.dirname(dir);",
      "}",
    ].join('\n'));
    doctor('ok', 'fail');
    fs.writeFileSync(bundle, entry);
    installed['repo-harness'].enabled = false;
    const ran = path.join(root, 'ran');
    const bashHook = installed['repo-harness'].PreToolUse.find((entry: { matcher: string }) => entry.matcher === 'run_command');
    bashHook.hooks[0].command = `/usr/bin/touch '${ran}'`;
    fs.writeFileSync(hooks, JSON.stringify(installed));
    doctor('warn', 'fail');
    expect(fs.existsSync(ran)).toBe(false);
    fs.writeFileSync(hooks, '{}');
    doctor('na', 'na');
    const linked = path.join(root, 'hooks.json');
    fs.renameSync(hooks, linked);
    fs.symlinkSync(linked, hooks);
    doctor('fail', 'na');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, DOCTOR_CHECK_TIMEOUT_MS);

test.skipIf(process.platform === 'win32')('doctor Antigravity guard probe passes when the hook denies protected-file overwrites under default and /tmp TMPDIR', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('rh-antigravity-probe-overwrite-ok');
  try {
    seedAntigravitySkillInputs(home, fakeBin);
    const bunInstall = path.join(root, 'bun');
    const baseEnv = { HOME: home, PATH: fakeBin, BUN_INSTALL: bunInstall, TMPDIR: root };
    seedGlobalPackageFixture(baseEnv, { mutable: true });
    const cli = path.join(import.meta.dir, '../../src/cli/index.ts');
    const run = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', cli, ...args], { cwd: root, env, encoding: 'utf8' });
    const install = run(baseEnv, 'install', '--target', 'antigravity');
    expect(install.status, install.stderr).toBe(0);

    // Check both isolated TMPDIR and /tmp (Linux CI default where os.tmpdir() and managedWorktreeRoot share /tmp).
    for (const probeEnv of [baseEnv, { ...baseEnv, TMPDIR: '/tmp' }]) {
      const report = run(probeEnv, 'doctor', '--json');
      const { checks } = JSON.parse(report.stdout) as ReturnType<typeof runDoctor>;
      expect(checks.find((check) => check.id === 'antigravity-native-activation')?.status).toBe('ok');
      expect(checks.find((check) => check.id === 'antigravity-direct-command')).toMatchObject({
        status: 'ok',
        detail: 'The direct command denied a synthetic .env read and a protected-file overwrite.',
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, DOCTOR_CHECK_TIMEOUT_MS);

test.skipIf(process.platform === 'win32')('doctor Antigravity guard probe fails when a stale hook returns force_ask for protected-file overwrites', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('rh-antigravity-probe-force-ask');
  try {
    seedAntigravitySkillInputs(home, fakeBin);
    const bunInstall = path.join(root, 'bun');
    const env = { HOME: home, PATH: fakeBin, BUN_INSTALL: bunInstall, TMPDIR: root };
    const bundle = path.join(seedGlobalPackageFixture(env, { mutable: true }), 'dist/hook-entry.js');
    const cli = path.join(import.meta.dir, '../../src/cli/index.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', cli, ...args], { cwd: root, env, encoding: 'utf8' });
    const install = run('install', '--target', 'antigravity');
    expect(install.status, install.stderr).toBe(0);

    // Simulate a v0.37.2 hook: denies .env reads, returns force_ask for protected-file overwrites.
    // Also fails the assertion if the probe ever puts HOME back inside TMPDIR.
    fs.writeFileSync(bundle, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
      "const cmd = input.toolCall?.args?.CommandLine ?? '';",
      "if (cmd.includes('.env')) {",
      "  console.log(JSON.stringify({ decision: 'deny', reason: 'rh hook: the tool call is refused' }));",
      "} else {",
      "  const home = fs.realpathSync(process.env.HOME);",
      "  const tmp = fs.realpathSync(process.env.TMPDIR);",
      "  const homeInTmp = home === tmp || home.startsWith(tmp + path.sep);",
      "  console.log(JSON.stringify(homeInTmp",
      "    ? { decision: 'deny', reason: 'rh hook: the tool call is refused' }",
      "    : { decision: 'force_ask', reason: '[UserFileGuard] I2: This tool call may overwrite or remove an existing file outside the allowed roots.' }));",
      "}",
    ].join('\n'));

    const report = run('doctor', '--json');
    const { checks } = JSON.parse(report.stdout) as ReturnType<typeof runDoctor>;
    expect(checks.find((check) => check.id === 'antigravity-native-activation')?.status).toBe('ok');
    expect(checks.find((check) => check.id === 'antigravity-direct-command')).toMatchObject({
      status: 'fail',
      detail: 'The direct command did not return the expected guard denial.',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, DOCTOR_CHECK_TIMEOUT_MS);

test.skipIf(process.platform === 'win32')('doctor checks Antigravity global rules and projected skills across absent, ok, stale, unbalanced, and linked states', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('rh-antigravity-doctor-rules-skills');
  try {
    seedAntigravitySkillInputs(home, fakeBin);
    const bunInstall = path.join(root, 'bun');
    const env = { HOME: home, PATH: fakeBin, BUN_INSTALL: bunInstall, TMPDIR: root };
    seedGlobalPackageFixture(env);
    const cli = path.join(import.meta.dir, '../../src/cli/index.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', cli, ...args], { cwd: root, env, encoding: 'utf8' });
    const doctorStatuses = () => {
      const report = run('doctor', '--json');
      const { checks } = JSON.parse(report.stdout) as ReturnType<typeof runDoctor>;
      return {
        rules: checks.find((check) => check.id === 'antigravity-global-rules'),
        skills: checks.find((check) => check.id === 'antigravity-skills'),
      };
    };

    // Before install: both checks report na.
    const before = doctorStatuses();
    expect(before.rules?.status).toBe('na');
    expect(before.skills?.status).toBe('na');

    // After install: both checks report ok.
    const install = run('install', '--target', 'antigravity');
    expect(install.status, install.stdout + install.stderr).toBe(0);
    const installed = doctorStatuses();
    expect(installed.rules?.status).toBe('ok');
    expect(installed.skills?.status).toBe('ok');

    const rulesPath = path.join(home, '.gemini', 'config', 'AGENTS.md');
    const skillsDir = path.join(home, '.gemini', 'config', 'skills');
    const originalRules = fs.readFileSync(rulesPath, 'utf8');

    // Edited managed block -> warn; unbalanced markers -> fail.
    fs.writeFileSync(rulesPath, originalRules.replace("Use the user's language for reports", 'Edited line'));
    expect(doctorStatuses().rules?.status).toBe('warn');
    fs.writeFileSync(rulesPath, '<!-- BEGIN: repo-harness global-working-rules -->\nbroken\n');
    expect(doctorStatuses().rules?.status).toBe('fail');
    fs.writeFileSync(rulesPath, originalRules);

    // Missing skill symlink -> fail; wrong symlink target -> fail; restored original symlink -> ok.
    const checkSkill = path.join(skillsDir, 'repo-harness-check');
    const parkedSkill = path.join(root, 'repo-harness-check-link');
    fs.renameSync(checkSkill, parkedSkill);
    expect(doctorStatuses().skills?.status).toBe('fail');
    fs.symlinkSync(home, checkSkill, 'dir');
    expect(doctorStatuses().skills?.status).toBe('fail');
    fs.unlinkSync(checkSkill);
    fs.renameSync(parkedSkill, checkSkill);
    expect(doctorStatuses().skills?.status).toBe('ok');

    // Symlinked AGENTS.md or skills directory -> fail with antigravity_hooks_path_linked.
    const parkedRules = path.join(root, 'AGENTS.md');
    fs.renameSync(rulesPath, parkedRules);
    fs.symlinkSync(parkedRules, rulesPath);
    expect(doctorStatuses().rules).toMatchObject({ status: 'fail', detail: expect.stringContaining('antigravity_hooks_path_linked') });
    fs.unlinkSync(rulesPath);
    fs.renameSync(parkedRules, rulesPath);

    const parkedSkills = path.join(root, 'skills');
    fs.renameSync(skillsDir, parkedSkills);
    fs.symlinkSync(parkedSkills, skillsDir, 'dir');
    expect(doctorStatuses().skills).toMatchObject({ status: 'fail', detail: expect.stringContaining('antigravity_hooks_path_linked') });
    fs.unlinkSync(skillsDir);
    fs.renameSync(parkedSkills, skillsDir);

    // After uninstall: both return to na.
    const uninstall = run('uninstall', '--target', 'antigravity');
    expect(uninstall.status, uninstall.stdout + uninstall.stderr).toBe(0);
    const after = doctorStatuses();
    expect(after.rules?.status).toBe('na');
    expect(after.skills?.status).toBe('na');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.skipIf(process.platform === 'win32')('doctor reports matching-but-unmanaged for an Antigravity skill symlink without a ledger record', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('rh-antigravity-doctor-unmanaged');
  try {
    seedAntigravitySkillInputs(home, fakeBin);
    const bunInstall = path.join(root, 'bun');
    const env = { HOME: home, PATH: fakeBin, BUN_INSTALL: bunInstall, TMPDIR: root };
    seedGlobalPackageFixture(env);
    const cli = path.join(import.meta.dir, '../../src/cli/index.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', cli, ...args], { cwd: root, env, encoding: 'utf8' });

    const install = run('install', '--target', 'antigravity');
    expect(install.status, install.stdout + install.stderr).toBe(0);

    // Drop the ledger record for one valid symlink pointing to the expected source.
    const ledgerPath = path.join(home, '.repo-harness', 'config', 'ledger.json');
    const checkSkill = path.join(home, '.gemini', 'config', 'skills', 'repo-harness-check');
    const linkTargetBefore = fs.readlinkSync(checkSkill);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const skillKey = path.join(fs.realpathSync(home), '.gemini', 'config', 'skills', 'repo-harness-check');
    expect(ledger.paths[skillKey]).toBeDefined();
    delete ledger.paths[skillKey];
    const ledgerBytesBefore = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    fs.writeFileSync(ledgerPath, ledgerBytesBefore);

    const report = run('doctor', '--json');
    const { checks } = JSON.parse(report.stdout) as ReturnType<typeof runDoctor>;
    const skills = checks.find((check) => check.id === 'antigravity-skills');
    expect(skills?.status).not.toBe('ok');
    expect(skills?.status).toBe('warn');
    expect(skills?.detail).toContain('matching-but-unmanaged');
    expect(skills?.detail).toContain('repo-harness-check');

    // Read-only check: ledger and symlink remain untouched (never auto-adopted).
    expect(fs.readFileSync(ledgerPath)).toEqual(ledgerBytesBefore);
    expect(fs.readlinkSync(checkSkill)).toBe(linkTargetBefore);

    // Confirm rh update refuses to manage the same unrecorded symlink.
    const update = run('update', '--target', 'antigravity');
    expect(update.status).not.toBe(0);
    expect(update.stdout + update.stderr).toContain('rh has no record of it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

function writeFakeCodeGraph(fakeBin: string, logFile: string): void {
  writeExecutable(fakeBin,
    path.join(fakeBin, 'codegraph'),
    [
      '#!/bin/bash',
      'set -euo pipefail',
      `echo "codegraph $*" >> "${logFile}"`,
      'case "${1:-}" in',
      '  "--version") echo "0.9.6" ;;',
      '  "status") echo "CodeGraph Status"; echo "Index is up to date" ;;',
      '  "init"|"sync"|"install") echo "unexpected mutation" >&2; exit 2 ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
}

function writeFakeBunx(fakeBin: string): void {
  writeExecutable(fakeBin,
    path.join(fakeBin, 'bunx'),
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'if [[ "$*" == *"skills ls -g --json"* ]]; then echo "[]"; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
  );
}

afterEach(() => {
  clearRegisteredChecks();
});

// Doctor readiness runs `hc --version`; a fake hc first on PATH keeps the developer's hc out of every test.
const fakeHcBin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-harness-doctor-hc-')));
const pathBeforeFakeHc = process.env.PATH;
beforeAll(() => {
  writeExecutable(fakeHcBin, path.join(fakeHcBin, 'hc'), `#!/bin/sh\nprintf 'hc ${HC_MIN_VERSION}\\n'\n`);
  process.env.PATH = `${fakeHcBin}:${pathBeforeFakeHc ?? ''}`;
});
afterAll(() => {
  process.env.PATH = pathBeforeFakeHc;
  fs.rmSync(fakeHcBin, { recursive: true, force: true });
});

describe('magpie readiness', () => {
  async function runMagpieCheck({ root, home, fakeBin }: ReturnType<typeof setupFakeEnvironment>, port: number) {
    const env = { HOME: home, PATH: fakeBin, BUN_INSTALL: path.join(root, 'bun') };
    fs.mkdirSync(env.BUN_INSTALL);
    const modulePath = path.join(import.meta.dir, '../../src/cli/commands/doctor.ts');
    const child = Bun.spawn([process.execPath, '--no-env-file', '-e',
      `import { checkMagpie } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(checkMagpie(${port})));`,
    ], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return { stdout, stderr };
  }

  const magpieBinary = process.platform === 'win32' ? 'magpie.cmd' : 'magpie';

  test.each([
    { status: 'ok', httpStatus: 200, gatewayName: 'magpie' },
    { status: 'na', httpStatus: 200, gatewayName: 'other-service' },
    { status: 'warn', httpStatus: 302, gatewayName: 'magpie' },
  ])('reports $status for $gatewayName with HTTP $httpStatus', async ({ status, httpStatus, gatewayName }) => {
    const { root, home, fakeBin } = setupFakeEnvironment('repo-harness-doctor-magpie');
    const requests: unknown[] = [];
    const privateBody = 'gateway response body';
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      requests.push({ method: request.method, url: request.url, body: await request.text(),
        authorization: request.headers.get('authorization'), key: request.headers.get('x-api-key') });
      const body = { name: gatewayName, privateBody };
      if (new URL(request.url).pathname === '/redirected') return Response.json(body);
      return Response.json(body, { status: httpStatus, headers: httpStatus === 302 ? { location: '/redirected' } : {} });
    } });
    try {
      const invocation = path.join(root, 'magpie-invoked');
      writeExecutable(root, path.join(fakeBin, magpieBinary), `#!/bin/sh\nprintf invoked > '${invocation}'\n`);
      if (status !== 'ok') {
        const nonMagpie = { runtime: 'claude' as const, model: 'opus', advisor_model: null, effort: 'high', tools: DEFAULT_SEATS_CONFIG.gatekeeper.tools, fleet: [] };
        const seats = {
          ...DEFAULT_SEATS_CONFIG,
          advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'claude' as const, model: 'opus' },
          worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: 'codex' as const, model: 'gpt-6.1-terra' },
          'worker-deep': { ...DEFAULT_SEATS_CONFIG['worker-deep'], runtime: 'codex' as const, model: 'gpt-6.2-sol' },
          'worker-neon': { ...DEFAULT_SEATS_CONFIG['worker-neon'], runtime: 'claude' as const, model: 'opus' },
          'worker-neon-deep': null,
          'worker-light': null,
          gatekeeper: nonMagpie,
          routing: {
            ...DEFAULT_SEATS_CONFIG.routing,
            important_deep: ['worker-opus', 'worker-neon', 'worker-deep'],
            simple_deep: ['worker-neon', 'worker-deep'],
            important_fast: ['worker-opus', 'worker-neon', 'worker'],
            simple_fast: ['worker'],
          },
        };
        const configDir = path.join(home, '.repo-harness');
        fs.mkdirSync(configDir);
        fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ seats }));
      }
      if (status === 'warn') recordPluginSelection({ HOME: home }, ['peer-runtime']);

      const { stdout, stderr } = await runMagpieCheck({ root, home, fakeBin }, server.port!);
      expect(JSON.parse(stdout)).toMatchObject({ id: 'magpie', status });
      if (status === 'warn') expect(stdout).toContain('https://usemagpie.ai');
      expect(requests).toEqual([{ method: 'GET', url: `http://127.0.0.1:${server.port}/`, body: '', authorization: null, key: null }]);
      expect(stdout + stderr).not.toContain(privateBody);
      expect(fs.existsSync(invocation)).toBe(false);
    } finally {
      await server.stop(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    { name: 'unreadable config.json', config: 'directory', detail: 'Cannot determine magpie use' },
    { name: 'invalid seats section', config: 'invalid', detail: 'Cannot determine magpie use' },
    { name: 'explicit magpie seat with a closed gateway', config: 'seat', detail: 'Start the magpie gateway' },
    { name: 'default magpie seat in a fresh home', config: 'absent', detail: 'Add the magpie CLI to PATH' },
    { name: 'live gateway without a magpie binary', config: 'absent', gatewayLive: true, detail: 'Add the magpie CLI to PATH' },
  ])('warns for $name', async ({ config, detail, gatewayLive }) => {
    const fixture = setupFakeEnvironment('repo-harness-doctor-magpie-warn');
    const { root, home, fakeBin } = fixture;
    const configPath = path.join(home, '.repo-harness', 'config.json');
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ name: 'magpie' }) });
    const port = server.port!;
    try {
      if (!gatewayLive) await server.stop(true);
      if (config === 'directory') {
        fs.mkdirSync(configPath, { recursive: true }); // A directory at this path makes the config read fail.
      } else if (config === 'invalid' || config === 'seat') {
        const seats = config === 'invalid' ? {} : {
          ...DEFAULT_SEATS_CONFIG,
          'worker-light': null,
          worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: 'pi' as const, model: 'magpie/group/fixture', fleet: [] },
          routing: {
            ...DEFAULT_SEATS_CONFIG.routing,
            important_fast: ['worker-opus', 'worker-neon', 'worker'],
            simple_fast: ['worker'],
          },
        };
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({ seats }));
      }
      if (config === 'seat') writeExecutable(root, path.join(fakeBin, magpieBinary), '#!/bin/sh\nexit 1\n');

      const { stdout } = await runMagpieCheck(fixture, port);
      const check = JSON.parse(stdout);
      expect(check).toMatchObject({ id: 'magpie', status: 'warn' });
      expect(check.detail).toContain(detail);
      expect(check.detail).toContain('https://usemagpie.ai');
    } finally {
      if (gatewayLive) await server.stop(true);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('doctor command (Phase 1C)', () => {
  for (const target of ['claude', 'codex'] as const) {
    test(`${target} diagnostics do not run or inherit a failed Pi integration check`, () => {
      const f = setupFakeEnvironment(`repo-harness-doctor-${target}-pi`);
      const log = path.join(f.root, 'host-probes');
      try {
        writeExecutable(f.root, path.join(f.fakeBin, 'pi'), `#!/bin/sh\necho pi >> '${log}'\nexit 99\n`);
        withEnv({ HOME: f.home, PATH: f.fakeBin }, () => {
          const report = runDoctor(CLI_PORTS.doctor, f.root, target);
          expect(report.checks.some(check => check.id.startsWith('pi-'))).toBe(false);
          expect(report.checks.map(check => check.id)).toContain(`${target}-adapter`);
        });
        expect(fs.existsSync(log)).toBe(false);
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }, DOCTOR_CHECK_TIMEOUT_MS);
  }

  test('runDoctor emits the built-in checks (path/version/hosts/trust)', () => {
    registerArchitecturePlugin();
    withTempHome('repo-harness-doctor', (home) => {
      const r = runDoctor(CLI_PORTS.doctor);
      const ids = r.checks.map((c) => c.id);
      expect(r.checks.find((c) => c.id === 'herdr-notify-relay')).toMatchObject({ status: 'na', detail: 'Herdr notify is not installed.' });
      // With an install record, the relay check reads one `hc ls` and names the start command when no relay is live.
      const rhHome = path.join(home, '.repo-harness');
      writeNotifyInstallRecord({ REPO_HARNESS_HOME: rhHome });
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      writeExecutable(home, path.join(bin, 'hc'), [
        '#!/bin/sh',
        `env | grep -E '^(WEBHOOK|SLACK|DISCORD|TELEGRAM)_' >> '${path.join(home, 'hc-env')}'`,
        'case "$FIXTURE_HC" in',
        `  live) echo '{"terminals":[{"address":"t5","name":"rh-notify-relay","state":"live"}]}' ;;`,
        `  stopped) echo '{"terminals":[]}' ;;`,
        '  *) exit 1 ;;',
        'esac',
        '',
      ].join('\n'));
      // Notify values exported in the caller's shell never reach the hc child: hc can keep them in a core it starts.
      const exported = { WEBHOOK_URL: 'https://bot.example/x', WEBHOOK_KEY: 'k', SLACK_WEBHOOK_URL: 'https://slack.example/x',
        DISCORD_WEBHOOK_URL: 'https://discord.example/x', TELEGRAM_BOT_TOKEN: '1:t', TELEGRAM_CHAT_ID: '-1' };
      const relay = (mode: string) => { let result; withEnv({ ...exported, PATH: `${bin}:${process.env.PATH}`, REPO_HARNESS_HOME: rhHome, FIXTURE_HC: mode }, () => { result = notifyRelayDoctorCheck(); }); return result; };
      expect(relay('live')).toMatchObject({ status: 'ok', detail: 'Relay terminal rh-notify-relay is live.' });
      expect(relay('stopped')).toMatchObject({ status: 'warn',
        detail: 'Relay terminal rh-notify-relay is not live (relay_stopped). Notifications are paused. Run: rh herdr notify start' });
      expect(relay('fail')).toMatchObject({ status: 'warn', detail: 'hc did not answer, so the relay state is unknown (hc_unavailable).' });
      expect(fs.readFileSync(path.join(home, 'hc-env'), 'utf8')).toBe('');
      expect(ids).toContain('cli-on-path');
      expect(ids).toContain('cli-version');
      expect(ids).toContain('codex-cli-version');
      expect(ids.filter(id => id === 'magpie')).toHaveLength(1);
      expect(ids).toContain('cli-update');
      expect(ids).toContain('codex-adapter');
      expect(ids).toContain('claude-adapter');
      expect(ids).toContain('codex-trust-state');
      expect(ids).toContain('codegraph-readiness');
      expect(ids).toContain('codex-codegraph-mcp');
      expect(ids).toContain('claude-codegraph-mcp');
      expect(ids).toContain('codegraph-index');
      expect(ids).toContain('security-config');
      expect(ids).toContain('typed-hook-routes');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('cli-on-path resolves rh from PATH without requiring Unix which and warns on the retired command', () => {
    withTempHome('repo-harness-doctor', () => {
      const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-harness-doctor-path-')));
      try {
        const fakeBin = path.join(tmp, 'bin');
        fs.mkdirSync(fakeBin, { recursive: true });
        const fakeCli = path.join(fakeBin, 'rh');
        writeExecutable(tmp, fakeCli, '#!/bin/bash\nexit 0\n');
        const fakeHook = path.join(fakeBin, 'repo-harness-hook');
        writeExecutable(tmp, fakeHook, '#!/bin/bash\nexit 0\n');

        withEnv({ PATH: fakeBin }, () => {
          const r = runDoctor(CLI_PORTS.doctor, tmp);
          const pathCheck = r.checks.find((c) => c.id === 'cli-on-path')!;
          expect(pathCheck.status).toBe('ok');
          expect(pathCheck.detail).toBe(`${fakeCli}; repo-harness-hook: ${fakeHook}`);
        });
        writeExecutable(tmp, path.join(fakeBin, 'repo-harness'), '#!/bin/bash\nexit 0\n');
        withEnv({ PATH: fakeBin }, () => {
          const pathCheck = runDoctor(CLI_PORTS.doctor, tmp).checks.find((c) => c.id === 'cli-on-path')!;
          expect(pathCheck.status).toBe('warn');
          expect(pathCheck.detail).toBe(`The retired command repo-harness is still on PATH at ${path.join(fakeBin, 'repo-harness')}; run rh update, or remove it if update reports it as not managed.`);
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('an old adapter reports projection mismatch and a missing hook bin', () => {
    withTempHome('repo-harness-doctor', home => {
      const bin = path.join(home, 'bin');
      fs.mkdirSync(bin);
      writeExecutable(home, path.join(bin, 'rh'), '#!/bin/sh\nexit 0\n');
      const hooks = buildManagedHooks('codex');
      hooks.Stop[0].hooks[0].timeout = 150;
      hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', timeout: 30,
        command: `: ${MANAGED_TAG}; HOOK_HOST=codex exec repo-harness-hook UserPromptSubmit --route default` }] });
      fs.mkdirSync(path.join(home, '.codex'));
      fs.writeFileSync(path.join(home, '.codex/hooks.json'), JSON.stringify({ hooks }));
      const before = fs.readFileSync(path.join(home, '.codex/hooks.json'), 'utf8');
      withEnv({ PATH: bin }, () => {
        const report = runDoctor(CLI_PORTS.doctor, home, 'codex');
        const pathCheck = report.checks.find(check => check.id === 'cli-on-path')!;
        expect(pathCheck.status).toBe('warn');
        expect(pathCheck.detail).toContain('repo-harness-hook not on PATH');
        const adapter = report.checks.find(check => check.id === 'codex-adapter')!;
        expect(adapter.status).toBe('warn');
        expect(adapter.detail).toContain('UserPromptSubmit.default unexpected');
        expect(adapter.detail).toContain('Stop.default timeout expected=30 actual=150');
        expect(adapter.detail).toContain('rh install --target codex --location global');
        expect(adapter.detail).toContain('rh run <helper>');
        withEnv({ BUN_INSTALL: path.join(home, 'missing-bun') }, () => {
          const unavailable = runDoctor(CLI_PORTS.doctor, home, 'codex');
          for (const id of ['codex-adapter', 'security-config']) {
            const check = unavailable.checks.find(check => check.id === id)!;
            expect(check.status).toBe('fail');
            expect(check.detail).toContain('bun add -g repo-harness');
          }
        });
      });
      expect(fs.readFileSync(path.join(home, '.codex/hooks.json'), 'utf8')).toBe(before);
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('codex-cli-version reports n/a when codex is absent from PATH', () => {
    const envRoot = setupFakeEnvironment('repo-harness-doctor-codex-absent');
    try {
      withEnv({ HOME: envRoot.home, PATH: envRoot.fakeBin }, () => {
        const r = runDoctor(CLI_PORTS.doctor, envRoot.root);
        const codex = r.checks.find((c) => c.id === 'codex-cli-version')!;
        expect(codex.status).toBe('na');
        expect(codex.detail).toBe('codex not found on PATH');
      });
    } finally {
      fs.rmSync(envRoot.root, { recursive: true, force: true });
    }
  }, DOCTOR_CHECK_TIMEOUT_MS);

  for (const expected of [
    { version: '0.143.0', status: 'warn', stable: true },
    { version: '0.144.0', status: 'ok', stable: true },
    { version: '0.144.0-alpha.4', status: 'warn', stable: false },
  ] as const) {
    test(`codex-cli-version reports ${expected.status} for Codex ${expected.version}`, () => {
      const envRoot = setupFakeEnvironment(`repo-harness-doctor-codex-${expected.version}`);
      const fakeCodex = path.join(envRoot.fakeBin, 'codex');
      try {
        writeExecutable(envRoot.root, fakeCodex, `#!/bin/bash\nprintf 'codex-cli ${expected.version}\\n'\n`);
        withEnv({ HOME: envRoot.home, PATH: envRoot.fakeBin }, () => {
          const r = runDoctor(CLI_PORTS.doctor, envRoot.root);
          const codex = r.checks.find((c) => c.id === 'codex-cli-version')!;
          expect(codex.status).toBe(expected.status);
          expect(codex.detail).toContain(`path=${fakeCodex}`);
          if (expected.stable) {
            expect(codex.detail).toContain(`current=${expected.version}`);
            expect(codex.detail).toContain('minimum=0.144.0');
          } else {
            expect(codex.detail).toContain(`unable to parse version from "codex-cli ${expected.version}"`);
          }
        });
      } finally {
        fs.rmSync(envRoot.root, { recursive: true, force: true });
      }
    }, DOCTOR_CHECK_TIMEOUT_MS);
  }

  test('typed-hook-routes reports n/a for non-opt-in repos', () => {
    withTempRepo({ optIn: false }, (repoRoot) => {
      const r = runDoctor(CLI_PORTS.doctor, repoRoot);
      const hooks = r.checks.find((c) => c.id === 'typed-hook-routes')!;
      expect(hooks.status).toBe('na');
      expect(hooks.detail).toContain('not opted in');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('typed-hook-routes verifies the exhaustive in-process binding', () => {
    withTempRepo({ optIn: true }, (repoRoot) => {
      const r = runDoctor(CLI_PORTS.doctor, repoRoot);
      const hooks = r.checks.find((c) => c.id === 'typed-hook-routes')!;
      expect(hooks.status).toBe('ok');
      expect(hooks.detail).toContain('all 8 public routes');
      expect(hooks.detail).toContain('typed in-process handler');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('capability-registry loads the model and fails with the cause and the next step', () => {
    withTempRepo({ optIn: true }, (repoRoot) => {
      const registryCheck = () => runDoctor(CLI_PORTS.doctor, repoRoot).checks.find((c) => c.id === 'capability-registry')!;
      expect(registryCheck()).toMatchObject({ status: 'na', detail: 'no capability registry is declared' });

      fs.writeFileSync(path.join(repoRoot, '.ai/harness/policy.json'), `${JSON.stringify({ context: { capability_source: 'archcontext' } })}\n`);
      const nodes = path.join(repoRoot, '.archcontext/model/nodes');
      fs.mkdirSync(nodes, { recursive: true });
      // Node files exist, but this one has no status, so the model does not load.
      fs.writeFileSync(path.join(nodes, 'capability.a.b.yaml'), 'schemaVersion: archcontext.node/v2\nid: capability.a.b\nkind: capability\n');
      fs.copyFileSync(path.join(import.meta.dir, '../../.archcontext/manifest.yaml'), path.join(repoRoot, '.archcontext/manifest.yaml'));
      execFileSync('git', ['add', '.'], { cwd: repoRoot });
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-q', '-m', 'model'], { cwd: repoRoot });
      const invalid = registryCheck();
      expect(invalid.status).toBe('fail');
      expect(invalid.detail).toContain('archcontext authority does not load: AC_SCHEMA_INVALID');
      expect(invalid.detail).toContain('capability.a.b $.status required');
      expect(invalid.detail).toContain('Next: run rh capability resolve validate');

      // A declared newer minimum names the upgrade, not the parse error.
      fs.writeFileSync(path.join(repoRoot, '.ai/harness/workflow-contract.json'), `${JSON.stringify({ minimum_harness_version: '999.0.0' })}\n`);
      const upgrade = registryCheck();
      expect(upgrade.status).toBe('fail');
      expect(upgrade.detail).toContain('This repository needs repo-harness >= 999.0.0;');
      expect(upgrade.detail).not.toContain('does not load');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('capability-registry is ok when the declared model loads', () => {
    withTempRepo({ optIn: true }, (repoRoot) => {
      fs.mkdirSync(path.join(repoRoot, '.ai/context'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, '.ai/context/capabilities.json'), `${JSON.stringify({ version: 1, capabilities: [] })}\n`);
      const check = runDoctor(CLI_PORTS.doctor, repoRoot).checks.find((c) => c.id === 'capability-registry')!;
      expect(check).toMatchObject({ status: 'ok', detail: 'registry authority loads 0 capabilities' });
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('capability-registry applies the hook rules for an empty registry and an explicit registry selector', () => {
    withTempRepo({ optIn: true }, (repoRoot) => {
      const registryCheck = () => runDoctor(CLI_PORTS.doctor, repoRoot).checks.find((c) => c.id === 'capability-registry')!;
      fs.mkdirSync(path.join(repoRoot, '.ai/context'), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, '.ai/context/capabilities.json'), '');
      // An empty file counts as missing; without a declaration that is not a fault.
      expect(registryCheck()).toMatchObject({ status: 'na', detail: 'no capability registry is declared' });

      fs.writeFileSync(path.join(repoRoot, '.ai/harness/policy.json'), `${JSON.stringify({ context: { capability_source: 'registry' } })}\n`);
      const missing = registryCheck();
      expect(missing.status).toBe('fail');
      expect(missing.detail).toContain('registry authority does not load: capability registry is missing');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('codex-trust-state reports n/a when ~/.codex/config.toml is missing', () => {
    withTempHome('repo-harness-doctor', () => {
      const r = runDoctor(CLI_PORTS.doctor);
      const trust = r.checks.find((c) => c.id === 'codex-trust-state')!;
      expect(trust.status).toBe('na');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('cli-update is agent-triggered and does not check npm by default', () => {
    withTempHome('repo-harness-doctor', () => {
      withEnv({ REPO_HARNESS_CHECK_UPDATES: undefined, REPO_HARNESS_LATEST_VERSION: undefined }, () => {
        const r = runDoctor(CLI_PORTS.doctor);
        const update = r.checks.find((c) => c.id === 'cli-update')!;
        expect(update.status).toBe('na');
        expect(update.detail).toContain('Agent can run REPO_HARNESS_CHECK_UPDATES=1 rh doctor --json');
      });
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('cli-update warns with an Agent action when the package is stale', () => {
    withTempHome('repo-harness-doctor', () => {
      withEnv({ REPO_HARNESS_CHECK_UPDATES: '1', REPO_HARNESS_LATEST_VERSION: '99.0.0' }, () => {
        const r = runDoctor(CLI_PORTS.doctor);
        const update = r.checks.find((c) => c.id === 'cli-update')!;
        expect(update.status).toBe('warn');
        expect(update.detail).toContain('current=');
        expect(update.detail).toContain('latest=99.0.0');
        expect(update.detail).toContain('agent_action=rh update --target both');
      });
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('compareVersions orders a pre-release before its release', () => {
    expect(compareVersions('0.26.0-rc.1', '0.26.0')).toBe(-1);
    expect(compareVersions('0.26.0', '0.26.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBe(1);
    expect(compareVersions('v1.2.3+sha.1', '1.2.3')).toBe(0);
    expect(compareVersions('', '1.0.0')).toBeNull();
  });

  test('cli-update scopes the recommended runtime refresh to the requested target', () => {
    withTempHome('repo-harness-doctor', () => {
      withEnv({ REPO_HARNESS_CHECK_UPDATES: '1', REPO_HARNESS_LATEST_VERSION: '99.0.0' }, () => {
        for (const target of ['codex', 'claude'] as const) {
          const r = runDoctor(CLI_PORTS.doctor, process.cwd(), target);
          const update = r.checks.find((c) => c.id === 'cli-update')!;
          expect(update.status).toBe('warn');
          expect(update.detail).toContain(`agent_action=rh update --target ${target}`);
        }
      });
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('registry version lookup uses the running Bun and ignores repo PATH package-manager shims', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-harness-version-lookup-')));
    const fakeBin = path.join(root, 'bin');
    const probe = path.join(root, 'bun-probe');
    const probeLog = path.join(root, 'probe.log');
    const fakeNpmLog = path.join(root, 'fake-npm.log');
    const previousExecPath = process.execPath;
    try {
      fs.mkdirSync(fakeBin, { recursive: true });
      writeExecutable(root,
        probe,
        [
          '#!/bin/bash',
          'set -euo pipefail',
          `printf '%s\\n%s\\n' "$PWD" "$*" > "${probeLog}"`,
          'if [[ ! -f "$PWD/package.json" ]]; then echo "missing package.json in cwd" >&2; exit 43; fi',
          'printf \'"99.0.0"\\n\'',
          '',
        ].join('\n'),
      );
      writeExecutable(root,
        path.join(fakeBin, 'npm'),
        `#!/bin/bash\nprintf '%s\\n' "$*" > "${fakeNpmLog}"\nexit 42\n`,
      );
      Object.defineProperty(process, 'execPath', { value: probe, configurable: true });

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      };
      delete env.REPO_HARNESS_LATEST_VERSION;
      const result = readLatestPackageVersion(env);

      expect(result).toEqual({ version: '99.0.0' });
      const [cwd, args] = fs.readFileSync(probeLog, 'utf-8').trim().split('\n');
      const packageRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
      expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(packageRoot));
      expect(args).toBe(
        'pm view repo-harness version --json --registry=https://registry.npmjs.org',
      );
      expect(fs.existsSync(fakeNpmLog)).toBe(false);
    } finally {
      Object.defineProperty(process, 'execPath', { value: previousExecPath, configurable: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('codex-trust-state counts user-level [hooks.state] lines when present', () => {
    withTempHome('repo-harness-doctor', (home) => {
      const configPath = path.join(home, '.codex/config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const content = `[features]\nhooks = true\n\n[hooks.state."${home}/.codex/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:a"\n\n[hooks.state."${home}/.codex/hooks.json:post_tool_use:0:0"]\ntrusted_hash = "sha256:b"\n\n[hooks.state."${home}/.codex/hooks.json:session_start:0:0"]\ntrusted_hash = "sha256:c"\n`;
      fs.writeFileSync(configPath, content);
      const r = runDoctor(CLI_PORTS.doctor);
      const trust = r.checks.find((c) => c.id === 'codex-trust-state')!;
      expect(trust.status).toBe('ok');
      expect(trust.detail).toContain('3');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('registerCheck still supports additional plugin entries', () => {
    withTempHome('repo-harness-doctor', () => {
      registerCheck({
        id: 'codegraph-test',
        describe: 'placeholder for Phase 2 wiring',
        run: () => ({ status: 'ok', detail: 'plugin reachable' }),
      });
      const r = runDoctor(CLI_PORTS.doctor);
      const plugin = r.checks.find((c) => c.id === 'codegraph-test');
      expect(plugin).toBeDefined();
      expect(plugin!.status).toBe('ok');
      expect(plugin!.detail).toBe('plugin reachable');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('summary tallies each status correctly', () => {
    withTempHome('repo-harness-doctor', () => {
      registerCheck({ id: 'ok-a', describe: '', run: () => ({ status: 'ok', detail: '' }) });
      registerCheck({ id: 'fail-b', describe: '', run: () => ({ status: 'fail', detail: '' }) });
      registerCheck({ id: 'na-c', describe: '', run: () => ({ status: 'na', detail: '' }) });
      const r = runDoctor(CLI_PORTS.doctor);
      const totalReported =
        r.summary.ok + r.summary.warn + r.summary.fail + r.summary.na;
      expect(totalReported).toBe(r.checks.length);
      expect(r.summary.fail).toBeGreaterThanOrEqual(1);
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('formatDoctor includes a Summary line', () => {
    withTempHome('repo-harness-doctor', () => {
      const text = formatDoctor(runDoctor(CLI_PORTS.doctor), false);
      expect(text).toContain('Summary:');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('formatDoctor --json produces parseable JSON', () => {
    withTempHome('repo-harness-doctor', () => {
      const json = formatDoctor(runDoctor(CLI_PORTS.doctor), true);
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(Array.isArray(parsed.checks)).toBe(true);
      expect(parsed.summary).toBeDefined();
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('security-config reports fail when hook JSON is invalid', () => {
    withTempHome('repo-harness-doctor', (home) => {
      const hooksPath = path.join(home, '.codex/hooks.json');
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, '{ not json');
      const r = runDoctor(CLI_PORTS.doctor);
      const security = r.checks.find((c) => c.id === 'security-config')!;
      expect(security.status).toBe('fail');
      expect(security.detail).toContain('invalid-json');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('security-config treats reviewed user-level warning as ok', () => {
    withTempHome('repo-harness-doctor', (home) => {
      const settingsPath = path.join(home, '.claude/settings.json');
      const configPath = path.join(home, '.repo-harness/config.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            SessionStart: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
          },
        }, null, 2),
      );
      const unreviewed = runDoctor(CLI_PORTS.doctor).checks.find(check => check.id === 'security-config')!;
      expect(unreviewed.status).toBe('warn');
      expect(unreviewed.detail).not.toContain('echo hello');
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          security: {
            reviewed_findings: [
              {
                filePath: '~/.claude/settings.json',
                ruleId: 'unmanaged-hook-command',
                command: 'echo hello',
                reason: 'Reviewed local test hook',
              },
            ],
          },
        }, null, 2),
      );

      const r = runDoctor(CLI_PORTS.doctor);
      const security = r.checks.find((c) => c.id === 'security-config')!;
      expect(security.status).toBe('ok');
      expect(security.detail).toContain('no active findings');
      expect(security.detail).toContain('1 reviewed exception');
    });
  }, DOCTOR_CHECK_TIMEOUT_MS);

  test('CLI doctor includes CodeGraph readiness without mutating CodeGraph state', () => {
    const envRoot = setupFakeEnvironment('repo-harness-doctor-codegraph');
    const logFile = path.join(envRoot.root, 'tool.log');
    try {
      fs.mkdirSync(path.join(envRoot.home, '.codex'), { recursive: true });
      fs.mkdirSync(envRoot.home, { recursive: true });
      fs.writeFileSync(
        path.join(envRoot.home, '.codex', 'config.toml'),
        '[mcp_servers.codegraph]\ncommand = "codegraph"\n',
      );
      fs.writeFileSync(
        path.join(envRoot.home, '.claude.json'),
        JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } } }),
      );
      writeFakeCodeGraph(envRoot.fakeBin, logFile);
      writeFakeBunx(envRoot.fakeBin);

      const root = path.join(import.meta.dir, '..', '..');
      fs.copyFileSync(path.join(root, 'package.json'), path.join(envRoot.root, 'package.json'));
      const env = {
        ...process.env,
        HOME: envRoot.home,
        REPO_HARNESS_HOME: path.join(envRoot.home, '.repo-harness'),
        PATH: `${envRoot.fakeBin}:${process.env.PATH ?? ''}`,
        REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0',
      };
      recordPluginSelection(env);
      const doctor = () => spawnSync('bun', [path.join(root, 'src/cli/index.ts'), 'doctor', '--json'], { cwd: envRoot.root, encoding: 'utf-8', env });
      const outside = JSON.parse(doctor().stdout).checks;
      for (const id of ['codegraph-index', 'typed-hook-routes', 'capability-registry']) {
        expect(outside.find((entry: { id: string }) => entry.id === id)).toMatchObject({ status: 'na', detail: 'not in a git repository' });
      }
      execSync('git init', { cwd: envRoot.root, stdio: 'ignore' });
      fs.mkdirSync(path.join(envRoot.root, '.codegraph'));
      const res = doctor();

      expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
      const report = JSON.parse(res.stdout);
      const codegraph = report.checks.find((entry: { id: string }) => entry.id === 'codegraph-readiness');
      expect(codegraph).toBeDefined();
      expect(codegraph.status).toBe('warn');
      expect(codegraph.detail).toContain('source=global');
      expect(codegraph.detail).toContain('claude-mcp=deferred');
      expect(codegraph.detail).toContain('remediation=bun install');
      const codexMcp = report.checks.find((entry: { id: string }) => entry.id === 'codex-codegraph-mcp');
      const claudeMcp = report.checks.find((entry: { id: string }) => entry.id === 'claude-codegraph-mcp');
      const index = report.checks.find((entry: { id: string }) => entry.id === 'codegraph-index');
      expect(codexMcp.status).toBe('ok');
      expect(claudeMcp.status).toBe('warn');
      expect(claudeMcp.detail).toContain('alwaysLoad is not true');
      expect(claudeMcp.detail).toContain('rh arch codegraph configure --target claude --location global');
      expect(index.status).toBe('ok');

      const log = fs.readFileSync(logFile, 'utf-8');
      expect(log).toContain('codegraph --version');
      expect(log).toContain('codegraph status .');
      expect(log).not.toContain('codegraph init');
      expect(log).not.toContain('codegraph sync');
      expect(log).not.toContain('codegraph install');

      // A selection without architecture has no CodeGraph: one na row replaces the CodeGraph checks and doctor probes nothing.
      fs.rmSync(logFile);
      const statePath = installStateFixturePath(env);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ protocol: 5, ...versions(['product']), selection: ['product'], transaction_id: 'doctor',
        applied_at: '2026-11-01T00:00:00.000Z', previous: null }));
      const unselected = JSON.parse(doctor().stdout).checks
        .filter((entry: { id: string }) => ['codegraph', 'codegraph-readiness', 'codex-codegraph-mcp', 'claude-codegraph-mcp', 'codegraph-index'].includes(entry.id))
        .map(({ id, status, detail }: { id: string; status: string; detail: string }) => ({ id, status, detail }));
      expect(unselected).toEqual([{ id: 'codegraph', status: 'na',
        detail: 'the architecture plugin is not selected; run: rh install --plugins architecture,product' }]);
      expect(fs.existsSync(logFile)).toBe(false);
    } finally {
      fs.rmSync(envRoot.root, { recursive: true, force: true });
    }
  }, 15000);
});

describe('doctor skill projection', () => {
  const root = path.resolve(import.meta.dir, '../..');
  function seed(home: string) {
    const source = path.join(home, '.bun/install/global/node_modules/repo-harness');
    // These cases need a mutable package copy rather than the shared runtime link.
    fs.unlinkSync(source);
    fs.mkdirSync(path.join(source, 'assets/skill-commands'), { recursive: true });
    fs.cpSync(path.join(root, 'assets/skill-commands/manifest.json'), path.join(source, 'assets/skill-commands/manifest.json'));
    fs.cpSync(path.join(root, 'assets/workflow-contract.v1.json'), path.join(source, 'assets/workflow-contract.v1.json'));
    fs.cpSync(path.join(root, 'assets/skills/repo-harness-cross-review'), path.join(source, 'assets/skills/repo-harness-cross-review'), { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'repo-harness', version: '0.20.0' }));
    const destination = path.join(home, '.codex/skills/repo-harness-cross-review');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    return { source: path.join(source, 'assets/skills/repo-harness-cross-review'), destination,
      // A PATH without `pi` keeps the default selection independent of the host.
      env: { ...process.env, HOME: home, BUN_INSTALL: path.join(home, '.bun'), PATH: '/usr/bin:/bin' } };
  }

  for (const state of ['ok link', 'stale copy', 'missing', 'dangling link', 'wrong link', 'ok copy'] as const) {
    test(`reports ${state} with the affected path and repair command`, () => withTempHome('repo-harness-doctor', home => {
      const f = seed(home);
      if (state === 'ok link') fs.symlinkSync(f.source, f.destination);
      if (state === 'dangling link') fs.symlinkSync(path.join(home, 'missing'), f.destination);
      if (state === 'wrong link') fs.symlinkSync(root, f.destination);
      if (state === 'stale copy' || state === 'ok copy') {
        fs.cpSync(f.source, f.destination, { recursive: true });
        if (state === 'stale copy') fs.writeFileSync(path.join(f.destination, 'SKILL.md'), 'user change\n');
      }
      const result = checkSkillProjection('both', f.env);
      expect(result.id).toBe('skill-projection');
      expect(result.detail).toContain(`${f.destination}: ${state}`);
      expect(result.detail).toMatch(DEFAULT_FIX_LINE);
      expect(result.detail).toContain(path.join(home, '.claude/skills/repo-harness-cross-review') + ': missing');
      expect(result.detail).toContain(path.join(home, '.codex/skills/think') + ': missing');
      if (state === 'stale copy') expect(fs.readFileSync(path.join(f.destination, 'SKILL.md'), 'utf8')).toBe('user change\n');
      if (state === 'dangling link') expect(fs.readlinkSync(f.destination)).toBe(path.join(home, 'missing'));
    }));
  }

  test('per-skill rows and the CLI text are two projections of the same judgments', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    const packageRoot = path.join(home, '.bun/install/global/node_modules/repo-harness');
    const catalog = parseSkillSurfaceCatalog(fs.readFileSync(path.join(packageRoot, 'assets/skill-commands/manifest.json'), 'utf8'),
      { declared: true });
    if (catalog.status !== 'valid') throw new Error('fixture catalog invalid');
    // The pre-row CLI line format, frozen: the rows must regenerate it byte for byte.
    const frozenLine = (projection: SkillProjection, state: string, ledgerDrift: boolean): string => {
      const fix = DEFAULT_FIX;
      const shown = state === 'ok link' ? `ok link -> ${projection.source}` : state;
      const problems: string[] = [];
      if (!shown.startsWith('ok ')) {
        const preserve = state === 'missing' || state === 'source missing' ? '' : `preserve or move ${projection.destination}, then `;
        problems.push(`expected ${projection.source}; ${preserve}run: ${fix}`);
      }
      if (ledgerDrift) problems.push(`ledger drift; inspect: rh install --state; then run: ${fix}`);
      return `${projection.destination}: ${shown}${problems.length > 0 ? '; ' + problems.join('; ') : ''}`;
    };
    const crossReview = 'repo-harness-cross-review';
    const allProjections = expectedSkillProjections(catalog.catalog, packageRoot, home, FULL_PLUGINS, f.env);
    const codexProjection = (name: string): SkillProjection => allProjections.find(p => p.host === 'codex' && p.name === name)!;
    const ledgerPath = installStateFixturePath({ HOME: home });
    const cases: { state: string; name: string; ledger?: boolean; setup: (p: SkillProjection) => void }[] = [
      { state: 'ok link', name: crossReview, setup: p => fs.symlinkSync(p.source, p.destination) },
      { state: 'dangling link', name: crossReview, setup: p => fs.symlinkSync(path.join(home, 'missing'), p.destination) },
      { state: 'wrong link', name: crossReview, setup: p => fs.symlinkSync(root, p.destination) },
      { state: 'ok copy', name: crossReview, setup: p => fs.cpSync(p.source, p.destination, { recursive: true }) },
      { state: 'stale copy', name: crossReview, setup: p => { fs.cpSync(p.source, p.destination, { recursive: true }); fs.writeFileSync(path.join(p.destination, 'SKILL.md'), 'x\n'); } },
      { state: 'invalid path type', name: crossReview, setup: p => fs.writeFileSync(p.destination, 'f\n') },
      { state: 'missing', name: crossReview, setup: () => {} },
      // A staged Waza skill: a real directory that matches its staging source but has no recorded owner.
      { state: 'unowned real directory', name: 'think', setup: p => {
        fs.mkdirSync(p.source, { recursive: true });
        fs.writeFileSync(path.join(p.source, 'SKILL.md'), '# think\n');
        fs.cpSync(p.source, p.destination, { recursive: true });
      } },
      // The link is fine; the recorded ledger entry has the wrong type, so only the ledger line differs.
      { state: 'ok link', name: crossReview, ledger: true, setup: p => {
        fs.symlinkSync(p.source, p.destination);
        seedRecordedInstall({ HOME: home }, FULL_PLUGINS, 'all', [{ path: p.destination, owner: 'cross-review', committed: { type: 'directory', sha256: hashManagedTree(p.source) } }]);
      } },
      // Last: this case deletes the fixture source for the rest of the test.
      { state: 'source missing', name: crossReview, setup: p => { fs.cpSync(p.source, p.destination, { recursive: true }); fs.rmSync(p.source, { recursive: true }); } },
    ];
    for (const { state, name, ledger, setup } of cases) {
      for (const projection of allProjections) fs.rmSync(projection.destination, { recursive: true, force: true });
      fs.rmSync(ledgerPath, { force: true });
      fs.rmSync(hostConfigPaths({ HOME: home }).ledger, { force: true });
      setup(codexProjection(name));
      const driftedDestination = ledger ? codexProjection(name).destination : null;
      for (const target of ['both', 'codex', 'claude'] as const) {
        const result = checkSkillProjection(target, f.env);
        const rows = result.skills!;
        const projections = allProjections.filter(projection => target === 'both' || projection.host === target);
        // With a ledger, only its one owned destination is judged; the other absent destinations give na lines.
        const judged = ledger ? projections.filter(p => p.destination === driftedDestination) : projections;
        expect(rows.map(row => `${row.host}:${row.name}`)).toEqual(judged.map(p => `${p.host}:${p.name}`));
        expect(rows.find(row => row.host === 'codex' && row.name === name)?.state ?? state).toBe(state as never);
        rows.forEach((row, index) => {
          const drifted = judged[index]!.destination === driftedDestination;
          expect(row.ok).toBe(row.state.startsWith('ok ') && !drifted);
        });
        const skillLines = projections.map(projection => {
          const index = judged.indexOf(projection);
          return index < 0
            ? `${projection.destination}: na; not in the install ledger`
            : frozenLine(projection, rows[index]!.state, projection.destination === driftedDestination);
        });
        const detailLines = result.detail.split('\n');
        expect(detailLines.slice(0, projections.length)).toEqual(skillLines);
        expect(detailLines).toHaveLength(projections.length + 1);
        if (ledger) {
          expect(detailLines[projections.length]).toContain('"surface_drift":["' + driftedDestination + '"]');
        } else {
          expect(detailLines[projections.length]).toBe('install ledger: missing; run: rh install');
        }
        expect(result.status).toBe('warn');
        expect(JSON.stringify(rows)).not.toContain(home);
      }
    }
  }));

  test('a claude-only ledger judges the claude rows and gives na for the hosts it never touched', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    const packageRoot = path.join(home, '.bun/install/global/node_modules/repo-harness');
    const catalog = parseSkillSurfaceCatalog(fs.readFileSync(path.join(packageRoot, 'assets/skill-commands/manifest.json'), 'utf8'),
      { declared: true });
    if (catalog.status !== 'valid') throw new Error('fixture catalog invalid');
    // With `pi` recorded, the Pi host is a third host that the claude-only ledger never touched.
    const recorded: readonly PluginId[] = [...FULL_PLUGINS, 'pi' as PluginId].sort();
    const projections = expectedSkillProjections(catalog.catalog, packageRoot, home, recorded, f.env);
    const claude = projections.filter(projection => projection.host === 'claude');
    const untouched = projections.filter(projection => projection.host !== 'claude');
    for (const projection of claude) {
      if (!fs.existsSync(path.join(projection.source, 'SKILL.md'))) {
        fs.mkdirSync(projection.source, { recursive: true });
        fs.writeFileSync(path.join(projection.source, 'SKILL.md'), `# ${projection.name}\n`);
      }
      fs.mkdirSync(path.dirname(projection.destination), { recursive: true });
      fs.symlinkSync(projection.source, projection.destination);
    }
    // Path records that own only the claude links.
    seedRecordedInstall(f.env, recorded, 'all', claude.map(projection => ({ path: projection.destination,
      owner: ownerForInstallPath(projection.destination, f.env)!, committed: { type: 'symlink', target: projection.source } })));

    const result = checkSkillProjection('both', f.env);
    expect(result.skills!.map(row => `${row.host}:${row.name}:${row.state}:${row.ok}`))
      .toEqual(claude.map(projection => `claude:${projection.name}:ok link:true`));
    expect(new Set(untouched.map(projection => projection.host))).toEqual(new Set(['codex', 'pi']));
    for (const projection of untouched) expect(result.detail).toContain(`${projection.destination}: na; not in the install ledger`);
    expect(result.detail).toContain('"surface_drift":[]');

    const [deleted] = claude;
    fs.rmSync(deleted!.destination);
    const afterDelete = checkSkillProjection('both', f.env);
    expect(afterDelete.skills!.find(row => row.name === deleted!.name)).toMatchObject({ host: 'claude', state: 'missing', ok: false });
    expect(afterDelete.detail).toContain(`${deleted!.destination}: missing; expected ${deleted!.source}`);
    expect(afterDelete.status).toBe('warn');
  }));

  test('review regression: old global contract is an actionable warning', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    const packageRoot = path.join(home, '.bun/install/global/node_modules/repo-harness');
    const contractPath = path.join(packageRoot, 'assets/workflow-contract.v1.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    delete contract.installedCopyExcludes;
    fs.writeFileSync(contractPath, JSON.stringify(contract));
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'repo-harness', version: '0.19.5' }));
    const before = fs.readFileSync(contractPath, 'utf8');
    const result = checkSkillProjection('both', f.env);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('installedCopyExcludes');
    expect(result.detail).toContain('run: rh upgrade');
    expect(fs.readFileSync(contractPath, 'utf8')).toBe(before);
  }));

  test('an old global contract without the canonical include set gives an actionable warning', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    const contractPath = path.join(home, '.bun/install/global/node_modules/repo-harness/assets/workflow-contract.v1.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    delete contract.installedCopyIncludes;
    fs.writeFileSync(contractPath, JSON.stringify(contract));
    const before = fs.readFileSync(contractPath, 'utf8');
    const result = checkSkillProjection('both', f.env);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('installedCopyIncludes');
    expect(result.detail).toContain('run: rh update; then run: rh upgrade');
    expect(fs.readFileSync(contractPath, 'utf8')).toBe(before);
  }));

  test('reports invalid path type without replacing the file', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    fs.writeFileSync(f.destination, 'user file\n');
    const result = checkSkillProjection('codex', f.env);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(`${f.destination}: invalid path type`);
    expect(result.detail).toContain(`preserve or move ${f.destination}`);
    expect(fs.readFileSync(f.destination, 'utf8')).toBe('user file\n');
  }));

  test('reports source missing and preserves the installed copy', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    fs.cpSync(f.source, f.destination, { recursive: true });
    const before = hashManagedTree(f.destination);
    fs.rmSync(f.source, { recursive: true });
    const result = checkSkillProjection('codex', f.env);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(`${f.destination}: source missing`);
    expect(result.detail).toMatch(DEFAULT_FIX_LINE);
    expect(hashManagedTree(f.destination)).toBe(before);
  }));

  test('fails closed on a malformed projection contract', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    const contractPath = path.join(home, '.bun/install/global/node_modules/repo-harness/assets/workflow-contract.v1.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    contract.installedCopyExcludes = 42;
    fs.writeFileSync(contractPath, JSON.stringify(contract));
    const result = checkSkillProjection('codex', f.env);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('invalid installed copy exclusions');
    expect(result.detail).toContain('rh install --state');
  }));

  test('reports ledger type drift and installStateStatus drift without changing the ledger', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    fs.symlinkSync(f.source, f.destination);
    seedRecordedInstall(f.env, FULL_PLUGINS, 'all', [{ path: f.destination, owner: 'cross-review', committed: { type: 'directory', sha256: hashManagedTree(f.source) } }]);
    const ledger = hostConfigPaths(f.env).ledger;
    const before = fs.readFileSync(ledger, 'utf8');
    const result = checkSkillProjection('codex', f.env);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(`${f.destination}: ok link -> ${f.source}; ledger drift`);
    expect(result.detail).toContain('"surface_drift":["' + f.destination + '"]');
    expect(result.detail).toContain('rh install --state');
    expect(fs.readFileSync(ledger, 'utf8')).toBe(before);
    // Keep the on-disk type as symlink, but change its recorded target.
    const changed = JSON.parse(before);
    const [key] = Object.keys(changed.paths);
    changed.paths[key!] = { ...changed.paths[key!], committed: { type: 'symlink', target: path.join(home, 'previous-target') } };
    fs.writeFileSync(ledger, JSON.stringify(changed));
    expect(checkSkillProjection('codex', f.env).detail).toContain(`${f.destination}: ok link -> ${f.source}; ledger drift`);
  }));

  test('reports changed owned links and unknown Waza directories; accepts relative staging links', () => withTempHome('repo-harness-doctor', home => {
    const f = seed(home);
    const staging = path.join(home, '.agents/skills/think');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'SKILL.md'), '# think\n');
    const dest = path.join(home, '.codex/skills/think');
    fs.symlinkSync('../../.agents/skills/think', dest);
    expect(checkSkillProjection('codex', f.env).detail).toContain(`${dest}: ok link -> ${staging}`);
    fs.rmSync(dest);
    fs.cpSync(staging, dest, { recursive: true });
    const result = checkSkillProjection('codex', f.env);
    expect(result.detail).toContain(`${dest}: unowned real directory; expected ${staging}; preserve or move ${dest}`);
    expect(result.detail).toMatch(DEFAULT_FIX_LINE);
    expect(fs.lstatSync(dest).isDirectory()).toBe(true);
    fs.writeFileSync(path.join(dest, 'SKILL.md'), 'private instructions\n');
    expect(checkSkillProjection('codex', f.env).detail).toContain(`${dest}: stale copy`);
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('private instructions\n');
  }));

  test('runDoctor includes the check and filters projection hosts by target', () => withTempHome('repo-harness-doctor', home => {
    seed(home);
    withEnv({ BUN_INSTALL: path.join(home, '.bun') }, () => {
      const result = runDoctor(CLI_PORTS.doctor, root, 'codex').checks.find(check => check.id === 'skill-projection');
      expect(result?.detail).toContain(path.join(home, '.codex/skills/repo-harness-cross-review'));
      expect(result?.detail).not.toContain(path.join(home, '.claude/skills'));
    });
  }), DOCTOR_CHECK_TIMEOUT_MS);
});

test('each skill-projection repair command keeps the recorded selection and passes the install selection gate', () => {
  const rows: readonly { readonly selection: 'all' | readonly PluginId[]; readonly plugins: readonly PluginId[]; readonly pi?: true; readonly repair: string }[] = [
    // `all` on a host without pi runs peer-runtime, which has no Codex host: a `--target codex` repair would fail the gate.
    { selection: 'all', plugins: FULL_PLUGINS, repair: 'rh install' },
    { selection: ['cross-review', 'product'], plugins: ['cross-review', 'product'], repair: 'rh install --plugins cross-review,product' },
    { selection: [], plugins: [], repair: 'rh install --no-plugins' },
    { selection: ['pi', 'product'], plugins: ['pi', 'product'], pi: true, repair: 'rh install --plugins pi,product' },
  ];
  for (const row of rows) withTempHome('repo-harness-doctor', home => {
    const tools = path.join(home, 'tool-bin');
    fs.mkdirSync(tools, { recursive: true });
    if (row.pi) writeExecutable(home, path.join(tools, 'pi'), '#!/bin/sh\ncase "$1" in --version) echo 1.5.0 ;; list) echo "No packages installed." ;; esac\n');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BUN_INSTALL: path.join(home, '.bun'), XDG_STATE_HOME: path.join(home, '.local/state'),
      REPO_HARNESS_HOME: path.join(home, '.repo-harness'), PATH: `${tools}:/usr/bin:/bin` };
    for (const key of ['CODEX_SKILLS_ROOT', 'CLAUDE_SKILLS_ROOT', 'PI_CODING_AGENT_DIR', 'REPO_HARNESS_INSTALL_PLUGINS']) delete env[key];
    // One broken projection that the ledger owns: the Codex router link points at the wrong tree.
    const router = path.join(home, '.codex/skills/repo-harness');
    fs.mkdirSync(path.dirname(router), { recursive: true });
    fs.symlinkSync(home, router);
    seedRecordedInstall(env, row.plugins, row.selection, [{ path: router, owner: 'core', committed: { type: 'symlink', target: path.join(home, '.bun/install/global/node_modules/repo-harness') } }]);
    const label = JSON.stringify(row.selection);
    const result = checkSkillProjection('codex', env);
    const repairs = [...new Set([...result.detail.matchAll(/run: (rh install[^;\n]*)/g)].map(match => match[1]!.trim()))];
    expect(repairs, label).toEqual([row.repair]);
    // The repair runs the install action's selection resolution and its availability gate.
    const dryRun = spawnSync(process.execPath, [path.join(import.meta.dir, '..', '..', 'src/cli/index.ts'), ...row.repair.split(' ').slice(1), '--dry-run', '--json'], { cwd: home, env, encoding: 'utf-8' });
    expect(dryRun.status, `${label}: ${dryRun.stderr}`).toBe(0);
    expect(JSON.parse(dryRun.stdout).selection, label).toEqual(row.selection);
  });
}, 60_000);

test('pi-retired-extension warns with a runnable mv -n only for a loaded extension that uses the old hook argv protocol', () => withTempHome('repo-harness-doctor', home => {
  const agentDir = path.join(home, 'pi agent');
  const extensions = path.join(agentDir, 'extensions');
  fs.mkdirSync(extensions, { recursive: true });
  const bin = 'const HOOK_BIN = process.env.REPO_HARNESS_PI_BIN ?? "repo-harness-hook";';
  const call = 'const { stdout, stderr } = await execFileAsync(HOOK_BIN, [event, "--route", route], {});';
  const env = { HOME: home, PI_CODING_AGENT_DIR: agentDir };
  const now = new Date('2026-11-14T12:00:00Z');
  for (const comment of [`// ${bin}\n// ${call}\n`, `/**\n * ${bin}\n * ${call}\n */\n`, `/* ${bin} */\n/* ${call} */\n`]) {
    fs.writeFileSync(path.join(extensions, 'other.ts'), `${comment}export default () => {};\n`);
    expect(checkRetiredPiExtension(env, now).status, comment).toBe('ok');
  }
  const content = `${bin}\n${call}\n`;
  const source = path.join(home, 'legacy.ts');
  fs.writeFileSync(source, content);
  const legacy = path.join(extensions, 'repo-harness.ts');
  fs.symlinkSync(source, legacy);
  const check = checkRetiredPiExtension(env, now);
  expect(check.status).toBe('warn');
  const command = check.detail.match(/Run: (mv -n .*)$/)?.[1];
  const archive = path.join(agentDir, 'repo-harness.ts.legacy-20261114');
  expect(command).toBe(`mv -n '${legacy}' '${archive}'`);
  fs.writeFileSync(archive, 'earlier archive\n');
  execSync(command!, { shell: '/bin/sh' });
  expect(fs.readFileSync(archive, 'utf8')).toBe('earlier archive\n');
  expect(checkRetiredPiExtension(env, now).status).toBe('warn');
  fs.rmSync(archive);
  execSync(command!, { shell: '/bin/sh' });
  expect(fs.readFileSync(archive, 'utf8')).toBe(content);
  expect(checkRetiredPiExtension(env, now).status).toBe('ok');
}));

