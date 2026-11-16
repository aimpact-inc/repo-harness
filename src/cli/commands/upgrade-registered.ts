import { sha256Prefixed } from '../../core/evidence/sha256';
import { spawnSync } from 'child_process';
import { lstatSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { readWorkflowPolicyDocument } from '../../effects/state/resolve-effective-state';
import { POLICY_ABSENT, isPolicyObject, policyValue } from '../../core/workflow/policy-schema';
import { formatJson } from '../installer/shared';
import { gitSpawnSync, withoutRepositorySelectingGitEnv } from '../../effects/git/runner';
import { applyAdoptionPlan, FS_TRANSACTION_BACKUP_ROOT, type ApplyAdoptionPlanResult } from '../../effects/fs-transaction';
import { version as PACKAGE_VERSION } from '../../../package.json';
import {
  assertRegistryRevisionFence,
  isRepoHarnessAdoptedPath,
  readRepoHarnessRegistryStrictSnapshot,
  repoCheckoutProbeEnv,
  repoHarnessCheckoutRejection,
} from '../../effects/repo-registry';
import { boundSweepSteps, planManagedWorktreeSweep, sweepManagedWorktrees, type WorktreeSweepPlan } from '../../effects/state/coordination-worktree-topology';
import { planRepoAdoption, runAdoptionApply } from './adoption-plan';
import { formatUpgradeResult, runUpgrade, type UpgradeResult } from './upgrade';

/** Same budget as the sweep that `contract-worktree start` runs. */
const SWEEP_DEADLINE_MS = 30_000;

export type RegisteredRepoSkipReason =
  | 'path_missing'
  | 'path_unreadable'
  | 'not_primary_checkout'
  | 'not_adopted'
  | 'default_branch_unknown'
  | 'not_default_branch'
  | 'dirty_worktree'
  | 'git_probe_failed'
  | 'no_origin_remote'
  | 'fetch_failed'
  | 'push_failed'
  | 'pr_failed'
  | 'refresh_branch_foreign';

export interface RegisteredInitPreview {
  readonly planned: number;
  readonly operations: readonly { readonly kind: string; readonly path?: string }[];
}

export interface RegisteredInitApply {
  readonly ok: boolean;
  readonly planned: number;
  readonly applied: number;
  readonly failed: number;
  readonly transaction?: string;
  readonly rollbackOk?: boolean;
  readonly errors?: readonly string[];
}

/** Preview: the sweep plan, null when there is nothing to sweep. Apply: the sweep report. */
export type RegisteredSweep =
  | { readonly ran: false; readonly plan: WorktreeSweepPlan | null }
  | { readonly ran: false; readonly error: string }
  | { readonly ran: true; readonly report: string | null };

/** `--pr` apply: what the refresh in the temporary worktree produced and published. */
export type RegisteredRefresh =
  | { readonly outcome: 'up_to_date' }
  | {
    /** `unchanged`: the remote refresh branch already holds this tree on this base, so nothing was pushed. */
    readonly outcome: 'pushed' | 'unchanged';
    readonly branch: string;
    readonly commit: string;
    readonly pr: string;
    readonly prAction: 'created' | 'updated' | 'open';
  };

export interface RegisteredRepoResult {
  readonly path: string;
  readonly status: 'ready' | 'applied' | 'skipped' | 'failed';
  readonly reason?: RegisteredRepoSkipReason;
  readonly detail?: string;
  /** Preview only: the repo has init operations or pending project upgrade work, including a removable or deferred legacy worktree. */
  readonly pending?: boolean;
  readonly init?: RegisteredInitPreview | RegisteredInitApply;
  readonly upgrade?: UpgradeResult;
  readonly sweep?: RegisteredSweep;
  /** Preview only: whether `--pr` can refresh this repo. */
  readonly prRefresh?: Classification;
  readonly refresh?: RegisteredRefresh;
  readonly error?: string;
}

export interface RegisteredUpgradeResult {
  readonly revision: string | null;
  readonly apply: boolean;
  /** Present only for a `--pr` apply. */
  readonly pr?: true;
  readonly exitCode: 0 | 1 | 2;
  readonly repos: readonly RegisteredRepoResult[];
  readonly error?: string;
}

export interface RegisteredUpgradeOptions {
  readonly apply?: boolean;
  readonly expectedRevision?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** The real process cwd. The sweep and the legacy worktree cleanup never remove it or anything below it. */
  readonly callerCwd?: string;
  /** With `apply`: refresh each repo in a temporary worktree, push the refresh branch and open or update its PR. */
  readonly pr?: boolean;
}

export type Classification =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: RegisteredRepoSkipReason; readonly detail: string };

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

type Skip = Exclude<Classification, { ready: true }>;

function skip(reason: RegisteredRepoSkipReason, detail: string): Skip {
  return { ready: false, reason, detail };
}

function git(path: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return gitSpawnSync(args, { cwd: path, env: repoCheckoutProbeEnv(env), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitFailure(result: ReturnType<typeof git>): string {
  return result.error?.message ?? (result.stderr.trim() || `git exited with status ${result.status}`);
}

/**
 * The policy owns the default branch. A missing or invalid value is never guessed.
 * `at` reads the policy from that commit instead of the worktree.
 */
function policyDefaultBranch(path: string, env: NodeJS.ProcessEnv, at?: string): { readonly branch: string } | { readonly error: string } {
  const where = at ? `${at}:` : '';
  let document: ReturnType<typeof readWorkflowPolicyDocument>;
  try {
    document = at === undefined ? readWorkflowPolicyDocument(path) : readWorkflowPolicyDocument(path, (policyPath) => {
      const shown = git(path, ['show', `${at}:${policyPath}`], env);
      if (shown.error || shown.status !== 0) throw new Error(gitFailure(shown));
      return shown.stdout;
    });
  } catch (error) { return { error: `${where}.ai/harness/policy.json is unreadable: ${message(error)}` }; }
  if (!document.present) return { error: `${where}.ai/harness/policy.json is missing` };
  const strategy = document.rootIsObject ? policyValue(document, 'worktree_strategy') : POLICY_ABSENT;
  const branch = isPolicyObject(strategy) ? policyValue(document, 'worktree_strategy.base_branch') : POLICY_ABSENT;
  if (typeof branch !== 'string' || branch.trim() === '') return { error: `${where}worktree_strategy.base_branch is missing or not a non-empty string` };
  return { branch: branch.trim() };
}

/** Read-only. `--no-optional-locks` keeps `git status` from refreshing the index. */
function classifyRepo(path: string, env: NodeJS.ProcessEnv): Classification {
  try {
    lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? skip('path_missing', `${path} does not exist`)
      : skip('path_unreadable', `${path} cannot be inspected (${code ?? 'probe_failed'})`);
  }
  const rejection = repoHarnessCheckoutRejection(path, env);
  if (rejection) return skip(rejection.reason, rejection.message);
  if (!isRepoHarnessAdoptedPath(path)) return skip('not_adopted', `${path} is not repo-harness adopted`);
  const base = policyDefaultBranch(path, env);
  if ('error' in base) return skip('default_branch_unknown', base.error);
  const head = git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env);
  if (head.error || (head.status !== 0 && head.status !== 1)) return skip('git_probe_failed', `cannot read the current branch: ${gitFailure(head)}`);
  if (head.status === 1) return skip('not_default_branch', `HEAD is detached; the default branch is ${base.branch}`);
  const current = head.stdout.trim();
  if (current !== base.branch) return skip('not_default_branch', `current branch is ${current}; the default branch is ${base.branch}`);
  // The flags override `status.showUntrackedFiles` and `diff.ignoreSubmodules` from user config.
  const status = git(path, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none'], env);
  if (status.error || status.status !== 0) return skip('git_probe_failed', `cannot read the worktree status: ${gitFailure(status)}`);
  if (status.stdout.trim() !== '') return skip('dirty_worktree', `${status.stdout.trim().split('\n').length} changed or untracked paths`);
  return { ready: true };
}

/** Each repo's classification and sweep plan. The plan revision binds every sweep plan, so apply runs only previewed steps. */
type RepoPlan =
  | { readonly classification: Classification; readonly sweep?: Exclude<RegisteredSweep, { ran: true }> }
  | { readonly error: string };

const NO_STEPS: WorktreeSweepPlan = { target_oid: null, items: [] };

function planRepo(path: string, env: NodeJS.ProcessEnv, callerCwd: string): RepoPlan {
  try {
    const classification = classifyRepo(path, env);
    if (!classification.ready) return { classification };
    try { return { classification, sweep: { ran: false, plan: planManagedWorktreeSweep(path, callerCwd, env, { deadlineMs: SWEEP_DEADLINE_MS }) } }; }
    catch (error) { return { classification, sweep: { ran: false, error: `sweep plan failed: ${message(error)}` } }; }
  } catch (error) { return { error: message(error) }; }
}

/** The plan that binds an apply sweep. A skipped repo or a failed plan approves no sweep step. */
function approvedSweep(plan: RepoPlan): WorktreeSweepPlan {
  return 'classification' in plan && plan.sweep && 'plan' in plan.sweep && plan.sweep.plan ? plan.sweep.plan : NO_STEPS;
}

/** Repo classification is checked again before each write, so the revision binds only the registry and the sweep steps. */
function planRevision(registryRevision: string, repos: readonly { readonly path: string }[], plans: readonly RepoPlan[]): string {
  const sweeps = plans.map((plan, index) => ({ path: repos[index]!.path, sweep: boundSweepSteps(approvedSweep(plan)) }));
  return sha256Prefixed(JSON.stringify({ registry: registryRevision, repos: sweeps }));
}

function skipped(path: string, classification: Skip): RegisteredRepoResult {
  return { path, status: 'skipped', reason: classification.reason, detail: classification.detail };
}

function previewRepo(path: string, env: NodeJS.ProcessEnv, callerCwd: string, plan: RepoPlan): RegisteredRepoResult {
  if ('error' in plan) throw new Error(plan.error);
  const { classification, sweep } = plan;
  const prRefresh = prRefreshability(path, classification, env);
  if (!classification.ready) return { ...skipped(path, classification), prRefresh };
  const planned = planRepoAdoption({ repo: path, mode: 'standard', explicitRepo: true, env });
  const init: RegisteredInitPreview | undefined = planned.plan && {
    planned: planned.plan.summary.plannedTotal,
    operations: planned.plan.operations.filter((operation) => operation.status === 'planned')
      .map((operation) => ({ kind: operation.kind, ...(operation.path === undefined ? {} : { path: operation.path }) })),
  };
  const upgrade = runUpgrade({ cwd: path, callerCwd, scope: 'project', apply: false, env });
  const errors = [
    ...(planned.error ? [`init plan failed: ${planned.error.code} - ${planned.error.message}`] : []),
    ...(upgrade.error ? [`project upgrade check failed: ${upgrade.error}`] : []),
  ];
  if (errors.length > 0) {
    return { path, status: 'failed', ...(init ? { init } : {}), upgrade, sweep, prRefresh, error: errors.join('; ') };
  }
  // A preview upgrade exits 1 for every pending item: leftovers, a template rewrite and a removable or deferred legacy worktree.
  const sweepSteps = sweep && 'plan' in sweep ? boundSweepSteps(sweep.plan).steps.length : 0;
  return { path, status: 'ready', pending: init!.planned > 0 || upgrade.exitCode !== 0 || sweepSteps > 0, init, upgrade, sweep, prRefresh };
}

function initApplyResult(ok: boolean, planned: number, apply: ApplyAdoptionPlanResult | undefined, otherErrors: readonly string[]): RegisteredInitApply {
  const results = apply?.results ?? [];
  const errors = [
    ...otherErrors,
    ...results.filter((result) => result.status === 'failed').map((result) => `${result.id}${result.error ? ` - ${result.error}` : ''}`),
  ];
  return {
    ok,
    planned,
    applied: results.filter((result) => result.status === 'applied').length,
    failed: results.filter((result) => result.status === 'failed').length,
    ...(apply?.transactionManifestPath ? { transaction: apply.transactionManifestPath } : {}),
    ...(apply?.rollback ? { rollbackOk: apply.rollback.ok } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * The per-repo write sequence. Preconditions are checked again immediately
 * before the first write; the init transaction then changes the worktree, so
 * later steps do not re-check it. A failed step stops this repo only.
 */
function applyRepo(path: string, env: NodeJS.ProcessEnv, callerCwd: string, approved: WorktreeSweepPlan): RegisteredRepoResult {
  const classification = classifyRepo(path, env);
  if (!classification.ready) return skipped(path, classification);

  const adoption = runAdoptionApply({ repo: path, mode: 'standard', explicitRepo: true, env }).report;
  const plannedOperations = (adoption.plan as { summary?: { plannedTotal?: unknown } }).summary?.plannedTotal;
  const init = initApplyResult(adoption.ok, typeof plannedOperations === 'number' ? plannedOperations : 0, adoption.apply, [
    ...(adoption.errors ?? []).map((error) => `${error.code} - ${error.message}`),
    ...(adoption.registration && !adoption.registration.registered && adoption.registration.reason !== 'already registered'
      ? [`registry: ${adoption.registration.reason ?? 'not registered'}`] : []),
  ]);
  if (!init.ok) return { path, status: 'failed', init, error: `init refresh failed: ${init.errors?.join('; ') || 'not ok'}` };

  // The upgrade also removes provable legacy sibling worktrees; the sweep then handles the managed root.
  const upgrade = runUpgrade({ cwd: path, callerCwd, scope: 'project', apply: true, env });
  if (upgrade.error) return { path, status: 'failed', init, upgrade, error: `project upgrade failed: ${upgrade.error}` };

  const sweep: RegisteredSweep = { ran: true, report: sweepManagedWorktrees(path, callerCwd, env, { deadlineMs: SWEEP_DEADLINE_MS, approved }) };
  return { path, status: 'applied', init, upgrade, sweep };
}

const REFRESH_BRANCH = 'repo-harness/refresh';
const REFRESH_SUBJECT = 'chore(harness): refresh repo-harness files for ';
const PROVIDER_TIMEOUT_MS = 120_000;
/** Skips that only block a write into the primary checkout; `--pr` writes in its own worktree instead. */
const CHECKOUT_ONLY_SKIPS: ReadonlySet<RegisteredRepoSkipReason> = new Set(['dirty_worktree', 'not_default_branch']);
/** `--pr` skips that report a failed remote command, so the run exits 1. */
const FAILED_COMMAND_SKIPS: ReadonlySet<RegisteredRepoSkipReason> = new Set(['fetch_failed', 'push_failed', 'pr_failed']);

type CommandResult = { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error?: Error };

function commandFailure(label: string, result: CommandResult): string {
  const stderr = result.stderr.trim();
  return `${label} ${result.error ? `failed: ${result.error.message}` : `exited with status ${result.status}`}${stderr ? `: ${stderr}` : ''}`;
}

/** Read-only and local: `git remote get-url` exits 2 when the remote does not exist. */
function originRemote(path: string, env: NodeJS.ProcessEnv): Classification {
  const url = git(path, ['remote', 'get-url', 'origin'], env);
  if (!url.error && url.status === 0) return { ready: true };
  if (!url.error && url.status === 2) return skip('no_origin_remote', `${path} has no remote named origin`);
  return skip('git_probe_failed', commandFailure('git remote get-url origin', url));
}

function prRefreshability(path: string, classification: Classification, env: NodeJS.ProcessEnv): Classification {
  if (!classification.ready && !CHECKOUT_ONLY_SKIPS.has(classification.reason)) return classification;
  return originRemote(path, env);
}

function gh(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync(env.REPO_HARNESS_GH_BIN ?? 'gh', [...args], {
    cwd, env: withoutRepositorySelectingGitEnv(env), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROVIDER_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) };
}

function revParse(cwd: string, rev: string, env: NodeJS.ProcessEnv): string {
  const result = git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], env);
  if (result.error || result.status !== 0) throw new Error(commandFailure(`git rev-parse ${rev}`, result));
  return result.stdout.trim();
}

/** The fetched base branch, and the fetched remote refresh branch or null when the remote has none. */
interface RefreshBase {
  readonly base: string;
  readonly baseOid: string;
  readonly refreshOid: string | null;
}

/**
 * Fetches the policy base branch and the refresh branch. The base branch comes
 * from the policy at `origin/<base>`; the checkout's policy only names which
 * branch to fetch, and a disagreement fails closed.
 */
function fetchRefreshBase(path: string, env: NodeJS.ProcessEnv): RefreshBase | Skip {
  const local = policyDefaultBranch(path, env);
  if ('error' in local) return skip('default_branch_unknown', local.error);
  const listed = git(path, ['ls-remote', '--heads', 'origin', `refs/heads/${REFRESH_BRANCH}`], env);
  if (listed.error || listed.status !== 0) return skip('fetch_failed', commandFailure('git ls-remote origin', listed));
  const refreshListed = listed.stdout.trim() !== '';
  const refspecs = [`+refs/heads/${local.branch}:refs/remotes/origin/${local.branch}`,
    ...(refreshListed ? [`+refs/heads/${REFRESH_BRANCH}:refs/remotes/origin/${REFRESH_BRANCH}`] : [])];
  const fetched = git(path, ['fetch', '--quiet', '--no-tags', 'origin', ...refspecs], env);
  if (fetched.error || fetched.status !== 0) return skip('fetch_failed', commandFailure(`git fetch origin ${local.branch}`, fetched));
  const remote = policyDefaultBranch(path, env, `refs/remotes/origin/${local.branch}`);
  if ('error' in remote) return skip('default_branch_unknown', remote.error);
  if (remote.branch !== local.branch) {
    return skip('default_branch_unknown', `origin/${local.branch} names the base branch ${remote.branch}; the checkout policy names ${local.branch}`);
  }
  return {
    base: local.branch,
    baseOid: revParse(path, `refs/remotes/origin/${local.branch}`, env),
    refreshOid: refreshListed ? revParse(path, `refs/remotes/origin/${REFRESH_BRANCH}`, env) : null,
  };
}

/** Commits on the remote refresh branch that are not this tool's refresh commits by this author. */
function foreignRefreshCommits(path: string, base: RefreshBase, env: NodeJS.ProcessEnv): string | null {
  if (base.refreshOid === null) return null;
  const ident = git(path, ['var', 'GIT_AUTHOR_IDENT'], env);
  if (ident.error || ident.status !== 0) throw new Error(commandFailure('git var GIT_AUTHOR_IDENT', ident));
  const email = /<([^>]*)>/.exec(ident.stdout)?.[1];
  if (email === undefined) throw new Error(`git var GIT_AUTHOR_IDENT printed no email: ${ident.stdout.trim()}`);
  const log = git(path, ['log', '--format=%ae%x00%s', `${base.baseOid}..${base.refreshOid}`], env);
  if (log.error || log.status !== 0) throw new Error(commandFailure(`git log origin/${REFRESH_BRANCH}`, log));
  const commits = log.stdout.split('\n').filter((line) => line !== '').map((line) => line.split('\0'));
  const foreign = commits.filter(([author, subject]) => author !== email || !subject?.startsWith(REFRESH_SUBJECT));
  return foreign.length === 0 ? null
    : `origin/${REFRESH_BRANCH} has ${foreign.length} of ${commits.length} commits that are not refresh commits by ${email}`;
}

/** Opens the PR of the refresh branch, or updates the open one when this run pushed. */
function publishRefreshPr(worktree: string, base: string, title: string, pushed: boolean, env: NodeJS.ProcessEnv):
  { readonly url: string; readonly action: 'created' | 'updated' | 'open' } | { readonly error: string } {
  const body = `Refresh the repo-harness tracked files for ${title.slice(REFRESH_SUBJECT.length)}.\n\nCreated by \`rh upgrade --registered --apply --pr\`. It never merges.\n`;
  const listed = gh(worktree, ['pr', 'list', '--head', REFRESH_BRANCH, '--base', base, '--state', 'open', '--json', 'url', '--limit', '1'], env);
  if (listed.error || listed.status !== 0) return { error: commandFailure('gh pr list', listed) };
  let open: unknown;
  try { open = JSON.parse(listed.stdout); } catch { return { error: `gh pr list printed no JSON array: ${listed.stdout.trim()}` }; }
  if (!Array.isArray(open)) return { error: `gh pr list printed no JSON array: ${listed.stdout.trim()}` };
  const url = (open[0] as { url?: unknown } | undefined)?.url;
  if (typeof url === 'string') {
    if (!pushed) return { url, action: 'open' };
    const edited = gh(worktree, ['pr', 'edit', url, '--title', title, '--body', body], env);
    return edited.error || edited.status !== 0 ? { error: commandFailure('gh pr edit', edited) } : { url, action: 'updated' };
  }
  const created = gh(worktree, ['pr', 'create', '--base', base, '--head', REFRESH_BRANCH, '--title', title, '--body', body], env);
  if (created.error || created.status !== 0) return { error: commandFailure('gh pr create', created) };
  return { url: created.stdout.trim().split('\n').pop() ?? '', action: 'created' };
}

/** The init refresh and the project upgrade in the worktree, then the commit, the push and the PR. */
function refreshInWorktree(path: string, worktree: string, base: RefreshBase, env: NodeJS.ProcessEnv, callerCwd: string): RegisteredRepoResult {
  const planned = planRepoAdoption({ repo: worktree, mode: 'standard', explicitRepo: true, env });
  if (planned.error) return { path, status: 'failed', error: `init plan failed: ${planned.error.code} - ${planned.error.message}` };
  // The repo is already registered; registration from the worktree path would be refused.
  const applied = applyAdoptionPlan({ ...planned.plan, apply: true });
  // The transaction records stay in the worktree, which is removed, so no rollback command is reported.
  const init = initApplyResult(applied.ok, planned.plan.summary.plannedTotal, { ...applied, transactionManifestPath: undefined }, []);
  if (!init.ok) return { path, status: 'failed', init, error: `init refresh failed: ${init.errors?.join('; ') || 'not ok'}` };
  const upgrade = runUpgrade({ cwd: worktree, callerCwd, scope: 'project', apply: true, env, legacyWorktreeCleanup: false });
  if (upgrade.error) return { path, status: 'failed', init, upgrade, error: `project upgrade failed: ${upgrade.error}` };

  const step = (args: readonly string[]): string => {
    const result = git(worktree, args, env);
    if (result.error || result.status !== 0) throw new Error(commandFailure(`git ${args[0]}`, result));
    return result.stdout.trim();
  };
  // The init and upgrade backups are local rollback records, not refreshed files.
  step(['add', '--all', '--', '.', `:(exclude)${FS_TRANSACTION_BACKUP_ROOT}`]);
  const staged = git(worktree, ['diff', '--cached', '--quiet'], env);
  if (staged.error || (staged.status !== 0 && staged.status !== 1)) throw new Error(commandFailure('git diff --cached', staged));
  if (staged.status === 0) return { path, status: 'applied', init, upgrade, refresh: { outcome: 'up_to_date' } };
  const title = `${REFRESH_SUBJECT}${PACKAGE_VERSION}`;
  step(['commit', '--quiet', '-m', title]);
  const commit = revParse(worktree, 'HEAD', env);

  const unchanged = base.refreshOid !== null
    && step(['rev-parse', `${base.refreshOid}^{tree}`]) === step(['rev-parse', 'HEAD^{tree}'])
    && step(['rev-parse', `${base.refreshOid}^`]) === base.baseOid;
  if (!unchanged) {
    // The lease names the commit that the foreign check inspected; an empty lease requires a new branch.
    const pushed = git(worktree, ['push', '--quiet', `--force-with-lease=refs/heads/${REFRESH_BRANCH}:${base.refreshOid ?? ''}`,
      'origin', `HEAD:refs/heads/${REFRESH_BRANCH}`], env);
    if (pushed.error || pushed.status !== 0) return skipped(path, skip('push_failed', commandFailure('git push origin', pushed)));
  }
  const pr = publishRefreshPr(worktree, base.base, title, !unchanged, env);
  if ('error' in pr) return skipped(path, skip('pr_failed', pr.error));
  return { path, status: 'applied', init, upgrade, refresh: {
    outcome: unchanged ? 'unchanged' : 'pushed', branch: REFRESH_BRANCH, commit: unchanged ? base.refreshOid! : commit, pr: pr.url, prAction: pr.action,
  } };
}

/**
 * The `--pr` write sequence. Every write goes to a new worktree on the refresh
 * branch; the primary checkout keeps its files, branch and index. The worktree
 * and its local branch are removed on every path. Nothing merges.
 */
function refreshRepoPr(path: string, env: NodeJS.ProcessEnv, callerCwd: string): RegisteredRepoResult {
  const access = prRefreshability(path, classifyRepo(path, env), env);
  if (!access.ready) return skipped(path, access);
  const base = fetchRefreshBase(path, env);
  if ('ready' in base) return skipped(path, base);
  const foreign = foreignRefreshCommits(path, base, env);
  if (foreign) return skipped(path, skip('refresh_branch_foreign', foreign));

  const worktree = join(tmpdir(), `${basename(path)}-wt-harness-refresh`);
  const added = git(path, ['worktree', 'add', '--quiet', '-b', REFRESH_BRANCH, worktree, base.baseOid], env);
  if (added.error || added.status !== 0) return { path, status: 'failed', error: commandFailure(`git worktree add ${worktree}`, added) };
  let result: RegisteredRepoResult;
  try { result = refreshInWorktree(path, worktree, base, env, callerCwd); }
  catch (error) { result = { path, status: 'failed', error: message(error) }; }
  const cleanup = [
    git(path, ['worktree', 'remove', '--force', worktree], env),
    git(path, ['branch', '--quiet', '-D', REFRESH_BRANCH], env),
  ].flatMap((removed, index) => removed.error || removed.status !== 0
    ? [commandFailure(index === 0 ? `git worktree remove ${worktree}` : `git branch -D ${REFRESH_BRANCH}`, removed)] : []);
  return cleanup.length === 0 ? result
    : { ...result, status: 'failed', error: [result.error, `cleanup failed: ${cleanup.join('; ')}`].filter(Boolean).join('; ') };
}

/**
 * Project upgrade for every registered repo. Targets come from one strict
 * registry snapshot; nothing scans directories. The default is a read-only
 * preview. `apply` needs the preview's plan revision, which binds the registry
 * revision and every sweep plan; each repo is classified, written and reported
 * on its own. Without `pr` nothing is committed; with `pr` each repo gets its
 * refresh branch and PR, and the sweep does not run.
 */
export function runRegisteredUpgrade(opts: RegisteredUpgradeOptions = {}): RegisteredUpgradeResult {
  const apply = opts.apply === true;
  const pr = opts.pr === true;
  const env = opts.env ?? process.env;
  let revision: string | null = null;
  try {
    if (pr && !apply) throw new Error('--pr needs --apply; the preview reports which repos --pr can refresh');
    assertRegistryRevisionFence({ apply, expectedRevision: opts.expectedRevision });
    const snapshot = readRepoHarnessRegistryStrictSnapshot({ env, adoptedOnly: false });
    const callerCwd = opts.callerCwd ?? process.cwd();
    const plans = snapshot.repos.map((repo) => planRepo(repo.path, env, callerCwd));
    revision = planRevision(snapshot.registryRevision, snapshot.repos, plans);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== revision) {
      throw new Error('registry or worktree sweep plan changed; preview again before applying');
    }
    const repos = snapshot.repos.map((repo, index): RegisteredRepoResult => {
      const plan = plans[index]!;
      try {
        if (!apply) return previewRepo(repo.path, env, callerCwd, plan);
        if (pr) return refreshRepoPr(repo.path, env, callerCwd);
        return applyRepo(repo.path, env, callerCwd, approvedSweep(plan));
      } catch (error) {
        return { path: repo.path, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      }
    });
    const failed = repos.some((repo) => repo.status === 'failed' || (repo.reason !== undefined && FAILED_COMMAND_SKIPS.has(repo.reason)));
    const pending = repos.some((repo) => repo.pending === true);
    return { revision, apply, ...(pr ? { pr: true as const } : {}), exitCode: failed || pending ? 1 : 0, repos };
  } catch (error) {
    return { revision, apply, ...(pr ? { pr: true as const } : {}), exitCode: 2, repos: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function indent(text: string, prefix: string): string[] {
  return text.trimEnd().split('\n').map((line) => `${prefix}${line}`);
}

function formatInit(init: RegisteredInitPreview | RegisteredInitApply): string[] {
  if ('operations' in init) {
    return [`  init: ${init.planned} planned operations`,
      ...init.operations.map((operation) => `    ${operation.kind}${operation.path === undefined ? '' : ` ${operation.path}`}`)];
  }
  const lines = [`  init: ${init.ok ? 'ok' : 'failed'}; ${init.planned} planned, ${init.applied} applied, ${init.failed} failed`];
  if (init.transaction) lines.push(`    rollback: rh init rollback --transaction ${init.transaction}`);
  if (init.rollbackOk !== undefined) lines.push(`    automatic rollback: ${init.rollbackOk ? 'complete' : 'incomplete'}`);
  for (const error of init.errors ?? []) lines.push(`    error: ${error}`);
  return lines;
}

function formatSweep(sweep: RegisteredSweep): string[] {
  if (sweep.ran) return sweep.report === null ? ['  sweep: no managed worktrees'] : ['  sweep:', ...indent(sweep.report, '    ')];
  if ('error' in sweep) return [`  sweep: ${sweep.error}; apply takes no sweep step`];
  if (sweep.plan === null) return ['  sweep: no managed worktrees'];
  return [`  sweep plan: target ${sweep.plan.target_oid ?? 'none'}`, ...sweep.plan.items.map((item) =>
    `    ${item.action} ${item.path}${item.branch ? ` (${item.branch})` : ''}${item.reason ? `: ${item.reason}` : ''}`)];
}

function formatRefresh(refresh: RegisteredRefresh): string {
  if (refresh.outcome === 'up_to_date') return '  refresh: up to date';
  const push = refresh.outcome === 'pushed' ? `pushed ${refresh.branch} at ${refresh.commit}` : `${refresh.branch} unchanged at ${refresh.commit}`;
  return `  refresh: ${push}; PR ${refresh.prAction}: ${refresh.pr}`;
}

export function formatRegisteredUpgradeResult(result: RegisteredUpgradeResult, asJson = false): string {
  if (asJson) return formatJson(result);
  const lines = [
    `${result.apply ? 'Registered upgrade apply' : 'Registered upgrade preview'}. Plan revision: ${result.revision ?? 'unavailable'}`,
  ];
  for (const repo of result.repos) {
    const head = repo.status === 'skipped' ? `skipped (${repo.reason}): ${repo.detail}`
      : repo.status === 'ready' ? `ready; ${repo.pending ? 'pending' : 'up to date'}` : repo.status;
    lines.push(`${repo.path}: ${head}`);
    if (repo.init) lines.push(...formatInit(repo.init));
    if (repo.upgrade) lines.push('  upgrade:', ...indent(formatUpgradeResult(repo.upgrade), '    '));
    if (repo.sweep) lines.push(...formatSweep(repo.sweep));
    if (repo.prRefresh) {
      lines.push(repo.prRefresh.ready ? '  --pr: can refresh'
        : `  --pr: cannot refresh (${repo.prRefresh.reason})${repo.prRefresh.reason === repo.reason ? '' : `: ${repo.prRefresh.detail}`}`);
    }
    if (repo.refresh) lines.push(formatRefresh(repo.refresh));
    if (repo.error) lines.push(`  failed: ${repo.error}`);
  }
  if (result.repos.length === 0 && !result.error) lines.push('No registered repos.');
  if (result.error) lines.push(`Failed: ${result.error}`);
  else if (!result.apply && result.revision) {
    lines.push(`Apply: rh upgrade --registered --apply --expected-revision ${result.revision}`);
    if (result.repos.some((repo) => repo.prRefresh?.ready)) {
      lines.push(`Apply with one PR per repo: rh upgrade --registered --apply --pr --expected-revision ${result.revision}`);
    }
  }
  if (result.apply && !result.pr && !result.error) lines.push('Nothing was committed. Review and commit each repo.');
  return `${lines.join('\n')}\n`;
}
