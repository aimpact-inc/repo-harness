import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  chmodSync,
  symlinkSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { defaultWorktreeTemplate } from "../src/core/worktree-location.mjs";
import { publishCheckpointFromLedger } from "../src/effects/evidence/checkpoint-store";
import { LEDGER_EPOCH_START_SHA } from "../src/effects/evidence/epoch";
import { appendGenesisRecord } from "../src/effects/evidence/event-log";

import { sweepManagedWorktrees } from '../src/effects/state/coordination-worktree-topology';
import { defaultPolicy } from "../src/effects/adoption/standard-plan";
import { copyHelpers, ROOT } from "./helpers/helper-script-fixture";
import { addSelfOrigin, commitAll, initGitRepo, run, tmpWorkspace } from "./helpers/repo-fixture";
import { installStateFixturePath, recordPluginSelection } from "./helpers/install-ownership";
import { indexPackageLocalCodeGraph, resolveCompatibleNodeRuntime, resolvePackageLocalArchctx } from '../src/effects/architecture/archctx-provider';
import { ARCHCTX_REQUIRED_VERSION } from '../src/core/architecture/projection';
import { shellQuote } from '../src/core/shell-quote';
import { productVersionManifest } from 'archctx-contracts';

setDefaultTimeout(30000);

interface IssueStub {
  number: number;
  title: string;
  state: string;
  url: string;
}

const ISSUE: IssueStub = {
  number: 123,
  title: "Location",
  state: "OPEN",
  url: "https://github.com/example/repo/issues/123",
};

const GH_DIR = tmpWorkspace("contract-worktree-gh");
const NO_GH_DIR = join(GH_DIR, "no-gh");
mkdirSync(NO_GH_DIR);
symlinkSync("/usr/bin/dirname", join(NO_GH_DIR, "dirname"));
afterAll(() => rmSync(GH_DIR, { recursive: true, force: true }));
writeFileSync(
  join(GH_DIR, "gh"),
  [
    "#!/bin/sh",
    'if [ -n "${GH_STUB_ERROR:-}" ]; then printf "%s\\n" "$GH_STUB_ERROR" >&2; exit 1; fi',
    'printf "%s\\n" "$GH_STUB_JSON"',
    "",
  ].join("\n"),
  { mode: 0o755 },
);

function issueEnv(
  env: NodeJS.ProcessEnv = {},
  issue: Partial<IssueStub> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: `${GH_DIR}:${process.env.PATH ?? ""}`,
    GH_STUB_JSON: JSON.stringify({ ...ISSUE, ...issue }),
    ...env,
  };
}

function start(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
  issue: Partial<IssueStub> = {},
) {
  addSelfOrigin(cwd);
  return run("bash", ["scripts/contract-worktree.sh", "start", ...args], cwd, issueEnv(env, issue));
}

function writeStartMetadata(cwd: string, slug: string, branch: string): void {
  mkdirSync(join(cwd, ".ai/harness/worktrees"), { recursive: true });
  writeFileSync(join(cwd, ".ai/harness/worktrees", `${slug}.json`), `${JSON.stringify({ slug, branch })}\n`);
}

function withIgnoredCleanupFixture(ignores: string, use: (f: ReturnType<typeof ignoredCleanupFixture>) => void, tracked: string[] = []) {
  const parent = tmpWorkspace("ignored-cleanup");
  try { use(ignoredCleanupFixture(parent, ignores, tracked)); }
  finally { rmSync(parent, { recursive: true, force: true }); }
}

function ignoredCleanupFixture(parent: string, ignores: string, tracked: string[]) {
  const cwd = join(parent, "repo");
  const worktree = join(parent, "repo-wt-demo");
  const marker = join(worktree, ".ai/harness/active-worktree");
  const metadata = join(cwd, ".ai/harness/worktrees/demo.json");
  const branch = "codex/demo";
  const entry = join(ROOT, "src/cli/index.ts");
  const scripts = join(ROOT, "scripts");
  mkdirSync(cwd);
  initGitRepo(cwd);
  writeFileSync(join(cwd, ".gitignore"), `${ignores}\n`);
  if (tracked.length > 0) {
    writeIgnoredFiles(cwd, tracked);
    expect(run("git", ["add", "-f", "--", ...tracked], cwd).status).toBe(0);
  }
  commitAll(cwd, "ignored cleanup fixture");
  expect(run("git", ["worktree", "add", "-b", branch, worktree], cwd).status).toBe(0);
  writeStartMetadata(cwd, "demo", branch);
  mkdirSync(join(worktree, ".ai/harness"), { recursive: true });
  writeFileSync(marker, `${worktree}\n`);
  const head = run("git", ["rev-parse", "HEAD"], cwd).stdout.trim();
  const cleanup = ["cleanup", "--slug", "demo"];
  const removeExact = ["remove-exact", "--repo", cwd, "--worktree", worktree, "--branch", branch,
    "--head", head, "--target", "main", "--target-oid", head, "--merge", head];
  const branchStatus = () => run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd).status;
  return {
    parent, worktree, metadata, branchStatus,
    cli: (...args: string[]) => run(process.execPath, [entry, "worktrees", ...args], cwd),
    cleanup, removeExact,
    shell: (env: NodeJS.ProcessEnv, ...args: string[]) => run("bash", [join(scripts, "contract-worktree.sh"), ...args], cwd,
      { ...env, REPO_HARNESS_TARGET_REPO_ROOT: cwd }),
    runtime: (env: NodeJS.ProcessEnv) => run(process.execPath, [join(scripts, "contract-worktree-runtime.ts"), ...removeExact], cwd, env),
    retained() {
      expect(existsSync(worktree)).toBe(true);
      expect(readFileSync(marker, "utf8").trim()).toBe(worktree);
      expect(branchStatus()).toBe(0);
      expect(JSON.parse(readFileSync(metadata, "utf8"))).toEqual({ slug: "demo", branch });
    },
  };
}

function writeIgnoredFiles(worktree: string, paths: readonly string[]): void {
  for (const path of paths) {
    const file = join(worktree, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture\n");
  }
}

describe("contract-worktree helper integration", () => {

  test("slug cleanup refuses ignored local data in preview and apply", () => {
    withIgnoredCleanupFixture(".ai/\n.env\nscratch.local\n/node_modules", f => {
      const paths = ["scratch.local", ".env", "build/.env", ".ai/harness/backups/keep.txt"];
      writeIgnoredFiles(f.worktree, paths);
      symlinkSync(f.parent, join(f.worktree, "node_modules"), "dir");
      for (const extra of [["--dry-run"], []]) {
        const result = f.cli(...f.cleanup, ...extra);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        for (const path of ["scratch.local", ".env", "build/.env", ".ai/harness/backups/", "node_modules"]) {
          expect(result.stderr).toContain(JSON.stringify(path));
        }
        expect(result.stderr).toContain("git status --ignored");
        f.retained();
        for (const path of paths) expect(readFileSync(join(f.worktree, path), "utf8")).toBe("fixture\n");
        expect(lstatSync(join(f.worktree, "node_modules")).isSymbolicLink()).toBe(true);
      }
    });
  });

  test("slug cleanup accepts populated dependency, build and harness runtime outputs", () => {
    withIgnoredCleanupFixture(".ai/harness/\nnode_modules/\ndist/\n.codegraph/\n.ci-affected-tests.json", f => {
      writeIgnoredFiles(f.worktree, [
        "node_modules/pkg/index.js", "dist/out.js", ".codegraph/codegraph.db", ".codegraph/daemon.log", ".codegraph/daemon.pid",
        ".ai/harness/runs/hook-events.jsonl", ".ai/harness/runs/junit/report.xml",
        ".ai/harness/runs/junit/20261120T000000Z-123/tests__contract-worktree.test.ts.xml",
        ".ai/harness/runs/task-agent-outbox/result-1.json", `.ai/harness/runs/task-agent-outbox/${"a".repeat(64)}/result-1.json`,
        `.ai/harness/runs/task-agent-outbox/${"a".repeat(64)}/context-1.txt`,
        ".ai/harness/state/agent-notice", ".ai/harness/state/agent-notice-status", ".ai/harness/state/agent-notice-archimap",
        ".ai/harness/state/circuit-breaker.json", ".ai/harness/state/protected-paths.json",
        ".ai/harness/failures/latest.jsonl", ".ci-affected-tests.json",
      ]);
      const preview = f.cli(...f.cleanup, "--dry-run");
      expect(preview.status, preview.stdout + preview.stderr).toBe(0);
      f.retained();
      const result = f.cli(...f.cleanup);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(f.worktree)).toBe(false);
      expect(existsSync(f.metadata)).toBe(false);
      expect(f.branchStatus()).not.toBe(0);
    });
  });

  const rotatedHookSegment = "1795132800000-12345678-1234-4321-9876-123456789abc.jsonl";

  test.each([
    { container: ".codegraph", outputs: [".gitignore", "codegraph.db"], label: "CodeGraph indexes" },
    { container: ".ai/harness/runs/hook-events.jsonl.archive", outputs: [rotatedHookSegment], label: "rotated hook telemetry" },
  ])("slug cleanup accepts generated $label", ({ container, outputs }) => {
    withIgnoredCleanupFixture(`.ai/harness/active-worktree\n${container}/`, f => {
      writeIgnoredFiles(f.worktree, outputs.map(path => `${container}/${path}`));
      const preview = f.cli(...f.cleanup, "--dry-run");
      expect(preview.status, preview.stdout + preview.stderr).toBe(0);
      f.retained();
      const removal = f.cli(...f.cleanup);
      expect(removal.status, removal.stdout + removal.stderr).toBe(0);
      expect(existsSync(f.worktree)).toBe(false);
    });
  });

  test("slug cleanup accepts a published checkpoint and empty staging directory", () => {
    withIgnoredCleanupFixture(".ai/harness/active-worktree\n.ai/harness/evidence/", f => {
      appendGenesisRecord(f.worktree, LEDGER_EPOCH_START_SHA, { worktreeId: "fixture" });
      const checkpoint = publishCheckpointFromLedger(f.worktree, () => new Date("2026-11-20T00:00:00Z"));
      expect(checkpoint.status).toBe("published");
      expect(readdirSync(join(f.worktree, ".ai/harness/evidence/checkpoints/.staging"))).toEqual([]);
      const preview = f.cli(...f.cleanup, "--dry-run");
      expect(preview.status, preview.stdout + preview.stderr).toBe(0);
      f.retained();
      const removal = f.cli(...f.cleanup);
      expect(removal.status, removal.stdout + removal.stderr).toBe(0);
      expect(existsSync(f.worktree)).toBe(false);
    });
  });

  const checkpointDir = `chk-${"b".repeat(64)}`;
  test.each([
    { container: ".codegraph", generated: ["codegraph.db"], local: ["notes.local", ".env", "backup/copy"],
      blocked: ["notes.local", ".env", "backup/"] },
    { container: ".ai/harness/evidence/checkpoints", generated: ["last-published.json", `${checkpointDir}/checkpoint.json`],
      local: ["notes.local", `${checkpointDir}/notes.local`, "chk-invalid/checkpoint.json", ".staging/stage-leftover/notes.local"],
      blocked: ["notes.local", `${checkpointDir}/notes.local`, "chk-invalid/", ".staging/stage-leftover/"] },
    { container: ".ai/harness/runs/hook-events.jsonl.archive", generated: [rotatedHookSegment],
      local: ["custom.jsonl"], blocked: ["custom.jsonl"] },
  ])("closeout retains unknown files in collapsed $container", ({ container, generated, local, blocked }) => {
    withIgnoredCleanupFixture(`.ai/harness/active-worktree\n${container}/`, f => {
      const paths = [...generated, ...local].map(path => `${container}/${path}`);
      writeIgnoredFiles(f.worktree, paths);
      const inventory = run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], f.worktree);
      expect(inventory.status).toBe(0);
      expect(inventory.stdout.split("\0").filter(path => path.startsWith(`${container}/`))).toEqual([`${container}/`]);
      for (const args of [[...f.cleanup, "--dry-run"], ["runtime", ...f.removeExact]]) {
        const result = f.cli(...args);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        for (const path of blocked) expect(result.stderr).toContain(JSON.stringify(`${container}/${path}`));
        for (const path of paths) expect(readFileSync(join(f.worktree, path), "utf8")).toBe("fixture\n");
        f.retained();
      }
    });
  });

  test.each([".codegraph", ".codegraph/codegraph.db"])("closeout retains symlinked %s", path => {
    withIgnoredCleanupFixture(".ai/harness/active-worktree\n/.codegraph", f => {
      const target = join(f.parent, "outside");
      const link = join(f.worktree, path);
      const directoryLink = path === ".codegraph";
      const contents = directoryLink ? join(target, "codegraph.db") : target;
      mkdirSync(dirname(contents), { recursive: true });
      writeFileSync(contents, "outside fixture\n");
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link, directoryLink ? "dir" : "file");
      for (const args of [[...f.cleanup, "--dry-run"], ["runtime", ...f.removeExact]]) {
        const result = f.cli(...args);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain(JSON.stringify(path));
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(contents, "utf8")).toBe("outside fixture\n");
        f.retained();
      }
    });
  });

  test("slug cleanup retains dotfiles under collapsed harness outputs", () => {
    withIgnoredCleanupFixture(".ai/harness/", f => {
      const paths = ["evidence/.env", "evidence/runs/.env.local.json", "evidence/runs/.env.local",
        "runs/junit/20261120T000000Z-123/.private.xml", `runs/task-agent-outbox/${"a".repeat(64)}/.env`]
        .map(path => `.ai/harness/${path}`);
      writeIgnoredFiles(f.worktree, paths);
      for (const extra of [["--dry-run"], []]) {
        const result = f.cli(...f.cleanup, ...extra);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        for (const path of paths) {
          expect(result.stderr).toContain(JSON.stringify(path));
          expect(readFileSync(join(f.worktree, path), "utf8")).toBe("fixture\n");
        }
        f.retained();
      }
    });
  });

  test.each(["collapsed", "individual"])("slug cleanup retains unknown outbox files in %s Git listings", listing => {
    const outbox = `.ai/harness/runs/task-agent-outbox/${"a".repeat(64)}`;
    const notes = `${outbox}/notes.local`;
    const paths = [`${outbox}/result-1.json`, `${outbox}/context-1.txt`, notes];
    const tracked = listing === "individual" ? [`${outbox}/.gitkeep`] : [];
    withIgnoredCleanupFixture(`.ai/harness/active-worktree\n${outbox}/`, f => {
      writeIgnoredFiles(f.worktree, paths);
      const inventory = run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], f.worktree);
      expect(inventory.status).toBe(0);
      expect(inventory.stdout.split("\0").filter(path => path.startsWith(outbox)).sort())
        .toEqual(listing === "individual" ? [...paths].sort() : [`${outbox}/`]);
      for (const extra of [["--dry-run"], []]) {
        const result = f.cli(...f.cleanup, ...extra);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain(JSON.stringify(notes));
        f.retained();
        for (const path of paths) expect(readFileSync(join(f.worktree, path), "utf8")).toBe("fixture\n");
      }
    }, tracked);
  });

  test("slug cleanup retains unknown files under collapsed state and failures directories", () => {
    const generated = [".ai/harness/state/protected-paths.json", ".ai/harness/failures/latest.jsonl"];
    const unknown = [".ai/harness/state/.env", ".ai/harness/state/notes.local", ".ai/harness/failures/notes.local"];
    withIgnoredCleanupFixture(".ai/harness/active-worktree\n.ai/harness/state/\n.ai/harness/failures/", f => {
      writeIgnoredFiles(f.worktree, [...generated, ...unknown]);
      const inventory = run("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], f.worktree);
      expect(inventory.status).toBe(0);
      expect(inventory.stdout.split("\0").filter(Boolean).sort())
        .toEqual([".ai/harness/active-worktree", ".ai/harness/failures/", ".ai/harness/state/"]);
      for (const extra of [["--dry-run"], []]) {
        const result = f.cli(...f.cleanup, ...extra);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        for (const path of unknown) expect(result.stderr).toContain(JSON.stringify(path));
        f.retained();
        for (const path of [...generated, ...unknown]) expect(readFileSync(join(f.worktree, path), "utf8")).toBe("fixture\n");
      }
    }, [".ai/harness/checks/.gitkeep"]);
  });

  test("slug cleanup allows named outputs in directories with tracked placeholders", () => {
    const tracked = ["checks", "runs", "failures"].map(dir => `.ai/harness/${dir}/.gitkeep`);
    withIgnoredCleanupFixture(".ai/harness/", f => {
      writeIgnoredFiles(f.worktree, ["checks/change-assessment.latest.json", "runs/verification-vx-123.log",
        "runs/verification-vx-123.json", "failures/latest.jsonl"].map(path => `.ai/harness/${path}`));
      const preview = f.cli(...f.cleanup, "--dry-run");
      expect(preview.status, preview.stdout + preview.stderr).toBe(0);
      const unknown = [".ai/harness/checks/notes.local", ".ai/harness/runs/.env", ".ai/harness/runs/verification-.env.log"];
      writeIgnoredFiles(f.worktree, unknown);
      const blocked = f.cli(...f.cleanup);
      expect(blocked.status).toBe(1);
      for (const path of unknown) {
        expect(blocked.stderr).toContain(JSON.stringify(path));
        expect(readFileSync(join(f.worktree, path), "utf8")).toBe("fixture\n");
      }
      f.retained();
      for (const path of unknown) rmSync(join(f.worktree, path));
      const result = f.cli(...f.cleanup);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(f.worktree)).toBe(false);
    }, tracked);
  });

  test("remove-exact rechecks ignored data added after a successful preview", () => {
    withIgnoredCleanupFixture(".ai/harness/active-worktree\n.ai/harness/evidence/\n.env\n/node_modules\n/ private/", f => {
      const ledger = ".ai/harness/evidence/events/log.jsonl";
      writeIgnoredFiles(f.worktree, [ledger]);
      const preview = f.cli(...f.cleanup, "--dry-run");
      expect(preview.status, preview.stdout + preview.stderr).toBe(0);
      const paths = ["build/.env", " private/keep.txt", ".ai/harness/evidence/events/unknown.txt"];
      writeIgnoredFiles(f.worktree, paths);
      symlinkSync(f.parent, join(f.worktree, "node_modules"), "dir");
      const result = f.cli("runtime", ...f.removeExact);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      for (const path of ["build/.env", " private/", ".ai/harness/evidence/events/unknown.txt", "node_modules"]) {
        expect(result.stderr).toContain(JSON.stringify(path));
      }
      expect(result.stderr).toContain("git status --ignored");
      f.retained();
      for (const path of [ledger, ...paths]) expect(readFileSync(join(f.worktree, path), "utf8")).toBe("fixture\n");
      expect(lstatSync(join(f.worktree, "node_modules")).isSymbolicLink()).toBe(true);
    });
  });

  test("ignored inventory refuses Git exit errors, stderr and truncated output before removal", () => {
    withIgnoredCleanupFixture(".ai/", f => {
      const git = join(f.parent, "git");
      const realGit = realpathSync(Bun.which("git")!);
      writeFileSync(git, `#!/bin/sh
if [ "$1" = ls-files ] && [ "$2" = --others ] && [ "$3" = --ignored ]; then
  case "$FIXTURE_GIT_FAILURE" in
    exit) exit 3 ;;
    stderr) printf '\\n' >&2; exit 0 ;;
    truncated) printf 'node_modules/'; exit 0 ;;
  esac
fi
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o700 });
      for (const failure of ["exit", "stderr", "truncated"]) {
        const env = { REPO_HARNESS_GIT_BIN: git, FIXTURE_GIT_FAILURE: failure };
        for (const attempt of [() => f.shell(env, ...f.cleanup, "--dry-run"), () => f.shell(env, ...f.cleanup), () => f.runtime(env)]) {
          const result = attempt();
          expect(result.status, result.stdout + result.stderr).toBe(1);
          expect(result.stderr).toContain("ignored worktree inventory failed");
          expect(result.stderr).toContain("git status --ignored");
          f.retained();
        }
      }
    });
  });

  test("contract-worktree cleanup should dry-run then remove merged worktree, branch, and metadata", () => {
    const cwd = tmpWorkspace("helper-contract-cleanup");
    const worktreePath = `${cwd}-wt-demo`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      commitAll(cwd, "init cleanup");

      expect(run("git", ["worktree", "add", worktreePath, "-b", "codex/demo"], cwd).status).toBe(0);
      writeStartMetadata(cwd, "demo", "codex/demo");

      const dryRun = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "demo", "--dry-run"], cwd);
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain("dry-run cleanup");
      expect(existsSync(worktreePath)).toBe(true);
      expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/demo"], cwd).status).toBe(0);
      expect(existsSync(join(cwd, ".ai/harness/worktrees/demo.json"))).toBe(true);

      const cleanup = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "demo"], cwd);
      expect(cleanup.status).toBe(0);
      expect(cleanup.stdout).toContain("Removed worktree");
      expect(cleanup.stdout).toContain("Deleted branch: codex/demo");
      expect(cleanup.stdout).toContain("Removed metadata");
      expect(existsSync(worktreePath)).toBe(false);
      expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/demo"], cwd).status).not.toBe(0);
      expect(existsSync(join(cwd, ".ai/harness/worktrees/demo.json"))).toBe(false);
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("contract-worktree start reads an open issue and emits one protocol 2 result", () => {
    const cwd = tmpWorkspace("helper-contract-start-json");
    const worktreePath = `${cwd}-wt-acquire`;
    const issue = { title: "Acquire fixture one two three four ignored" };
    const slug = "123-acquire-fixture-one-two-three";
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      commitAll(cwd, "seed structured start");

      mkdirSync(join(cwd, ".ai/harness/worktrees"), { recursive: true });
      const metadataPath = join(cwd, ".ai/harness/worktrees", `${slug}.json`);
      writeFileSync(metadataPath, "{}\n");
      const metadataResidual = start([
        "--issue", "123",
        "--path", worktreePath,
        "--fresh",
        "--json",
      ], cwd, {}, issue);
      expect(metadataResidual.status).toBe(1);
      expect(metadataResidual.stderr).toContain("--fresh refuses residual worktree metadata");
      rmSync(metadataPath);

      const started = start([
        "--issue", "123",
        "--path", worktreePath,
        "--fresh",
        "--json",
      ], cwd, {}, issue);
      expect(started.status, `${started.stdout}\n${started.stderr}`).toBe(0);
      const result = JSON.parse(started.stdout);
      expect(result).toEqual({
        protocol: 2,
        kind: "repo-harness-contract-worktree-start",
        worktree_path: realpathSync(worktreePath),
        branch: `feat/${slug}`,
        issue: 123,
        issue_url: ISSUE.url,
        disposition: "created",
      });
      expect(started.stdout.trim().split("\n")).toHaveLength(1);
      const metadata = JSON.parse(readFileSync(join(cwd, ".ai/harness/worktrees", `${slug}.json`), "utf8"));
      expect(metadata).toMatchObject({
        slug,
        issue: 123,
        issue_url: ISSUE.url,
        branch: `feat/${slug}`,
      });
      expect(metadata).not.toHaveProperty("plan");
      expect(existsSync(join(worktreePath, ".ai/harness/worktrees", `${slug}.json`))).toBe(false);
      expect(run("git", ["branch", "--show-current"], worktreePath).stdout.trim()).toBe(`feat/${slug}`);

      // Start metadata now lives in the primary checkout. Remove it so this
      // retry still exercises the residual worktree path refusal.
      rmSync(join(cwd, ".ai/harness/worktrees", `${slug}.json`));
      const residual = start([
        "--issue", "123",
        "--path", worktreePath,
        "--fresh",
        "--json",
      ], cwd, {}, issue);
      expect(residual.status).toBe(1);
      expect(residual.stderr).toContain("--fresh refuses residual worktree path");
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("rh worktrees start gives the same worktree, record and exit code as the helper script", () => {
    const issue = { title: "Parity fixture" };
    const slug = "123-parity-fixture";
    const ghStub = join(GH_DIR, "gh-parity");
    writeFileSync(ghStub, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ ...ISSUE, ...issue })}'\n`, { mode: 0o755 });
    const roots = [tmpWorkspace("helper-contract-start-script"), tmpWorkspace("helper-contract-start-cli")];
    try {
      for (const cwd of roots) {
        copyHelpers(cwd);
        initGitRepo(cwd);
        commitAll(cwd, "seed parity");
        addSelfOrigin(cwd);
      }
      const [scriptRoot, cliRoot] = roots;
      const home = join(cliRoot, "home");
      mkdirSync(home);
      const results = [
        start(["--issue", "123", "--path", `${scriptRoot}-wt`, "--json"], scriptRoot, {}, issue),
        run(process.execPath, [
          "--preload", join(ROOT, "tests/helpers/protected-helper-host.ts"),
          join(ROOT, "src/cli/index.ts"), "worktrees", "start", "--issue", "123", "--path", `${cliRoot}-wt`, "--json",
        ], cliRoot, { HOME: home, PROTECTED_HELPER_TEST_GH: ghStub, PROTECTED_HELPER_TEST_HOME: home }),
      ];
      const observed = results.map((result, index) => {
        const cwd = roots[index]!;
        const record = JSON.parse(readFileSync(join(cwd, ".ai/harness/worktrees", `${slug}.json`), "utf8"));
        const base = run("git", ["rev-parse", "origin/main"], cwd).stdout.trim();
        return {
          status: result.status,
          start: JSON.parse(result.stdout.replaceAll(realpathSync(`${cwd}-wt`), "<worktree>")),
          record: { ...record, worktree: record.worktree.replace(realpathSync(`${cwd}-wt`), "<worktree>"),
            source_repo: record.source_repo.replace(cwd, "<repo>"), base_commit: record.base_commit === base },
          branch: run("git", ["branch", "--show-current"], `${cwd}-wt`).stdout.trim(),
        };
      });
      expect(results[1]!.status, results[1]!.stderr).toBe(0);
      expect(observed[1]).toEqual(observed[0]!);
      expect(observed[0]).toMatchObject({ status: 0, branch: `feat/${slug}`, start: { worktree_path: "<worktree>", disposition: "created" },
        record: { slug, worktree: "<worktree>", source_repo: "<repo>", base_commit: true } });
    } finally {
      for (const cwd of roots) {
        run("git", ["worktree", "remove", "--force", `${cwd}-wt`], cwd);
        rmSync(`${cwd}-wt`, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  }, 60000);

  const codeGraphCases = ['seeded', 'retry-ready', 'retry-exhausted', 'no-base', 'wsl-primary', 'not-opted-in', 'not-selected', 'unreadable', 'init-failed', 'occupied'] as const;
  for (const scenario of codeGraphCases) {
    test.skipIf(process.platform === 'win32')(`rh worktrees start CodeGraph bootstrap: ${scenario}`, () => {
      const workspace = tmpWorkspace('shared-codegraph-start');
      const primary = join(workspace, 'primary');
      const linked = join(workspace, 'linked');
      const home = join(workspace, 'home');
      const log = join(workspace, 'calls.log');
      const node = resolveCompatibleNodeRuntime(process.env);
      const archctx = resolvePackageLocalArchctx().binaryPath;
      const env = { HOME: home, DO_NOT_TRACK: '1', CODEGRAPH_NO_DOWNLOAD: '1' };
      const arch = (cwd: string, args: string[]) => run(node, [archctx, ...args, '--json'], cwd, env);
      const baseDir = join(primary, '.git', 'archcontext', 'codegraph', productVersionManifest().runtime.codeGraph.requiredVersion);
      const pointer = join(baseDir, 'current.json');
      const hiddenPointer = join(workspace, 'published-pointer.json');
      const needsBase = scenario === 'seeded' || scenario === 'retry-ready';
      const busy = scenario === 'retry-ready' || scenario === 'retry-exhausted';
      mkdirSync(primary);
      mkdirSync(home);
      try {
        const indexDir = join(primary, '.codegraph');
        const wslPrimaryDir = join(primary, '.codegraph-wsl');
        initGitRepo(primary);
        if (scenario === 'wsl-primary') {
          mkdirSync(wslPrimaryDir);
          writeFileSync(join(wslPrimaryDir, 'marker.txt'), 'wsl-primary-untouched\n');
          writeFileSync(join(primary, '.gitignore'), '.codegraph/\n.codegraph-wsl/\n');
        } else {
          if (scenario !== 'not-opted-in') mkdirSync(indexDir);
          if (scenario === 'occupied') writeFileSync(join(indexDir, 'user.txt'), 'keep this file');
          else writeFileSync(join(primary, '.gitignore'), '.codegraph/\n');
        }
        writeFileSync(join(primary, 'index.ts'), 'export const baseSymbol = true;\n');
        commitAll(primary, 'seed CodeGraph fixture');
        if (scenario === 'unreadable') {
          mkdirSync(join(home, '.repo-harness'));
          writeFileSync(installStateFixturePath(env), '{');
        } else if (scenario !== 'not-selected') recordPluginSelection(env);
        if (needsBase) {
          writeFileSync(join(home, '.repo-harness/config.json'), JSON.stringify({ architecture: { projection_provider: 'archctx', projection_apply: 'manual' } }));
          indexPackageLocalCodeGraph(primary, {
            env: { ...process.env, ...env },
            policy: { provider: 'archctx', requiredVersion: ARCHCTX_REQUIRED_VERSION, applyMode: 'disabled', timeoutMs: 120_000 },
          });
          const published = run(process.execPath, [join(ROOT, 'src/cli/index.ts'), 'arch', 'index', 'seed', '--json'], primary, env);
          expect(published.status, published.stderr || published.stdout).toBe(0);
          expect(JSON.parse(published.stdout).data).toMatchObject({
            schemaVersion: 'archcontext.index-seed/v1',
            mode: 'primary-refresh',
            worktreeRole: 'primary',
            copiedFiles: 1,
          });
          if (scenario === 'seeded') {
            writeFileSync(join(primary, 'index.ts'), 'export const refreshedSymbol = true;\n');
            commitAll(primary, 'advance the primary checkout');
          } else renameSync(pointer, hiddenPointer);
        }
        if (busy) {
          mkdirSync(baseDir, { recursive: true });
          writeFileSync(join(baseDir, 'refresh.lock'), `${process.pid}\n`, { flag: 'wx' });
        }
        const primaryHead = run('git', ['rev-parse', 'HEAD'], primary).stdout.trim();
        addSelfOrigin(primary);

        const gh = join(workspace, 'gh');
        writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(JSON.stringify(ISSUE))}\n`, { mode: 0o755 });
        const observedNode = join(workspace, 'node');
        writeFileSync(observedNode, [
          '#!/bin/sh',
          'case "${1##*/}:${2:-}:${3:-}" in',
          `  archctx.mjs:index:seed) printf 'index seed %s\\n' "$(pwd -P)" >> ${shellQuote(log)} ;;`,
          `  npm-shim.js:init:*) printf 'init %s\\n' "$(pwd -P)" >> ${shellQuote(log)} ;;`,
          'esac',
          ...(scenario === 'retry-ready' ? [
            `if [ "$2" = index ] && [ "$3" = seed ] && [ "$(pwd -P)" = ${shellQuote(linked)} ] && [ -f ${shellQuote(hiddenPointer)} ]; then`,
            `  (sleep 0.3 && mv ${shellQuote(hiddenPointer)} ${shellQuote(pointer)}) >/dev/null 2>&1 &`,
            'fi',
          ] : []),
          ...(scenario === 'init-failed' ? ['if [ "$2" = init ]; then head -c 5000 /dev/zero | tr "\\000" x >&2; exit 1; fi'] : []),
          `exec ${shellQuote(node)} "$@"`,
          '',
        ].join('\n'), { mode: 0o755 });
        const started = run(process.execPath, [
          '--preload', join(ROOT, 'tests/helpers/protected-helper-host.ts'),
          join(ROOT, 'src/cli/index.ts'), 'worktrees', 'start', '--issue', '123', '--path', linked, '--json',
        ], primary, { ...env, PROTECTED_HELPER_TEST_GH: gh, PROTECTED_HELPER_TEST_HOME: home, PROTECTED_HELPER_TEST_NODE: observedNode });
        expect(started.status, `${started.stderr}\n${started.stdout}`).toBe(scenario === 'init-failed' || scenario === 'occupied' ? 1 : 0);
        expect(existsSync(join(linked, '.git'))).toBe(true);
        const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
        const db = '.codegraph/codegraph.db';
        switch (scenario) {
          case 'seeded':
          case 'retry-ready': {
            expect(calls).toEqual([`index seed ${primary}`, `index seed ${linked}`]);
            const seeded = lstatSync(join(linked, db));
            expect(seeded.isFile()).toBe(true);
            expect(seeded.ino).not.toBe(lstatSync(join(primary, db)).ino);
            const doctor = arch(linked, ['doctor']);
            expect(doctor.status, doctor.stderr || doctor.stdout).toBe(0);
            expect(JSON.parse(doctor.stdout).data.codeFacts).toMatchObject({ state: 'ready', indexPresent: true });
            expect(JSON.parse(readFileSync(pointer, 'utf8')).headSha).toBe(primaryHead);
            if (scenario === 'seeded') {
              // Reusing linked worktree with clean `.codegraph/codegraph.db` and no `.codegraph-wsl` skips bootstrap.
              writeFileSync(log, '');
              const cleanReuse = run(process.execPath, [
                '--preload', join(ROOT, 'tests/helpers/protected-helper-host.ts'),
                join(ROOT, 'src/cli/index.ts'), 'worktrees', 'start', '--issue', '123', '--path', linked, '--json',
              ], primary, { ...env, PROTECTED_HELPER_TEST_GH: gh, PROTECTED_HELPER_TEST_HOME: home, PROTECTED_HELPER_TEST_NODE: observedNode });
              expect(cleanReuse.status, `${cleanReuse.stderr}\n${cleanReuse.stdout}`).toBe(0);
              expect(readFileSync(log, 'utf8').trim()).toBe('');

              // Reusing linked worktree holding both `.codegraph/codegraph.db` and `.codegraph-wsl` does NOT skip CodeGraph checks.
              mkdirSync(join(linked, '.codegraph-wsl'));
              writeFileSync(join(linked, '.codegraph-wsl', 'stale.txt'), 'wsl-present\n');
              const wslCoexistReuse = run(process.execPath, [
                '--preload', join(ROOT, 'tests/helpers/protected-helper-host.ts'),
                join(ROOT, 'src/cli/index.ts'), 'worktrees', 'start', '--issue', '123', '--path', linked, '--json',
              ], primary, { ...env, PROTECTED_HELPER_TEST_GH: gh, PROTECTED_HELPER_TEST_HOME: home, PROTECTED_HELPER_TEST_NODE: observedNode });
              expect(wslCoexistReuse.status, `${wslCoexistReuse.stderr}\n${wslCoexistReuse.stdout}`).toBe(0);
              expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([`index seed ${primary}`, `index seed ${linked}`]);
              expect(readFileSync(join(linked, '.codegraph-wsl', 'stale.txt'), 'utf8')).toBe('wsl-present\n');
            }
            break;
          }
          case 'retry-exhausted':
            expect(calls).toEqual([`index seed ${linked}`, `init ${linked}`]);
            expect(started.stderr).toContain('(index-base-building)');
            expect(existsSync(pointer)).toBe(false);
            expect(lstatSync(join(linked, db)).isFile()).toBe(true);
            break;
          case 'no-base':
          case 'wsl-primary':
          case 'init-failed':
            expect(calls).toEqual([`index seed ${linked}`, `init ${linked}`]);
            expect(existsSync(join(linked, db))).toBe(scenario !== 'init-failed');
            expect(existsSync(join(primary, db))).toBe(false);
            if (scenario === 'wsl-primary') {
              expect(readFileSync(join(wslPrimaryDir, 'marker.txt'), 'utf8')).toBe('wsl-primary-untouched\n');
            }
            if (scenario === 'init-failed') {
              expect(started.stderr).toContain('codegraph init in');
              expect(started.stderr).not.toContain('x'.repeat(2001));
            }
            break;
          case 'occupied':
            expect(calls).toEqual([]);
            expect(readFileSync(join(linked, '.codegraph/user.txt'), 'utf8')).toBe('keep this file');
            break;
          default:
            expect(calls).toEqual([]);
            expect(existsSync(join(linked, '.codegraph'))).toBe(false);
            expect(existsSync(indexDir)).toBe(scenario !== 'not-opted-in');
            if (scenario === 'not-selected') expect(started.stderr).toContain('the architecture plugin is not selected; run: rh install');
            if (scenario === 'unreadable') expect(started.stderr).toContain('the install selection cannot be read');
        }
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }, 60_000);
  }

  test("contract-worktree start bases the worktree on the upstream tip and fails closed without an upstream", () => {
    const cwd = tmpWorkspace("helper-contract-start-origin");
    const origin = `${cwd}-origin`;
    const worktreePath = `${cwd}-wt-origin`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      commitAll(cwd, "seed origin start");
      expect(run("git", ["clone", "--bare", cwd, origin], cwd).status).toBe(0);
      expect(run("git", ["remote", "add", "origin", origin], cwd).status).toBe(0);
      const staleHead = run("git", ["rev-parse", "HEAD"], cwd).stdout.trim();

      // Without an upstream the base is unknown: start stops, no fallback to HEAD.
      const failed = run("bash", ["scripts/contract-worktree.sh", "start", "--issue", "123", "--path", worktreePath], cwd, issueEnv());
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("no resolvable upstream");
      expect(existsSync(worktreePath)).toBe(false);

      // A second clone advances origin/main; the caller fetches; local main stays behind.
      const pusher = `${cwd}-pusher`;
      expect(run("git", ["clone", origin, pusher], cwd).status).toBe(0);
      writeFileSync(join(pusher, "ahead"), "ahead\n");
      expect(run("git", ["add", "."], pusher).status).toBe(0);
      expect(run("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ahead"], pusher).status).toBe(0);
      expect(run("git", ["push", "-q", "origin", "main"], pusher).status).toBe(0);
      const originTip = run("git", ["rev-parse", "HEAD"], pusher).stdout.trim();
      rmSync(pusher, { recursive: true, force: true });
      expect(run("git", ["fetch", "-q", "origin"], cwd).status).toBe(0);
      expect(run("git", ["branch", "-q", "--set-upstream-to=origin/main", "main"], cwd).status).toBe(0);

      const started = start(["--issue", "123", "--path", worktreePath], cwd);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stderr).toContain(`Base: origin/main ${originTip}`);
      expect(run("git", ["rev-parse", "HEAD"], worktreePath).stdout.trim()).toBe(originTip);
      expect(originTip).not.toBe(staleHead);
      const metadata = JSON.parse(readFileSync(join(cwd, ".ai/harness/worktrees/123-location.json"), "utf8"));
      expect(metadata.base_commit).toBe(originTip);
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30000);

  test("contract-worktree start uses --type for the branch prefix", () => {
    const cwd = tmpWorkspace("helper-contract-start-type");
    const worktreePath = `${cwd}-wt-type`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      commitAll(cwd, "seed typed start");

      const started = start(["--issue", "123", "--type", "fix", "--path", worktreePath, "--json"], cwd);
      expect(started.status, started.stderr).toBe(0);
      expect(JSON.parse(started.stdout)).toMatchObject({
        branch: "fix/123-location",
        issue: 123,
        disposition: "created",
      });
      const metadata = JSON.parse(readFileSync(join(cwd, ".ai/harness/worktrees/123-location.json"), "utf8"));
      expect(metadata.branch).toBe("fix/123-location");
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("contract-worktree start rejects plan, missing gh, gh failure and non-open issues", () => {
    const cwd = tmpWorkspace("helper-contract-start-reject");
    const target = join(cwd, "never-created");
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      commitAll(cwd, "seed rejected starts");

      const plan = run("/bin/bash", ["scripts/contract-worktree.sh", "start", "--plan", "plans/plan-old.md"], cwd, {
        PATH: NO_GH_DIR,
      });
      expect(plan.status).toBe(2);
      expect(plan.stderr.trim()).toBe("contract-worktree: unknown option --plan; use --issue <n>");

      const missingGh = run("/bin/bash", ["scripts/contract-worktree.sh", "start", "--issue", "123", "--path", target], cwd, {
        PATH: NO_GH_DIR,
      });
      expect(missingGh.status).toBe(2);
      expect(missingGh.stderr.trim()).toBe("contract-worktree: gh is required for --issue");

      const ghFailure = start(["--issue", "123", "--path", target], cwd, {
        GH_STUB_ERROR: "gh: authentication required",
      });
      expect(ghFailure.status).toBe(2);
      expect(ghFailure.stderr.trim()).toBe("contract-worktree: cannot read issue 123: gh: authentication required");

      const closed = start(["--issue", "123", "--path", target], cwd, {}, { state: "CLOSED" });
      expect(closed.status).toBe(2);
      expect(closed.stderr.trim()).toBe("contract-worktree: issue 123 is CLOSED");

      expect(existsSync(target)).toBe(false);
      expect(existsSync(join(cwd, ".ai/harness/worktrees"))).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("contract-worktree cleanup should repair stale gitdir before removing a merged worktree", () => {
    const cwd = tmpWorkspace("helper-contract-cleanup-repair");
    const worktreePath = `${cwd}-wt-demo`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      commitAll(cwd, "init cleanup repair");

      expect(run("git", ["worktree", "add", worktreePath, "-b", "codex/demo"], cwd).status).toBe(0);
      writeStartMetadata(cwd, "demo", "codex/demo");
      const staleGitdir = "gitdir: /tmp/moved-repo/.git/worktrees/wt-demo\n";
      writeFileSync(join(worktreePath, ".git"), staleGitdir);

      const dryRun = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "demo", "--dry-run"], cwd);
      expect(dryRun.status).toBe(1);
      expect(dryRun.stderr).toContain("linked worktree status unavailable");
      expect(dryRun.stderr).toContain(`git worktree repair '${worktreePath}'`);
      expect(readFileSync(join(worktreePath, ".git"), "utf8")).toBe(staleGitdir);
      expect(existsSync(worktreePath)).toBe(true);
      expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/demo"], cwd).status).toBe(0);

      const cleanup = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "demo"], cwd);
      expect(cleanup.status).toBe(0);
      expect(cleanup.stderr).toContain("Repaired stale worktree gitdir");
      expect(cleanup.stdout).toContain("Removed worktree");
      expect(cleanup.stdout).toContain("Deleted branch: codex/demo");
      expect(existsSync(worktreePath)).toBe(false);
      expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/demo"], cwd).status).not.toBe(0);
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("contract-worktree cleanup removes a feat worktree created by start", () => {
    const cwd = tmpWorkspace("helper-contract-cleanup-feat");
    const worktreePath = `${cwd}-wt-feat`;
    const slug = "123-feat-cleanup";
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      writeFileSync(join(cwd, ".gitignore"), ".ai/harness/worktrees/\n.ai/harness/active-worktree\n");
      commitAll(cwd, "init cleanup feat");
      const started = start(["--issue", "123", "--path", worktreePath, "--json"], cwd, {}, { title: "Feat cleanup" });
      expect(started.status, started.stderr).toBe(0);
      expect(JSON.parse(started.stdout).branch).toBe(`feat/${slug}`);

      const dryRun = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", slug, "--dry-run"], cwd);
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(dryRun.stdout).toContain(`would delete branch: feat/${slug}`);
      expect(existsSync(worktreePath)).toBe(true);

      const cleanup = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", slug], cwd);
      expect(cleanup.status, cleanup.stderr).toBe(0);
      expect(cleanup.stdout).toContain(`Deleted branch: feat/${slug}`);
      expect(existsSync(worktreePath)).toBe(false);
      expect(run("git", ["show-ref", "--verify", "--quiet", `refs/heads/feat/${slug}`], cwd).status).not.toBe(0);
      expect(existsSync(join(cwd, ".ai/harness/worktrees", `${slug}.json`))).toBe(false);
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("contract-worktree cleanup removes the start branch after the worktree is pruned", () => {
    const cwd = tmpWorkspace("helper-contract-cleanup-pruned");
    const worktreePath = `${cwd}-wt-pruned`;
    const slug = "123-pruned";
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      writeFileSync(join(cwd, ".gitignore"), ".ai/harness/worktrees/\n");
      commitAll(cwd, "init cleanup pruned");
      const started = start(["--issue", "123", "--path", worktreePath, "--json"], cwd, {}, { title: "Pruned" });
      expect(started.status, started.stderr).toBe(0);
      expect(JSON.parse(started.stdout).branch).toBe(`feat/${slug}`);
      expect(existsSync(join(cwd, ".ai/harness/worktrees", `${slug}.json`))).toBe(true);

      expect(run("git", ["worktree", "remove", "--force", worktreePath], cwd).status).toBe(0);
      expect(run("git", ["worktree", "prune"], cwd).status).toBe(0);
      expect(existsSync(worktreePath)).toBe(false);
      expect(run("git", ["show-ref", "--verify", "--quiet", `refs/heads/feat/${slug}`], cwd).status).toBe(0);

      const cleanup = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", slug], cwd);
      expect(cleanup.status, cleanup.stderr).toBe(0);
      expect(cleanup.stdout).toContain(`Deleted branch: feat/${slug}`);
      expect(run("git", ["show-ref", "--verify", "--quiet", `refs/heads/feat/${slug}`], cwd).status).not.toBe(0);
      expect(existsSync(join(cwd, ".ai/harness/worktrees", `${slug}.json`))).toBe(false);
      expect(run("git", ["branch", "--list", `codex/${slug}`], cwd).stdout.trim()).toBe("");
    } finally {
      run("git", ["worktree", "remove", "--force", worktreePath], cwd);
      rmSync(worktreePath, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("contract-worktree cleanup fails closed when start metadata is missing", () => {
    const cwd = tmpWorkspace("helper-contract-cleanup-no-metadata");
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      writeFileSync(join(cwd, ".ai/harness/policy.json"), `${JSON.stringify({ worktree_strategy: { branch_prefix: "codex/" } })}\n`);
      commitAll(cwd, "init missing metadata");
      expect(run("git", ["branch", "codex/no-metadata"], cwd).status).toBe(0);

      const cleanup = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "no-metadata"], cwd);
      expect(cleanup.status).toBe(2);
      expect(cleanup.stderr.trim()).toBe("contract-worktree: no start metadata for no-metadata");
      expect(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/codex/no-metadata"], cwd).status).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("contract-worktree cleanup fails closed when the recorded branch is missing", () => {
    const cwd = tmpWorkspace("helper-contract-cleanup-missing-branch");
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      commitAll(cwd, "init missing branch");
      writeStartMetadata(cwd, "missing-branch", "feat/missing-branch");

      const cleanup = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "missing-branch"], cwd);
      expect(cleanup.status).toBe(2);
      expect(cleanup.stderr.trim()).toBe("contract-worktree: branch feat/missing-branch not found");
      expect(existsSync(join(cwd, ".ai/harness/worktrees/missing-branch.json"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);

  test("contract-worktree cleanup should refuse unmerged, dirty, and linked-cwd cleanup", () => {
    const cwd = tmpWorkspace("helper-contract-cleanup-refuse");
    const unmergedPath = `${cwd}-wt-unmerged`;
    const dirtyPath = `${cwd}-wt-dirty`;
    const linkedPath = `${cwd}-wt-linked`;
    try {
      copyHelpers(cwd);
      initGitRepo(cwd);
      writeFileSync(join(cwd, "README.md"), "# demo\n");
      commitAll(cwd, "init cleanup refuse");

      expect(run("git", ["worktree", "add", unmergedPath, "-b", "codex/unmerged"], cwd).status).toBe(0);
      writeStartMetadata(cwd, "unmerged", "codex/unmerged");
      writeFileSync(join(unmergedPath, "feature.txt"), "unmerged\n");
      commitAll(unmergedPath, "unmerged branch change");
      const unmerged = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "unmerged"], cwd);
      expect(unmerged.status).toBe(1);
      expect(unmerged.stderr).toContain("not fully merged");

      expect(run("git", ["worktree", "add", dirtyPath, "-b", "codex/dirty"], cwd).status).toBe(0);
      writeStartMetadata(cwd, "dirty", "codex/dirty");
      writeFileSync(join(dirtyPath, "dirty.txt"), "dirty\n");
      const dirty = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "dirty"], cwd);
      expect(dirty.status).toBe(1);
      expect(dirty.stderr).toContain("linked worktree is dirty");

      expect(run("git", ["worktree", "add", linkedPath, "-b", "codex/linked"], cwd).status).toBe(0);
      const linked = run("bash", ["scripts/contract-worktree.sh", "cleanup", "--slug", "linked"], linkedPath);
      expect(linked.status).toBe(1);
      expect(linked.stderr).toContain("cleanup must run from the target primary worktree");
    } finally {
      for (const path of [unmergedPath, dirtyPath, linkedPath]) {
        run("git", ["worktree", "remove", "--force", path], cwd);
        rmSync(path, { recursive: true, force: true });
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15000);
});

describe('task worktree location', () => {
  test('a policy without a location key uses the package default, and start uses the managed test root', () => {
    const expectedTemplate = defaultWorktreeTemplate(process.platform, tmpdir());
    const parent = tmpWorkspace('worktree-default');
    const cwd = join(parent, 'repo');
    const managed = join(parent, 'managed');
    mkdirSync(cwd); mkdirSync(managed);
    try {
      copyHelpers(cwd); initGitRepo(cwd);
      mkdirSync(join(cwd, '.ai/harness'), { recursive: true });
      writeFileSync(join(cwd, '.ai/harness/policy.json'), JSON.stringify(defaultPolicy('en')));
      expect(defaultPolicy('en')).not.toHaveProperty('worktree_strategy');
      const helperTemplate = run(process.execPath, ['scripts/contract-worktree-runtime.ts', 'default-template'], cwd);
      expect(helperTemplate.status, helperTemplate.stderr).toBe(0); expect(helperTemplate.stdout.trim()).toBe(expectedTemplate);
      commitAll(cwd, 'location fixture');
      run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], cwd);
      const result = start(['--issue', '123', '--json'], cwd, { REPO_HARNESS_WORKTREE_ROOT: managed });
      expect(result.status).toBe(0);
      const path = join(managed, 'repo-wt-123-location');
      expect(JSON.parse(result.stdout).worktree_path).toBe(path);
      expect(readFileSync(join(path, '.ai/harness/active-worktree'), 'utf8').trim()).toBe(path);
      const retry = start(['--issue', '123', '--json'], cwd, { REPO_HARNESS_WORKTREE_ROOT: managed });
      expect(retry.status, retry.stderr).toBe(0);
      expect(JSON.parse(retry.stdout)).toMatchObject({ disposition: 'reused_existing_worktree', worktree_path: path });
      const sweep = sweepManagedWorktrees(cwd, cwd, { ...process.env, REPO_HARNESS_WORKTREE_ROOT: managed }, { deadlineMs: 60_000 });
      expect(sweep).toContain(`${path}: kept; cleanup_blocked_dirty_worktree, branch has no commits of its own`);
      expect(readFileSync(join(path, '.ai/harness/active-worktree'), 'utf8').trim()).toBe(path);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 15000);

  test('start ignores a location template in the policy', () => {
    const parent = tmpWorkspace('worktree-stored'); const cwd = join(parent, 'repo'); const managed = join(parent, 'managed');
    mkdirSync(cwd); mkdirSync(managed);
    try {
      copyHelpers(cwd); initGitRepo(cwd);
      writeFileSync(join(cwd, '.ai/harness/policy.json'), JSON.stringify({ worktree_strategy: { worktree_dir_template: '/custom/{{slug}}' } }));
      commitAll(cwd, 'stored location fixture');
      const result = start(['--issue', '123', '--json'], cwd, { REPO_HARNESS_WORKTREE_ROOT: managed });
      expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout).worktree_path).toBe(join(managed, 'repo-wt-123-location'));
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 15000);

  test.each(['directory', 'file', 'symlink'])('start refuses an existing %s at the default target', kind => {
    const parent = tmpWorkspace('worktree-existing');
    const cwd = join(parent, 'repo'); const managed = join(parent, 'managed');
    mkdirSync(cwd); mkdirSync(managed);
    const target = join(managed, 'repo-wt-123-location');
    try {
      copyHelpers(cwd); initGitRepo(cwd); commitAll(cwd, 'location fixture');
      if (kind === 'directory') mkdirSync(target);
      else if (kind === 'file') writeFileSync(target, 'keep');
      else symlinkSync(join(parent, 'absent'), target);
      const result = start(['--issue', '123'], cwd, { REPO_HARNESS_WORKTREE_ROOT: managed });
      expect(result.status).toBe(1); expect(result.stderr).toContain('target worktree path already exists');
      expect(lstatSync(target)).toBeDefined();
      expect(run('git', ['show-ref', '--verify', 'refs/heads/feat/123-location'], cwd).status).not.toBe(0);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 15000);
});

describe('W2/W3/W4 start and closeout ownership', () => {
  function fixture() {
    const parent = tmpWorkspace('start-closeout'); const cwd = join(parent, 'repo'); const target = join(parent, 'linked');
    mkdirSync(cwd); copyHelpers(cwd); initGitRepo(cwd);
    writeFileSync(join(cwd, '.gitignore'), '.ai/\nnode_modules\n'); commitAll(cwd, 'base'); addSelfOrigin(cwd);
    const args = ['--issue', '123', '--path', target, '--branch', 'codex/owned'];
    return {
      parent,
      cwd,
      target,
      start: (extra: string[] = [], env: NodeJS.ProcessEnv = {}) => start([...args, ...extra], cwd, env, { title: 'Owned' }),
      cleanup: () => rmSync(parent, { recursive: true, force: true }),
    };
  }
  test('real start, task commit, merge and cleanup releases only the self marker', () => {
    const f = fixture(); try {
      const started = f.start();
      expect(started.status, started.stderr).toBe(0);
      expect(readFileSync(join(f.target, '.ai/harness/active-worktree'), 'utf8').trim()).toBe(f.target);
      writeFileSync(join(f.target, 'change'), 'task change'); commitAll(f.target, 'task change');
      expect(run('git', ['merge', '--ff-only', 'codex/owned'], f.cwd).status).toBe(0);
      const result = run('bash', ['scripts/contract-worktree.sh', 'cleanup', '--slug', '123-owned', '--target', 'main'], f.cwd);
      expect(result.status, result.stderr).toBe(0); expect(existsSync(f.target)).toBe(false);
      expect(run('git', ['branch', '--list', 'codex/owned'], f.cwd).stdout.trim()).toBe('');
    } finally { f.cleanup(); }
  }, 15000);
  test('retry recovers the same registered branch and marker', () => {
    const f = fixture(); try {
      expect(f.start().status).toBe(0);
      const retry = f.start(['--json']);
      expect(retry.status, retry.stderr).toBe(0); expect(JSON.parse(retry.stdout).disposition).toBe('reused_existing_worktree');
      expect(readFileSync(join(f.target, '.ai/harness/active-worktree'), 'utf8').trim()).toBe(f.target);
    } finally { f.cleanup(); }
  }, 15000);
  test.each([false, true])('W6 start, recovery and closeout work under umask 002; shared=%s', shared => {
    const f = fixture(); try {
      if (shared) expect(run('git', ['config', 'core.sharedRepository', 'group'], f.cwd).status).toBe(0);
      const invoke = (extra: string[] = []) => run('bash', [
        '-c', 'umask 002; exec bash "$@"', 'w6',
        'scripts/contract-worktree.sh', 'start', '--issue', '123', '--path', f.target, '--branch', 'codex/owned', ...extra,
      ], f.cwd, issueEnv({}, { title: 'Owned' }));
      const started = invoke(); expect(started.status, started.stderr).toBe(0);
      expect(lstatSync(f.target).mode & 0o022).toBe(0);
      expect(lstatSync(join(f.target, '.git')).mode & 0o020).toBe(0o020);
      const retry = invoke(['--json']); expect(retry.status, retry.stderr).toBe(0);
      expect(JSON.parse(retry.stdout).disposition).toBe('reused_existing_worktree');
      const store = join(f.cwd, '.git/repo-harness/coordination/worktree-identities');
      const record = readdirSync(store).find(name => name.endsWith('.json'))!; expect(record).toBeTruthy();
      const stale = join(store, record + '.12345678-1234-4123-8123-123456789abc');
      writeFileSync(stale, 'unpublished', { mode: 0o600 }); utimesSync(stale, new Date(0), new Date(0));
      const unknown = join(store, 'keep.txt'); writeFileSync(unknown, 'keep');
      expect(invoke().status).toBe(0);
      expect(existsSync(stale)).toBe(false); expect(existsSync(unknown)).toBe(true);
      writeFileSync(join(f.target, 'change'), 'task'); commitAll(f.target, 'task');
      expect(run('git', ['merge', '--ff-only', 'codex/owned'], f.cwd).status).toBe(0);
      const cleanup = run('bash', ['scripts/contract-worktree.sh', 'cleanup', '--slug', '123-owned', '--target', 'main'], f.cwd);
      expect(cleanup.status, cleanup.stderr).toBe(0); expect(existsSync(f.target)).toBe(false);
      expect(readdirSync(store).filter(name => name.endsWith('.json'))).toEqual([]);
    } finally { f.cleanup(); }
  }, 20000);

  test('W6 an old registered checkout without a start identity has an action message', () => {
    const f = fixture(); try {
      expect(run('git', ['worktree', 'add', '-b', 'codex/owned', f.target], f.cwd).status).toBe(0);
      const retry = f.start();
      expect(retry.status).toBe(1); expect(retry.stderr).toContain('no start identity record:');
      expect(retry.stderr).toContain('start with a new slug'); expect(retry.stderr).not.toContain('ENOENT');
      expect(existsSync(f.target)).toBe(true);
    } finally { f.cleanup(); }
  });

  test('W6 no-uid runtime creation succeeds and recovery refuses clearly', () => {
    const f = fixture(); try {
      const runtime = join(ROOT, 'scripts/contract-worktree-runtime.ts');
      const worker = join(f.parent, 'no-uid.ts');
      writeFileSync(worker, `process.getuid=undefined;process.argv=[process.execPath,${JSON.stringify(runtime)},...process.argv.slice(2)];await import(${JSON.stringify(runtime)});`);
      const added = run(process.execPath, [worker, 'add-worktree', '--repo', f.cwd, '--worktree', f.target, '--branch', 'codex/owned', '--base', 'HEAD', '--new-branch'], f.cwd);
      expect(added.status, added.stderr).toBe(0); expect(existsSync(join(f.target, '.git'))).toBe(true);
      expect(existsSync(join(f.target, '.ai/harness/active-worktree'))).toBe(true);
      expect(existsSync(join(f.cwd, '.git/repo-harness/coordination/worktree-identities'))).toBe(false);
      const retry = run(process.execPath, [worker, 'check-start-path', '--repo', f.cwd, '--worktree', f.target, '--branch', 'codex/owned'], f.cwd);
      expect(retry.status).toBe(1); expect(retry.stderr).toContain('recovery uid is unavailable:');
    } finally { f.cleanup(); }
  });

  test('W6 identity write failure names the retained checkout and manual cleanup', () => {
    const f = fixture(); try {
      const binary = join(f.parent, 'git-block-identity');
      writeFileSync(binary, '#!/bin/sh\n/usr/bin/git "$@"\nstatus=$?\nif [ "$1" = worktree ] && [ "$2" = add ] && [ "$status" = 0 ]; then mkdir -p "$W6_STORE_PARENT"; printf blocked > "$W6_STORE_PARENT/worktree-identities"; fi\nexit "$status"\n', { mode: 0o755 });
      const started = f.start([], { REPO_HARNESS_GIT_BIN: binary, W6_STORE_PARENT: join(f.cwd, '.git/repo-harness/coordination') });
      expect(started.status).toBe(1); expect(started.stderr).toContain('Git created checkout ' + f.target);
      expect(started.stderr).toContain('Managed cleanup cannot prove ownership');
      expect(started.stderr).toContain('git branch -D codex/owned');
      expect(existsSync(join(f.target, '.git'))).toBe(true);
    } finally { f.cleanup(); }
  });

  test('W5 start and recovery accept the system tmp canonical alias', () => {
    const f = fixture(); try {
      const alias = f.target.replace(/^\/private\/tmp\//, '/tmp/');
      const args = ['--issue', '123', '--path', alias, '--branch', 'codex/owned'];
      expect(start(args, f.cwd, {}, { title: 'Owned' }).status).toBe(0);
      const retry = start([...args, '--json'], f.cwd, {}, { title: 'Owned' });
      expect(retry.status, retry.stderr).toBe(0);
      expect(JSON.parse(retry.stdout).disposition).toBe('reused_existing_worktree');
      expect(readFileSync(join(f.target, '.ai/harness/active-worktree'), 'utf8').trim()).toBe(f.target);
    } finally { f.cleanup(); }
  }, 15000);
  test.each(['replacement', 'deleted-replacement', 'writable', 'git-symlink'])('W5 recovery refuses %s', change => {
    const f = fixture(); try {
      expect(f.start().status).toBe(0);
      const pointer = readFileSync(join(f.target, '.git'), 'utf8');
      if (change === 'replacement' || change === 'deleted-replacement') {
        // Rename keeps the old inode allocated, as a cleaner or another process can.
        const old = join(f.parent, 'old-checkout');
        if (change === 'replacement') require('fs').renameSync(f.target, old);
        else rmSync(f.target, { recursive: true });
        mkdirSync(f.target, { mode: 0o700 });
        writeFileSync(join(f.target, '.git'), pointer); writeFileSync(join(f.target, 'planted'), 'unsafe');
      } else if (change === 'writable') chmodSync(f.target, 0o777);
      else {
        const copy = join(f.parent, 'copied-pointer'); writeFileSync(copy, pointer);
        rmSync(join(f.target, '.git')); symlinkSync(copy, join(f.target, '.git'));
      }
      const retry = f.start();
      expect(retry.status).toBe(1); expect(existsSync(f.target)).toBe(true);
      if (change === 'replacement' || change === 'deleted-replacement') expect(readFileSync(join(f.target, 'planted'), 'utf8')).toBe('unsafe');
    } finally { f.cleanup(); }
  }, 15000);
  test('an existing target on another branch is refused', () => {
    const f = fixture(); try {
      expect(run('git', ['worktree', 'add', '-b', 'other', f.target], f.cwd).status).toBe(0);
      const result = f.start();
      expect(result.status).toBe(1); expect(existsSync(f.target)).toBe(true);
      expect(run('git', ['branch', '--show-current'], f.target).stdout.trim()).toBe('other');
    } finally { f.cleanup(); }
  });
  test('a failed Git add rolls back only its empty exclusive claim', () => {
    const f = fixture(); try {
      const binary = join(f.parent, 'git-fail-add');
      writeFileSync(binary, '#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = add ]; then exit 42; fi\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
      const failed = f.start([], { REPO_HARNESS_GIT_BIN: binary });
      expect(failed.status).toBe(1); expect(existsSync(f.target)).toBe(false);
      expect(f.start().status).toBe(0);
    } finally { f.cleanup(); }
  }, 15000);
});
