import { describe, expect, test } from 'bun:test';
import { writeFakeHc } from '../helpers/fake-hc';
import { installStateFixturePath, recordLegacyInstallOwnership, recordPluginSelection, seedGlobalPackageFixture, withTempHome } from '../helpers/install-ownership';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { previewHostConfig, resolveOverrides, runInstall, runUninstall } from '../../src/cli/commands/install';
import { NO_OVERRIDES } from '../../src/core/host-config/override';
import { routesForHost } from '../../src/cli/hook/route-registry';
import { CLAUDE_STATUS_LINE_PIPE, claudeTarget } from '../../src/cli/installer/targets/claude';
import type { Location } from '../../src/cli/installer/types';
import { requestUserInputFragment } from '../../src/cli/installer/targets/codex';
import { openHostConfigGate } from '../../src/effects/host-config/gate';
import { hostConfigPaths } from '../../src/effects/host-config/store';
import { isRepoHarnessManagedHookCommand } from '../../src/core/adoption/managed-hook-config';
import { buildManagedHooks, compareManagedHookProjection, hookSelector, managedStatusLine } from '../../src/cli/installer/managed-entries';

const ROOT = path.join(import.meta.dir, '..', '..');
const CLI = path.join(ROOT, 'src/cli/index.ts');

function antigravityCli(home: string, args: readonly string[], bunInstall = path.join(home, '.bun')) {
  const bin = path.join(home, 'probe-bin');
  fs.mkdirSync(bin, { recursive: true });
  if (!fs.existsSync(path.join(bin, 'hc'))) writeFakeHc(bin);
  for (const skill of ['think', 'hunt', 'check', 'health']) {
    const staged = path.join(home, '.agents', 'skills', skill);
    if (fs.existsSync(staged)) continue;
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, 'SKILL.md'), `# ${skill} fixture\n`);
  }
  return spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', CLI, ...args], {
    cwd: home, env: { HOME: home, PATH: bin, BUN_INSTALL: bunInstall, TMPDIR: home }, encoding: 'utf8',
  });
}

test.skipIf(process.platform === 'win32')('Antigravity refuses a link or wrong entry type at each hook path component', () => {
  withTempHome('rh-antigravity-path', (home) => {
    const hooks = path.join(home, '.gemini/config/hooks.json');
    const target = ['--target', 'antigravity'];
    const install = antigravityCli(home, ['install', ...target]);
    expect(install.status, install.stderr).toBe(0);
    const codex = path.join(home, '.codex/hooks.json');
    expect(antigravityCli(home, ['install', '--target', 'codex', '--location', 'global']).status).toBe(0);
    const original = fs.readFileSync(hooks);
    const originalCodex = fs.readFileSync(codex);
    const commands = [
      ['install', ...target], ['install', ...target, '--dry-run'],
      ['update', ...target], ['update', ...target, '--dry-run'],
      ['uninstall', ...target], ['uninstall', ...target, '--dry-run'],
      ['config', 'status'], ['config', 'diff', hooks],
      ['config', 'restore', hooks], ['config', 'restore', hooks, '--dry-run'],
    ];
    for (const entry of [path.join(home, '.gemini'), path.dirname(hooks), hooks]) {
      const parked = path.join(home, 'parked');
      fs.renameSync(entry, parked);
      const referent = path.join(parked, path.relative(entry, hooks));
      const targetEntry = entry === hooks ? codex : parked;
      fs.symlinkSync(targetEntry, entry, entry === hooks ? 'file' : 'dir');
      for (const command of commands) {
        const result = antigravityCli(home, command);
        expect(result.status, command.join(' ')).not.toBe(0);
        expect(result.stdout + result.stderr).toContain('antigravity_hooks_path_linked');
      }
      expect(fs.readlinkSync(entry)).toBe(targetEntry);
      expect(fs.readFileSync(referent)).toEqual(original);
      expect(fs.readFileSync(codex)).toEqual(originalCodex);
      fs.unlinkSync(entry);
      if (entry === hooks) fs.mkdirSync(entry); else fs.writeFileSync(entry, 'fake');
      const preview = antigravityCli(home, ['install', ...target, '--dry-run']);
      expect(preview.stdout + preview.stderr).toContain('antigravity_hooks_path_linked');
      if (entry === hooks) fs.rmdirSync(entry); else fs.unlinkSync(entry);
      fs.renameSync(parked, entry);
    }
  });
}, 30_000);

test.skipIf(process.platform === 'win32')('adapter-only default install and local previews exclude Antigravity, and explicit update refreshes a recorded member', () => {
  withTempHome('rh-antigravity-opt-in', (home) => {
    const hooks = path.join(home, '.gemini/config/hooks.json');
    const target = ['--target', 'antigravity'];
    expect(antigravityCli(home, ['update', ...target, '--no-cli']).status).toBe(0);
    expect(fs.existsSync(path.dirname(path.dirname(hooks)))).toBe(false);
    expect(antigravityCli(home, ['install', ...target]).status).toBe(0);
    const installed = fs.readFileSync(hooks, 'utf8');
    const bunInstall = path.join(home, 'moved-bun');
    seedGlobalPackageFixture({ HOME: home, BUN_INSTALL: bunInstall }, { mutable: true });
    const defaultInstall = antigravityCli(home, ['install', '--location', 'global'], bunInstall);
    expect(defaultInstall.status, defaultInstall.stderr).toBe(0);
    expect(defaultInstall.stdout).toContain('[claude]');
    expect(defaultInstall.stdout).toContain('[codex]');
    for (const command of ['install', 'update']) {
      const preview = antigravityCli(home, [command, '--dry-run', '--json'], bunInstall);
      expect(preview.status, preview.stderr).toBe(0);
      const { host_config } = JSON.parse(preview.stdout);
      expect(host_config.items.every(({ path: file }: { path: string }) => file !== hooks)).toBe(true);
      expect(host_config.unplanned.some(({ target }: { target: string }) => target === 'antigravity')).toBe(false);
    }
    expect(fs.readFileSync(hooks, 'utf8')).toBe(installed);
    const update = antigravityCli(home, ['update', ...target, '--no-cli'], bunInstall);
    expect(update.status, update.stderr).toBe(0);
    expect(fs.readFileSync(hooks, 'utf8')).toContain(path.join(bunInstall, 'install/global/node_modules/repo-harness/dist/hook-entry.js'));
  });
}, 30_000);

test.skipIf(process.platform === 'win32')('Antigravity install --report-language zh-CN writes hooks, AGENTS.md, and skill symlinks; dry-run previews AGENTS.md; update preserves user edits', () => {
  withTempHome('rh-antigravity-rules-skills', (home) => {
    const configDir = path.join(home, '.gemini', 'config');
    const hooks = path.join(configDir, 'hooks.json');
    const rules = path.join(configDir, 'AGENTS.md');
    const skillsDir = path.join(configDir, 'skills');
    const target = ['--target', 'antigravity'];

    // Pre-existing user text in AGENTS.md is preserved outside markers.
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(rules, '# My Antigravity Notes\n\nKeep personal rules.\n');

    // Dry-run lists hooks.json, AGENTS.md, and projected skill symlinks and writes nothing.
    const dryRun = antigravityCli(home, ['install', ...target, '--report-language', 'zh-CN', '--dry-run', '--json']);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    const preview = JSON.parse(dryRun.stdout).host_config;
    expect(preview.items).toEqual(expect.arrayContaining([
      { path: hooks, selector: 'repo-harness', action: 'add' },
      { path: rules, selector: 'global-working-rules', action: 'add' },
      { path: path.join(skillsDir, 'repo-harness'), selector: 'symlink', action: 'create' },
      { path: path.join(skillsDir, 'repo-harness-check'), selector: 'symlink', action: 'create' },
      { path: path.join(skillsDir, 'repo-harness-issue-flow'), selector: 'symlink', action: 'create' },
    ]));
    expect(preview.unplanned).toEqual([]);
    expect(preview.notListed).toEqual([]);
    expect(fs.existsSync(hooks)).toBe(false);
    expect(fs.existsSync(skillsDir)).toBe(false);
    expect(fs.readFileSync(rules, 'utf8')).toBe('# My Antigravity Notes\n\nKeep personal rules.\n');

    // Install with --report-language zh-CN writes hooks, zh-CN global rules, and projected skill symlinks.
    const install = antigravityCli(home, ['install', ...target, '--report-language', 'zh-CN']);
    expect(install.status, install.stdout + install.stderr).toBe(0);
    const hookMember = JSON.parse(fs.readFileSync(hooks, 'utf8'))['repo-harness'];
    expect(hookMember?.enabled).not.toBe(false);
    expect(Array.isArray(hookMember?.PreToolUse)).toBe(true);
    const rulesContent = fs.readFileSync(rules, 'utf8');
    expect(rulesContent).toContain('# My Antigravity Notes\n\nKeep personal rules.');
    expect(rulesContent).toContain('<!-- BEGIN: repo-harness global-working-rules -->');
    expect(rulesContent).toContain('Use Chinese to report to user.');
    expect(rulesContent).toContain('下一刀');
    expect(fs.lstatSync(path.join(skillsDir, 'repo-harness')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(skillsDir, 'repo-harness-check')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(skillsDir, 'repo-harness-issue-flow')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'repo-harness-setup'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'repo-harness-herdr-portal'))).toBe(false);
    expect(fs.existsSync(path.join(skillsDir, 'repo-harness-seat-handoff'))).toBe(false);
    expect(fs.readFileSync(path.join(skillsDir, 'herdr', 'SKILL.md'), 'utf8')).toContain('hc manual (herdr-core)');
    for (const skill of ['think', 'hunt', 'check', 'health']) {
      expect(fs.readlinkSync(path.join(skillsDir, skill))).toBe(path.join(home, '.agents', 'skills', skill));
    }

    // Unrelated flags and invalid --report-language are rejected.
    expect(antigravityCli(home, ['install', ...target, '--plugins', 'core']).status).not.toBe(0);
    expect(antigravityCli(home, ['install', ...target, '--with-obsidian-skills']).status).not.toBe(0);
    expect(antigravityCli(home, ['install', ...target, '--report-language', 'fr']).status).not.toBe(0);
    expect(antigravityCli(home, ['update', ...target, '--version', '1.0.0']).status).not.toBe(0);

    // Re-running install/update dry-run reports no pending changes when already current.
    const idempotentDryRun = antigravityCli(home, ['install', ...target, '--dry-run', '--json']);
    expect(idempotentDryRun.status, idempotentDryRun.stderr).toBe(0);
    expect(JSON.parse(idempotentDryRun.stdout).host_config).toEqual({ items: [], unplanned: [], notListed: [] });

    // Re-running install/update preserves recorded zh-CN language and user edits inside markers.
    const idempotent = antigravityCli(home, ['install', ...target]);
    expect(idempotent.status, idempotent.stderr).toBe(0);
    expect(fs.readFileSync(rules, 'utf8')).toBe(rulesContent);

    const edited = rulesContent.replace('Use Chinese to report to user.', 'Use Chinese to report to user. User edit.');
    fs.writeFileSync(rules, edited);
    const update = antigravityCli(home, ['update', ...target, '--no-cli']);
    expect(update.status, update.stdout + update.stderr).toBe(0);
    expect(fs.readFileSync(rules, 'utf8')).toBe(edited);
  });
}, 30_000);

test.skipIf(process.platform === 'win32')('Antigravity rolls back a new install when a Waza destination belongs to the user', () => {
  withTempHome('rh-antigravity-waza-collision', (home) => {
    const config = path.join(home, '.gemini', 'config');
    const skills = path.join(config, 'skills');
    const think = path.join(skills, 'think');
    fs.mkdirSync(think, { recursive: true });
    fs.writeFileSync(path.join(think, 'SKILL.md'), '# User skill\n');

    const install = antigravityCli(home, ['install', '--target', 'antigravity']);
    expect(install.status, install.stdout + install.stderr).toBe(1);
    expect(install.stdout + install.stderr).toContain(think);
    expect(fs.readFileSync(path.join(think, 'SKILL.md'), 'utf8')).toBe('# User skill\n');
    expect(fs.readdirSync(skills)).toEqual(['think']);
    expect(fs.existsSync(path.join(config, 'hooks.json'))).toBe(false);
    expect(fs.existsSync(path.join(config, 'AGENTS.md'))).toBe(false);
  });
});

test.skipIf(process.platform === 'win32')('Antigravity retires the old owned portal link and uninstalls new skill projections', () => {
  withTempHome('rh-antigravity-retire-skill', (home) => {
    const target = ['--target', 'antigravity'];
    const skills = path.join(home, '.gemini', 'config', 'skills');
    const portal = path.join(skills, 'repo-harness-herdr-portal');
    const portalSource = path.join(ROOT, 'assets', 'skills', 'repo-harness-herdr-portal');
    recordPluginSelection(process.env, ['peer-runtime', 'strategy-memory']);
    expect(antigravityCli(home, ['install', ...target]).status).toBe(0);
    openHostConfigGate().writePaths([{ path: portal, owner: 'peer-runtime', entry: { type: 'symlink', target: portalSource } }]);
    const strategy = path.join(skills, 'repo-harness-strategy');
    expect(antigravityCli(home, ['strategy', 'install-skill']).status).toBe(0);
    expect(fs.readlinkSync(strategy)).toBe(path.join(ROOT, 'assets', 'skills', 'repo-harness-strategy'));

    const update = antigravityCli(home, ['update', ...target]);
    expect(update.status, update.stdout + update.stderr).toBe(0);
    expect(fs.existsSync(portal)).toBe(false);
    expect(fs.existsSync(strategy)).toBe(true);
    expect(fs.existsSync(path.join(skills, 'think'))).toBe(true);
    expect(fs.existsSync(path.join(portalSource, 'SKILL.md'))).toBe(true);

    // The user recreated the link with the same target. Its identity is new.
    openHostConfigGate().writePaths([{ path: portal, owner: 'peer-runtime', entry: { type: 'symlink', target: portalSource } }]);
    fs.renameSync(portal, path.join(home, 'previous-portal'));
    fs.symlinkSync(portalSource, portal, 'dir');
    expect(antigravityCli(home, ['update', ...target]).status).toBe(0);
    expect(fs.readlinkSync(portal)).toBe(portalSource);

    const uninstall = antigravityCli(home, ['uninstall', ...target]);
    expect(uninstall.status, uninstall.stdout + uninstall.stderr).toBe(0);
    for (const name of ['herdr', 'think', 'hunt', 'check', 'health', 'repo-harness-strategy']) {
      expect(fs.lstatSync(path.join(skills, name), { throwIfNoEntry: false })).toBeUndefined();
    }
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'think', 'SKILL.md'))).toBe(true);
    expect(fs.readlinkSync(portal)).toBe(portalSource);
  });
});

test.skipIf(process.platform === 'win32')('Antigravity --dry-run reports unowned skill collisions and exits non-zero, matching apply', () => {
  withTempHome('rh-antigravity-dry-run-collision', (home) => {
    const configDir = path.join(home, '.gemini', 'config');
    const hooks = path.join(configDir, 'hooks.json');
    const rules = path.join(configDir, 'AGENTS.md');
    const skillsDir = path.join(configDir, 'skills');
    const target = ['--target', 'antigravity'];
    const userSkill = path.join(skillsDir, 'repo-harness');

    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# User owned skill\n');

    const dryRunJson = antigravityCli(home, ['install', ...target, '--dry-run', '--json']);
    expect(dryRunJson.status).toBe(1);
    const preview = JSON.parse(dryRunJson.stdout).host_config;
    expect(preview.unplanned).toContainEqual({
      target: 'antigravity',
      reason: expect.stringContaining('rh has no record of it'),
    });
    expect(preview.unplanned[0].reason).toContain(userSkill);
    expect(fs.existsSync(hooks)).toBe(false);
    expect(fs.existsSync(rules)).toBe(false);
    expect(fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8')).toBe('# User owned skill\n');

    const dryRunText = antigravityCli(home, ['install', ...target, '--dry-run']);
    expect(dryRunText.status).toBe(1);
    expect(dryRunText.stdout + dryRunText.stderr).toContain('rh has no record of it');

    const apply = antigravityCli(home, ['install', ...target]);
    expect(apply.status).toBe(1);
    expect(apply.stdout + apply.stderr).toContain('rh has no record of it');

    // After clean install, replacing a managed skill with an unowned directory fails both update --dry-run and update.
    fs.rmSync(userSkill, { recursive: true, force: true });
    expect(antigravityCli(home, ['install', ...target]).status).toBe(0);
    const checkSkill = path.join(skillsDir, 'repo-harness-check');
    fs.unlinkSync(checkSkill);
    fs.mkdirSync(checkSkill, { recursive: true });
    fs.writeFileSync(path.join(checkSkill, 'SKILL.md'), '# User replacement\n');

    const updateDryRun = antigravityCli(home, ['update', ...target, '--dry-run', '--json']);
    expect(updateDryRun.status).toBe(1);
    const updatePreview = JSON.parse(updateDryRun.stdout).host_config;
    expect(updatePreview.unplanned).toContainEqual({
      target: 'antigravity',
      reason: expect.stringContaining(checkSkill),
    });
    const updateApply = antigravityCli(home, ['update', ...target]);
    expect(updateApply.status).toBe(1);
    expect(updateApply.stdout + updateApply.stderr).toContain(checkSkill);
    expect(fs.readFileSync(path.join(checkSkill, 'SKILL.md'), 'utf8')).toBe('# User replacement\n');
  });
}, 30_000);

test.skipIf(process.platform === 'win32')('Antigravity refuses symlinked AGENTS.md or skills and preserves pre-existing user skill directories', () => {
  withTempHome('rh-antigravity-i2', (home) => {
    const configDir = path.join(home, '.gemini', 'config');
    const hooks = path.join(configDir, 'hooks.json');
    const rules = path.join(configDir, 'AGENTS.md');
    const skillsDir = path.join(configDir, 'skills');
    const target = ['--target', 'antigravity'];

    // Pre-existing user skill directory at ~/.gemini/config/skills/repo-harness is refused before any write.
    const userSkill = path.join(skillsDir, 'repo-harness');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# User owned skill\n');
    const collision = antigravityCli(home, ['install', ...target]);
    expect(collision.status).not.toBe(0);
    expect(collision.stdout + collision.stderr).toContain('rh has no record of it');
    expect(fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8')).toBe('# User owned skill\n');
    expect(fs.existsSync(hooks)).toBe(false);
    expect(fs.existsSync(rules)).toBe(false);
    fs.rmSync(userSkill, { recursive: true, force: true });

    // Clean install succeeds, then symlinked AGENTS.md and skills directory fail closed across CLI commands.
    expect(antigravityCli(home, ['install', ...target]).status).toBe(0);
    const originalRules = fs.readFileSync(rules);
    for (const [entry, isDir] of [[rules, false], [skillsDir, true]] as const) {
      const parked = path.join(home, 'parked-entry');
      fs.renameSync(entry, parked);
      fs.symlinkSync(parked, entry, isDir ? 'dir' : 'file');
      for (const command of [
        ['install', ...target], ['install', ...target, '--dry-run'],
        ['update', ...target], ['update', ...target, '--dry-run'],
        ['uninstall', ...target], ['uninstall', ...target, '--dry-run'],
        ['config', 'status'],
      ]) {
        const res = antigravityCli(home, command);
        expect(res.status, `${entry}: ${command.join(' ')}`).not.toBe(0);
        expect(res.stdout + res.stderr).toContain('antigravity_hooks_path_linked');
      }
      expect(fs.readlinkSync(entry)).toBe(parked);
      fs.unlinkSync(entry);
      fs.renameSync(parked, entry);
    }
    expect(fs.readFileSync(rules)).toEqual(originalRules);
  });
}, 30_000);

describe('issue 698 host configuration ownership', () => {
  test('issue 698 installs and restores only the top-level TOML key', () => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.codex/config.toml');
      const original = 'model = "user"\n[profiles.work]\ndefault_mode_request_user_input = false\n';
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, original);

      const install = runInstall({ target: 'codex', location: 'global' });
      expect(install.exitCode).toBe(0);
      const installed = fs.readFileSync(filePath, 'utf8');
      expect(installed).toBe(`default_mode_request_user_input = true\n${original}`);
      expect(fs.existsSync(path.join(home, '.repo-harness/configuration-restore.json'))).toBe(false);
      const ledger = () => JSON.parse(fs.readFileSync(path.join(home, '.repo-harness/config/ledger.json'), 'utf8'));
      expect(ledger().fragments.filter((entry: { file: string }) => entry.file === fs.realpathSync(filePath))).toEqual([{ file: fs.realpathSync(filePath), owner: 'core', selector: 'default_mode_request_user_input', kind: 'add', inserted: 'default_mode_request_user_input = true\n' }]);
      const recorded = ledger();
      expect(runInstall({ target: 'codex', location: 'global' }).exitCode).toBe(0);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(installed);
      expect(ledger()).toEqual(recorded);

      expect(runUninstall({ target: 'codex', location: 'global' }).exitCode).toBe(0);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
    });
  });

  test('A10: install keeps an explicit user value and prints it; only the override selection replaces it, and a revert restores it', () => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.codex/config.toml');
      const original = 'default_mode_request_user_input = false   # I prefer no prompts\n[profiles.work]\nmodel = "x"\n';
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, original);
      const install = runInstall({ target: 'codex', location: 'global' });
      expect(install.exitCode).toBe(0);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
      expect(install.lines).toContain('[codex] kept: default_mode_request_user_input = false (your value). repo-harness skills ask plain-text numbered questions instead of request_user_input.');

      const gate = openHostConfigGate({ env: process.env });
      gate.apply([{ path: filePath, fragments: [requestUserInputFragment(original, true)!] }]);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original.replace('false   # I prefer no prompts', 'true'));
      expect(gate.revert([filePath]).map((entry) => entry.action)).toEqual(['text_removed']);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
    });
  });

  test('only an override selection replaces a user value; the dry run lists the items that the apply then writes, and writes nothing', () => {
    withTempHome('repo-harness-install', (home) => {
      const settings = path.join(home, '.claude/settings.json');
      const original = '{"statusLine":{"type":"command","command":"user-line"}}\n';
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, original);
      const file = fs.realpathSync(settings);
      const ledgerPath = hostConfigPaths(process.env).ledger;
      const recorded = () => fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).fragments.map((entry: { selector: string }) => entry.selector) as string[] : [];
      const preview = (overrides: typeof NO_OVERRIDES) => {
        const ledgerBefore = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath) : null;
        const settingsBefore = fs.readFileSync(settings);
        const items = previewHostConfig('claude', overrides, process.env).items;
        expect(fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath) : null).toEqual(ledgerBefore);
        expect(fs.readFileSync(settings)).toEqual(settingsBefore);
        return items;
      };

      const unselected = preview(NO_OVERRIDES);
      expect(unselected.filter((item) => item.action.startsWith('host_config_'))).toEqual([{ path: file, selector: 'statusLine', action: 'host_config_override_skipped' }]);
      expect(runInstall({ target: 'claude', location: 'global' }).exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command).toBe('user-line');
      expect(recorded().sort()).toEqual(unselected.filter((item) => item.action === 'add').map((item) => item.selector).sort());

      const overrides = resolveOverrides([`${settings}#statusLine`], process.env);
      expect(preview(overrides)).toEqual([{ path: file, selector: 'statusLine', action: 'override' }]);
      const before = recorded();
      expect(runInstall({ target: 'claude', location: 'global', overrides }).exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine).toEqual(managedStatusLine());
      expect(recorded().filter((selector) => !before.includes(selector))).toEqual(['statusLine']);
    });
  });

  test('issue 698 leaves a true top-level TOML key and false profile key unchanged', () => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.codex/config.toml');
      const original = 'default_mode_request_user_input = true # user setting\n[profiles.work]\ndefault_mode_request_user_input = false\n';
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, original);
      expect(runInstall({ target: 'codex', location: 'global' }).exitCode).toBe(0);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
      const ledger = JSON.parse(fs.readFileSync(path.join(home, '.repo-harness/config/ledger.json'), 'utf8'));
      expect(ledger.files[fs.realpathSync(filePath)]).toBeUndefined();
    });
  });

  for (const raw of [
    'default_mode_request_user_input = false\ndefault_mode_request_user_input = true\n',
    '"default_mode_request_user_input" = false\n',
    '[profiles.work\ndefault_mode_request_user_input = false\n',
    'text = """\ndefault_mode_request_user_input = false\n"""\ndefault_mode_request_user_input = false\n',
  ]) {
    test(`issue 698 refuses unsupported TOML before any config write: ${JSON.stringify(raw)}`, () => {
      withTempHome('repo-harness-install', (home) => {
        const filePath = path.join(home, '.codex/config.toml');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, raw);
        expect(runInstall({ target: 'codex', location: 'global' }).exitCode).toBe(1);
        expect(fs.readFileSync(filePath, 'utf8')).toBe(raw);
        expect(fs.existsSync(path.join(home, '.codex/hooks.json'))).toBe(false);
        expect(fs.existsSync(path.join(home, '.repo-harness/configuration-restore.json'))).toBe(false);
      });
    });
  }

  test('issue 3079 names an invalid config.toml with the remedy and never quotes its text', () => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.codex/config.toml');
      const raw = 'k = sk-FAKE-SECRET-12345\n';
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, raw);
      const result = runInstall({ target: 'codex', location: 'global' });
      expect(result.exitCode).toBe(1);
      expect(result.lines).toContain(`[codex] error: ${filePath}: the file is not valid TOML. Fix the TOML in that file, then run the command again`);
      expect(result.lines.join('\n')).not.toContain('sk-FAKE');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(raw);
      expect(fs.existsSync(path.join(home, '.codex/hooks.json'))).toBe(false);
    });
  });

  for (const host of ['codex', 'claude'] as const) {
    for (const shape of ['file', 'directory', 'dangling'] as const) {
      test(`${host} install follows a user's ${shape} symlink, and uninstall restores the linked file`, () => {
        withTempHome('repo-harness-install', (home) => {
          const name = host === 'codex' ? 'hooks.json' : 'settings.json';
          const root = path.join(home, `.${host}`);
          const filePath = path.join(root, name);
          const outside = path.join(home, 'dotfiles');
          const linked = path.join(outside, name);
          const original = '{"theme":"user"}\n';
          fs.mkdirSync(outside);
          if (shape !== 'dangling') fs.writeFileSync(linked, original);
          if (shape === 'directory') fs.symlinkSync(outside, root);
          else {
            fs.mkdirSync(root);
            fs.symlinkSync(linked, filePath);
          }
          const linkPath = shape === 'directory' ? root : filePath;
          const link = fs.readlinkSync(linkPath);
          expect(runInstall({ target: host, location: 'global' }).exitCode).toBe(0);
          expect(fs.readlinkSync(linkPath)).toBe(link);
          expect(Object.keys(JSON.parse(fs.readFileSync(linked, 'utf8')).hooks).length).toBeGreaterThan(0);
          expect(runUninstall({ target: host, location: 'global' }).exitCode).toBe(0);
          expect(fs.readlinkSync(linkPath)).toBe(link);
          if (shape !== 'dangling') expect(fs.readFileSync(linked, 'utf8')).toBe(original);
          else expect(fs.existsSync(linked)).toBe(false);
        });
      });
    }
  }

  test('issue 698 rejects local commands and Claude target calls without touching settings', () => {
    withTempHome('repo-harness-install', (home) => {
      const repo = path.join(home, 'project');
      fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
      const victim = path.join(home, 'dotfile.json');
      const original = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"repo-harness hook SessionStart --route default"}]}]}}\n';
      fs.writeFileSync(victim, original);
      const filePath = path.join(repo, '.claude/settings.json');
      fs.symlinkSync(victim, filePath);
      const previous = process.cwd();
      process.chdir(repo);
      try {
        const local = 'local' as Location; // Deliberately invalid runtime input.
        for (const target of ['codex', 'claude', 'both'] as const) {
          expect(runInstall({ target, location: local }).exitCode).toBe(2);
          expect(runUninstall({ target, location: local, dryRun: true }).exitCode).toBe(2);
          expect(runUninstall({ target, location: local }).exitCode).toBe(2);
        }
        expect(() => claudeTarget.install(local, {})).toThrow('--location global');
        expect(() => claudeTarget.detect(local)).toThrow('--location global');
        expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(victim, 'utf8')).toBe(original);
        expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
        expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
        expect(fs.existsSync(path.join(home, '.repo-harness'))).toBe(false);
      } finally { process.chdir(previous); }
    });
  });

  test('issue 698 refuses a user hook entry that holds a retired rh command, and lookalike user commands are not rh\'s', () => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.claude/settings.json');
      const commands = [
        'echo user-guard # see .ai/hooks/run-hook.sh docs',
        'echo .claude/hooks/run-hook.sh',
        `echo ${home}/.repo-harness/hook-shim.sh`,
        'repo-harness hook Stop --route user',
        'repo-harness hook SessionStart --route default; echo user',
        'repo=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0; export HOOK_REPO_ROOT="$repo"; echo repo-harness-hook exec repo-harness hook user',
      ];
      const historical = 'repo=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0; HOOK_REPO_ROOT="$repo" bash "$repo/.ai/hooks/run-hook.sh" session-start-context.sh';
      expect(isRepoHarnessManagedHookCommand(historical)).toBe(true);
      expect(commands.filter((command) => isRepoHarnessManagedHookCommand(command))).toEqual([]);
      const original = JSON.stringify({ theme: 'user', hooks: { SessionStart: [{ hooks: [...commands, historical].map(command => ({ type: 'command', command })) }] } });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, original);
      const install = runInstall({ target: 'claude', location: 'global' });
      expect(install.exitCode).toBe(1);
      expect(install.lines).toContain('[claude] error: a hook entry in SessionStart holds a repo-harness command together with other commands. Move that command into its own entry, or delete it, then run rh again');
      expect(fs.readFileSync(filePath, 'utf8')).toBe(original);
      expect(fs.existsSync(path.join(home, '.repo-harness/configuration-restore.json'))).toBe(false);
    });
  });
});

function writeReadyOfficialCodexPluginCli(home: string): string {
  const pluginRoot = path.join(home, '.claude', 'plugins', 'cache', 'openai-codex', 'codex', '1.0.6');
  fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'schemas'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, 'scripts', 'codex-companion.mjs'), '// fixture\n');
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'codex',
    version: '1.0.6',
    author: { name: 'OpenAI' },
  }));
  fs.writeFileSync(path.join(pluginRoot, 'schemas', 'review-output.schema.json'), JSON.stringify({
    required: ['verdict', 'summary', 'findings', 'next_steps'],
    properties: {
      verdict: { enum: ['approve', 'needs-attention'] },
      findings: { items: { properties: { severity: { enum: ['critical', 'high', 'medium', 'low'] } } } },
    },
  }));
  const claude = path.join(home, 'bin', 'claude');
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, [
    '#!/bin/bash',
    'if [[ "$*" == "plugin list --json" ]]; then',
    `  printf '%s\\n' '${JSON.stringify([{ id: 'codex@openai-codex', version: '1.0.6', enabled: true, installPath: pluginRoot }])}'`,
    '  exit 0',
    'fi',
    'exit 9',
    '',
  ].join('\n'));
  fs.chmodSync(claude, 0o755);
  return claude;
}

describe('install command (Phase 1B)', () => {
  test('dry-run reports owned dangling links without changing host files', () => {
    withTempHome('repo-harness-install', (home) => {
      const ownedTarget = path.join(ROOT, 'assets/skill-commands/retired-symlink-test');
      expect(fs.existsSync(ownedTarget)).toBe(false);
      const foreignTarget = path.join(home, 'Waza', 'think');
      fs.symlinkSync(path.join(home, 'missing-volume'), path.dirname(foreignTarget));
      const roots = ['.codex', '.claude'].map((host) => path.join(home, host, 'skills'));
      for (const root of roots) {
        fs.mkdirSync(root, { recursive: true });
        fs.symlinkSync(foreignTarget, path.join(root, 'think'));
      }
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
      delete env.CODEX_SKILLS_ROOT; delete env.CLAUDE_SKILLS_ROOT;
      openHostConfigGate({ env }).writePaths(roots.map(root => ({ path: path.join(root, 'repo-harness-plan.bak'), owner: 'core', entry: { type: 'symlink', target: ownedTarget } })));
      const harness = path.join(home, '.repo-harness');
      const entriesBefore = fs.readdirSync(harness, { recursive: true }).map(String).sort();
      const ledgerBefore = fs.readFileSync(hostConfigPaths(env).ledger);
      for (const json of [false, true]) {
        const result = spawnSync(process.execPath, [CLI, 'install', '--dry-run', ...(json ? ['--json'] : [])], {
          cwd: ROOT, encoding: 'utf-8',
          env,
        });
        expect(result.status, result.stderr).toBe(0);
        for (const root of roots) {
          const link = path.join(root, 'repo-harness-plan.bak');
          if (json) expect(JSON.parse(result.stdout).removedDanglingSkillLinks).toContain(link);
          else expect(result.stdout).toContain(`would remove dangling skill symlink: ${link}`);
          const foreignLink = path.join(root, 'think');
          if (json) expect(JSON.parse(result.stdout).removedDanglingSkillLinks).not.toContain(foreignLink);
          else expect(result.stdout).not.toContain(foreignLink);
          expect(fs.readdirSync(root).sort()).toEqual(['repo-harness-plan.bak', 'think']);
          expect(fs.readlinkSync(link)).toBe(ownedTarget);
          expect(fs.readlinkSync(path.join(root, 'think'))).toBe(foreignTarget);
        }
        expect(fs.readdirSync(harness, { recursive: true }).map(String).sort()).toEqual(entriesBefore);
        expect(fs.readFileSync(hostConfigPaths(env).ledger)).toEqual(ledgerBefore);
        expect(fs.readdirSync(path.join(home, '.codex'))).toEqual(['skills']);
        expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['skills']);
      }
    });
  }, 30_000);

  test('install refuses an override that no request of the run carries before any write', () => {
    withTempHome('repo-harness-install', (home) => {
      const settings = path.join(home, '.claude/settings.json');
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, '{"statusLine":{"type":"command","command":"user-line"}}\n');
      const before = fs.readdirSync(home, { recursive: true }).map(String).sort();
      const codexHook = `${path.join(home, '.codex/hooks.json')}#${hookSelector(routesForHost('codex')[0]!)}`;
      for (const args of [
        ['--override', `${settings}#nope`],
        // The Codex writers take no selection yet.
        ['--override', codexHook],
        ['--no-hooks', '--override', `${settings}#statusLine`],
        ['--override', settings],
        ['--state', '--override', `${settings}#statusLine`],
      ]) {
        const result = spawnSync(process.execPath, [CLI, 'install', ...args], { cwd: ROOT, env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf-8' });
        expect(result.status, args.join(' ')).not.toBe(0);
        expect(result.stderr, args.join(' ')).toContain('--override');
        expect(fs.readdirSync(home, { recursive: true }).map(String).sort()).toEqual(before);
      }
    });
  }, 60_000);

  test('install --dry-run on a protocol 3 state lists the host-config items of every override and writes nothing', () => {
    withTempHome('repo-harness-install', (home) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
      recordLegacyInstallOwnership([], env);
      const settings = path.join(home, '.claude/settings.json');
      fs.mkdirSync(path.dirname(settings), { recursive: true });
      fs.writeFileSync(settings, '{"statusLine":{"type":"command","command":"user-line"}}\n');
      const hook = hookSelector(routesForHost('claude')[0]!);
      const before = fs.readdirSync(home, { recursive: true }).map(String).sort();
      const state = fs.readFileSync(installStateFixturePath(env));
      const result = spawnSync(process.execPath, [CLI, 'install', '--dry-run', '--json', '--target', 'claude',
        '--override', `${settings}#statusLine`, '--override', `${settings}#${hook}`], { cwd: ROOT, env, encoding: 'utf-8' });
      expect(result.status, result.stderr).toBe(0);
      const items = JSON.parse(result.stdout).host_config.items;
      expect(items).toContainEqual({ path: fs.realpathSync(settings), selector: 'statusLine', action: 'override' });
      expect(items).toContainEqual({ path: fs.realpathSync(settings), selector: hook, action: 'add' });
      expect(fs.readdirSync(home, { recursive: true }).map(String).sort()).toEqual(before);
      expect(fs.readFileSync(installStateFixturePath(env))).toEqual(state);
    });
  }, 30_000);

  test('adapter-only install rejects protocol-1 state before mutating host config', () => {
    withTempHome('repo-harness-install', (home) => {
      const statePath = installStateFixturePath({ HOME: home });
      const hooksPath = path.join(home, '.codex', 'hooks.json');
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify({
        protocol: 1,
        profile: 'standard',
        components: [
          'cli',
          'effective-state',
          'scope-worktree-check-guards',
          'handoff',
          'host-adapters',
          'adaptive-workflow',
          'codegraph-conditional',
        ],
        transaction_id: 'legacy-standard',
        applied_at: '2026-07-14T00:00:00.000Z',
        ownership_manifest: [],
        previous: null,
      }, null, 2)}\n`);
      fs.writeFileSync(hooksPath, `${JSON.stringify({
        theme: 'user-owned',
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'user hook' }] }],
        },
      }, null, 2)}\n`);
      const stateBefore = fs.readFileSync(statePath);
      const hooksBefore = fs.readFileSync(hooksPath);

      const result = spawnSync(process.execPath, [
        CLI,
        'install',
        '--target',
        'codex',
        '--location',
        'global',
      ], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, BUN_INSTALL: path.join(home, '.bun') },
        encoding: 'utf-8',
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain('0.25.x bridge');
      expect(fs.readFileSync(statePath)).toEqual(stateBefore);
      expect(fs.readFileSync(hooksPath)).toEqual(hooksBefore);
    });
  }, 30_000);

  for (const command of ['install', 'uninstall']) {
    for (const target of ['codex', 'claude', 'both']) {
      test(`CLI ${command} --target ${target} rejects local before any configuration read or write`, () => {
        withTempHome('repo-harness-install', (home) => {
          const repo = path.join(home, 'project');
          fs.mkdirSync(repo);
          const files = {
            '.claude/settings.json': '{"theme":"user"}\n',
            '.codex/hooks.json': '{"hooks":{}}\n',
            [path.relative(home, installStateFixturePath({ HOME: home }))]: 'invalid profile state\n',
            'project/.claude/settings.json': '{"permissions":{"allow":["user"]}}\n',
          };
          for (const [relativePath, content] of Object.entries(files)) {
            const filePath = path.join(home, relativePath);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content);
          }
          const before = fs.readdirSync(home, { recursive: true }).sort();
          const result = spawnSync(process.execPath, [CLI, command, '--target', target, '--location', 'local'], {
            cwd: repo,
            env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
            encoding: 'utf-8',
          });
          expect(result.status, result.stderr).toBe(2);
          expect(result.stderr).toContain('invalid --location "local" (expected: global)');
          expect(fs.readdirSync(home, { recursive: true }).sort()).toEqual(before);
          for (const [relativePath, content] of Object.entries(files)) {
            expect(fs.readFileSync(path.join(home, relativePath), 'utf8')).toBe(content);
          }
        });
      }, 30_000);
    }
  }

  for (const target of ['codex', 'claude', 'both']) {
    test(`CLI install --target ${target} --location global --dry-run refuses before any host write`, () => {
      withTempHome('repo-harness-install', (home) => {
        const before = fs.readdirSync(home, { recursive: true }).sort();
        const result = spawnSync(process.execPath, [CLI, 'install', '--target', target, '--location', 'global', '--dry-run'], {
          cwd: ROOT,
          env: { ...process.env, HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
          encoding: 'utf-8',
        });
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('--dry-run cannot be combined with --location');
        expect(fs.readdirSync(home, { recursive: true }).sort()).toEqual(before);
      });
    }, 30_000);
  }

  test('codex --location global creates ~/.codex/hooks.json with 5 matcher-grouped entries', () => {
    withTempHome('repo-harness-install', (home) => {
      const result = runInstall({ target: 'codex', location: 'global' });
      expect(result.exitCode).toBe(0);
      const filePath = path.join(home, '.codex/hooks.json');
      expect(fs.existsSync(filePath)).toBe(true);
      const tomlPath = path.join(home, '.codex/config.toml');
      expect(fs.readFileSync(tomlPath, 'utf-8')).toContain('default_mode_request_user_input = true');

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const entries = data.hooks;
      const total = Object.values(entries as Record<string, unknown[]>).flat().length;
      expect(total).toBe(5);

      expect(entries.PostToolUse).toBeUndefined();
      // Codex has only the edit guard.
      expect((entries.PreToolUse as { matcher?: string }[]).map((e) => e.matcher)).toEqual([
        'Edit|Write',
      ]);
      // UserPromptSubmit has only the inbox.
      expect(entries.SessionStart.length).toBe(1);
      expect(entries.Stop.length).toBe(1);
      expect(entries.UserPromptSubmit.length).toBe(1);
      expect(entries.SubagentStart.length).toBe(1);
      expect(entries.SubagentStop).toBeUndefined();
    });
  });

  test.each(['codex', 'claude'] as const)('%s: every adapter command binds Bun and the installed bundle behind the opt-in check', (host) => {
    withTempHome('repo-harness-install', (home) => {
      expect(runInstall({ target: host, location: 'global' }).exitCode).toBe(0);
      const data = JSON.parse(
        fs.readFileSync(path.join(home, host === 'codex' ? '.codex/hooks.json' : '.claude/settings.json'), 'utf-8'),
      );
      expect(compareManagedHookProjection(data.hooks, host).status).toBe('consistent');
      for (const [event, entries] of Object.entries(data.hooks) as [string, { hooks: { command: string; timeout?: number }[] }[]][]) {
        for (const entry of entries) {
          const hook = entry.hooks[0];
          const cmd = hook.command;
          expect(cmd).toContain('git rev-parse --show-toplevel');
          expect(cmd).toContain('repo-harness-managed-hook-v1');
          expect(cmd).toContain('export HOOK_REPO_ROOT="$repo"');
          expect(cmd).toContain('[ -f "$repo/.ai/harness/workflow-contract.json" ]');
          const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
          expect(cmd).toContain(`exec ${quote(fs.realpathSync(process.execPath))} ${quote(fs.realpathSync(path.join(ROOT, 'dist/hook-entry.js')))} ${event} --route `);
          expect(cmd).not.toContain('&& exit 0');
          expect(cmd).toContain(`HOOK_HOST=${host}`);
          expect(cmd).not.toContain('exec repo-harness hook ');
          expect(cmd).not.toContain('command -v');
          expect(hook.timeout).toBe(30);
        }
      }
      data.hooks.PreToolUse[0].hooks[0].command += ' changed';
      expect(compareManagedHookProjection(data.hooks, host).mismatches).toEqual([
        expect.objectContaining({ kind: 'field-mismatch', field: 'command', routeId: 'edit' }),
      ]);
    });
  });

  test('install refuses an unresolved Bun runtime before writing host configuration', () => {
    withTempHome('repo-harness-install', (home) => {
      const before = fs.readdirSync(home, { recursive: true }).sort();
      const runtime = process.execPath;
      try {
        process.execPath = path.join(home, 'missing-bun');
        const result = runInstall({ target: 'both', location: 'global' });
        expect(result.exitCode).toBe(1);
        expect(result.lines.join('\n')).toContain('Cannot resolve managed hook Bun runtime');
        expect(fs.readdirSync(home, { recursive: true }).sort()).toEqual(before);
      } finally { process.execPath = runtime; }
    });
  });

  test('install refuses a missing global bundle before writing host configuration and names the repair', () => {
    withTempHome('repo-harness-install', (home) => {
      process.env.BUN_INSTALL = path.join(home, 'missing-bun');
      const globalRoot = path.join(process.env.BUN_INSTALL, 'install/global/node_modules/repo-harness');
      fs.mkdirSync(globalRoot, { recursive: true });
      const before = fs.readdirSync(home, { recursive: true }).sort();
      const result = runInstall({ target: 'both', location: 'global' });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain(globalRoot);
      expect(result.lines.join('\n')).toContain('bun add -g repo-harness');
      expect(fs.readdirSync(home, { recursive: true }).sort()).toEqual(before);
    });
  });

  test('codex install is idempotent — second run returns unchanged', () => {
    withTempHome('repo-harness-install', () => {
      const first = runInstall({ target: 'codex', location: 'global' });
      expect(first.lines.some((l) => l.includes('created'))).toBe(true);

      const second = runInstall({ target: 'codex', location: 'global' });
      expect(second.exitCode).toBe(0);
      expect(second.lines.some((l) => l.includes('unchanged'))).toBe(true);
    });
  });

  test('claude --location global creates ~/.claude/settings.json with 6 hooks including the Bash tripwire', () => {
    withTempHome('repo-harness-install', (home) => {
      const result = runInstall({ target: 'claude', location: 'global' });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(
        fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf-8'),
      );
      const total = Object.values(data.hooks as Record<string, unknown[]>).flat().length;
      expect(total).toBe(6);
      expect(data.hooks.PreToolUse.map((entry: { matcher: string }) => entry.matcher)).toEqual(['Edit|Write', 'Agent', 'Bash']);
      expect(data.hooks.UserPromptSubmit.length).toBe(1);
      expect(data.hooks.SubagentStart).toBeUndefined();
      expect(data.hooks.SubagentStop).toBeUndefined();
      for (const [, entries] of Object.entries(data.hooks) as [string, { hooks: { command: string; timeout?: number }[] }[]][]) {
        for (const entry of entries) {
          expect(entry.hooks[0].command).toContain('HOOK_HOST=claude');
          expect(entry.hooks[0].timeout).toBe(30);
        }
      }
    });
  });

  test.each([
    // [case, statusLine before install, statusLine the user sets after install, statusLine after uninstall]
    ['none exists', undefined, undefined, undefined],
    ['an older tagged entry exists', { type: 'command', command: ': repo-harness-managed-hook-v1; exec repo-harness-hook statusline' }, undefined, undefined],
    ['a user status line exists', { type: 'command', command: 'my-line' }, undefined, { type: 'command', command: 'my-line' }],
    ['the user edits the installed one', undefined, { type: 'command', command: 'my-line' }, { type: 'command', command: 'my-line' }],
  ] as const)('claude statusLine when %s: install writes the tagged entry only into an empty or tagged slot, uninstall removes only a tagged one', (_name, existing, edit, remaining) => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.claude/settings.json');
      const userLine = existing !== undefined && !existing.command.startsWith(': repo-harness-managed-hook-v1; ');
      if (existing) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify({ statusLine: existing }, null, 2)}\n`);
      }
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      const owned = { type: 'command', command: `: repo-harness-managed-hook-v1; exec ${quote(fs.realpathSync(process.execPath))} ${quote(fs.realpathSync(path.join(ROOT, 'dist/hook-entry.js')))} statusline` };
      const pipeNote = `[claude] note: statusLine exists and is not changed. To capture Claude quota, set its command to: ${CLAUDE_STATUS_LINE_PIPE}`;
      const first = runInstall({ target: 'claude', location: 'global' });
      expect(first.exitCode).toBe(0);
      const installed = JSON.parse(fs.readFileSync(filePath, 'utf-8')).statusLine;
      if (!userLine) {
        const result = spawnSync('/bin/sh', ['-c', installed.command], {
          cwd: home, env: { ...process.env, HOME: home, PATH: '/usr/bin:/bin' }, input: '{}', encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
      }
      expect(installed).toEqual(userLine ? existing : owned);
      expect(first.lines.includes(pipeNote)).toBe(userLine);
      expect(runInstall({ target: 'claude', location: 'global' }).lines).toEqual([`[claude] unchanged: ${filePath}`, ...(userLine ? [pipeNote] : [])]);
      if (edit) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.writeFileSync(filePath, `${JSON.stringify({ ...data, statusLine: edit }, null, 2)}\n`);
        // The edited entry is the user's: a later install keeps it, and a receipt mutation of the file does not fail.
        expect(runInstall({ target: 'claude', location: 'global' }).lines).toContain(pipeNote);
      }
      // An rh status line that the user edited stays, and uninstall reports it (A9).
      const uninstall = runUninstall({ target: 'claude', location: 'global' });
      expect(uninstall.exitCode, uninstall.lines.join('\n')).toBe(edit ? 1 : 0);
      if (edit) expect(uninstall.lines).toContain(`[unresolved] ${filePath}: changed since rh wrote it; preserved: statusLine`);
      const after = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : {};
      expect(after.statusLine).toEqual(remaining);
      expect(after.hooks).toBeUndefined();
    });
  });

  test('claude install self-heals legacy Codex-only managed entries back to 6 hooks', () => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.claude/settings.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'HOOK_HOST=claude repo-harness hook UserPromptSubmit --route delegation' }] },
            ],
            SubagentStart: [
              { hooks: [{ type: 'command', command: 'HOOK_HOST=claude repo-harness hook SubagentStart --route context' }] },
            ],
            SubagentStop: [
              { hooks: [{ type: 'command', command: 'HOOK_HOST=claude repo-harness hook SubagentStop --route quality' }] },
            ],
          },
        }, null, 2)}\n`,
      );

      const result = runInstall({ target: 'claude', location: 'global' });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const total = Object.values(data.hooks as Record<string, unknown[]>).flat().length;
      expect(total).toBe(6);
      expect(data.hooks.UserPromptSubmit.length).toBe(1);
      // The migration does not prove that rh created the retired event arrays, so they stay, empty.
      expect([data.hooks.SubagentStart, data.hooks.SubagentStop]).toEqual([[], []]);
    });
  });

  test('install preserves sibling non-managed hooks (Phase 0 rtk hook claude case)', () => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.claude/settings.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({
          hooks: {
            PreToolUse: [
              { hooks: [{ type: 'command', command: 'rtk hook claude' }] },
              { hooks: [{ type: 'command', command: 'echo repo-harness hook is documented' }] },
            ],
          },
        }, null, 2)}\n`,
      );
      runInstall({ target: 'claude', location: 'global' });
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const pre = data.hooks.PreToolUse as { hooks: { command: string }[] }[];
      // 2 siblings + 3 managed, including the Bash tripwire.
      expect(pre.length).toBe(5);
      expect(pre.slice(0, 3)).toEqual(buildManagedHooks('claude').PreToolUse);
      expect(pre[3].hooks[0].command).toBe('rtk hook claude');
      expect(pre[4].hooks[0].command).toBe('echo repo-harness hook is documented');
    });
  });

  test('uninstall removes only managed Claude entries and leaves sibling entries intact', () => {
    withTempHome('repo-harness-install', (home) => {
      const filePath = path.join(home, '.claude/settings.json');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        `${JSON.stringify({
          theme: 'dark',
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
          },
        }, null, 2)}\n`,
      );
      runInstall({ target: 'claude', location: 'global' });
      const beforeUninstall = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(beforeUninstall.theme).toBe('dark');
      expect(beforeUninstall.hooks.UserPromptSubmit.length).toBe(2);

      const uninstall = runUninstall({ target: 'claude', location: 'global' });
      expect(uninstall.exitCode).toBe(0);
      expect(uninstall.lines).toContain(`[restored] ${filePath}: host-config ledger: rh text removed`);
      const afterUninstall = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(afterUninstall.theme).toBe('dark');
      expect(afterUninstall.hooks.UserPromptSubmit).toEqual([
        { hooks: [{ type: 'command', command: 'rtk hook claude' }] },
      ]);
    });
  });

  test('install and uninstall keep private host config modes under a 0022 umask', () => {
    withTempHome('repo-harness-install', (home) => {
      const claudePath = path.join(home, '.claude/settings.json');
      const codexPath = path.join(home, '.codex/hooks.json');
      const sibling = { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } };
      for (const filePath of [claudePath, codexPath]) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${JSON.stringify(sibling, null, 2)}\n`, { mode: 0o600 });
        fs.chmodSync(filePath, 0o600);
      }
      const previousUmask = process.umask(0o022);
      try {
        expect(runInstall({ target: 'both', location: 'global' }).exitCode).toBe(0);
        for (const filePath of [claudePath, codexPath]) {
          expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).hooks.PreToolUse.length).toBeGreaterThan(1);
          expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
        }
        expect(runUninstall({ target: 'both', location: 'global' }).exitCode).toBe(0);
        for (const filePath of [claudePath, codexPath]) {
          expect(JSON.parse(fs.readFileSync(filePath, 'utf-8')).hooks).toEqual(sibling.hooks);
          expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
        }
      } finally {
        process.umask(previousUmask);
      }
    });
  });

  test('uninstall removes managed Codex entries and reverses installer TOML', () => {
    withTempHome('repo-harness-install', (home) => {
      const result = runInstall({ target: 'codex', location: 'global' });
      expect(result.exitCode).toBe(0);
      const hooksPath = path.join(home, '.codex/hooks.json');
      const tomlPath = path.join(home, '.codex/config.toml');
      expect(fs.existsSync(hooksPath)).toBe(true);
      expect(fs.existsSync(tomlPath)).toBe(true);

      const uninstall = runUninstall({ target: 'codex', location: 'global' });
      expect(uninstall.exitCode).toBe(0);
      expect(uninstall.lines).toContain(`[restored] ${hooksPath}: host-config ledger: rh created this file`);


      expect(fs.existsSync(hooksPath)).toBe(false);
      expect(fs.existsSync(tomlPath)).toBe(false);
    });
  });

  test('uninstall is idempotent when no managed entries exist', () => {
    withTempHome('repo-harness-install', () => {
      runInstall({ target: 'both', location: 'global' });
      const first = runUninstall({ target: 'both', location: 'global' });
      expect(first.exitCode).toBe(0);
      expect(first.lines.some((l) => l.includes('[restored]'))).toBe(true);

      const second = runUninstall({ target: 'both', location: 'global' });
      expect(second.exitCode).toBe(0);
      expect(second.lines.some((l) => l.includes('[restored]') || l.includes('[reverted]'))).toBe(false);
    });
  });

  test('both --location global installs to both targets', () => {
    withTempHome('repo-harness-install', (home) => {
      const result = runInstall({ target: 'both', location: 'global' });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(home, '.codex/hooks.json'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.claude/settings.json'))).toBe(true);
      // Both targets each emit at least one created/updated line
      expect(result.lines.filter((l) => l.startsWith('[codex]')).length).toBeGreaterThan(0);
      expect(result.lines.filter((l) => l.startsWith('[claude]')).length).toBeGreaterThan(0);
    });
  });

  test('CLI global install and uninstall work for both hosts', () => {
    withTempHome('repo-harness-install', (home) => {
      const install = spawnSync('bun', [CLI, 'install', '--target', 'both', '--location', 'global'], {
        cwd: ROOT,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      expect(install.status).toBe(0);
      const claudePath = path.join(home, '.claude/settings.json');
      const codexPath = path.join(home, '.codex/hooks.json');
      expect(fs.existsSync(claudePath)).toBe(true);
      expect(fs.existsSync(codexPath)).toBe(true);

      const uninstall = spawnSync('bun', [CLI, 'uninstall', '--location', 'global'], {
        cwd: ROOT,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      expect(uninstall.status).toBe(0);
      expect(uninstall.stdout).toContain(`[restored] ${codexPath}: host-config ledger: rh created this file`);
      expect(uninstall.stdout).toContain(`[restored] ${claudePath}: host-config ledger: rh created this file`);
      expect(fs.existsSync(claudePath)).toBe(false);
      expect(fs.existsSync(codexPath)).toBe(false);
    });
  }, 30_000);

  test('CLI install without required core surfaces fails closed and compensates adapters', () => {
    withTempHome('repo-harness-install', (home) => {
      const claude = writeReadyOfficialCodexPluginCli(home);
      const install = spawnSync(
        'bun',
        [
          CLI,
          'install',
          '--plugins',
          'architecture,cross-review,mcp,peer-runtime,platform,product,strategy-memory',
          '--target',
          'codex',
          '--no-cli',
          '--no-sync-skill',
          '--no-external-skills',
          '--no-codegraph',
        ],
        {
          cwd: ROOT,
          env: { ...process.env, HOME: home, REPO_HARNESS_CLAUDE_EXECUTABLE: claude },
          encoding: 'utf-8',
        },
      );
      expect(install.status).not.toBe(0);
      expect(`${install.stdout}\n${install.stderr}`).toContain('install projection is incomplete');
      expect(fs.existsSync(path.join(home, '.codex/hooks.json'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.repo-harness/install-state.json'))).toBe(false);
    });
  }, 30_000);
});

describe('install native Codex delegation authority', () => {
  test('adapter-only install exposes no delegation-mode compatibility option or config write', () => {
    withTempHome('repo-harness-install', (home) => {
      const help = spawnSync('bun', [CLI, 'install', '--help'], {
        cwd: ROOT,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      expect(help.status).toBe(0);
      expect(help.stdout).not.toContain('--delegation-mode');

      const install = spawnSync('bun', [CLI, 'install', '--target', 'codex', '--location', 'global'], {
        cwd: ROOT,
        env: { ...process.env, HOME: home },
        encoding: 'utf-8',
      });
      expect(install.status).toBe(0);
      expect(fs.existsSync(path.join(home, '.codex/hooks.json'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.repo-harness', 'config.json'))).toBe(false);
    });
  }, 30_000);
});

describe('managed-first hook order', () => {
  for (const host of ['codex', 'claude'] as const) {
    const relative = host === 'codex' ? '.codex/hooks.json' : '.claude/settings.json';
    test(`${host}: keep managed blocks where they are, preserve duplicate and empty user blocks, then rerun without writes or notice`, () => {
      withTempHome('repo-harness-install', home => {
        const file = path.join(home, relative);
        const managed = buildManagedHooks(host);
        const user = { matcher: 'custom', metadata: { keep: true }, hooks: [
          { type: 'command', command: 'echo same', timeout: 9, statusMessage: 'User guard' },
          { type: 'command', command: 'echo same', timeout: 9, statusMessage: 'User guard' },
        ] };
        const empty = { matcher: 'empty', hooks: [], label: 'Keep user empty block' };
        // A text edit never moves an entry: managed entries of an earlier install keep their place.
        const hooks = { ...managed, SessionStart: [user, user, ...managed.SessionStart],
          PreToolUse: [empty, ...managed.PreToolUse], UserEvent: [empty, user], EmptyUserEvent: [] };
        const original = JSON.stringify({ theme: 'user', hooks });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, original);
        const result = runInstall({ target: host, location: 'global' });
        expect(result.exitCode).toBe(0);
        const installed = fs.readFileSync(file, 'utf8');
        const after = JSON.parse(installed);
        expect(after.theme).toBe('user');
        expect(after.hooks.SessionStart).toEqual([user, user, ...managed.SessionStart]);
        expect(after.hooks.PreToolUse).toEqual([empty, ...managed.PreToolUse]);
        expect(after.hooks.UserEvent).toEqual([empty, user]);
        expect(after.hooks.EmptyUserEvent).toEqual([]);
        // The source objects must also keep their commands and metadata.
        expect(JSON.stringify({ theme: 'user', hooks })).toBe(original);
        // The managed entries were already in place, so the hook file is not written and Codex asks for no review.
        expect(result.lines.join('\n').includes('enter /hooks')).toBe(false);
        const rerun = runInstall({ target: host, location: 'global' });
        expect(rerun.exitCode).toBe(0);
        expect(rerun.lines.every(line => line.includes('unchanged:'))).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toBe(installed);
      });
    });

    for (const withUsers of [false, true]) {
      test(`${host}: fresh install ${withUsers ? 'with existing user hooks' : 'without user hooks'} puts managed blocks first`, () => {
        withTempHome('repo-harness-install', home => {
          const file = path.join(home, relative);
          const user = { matcher: 'custom', hooks: [{ type: 'command', command: 'echo fresh user', timeout: 3 }] };
          if (withUsers) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [user], UserEvent: [{ hooks: [] }] } }));
          }
          const result = runInstall({ target: host, location: 'global' });
          expect(result.exitCode).toBe(0);
          const after = JSON.parse(fs.readFileSync(file, 'utf8'));
          // Every Codex created or updated write prints the /hooks review step; Claude prints none.
          expect(result.lines.some(line => line.includes('enter /hooks'))).toBe(host === 'codex');
          if (withUsers) {
            expect(after.hooks.SessionStart).toEqual([...buildManagedHooks(host).SessionStart, user]);
            expect(after.hooks.UserEvent).toEqual([{ hooks: [] }]);
          } else {
            expect(after.hooks.SessionStart).toEqual(buildManagedHooks(host).SessionStart);
          }
        });
      });
    }
  }
});
