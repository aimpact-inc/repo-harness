import { describe, test, expect, setDefaultTimeout } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { runMutationGuard } from "../src/cli/hook/mutation-guard";
import { renderAntigravityHookCommand } from "../src/cli/hook/host-adapter";
import type { HookEvent, RouteId } from "../src/cli/hook/route-registry";
import { hookIdentity } from "./helpers/hook-identity";
import { tmpWorkspace } from "./helpers/repo-fixture";

// Some fixtures resolve full effective state and can exceed the default under
// parallel session load.
setDefaultTimeout(20000);

// The edit tests call the in-process mutation-guard handler directly, the
// same "no subprocess" pattern tests/mutation-guard.test.ts uses.
function runEditHandler(
  cwd: string,
  payload: Record<string, unknown>,
): { status: number; stdout: string; stderr: string } {
  const result = runMutationGuard({ repoRoot: cwd, payload, identity: hookIdentity(), env: process.env });
  return { status: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function initGitRepo(cwd: string) {
  spawnSync("git", ["init"], { cwd, encoding: "utf-8" });
  spawnSync("git", ["config", "user.name", "Hook Test"], { cwd, encoding: "utf-8" });
  spawnSync("git", ["config", "user.email", "hook@test.local"], { cwd, encoding: "utf-8" });
  writeFileSync(join(cwd, "tracked.txt"), "base\n");
  spawnSync("git", ["add", "tracked.txt"], { cwd, encoding: "utf-8" });
  spawnSync("git", ["commit", "-m", "init"], { cwd, encoding: "utf-8" });
}

function writeActivePlan(cwd: string, planPath: string) {
  mkdirSync(join(cwd, ".ai/harness"), { recursive: true });
  writeFileSync(join(cwd, ".ai/harness/active-plan"), planPath);
  writeFileSync(join(cwd, ".ai/harness/active-worktree"), `${realpathSync(cwd)}\n`);
}

describe("Claude Code hook protocol compliance", () => {
  // Background: Claude Code's PreToolUse / UserPromptSubmit hook protocol treats
  // exit code 2 as the "blocking" signal and feeds stderr to the model.
  // Non-zero non-2 exits are surfaced as "non-blocking status code: No stderr output"
  // (a confusing UX that also doesn't actually block).
  // Every guard that intends to BLOCK must:
  //   1. exit with code 2
  //   2. write a human-readable [Guard] reason + fix to stderr

  test("worktree marker does not block ordinary edits", () => {
    const cwd = tmpWorkspace("hook-proto-worktree");
    try {
      initGitRepo(cwd);
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(join(cwd, ".claude/.require-worktree"), "1\n");

      const res = runEditHandler(cwd, { tool_input: { file_path: "src/app.ts" } });
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("[WorktreeGuard]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("pre-edit-guard: plan transition does not gate ordinary edits", () => {
    const cwd = tmpWorkspace("hook-proto-plan-transition");
    try {
      initGitRepo(cwd);
      mkdirSync(join(cwd, "plans"), { recursive: true });
      writeFileSync(
        join(cwd, "plans/plan-20260528-1500-demo.md"),
        "# Plan: demo\n\n> **Status**: Draft\n\n## Annotations\n<!-- [NOTE]: add detail -->\n"
      );

      const res = runEditHandler(cwd, {
        tool_input: {
          file_path: "plans/plan-20260528-1500-demo.md",
          content:
            "# Plan: demo\n\n> **Status**: Approved\n\n## Annotations\n<!-- [NOTE]: add detail -->\n",
        },
      });
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("[PlanTransitionGuard]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("corrupt profile authority remains diagnosed without blocking ordinary edits", () => {
    const cwd = tmpWorkspace("hook-proto-plan-status");
    try {
      initGitRepo(cwd);
      mkdirSync(join(cwd, "docs"), { recursive: true });
      mkdirSync(join(cwd, "plans"), { recursive: true });
      writeFileSync(join(cwd, "docs/spec.md"), "# Product Spec\n");
      writeFileSync(
        join(cwd, "plans/plan-20260528-1300-demo.md"),
        "# Plan: demo\n\n> **Status**: Draft\n"
      );
      writeActivePlan(cwd, "plans/plan-20260528-1300-demo.md");

      // Malformed capability authority cannot become an edit permission gate.
      // The edit guard reads no workflow state, so it gives no advice either.
      mkdirSync(join(cwd, ".ai/context"), { recursive: true });
      writeFileSync(
        join(cwd, ".ai/harness/policy.json"),
        JSON.stringify({ context: { capability_registry_file: ".ai/context/capabilities.json" } }, null, 2),
      );
      writeFileSync(join(cwd, ".ai/context/capabilities.json"), "{not json");

      const res = runEditHandler(cwd, { tool_input: { file_path: "src/app.ts" } });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
      expect(res.stderr).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);


  test("pre-edit-guard: ignores paths outside the repo contract boundary", () => {
    // Case 2: an absolute path outside the repo (e.g. a global plan file under
    // ~/.claude/plans/...) must not be governed by this repo's sprint contract.
    // The repo-local hook can normalize repo-internal absolute paths, but it
    // should not turn an active contract into a global filesystem lock.
    const cwd = tmpWorkspace("hook-proto-abs-outside");
    const outsideRoot = realpathSync(mkdtempSync(join(tmpdir(), "hook-proto-outside-")));
    try {
      initGitRepo(cwd);
      mkdirSync(join(cwd, "plans"), { recursive: true });
      mkdirSync(join(cwd, "tasks/contracts"), { recursive: true });

      const planPath = "plans/plan-20260528-2300-outside.md";
      writeFileSync(join(cwd, planPath), "# Plan: outside\n\n> **Status**: Approved\n");
      writeActivePlan(cwd, planPath);
      writeFileSync(
        join(cwd, "tasks/contracts/outside.contract.md"),
        [
          "# Task Contract: outside",
          "",
          "> **Status**: Pending",
          `> **Plan**: ${planPath}`,
          "",
          "## Allowed Paths",
          "",
          "```yaml",
          "allowed_paths:",
          "  - src/",
          "```",
          "",
        ].join("\n")
      );

      const outsidePath = join(outsideRoot, "some-other-file.md");
      const res = runEditHandler(cwd, { tool_input: { file_path: outsidePath } });
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("[ContractScopeGuard]");
      expect(res.stdout).not.toContain("\"guard\":\"ContractScopeGuard\"");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("ContractScopeGuard: absolute paths under allowed_paths directories are NOT blocked", () => {
    // The bug we are fixing: an absolute path like
    // /Users/.../repo/.ai/hooks/foo.sh used to be reported as outside the
    // contract because the allowed_paths pattern `.ai/hooks/` is repo-relative
    // and `==` shell glob match never matched the absolute form.
    const cwd = tmpWorkspace("hook-proto-abs-allowed");
    try {
      initGitRepo(cwd);
      mkdirSync(join(cwd, "plans"), { recursive: true });
      mkdirSync(join(cwd, "tasks/contracts"), { recursive: true });
      mkdirSync(join(cwd, ".ai/hooks"), { recursive: true });

      const planPath = "plans/plan-20260528-2310-allowed.md";
      writeFileSync(join(cwd, planPath), "# Plan: allowed\n\n> **Status**: Approved\n");
      writeActivePlan(cwd, planPath);
      writeFileSync(
        join(cwd, "tasks/contracts/allowed.contract.md"),
        [
          "# Task Contract: allowed",
          "",
          "> **Status**: Pending",
          `> **Plan**: ${planPath}`,
          "",
          "## Allowed Paths",
          "",
          "```yaml",
          "allowed_paths:",
          "  - .ai/hooks/",
          "  - src/",
          "```",
          "",
        ].join("\n")
      );
      writeFileSync(join(cwd, ".ai/hooks/sample.sh"), "#!/bin/bash\necho sample\n");

      const res = runEditHandler(cwd, { tool_input: { file_path: `${cwd}/.ai/hooks/sample.sh` } });
      // An edit inside the repository is allowed; the guard has no
      // contract-scope check.
      expect(res.status).toBe(0);
      expect(res.stderr).not.toContain("[ContractScopeGuard]");
      expect(res.stdout).not.toContain("[ContractScopeGuard]");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test.skipIf(process.platform === "win32")("hook_structured_error: writes the diagnostic to stderr and one failure record", () => {
    // The host reads the stderr reason. Trace consumers read the failure
    // record; a denial writes nothing to stdout.
    const cwd = tmpWorkspace("hook-proto-emit-shape");
    try {
      initGitRepo(cwd);
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(join(cwd, ".claude/.require-worktree"), "1\n");

      // /etc/hosts is an existing file outside the worktree and the temp directories, so the I2 rule denies the overwrite.
      const res = runEditHandler(cwd, { tool_input: { file_path: "/etc/hosts" } });
      expect(res.status).toBe(2);
      // stderr keeps the human-readable diagnostic (this is what Claude / the user reads).
      expect(res.stderr).toContain("[UserFileGuard]");
      expect(res.stdout).toBe("");
      const records = readFileSync(join(cwd, ".ai/harness/failures/latest.jsonl"), "utf-8").trim().split("\n");
      expect(records).toHaveLength(1);
      expect(records[0]).toContain('"failure_class":"state_violation"');
      expect(records[0]).toContain('"guard":"UserFileGuard"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

const HOOK_ENTRY = join(import.meta.dir, '../src/cli/hook-entry.ts');
const GUARD_DENIAL = 'rh hook: the tool call is refused';

function withAntigravityFixture(testCase: (fixture: ReturnType<typeof antigravityFixture>) => void) {
  const root = tmpWorkspace('rh-agy-protocol');
  try { testCase(antigravityFixture(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

function antigravityFixture(root: string) {
  const config = join(root, "hook config's cwd");
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const bunInstall = join(root, 'bun-install');
  const repo = join(root, 'repo');
  const cwd = join(repo, 'nested');
  for (const dir of [config, home, bin, bunInstall, cwd]) mkdirSync(dir, { recursive: true });
  const env = [`HOME=${home}`, `PATH=${bin}`, `BUN_INSTALL=${bunInstall}`, `TMPDIR=${root}`];
  const git = Bun.which('git');
  if (!git) throw new Error('git is required for the Antigravity fixture');
  const init = spawnSync('/usr/bin/env', ['-i', ...env, git, 'init', '-q', repo], { cwd: root, env: {}, encoding: 'utf8' });
  expect(init.status, init.stderr).toBe(0);
  mkdirSync(join(repo, '.ai/harness'), { recursive: true });
  writeFileSync(join(repo, '.ai/harness/workflow-contract.json'), '{}\n');
  const failures = join(repo, '.ai/harness/failures/latest.jsonl');
  function run(event: HookEvent, route: RouteId, input: unknown, extraEnv: string[] = [], entry = HOOK_ENTRY) {
    const command = renderAntigravityHookCommand(process.execPath, entry, event, route);
    return spawnSync('/usr/bin/env', ['-i', ...env, ...extraEnv, '/bin/sh', '-c', command], {
      cwd: config, env: {}, input: JSON.stringify(input), encoding: 'utf8',
    });
  }
  return { root, config, repo, cwd, failures, run };
}

function expectAntigravityDeny(result: { status: number | null; stdout: string; stderr: string }, reason: string) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe(`${JSON.stringify({ decision: 'deny', reason })}\n`);
  expect(result.stderr).toBe('');
}

function expectAntigravityForceAsk(result: { status: number | null; stdout: string; stderr: string }) {
  expect([result.status, result.stderr]).toEqual([0, '']);
  expect(JSON.parse(result.stdout)).toEqual({
    decision: 'force_ask',
    reason: '[UserFileGuard] I2: This tool call may overwrite or remove an existing file outside the allowed roots.',
  });
}

describe.skipIf(process.platform === 'win32')('Antigravity hook protocol', () => {
  test('canonicalizes a symlink cwd, ignores a forged root, and passes only on confirmed absence', () => withAntigravityFixture(f => {
    const link = join(f.root, 'nested-link');
    symlinkSync(f.cwd, link);
    const toolCall = { name: 'run_command', args: { CommandLine: 'cat .env' } };
    expectAntigravityDeny(f.run('PreToolUse', 'bash', { cwd: link, toolCall }, [`HOOK_REPO_ROOT=${f.config}`]), GUARD_DENIAL);

    const broken = join(f.root, 'broken-cwd');
    symlinkSync(join(f.root, 'missing'), broken);
    for (const cwd of [broken, join(f.root, 'missing'), join(f.repo, '.git/HEAD')]) {
      expectAntigravityDeny(f.run('PreToolUse', 'bash', { cwd, toolCall }), 'rh hook failed: bash; the call is refused');
    }
    const noGit = f.run('PreToolUse', 'bash', { cwd: f.config, toolCall }, [`HOOK_REPO_ROOT=${f.repo}`]);
    expect([noGit.status, noGit.stdout, noGit.stderr]).toEqual([0, '', '']);
    rmSync(join(f.repo, '.ai/harness/workflow-contract.json'));
    const noMarker = f.run('PreToolUse', 'bash', { cwd: link, toolCall });
    expect([noMarker.status, noMarker.stdout, noMarker.stderr]).toEqual([0, '', '']);
    rmSync(join(f.repo, '.ai/harness'), { recursive: true });
    writeFileSync(join(f.repo, '.ai/harness'), 'not a directory');
    expectAntigravityDeny(f.run('PreToolUse', 'bash', { cwd: link, toolCall }), 'rh hook failed: bash; the call is refused');
  }));

  test('blocks malformed guard arguments and relative edit paths before dispatch', () => withAntigravityFixture(f => {
    const rows = [
      ['bash', 'run_command', {}], ['bash', 'run_command', { CommandLine: 3 }],
      ['edit', 'write_file', {}], ['edit', 'write_file', { Path: 'relative.txt' }],
      ['edit', 'edit_file', { Path: 3 }], ['edit', 'edit_file', { Path: 'relative.txt' }],
    ] as const;
    for (const [route, name, args] of rows) {
      expectAntigravityDeny(f.run('PreToolUse', route, { cwd: f.cwd, toolCall: { name, args } }), `rh hook: malformed ${name} input`);
    }
    const mismatched = { cwd: f.cwd, toolCall: { name: 'run_command', args: { CommandLine: 'echo okay' } } };
    expectAntigravityDeny(f.run('PreToolUse', 'edit', mismatched), 'rh hook failed: edit; the call is refused');
    const unknown = f.run('PreToolUse', 'default', mismatched);
    expect([unknown.status, unknown.stdout]).toEqual([2, '']);
  }));

  test('keeps clean Bash silent and asks before either file tool overwrites a protected file', () => withAntigravityFixture(f => {
    const input = { cwd: f.cwd, toolCall: { name: 'run_command', args: { CommandLine: 'echo okay' } } };
    const allowed = f.run('PreToolUse', 'bash', input);
    expect([allowed.status, allowed.stdout, allowed.stderr]).toEqual([0, '', '']);
    for (const name of ['write_file', 'edit_file']) {
      const toolCall = { name, args: { Path: '/etc/hosts' } };
      expectAntigravityForceAsk(f.run('PreToolUse', 'edit', { cwd: f.cwd, toolCall }));
    }
  }));

  test('guard exceptions deny both tuples with fixed text', () => withAntigravityFixture(f => {
    const entry = join(f.config, 'throwing-guard.ts');
    const hook = join(import.meta.dir, '../src/cli/hook');
    // Inject a fault at the actual handler call in a separate process.
    writeFileSync(entry, `
import { runHookCli } from ${JSON.stringify(HOOK_ENTRY)};
import { getHandlerForRoute } from ${JSON.stringify(join(hook, 'handler-registry.ts'))};
import { getRoute } from ${JSON.stringify(join(hook, 'route-registry.ts'))};
const tuple = getRoute(process.argv[2], process.argv[4]);
Object.defineProperty(getHandlerForRoute(tuple), 'run', { value() { throw new Error('OPAQUE-CRASH-MARKER-3251'); } });
process.exit(runHookCli(process.argv.slice(2)));
`);
    const toolCalls = {
      bash: { name: 'run_command', args: { CommandLine: 'echo okay' } },
      edit: { name: 'write_file', args: { Path: join(f.cwd, 'fixture.txt') } },
    };
    for (const route of ['bash', 'edit'] as const) {
      expectAntigravityDeny(f.run('PreToolUse', route, { cwd: f.cwd, toolCall: toolCalls[route] }, [], entry),
        `rh hook failed: ${route}; the call is refused`);
    }
  }));

  test('rendered command isolates Bun startup and ambient environment before bootstrap', () => withAntigravityFixture(f => {
    const startup = 'BUN-STARTUP-MARKER-3251';
    const ambient = 'AMBIENT-SECRET-MARKER-3251';
    writeFileSync(join(f.config, '.env'), `REPO_HARNESS_SEAT_STARTUP=${startup}\n`);
    const preload = join(f.config, 'preload.ts');
    writeFileSync(preload, `console.error(${JSON.stringify(startup)});\n`);
    writeFileSync(join(f.config, 'bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n`);
    const toolCall = { name: 'run_command', args: { CommandLine: 'cat .env' } };
    const extraEnv = [`AMBIENT_SECRET=${ambient}`, 'REPO_HARNESS_WORKTREE_ROOT=/etc'];
    const result = f.run('PreToolUse', 'bash', { cwd: f.cwd, toolCall }, extraEnv);
    expectAntigravityDeny(result, GUARD_DENIAL);
    // The ambient worktree override would otherwise admit this existing outside file.
    const edit = f.run('PreToolUse', 'edit', { cwd: f.cwd, toolCall: { name: 'write_file', args: { Path: '/etc/hosts' } } }, extraEnv);
    expectAntigravityForceAsk(edit);
    // An allowlisted seat variable would survive bootstrap if Bun loaded .env.
    const auditEntry = join(f.config, 'audit-entry.ts');
    writeFileSync(auditEntry, `
import { runHookCli } from ${JSON.stringify(HOOK_ENTRY)};
for (const key of ['REPO_HARNESS_SEAT_STARTUP', 'AMBIENT_SECRET']) {
  if (process.env[key]) console.error(process.env[key]);
}
process.exit(runHookCli(process.argv.slice(2)));
`);
    const audit = f.run('PreToolUse', 'bash', { cwd: f.cwd, toolCall }, extraEnv, auditEntry);
    expectAntigravityDeny(audit, GUARD_DENIAL);
    const logs = readFileSync(f.failures, 'utf8');
    const output = [result, edit, audit].map(({ stdout, stderr }) => stdout + stderr).join('') + logs;
    for (const marker of [startup, ambient]) expect(output).not.toContain(marker);
  }));

  test('Bash force_ask and deny keep opaque command words out of the response, stderr, and failure log', () => withAntigravityFixture(f => {
    const marker = 'OPAQUE-SECRET-MARKER-3251';
    const invoke = (CommandLine: string) => f.run('PreToolUse', 'bash', { cwd: f.cwd, toolCall: { name: 'run_command', args: { CommandLine } } });
    const command = `rm "$UNKNOWN/${marker}"`;
    const asked = invoke(command);
    expectAntigravityForceAsk(asked);
    const denied = invoke(`${command}; cat .env`);
    expectAntigravityDeny(denied, GUARD_DENIAL);
    const log = readFileSync(f.failures, 'utf8');
    expect(JSON.parse(log)).toMatchObject({ guard: 'CredentialGuard', action: 'block', reason: GUARD_DENIAL });
    expect(asked.stdout + denied.stdout + log).not.toContain(marker);
  }));

  test('resolves an opted-in checkout from workspacePaths when cwd is an agent dir, refuses .env reads, and fails closed on ambiguity or invalid entries', () => withAntigravityFixture(f => {
    const agentDir = join(f.root, '.repo-harness', 'seats', 'agy', 'fa283333');
    const otherRepo = join(f.root, 'other-repo');
    const repoLink = join(f.root, 'repo-link');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    symlinkSync(f.repo, repoLink);
    const git = Bun.which('git')!;
    const init = spawnSync(git, ['init', '-q', otherRepo], { encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);

    // Captured agy 1.5.16 multi-workspace shape: cwd is the non-git agent dir, workspacePaths includes the opted-in checkout.
    const multi = { cwd: agentDir, workspacePaths: [agentDir, f.repo], conversationId: 'conv-3473', transcriptPath: '' };
    const start = f.run('SessionStart', 'default', { ...multi, hookEventName: 'SessionStart' });
    expect([start.status, start.stderr]).toEqual([0, '']);
    expect(JSON.parse(start.stdout)).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: expect.stringContaining('[EditGuardScope]') } }],
    });

    // I1 CredentialGuard refuses .env reads in the multi-workspace shape.
    for (const CommandLine of ['cat /tmp/rh-probe-3473-nonexistent/.env', 'cat .env']) {
      expectAntigravityDeny(
        f.run('PreToolUse', 'bash', { ...multi, hookEventName: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine } } }),
        GUARD_DENIAL,
      );
    }

    // I2 UserFileGuard still resolves relative Bash targets against wire.cwd (outside repoRoot and tmp), not repoRoot.
    expectAntigravityForceAsk(
      f.run('PreToolUse', 'bash', { cwd: '/etc', workspacePaths: ['/etc', f.repo], toolCall: { name: 'run_command', args: { CommandLine: 'rm hosts' } } }),
    );
    expectAntigravityForceAsk(
      f.run('PreToolUse', 'edit', { ...multi, toolCall: { name: 'write_file', args: { Path: '/etc/hosts' } } }),
    );

    // PreInvocation and Stop resolve the opted-in checkout too instead of skipping as not-in-git-repo.
    const inbox = f.run('UserPromptSubmit', 'inbox', { ...multi, hookEventName: 'PreInvocation', invocationNum: 0 });
    expect([inbox.status, inbox.stderr]).toEqual([0, '']);
    const stop = f.run('Stop', 'default', { ...multi, hookEventName: 'Stop', executionNum: 0 });
    expect([stop.status, stop.stderr]).toEqual([0, '']);
    const events = readFileSync(join(f.repo, '.ai/harness/runs/hook-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as { host: string; event: string; session_id: string });
    expect(events.map(entry => entry.event)).toEqual(expect.arrayContaining(['SessionStart', 'PreToolUse', 'UserPromptSubmit', 'Stop']));
    expect(events.every(entry => entry.host === 'antigravity')).toBe(true);

    // Same opted-in repository repeated via subdir/root/symlink is unambiguous.
    const okTool = { name: 'run_command', args: { CommandLine: 'echo okay' } };
    const dedup = f.run('PreToolUse', 'bash', { cwd: f.cwd, workspacePaths: [f.cwd, f.repo, repoLink], toolCall: okTool });
    expect([dedup.status, dedup.stdout, dedup.stderr]).toEqual([0, '', '']);

    // One opted-in repo alongside a non-opt-in git repo runs guards for the opted-in repo.
    const mixed = f.run('PreToolUse', 'bash', {
      cwd: otherRepo, workspacePaths: [otherRepo, f.repo], toolCall: { name: 'run_command', args: { CommandLine: 'cat .env' } },
    });
    expectAntigravityDeny(mixed, GUARD_DENIAL);

    // Two distinct opted-in repos are ambiguous and must fail closed on both guard routes.
    mkdirSync(join(otherRepo, '.ai/harness'), { recursive: true });
    writeFileSync(join(otherRepo, '.ai/harness/workflow-contract.json'), '{}\n');
    for (const cwd of [agentDir, f.repo]) {
      expectAntigravityDeny(
        f.run('PreToolUse', 'bash', { cwd, workspacePaths: [agentDir, f.repo, otherRepo], toolCall: okTool }),
        'rh hook failed: bash; the call is refused',
      );
    }
    expectAntigravityDeny(
      f.run('PreToolUse', 'edit', { cwd: f.repo, workspacePaths: [f.repo, otherRepo], toolCall: { name: 'write_file', args: { Path: join(f.repo, 'ok.txt') } } }),
      'rh hook failed: edit; the call is refused',
    );

    // Corrupted marker in a sibling workspace fails closed rather than silently skipping.
    rmSync(join(otherRepo, '.ai/harness'), { recursive: true });
    writeFileSync(join(otherRepo, '.ai/harness'), 'not a directory');
    expectAntigravityDeny(
      f.run('PreToolUse', 'bash', { cwd: agentDir, workspacePaths: [agentDir, f.repo, otherRepo], toolCall: okTool }),
      'rh hook failed: bash; the call is refused',
    );
    rmSync(join(otherRepo, '.ai/harness'));

    // Malformed or unresolvable workspacePaths entries fail closed.
    for (const workspacePaths of ['not-an-array', null, ['relative/path'], [f.repo, join(f.root, 'missing-workspace')], [f.repo, join(f.repo, '.git/HEAD')]]) {
      expectAntigravityDeny(
        f.run('PreToolUse', 'bash', { cwd: f.repo, workspacePaths, toolCall: okTool }),
        'rh hook failed: bash; the call is refused',
      );
    }

    // Confirmed absence of any opted-in repo across cwd and workspacePaths passes silently.
    const noOptIn = f.run('PreToolUse', 'bash', {
      cwd: agentDir, workspacePaths: [agentDir, otherRepo], toolCall: { name: 'run_command', args: { CommandLine: 'cat .env' } },
    });
    expect([noOptIn.status, noOptIn.stdout, noOptIn.stderr]).toEqual([0, '', '']);
  }));
});
