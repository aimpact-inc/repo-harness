import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      fixtureWrite(repo, '.archcontext/product.yaml', fixtureYaml({
        schemaVersion: 'archcontext.product/v1', id: `product.seed.${name}`, name: `seed ${name}`, purpose: 'Test seed and read-only CodeGraph opens.',
        capabilities: ['test'], nonGoals: [], riskDomains: [], successCriteria: ['Read-only commands leave no SQLite sidecars.'],
        users: [{ description: 'Developer.', id: 'developer' }],
      }));
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
    const writeCodeGraphSchemaDb = (dbPath: string) => {
      const db = new Database(dbPath);
      try {
        db.exec(`
          CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
          INSERT INTO schema_versions (version, applied_at, description) VALUES (1, 1, 'init');
          CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, updated_at INTEGER NOT NULL);
          CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL);
          CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL);
          CREATE TABLE unresolved_refs (id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id TEXT NOT NULL);
          CREATE TABLE name_segment_vocab (segment TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (segment, name)) WITHOUT ROWID;
          CREATE TABLE synthesis_inputs (file_path TEXT PRIMARY KEY);
          CREATE TABLE project_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        `);
      } finally {
        db.close();
      }
    };
    const ignoreLinkCase = makeRepo('ignorelink');
    const externalIgnore = join(externalDir, 'external.gitignore');
    writeFileSync(externalIgnore, '# CodeGraph data files\n*.db\n');
    mkdirSync(join(ignoreLinkCase.repo, '.codegraph'), { recursive: true });
    writeCodeGraphSchemaDb(join(ignoreLinkCase.repo, '.codegraph/codegraph.db'));
    symlinkSync(externalIgnore, join(ignoreLinkCase.repo, '.codegraph/.gitignore'));
    const ignoreLinkRes = runSeed(ignoreLinkCase.repo, ignoreLinkCase.env);
    expect(ignoreLinkRes.status).toBe(1);
    expect(ignoreLinkRes.stderr).toContain('.codegraph/.gitignore must be a regular file');
    expect(readFileSync(externalIgnore, 'utf8')).toBe('# CodeGraph data files\n*.db\n');

    // 6. Stale-default .codegraph/.gitignore that CodeGraph would overwrite refused.
    const staleIgnoreCase = makeRepo('staleignore');
    mkdirSync(join(staleIgnoreCase.repo, '.codegraph'), { recursive: true });
    writeCodeGraphSchemaDb(join(staleIgnoreCase.repo, '.codegraph/codegraph.db'));
    writeFileSync(join(staleIgnoreCase.repo, '.codegraph/.gitignore'), '# CodeGraph data files\n*.db\n');
    const staleIgnoreRes = runSeed(staleIgnoreCase.repo, staleIgnoreCase.env);
    expect(staleIgnoreRes.status).toBe(1);
    expect(staleIgnoreRes.stderr).toContain('stale-default pattern');
    expect(readFileSync(join(staleIgnoreCase.repo, '.codegraph/.gitignore'), 'utf8')).toBe('# CodeGraph data files\n*.db\n');

    // 7. Non-SQLite user file at .codegraph/codegraph.db refused without modifying bytes.
    const foreignDbCase = makeRepo('foreigndb');
    mkdirSync(join(foreignDbCase.repo, '.codegraph'), { recursive: true });
    writeFileSync(join(foreignDbCase.repo, '.codegraph/codegraph.db'), 'not-a-sqlite-database\n');
    const foreignDbRes = runSeed(foreignDbCase.repo, foreignDbCase.env);
    expect(foreignDbRes.status).toBe(1);
    expect(foreignDbRes.stderr).toContain('not a valid SQLite 3 database');
    expect(readFileSync(join(foreignDbCase.repo, '.codegraph/codegraph.db'), 'utf8')).toBe('not-a-sqlite-database\n');

    // 7b. Real pinned-provider test: foreign SQLite DB WITH a `nodes` table is refused without writes or sidecars.
    const foreignNodesCase = makeRepo('foreignnodes');
    const foreignNodesDir = join(foreignNodesCase.repo, '.codegraph');
    mkdirSync(foreignNodesDir, { recursive: true });
    const foreignNodesPath = join(foreignNodesDir, 'codegraph.db');
    const foreignNodesDb = new Database(foreignNodesPath);
    foreignNodesDb.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT); INSERT INTO nodes VALUES ("u1", "keep");');
    foreignNodesDb.close();
    const foreignBytesBefore = readFileSync(foreignNodesPath);
    const foreignEntriesBefore = readdirSync(foreignNodesDir).sort();
    const foreignNodesRes = runSeed(foreignNodesCase.repo, foreignNodesCase.env);
    expect(foreignNodesRes.status).toBe(1);
    expect(foreignNodesRes.stderr).toContain('CodeGraph 1.6.4 schema');
    expect(readFileSync(foreignNodesPath)).toEqual(foreignBytesBefore);
    expect(readdirSync(foreignNodesDir).sort()).toEqual(foreignEntriesBefore);

    // 8. Valid clean repository succeeds through public CLI (stripping caller CODEGRAPH_DIR) and refreshes on a second run.
    const cleanCase = makeRepo('clean');
    const cleanRes = runSeed(cleanCase.repo, { ...cleanCase.env, CODEGRAPH_DIR: '.codegraph-custom' });
    expect(cleanRes.status, `${cleanRes.stderr}\n${cleanRes.stdout}`).toBe(0);
    expect(JSON.parse(cleanRes.stdout)).toMatchObject({
      schemaVersion: 'archcontext.envelope/v1',
      ok: true,
      requestId: 'index.seed',
      data: { schemaVersion: 'archcontext.index-seed/v1', worktreeRole: 'primary' },
    });
    expect(lstatSync(join(cleanCase.repo, '.codegraph/codegraph.db')).isFile()).toBe(true);
    expect(existsSync(join(cleanCase.repo, '.codegraph-custom'))).toBe(false);

    // Second primary refresh against the real CodeGraph 1.6.4 initialized DB passes schema verification and succeeds.
    const refreshRes = runSeed(cleanCase.repo, cleanCase.env);
    expect(refreshRes.status, `${refreshRes.stderr}\n${refreshRes.stdout}`).toBe(0);
    expect(JSON.parse(refreshRes.stdout)).toMatchObject({
      schemaVersion: 'archcontext.envelope/v1',
      ok: true,
      requestId: 'index.seed',
      data: { schemaVersion: 'archcontext.index-seed/v1', mode: 'primary-refresh', worktreeRole: 'primary' },
    });

    // 8b. Real pinned-provider test: nested Git checkout with schemaless SQLite DB inside an initialized parent checkout
    // refuses before CodeGraph can walk up to the parent and overwrite parent's stale-default .codegraph/.gitignore.
    const parentIgnorePath = join(cleanCase.repo, '.codegraph/.gitignore');
    const originalParentIgnore = readFileSync(parentIgnorePath, 'utf8');
    writeFileSync(parentIgnorePath, '# CodeGraph data files\n*.db\n');
    const parentDbBefore = readFileSync(join(cleanCase.repo, '.codegraph/codegraph.db'));
    const nestedChild = join(cleanCase.repo, 'nested-child');
    mkdirSync(join(nestedChild, '.codegraph'), { recursive: true });
    fixtureGit(nestedChild, ['init', '-q']);
    fixtureWrite(nestedChild, 'index.ts', 'export const child = 1;\n');
    fixtureCommit(nestedChild);
    const childDbPath = join(nestedChild, '.codegraph/codegraph.db');
    const childDb = new Database(childDbPath);
    childDb.exec('CREATE TABLE user_notes (id INTEGER PRIMARY KEY);');
    childDb.close();
    const childBytesBefore = readFileSync(childDbPath);
    const childEntriesBefore = readdirSync(join(nestedChild, '.codegraph')).sort();
    const nestedRes = runSeed(nestedChild, cleanCase.env);
    expect(nestedRes.status).toBe(1);
    expect(nestedRes.stderr).toContain('CodeGraph 1.6.4 schema');
    expect(readFileSync(childDbPath)).toEqual(childBytesBefore);
    expect(readdirSync(join(nestedChild, '.codegraph')).sort()).toEqual(childEntriesBefore);
    expect(readFileSync(parentIgnorePath, 'utf8')).toBe('# CodeGraph data files\n*.db\n');
    expect(readFileSync(join(cleanCase.repo, '.codegraph/codegraph.db'))).toEqual(parentDbBefore);
    writeFileSync(parentIgnorePath, originalParentIgnore);
    rmSync(nestedChild, { recursive: true, force: true });

    // 8c. Real pinned-provider test: valid SQLite sidecars copied from ANOTHER database (-wal alone, -shm alone,
    // -wal + -shm pair, and -journal) beside a valid CodeGraph DB are refused unconditionally, preserving exact bytes.
    const cleanCgDir = join(cleanCase.repo, '.codegraph');
    const cleanDbPath = join(cleanCgDir, 'codegraph.db');
    // Confirm clean seeded repo already has zero lingering sidecars after rh arch index seed.
    expect(readdirSync(cleanCgDir).sort()).toEqual(['.gitignore', 'codegraph.db']);

    const foreignWalSource = mkdtempSync(join(tmpdir(), 'repo-harness-foreign-wal-'));
    roots.push(foreignWalSource);
    const foreignSourceDb = new Database(join(foreignWalSource, 'other.db'));
    let foreignWalBytes: Buffer;
    let foreignShmBytes: Buffer;
    try {
      foreignSourceDb.exec('PRAGMA journal_mode=WAL; CREATE TABLE foreign_tbl (id TEXT); INSERT INTO foreign_tbl VALUES ("foreign");');
      foreignWalBytes = readFileSync(join(foreignWalSource, 'other.db-wal'));
      foreignShmBytes = readFileSync(join(foreignWalSource, 'other.db-shm'));
      expect(foreignWalBytes.length).toBeGreaterThan(32);
      expect(foreignShmBytes.length).toBeGreaterThanOrEqual(32_768);
    } finally {
      foreignSourceDb.close();
    }

    const sidecarCases: Array<{ files: Array<[string, Buffer]>; expected: string }> = [
      { files: [['codegraph.db-wal', foreignWalBytes]], expected: '.codegraph/codegraph.db-wal is present' },
      { files: [['codegraph.db-shm', foreignShmBytes]], expected: '.codegraph/codegraph.db-shm is present' },
      { files: [['codegraph.db-wal', foreignWalBytes], ['codegraph.db-shm', foreignShmBytes]], expected: '.codegraph/codegraph.db-wal is present' },
      { files: [['codegraph.db-journal', Buffer.from('foreign-journal-user-data\n')]], expected: '.codegraph/codegraph.db-journal is present' },
    ];
    for (const sc of sidecarCases) {
      for (const [name, payload] of sc.files) writeFileSync(join(cleanCgDir, name), payload);
      const dbBefore = readFileSync(cleanDbPath);
      const entriesBefore = readdirSync(cleanCgDir).sort();
      const sidecarRes = runSeed(cleanCase.repo, cleanCase.env);
      expect(sidecarRes.status).toBe(1);
      expect(sidecarRes.stderr).toContain(sc.expected);
      for (const [name, payload] of sc.files) expect(readFileSync(join(cleanCgDir, name)).equals(payload)).toBe(true);
      expect(readFileSync(cleanDbPath)).toEqual(dbBefore);
      expect(readdirSync(cleanCgDir).sort()).toEqual(entriesBefore);
      for (const [name] of sc.files) rmSync(join(cleanCgDir, name), { force: true });
    }

    // 8d. Real pinned-provider test: sibling checkouts `project` and `project ` (trailing space) —
    // invoking public `rh arch index seed` in `project ` (or a subdir of it) fails closed without touching `project`.
    const wsParent = mkdtempSync(join(tmpdir(), 'repo-harness-ws-sibling-'));
    roots.push(wsParent);
    const cleanSibling = join(wsParent, 'project');
    const spacedSibling = join(wsParent, 'project ');
    for (const dir of [cleanSibling, spacedSibling]) {
      mkdirSync(join(dir, 'src'), { recursive: true });
      fixtureGit(dir, ['init', '-q']);
      fixtureWrite(dir, 'src/index.ts', 'export const ok = 1;\n');
      fixtureCommit(dir);
    }
    const cleanSiblingSeed = runSeed(cleanSibling, cleanCase.env);
    expect(cleanSiblingSeed.status, `${cleanSiblingSeed.stderr}\n${cleanSiblingSeed.stdout}`).toBe(0);
    const siblingDbBefore = readFileSync(join(cleanSibling, '.codegraph/codegraph.db'));
    for (const cwdTarget of [spacedSibling, join(spacedSibling, 'src')]) {
      const spacedRes = runSeed(cwdTarget, cleanCase.env);
      expect(spacedRes.status).toBe(1);
      expect(spacedRes.stderr).toContain('whitespace');
      expect(readFileSync(join(cleanSibling, '.codegraph/codegraph.db'))).toEqual(siblingDbBefore);
      expect(existsSync(join(spacedSibling, '.codegraph'))).toBe(false);
    }

    // 8e. Real pinned archctx@0.18.2 read-only commands leave zero SQLite sidecars so subsequent public seed succeeds.
    const readChecks: Array<{ args: readonly string[]; allowedStatuses: readonly number[] }> = [
      { args: ['doctor', '--json'], allowedStatuses: [0] },
      { args: ['prepare', '--task', 'verify-zero-sidecars', '--json'], allowedStatuses: [0] },
      { args: ['check', '--json'], allowedStatuses: [0] },
      { args: ['sync', '--check', '--json'], allowedStatuses: [0, 2] },
      { args: ['debt', '--json'], allowedStatuses: [0, 1] },
    ];
    for (const check of readChecks) {
      const readRes = spawnSync(process.execPath, [CLI, 'arch', ...check.args], {
        cwd: cleanCase.repo,
        env: cleanCase.env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(check.allowedStatuses, `rh arch ${check.args.join(' ')}: ${readRes.stderr}\n${readRes.stdout}`).toContain(readRes.status ?? -1);
      expect(readRes.stderr).not.toContain('RH_CODEGRAPH_DESTINATION_UNSAFE');
      expect(readRes.stdout).not.toContain('missing .archcontext/product.yaml');
      expect(readdirSync(cleanCgDir).sort()).toEqual(['.gitignore', 'codegraph.db']);
    }
    const reseedRes = runSeed(cleanCase.repo, cleanCase.env);
    expect(reseedRes.status, `${reseedRes.stderr}\n${reseedRes.stdout}`).toBe(0);
    expect(readdirSync(cleanCgDir).sort()).toEqual(['.gitignore', 'codegraph.db']);

    // 8f. Real POSIX sibling checkouts `project` and `project\r` (literal CR suffix):
    // invoking public `rh arch index seed` in `project\r` (or a subdir of it) fails closed without touching `project`.
    if (process.platform !== 'win32') {
      const crSibling = join(wsParent, 'project\r');
      mkdirSync(join(crSibling, 'src'), { recursive: true });
      fixtureGit(crSibling, ['init', '-q']);
      fixtureWrite(crSibling, 'src/index.ts', 'export const cr = 1;\n');
      fixtureCommit(crSibling);
      for (const cwdTarget of [crSibling, join(crSibling, 'src')]) {
        const crRes = runSeed(cwdTarget, cleanCase.env);
        expect(crRes.status).toBe(1);
        expect(crRes.stderr).toContain('control characters');
        expect(readFileSync(join(cleanSibling, '.codegraph/codegraph.db'))).toEqual(siblingDbBefore);
        expect(existsSync(join(crSibling, '.codegraph'))).toBe(false);
      }
      const crEnvRes = runSeed(cleanSibling, { ...cleanCase.env, GIT_WORK_TREE: crSibling });
      expect(crEnvRes.status).toBe(1);
      expect(readFileSync(join(cleanSibling, '.codegraph/codegraph.db'))).toEqual(siblingDbBefore);
      expect(existsSync(join(crSibling, '.codegraph'))).toBe(false);
    }

    // 8g. Real lockfile-installed archctx@0.18.2 fails closed on an unrelated SQLite DB with overlapping table names
    // (preserving exact DB, -wal, and -shm bytes when ARCHCONTEXT_LOCAL_STORE_PATH is passed via rh arch).
    const foreignStoreDir = mkdtempSync(join(tmpdir(), 'repo-harness-foreign-store-'));
    roots.push(foreignStoreDir);
    const overlappingPath = join(foreignStoreDir, 'overlapping.sqlite');
    const overlappingWalPath = `${overlappingPath}-wal`;
    const overlappingShmPath = `${overlappingPath}-shm`;
    const overlappingDb = new Database(overlappingPath);
    try {
      overlappingDb.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE snapshots (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
        CREATE TABLE waivers (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL);
        CREATE TABLE kv_cache (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (1, 'foreign_v1');
        INSERT INTO waivers VALUES (42, 'SEC-42');
      `);
      const dbBytesBefore = readFileSync(overlappingPath);
      const walBytesBefore = readFileSync(overlappingWalPath);
      const shmBytesBefore = readFileSync(overlappingShmPath);
      expect(walBytesBefore.length).toBeGreaterThan(0);
      expect(shmBytesBefore.length).toBeGreaterThan(0);

      const foreignStoreRes = spawnSync(
        process.execPath,
        [CLI, 'arch', 'prepare', '--task', 'verify-foreign-store', '--json'],
        {
          cwd: cleanCase.repo,
          env: { ...cleanCase.env, ARCHCONTEXT_LOCAL_STORE_PATH: overlappingPath },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      expect(foreignStoreRes.status).not.toBe(0);
      const foreignStoreEnvelope = JSON.parse(foreignStoreRes.stdout) as {
        ok: boolean;
        error?: { code?: string; reasonCode?: string };
      };
      expect(foreignStoreEnvelope.ok).toBe(false);
      expect(foreignStoreEnvelope.error?.code).toBe('AC_PRECONDITION_FAILED');
      expect(foreignStoreEnvelope.error?.reasonCode).toBe('local-store-unproven-file');
      expect(readFileSync(overlappingPath).equals(dbBytesBefore)).toBe(true);
      expect(readFileSync(overlappingWalPath).equals(walBytesBefore)).toBe(true);
      expect(readFileSync(overlappingShmPath).equals(shmBytesBefore)).toBe(true);
      expect(readdirSync(foreignStoreDir).sort()).toEqual([
        'overlapping.sqlite',
        'overlapping.sqlite-shm',
        'overlapping.sqlite-wal',
      ]);
    } finally {
      overlappingDb.close();
    }

    // 9. Non-PID / empty user files at codegraph.lock and codegraph.lock.break refused on real primary index without unlinking.
    const lockPath = join(cleanCase.repo, '.codegraph/codegraph.lock');
    writeFileSync(lockPath, 'user notes — do not delete\n');
    const textLockRes = runSeed(cleanCase.repo, cleanCase.env);
    expect(textLockRes.status).toBe(1);
    expect(textLockRes.stderr).toContain('PID lock format');
    expect(readFileSync(lockPath, 'utf8')).toBe('user notes — do not delete\n');

    writeFileSync(lockPath, '');
    const emptyLockRes = runSeed(cleanCase.repo, cleanCase.env);
    expect(emptyLockRes.status).toBe(1);
    expect(emptyLockRes.stderr).toContain('PID lock format');
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath);

    const breakLockPath = join(cleanCase.repo, '.codegraph/codegraph.lock.break');
    writeFileSync(breakLockPath, 'custom break file\n');
    const breakLockRes = runSeed(cleanCase.repo, cleanCase.env);
    expect(breakLockRes.status).toBe(1);
    expect(breakLockRes.stderr).toContain('PID lock format');
    expect(readFileSync(breakLockPath, 'utf8')).toBe('custom break file\n');
    rmSync(breakLockPath);

    // 10. Nested subdir blocked by GIT_CEILING_DIRECTORIES fails closed instead of falling back to cwd while archctx walks up.
    const ceilingRes = runSeed(join(cleanCase.repo, 'src/module'), {
      ...cleanCase.env,
      GIT_CEILING_DIRECTORIES: cleanCase.repo,
    });
    expect(ceilingRes.status).toBe(1);
    expect(ceilingRes.stderr).toContain('git rev-parse --show-toplevel failed');

    // 11. Non-Git directory fails closed without invoking archctx.
    const nonGitDir = mkdtempSync(join(tmpdir(), 'repo-harness-seed-nongit-'));
    roots.push(nonGitDir);
    const nonGitRes = runSeed(nonGitDir, cleanCase.env);
    expect(nonGitRes.status).toBe(1);
    expect(nonGitRes.stderr).toContain('git rev-parse --show-toplevel failed');

    // 12. Two real checkouts: inherited GIT_DIR + GIT_WORK_TREE pointing to another valid repo fails closed
    // before index seed touches either checkout's .codegraph/codegraph.db.
    const cleanCaseDbBefore = readFileSync(join(cleanCase.repo, '.codegraph/codegraph.db'));
    const crossCheckoutEnvRes = runSeed(cleanSibling, {
      ...cleanCase.env,
      GIT_DIR: join(cleanCase.repo, '.git'),
      GIT_WORK_TREE: cleanCase.repo,
    });
    expect(crossCheckoutEnvRes.status).toBe(1);
    expect(crossCheckoutEnvRes.stderr).toContain('ambiguous Git repository root');
    expect(readFileSync(join(cleanSibling, '.codegraph/codegraph.db'))).toEqual(siblingDbBefore);
    expect(readFileSync(join(cleanCase.repo, '.codegraph/codegraph.db'))).toEqual(cleanCaseDbBefore);

    // 13. Non-Git directory with inherited GIT_DIR + GIT_WORK_TREE pointing to another valid repo also fails closed.
    const nonGitCrossEnvRes = runSeed(nonGitDir, {
      ...cleanCase.env,
      GIT_DIR: join(cleanCase.repo, '.git'),
      GIT_WORK_TREE: cleanCase.repo,
    });
    expect(nonGitCrossEnvRes.status).toBe(1);
    expect(nonGitCrossEnvRes.stderr).toContain('ambiguous Git repository root');
    expect(readFileSync(join(cleanCase.repo, '.codegraph/codegraph.db'))).toEqual(cleanCaseDbBefore);
  }, 120_000);
});
