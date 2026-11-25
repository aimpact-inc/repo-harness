import { controlledWorktreeProcessPreload, setControlledWorktreeProcesses, writeControlledWorktreeProcessesConfig } from './helpers/controlled-worktree-processes';
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { commitAll, initGitRepo as initFixtureGitRepo, run, tmpWorkspace } from "./helpers/repo-fixture";
import { executeAdmittedVerification } from "../src/effects/evidence/verification-execution";
import { seedReviewAdmissionFixture } from './helpers/review-admission-fixture';
import { parseVerificationPlanFromContractText } from '../src/core/evidence/verification-plan';
import { nativeVerificationPlan } from "./state/effective-state-fixture";
import { boundSweepSteps, planManagedWorktreeSweep, removeExactWorktree, removeGreenWorktrees, sweepManagedWorktrees } from "../src/effects/state/coordination-worktree-topology";
import { readPrunedWorktreeIntents } from "../src/effects/state/pruned-worktree-intents";
import { listHelperFiles } from "../src/effects/runtime/helper-runner";
import { workspaceDirectory } from '../src/effects/terminal/task-session-record';
import { ensureSessionDirectory } from '../src/effects/terminal/task-session-io';

// Regression guard for the squash-merge absorption predicate in the cleanup
// branch of `scripts/contract-worktree.sh`. See:
//   plans/plan-20260731-0952-contract-worktree-squash-cleanup.md
//   tasks/contracts/20260731-0952-contract-worktree-squash-cleanup.contract.md
//
// This composition checks cleanup absorption through contract-worktree and
// the managed worktree sweep against real Git history.

const ROOT = join(import.meta.dir, "..");
const HELPER_DIR = join(ROOT, "scripts");

setDefaultTimeout(30000);

function initGitRepo(cwd: string): void {
  initFixtureGitRepo(cwd);
  writeControlledWorktreeProcessesConfig(cwd);
}







function copyHelpers(cwd: string) {
  const scriptsDir = join(cwd, "scripts");
  const harnessScriptsDir = join(cwd, ".ai", "harness", "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(harnessScriptsDir, { recursive: true });
  mkdirSync(join(cwd, ".ai", "harness"), { recursive: true });
  mkdirSync(join(cwd, ".ai", "harness", "triage"), { recursive: true });
  mkdirSync(join(cwd, "docs", "architecture"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  symlinkSync(join(ROOT, "src/effects"), join(cwd, "src/effects"), "dir");
  symlinkSync(join(ROOT, "src/core"), join(cwd, "src/core"), "dir");
  // The worktree runtime reads the recorded install selection through src/cli/installer.
  symlinkSync(join(ROOT, "src/cli"), join(cwd, "src/cli"), "dir");
  // The helpers start archctx and CodeGraph only through the shared gate in scripts/lib.
  symlinkSync(join(HELPER_DIR, "lib"), join(scriptsDir, "lib"), "dir");

  for (const file of listHelperFiles({ REPO_HARNESS_SOURCE_ROOT: ROOT })) {
    copyFileSync(join(HELPER_DIR, file), join(scriptsDir, file));
    copyFileSync(join(HELPER_DIR, file), join(harnessScriptsDir, file));
  }
  copyFileSync(join(ROOT, "assets/workflow-contract.v1.json"), join(cwd, ".ai/harness/workflow-contract.json"));
  writeFileSync(join(cwd, ".ai", "harness", "triage", ".gitkeep"), "");
  if (!existsSync(join(cwd, "docs/architecture/index.md"))) {
    writeFileSync(
      join(cwd, "docs/architecture/index.md"),
      [
        "# Architecture Index",
        "",
        "## Pending Requests",
        "",
        "<!-- BEGIN ARCHITECTURE PENDING REQUESTS -->",
        "- (none)",
        "<!-- END ARCHITECTURE PENDING REQUESTS -->",
        "",
      ].join("\n"),
    );
  }

  expect(run("bash", ["-lc", "chmod +x scripts/*.sh"], cwd).status).toBe(0);
  expect(run("bash", ["-lc", "chmod +x .ai/harness/scripts/*.sh"], cwd).status).toBe(0);
}

describe("contract-worktree cleanup squash-merge absorption", () => {
  test("cleanup retains a merged clean worktree that holds an ignored native ledger and executed run", () => {
    const cwd = tmpWorkspace("cleanup-native-evidence");
    const worktreePath = `${cwd}-wt-native-evidence`;
    const authorityHome = tmpWorkspace("cleanup-authority");
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, ".gitignore"), ".ai/harness/worktrees/\n.ai/harness/evidence/\n.ai/harness/runs/\n");
      mkdirSync(join(cwd, "tasks/contracts"), { recursive: true });
      const contract = "tasks/contracts/native.contract.md";
      writeFileSync(join(cwd, contract), "# Native Contract\n" + nativeVerificationPlan());
      writeFileSync(join(cwd, "feature.txt"), "fixture\n");
      commitAll(cwd, "native cleanup fixture");
      expect(run("git", ["worktree", "add", worktreePath, "-b", "codex/native-evidence"], cwd).status).toBe(0);
      const { source: authority } = seedReviewAdmissionFixture(worktreePath, authorityHome, {
        plan: parseVerificationPlanFromContractText(readFileSync(join(worktreePath, contract), 'utf8')),
      });
      const report = executeAdmittedVerification({ repoRoot: worktreePath, authority });
      expect(report.passed).toBe(true);
      expect(report.kind).toBe("verification_execution_report");
      expect(report.results).toHaveLength(1);
      expect(report.results[0]!.execution).toBe("executed");
      const runPath = join(worktreePath, report.results[0]!.run_file!);
      const ledgerPath = join(worktreePath, ".ai/harness/evidence/events/log.jsonl");
      const runBytes = readFileSync(runPath, "utf8");
      const ledgerBytes = readFileSync(ledgerPath, "utf8");
      expect(ledgerBytes.length).toBeGreaterThan(0);
      expect(run("git", ["status", "--porcelain"], worktreePath).stdout).toBe("");
      mkdirSync(join(cwd, ".ai/harness/worktrees"), { recursive: true });
      const metadataPath = join(cwd, ".ai/harness/worktrees/native-evidence.json");
      const metadata = '{"slug":"native-evidence","branch":"codex/native-evidence"}\n';
      writeFileSync(metadataPath, metadata);
      for (const extra of [["--dry-run"], []]) {
        const result = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "native-evidence", ...extra], cwd);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain('ignored worktree data');
        expect(result.stderr).toContain('.ai/harness/evidence/events/log.jsonl');
        expect(result.stdout).not.toContain('would remove worktree');
        expect(readFileSync(runPath, "utf8")).toBe(runBytes);
        expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBytes);
        expect(readFileSync(metadataPath, "utf8")).toBe(metadata);
        expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/native-evidence"], cwd).status).toBe(0);
      }
    } finally {
      rmSync(authorityHome, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("cleanup accepts a squash-merged branch via merge-tree absorption (dry-run)", () => {
    const cwd = tmpWorkspace("helper-cleanup-squash-absorbed");
    const worktreePath = `${cwd}-wt-squash-demo`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      commitAll(cwd, "init squash cleanup");

      expect(run("git", ["worktree", "add", worktreePath, "-b", "codex/squash-demo"], cwd).status).toBe(0);
      writeFileSync(join(worktreePath, "feature.txt"), "squash feature\n");
      commitAll(worktreePath, "add squash feature");

      // Simulate the repo's house ship flow: squash the branch onto main.
      // The branch tip is now NOT an ancestor of main -- that structural
      // mismatch is exactly what the ancestry-only check cannot see past.
      expect(run("git", ["merge", "--squash", "codex/squash-demo"], cwd).status).toBe(0);
      commitAll(cwd, "squash-merge codex/squash-demo");
      expect(
        run("git", ["merge-base", "--is-ancestor", "codex/squash-demo", "main"], cwd).status,
      ).not.toBe(0);

      mkdirSync(join(cwd, ".ai/harness/worktrees"), { recursive: true });
      writeFileSync(join(cwd, ".ai/harness/worktrees/squash-demo.json"), '{"slug":"squash-demo","branch":"codex/squash-demo"}\n');

      const unpublished = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "squash-demo", "--dry-run"], cwd);
      expect(unpublished.status).toBe(1);
      expect(unpublished.stderr).toContain('has unpushed commits');
      expect(run("git", ["update-ref", "refs/remotes/origin/squash-demo", "codex/squash-demo"], cwd).status).toBe(0);
      const dryRun = run(
        "bash",
        ["scripts/contract-worktree.sh", "cleanup", "--slug", "squash-demo", "--dry-run"],
        cwd,
      );
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain("absorbed");
      expect(dryRun.stdout).toContain("dry-run cleanup");
      expect(dryRun.stdout).toContain("would remove worktree");
      expect(dryRun.stdout).toContain("would delete branch: codex/squash-demo");
      expect(dryRun.stdout).toContain("would remove metadata");

      // dry-run must not touch anything
      expect(existsSync(worktreePath)).toBe(true);
      expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/squash-demo"], cwd).status).toBe(0);
      expect(existsSync(join(cwd, ".ai/harness/worktrees/squash-demo.json"))).toBe(true);
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("cleanup still refuses a squash-merged branch carrying an unmerged extra commit (fail-closed)", () => {
    const cwd = tmpWorkspace("helper-cleanup-squash-extra");
    const worktreePath = `${cwd}-wt-squash-extra`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      commitAll(cwd, "init squash cleanup extra");

      expect(run("git", ["worktree", "add", worktreePath, "-b", "codex/squash-extra"], cwd).status).toBe(0);
      writeFileSync(join(worktreePath, "feature.txt"), "squash feature\n");
      commitAll(worktreePath, "add squash feature");

      expect(run("git", ["merge", "--squash", "codex/squash-extra"], cwd).status).toBe(0);
      commitAll(cwd, "squash-merge codex/squash-extra");

      // Extra commit lands on the branch AFTER the squash-merge landed on
      // main, so main's tree no longer equals the branch's tree. The
      // absorption predicate must reject exactly as the ancestry check does
      // -- this is the falsifier's negative control.
      writeFileSync(join(worktreePath, "extra.txt"), "not on main\n");
      commitAll(worktreePath, "add unmerged extra change");
      mkdirSync(join(cwd, ".ai/harness/worktrees"), { recursive: true });
      writeFileSync(join(cwd, ".ai/harness/worktrees/squash-extra.json"), '{"slug":"squash-extra","branch":"codex/squash-extra"}\n');

      const dryRun = run(
        "bash",
        ["scripts/contract-worktree.sh", "cleanup", "--slug", "squash-extra", "--dry-run"],
        cwd,
      );
      expect(dryRun.status).toBe(1);
      expect(dryRun.stderr).toContain("not fully merged");

      expect(existsSync(worktreePath)).toBe(true);
      expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/squash-extra"], cwd).status).toBe(0);
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  // Regression guard for the branch-deletion half of the fix: the merge
  // gate above already proves absorption/ancestry -- the deletion step must
  // consume that predicate instead of re-deriving it via git's own
  // ancestry-based `-d` safety check, which is a guaranteed false positive
  // for every squash-absorbed branch. See:
  //   plans/plan-20260731-1056-contract-worktree-branch-delete.md
  //   tasks/contracts/20260731-1056-contract-worktree-branch-delete.contract.md
  test("cleanup deletes a squash-merged branch end to end on a real (non-dry-run) run", () => {
    const cwd = tmpWorkspace("helper-cleanup-squash-real");
    const worktreePath = `${cwd}-wt-squash-real`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      commitAll(cwd, "init squash real cleanup");

      expect(run("git", ["worktree", "add", worktreePath, "-b", "codex/squash-real"], cwd).status).toBe(0);
      writeFileSync(join(worktreePath, "feature.txt"), "squash feature\n");
      commitAll(worktreePath, "add squash feature");

      expect(run("git", ["merge", "--squash", "codex/squash-real"], cwd).status).toBe(0);
      commitAll(cwd, "squash-merge codex/squash-real");
      expect(run("git", ["update-ref", "refs/remotes/origin/squash-real", "codex/squash-real"], cwd).status).toBe(0);
      expect(
        run("git", ["merge-base", "--is-ancestor", "codex/squash-real", "main"], cwd).status,
      ).not.toBe(0);

      mkdirSync(join(cwd, ".ai/harness/worktrees"), { recursive: true });
      writeFileSync(join(cwd, ".ai/harness/worktrees/squash-real.json"), '{"slug":"squash-real","branch":"codex/squash-real"}\n');

      const result = run(
        "bash",
        ["scripts/contract-worktree.sh", "cleanup", "--slug", "squash-real"],
        cwd,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("absorbed into main (squash-equivalent tree)");
      expect(result.stdout).toContain("Deleted branch: codex/squash-real (update-ref, absorbed)");

      // The real assertion this test exists for: cleanup must finish in one
      // pass -- worktree, branch, AND metadata all gone, exit 0. Pre-fix,
      // `git branch -d` refuses (not fully merged) and `set -euo pipefail`
      // kills the script before metadata removal, leaving the branch (and
      // possibly the metadata) behind with a non-zero exit.
      expect(existsSync(worktreePath)).toBe(false);
      expect(
        run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/squash-real"], cwd).status,
      ).not.toBe(0);
      expect(existsSync(join(cwd, ".ai/harness/worktrees/squash-real.json"))).toBe(false);
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("cleanup deletes a plain-merged (ancestor) branch at the proven snapshot on a real run", () => {
    const cwd = tmpWorkspace("helper-cleanup-ancestor-real");
    const worktreePath = `${cwd}-wt-ancestor-real`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      commitAll(cwd, "init ancestor real cleanup");

      expect(run("git", ["worktree", "add", worktreePath, "-b", "codex/ancestor-real"], cwd).status).toBe(0);
      writeFileSync(join(worktreePath, "feature.txt"), "ancestor feature\n");
      commitAll(worktreePath, "add ancestor feature");

      // Diverge main so the merge cannot fast-forward -- forces a real merge
      // commit, proving the ancestor predicate (not the absorption
      // fallback) is what fires here, and that the double-insurance -d path
      // still works after the deletion step starts branching on merge_mode.
      writeFileSync(join(cwd, "main-only.txt"), "main-only change\n");
      commitAll(cwd, "diverge main");

      expect(
        run(
          "git",
          ["merge", "--no-ff", "-m", "merge codex/ancestor-real", "codex/ancestor-real"],
          cwd,
        ).status,
      ).toBe(0);
      expect(
        run("git", ["merge-base", "--is-ancestor", "codex/ancestor-real", "main"], cwd).status,
      ).toBe(0);

      mkdirSync(join(cwd, ".ai/harness/worktrees"), { recursive: true });
      writeFileSync(join(cwd, ".ai/harness/worktrees/ancestor-real.json"), '{"slug":"ancestor-real","branch":"codex/ancestor-real"}\n');

      const result = run(
        "bash",
        ["scripts/contract-worktree.sh", "cleanup", "--slug", "ancestor-real"],
        cwd,
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("ancestor of main");
      expect(result.stdout).toContain("Deleted branch: codex/ancestor-real (update-ref, ancestor)");

      expect(existsSync(worktreePath)).toBe(false);
      expect(
        run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/ancestor-real"], cwd).status,
      ).not.toBe(0);
      expect(existsSync(join(cwd, ".ai/harness/worktrees/ancestor-real.json"))).toBe(false);
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);
});

describe("provider merge proof after a later conflicting target edit", () => {
  /** A stub answer that is not a JSON value, or that exits non-zero. */
  class RawAnswer { constructor(readonly stdout: string, readonly exit = 0) {} }
  /** Answer N serves provider call N. Later calls reuse the last answer. */
  function squashFixture(...answers: Array<(squash: string, target: string, head: string) => unknown>) {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "worktree-provider-proof-")));
    const root = join(parent, "repo");
    const managed = join(parent, "managed");
    const home = join(parent, "home");
    for (const directory of [root, managed, home]) mkdirSync(directory);
    const env = { ...process.env, REPO_HARNESS_WORKTREE_ROOT: managed, HOME: home, BUN_INSTALL: join(parent, 'bun') };
    mkdirSync(env.BUN_INSTALL);
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.test");
    writeFileSync(join(root, ".gitignore"), ".ai/\n");
    writeFileSync(join(root, "source"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const path = join(managed, "repo-wt-squash");
    git(root, "worktree", "add", "-q", "-b", "fix/squash", path);
    writeFileSync(join(path, "source"), "feature\n");
    git(path, "commit", "-qam", "feature");
    const head = git(root, "rev-parse", "refs/heads/fix/squash");
    git(root, "merge", "--squash", "fix/squash");
    git(root, "commit", "-qm", "squash fix/squash");
    const squash = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "source"), "later\n");
    git(root, "commit", "-qam", "later conflicting edit");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const target = git(root, "rev-parse", "HEAD");
    mkdirSync(join(path, ".ai/harness/runs"), { recursive: true });
    writeFileSync(join(path, ".ai/harness/runs/hook-events.jsonl"), "{}\n");
    const log = join(parent, "gh.log");
    answers.forEach((answer, index) => {
      const value = answer(squash, target, head);
      const raw = value instanceof RawAnswer ? value : new RawAnswer(JSON.stringify(value));
      writeFileSync(join(parent, `gh.${index + 1}.out`), raw.stdout);
      writeFileSync(join(parent, `gh.${index + 1}.exit`), String(raw.exit));
    });
    const gh = join(parent, "gh");
    writeFileSync(gh, [
      "#!/bin/bash",
      `printf '%s|%s|%s|%s\\n' "$PWD" "\${GH_REPO-unset}" "\${GH_HOST-unset}" "$*" >> '${log}'`,
      "n=0",
      `while IFS= read -r _; do n=$((n + 1)); done < '${log}'`,
      `(( n <= ${answers.length} )) || n=${answers.length}`,
      `cat '${parent}/gh.'"$n"'.out'`,
      `exit "$(< '${parent}/gh.'"$n"'.exit')"`,
      "",
    ].join("\n"));
    chmodSync(gh, 0o755);
    const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    const sweep = (approved?: NonNullable<ReturnType<typeof planManagedWorktreeSweep>>) => sweepManagedWorktrees(root, root, env, { deadlineMs: 30_000, ghBin: gh, approved });
    const plan = () => planManagedWorktreeSweep(root, root, env, { deadlineMs: 30_000 })!;
    const prune = () => rmSync(path, { recursive: true });
    const pending = () => readPrunedWorktreeIntents(join(root, '.git')).some(entry => entry.worktree === path);
    return { root, managed, path, head, squash, gh, env, git, calls, sweep, plan, prune, pending, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
  }
  const mergedPr = (squash: string, _target: string, head: string) => [{ number: 7, state: "closed", merged_at: "2026-10-01T00:00:00Z",
    base: { ref: "main" }, head: { sha: head }, merge_commit_sha: squash }];

  test("ordinary sweep proves an exact squash head after an offline preview keeps it", () => {
    const f = squashFixture(mergedPr);
    try {
      const marker = join(f.path, '.ai/harness/active-worktree');
      writeFileSync(marker, `${f.path}\n`);
      const detached = join(f.managed, 'repo-wt-detached');
      f.git(f.root, 'worktree', 'add', '-q', '--detach', detached, f.squash);
      const plan = f.plan();
      expect(plan.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: detached, action: 'remove', head: f.squash }),
        expect.objectContaining({ path: f.path, action: 'keep', reason: expect.stringContaining('cleanup merge is unproven') }),
      ]));
      expect(f.sweep(plan)).toContain(`${f.path}: kept; not in the preview`);
      expect(existsSync(detached)).toBe(false);
      expect(readFileSync(marker, 'utf8')).toBe(`${f.path}\n`);
      expect(f.calls()).toEqual([]);
      expect(f.sweep()).toContain(`${f.path}: removed`);
      expect(existsSync(f.path)).toBe(false);
      expect(f.git(f.root, 'branch', '--list', 'fix/squash')).toBe('');
      expect(f.calls()).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  test('closeout reuses a verified PR merge while it checks the bound head and ancestry', () => {
    const f = squashFixture(() => []);
    try {
      const target = f.git(f.root, 'rev-parse', 'refs/remotes/origin/main');
      const expected = { worktree: f.path, branch: 'fix/squash', head_sha: f.head, target_ref: 'refs/remotes/origin/main',
        target_oid: target, merge_commit_sha: f.squash };
      const limits = { closeout: true, closeoutMergeFromProvider: true, closeoutProcesses: () => [], ghBin: f.gh } as const;
      expect(() => removeExactWorktree(f.root, { ...expected, head_sha: target }, limits)).toThrow('cleanup execution head moved');
      expect(() => removeExactWorktree(f.root, { ...expected, merge_commit_sha: f.head }, limits)).toThrow();
      expect(existsSync(f.path)).toBe(true);
      removeExactWorktree(f.root, expected, limits);
      expect(existsSync(f.path)).toBe(false);
      expect(f.git(f.root, 'branch', '--list', expected.branch)).toBe('');
      expect(f.calls()).toEqual([]);
    } finally { f.cleanup(); }
  });

  test('bound detached removal requires a registration and rechecks it after a replacement', () => {
    const f = squashFixture(mergedPr);
    try {
      const detached = join(f.managed, 'repo-wt-detached');
      const help = run('git', ['worktree', 'add', '-h'], f.root);
      const relative = (help.stdout + help.stderr).includes('--relative-paths') ? ['--relative-paths'] : [];
      const add = () => f.git(f.root, 'worktree', 'add', '-q', ...relative, '--detach', detached, f.squash);
      add();
      const original = f.plan();
      const step = original.items.find(item => item.path === detached)!;
      expect(step).toMatchObject({ action: 'remove', head: f.squash, registration: expect.any(String) });
      const unbound = { ...original, items: [{ ...step, registration: undefined }] };
      expect(boundSweepSteps(unbound)).toEqual({ target_oid: null, steps: [] });
      expect(f.sweep(unbound)).toContain(`${detached}: kept; not in the preview`);
      let scans = 0;
      setControlledWorktreeProcesses(() => {
        if (++scans === 2) {
          f.git(f.root, 'worktree', 'move', detached, join(dirname(f.managed), 'original-detached'));
          add();
        }
        return [];
      });
      expect(f.sweep(original)).toContain(`${detached}: kept; not in the preview`);
      expect(f.git(detached, 'rev-parse', 'HEAD')).toBe(f.squash);
      setControlledWorktreeProcesses([]);
      const replacement = f.plan();
      expect(replacement.items.find(item => item.path === detached)?.registration).not.toBe(step.registration);
      expect(f.sweep(replacement)).toContain(`${detached}: removed`);
    } finally {
      setControlledWorktreeProcesses([]);
      f.cleanup();
    }
  });

  test('replays the 51 audit classifications with evidence and ArchContext retention', async () => {
    const f = squashFixture(mergedPr);
    let occupant: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const git = (...args: string[]) => f.git(f.root, ...args);
      const target = 'refs/remotes/origin/main';
      const add = (slug: string, detached?: string) => {
        const path = join(f.managed, `repo-wt-${slug}`);
        if (detached) git('worktree', 'add', '-q', '--detach', path, detached);
        else git('worktree', 'add', '-q', '-b', `fix/${slug}`, path);
        return path;
      };
      const output = (path: string, file: string, contents = 'fixture\n') => {
        const dest = join(path, file);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, contents);
      };
      const mark = (path: string, owner = path) => output(path, '.ai/harness/active-worktree', `${owner}\n`);
      const branch = (slug: string, merged = false) => {
        const path = add(slug);
        output(path, 'source', `${slug}\n`);
        f.git(path, 'commit', '-qam', slug);
        if (merged) git('merge', '--ff-only', `fix/${slug}`);
        return path;
      };
      const providerCases = new Map<string, string>();
      const pulls = mergedPr(f.squash, '', f.head);
      for (const slug of ['safe-squash-1', 'safe-squash-2']) {
        const path = branch(slug);
        providerCases.set(path, 'cleanup merge is unproven');
        git('merge', '--squash', `fix/${slug}`);
        git('commit', '-qm', `squash ${slug}`);
        pulls.push(...mergedPr(git('rev-parse', 'HEAD'), '', f.git(path, 'rev-parse', 'HEAD')));
        output(f.root, 'source', `edit after ${slug}\n`);
        git('commit', '-qam', 'later edit');
      }
      output(f.root, '.git/info/exclude', '.codegraph/\n.archcontext/\n.env\n');
      const offlineCases: string[] = [];
      const kept = new Map([[f.path, 'ignored_data']]);
      output(f.path, '.ai/harness/evidence/events/log.jsonl', '{}\n');
      for (let i = 0; i < 16; i++) {
        const slug = `safe-marked-${i}`;
        const path = i === 15 ? add(slug) : branch(slug, true);
        mark(path);
        if (i === 15) {
          output(path, 'marked-feature', 'merged feature\n');
          f.git(path, 'add', 'marked-feature');
          f.git(path, 'commit', '-qm', slug);
          git('merge', '--squash', `fix/${slug}`);
          git('commit', '-qm', `squash ${slug}`);
          providerCases.set(path, 'unpushed');
        } else offlineCases.push(path);
        pulls.push(...mergedPr(git('rev-parse', 'HEAD'), '', f.git(path, 'rev-parse', 'HEAD')));
        const repository = { primary_root: f.root, repository_id: join(f.root, '.git'), execution_root: path };
        expect(existsSync(workspaceDirectory(repository))).toBe(false);
      }
      for (let i = 0; i < 11; i++) {
        const path = branch(`zz-outputs-${i}`, true);
        for (const file of ['.ai/harness/state/agent-notice', '.ai/harness/failures/latest.jsonl', '.codegraph/codegraph.db',
          '.archcontext/generated/model.json', '.archcontext/tmp/cache.json']) output(path, file);
        kept.set(path, 'ignored_data');
      }
      for (let i = 0; i < 8; i++) offlineCases.push(add(`safe-detached-${i}`, f.squash));
      for (let i = 0; i < 7; i++) {
        const path = branch(`zz-closed-${i}`);
        if (i < 5) mark(path);
        const head = f.git(path, 'rev-parse', 'HEAD');
        git('update-ref', `refs/remotes/origin/closed-${i}`, head);
        // Closed PRs and a merged PR on a different tip are both insufficient.
        pulls.push(i === 4 ? { ...pulls[0]! } : { ...pulls[0]!, merged_at: '', head: { sha: head } });
        kept.set(path, 'cleanup merge is unproven');
      }
      output(dirname(f.gh), 'gh.1.out', JSON.stringify(pulls));
      const closedHead = git('rev-parse', 'refs/heads/fix/zz-closed-0');
      for (let i = 0; i < 4; i++) kept.set(add(`zz-detached-${i}`, closedHead), 'cleanup merge is unproven');
      kept.set(branch('zz-unpushed'), 'unpushed');
      const locked = branch('zz-locked', true);
      git('worktree', 'lock', locked);
      kept.set(locked, 'locked');
      expect([offlineCases.length, providerCases.size, kept.size]).toEqual([23, 3, 25]);

      const ignored = branch('zz-ignored', true);
      output(ignored, '.env', 'keep these bytes\n');
      const foreign = branch('zz-foreign', true);
      mark(f.root, foreign);
      const open = branch('zz-open', true);
      const repository = { primary_root: f.root, repository_id: join(f.root, '.git'), execution_root: open };
      ensureSessionDirectory(f.root, workspaceDirectory(repository));
      const busy = branch('zz-busy', true);
      occupant = Bun.spawn([process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)'],
        { cwd: busy, env: f.env, stdout: 'pipe' });
      const ready = (occupant.stdout as ReadableStream<Uint8Array>).getReader();
      try { expect(new TextDecoder().decode((await ready.read()).value)).toBe('ready\n'); }
      finally { ready.releaseLock(); }
      const inventory = [{ pid: occupant.pid, cwd: busy }];
      setControlledWorktreeProcesses(inventory);
      const protectedPaths: Array<[string, string]> = [[ignored, 'ignored_data'], [foreign, 'marker reference'], [open, 'runtime is open'], [busy, 'process_in_use']];
      git('update-ref', target, 'HEAD');
      const beforeObjects = git('count-objects', '-v');
      const plan = new Map(f.plan().items.map(item => [item.path, item]));
      expect(git('count-objects', '-v')).toBe(beforeObjects);
      expect(plan.size).toBe(55);
      for (const path of offlineCases) expect(plan.get(path)).toMatchObject({ action: 'remove' });
      for (const [path, reason] of providerCases) expect(plan.get(path)).toMatchObject({ action: 'keep', reason: expect.stringContaining(reason) });
      for (const [path, reason] of [...kept, ...protectedPaths]) {
        expect(plan.get(path)).toMatchObject({ action: 'keep', reason: expect.stringContaining(reason) });
      }
      expect(f.calls()).toEqual([]);

      const readbacks = Array.from({ length: 4 }, () => f.sweep()).join('\n');
      for (const path of [...offlineCases, ...providerCases.keys()]) {
        expect(readbacks).toContain(`${path}: removed`);
        expect(existsSync(path)).toBe(false);
      }
      const protectedResult = removeGreenWorktrees(f.root, f.root, f.env, protectedPaths.map(([path]) => ({
        path, verify: () => { throw new Error('a protected checkout reached the removal barrier'); },
      })), { ghBin: f.gh, deadline: Date.now() + 30_000, processes: () => inventory });
      expect(protectedResult.results.map(result => !result.removed && String(result.error))).toEqual(
        protectedPaths.map(([, reason]) => expect.stringContaining(reason)));
      for (const path of [...kept.keys(), ignored, foreign, open, busy]) expect(existsSync(path)).toBe(true);
      expect(readFileSync(join(ignored, '.env'), 'utf8')).toBe('keep these bytes\n');
      expect(readFileSync(join(f.path, '.ai/harness/evidence/events/log.jsonl'), 'utf8')).toBe('{}\n');
      for (const dir of ['generated', 'tmp']) {
        const name = dir === 'generated' ? 'model.json' : 'cache.json';
        expect(readFileSync(join(f.managed, 'repo-wt-zz-outputs-0', '.archcontext', dir, name), 'utf8')).toBe('fixture\n');
      }
    } finally {
      setControlledWorktreeProcesses([]);
      occupant?.kill();
      await occupant?.exited;
      f.cleanup();
    }
  }, 60_000);

  test('explicit contract cleanup uses exact-head provider proof for a squash with no remote branch', () => {
    const f = squashFixture(mergedPr);
    try {
      const metadata = join(f.root, '.ai/harness/worktrees/squash.json');
      mkdirSync(join(f.root, '.ai/harness/worktrees'), { recursive: true });
      writeFileSync(metadata, '{"slug":"squash","branch":"fix/squash"}\n');
      const preload = join(dirname(f.gh), 'provider-preload.ts');
      const executableModule = join(ROOT, 'src/effects/runtime/trusted-executable.ts');
      writeFileSync(preload, `import { mock } from 'bun:test';
const actual = await import(${JSON.stringify(executableModule)});
mock.module(${JSON.stringify(executableModule)}, () => ({ ...actual, resolveTrustedGhExecutable: () => ${JSON.stringify(f.gh)} }));\n`);
      const bun = join(dirname(f.gh), 'provider-bun');
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      writeFileSync(bun, `#!/bin/sh
exec ${quote(process.execPath)} --preload ${quote(controlledWorktreeProcessPreload)} --preload ${quote(preload)} "$@"
`, { mode: 0o700 });
      const result = run('bash', [join(HELPER_DIR, 'contract-worktree.sh'), 'cleanup', '--slug', 'squash'], f.root,
        { ...f.env, REPO_HARNESS_TARGET_REPO_ROOT: f.root, REPO_HARNESS_BUN_BIN: bun });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('provider proved the exact head merged into main');
      expect(existsSync(f.path)).toBe(false);
      expect(existsSync(metadata)).toBe(false);
      expect(f.calls()).toHaveLength(2);
    } finally { f.cleanup(); }
  });

  test('a provider result for a different head keeps the live branch', () => {
    const f = squashFixture((squash, target) => mergedPr(squash, target, target));
    try {
      const result = f.sweep();
      expect(result).toContain(`${f.path}: kept; unpushed, cleanup merge is unproven`);
      expect(f.calls()).toHaveLength(1);
      expect(existsSync(f.path)).toBe(true);
      expect(f.git(f.path, 'rev-parse', 'HEAD')).toBe(f.head);
    } finally { f.cleanup(); }
  });

  test("absent provider proof leaves a pruned squash-merged branch and intent", () => {
    const f = squashFixture(() => []);
    try {
      f.prune();
      const result = f.sweep();
      expect(result).toContain(`${f.path}: pruned; unmerged branch kept (fix/squash)`);
      expect(f.pending()).toBe(true);
      expect(f.git(f.root, 'branch', '--list', 'fix/squash')).toContain('fix/squash');
    } finally { f.cleanup(); }
  });

  test("a merged provider PR proves the merge and the sweep removes the pruned branch and intent", () => {
    const saved = { GH_REPO: process.env.GH_REPO, GH_HOST: process.env.GH_HOST };
    process.env.GH_REPO = "caller/other-repo";
    process.env.GH_HOST = "caller.example.test";
    let f: ReturnType<typeof squashFixture> | undefined;
    try {
      // The fixture copies process.env into the env that it passes to the sweep.
      f = squashFixture(mergedPr);
      f.prune();
      const result = f.sweep();
      expect(result, String(result)).toContain(`${f.path}: removed`);
      expect(existsSync(f.path)).toBe(false);
      expect(f.git(f.root, "branch", "--list", "fix/squash")).toBe("");
      expect(f.pending()).toBe(false);
      // The sweep proves once outside the lock, and the barrier proves again.
      const call = `${f.root}|unset|unset|api repos/{owner}/{repo}/commits/${f.head}/pulls`;
      expect(f.calls()).toEqual([call, call]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      f?.cleanup();
    }
  });

  for (const [label, second, reason] of [
    ["no PR", () => [], "cleanup merge is unproven"],
    ["another merge commit", (_squash: string, target: string, head: string) => mergedPr(target, target, head), "cleanup merge commit changed"],
  ] as const) {
    test(`the barrier keeps the pruned branch when its second provider proof returns ${label}`, () => {
      const f = squashFixture(mergedPr, second);
      try {
        f.prune();
        expect(f.sweep()).toContain(`${f.path}: kept; ${reason}`);
        expect(f.calls()).toHaveLength(2);
        expect(f.pending()).toBe(true);
        expect(f.git(f.root, "branch", "--list", "fix/squash")).toContain("fix/squash");
      } finally { f.cleanup(); }
    });
  }

  for (const [label, answer] of [
    ["exits non-zero", (squash: string, target: string, head: string) => new RawAnswer(JSON.stringify(mergedPr(squash, target, head)), 1)],
    ["returns malformed JSON", () => new RawAnswer('[{"merged_at":')],
  ] as const) {
    test(`a provider call that ${label} keeps the pruned branch`, () => {
      const f = squashFixture(answer);
      try {
        f.prune();
        expect(f.sweep()).toContain(`${f.path}: pruned; unmerged branch kept (fix/squash)`);
        expect(f.pending()).toBe(true);
        expect(f.calls()).toHaveLength(1);
        expect(f.git(f.root, "branch", "--list", "fix/squash")).toContain("fix/squash");
      } finally { f.cleanup(); }
    });
  }

  test("an open provider PR keeps the pruned branch", () => {
    const f = squashFixture(squash => [{ number: 7, state: "open", merged_at: null, base: { ref: "main" }, merge_commit_sha: squash }]);
    try {
      f.prune();
      const result = f.sweep();
      expect(result).toContain(`${f.path}: pruned; unmerged branch kept (fix/squash)`);
      expect(f.pending()).toBe(true);
      expect(f.calls()).toHaveLength(1);
      expect(f.git(f.root, "branch", "--list", "fix/squash")).toContain("fix/squash");
    } finally { f.cleanup(); }
  });

  type ProviderPull = ReturnType<typeof mergedPr>[number];
  const edits: ReadonlyArray<readonly [string, (pr: ProviderPull) => ProviderPull]> = [
    ["another base branch", pr => ({ ...pr, base: { ref: "release" } })],
    ["a merge commit missing locally", pr => ({ ...pr, merge_commit_sha: "0".repeat(40) })],
    ["an abbreviated merge commit", pr => ({ ...pr, merge_commit_sha: pr.merge_commit_sha.slice(0, 12) })],
  ];
  for (const [label, edit] of edits) {
    test(`a merged provider PR with ${label} keeps the pruned branch`, () => {
      const f = squashFixture((squash, target, head) => mergedPr(squash, target, head).map(edit));
      try {
        f.prune();
        expect(f.sweep()).toContain(`${f.path}: pruned; unmerged branch kept (fix/squash)`);
        expect(f.pending()).toBe(true);
        expect(f.calls()).toHaveLength(1);
        expect(f.git(f.root, 'branch', '--list', 'fix/squash')).toContain('fix/squash');
      } finally { f.cleanup(); }
    });
  }

  test("a fresh branch at the target head is kept and never reaches the provider", () => {
    const f = squashFixture(mergedPr);
    try {
      const fresh = join(f.managed, "repo-wt-fresh");
      f.git(f.root, "worktree", "add", "-q", "-b", "fix/fresh", fresh, "refs/remotes/origin/main");
      const freshHead = f.git(f.root, "rev-parse", "refs/heads/fix/fresh");
      const result = f.sweep();
      expect(result).toContain(`${fresh}: kept; branch has no commits of its own`);
      expect(existsSync(fresh)).toBe(true);
      expect(f.git(f.root, "branch", "--list", "fix/fresh")).toContain("fix/fresh");
      expect(f.calls().some(call => call.includes(freshHead))).toBe(false);
    } finally { f.cleanup(); }
  });
});

describe("contract-worktree sweep", () => {
  test("sweep removes merged worktrees and keeps dirty and locked work", () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "contract-worktree-sweep-")));
    const cwd = join(parent, "repo");
    mkdirSync(cwd);
    let locked = "";
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, ".gitignore"), ".ai/\n");
      commitAll(cwd, "fixture");
      const add = (slug: string) => {
        const path = join(parent, `repo-wt-${slug}`);
        expect(run("git", ["worktree", "add", path, "-b", `fix/${slug}`], cwd).status).toBe(0);
        writeFileSync(join(path, `${slug}.txt`), `${slug}\n`);
        commitAll(path, slug);
        return path;
      };
      const dirty = add("a-dirty");
      locked = add("b-locked");
      const merged = add("m-merged");
      for (const slug of ["a-dirty", "b-locked", "m-merged"]) {
        expect(run("git", ["merge", "--no-ff", "-m", `merge ${slug}`, `fix/${slug}`], cwd).status).toBe(0);
      }
      const squash = add("n-squash");
      expect(run("git", ["merge", "--squash", "fix/n-squash"], cwd).status).toBe(0);
      commitAll(cwd, "squash fix/n-squash");
      expect(run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], cwd).status).toBe(0);
      expect(run("git", ["update-ref", "refs/remotes/origin/n-squash", "fix/n-squash"], cwd).status).toBe(0);
      writeFileSync(join(dirty, "wip.txt"), "preserve me\n");
      expect(run("git", ["worktree", "lock", locked], cwd).status).toBe(0);

      const bun = join(parent, 'controlled-bun');
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      writeFileSync(bun, `#!/bin/sh\nexec ${quote(process.execPath)} --preload ${quote(controlledWorktreeProcessPreload)} "$@"\n`, { mode: 0o700 });
      const result = run("bash", ["scripts/contract-worktree.sh", "sweep"], cwd, { REPO_HARNESS_WORKTREE_ROOT: parent, REPO_HARNESS_BUN_BIN: bun });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("[WorktreeSweep] removed=2 pruned=0 kept=2");
      expect(result.stdout).toContain(`${merged}: removed`);
      expect(result.stdout).toContain(`${squash}: removed`);
      expect(result.stdout).toContain(`${dirty}: kept; cleanup_blocked_dirty_worktree`);
      expect(result.stdout).toContain(`${locked}: kept; locked`);
      expect(existsSync(merged)).toBe(false);
      expect(existsSync(squash)).toBe(false);
      expect(readFileSync(join(dirty, "wip.txt"), "utf8")).toBe("preserve me\n");
      expect(existsSync(locked)).toBe(true);
      expect(run("git", ["branch", "--list", "fix/*"], cwd).stdout.split("\n").map(line => line.replace(/^[*+ ]+/, "").trim()).filter(Boolean).sort())
        .toEqual(["fix/a-dirty", "fix/b-locked"]);

      const usage = run("bash", ["scripts/contract-worktree.sh", "sweep", "--dry-run"], cwd);
      expect(usage.status).toBe(2);
      expect(usage.stderr).toContain("sweep takes no arguments");
    } finally {
      if (locked) run("git", ["worktree", "unlock", locked], cwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
