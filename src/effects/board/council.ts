import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  COUNCIL_KIND,
  COUNCIL_PROTOCOL,
  CouncilError,
  defaultCouncilPlanPath,
  renderCouncilTask,
  resolveCouncilMemberConfig,
  validateCouncilOutPath,
  type CouncilMemberId,
} from '../../core/board/council';
import type { TransportPreset } from '../../core/board/model-catalog';
import type { SeatLaunchV1 } from '../../core/board/seat-launch';
import { githubRemoteRepository } from '../../core/board/source';
import { resolveGitCommonDirectory } from '../git/common-directory';
import { gitExecFileSync, gitSpawnSync, withoutRepositorySelectingGitEnv } from '../git/runner';
import { parseWorktreeTopology } from '../git/worktree-topology';
import { readLocalRepositoryIdAsync } from './collect';

const QUALIFIER_WORD = /^[a-z][a-z0-9]*$/u;

export interface CouncilInput {
  readonly cwd: string;
  readonly issue: number;
  readonly members: readonly CouncilMemberId[];
  readonly preset: TransportPreset;
  readonly parent?: number;
  readonly qualifier?: string;
  readonly repositoryId?: string;
  readonly space?: string;
  readonly question?: string;
  readonly dry_run: boolean;
}

export interface CouncilMemberLaunchResult {
  readonly launch: Pick<SeatLaunchV1, 'argv' | 'runtime'> & { readonly name: string | null; readonly tab: string | null };
  readonly model: string | null;
  readonly effort: string | null;
  readonly shell: boolean;
  /** True when the prompt is already embedded in `launch.argv` (e.g. `codex exec ... -- <task>` or `agy -i <task>`). */
  readonly taskInArgv?: boolean;
}

export interface CouncilPorts {
  readonly launch: (
    member: CouncilMemberId,
    labels: { readonly repositoryId: string; readonly issue: string; readonly parent?: string; readonly qualifier?: string },
    cwd: string,
    dryRun: boolean,
    outPath: string,
    task: string,
  ) => Promise<CouncilMemberLaunchResult>;
  readonly openTab: (args: {
    readonly name: string;
    readonly space: string;
    readonly folder: string;
    readonly argv: readonly string[];
    readonly task?: string;
  }) => void;
}

export interface CouncilMemberResult {
  readonly member: CouncilMemberId;
  readonly runtime: SeatLaunchV1['runtime'];
  readonly model: string | null;
  readonly effort: string | null;
  readonly pane_name: string;
  readonly tab: string;
  readonly out_path: string;
  readonly argv: readonly string[];
}

export interface CouncilResult {
  readonly protocol: typeof COUNCIL_PROTOCOL;
  readonly kind: typeof COUNCIL_KIND;
  readonly dry_run: boolean;
  readonly preset: TransportPreset;
  readonly seat: 'council';
  readonly issue: number;
  readonly parent: number | null;
  readonly members: readonly CouncilMemberResult[];
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
    if (ancestor === parent) throw new CouncilError('council_path_unavailable', `No parent directory exists for the council path ${path}.`);
    suffix.push(basename(ancestor));
    ancestor = parent;
  }
  try {
    const canonical = realpathSync.native(ancestor);
    return { path: join(canonical, ...suffix.reverse()), ancestor: canonical, exists: suffix.length === 0 };
  } catch {
    throw new CouncilError('council_path_unavailable', `Cannot resolve the council path ${path}. Check the destination and its links.`);
  }
}

/** Git discovery also finds unrelated checkouts and bare repositories. */
function checkOutsideGit(cwd: string, path: string, env: NodeJS.ProcessEnv): void {
  const probe = gitSpawnSync(['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', env });
  if (probe.status === 0) {
    throw new CouncilError('council_path_inside_repo', `The council path ${path} is inside a Git repository. Choose a path outside Git.`);
  }
  if (probe.status !== 128 || !probe.stderr.startsWith('fatal: not a git repository')) {
    throw new CouncilError('council_path_unavailable', `Git could not check the council path ${path}. Check the destination and its permissions.`);
  }
}

async function resolveCouncilRepositoryId(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
  const id = await readLocalRepositoryIdAsync({ repo_root: repoRoot, env, signal: new AbortController().signal }, url => githubRemoteRepository(url) !== null)
    .catch(() => null);
  if (id === null) {
    throw new CouncilError('repository_id_required', 'The GitHub repository ID of this checkout is unknown. Pass --repository-id <id>.');
  }
  return String(id);
}

export async function runCouncil(input: CouncilInput, ports: CouncilPorts): Promise<CouncilResult> {
  if (!input.dry_run && !input.space?.trim()) {
    throw new CouncilError('council_launch_invalid', 'Pass --space <id> to open a Herdr.app tab, or run inside a Herdr.app pane.');
  }
  if (input.qualifier !== undefined && !QUALIFIER_WORD.test(input.qualifier)) {
    throw new CouncilError('council_launch_invalid', `Council qualifier ${JSON.stringify(input.qualifier)} must match ${QUALIFIER_WORD.source}.`);
  }

  const env = { ...withoutRepositorySelectingGitEnv(), LC_ALL: 'C', GIT_CEILING_DIRECTORIES: undefined, GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' };
  const gitOptions = { env, encoding: 'utf8' as const, stdio: 'pipe' as const };
  const repoRoot = realpathSync(gitExecFileSync(['rev-parse', '--show-toplevel'], { ...gitOptions, cwd: input.cwd }).trim());
  const gitCommonDir = resolveGitCommonDirectory(repoRoot, undefined, undefined, env);
  const { worktrees } = parseWorktreeTopology(gitExecFileSync(['worktree', 'list', '--porcelain'], { ...gitOptions, cwd: repoRoot }));
  const repoSlug = basename(worktrees[0]!.path);
  const gitRoots = [repoRoot, gitCommonDir, ...worktrees.map(worktree => worktree.path)];
  const canonicalGitRoots = gitRoots.map(root => resolveCouncilPath(root).path);

  const repositoryId = input.repositoryId ?? await resolveCouncilRepositoryId(repoRoot, env);

  // Preflight all member output paths and launch descriptors before creating directories or opening any tab.
  const planned: Array<{
    readonly member: CouncilMemberId;
    readonly outPath: string;
    readonly task: string;
    readonly launched: CouncilMemberLaunchResult;
  }> = [];

  for (const member of input.members) {
    const requested = resolve(input.cwd, defaultCouncilPlanPath(tmpdir(), repoSlug, input.issue, member, input.qualifier));
    validateNativeCouncilPath(requested, gitRoots);
    const { path: outPath, ancestor, exists } = resolveCouncilPath(requested);
    validateNativeCouncilPath(outPath, canonicalGitRoots);
    checkOutsideGit(exists ? dirname(ancestor) : ancestor, outPath, env);
    if (exists) {
      throw new CouncilError('council_path_exists', `The council path ${outPath} already exists. Use --qualifier to choose a new path.`);
    }

    const memberQualifier = input.qualifier === undefined ? member : `${member}${input.qualifier}`;
    const expectedRuntime = resolveCouncilMemberConfig(member, input.preset, null).runtime;
    const initialTask = renderCouncilTask({
      issue: input.issue,
      member,
      runtime: expectedRuntime,
      parent: input.parent,
      outPath,
      question: input.question,
    });
    const launched = await ports.launch(member, {
      repositoryId,
      issue: String(input.issue),
      ...(input.parent === undefined ? {} : { parent: String(input.parent) }),
      qualifier: memberQualifier,
    }, repoRoot, input.dry_run, outPath, initialTask);
    const task = launched.launch.runtime === expectedRuntime ? initialTask : renderCouncilTask({
      issue: input.issue,
      member,
      runtime: launched.launch.runtime,
      parent: input.parent,
      outPath,
      question: input.question,
    });
    if (launched.launch.runtime !== 'codex' && launched.launch.runtime !== 'agy' && !launched.shell) {
      throw new CouncilError('council_runtime_unsupported', `Council member ${member} needs the shell tool to write the proposal outside the checkout. Enable shell for the council seat.`);
    }
    if (launched.launch.name === null || launched.launch.tab === null) {
      throw new CouncilError('council_launch_invalid', `Council member ${member} needs a labeled pane and a tab name.`);
    }
    planned.push({ member, outPath, task, launched });
  }

  if (!input.dry_run) {
    for (const entry of planned) {
      const parent = dirname(entry.outPath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      accessSync(parent, constants.W_OK);
    }
    for (const entry of planned) {
      ports.openTab({
        name: entry.launched.launch.tab!,
        space: input.space!,
        folder: repoRoot,
        argv: entry.launched.launch.argv,
        ...(entry.launched.taskInArgv ? {} : { task: entry.task }),
      });
    }
  }

  return {
    protocol: COUNCIL_PROTOCOL,
    kind: COUNCIL_KIND,
    dry_run: input.dry_run,
    preset: input.preset,
    seat: 'council',
    issue: input.issue,
    parent: input.parent ?? null,
    members: planned.map(({ member, outPath, launched }) => ({
      member,
      runtime: launched.launch.runtime,
      model: launched.model,
      effort: launched.effort,
      pane_name: launched.launch.name!,
      tab: launched.launch.tab!,
      out_path: outPath,
      argv: launched.launch.argv,
    })),
  };
}
