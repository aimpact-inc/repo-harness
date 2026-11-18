import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const MIN_BUN_VERSION = "1.4.0";

function read(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

describe("install script contracts", () => {
  test("macOS/Linux installer is syntax-valid and Bun-owned", () => {
    const script = read("install.sh");
    const syntax = spawnSync("bash", ["-n", "install.sh"], {
      cwd: ROOT,
      encoding: "utf-8",
    });

    expect(syntax.status).toBe(0);
    expect(script).toContain("REPO_HARNESS_VERSION");
    expect(script).toContain("https://bun.sh/install");
    expect(script).toContain(`MIN_BUN_VERSION="${MIN_BUN_VERSION}"`);
    expect(script).toContain('bun_version_at_least "$current_bun_version"');
    expect(script).toContain("bun add -g \"$package_spec\"");
    expect(script).toContain("rh --version");
    expect(script).not.toMatch(/\bnpm\b/);
    expect(script).not.toMatch(/\bnpx\b/);
    expect(script).not.toMatch(/\bnode\b/);
  }, 30_000);

  test("Windows installer is Bun-owned and version-pinnable", () => {
    const script = read("install.ps1");

    expect(script).toContain("REPO_HARNESS_VERSION");
    expect(script).toContain("https://bun.sh/install.ps1");
    expect(script).toContain(`$MinimumBunVersion = [Version]"${MIN_BUN_VERSION}"`);
    expect(script).toContain('$BunVersion -lt $MinimumBunVersion');
    expect(script).toContain("& bun add -g $PackageSpec");
    expect(script).toContain("rh --version");
    expect(script).not.toMatch(/\bnpm\b/i);
    expect(script).not.toMatch(/\bnpx\b/i);
    expect(script).not.toMatch(/\bnode\b/i);
  });

  // Scope: the shell-installer surface only. The bunx / bun add -g / npx command
  // pins live in tests/readme-dx.test.ts against the First 5 Minutes section;
  // repeating them here at whole-README scope added no coverage.
  test("README documents the no-Node installer and its Bun version floor", () => {
    const readme = read("README.md");
    const zhReadme = read("README.zh-CN.md");
    const pkg = JSON.parse(read("package.json"));

    expect(readme).toContain("curl -fsSL https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.sh | sh");
    expect(readme).toContain("irm https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.ps1 | iex");
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN_VERSION}`);
    expect(readme).toContain(MIN_BUN_VERSION);
    expect(readme).not.toContain("npm install -g repo-harness");
    expect(zhReadme).toContain("curl -fsSL https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.sh | sh");
    expect(zhReadme).toContain("irm https://raw.githubusercontent.com/aimpact-inc/repo-harness/main/install.ps1 | iex");
    expect(zhReadme).toContain("bunx -p repo-harness@latest rh install");
    expect(zhReadme).toContain("npx -y -p repo-harness@latest rh install");
    expect(pkg.files).toContain("install.sh");
    expect(pkg.files).toContain("install.ps1");
  });
});

// install.sh with a fake curl that serves a fake Bun installer: it logs its arguments, installs a bun that reports `version`
// (other calls go to the real Bun, so the record writer runs), adds rh, and appends two lines to an existing ~/.zshrc.
describe("install.sh Bun bootstrap record", () => {
  test.each([
    { label: "a fresh Bun at the measured version gets a 0600 record", bun: "absent", version: "1.4.4" },
    { label: "a Bun that was there gets no record and no installer run", bun: "present", version: "1.4.4" },
    { label: "another installer version stops with a named error and no record", bun: "absent", version: "1.5.0" },
  ] as const)("%s", ({ bun, version }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "install-sh-bun-")));
    const home = join(root, "home"), fakeBin = join(root, "bin"), log = join(root, "installer.log");
    const bunInstall = join(home, ".bun");
    const fakeBun = `#!/bin/sh\ncase "$1" in --version) echo ${version} ;; add) ;; *) exec "${process.execPath}" "$@" ;; esac\n`;
    const rh = "#!/bin/sh\necho 9.9.9\n";
    try {
      mkdirSync(home); mkdirSync(fakeBin);
      writeFileSync(join(home, ".zshrc"), "export EDITOR=vi\n");
      const installer = `printf '%s\\n' "$*" > "${log}"\nmkdir -p "${bunInstall}/bin"\ncat > "${bunInstall}/bin/bun" <<'BUN'\n${fakeBun}BUN\n`
        + `cat > "${bunInstall}/bin/rh" <<'RH'\n${rh}RH\nchmod +x "${bunInstall}/bin/bun" "${bunInstall}/bin/rh"\n`
        + `printf '\\n# bun\\nexport BUN_INSTALL="$HOME/.bun"\\n' >> "$HOME/.zshrc"\n`;
      writeFileSync(join(root, "installer.sh"), installer);
      writeFileSync(join(fakeBin, "curl"), `#!/bin/sh\ncat "${join(root, "installer.sh")}"\n`, { mode: 0o755 });
      if (bun === "present") { mkdirSync(join(bunInstall, "bin"), { recursive: true }); writeFileSync(join(bunInstall, "bin", "bun"), fakeBun, { mode: 0o755 }); writeFileSync(join(bunInstall, "bin", "rh"), rh, { mode: 0o755 }); }
      const result = spawnSync("sh", [join(ROOT, "install.sh")], { encoding: "utf-8", env: { HOME: home, PATH: `${bun === "present" ? `${bunInstall}/bin:` : ""}${fakeBin}:/usr/bin:/bin` } });
      const record = join(home, ".repo-harness", "bootstrap", "bun.json");
      if (version !== "1.4.4") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("bun_bootstrap_version_mismatch: the Bun installer gave 1.5.0, and only 1.4.4 was measured; no bootstrap record written");
        expect(existsSync(record)).toBe(false);
        return;
      }
      expect(result.status, result.stderr).toBe(0);
      if (bun === "present") { expect([existsSync(log), existsSync(record)]).toEqual([false, false]); return; }
      expect(readFileSync(log, "utf8")).toBe("bun-v1.4.4\n");
      expect(statSync(record).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ installed_by: "rh-bootstrap", version: "1.4.4", path: join(bunInstall, "bin", "bun"),
        sha256: `sha256:${createHash("sha256").update(readFileSync(join(bunInstall, "bin", "bun"))).digest("hex")}`, directories: [bunInstall],
        profile: { file: join(home, ".zshrc"), inserted: '\n# bun\nexport BUN_INSTALL="$HOME/.bun"\n' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
