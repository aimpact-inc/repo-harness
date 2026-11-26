import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { spawnSync } from "child_process";
import { recordPluginSelection } from "../helpers/install-ownership";
import { writeShellExecutableFixture } from "../helpers/repo-fixture";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts/ensure-codegraph.sh");

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

  test.skipIf(process.platform === "win32")(
    "win32 resolver emulation: read-only probe skips checkout-local codegraph.exe and resolves installed CodeGraph outside the checkout",
    () => {
      const envRoot = setupFakeEnvironment("ensure-codegraph-win-boundary");
      const checkout = join(envRoot.root, "untrusted-checkout");
      const checkoutBin = join(checkout, "node_modules", ".bin");
      const globalBin = join(envRoot.root, "global-bin");
      const sentinel = join(envRoot.root, "checkout-codegraph-ran");
      const globalLog = join(envRoot.root, "global.log");
      const preload = join(envRoot.root, "win32-platform.cjs");
      try {
        mkdirSync(join(checkout, ".git"), { recursive: true });
        mkdirSync(checkoutBin, { recursive: true });
        mkdirSync(globalBin, { recursive: true });
        for (const utility of ["dirname", "basename", "node", "bun", "git", "bash", "sh", "which", "uname", "cat"]) {
          const actual = Bun.which(utility);
          if (actual) symlinkSync(actual, join(envRoot.fakeBin, utility));
        }
        writeExecutable(envRoot.root, join(checkoutBin, "codegraph.exe"), [
          "#!/bin/bash",
          `echo "executed $*" > "${sentinel}"`,
          "exit 99",
          "",
        ].join("\n"));
        writeExecutable(envRoot.root, join(globalBin, "codegraph.exe"), [
          "#!/bin/bash",
          "set -euo pipefail",
          `echo "codegraph $*" >> "${globalLog}"`,
          'case "${1:-}" in',
          "  \"--version\") echo '0.9.6' ;;",
          "  \"status\") echo 'CodeGraph Status'; echo 'Index is up to date' ;;",
          "  *) exit 1 ;;",
          "esac",
          "",
        ].join("\n"));
        writeFakeBunx(envRoot.fakeBin);
        writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });\n");

        const baseEnv: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: envRoot.home,
          PATHEXT: ".exe;.cmd",
          PATH: [checkoutBin, globalBin, envRoot.fakeBin].join(delimiter),
          NODE_OPTIONS: `--require=${preload}`,
        };
        delete baseEnv.REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL;
        delete baseEnv.REPO_HARNESS_CODEGRAPH_LOCAL_BIN;
        delete baseEnv.REPO_HARNESS_CODEGRAPH_GLOBAL_BIN;

        const withGlobal = spawnSync("bash", [SCRIPT, "--check", "--json", "--repo", checkout], {
          cwd: checkout,
          encoding: "utf-8",
          env: baseEnv,
        });
        expect(withGlobal.status, withGlobal.stderr).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
        const parsedGlobal = JSON.parse(withGlobal.stdout).codegraph;
        expect(parsedGlobal.source).toBe("global");
        expect(parsedGlobal.local_bin_path).toBeNull();
        expect(parsedGlobal.bin_path).toBe(join(globalBin, "codegraph.exe"));
        expect(parsedGlobal.version).toBe("0.9.6");

        rmSync(join(globalBin, "codegraph.exe"));
        const withoutGlobal = spawnSync("bash", [SCRIPT, "--check", "--json", "--repo", checkout], {
          cwd: checkout,
          encoding: "utf-8",
          env: baseEnv,
        });
        expect(withoutGlobal.status, withoutGlobal.stderr).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
        const parsedMissing = JSON.parse(withoutGlobal.stdout).codegraph;
        expect(parsedMissing.source).toBe("missing");
        expect(parsedMissing.local_bin_path).toBeNull();
        expect(parsedMissing.bin_path).toBeNull();
      } finally {
        rmSync(envRoot.root, { recursive: true, force: true });
      }
    },
    15000,
  );

  test.skipIf(process.platform === "win32")(
    "win32 resolver emulation: explicit ensure --init and --sync use checkout-local codegraph.exe without global CodeGraph",
    () => {
      const envRoot = setupFakeEnvironment("ensure-codegraph-win-explicit");
      const checkout = join(envRoot.root, "pinned-checkout");
      const checkoutBin = join(checkout, "node_modules", ".bin");
      const localLog = join(envRoot.root, "local.log");
      const preload = join(envRoot.root, "win32-platform.cjs");
      try {
        mkdirSync(join(checkout, ".git"), { recursive: true });
        mkdirSync(checkoutBin, { recursive: true });
        for (const utility of ["dirname", "basename", "node", "bun", "git", "bash", "sh", "which", "uname", "cat", "mkdir", "touch"]) {
          const actual = Bun.which(utility);
          if (actual) symlinkSync(actual, join(envRoot.fakeBin, utility));
        }
        writeExecutable(envRoot.root, join(checkoutBin, "codegraph.exe"), [
          "#!/bin/bash",
          "set -euo pipefail",
          `echo "codegraph $*" >> "${localLog}"`,
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
        writeFakeBunx(envRoot.fakeBin);
        writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });\n");

        const baseEnv: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: envRoot.home,
          PATHEXT: ".exe;.cmd",
          PATH: envRoot.fakeBin,
          NODE_OPTIONS: `--require=${preload}`,
        };
        delete baseEnv.REPO_HARNESS_CODEGRAPH_ALLOW_REPO_LOCAL;
        delete baseEnv.REPO_HARNESS_CODEGRAPH_LOCAL_BIN;
        delete baseEnv.REPO_HARNESS_CODEGRAPH_GLOBAL_BIN;

        const initRes = spawnSync("bash", [SCRIPT, "--init", "--no-install-deps", "--json", "--repo", checkout], {
          cwd: checkout,
          encoding: "utf-8",
          env: baseEnv,
        });
        expect(initRes.status, initRes.stderr).toBe(0);
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
