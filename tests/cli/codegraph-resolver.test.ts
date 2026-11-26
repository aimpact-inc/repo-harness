import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { spawnSync } from "child_process";
import { recordPluginSelection } from "../helpers/install-ownership";
import { writeShellExecutableFixture } from "../helpers/repo-fixture";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts/ensure-codegraph.sh");
const CHECKER_SCRIPT = join(ROOT, "scripts/check-agent-tooling.sh");

function writeExecutable(temporaryRoot: string, filePath: string, content: string) {
  writeShellExecutableFixture(temporaryRoot, filePath, content);
}

function setupFakeEnvironment(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const home = join(root, "home");
  const fakeBin = join(root, "fakebin");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  recordPluginSelection({ HOME: home });
  writeExecutable(root,
    join(fakeBin, "timeout"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      "if [[ \"${1:-}\" == --kill-after=* ]]; then shift; fi",
      "if [[ \"${1:-}\" == *s ]]; then shift; fi",
      "exec \"$@\"",
      "",
    ].join("\n")
  );
  return { root, home, fakeBin };
}

function writeFakeCodeGraph(fakeBin: string, logFile: string) {
  writeExecutable(fakeBin,
    join(fakeBin, "codegraph"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      `echo "codegraph $*" >> "${logFile}"`,
      "case \"${1:-}\" in",
      "  \"--version\") echo '0.9.6' ;;",
      "  \"status\") echo 'CodeGraph Status'; echo 'Index is up to date' ;;",
      "  \"init\"|\"sync\"|\"install\") echo 'unexpected mutation' >&2; exit 2 ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n")
  );
}

function writeFakeBunx(fakeBin: string) {
  writeExecutable(fakeBin,
    join(fakeBin, "bunx"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      "if [[ \"$*\" == *\"skills ls -g --json\"* ]]; then echo '[]'; exit 0; fi",
      "exit 1",
      "",
    ].join("\n")
  );
}

describe("ensure-codegraph", () => {
  test("--check is read-only and reuses check-agent-tooling readiness", () => {
    const envRoot = setupFakeEnvironment("ensure-codegraph");
    const logFile = join(envRoot.root, "tool.log");
    try {
      mkdirSync(join(envRoot.home, ".codex"), { recursive: true });
      writeFileSync(join(envRoot.home, ".codex", "config.toml"), "[mcp_servers.codegraph]\ncommand = \"codegraph\"\n");
      writeFakeCodeGraph(envRoot.fakeBin, logFile);
      writeFakeBunx(envRoot.fakeBin);

      const res = spawnSync("bash", [SCRIPT, "--check", "--json", "--repo", ROOT], {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: envRoot.home,
          PATH: `${envRoot.fakeBin}:${process.env.PATH ?? ""}`,
          REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: "0",
        },
      });

      expect(res.status).toBe(0);
      const result = JSON.parse(res.stdout);
      expect(result.read_only).toBe(true);
      expect(result.changed).toBe(false);
      expect(result.codegraph.source).toBe("global");
      expect(result.codegraph.status).toBe("partial");

      expect(result.codegraph.probes).toHaveLength(2);
      for (const probe of result.codegraph.probes) {
        expect(probe.status).toBe(0);
        expect(probe.signal).toBeNull();
        expect(probe.error_code).toBeNull();
        expect(probe.error).toBe("");
        expect(probe.timed_out).toBe(false);
      }
      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("codegraph --version");
      expect(log).toContain("codegraph status .");
      expect(log).not.toContain("codegraph init");
      expect(log).not.toContain("codegraph sync");
      expect(log).not.toContain("codegraph install");
    } finally {
      rmSync(envRoot.root, { recursive: true, force: true });
    }
  }, 15000);

  for (const failure of ["EAGAIN", "ETIMEDOUT", "SIGTERM", "exit"] as const) {
    test(`--check exposes CodeGraph probe ${failure} without synthesizing execution`, () => {
      const envRoot = setupFakeEnvironment("ensure-codegraph-probe");
      try {
        writeFakeCodeGraph(envRoot.fakeBin, join(envRoot.root, "tool.log"));
        writeFakeBunx(envRoot.fakeBin);
        const preload = join(envRoot.root, "probe.cjs");
        writeFileSync(preload, `
          const cp = require('child_process');
          const original = cp.spawnSync;
          cp.spawnSync = function(command, args, options) {
            if (![command, ...(args || [])].some(value => /(?:^|\\/)codegraph$/.test(String(value)))) return original.apply(this, arguments);
            return {status: ${failure === "exit" ? "7" : "null"}, signal: ${JSON.stringify(failure === "SIGTERM" || failure === "ETIMEDOUT" ? "SIGTERM" : null)}, stdout: '', stderr: '',
              error: ${failure === "EAGAIN" || failure === "ETIMEDOUT" ? `Object.assign(new Error('probe ${failure}'), {code: '${failure}'})` : "undefined"}};
          };
        `);
        const res = spawnSync("bash", [SCRIPT, "--check", "--json", "--repo", ROOT], {
          cwd: ROOT, encoding: "utf-8",
          env: { ...process.env, HOME: envRoot.home, PATH: `${envRoot.fakeBin}:${process.env.PATH ?? ""}`,
            NODE_OPTIONS: `--require=${preload}`, REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL: "0" },
        });
        expect(res.status).toBe(0);
        const probes = JSON.parse(res.stdout).codegraph.probes;
        expect(probes).toHaveLength(failure === "ETIMEDOUT" ? 3 : 2);
        expect(probes[0].args).toEqual(["--version"]);
        expect(probes.at(-1).args).toEqual(["status", "."]);
        for (const probe of probes) {
          expect(probe.bin_path).toBe(join(envRoot.fakeBin, "codegraph"));
          expect(probe.status).toBe(failure === "exit" ? 7 : null);
          expect(probe.signal).toBe(failure === "SIGTERM" || failure === "ETIMEDOUT" ? "SIGTERM" : null);
          expect(probe.error_code).toBe(failure === "EAGAIN" || failure === "ETIMEDOUT" ? failure : null);
          expect(probe.error).toBe(failure === "EAGAIN" || failure === "ETIMEDOUT" ? `probe ${failure}` : "");
          expect(probe.timed_out).toBe(failure === "ETIMEDOUT");
        }
      } finally { rmSync(envRoot.root, { recursive: true, force: true }); }
    }, 15000);
  }

  function setupWin32Emulation(prefix: string, extraUtilities: readonly string[] = []) {
    const envRoot = setupFakeEnvironment(prefix);
    const preload = join(envRoot.root, "win32-platform.cjs");
    for (const utility of ["dirname", "basename", "node", "bun", "git", "bash", "sh", "which", "uname", "cat", ...extraUtilities]) {
      const actual = Bun.which(utility);
      if (actual) symlinkSync(actual, join(envRoot.fakeBin, utility));
    }
    writeFakeBunx(envRoot.fakeBin);
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });\n");
    return { ...envRoot, preload };
  }

  function makeWin32EmulationEnv(home: string, preload: string, pathEntries: readonly string[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PATHEXT: ".exe;.cmd",
      PATH: pathEntries.join(delimiter),
      NODE_OPTIONS: `--require=${preload}`,
    };
    delete env.REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL;
    delete env.REPO_HARNESS_CODEGRAPH_LOCAL_BIN;
    delete env.REPO_HARNESS_CODEGRAPH_GLOBAL_BIN;
    return env;
  }

  function writeSentinelLauncher(tempRoot: string, filePath: string, sentinelPath: string) {
    writeExecutable(tempRoot, filePath, [
      "#!/bin/bash",
      `echo "executed $0 $*" >> "${sentinelPath}"`,
      "exit 99",
      "",
    ].join("\n"));
  }

  function writeFakeWinCodegraph(tempRoot: string, filePath: string, logPath: string) {
    writeExecutable(tempRoot, filePath, [
      "#!/bin/bash",
      "set -euo pipefail",
      `echo "codegraph $*" >> "${logPath}"`,
      'case "${1:-}" in',
      "  \"--version\") echo '0.9.6' ;;",
      "  \"status\")",
      "    if [[ -f .codegraph/initialized ]]; then",
      "      echo 'CodeGraph Status'; echo 'Index is up to date'",
      "    else",
      "      echo 'Not initialized'",
      "    fi ;;",
      "  \"init\") mkdir -p .codegraph && touch .codegraph/initialized ;;",
      "  \"sync\") mkdir -p .codegraph && touch .codegraph/synced ;;",
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"));
  }

  test.skipIf(process.platform === "win32")(
    "win32 resolver emulation: read-only probe refuses checkout-local launchers and overrides without fallback",
    () => {
      const envRoot = setupWin32Emulation("ensure-codegraph-win-inside");
      const checkout = join(envRoot.root, "untrusted-checkout");
      const checkoutBin = join(checkout, "node_modules", ".bin");
      const globalBin = join(envRoot.root, "global-bin");
      const outsideLinkDir = join(envRoot.root, "outside-link");
      const sentinel = join(envRoot.root, "checkout-launcher-ran");
      const globalLog = join(envRoot.root, "global.log");
      try {
        mkdirSync(join(checkout, ".git"), { recursive: true });
        mkdirSync(checkoutBin, { recursive: true });
        mkdirSync(globalBin, { recursive: true });
        mkdirSync(outsideLinkDir, { recursive: true });
        for (const name of ["codegraph.exe", "archctx.exe", "bun.exe", "skills.exe", "hc.exe"]) {
          writeSentinelLauncher(envRoot.root, join(checkoutBin, name), sentinel);
        }
        writeFakeWinCodegraph(envRoot.root, join(globalBin, "codegraph.exe"), globalLog);
        symlinkSync(join(checkoutBin, "codegraph.exe"), join(outsideLinkDir, "cg-link.exe"));

        // Read-only full checker with checkout launchers first on PATH and no global codegraph.
        const probeRes = spawnSync(
          "bash",
          [CHECKER_SCRIPT, "--json", "--architecture-selected", "--probe-skills-cli"],
          {
            cwd: checkout,
            encoding: "utf-8",
            env: makeWin32EmulationEnv(envRoot.home, envRoot.preload, [checkoutBin, envRoot.fakeBin]),
          },
        );
        expect(probeRes.status, probeRes.stderr).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
        const report = JSON.parse(probeRes.stdout);
        expect(report.tools.codegraph.source).toBe("missing");
        expect(report.tools.codegraph.bin_path).toBeNull();
        expect(report.tools.archctx.path_copy).toBeNull();
        expect(report.tools.archctx.managed.status).toBe("present");
        expect(report.runtime_capabilities.skills_cli.path).toBeNull();
        expect(report.runtime_capabilities.herdr_core.path).toBeNull();

        // Checkout-pointing env overrides (extensionless and symlinked realpath) fail closed with no global fallback.
        const envWithGlobal = makeWin32EmulationEnv(envRoot.home, envRoot.preload, [globalBin, envRoot.fakeBin]);
        for (const [envVar, overrideValue] of [
          ["REPO_HARNESS_CODEGRAPH_LOCAL_BIN", join(checkoutBin, "codegraph")],
          ["REPO_HARNESS_CODEGRAPH_GLOBAL_BIN", join(checkoutBin, "codegraph")],
          ["REPO_HARNESS_CODEGRAPH_LOCAL_BIN", join(outsideLinkDir, "cg-link")],
        ] as const) {
          const overrideRes = spawnSync("bash", [SCRIPT, "--check", "--json", "--repo", checkout], {
            cwd: checkout,
            encoding: "utf-8",
            env: { ...envWithGlobal, [envVar]: overrideValue },
          });
          expect(overrideRes.status).not.toBe(0);
          expect(overrideRes.stderr).toContain("refused");
          expect(overrideRes.stderr).toContain(envVar);
          expect(existsSync(sentinel)).toBe(false);
        }
        expect(existsSync(globalLog)).toBe(false);
      } finally {
        rmSync(envRoot.root, { recursive: true, force: true });
      }
    },
    20000,
  );

  test.skipIf(process.platform === "win32")(
    "win32 resolver emulation: nested ..tools directory inside enclosing Git checkout stays inside and is refused",
    () => {
      const envRoot = setupWin32Emulation("ensure-codegraph-win-dotdot-tools");
      const enclosingRepo = join(envRoot.root, "enclosing-repo");
      const nestedProject = join(enclosingRepo, "..tools");
      const nestedBin = join(nestedProject, "node_modules", ".bin");
      const sentinel = join(envRoot.root, "dotdot-tools-ran");
      try {
        mkdirSync(join(enclosingRepo, ".git"), { recursive: true });
        mkdirSync(nestedBin, { recursive: true });
        writeSentinelLauncher(envRoot.root, join(nestedBin, "codegraph.exe"), sentinel);
        writeSentinelLauncher(envRoot.root, join(nestedBin, "archctx.exe"), sentinel);

        const res = spawnSync("bash", [SCRIPT, "--check", "--json", "--repo", nestedProject], {
          cwd: nestedProject,
          encoding: "utf-8",
          env: makeWin32EmulationEnv(envRoot.home, envRoot.preload, [nestedBin, envRoot.fakeBin]),
        });
        expect(res.status, res.stderr).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
        const parsed = JSON.parse(res.stdout).codegraph;
        expect(parsed.source).toBe("missing");
        expect(parsed.local_bin_path).toBeNull();
        expect(parsed.bin_path).toBeNull();
      } finally {
        rmSync(envRoot.root, { recursive: true, force: true });
      }
    },
    15000,
  );

  test.skipIf(process.platform === "win32")(
    "win32 resolver emulation: exact .. parent and ..-separator sibling outside checkout are allowed",
    () => {
      const envRoot = setupWin32Emulation("ensure-codegraph-win-outside");
      const checkout = join(envRoot.root, "untrusted-checkout");
      const checkoutBin = join(checkout, "node_modules", ".bin");
      const siblingBin = join(envRoot.root, "global-bin");
      const sentinel = join(envRoot.root, "checkout-ran");
      const parentLog = join(envRoot.root, "parent.log");
      const siblingLog = join(envRoot.root, "sibling.log");
      try {
        mkdirSync(join(checkout, ".git"), { recursive: true });
        mkdirSync(checkoutBin, { recursive: true });
        mkdirSync(siblingBin, { recursive: true });
        writeSentinelLauncher(envRoot.root, join(checkoutBin, "codegraph.exe"), sentinel);
        writeFakeWinCodegraph(envRoot.root, join(envRoot.root, "codegraph.exe"), parentLog);
        writeFakeWinCodegraph(envRoot.root, join(siblingBin, "codegraph.exe"), siblingLog);

        const env = makeWin32EmulationEnv(envRoot.home, envRoot.preload, [checkoutBin, envRoot.root, siblingBin, envRoot.fakeBin]);

        // Relative path to envRoot.root from checkout is exact "..", and to the file is "../codegraph.exe".
        const parentRes = spawnSync("bash", [SCRIPT, "--check", "--json", "--repo", checkout], {
          cwd: checkout,
          encoding: "utf-8",
          env,
        });
        expect(parentRes.status, parentRes.stderr).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
        const parsedParent = JSON.parse(parentRes.stdout).codegraph;
        expect(parsedParent.source).toBe("global");
        expect(parsedParent.local_bin_path).toBeNull();
        expect(parsedParent.bin_path).toBe(join(envRoot.root, "codegraph.exe"));
        expect(parsedParent.version).toBe("0.9.6");

        // Removing the parent binary falls through to sibling "../global-bin/codegraph.exe".
        rmSync(join(envRoot.root, "codegraph.exe"));
        const siblingRes = spawnSync("bash", [SCRIPT, "--check", "--json", "--repo", checkout], {
          cwd: checkout,
          encoding: "utf-8",
          env,
        });
        expect(siblingRes.status, siblingRes.stderr).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
        const parsedSibling = JSON.parse(siblingRes.stdout).codegraph;
        expect(parsedSibling.source).toBe("global");
        expect(parsedSibling.local_bin_path).toBeNull();
        expect(parsedSibling.bin_path).toBe(join(siblingBin, "codegraph.exe"));
        expect(parsedSibling.version).toBe("0.9.6");
      } finally {
        rmSync(envRoot.root, { recursive: true, force: true });
      }
    },
    15000,
  );

  test.skipIf(process.platform === "win32")(
    "win32 resolver emulation: explicit ensure --init and --sync use checkout-local codegraph.exe while keeping other checkout launchers excluded",
    () => {
      const envRoot = setupWin32Emulation("ensure-codegraph-win-explicit", ["mkdir", "touch"]);
      const checkout = join(envRoot.root, "pinned-checkout");
      const checkoutBin = join(checkout, "node_modules", ".bin");
      const localLog = join(envRoot.root, "local.log");
      const otherSentinel = join(envRoot.root, "other-launcher-ran");
      try {
        mkdirSync(join(checkout, ".git"), { recursive: true });
        mkdirSync(checkoutBin, { recursive: true });
        writeFakeWinCodegraph(envRoot.root, join(checkoutBin, "codegraph.exe"), localLog);
        writeSentinelLauncher(envRoot.root, join(checkoutBin, "archctx.exe"), otherSentinel);
        writeSentinelLauncher(envRoot.root, join(checkoutBin, "bun.exe"), otherSentinel);

        const baseEnv = makeWin32EmulationEnv(envRoot.home, envRoot.preload, [checkoutBin, envRoot.fakeBin]);

        const initRes = spawnSync("bash", [SCRIPT, "--init", "--no-install-deps", "--json", "--repo", checkout], {
          cwd: checkout,
          encoding: "utf-8",
          env: baseEnv,
        });
        expect(initRes.status, initRes.stderr).toBe(0);
        expect(existsSync(otherSentinel)).toBe(false);
        const parsedInit = JSON.parse(initRes.stdout);
        expect(parsedInit.read_only).toBe(false);
        expect(parsedInit.changed).toBe(true);
        expect(parsedInit.codegraph.source).toBe("local");
        expect(parsedInit.codegraph.local_bin_path).toBe(join(checkoutBin, "codegraph.exe"));
        expect(parsedInit.codegraph.bin_path).toBe(join(checkoutBin, "codegraph.exe"));
        expect(parsedInit.actions).toContainEqual(expect.objectContaining({ action: "init-index", status: "changed" }));

        const syncRes = spawnSync("bash", [SCRIPT, "--sync", "--no-install-deps", "--json", "--repo", checkout], {
          cwd: checkout,
          encoding: "utf-8",
          env: baseEnv,
        });
        expect(syncRes.status, syncRes.stderr).toBe(0);
        expect(existsSync(otherSentinel)).toBe(false);
        const parsedSync = JSON.parse(syncRes.stdout);
        expect(parsedSync.read_only).toBe(false);
        expect(parsedSync.changed).toBe(true);
        expect(parsedSync.codegraph.source).toBe("local");
        expect(parsedSync.codegraph.local_bin_path).toBe(join(checkoutBin, "codegraph.exe"));
        expect(parsedSync.actions).toContainEqual(expect.objectContaining({ action: "sync-index", status: "changed" }));

        const log = readFileSync(localLog, "utf-8");
        expect(log).toContain("codegraph init -i .");
        expect(log).toContain("codegraph sync .");
      } finally {
        rmSync(envRoot.root, { recursive: true, force: true });
      }
    },
    15000,
  );

});
