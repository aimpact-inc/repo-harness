import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { spawnSync, type SpawnSyncReturns } from "child_process";
import { installStateFixturePath, pluginSelectionEnv, recordPluginSelection, seedGlobalPackageFixture } from "../helpers/install-ownership";
import { initGitRepo, writeShellExecutableFixture } from "../helpers/repo-fixture";
import { writeFakeHc } from "../helpers/fake-hc";
import { requestUserInputFragment } from "../../src/cli/installer/targets/codex";
import { openHostConfigGate } from "../../src/effects/host-config/gate";
import { hostConfigPaths, readLedger } from "../../src/effects/host-config/store";
import { hashManagedTree } from "../../src/effects/managed-tree";
import { acquireRuntimeTransactionLock, globalRuntimeScope } from "../../src/effects/locking/runtime-transaction-lock";
import { configureAntigravityCodegraphStep } from "../../src/cli/tools/codegraph";
import { buildManagedHooks } from "../../src/cli/installer/managed-entries";
import { jsonFragment } from "../../src/core/host-config/json-fragment";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src/cli/index.ts");

function writeExecutable(temporaryRoot: string, filePath: string, content: string) {
  writeShellExecutableFixture(temporaryRoot, filePath, content);
}

function setupFakeEnvironment(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const home = join(root, "home");
  const fakeBin = join(root, "fakebin");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  recordPluginSelection({ HOME: home });
  return { root, home, fakeBin };
}

function writeFakeCodeGraph(fakeBin: string, logFile: string) {
  writeExecutable(fakeBin,
    join(fakeBin, "codegraph"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      `echo "codegraph $*" >> "${logFile}"`,
      "case \"${1:-}\" in",
      "  \"--version\") echo '0.9.6' ;;",
      "  \"status\") echo 'CodeGraph Status'; echo 'Index is up to date' ;;",
      "  \"init\"|\"sync\"|\"install\") echo 'unexpected mutation' >&2; exit 2 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n")
  );
}

// check-agent-tooling.sh resolves `skills` from PATH (and only spawns it under
// --probe-skills-cli), so the stub has to be the binary itself, not bunx.
function writeFakeSkillsCli(fakeBin: string) {
  writeExecutable(fakeBin,
    join(fakeBin, "skills"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      "if [[ \"$*\" == \"ls -g --json\" ]]; then echo '[]'; exit 0; fi",
      "exit 1",
      "",
    ].join("\n")
  );
}

describe("arch codegraph ensure", () => {
  test("--check is read-only and exposes the shared readiness report", () => {
    const envRoot = setupFakeEnvironment("repo-harness-tools-codegraph");
    const logFile = join(envRoot.root, "tool.log");
    try {
      mkdirSync(join(envRoot.home, ".codex"), { recursive: true });
      writeFileSync(join(envRoot.home, ".codex", "config.toml"), "[mcp_servers.codegraph]\ncommand = \"codegraph\"\n");
      writeFakeCodeGraph(envRoot.fakeBin, logFile);
      writeFakeSkillsCli(envRoot.fakeBin);

      const res = spawnSync("bun", [CLI, "arch", "codegraph", "ensure", "--check", "--json", "--repo", ROOT], {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: envRoot.home,
          PATH: `${envRoot.fakeBin}:${process.env.PATH ?? ""}`,
          REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: "0",
        },
      });

      expect(res.status).toBe(0);
      const result = JSON.parse(res.stdout);
      expect(result.read_only).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.codegraph.name).toBe("codegraph");
      expect(result.codegraph.source).toBe("global");
      expect(result.actions).toEqual([]);

      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("codegraph --version");
      expect(log).toContain("codegraph status .");
      expect(log).not.toContain("codegraph init");
      expect(log).not.toContain("codegraph sync");
      expect(log).not.toContain("codegraph install");
    } finally {
      rmSync(envRoot.root, { recursive: true, force: true });
    }
  }, 15000);

  test("human output names CodeGraph status", () => {
    const res = spawnSync("bun", [CLI, "arch", "codegraph", "ensure", "--check"], {
      cwd: ROOT,
      env: pluginSelectionEnv(),
      encoding: "utf-8",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("CodeGraph:");
    expect(res.stdout).toContain("Source:");
  }, 15000);
});

test('standalone CodeGraph configure writes the Codex table through the gate, and uninstall reverts it', () => {
  const fixture = setupFakeEnvironment('standalone-codegraph-uninstall');
  try {
    writeFakeSkillsCli(fixture.fakeBin);
    const codegraph = join(fixture.fakeBin, 'codegraph');
    writeExecutable(fixture.root, codegraph, [
      '#!/bin/bash',
      'set -euo pipefail',
      'case "${1:-}" in',
      '  --version) echo "0.9.6" ;;',
      '  status) echo "CodeGraph Status"; echo "Index is up to date" ;;',
      // codegraph 1.6.2 prints this snippet for `install --print-config codex` and writes nothing.
      '  install) [[ "$*" == "install --print-config codex" ]] || exit 2; printf \'%s\\n\' "# Add to $HOME/.codex/config.toml" "" \'[mcp_servers.codegraph]\' \'command = "codegraph"\' \'args = ["serve", "--mcp"]\' ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'));
    mkdirSync(join(fixture.home, '.codex'));
    writeFileSync(join(fixture.home, '.codex/config.toml'), 'model = "user-model"\n');
    // The `core` fragment is in place before the `architecture` owner writes its table (A7).
    openHostConfigGate({ env: { HOME: fixture.home } }).apply([{ path: join(fixture.home, '.codex/config.toml'), fragments: [requestUserInputFragment('model = "user-model"\n')!] }]);
    const env = { ...process.env, HOME: fixture.home, PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`, REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
    const configured = spawnSync('bun', [CLI, 'arch', 'codegraph', 'configure', '--target', 'codex', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, encoding: 'utf8' });
    expect(configured.status, configured.stderr).toBe(0);
    expect(JSON.parse(configured.stdout).actions.map((entry: any) => [entry.action, entry.status])).toEqual([['configure-codex', 'changed']]);
    const section = '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["serve", "--mcp", "--path", "."]\n';
    expect(readFileSync(join(fixture.home, '.codex/config.toml'), 'utf8')).toBe(`default_mode_request_user_input = true\nmodel = "user-model"\n${section}`);
    const ledger = readFileSync(join(fixture.home, '.repo-harness/config/ledger.json'), 'utf8');
    expect(JSON.parse(ledger).fragments.map((entry: any) => [entry.owner, entry.selector, entry.inserted]))
      .toEqual([['core', 'default_mode_request_user_input', 'default_mode_request_user_input = true\n'], ['architecture', 'mcp_servers.codegraph', section]]);
    expect(JSON.parse(ledger).files[realpathSync(join(fixture.home, '.codex/config.toml'))].external_change).toBe(false);
    expect(ledger).not.toContain('user-model');
    const uninstalled = spawnSync('bun', [CLI, 'uninstall', '--target', 'codex', '--json'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(uninstalled.status, uninstalled.stdout + uninstalled.stderr).toBe(0);
    expect(readFileSync(join(fixture.home, '.codex/config.toml'), 'utf8')).toBe('model = "user-model"\n');
    // A config.toml that does not parse is named with the remedy; its text never reaches the output, and its bytes stay (I1).
    const broken = 'k = sk-FAKE-SECRET-12345\n';
    writeFileSync(join(fixture.home, '.codex/config.toml'), broken);
    const refused = spawnSync('bun', [CLI, 'arch', 'codegraph', 'configure', '--target', 'codex', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, encoding: 'utf8' });
    expect(JSON.parse(refused.stdout).actions).toMatchObject([{ action: 'configure-codex', status: 'failed',
      stderr: `${join(fixture.home, '.codex/config.toml')}: the file is not valid TOML. Fix the TOML in that file, then run the command again` }]);
    expect(`${refused.stdout}${refused.stderr}`).not.toContain('sk-FAKE');
    expect(readFileSync(join(fixture.home, '.codex/config.toml'), 'utf8')).toBe(broken);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}, 15000);

/** A fake codegraph whose `install --print-config claude` prints a server object with this command and writes nothing. */
function writeClaudePrintingCodegraph(fakeBin: string, command: string) {
  writeExecutable(fakeBin, join(fakeBin, 'codegraph'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'case "${1:-}" in',
    '  --version) echo "0.9.6" ;;',
    '  status) echo "CodeGraph Status"; echo "Index is up to date" ;;',
    // codegraph 1.6.2 prints this object for `install --print-config claude` and writes nothing.
    `  install) [[ "$*" == "install --print-config claude" ]] || exit 2; printf '%s\\n' "# Add to $HOME/.claude.json" "" '${JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command, args: ['serve', '--mcp'], alwaysLoad: true } } })}' ;;`,
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'));
}

test('standalone CodeGraph configure for Claude writes its server and tool rule through the gate, refreshes its own server, keeps no copy of ~/.claude.json, and uninstall reverts both', () => {
  const fixture = setupFakeEnvironment('standalone-codegraph-claude');
  const fakeCodegraph = (command: string) => writeClaudePrintingCodegraph(fixture.fakeBin, command);
  try {
    writeFakeSkillsCli(fixture.fakeBin);
    fakeCodegraph('codegraph');
    const rootConfig = join(fixture.home, '.claude.json');
    const settings = join(fixture.home, '.claude/settings.json');
    const rootBefore = '{\n    "primaryApiKey": "sk-test-not-a-key",\n    "numStartups": 3\n}\n';
    mkdirSync(join(fixture.home, '.claude'));
    writeFileSync(rootConfig, rootBefore);
    // An earlier rh version wrote the tool rule into top-level allowedTools and recorded it in its receipt.
    // The migration cannot prove that rh created the allowedTools array, so it stays, empty.
    const settingsAfter = '{"permissions":{"allow":["Bash(ls)"]},"allowedTools":[]}';
    writeFileSync(settings, '{"permissions":{"allow":["Bash(ls)"]},"allowedTools":["mcp__codegraph__*"]}');
    mkdirSync(join(fixture.home, '.repo-harness'), { recursive: true });
    writeFileSync(join(fixture.home, '.repo-harness/configuration-restore.json'), JSON.stringify({ protocol: 1, changes: [
      { path: settings, selector: 'allowedTools.codegraph', before: null, installed: JSON.stringify('mcp__codegraph__*'), active: true },
    ] }));
    const env = { ...process.env, HOME: fixture.home, PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`, REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
    const configured = spawnSync('bun', [CLI, 'arch', 'codegraph', 'configure', '--target', 'claude', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, encoding: 'utf8' });
    expect(configured.status, configured.stderr).toBe(0);
    expect(JSON.parse(configured.stdout).actions.map((entry: any) => [entry.action, entry.status])).toEqual([['configure-claude', 'changed'], ['claude-tool-permission', 'changed']]);
    expect(JSON.parse(readFileSync(rootConfig, 'utf8')).mcpServers.codegraph).toEqual({ type: 'stdio', command: 'codegraph', args: ['serve', '--mcp', '--path', '.'], alwaysLoad: true });
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ permissions: { allow: ['Bash(ls)', 'mcp__codegraph__*'] }, allowedTools: [] });
    // C3 (owner): rh's add to ~/.claude.json keeps no whole-file copy, so the login key is in no rh file.
    const ledger = JSON.parse(readFileSync(join(fixture.home, '.repo-harness/config/ledger.json'), 'utf8'));
    expect(ledger.files[realpathSync(rootConfig)]).toMatchObject({ kind: 'text_block', backup: null });
    for (const name of readdirSync(join(fixture.home, '.repo-harness/config/vault'))) {
      expect(readFileSync(join(fixture.home, '.repo-harness/config/vault', name), 'utf8')).not.toContain('sk-test-not-a-key');
    }
    expect(existsSync(join(fixture.home, '.repo-harness/configuration-restore.json'))).toBe(false);
    // A later codegraph prints another server object: rh refreshes the server that it recorded, and its record follows.
    fakeCodegraph('/opt/codegraph/bin/codegraph');
    const refreshed = spawnSync('bun', [CLI, 'arch', 'codegraph', 'configure', '--target', 'claude', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, encoding: 'utf8' });
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(JSON.parse(refreshed.stdout).actions.map((entry: any) => [entry.action, entry.status])).toEqual([['configure-claude', 'changed'], ['claude-tool-permission', 'unchanged']]);
    const rootAfter = readFileSync(rootConfig, 'utf8');
    expect(JSON.parse(rootAfter).mcpServers.codegraph).toEqual({ type: 'stdio', command: '/opt/codegraph/bin/codegraph', args: ['serve', '--mcp', '--path', '.'], alwaysLoad: true });
    const range = jsonFragment.locate(rootAfter, 'mcpServers.codegraph')!;
    const recorded = JSON.parse(readFileSync(join(fixture.home, '.repo-harness/config/ledger.json'), 'utf8')).fragments.find((entry: any) => entry.file === realpathSync(rootConfig));
    expect(recorded).toMatchObject({ selector: 'mcpServers.codegraph', kind: 'add', inserted: rootAfter.slice(range.start, range.end) });
    const uninstalled = spawnSync('bun', [CLI, 'uninstall', '--target', 'claude', '--json'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(uninstalled.status, uninstalled.stdout + uninstalled.stderr).toBe(0);
    expect(readFileSync(rootConfig, 'utf8')).toBe(rootBefore);
    expect(readFileSync(settings, 'utf8')).toBe(settingsAfter);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}, 15000);

test.skipIf(process.platform === 'win32')('Antigravity CodeGraph configure checks opt-in, scopes the server, and refuses a linked config', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('antigravity-codegraph');
  try {
    const codegraph = join(fakeBin, 'codegraph');
    const config = join(home, '.gemini', 'config', 'mcp_config.json');
    const log = join(root, 'print-config.log');
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0', REPO_HARNESS_CODEGRAPH_GLOBAL_BIN: codegraph, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
    seedGlobalPackageFixture(env);
    writeFakeHc(fakeBin);
    writeFakeSkillsCli(fakeBin);
    const printServer = (command: string) => writeExecutable(fakeBin, codegraph, [
      '#!/bin/bash',
      'set -euo pipefail',
      'case "$*" in',
      '  --version) echo "1.6.4" ;;',
      '  "status .") echo "Index is up to date" ;;',
      `  "install --print-config antigravity") echo "$*" >> "${log}"; printf '%s\\n' "# Add to $HOME/.gemini/config/mcp_config.json" "" '${JSON.stringify({ mcpServers: { codegraph: { command, args: ['serve', '--mcp'] } } })}' ;;`,
      '  *) exit 2 ;;',
      'esac',
    ].join('\n'));
    printServer('/opt/codegraph-first');
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args, '--json'], { cwd: root, env, encoding: 'utf8' });
    const doctor = (status: 'ok' | 'warn' | 'fail' | 'na', detail?: string) => {
      const result = cli('doctor');
      const check = JSON.parse(result.stdout).checks.find((entry: { id: string }) => entry.id === 'antigravity-codegraph-mcp');
      expect(check).toMatchObject({ status });
      if (detail) expect(check.detail).toContain(detail);
      return check.detail as string;
    };
    const target = ['--target', 'antigravity'];
    const user = { personal: { command: 'my-tool' } };
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    const outside = join(root, 'standalone.json');
    const original = JSON.stringify({ mcpServers: user });
    writeFileSync(outside, original);
    symlinkSync(outside, config);
    expect(configureAntigravityCodegraphStep(root, env)).toBeUndefined();
    expect(existsSync(log)).toBe(false);
    doctor('na');
    expect(readFileSync(outside, 'utf8')).toBe(original);

    rmSync(config);
    writeFileSync(config, original);
    const adapters = cli('install', ...target, '--no-external-skills');
    expect(adapters.status, adapters.stdout + adapters.stderr).toBe(0);
    doctor('warn', 'Run rh update --configure-codegraph');
    const customCodegraph = JSON.stringify({ mcpServers: { ...user, codegraph: { command: 'my-codegraph', args: ['serve', '--mcp'] } } });
    writeFileSync(config, customCodegraph);
    const userRemedy = doctor('warn', `Edit mcpServers.codegraph in ${config}`);
    expect(userRemedy).not.toContain('rh update');
    expect(configureAntigravityCodegraphStep(root, env)).toMatchObject({ status: 'skipped', detail: expect.stringContaining('mcpServers.codegraph') });
    expect(readFileSync(config, 'utf8')).toBe(customCodegraph);
    expect(openHostConfigGate({ env }).recorded(config)).toEqual([]);
    writeFileSync(config, original);

    expect(configureAntigravityCodegraphStep(root, env)).toMatchObject({ status: 'ok', detail: 'changed' });
    const args = ['serve', '--mcp', '--path', '.'];
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ mcpServers: { ...user, codegraph: { command: '/opt/codegraph-first', args } } });

    printServer('/opt/codegraph-update');
    expect(configureAntigravityCodegraphStep(root, env)).toMatchObject({ status: 'ok', detail: 'changed' });
    expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ mcpServers: { ...user, codegraph: { command: '/opt/codegraph-update', args } } });
    doctor('ok');
    rmSync(config);
    symlinkSync(outside, config);
    doctor('fail');
    expect(readFileSync(outside, 'utf8')).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30000);

test.skipIf(process.platform === 'win32')('global update refuses malformed Antigravity MCP before package or adapter writes', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('refused-antigravity-update');
  try {
    const bunBin = join(fakeBin, 'bun');
    const called = join(root, 'bun-called');
    writeExecutable(fakeBin, bunBin, `#!/bin/sh\nprintf called > '${called}'\nexit 98\n`);
    const bunInstall = join(home, '.bun');
    const cliPath = join(bunInstall, 'bin', 'rh');
    const hookPath = join(home, '.codex', 'hooks.json');
    const managedConfig = join(home, '.repo-harness/config.json');
    const config = join(home, '.gemini/config/mcp_config.json');
    const env = { HOME: home, TMPDIR: root, BUN_INSTALL: bunInstall, REPO_HARNESS_BUN_EXECUTABLE: bunBin, PATH: `${fakeBin}:/bin:/usr/bin` };
    mkdirSync(join(bunInstall, 'bin'), { recursive: true });
    mkdirSync(join(home, '.codex'));
    writeFileSync(cliPath, 'prior CLI');
    writeFileSync(hookPath, '{"hooks":{}}\n');
    writeFileSync(managedConfig, '{"custom":true}\n');
    openHostConfigGate({ env }).apply([{ path: config, fragments: [{ owner: 'architecture', selector: 'mcpServers.codegraph', kind: 'add', strategy: jsonFragment, value: { command: 'codegraph' } }] }]);
    const malformed = '{"mcpServers":';
    writeFileSync(config, malformed);
    const paths = [cliPath, hookPath, managedConfig, config];
    const state = () => paths.map((path) => ({ bytes: readFileSync(path), ino: statSync(path).ino }));
    const before = state();
    const result = spawnSync(process.execPath, [CLI, 'update', '--configure-codegraph', '--json'], { cwd: root, env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the file is not valid JSON');
    expect(existsSync(called)).toBe(false);
    expect(state()).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe.skipIf(process.platform === 'win32')('targeted Antigravity CodeGraph', () => {
  function withTargetedFixture(command: 'install' | 'update', run: (fixture: {
    env: NodeJS.ProcessEnv; root: string; repo: string; fakeBin: string; config: string; statePath: string; cliPath: string;
    cli: (...args: string[]) => SpawnSyncReturns<string>;
    launch: (bunArgs: readonly string[], args: readonly string[]) => SpawnSyncReturns<string>;
  }) => void) {
    const { root, home, fakeBin } = setupFakeEnvironment('targeted-antigravity');
    try {
      const codegraph = join(fakeBin, 'codegraph');
      const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0', REPO_HARNESS_CODEGRAPH_GLOBAL_BIN: codegraph, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
      seedGlobalPackageFixture(env);
      writeFakeHc(fakeBin);
      writeFakeSkillsCli(fakeBin);
      writeExecutable(fakeBin, codegraph, `#!/bin/sh
case "$*" in
  --version) echo 1.6.4 ;;
  'status .') echo 'Index is up to date' ;;
  'install --print-config antigravity') printf '%s\\n' '{"mcpServers":{"codegraph":{"command":"codegraph"}}}' ;;
  *) exit 2 ;;
esac
`);
      const config = join(home, '.gemini/config/mcp_config.json');
      const cliPath = join(env.BUN_INSTALL, 'bin/rh');
      const managedConfig = join(home, '.repo-harness/config.json');
      for (const [path, value] of [[config, '{"mcpServers":{"personal":{"command":"my-tool"}}}'], [cliPath, 'prior CLI'], [managedConfig, '{}\n']] as const) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, value);
      }
      const repo = join(root, 'repo');
      const cwd = join(repo, 'nested');
      mkdirSync(cwd, { recursive: true });
      initGitRepo(repo);
      const launch = (bunArgs: readonly string[], args: readonly string[]) => spawnSync(process.execPath, [...bunArgs, CLI, ...args, '--target', 'antigravity', '--json'], { cwd, env, encoding: 'utf8' });
      const cli = (...args: string[]) => launch([], args);
      if (command === 'update') {
        const installed = cli('install', '--no-external-skills');
        expect(installed.status, installed.stdout + installed.stderr).toBe(0);
      }
      run({ env, root, repo, fakeBin, config, statePath: installStateFixturePath(env), cliPath, cli, launch });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  for (const command of ['install', 'update'] as const) {
    const options = command === 'install' ? ['--no-external-skills'] : [];

    test(`${command} previews and applies a scoped MCP change after protocol 4 migration`, () => withTargetedFixture(command, ({ env, root, config, statePath, cli }) => {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      writeFileSync(statePath, JSON.stringify({ ...state, protocol: 4, pi_packages: [] }));
      const before = hashManagedTree(root);
      const args = [command, '--configure-codegraph', ...options];
      const dryRun = cli(...args, '--dry-run');
      expect(dryRun.status, dryRun.stdout + dryRun.stderr).toBe(0);
      expect(JSON.parse(dryRun.stdout).host_config.items).toEqual(expect.arrayContaining([
        { path: realpathSync(config), selector: 'mcpServers.codegraph', action: 'add' },
        { path: hostConfigPaths(env).ledger, selector: `${realpathSync(config)}#mcpServers.codegraph`, action: 'record' },
      ]));
      expect(hashManagedTree(root)).toBe(before);

      const result = cli(...args);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).protocol).toBe(5);
      expect(JSON.parse(readFileSync(config, 'utf8')).mcpServers).toEqual({
        personal: { command: 'my-tool' }, codegraph: { command: 'codegraph', args: ['serve', '--mcp', '--path', '.'] },
      });
      expect(openHostConfigGate({ env }).recorded(config)).toMatchObject([{ owner: 'architecture', selector: 'mcpServers.codegraph' }]);
    }), 30000);

    test(`${command} uses the installed renderer over checkout candidates in preview and apply`, () => withTargetedFixture(command, ({ env, root, repo, fakeBin, config, cli }) => {
      const checkoutBin = join(repo, 'bin');
      const pathAlias = join(root, 'path-alias');
      const refused = join(root, 'checkout-renderer-ran');
      mkdirSync(checkoutBin);
      mkdirSync(pathAlias);
      const local = join(checkoutBin, 'codegraph');
      writeExecutable(checkoutBin, local, `#!/bin/sh\nprintf '%s' "$*" > '${refused}'\nexit 2\n`);
      symlinkSync(local, join(pathAlias, 'codegraph'));
      const args = [command, '--configure-codegraph', ...options];
      const installedPath = env.PATH;
      env.REPO_HARNESS_CODEGRAPH_LOCAL_BIN = local;
      env.REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL = '1';
      const assertRefused = () => {
        for (const mode of [['--dry-run'], []]) {
          const rejected = cli(...args, ...mode);
          expect(rejected.status).toBe(1);
          expect(rejected.stderr).toContain('CodeGraph CLI is missing');
          expect(existsSync(refused)).toBe(false);
        }
      };
      env.REPO_HARNESS_CODEGRAPH_GLOBAL_BIN = join(pathAlias, 'codegraph');
      assertRefused();
      delete env.REPO_HARNESS_CODEGRAPH_GLOBAL_BIN;
      const checkoutPath = `../bin:${checkoutBin}:${pathAlias}`;
      env.PATH = checkoutPath;
      assertRefused();

      env.PATH = `${checkoutPath}:${fakeBin}:${installedPath}`;
      const installed = join(fakeBin, 'codegraph');
      writeExecutable(fakeBin, installed, `#!/bin/sh
[ "$*" = 'install --print-config antigravity' ] || exit 2
printf 'cache' > "$HOME/renderer-cache"
printf '{"mcpServers":{"codegraph":{"command":"%s"}}}\\n' "$(command -v codegraph)"
`);
      const before = hashManagedTree(root);
      const dryRun = cli(...args, '--dry-run');
      expect(dryRun.status, dryRun.stdout + dryRun.stderr).toBe(0);
      expect(JSON.parse(dryRun.stdout).host_config.items).toContainEqual({ path: realpathSync(config), selector: 'mcpServers.codegraph', action: 'add' });
      expect(hashManagedTree(root)).toBe(before);
      const applied = cli(...args);
      expect(applied.status, applied.stdout + applied.stderr).toBe(0);
      expect(JSON.parse(readFileSync(config, 'utf8')).mcpServers.codegraph.command).toBe(realpathSync(installed));
      expect(existsSync(join(env.HOME!, 'renderer-cache'))).toBe(false);
      expect(existsSync(refused)).toBe(false);
    }), 30000);

    test.each(['formatted', 'absent', 'replaced'] as const)(`${command} handles adapter failure with %s MCP preimage`, (input) => withTargetedFixture(command, ({ env, root, config, launch }) => {
      const original = '{\r\n\t"mcpServers" : {  \r\n  }\r\n}\r\n';
      if (input === 'formatted') writeFileSync(config, original);
      else rmSync(config);
      const ledger = hostConfigPaths(env).ledger;
      const ledgerBytes = () => existsSync(ledger) ? readFileSync(ledger) : null;
      const before = ledgerBytes();
      const preload = join(root, 'fail-adapter.ts');
      const replacement = join(root, 'replacement.json');
      writeFileSync(preload, `
import { copyFileSync, readFileSync, renameSync } from 'node:fs';
import { antigravityTarget } from ${JSON.stringify(join(ROOT, 'src/cli/installer/targets/antigravity.ts'))};
antigravityTarget.install = () => {
  const config = ${JSON.stringify(config)};
  if (JSON.parse(readFileSync(config, 'utf8')).mcpServers.codegraph.command !== 'codegraph') throw new Error('MCP write missing');
  ${input === 'replaced' ? `const copy = ${JSON.stringify(replacement)}; copyFileSync(config, copy); renameSync(copy, config);` : ''}
  throw new Error('injected adapter failure after MCP write');
};
`);
      const result = launch(['--preload', preload], [command, '--configure-codegraph', ...options]);
      expect(result.status).toBe(1);
      if (input === 'replaced') {
        expect(result.stderr).toContain('rollback failed');
        expect(JSON.parse(readFileSync(config, 'utf8')).mcpServers.codegraph.command).toBe('codegraph');
      } else {
        expect(result.stdout).toContain('injected adapter failure after MCP write');
        expect(existsSync(config) ? readFileSync(config, 'utf8') : null).toBe(input === 'formatted' ? original : null);
      }
      expect(ledgerBytes()).toEqual(before);
    }), 30000);

    test.each(['core-only', 'malformed', 'linked'] as const)(`${command} refuses %s before adapter writes`, (input) => withTargetedFixture(command, ({ env, config, statePath, cliPath, cli }) => {
      if (input === 'core-only') recordPluginSelection(env, []);
      if (input === 'malformed') {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        writeFileSync(statePath, JSON.stringify({ ...state, protocol: 4, pi_packages: [] }));
        writeFileSync(config, '{"mcpServers":');
      }
      const outside = join(env.HOME!, 'other.json');
      if (input === 'linked') {
        writeFileSync(outside, readFileSync(config));
        rmSync(config);
        symlinkSync(outside, config);
      }
      const paths = [cliPath, config, outside, statePath, hostConfigPaths(env).ledger, join(env.HOME!, '.repo-harness/config.json'),
        join(dirname(config), 'hooks.json'), join(dirname(config), 'AGENTS.md')];
      const snapshot = () => paths.map(path => existsSync(path) ? { bytes: readFileSync(path), ino: statSync(path).ino } : null);
      const before = snapshot();
      const result = cli(command, '--configure-codegraph', ...options);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain({ 'core-only': 'rh install --plugins architecture', malformed: 'the file is not valid JSON', linked: 'antigravity_hooks_path_linked' }[input]);
      expect(snapshot()).toEqual(before);
    }), 30000);
  }
});

test.skipIf(process.platform === 'win32')('architecture switch removes only a recorded Antigravity MCP fragment and restores it on failure', () => {
  const { root, home, fakeBin } = setupFakeEnvironment('antigravity-architecture-switch');
  try {
    const bunBin = join(fakeBin, 'bun');
    const env = { ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), REPO_HARNESS_BUN_EXECUTABLE: bunBin,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}` };
    const installedPackage = seedGlobalPackageFixture(env);
    const bin = join(env.BUN_INSTALL, 'bin');
    mkdirSync(bin, { recursive: true });
    symlinkSync(join(installedPackage, 'src/cli/index.ts'), join(bin, 'rh'));
    writeFakeHc(fakeBin);
    const config = join(home, '.gemini/config/mcp_config.json');
    const paths = hostConfigPaths(env);
    const statePath = installStateFixturePath(env);
    const state = readFileSync(statePath);
    const original = '{"mcpServers":{"personal":{"command":"my-tool"}}}';
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, original);
    const gate = openHostConfigGate({ env });
    const change = { path: config, fragments: [{ owner: 'architecture', selector: 'mcpServers.codegraph', kind: 'add' as const, strategy: jsonFragment, value: { command: 'codegraph' } }] };
    gate.apply([change]);
    const recorded = readLedger(paths);
    const configured = readFileSync(config, 'utf8');
    const key = realpathSync(config);
    const failAfterRemoval = (after = '') => writeExecutable(fakeBin, bunBin, `#!/bin/bash
[ "$1" = --version ] || exit 2
[ "$(< '${config}')" = '${original}' ] || exit 3
${after}
printf 'observed scoped removal\\n' >&2
exit 4
`);
    const cli = (...args: string[]) => spawnSync(process.execPath, [CLI, 'install', '--no-plugins', '--no-cli', '--no-external-skills', '--json', ...args], { cwd: root, env, encoding: 'utf8' });
    failAfterRemoval();
    const failed = cli();
    expect(failed.status).toBe(1);
    expect(failed.stdout + failed.stderr).toContain('observed scoped removal');
    expect(readFileSync(statePath)).toEqual(state);
    expect(readFileSync(config, 'utf8')).toBe(configured);
    expect(readLedger(paths).files[key]).toEqual(recorded.files[key]);
    expect(gate.recorded(config)).toEqual(recorded.fragments.filter(fragment => fragment.file === key));

    failAfterRemoval(`cp '${config}' '${config}.copy' && mv '${config}.copy' '${config}' || exit 5`);
    const replaced = cli();
    expect(replaced.status).toBe(1);
    expect(replaced.stderr).toContain('cannot prove this host configuration entry');
    expect(readFileSync(statePath)).toEqual(state);
    expect(readFileSync(config, 'utf8')).toBe(original);
    expect(readLedger(paths).files[key]).toBeUndefined();
    gate.apply([change]);

    writeExecutable(fakeBin, bunBin, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    const switched = cli();
    expect(switched.status, switched.stdout + switched.stderr).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe(original);
    expect(readLedger(paths).files[key]).toBeUndefined();
    expect(gate.recorded(config)).toEqual([]);

    recordPluginSelection(env);
    rmSync(join(home, '.gemini'), { recursive: true });
    const outside = join(root, 'other');
    mkdirSync(join(outside, 'config'), { recursive: true });
    writeFileSync(join(outside, 'config/mcp_config.json'), configured);
    symlinkSync(outside, join(home, '.gemini'));
    const unrecorded = cli('--no-hooks');
    expect(unrecorded.status, unrecorded.stdout + unrecorded.stderr).toBe(0);
    expect(readFileSync(join(outside, 'config/mcp_config.json'), 'utf8')).toBe(configured);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);

test('a concurrent rh install and CodeGraph configure for Claude serialize on the global lock, and the ledger keeps the records of both', async () => {
  const fixture = setupFakeEnvironment('concurrent-claude-writers');
  try {
    writeFakeSkillsCli(fixture.fakeBin);
    writeClaudePrintingCodegraph(fixture.fakeBin, 'codegraph');
    const rootConfig = join(fixture.home, '.claude.json');
    const settings = join(fixture.home, '.claude/settings.json');
    mkdirSync(join(fixture.home, '.claude'));
    writeFileSync(rootConfig, '{"numStartups":1}\n');
    writeFileSync(settings, '{"theme":"user"}\n');
    const env = { ...process.env, HOME: fixture.home, BUN_INSTALL: join(fixture.home, '.bun'), PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`, REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: '0', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
    seedGlobalPackageFixture(env);
    // Both writers start while the test holds the lock, so each one waits for it.
    const lock = acquireRuntimeTransactionLock(globalRuntimeScope(env));
    let writers: ReturnType<typeof Bun.spawn>[];
    try {
      writers = [
        Bun.spawn(['bun', CLI, 'install', '--target', 'claude', '--location', 'global'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' }),
        Bun.spawn(['bun', CLI, 'arch', 'codegraph', 'configure', '--target', 'claude', '--location', 'global', '--json', '--repo', ROOT], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' }),
      ];
    } finally { lock.release(); }
    expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual([0, 0]);
    const gate = openHostConfigGate({ env });
    const selectors = gate.recorded(settings).map((entry) => entry.selector);
    expect(selectors).toContain('permissions.allow[mcp__codegraph__*]');
    expect(selectors).toContain('statusLine');
    expect(selectors.filter((selector) => selector.startsWith('hooks.')).length).toBe(Object.values(buildManagedHooks('claude', env)).flat().length);
    expect(gate.recorded(rootConfig).map((entry) => entry.selector)).toEqual(['mcpServers.codegraph']);
    const uninstalled = spawnSync('bun', [CLI, 'uninstall', '--target', 'claude', '--json'], { cwd: ROOT, env, encoding: 'utf8' });
    expect(uninstalled.status, uninstalled.stdout + uninstalled.stderr).toBe(0);
    expect([readFileSync(rootConfig, 'utf8'), readFileSync(settings, 'utf8')]).toEqual(['{"numStartups":1}\n', '{"theme":"user"}\n']);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}, 30000);
