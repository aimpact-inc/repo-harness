import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHCTX_COMMAND_DISPOSITIONS, ARCHCTX_REQUIRED_VERSION, archctxRefusal } from '../../src/core/architecture/projection';
import { indexPackageLocalCodeGraph, resolveCompatibleNodeRuntime, resolvePackageLocalArchctx, runArchctxPassThrough } from '../../src/effects/architecture/archctx-provider';
import { pluginSelectionEnv, recordPluginSelection } from '../helpers/install-ownership';
import { MODULE_DOC, MODULE_ID, MODULE_NODE, fixtureCommit, fixtureGit, fixtureWrite, fixtureYaml, moduleRepository } from '../helpers/module-repository';

const ROOT = join(import.meta.dir, '..', '..');
const CLI = join(ROOT, 'src', 'cli', 'index.ts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A package-local archctx at the required version: `resolve` exits by path, other commands record their argv. */
function fakeConsumer(): { root: string; argvFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'repo-harness-arch-'));
  roots.push(root);
  const packageRoot = join(root, 'node_modules', 'archctx');
  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: 'archctx', version: ARCHCTX_REQUIRED_VERSION, engines: { node: '>=22.22 <26' }, bin: { archctx: './bin/archctx' } })}\n`);
  const argvFile = join(root, 'argv.json');
  const binary = join(packageRoot, 'bin', 'archctx');
  writeFileSync(binary, `#!/usr/bin/env node
const [command, ...rest] = process.argv.slice(2);
if (command === 'capabilities') {
  console.log(JSON.stringify({ schemaVersion: 'archcontext.capabilities/v1', package: { name: 'archctx', version: ${JSON.stringify(ARCHCTX_REQUIRED_VERSION)} } }));
} else if (command === 'resolve') {
  process.exit(rest.includes('unowned') ? 1 : 2);
} else {
  require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify([command, ...rest]));
  process.exit(7);
}
`);
  chmodSync(binary, 0o755);
  return { root, argvFile };
}

describe('rh arch', () => {
  test('the disposition table has one entry for each command of the pinned archctx help', () => {
    const { binaryPath } = resolvePackageLocalArchctx();
    const help = JSON.parse(execFileSync(resolveCompatibleNodeRuntime(process.env), [binaryPath, 'help', '--json'], { encoding: 'utf8' })) as { data: { commands: string[] } };
    expect(Object.keys(ARCHCTX_COMMAND_DISPOSITIONS).sort()).toEqual([...help.data.commands, 'docs'].sort());
  });

  test('refuses an unknown, owned or refused command and lets the read-only projection subcommands through', () => {
    expect(archctxRefusal(['nosuch'])).toBe('arch_command_unknown: nosuch');
    expect(archctxRefusal(['install', '--host', 'codex'])).toBe('arch_command_refused: install. Use: rh install');
    for (const removed of ['daemon', 'ledger', 'audit', 'investigate', 'agents', 'jobs']) {
      expect(archctxRefusal([removed, 'status'])).toBe(`arch_command_unknown: ${removed}`);
    }
    expect(archctxRefusal(['hook', 'enqueue'])).toBe('arch_command_refused: hook. Use: rh install');
    for (const owned of ['recommendations', 'scan', 'decide']) {
      expect(archctxRefusal([owned])).toBe(`arch_command_owned: ${owned}. Use: rh arch refactor`);
    }
    expect(archctxRefusal(['projection', 'run'])).toBe('arch_command_owned: projection run. Use: rh arch projection check|plan|apply');
    for (const removedSub of ['nosuch', 'recover', 'readback']) {
      expect(archctxRefusal(['projection', removedSub])).toBe(`arch_command_unknown: projection ${removedSub}`);
    }
    for (const sub of ['snapshot', 'freshness', 'publish-status', 'verify-pr']) expect(archctxRefusal(['projection', sub, '--json'])).toBeNull();
    for (const pass of ['validate', 'index', 'check', 'model']) expect(archctxRefusal([pass, '--json'])).toBeNull();
    const syncRefusal = 'arch_command_owned: sync. Use: rh arch projection apply (or rh arch sync --check)';
    for (const writeSync of [['sync'], ['sync', '--json'], ['sync', '--no-instructions'], ['sync', '--changed', '--check'], ['sync', '--', '--check']]) {
      expect(archctxRefusal(writeSync)).toBe(syncRefusal);
    }
    for (const readonlySync of [['sync', '--check'], ['sync', '--check', '--json'], ['sync', '--check', '--no-instructions'], ['sync', '--help'], ['sync', '-h']]) {
      expect(archctxRefusal(readonlySync)).toBeNull();
    }
  });

  test('passes the arguments unchanged and returns the archctx exit code', () => {
    const { root, argvFile } = fakeConsumer();
    const options = { consumerRoot: root, policy: { provider: 'archctx', applyMode: 'manual', requiredVersion: ARCHCTX_REQUIRED_VERSION, timeoutMs: 120_000 } } as const;
    expect(runArchctxPassThrough(root, ['validate', '--format', 'json'], options)).toBe(7);
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(['validate', '--format', 'json']);
    expect(runArchctxPassThrough(root, ['resolve', '--path', 'unowned'], options)).toBe(1);
    expect(runArchctxPassThrough(root, ['resolve', '--path', 'ambiguous'], options)).toBe(2);
  });

  test('the command starts no process for a refusal and needs the architecture plugin', () => {
    const run = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(process.execPath, [CLI, 'arch', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
    const selected = pluginSelectionEnv(['architecture']);
    expect(run(selected, 'nosuch')).toMatchObject({ status: 2, stderr: 'arch_command_unknown: nosuch\n' });
    expect(run(selected, 'install', '--host', 'codex').status).toBe(2);
    expect(run(selected, 'daemon')).toMatchObject({ status: 2, stderr: 'arch_command_unknown: daemon\n' });
    expect(run(selected, 'scan')).toMatchObject({ status: 2, stderr: 'arch_command_owned: scan. Use: rh arch refactor\n' });
    expect(run(selected, 'hook')).toMatchObject({ status: 2, stderr: 'arch_command_refused: hook. Use: rh install\n' });
    const without = run(pluginSelectionEnv([]), 'validate');
    expect(without.status).not.toBe(0);
    expect(without.stderr).toContain('install_plugin_unavailable');
  });

  test('projection slice links the renamed base document and marks a new capability absent at base', () => {
    const root = realpathSync(moduleRepository());
    roots.push(root);
    const env = { ...process.env, HOME: join(root, 'home') };
    recordPluginSelection(env);
    fixtureWrite(root, 'home/.repo-harness/config.json', JSON.stringify({ architecture: { projection_provider: 'archctx', projection_apply: 'manual' } }));
    const policy = { provider: 'archctx', applyMode: 'manual', requiredVersion: ARCHCTX_REQUIRED_VERSION, timeoutMs: 30_000 } as const;
    fixtureGit(root, ['remote', 'add', 'origin', 'https://github.com/test/slice.git']);
    fixtureWrite(root, '.gitignore', '.codegraph/\nhome/\n');
    const manifestPath = 'docs/architecture/.projection-manifest.json';
    const manifest = JSON.parse(readFileSync(join(ROOT, manifestPath), 'utf8'));
    const priorDoc = 'docs/architecture/modules/capability-test-module.md';
    renameSync(join(root, MODULE_DOC), join(root, priorDoc));
    const recordDocument = (profile: string, path: string) => fixtureWrite(root, manifestPath, JSON.stringify({
      ...manifest, profile, semanticBaseline: { ...manifest.semanticBaseline, capabilities: [] }, targets: {
        'projection_target.entity.capability-test-module': {
          type: 'entity-summary', scope: { kind: 'entity', id: MODULE_ID, entityKind: 'capability' },
          path, ownership: 'mixed', format: 'markdown', outputDigest: `sha256:${'a'.repeat(64)}`,
        },
      },
    }));
    recordDocument('default', priorDoc);
    const base = fixtureCommit(root);
    execFileSync('git', ['branch', 'review-base', base], {
      cwd: root, env: { ...env, GIT_COMMITTER_DATE: new Date(Date.now() - 7_200_000).toISOString() },
    });
    renameSync(join(root, priorDoc), join(root, MODULE_DOC));
    recordDocument('repo-harness/v1', MODULE_DOC);
    const node = readFileSync(join(root, MODULE_NODE), 'utf8');
    fixtureWrite(root, MODULE_NODE, node.replace('entrypoint.module.read', 'entrypoint.module.read-updated'));
    const newId = 'capability.test.added';
    fixtureWrite(root, `.archcontext/model/nodes/${newId}.yaml`, fixtureYaml({
      ...JSON.parse(node), id: newId, source: { include: ['src/added/**'] },
    }));
    fixtureWrite(root, 'docs/architecture/modules/test/added.md', '# Added\n');
    const head = fixtureCommit(root);
    fixtureGit(root, ['update-ref', 'refs/heads/review-base', head, base]);
    const baseRef = 'review-base@{1 hour ago}';
    expect(fixtureGit(root, ['rev-parse', '--verify', baseRef])).toBe(base);
    indexPackageLocalCodeGraph(root, { policy });
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'arch', 'projection', 'slice', '--base', baseRef, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000,
    });
    const markdown = run();
    expect(markdown.status, markdown.stderr + markdown.stdout).toBe(0);
    const json = run('--json');
    expect(json.status, json.stderr + json.stdout).toBe(0);
    const envelope = JSON.parse(json.stdout);
    expect(envelope).toMatchObject({ schemaVersion: 'archcontext.envelope/v1', ok: true });
    const { data } = envelope;
    expect(data).toMatchObject({ base, baseSha: base, headSha: head, changed: true });
    expect(data.affectedCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capabilityId: MODULE_ID, modulePath: MODULE_DOC, diagramMermaid: expect.any(String) }),
      expect.objectContaining({ capabilityId: newId, modulePath: 'docs/architecture/modules/test/added.md' }),
    ]));
    expect(markdown.stdout).toContain(`https://github.com/test/slice/blob/${base}/${priorDoc}`);
    expect(markdown.stdout).toContain(`Capability document absent at base \`${base}\`.`);
    expect(markdown.stdout).not.toContain(`/blob/${base}/${MODULE_DOC}`);
    expect(markdown.stdout).not.toContain(`/blob/${base}/docs/architecture/modules/test/added.md`);
    expect(markdown.stdout).toContain(data.affectedCapabilities.find((entry: { capabilityId: string }) => entry.capabilityId === MODULE_ID).diagramMermaid);
    expect(markdown.stdout).toContain('entrypoint.module.read-updated');
    expect(fixtureGit(root, ['status', '--porcelain'])).toBe('');
  }, 60_000);

  test('the architecture commands run under rh arch, and their old top-level names are unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'repo-harness-arch-cli-'));
    roots.push(root);
    const home = join(root, 'home');
    mkdirSync(join(home, '.repo-harness'), { recursive: true });
    writeFileSync(join(home, '.repo-harness', 'config.json'), JSON.stringify({ architecture: { projection_provider: 'archctx', projection_apply: 'manual' } }));
    recordPluginSelection({ HOME: home });
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 30_000 });
    // archctx answers verify-pr itself; outside a Git worktree it reports its own error.
    const verify = run('arch', 'projection', 'verify-pr', '--base', 'origin/main', '--json');
    expect(JSON.parse(verify.stdout)).toMatchObject({ schemaVersion: 'archcontext.envelope/v1', requestId: 'projection.verify-pr' });
    expect(run('arch', 'projection', 'run', '--request-json', '{}')).toMatchObject({ status: 2, stderr: 'arch_command_owned: projection run. Use: rh arch projection check|plan|apply\n' });
    for (const args of [['architecture-projection', 'status', '--json'], ['architecture-debt'], ['module', 'list'], ['refactor', 'recommendations'], ['tools', 'ensure', 'codegraph']]) {
      expect(run(...args)).toMatchObject({ status: 1, stderr: `error: unknown command '${args[0]}'\n` });
    }
  }, 60_000);

  test('public CLI refuses write-mode sync, enforces disabled projection apply, and preserves ignored files under .archcontext/generated', () => {
    const root = realpathSync(moduleRepository());
    roots.push(root);
    const home = join(root, '.test-home');
    const stateDir = join(root, '.test-state');
    const env = { ...process.env, HOME: home, ARCHCONTEXT_STATE_DIR: stateDir };
    recordPluginSelection(env);
    fixtureWrite(root, '.test-home/.repo-harness/config.json', JSON.stringify({ architecture: { projection_provider: 'archctx', projection_apply: 'disabled' } }));
    fixtureWrite(root, '.archcontext/product.yaml', fixtureYaml({
      schemaVersion: 'archcontext.product/v1', id: 'product.sync.test', name: 'sync test', purpose: 'Test sync authorization.',
      capabilities: ['test'], nonGoals: [], riskDomains: [], successCriteria: ['Sync check stays read-only.'],
      users: [{ description: 'Developer.', id: 'developer' }],
    }));
    fixtureWrite(root, '.gitignore', '.codegraph/\n.test-home/\n.test-state/\n.archcontext/generated/\n');
    fixtureCommit(root);
    const userFile = join(root, '.archcontext/generated/user-notes.txt');
    fixtureWrite(root, '.archcontext/generated/user-notes.txt', 'keep user notes\n');
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, 'arch', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30_000 });

    expect(run('sync')).toMatchObject({
      status: 2,
      stderr: 'arch_command_owned: sync. Use: rh arch projection apply (or rh arch sync --check)\n',
    });
    expect(run('sync', '--changed', '--check').status).toBe(2);
    expect(readFileSync(userFile, 'utf8')).toBe('keep user notes\n');

    const disabledApply = run('projection', 'apply', '--json');
    expect(disabledApply.status).not.toBe(0);
    expect(`${disabledApply.stderr}\n${disabledApply.stdout}`).toContain('architecture projection apply is disabled');
    expect(readFileSync(userFile, 'utf8')).toBe('keep user notes\n');

    const check = run('sync', '--check', '--json');
    expect([0, 2]).toContain(check.status ?? -1);
    expect(readFileSync(userFile, 'utf8')).toBe('keep user notes\n');
  }, 60_000);

  test('public CLI rh arch index seed enforces safe CodeGraph destination preflight before invoking archctx and succeeds on clean repos', () => {
    const makeRepo = (name: string) => {
      const repo = realpathSync(moduleRepository());
      roots.push(repo);
      const home = mkdtempSync(join(tmpdir(), `repo-harness-seed-home-${name}-`));
      roots.push(home);
      const stateDir = mkdtempSync(join(tmpdir(), `repo-harness-seed-state-${name}-`));
      roots.push(stateDir);
      const env = { ...process.env, HOME: home, ARCHCONTEXT_STATE_DIR: stateDir };
      recordPluginSelection(env);
      writeFileSync(join(home, '.repo-harness/config.json'), JSON.stringify({ architecture: { projection_provider: 'archctx', projection_apply: 'manual' } }));
      fixtureWrite(repo, '.gitignore', '.codegraph/\n');
      fixtureCommit(repo);
      return { repo, env };
    };
    const runSeed = (cwd: string, env: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [CLI, 'arch', 'index', 'seed', '--json'], { cwd, env, encoding: 'utf8', timeout: 60_000 });

    // 1. Symlinked .codegraph refused without touching external target.
    const symlinkCase = makeRepo('symlink');
    const externalDir = mkdtempSync(join(tmpdir(), 'repo-harness-seed-target-'));
    roots.push(externalDir);
    symlinkSync(externalDir, join(symlinkCase.repo, '.codegraph'));
    const symlinkRes = runSeed(symlinkCase.repo, symlinkCase.env);
    expect(symlinkRes.status).toBe(1);
    expect(symlinkRes.stderr).toContain('.codegraph must be a regular directory');
    expect(lstatSync(join(symlinkCase.repo, '.codegraph')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(externalDir, 'codegraph.db'))).toBe(false);

    // 2. Non-directory .codegraph refused.
    const fileCase = makeRepo('file');
    writeFileSync(join(fileCase.repo, '.codegraph'), 'plain-file\n');
    const fileRes = runSeed(fileCase.repo, fileCase.env);
    expect(fileRes.status).toBe(1);
    expect(fileRes.stderr).toContain('.codegraph must be a regular directory');
    expect(readFileSync(join(fileCase.repo, '.codegraph'), 'utf8')).toBe('plain-file\n');

    // 3. Occupied .codegraph without codegraph.db refused, including from a nested subdirectory.
    const occupiedCase = makeRepo('occupied');
    mkdirSync(join(occupiedCase.repo, '.codegraph'), { recursive: true });
    writeFileSync(join(occupiedCase.repo, '.codegraph/user.txt'), 'keep me\n');
    const subDir = join(occupiedCase.repo, 'src/module');
    const occupiedRes = runSeed(subDir, occupiedCase.env);
    expect(occupiedRes.status).toBe(1);
    expect(occupiedRes.stderr).toContain('occupied without codegraph.db');
    expect(readFileSync(join(occupiedCase.repo, '.codegraph/user.txt'), 'utf8')).toBe('keep me\n');
    expect(existsSync(join(occupiedCase.repo, '.codegraph/codegraph.db'))).toBe(false);

    // 4. Symlinked codegraph.db refused.
    const dbLinkCase = makeRepo('dblink');
    const externalDb = join(externalDir, 'external.db');
    writeFileSync(externalDb, 'external-db');
    mkdirSync(join(dbLinkCase.repo, '.codegraph'), { recursive: true });
    symlinkSync(externalDb, join(dbLinkCase.repo, '.codegraph/codegraph.db'));
    const dbLinkRes = runSeed(dbLinkCase.repo, dbLinkCase.env);
    expect(dbLinkRes.status).toBe(1);
    expect(dbLinkRes.stderr).toContain('.codegraph/codegraph.db must be a regular file');
    expect(lstatSync(join(dbLinkCase.repo, '.codegraph/codegraph.db')).isSymbolicLink()).toBe(true);

    // 5. Symlinked .codegraph/.gitignore refused.
    const ignoreLinkCase = makeRepo('ignorelink');
    const externalIgnore = join(externalDir, 'external.gitignore');
    writeFileSync(externalIgnore, '# CodeGraph data files\n*.db\n');
    mkdirSync(join(ignoreLinkCase.repo, '.codegraph'), { recursive: true });
    writeFileSync(join(ignoreLinkCase.repo, '.codegraph/codegraph.db'), 'db-bytes');
    symlinkSync(externalIgnore, join(ignoreLinkCase.repo, '.codegraph/.gitignore'));
    const ignoreLinkRes = runSeed(ignoreLinkCase.repo, ignoreLinkCase.env);
    expect(ignoreLinkRes.status).toBe(1);
    expect(ignoreLinkRes.stderr).toContain('.codegraph/.gitignore must be a regular file');
    expect(readFileSync(externalIgnore, 'utf8')).toBe('# CodeGraph data files\n*.db\n');

    // 6. Stale-default .codegraph/.gitignore that CodeGraph would overwrite refused.
    const staleIgnoreCase = makeRepo('staleignore');
    mkdirSync(join(staleIgnoreCase.repo, '.codegraph'), { recursive: true });
    writeFileSync(join(staleIgnoreCase.repo, '.codegraph/codegraph.db'), 'db-bytes');
    writeFileSync(join(staleIgnoreCase.repo, '.codegraph/.gitignore'), '# CodeGraph data files\n*.db\n');
    const staleIgnoreRes = runSeed(staleIgnoreCase.repo, staleIgnoreCase.env);
    expect(staleIgnoreRes.status).toBe(1);
    expect(staleIgnoreRes.stderr).toContain('stale-default pattern');
    expect(readFileSync(join(staleIgnoreCase.repo, '.codegraph/.gitignore'), 'utf8')).toBe('# CodeGraph data files\n*.db\n');

    // 7. Valid clean repository succeeds through public CLI.
    const cleanCase = makeRepo('clean');
    const cleanRes = runSeed(cleanCase.repo, cleanCase.env);
    expect(cleanRes.status, `${cleanRes.stderr}\n${cleanRes.stdout}`).toBe(0);
    expect(JSON.parse(cleanRes.stdout)).toMatchObject({
      schemaVersion: 'archcontext.envelope/v1',
      ok: true,
      requestId: 'index.seed',
      data: { schemaVersion: 'archcontext.index-seed/v1', worktreeRole: 'primary' },
    });
    expect(lstatSync(join(cleanCase.repo, '.codegraph/codegraph.db')).isFile()).toBe(true);
  }, 120_000);
});
