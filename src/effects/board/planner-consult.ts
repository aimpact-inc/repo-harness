import { accessSync, constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { PLANNER_CONSULT_KIND, PLANNER_CONSULT_PROTOCOL, PlannerConsultError, defaultConsultPlanPath, renderConsultTask, validateConsultOutPath } from '../../core/board/planner-consult';
import type { SeatLaunchV1 } from '../../core/board/seat-launch';
import { githubRemoteRepository } from '../../core/board/source';
import { resolveGitCommonDirectory } from '../git/common-directory';
import { gitExecFileSync, gitSpawnSync, withoutRepositorySelectingGitEnv } from '../git/runner';
import { parseWorktreeTopology } from '../git/worktree-topology';
import { readLocalRepositoryIdAsync } from './collect';

interface PlannerConsultInput {
  readonly cwd: string;
  readonly issue: number;
  readonly parent?: number;
  readonly qualifier?: string;
  readonly repositoryId?: string;
  readonly space?: string;
  readonly out?: string;
  readonly question?: string;
  readonly dry_run: boolean;
}

interface PlannerConsultPorts {
  readonly launch: (seat: 'planner', labels: { repositoryId: string; issue: string; parent?: string; qualifier?: string }, cwd: string, dryRun: boolean) => Promise<{
    launch: Pick<SeatLaunchV1, 'argv' | 'runtime'> & { name: string | null; tab: string | null };
    model: string | null;
    shell: boolean;
  }>;
  readonly openTab: (args: { name: string; space: string; folder: string; argv: readonly string[]; task: string }) => void;
}

function validateNativeConsultPath(outPath: string, gitRoots: readonly string[]): void {
  const key = (path: string) => sep === '\\' ? path.replaceAll(sep, '/').toLowerCase() : path;
  validateConsultOutPath(key(outPath), gitRoots.map(key));
}

/** Resolve from the nearest existing ancestor so new directories cannot hide a symlink. */
function resolveConsultPath(path: string): { path: string; ancestor: string; exists: boolean } {
  const suffix: string[] = [];
  let ancestor = path;
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) {
    const parent = dirname(ancestor);
    if (ancestor === parent) throw new PlannerConsultError('consult_path_unavailable', `No parent directory exists for the plan path ${path}.`);
    suffix.push(basename(ancestor));
    ancestor = parent;
  }
  try {
    const canonical = realpathSync.native(ancestor);
    return { path: join(canonical, ...suffix.reverse()), ancestor: canonical, exists: suffix.length === 0 };
  } catch {
    throw new PlannerConsultError('consult_path_unavailable', `Cannot resolve the plan path ${path}. Check the destination and its links.`);
  }
}

/** Git discovery also finds unrelated checkouts and bare repositories. */
function checkOutsideGit(cwd: string, path: string, env: NodeJS.ProcessEnv): void {
  const probe = gitSpawnSync(['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', env });
  if (probe.status === 0) {
    throw new PlannerConsultError('consult_path_inside_repo', `The plan path ${path} is inside a Git repository. Choose a path outside Git.`);
  }
  if (probe.status !== 128 || !probe.stderr.startsWith('fatal: not a git repository')) {
    throw new PlannerConsultError('consult_path_unavailable', `Git could not check the plan path ${path}. Check the destination and its permissions.`);
  }
}

async function resolveConsultRepositoryId(repoRoot: string, env: NodeJS.ProcessEnv): Promise<string> {
  const id = await readLocalRepositoryIdAsync({ repo_root: repoRoot, env, signal: new AbortController().signal }, url => githubRemoteRepository(url) !== null)
    .catch(() => null);
  if (id === null) {
    throw new PlannerConsultError('repository_id_required', 'The GitHub repository ID of this checkout is unknown. Pass --repository-id <id>.');
  }
  return String(id);
}

export async function runPlannerConsult(input: PlannerConsultInput, ports: PlannerConsultPorts) {
  if (!input.dry_run && !input.space?.trim()) throw new PlannerConsultError('consult_launch_invalid', 'Pass --space <id> to open a Herdr.app tab.');

  const env = { ...withoutRepositorySelectingGitEnv(), LC_ALL: 'C', GIT_CEILING_DIRECTORIES: undefined, GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' };
  const gitOptions = { env, encoding: 'utf8' as const, stdio: 'pipe' as const };
  const repoRoot = realpathSync(gitExecFileSync(['rev-parse', '--show-toplevel'], { ...gitOptions, cwd: input.cwd }).trim());
  const gitCommonDir = resolveGitCommonDirectory(repoRoot, undefined, undefined, env);
  const { worktrees } = parseWorktreeTopology(gitExecFileSync(['worktree', 'list', '--porcelain'], { ...gitOptions, cwd: repoRoot }));
  const repoSlug = basename(worktrees[0]!.path);
  const gitRoots = [repoRoot, gitCommonDir, ...worktrees.map(worktree => worktree.path)];
  const requested = resolve(input.cwd, input.out ?? defaultConsultPlanPath(tmpdir(), repoSlug, input.issue, input.qualifier));
  validateNativeConsultPath(requested, gitRoots);
  const { path: outPath, ancestor, exists } = resolveConsultPath(requested);
  validateNativeConsultPath(outPath, gitRoots.map(root => resolveConsultPath(root).path));
  checkOutsideGit(exists ? dirname(ancestor) : ancestor, outPath, env);
  if (exists) throw new PlannerConsultError('consult_path_exists', `The plan path ${outPath} already exists. Use --qualifier or --out to choose a new path.`);

  const repositoryId = input.repositoryId ?? await resolveConsultRepositoryId(repoRoot, env);
  const { launch, model, shell } = await ports.launch('planner', {
    repositoryId,
    issue: String(input.issue),
    ...(input.parent === undefined ? {} : { parent: String(input.parent) }),
    ...(input.qualifier === undefined ? {} : { qualifier: input.qualifier }),
  }, repoRoot, input.dry_run);
  if (launch.runtime === 'codex') {
    throw new PlannerConsultError('consult_runtime_unsupported', 'The Codex read-only sandbox blocks scratch writes. Configure a Pi or Claude planner.');
  }
  if (!shell) {
    throw new PlannerConsultError('consult_runtime_unsupported', 'The planner needs the shell tool to write the plan outside the checkout. Enable shell for the planner.');
  }
  if (launch.name === null || launch.tab === null) {
    throw new PlannerConsultError('consult_launch_invalid', 'The planner launch needs a labeled pane and a tab name.');
  }

  if (!input.dry_run) {
    const parent = dirname(outPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    accessSync(parent, constants.W_OK);
    ports.openTab({ name: launch.tab, space: input.space!, folder: repoRoot, argv: launch.argv, task: renderConsultTask({ ...input, outPath }) });
  }
  return {
    protocol: PLANNER_CONSULT_PROTOCOL,
    kind: PLANNER_CONSULT_KIND,
    dry_run: input.dry_run,
    seat: 'planner' as const,
    runtime: launch.runtime,
    model,
    issue: input.issue,
    parent: input.parent ?? null,
    pane_name: launch.name,
    tab: launch.tab,
    out_path: outPath,
  };
}
