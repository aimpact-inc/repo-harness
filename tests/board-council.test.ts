import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultCouncilPlanPath, parseCouncilMembers, resolveCouncilMemberConfig, validateCouncilOutPath } from '../src/core/board/council';
import { runCouncil, type CouncilMemberLaunchResult, type CouncilPorts } from '../src/effects/board/council';
import { initGitRepo, run, tmpWorkspace } from './helpers/repo-fixture';

let scratch: string;
let repo: string;
let linked: string;
let commonDir: string;
const createdCouncilDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = run('git', args, cwd);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

beforeEach(() => {
  scratch = tmpWorkspace('council-effect');
  repo = join(scratch, 'repo');
  linked = join(scratch, 'linked');
  commonDir = join(scratch, 'git-store');
  mkdirSync(repo);
  initGitRepo(repo);
  git(repo, 'init', '--separate-git-dir', commonDir);
  git(repo, 'commit', '--allow-empty', '-qm', 'initial commit');
  git(repo, 'worktree', 'add', '-q', linked);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  while (createdCouncilDirs.length > 0) {
    rmSync(createdCouncilDirs.pop()!, { recursive: true, force: true });
  }
});

function councilPorts(
  runtimeFor: (member: 'fable' | 'carbon' | 'astra') => {
    runtime: 'pi' | 'claude' | 'codex' | 'agy';
    model: string;
    effort: string | null;
    shell?: boolean;
    taskInArgv?: boolean;
  } = member => ({
    runtime: member === 'fable' ? 'claude' : 'pi',
    model: member === 'fable' ? 'fable' : member === 'carbon' ? 'magpie/agy-cli/gemini-4-carbon' : 'magpie/codex/gpt-6.2-astra',
    effort: 'high',
    shell: true,
    taskInArgv: false,
  }),
) {
  const launch = mock(async (member, labels, _cwd, _dryRun, _outPath, _task): Promise<CouncilMemberLaunchResult> => {
    const spec = runtimeFor(member);
    return {
      launch: {
        runtime: spec.runtime,
        name: `rh-cn-${labels.issue}-${labels.qualifier ?? member}`,
        tab: 'council',
        argv: [`${member}-argv`],
      },
      model: spec.model,
      effort: spec.effort,
      shell: spec.shell ?? true,
      taskInArgv: spec.taskInArgv ?? false,
    };
  });
  const openTab = mock<CouncilPorts['openTab']>();
  return { launch, openTab };
}

test('parseCouncilMembers accepts 1 to 3 distinct members from {fable, carbon, astra} and rejects others or duplicates', () => {
  expect(parseCouncilMembers('fable')).toEqual(['fable']);
  expect(parseCouncilMembers('fable, carbon, astra')).toEqual(['fable', 'carbon', 'astra']);
  for (const invalid of ['', 'opus', 'fable,fable', 'fable,carbon,astra,opus', 'fable,,carbon']) {
    expect(() => parseCouncilMembers(invalid)).toThrow(/council|member/i);
  }
});

test('resolveCouncilMemberConfig maps magpie and native presets from MODEL_CATALOG', () => {
  expect(resolveCouncilMemberConfig('fable', 'magpie', null)).toMatchObject({ runtime: 'claude', model: 'fable', effort: 'high' });
  expect(resolveCouncilMemberConfig('carbon', 'magpie', null)).toMatchObject({ runtime: 'pi', model: 'magpie/agy-cli/gemini-4-carbon', effort: 'xhigh' });
  expect(resolveCouncilMemberConfig('astra', 'magpie', null)).toMatchObject({ runtime: 'pi', model: 'magpie/codex/gpt-6.2-astra', effort: 'high' });
  expect(resolveCouncilMemberConfig('carbon', 'native', null)).toMatchObject({ runtime: 'agy', model: 'gemini-4-carbon', effort: null, fleet: [] });
  expect(resolveCouncilMemberConfig('astra', 'native', null)).toMatchObject({ runtime: 'codex', model: 'gpt-6.2-astra', effort: 'high' });
});

test('opens one tab per council member under /tmp/rh-council/<repo>/ with blind prompts and supports native codex -o', async () => {
  const ports = councilPorts(member => (
    member === 'astra'
      ? { runtime: 'codex', model: 'gpt-6.2-astra', effort: 'high', shell: true, taskInArgv: true }
      : { runtime: 'claude', model: 'fable', effort: 'high', shell: true, taskInArgv: false }
  ));
  const qualifier = `t${Date.now().toString(36).slice(-5)}`;
  const result = await runCouncil({
    cwd: linked,
    repositoryId: '19',
    issue: 42,
    parent: 7,
    members: ['fable', 'astra'],
    preset: 'native',
    qualifier,
    space: 'sp1',
    question: 'Which boundaries change?',
    dry_run: false,
  }, ports);
  for (const member of result.members) createdCouncilDirs.push(dirname(member.out_path));

  expect(result.seat).toBe('council');
  expect(result.members.map(m => m.member)).toEqual(['fable', 'astra']);
  expect(result.members[0]!.out_path).toEndWith(`/rh-council/repo/issue-42-fable-${qualifier}.md`);
  expect(result.members[1]!.out_path).toEndWith(`/rh-council/repo/issue-42-astra-${qualifier}.md`);
  expect(ports.openTab).toHaveBeenCalledTimes(2);

  const fableTab = ports.openTab.mock.calls[0]![0];
  expect(fableTab).toMatchObject({ name: 'council', space: 'sp1', folder: linked, argv: ['fable-argv'] });
  for (const part of ['gh issue view 42 --json title,body', 'parent #7', result.members[0]!.out_path, 'Which boundaries change?', 'Do not read other council members', 'Do not change repository files']) {
    expect(fableTab.task).toContain(part);
  }
  const astraTab = ports.openTab.mock.calls[1]![0];
  expect(astraTab).toMatchObject({ name: 'council', space: 'sp1', folder: linked, argv: ['astra-argv'] });
  expect(astraTab.task).toBeUndefined();
  expect(ports.launch.mock.calls[1]![5]).toContain('codex -o');
  expect(existsSync(dirname(result.members[0]!.out_path))).toBe(true);
  expect(git(repo, 'status', '--porcelain')).toBe('');
  expect(git(linked, 'status', '--porcelain')).toBe('');
});

test('validateCouncilOutPath refuses paths inside any git root and runCouncil refuses existing proposal files or missing shell', async () => {
  expect(() => validateCouncilOutPath('/repo/plan.md', ['/repo'])).toThrow(/inside/);
  const qualifier = `e${Date.now().toString(36).slice(-5)}`;
  const existing = defaultCouncilPlanPath(tmpdir(), 'repo', 42, 'fable', qualifier);
  mkdirSync(dirname(existing), { recursive: true });
  writeFileSync(existing, 'previous proposal');
  createdCouncilDirs.push(dirname(existing));

  const ports = councilPorts();
  await expect(runCouncil({
    cwd: repo, repositoryId: '19', issue: 42, members: ['fable'], preset: 'magpie', qualifier, space: 'sp1', dry_run: false,
  }, ports)).rejects.toMatchObject({ code: 'council_path_exists' });
  expect(readFileSync(existing, 'utf8')).toBe('previous proposal');
  expect(ports.openTab).not.toHaveBeenCalled();

  const noShell = councilPorts(() => ({ runtime: 'claude', model: 'fable', effort: 'high', shell: false }));
  const q2 = `n${Date.now().toString(36).slice(-5)}`;
  await expect(runCouncil({
    cwd: repo, repositoryId: '19', issue: 42, members: ['fable'], preset: 'magpie', qualifier: q2, space: 'sp1', dry_run: false,
  }, noShell)).rejects.toMatchObject({ code: 'council_runtime_unsupported' });
  expect(noShell.openTab).not.toHaveBeenCalled();

  // Bad qualifier is refused before constructing output paths.
  await expect(runCouncil({
    cwd: repo, repositoryId: '19', issue: 42, members: ['fable'], preset: 'magpie', qualifier: '../escape', space: 'sp1', dry_run: true,
  }, ports)).rejects.toMatchObject({ code: 'council_launch_invalid' });

  // Symlinked repo alias check via validateCouncilOutPath.
  const alias = join(scratch, 'alias');
  symlinkSync(repo, alias, 'dir');
  expect(() => validateCouncilOutPath(join(repo, 'nested', 'x.md'), [repo, linked, commonDir])).toThrow(/inside/);
});
