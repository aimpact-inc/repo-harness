import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ArchitectureDebtItemV1, ArchitectureDebtReportV1 } from 'archctx-contracts';
import { version as PACKAGE_VERSION } from '../../../package.json';
import {
  completeArchitectureDebt,
  seedWorktreeCodeGraph,
  stopWorkspaceArchitectureDaemons,
} from '../../effects/architecture/archctx-provider';
import { loadArchitectureProjectionPolicy } from '../../effects/architecture/projection-config';
import { ArchctxClientError, decodeArchitectureDebtReport } from '../../core/architecture/projection';
import type { ArchctxProviderOptions } from '../../core/architecture/contracts';
import { retryWindowsSharingRace } from '../../effects/atomic-append';
import { gitSpawnSync } from '../../effects/git/runner';
import { recordWorktree, endWorktreeRecord, readWorktreeRecord, type WorktreeRecord } from '../../effects/git/worktree-record';
import { resolveGitCommonDirectory } from '../../effects/git/common-directory';
import { ExclusiveLockContentionError, withExclusiveDirectoryLock } from '../../effects/locking/exclusive-directory-lock';
import { currentProcessStartTime, readProcessStartTime } from '../../effects/locking/process-start-time';

const BASE_CHECKOUT_PREFIX = 'repo-harness-debt-base-';
const BASE_CHECKOUT_OWNER = 'owner.json';
const INTERRUPT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export interface ArchitectureDebtOutputV1 {
  kind: 'repo-harness-architecture-debt';
  head: { sha: string; debt: ArchitectureDebtReportV1 };
  base: null | { ref: string; sha: string; debtDigest: string; coverage: ArchitectureDebtReportV1['coverage']; coverageReasonCodes: string[] };
  /** Head items whose id is not in the base report, in id order. */
  introduced: null | ArchitectureDebtItemV1[];
  /** Base item ids that are not in the head report, in id order. */
  resolvedIds: null | string[];
}

/**
 * Measures the debt at HEAD. With a base ref, it also measures the base commit
 * in a temporary detached checkout, or reads the cached base report, and
 * compares the two reports by item id. The ids are content identities, so they
 * compare across checkouts.
 */
export function architectureDebtReport(repoRoot: string, baseRef: string | undefined, options: ArchctxProviderOptions = {}): ArchitectureDebtOutputV1 {
  const headSha = resolveCommit(repoRoot, 'HEAD');
  // An unresolvable base fails before archctx runs.
  const baseCommit = baseRef === undefined ? null : { ref: baseRef, sha: resolveCommit(repoRoot, baseRef) };
  const head = completeArchitectureDebt(repoRoot, headSha, options);
  if (baseCommit === null) return { kind: 'repo-harness-architecture-debt', head: { sha: headSha, debt: head }, base: null, introduced: null, resolvedIds: null };
  const base = cachedBaseDebt(repoRoot, baseCommit.sha, options, () => withBaseCheckout(repoRoot, baseCommit.sha, options, (checkout) => {
    seedWorktreeCodeGraph(checkout, options);
    return completeArchitectureDebt(checkout, baseCommit.sha, options);
  }));
  const baseIds = new Set(base.items.map((item) => item.id));
  const headIds = new Set(head.items.map((item) => item.id));
  return {
    kind: 'repo-harness-architecture-debt',
    head: { sha: headSha, debt: head },
    base: { ...baseCommit, debtDigest: base.digest, coverage: base.coverage, coverageReasonCodes: base.coverageReasonCodes },
    // The decoder proved that both item lists are sorted by id.
    introduced: head.items.filter((item) => !baseIds.has(item.id)),
    resolvedIds: base.items.map((item) => item.id).filter((id) => !headIds.has(id)),
  };
}

export function architectureDebtSummary(output: ArchitectureDebtOutputV1): string {
  const debt = output.head.debt;
  const counts = new Map<string, number>();
  for (const item of debt.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const lines = [`architecture debt at HEAD ${output.head.sha.slice(0, 12)}: ${debt.items.length} items, coverage ${debt.coverage}`];
  for (const [kind, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${kind}: ${count}`);
  if (debt.coverageReasonCodes.length > 0) lines.push(`  coverage gaps: ${debt.coverageReasonCodes.join(', ')}`);
  if (output.base && output.introduced && output.resolvedIds) {
    lines.push(`base ${output.base.ref} ${output.base.sha.slice(0, 12)}: coverage ${output.base.coverage}; introduced ${output.introduced.length}, resolved ${output.resolvedIds.length}`);
    if (output.base.coverageReasonCodes.length > 0) lines.push(`  base coverage gaps: ${output.base.coverageReasonCodes.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function resolveCommit(repoRoot: string, ref: string): string {
  const result = gitSpawnSync(['-C', repoRoot, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { encoding: 'utf8' });
  const sha = result.status === 0 ? result.stdout.trim() : '';
  if (!/^[a-f0-9]{40,64}$/.test(sha)) {
    throw new ArchctxClientError({ code: 'RH_ARCHITECTURE_DEBT_REF_UNRESOLVED', action: 'pass-a-commit-ref', reasonCode: 'ref-unresolved', details: { ref }, message: `${ref} does not resolve to a commit` });
  }
  return sha;
}

/**
 * A base report depends only on the base commit, its `.archcontext` model and
 * the tool version, so parallel runs on one base share one measurement. The
 * lock makes N concurrent runs build at most one checkout; the rename makes a
 * reader see a whole report or none. A HEAD report is never cached.
 */
function cachedBaseDebt(repoRoot: string, sha: string, options: ArchctxProviderOptions, measure: () => ArchitectureDebtReportV1): ArchitectureDebtReportV1 {
  const directory = join(resolveGitCommonDirectory(repoRoot), 'repo-harness', 'cache', 'arch-debt');
  const name = `${sha}-${archcontextTree(repoRoot, sha)}-${PACKAGE_VERSION}`;
  const file = join(directory, `${name}.json`);
  const hit = readCachedBaseDebt(file, sha);
  if (hit) return hit;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const policy = options.policy ?? loadArchitectureProjectionPolicy(options.env);
  // A holder runs CodeGraph init, archctx doctor and archctx complete, each bounded by the policy timeout, then the daemon stop.
  const waitTimeoutMs = 4 * policy.timeoutMs;
  try {
    return withExclusiveDirectoryLock(realpathSync(directory), `${name}.lock`, () => {
      const cached = readCachedBaseDebt(file, sha);
      if (cached) return cached;
      const report = measure();
      const temporary = `${file}.${randomUUID()}`;
      try {
        writeFileSync(temporary, `${JSON.stringify({ sha, report })}\n`, { flag: 'wx', mode: 0o600 });
        retryWindowsSharingRace(() => renameSync(temporary, file));
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
      return report;
    }, { reclaimStaleOwner: true, waitTimeoutMs });
  } catch (error) {
    if (!(error instanceof ExclusiveLockContentionError)) throw error;
    throw new ArchctxClientError({ code: 'RH_ARCHITECTURE_DEBT_CACHE_LOCKED', action: 'retry-architecture-debt', reasonCode: 'base-debt-cache-locked', details: { lock: error.lockPath }, message: `another run still measures base ${sha}: ${error.message}` });
  }
}

/** The tree id of the base commit's `.archcontext` directory, or `none` when the commit has none. */
function archcontextTree(repoRoot: string, sha: string): string {
  const listed = gitSpawnSync(['-C', repoRoot, 'ls-tree', '-d', sha, '--', '.archcontext'], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-tree ${sha} -- .archcontext failed: ${listed.stderr.trim()}`);
  const match = /^040000 tree ([a-f0-9]{40,64})\t\.archcontext$/m.exec(listed.stdout);
  return match ? match[1]! : 'none';
}

function readCachedBaseDebt(file: string, sha: string): ArchitectureDebtReportV1 | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const record = JSON.parse(text) as { sha?: unknown; report?: unknown };
    if (record.sha !== sha) throw new Error(`the record is for ${String(record.sha)}`);
    return decodeArchitectureDebtReport(record.report);
  } catch (error) {
    throw new ArchctxClientError({ code: 'RH_ARCHITECTURE_DEBT_CACHE_INVALID', action: 'remove-cache-file', reasonCode: 'base-debt-cache-invalid', details: { file }, message: `the cached base debt report ${file} is invalid: ${error instanceof Error ? error.message : String(error)}; remove the file and run again` });
  }
}

/**
 * The base checkout is always closed: its archctx daemons stop, the worktree is
 * removed, and its temporary parent directory is removed. A cleanup
 * failure is an error, also when the base run failed first. Checkouts that an
 * earlier run left behind when it was killed are reaped first.
 */
function withBaseCheckout<T>(repoRoot: string, sha: string, options: ArchctxProviderOptions, work: (checkout: string) => T): T {
  reapOrphanBaseCheckouts(repoRoot, options);
  const parent = mkdtempSync(join(tmpdir(), BASE_CHECKOUT_PREFIX));
  const checkout = join(parent, 'checkout');
  // The owner record exists before the worktree, so every checkout this tool registers has an owner to test.
  writeFileSync(join(parent, BASE_CHECKOUT_OWNER), `${JSON.stringify({ pid: process.pid, start_time: currentProcessStartTime() })}\n`, { flag: 'wx', mode: 0o600 });
  let issues: string[] | null = null;
  const close = (): string[] => issues ??= closeBaseCheckout(repoRoot, parent, checkout, options);
  const detach = (): void => { for (const signal of INTERRUPT_SIGNALS) process.removeListener(signal, onSignal); };
  // The work is synchronous, so a caught signal is dispatched only after it returns.
  // The handler replaces the default action, which would kill this process before
  // the close below; the handler then closes (a no-op once closed) and re-raises.
  function onSignal(signal: NodeJS.Signals): void {
    close();
    detach();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  }
  for (const signal of INTERRUPT_SIGNALS) process.on(signal, onSignal);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  let record: WorktreeRecord | null = null;
  // Hooks of the measured repository do not run in the temporary checkout.
  const added = gitSpawnSync(['-C', repoRoot, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', checkout, sha], { encoding: 'utf8' });
  if (added.status !== 0) {
    outcome = { ok: false, error: new ArchctxClientError({ code: 'RH_ARCHITECTURE_DEBT_CHECKOUT_FAILED', action: 'inspect-git-worktree', reasonCode: 'worktree-add-failed', details: { sha }, message: `git worktree add for ${sha} failed: ${added.stderr.trim()}` }) };
  } else {
    try {
      record = recordWorktree(repoRoot, checkout, { creator: 'task', purpose: 'architecture base inspection', task_id: sha });
      outcome = { ok: true, value: work(realpathSync(checkout)) };
    }
    catch (error) { outcome = { ok: false, error }; }
  }
  const closeIssues = close();
  // A signal caught during the work is dispatched on the next turn of the event loop; keep the handler until then.
  setImmediate(detach);
  if (closeIssues.length === 0) endWorktreeRecord(resolveGitCommonDirectory(repoRoot), record, 'removed');
  if (closeIssues.length > 0) {
    const baseError = outcome.ok ? null : outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    throw new ArchctxClientError({
      code: 'RH_ARCHITECTURE_DEBT_CLEANUP_FAILED', action: 'remove-base-checkout', reasonCode: 'base-checkout-cleanup-failed',
      details: { checkout, issues: closeIssues, baseError },
      message: `the temporary base checkout ${checkout} was not fully closed: ${closeIssues.join('; ')}${baseError === null ? '' : `; the base run also failed: ${baseError}`}`,
    });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Removes registered base checkouts of this repository whose owner process is
 * gone. Only a `checkout` entry in a `repo-harness-debt-base-` directory directly
 * under the temporary directory, with this tool's owner record, qualifies. Each entry is removed by path; a repository-wide
 * `git worktree prune` would also drop other stale registrations.
 */
function reapOrphanBaseCheckouts(repoRoot: string, options: ArchctxProviderOptions): void {
  const listed = gitSpawnSync(['-C', repoRoot, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git worktree list failed: ${listed.stderr.trim()}`);
  const temporaryRoot = realpathSync(tmpdir());
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const checkout = line.slice('worktree '.length);
    const parent = dirname(checkout);
    if (basename(checkout) !== 'checkout' || !basename(parent).startsWith(BASE_CHECKOUT_PREFIX)) continue;
    let realParent: string;
    try { realParent = realpathSync(parent); } catch { continue; }
    if (dirname(realParent) !== temporaryRoot || !baseCheckoutOwnerIsDead(realParent)) continue;
    const record = existsSync(checkout) ? readWorktreeRecord(resolveGitCommonDirectory(repoRoot), checkout) : null;
    const issues = closeBaseCheckout(repoRoot, parent, checkout, options);
    if (issues.length > 0) {
      throw new ArchctxClientError({
        code: 'RH_ARCHITECTURE_DEBT_CLEANUP_FAILED', action: 'remove-base-checkout', reasonCode: 'orphan-base-checkout-cleanup-failed',
        details: { checkout, issues },
        message: `the orphaned base checkout ${checkout} was not fully closed: ${issues.join('; ')}`,
      });
    }
    endWorktreeRecord(resolveGitCommonDirectory(repoRoot), record, 'removed');
  }
}

/** Dead means no process runs as the recorded owner. A missing record, or an unreadable process table, proves nothing. */
function baseCheckoutOwnerIsDead(parent: string): boolean {
  let owner: { pid?: unknown; start_time?: unknown };
  try { owner = JSON.parse(readFileSync(join(parent, BASE_CHECKOUT_OWNER), 'utf8')) as typeof owner; } catch { return false; }
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1 || typeof owner.start_time !== 'string') return false;
  try { return readProcessStartTime(owner.pid as number) !== owner.start_time; } catch { return false; }
}

function closeBaseCheckout(repoRoot: string, parent: string, checkout: string, options: ArchctxProviderOptions): string[] {
  const issues: string[] = [];
  if (existsSync(checkout)) {
    try {
      const report = stopWorkspaceArchitectureDaemons(repoRoot, realpathSync(checkout), options);
      for (const failure of report.failures) issues.push(`archctx daemon stop ${failure.stateDir ?? '(listing)'}: ${failure.code} ${failure.action}: ${failure.message}`);
    } catch (error) { issues.push(`archctx daemon stop: ${error instanceof Error ? error.message : String(error)}`); }
    const removed = gitSpawnSync(['-C', repoRoot, 'worktree', 'remove', '--force', checkout], { encoding: 'utf8' });
    // A concurrent reaper may have removed the same orphan first.
    if (removed.status !== 0 && existsSync(checkout)) issues.push(`git worktree remove: ${removed.stderr.trim()}`);
  }
  // The owner record stays while the checkout stays, so a later run can still reap it.
  if (existsSync(checkout)) return issues;
  try {
    rmSync(join(parent, BASE_CHECKOUT_OWNER), { force: true });
    rmdirSync(parent);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push(`remove ${parent}: ${error instanceof Error ? error.message : String(error)}`); }
  return issues;
}

/** `rh arch debt` loads this module only after the architecture selection check. */
export function runArchitectureDebtCommand(options: { json?: boolean; base?: string }): void {
  try {
    const output = architectureDebtReport(git(process.cwd(), ['rev-parse', '--show-toplevel']), options.base);
    process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : architectureDebtSummary(output));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function git(cwd: string, args: string[]): string {
  const result = gitSpawnSync(['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}
