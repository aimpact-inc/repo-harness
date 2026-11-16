import { expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

test('install owns the Herdr skill copies under core, and uninstall removes them with the emptied skill roots', () => withInstallHome((home, rh, env) => {
  const install = rh(...INSTALL);
  expect(install.status, `${install.stdout}\n${install.stderr}`).toBe(0);
  const herdr = ['.claude', '.codex'].map(host => join(home, host, 'skills', 'herdr'));
  expect(readInstallState(env)!.ownership_manifest
    .filter(surface => surface.path.endsWith('/herdr')).map(({ owner, path, type }) => ({ owner, path, type })))
    .toEqual(herdr.map(path => ({ owner: 'core', path, type: 'directory-copy' })));
  const uninstall = rh('uninstall', '--json');
  expect(uninstall.status, `${uninstall.stdout}\n${uninstall.stderr}`).toBe(0);
  expect(JSON.parse(String(uninstall.stdout)).lines.at(-1)).toBe('[uninstall] complete');
  for (const host of ['.claude', '.codex']) expect(existsSync(join(home, host, 'skills')), host).toBe(false);
}), 120_000);

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
