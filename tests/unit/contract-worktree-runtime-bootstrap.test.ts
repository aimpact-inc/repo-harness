import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { pluginSelectionEnv } from "../helpers/install-ownership";

// Keep the shell wiring and existing-index checks here. The real start cases
// in tests/contract-worktree.test.ts exercise CodeGraph and plugin selection.

const ROOT = join(import.meta.dir, "..", "..");
const SELECTED_HOME = pluginSelectionEnv().HOME;
const COPIES = [
  "scripts/contract-worktree.sh",
] as const;

function sourceOf(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf-8");
}

/** Evaluate the bootstrap function alone, so the surrounding script's start-up
 *  side effects stay out of the way. */
function runBootstrap(
  scriptPath: string,
  worktreePath: string,
  repoRoot: string,
): { status: number | null; stdout: string; stderr: string } {
  const extract = `. "$3/scripts/lib/architecture-plugin.sh"; helper_dir="$3/scripts"; BUN_BIN=""; eval "$(sed -n '/^bootstrap_worktree_runtime() {/,/^}/p' "$1")"`;
  const env: NodeJS.ProcessEnv = { ...process.env, REPO_ROOT: repoRoot, HOME: SELECTED_HOME };
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail; ${extract}; bootstrap_worktree_runtime "$2"`, "bash", join(ROOT, scriptPath), worktreePath, ROOT],
    { env, encoding: "utf-8" },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function tempDirs(): { worktree: string; repoRoot: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "worktree-bootstrap-"));
  const worktree = join(base, "worktree");
  const repoRoot = join(base, "primary");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  return { worktree, repoRoot, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("contract-worktree runtime bootstrap: wiring", () => {
  test("the helper defines the bootstrap and calls it from start", () => {
    for (const relative of COPIES) {
      const body = sourceOf(relative);
      expect(body).toContain("bootstrap_worktree_runtime() {");
      // The call must land inside start_worktree and before metadata is written,
      // so a worktree is usable by the time any downstream helper runs in it.
      const start = body.indexOf("start_worktree() {");
      const call = body.indexOf('bootstrap_worktree_runtime "$worktree_path"', start);
      const metadata = body.indexOf('write_start_metadata "$slug"', start);
      expect(start).toBeGreaterThan(-1);
      expect(call).toBeGreaterThan(start);
      expect(metadata).toBeGreaterThan(call);
    }
  });

  test("dependency install failure names the verification limit", () => {
    expect(sourceOf(COPIES[0])).toContain("no verification gate can run in this worktree");
  });

  test("the extracted bootstrap has no dependency on the surrounding start helper", () => {
    const body = sourceOf(COPIES[0]);
    const bootstrap = body.match(/^bootstrap_worktree_runtime\(\) \{[\s\S]*?^}/m)?.[0] ?? "";
    expect(bootstrap).not.toContain("start_notice");
    expect(bootstrap).toContain("contract_worktree_start_json");
  });
});

describe("contract-worktree runtime bootstrap: behavior", () => {
  test("a worktree with no manifest and no adopted tooling is left alone", () => {
    const { worktree, repoRoot, cleanup } = tempDirs();
    try {
      const result = runBootstrap(COPIES[0], worktree, repoRoot);
      expect(result.status).toBe(0);
      expect(existsSync(join(worktree, "node_modules"))).toBe(false);
      expect(existsSync(join(worktree, ".codegraph"))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("an existing index is preserved when a worktree is reused", () => {
    const { worktree, repoRoot, cleanup } = tempDirs();
    try {
      mkdirSync(join(repoRoot, ".codegraph"), { recursive: true });
      mkdirSync(join(worktree, ".codegraph"), { recursive: true });
      writeFileSync(join(worktree, ".codegraph", "codegraph.db"), "existing");
      const result = runBootstrap(COPIES[0], worktree, repoRoot);
      expect(result.status).toBe(0);
      expect(readFileSync(join(worktree, ".codegraph", "codegraph.db"), "utf-8")).toBe("existing");
    } finally {
      cleanup();
    }
  });
});
