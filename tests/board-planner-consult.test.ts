import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultCouncilPlanPath, parseCouncilMembers } from '../src/core/board/planner-consult';
import { runCouncilConsult } from '../src/effects/board/planner-consult';
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
  scratch = tmpWorkspace('council-consult');
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

function councilPorts(
  runtimes: Partial<Record<'fable' | 'carbon' | 'astra', { runtime: 'pi' | 'claude' | 'codex' | 'agy'; model?: string; shell?: boolean }>> = {},
) {
  return {
    launch: mock(async (member: 'fable' | 'carbon' | 'astra', labels: { qualifier?: string }) => {
      const cfg = runtimes[member] ?? { runtime: member === 'fable' ? 'claude' : member === 'carbon' ? 'pi' : 'codex', shell: true };
      return {
        launch: { runtime: cfg.runtime, name: `rh-cn-42-${labels.qualifier ?? member}`, tab: 'council', argv: [`${member}-argv`] },
        model: cfg.model ?? null,
        shell: cfg.shell ?? true,
      };
    }),
    openTab: mock(),
  };
}

test('opens council tabs for fable and carbon in canonical scratch directory and launches codex astra with exec -o', async () => {
  const outputAlias = join(scratch, 'alias');
  const outputDir = `${repo}-outside`;
  mkdirSync(outputDir);
  symlinkSync(outputDir, outputAlias, 'dir');
  const ports = councilPorts({ fable: { runtime: 'claude', model: 'fable' }, carbon: { runtime: 'pi', model: 'magpie/agy-cli/gemini-4-carbon' } });
  const result = await runCouncilConsult({
    cwd: linked, repositoryId: '19', issue: 42, parent: 7, qualifier: 'api', space: 'sp1',
    members: ['fable', 'carbon'], outDir: join(outputAlias, 'nested'), question: 'Which boundaries change?', dry_run: false,
  }, ports);

  expect(ports.launch).toHaveBeenCalledTimes(2);
  expect(ports.launch).toHaveBeenNthCalledWith(1, 'fable', { repositoryId: '19', issue: '42', parent: '7', qualifier: 'fableapi' }, linked, false);
  expect(ports.launch).toHaveBeenNthCalledWith(2, 'carbon', { repositoryId: '19', issue: '42', parent: '7', qualifier: 'carbonapi' }, linked, false);
  expect(ports.openTab).toHaveBeenCalledTimes(2);
  const fablePath = join(outputDir, 'nested', 'issue-42-fable-api.md');
  const carbonPath = join(outputDir, 'nested', 'issue-42-carbon-api.md');
  const tab0 = ports.openTab.mock.calls[0]![0];
  expect(tab0).toMatchObject({ name: 'council', space: 'sp1', folder: linked, argv: ['fable-argv'] });
  for (const part of ['gh issue view 42 --json title,body', 'gh issue view 42 --comments', 'parent #7', fablePath, 'Which boundaries change?', 'Cheapest alternative', 'Keep the checkout read-only']) {
    expect(tab0.task).toContain(part);
  }
  expect(ports.openTab.mock.calls[1]![0].task).toContain(carbonPath);
  expect(result).toMatchObject({
    dry_run: false, seat: 'council', parent: 7,
    members: [
      { member: 'fable', pane_name: 'rh-cn-42-fableapi', tab: 'council', out_path: fablePath },
      { member: 'carbon', pane_name: 'rh-cn-42-carbonapi', tab: 'council', out_path: carbonPath },
    ],
  });
  expect(existsSync(dirname(fablePath))).toBe(true);
  expect(existsSync(fablePath)).toBe(false);

  const astraOut = join(outputAlias, 'nested', 'astra.md');
  const astraReal = join(outputDir, 'nested', 'astra.md');
  const codexPorts = councilPorts({ astra: { runtime: 'codex', model: 'gpt-6.2-astra', shell: false } });
  await runCouncilConsult({ cwd: linked, repositoryId: '19', issue: 42, space: 'sp1', members: ['astra'], out: astraOut, dry_run: false }, codexPorts);
  const codexTab = codexPorts.openTab.mock.calls[0]![0];
  expect(codexTab.task).toBeUndefined();
  expect(codexTab.argv.slice(0, 3)).toEqual(['astra-argv', 'exec', '-o']);
  expect(codexTab.argv[3]).toBe(astraReal);
  expect(codexTab.argv[4]).toContain('Return the complete proposal as your final message');
  expect(defaultCouncilPlanPath('/tmp/', 'repo.git', 42, 'astra')).toBe('/tmp/rh-council/repo.git/issue-42-astra.md');
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(git(linked, 'status', '--porcelain')).toBe('');
});

test('passes -i <task> in argv and privateTask: true for native agy council members without duplicating task', async () => {
  const agyOut = join(scratch, 'agy-carbon.md');
  const agyPorts = councilPorts({ carbon: { runtime: 'agy', model: 'gemini-4-carbon-high', shell: true } });
  await runCouncilConsult({
    cwd: linked, repositoryId: '19', issue: 42, space: 'sp1', members: ['carbon'], out: agyOut, question: 'Private council question', dry_run: false,
  }, agyPorts);
  expect(agyPorts.openTab).toHaveBeenCalledTimes(1);
  const [tabArgs, tabOptions] = agyPorts.openTab.mock.calls[0]!;
  expect(tabArgs.task).toBeUndefined();
  expect(tabArgs.argv.slice(0, 2)).toEqual(['carbon-argv', '-i']);
  expect(tabArgs.argv[2]).toContain('Private council question');
  expect(tabArgs.argv[2]).toContain(agyOut);
  expect(tabOptions).toEqual({ privateTask: true });
});

test('refuses invalid or duplicate council members and protects Git roots and symlinks', async () => {
  for (const bad of ['', 'neon', 'opus', 'fable,fable', 'fable,carbon,astra,fable']) {
    expect(() => parseCouncilMembers(bad)).toThrow(expect.objectContaining({ code: 'council_member_invalid' }));
  }
  expect(parseCouncilMembers('fable, carbon')).toEqual(['fable', 'carbon']);
  const unrelated = join(scratch, 'unrelated');
  mkdirSync(unrelated);
  initGitRepo(unrelated);
  const alias = join(scratch, 'alias');
  symlinkSync(repo, alias, 'dir');
  const ports = councilPorts();
  for (const root of [repo, linked, commonDir, unrelated, alias]) {
    await expect(runCouncilConsult({ cwd: repo, repositoryId: '19', issue: 42, members: ['fable'], space: 'sp1', out: join(root, 'new', 'plan.md'), dry_run: false }, ports))
      .rejects.toMatchObject({ code: 'council_path_inside_repo' });
    expect(existsSync(join(root, 'new'))).toBe(false);
  }
  expect(ports.launch).not.toHaveBeenCalled();
  expect(ports.openTab).not.toHaveBeenCalled();
});

test('preserves existing council output, requires outDir for multi-member, and refuses unsupported shell-less writers', async () => {
  const existing = join(scratch, 'issue-42-fable.md');
  writeFileSync(existing, 'previous plan');
  const out = join(scratch, 'new', 'plan.md');
  const input = { cwd: repo, repositoryId: '19', issue: 42, space: 'sp1', dry_run: false };
  const ports = councilPorts();
  await expect(runCouncilConsult({ ...input, members: ['fable'], out: existing }, ports)).rejects.toMatchObject({ code: 'council_path_exists' });
  expect(readFileSync(existing, 'utf8')).toBe('previous plan');
  await expect(runCouncilConsult({ ...input, members: ['fable', 'carbon'], out }, ports)).rejects.toMatchObject({ code: 'council_launch_invalid' });
  expect(ports.openTab).not.toHaveBeenCalled();
  const blocked = councilPorts({ fable: { runtime: 'claude', shell: false } });
  await expect(runCouncilConsult({ ...input, members: ['fable'], out }, blocked)).rejects.toMatchObject({ code: 'council_runtime_unsupported' });
  expect(blocked.openTab).not.toHaveBeenCalled();
  expect(existsSync(dirname(out))).toBe(false);
});
