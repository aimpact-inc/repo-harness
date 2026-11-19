import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runPlannerConsult } from '../src/effects/board/planner-consult';
import { initGitRepo, run, tmpWorkspace } from './helpers/repo-fixture';

let scratch: string;
let repo: string;
let linked: string;
let commonDir: string;

function git(cwd: string, ...args: string[]): string {
  const result = run('git', args, cwd);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

beforeEach(() => {
  scratch = tmpWorkspace('planner-consult');
  repo = join(scratch, 'repo');
  linked = join(scratch, 'linked');
  commonDir = join(scratch, 'git-store');
  mkdirSync(repo);
  initGitRepo(repo);
  git(repo, 'init', '--separate-git-dir', commonDir);
  git(repo, 'commit', '--allow-empty', '-qm', 'initial commit');
  git(repo, 'worktree', 'add', '-q', linked);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function consultPorts(runtime: 'pi' | 'claude' | 'codex' = 'pi', shell = true) {
  return {
    launch: mock(async () => ({ launch: { runtime, name: 'rh-pl-42-api', tab: 'plan', argv: ['planner-argv'] }, model: null, shell })),
    openTab: mock(),
  };
}

test('opens one tab from the linked checkout with a task that writes to the canonical scratch path', async () => {
  const outputAlias = join(scratch, 'alias');
  const outputDir = `${repo}-outside`;
  mkdirSync(outputDir);
  symlinkSync(outputDir, outputAlias, 'dir');
  const ports = consultPorts();
  const out = join(outputAlias, 'nested', 'plan.md');
  const outPath = join(outputDir, 'nested', 'plan.md');
  const result = await runPlannerConsult({ cwd: linked, repositoryId: '19', issue: 42, parent: 7, qualifier: 'api', space: 'sp1', out, question: 'Which boundaries change?', dry_run: false }, ports);

  expect(ports.launch).toHaveBeenCalledWith('planner', { repositoryId: '19', issue: '42', parent: '7', qualifier: 'api' }, linked, false);
  expect(ports.openTab).toHaveBeenCalledTimes(1);
  const tab = ports.openTab.mock.calls[0]![0];
  expect(tab).toMatchObject({ name: 'plan', space: 'sp1', folder: linked, argv: ['planner-argv'] });
  for (const part of ['gh issue view 42 --json title,body', 'gh issue view 42 --comments', 'parent #7', outPath, 'Which boundaries change?', 'Do not change repository files', 'write to GitHub']) {
    expect(tab.task).toContain(part);
  }
  expect(result).toMatchObject({ dry_run: false, parent: 7, out_path: outPath });
  expect(existsSync(dirname(outPath))).toBe(true);
  expect(existsSync(outPath)).toBe(false);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(git(linked, 'status', '--porcelain')).toBe('');
});

test('refuses checkout, linked worktree, common directory, unrelated Git root and resolved symlink paths', async () => {
  const unrelated = join(scratch, 'unrelated');
  mkdirSync(unrelated);
  initGitRepo(unrelated);
  const alias = join(scratch, 'alias');
  symlinkSync(repo, alias, 'dir');
  const ports = consultPorts();
  for (const root of [repo, linked, commonDir, unrelated, alias]) {
    await expect(runPlannerConsult({ cwd: repo, repositoryId: '19', issue: 42, space: 'sp1', out: join(root, 'new', 'plan.md'), dry_run: false }, ports))
      .rejects.toMatchObject({ code: 'consult_path_inside_repo' });
    expect(existsSync(join(root, 'new'))).toBe(false);
  }
  expect(ports.launch).not.toHaveBeenCalled();
  expect(ports.openTab).not.toHaveBeenCalled();
});

test('preserves an existing plan and refuses unsupported scratch writers before making directories', async () => {
  const existing = join(scratch, 'plan.md');
  writeFileSync(existing, 'previous plan');
  const out = join(scratch, 'new', 'plan.md');
  const input = { cwd: repo, repositoryId: '19', issue: 42, space: 'sp1', dry_run: false };
  const ports = consultPorts();
  await expect(runPlannerConsult({ ...input, out: existing }, ports)).rejects.toMatchObject({ code: 'consult_path_exists' });
  expect(readFileSync(existing, 'utf8')).toBe('previous plan');
  expect(ports.openTab).not.toHaveBeenCalled();
  for (const blocked of [consultPorts('codex'), consultPorts('claude', false)]) {
    await expect(runPlannerConsult({ ...input, out }, blocked)).rejects.toMatchObject({ code: 'consult_runtime_unsupported' });
    expect(blocked.openTab).not.toHaveBeenCalled();
  }
  expect(existsSync(dirname(out))).toBe(false);
});
