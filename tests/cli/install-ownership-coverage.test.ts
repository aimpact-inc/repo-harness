import { expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configureRequiredHerdrSkill } from '../../src/cli/commands/herdr-skill';
import { readInstallState } from '../../src/cli/installer/install-profile';
import { seedGlobalPackageFixture } from '../helpers/install-ownership';
import { writeFakeHc } from '../helpers/fake-hc';

const CLI = join(import.meta.dir, '../../src/cli/index.ts');

/** A scratch HOME with its own Git config home, Bun root, `rh` link and fake `hc`; `rh` runs core only on both hosts, offline. */
function withInstallHome(run: (home: string, rh: (...args: string[]) => ReturnType<typeof spawnSync>, env: NodeJS.ProcessEnv) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'repo-harness-ownership-coverage-'));
  const bin = join(home, 'tool-bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'bun'));
  writeFakeHc(bin);
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, BUN_INSTALL: join(home, '.bun'), XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'),
    REPO_HARNESS_HOME: join(home, '.repo-harness'), PATH: `${bin}:/usr/bin:/bin`, REPO_HARNESS_BUN_EXECUTABLE: join(bin, 'bun'),
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
  // `earlier copy`: an rh run before this install (a release that recorded no Herdr surface) left marked copies.
  for (const earlierCopy of [false, true]) withInstallHome((home, rh, env) => {
    if (earlierCopy) expect(configureRequiredHerdrSkill('both', env, undefined, false).status).toBe('ok');
    const install = rh(...INSTALL);
    expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
    const herdr = ['.claude', '.codex'].map(host => join(home, host, 'skills', 'herdr'));
    const ledger = readInstallState(env)!.ownership_manifest;
    expect(ledger.filter(surface => surface.path.endsWith('/herdr')).map(({ owner, path, type }) => ({ owner, path, type })), `earlier copy: ${earlierCopy}`)
      .toEqual(herdr.map(path => ({ owner: 'core', path, type: 'directory-copy' })));
    expect(ledger.some(surface => surface.path === join(home, '.config', 'git', 'ignore'))).toBe(false);
    const uninstall = rh('uninstall', '--json');
    expect(uninstall.status, `${uninstall.stdout}\n${uninstall.stderr}`).toBe(0);
    expect(JSON.parse(String(uninstall.stdout)).lines.at(-1)).toBe('[uninstall] complete');
    for (const host of ['.claude', '.codex']) expect(existsSync(join(home, host, 'skills')), `${host} earlier copy: ${earlierCopy}`).toBe(false);
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

test('a custom excludes path is restore-only, and a directory or symlink excludes path is refused before any host write', () => {
  const rows: { name: string; excludes: (home: string) => string; refused: boolean }[] = [
    // Each basename matches an ownership rule: an absent path that the ignore step creates must not become a surface.
    { name: 'bin/rh', excludes: home => join(home, 'bin', 'rh'), refused: false },
    { name: 'skills/herdr', excludes: home => join(home, '.config', 'skills', 'herdr'), refused: false },
    { name: 'directory', excludes: home => { mkdirSync(join(home, 'rules')); writeFileSync(join(home, 'rules', 'keep'), 'user\n'); return join(home, 'rules'); }, refused: true },
    { name: 'symlink', excludes: home => { writeFileSync(join(home, 'secret'), 'token\n'); symlinkSync(join(home, 'secret'), join(home, 'ignore-link')); return join(home, 'ignore-link'); }, refused: true },
    { name: 'HOME', excludes: home => home, refused: true },
  ];
  for (const row of rows) withInstallHome((home, rh, env) => {
    const excludes = row.excludes(home);
    expect(spawnSync('git', ['config', '--global', 'core.excludesFile', excludes], { env }).status).toBe(0);
    const install = rh(...INSTALL);
    if (row.refused) {
      expect(install.status, row.name).not.toBe(0);
      expect(String(install.stderr), row.name).toContain(`excludes_file_not_regular: the user Git excludes file ${excludes} is`);
      for (const written of ['.claude', '.codex', join('.repo-harness', 'install-state.json')]) expect(existsSync(join(home, written)), `${row.name}: ${written}`).toBe(false);
      if (row.name === 'directory') expect(readFileSync(join(excludes, 'keep'), 'utf-8')).toBe('user\n');
      if (row.name === 'symlink') expect(readFileSync(join(home, 'secret'), 'utf-8')).toBe('token\n');
      return;
    }
    expect(install.status, `${row.name}\n${install.stdout}\n${install.stderr}`).toBe(0);
    expect(readFileSync(excludes, 'utf-8'), row.name).toContain('# BEGIN: repo-harness runtime-state');
    expect(readInstallState(env)!.ownership_manifest.some(surface => surface.path === excludes), row.name).toBe(false);
  });
}, 120_000);
