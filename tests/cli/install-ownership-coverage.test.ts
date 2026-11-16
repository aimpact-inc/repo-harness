import { expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configureRequiredHerdrSkill } from '../../src/cli/commands/herdr-skill';
import { readInstallState } from '../../src/cli/installer/install-profile';
import { seedGlobalPackageFixture } from '../helpers/install-ownership';
import { writeFakeHc } from '../helpers/fake-hc';
import { writeBunWrapper } from '../helpers/repo-fixture';

const CLI = join(import.meta.dir, '../../src/cli/index.ts');

/** A scratch HOME with its own Git config home, Bun root, `rh` link and fake `hc`; `rh` runs core only on both hosts, offline. */
function withInstallHome(run: (home: string, rh: (...args: string[]) => ReturnType<typeof spawnSync>, env: NodeJS.ProcessEnv) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'repo-harness-ownership-coverage-'));
  const bin = join(home, 'tool-bin');
  mkdirSync(bin);
  writeBunWrapper(join(bin, 'bun'));
  writeFakeHc(bin);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'),
    REPO_HARNESS_HOME: join(home, '.repo-harness'), PATH: `${bin}:/usr/bin:/bin`, REPO_HARNESS_BUN_EXECUTABLE: join(bin, 'bun'),
    // Bun's transpiler cache would write under HOME (Library/Caches on darwin, $BUN_INSTALL/install/cache on Linux).
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  };
  for (const key of ['GIT_CONFIG_GLOBAL', 'CODEX_SKILLS_ROOT', 'CLAUDE_SKILLS_ROOT', 'PI_CODING_AGENT_DIR', 'REPO_HARNESS_INSTALL_PLUGINS', 'REPO_HARNESS_INCLUDE_PI']) delete env[key];
  seedGlobalPackageFixture(env, { mutable: true });
  mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
  writeFileSync(join(home, '.bun', 'bin', 'rh'), '#!/bin/sh\n', { mode: 0o755 });
  const rh = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf-8' });
  try { run(home, rh, env); } finally { rmSync(home, { recursive: true, force: true }); }
}

const INSTALL = ['install', '--no-plugins', '--target', 'both', '--no-cli', '--no-codegraph', '--no-external-skills', '--json'];

test('install owns the Herdr skill copies under core, and uninstall removes them with the emptied skill roots', () => {
  // `earlier copy`: an rh run before this install (a release that recorded no Herdr surface) left marked copies,
  // in both host roots and in the staged root that the Herdr step refreshes when it exists.
  for (const earlierCopy of [false, true]) withInstallHome((home, rh, env) => {
    if (earlierCopy) {
      expect(configureRequiredHerdrSkill('both', env, undefined, false).status).toBe('ok');
      cpSync(join(home, '.codex', 'skills', 'herdr'), join(home, '.agents', 'skills', 'herdr'), { recursive: true });
    }
    const install = rh(...INSTALL);
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
    const herdr = [join('.agents', 'skills'), join('.claude', 'skills'), join('.codex', 'skills')]
      .filter(root => earlierCopy || !root.startsWith('.agents')).map(root => join(home, root, 'herdr'));
    const ledger = readInstallState(env)!.ownership_manifest;
    expect(ledger.filter(surface => surface.path.endsWith('/herdr')).map(({ owner, path, type }) => ({ owner, path, type })), `earlier copy: ${earlierCopy}`)
      .toEqual(herdr.map(path => ({ owner: 'core', path, type: 'directory-copy' })));
    expect(ledger.some(surface => surface.path === join(home, '.config', 'git', 'ignore'))).toBe(false);
    const uninstall = rh('uninstall', '--json');
    expect(uninstall.status, `${uninstall.stdout}\n${uninstall.stderr}`).toBe(0);
    expect(JSON.parse(String(uninstall.stdout)).lines.at(-1)).toBe('[uninstall] complete');
    for (const host of ['.claude', '.codex']) expect(existsSync(join(home, host, 'skills')), `${host} earlier copy: ${earlierCopy}`).toBe(false);
    expect(existsSync(join(home, '.agents', 'skills', 'herdr'))).toBe(false);
  });
}, 120_000);

test('a refused user Herdr skill stays unowned, and the failed install restores the Git excludes file', () => {
  for (const excludes of [null, '# user rule\n*.log\n']) withInstallHome((home, rh) => {
    const user = join(home, '.claude', 'skills', 'herdr', 'SKILL.md');
    mkdirSync(join(user, '..'), { recursive: true });
    writeFileSync(user, '# my own herdr notes\n');
    const ignore = join(home, '.config', 'git', 'ignore');
    if (excludes !== null) { mkdirSync(join(ignore, '..'), { recursive: true }); writeFileSync(ignore, excludes); }
    const install = rh(...INSTALL);
    expect(install.status).not.toBe(0);
    const steps = JSON.parse(String(install.stdout)).steps as { step: string; status: string; detail: string }[];
    expect(steps.find(({ step }) => step === 'configure required Herdr skill')).toMatchObject({ status: 'failed', detail: expect.stringContaining('refusing to replace unowned or changed Herdr skill') });
    // The ignore step still wrote the file before the rollback.
    expect(steps.find(({ step }) => step === 'write runtime ignore rules')).toMatchObject({ status: 'ok', detail: expect.stringContaining(ignore) });
    expect(readFileSync(user, 'utf-8')).toBe('# my own herdr notes\n');
    expect(existsSync(join(home, '.repo-harness', 'install-state.json'))).toBe(false);
    if (excludes === null) expect(existsSync(ignore)).toBe(false);
    else expect(readFileSync(ignore, 'utf-8')).toBe(excludes);
  });
}, 120_000);

test('a custom excludes path is restore-only, and a managed, directory or symlink excludes path is refused before any host write', () => {
  const managed = 'excludes_file_managed_path', notRegular = 'excludes_file_not_regular';
  const rows: { name: string; excludes: (home: string) => string; refused: string | null }[] = [
    // Each basename matches an ownership rule: an absent path that the ignore step creates must not become a surface.
    { name: 'bin/rh', excludes: home => join(home, 'bin', 'rh'), refused: null },
    { name: 'skills/herdr', excludes: home => join(home, '.config', 'skills', 'herdr'), refused: null },
    // One row per managed class: an allowlisted path (a fleet target), a path inside a written directory, a facade path.
    { name: 'fleet target', excludes: home => join(home, '.claude', 'agents', 'gatekeeper.md'), refused: managed },
    { name: 'inside the Herdr skill', excludes: home => join(home, '.claude', 'skills', 'herdr', 'ignore'), refused: managed },
    { name: 'facade path', excludes: home => join(home, '.codex', 'skills', 'repo-harness-notes'), refused: managed },
    // Other spellings of a managed path: identity, not the string, decides.
    { name: 'parent symlink alias', excludes: home => { mkdirSync(join(home, '.claude', 'agents'), { recursive: true }); symlinkSync(join(home, '.claude', 'agents'), join(home, 'fleet-alias')); return join(home, 'fleet-alias', 'gatekeeper.md'); }, refused: managed },
    { name: 'case variant', excludes: home => join(home, '.claude', 'agents', 'GATEKEEPER.MD'), refused: process.platform === 'darwin' || process.platform === 'win32' ? managed : null },
    { name: 'HOME realpath (/private/var on darwin)', excludes: home => join(realpathSync(home), '.claude', 'agents', 'gatekeeper.md'), refused: managed },
    { name: 'hard link', excludes: home => { mkdirSync(join(home, '.codex')); writeFileSync(join(home, '.codex', 'config.toml'), 'model = "user"\n'); linkSync(join(home, '.codex', 'config.toml'), join(home, 'excludes-link')); return join(home, 'excludes-link'); }, refused: managed },
    { name: 'directory', excludes: home => { mkdirSync(join(home, 'rules')); writeFileSync(join(home, 'rules', 'keep'), 'user\n'); return join(home, 'rules'); }, refused: notRegular },
    { name: 'symlink', excludes: home => { writeFileSync(join(home, 'secret'), 'token\n'); symlinkSync(join(home, 'secret'), join(home, 'ignore-link')); return join(home, 'ignore-link'); }, refused: notRegular },
    { name: 'HOME', excludes: home => home, refused: notRegular },
  ];
  for (const row of rows) withInstallHome((home, rh, env) => {
    const excludes = row.excludes(home);
    expect(spawnSync('git', ['config', '--global', 'core.excludesFile', excludes], { env }).status).toBe(0);
    // Every entry outside the runtime home (its lock and state), with its size and mtime.
    const tree = () => readdirSync(home, { recursive: true }).map(String).filter(path => !/^\.repo-harness(?:\/|$)/.test(path)).sort()
      .map(path => { const stat = lstatSync(join(home, path)); return `${path}:${stat.size}:${stat.mtimeMs}`; });
    const before = tree();
    const install = rh(...INSTALL);
    if (row.refused !== null) {
      expect(install.status, row.name).not.toBe(0);
      expect(String(install.stderr), row.name).toContain(`${row.refused}: the user Git excludes file ${excludes} is`);
      expect(tree(), row.name).toEqual(before);
      expect(existsSync(join(home, '.repo-harness', 'install-state.json')), row.name).toBe(false);
      return;
    }
    expect(install.status, `${row.name}\n${install.stdout}\n${install.stderr}`).toBe(0);
    expect(readFileSync(excludes, 'utf-8'), row.name).toContain('# BEGIN: repo-harness runtime-state');
    expect(readInstallState(env)!.ownership_manifest.some(surface => surface.path === excludes), row.name).toBe(false);
  });
}, 120_000);
