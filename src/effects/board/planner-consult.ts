import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  COUNCIL_CONSULT_KIND,
  COUNCIL_CONSULT_PROTOCOL,
  CouncilConsultError,
  defaultCouncilPlanPath,
  isCouncilMember,
  renderCouncilTask,
  validateCouncilOutPath,
  type CouncilMember,
} from '../../core/board/planner-consult';
import type { SeatLaunchV1 } from '../../core/board/seat-launch';
import type { SeatLaunchOverrideV1 } from '../../core/board/seat-overrides';
import { githubRemoteRepository } from '../../core/board/source';
import { resolveGitCommonDirectory } from '../git/common-directory';
import { gitExecFileSync, gitSpawnSync, withoutRepositorySelectingGitEnv } from '../git/runner';
import { parseWorktreeTopology } from '../git/worktree-topology';
import { readLocalRepositoryIdAsync } from './collect';

export interface CouncilConsultInput {
  readonly cwd: string;
  readonly issue: number;
  readonly members: readonly CouncilMember[];
  readonly parent?: number;
  readonly qualifier?: string;
  readonly repositoryId?: string;
  readonly space?: string;
  readonly outDir?: string;
  readonly out?: string;
  readonly question?: string;
  readonly dry_run: boolean;
}

export interface CouncilConsultPorts {
  readonly launch: (
    member: CouncilMember,
    labels: { repositoryId: string; issue: string; parent?: string; qualifier?: string },
    cwd: string,
    dryRun: boolean,
  ) => Promise<{
    launch: Pick<SeatLaunchV1, 'argv' | 'runtime'> & {
      name: string | null;
      tab: string | null;
      readonly ownerOverride?: SeatLaunchOverrideV1;
    };
    model: string | null;
    shell: boolean;
  }>;
  readonly openTab: (args: { name: string; space: string; folder: string; argv: readonly string[]; task?: string }, options?: { readonly privateTask?: boolean }) => void;
}

function validateNativeCouncilPath(outPath: string, gitRoots: readonly string[]): void {
  const key = (path: string) => sep === '\\' ? path.replaceAll(sep, '/').toLowerCase() : path;
  validateCouncilOutPath(key(outPath), gitRoots.map(key));
}

/** Resolve from the nearest existing ancestor so new directories cannot hide a symlink. */
function resolveCouncilPath(path: string): { path: string; ancestor: string; exists: boolean } {
  const suffix: string[] = [];
  let ancestor = path;
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(ancestor);
    if (ancestor === parent) throw new CouncilConsultError('council_path_unavailable', `No parent directory exists for the council path ${path}.`);
    suffix.push(basename(ancestor));
    ancestor = parent;
  }
  try {
    const canonical = realpathSync.native(ancestor);
    return { path: join(canonical, ...suffix.reverse()), ancestor: canonical, exists: suffix.length === 0 };
  } catch {
    throw new CouncilConsultError('council_path_unavailable', `Cannot resolve the council path ${path}. Check the destination and its links.`);
  }
}

/** Git discovery also finds unrelated checkouts and bare repositories. */
function checkOutsideGit(cwd: string, path: string, env: NodeJS.ProcessEnv): void {
  const probe = gitSpawnSync(['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', env });
  if (probe.status === 0) {
    throw new CouncilConsultError('council_path_inside_repo', `The council output path ${path} is inside a Git repository. Choose a path outside Git.`);
  }
  if (probe.status !== 128 || !probe.stderr.startsWith('fatal: not a git repository')) {
    throw new CouncilConsultError('council_path_unavailable', `Git could not check the council path ${path}. Check the destination and its permissions.`);
  }
}

async function resolveCouncilRepositoryId(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
  const id = await readLocalRepositoryIdAsync({ repo_root: repoRoot, env, signal: new AbortController().signal }, url => githubRemoteRepository(url) !== null)
    .catch(() => null);
  if (id === null) {
    throw new CouncilConsultError('repository_id_required', 'The GitHub repository ID of this checkout is unknown. Pass --repository-id <id>.');
  }
  return String(id);
}

export async function runCouncilConsult(input: CouncilConsultInput, ports: CouncilConsultPorts) {
  if (input.members.length === 0 || input.members.length > 3 || new Set(input.members).size !== input.members.length || input.members.some(member => !isCouncilMember(member))) {
    throw new CouncilConsultError('council_member_invalid', 'Select 1 to 3 distinct council members from: fable, carbon, astra.');
  }
  if (input.out !== undefined && input.members.length > 1) {
    throw new CouncilConsultError('council_launch_invalid', 'Use --out-dir instead of --out when launching multiple council members.');
  }
  if (!input.dry_run && !input.space?.trim()) {
    throw new CouncilConsultError('council_launch_invalid', 'Pass --space <id> or run inside a Herdr.app terminal with a herdr.space label.');
  }

  const env = { ...withoutRepositorySelectingGitEnv(), LC_ALL: 'C', GIT_CEILING_DIRECTORIES: undefined, GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' };
  const gitOptions = { env, encoding: 'utf8' as const, stdio: 'pipe' as const };
  const repoRoot = realpathSync(gitExecFileSync(['rev-parse', '--show-toplevel'], { ...gitOptions, cwd: input.cwd }).trim());
  const gitCommonDir = resolveGitCommonDirectory(repoRoot, undefined, undefined, env);
  const { worktrees } = parseWorktreeTopology(gitExecFileSync(['worktree', 'list', '--porcelain'], { ...gitOptions, cwd: repoRoot }));
  const repoSlug = basename(worktrees[0]!.path);
  const gitRoots = [repoRoot, gitCommonDir, ...worktrees.map(worktree => worktree.path)];
  const canonicalGitRoots = gitRoots.map(root => resolveCouncilPath(root).path);

  const plannedPaths = input.members.map(member => {
    const fileName = `issue-${input.issue}-${member}${input.qualifier === undefined ? '' : `-${input.qualifier}`}.md`;
    const requested = input.out !== undefined
      ? resolve(input.cwd, input.out)
      : input.outDir !== undefined
        ? resolve(input.cwd, input.outDir, fileName)
        : resolve(input.cwd, defaultCouncilPlanPath(tmpdir(), repoSlug, input.issue, member, input.qualifier));
    validateNativeCouncilPath(requested, gitRoots);
    const { path: outPath, ancestor, exists } = resolveCouncilPath(requested);
    validateNativeCouncilPath(outPath, canonicalGitRoots);
    checkOutsideGit(exists ? dirname(ancestor) : ancestor, outPath, env);
    if (exists) {
      throw new CouncilConsultError('council_path_exists', `The council path ${outPath} already exists. Use --qualifier or --out-dir to choose a new path.`);
    }
    return { member, outPath };
  });

  const repositoryId = input.repositoryId ?? await resolveCouncilRepositoryId(repoRoot, env);
  const prepared: Array<{
    member: CouncilMember;
    outPath: string;
    launch: Pick<SeatLaunchV1, 'argv' | 'runtime'> & {
      name: string | null;
      tab: string | null;
      readonly ownerOverride?: SeatLaunchOverrideV1;
    };
    model: string | null;
  }> = [];

  for (const { member, outPath } of plannedPaths) {
    const qualifier = input.qualifier === undefined ? member : `${member}${input.qualifier}`;
    const { launch, model, shell } = await ports.launch(member, {
      repositoryId,
      issue: String(input.issue),
      ...(input.parent === undefined ? {} : { parent: String(input.parent) }),
      qualifier,
    }, repoRoot, input.dry_run);
    if (launch.runtime !== 'codex' && launch.runtime !== 'agy' && !shell) {
      throw new CouncilConsultError('council_runtime_unsupported', `Council member ${member} needs the shell tool to write ${outPath} outside the checkout.`);
    }
    if (launch.name === null || launch.tab === null) {
      throw new CouncilConsultError('council_launch_invalid', `Council member ${member} needs a labeled pane and a tab name.`);
    }
    prepared.push({ member, outPath, launch, model });
  }

  if (!input.dry_run) {
    for (const item of prepared) {
      const parent = dirname(item.outPath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      accessSync(parent, constants.W_OK);
    }
    for (const item of prepared) {
      const task = renderCouncilTask({
        issue: input.issue,
        parent: input.parent,
        member: item.member,
        outPath: item.outPath,
        question: input.question,
        runtime: item.launch.runtime,
      });
      if (item.launch.runtime === 'codex') {
        ports.openTab({ name: item.launch.tab!, space: input.space!, folder: repoRoot, argv: [...item.launch.argv, 'exec', '-o', item.outPath, task] });
      } else if (item.launch.runtime === 'agy') {
        ports.openTab({ name: item.launch.tab!, space: input.space!, folder: repoRoot, argv: [...item.launch.argv, '-i', task] }, { privateTask: true });
      } else {
        ports.openTab({ name: item.launch.tab!, space: input.space!, folder: repoRoot, argv: item.launch.argv, task });
      }
    }
  }

  return {
    protocol: COUNCIL_CONSULT_PROTOCOL,
    kind: COUNCIL_CONSULT_KIND,
    dry_run: input.dry_run,
    seat: 'council' as const,
    issue: input.issue,
    parent: input.parent ?? null,
    members: prepared.map(item => ({
      member: item.member,
      runtime: item.launch.runtime,
      model: item.model,
      ...(item.launch.ownerOverride === undefined ? {} : { ownerOverride: item.launch.ownerOverride }),
      pane_name: item.launch.name!,
      tab: item.launch.tab!,
      out_path: item.outPath,
    })),
  };
}
