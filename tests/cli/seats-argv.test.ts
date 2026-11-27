import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, delimiter, dirname, join } from "path";
import { AGY_READONLY_COMMAND_PREFIXES, AGY_SEAT_AGENT_DIR_PATTERN, AGY_WORKER_COMMAND_PREFIXES, agySeatCommandRules, agySeatLimits, buildSeatLaunch } from "../../src/core/board/seat-launch";
import { seatPaneName, seatTabName } from "../../src/core/board/seat-pane-name";
import { agySeatAgentSpec } from "../../src/effects/board/seats-configuration";
import { HANDOFF_SECTIONS, seatHandoffPath, seatResetReason, seatResetRelaunchPath, seatResetRequestPath, seatResetSteps } from "../../src/core/board/seat-reset";
import { EDIT_GUARD_SCOPE_SECTION } from "../../src/cli/hook/session-context";
import { SeatResetError, readSeatSession, recordSeatSession, runSeatReset, type SeatRelaunch, type SeatResetNotify, type SeatResetOptions } from "../../src/effects/board/seat-reset";
import { seatHandoff, seatResetLaunch, seatResetTarget } from "../../src/cli/commands/seats";
import { AGY_ADVISOR_ALLOWED_SEAT_TOOLS, AGY_ADVISOR_SEAT_TOOLS, DEFAULT_SEATS_CONFIG, LAUNCH_SEAT_IDS, NATIVE_SEATS_PRESET, WORKER_SEAT_IDS, isCouncilSeat, isReviewSeat, isWorkerSeat } from "../../src/core/board/seats-settings";
import { repoHarnessRepoIdFor } from "../../src/effects/repo-registry";
import { classifyQuotaReading, decodeCodexRateLimitsResult } from "../../src/core/board/quota";
import { effectiveSeatConfig, formatSeatRoutes, seatAccountQuotas } from "../../src/core/board/seat-routing";
import { assertPiShell } from "../../src/effects/board/pi-shell";
import { readClaudeQuota } from "../../src/effects/board/quota";
import { buildAntigravityHooks } from "../../src/cli/installer/managed-entries";
import { runUserUninstall } from "../../src/cli/installer/uninstall";
import { observeEntryIdentity } from "../../src/effects/host-config/whole-path";
import { seedGlobalPackageFixture } from "../helpers/install-ownership";
import { agyCatalogScript, type AgyCatalogFixture } from "../helpers/agy-cli-fixture";

const CLI = join(import.meta.dir, "..", "..", "src/cli/index.ts");

/** A Pi seat launch probes its shell (#2370); a stub shell prints what the probe script prints on a good or a bash 3.2 shell. */
const GOOD_PROBE_OUTPUT = "RESULT[a smile :)\nthen a span `echo INJECTED-BY-BACKTICK`]";
const BAD_PROBE_OUTPUT = "RESULT[a smile :)\nthen a span INJECTED-BY-BACKTICK]";
function stubShell(home: string, name: string, output: string): string {
  const path = join(home, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(path, 0o755);
  return path;
}

/**
 * A HOME with an optional seats section, a nested user agent `nested-auditor`, and one enabled plugin
 * `demo` with a nameless agent (`demo:helper`) and a nested agent (`demo:review:security`).
 */
function withHome(seats: unknown, fn: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "seats-argv-"));
  try {
    if (seats !== undefined) {
      mkdirSync(join(home, ".repo-harness"));
      writeFileSync(join(home, ".repo-harness", "config.json"), JSON.stringify({ seats }));
    }
    const plugin = join(home, "plugin");
    mkdirSync(join(plugin, "agents", "review"), { recursive: true });
    mkdirSync(join(plugin, ".claude-plugin"));
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "demo" }));
    writeFileSync(join(plugin, "agents", "helper.md"), "Body without frontmatter\n");
    writeFileSync(join(plugin, "agents", "review", "security.md"), "---\nname: security\ndescription: Demo\n---\nBody\n");
    mkdirSync(join(home, ".claude", "agents", "review"), { recursive: true });
    writeFileSync(join(home, ".claude", "agents", "review", "audit.md"), "---\nname: nested-auditor\ndescription: Demo\n---\nBody\n");
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "demo@market": true } }));
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "demo@market": [{ scope: "user", installPath: plugin }] } }));
    mkdirSync(join(home, ".bun", "install", "global", "node_modules", "repo-harness", "src", "pi"), { recursive: true });
    writeFileSync(join(home, ".bun", "install", "global", "node_modules", "repo-harness", "src", "pi", "extension.ts"), "");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ shellPath: stubShell(home, "good-shell", GOOD_PROBE_OUTPUT) }));
    mkdirSync(join(home, '.quota-bin'));
    writeFileSync(join(home, 'codex-used'), '51');
    writeFileSync(join(home, 'codex-credits'), 'false');
    writeFileSync(join(home, '.quota-bin', 'codex'), `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
if (args === 'app-server --help') process.exit(0);
if (args === '--version') { console.log('99.0.0'); process.exit(0); }
if (args === 'login status') { console.error('Logged in using ChatGPT'); process.exit(0); }
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  if (message.method === 'model/list') console.log(JSON.stringify({ id: message.id, result: { data: [{ model: 'gpt-6.1-terra' }], nextCursor: null } }));
  if (message.method === 'config/read') console.log(JSON.stringify({ id: message.id, result: { config: { model: 'gpt-6.1-terra' } } }));
  if (message.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({ id: message.id, result: { rateLimits: {
    primary: { usedPercent: Number(require('node:fs').readFileSync(require('node:path').join(process.env.HOME, 'codex-used'), 'utf8')),
      windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 84 * 3600 },
    credits: { hasCredits: require('node:fs').readFileSync(require('node:path').join(process.env.HOME, 'codex-credits'), 'utf8').trim() === 'true',
      unlimited: false, balance: require('node:fs').readFileSync(require('node:path').join(process.env.HOME, 'codex-credits'), 'utf8').trim() === 'true' ? '34410.83' : '0' }
  } } }) + '\\n');
});
`);
    chmodSync(join(home, '.quota-bin', 'codex'), 0o755);
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function run(env: Record<string, string>, args: string[], cwd?: string) {
  const { CLAUDE_CONFIG_DIR: _inherited, PI_CODING_AGENT_DIR: _piDirectory, ...base } = process.env;
  const result = spawnSync(process.execPath, [CLI, "seats", "argv", ...args], { env: { ...base, ...env, BUN_INSTALL: join(env.HOME!, '.bun'), PATH: `${join(env.HOME!, '.quota-bin')}${delimiter}${env.PATH ?? base.PATH ?? ''}` }, encoding: "utf8", cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const argv = (home: string, ...args: string[]) => run({ HOME: home }, args);

const launch = (home: string, seat: string) => JSON.parse(argv(home, seat, "--json").stdout);
/** The values of `flag`, up to the next flag; empty when `flag` is absent. */
function values(args: string[], flag: string): string[] {
  const start = args.indexOf(flag);
  if (start === -1) return [];
  const end = args.findIndex((arg, index) => index > start && arg.startsWith("--"));
  return args.slice(start + 1, end);
}
const tools = (args: string[]) => values(args, "--tools");

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
};

/** The test preload sets REPO_HARNESS_HOME, so the registry of `home` is named explicitly. */
const registryEnv = (home: string) => ({ HOME: home, REPO_HARNESS_HOME: join(home, ".repo-harness") });

/** A primary checkout with one commit, a linked worktree of it, and its registry entry with `panePrefix` when given. */
function withRepository(home: string, panePrefix: string | undefined, fn: (repo: string, worktree: string) => void) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "seats-argv-repo-")));
  const worktree = `${repo}-wt`;
  try {
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", worktree);
    const at = "2026-11-03T00:00:00.000Z";
    const entry = { id: repoHarnessRepoIdFor(repo), path: repo, accessMode: "read_only", source: "manual", registeredAt: at, lastSeenAt: at };
    mkdirSync(join(home, ".repo-harness"), { recursive: true });
    writeFileSync(join(home, ".repo-harness", "registered-repos.json"),
      JSON.stringify({ version: 1, authorizationRevision: 0, repos: [panePrefix === undefined ? entry : { ...entry, panePrefix }] }));
    fn(repo, worktree);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}
const denied = (args: string[]) => values(args, "--disallowedTools");
const agent = (launch: { argv: string[] }) => launch.argv.slice(launch.argv.indexOf("env"));
/** Every seat argv first unsets the seat identity that it inherits and the Pi role directory (#1975, #1977); `bare` checks that prefix and drops it. */
const UNSET_SEAT = ["env", "-u", "REPO_HARNESS_SEAT", "-u", "REPO_HARNESS_SEAT_REPOSITORY", "-u", "REPO_HARNESS_SEAT_MODEL", "-u", "REPO_HARNESS_SEAT_EFFORT", "-u", "PI_SUBAGENT_EXTRA_AGENT_DIRS"];
function bare(args: string[]): unknown[] {
  expect(args.slice(0, UNSET_SEAT.length)).toEqual(UNSET_SEAT);
  return args.slice(UNSET_SEAT.length);
}

const AGY_ADVISOR = { runtime: "agy", model: "gemini-4-neon-high", advisor_model: null, effort: null, tools: AGY_ADVISOR_SEAT_TOOLS, fleet: [] } as const;
const AGY_ORCHESTRATOR = { ...AGY_ADVISOR, tools: ["gh", "mcp", "net", "read", "shell", "tasks"] } as const;
const AGY_WORKER = { runtime: "agy", model: "gemini-4-neon-high", advisor_model: null, effort: null, tools: ["edit", "gh", "net", "read", "shell"], fleet: [] } as const;
const AGY_WORKER_NO_GH = { ...NATIVE_SEATS_PRESET["worker-light"]!, effort: "high", tools: ["edit", "net", "read", "shell"] } as const;
const AGY_FALLBACK = { runtime: "agy", model: "gemini-4-hydrogen-high", advisor_model: null, effort: null, tools: ["net", "read", "shell"], fleet: [] } as const;
/** A stored council seat whose runtime is `pi` selects the Pi route of each member that has one (#3644). */
const PI_COUNCIL = { runtime: "pi", model: "magpie/agy-cli/gemini-4-carbon", advisor_model: null, effort: null, tools: ["net", "read", "shell"], fleet: [] } as const;

type AgyFixture = {
  home: string; cwd: string; agy: string; hooks: string; bundle: string; tab: string; env: NodeJS.ProcessEnv;
  run: (args: string[], extra?: Record<string, string>) => ReturnType<typeof run>;
  configure: (advisor?: unknown, enabled?: boolean, overrides?: Record<string, unknown>) => void;
  catalog: (models: AgyCatalogFixture, version?: string, quota?: { gemini: number; other: number }) => void;
};

function withAgySeat(callback: (fixture: AgyFixture) => void) {
  return () => withHome(undefined, home => withRepository(home, "rh", (_repo, cwd) => {
    const bin = join(home, "bin");
    const setup = { ...registryEnv(home), PATH: [bin, "/usr/bin", "/bin"].join(delimiter), BUN_INSTALL: join(home, ".bun"), TMPDIR: home };
    mkdirSync(bin);
    mkdirSync(join(cwd, ".ai", "harness"), { recursive: true });
    writeFileSync(join(cwd, ".ai", "harness", "workflow-contract.json"), "{}\n");
    const hooks = join(home, ".gemini", "config", "hooks.json");
    const bundle = join(seedGlobalPackageFixture(setup, { mutable: true }), "dist", "hook-entry.js");
    mkdirSync(dirname(hooks), { recursive: true });
    writeFileSync(hooks, JSON.stringify({ "repo-harness": buildAntigravityHooks(setup) }));
    const configure = (advisor: unknown = AGY_ADVISOR, enabled = true, overrides: Record<string, unknown> = {}) => {
      writeFileSync(join(home, ".repo-harness", "config.json"), JSON.stringify({
        agents: { enabled: enabled ? ["antigravity", "claude", "codex", "pi"] : [], uses: { docs: [], review: [] }, default_docs: null },
        seats: { ...DEFAULT_SEATS_CONFIG, advisor, ...overrides },
      }));
    };
    configure();
    const agy = join(bin, "agy");
    const catalog = (models: AgyCatalogFixture, version?: string, quota?: { gemini: number; other: number }) => {
      const quotaScript = `
if (command === 'models') process.exit(0);
const quota = ${JSON.stringify(quota)};
if (command === '-p' && process.argv[3] === '/usage' && quota) {
  const bucket = (window, remaining_fraction, hours) => ({ window, remaining_fraction,
    reset_time: new Date(Date.now() + hours * 3600000).toISOString() });
  const group = (name, remaining) => ({ name, buckets: [bucket('weekly', remaining, 84), bucket('5h', 0.90, 2)] });
  const groups = [group('Gemini Models', quota.gemini), group('Claude and GPT models', quota.other)];
  console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups } } }));
  process.exit(0);
}
process.exit(93);
`;
      writeFileSync(agy, `#!${process.execPath}\n${agyCatalogScript(models, version, quotaScript)}`, { mode: 0o755 });
    };
    catalog([
      { id: "gemini-4-neon", efforts: ["high"] },
      { id: "gemini-4-carbon", efforts: ["high"] },
      { id: "gemini-4-hydrogen", efforts: ["low", "medium", "high", "xhigh"] },
    ]);
    const tab = join(home, "tab.json");
    writeFileSync(join(bin, "herdr-app"), `#!${process.execPath}
if (process.argv[2] === 'ls') {
  console.log(JSON.stringify({ spaces: [] }));
  process.exit(0);
}
const args = JSON.parse(process.argv[4]);
require('node:fs').appendFileSync(${JSON.stringify(tab)}, JSON.stringify(args) + '\\n');
if (process.env.AGY_HERDR_FAIL) { console.error(JSON.stringify(args)); process.exit(1); }
console.log(JSON.stringify({ tab: 'tb1', terminal: 't9', args }));
`, { mode: 0o755 });
    const run = (args: string[], extra: Record<string, string> = {}) => {
      const result = spawnSync(process.execPath, [CLI, "seats", ...args], { cwd, env: { ...setup, ...extra }, encoding: "utf8", timeout: 40_000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    callback({ home, cwd, agy, hooks, bundle, tab, env: setup, run, configure, catalog });
  }));
}

function agyTabArgs(cwd: string, task = "Private first turn"): string[] {
  return ["launch", "advisor", "--space", "sp1", "--cwd", cwd, "--task", task, "--json"];
}

describe.skipIf(process.platform === "win32")("agy multi-seat launch", () => {
  test("renders the exact labeled and unlabeled advisor argv and sends the first task once through Herdr", withAgySeat(f => {
    const task = "Private first turn";
    const labels = ["--repository-id", "1186405141"];
    const raw = f.run(["argv", "advisor", ...labels, "--json"]);
    expect(raw.status, raw.stderr).toBe(0);
    const labeled = JSON.parse(raw.stdout);
    const expectedSpec = agySeatAgentSpec("advisor", AGY_ADVISOR);
    const agentName = labeled.argv[labeled.argv.indexOf("--agent") + 1];
    expect(labeled.argv).not.toContain("--add-dir");
    expect(agentName).toBe(expectedSpec.name);
    expect(agentName).toMatch(AGY_SEAT_AGENT_DIR_PATTERN);
    const agentDir = join(realpathSync(f.home), ".gemini", "config", "agents", agentName);
    expect(existsSync(join(f.home, ".repo-harness", "seats", "agy"))).toBe(false);
    const settings = { trustedWorkspaces: [f.cwd], permissions: {
      "allow": [
        "command(hc ls)",
        "command(hc get)",
        "command(hc read)",
        "command(hc file read)",
        "command(hc wait)",
        "command(hc send)",
        "command(git log)",
        "command(git show)",
        "command(git diff)",
        "command(git status)",
        "command(git grep)",
        "command(git rev-parse)",
        "command(git ls-remote)",
        "command(git fetch)",
        "command(gh pr view)",
        "command(gh pr list)",
        "command(gh pr checks)",
        "command(gh pr diff)",
        "command(gh issue view)",
        "command(gh issue list)",
        "command(gh run view)",
        "command(gh run list)",
        "command(rh board attention --parent)",
        "command(rh board parents)",
        "command(rh board cluster)",
        "command(rh board seats)",
        "command(rh board retro)",
        "command(rh doctor)",
        "command(rh quota)",
        "command(rh seats pool)",
        "command(rh arch projection status)",
        "command(rh arch debt)",
        "command(rh arch refactor recommendations)",
        "command(rh arch refactor list)",
        "command(rh arch refactor show)",
        "command(rh arch module list)",
        "command(rh arch module review-prompt)",
        "command(rg)",
        "command(ls)",
        "command(cat)",
        "command(rh seats council)",
        "command(rh seats reset)",
        "command(rh seats handoff)",
        "command(rh arch refactor decide)"
      ],
      "deny": [
        "command(gh issue close)",
        "command(gh issue comment)",
        "command(gh issue create)",
        "command(gh issue edit)",
        "command(gh pr close)",
        "command(gh pr comment)",
        "command(gh pr create)",
        "command(gh pr edit)",
        "command(gh pr merge)",
        "command(gh pr review)",
        "command(gh release create)",
        "command(git push)",
        "command(rh board attention start)",
        "command(rh board merge)",
        "command(rh board dispatch)",
        "command(rh board review)",
        "command(rh board post)",
        "command(rh board triage-apply)",
        "command(rh board closeout)",
        "command(rh board migrate-dependencies)",
        "command(rh seats launch)",
        "command(rh publication merge)",
        "command(rh review collect)",
        "command(rh review publish)",
        "command(gh run rerun)",
        "command(git reset --hard)",
        "command(git clean)"
      ]
    } };
    for (const mutating of ["rh board dispatch", "rh board review", "rh board merge", "rh board closeout", "rh board post", "rh board migrate-dependencies", "rh seats launch", "rh seats consult"]) {
      expect(settings.permissions.allow).not.toContain(`command(${mutating})`);
    }
    expect(AGY_READONLY_COMMAND_PREFIXES.some(prefix => "rh board --parent 123 merge".startsWith(prefix))).toBe(false);
    expect(AGY_WORKER_COMMAND_PREFIXES.some(prefix => ["git", "gh", "hc", "rh"].includes(prefix))).toBe(false);
    expect(AGY_READONLY_COMMAND_PREFIXES.some(prefix => ["git", "gh", "hc", "rh"].includes(prefix))).toBe(false);
    expect(settings.permissions.deny).toContain("command(rh board attention start)");
    const executable = [f.agy, "--dangerously-skip-permissions", "--model", "gemini-4-neon-high",
      "--agent", agentName, "--settings", JSON.stringify(settings)];
    expect(agent(labeled)).toEqual([...UNSET_SEAT, "REPO_HARNESS_SEAT=advisor", "REPO_HARNESS_SEAT_REPOSITORY=1186405141",
      "REPO_HARNESS_SEAT_MODEL=gemini-4-neon-high", ...executable]);
    const profile = readFileSync(join(agentDir, "agent.md"), "utf8");
    expect(profile).toContain(`name: ${agentName}\ndescription: Repo-harness advisor\nmainAgent: true\ntools: [view_file, write_file, edit_file, run_command, search_web, schedule]\ninheritMcp: true`);
    const ledger = JSON.parse(readFileSync(join(f.home, ".repo-harness", "config", "ledger.json"), "utf8"));
    const agentFile = join(agentDir, "agent.md");
    expect(ledger.paths[agentFile]).toMatchObject({
      host: "antigravity",
      owner: "core",
      kind: "created",
      committed: { type: "file", sha256: expectedSpec.fileDigest },
      identity: observeEntryIdentity(agentFile),
    });
    expect(ledger.directory_identities?.[agentDir]).toBe(observeEntryIdentity(agentDir));
    expect(profile).toContain("Edit only your own files under /tmp/rh-triage/");
    expect(profile).toContain("Never edit repository source.");
    expect(profile).toContain("Never read auth or credential files.");
    expect(profile).toContain("Follow the handoff steps printed by the Stop hook or rh seats handoff");
    const unlabeled = f.run(["argv", "advisor", "--json"]);
    expect(unlabeled.status, unlabeled.stderr).toBe(0);
    expect(JSON.parse(unlabeled.stdout).argv).toEqual([...UNSET_SEAT, ...executable]);
    const opened = f.run([...agyTabArgs(f.cwd, task), ...labels]);
    expect(opened.status, opened.stderr).toBe(0);
    expect(JSON.parse(readFileSync(f.tab, "utf8"))).toEqual({ name: labeled.tab, space: "sp1", folder: f.cwd,
      focus: false, argv: [...labeled.argv, "-i", task] });
    expect(opened.stdout).not.toContain(task);
    expect(JSON.parse(opened.stdout).placement).toEqual({ tab: "tb1", terminal: "t9" });
  }));

  test("renders the native orchestrator argv, command rules and read-only agent profile", withAgySeat(f => {
    f.configure(AGY_ADVISOR, true, { orchestrator: AGY_ORCHESTRATOR });
    const raw = f.run(["argv", "orchestrator", "--repository-id", "1186405141", "--json"]);
    expect(raw.status, raw.stderr).toBe(0);
    const launch = JSON.parse(raw.stdout);
    expect(launch).toMatchObject({ seat: "orchestrator", runtime: "agy" });
    const argv = agent(launch);
    expect(argv).toContain("REPO_HARNESS_SEAT=orchestrator");
    const expectedAgent = agySeatAgentSpec("orchestrator", AGY_ORCHESTRATOR).name;
    expect(argv).not.toContain("--add-dir");
    expect(argv[argv.indexOf("--agent") + 1]).toBe(expectedAgent);
    const profile = readFileSync(join(f.home, ".gemini", "config", "agents", expectedAgent, "agent.md"), "utf8");
    expect(profile).toContain("tools: [view_file, run_command, search_web]\ninheritMcp: true");
    expect(profile).toContain("Never edit repository files.");
    expect(profile).toContain("triage queue in your own scratch files under /tmp");
    const { permissions } = JSON.parse(argv[argv.indexOf("--settings") + 1]);
    expect(permissions.allow).toEqual(expect.arrayContaining([
      "command(rh board attention)", "command(rh board dispatch)", "command(rh board review)",
      "command(rh seats launch)", "command(rh publication merge)", "command(rh review collect)",
      "command(rh worktrees clean)", "command(git worktree list)", "command(gh issue edit)", "command(gh run rerun)",
    ]));
    expect(permissions.deny).toEqual([
      "command(git reset --hard)", "command(git clean)", "command(gh release create)",
      "command(npm publish)", "command(bun publish)",
    ]);
  }));

  test.each(["advisor", "orchestrator"] as const)("the generated agy %s profile can write and hash a handoff through its CLI", seat => withAgySeat(f => {
    const advisor = { ...AGY_ADVISOR, tools: AGY_ADVISOR.tools.filter(tool => tool !== "edit") };
    f.configure(advisor, true, { orchestrator: AGY_ORCHESTRATOR });
    const repository = String(9_400_000_000 + process.pid * 10 + Number(seat === "advisor"));
    const identity = { seat, repository };
    const handoff = seatHandoffPath(identity);
    const request = seatResetRequestPath(identity);
    try {
      const launch = f.run(["argv", seat, "--repository-id", repository, "--json"]);
      expect(launch.status, launch.stderr).toBe(0);
      const argv = agent(JSON.parse(launch.stdout));
      const { permissions } = JSON.parse(argv[argv.indexOf("--settings") + 1]);
      expect(permissions.allow).toContain("command(rh seats handoff)");
      expect(permissions.deny).not.toContain("command(rh seats handoff)");
      expect(argv).not.toContain("--add-dir");
      const agentName = argv[argv.indexOf("--agent") + 1];
      expect(agentName).toMatch(new RegExp(`^rh-${seat}-[0-9a-f]{12}$`, "u"));
      const profile = readFileSync(join(f.home, ".gemini", "config", "agents", agentName, "agent.md"), "utf8");
      expect(profile).not.toMatch(/^tools:.*\b(?:write_file|edit_file)\b/mu);
      const env = { ...f.env, ...Object.fromEntries(argv.filter(value => /^REPO_HARNESS_SEAT(?:_REPOSITORY)?=/u.test(value)).map(value => value.split("="))) };
      const transcript = join(f.home, ".gemini", "antigravity-cli", "brain", "handoff-fixture", ".system_generated", "logs", "transcript.jsonl");
      mkdirSync(dirname(transcript), { recursive: true });
      writeFileSync(transcript, '{"type":"PLANNER_RESPONSE","input_tokens":100}\n');
      recordSeatSession(identity, { host: "antigravity", sessionId: "handoff-fixture", transcriptPath: transcript,
        source: "startup", model: null, effort: null }, new Date(0));
      writeFileSync(join(f.home, "bin", "rh"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`, { mode: 0o755 });
      const runHandoff = (command: string) => spawnSync("/bin/sh", ["-c", command], { env, cwd: f.cwd, encoding: "utf8" });
      const steps = runHandoff("rh seats handoff");
      expect(steps.status, steps.stderr).toBe(0);
      const heredoc = steps.stdout.match(/rh seats handoff --write <<'RH_HANDOFF'\n[\s\S]*?\nRH_HANDOFF/u)?.[0];
      expect(heredoc).toBeDefined();
      const recorded = readFileSync(request, "utf8");
      const command = heredoc!.replaceAll("<fill in>", "Current state includes a literal $(exit 9).");
      const body = command.split("\n").slice(1, -1).join("\n") + "\n";
      const write = runHandoff(command);
      expect(write.status, write.stderr).toBe(0);
      expect(readFileSync(handoff, "utf8")).toBe(body);
      expect(write.stdout).toBe(`RESET-REQUEST ${handoff} ${createHash("sha256").update(body).digest("hex")}\n`);
      expect(readFileSync(request, "utf8")).toBe(recorded);
    } finally {
      rmSync(dirname(dirname(handoff)), { recursive: true, force: true });
    }
  })());

  test.each(["missing", "unsupported", "signed out", "unknown", "model absent", "effort mismatch", "outside opt-in", "guard absent", "guard force_ask", "host disabled", "gatekeeper", "reviewer"])("agy refuses %s before any agent projection or tab", (branch) => withAgySeat(f => {
    let cwd = f.cwd;
    let seat = "advisor";
    let error: string;
    const extraArgs: string[] = [];
    switch (branch) {
      case "missing": rmSync(f.agy); error = "seat_runtime_missing"; break;
      case "unsupported": f.catalog([], "1.4.9"); error = "seat_runtime_unsupported"; break;
      case "signed out":
        f.configure({ ...AGY_ADVISOR, model: "private-free-id" });
        f.catalog("signed_out", undefined, { gemini: 0.01, other: 0.60 });
        error = "seat_runtime_signed_out";
        break;
      case "unknown": f.catalog("malformed"); error = "seat_runtime_unknown"; break;
      case "model absent": f.configure({ ...AGY_ADVISOR, model: "private-free-id" }); error = "seat_model_unavailable"; break;
      case "effort mismatch": f.configure({ ...AGY_ADVISOR, effort: "medium" }); error = "seat_effort_invalid"; break;
      case "outside opt-in": cwd = f.home; error = "seat_checkout_not_opted_in"; break;
      case "guard absent": rmSync(f.hooks); error = "antigravity_guard_unready"; break;
      case "guard force_ask":
        writeFileSync(f.bundle, [
          "const fs = require('node:fs');",
          "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
          "const cmd = input.toolCall?.args?.CommandLine ?? '';",
          "console.log(JSON.stringify(cmd.includes('.env')",
          "  ? { decision: 'deny', reason: 'rh hook: the tool call is refused' }",
          "  : { decision: 'force_ask', reason: '[UserFileGuard] I2: This tool call may overwrite or remove an existing file outside the allowed roots.' }));",
        ].join("\n"));
        error = "antigravity_guard_unready";
        break;
      case "host disabled": f.configure(AGY_ADVISOR, false); error = "seat_runtime_not_enabled"; break;
      case "gatekeeper": seat = "gatekeeper"; extraArgs.push("--pr", "3377"); f.configure(AGY_ADVISOR, true, { gatekeeper: AGY_ADVISOR }); error = "seat_runtime_not_allowed"; break;
      default: seat = "reviewer"; extraArgs.push("--pr", "3377"); f.configure(AGY_ADVISOR, true, { reviewer: AGY_ADVISOR }); error = "seat_runtime_not_allowed"; break;
    }
    const args = [...agyTabArgs(cwd), ...extraArgs];
    args[1] = seat;
    const result = f.run(args);
    expect([result.status, result.stdout, JSON.parse(result.stderr).error]).toEqual([1, "", error]);
    expect(result.stderr).not.toContain("private");
    expect(existsSync(join(f.home, ".gemini", "config", "agents"))).toBe(false);
    expect(existsSync(join(f.home, ".repo-harness", "seats", "agy"))).toBe(false);
    expect(existsSync(f.tab)).toBe(false);
  })());

  test("a listed free model launches despite a stale cache, and only the local argv carries it", withAgySeat(f => {
    const model = "private-free-id";
    f.configure({ ...AGY_ADVISOR, model, tools: ["net", "read", "shell"] });
    f.catalog("signed_out");
    const negative = f.run(["pool", "--json"]);
    expect(negative.status, negative.stderr).toBe(0);
    const cache = join(f.home, ".repo-harness", "seats", "pool.json");
    const stale = JSON.stringify({ ...JSON.parse(negative.stdout), collected_at: "2026-01-01T00:00:00.000Z" });
    writeFileSync(cache, stale);
    f.catalog([model]);
    const result = f.run(agyTabArgs(f.cwd));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(model);
    expect(JSON.parse(result.stdout).model).toBe("seats.advisor.model");
    const args = JSON.parse(readFileSync(f.tab, "utf8")).argv;
    expect(args[args.indexOf("--model") + 1]).toBe(model);
    expect(args).not.toContain("--add-dir");
    const agentName = args[args.indexOf("--agent") + 1];
    expect(readFileSync(join(f.home, ".gemini", "config", "agents", agentName, "agent.md"), "utf8"))
      .toContain("tools: [view_file, run_command, search_web]\ninheritMcp: false");
    expect(readFileSync(cache, "utf8")).toBe(stale);
  }));

  test("builds an agy advisor relaunch in the existing shell", withAgySeat(f => {
    const repository = "1186405141";
    const source = join(import.meta.dir, "../../src/cli/commands/seats.ts");
    const program = `import { seatResetLaunch } from ${JSON.stringify(source)};
console.log(JSON.stringify(await seatResetLaunch({ seat: "advisor", repository: "${repository}" }, process.env, process.cwd(), false)));`;
    const result = spawnSync(process.execPath, ["--eval", program], { cwd: f.cwd, env: f.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const { argv, model, runtime } = JSON.parse(result.stdout);
    expect(runtime).toBe("agy");
    expect(model).toBe("gemini-4-neon-high");
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv).not.toContain("--add-dir");
    expect(argv).toEqual(expect.arrayContaining([f.agy, agySeatAgentSpec("advisor", AGY_ADVISOR).name, `REPO_HARNESS_SEAT_REPOSITORY=${repository}`]));
    expect(existsSync(f.tab)).toBe(false);
  }));

  test("agy advisor checks the quota-selected model in its native catalog", withAgySeat(f => {
    f.configure({ ...AGY_ADVISOR, model: "gemini-4-carbon-xhigh", effort: "xhigh" });
    const carbon = [{ id: "gemini-4-carbon", efforts: ["xhigh"] }];
    const neon = [{ id: "gemini-4-neon", efforts: ["high"] }];
    f.catalog(carbon, undefined, { gemini: 0.49, other: 0.60 });
    const missing = f.run(["argv", "advisor", "--json"]);
    expect([missing.status, JSON.parse(missing.stderr).error]).toEqual([1, "seat_model_unavailable"]);
    f.catalog(neon, undefined, { gemini: 0.49, other: 0.60 });
    const downgraded = f.run(["argv", "advisor", "--json"]);
    expect(downgraded.status, downgraded.stderr).toBe(0);
    const args = JSON.parse(downgraded.stdout).argv;
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-4-neon-high");
    expect(args).not.toContain("--effort");
    f.catalog(carbon, undefined, { gemini: 0.50, other: 0.60 });
    const unchanged = f.run(["argv", "advisor", "--json"]);
    expect(unchanged.status, unchanged.stderr).toBe(0);
    const configured = JSON.parse(unchanged.stdout).argv;
    expect(configured[configured.indexOf("--model") + 1]).toBe("gemini-4-carbon-xhigh");
    expect(configured[configured.indexOf("--effort") + 1]).toBe("xhigh");
  }));

  test('worker-neon-deep launches the native Neon xhigh preset', withAgySeat(f => {
    f.configure(AGY_ADVISOR, true, { 'worker-neon-deep': NATIVE_SEATS_PRESET['worker-neon-deep'] });
    f.catalog([{ id: 'gemini-4-neon', efforts: ['high', 'xhigh'] }]);
    const result = f.run(['argv', 'worker-neon-deep', '--json']);
    expect(result.status, result.stderr).toBe(0);
    const { runtime, argv } = JSON.parse(result.stdout);
    expect(runtime).toBe('agy');
    expect(argv[argv.indexOf('--model') + 1]).toBe('gemini-4-neon-xhigh');
  }));

  test("native agy worker without Gemini uses the agy_other account before launch", withAgySeat(f => {
    const model = "claude-opus-5-5-high";
    f.configure(AGY_ADVISOR, true, { worker: { ...AGY_WORKER, model } });
    f.catalog([model], undefined, { gemini: 0.60, other: 0.01 });
    const refused = f.run(["argv", "worker", "--json"]);
    expect([refused.status, JSON.parse(refused.stderr).error]).toEqual([1, "seat_quota_exhausted"]);
    expect(JSON.parse(refused.stderr).message).toContain("agy_other");
  }));

  test("agy refuses an explicit effort outside the listed model's menu before writing a profile or opening a pane", withAgySeat(f => {
    const model = "gemini-4-hydrogen";
    f.configure({ ...AGY_ADVISOR, model, effort: "max" });
    f.catalog([{ id: model, efforts: ["low", "medium", "high", "xhigh"] }]);
    const refused = f.run(agyTabArgs(f.cwd));
    expect([refused.status, JSON.parse(refused.stderr).error]).toEqual([1, "seat_effort_invalid"]);
    expect(existsSync(join(f.home, ".gemini", "config", "agents"))).toBe(false);
    expect(existsSync(join(f.home, ".repo-harness", "seats", "agy"))).toBe(false);
    expect(existsSync(f.tab)).toBe(false);
  }));

  test.each(["explicit override with a different agy on PATH", "official install outside PATH"] as const)(
    "agy quota and launch use the same executable for %s", (branch) => withAgySeat(f => {
      const model = "claude-opus-5-5-high";
      f.configure(AGY_ADVISOR, true, { worker: { ...AGY_WORKER, model } });
      const explicit = branch.startsWith("explicit");
      const installation = join(f.home, explicit ? "override" : ".local/bin", "agy");
      mkdirSync(dirname(installation), { recursive: true });
      f.catalog([model], undefined, { gemini: 0.60, other: 0.01 });
      writeFileSync(installation, readFileSync(f.agy), { mode: 0o755 });
      if (explicit) f.catalog([model], undefined, { gemini: 0.60, other: 0.60 });
      else rmSync(f.agy);
      const env: Record<string, string> = explicit ? { OAR_ANTIGRAVITY_BIN: installation } : {};
      const refused = f.run(["argv", "worker", "--json"], env);
      expect(refused.status, refused.stdout || refused.stderr).toBe(1);
      expect(JSON.parse(refused.stderr)).toMatchObject({ error: "seat_quota_exhausted", message: expect.stringContaining("agy_other") });
    })(),
  );

  test("worker agy launches generate rh-worker with writable tools, zero REPO_HARNESS_SEAT* env vars, and gh-aware command rules", withAgySeat(f => {
    f.configure(AGY_ADVISOR, true, { "worker-neon": AGY_WORKER, "worker-light": AGY_WORKER_NO_GH });
    const raw = f.run(["argv", "worker-neon", "--repository-id", "1186405141", "--issue", "3377", "--parent", "3375", "--json"]);
    expect(raw.status, raw.stderr).toBe(0);
    const worker = JSON.parse(raw.stdout);
    const workerAgentArgs = agent(worker);
    expect(workerAgentArgs.slice(0, UNSET_SEAT.length)).toEqual(UNSET_SEAT);
    expect(workerAgentArgs[UNSET_SEAT.length]).toBe(f.agy);
    expect(worker.argv.some((arg: string) => arg.startsWith("REPO_HARNESS_SEAT") && arg.includes("="))).toBe(false);
    expect(worker.argv).toContain("--dangerously-skip-permissions");
    expect(worker.argv).not.toContain("--mode");
    expect(worker.argv).not.toContain("accept-edits");
    expect(worker.argv).not.toContain("--add-dir");
    const expectedWorkerAgent = agySeatAgentSpec("worker-neon", AGY_WORKER).name;
    expect(worker.argv[worker.argv.indexOf("--agent") + 1]).toBe(expectedWorkerAgent);
    expect(worker.brief).not.toContain("Do not edit files.");
    expect(worker.brief).not.toContain("Do not write to GitHub.");
    const profile = readFileSync(join(f.home, ".gemini", "config", "agents", expectedWorkerAgent, "agent.md"), "utf8");
    expect(profile).toContain(`name: ${expectedWorkerAgent}\ndescription: Repo-harness worker\nmainAgent: true\ntools: [view_file, write_file, edit_file, run_command, search_web]\ninheritMcp: false`);
    expect(profile).toContain("Never read auth or credential files.");
    expect(profile).not.toContain("When Stop requests a handoff");
    const parsedSettings = JSON.parse(worker.argv[worker.argv.indexOf("--settings") + 1]);
    expect(parsedSettings.permissions.allow).toEqual(expect.arrayContaining([
      "command(bun)", "command(git commit)", "command(git push)", "command(gh pr create)", "command(gh run rerun)",
      ...[
        "rh arch projection status", "rh arch projection slice", "rh arch prepare", "rh arch checkpoint", "rh arch complete",
        "rh arch verify", "rh arch debt", "rh arch refactor verify", "rh arch refactor resolve", "rh capability resolve",
        "rh state", "rh doctor", "rh quota", "rh seats pool", "rh run", "bash scripts/check-ci.sh",
        "git worktree list", "git merge-tree",
        "git restore --staged -- ./", "git mv -- ./", "git stash push", "git stash list", "git stash show",
      ].map(command => `command(${command})`),
    ]));
    expect(parsedSettings.permissions.deny).not.toContain("command(git push)");
    expect(parsedSettings.permissions.deny).toEqual(expect.arrayContaining([
      "command(rh publication merge)", "command(rh board merge)", "command(gh pr merge)", "command(gh release create)",
      "command(gh issue close)", "command(git reset --hard)", "command(git clean)",
    ]));
    expect(worker.limits).toEqual(agySeatLimits("worker-neon", AGY_WORKER));
    expect(worker.limits.some((limit: { subject: string }) => limit.subject === "edit" || limit.subject === "gh")).toBe(false);

    // Worker with gh disabled denies git push and gh pr create and reports gh: common_commands.
    const noGhRaw = f.run(["argv", "worker-light", "--repository-id", "1186405141", "--issue", "3377", "--json"]);
    expect(noGhRaw.status, noGhRaw.stderr).toBe(0);
    const noGh = JSON.parse(noGhRaw.stdout);
    expect(noGh.argv[noGh.argv.indexOf("--model") + 1]).toBe("gemini-4-hydrogen-high");
    expect(noGh.argv[noGh.argv.indexOf("--effort") + 1]).toBe("high");
    const noGhSettings = JSON.parse(noGh.argv[noGh.argv.indexOf("--settings") + 1]);
    expect(noGhSettings.permissions.allow).not.toContain("command(git push)");
    expect(noGhSettings.permissions.allow).not.toContain("command(gh pr create)");
    expect(noGhSettings.permissions.allow).not.toContain("command(gh run rerun)");
    expect(noGhSettings.permissions.deny).toEqual(expect.arrayContaining(["command(git push)", "command(gh pr create)", "command(gh pr merge)", "command(gh run rerun)", "command(git reset --hard)"]));
    expect(noGh.limits).toContainEqual({ subject: "gh", level: "common_commands" });
    expect(noGh.limits.some((limit: { subject: string }) => limit.subject === "edit")).toBe(false);
  }));

  test("gatekeeper-fallback on agy launches read-only rh-gatekeeper-fallback when primary gatekeeper is exhausted and fails closed when hooks are missing", withAgySeat(f => {
    f.configure(AGY_ADVISOR, true, {
      gatekeeper: { runtime: "codex", model: "gpt-6.2-sol", advisor_model: null, effort: "high", tools: ["net", "read", "shell"], fleet: [] },
      "gatekeeper-fallback": AGY_FALLBACK,
    });
    writeFileSync(join(f.home, "codex-used"), "97");
    const extraPath = { PATH: [join(f.home, "bin"), join(f.home, ".quota-bin"), "/usr/bin", "/bin"].join(delimiter) };
    const raw = f.run(["argv", "gatekeeper", "--repository-id", "1186405141", "--pr", "42", "--json"], extraPath);
    expect(raw.status, raw.stderr).toBe(0);
    const gk = JSON.parse(raw.stdout);
    expect(gk.runtime).toBe("agy");
    expect(gk.argv[gk.argv.indexOf("--model") + 1]).toBe("gemini-4-hydrogen-high");
    expect(gk.argv).not.toContain("--add-dir");
    const expectedGkAgent = agySeatAgentSpec("gatekeeper", AGY_FALLBACK).name;
    expect(gk.argv[gk.argv.indexOf("--agent") + 1]).toBe(expectedGkAgent);
    expect(gk.argv.some((arg: string) => arg.startsWith("REPO_HARNESS_SEAT") && arg.includes("="))).toBe(false);
    expect(gk.brief).toContain("Do not edit files.");
    const profile = readFileSync(join(f.home, ".gemini", "config", "agents", expectedGkAgent, "agent.md"), "utf8");
    expect(profile).toContain(`name: ${expectedGkAgent}\ndescription: Repo-harness gatekeeper fallback\nmainAgent: true\ntools: [view_file, run_command, search_web]\ninheritMcp: false`);
    const parsedSettings = JSON.parse(gk.argv[gk.argv.indexOf("--settings") + 1]);
    expect(parsedSettings.permissions.allow).not.toContain("command(rh seats council)");
    expect(parsedSettings.permissions.deny).toEqual(expect.arrayContaining(["command(rh publication merge)", "command(rh board merge)", "command(gh pr merge)", "command(git reset --hard)"]));

    // Removing hooks fails closed before creating any agent dir or tab.
    rmSync(join(f.home, ".gemini", "config", "agents"), { recursive: true, force: true });
    rmSync(f.hooks);
    const refused = f.run(["argv", "gatekeeper", "--pr", "42", "--json"], extraPath);
    expect([refused.status, JSON.parse(refused.stderr).error]).toEqual([1, "antigravity_guard_unready"]);
    expect(existsSync(join(f.home, ".gemini", "config", "agents"))).toBe(false);
    expect(existsSync(join(f.home, ".repo-harness", "seats", "agy"))).toBe(false);
  }));

  test("native agy council launches rh-council with -i <task>, zero seat env vars, dry-run without writes, and private task redaction", withAgySeat(f => {
    const dry = f.run(["council", "--issue", "3377", "--members", "carbon", "--repository-id", "1186405141", "--dry-run", "--json"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout).members[0]).toMatchObject({ member: "carbon", runtime: "agy", model: "gemini-4-carbon-high" });
    expect(existsSync(join(f.home, ".gemini", "config", "agents"))).toBe(false);
    expect(existsSync(join(f.home, ".repo-harness", "seats", "agy"))).toBe(false);

    const res = f.run(["council", "--issue", "3377", "--members", "carbon", "--repository-id", "1186405141", "--space", "sp1", "--question", "Secret focus?", "--json"]);
    expect(res.status, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.members[0]).toMatchObject({ member: "carbon", runtime: "agy", model: "gemini-4-carbon-high" });
    const tabArg = JSON.parse(readFileSync(f.tab, "utf8").trim());
    expect(tabArg.task).toBeUndefined();
    expect(tabArg.argv.at(-2)).toBe("-i");
    expect(tabArg.argv.at(-1)).toContain("Secret focus?");
    expect(tabArg.argv.some((arg: string) => arg.startsWith("REPO_HARNESS_SEAT") && arg.includes("="))).toBe(false);
    expect(tabArg.argv).not.toContain("--add-dir");
    const councilAgent = tabArg.argv[tabArg.argv.indexOf("--agent") + 1];
    expect(councilAgent).toMatch(/^rh-council-[0-9a-f]{12}$/u);
    const profile = readFileSync(join(f.home, ".gemini", "config", "agents", councilAgent, "agent.md"), "utf8");
    expect(profile).toContain(`name: ${councilAgent}\ndescription: Repo-harness council\nmainAgent: true\ntools: [view_file, run_command, search_web]\ninheritMcp: false`);
    const parsedSettings = JSON.parse(tabArg.argv[tabArg.argv.indexOf("--settings") + 1]);
    expect(parsedSettings.permissions.allow).not.toContain("command(rh seats council)");
    expect(parsedSettings.permissions.deny).toEqual(expect.arrayContaining(["command(rh publication merge)", "command(rh board merge)", "command(gh pr merge)", "command(git reset --hard)"]));

    // Herdr failure redacts the private task in stderr.
    const failed = f.run(["council", "--issue", "3377", "--members", "carbon", "--qualifier", "b", "--repository-id", "1186405141", "--space", "sp1", "--question", "Secret focus?"], { AGY_HERDR_FAIL: "1" });
    expect([failed.status, JSON.parse(failed.stderr).error]).toEqual([1, "seat_tab_unknown"]);
    expect(failed.stderr).not.toContain("Secret focus?");
    rmSync(dirname(out.members[0].out_path), { recursive: true, force: true });
  }));

  test("seats council starts each member on its native route while pi and magpie are installed, and follows a stored seats.council.runtime=pi or agy (#3644)", withAgySeat(f => {
    mkdirSync(join(f.home, ".pi", "agent", "extensions"), { recursive: true });
    writeFileSync(join(f.home, ".pi", "agent", "extensions", "magpie.ts"), "");
    writeFileSync(join(f.home, "bin", "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // Installed pi + magpie do not move a member onto its Pi route: every member starts native.
    const nativeDry = f.run(["council", "--issue", "3644", "--members", "fable,carbon,astra", "--repository-id", "1186405141", "--dry-run", "--json"]);
    expect(nativeDry.status, nativeDry.stderr).toBe(0);
    expect(JSON.parse(nativeDry.stdout).members).toEqual([
      expect.objectContaining({ member: "fable", runtime: "claude", model: "fable" }),
      expect.objectContaining({ member: "carbon", runtime: "agy", model: "gemini-4-carbon-high" }),
      expect.objectContaining({ member: "astra", runtime: "codex", model: "gpt-6.2-astra" }),
    ]);

    // A stored seats.council.runtime=pi selects the Pi route of each member that has one.
    f.configure(AGY_ADVISOR, true, { council: PI_COUNCIL });
    const piDry = f.run(["council", "--issue", "3644", "--members", "fable,carbon,astra", "--repository-id", "1186405141", "--dry-run", "--json"]);
    expect(piDry.status, piDry.stderr).toBe(0);
    expect(JSON.parse(piDry.stdout).members).toEqual([
      expect.objectContaining({ member: "fable", runtime: "claude", model: "fable" }),
      expect.objectContaining({ member: "carbon", runtime: "pi", model: "magpie/agy-cli/gemini-4-carbon" }),
      expect.objectContaining({ member: "astra", runtime: "pi", model: "magpie/codex/gpt-6.2-astra" }),
    ]);

    // A stored seats.council.runtime=agy keeps carbon native and leaves the other members on their routes (#3587).
    f.configure(AGY_ADVISOR, true, {
      council: { runtime: "agy", model: "gemini-4-carbon-high", advisor_model: null, effort: null, tools: ["net", "read", "shell"], fleet: [] },
    });
    const agyDry = f.run(["council", "--issue", "3587", "--members", "fable,carbon,astra", "--repository-id", "1186405141", "--dry-run", "--json"]);
    expect(agyDry.status, agyDry.stderr).toBe(0);
    expect(JSON.parse(agyDry.stdout).members).toEqual([
      expect.objectContaining({ member: "fable", runtime: "claude", model: "fable" }),
      expect.objectContaining({ member: "carbon", runtime: "agy", model: "gemini-4-carbon-high" }),
      expect.objectContaining({ member: "astra", runtime: "codex", model: "gpt-6.2-astra" }),
    ]);
  }));

  test("an uncertain tab request stays uncertain and keeps the first task private", withAgySeat(f => {
    const task = "Private first turn";
    const result = f.run(agyTabArgs(f.cwd, task), { AGY_HERDR_FAIL: "1" });
    expect([result.status, JSON.parse(result.stderr).error]).toEqual([1, "seat_tab_unknown"]);
    expect(result.stderr).not.toContain(task);
    expect(readFileSync(f.tab, "utf8").trimEnd().split("\n")).toHaveLength(1);
  }));

  test("disk-verified cache hit reuses untouched agent file without rewriting, fails closed on edit/file-replacement/dir-replacement/digest-mismatch/unrecorded/symlink, and recreates after clean absence", withAgySeat(f => {
    const argv = ["argv", "advisor", "--json"];
    const first = f.run(argv);
    expect(first.status, first.stderr).toBe(0);
    const args = JSON.parse(first.stdout).argv;
    const agentName = args[args.indexOf("--agent") + 1];
    const agentsDir = join(realpathSync(f.home), ".gemini", "config", "agents");
    const agentDir = join(agentsDir, agentName);
    const file = join(agentDir, "agent.md");
    const ledgerPath = join(f.home, ".repo-harness", "config", "ledger.json");
    const originalContent = readFileSync(file, "utf8");
    const fileIdentityBefore = observeEntryIdentity(file);
    const dirIdentityBefore = observeEntryIdentity(agentDir);
    const ledgerBefore = readFileSync(ledgerPath, "utf8");

    // Cache hit: untouched disk file and dir are verified and reused without rewriting.
    const second = f.run(argv);
    expect(second.status, second.stderr).toBe(0);
    expect(observeEntryIdentity(file)).toBe(fileIdentityBefore);
    expect(observeEntryIdentity(agentDir)).toBe(dirIdentityBefore);
    expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);

    // Edit between launches: fails closed and preserves user bytes.
    writeFileSync(file, "user content");
    const edited = f.run(argv);
    expect([edited.status, JSON.parse(edited.stderr).error]).toEqual([1, "host_config_replacement_refused"]);
    expect(readFileSync(file, "utf8")).toBe("user content");

    // Same-bytes inode replacement of agent.md alone: fails closed and preserves the replacement inode.
    const siblingCopy = join(f.home, "agent-sibling-copy.md");
    writeFileSync(siblingCopy, originalContent);
    renameSync(siblingCopy, file);
    const replacedFileIdentity = observeEntryIdentity(file);
    expect(replacedFileIdentity).not.toBe(fileIdentityBefore);
    const replacedFile = f.run(argv);
    expect([replacedFile.status, JSON.parse(replacedFile.stderr).error]).toEqual([1, "host_config_replacement_refused"]);
    expect(observeEntryIdentity(file)).toBe(replacedFileIdentity);

    // Replacement of agentDir with identical bytes (new dir + file identity): fails closed and preserves the replacement copy.
    const replacedCopy = join(f.home, "replaced-agent");
    mkdirSync(replacedCopy, { recursive: true });
    writeFileSync(join(replacedCopy, "agent.md"), originalContent);
    rmSync(agentDir, { recursive: true, force: true });
    cpSync(replacedCopy, agentDir, { recursive: true });
    const replacementDirIdentity = observeEntryIdentity(agentDir);
    expect(replacementDirIdentity).not.toBe(dirIdentityBefore);
    const replaced = f.run(argv);
    expect([replaced.status, JSON.parse(replaced.stderr).error]).toEqual([1, "host_config_replacement_refused"]);
    expect(observeEntryIdentity(agentDir)).toBe(replacementDirIdentity);

    // Clean absence: recreates through host-config gate and updates ledger identities.
    rmSync(agentDir, { recursive: true, force: true });
    const recreated = f.run(argv);
    expect(recreated.status, recreated.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(originalContent);
    expect(observeEntryIdentity(agentDir)).not.toBe(replacementDirIdentity);

    // Ledger committed digest mismatch while matching disk: fails closed.
    const tamperedContent = `${originalContent}\n# different digest\n`;
    writeFileSync(file, tamperedContent);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    const mismatchHash = `sha256:${createHash("sha256").update(tamperedContent).digest("hex")}`;
    ledger.paths[file].committed.sha256 = mismatchHash;
    ledger.paths[file].identity = observeEntryIdentity(file);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    const mismatch = f.run(argv);
    expect([mismatch.status, JSON.parse(mismatch.stderr).error]).toEqual([1, "host_config_replacement_refused"]);
    expect(readFileSync(file, "utf8")).toBe(tamperedContent);

    // Pre-existing unrecorded file/directory at target key: fails closed without overwriting.
    delete ledger.paths[file];
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    const unrecorded = f.run(argv);
    expect([unrecorded.status, JSON.parse(unrecorded.stderr).error]).toEqual([1, "host_config_replacement_refused"]);
    expect(readFileSync(file, "utf8")).toBe(tamperedContent);

    // Symlinked ~/.gemini/config/agents fails closed with antigravity_hooks_path_linked.
    const parkedAgents = join(f.home, "parked-agents");
    renameSync(agentsDir, parkedAgents);
    symlinkSync(parkedAgents, agentsDir, "dir");
    const linked = f.run(argv);
    expect([linked.status, JSON.parse(linked.stderr).error]).toEqual([1, "antigravity_hooks_path_linked"]);
    expect(lstatSync(agentsDir).isSymbolicLink()).toBe(true);
  }));

  test("agy seat directory containing an extra regular .repo-harness-owner.json fails cache hit, and uninstall removes only agent.md while keeping and reporting the directory", () => {
    for (const target of ["antigravity", "both"] as const) {
      withAgySeat(f => {
        const argv = ["argv", "advisor", "--json"];
        const first = f.run(argv);
        expect(first.status, first.stderr).toBe(0);
        const args = JSON.parse(first.stdout).argv;
        const agentName = args[args.indexOf("--agent") + 1];
        const agentDir = join(realpathSync(f.home), ".gemini", "config", "agents", agentName);
        const agentFile = join(agentDir, "agent.md");
        const userMarker = join(agentDir, ".repo-harness-owner.json");
        const userBytes = "{\"user\":\"keep\"}\n";
        writeFileSync(userMarker, userBytes);

        // Cache hit must reject the modified directory rather than ignoring .repo-harness-owner.json.
        const second = f.run(argv);
        expect([second.status, JSON.parse(second.stderr).error]).toEqual([1, "host_config_replacement_refused"]);
        expect(readFileSync(userMarker, "utf8")).toBe(userBytes);

        // Dry-run and apply remove only untouched agent.md, never recursively delete agentDir, keep .repo-harness-owner.json, and report agentDir as kept.
        const dry = runUserUninstall({ target, dryRun: true, env: f.env });
        expect(dry.items).toContainEqual(expect.objectContaining({ path: agentDir, action: "kept" }));

        const result = runUserUninstall({ target, env: f.env });
        expect(result.exitCode, result.lines.join("\n")).toBe(0);
        expect(existsSync(agentFile)).toBe(false);
        expect(readFileSync(userMarker, "utf8")).toBe(userBytes);
        expect(lstatSync(agentDir).isDirectory()).toBe(true);
        expect(result.items).toContainEqual(expect.objectContaining({ path: agentDir, action: "kept" }));
      })();
    }
  });

  test("pre-existing capitalized Agents directory and post-publish case-only rename use guarded canonical aliases across publish, cache hit, and uninstall", withAgySeat(f => {
    const configDir = join(realpathSync(f.home), ".gemini", "config");
    const capitalizedAgents = join(configDir, "Agents");
    mkdirSync(capitalizedAgents, { recursive: true });

    const argv = ["argv", "advisor", "--json"];
    const first = f.run(argv);
    expect(first.status, first.stderr).toBe(0);
    const args = JSON.parse(first.stdout).argv;
    const agentName = args[args.indexOf("--agent") + 1];
    const ledgerPath = join(f.home, ".repo-harness", "config", "ledger.json");
    const recordedKey = Object.keys(JSON.parse(readFileSync(ledgerPath, "utf8")).paths)
      .find(key => basename(dirname(key)) === agentName && basename(key) === "agent.md")!;
    expect(recordedKey).toBeDefined();
    const identityBefore = observeEntryIdentity(recordedKey);
    const ledgerBefore = readFileSync(ledgerPath, "utf8");

    // Second launch must hit the cache using the same canonical key (including on case-insensitive macOS APFS).
    const second = f.run(argv);
    expect(second.status, second.stderr).toBe(0);
    expect(observeEntryIdentity(recordedKey)).toBe(identityBefore);
    expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);

    // Targeted Antigravity uninstall must recognize and remove the recorded agent file + dir while keeping the pre-existing Agents dir.
    const removed = runUserUninstall({ target: "antigravity", env: f.env });
    expect(removed.exitCode, removed.lines.join("\n")).toBe(0);
    expect(existsSync(recordedKey)).toBe(false);
    expect(existsSync(dirname(recordedKey))).toBe(false);
    expect(lstatSync(capitalizedAgents).isDirectory()).toBe(true);

    // Case-only rename after publication on case-insensitive volumes (agents -> Agents) still hits cache and uninstalls cleanly.
    rmSync(capitalizedAgents, { recursive: true, force: true });
    const republished = f.run(argv);
    expect(republished.status, republished.stderr).toBe(0);
    const lowercaseAgents = join(configDir, "agents");
    const lowercaseFile = join(lowercaseAgents, agentName, "agent.md");
    const sameVolumeCaseInsensitive = lstatSync(capitalizedAgents, { throwIfNoEntry: false }) !== undefined;
    if (sameVolumeCaseInsensitive) {
      renameSync(lowercaseAgents, capitalizedAgents);
      expect(f.run(argv).status).toBe(0);
      const preview = runUserUninstall({ target: "antigravity", dryRun: true, env: f.env });
      expect(preview.items).toContainEqual(expect.objectContaining({ path: lowercaseFile, action: "restored" }));
      const cleaned = runUserUninstall({ target: "antigravity", env: f.env });
      expect(cleaned.exitCode, cleaned.lines.join("\n")).toBe(0);
      expect(existsSync(join(capitalizedAgents, agentName))).toBe(false);
      expect(existsSync(capitalizedAgents)).toBe(false);
    }
  }));

  test("same-role agy candidates disambiguate by content-addressed name without colliding with each other or user rh-worker", withAgySeat(f => {
    f.configure(AGY_ADVISOR, true, { "worker-neon": AGY_WORKER, "worker-light": AGY_WORKER_NO_GH });
    const agentsDir = join(f.home, ".gemini", "config", "agents");
    const userWorkerDir = join(agentsDir, "rh-worker");
    mkdirSync(userWorkerDir, { recursive: true });
    writeFileSync(join(userWorkerDir, "agent.md"), "---\nname: rh-worker\ndescription: User worker\nmainAgent: true\ntools: [view_file]\n---\n\n# User\n");

    const withGh = JSON.parse(f.run(["argv", "worker-neon", "--json"]).stdout);
    const withoutGh = JSON.parse(f.run(["argv", "worker-light", "--json"]).stdout);
    const withGhName = withGh.argv[withGh.argv.indexOf("--agent") + 1];
    const withoutGhName = withoutGh.argv[withoutGh.argv.indexOf("--agent") + 1];
    expect(withGhName).not.toBe(withoutGhName);

    // Simulate agy fs.ConfigDir agent discovery across ~/.gemini/config/agents/*/agent.md by directory + frontmatter name.
    const discovered = new Map<string, string>();
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const body = readFileSync(join(agentsDir, entry.name, "agent.md"), "utf8");
      const frontmatterName = body.match(/^name:\s*(.+)$/mu)?.[1]?.trim();
      expect(frontmatterName).toBe(entry.name);
      discovered.set(frontmatterName!, body);
    }
    expect(discovered.get(withGhName)).not.toContain("Do not write to GitHub.");
    expect(discovered.get(withoutGhName)).toContain("Do not write to GitHub.");
    expect(discovered.get("rh-worker")).toContain("# User");
  }));

  test("rh seats argv --help states that it materializes Pi fleet roles and agy seat agent directories", withAgySeat(f => {
    const help = f.run(["argv", "--help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("~/.gemini/config/agents");
    expect(help.stdout).toContain("Pi fleet");
  }));

  test("stored main@76675c2 Native preset with read-only agy workers lets unrelated seats render argv while failing closed on read-only agy worker launch", withAgySeat(f => {
    const legacyNativeSeats = {
      ...NATIVE_SEATS_PRESET,
      "worker-neon": { ...NATIVE_SEATS_PRESET["worker-neon"], tools: ["net", "read", "shell"] as const },
      "worker-light": { ...NATIVE_SEATS_PRESET["worker-light"]!, tools: ["net", "read", "shell"] as const },
    };
    writeFileSync(join(f.home, ".repo-harness", "config.json"), JSON.stringify({
      agents: { enabled: ["antigravity", "claude", "codex", "pi"], uses: { docs: [], review: [] }, default_docs: null },
      seats: legacyNativeSeats,
    }));

    const orch = f.run(["argv", "orchestrator", "--json"]);
    expect(orch.status, orch.stderr).toBe(0);
    expect(JSON.parse(orch.stdout).runtime).toBe("claude");

    const adv = f.run(["argv", "advisor", "--json"]);
    expect(adv.status, adv.stderr).toBe(0);
    expect(JSON.parse(adv.stdout).runtime).toBe("agy");

    rmSync(join(f.home, ".gemini", "config", "agents"), { recursive: true, force: true });
    for (const workerSeat of ["worker-neon", "worker-light"] as const) {
      const refused = f.run(["argv", workerSeat, "--json"]);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toBe("");
      const body = JSON.parse(refused.stderr);
      expect(body.error).toBe("seat_tool_not_allowed");
      expect(body.message).toContain(`The ${workerSeat} agy worker seat is configured read-only (missing edit).`);
      expect(body.message).toContain(`Enable edit for seats.${workerSeat}.tools in Settings`);
    }
    expect(existsSync(join(f.home, ".gemini", "config", "agents"))).toBe(false);
    expect(existsSync(join(f.home, ".repo-harness", "seats", "agy"))).toBe(false);
  }));

  test.each([
    "git worktree remove --force ../dirty", "git worktree remove ../dirty --force", "git worktree remove ../dirty -f",
    "git restore -- src/file.ts", "git restore --staged --worktree src/file.ts", "git restore --staged src/file.ts --worktree",
    "git restore --staged --no-staged src/file.ts", "git rm -f src/file.ts", "git rm --force src/file.ts", "git rm src/file.ts --force",
    "git stash drop stash@{0}", "git stash clear",
    "git checkout -- src/file.ts", "git checkout -f main", "git checkout main --force",
    "git switch -f main", "git switch main --discard-changes", "git switch --discard-changes main",
    "git mv src/file.ts dst.ts --force", "git merge --abort",
  ])("an agy worker needs approval for %s", command => {
    const { allow } = agySeatCommandRules("worker", AGY_WORKER);
    expect(allow.find(prefix => command.startsWith(prefix))).toBeUndefined();
  });

  test("an agy worker needs approval for submodule removal and worktree creation or pruning", () => {
    const { allow } = agySeatCommandRules("worker", AGY_WORKER);
    for (const command of ["git rm -- ./submodule", "git worktree add -B existing ../checkout", "git worktree prune"]) {
      expect(allow.find(prefix => command.startsWith(prefix))).toBeUndefined();
    }
  });

  test("an agy orchestrator needs approval for commands outside the coordinator grants", () => {
    const { allow } = agySeatCommandRules("orchestrator", AGY_ORCHESTRATOR);
    for (const command of [
      "git worktree add -B existing ../checkout", "git worktree prune", "rh worktrees prune",
      "git push origin topic --force-with-lease", "git push origin --delete topic", "git push origin topic",
      "gh api repos/org/repo", "gh issue delete 42", "gh run delete 42", "gh pr merge 42 --admin",
      "rh board --parent 42 merge", "hc keys t1", "hc run --help",
    ]) {
      expect(allow.find(prefix => command.startsWith(prefix)), command).toBeUndefined();
    }
  });

  test("an agy orchestrator needs approval for Git commands that can write output files", () => {
    const { allow } = agySeatCommandRules("orchestrator", AGY_ORCHESTRATOR);
    for (const subcommand of ["diff", "log", "show"]) {
      const prefix = `git ${subcommand}`;
      const output = `${prefix} --output=/tmp/existing-user-file`;
      expect(allow.some(rule => prefix.startsWith(rule) || output.startsWith(rule)), output).toBe(false);
    }
  });

  test("a native agy council cannot invoke the advisor's reset commands", () => {
    const { allow, deny } = agySeatCommandRules("council", AGY_FALLBACK);
    expect(deny).toContain("rh seats reset");
    expect(["rh seats reset", "rh seats handoff"].some(command => allow.some(prefix => command.startsWith(prefix)))).toBe(false);
  });

  test("agySeatCommandRules refuses bare command names and mutation-capable prefixes across all allowed seats", () => {
    for (const [seat, config] of [
      ["advisor", AGY_ADVISOR],
      ["council", AGY_FALLBACK],
      ["gatekeeper", AGY_FALLBACK],
      ["worker", AGY_WORKER],
      ["worker-light", AGY_WORKER_NO_GH],
    ] as const) {
      const rules = agySeatCommandRules(seat, config);
      for (const prefix of rules.allow) {
        expect(["git", "gh", "hc", "rh", "bash", "sh", "gh api", "rh board --parent"]).not.toContain(prefix);
      }
      expect(rules.deny).toEqual(expect.arrayContaining(["rh publication merge", "rh board merge", "gh pr merge", "git reset --hard"]));
      if (seat === "council" || seat === "gatekeeper") {
        expect(rules.allow).not.toContain("rh arch refactor decide");
        expect(rules.deny).toContain("rh arch refactor decide");
      }
    }
  });

  test("advisor brief without gh keeps the no-GitHub-write text across Pi, Claude, Codex, and agy", () => {
    const agyInput = { executable: "/usr/local/bin/agy", agentName: "rh-advisor-0123456789ab", cwd: "/tmp/repo" };
    for (const config of [
      { runtime: "pi", model: "magpie/agy-cli/gemini-4-neon", advisor_model: null, effort: "xhigh", tools: ["mcp", "net", "read", "shell"], fleet: [] },
      { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: ["mcp", "net", "read", "shell"], fleet: [] },
      { runtime: "codex", model: "gpt-6.2-sol", advisor_model: null, effort: "high", tools: ["mcp", "net", "read", "shell"], fleet: [] },
      { runtime: "agy", model: "gemini-4-neon-high", advisor_model: null, effort: null, tools: AGY_ADVISOR_SEAT_TOOLS, fleet: [] },
    ] as const) {
      const result = buildSeatLaunch("advisor", config, "seats", [], config.runtime === "agy" ? { agy: agyInput } : {});
      expect(result.brief).toContain("You do not commit or write to GitHub.");
      expect(result.brief).toContain("Do not write to GitHub.");
      expect(result.brief).not.toContain("gh issue comment");
      expect(result.brief).not.toContain("gh pr comment");
      expect(result.brief).not.toContain("gh issue create");
    }
  });

  test("advisor brief with gh allows only gh issue comment, gh pr comment, and gh issue create across Pi, Claude, Codex, and agy", () => {
    const agyInput = { executable: "/usr/local/bin/agy", agentName: "rh-advisor-0123456789ab", cwd: "/tmp/repo" };
    for (const config of [
      { runtime: "pi", model: "magpie/agy-cli/gemini-4-neon", advisor_model: null, effort: "xhigh", tools: ["gh", "mcp", "net", "read", "shell", "tasks"], fleet: [] },
      { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: ["gh", "mcp", "net", "read", "shell", "tasks"], fleet: [] },
      { runtime: "codex", model: "gpt-6.2-sol", advisor_model: null, effort: "high", tools: ["gh", "mcp", "net", "read", "shell"], fleet: [] },
      { runtime: "agy", model: "gemini-4-neon-high", advisor_model: null, effort: null, tools: AGY_ADVISOR_ALLOWED_SEAT_TOOLS, fleet: [] },
    ] as const) {
      const result = buildSeatLaunch("advisor", config, "seats", [], config.runtime === "agy" ? { agy: agyInput } : {});
      expect(result.brief).toContain("You may write to GitHub only with `gh issue comment`, `gh pr comment`, and `gh issue create` (end each comment with `Seat: advisor <hc address>`).");
      expect(result.brief).toContain("Do not commit, push, merge, close or reopen, label, edit issue or PR bodies, review, or release.");
      expect(result.brief).not.toContain("You do not commit or write to GitHub.");
      expect(result.brief).not.toContain("Do not write to GitHub.");
    }
  });

  test("Claude advisor with gh keeps all non-allowed GitHub and git push denials while other Claude seats with gh drop them", () => {
    const disallowed = (argv: readonly string[]): readonly string[] => {
      const start = argv.indexOf("--disallowedTools");
      if (start === -1) return [];
      const end = argv.indexOf("--append-system-prompt", start);
      return argv.slice(start + 1, end === -1 ? argv.length : end);
    };
    const nonAllowed = [
      "Bash(gh issue close *)", "Bash(gh issue edit *)", "Bash(gh pr close *)", "Bash(gh pr create *)",
      "Bash(gh pr edit *)", "Bash(gh pr merge *)", "Bash(gh pr review *)", "Bash(gh release create *)", "Bash(git push *)",
    ];
    const allowed = ["Bash(gh issue comment *)", "Bash(gh pr comment *)", "Bash(gh issue create *)"];

    const withoutGh = buildSeatLaunch("advisor", { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: ["mcp", "net", "read", "shell"], fleet: [] }, "seats", []);
    expect(disallowed(withoutGh.argv)).toEqual(expect.arrayContaining([...nonAllowed, ...allowed]));

    const withGh = buildSeatLaunch("advisor", { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: ["gh", "mcp", "net", "read", "shell"], fleet: ["explorer"] }, "seats", ["explorer", "Plan"]);
    expect(disallowed(withGh.argv)).toEqual([...nonAllowed, "Agent(Plan)"]);
    for (const item of allowed) expect(disallowed(withGh.argv)).not.toContain(item);

    const withGhNoFleet = buildSeatLaunch("advisor", { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: ["gh", "mcp", "net", "read", "shell"], fleet: [] }, "seats", []);
    expect(disallowed(withGhNoFleet.argv)).toEqual(nonAllowed);

    const withGhNoShell = buildSeatLaunch("advisor", { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: ["gh", "mcp", "net", "read"], fleet: [] }, "seats", []);
    expect(disallowed(withGhNoShell.argv)).toEqual([]);

    for (const [seat, tools] of [
      ["orchestrator", DEFAULT_SEATS_CONFIG.orchestrator.tools],
      ["worker-opus", DEFAULT_SEATS_CONFIG["worker-opus"].tools],
    ] as const) {
      const sibling = buildSeatLaunch(seat, { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools, fleet: [] }, "seats", []);
      expect(disallowed(sibling.argv)).toEqual([]);
    }
  });

  test("agy advisor keeps gh and tasks off in the Native preset and grants only comment and intake issue writes when gh is enabled", () => {
    expect(NATIVE_SEATS_PRESET.advisor.tools).not.toContain("gh");
    expect(NATIVE_SEATS_PRESET.advisor.tools).not.toContain("tasks");
    const withoutGh = agySeatCommandRules("advisor", NATIVE_SEATS_PRESET.advisor);
    for (const allowed of ["gh issue comment", "gh pr comment", "gh issue create"]) {
      expect(withoutGh.allow).not.toContain(allowed);
      expect(withoutGh.deny).toContain(allowed);
    }

    const withGh = agySeatCommandRules("advisor", { ...AGY_ADVISOR, tools: AGY_ADVISOR_ALLOWED_SEAT_TOOLS });
    expect(withGh.allow).toEqual(expect.arrayContaining(["gh issue comment", "gh pr comment", "gh issue create"]));
    for (const allowed of ["gh issue comment", "gh pr comment", "gh issue create"]) {
      expect(withGh.deny).not.toContain(allowed);
    }
    expect(withGh.deny).toEqual(expect.arrayContaining([
      "gh issue close", "gh issue edit", "gh pr close", "gh pr create",
      "gh pr edit", "gh pr merge", "gh pr review", "gh release create", "git push", "gh run rerun",
    ]));
    for (const forbidden of [
      "gh issue close 3468", "gh issue reopen 3468", "gh issue edit 3468 --add-label tier:medium",
      "gh issue delete 3468 --yes", "gh pr close 3467", "gh pr reopen 3467", "gh pr create --title x",
      "gh pr edit 3467 --body x", "gh pr merge 3467 --squash", "gh pr review 3467 --approve",
      "gh release create v0.37.0", "gh label create foo", "gh api repos/org/repo/issues/1/comments",
      "gh run rerun 123", "git commit -m test", "git push origin main",
    ]) {
      expect(withGh.allow.find(prefix => forbidden.startsWith(prefix)), forbidden).toBeUndefined();
    }
  });

  test("orchestrator and advisor require the herdr skill and explicit pane placement across Claude, Pi, and agy while review seats keep --no-skills", () => {
    const agyInput = (seat: "orchestrator" | "advisor") => ({
      executable: "/usr/local/bin/agy",
      agentName: `rh-${seat}-0123456789ab`,
      cwd: "/tmp/repo",
    });
    const herdrRequirement = "Load the `herdr` skill at session start before any `hc` or `herdr-app` read, send, or pane operation.";

    for (const [seat, configs] of [
      ["orchestrator", [
        { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: DEFAULT_SEATS_CONFIG.orchestrator.tools, fleet: ["explorer"] },
        { runtime: "pi", model: "magpie/agy-cli/gemini-4-neon", advisor_model: null, effort: "high", tools: DEFAULT_SEATS_CONFIG.orchestrator.tools, fleet: ["explorer"] },
        AGY_ORCHESTRATOR,
      ]],
      ["advisor", [
        { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: ["mcp", "net", "read", "shell"], fleet: ["explorer"] },
        { runtime: "pi", model: "magpie/agy-cli/gemini-4-neon", advisor_model: null, effort: "xhigh", tools: ["mcp", "net", "read", "shell"], fleet: ["explorer"] },
        AGY_ADVISOR,
      ]],
    ] as const) {
      for (const config of configs) {
        const result = buildSeatLaunch(seat, config, "seats", [], config.runtime === "agy" ? { agy: agyInput(seat) } : {});
        expect(result.brief, `${seat}:${config.runtime}`).toContain(herdrRequirement);
        if (seat === "orchestrator") {
          expect(result.brief, `${seat}:${config.runtime}`).toContain("`rh seats launch <seat>` or `rh board dispatch`");
          expect(result.brief, `${seat}:${config.runtime}`).toContain("resolve an explicit `--pane <id>` with `herdr-app ls` and never rely on `pane.focus` with an untargeted `pane.split`");
          expect(result.brief, `${seat}:${config.runtime}`).not.toContain("with `rh seats argv <seat>`");
        }
        if (config.runtime === "claude") {
          expect(tools([...result.argv]), `${seat}:claude`).toContain("Skill");
        }
        if (config.runtime === "pi") {
          expect(result.argv, `${seat}:pi`).not.toContain("--no-skills");
        }
      }
    }

    expect(agySeatCommandRules("orchestrator", AGY_ORCHESTRATOR).allow).toContain("herdr-app ls");

    const claudeReviewer = buildSeatLaunch("reviewer", { runtime: "claude", model: "opus", advisor_model: null, effort: "high", tools: ["net", "read", "shell"], fleet: [] }, "seats", []);
    expect(tools([...claudeReviewer.argv])).not.toContain("Skill");
    expect(claudeReviewer.brief).not.toContain(herdrRequirement);

    for (const reviewSeat of ["gatekeeper", "reviewer"] as const) {
      const piReview = buildSeatLaunch(reviewSeat, { runtime: "pi", model: "magpie/codex/gpt-6.2-sol", advisor_model: null, effort: "high", tools: ["net", "read", "shell"], fleet: [] }, "seats", [], { piHookExtension: "/tmp/ext.ts" });
      expect(piReview.argv, reviewSeat).toContain("--no-skills");
      expect(piReview.brief, reviewSeat).not.toContain(herdrRequirement);
    }
  });

  test("every agy seat launches with --dangerously-skip-permissions and preserves --settings trustedWorkspaces and command rules", () => {
    const cwd = "/tmp/repo";
    for (const [seat, config, agentName] of [
      ["orchestrator", AGY_ORCHESTRATOR, "rh-orchestrator-0123456789ab"],
      ["advisor", AGY_ADVISOR, "rh-advisor-0123456789ab"],
      ["worker-neon", AGY_WORKER, "rh-worker-0123456789ab"],
      ["worker-light", AGY_WORKER_NO_GH, "rh-worker-0123456789ab"],
      ["council", AGY_FALLBACK, "rh-council-0123456789ab"],
      ["gatekeeper", AGY_FALLBACK, "rh-gatekeeper-fallback-0123456789ab"],
    ] as const) {
      const result = buildSeatLaunch(seat, config, "seats", [], { agy: { executable: "/usr/local/bin/agy", agentName, cwd } });
      expect(result.argv, seat).toContain("--dangerously-skip-permissions");
      expect(result.argv, seat).not.toContain("--mode");
      expect(result.argv, seat).not.toContain("accept-edits");
      const settings = JSON.parse(result.argv[result.argv.indexOf("--settings") + 1]!);
      const rules = agySeatCommandRules(seat, config);
      expect(settings, seat).toEqual({
        trustedWorkspaces: [cwd],
        permissions: {
          allow: rules.allow.map(command => `command(${command})`),
          deny: rules.deny.map(command => `command(${command})`),
        },
      });
    }
  });

  test("rh seats argv emits honest agy limit lines under --dangerously-skip-permissions", withAgySeat(f => {
    expect(agySeatLimits("advisor", AGY_ADVISOR)).toEqual([
      { subject: "tasks", level: "instructions_only" },
      { subject: "gh", level: "common_commands" },
      { subject: "fleet", level: "instructions_only" },
      { subject: "hook", level: "common_commands" },
    ]);
    expect(agySeatLimits("worker-neon", AGY_WORKER)).toEqual([
      { subject: "tasks", level: "instructions_only" },
      { subject: "schedule", level: "instructions_only" },
      { subject: "mcp", level: "instructions_only" },
      { subject: "fleet", level: "instructions_only" },
      { subject: "hook", level: "common_commands" },
    ]);
    expect(agySeatLimits("council", AGY_FALLBACK)).toEqual([
      { subject: "edit", level: "common_commands" },
      { subject: "tasks", level: "instructions_only" },
      { subject: "schedule", level: "instructions_only" },
      { subject: "mcp", level: "instructions_only" },
      { subject: "gh", level: "common_commands" },
      { subject: "fleet", level: "instructions_only" },
      { subject: "hook", level: "common_commands" },
    ]);

    f.configure(AGY_ADVISOR, true, { orchestrator: AGY_ORCHESTRATOR });
    const plain = f.run(["argv", "orchestrator"]);
    expect(plain.status, plain.stderr).toBe(0);
    const parsedArgv = JSON.parse(plain.stdout) as string[];
    expect(parsedArgv).toContain("--dangerously-skip-permissions");
    expect(parsedArgv).not.toContain("--mode");
    expect(parsedArgv).not.toContain("accept-edits");
    expect(parsedArgv).toContain("--settings");
    const limitLines = plain.stderr.trim().split("\n").filter(line => line.startsWith("limit "));
    expect(limitLines).toEqual([
      "limit edit: common_commands",
      "limit schedule: instructions_only (written into the launch instructions only)",
      "limit fleet: instructions_only (written into the launch instructions only)",
      "limit hook: common_commands",
    ]);
  }));
});

describe("rh seats argv", () => {
  test("a Pi seat launch refuses a shell that fails the heredoc probe, passes a good one and reports a shell that cannot start", () => {
    const seats = { ...DEFAULT_SEATS_CONFIG, "worker-light": { runtime: "pi", model: null, effort: null, tools: DEFAULT_SEATS_CONFIG.worker.tools, fleet: [] } };
    withHome(seats, home => {
      const settings = join(home, ".pi", "agent", "settings.json");
      writeFileSync(settings, JSON.stringify({ shellPath: stubShell(home, "bad-shell", BAD_PROBE_OUTPUT) }));
      const refused = argv(home, "worker-light", "--json");
      expect([refused.status, refused.stdout, JSON.parse(refused.stderr).error]).toEqual([1, "", "pi_shell_refused"]);
      expect(JSON.parse(refused.stderr).message).toContain("shellPath");
      writeFileSync(settings, JSON.stringify({ shellPath: join(home, "missing-shell") }));
      expect(JSON.parse(argv(home, "worker-light", "--json").stderr).error).toBe("pi_shell_probe_failed");
      // The project settings file overrides the global one for shellPath, as Pi merges them.
      mkdirSync(join(home, ".pi"), { recursive: true });
      writeFileSync(join(home, ".pi", "settings.json"), JSON.stringify({ shellPath: stubShell(home, "project-shell", GOOD_PROBE_OUTPUT) }));
      expect(run({ HOME: home }, ["worker-light", "--json"], home).status).toBe(0);
      // A shell that does not finish is its own error.
      const slow = join(home, "slow-shell");
      writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n");
      chmodSync(slow, 0o755);
      writeFileSync(join(home, ".pi", "settings.json"), JSON.stringify({ shellPath: slow }));
      expect(JSON.parse(run({ HOME: home }, ["worker-light", "--json"], home).stderr).error).toBe("pi_shell_probe_failed");
      rmSync(join(home, ".pi", "settings.json"));
      // A Claude seat does not probe: the same refusing settings leave it unchanged.
      writeFileSync(settings, JSON.stringify({ shellPath: stubShell(home, "bad-shell", BAD_PROBE_OUTPUT) }));
      expect(argv(home, "orchestrator", "--json").status).toBe(0);
    });
  });

  test("an empty project shellPath selects the default shell, and a path that is not absolute is refused", async () => {
    const home = mkdtempSync(join(tmpdir(), "pi-shell-"));
    try {
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ shellPath: stubShell(home, "global-shell", BAD_PROBE_OUTPUT) }));
      writeFileSync(join(home, ".pi", "settings.json"), JSON.stringify({ shellPath: "" }));
      const env = { HOME: home };
      await expect(assertPiShell(env, home, stubShell(home, "default-shell", GOOD_PROBE_OUTPUT))).resolves.toBeUndefined();
      for (const bad of ["~/bin/bash", "bin/bash"]) {
        writeFileSync(join(home, ".pi", "settings.json"), JSON.stringify({ shellPath: bad }));
        await expect(assertPiShell(env, home)).rejects.toMatchObject({ code: "pi_shell_refused", message: expect.stringContaining(`"${bad}"`) });
      }
      await expect(assertPiShell({ ...env, PI_CODING_AGENT_DIR: "~/agent" }, home)).rejects.toMatchObject({ code: "pi_shell_refused" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an old seats section fails closed with the update action", () => {
    const seats = { orchestrator: DEFAULT_SEATS_CONFIG.orchestrator, advisor: DEFAULT_SEATS_CONFIG.advisor, worker: DEFAULT_SEATS_CONFIG.worker };
    withHome(seats, home => {
      const result = argv(home, "worker", "--json");
      expect([result.status, result.stdout]).toEqual([1, ""]);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "seats_config_migration_required", next_action: "rh update" });
    });
  });

  test("a fully configured seat with a retired role refuses launch and directs the user to update", () => {
    const worker = { ...DEFAULT_SEATS_CONFIG.worker, fleet: ["explorer", "harness-evaluator"] };
    withHome({ ...DEFAULT_SEATS_CONFIG, worker }, home => {
      const result = argv(home, "worker", "--json");
      expect([result.status, result.stdout]).toEqual([1, ""]);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: "seats_config_migration_required", next_action: "rh update" });
    });
  });

  test("an unconfigured worker-light fails with seat_not_configured", () => {
    const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-light': null,
      routing: { ...DEFAULT_SEATS_CONFIG.routing, important_fast: ['worker-opus', 'worker-neon', 'worker'] as const, simple_fast: ['worker'] as const } };
    withHome(seats, home => {
      const result = argv(home, "worker-light", "--json");
      expect([result.status, result.stdout]).toEqual([1, ""]);
      expect(JSON.parse(result.stderr).error).toBe("seat_not_configured");
    });
  });

  test("saving routes reject a non-Pi worker-light; its launch is judged on its own account", () => {
    for (const configured of [DEFAULT_SEATS_CONFIG.worker, DEFAULT_SEATS_CONFIG['worker-opus']]) {
      const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-light': { ...configured, fleet: [] },
        routing: { ...DEFAULT_SEATS_CONFIG.routing, important_deep: ['worker-light'] as const, important_fast: ['worker-light'] as const, simple_fast: ['worker-light', 'worker'] as const } };
      withHome(seats, home => {
        const initial = argv(home, 'worker-light', '--json');
        expect(initial.status, initial.stderr).toBe(0);
        mkdirSync(join(home, '.repo-harness', 'quota'));
        for (const used of [81, 95]) {
          writeFileSync(join(home, '.repo-harness', 'quota', 'claude.json'), JSON.stringify({ observed_at: new Date().toISOString(), rate_limits: {
            seven_day: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          } }));
          const quota = seatAccountQuotas([classifyQuotaReading(readClaudeQuota({ HOME: home }), Date.now())], seats.routing);
          const result = argv(home, 'worker-light', '--json');
          expect({
            routes: formatSeatRoutes(seats, quota).split('\n').filter(line => /^route important_/u.test(line)),
            launch: [result.status, result.stdout, result.stderr ? JSON.parse(result.stderr).error : null],
          }).toEqual({
            routes: configured.runtime === 'pi'
              ? ['route important_deep: worker-light (pi magpie/codex/gpt-6.2-sol high; chatgpt unknown)', 'route important_fast: worker-light (pi magpie/codex/gpt-6.2-sol high; chatgpt unknown)']
              : [`route important_deep: none (claude ${used === 95 ? 'exhausted' : 'normal'}, reserved for advisor and orchestrator)`, `route important_fast: none (claude ${used === 95 ? 'exhausted' : 'normal'}, reserved for advisor and orchestrator)`],
            launch: configured.runtime === 'pi' ? [0, expect.any(String), null]
              : [1, '', used === 95 ? 'seat_quota_exhausted' : 'seat_quota_reserved'],
          });
        }
      });
    }
  });

  test("every configured worker seat keeps its brief, labels and issue pane naming", () => {
    const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-light': { runtime: 'pi', model: null, effort: null, tools: DEFAULT_SEATS_CONFIG.worker.tools, fleet: [] } };
    withHome(seats, home => withRepository(home, "rh", repo => {
      for (const seat of WORKER_SEAT_IDS) {
        const result = run(registryEnv(home), [seat, "--repository-id", "1", "--issue", "1925", "--parent", "1924", "--json"], repo);
        expect(result.status, result.stderr).toBe(0);
        const value = JSON.parse(result.stdout);
        expect(value.runtime).toBe(seats[seat]?.runtime);
        if (seat === 'worker-neon-deep') {
          const modelArgs = value.argv.indexOf('--provider');
          expect(value.argv.slice(modelArgs, modelArgs + 6)).toEqual(['--provider', 'magpie', '--model', 'agy-cli/gemini-4-neon', '--thinking', 'xhigh']);
        }
        expect(value.brief).toContain("You are a worker seat.");
        expect(value.labels).toContain(`repo-harness.seat=${seat}`);
        expect([value.name, value.tab]).toEqual(["rh-w-1925", "#1925"]);
      }
    }));
  });

  test("gatekeeper and reviewer require a PR and launch read-only reviews; gatekeeper-deep is retired", () => {
    const seats = { ...DEFAULT_SEATS_CONFIG, gatekeeper: { ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: "codex" as const, model: "gpt-6.2-sol" } };
    withHome(seats, home => withRepository(home, "rh", repo => {
      for (const [seat, role] of [["gatekeeper", "gk"], ["reviewer", "rv"]] as const) {
        const missing = argv(home, seat, "--json");
        expect([missing.status, JSON.parse(missing.stderr).error]).toEqual([1, "pane_name_invalid"]);
        const bare = argv(home, seat, "--pr", "1925", "--json");
        expect(bare.status, bare.stderr).toBe(0);
        const result = run(registryEnv(home), [seat, "--repository-id", "1", "--pr", "1925", "--json"], repo);
        expect(result.status, result.stderr).toBe(0);
        const value = JSON.parse(result.stdout);
        expect([value.name, value.tab]).toEqual([`rh-${role}-1925`, "PR#1925"]);
        expect(value.brief).toContain("Do not edit files, commit, push, or write to GitHub. Report the verdict first");
        expect(value.brief).not.toContain("rh review publish");
        expect(value.brief).not.toContain("You are a worker seat");
        if (seat !== "reviewer") {
          expect(agent(value)).toContain("read-only");
          expect(agent(value)).not.toContain('web_search="disabled"');
        } else expect(tools(agent(value))).toEqual(["WebFetch", "WebSearch", "Read", "Glob", "Grep", "Bash", "Monitor", "TaskStop"]);
        expect(value.brief).not.toContain("Do not use the network.");
      }
      const retired = argv(home, "gatekeeper-deep", "--pr", "1925", "--json");
      expect([retired.status, JSON.parse(retired.stderr).error]).toEqual([1, "seat_unknown"]);
      expect(LAUNCH_SEAT_IDS).toEqual(["orchestrator", "advisor", "council", "worker", "worker-deep", "worker-opus", "worker-neon", "worker-neon-deep", "worker-light", "gatekeeper", "reviewer"]);
    }));
  });

  test("Pi review seats exclude edit and write tools and report the shell path as common_commands", () => {
    for (const seat of ["gatekeeper", "reviewer"] as const) {
      withHome({ ...DEFAULT_SEATS_CONFIG, [seat]: { ...DEFAULT_SEATS_CONFIG[seat], runtime: "pi", model: null, effort: null } }, home => {
        const result = argv(home, seat, "--pr", "1928", "--json");
        expect(result.status, result.stderr).toBe(0);
        const value = JSON.parse(result.stdout);
        expect(bare(value.argv).slice(0, 10)).toEqual(["pi", "--exclude-tools", "edit,write",
          "--no-extensions", "-e", join(home, ".bun", "install", "global", "node_modules", "repo-harness", "src", "pi", "extension.ts"),
          "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp"]);
        expect(value.limits).toContainEqual({ subject: "edit", level: "common_commands" });
        expect(value.limits).toContainEqual({ subject: "hook", level: "enforced" });
      });
    }
  });

  test("a Pi review seat refuses to launch without the installed Pi extension", () => {
    withHome({ ...DEFAULT_SEATS_CONFIG, reviewer: { ...DEFAULT_SEATS_CONFIG.reviewer, runtime: "pi", model: null, effort: null } }, home => {
      rmSync(join(home, ".bun"), { recursive: true });
      const result = argv(home, "reviewer", "--pr", "1928", "--json");
      expect([result.status, JSON.parse(result.stderr).error]).toEqual([1, "pi_extension_missing"]);
    });
  });

  test("an exhausted gatekeeper account launches the fallback seat as the gatekeeper; gatekeeper-fallback is no launch target", () => {
    const fallback = { ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: "pi" as const, model: "magpie/group/deepseek-v4.1-flash", effort: null };
    withHome({ ...DEFAULT_SEATS_CONFIG, "gatekeeper-fallback": fallback }, home => {
      const gatekeeper = () => JSON.parse(argv(home, "gatekeeper", "--pr", "2253", "--json").stdout);
      writeFileSync(join(home, "codex-used"), "60");
      expect(bare(gatekeeper().argv).slice(0, 5)).toEqual(["pi", "--provider", "magpie", "--model", "codex/gpt-6.2-sol"]);
      writeFileSync(join(home, "codex-used"), "97");
      const value = gatekeeper();
      expect([value.seat, value.runtime, bare(value.argv).slice(0, 5)]).toEqual(["gatekeeper", "pi", ["pi", "--provider", "magpie", "--model", "group/deepseek-v4.1-flash"]]);
      expect(value.brief).toContain("You are the gatekeeper seat.");
      const refused = argv(home, "gatekeeper-fallback", "--pr", "2253", "--json");
      expect([refused.status, JSON.parse(refused.stderr).error]).toEqual([1, "seat_unknown"]);
    });
  });

  test("Pi worker and review seats pass the configured provider and model", () => {
    for (const seat of ["worker", "reviewer"] as const) {
      const config = { ...DEFAULT_SEATS_CONFIG[seat], runtime: "pi", model: "magpie/cursor/deepseek-v41-flash-1017", effort: null, fleet: [] };
      withHome({ ...DEFAULT_SEATS_CONFIG, [seat]: config }, home => {
        const result = argv(home, seat, ...(seat === "reviewer" ? ["--pr", "1950"] : []), "--json");
        expect(result.status, result.stderr).toBe(0);
        const value = JSON.parse(result.stdout);
        expect(bare(value.argv).slice(0, 5)).toEqual(["pi", "--provider", "magpie", "--model", "cursor/deepseek-v41-flash-1017"]);
        if (seat === "reviewer") expect(bare(value.argv).slice(5, 14)).toEqual(["--exclude-tools", "edit,write", "--no-extensions", "-e", join(home, ".bun", "install", "global", "node_modules", "repo-harness", "src", "pi", "extension.ts"), "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp"]);
      });
    }
  });

  test.each([
    ["claude", "claude-opus-9", ["--model", "claude-opus-9"]],
    ["codex", "gpt-7-nova", ["-m", "gpt-7-nova"]],
    ["pi", "acme/mystery-1", ["--provider", "acme", "--model", "mystery-1"]],
  ] as const)("a user-set %s model id outside the recommended list reaches the argv (#3250)", (runtime, model, flags) => {
    const worker = { ...DEFAULT_SEATS_CONFIG.worker, runtime, model, fleet: [] };
    withHome({ ...DEFAULT_SEATS_CONFIG, worker }, home => {
      const result = argv(home, "worker", "--json");
      expect(result.status, result.stderr).toBe(0);
      const args = bare(JSON.parse(result.stdout).argv);
      expect(args.slice(args.indexOf(flags[0]), args.indexOf(flags[0]) + flags.length)).toEqual([...flags]);
    });
  });

  test("a Pi GPT worker passes configured thinking and model, and draws on the ChatGPT account", () => {
    const worker = { ...DEFAULT_SEATS_CONFIG.worker, runtime: "pi" as const, model: "magpie/codex/gpt-6.1-terra", fleet: [] };
    withHome({ ...DEFAULT_SEATS_CONFIG, worker }, home => {
      writeFileSync(join(home, 'codex-used'), '51');
      expect(bare(launch(home, "worker").argv).slice(0, 7)).toEqual(["pi", "--provider", "magpie", "--model", "codex/gpt-6.1-terra", "--thinking", "high"]);
      writeFileSync(join(home, 'codex-used'), '10');
      expect(bare(launch(home, "worker").argv).slice(0, 7)).toEqual(["pi", "--provider", "magpie", "--model", "codex/gpt-6.1-terra", "--thinking", "high"]);
      writeFileSync(join(home, 'codex-used'), '95');
      const exhausted = argv(home, "worker", "--json");
      expect([exhausted.status, JSON.parse(exhausted.stderr).error]).toEqual([1, "seat_quota_exhausted"]);
    });
    const seats = { ...DEFAULT_SEATS_CONFIG, worker };
    expect(formatSeatRoutes(seats, seatAccountQuotas([], seats.routing))).toContain("route simple_fast: worker-light (pi zai/glm-5.3-flash)");
    // The rh quota routes show only a shipped recommended id; any other id, such as a pasted secret, shows as its seat field (#3250).
    const pasted = { ...seats, worker: { ...worker, model: "magpie/o3sk-live-0123456789" }, gatekeeper: { ...seats.gatekeeper, runtime: "codex" as const, model: "o3sk-live-0123456789" },
      routing: { ...seats.routing, simple_fast: ["worker"] as const } };
    const routes = formatSeatRoutes(pasted, seatAccountQuotas([], pasted.routing));
    expect(routes).not.toContain("o3sk-live-0123456789");
    expect(routes).toContain("route simple_fast: worker (pi seats.worker.model high)");
    expect(routes).toContain("gatekeeper: gatekeeper (codex seats.gatekeeper.model");
    const reading = decodeCodexRateLimitsResult({ rateLimits: { primary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 84 * 3600 } } }, new Date().toISOString());
    expect(formatSeatRoutes({ ...seats, routing: { ...seats.routing, simple_fast: ["worker"] as const } }, seatAccountQuotas([classifyQuotaReading(reading, Date.now())], seats.routing))).toContain("route simple_fast: none (chatgpt exhausted)");
  });

  test("an exhausted or reserved agy Gemini group blocks workers while keeping advisor and Claude/GPT seats available", () => {
    const gemini = { ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: "pi" as const, model: "magpie/agy-cli/gemini-4-neon" };
    const other = { ...gemini, model: "magpie/agy-cli/claude-opus-5-5" };
    withHome({ ...DEFAULT_SEATS_CONFIG, worker: gemini, 'worker-deep': other, gatekeeper: gemini, 'gatekeeper-fallback': other }, home => {
      const agy = join(home, '.quota-bin', 'agy'), log = join(home, 'agy-calls');
      const writeAgy = (weekly: number) => writeFileSync(agy, `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
require('node:fs').appendFileSync(${JSON.stringify(log)}, args + '\\n');
if (args === '--help') { console.log('Usage of agy: --conversation'); process.exit(0); }
if (args === '--version') { console.log('1.5.12'); process.exit(0); }
if (args === 'models') process.exit(0);
if (args !== '-p /usage --output-format json') process.exit(9);
const hour = 3_600_000;
const bucket = (window, remaining_fraction, hours) => ({ id: window, name: window, window, remaining_fraction,
  reset_time: new Date(Date.now() + hours * hour).toISOString() });
const group = (name, weekly) => ({ name, buckets: [bucket('weekly', weekly, 84), bucket('5h', 0.9, 2)] });
const groups = [group('Gemini Models', ${weekly}), group('Claude and GPT models', 0.62)];
console.log(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups } } }));
`, { mode: 0o755 });
      writeAgy(0);
      const exhausted = argv(home, "worker", "--json");
      expect(exhausted.status).toBe(1);
      expect(JSON.parse(exhausted.stderr)).toMatchObject({ error: 'seat_quota_exhausted', message: expect.stringContaining('agy_gemini account is exhausted') });
      expect(bare(launch(home, 'worker-deep').argv)).toContain('agy-cli/claude-opus-5-5');
      const fallback = argv(home, "gatekeeper", "--pr", "3288", "--json");
      expect(fallback.status, fallback.stderr).toBe(0);
      expect(bare(JSON.parse(fallback.stdout).argv)).toContain('agy-cli/claude-opus-5-5');
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(Array.from({ length: 3 }, () => ['--help', '--version', 'models', '-p /usage --output-format json']).flat());
      writeAgy(0.24);
      const reserved = argv(home, "worker-neon", "--json");
      expect([reserved.status, JSON.parse(reserved.stderr).error]).toEqual([1, "seat_quota_reserved"]);
      expect(argv(home, "advisor", "--json").status).toBe(0);
    });
  });

  test("a Neon Pi advisor gets its own read-only roles on the default or overridden model", () => {
    const advisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "pi" as const, model: "magpie/agy-cli/gemini-4-neon" };
    const seats = { ...DEFAULT_SEATS_CONFIG, advisor };
    withHome(seats, home => {
      const neon = launch(home, "advisor");
      const [assignment, command, providerFlag, provider, modelFlag, model] = bare(neon.argv) as string[];
      const directory = assignment!.replace("PI_SUBAGENT_EXTRA_AGENT_DIRS=", "");
      expect(directory.startsWith(join(realpathSync(home), ".repo-harness", "seats", "pi-fleet"))).toBe(true);
      expect([command, providerFlag, provider, modelFlag, model]).toEqual(["pi", "--provider", "magpie", "--model", "agy-cli/gemini-4-neon"]);
      expect(readdirSync(directory).sort()).toEqual(["rh-deep-reasoner.md", "rh-explorer.md"]);
      const explorer = readFileSync(join(directory, "rh-explorer.md"), "utf8");
      expect(explorer).toContain("name: rh-explorer\n");
      expect(explorer).toContain(`model: ${JSON.stringify(DEFAULT_SEATS_CONFIG["worker-light"]!.model)}\nthinking: high\ntools: read, grep, find, ls, bash\n`);
      const reasoner = readFileSync(join(directory, "rh-deep-reasoner.md"), "utf8");
      expect(reasoner).toContain('model: "magpie/codex/gpt-6.2-sol"\nthinking: high\ntools: read, grep, find, ls, bash\n');
      expect(neon.brief).toContain("Collect evidence through your sub-agents: `rh-deep-reasoner`, `rh-explorer`.");
      expect(neon.limits).toContainEqual({ subject: "fleet", level: "instructions_only" });

      const override = "magpie/group/deepseek-v4.1-flash";
      writeFileSync(join(home, ".repo-harness", "config.json"), JSON.stringify({ seats: { ...seats, pi_sub_agent_models: { explorer: override } } }));
      const overridden = String(bare(launch(home, "advisor").argv)[0]).replace("PI_SUBAGENT_EXTRA_AGENT_DIRS=", "");
      expect(overridden).not.toBe(directory);
      expect(readFileSync(join(overridden, "rh-explorer.md"), "utf8")).toContain(`model: ${JSON.stringify(override)}\n`);
      expect(readFileSync(join(overridden, "rh-deep-reasoner.md"), "utf8")).toBe(reasoner);
      const light = launch(home, "worker-light");
      expect(bare(light.argv)[0]).toBe("pi");
      expect(light.brief).toContain("You have no sub-agents.");
    });
  });

  test("Pi reset seats inject REPO_HARNESS_SEAT* only with repositoryId while Pi workers never inject them", () => {
    const piOrchestrator = buildSeatLaunch("orchestrator", { runtime: "pi", model: "magpie/agy-cli/gemini-4-neon", advisor_model: null, effort: "xhigh", tools: ["read", "shell", "net", "tasks", "gh"], fleet: [] }, "seats", [], { repositoryId: "12345" });
    expect(bare([...piOrchestrator.argv]).slice(0, 5)).toEqual([
      "REPO_HARNESS_SEAT=orchestrator",
      "REPO_HARNESS_SEAT_REPOSITORY=12345",
      "REPO_HARNESS_SEAT_MODEL=magpie/agy-cli/gemini-4-neon",
      "REPO_HARNESS_SEAT_EFFORT=xhigh",
      "pi",
    ]);
    expect(values([...piOrchestrator.argv], "--exclude-tools")).toEqual(["ask_user_question"]);
    expect(piOrchestrator.argv).not.toContain("--no-extensions");
    expect(piOrchestrator.brief).toContain("Do not call a blocking question tool");

    const piAdvisor = buildSeatLaunch("advisor", { runtime: "pi", model: "magpie/agy-cli/gemini-4-neon", advisor_model: null, effort: "xhigh", tools: ["read", "shell", "net"], fleet: [] }, "seats", [], { repositoryId: "12345" });
    expect(bare([...piAdvisor.argv]).slice(0, 5)).toEqual([
      "REPO_HARNESS_SEAT=advisor",
      "REPO_HARNESS_SEAT_REPOSITORY=12345",
      "REPO_HARNESS_SEAT_MODEL=magpie/agy-cli/gemini-4-neon",
      "REPO_HARNESS_SEAT_EFFORT=xhigh",
      "pi",
    ]);
    expect(values([...piAdvisor.argv], "--exclude-tools")).toEqual([]);
    const piAdvisorUnlabeled = buildSeatLaunch("advisor", { runtime: "pi", model: "magpie/agy-cli/gemini-4-neon", advisor_model: null, effort: "xhigh", tools: ["read", "shell", "net"], fleet: [] }, "seats", []);
    expect(bare([...piAdvisorUnlabeled.argv])[0]).toBe("pi");
    const piWorker = buildSeatLaunch("worker", { runtime: "pi", model: "magpie/agy-cli/gemini-4-neon", advisor_model: null, effort: "xhigh", tools: ["edit", "read", "shell"], fleet: [] }, "seats", [], { repositoryId: "12345" });
    const workerBare = bare([...piWorker.argv]);
    expect(workerBare[0]).toBe("pi");
    expect(values([...piWorker.argv], "--exclude-tools")).toEqual([]);
    expect(workerBare.some(arg => typeof arg === "string" && arg.startsWith("REPO_HARNESS_SEAT"))).toBe(false);
    expect(piWorker.argv.some(arg => arg.startsWith("REPO_HARNESS_SEAT") && arg.includes("="))).toBe(false);

    const codexOrchestrator = buildSeatLaunch("orchestrator", { runtime: "codex", model: "gpt-6.2-sol", advisor_model: null, effort: "high", tools: ["read", "shell", "net", "gh"], fleet: [] }, "seats", [], { repositoryId: "12345" });
    expect(codexOrchestrator.brief).toContain("Do not call a blocking question tool");
  });

  test.skipIf(process.platform === "win32")("Pi role overrides stay private under umask 022", () => {
    const advisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "pi", model: "magpie/agy-cli/gemini-4-neon" };
    const override = "synthetic/example-private-model";
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor, pi_sub_agent_models: { explorer: override } }, home => {
      const previousUmask = process.umask(0o022);
      try {
        const directory = String(bare(launch(home, "advisor").argv)[0]).replace("PI_SUBAGENT_EXTRA_AGENT_DIRS=", "");
        const explorer = join(directory, "rh-explorer.md");
        expect(readFileSync(explorer, "utf8")).toContain(`model: ${JSON.stringify(override)}\n`);
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(statSync(explorer).mode & 0o777).toBe(0o600);
        expect(statSync(join(directory, "rh-deep-reasoner.md")).mode & 0o777).toBe(0o600);

        chmodSync(directory, 0o755);
        chmodSync(explorer, 0o644);
        expect(bare(launch(home, "advisor").argv)[0]).toBe(`PI_SUBAGENT_EXTRA_AGENT_DIRS=${directory}`);
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(statSync(explorer).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(previousUmask);
      }
    });
  });

  test("every role name in a Pi advisor brief is the generated rh- name", () => {
    const advisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "pi" as const, model: "magpie/codex/gpt-6-astra", effort: null, fleet: ["deep-reasoner", "explorer"] };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor }, home => {
      writeFileSync(join(home, 'codex-used'), '51');
      const { brief } = launch(home, "advisor");
      expect(brief).toContain("`rh-deep-reasoner`, `rh-explorer`");
      expect(brief).toContain("Use rh-deep-reasoner only for an independent second judgment.");
      expect(brief).not.toMatch(/(?<!rh-)deep-reasoner/u);
    });
  });

  test("Claude advisor flags follow the setting and disappear in saving mode", () => {
    // #3091: a null advisor_model outside saving mode keeps the user's own persistent Claude Code advisorModel setting.
    withHome(DEFAULT_SEATS_CONFIG, home => {
      const args = launch(home, 'worker-opus').argv;
      expect(args).not.toContain('--advisor');
      expect(args).not.toContain('CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1');
    });
    const seats = { ...DEFAULT_SEATS_CONFIG,
      'worker-opus': { ...DEFAULT_SEATS_CONFIG['worker-opus'], advisor_model: 'fable' },
      orchestrator: { ...DEFAULT_SEATS_CONFIG.orchestrator, advisor_model: 'fable' } };
    withHome(seats, home => {
      const args = launch(home, 'worker-opus').argv;
      expect(args.slice(args.indexOf('--advisor'), args.indexOf('--advisor') + 2)).toEqual(['--advisor', 'fable']);
      mkdirSync(join(home, '.repo-harness', 'quota'));
      for (const used of [80, 81]) {
        writeFileSync(join(home, '.repo-harness', 'quota', 'claude.json'), JSON.stringify({ observed_at: new Date().toISOString(), rate_limits: {
          seven_day: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        } }));
        const orchestrator = launch(home, 'orchestrator').argv;
        expect(orchestrator.includes('--advisor')).toBe(used === 80);
        // #3091: saving mode also disables the advisor tool of a persistent Claude Code advisorModel setting.
        expect(orchestrator.includes('CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1')).toBe(used === 81);
        const quota = seatAccountQuotas([classifyQuotaReading(readClaudeQuota({ HOME: home }), Date.now())], seats.routing);
        expect(effectiveSeatConfig('worker-opus', seats, quota).advisor_model).toBe(used === 80 ? 'fable' : null);
      }
    });
  });

  test("quota preserves Codex models and Pi, changes Claude control-seat effort, and stops exhaustion", () => {
    const seats = { ...DEFAULT_SEATS_CONFIG,
      advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: 'claude' as const, model: 'fable', effort: 'high', tools: ['mcp', 'net', 'read', 'shell'] as const },
      worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: 'codex' as const, model: 'gpt-6.1-terra', effort: 'high' },
      'worker-neon': { ...DEFAULT_SEATS_CONFIG['worker-neon'], runtime: 'claude' as const, model: 'sonnet', effort: 'medium' },
      gatekeeper: { ...DEFAULT_SEATS_CONFIG.gatekeeper, runtime: 'codex' as const, model: 'gpt-6.1-terra', effort: 'high' },
    };
    withHome(seats, home => {
      writeFileSync(join(home, 'codex-used'), '10');
      expect(bare(launch(home, "worker").argv).slice(0, 5)).toEqual(["codex", "-m", seats.worker.model, "-c", 'model_reasoning_effort="high"']);
      writeFileSync(join(home, 'codex-used'), '51');
      expect(bare(launch(home, "worker").argv).slice(0, 5)).toEqual(["codex", "-m", seats.worker.model, "-c", 'model_reasoning_effort="high"']);
      expect(bare(launch(home, "worker-neon").argv).slice(0, 5)).toEqual(["claude", "--model", "sonnet", "--effort", "medium"]);
      expect(bare(launch(home, "worker-light").argv).slice(0, 5)).toEqual(["pi", "--provider", "zai", "--model", "glm-5.3-flash"]);
      mkdirSync(join(home, ".repo-harness", "quota"));
      const claudeUsed = (used: number) => writeFileSync(join(home, ".repo-harness", "quota", "claude.json"), JSON.stringify({ observed_at: new Date().toISOString(), rate_limits: {
        seven_day: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      } }));
      // #2633: the advisor takes its config entry only in Claude hyper (50% or more left); normal gives opus high.
      for (const [used, model] of [[50, "fable"], [51, "opus"]] as const) {
        claudeUsed(used);
        expect(bare(launch(home, "advisor").argv).slice(0, 5)).toEqual(["claude", "--model", model, "--effort", "high"]);
      }
      for (const used of [81, 95]) {
        claudeUsed(used);
        for (const id of ['advisor', 'orchestrator', 'worker-neon']) {
          const result = argv(home, id, '--json');
          if (used === 95 || id === 'worker-neon') {
            expect([result.status, result.stdout, JSON.parse(result.stderr).error]).toEqual([1, '', used === 95 ? 'seat_quota_exhausted' : 'seat_quota_reserved']);
          } else {
            const value = JSON.parse(result.stdout);
            const start = value.argv.indexOf('claude');
            expect(value.argv.slice(start, start + 5)).toEqual(['claude', '--model', 'opus', '--effort', 'high']);
          }
        }
      }
      writeFileSync(join(home, 'codex-used'), '95');
      writeFileSync(join(home, 'codex-credits'), 'false');
      const exhausted = argv(home, 'worker', '--json');
      expect([exhausted.status, JSON.parse(exhausted.stderr).error]).toEqual([1, 'seat_quota_exhausted']);
      expect(JSON.parse(argv(home, 'gatekeeper', '--pr', '2630', '--json').stderr).error).toBe('seat_quota_exhausted');
    });
    // #2630: the stored credit mode admits the seats it names while the account is exhausted and has credits.
    for (const mode of ['review', 'all'] as const) {
      withHome({ ...seats, routing: { ...seats.routing, codex_credit_mode: mode, codex_credit_floor: 2000 } }, home => {
        writeFileSync(join(home, 'codex-used'), '95');
        writeFileSync(join(home, 'codex-credits'), 'true');
        const worker = argv(home, 'worker', '--json');
        expect([mode, worker.status, worker.stderr ? JSON.parse(worker.stderr).error : null]).toEqual([mode, mode === 'all' ? 0 : 1, mode === 'all' ? null : 'seat_quota_exhausted']);
        expect(bare(JSON.parse(argv(home, 'gatekeeper', '--pr', '2630', '--json').stdout).argv).slice(0, 3)).toEqual(['codex', '-m', seats.gatekeeper.model]);
        writeFileSync(join(home, 'codex-credits'), 'false');
        expect(JSON.parse(argv(home, 'gatekeeper', '--pr', '2630', '--json').stderr).error).toBe('seat_quota_exhausted');
      });
    }
  });

  test("an owner exception on this repository lifts the Claude reservation for one launch and is recorded (#2769)", () => {
    const pi = { ...DEFAULT_SEATS_CONFIG['worker-light']!, model: 'magpie/anthropic/claude-opus-5-5', effort: 'high' };
    const seats = { ...DEFAULT_SEATS_CONFIG, 'worker-light': pi, 'worker-deep': { ...pi, model: null },
      routing: { ...DEFAULT_SEATS_CONFIG.routing, unavailable_pi_providers: ['magpie/anthropic'] } };
    withHome(seats, home => withRepository(home, "rh", repo => {
      git(repo, "remote", "add", "origin", "https://github.com/aimpact-inc/repo-harness.git");
      mkdirSync(join(home, ".repo-harness", "quota"), { recursive: true });
      const claudeUsed = (used: number) => writeFileSync(join(home, ".repo-harness", "quota", "claude.json"), JSON.stringify({ observed_at: new Date().toISOString(), rate_limits: {
        seven_day: { used_percentage: used, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      } }));
      claudeUsed(81);
      const url = "https://github.com/aimpact-inc/repo-harness/issues/2769#issuecomment-6885575441";
      const reviewer = (...args: string[]) => run(registryEnv(home), ["reviewer", "--repository-id", "1", "--pr", "2769", ...args, "--json"], repo);
      const error = (result: ReturnType<typeof run>) => [result.status, result.stdout, JSON.parse(result.stderr).error];
      const accepted = JSON.parse(reviewer("--owner-exception", url).stdout);
      expect([accepted.ownerException, accepted.labels.at(-1), accepted.argv.slice(6, 11)]).toEqual([url, `repo-harness.owner-exception=${url}`,
        [expect.stringContaining('"$0" "$1" seats label reviewer --repository-id 1 --pr 2769 --owner-exception "$3" && shift 3 && exec "$@"'), process.execPath, CLI, expect.any(String), url]]);
      expect(accepted.argv[6]).not.toContain(url);
      for (const bad of ["https://github.com/other/repo/issues/1", "https://github.com/aimpact-inc/repo-harness/issues/1 ; true", "http://github.com/aimpact-inc/repo-harness/pull/1"]) {
        expect(error(reviewer("--owner-exception", bad))).toEqual([1, "", "owner_exception_invalid"]);
      }
      expect(error(reviewer())).toEqual([1, "", "seat_quota_reserved"]);
      // The exception lifts only the reservation refusal: a Codex seat has none, and a listed Pi provider stays refused.
      expect(error(run(registryEnv(home), ["worker", "--repository-id", "1", "--issue", "2769", "--owner-exception", url, "--json"], repo))).toEqual([1, "", "owner_exception_invalid"]);
      expect(error(run(registryEnv(home), ["worker-light", "--json"], repo))).toEqual([1, "", "seat_provider_unavailable"]);
      const unknown = JSON.parse(run(registryEnv(home), ["worker-deep", "--json"], repo).stderr);
      expect([unknown.error, unknown.message]).toEqual(["seat_provider_unavailable", expect.stringContaining("give the seat an explicit model or empty seats.routing.unavailable_pi_providers")]);
      expect(error(run(registryEnv(home), ["reviewer", "--pr", "2769", "--owner-exception", url, "--json"], repo))).toEqual([1, "", "repository_id_required"]);
      expect(error(run(registryEnv(home), ["reviewer", "--repository-id", "1", "--owner-exception", url, "--json"], home))).toEqual([1, "", "owner_exception_invalid"]);
      git(repo, "remote", "set-url", "origin", "https://gitlab.com/aimpact-inc/repo-harness.git");
      expect(error(reviewer("--owner-exception", url))).toEqual([1, "", "owner_exception_invalid"]);
      git(repo, "remote", "set-url", "origin", "https://github.com/aimpact-inc/repo-harness.git");
      claudeUsed(97);
      expect(error(reviewer("--owner-exception", url))).toEqual([1, "", "seat_quota_exhausted"]);
    }));
  });

  test("without a seats section the advisor launch comes from the defaults and briefs the default fleet", () => {
    withHome(undefined, (home) => {
      const advisor = launch(home, "advisor");
      expect(advisor.source).toBe("defaults");
      expect(advisor.brief).toContain("Collect evidence through your sub-agents: `rh-deep-reasoner`, `rh-explorer`.");
      expect(bare(advisor.argv).slice(1, 6)).toEqual(["pi", "--provider", "magpie", "--model", "agy-cli/gemini-4-neon"]);
      expect(advisor.argv.at(-1)).toBe(advisor.brief);
      const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
      withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, claudeHome => {
        const ca = launch(claudeHome, "advisor");
        expect(tools(ca.argv)).toEqual(["ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "WebFetch", "WebSearch", "Read", "Glob", "Grep",
          "Bash", "Monitor", "TaskStop", "Agent", "Skill"]);
        expect(ca.argv).not.toContain("--strict-mcp-config");
        expect(denied(ca.argv)).toEqual(expect.arrayContaining(["Agent(fast-worker)", "Agent(general-purpose)", "Agent(fork)",
          "Agent(nested-auditor)", "Agent(demo:helper)", "Agent(demo:review:security)", "Bash(gh pr create *)"]));
        expect(denied(ca.argv)).not.toContain("Agent(explorer)");
        expect(ca.limits).toContainEqual({ subject: "fleet", level: "named_types_only" });
        expect(ca.limits).toContainEqual({ subject: "edit", level: "common_commands" });
        expect(ca.brief).toContain("The host refuses only common commands for these limits. Keep them yourself. Do not edit files. Do not write to GitHub.");
      });
    });
  });

  test("the Claude opus worker blocks retired roles and the evaluator by name", () => {
    withHome(undefined, home => {
      const worker = launch(home, "worker-opus");
      expect(tools(worker.argv)).toContain("Agent");
      expect(denied(worker.argv)).toEqual(expect.arrayContaining([
        "Agent(deep-reasoner)", "Agent(deep-worker)", "Agent(fast-worker)", "Agent(gatekeeper)", "Agent(harness-evaluator)", "Agent(root-cause-prover)",
      ]));
      expect(denied(worker.argv)).not.toContain("Agent(explorer)");
      expect(worker.brief).toContain("You may call these sub-agents: `explorer`.");
    });
  });

  test("an empty advisor fleet refuses every agent type, and a Pi seat says it has no sub-agents", () => {
    const seats = { ...DEFAULT_SEATS_CONFIG, advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const, fleet: [] }, worker: { runtime: "pi", model: null, effort: null, tools: ["edit", "read", "shell"], fleet: [] } };
    withHome(seats, (home) => {
      const advisor = launch(home, "advisor");
      expect(advisor.source).toBe("seats");
      expect(advisor.brief).toContain("You have no sub-agents. Collect evidence yourself.");
      expect(tools(advisor.argv)).not.toContain("Agent");
      expect(denied(advisor.argv).some((rule: string) => rule.startsWith("Agent("))).toBe(false);
      const worker = launch(home, "worker");
      expect(bare(worker.argv)).toEqual(["pi", "--append-system-prompt", worker.brief]);
      expect(worker.brief).toContain("You have no sub-agents.");
      expect(worker.limits).toContainEqual({ subject: "gh", level: "instructions_only" });
      expect(worker.brief).toContain("These limits are instructions only; the host does not enforce them. Keep them yourself. Do not use the network. Do not use the task list tools. Do not use MCP tools. Do not write to GitHub.");
    });
  });

  test("the orchestrator seat names its triage queue and allows exactly its groups' tools, with explorer Agent", () => {
    withHome(undefined, (home) => {
      const orchestrator = launch(home, "orchestrator").argv;
      expect(bare(orchestrator).slice(0, 2)).toEqual(["CLAUDE_CODE_TASK_LIST_ID=repo-harness-orchestrator", "claude"]);
      expect(tools(orchestrator)).toEqual(["ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "WebFetch", "WebSearch", "Read", "Glob", "Grep",
        "Bash", "Monitor", "TaskStop", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "Agent", "Skill"]);
      expect(denied(orchestrator)).not.toContain("Agent(explorer)");
      expect(denied(orchestrator)).toContain("Agent(deep-reasoner)");
      expect(orchestrator).not.toContain("--strict-mcp-config");
    });
  });

  test("the schedule group adds the Cron tools to --tools and is off by default", () => {
    const advisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "schedule", "shell"] };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor }, home => {
      expect(tools(launch(home, "advisor").argv)).toEqual(expect.arrayContaining(["CronCreate", "CronList", "CronDelete"]));
      const off = tools(launch(home, "orchestrator").argv);
      for (const tool of ["CronCreate", "CronList", "CronDelete"]) expect(off).not.toContain(tool);
      expect(launch(home, "advisor").limits).toContainEqual({ subject: "gh", level: "common_commands" });
      expect(launch(home, "orchestrator").limits).toContainEqual({ subject: "schedule", level: "instructions_only" });
      expect(launch(home, "orchestrator").brief).toContain("Do not schedule recurring jobs.");
      // Shell off, MCP on: the MCP path alone keeps the limit instructions_only.
      const mcpOnly = { ...advisor, tools: ["mcp", "read"] };
      withHome({ ...DEFAULT_SEATS_CONFIG, advisor: mcpOnly }, home2 => expect(launch(home2, "advisor").limits).toContainEqual({ subject: "schedule", level: "instructions_only" }));
    });
  });

  test("the schedule group changes no Codex or Pi argv, and a stored config without it decodes unchanged", () => {
    for (const runtime of ["codex", "pi"] as const) {
      const base = { ...DEFAULT_SEATS_CONFIG.advisor, runtime, model: runtime === "pi" ? "magpie/codex/gpt-6-astra" : "gpt-6.1-terra", effort: null, fleet: [] };
      const argvWith = (seatTools: string[]) => withHome({ ...DEFAULT_SEATS_CONFIG, advisor: { ...base, tools: seatTools } }, home => { out.push(launch(home, "advisor").argv); });
      const out: string[][] = [];
      argvWith(["mcp", "net", "read", "shell"]);
      argvWith(["mcp", "net", "read", "schedule", "shell"]);
      expect(out[1]).toEqual(out[0]);
    }
    // A config stored before the group existed lists no schedule and still launches.
    const stored = { ...DEFAULT_SEATS_CONFIG, advisor: { ...DEFAULT_SEATS_CONFIG.advisor, tools: ["mcp", "net", "read", "shell"] } };
    withHome(stored, home => expect(launch(home, "advisor").source).toBe("seats"));
  });

  test("the orchestrator brief names its fleet and its review path; a fleet keeps the Agent tool and refuses every other agent type", () => {
    const seatReview = "You do not review a PR that you dispatched; route that review to another seat.";
    const gatekeeperReview = "You do not review a PR yourself. An independent `gatekeeper` sub-agent may review a PR that you dispatched; route every other review of that PR to another seat.";
    const seatsOnly = (roles: string) => `You may call these read-only sub-agents: ${roles}. Call no other agent type. Writers and the Codex review run only in Herdr seats: dispatch them to seats through Herdr.`;
    for (const [fleet, dispatch] of [
      [[], "You do not dispatch sub-agents (the Agent tool) for execution. Dispatch work only to seats through Herdr."],
      [["explorer"], seatsOnly("`explorer`")],
    ] as const) {
      withHome({ ...DEFAULT_SEATS_CONFIG, orchestrator: { ...DEFAULT_SEATS_CONFIG.orchestrator, fleet } }, (home) => {
        const orchestrator = launch(home, "orchestrator");
        expect(orchestrator.brief).toContain("You push only the branch of a Codex worker seat handoff: commit its worktree diff with its message and explicit paths only, push the branch, open the PR, and push each fix round. On the owner's explicit word for one release you run the command list of `bash scripts/release-owner-steps.sh plan <version>` from the release worktree; the owner confirms the npm login. Without that word you do not tag or publish. You do not delete, or change credentials or permissions yourself.");
        expect(orchestrator.brief).not.toContain("You do not push, tag, release, delete, or change credentials or permissions.");
        expect(orchestrator.brief).toContain(seatReview);
        expect(orchestrator.brief).toContain(dispatch);
        expect(orchestrator.brief).not.toContain(gatekeeperReview);
        if (fleet.length === 0) return;
        expect(orchestrator.brief).not.toContain("Dispatch work only to seats through Herdr.");
        expect(tools(orchestrator.argv)).toContain("Agent");
        expect(denied(orchestrator.argv)).toEqual(expect.arrayContaining(["Agent(fast-worker)", "Agent(deep-worker)", "Agent(general-purpose)", "Agent(fork)"]));
        expect(denied(orchestrator.argv).filter((rule: string) => fleet.some(role => rule === `Agent(${role})`))).toEqual([]);
        expect(orchestrator.limits).toContainEqual({ subject: "fleet", level: "named_types_only" });
      });
    }
    const legacy = buildSeatLaunch("orchestrator", { ...DEFAULT_SEATS_CONFIG.orchestrator, fleet: ["gatekeeper"] }, "seats", []);
    expect(legacy.brief).toContain(seatReview);
    expect(legacy.brief).not.toContain(gatekeeperReview);
  });

  test("the Codex argv holds only flags that Codex applies; the fleet goes into the launch instructions only", () => {
    const seats = { ...DEFAULT_SEATS_CONFIG, worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: "codex" as const, model: "gpt-6.1-terra", tools: ["edit", "read", "shell"] } };
    const handoff = "As a Codex worker seat in a linked contract worktree, edit files and run checks only. Do not run `git fetch`, `git commit` or `git push`. In your last message, give the commit subject and body, the PR title and body, and the check results. The orchestrator commits your worktree diff with that message and explicit paths only, pushes the branch and opens the PR. It is the head owner of record and pushes each fix round; no other agent pushes to that PR. You remain the content author and answer review threads through the orchestrator.";
    withHome(seats, (home) => {
      const result = argv(home, "worker");
      expect(result.status).toBe(0);
      const args: string[] = JSON.parse(result.stdout);
      const instructions = args.at(-1)!;
      expect(bare(args).slice(0, -1)).toEqual(["codex", "-m", "gpt-6.1-terra", "-c", 'model_reasoning_effort="high"', "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "-c", 'web_search="disabled"', "-c"]);
      expect(instructions).toStartWith('developer_instructions="You are a worker seat.');
      expect(JSON.parse(instructions.slice("developer_instructions=".length))).toContain(handoff);
      expect(JSON.parse(instructions.slice("developer_instructions=".length))).toContain("These limits are instructions only; the host does not enforce them. Keep them yourself. Do not use the task list tools. Do not use MCP tools. Do not write to GitHub.");
      expect(result.stderr).toContain("limit fleet: instructions_only (written into the launch instructions only)");
      expect(result.stderr).toContain("limit mcp: instructions_only (written into the launch instructions only)");
    });
    withHome({ ...seats, worker: { ...seats.worker, runtime: "claude" } }, (home) => {
      expect(launch(home, "worker").brief).not.toContain(handoff);
    });
  });

  test("without net, Codex disables web search; an MCP path keeps edit and net partial, and the fleet is always instructions only", () => {
    const seats = {
      ...DEFAULT_SEATS_CONFIG,
      advisor: { runtime: "codex", model: null, effort: null, tools: ["mcp", "read", "shell"], fleet: [] },
      worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: "codex" as const, model: "gpt-6.1-terra", tools: ["edit", "read", "shell"] },
    };
    withHome(seats, (home) => {
      const worker = launch(home, "worker");
      expect(worker.argv).toEqual(expect.arrayContaining(["sandbox_workspace_write.network_access=false", 'web_search="disabled"']));
      // No argv flag disables every inherited MCP server, so net stays partial even when the mcp group is off.
      expect(worker.limits).toContainEqual({ subject: "net", level: "common_commands" });
      expect(worker.brief).toContain("The host refuses only common commands for these limits. Keep them yourself. Do not use the network.");
      const advisor = launch(home, "advisor");
      expect(bare(advisor.argv).slice(0, 5)).toEqual(["codex", "-s", "read-only", "-c", 'web_search="disabled"']);
      expect(advisor.limits).toContainEqual({ subject: "net", level: "common_commands" });
      expect(advisor.limits).toContainEqual({ subject: "edit", level: "common_commands" });
      expect(advisor.limits).toContainEqual({ subject: "fleet", level: "instructions_only" });
    });
  });

  test("a writable Codex seat enables sandbox network with net, and other seats keep net", () => {
    const codexWorker = { ...DEFAULT_SEATS_CONFIG.worker, runtime: "codex" as const, model: "gpt-6.1-terra" };
    withHome({ ...DEFAULT_SEATS_CONFIG, worker: codexWorker }, (home) => {
      const worker = launch(home, "worker");
      expect(worker.argv).toEqual(expect.arrayContaining(["workspace-write", "sandbox_workspace_write.network_access=true"]));
      expect(worker.argv).not.toContain('web_search="disabled"');
      expect(worker.brief).not.toContain("Do not use the network.");
    });
    const editNet = ["edit", "net", "read", "shell"];
    withHome({ ...DEFAULT_SEATS_CONFIG, worker: { ...codexWorker, tools: editNet } }, (home) => {
      expect(launch(home, "worker").argv).toEqual(expect.arrayContaining(["workspace-write", "sandbox_workspace_write.network_access=true"]));
    });
    const seats = {
      ...DEFAULT_SEATS_CONFIG,
      advisor: { runtime: "codex", model: null, effort: null, tools: ["net", "read"], fleet: [] },
      worker: { runtime: "claude", model: null, effort: null, tools: editNet, fleet: [] },
    };
    withHome(seats, (home) => {
      const advisor = launch(home, "advisor").argv;
      expect(bare(advisor).slice(0, 3)).toEqual(["codex", "-s", "read-only"]);
      expect(advisor.join(" ")).not.toContain("network_access");
      expect(advisor).not.toContain('web_search="disabled"');
      expect(tools(launch(home, "worker").argv)).toEqual(expect.arrayContaining(["Edit", "WebFetch"]));
    });
    withHome({ ...seats, worker: { ...seats.worker, runtime: "pi" } }, (home) => {
      expect(bare(launch(home, "worker").argv)[0]).toBe("pi");
    });
  });

  test("on Claude, an mcp-off seat loads no MCP server, and edit is enforced only when the shell and MCP groups are both off", () => {
    const seats = {
      ...DEFAULT_SEATS_CONFIG,
      advisor: { runtime: "claude", model: null, effort: null, tools: ["read"], fleet: [] },
      worker: { runtime: "claude", model: null, effort: null, tools: ["mcp", "read"], fleet: [] },
    };
    withHome(seats, (home) => {
      const worker = launch(home, "worker");
      expect(tools(worker.argv)).toEqual(["ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "Read", "Glob", "Grep"]);
      expect(worker.argv).not.toContain("--strict-mcp-config");
      expect(worker.limits).toContainEqual({ subject: "edit", level: "common_commands" });
      expect(worker.brief).toContain("Keep them yourself. Do not edit files.");
      const advisor = launch(home, "advisor");
      expect(tools(advisor.argv)).toEqual(["Read", "Glob", "Grep"]);
      expect(advisor.argv).toContain("--strict-mcp-config");
      expect(advisor.argv).not.toContain("--mcp-config");
      expect(advisor.argv).not.toContain("--disallowedTools");
      expect(advisor.limits).toContainEqual({ subject: "edit", level: "enforced" });
      expect(advisor.limits).toContainEqual({ subject: "net", level: "enforced" });
    });
  });

  test("the agent types come from CLAUDE_CONFIG_DIR when it is set", () => {
    const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, (home) => {
      const root = join(home, "alternate");
      mkdirSync(join(root, "agents"), { recursive: true });
      writeFileSync(join(root, "agents", "other.md"), "---\nname: alternate-auditor\ndescription: Demo\n---\nBody\n");
      const advisor = JSON.parse(run({ HOME: home, CLAUDE_CONFIG_DIR: root }, ["advisor", "--json"]).stdout);
      expect(denied(advisor.argv)).toContain("Agent(alternate-auditor)");
      expect(denied(advisor.argv)).not.toContain("Agent(nested-auditor)");
    });
  });

  test("an agent file with list and nested frontmatter fields is read by its name", () => {
    const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, (home) => {
      writeFileSync(join(home, ".claude", "agents", "api.md"),
        "---\nname: api-developer\ndescription: Builds APIs: REST and RPC\nskills:\n  - api-design\n  - testing\nhooks:\n  PreToolUse:\n    - matcher: Bash\n---\nBody\n");
      expect(denied(launch(home, "advisor").argv)).toContain("Agent(api-developer)");
    });
  });

  test("an empty CLAUDE_CONFIG_DIR fails closed", () => {
    const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, (home) => {
      const result = run({ HOME: home, CLAUDE_CONFIG_DIR: "" }, ["advisor", "--json"]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toBe("claude_agent_types_unreadable");
    });
  });

  test("an agent name that does not parse fails closed", () => {
    const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, (home) => {
      writeFileSync(join(home, "plugin", "agents", "bad.md"), "---\nname: [oops\ndescription: Demo\n---\nBody\n");
      const result = argv(home, "advisor", "--json");
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toBe("claude_agent_types_unreadable");
    });
  });

  test("an enabled plugin without a manifest uses its entry name even when marked orphaned", () => {
    const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, (home) => {
      rmSync(join(home, "plugin", ".claude-plugin"), { recursive: true });
      writeFileSync(join(home, "plugin", ".orphaned_at"), "1793467681012");
      const result = argv(home, "advisor", "--json");
      expect(result.status).toBe(0);
      expect(denied(JSON.parse(result.stdout).argv)).toEqual(expect.arrayContaining(["Agent(demo:helper)", "Agent(demo:review:security)"]));
    });
  });

  test("a scoped npm plugin without a manifest fails closed with the missing name cause and repair", () => {
    const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
    const key = "@scope/pkg@npm";
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, (home) => {
      rmSync(join(home, "plugin", ".claude-plugin"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { [key]: true } }));
      writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { [key]: [{ installPath: join(home, "plugin") }] } }));
      const result = argv(home, "advisor", "--json");
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr);
      expect(error.error).toBe("claude_agent_types_unreadable");
      expect(error.message).toContain(`entry ${key} has no manifest and its key gives no plugin name. Add a .claude-plugin/plugin.json with a name, or reinstall the plugin from a marketplace.`);
    });
  });

  test("a present plugin manifest without a name fails closed with a repair", () => {
    const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, (home) => {
      const manifestPath = join(home, "plugin", ".claude-plugin", "plugin.json");
      writeFileSync(manifestPath, "{}");
      const result = argv(home, "advisor", "--json");
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toEqual({ ok: false, error: "claude_agent_types_unreadable", message: `${manifestPath} has no plugin name. Reinstall or disable demo@market.` });
    });
  });

  test("a present plugin manifest name takes precedence over its entry name", () => {
    const claudeAdvisor = { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const };
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: claudeAdvisor }, (home) => {
      writeFileSync(join(home, "plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "manifest-name" }));
      const rules = denied(launch(home, "advisor").argv);
      expect(rules).toContain("Agent(manifest-name:helper)");
      expect(rules).not.toContain("Agent(demo:helper)");
    });
  });

  test("the seat labels hold the GitHub repository id and the dispatch numbers, and need --repository-id", () => {
    withHome(undefined, (home) => {
      // With --repository-id the command also names the pane, so it runs in a registered checkout with a prefix.
      withRepository(home, "rh", (repo) => {
        const worker = JSON.parse(run(registryEnv(home), ["worker", "--repository-id", "1186405141", "--issue", "1473", "--pr", "1521", "--parent", "1000", "--json"], repo).stdout);
        expect(worker.labels).toEqual(["repo-harness.seat=worker", "repo-harness.repository=1186405141", "repo-harness.issue=1473", "repo-harness.pr=1521", "repo-harness.parent=1000"]);
      });
      const missing = argv(home, "worker", "--issue", "1473");
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe("");
      expect(JSON.parse(missing.stderr).error).toBe("repository_id_required");
    });
  });

  test("with --repository-id the argv labels its own terminal before the agent starts; a label failure starts no agent", () => {
    withHome(undefined, (home) => {
      withRepository(home, "rh", (repo) => {
        const worker = JSON.parse(run(registryEnv(home), ["worker", "--repository-id", "1186405141", "--parent", "1000", "--issue", "1473", "--json"], repo).stdout);
        // A fake hc and a fake agent on an explicit PATH: no real terminal is labelled or started.
        const bin = join(home, "bin"), log = join(home, "calls.log");
        mkdirSync(bin);
        for (const profile of [".profile", ".zshrc"]) writeFileSync(join(home, profile), 'export PATH="$HOME/bin:/bin:/usr/bin"\n');
        writeFileSync(join(bin, "hc"), `#!/bin/sh\nprintf 'hc %s\\n' "$*" >> "${log}"\nif [ -n "$FAKE_HC_FAIL" ]; then printf '%s' '{"error":{"kind":"not_found","message":"no terminal"}}' >&2; exit 3; fi\n`
          + `printf '%s' '{"address":"t5","state":"live","labels":{"repo-harness.seat":"worker"},"turn":0}'\n`);
        writeFileSync(join(bin, "pi"), `#!/bin/sh\nprintf 'pi %s %s %s %s %s\\n' "$1" "$2" "$3" "\${REPO_HARNESS_SEAT-unset}" "\${PI_SUBAGENT_EXTRA_AGENT_DIRS-unset}" >> "${log}"\n`);
        for (const name of ["hc", "pi"]) chmodSync(join(bin, name), 0o755);
        const label = "hc label --json -- t5 repo-harness.seat=worker repo-harness.repository=1186405141 repo-harness.issue=1473 repo-harness.parent=1000";
        for (const [env, error, calls] of [
          // A worker started from a reset seat's env does not inherit the seat identity or a parent's Pi role directory (#1975, #1977).
          [{ HC_TERMINAL_ID: "t5", REPO_HARNESS_SEAT: "orchestrator", REPO_HARNESS_SEAT_REPOSITORY: "1186405141", PI_SUBAGENT_EXTRA_AGENT_DIRS: "/parent/pi-fleet" }, null,
            [label, `pi --provider magpie --model unset ${join(realpathSync(home), ".repo-harness", "seats", "pi-fleet")}`]],
          [{ HC_TERMINAL_ID: "t5", FAKE_HC_FAIL: "1" }, "label_failed", [label]],
          [{}, "terminal_unknown", []],
        ] as const) {
          writeFileSync(log, "");
          const result = spawnSync(worker.argv[0], worker.argv.slice(1), { env: { ...registryEnv(home), PATH: `${bin}:/bin:/usr/bin`, ...env }, encoding: "utf8", cwd: repo });
          const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
          const failure = error === null ? null : JSON.parse(result.stderr.trim().split("\n").at(-1)!);
          if (error === null) {
            expect(result.status).toBe(0);
            expect(lines[0]).toBe(label);
            expect(lines[1]).toStartWith("pi --provider magpie --model unset ");
          } else {
            expect([result.status === 0, failure?.error ?? null, failure?.message.startsWith("The seat did not start: ") ?? null, lines])
              .toEqual([false, error, true, [...calls]]);
          }
        }
      });
    });
  });

  test("registered Pi argv gives a direct pane launch bun, rh and hc on PATH", () => {
    withHome(undefined, home => withRepository(home, "rh", repo => {
      const launchBin = join(home, "launch-bin"), bunBin = join(home, "bun-bin"), paneBin = join(home, "pane-bin");
      mkdirSync(launchBin);
      mkdirSync(bunBin);
      mkdirSync(paneBin);
      for (const profile of [".profile", ".zshrc"]) writeFileSync(join(home, profile), 'export PATH="$HOME/pane-bin:/bin:/usr/bin"\n');
      writeFileSync(join(launchBin, "hc"), `#!/bin/sh\ncase "$1" in\n  --version) echo hc-probe;;\n  label) echo '{"address":"t5","state":"live","labels":{"repo-harness.seat":"worker-light"},"turn":0}';;\nesac\n`, { mode: 0o755 });
      writeFileSync(join(launchBin, "rh"), "#!/bin/sh\necho rh-probe\n", { mode: 0o755 });
      writeFileSync(join(bunBin, "bun"), `#!/bin/sh\nexec ${JSON.stringify(Bun.which("bun") ?? process.execPath)} "$@"\n`, { mode: 0o755 });
      writeFileSync(join(bunBin, "rh"), "#!/bin/sh\necho shadowed-rh\n", { mode: 0o755 });
      writeFileSync(join(paneBin, "pi"), "#!/bin/sh\nset -e\nbun --version\nrh --version\nhc --version\n", { mode: 0o755 });
      const env = registryEnv(home);
      const launch = run({ ...env, PATH: `${launchBin}:${bunBin}:/bin:/usr/bin` }, ["worker-light", "--repository-id", "1186405141", "--issue", "3300"], repo);
      expect(launch.status, launch.stderr).toBe(0);
      const [command, ...args] = JSON.parse(launch.stdout);
      const result = spawnSync(command, args, { cwd: repo, encoding: "utf8",
        env: { ...env, ZDOTDIR: home, BUN_INSTALL: join(home, ".bun"), HC_TERMINAL_ID: "t5", PATH: `${paneBin}:/bin:/usr/bin` } });
      expect([result.status, result.stdout.trim().split("\n")]).toEqual([0, [Bun.version, "rh-probe", "hc-probe"]]);
    }));
  });

  test("the pane name and the tab name come from the registry prefix of the primary checkout, one per role", () => {
    const seats = { ...DEFAULT_SEATS_CONFIG,
      advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "claude" as const, model: "opus", effort: "high", tools: ["mcp", "net", "read", "shell"] as const },
      worker: { ...DEFAULT_SEATS_CONFIG.worker, runtime: "codex" as const, model: "gpt-6.1-terra" } };
    withHome(seats, (home) => {
      withRepository(home, "rh", (repo, worktree) => {
        const named = (cwd: string, ...args: string[]) => JSON.parse(run(registryEnv(home), [...args, "--repository-id", "1186405141", "--json"], cwd).stdout);
        const orchestrator = named(repo, "orchestrator");
        expect([orchestrator.name, orchestrator.tab]).toEqual(["rh-orch", "orch"]);
        expect(agent(orchestrator).slice(0, 19)).toEqual([...UNSET_SEAT, "CLAUDE_CODE_TASK_LIST_ID=repo-harness-orchestrator",
          "REPO_HARNESS_SEAT=orchestrator", "REPO_HARNESS_SEAT_REPOSITORY=1186405141", "REPO_HARNESS_SEAT_MODEL=opus", "REPO_HARNESS_SEAT_EFFORT=high", "claude", "-n", "rh-orch"]);
        const advisor = named(repo, "advisor", "--parent", "1000");
        expect([advisor.name, advisor.tab]).toEqual(["rh-adv", "orch"]);
        expect(agent(advisor).slice(0, 18)).toEqual([...UNSET_SEAT, "REPO_HARNESS_SEAT=advisor", "REPO_HARNESS_SEAT_REPOSITORY=1186405141",
          "REPO_HARNESS_SEAT_MODEL=opus", "REPO_HARNESS_SEAT_EFFORT=high", "claude", "-n", "rh-adv"]);
        // A linked worktree resolves to its primary checkout; the Codex worker has no session name flag.
        const worker = named(worktree, "worker", "--parent", "1000", "--issue", "1508", "--pr", "1521", "--qualifier", "device");
        expect([worker.name, worker.tab]).toEqual(["rh-w-1508-device", "#1508"]);
        expect(worker.argv).not.toContain("rh-w-1508-device");
        const release = named(repo, "worker", "--release", "0252");
        expect([release.name, release.tab]).toEqual(["rh-w-rel0252", "other"]);
        expect([
          seatTabName("worker", { issue: "2479" }),
          seatTabName("worker-deep"),
          seatTabName("gatekeeper", { pr: "2478" }),
          seatTabName("reviewer"),
          seatTabName("council", { issue: "42" }),
          seatTabName("orchestrator"),
          seatTabName("advisor"),
        ]).toEqual(["#2479", "other", "PR#2478", "review", "council", "orch", "orch"]);
        expect(() => seatTabName("worker", { issue: "0" })).toThrow(expect.objectContaining({ code: "pane_name_invalid" }));
        expect(() => seatTabName("gatekeeper", { pr: "abc" })).toThrow(expect.objectContaining({ code: "pane_name_invalid" }));
        expect(seatPaneName({ prefix: "rh", seat: "reviewer", pr: "1536", qualifier: "codex" })).toBe("rh-rv-1536-codex");
        expect(() => seatPaneName({ prefix: "a", seat: "reviewer", pr: "1536" })).toThrow(expect.objectContaining({ code: "pane_name_invalid" }));
        // Without --repository-id the argv has no pane name, while the base tab name still resolves (P2-unlabeled-tab-names).
        expect(launch(home, "orchestrator").argv).not.toContain("-n");
        expect([
          JSON.parse(run(registryEnv(home), ["orchestrator", "--json"], repo).stdout),
          JSON.parse(run(registryEnv(home), ["advisor", "--json"], repo).stdout),
          JSON.parse(run(registryEnv(home), ["worker", "--json"], repo).stdout),
          JSON.parse(run(registryEnv(home), ["gatekeeper", "--pr", "2478", "--json"], repo).stdout),
        ].map(entry => [entry.name, entry.tab])).toEqual([
          [null, "orch"],
          [null, "orch"],
          [null, "other"],
          [null, "PR#2478"],
        ]);
      });
    });
  });

  test("a council launch labels its issue and keeps the configured model on all three hosts", () => {
    expect([isWorkerSeat("council"), isReviewSeat("council"), isCouncilSeat("council")]).toEqual([false, false, true]);
    for (const [runtime, model] of [["pi", "magpie/agy-cli/gemini-4-carbon"], ["codex", "gpt-6.2-astra"], ["claude", "fable"]] as const) {
      const council = { ...DEFAULT_SEATS_CONFIG.reviewer, runtime, model, fleet: ["explorer"] };
      withHome({ ...DEFAULT_SEATS_CONFIG, council }, home => withRepository(home, "rh", (_repo, worktree) => {
        writeFileSync(join(home, ".quota-bin", "agy"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
        const result = run(registryEnv(home), ["council", "--repository-id", "1", "--issue", "42", "--parent", "5", "--qualifier", "fable", "--json"], worktree);
        expect(result.status, result.stderr).toBe(0);
        const value = JSON.parse(result.stdout);
        expect(value).toMatchObject({ seat: "council", runtime, name: "rh-cn-42-fable", tab: "council",
          labels: ["repo-harness.seat=council", "repo-harness.repository=1", "repo-harness.issue=42", "repo-harness.parent=5"] });
        expect(value.argv.some((arg: string) => arg.includes("seats label council --repository-id 1 --issue 42 --parent 5"))).toBe(true);
        expect(value.brief).toContain("RECOMMENDATION: <one sentence> — confidence: HIGH|MEDIUM|LOW");
        expect(value.brief).toContain("caller-provided scratch file outside every Git repository and worktree");
        const args = bare(agent(value)) as string[];
        if (runtime === "pi") {
          expect(args.slice(1, 6)).toEqual(["pi", "--provider", "magpie", "--model", "agy-cli/gemini-4-carbon"]);
          expect(values(args, "--exclude-tools")).toEqual(["edit,write"]);
          expect(args).not.toContain("--no-extensions");
          expect(value.brief).toContain("`rh-explorer` in parallel");
          const directory = args[0]!.replace("PI_SUBAGENT_EXTRA_AGENT_DIRS=", "");
          expect(directory).not.toBe(args[0]);
          expect(readdirSync(directory)).toEqual(["rh-explorer.md"]);
        } else if (runtime === "codex") {
          expect(args.slice(0, 3)).toEqual(["codex", "-m", model]);
          expect(args).toContain("read-only");
        } else {
          expect(args.slice(0, 5)).toEqual(["claude", "-n", "rh-cn-42-fable", "--model", model]);
          expect(tools(args)).toContain("Agent");
          expect(tools(args)).not.toContain("Write");
        }
      }));
    }
  });

  test("a council seat requires an issue and a configured seat", () => {
    withHome(undefined, home => {
      const result = argv(home, "council", "--repository-id", "1", "--issue", "42", "--json");
      expect([result.status, result.stdout, JSON.parse(result.stderr).error]).toEqual([1, "", "seat_not_configured"]);
    });
    withHome({ ...DEFAULT_SEATS_CONFIG, council: { ...DEFAULT_SEATS_CONFIG.reviewer, model: "fable" } }, home => {
      for (const flags of [[], ["--pr", "99"], ["--issue", "42", "--pr", "99"], ["--issue", "42", "--release", "0050"]]) {
        const result = argv(home, "council", "--repository-id", "1", "--json", ...flags);
        expect([result.status, result.stdout, JSON.parse(result.stderr).error]).toEqual([1, "", "pane_name_invalid"]);
      }
    });
    expect(seatPaneName({ prefix: "rh", seat: "council", issue: "42", qualifier: "fable" })).toBe("rh-cn-42-fable");
    expect(() => seatPaneName({ prefix: "rh", seat: "council", issue: "0" })).toThrow(expect.objectContaining({ code: "pane_name_invalid" }));
  });

  test("seats council previews without writes and launches member panes via Herdr with auto herdr.space resolution", () => {
    withHome({ ...DEFAULT_SEATS_CONFIG, council: PI_COUNCIL }, home => withRepository(home, "rh", (repo, worktree) => {
      const bin = join(home, ".quota-bin");
      const scratch = realpathSync(mkdirSync(join(home, "scratch"), { recursive: true })!);
      const ghLog = join(home, "gh.log"), tabLog = join(home, "tab.log");
      const gh = join(bin, "gh");
      mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
      writeFileSync(join(home, ".pi", "agent", "extensions", "magpie.ts"), "");
      writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      writeFileSync(join(bin, "agy"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
      const stateFile = join(home, "herdr-state.json");
      writeFileSync(stateFile, JSON.stringify({ spaces: [{ id: "sp-auto", name: "council-test", folder: worktree, machine: null, active: true, tabs: [] }], seq: 1 }));
      writeFileSync(join(bin, "hc"), `#!${process.execPath}
const fs = require('node:fs');
const sub = process.argv[2];
if (sub === 'run') {
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
  const args = process.argv.slice(3);
  const sep = args.indexOf('--');
  const flags = sep === -1 ? args : args.slice(0, sep);
  const argv = sep === -1 ? [] : args.slice(sep + 1);
  const labels = {};
  let cwd = null;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--cwd') cwd = flags[++i];
    else if (flags[i] === '--label') {
      const pair = flags[++i];
      const eq = pair.indexOf('=');
      labels[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  const id = state.seq++;
  const pane = 'p' + id;
  const terminal = 't' + (10 + id);
  fs.appendFileSync(${JSON.stringify(tabLog)}, JSON.stringify(['hc.run', { cwd, space: labels['herdr.space'], tab: labels['herdr.tab'], keep: flags.includes('--keep'), noParent: flags.includes('--no-parent'), argv }]) + '\\n');
  const space = state.spaces.find(s => s.id === labels['herdr.space']);
  const tab = space?.tabs.find(t => t.id === labels['herdr.tab']);
  if (tab) tab.terminals.push({ terminal, pane, status: null, app: null, name: null });
  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
  console.log(JSON.stringify({ address: terminal, state: 'live', cwd }));
  process.exit(0);
}
console.log(JSON.stringify({ address: 't5', state: 'live', turn: 0, labels: { 'herdr.space': 'sp-auto' } }));
`, { mode: 0o755 });
      writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${ghLog}"\n`
        + `test "$*" = 'api --hostname github.com repos/{owner}/{repo}' && test -z "$GH_REPO" && printf '{"id":19}'\n`, { mode: 0o755 });
      writeFileSync(join(bin, "herdr-app"), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
if (process.argv[2] === 'ls') {
  console.log(JSON.stringify({ spaces: state.spaces }));
  process.exit(0);
}
const cmd = process.argv[3];
const args = JSON.parse(process.argv[4]);
fs.appendFileSync(${JSON.stringify(tabLog)}, JSON.stringify([cmd, args]) + '\\n');
const id = state.seq++;
const pane = 'p' + id;
const terminal = 't' + (10 + id);
if (cmd === 'tab.new') {
  const space = state.spaces.find(s => s.id === args.space);
  const tabId = 'tb' + id;
  if (space) space.tabs.push({ id: tabId, name: args.name ?? null, active: true, terminals: [{ terminal, pane, status: null, app: null, name: null }] });
  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
  console.log(JSON.stringify({ tab: tabId, pane, terminal }));
}
`, { mode: 0o755 });
      const { CLAUDE_CONFIG_DIR: _claude, PI_CODING_AGENT_DIR: _pi, HC_TERMINAL_ID: _terminal, HERDR_ENV: _herdr, ...base } = process.env;
      const env = { ...base, ...registryEnv(home), TMPDIR: scratch, GH_REPO: "another/repo", REPO_HARNESS_GH_BIN: gh, HC_TERMINAL_ID: "t5",
        PATH: [bin, dirname(process.execPath), "/bin", "/usr/bin"].join(delimiter) };
      const council = (...args: string[]) => spawnSync(process.execPath, [CLI, "seats", "council", "--issue", "42", "--members", "fable,carbon", ...args], { env, cwd: worktree, encoding: "utf8" });

      git(repo, "remote", "add", "origin", "https://github.com/example/council-test.git");
      const dry = council("--dry-run", "--json");
      expect(dry.status, dry.stderr).toBe(0);
      const councilDir = join(scratch, "rh-council", basename(repo));
      expect(JSON.parse(dry.stdout)).toEqual({
        protocol: 1, kind: "repo-harness.seats.council", dry_run: true, seat: "council", issue: 42, parent: null,
        members: [
          { member: "fable", runtime: "claude", model: "fable", pane_name: "rh-cn-42-fable", tab: "council", out_path: join(councilDir, "issue-42-fable.md") },
          { member: "carbon", runtime: "pi", model: "magpie/agy-cli/gemini-4-carbon", pane_name: "rh-cn-42-carbon", tab: "council", out_path: join(councilDir, "issue-42-carbon.md") },
        ],
      });
      expect(existsSync(join(scratch, "rh-council"))).toBe(false);
      expect(existsSync(join(home, ".repo-harness", "seats", "pi-fleet"))).toBe(false);
      expect(existsSync(tabLog)).toBe(false);

      const outDir = join(scratch, "out");
      const applied = council("--repository-id", "20", "--parent", "7", "--qualifier", "api", "--out-dir", outDir);
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stdout).toContain(`rh-cn-42-fableapi → ${join(outDir, "issue-42-fable-api.md")}`);
      expect(applied.stdout).toContain(`rh-cn-42-carbonapi → ${join(outDir, "issue-42-carbon-api.md")}`);
      const ops = readFileSync(tabLog, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as [string, Record<string, unknown>]);
      expect(ops).toHaveLength(2);
      const [cmd0, tab0] = ops[0]!;
      const [cmd1, split1] = ops[1]!;
      expect([cmd0, tab0]).toEqual(["tab.new", expect.objectContaining({ name: "council", space: "sp-auto", folder: worktree })]);
      expect([cmd1, split1]).toEqual(["hc.run", expect.objectContaining({ cwd: worktree, space: "sp-auto", tab: "tb1", keep: true, noParent: true })]);
      expect((tab0.argv as string[]).some((arg: string) => arg.includes("seats label council --repository-id 20 --issue 42 --parent 7"))).toBe(true);
      expect(values(split1.argv as string[], "--exclude-tools")).toEqual(["edit,write"]);
      expect((split1.argv as string[]).join(" ")).not.toContain("cd --");
      expect(tab0.task).toContain(join(outDir, "issue-42-fable-api.md"));
      expect((split1.argv as string[]).at(-2)).toBe("--");
      expect((split1.argv as string[]).at(-1)).toContain(join(outDir, "issue-42-carbon-api.md"));
      expect(readFileSync(ghLog, "utf8").trim().split("\n")).toEqual(["api --hostname github.com repos/{owner}/{repo}"]);
      for (const checkout of [repo, worktree]) {
        const status = spawnSync("git", ["status", "--porcelain"], { cwd: checkout, env, encoding: "utf8" });
        expect([status.status, status.stdout]).toEqual([0, ""]);
      }
    }));
  });

  test("seats council refuses missing launch inputs and invalid members", () => {
    withHome(undefined, home => withRepository(home, "rh", (repo) => {
      const { CLAUDE_CONFIG_DIR: _claude, PI_CODING_AGENT_DIR: _pi, HC_TERMINAL_ID: _terminal, ...base } = process.env;
      const env = { ...base, ...registryEnv(home), PATH: [join(home, ".quota-bin"), dirname(process.execPath), "/bin", "/usr/bin"].join(delimiter) };
      const councilError = (...args: string[]) => {
        const result = spawnSync(process.execPath, [CLI, "seats", "council", ...args], { env, cwd: repo, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(1);
        return JSON.parse(result.stderr).error;
      };
      expect(councilError("--issue", "42", "--members", "neon", "--dry-run")).toBe("council_member_invalid");
      expect(councilError("--issue", "42", "--members", "fable,fable", "--dry-run")).toBe("council_member_invalid");
      expect(councilError("--issue", "42", "--members", "fable", "--dry-run")).toBe("repository_id_required");
      const labels = ["--issue", "42", "--members", "fable", "--repository-id", "19"];
      expect(councilError(...labels)).toBe("seat_space_missing");
      expect(councilError(...labels, "--parent", "0", "--dry-run")).toBe("label_value_invalid");
      expect(councilError("--issue", "42", "--members", "fable,carbon", "--repository-id", "19", "--out", "/tmp/a.md", "--dry-run")).toBe("council_launch_invalid");
    }));
  });

  test("a Claude council keeps its configuration in saving and hyper modes", () => {
    const council = { ...DEFAULT_SEATS_CONFIG.reviewer, model: "fable", advisor_model: null, effort: "medium" };
    const seats = { ...DEFAULT_SEATS_CONFIG, council };
    const quota = seatAccountQuotas([], seats.routing);
    for (const mode of ["saving", "hyper"] as const) {
      expect(effectiveSeatConfig("council", seats, { ...quota, claude: { ...quota.claude, mode } })).toEqual(council);
    }
  });

  test("seats launch opens the seats argv launch in a Herdr.app tab and fails closed without a space or a tab (#3166)", () => {
    withHome(undefined, (home) => {
      withRepository(home, "rh", (repo, worktree) => {
        // A fake hc and a fake herdr-app first on PATH: no real terminal or tab is touched.
        const bin = join(home, "bin"), piBin = join(home, "pi-bin"), log = join(home, "calls.log");
        mkdirSync(bin);
        mkdirSync(piBin);
        mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
        writeFileSync(join(home, ".pi", "agent", "extensions", "magpie.ts"), "");
        writeFileSync(join(piBin, "pi"), "#!/bin/sh\nexit 0\n");
        writeFileSync(join(bin, "hc"), `#!/bin/sh\nprintf 'hc %s\\n' "$*" >> "${log}"\n`
          + `printf '{"address":"t5","state":"live","turn":0,"labels":{%s}}' "\${FAKE_SPACE+\\"herdr.space\\":\\"$FAKE_SPACE\\"}"\n`);
        writeFileSync(join(bin, "herdr-app"), `#!/bin/sh\nprintf 'herdr-app %s\\n' "$*" >> "${log}"\n`
          + `if [ "$1" = "ls" ]; then\n`
          + `  if [ -n "$FAKE_HERDR_LS_FAIL" ]; then printf '%s' '{"error":"no window"}'; exit 1; fi\n`
          + `  printf '%s' '{"spaces":[]}'\n  exit 0\nfi\n`
          + `if [ -n "$FAKE_HERDR_FAIL" ]; then printf '%s' '{"error":"no window"}'; exit 1; fi\nprintf '%s' '{"tab":"tb1","terminal":"t9"}'\n`);
        chmodSync(join(piBin, "pi"), 0o755);
        for (const name of ["hc", "herdr-app"]) chmodSync(join(bin, name), 0o755);
        const { CLAUDE_CONFIG_DIR: _c, PI_CODING_AGENT_DIR: _p, HC_TERMINAL_ID: _t, HERDR_ENV: _h, ...base } = process.env;
        const labels = ["worker", "--repository-id", "1186405141", "--parent", "1000", "--issue", "1473"];
        const seats = (env: Record<string, string>, args: string[]) => {
          writeFileSync(log, "");
          const result = spawnSync(process.execPath, [CLI, "seats", ...args], { cwd: repo, encoding: "utf8",
            env: { ...base, ...registryEnv(home), BUN_INSTALL: join(home, ".bun"), PATH: `${bin}${delimiter}${piBin}${delimiter}${join(home, ".quota-bin")}${delimiter}${dirname(process.execPath)}${delimiter}/bin${delimiter}/usr/bin`, ...env } });
          return { status: result.status, stdout: result.stdout, error: result.status === 0 ? null : JSON.parse(result.stderr).error, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
        };
        const argvLaunch = JSON.parse(seats({}, ["argv", ...labels, "--json"]).stdout);
        const launchArgs = [...labels, "--cwd", worktree, "--task", "Task: issue #1473"];

        // The space comes from the herdr.space label of the calling terminal, which may carry no repo-harness label (an
        // ordinary Herdr.app shell); the tab gets the seats argv argv and its issue tab name (#1473).
        const opened = seats({ HC_TERMINAL_ID: "t5", FAKE_SPACE: "sp1" }, ["launch", ...launchArgs]);
        expect([opened.status, JSON.parse(opened.stdout).placement, opened.calls[0]]).toEqual([0, { tab: "tb1", terminal: "t9" }, "hc get --json -- t5"]);
        expect(opened.calls.slice(1).map(line => line.split(" ").slice(0, 3).join(" "))).toEqual(["herdr-app ls", "herdr-app do tab.new"]);
        expect(JSON.parse(opened.calls[2]!.slice("herdr-app do tab.new ".length))).toEqual({
          name: "#1473", space: "sp1", folder: worktree, argv: argvLaunch.argv, task: "Task: issue #1473", focus: false });

        // No --space and a caller without a herdr.space label, a blank caller label, or a blank --space: no tab and no headless terminal.
        for (const [env, space] of [[{}, []], [{ HC_TERMINAL_ID: "t5" }, []], [{ HC_TERMINAL_ID: "t5", FAKE_SPACE: " " }, []], [{}, ["--space", " "]]] as [Record<string, string>, string[]][]) {
          const missing = seats(env, ["launch", ...launchArgs, ...space]);
          expect([missing.status, missing.error, missing.calls.filter(line => !line.startsWith("hc get "))]).toEqual([1, "seat_space_missing", []]);
        }

        // Herdr.app refuses the tab after ls succeeds: the launch fails closed as seat_tab_unknown and never falls back to hc run.
        const refused = seats({ FAKE_HERDR_FAIL: "1" }, ["launch", ...launchArgs, "--space", "mini-cf/sp2"]);
        expect([refused.status, refused.error, refused.calls.map(line => line.split(" ").slice(0, 3).join(" "))]).toEqual([1, "seat_tab_unknown", ["herdr-app ls", "herdr-app do tab.new"]]);
        // Herdr.app ls fails before any mutation: fails closed as seat_tab_failed without sending tab.new.
        const lsFailed = seats({ FAKE_HERDR_LS_FAIL: "1" }, ["launch", ...launchArgs, "--space", "sp1"]);
        expect([lsFailed.status, lsFailed.error, lsFailed.calls]).toEqual([1, "seat_tab_failed", ["herdr-app ls"]]);
        // No herdr-app on PATH: no request was sent, so the tab surely does not exist.
        const absent = seats({ PATH: `${piBin}${delimiter}${join(home, ".quota-bin")}${delimiter}${dirname(process.execPath)}${delimiter}/bin${delimiter}/usr/bin` }, ["launch", ...launchArgs, "--space", "sp1"]);
        expect([absent.status, absent.error, absent.calls]).toEqual([1, "seat_tab_failed", []]);
      });
    });
  });

  test("seats launch and council enforce Option A tab naming (#<issue>, PR#<pr>, council) and 3-pane hc.run tab packing with worktree cwd (#3494)", () => {
    const seatsConfig = {
      ...DEFAULT_SEATS_CONFIG,
      council: PI_COUNCIL,
      reviewer: { ...DEFAULT_SEATS_CONFIG.reviewer, runtime: "pi" as const, model: "magpie/group/deepseek-v4.1-flash", effort: null },
    };
    withHome(seatsConfig, (home) => {
      withRepository(home, "rh", (repo, worktree) => {
        const bin = join(home, "bin");
        const stateFile = join(home, "herdr-state.json");
        const opsLog = join(home, "ops.log");
        const scratch = realpathSync(mkdirSync(join(home, "scratch"), { recursive: true })!);
        mkdirSync(bin);
        mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
        writeFileSync(join(home, ".pi", "agent", "extensions", "magpie.ts"), "");
        writeFileSync(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(join(bin, "agy"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
        writeFileSync(stateFile, JSON.stringify({
          spaces: [{ id: "sp1", name: "repo-harness", folder: repo, machine: null, active: true, tabs: [] }],
          terminals: {},
          seq: 1,
        }));
        writeFileSync(join(bin, "hc"), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
const sub = process.argv[2];
if (sub === 'ls') {
  const terminals = Object.values(state.terminals).map(t => ({ address: t.address, name: t.name, state: t.state, agent: t.agent }));
  console.log(JSON.stringify({ terminals }));
} else if (sub === 'get') {
  const addr = process.argv[process.argv.length - 1];
  const found = state.terminals[addr] ?? { address: addr, name: null, state: 'live', turn: 0, labels: { 'herdr.space': 'sp1' }, status: null, pid: null, foreground: null, reason: null, cwd: null };
  console.log(JSON.stringify(found));
} else if (sub === 'run') {
  const args = process.argv.slice(3);
  const sep = args.indexOf('--');
  const flags = sep === -1 ? args : args.slice(0, sep);
  const labels = {};
  let cwd = null;
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--cwd') cwd = flags[++i];
    else if (flags[i] === '--label') {
      const pair = flags[++i];
      const eq = pair.indexOf('=');
      labels[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  const id = state.seq++;
  const pane = 'p' + id;
  const terminal = 't' + (10 + id);
  fs.appendFileSync(${JSON.stringify(opsLog)}, JSON.stringify(['hc.run', {
    cwd,
    keep: flags.includes('--keep'),
    noParent: flags.includes('--no-parent'),
    space: labels['herdr.space'] ?? null,
    tab: labels['herdr.tab'] ?? null,
  }]) + '\\n');
  if (process.env.DELAY_ADOPTION !== '1') {
    const space = state.spaces.find(s => s.id === labels['herdr.space']);
    const tab = space?.tabs.find(t => t.id === labels['herdr.tab']);
    if (tab) tab.terminals.push({ terminal, pane, status: null, app: null, name: null });
  }
  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
  console.log(JSON.stringify({ address: terminal, state: 'live', cwd }));
}
`, { mode: 0o755 });
        writeFileSync(join(bin, "herdr-app"), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
if (process.argv[2] === 'ls') {
  console.log(JSON.stringify({ spaces: state.spaces }));
  process.exit(0);
}
const cmd = process.argv[3];
const args = JSON.parse(process.argv[4]);
fs.appendFileSync(${JSON.stringify(opsLog)}, JSON.stringify([cmd, args]) + '\\n');
const id = state.seq++;
const pane = 'p' + id;
const terminal = 't' + (10 + id);
const space = state.spaces.find(s => s.id === 'sp1');
if (cmd === 'tab.new') {
  const tabId = 'tb' + id;
  space.tabs.push({ id: tabId, name: args.name ?? null, active: true, terminals: [{ terminal, pane, status: null, app: null, name: null }] });
  fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state));
  console.log(JSON.stringify({ tab: tabId, pane, terminal }));
}
`, { mode: 0o755 });
        const { CLAUDE_CONFIG_DIR: _c, PI_CODING_AGENT_DIR: _p, HC_TERMINAL_ID: _t, HERDR_ENV: _h, ...base } = process.env;
        const env = {
          ...base, ...registryEnv(home), BUN_INSTALL: join(home, ".bun"), TMPDIR: scratch,
          PATH: [bin, join(home, ".quota-bin"), dirname(process.execPath), "/bin", "/usr/bin"].join(delimiter),
        };
        const runSeats = (args: string[], extraEnv: Record<string, string> = {}) => {
          const result = spawnSync(process.execPath, [CLI, "seats", ...args], { cwd: repo, env: { ...env, ...extraEnv }, encoding: "utf8" });
          expect(result.status, result.stderr).toBe(0);
          return result;
        };
        const readOps = () => readFileSync(opsLog, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as [string, Record<string, unknown>]);

        // 1. Two workers for #2479 and #2461 under --parent 2457 open distinct tabs #2479 and #2461 (no duplicate #2457).
        // Start w1 in the primary checkout (repo) while its PR lives in worktree (P1 trigger setup).
        const w1 = JSON.parse(runSeats(["launch", "worker", "--repository-id", "1", "--parent", "2457", "--issue", "2479", "--space", "sp1", "--cwd", repo, "--task", "Task #2479"]).stdout);
        const w2 = JSON.parse(runSeats(["launch", "worker", "--repository-id", "1", "--parent", "2457", "--issue", "2461", "--space", "sp1", "--cwd", repo, "--task", "Task #2461"]).stdout);
        expect([w1.tab, w2.tab]).toEqual(["#2479", "#2461"]);
        // Record w1 as a live hc worker terminal with cwd = worktree so standalone seats launch discovers it by cwd/pr.
        const stateAfterWorkers = JSON.parse(readFileSync(stateFile, "utf8"));
        stateAfterWorkers.terminals[w1.placement.terminal] = {
          address: w1.placement.terminal, name: null, state: "live", agent: "pi", turn: 0, status: null, pid: null, foreground: null, reason: null,
          cwd: worktree, labels: { "repo-harness.repository": "1", "repo-harness.seat": "worker", "repo-harness.issue": "2479", "repo-harness.parent": "2457" },
        };
        writeFileSync(stateFile, JSON.stringify(stateAfterWorkers));

        // 2. Launching gatekeeper and reviewer for PR #2485 joins #2479 (tb1) via hc.run with --cwd worktree (--keep --no-parent).
        const gk = JSON.parse(runSeats(["launch", "gatekeeper", "--repository-id", "1", "--pr", "2485", "--space", "sp1", "--cwd", worktree, "--task", "Review PR#2485 gk"]).stdout);
        const rv = JSON.parse(runSeats(["launch", "reviewer", "--repository-id", "1", "--pr", "2485", "--space", "sp1", "--cwd", worktree, "--task", "Review PR#2485 rv"]).stdout);
        expect([gk.tab, rv.tab]).toEqual(["#2479", "#2479"]);

        // 3. Now #2479 has 3 panes (full): further review launches for PR #2485 open PR#2485, pack up to 3 panes, then open PR#2485 2.
        const fb1 = JSON.parse(runSeats(["launch", "gatekeeper", "--repository-id", "1", "--pr", "2485", "--space", "sp1", "--cwd", worktree, "--task", "Fallback 1"]).stdout);
        const fb2 = JSON.parse(runSeats(["launch", "gatekeeper", "--repository-id", "1", "--pr", "2485", "--space", "sp1", "--cwd", worktree, "--task", "Fallback 2"]).stdout);
        const fb3 = JSON.parse(runSeats(["launch", "gatekeeper", "--repository-id", "1", "--pr", "2485", "--space", "sp1", "--cwd", worktree, "--task", "Fallback 3"]).stdout);
        const fb4 = JSON.parse(runSeats(["launch", "gatekeeper", "--repository-id", "1", "--pr", "2485", "--space", "sp1", "--cwd", worktree, "--task", "Fallback 4"]).stdout);
        expect([fb1.tab, fb2.tab, fb3.tab, fb4.tab]).toEqual(["PR#2485", "PR#2485", "PR#2485", "PR#2485 2"]);

        // 4. Council packs 3 panes into 'council', then a subsequent council launch opens 'council 2'.
        // Even with DELAY_ADOPTION=1 (simulating async Herdr.app adoption during a single council run), a 2-pane council tab only admits 1 more pane before overflowing to 'council 2'.
        runSeats(["council", "--issue", "42", "--members", "fable,carbon,astra", "--repository-id", "1", "--space", "sp1", "--out-dir", join(scratch, "c1")]);
        runSeats(["council", "--issue", "43", "--members", "fable", "--repository-id", "1", "--space", "sp1", "--out-dir", join(scratch, "c2")]);
        runSeats(["council", "--issue", "44", "--members", "fable,carbon,astra", "--repository-id", "1", "--space", "sp1", "--out-dir", join(scratch, "c3")], { DELAY_ADOPTION: "1" });

        const ops = readOps();
        expect(ops.map(([cmd, args]) => cmd === "tab.new"
          ? [cmd, args.name]
          : [cmd, args.space, args.tab, args.cwd, args.keep, args.noParent])).toEqual([
          ["tab.new", "#2479"],
          ["tab.new", "#2461"],
          ["hc.run", "sp1", "tb1", worktree, true, true],
          ["hc.run", "sp1", "tb1", worktree, true, true],
          ["tab.new", "PR#2485"],
          ["hc.run", "sp1", "tb5", worktree, true, true],
          ["hc.run", "sp1", "tb5", worktree, true, true],
          ["tab.new", "PR#2485 2"],
          ["tab.new", "council"],
          ["hc.run", "sp1", "tb9", repo, true, true],
          ["hc.run", "sp1", "tb9", repo, true, true],
          ["tab.new", "council 2"],
          // Under DELAY_ADOPTION=1, 'council 2' (tb12) starts with 1 pane -> fable & carbon join tb12 (2nd & 3rd panes), astra overflows to 'council 3'.
          ["hc.run", "sp1", "tb12", repo, true, true],
          ["hc.run", "sp1", "tb12", repo, true, true],
          ["tab.new", "council 3"],
        ]);
      });
    });
  });

  test("a name over 32 characters and an entry without a prefix fail closed", () => {
    withHome(undefined, (home) => {
      withRepository(home, "rhlong", (repo) => {
        const result = run(registryEnv(home), ["worker", "--repository-id", "1", "--issue", "1508", "--qualifier", "averyveryverylongslice", "--json"], repo);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(JSON.parse(result.stderr).error).toBe("pane_name_invalid");
      });
      withRepository(home, undefined, (repo) => {
        const result = run(registryEnv(home), ["orchestrator", "--repository-id", "1", "--json"], repo);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stderr).error).toBe("pane_name_invalid");
        expect(JSON.parse(result.stderr).message).toContain("seats prefix");

        const prefix = (value: string) => spawnSync(process.execPath, [CLI, "seats", "prefix", "--repo", repo, "--pane-prefix", value], { env: { ...process.env, ...registryEnv(home) }, encoding: "utf8" });
        expect(prefix("Bad").status).toBe(1);
        const set = prefix("rhx");
        expect(set.status).toBe(0);
        expect(JSON.parse(set.stdout)).toEqual(expect.objectContaining({ ok: true, registered: true, changed: true, panePrefix: "rhx" }));
        const registry = JSON.parse(readFileSync(join(home, ".repo-harness", "registered-repos.json"), "utf8"));
        expect([registry.authorizationRevision, registry.repos[0].accessMode, registry.repos[0].panePrefix]).toEqual([0, "read_only", "rhx"]);
        expect(JSON.parse(run(registryEnv(home), ["orchestrator", "--repository-id", "1", "--json"], repo).stdout).name).toContain("rhx");
      });
    });
  });

  test("advisor and council briefs emit raw-evidence, analogy-break, and external-check rigor without changing tool limits or flags", () => {
    const advisorRigor = "Start from raw source files and live command output rather than summaries, probe experiment-settleable choices before proposing, distinguish candidate problems by observable signs when a request is ambiguous, and cut unverified citations or links.";
    const councilRigor = "For any borrowed pattern from another system or field, state what carries over and where the analogy breaks, and name at least one external check beyond the writer and reviewer that proves the result.";

    const seats = {
      ...DEFAULT_SEATS_CONFIG,
      advisor: { ...DEFAULT_SEATS_CONFIG.advisor, runtime: "pi" as const, model: "magpie/agy-cli/gemini-4-neon", effort: "high" as const, tools: ["mcp", "net", "read", "shell"] as const, fleet: [] },
      council: { ...DEFAULT_SEATS_CONFIG.reviewer, runtime: "codex" as const, model: "gpt-6.2-astra", fleet: [] },
    };
    withHome(seats, (home) => withRepository(home, "rh", (_repo, worktree) => {
      writeFileSync(join(home, ".quota-bin", "agy"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
      const advisorRes = argv(home, "advisor", "--json");
      expect(advisorRes.status, advisorRes.stderr).toBe(0);
      const advisor = JSON.parse(advisorRes.stdout);
      expect(advisor.brief).toContain(advisorRigor);
      expect(advisor.brief).not.toContain(councilRigor);
      expect(advisor.argv).toContain(advisor.brief);
      expect(bare(advisor.argv)).not.toContain("--exclude-tools");
      expect(bare(advisor.argv)).not.toContain("--no-skills");
      expect(advisor.limits).toEqual([
        { subject: "edit", level: "instructions_only" },
        { subject: "tasks", level: "instructions_only" },
        { subject: "gh", level: "instructions_only" },
        { subject: "fleet", level: "instructions_only" },
      ]);

      const councilRes = run(registryEnv(home), ["council", "--repository-id", "1", "--issue", "42", "--json"], worktree);
      expect(councilRes.status, councilRes.stderr).toBe(0);
      const council = JSON.parse(councilRes.stdout);
      expect(council.brief).toContain(councilRigor);
      expect(council.brief).not.toContain(advisorRigor);
      expect(bare(agent(council))).toContain("read-only");
      expect(bare(agent(council))).toContain(`developer_instructions=${JSON.stringify(council.brief)}`);
      expect(council.limits).toContainEqual({ subject: "edit", level: "common_commands" });

      const worker = launch(home, "worker");
      expect(worker.brief).not.toContain(advisorRigor);
      expect(worker.brief).not.toContain(councilRigor);
    }));
  });

  test("an invalid seats section fails closed", () => {
    withHome({ advisor: {} }, (home) => {
      const result = argv(home, "advisor", "--json");
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error).toBe("config_invalid");
    });
    // The refusal names the seat field, not its value (#3244).
    withHome({ ...DEFAULT_SEATS_CONFIG, advisor: { ...DEFAULT_SEATS_CONFIG.advisor, model: "Claude Opus" } }, (home) => {
      expect(JSON.parse(argv(home, "worker", "--json").stderr)).toMatchObject({ error: "config_invalid", message: "The seats section of the repo-harness configuration is not valid at seats.advisor.model." });
    });
  });
});

describe("rh seats handoff (#2175)", () => {
  test("it fails closed without a seat identity, a session record or a context, else records the request and prints the hook steps", () => {
    const home = mkdtempSync(join(tmpdir(), "seats-handoff-"));
    // The seat directory is fixed under /tmp; a repository id per run keeps the runs apart.
    const repository = String(8_000_000_000 + process.pid);
    const dir = join("/tmp/repo-harness-seats", repository, "orchestrator");
    const transcript = join(home, "transcript.jsonl");
    const handoff = (seat: Record<string, string>) => {
      const { REPO_HARNESS_SEAT: _seat, REPO_HARNESS_SEAT_REPOSITORY: _repository, ...base } = process.env;
      const result = spawnSync(process.execPath, [CLI, "seats", "handoff"], { env: { ...base, HOME: home, ...seat }, encoding: "utf8" });
      return { status: result.status, stdout: result.stdout, error: result.stderr === "" ? null : JSON.parse(result.stderr).error };
    };
    const seat = { REPO_HARNESS_SEAT: "orchestrator", REPO_HARNESS_SEAT_REPOSITORY: repository };
    try {
      const failures = [handoff({}), handoff({ REPO_HARNESS_SEAT: "worker", REPO_HARNESS_SEAT_REPOSITORY: repository }), handoff(seat)];
      mkdirSync(dir, { recursive: true });
      // A record with a readable transcript but any field unlike recordSeatSession writes it is not the SessionStart record.
      writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10 } } })}\n`);
      const record = { session_id: "s", transcript_path: transcript, source: "startup", started_at: new Date().toISOString() };
      const { session_id: _missing, ...noSessionId } = record;
      const malformed = [{ transcript_path: transcript }, noSessionId, { ...record, source: "bogus" }, { ...record, started_at: "2024" }];
      for (const bad of malformed) {
        writeFileSync(join(dir, "session.json"), JSON.stringify(bad));
        failures.push(handoff(seat));
      }
      writeFileSync(join(dir, "session.json"), JSON.stringify(record));
      writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })}\n`);
      failures.push(handoff(seat));
      expect(failures).toEqual([
        { status: 1, stdout: "", error: "seat_identity_missing" }, { status: 1, stdout: "", error: "seat_identity_missing" },
        { status: 1, stdout: "", error: "seat_session_unknown" },
        ...malformed.map(() => ({ status: 1, stdout: "", error: "seat_session_unknown" })),
        { status: 1, stdout: "", error: "seat_context_unknown" },
      ]);
      expect(existsSync(join(dir, "request.json"))).toBe(false);

      writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 5 } } })}\n`, { flag: "a" });
      const identity = { seat: "orchestrator", repository } as const;
      expect(handoff(seat)).toEqual({ status: 0, stdout: `${seatResetSteps(identity, "compact")}\n`, error: null });
      // The Stop hook prints the same steps after its token line.
      expect(seatResetReason(identity, 1, 1, "compact").split("\n").slice(1).join("\n")).toBe(seatResetSteps(identity, "compact"));
      const request = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
      expect([request.context_tokens, request.transcript_path, Number.isFinite(Date.parse(request.requested_at)), request.action, request.transcript_bytes])
        .toEqual([200_015, transcript, true, "compact", statSync(transcript).size]);

      const piNow = new Date();
      const piTranscript = join(home, "pi-transcript.jsonl");
      writeFileSync(piTranscript, `${JSON.stringify({
        type: "message", id: "m1", parentId: null, timestamp: piNow.toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions", provider: "magpie", model: "agy-cli/gemini-4-neon", stopReason: "stop", timestamp: piNow.getTime(), usage: { input: 200_000, output: 10, cacheRead: 190_000, cacheWrite: 0, totalTokens: 390_010 } },
      })}\n`);
      recordSeatSession({ seat: "advisor", repository }, { sessionId: "pi-s", transcriptPath: piTranscript, source: "startup", host: "pi", model: "magpie/agy-cli/gemini-4-neon", effort: "xhigh" }, piNow);
      expect(readSeatSession({ seat: "advisor", repository })).toMatchObject({ host: "pi", sessionId: "pi-s", transcriptPath: piTranscript });
      expect(seatHandoff({ REPO_HARNESS_SEAT: "advisor", REPO_HARNESS_SEAT_REPOSITORY: repository })).toBe(seatResetSteps({ seat: "advisor", repository }, "compact", "pi"));
      expect(JSON.parse(readFileSync(join("/tmp/repo-harness-seats", repository, "advisor", "request.json"), "utf8")).host).toBe("pi");
    } finally {
      rmSync(join("/tmp/repo-harness-seats", repository), { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("rh seats reset (#1972)", () => {
  let runs = 0;
  const ended = { ended: true, reason: "status", turn: 3, status: "idle" };
  const timeouts = { signalMs: 300, compactSignalMs: 300, evidenceMs: 300, exitMs: 300, pollMs: 20 };
  type ResetInput = { path?: string; text?: string; sha256?: string; caller?: string; request?: boolean; fresh?: boolean; stale?: boolean; handoff?: boolean;
    resolveLaunch?: SeatResetOptions["resolveLaunch"]; relaunch?: SeatResetOptions["relaunch"]; before?: () => void;
    notify?: SeatResetNotify; action?: "compact" | "reset" | null; host?: "claude" | "pi" | "antigravity" };
  /**
   * A fake hc at the hc boundary: no real terminal is read or written. `/clear` writes the new-session signal of a new
   * transcript and `/compact` a compact record of the request transcript when `signal` is on, a relaunch line always writes it, `/exit` ends claude when `exit` is on, and every resume prompt
   * lands in the new transcript. The model answers earlier prompts with text only, and prompt number `evidenceFrom` and
   * later with the Bash tool call that sends RESUMED and its tool result, an error result before prompt `errorUntil`.
   * `answers[n]` replaces the command and the result (ok, error or none) of prompt n + 1.
   * `sendFail` refuses a send.
   */
  function withReset(fn: (f: { handoff: string; body: string; sha: (text: string) => string; state: (patch: Record<string, unknown>) => void;
    reset: (input?: ResetInput) => Promise<unknown>;
    home: string; relaunchPath: () => string; sends: () => string[]; calls: () => string[]; log: () => { kind: string; detail: string; notice: string; requested_at: string }[] }) => Promise<void>, seat: "advisor" | "orchestrator" = "advisor") {
    return async () => {
      const home = mkdtempSync(join(tmpdir(), "seats-reset-"));
      // The handoff path is fixed under /tmp; a repository id per run keeps the runs apart.
      const repository = String(9_000_000_000 + process.pid * 10 + (runs += 1));
      const dir = join("/tmp/repo-harness-seats", repository, seat);
      const handoff = join(dir, "handoff.md");
      try {
        mkdirSync(join(home, "bin"));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(home, "bin", "hc"), `#!${process.execPath}
const fs = require("fs");
const { spawnSync } = require("child_process");
const [cmd, , ...rest] = process.argv.slice(2);
const st = JSON.parse(fs.readFileSync("${home}/state.json", "utf8"));
fs.appendFileSync("${home}/calls.log", [cmd, ...rest].join(" ") + "\\n");
const out = value => process.stdout.write(JSON.stringify(value));
const session = (transcript, source = "clear") => fs.writeFileSync("${dir}/session.json", JSON.stringify({ session_id: "s", transcript_path: transcript, source, started_at: new Date().toISOString(), ...(st.host ? { host: st.host } : {}) }));
const writeAgyTurn = (transcript, content) => {
  const step = st.answers[0] ?? { command: "hc send t2 RESUMED", result: "ok" };
  const write = entry => fs.appendFileSync(transcript, JSON.stringify(entry) + "\\n");
  write({ type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", step_index: 0, content });
  write({ type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", step_index: 1,
    tool_calls: [{ name: "run_command", args: { CommandLine: step.command, WaitMsBeforeAsync: 1000 } }] });
  if (step.result !== "none") write({ type: "GENERIC", source: "MODEL", status: "DONE", step_index: step.result === "unrelated" ? 3 : 2,
    content: "Created At: 2026-11-23T16:08:20+08:00\\nCompleted At: 2026-11-23T16:08:21+08:00\\n"
      + (step.result === "error" ? "Command exited with code 1.\\n\\nCommand output:\\nCommand exited with code 0." : "Command exited with code 0.\\n\\nCommand output:\\n") });
};
if (cmd === "ls") out({ terminals: st.terminals });
if (cmd === "get") {
  const peer = rest.at(-1) === "t2";
  const state = peer ? "live" : st.requesterState ?? "live";
  if (!peer && st.exited && Array.isArray(st.exitSequence) && st.exitSequence.length > 0) {
    st.foreground = st.exitSequence.length > 1 ? st.exitSequence.shift() : st.exitSequence[0];
  }
  const fg = state === "finished" ? null : typeof st.foreground === "object" && st.foreground !== null
    ? { cwd: "/", ...st.foreground }
    : { pid: st.foreground === "zsh" ? st.pid ?? 1 : 2, name: st.foreground, argv: [st.foreground === "node" ? "pi" : st.foreground], cwd: "/" };
  out({ address: rest.at(-1), state, labels: peer ? st.callerLabels : { "repo-harness.seat": "${seat}", "repo-harness.repository": "${repository}" },
    turn: st.turn ?? 3, cwd: st.cwd, pid: st.pid ?? 1, status: st.status, foreground: fg });
}
// wait is one result, or a sequence: the last result answers every later call.
// Wait number waitDelayAt (from 1) answers after waitDelayMs, as a message that arrives late does.
if (cmd === "wait") {
  st.waits = (st.waits ?? 0) + 1;
  if (st.waitDelayAt === st.waits) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, st.waitDelayMs);
  out(Array.isArray(st.wait) ? (st.wait.length > 1 ? st.wait.shift() : st.wait[0]) : st.wait);
}
// As the real hc: keys arrive as typed input; send wraps its text in an envelope, so a sent slash command is chat text.
if (cmd === "keys") {
  const line = rest.slice(2).filter(key => key !== "enter").map(key => (key === "space" ? " " : key)).join("");
  if ((line === "/clear" || line === "/new") && st.signal) session("${home}/cleared.jsonl");
  if ((line === "/clear" || line === "/new") && st.untrackOnClear) st.status = null;
  if (line === "/compact" && st.signal) session("${home}/old.jsonl", "compact");
  if (line === "/exit" || line === "/quit") {
    if (!fs.readdirSync("${dir}").some(name => name.startsWith("claim-"))) process.exit(1);
    if (st.exit) {
      st.exited = true;
      if (!Array.isArray(st.exitSequence) || st.exitSequence.length === 0) st.foreground = st.exitForeground ?? "zsh";
    }
  }
  if (line.startsWith("sh ")) {
    if (typeof st.foreground === "object" && st.foreground !== null && Array.isArray(st.foreground.argv) && st.foreground.argv.includes("-lic")) process.exit(1);
    if (st.destinationHost) st.host = st.destinationHost;
    st.exited = false;
    st.foreground = st.host === "antigravity" ? "agy" : st.host === "pi" ? "pi" : "claude";
    if (st.host === "antigravity") {
      st.status = { state: "idle", app: "antigravity" };
      const scriptPath = line.slice("sh ".length);
      if (st.runRelaunchScript) {
        const run = spawnSync("/bin/sh", [scriptPath], { env: process.env });
        if (run.status !== 0) process.exit(run.status ?? 1);
      } else {
        const text = fs.readFileSync(scriptPath, "utf8");
        const marker = " -i '";
        const start = text.indexOf(marker);
        const end = text.lastIndexOf("'");
        const initialPrompt = start !== -1 && end > start
          ? text.slice(start + marker.length, end).split("'" + String.fromCharCode(92) + "''").join("'")
          : null;
        if (initialPrompt !== null && st.agyNoSignal !== true) {
          const logs = "${home}/.gemini/antigravity-cli/brain/s/.system_generated/logs";
          fs.mkdirSync(logs, { recursive: true });
          const transcript = logs + "/transcript_full.jsonl";
          session(transcript, "startup");
          writeAgyTurn(transcript, initialPrompt);
        }
      }
    } else session("${home}/relaunched.jsonl", "startup");
  }
  out({ status: null, turn: 4 });
}
if (cmd === "send" && st.sendFail) { process.stderr.write(JSON.stringify({ error: { kind: "blocked", message: "blocked" } })); process.exit(9); }
if (cmd === "send") {
  const text = rest[rest.length - 1];
  if (text.startsWith("You are")) {
    const transcript = JSON.parse(fs.readFileSync("${dir}/session.json", "utf8")).transcript_path;
    const wrapped = \`<hc from="t2">\${text}</hc>\`;
    // st.forgeQueued writes the forged first prompt: one assistant entry carries a queued_command field and a RESUMED
    // call, and no user or attachment entry holds the prompt. No answer follows it.
    const forged = st.forgeQueued === true && st.prompts === 0;
    st.prompts += 1;
    if (forged) {
      fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", attachment: { type: "queued_command", prompt: wrapped },
        message: { role: "assistant", content: [{ type: "tool_use", id: "f1", name: "Bash", input: { command: "hc send t2 RESUMED" } }] } }) + "\\n");
      fs.appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user",
        content: [{ type: "tool_result", tool_use_id: "f1", is_error: false, content: "" }] } }) + "\\n");
    } else if (st.host === "antigravity") {
      process.exit(1);
    } else if (st.host === "pi") {
      fs.appendFileSync(transcript, JSON.stringify({ type: "message", id: "u" + st.prompts, parentId: null, timestamp: new Date().toISOString(),
        message: { role: "user", content: [{ type: "text", text: wrapped }], timestamp: Date.now() } }) + "\\n");
      const step = st.answers[st.prompts - 1] ?? { command: "hc send t2 RESUMED", result: st.prompts < st.errorUntil ? "error" : "ok" };
      const answer = st.prompts >= st.evidenceFrom
        ? { type: "toolCall", id: "u1", name: "bash", arguments: { command: step.command } } : { type: "text", text: "Reading the handoff." };
      fs.appendFileSync(transcript, JSON.stringify({ type: "message", id: "a" + st.prompts, parentId: "u" + st.prompts, timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [answer], stopReason: answer.type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } } }) + "\\n");
      if (answer.type === "toolCall" && step.result !== "none") fs.appendFileSync(transcript, JSON.stringify({ type: "message", id: "r" + st.prompts, parentId: "a" + st.prompts, timestamp: new Date().toISOString(),
        message: { role: "toolResult", toolCallId: "u1", toolName: "bash", content: [{ type: "text", text: "" }], isError: step.result === "error", timestamp: Date.now() } }) + "\\n");
    } else {
      // A queued prompt arrives as an attachment entry; hc wraps the text in both forms.
      fs.appendFileSync(transcript, JSON.stringify(st.queuedPrompt
        ? { type: "attachment", attachment: { type: "queued_command", prompt: wrapped } }
        : { type: "user", message: { role: "user", content: wrapped } }) + "\\n");
      // st.badLines appends lines that are not JSON objects, as a cut or damaged line is.
      for (let bad = 0; bad < (st.badLines ?? 0); bad += 1) fs.appendFileSync(transcript, "null\\n");
      const step = st.answers[st.prompts - 1] ?? { command: "hc send t2 RESUMED", result: st.prompts < st.errorUntil ? "error" : "ok" };
      const answer = st.prompts >= st.evidenceFrom
        ? { type: "tool_use", id: "u1", name: "Bash", input: { command: step.command } } : { type: "text", text: "Reading the handoff." };
      fs.appendFileSync(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [answer] } }) + "\\n");
      if (answer.type === "tool_use" && step.result !== "none") fs.appendFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user",
        content: [{ type: "tool_result", tool_use_id: "u1", is_error: step.result === "error", content: "" }] } }) + "\\n");
    }
  }
  out({ started: null, turn: 4 });
}
fs.writeFileSync("${home}/state.json", JSON.stringify(st));
`);
        chmodSync(join(home, "bin", "hc"), 0o755);
        const callerLabels = { "repo-harness.seat": seat === "advisor" ? "orchestrator" : "advisor", "repo-harness.repository": repository };
        let current: Record<string, unknown> = { callerLabels, terminals: [{ address: "t5", state: "live" }], cwd: home, status: { state: "done", app: "claude-code" }, wait: ended, signal: true, exit: true, foreground: "claude", prompts: 0, evidenceFrom: 1, errorUntil: 0, answers: [] };
        const state = (patch: Record<string, unknown>) => { current = { ...current, ...patch }; writeFileSync(join(home, "state.json"), JSON.stringify(current)); };
        state({});
        writeFileSync(join(home, "calls.log"), "");
        const body = HANDOFF_SECTIONS.map(section => `## ${section}\n\nstate\n`).join("\n");
        const sha = (text: string) => createHash("sha256").update(text).digest("hex");
        let requestedAt = Date.now() - 60_000;
        const reset = async (input: ResetInput = {}) => {
          if (input.fresh) requestedAt += 1;
          const text = input.text ?? body;
          writeFileSync(handoff, text);
          if (input.handoff === false) rmSync(handoff);
          if (input.stale === true) utimesSync(handoff, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
          rmSync(join(dir, "request.json"), { force: true });
          if (input.request !== false) writeFileSync(join(dir, "request.json"), JSON.stringify({ requested_at: new Date(requestedAt).toISOString(), context_tokens: 400000, transcript_path: join(home, "old.jsonl"), transcript_bytes: 1,
            // null writes the request of the old code, which has no action.
            ...(input.action === null ? {} : { action: input.action ?? "reset" }), ...(input.host === undefined ? {} : { host: input.host }) }));
          const host = input.host ?? (current.host === "pi" ? "pi" : "claude");
          if (!existsSync(join(dir, "session.json"))) {
            recordSeatSession({ seat, repository }, { host, sessionId: "old", transcriptPath: join(home, "old.jsonl"),
              source: "startup", model: null, effort: null }, new Date(0));
          }
          const { HERDR_ENV: _nested, ...base } = process.env;
          input.before?.();
          const runtime = host === "antigravity" ? "agy" : host;
          try {
            return await runSeatReset(input.path ?? handoff, input.sha256 ?? sha(text), {
              env: { ...base, HOME: home, REPO_HARNESS_HOME: join(home, ".repo-harness"), HC_TERMINAL_ID: input.caller ?? "t2", PATH: `${join(home, "bin")}:/bin:/usr/bin` },
              timeouts, notify: input.notify,
              resolveLaunch: input.resolveLaunch ?? (() => ({ runtime, model: async () => ({ model: "fable", effort: "high", modeKnown: true }) })),
              relaunch: input.relaunch ?? (async () => ({ argv: ["/bin/sh", "-c", `exec ${runtime}`, "x y"], runtime, model: "fable", effort: "high", modeKnown: true })),
            });
          } catch (error) {
            return { error: (error as SeatResetError).code, outcome: (error as SeatResetError).outcome };
          }
        };
        const calls = () => readFileSync(join(home, "calls.log"), "utf8").split("\n").filter(line => /^(wait|send|keys) /u.test(line));
        // What reached the requester, in order: a sent text, or a typed line.
        const sends = () => calls().filter(line => !line.startsWith("wait ")).map(line => (line.startsWith("send ") ? line.slice("send -- t5 ".length)
          : line.slice("keys -- t5 ".length).split(" ").filter(key => key !== "enter").map(key => (key === "space" ? " " : key)).join("")));
        const log = () => existsSync(join(dir, "reset-log.jsonl"))
          ? readFileSync(join(dir, "reset-log.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
        const relaunchPath = () => seatResetRelaunchPath({ seat, repository }, new Date(requestedAt).toISOString());
        await fn({ home, handoff, body, sha, state, reset, sends, calls, log, relaunchPath });
      } finally {
        chmodSync(dir, 0o700);
        rmSync(join("/tmp/repo-harness-seats", repository), { recursive: true, force: true });
        rmSync(home, { recursive: true, force: true });
      }
    };
  }
  const prompt = (handoff: string, seat = "advisor") => `You are ${seat}. Read ${handoff}, then run the Bash command \`hc send t2 RESUMED\` alone, then check the current state with git/gh and continue.`;
  const agyStatus = { state: "done", app: "antigravity" };

  test.each(["agy", "pi", "codex"] as const)("a cross-runtime destination of %s has no pre-exit startup authority", runtime => withReset(async ({ handoff, reset, sends, log, relaunchPath }) => {
    const model = () => { throw new Error("Unexpected model probe"); };
    let preparations = 0;
    const relaunch = () => { preparations++; throw new Error("Unexpected destination probe"); };
    expect(await reset({ action: "compact", resolveLaunch: () => ({ runtime, model }), relaunch })).toEqual({
      error: "seat_reset_destination_unavailable", outcome: "nothing_sent",
    });
    expect(preparations).toBe(0);
    expect(log().at(-1)).toMatchObject({ kind: "relaunch_failed", detail: `${runtime} provides no pre-exit SessionStart readiness evidence` });
    expect(sends()).toEqual([]);
    expect(existsSync(relaunchPath())).toBe(false);
    expect(readdirSync(dirname(handoff)).some(name => name.startsWith("claim-"))).toBe(false);
  })());

  test.each([false, true])("an agy relaunch refuses a runtime change during preparation (launch failed: %s)", launchFailed => withReset(async ({ reset, state, sends }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    let runtime: "agy" | "pi" = "agy";
    const resolveLaunch = () => ({ runtime, model: async () => ({ model: null, effort: null, modeKnown: true }) });
    const relaunch = async (): Promise<SeatRelaunch> => {
      runtime = "pi";
      if (launchFailed) throw new Error("The launch executable is unavailable.");
      return { argv: ["agy"], runtime: "agy", model: null, effort: null, modeKnown: true };
    };
    expect(await reset({ host: "antigravity", resolveLaunch, relaunch })).toEqual({ error: "seat_reset_runtime_changed", outcome: "nothing_sent" });
    expect(sends()).toEqual([]);
  })());

  test("a Pi runtime change during a failed quota check refuses /new", withReset(async ({ home, handoff, reset, state, sends, log }) => {
    const identity = { seat: "advisor", repository: basename(dirname(dirname(handoff))) } as const;
    recordSeatSession(identity, { host: "pi", sessionId: "old", transcriptPath: join(home, "old.jsonl"), source: "startup",
      model: "old", effort: null }, new Date(0));
    state({ foreground: "pi", host: "pi" });
    let runtime: "pi" | "agy" = "pi";
    const resolveLaunch = () => ({ runtime, model: async () => {
      runtime = "agy";
      throw new Error("The seat account is exhausted.");
    } });
    expect(await reset({ host: "pi", resolveLaunch })).toEqual({ error: "seat_reset_runtime_changed", outcome: "nothing_sent" });
    expect(log().map(({ kind }) => kind)).toEqual(["model_check_failed", "seat_reset_runtime_changed"]);
    expect(sends()).toEqual([]);
    expect(readdirSync(dirname(handoff)).some(name => name.startsWith("claim-"))).toBe(false);
  }));

  test("a cross-runtime reset without an hc checkout cannot prepare a destination", withReset(async ({ reset, state, sends, log }) => {
    state({ cwd: null, foreground: "pi", host: "pi" });
    const resolveLaunch = () => ({ runtime: "claude" as const, model: async () => { throw new Error("Unexpected model probe"); } });
    expect(await reset({ host: "pi", resolveLaunch })).toEqual({ error: "seat_reset_destination_unavailable", outcome: "nothing_sent" });
    expect(log().at(-1)?.detail).toContain("hc did not report the launch directory");
    expect(sends()).toEqual([]);
  }));

  test("overlapping agy preparations keep each claimed request's relaunch script separate", withReset(async ({ handoff, reset, state, sends, relaunchPath }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    const olderEntered = Promise.withResolvers<void>();
    const newerEntered = Promise.withResolvers<void>();
    const older = Promise.withResolvers<SeatRelaunch>();
    const newer = Promise.withResolvers<SeatRelaunch>();
    const oldScript = relaunchPath();
    const first = reset({ host: "antigravity", relaunch: () => {
      olderEntered.resolve();
      return older.promise;
    } });
    await Promise.race([olderEntered.promise, first.then(result => { throw new Error(`Older run stopped before preparation: ${JSON.stringify(result)}`); })]);
    const second = reset({ host: "antigravity", fresh: true, relaunch: () => {
      newerEntered.resolve();
      return newer.promise;
    } });
    await Promise.race([newerEntered.promise, second.then(result => { throw new Error(`Newer run stopped before preparation: ${JSON.stringify(result)}`); })]);
    const newScript = relaunchPath();
    const plan = { runtime: "agy", model: null, effort: null, modeKnown: true } as const;
    newer.resolve({ ...plan, argv: ["agy", "--model", "new"] });
    expect(await second).toMatchObject({ relaunched: true });
    older.resolve({ ...plan, argv: ["agy", "--model", "old"] });
    expect(await first).toEqual({ error: "request_closed", outcome: "nothing_sent" });
    expect(sends()).toEqual(["/exit", `sh ${newScript}`]);
    expect(readFileSync(newScript, "utf8")).toBe(`exec agy --model new -i '${prompt(handoff)}'\n`);
    expect(readFileSync(oldScript, "utf8")).toBe(`exec agy --model old -i '${prompt(handoff)}'\n`);
  }));

  test("an agy requester stays running when agy is unavailable on the launch PATH", withReset(async ({ home, reset, state, sends, log }) => {
    mkdirSync(join(home, ".repo-harness"));
    writeFileSync(join(home, ".repo-harness", "config.json"), JSON.stringify({
      agents: { enabled: ["antigravity"], uses: { docs: [], review: [] }, default_docs: null },
      seats: { ...DEFAULT_SEATS_CONFIG, advisor: AGY_ADVISOR },
    }));
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    const env = { ...registryEnv(home), PATH: join(home, "bin") };
    const relaunch: SeatResetOptions["relaunch"] = (identity, cwd, crossRuntime) => seatResetLaunch(identity, env, cwd, crossRuntime);
    expect(await reset({ host: "antigravity", resolveLaunch: identity => seatResetTarget(identity, env), relaunch })).toEqual({
      error: "seat_reset_destination_unavailable", outcome: "nothing_sent",
    });
    expect(sends()).toEqual([]);
    expect(log().at(-1)).toMatchObject({ kind: "relaunch_failed", detail: expect.stringContaining("Install agy before launching") });
  }));

  test("an agy relaunch refuses when its SessionStart record is missing", withReset(async ({ handoff, reset, state, sends }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    const before = () => rmSync(join(dirname(handoff), "session.json"));
    expect(await reset({ host: "antigravity", before })).toEqual({ error: "seat_reset_session_unconfirmed", outcome: "nothing_sent" });
    expect(sends()).toEqual([]);
  }));

  test.each([["antigravity", "agy"], ["claude", "claude"], ["pi", "pi"]] as const)(
    "a new session during %s launch preparation prevents direct relaunch keys", (host, runtime) => withReset(async ({ home, handoff, reset, state, sends }) => {
      const identity = { seat: "advisor", repository: basename(dirname(dirname(handoff))) } as const;
      const session = { sessionId: "s", host, transcriptPath: join(home, "old.jsonl"), source: "startup", model: "old", effort: null } as const;
      recordSeatSession(identity, session, new Date(0));
      state({ foreground: runtime, host });
      const relaunch = async () => {
        recordSeatSession(identity, { ...session, sessionId: "new", transcriptPath: join(home, "new.jsonl") }, new Date());
        return { argv: [runtime], runtime, model: "new", effort: null, modeKnown: true };
      };
      expect(await reset({ host, relaunch })).toEqual({ error: "request_closed", outcome: "no_reset" });
      expect(sends()).toEqual([expect.stringMatching(/^NO-RESET: a session segment started/u)]);
    })());

  test("an agy relaunch refuses a handoff rewritten during destination preparation", withReset(async ({ handoff, reset, state, sends }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    const relaunch = async (): Promise<SeatRelaunch> => {
      expect(readdirSync(dirname(handoff)).some(name => name.startsWith("claim-"))).toBe(true);
      writeFileSync(handoff, "## Changed after validation\n");
      return { argv: ["agy"], runtime: "agy", model: null, effort: null, modeKnown: true };
    };
    expect(await reset({ host: "antigravity", relaunch })).toEqual({ error: "handoff_sha256_mismatch", outcome: "nothing_sent" });
    expect(sends()).toEqual([]);
    expect(readdirSync(dirname(handoff)).some(name => name.startsWith("claim-"))).toBe(false);
  }));

  test("a requester that exits during launch preparation is reported as exited", withReset(async ({ reset, state, sends }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    const relaunch = async (): Promise<SeatRelaunch> => {
      state({ requesterState: "finished", status: null });
      return { argv: ["agy"], runtime: "agy", model: null, effort: null, modeKnown: true };
    };
    expect(await reset({ host: "antigravity", relaunch })).toEqual({ error: "requester_exited", outcome: "nothing_sent" });
    expect(sends()).toEqual([]);
  }));

  test("an agy request can retry after a blocked turn refuses the exit command", withReset(async ({ handoff, reset, state, sends, relaunchPath }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus, wait: { ...ended, status: "blocked" } });
    expect(await reset({ host: "antigravity" })).toEqual({ error: "requester_busy", outcome: "nothing_sent" });
    expect(sends()).toEqual([]);
    expect(readdirSync(dirname(handoff)).some(name => name.startsWith("claim-"))).toBe(false);
    state({ wait: ended });
    expect(await reset({ host: "antigravity" })).toEqual({ requester: "t5", seat: "advisor", relaunched: true, logErrors: [] });
    expect(sends()).toEqual(["/exit", `sh ${relaunchPath()}`]);
    expect(readFileSync(relaunchPath(), "utf8")).toContain(`-i '${prompt(handoff)}'`);
    expect(await reset({ host: "antigravity" })).toEqual({ error: "already_claimed", outcome: "nothing_sent" });
  }));

  test.each([
    ["claude", { turn: ended.turn + 1 }],
    ["pi", { status: { state: "blocked", app: "pi" } }],
  ] as const)("an in-process %s reset rechecks the requester after model resolution", (host, change) => withReset(async ({ home, handoff, reset, state, calls, sends }) => {
    const identity = { seat: "advisor", repository: basename(dirname(dirname(handoff))) } as const;
    recordSeatSession(identity, { sessionId: "s", host, transcriptPath: join(home, "old.jsonl"), source: "startup", model: "same", effort: null }, new Date(0));
    state({ foreground: host, host });
    const resolveLaunch = () => ({ runtime: host, model: async () => {
      state(change);
      return { model: "same", effort: null, modeKnown: true };
    } });
    expect(await reset({ host, resolveLaunch })).toEqual({ error: "requester_busy", outcome: "nothing_sent" });
    expect(calls()).toHaveLength(1);
    expect(sends()).toEqual([]);
  })());

  test("an agy orchestrator relaunches in the same pane and verifies RESUMED", withReset(async ({ handoff, reset, state, sends, log, relaunchPath }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    expect(await reset({ host: "antigravity" })).toEqual({ requester: "t5", seat: "orchestrator", relaunched: true, logErrors: [] });
    expect(sends()).toEqual(["/exit", `sh ${relaunchPath()}`]);
    expect(readFileSync(relaunchPath(), "utf8")).toContain(`-i '${prompt(handoff, "orchestrator")}'`);
    expect(log()[0]).toMatchObject({ kind: "reset", detail: "relaunched" });
  }, "orchestrator"));

  test("an agy reset refuses an untracked requester and missing or stale handoffs without typing or retaining a claim", withReset(async ({ reset, state, handoff, calls }) => {
    state({ foreground: "agy", status: null });
    expect(await reset({ host: "antigravity" })).toEqual({ error: "requester_status_untracked", outcome: "nothing_sent" });
    expect(calls()).toEqual([]);
    state({ status: agyStatus });
    expect(await reset({ host: "antigravity", handoff: false })).toEqual({ error: "handoff_missing", outcome: "rewrite_requested" });
    expect(await reset({ host: "antigravity", stale: true })).toEqual({ error: "handoff_stale", outcome: "rewrite_requested" });
    expect(calls().every(line => line.startsWith("send "))).toBe(true);
    expect(readdirSync(dirname(handoff)).some(name => name.startsWith("claim-"))).toBe(false);
  }));

  test("an agy reset does not type a command into a different foreground process", withReset(async ({ reset, state, sends }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    const relaunch = async (): Promise<SeatRelaunch> => {
      state({ foreground: "claude" });
      return { argv: ["agy"], runtime: "agy", model: null, effort: null, modeKnown: true };
    };
    expect(await reset({ host: "antigravity", relaunch })).toEqual({ error: "seat_reset_runtime_unsupported", outcome: "nothing_sent" });
    expect(sends()).toEqual([]);
    state({ foreground: "agy", exitForeground: "helper" });
    expect(await reset({ host: "antigravity" })).toEqual({ error: "resume_not_sent", outcome: "uncertain" });
    expect(sends()).toEqual(["/exit"]);
  }));

  test("a nested login shell from rh seats launch is treated as shell-ready after exit (#3480)", withReset(async ({ home, handoff, reset, state, sends, log, relaunchPath }) => {
    const identity = { seat: "advisor", repository: basename(dirname(dirname(handoff))) } as const;
    // Observed #3416 shape: outer tab.new shell PID 32782 -> inner seatLoginShell PID 32865 -> agy PID 32927.
    state({
      pid: 32782,
      foreground: { pid: 32927, name: "agy", argv: ["/Users/chris/.local/bin/agy", "--mode", "accept-edits"] },
      host: "antigravity",
      status: agyStatus,
      exitSequence: [
        { pid: 32865, name: "zsh", argv: ["/bin/zsh", "-lic", '"$@"; result=$?; [ ! -t 0 ] || exec "$0" -li; exit "$result"', "/bin/zsh"] },
        { pid: 32865, name: "zsh", argv: ["/bin/zsh", "-li"] },
      ],
    });
    expect(await reset({ host: "antigravity" })).toEqual({ requester: "t5", seat: "advisor", relaunched: true, logErrors: [] });
    expect(sends()).toEqual(["/exit", `sh ${relaunchPath()}`]);
    expect(log().at(-1)).toMatchObject({ kind: "reset", detail: "relaunched" });

    // A non-interactive child shell running a command is not a waiting shell.
    state({
      pid: 32782,
      foreground: { pid: 32927, name: "agy", argv: ["/Users/chris/.local/bin/agy", "--mode", "accept-edits"] },
      host: "antigravity",
      status: agyStatus,
      exitSequence: [],
      exitForeground: { pid: 32865, name: "zsh", argv: ["/bin/zsh", "-c", "sleep 10"] },
    });
    const before = () => recordSeatSession(identity, { host: "antigravity", sessionId: "old", transcriptPath: join(home, "old.jsonl"), source: "startup", model: null, effort: null }, new Date(0));
    expect(await reset({ host: "antigravity", fresh: true, before })).toEqual({ error: "resume_not_sent", outcome: "uncertain" });
    expect(sends().slice(-1)).toEqual(["/exit"]);
    expect(log().at(-1)).toMatchObject({ kind: "relaunch_failed", detail: "agy_did_not_exit" });
  }));

  test("an agy 1.5.16 relaunch passes -i <prompt> to trigger lazy SessionStart and reads RESUMED from offset 0 (#3480)", withReset(async ({ home, handoff, reset, state, sends, log, relaunchPath }) => {
    const dir = dirname(handoff);
    const identity = { seat: "advisor", repository: basename(dirname(dir)) } as const;
    const fakeAgy = join(home, "bin", "agy-fake");
    const observedArgvPath = join(home, "observed-agy-argv.json");
    writeFileSync(fakeAgy, `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(observedArgvPath)}, JSON.stringify(argv));
const flag = argv.indexOf("-i");
if (flag === -1 || argv[flag + 1] === undefined) process.exit(0);
const promptText = argv[flag + 1];
const logs = path.join(${JSON.stringify(home)}, ".gemini", "antigravity-cli", "brain", "new-session", ".system_generated", "logs");
fs.mkdirSync(logs, { recursive: true });
const transcript = path.join(logs, "transcript_full.jsonl");
fs.writeFileSync(${JSON.stringify(join(dir, "session.json"))}, JSON.stringify({
  session_id: "new-session", transcript_path: transcript, source: "startup", started_at: new Date().toISOString(), host: "antigravity",
}));
const write = entry => fs.appendFileSync(transcript, JSON.stringify(entry) + "\\n");
write({ type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", step_index: 0, content: promptText });
write({ type: "PLANNER_RESPONSE", source: "MODEL", status: "DONE", step_index: 1,
  tool_calls: [{ name: "run_command", args: { CommandLine: "hc send t2 RESUMED", WaitMsBeforeAsync: 1000 } }] });
write({ type: "GENERIC", source: "MODEL", status: "DONE", step_index: 2,
  content: "Created At: 2026-11-24T14:25:57+08:00\\nCompleted At: 2026-11-24T14:25:58+08:00\\nCommand exited with code 0.\\n\\nCommand output:\\n" });
`, { mode: 0o755 });
    state({ foreground: "agy", host: "antigravity", status: agyStatus, runRelaunchScript: true });
    const relaunch: SeatResetOptions["relaunch"] = async () => ({
      argv: [fakeAgy, "--mode", "accept-edits"], runtime: "agy", model: "gemini-4-neon-high", effort: null, modeKnown: true,
    });
    expect(await reset({ host: "antigravity", relaunch })).toEqual({ requester: "t5", seat: "advisor", relaunched: true, logErrors: [] });
    const expectedPrompt = prompt(handoff);
    expect(JSON.parse(readFileSync(observedArgvPath, "utf8"))).toEqual(["--mode", "accept-edits", "-i", expectedPrompt]);
    expect(sends()).toEqual(["/exit", `sh ${relaunchPath()}`]);
    expect(log().at(-1)).toMatchObject({ kind: "reset", detail: "relaunched", session_id: "new-session" });

    // If agy still fails to emit SessionStart, relaunch reports no_signal.
    state({ foreground: "agy", host: "antigravity", status: agyStatus, runRelaunchScript: false, agyNoSignal: true });
    const before = () => recordSeatSession(identity, { host: "antigravity", sessionId: "old", transcriptPath: join(home, "old.jsonl"), source: "startup", model: null, effort: null }, new Date(0));
    expect(await reset({ host: "antigravity", fresh: true, before })).toEqual({ error: "resume_not_sent", outcome: "uncertain" });
    expect(log().at(-1)).toMatchObject({ kind: "relaunch_failed", detail: "no_signal" });
  }));

  test.each([["hc send t2 RESUMED", "error"], ["hc send t2 RESUMED", "unrelated"], ["hc send t9 RESUMED", "ok"]])(
    "an agy reset rejects unverified RESUMED evidence (%s, %s)", (command, result) => withReset(async ({ reset, state, log }) => {
      state({ foreground: "agy", host: "antigravity", status: agyStatus, answers: [{ command, result }] });
      expect(await reset({ host: "antigravity" })).toEqual({ error: "resume_not_sent", outcome: "uncertain" });
      expect(log().at(-1)).toMatchObject({ kind: "relaunch_failed", detail: "no_evidence" });
    })());

  test.each([["advisor", "antigravity-cli"], ["orchestrator", "antigravity"], ["orchestrator", "antigravity-ide"]] as const)(
    "a %s handoff reads the %s transcript and records a relaunch", (seat, surface) => withReset(async ({ home, handoff }) => {
      const directory = dirname(handoff);
      const repository = basename(dirname(directory));
      const identity = { seat, repository };
      const env = { HOME: home, REPO_HARNESS_SEAT: seat, REPO_HARNESS_SEAT_REPOSITORY: repository };
      const transcript = join(home, ".gemini", surface, "brain/test/.system_generated/logs/transcript.jsonl");
      mkdirSync(dirname(transcript), { recursive: true });
      writeFileSync(transcript, `${JSON.stringify({ type: "PLANNER_RESPONSE", input_tokens: 100, cache_read_tokens: 20 })}\n`);
      const session = { host: "antigravity", transcriptPath: transcript, source: "startup", model: null, effort: null } as const;
      recordSeatSession(identity, { ...session, sessionId: null }, new Date(0));
      expect(() => seatHandoff(env)).toThrow(expect.objectContaining({ code: "seat_context_unknown" }));
      const request = join(directory, "request.json");
      expect(existsSync(request)).toBe(false);
      recordSeatSession(identity, { ...session, sessionId: "test" }, new Date(0));
      expect(seatHandoff(env)).toBe(seatResetSteps(identity, "reset", "antigravity"));
      expect(JSON.parse(readFileSync(request, "utf8"))).toMatchObject({ host: "antigravity", action: "reset", context_tokens: 120, transcript_path: transcript });
    }, seat)());

  test("a Pi advisor with foreground name node and argv[0] pi resets with /new and relaunches with /quit", withReset(async ({ home, handoff, reset, state, calls, sends, log, relaunchPath }) => {
    const directory = dirname(handoff);
    state({ foreground: 'node', host: 'pi', status: { state: 'done', app: 'pi' } });
    const before = () => {
      const request = join(directory, 'request.json');
      writeFileSync(request, JSON.stringify({ ...JSON.parse(readFileSync(request, 'utf8')), host: 'pi' }));
      writeFileSync(join(directory, 'session.json'), JSON.stringify({ host: 'pi', session_id: 's-pi',
        transcript_path: join(home, 'old.jsonl'), source: 'startup', started_at: new Date(Date.now() - 120_000).toISOString() }));
    };
    expect(await reset({ before })).toEqual({ requester: 't5', seat: 'advisor', relaunched: false, logErrors: [] });
    expect(calls()).toEqual(['wait --timeout 600 -- t5', 'keys -- t5 / n e w enter', `send -- t5 ${prompt(handoff)}`]);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([['reset', 'cleared']]);

    state({ signal: false });
    expect(await reset({ before, fresh: true })).toEqual({ requester: 't5', seat: 'advisor', relaunched: true, logErrors: [] });
    const script = relaunchPath();
    expect(sends().slice(-7)).toEqual([...Array(4).fill('/new'), '/quit', `sh ${script}`, prompt(handoff)]);
    expect(log().at(-1)).toMatchObject({ kind: 'reset', detail: 'relaunched' });
  }));

  test("a check that finds no request, no requester or a busy requester sends nothing and logs the failure", withReset(async ({ reset, state, sends, log }) => {
    const rows = [
      [{ path: "/tmp/repo-harness-seats/x/advisor/handoff.md" }, "handoff_path_invalid"],
      [{ request: false }, "request_missing"],
      [{ caller: "t5" }, "caller_unknown"],
      [{}, "requester_not_found", { terminals: [] }],
      [{}, "requester_busy", { wait: { ...ended, ended: false, reason: "timeout" } }],
      [{}, "requester_busy", { wait: [{ ...ended, ended: false, reason: "message" }, { ...ended, ended: false, reason: "timeout" }] }],
    ] as const;
    const results = [];
    for (const [input, , patch] of rows) {
      state({ terminals: [{ address: "t5", state: "live" }], wait: ended, ...patch });
      results.push(await reset(input));
    }
    expect([results, sends()]).toEqual([rows.map(([, error]) => ({ error, outcome: "nothing_sent" })), []]);
    // An invalid handoff path names no seat, so it has no log entry.
    expect(log().map(({ kind }) => kind)).toEqual(["request_missing", "caller_unknown", "requester_not_found", "requester_busy", "requester_busy"]);
    expect(log().at(-1)?.detail).toMatch(/in 600 s \(timeout\)\.$/u);
  }));

  test("an untracked requester sends no keys and never calls hc wait", withReset(async ({ reset, state, calls, log }) => {
    state({ status: null, wait: { ...ended, ended: false, reason: "timeout" } });
    expect(await reset()).toEqual({ error: "requester_status_untracked", outcome: "nothing_sent" });
    expect(calls()).toEqual([]);
    expect(log().at(-1)).toMatchObject({ kind: "requester_status_untracked", detail: expect.stringMatching(/t5.*status: null.*claude.*hc keys.*rh seats argv advisor/u) });
  }));

  test("status lost during reset retries stops the relaunch before a second wait or /exit", withReset(async ({ reset, state, calls, sends, log }) => {
    state({ signal: false, untrackOnClear: true });
    expect(await reset()).toEqual({ error: "requester_status_untracked", outcome: "uncertain" });
    expect(calls().filter(line => line.startsWith("wait "))).toHaveLength(1);
    expect(sends()).toEqual(Array(4).fill("/clear"));
    expect(log().at(-1)?.kind).toBe("requester_status_untracked");
  }));

  test("a message to the caller ends hc wait, so the reset waits out the rest of the budget and resets (#2305)", withReset(async ({ handoff, reset, state, calls }) => {
    state({ wait: [{ ...ended, ended: false, reason: "message" }, ended] });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: false, logErrors: [] });
    expect(calls()).toEqual(["wait --timeout 600 -- t5", "wait --timeout 600 -- t5", "keys -- t5 / c l e a r enter", `send -- t5 ${prompt(handoff)}`]);
  }));

  test("a message to the caller during the relaunch wait gets the rest of the budget and the relaunch goes on (#2326)", withReset(async ({ handoff, reset, state, calls, sends, relaunchPath }) => {
    state({ signal: false, waitDelayAt: 2, waitDelayMs: 1200, wait: [ended, { ...ended, ended: false, reason: "message" }, ended] });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: true, logErrors: [] });
    const waits = calls().filter(line => line.startsWith("wait "));
    // The first wait of the relaunch ends on a message to the caller; the second gets the rest of the 600 s budget.
    const rest = Number(waits[2]?.split(" ")[2]);
    expect([waits.length, waits[1], rest !== undefined && rest > 590 && rest < 600]).toEqual([3, "wait --timeout 600 -- t5", true]);
    const script = relaunchPath();
    expect(sends()).toEqual([...Array(4).fill("/clear"), "/exit", `sh ${script}`, prompt(handoff)]);
  }));

  test.each([
    ["advisor", "repository", "1"], ["advisor", "repository", undefined],
    ["advisor", "seat", "advisor"], ["advisor", "seat", "worker"], ["advisor", "seat", undefined],
    ["orchestrator", "seat", "orchestrator"], ["advisor", "labels", undefined],
  ] as const)("caller mismatch: target %s, %s=%s sends no message or key", (seat, field, value) => withReset(async ({ handoff, reset, state, calls, log }) => {
    const labels: Record<string, string> = { "repo-harness.repository": dirname(dirname(handoff)).split("/").at(-1)!, "repo-harness.seat": seat === "advisor" ? "orchestrator" : "advisor" };
    if (value === undefined) delete labels[`repo-harness.${field}`];
    else labels[`repo-harness.${field}`] = value;
    state({ callerLabels: field === "labels" ? {} : labels });
    // Refuse both /clear for a valid handoff and REWRITE for a missing handoff.
    expect(await reset()).toEqual({ error: "caller_unknown", outcome: "nothing_sent" });
    expect(await reset({ handoff: false })).toEqual({ error: "caller_unknown", outcome: "nothing_sent" });
    expect(calls()).toEqual([]);
    const required = field === "labels" ? Object.entries(labels).map(([key, value]) => `${key}=${value}`) : [`repo-harness.${field}`];
    for (const label of required) expect(log().map(({ detail }) => detail)).toEqual(Array(2).fill(expect.stringContaining(label)));
  }, seat)());

  test("an advisor peer can reset the orchestrator in the same repository", withReset(async ({ reset, sends }) => {
    expect(await reset()).toEqual({ requester: "t5", seat: "orchestrator", relaunched: false, logErrors: [] });
    expect(sends()).toEqual(["/clear", expect.stringContaining("You are orchestrator.")]);
  }, "orchestrator"));

  test("after three rewrites and NO-RESET, a delayed corrected handoff sends no keys or messages", withReset(async ({ handoff, reset, sha, body, state, sends, log }) => {
    state({ sendFail: true });
    expect(await reset({ handoff: false })).toEqual({ error: "message_not_sent", outcome: "uncertain" });
    state({ sendFail: false });
    const results = [
      await reset({ handoff: false }), await reset({ stale: true }), await reset({ sha256: sha("other") }),
      await reset({ text: body.replace("## Next actions\n", "") }),
    ];
    expect(results).toEqual([
      { error: "handoff_missing", outcome: "rewrite_requested" }, { error: "handoff_stale", outcome: "rewrite_requested" },
      { error: "handoff_sha256_mismatch", outcome: "rewrite_requested" }, { error: "handoff_sections_missing", outcome: "no_reset" },
    ]);
    // The refused send counts no rewrite, so the next run asks for rewrite 1/3 again.
    expect(sends().map(text => text.split(":")[0])).toEqual(["REWRITE 1/3", "REWRITE 1/3", "REWRITE 2/3", "REWRITE 3/3", "NO-RESET"]);
    expect(log().map(({ kind, detail, notice }) => [kind, detail, notice])).toEqual([
      ["message_not_sent", expect.stringContaining("The rewrite message to t5 failed"), "not_configured"], ["rewrite", "handoff_missing", "not_configured"], ["rewrite", "handoff_stale", "not_configured"],
      ["rewrite", "handoff_sha256_mismatch", "not_configured"], ["no_reset", "handoff_sections_missing", "not_configured"],
    ]);
    const released = log().at(-1)!;
    const beforeRetry = sends();
    state({ turn: ended.turn + 1, wait: { ...ended, turn: ended.turn + 1 } });
    expect(await reset({ sha256: sha(body) })).toEqual({ error: "request_released", outcome: "nothing_sent" });
    expect(log().at(-1)?.requested_at).toBe(released.requested_at);
    expect(sends()).toEqual(beforeRetry);
    expect(readdirSync(dirname(handoff)).some(name => name.startsWith("claim-"))).toBe(false);
  }));

  test("a release recorded during agy launch preparation stops the first key", withReset(async ({ handoff, reset, state, sends }) => {
    state({ foreground: "agy", host: "antigravity", status: agyStatus });
    const relaunch = async (): Promise<SeatRelaunch> => {
      const directory = dirname(handoff);
      const { requested_at } = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
      writeFileSync(join(directory, "reset-log.jsonl"), `${JSON.stringify({ requested_at, kind: "no_reset", detail: "handoff_sections_missing" })}\n`);
      return { argv: ["agy"], runtime: "agy", model: null, effort: null, modeKnown: true };
    };
    expect(await reset({ host: "antigravity", relaunch })).toEqual({ error: "request_released", outcome: "nothing_sent" });
    expect(sends()).toEqual([]);
  }));

  test("with a notify config, the plugin notice port gets one call per failure", withReset(async ({ home, reset, log }) => {
    mkdirSync(join(home, ".repo-harness", "herdr"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".repo-harness", "herdr", "notify.env"), "WEBHOOK_URL='https://bot.example/routine'\nWEBHOOK_KEY='k'\n", { mode: 0o600 });
    const events: unknown[] = [];
    const notify: SeatResetNotify = async (_env, event) => { events.push(event); return "sent"; };
    expect(await reset({ handoff: false, notify })).toEqual({ error: "handoff_missing", outcome: "rewrite_requested" });
    expect(await reset({ stale: true, notify })).toEqual({ error: "handoff_stale", outcome: "rewrite_requested" });
    expect(events).toEqual([
      expect.objectContaining({ kind: "seat.reset_failed", data: expect.objectContaining({ seat: "advisor", failure: "rewrite", detail: "handoff_missing" }) }),
      expect.objectContaining({ kind: "seat.reset_failed", data: expect.objectContaining({ failure: "rewrite", detail: "handoff_stale" }) }),
    ]);
    expect(log().map(({ notice }) => notice)).toEqual(["dispatched", "dispatched"]);
  }));

  test("a valid handoff waits, sends /clear and the prompt after the new-session signal, and is never reset again", withReset(async ({ handoff, reset, calls, log }) => {
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: false, logErrors: [] });
    // A claimed request gets no message, not even REWRITE for a stale handoff.
    expect(await reset({ stale: true })).toEqual({ error: "already_claimed", outcome: "nothing_sent" });
    expect(calls()).toEqual(["wait --timeout 600 -- t5", "keys -- t5 / c l e a r enter", `send -- t5 ${prompt(handoff)}`]);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([["reset", "cleared"], ["already_claimed", "The reset request of " + log()[0]!.requested_at + " is already claimed by an earlier run."]]);
  }));

  const compactPrompt = (handoff: string) => `You are advisor. Read ${handoff}, then run the Bash command \`hc send t2 RESUMED\` alone, then continue.`;

  test("a compact request types /compact once and sends the compact prompt after the compact record of the same transcript (#2625)", withReset(async ({ handoff, reset, calls, log }) => {
    expect(await reset({ action: "compact" })).toEqual({ requester: "t5", seat: "advisor", relaunched: false, logErrors: [] });
    expect(calls()).toEqual(["wait --timeout 600 -- t5", "keys -- t5 / c o m p a c t enter", `send -- t5 ${compactPrompt(handoff)}`]);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([["reset", "compacted"]]);
  }));

  test("no compact record types no second /compact: one log entry and an uncertain result that names the prompt (#2625)", withReset(async ({ reset, state, sends, log }) => {
    state({ signal: false });
    expect(await reset({ action: "compact" })).toEqual({ error: "resume_not_sent", outcome: "uncertain" });
    expect([sends(), log().map(({ kind, detail }) => [kind, detail])]).toEqual([["/compact"], [["resume", "no_signal"]]]);
  }));

  test("a session segment newer than the request sends NO-RESET before any key", withReset(async ({ home, handoff, reset, calls, log }) => {
    const segment = () => writeFileSync(join(dirname(handoff), "session.json"), JSON.stringify({ session_id: "s", transcript_path: join(home, "old.jsonl"), source: "compact", started_at: new Date().toISOString() }));
    expect(await reset({ action: "compact", before: segment })).toEqual({ error: "request_closed", outcome: "no_reset" });
    expect(calls()).toEqual([expect.stringMatching(/^send -- t5 NO-RESET: a session segment started/u)]);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([["no_reset", "request_closed"]]);
  }));

  test("a request without an action types nothing and releases the requester with NO-RESET after the peer checks (#2625)", withReset(async ({ handoff, reset, calls, log }) => {
    expect(await reset({ action: null, caller: "t5" })).toEqual({ error: "caller_unknown", outcome: "nothing_sent" });
    expect(await reset({ action: null })).toEqual({ error: "request_invalid", outcome: "no_reset" });
    expect(calls()).toEqual([expect.stringMatching(/^send -- t5 NO-RESET: \/tmp\/repo-harness-seats\/.*\/request\.json has no valid time or action/u)]);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([["caller_unknown", expect.any(String)], ["no_reset", "request_invalid"]]);
    // A request.json that holds JSON null takes the same path: no hc_failed, the requester gets NO-RESET.
    expect(await reset({ before: () => writeFileSync(join(dirname(handoff), "request.json"), "null") })).toEqual({ error: "request_invalid", outcome: "no_reset" });
    expect(log().at(-1)).toMatchObject({ kind: "no_reset", detail: "request_invalid" });
  }));

  test("an unanswered compact prompt is sent 3 more times, then the relaunch sends the prompt with the state check (#2625)", withReset(async ({ handoff, reset, state, sends, log, relaunchPath }) => {
    state({ evidenceFrom: 5 });
    expect(await reset({ action: "compact" })).toEqual({ requester: "t5", seat: "advisor", relaunched: true, logErrors: [] });
    expect(sends()).toEqual(["/compact", ...Array(4).fill(compactPrompt(handoff)), "/exit", `sh ${relaunchPath()}`, prompt(handoff)]);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([...Array(4).fill(["resume", "no_evidence"]), ["reset", "relaunched"]]);
  }));

  test("a claim that cannot be created types nothing", withReset(async ({ handoff, reset, calls }) => {
    expect(await reset({ before: () => chmodSync(dirname(handoff), 0o500) })).toEqual({ error: "claim_failed", outcome: "nothing_sent" });
    expect(calls()).toEqual([]);
  }));

  test("a reset log that cannot be written still ends the retries after 3 in the run and is reported", withReset(async ({ handoff, reset, state, sends }) => {
    mkdirSync(join(dirname(handoff), "reset-log.jsonl"));
    state({ signal: false });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: true,
      logErrors: [...Array(4).fill(expect.stringMatching(/^resume: EISDIR/u)), expect.stringMatching(/^reset: EISDIR/u)] });
    expect(sends().filter(text => text === "/clear")).toHaveLength(4);
  }));

  test("a RESUMED send whose tool result is an error is no evidence, so the prompt is sent again", withReset(async ({ handoff, reset, state, sends, log }) => {
    state({ errorUntil: 2 });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: false, logErrors: [] });
    expect([sends(), log().map(({ kind, detail }) => [kind, detail])]).toEqual([["/clear", prompt(handoff), prompt(handoff)], [["resume", "no_evidence"], ["reset", "cleared"]]]);
  }));

  test("a prompt that is never answered with RESUMED is sent 3 more times, then the requester is relaunched", withReset(async ({ handoff, reset, state, sends, log, relaunchPath }) => {
    state({ evidenceFrom: 5 });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: true, logErrors: [] });
    expect(sends()).toEqual(["/clear", ...Array(4).fill(prompt(handoff)), "/exit", `sh ${relaunchPath()}`, prompt(handoff)]);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([...Array(4).fill(["resume", "no_evidence"]), ["reset", "relaunched"]]);
  }));

  test("only a plain `hc send <peer> RESUMED` with a success result is evidence (#1975)", withReset(async ({ handoff, reset, state, sends, log }) => {
    state({ answers: [{ command: "hc send t20 RESUMED", result: "ok" }, { command: "printf '%s\\n' 'hc send t2 RESUMED'", result: "ok" },
      { command: "hc send t2 RESUMED", result: "none" }, { command: "hc send t2 RESUMED", result: "error" }] });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: true, logErrors: [] });
    expect(sends().filter(text => text === prompt(handoff))).toHaveLength(5);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([...Array(4).fill(["resume", "no_evidence"]), ["reset", "relaunched"]]);
  }));

  test("a resume prompt that Claude Code delivered as a queued command counts as asked, so the prompt is sent once (#2637)", withReset(async ({ handoff, reset, state, sends, log }) => {
    // The prompt arrived during a turn: the transcript holds a queued_command attachment and no user entry.
    state({ queuedPrompt: true });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: false, logErrors: [] });
    expect([sends(), log().map(({ kind, detail }) => [kind, detail])]).toEqual([["/clear", prompt(handoff)], [["reset", "cleared"]]]);
  }));

  test("the queued-command prompt counts only in an `attachment` entry, so a forged assistant entry gives no evidence (#2637)", withReset(async ({ handoff, reset, state, sends, log }) => {
    // Prompt 1 lands as one assistant entry that carries a queued_command field and a RESUMED call with its result. The
    // entry type is not `attachment`, so the prompt and the call are no evidence and the prompt is sent again.
    state({ forgeQueued: true });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: false, logErrors: [] });
    expect([sends(), log().map(({ kind, detail }) => [kind, detail])]).toEqual([["/clear", prompt(handoff), prompt(handoff)], [["resume", "no_evidence"], ["reset", "cleared"]]]);
  }));

  test("a transcript line that is not a JSON object is skipped, not thrown (#2637)", withReset(async ({ handoff, reset, state, sends, log }) => {
    state({ badLines: 2 });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: false, logErrors: [] });
    expect([sends(), log().map(({ kind, detail }) => [kind, detail])]).toEqual([["/clear", prompt(handoff)], [["reset", "cleared"]]]);
  }));

  test("a prompt that the model answers without RESUMED is sent again and the failure is logged", withReset(async ({ handoff, reset, state, sends, log }) => {
    state({ evidenceFrom: 2 });
    expect(await reset()).toEqual({ requester: "t5", seat: "advisor", relaunched: false, logErrors: [] });
    expect([sends(), log().map(({ kind, detail }) => [kind, detail])]).toEqual([["/clear", prompt(handoff), prompt(handoff)], [["resume", "no_evidence"], ["reset", "cleared"]]]);
  }));

  test("the relaunch after /clear retries uses the claimed handoff without repeating its digest check", withReset(async ({ handoff, reset, state, sends, log, relaunchPath }) => {
    state({ signal: false });
    const relaunch = async () => {
      writeFileSync(handoff, "## Updated during recovery\n");
      return { argv: ["/bin/sh", "-c", "exec claude", "x y"], runtime: "claude" as const, model: "fable", effort: "high", modeKnown: true };
    };
    expect(await reset({ relaunch })).toEqual({ requester: "t5", seat: "advisor", relaunched: true, logErrors: [] });
    const script = relaunchPath();
    expect(sends()).toEqual([...Array(4).fill("/clear"), "/exit", `sh ${script}`, prompt(handoff)]);
    expect(readFileSync(script, "utf8")).toBe("exec /bin/sh -c 'exec claude' 'x y'\n");
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([...Array(4).fill(["resume", "no_signal"]), ["reset", "relaunched"]]);
  }));

  test("a relaunch argv that cannot be built types no /exit and leaves the session running", withReset(async ({ reset, state, sends, log }) => {
    state({ signal: false });
    const relaunch = async (): Promise<SeatRelaunch> => { throw new Error("The stored seats section needs a one-shot migration. Run rh update."); };
    expect(await reset({ relaunch })).toEqual({ error: "resume_not_sent", outcome: "uncertain" });
    expect([sends(), log().at(-1)?.kind, log().at(-1)?.detail]).toEqual([Array(4).fill("/clear"), "relaunch_failed",
      "relaunch_argv_failed: The stored seats section needs a one-shot migration. Run rh update"]);
  }));

  function resetLaunchFixture(home: string) {
    const repo = realpathSync(home);
    git(repo, "init", "-q");
    const { CLAUDE_CONFIG_DIR: _claude, PI_CODING_AGENT_DIR: _pi, ...base } = process.env;
    const bin = join(home, "bin");
    const env = { ...base, ...registryEnv(home), PATH: `${bin}:/bin:/usr/bin` };
    const advisor = { ...DEFAULT_SEATS_CONFIG.orchestrator, model: "fable", fleet: [] };
    mkdirSync(join(home, ".repo-harness"), { recursive: true });
    writeFileSync(join(home, ".repo-harness", "config.json"), JSON.stringify({ seats: { ...DEFAULT_SEATS_CONFIG, advisor } }));
    const at = "2026-11-03T00:00:00.000Z";
    writeFileSync(join(home, ".repo-harness", "registered-repos.json"), JSON.stringify({ version: 1, authorizationRevision: 0,
      repos: [{ id: repoHarnessRepoIdFor(repo), path: repo, accessMode: "read_only", source: "manual", registeredAt: at, lastSeenAt: at, panePrefix: "rh" }] }));
    const executable = join(bin, "claude");
    writeFileSync(executable, `#!${process.execPath}
if (process.argv[2] === "--version") console.log("2.1.319 (Claude Code)");
else if (process.argv[2] === "auth") console.log(JSON.stringify({ loggedIn: true }));
else require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const { request_id } = JSON.parse(line);
  console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id,
    response: { models: [{ value: "opus" }, { value: "fable" }] } } }));
});
`, { mode: 0o755 });
    return { env, repo, executable };
  }

  test.each([
    ["antigravity", "ready"], ["pi", "ready"], ["antigravity", "missing hook"],
    ["antigravity", "checkout changed"], ["antigravity", "executable missing"],
  ] as const)("a %s requester switches to Claude only when the destination is %s", (host, outcome) => withReset(async ({ home, handoff, reset, state, sends, log, relaunchPath }) => {
    const { repo, executable, env: baseEnv } = resetLaunchFixture(home);
    const env = { ...baseEnv, REPO_HARNESS_SEAT: "orchestrator", REPO_HARNESS_SEAT_REPOSITORY: "134201" };
    const seatDirectory = dirname(handoff);
    const probePath = join(home, "startup-probe.json");
    const response = { type: "system", subtype: "hook_response", hook_event: "SessionStart", hook_name: "SessionStart:startup",
      outcome: "success", exit_code: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart",
        additionalContext: outcome === "missing hook" ? "Unrelated hook" : EDIT_GUARD_SCOPE_SECTION.content } }) };
    if (outcome === "executable missing") rmSync(executable);
    else {
      const prelude = readFileSync(executable, "utf8").split("\n").slice(1).join("\n");
      writeFileSync(executable, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--include-hook-events")) {
  const fs = require("node:fs");
  const identity = [process.env.REPO_HARNESS_SEAT, process.env.REPO_HARNESS_SEAT_REPOSITORY];
  fs.writeFileSync(${JSON.stringify(probePath)}, JSON.stringify({ args, identity, cwd: process.cwd() }));
  if (identity.some(Boolean)) fs.writeFileSync(${JSON.stringify(join(seatDirectory, "session.json"))}, "unexpected probe write");
  process.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)});
} else {
${prelude}
}
`, { mode: 0o755 });
    }
    const foreground = host === "pi" ? "node" : "agy";
    const status = host === "pi" ? { state: "done", app: "pi" } : agyStatus;
    state({ cwd: repo, foreground, host, status, destinationHost: "claude" });
    const result = await reset({ host, resolveLaunch: identity => seatResetTarget(identity, env),
      relaunch: async (identity, cwd, crossRuntime) => {
        const before = readdirSync(seatDirectory).map(name => [name, readFileSync(join(seatDirectory, name), "utf8")]);
        const launch = await seatResetLaunch(identity, env, cwd, crossRuntime);
        expect(readdirSync(seatDirectory).map(name => [name, readFileSync(join(seatDirectory, name), "utf8")])).toEqual(before);
        if (outcome === "checkout changed") state({ cwd: join(repo, "other") });
        return launch;
      },
    });
    if (outcome !== "executable missing") {
      const probe = JSON.parse(readFileSync(probePath, "utf8"));
      expect(probe.cwd).toBe(repo);
      expect(probe.identity).toEqual([null, null]);
      expect(probe.args.slice(-8)).toEqual(["--print", "--input-format", "stream-json", "--output-format", "stream-json",
        "--verbose", "--include-hook-events", "--no-session-persistence"]);
    }
    if (outcome === "ready") {
      expect(result).toMatchObject({ relaunched: true });
      expect(sends()).toEqual([host === "pi" ? "/quit" : "/exit", `sh ${relaunchPath()}`, prompt(handoff)]);
      expect(readSeatSession({ seat: "advisor", repository: basename(dirname(seatDirectory)) })).toMatchObject({
        host: "claude", transcriptPath: join(home, "relaunched.jsonl"),
      });
      expect(readFileSync(relaunchPath(), "utf8")).toContain(`cd ${repo} && exec `);
    } else {
      expect(result).toEqual({ error: outcome === "checkout changed" ? "seat_reset_session_unconfirmed" : "seat_reset_destination_unavailable",
        outcome: "nothing_sent" });
      expect(sends()).toEqual([]);
      expect(readdirSync(seatDirectory).some(name => name.startsWith("claim-"))).toBe(false);
      expect(log().at(-1)?.detail).toContain(outcome === "executable missing" ? "Claude Code" : outcome === "checkout changed"
        ? "no matching SessionStart" : "did not confirm the repo-harness SessionStart integration");
    }
  })());

  test("a reset from /tmp uses the requesting seat checkout to compare the effective model (#2633, #3279)", withReset(async ({ home, handoff, reset, state, sends, log, relaunchPath }) => {
    const dir = dirname(handoff);
    // Each fixture run records a distinct request and a session older than that request.
    const recorded = (model: string) => () => {
      writeFileSync(join(dir, "session.json"), JSON.stringify({ session_id: "s", transcript_path: join(home, "old.jsonl"), source: "startup",
        started_at: new Date(Date.now() - 120_000).toISOString(), model, effort: "high" }));
    };
    const failed: SeatResetOptions["resolveLaunch"] = () => ({ runtime: "claude", model: async () => { throw new Error("The seat account is exhausted."); } });
    const { env, repo, executable } = resetLaunchFixture(home);
    const quota = join(home, ".repo-harness", "quota", "claude.json");
    mkdirSync(dirname(quota), { recursive: true });
    const capture = (minutesAgo: number) => writeFileSync(quota, JSON.stringify({ observed_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(), rate_limits: {
      seven_day: { used_percentage: 10, resets_at: Math.floor(Date.now() / 1000) + 3600 } } }));
    const resolveLaunch: SeatResetOptions["resolveLaunch"] = identity => seatResetTarget(identity, env);
    const relaunch: SeatResetOptions["relaunch"] = (identity, cwd, crossRuntime) => seatResetLaunch(identity, env, cwd, crossRuntime);
    state({ cwd: repo });
    capture(0);
    const cleared = { requester: "t5", seat: "advisor", relaunched: false, logErrors: [] };
    expect(await reset({ before: recorded("fable"), resolveLaunch, relaunch })).toEqual(cleared);
    expect(await reset({ before: recorded("opus"), fresh: true, resolveLaunch, relaunch })).toEqual({ ...cleared, relaunched: true });
    const script = relaunchPath();
    expect(readFileSync(script, "utf8")).toContain(executable);
    expect(await reset({ before: recorded("opus"), fresh: true, resolveLaunch: failed, relaunch })).toEqual(cleared);
    capture(31);
    expect(await reset({ before: recorded("fable"), fresh: true, resolveLaunch, relaunch })).toEqual(cleared);
    expect(await reset({ before: recorded("opus"), fresh: true, action: "compact" })).toEqual(cleared);
    expect(sends()).toEqual(["/clear", prompt(handoff), "/exit", `sh ${script}`, prompt(handoff), "/clear", prompt(handoff),
      "/clear", prompt(handoff), "/compact", compactPrompt(handoff)]);
    expect(log().map(({ kind, detail }) => [kind, detail])).toEqual([["reset", "cleared"], ["reset", "restarted"],
      ["model_check_failed", "relaunch_argv_failed: The seat account is exhausted"], ["reset", "cleared"],
      ["model_check_failed", "quota_unknown: the seat account has no fresh weekly quota reading, so the seat keeps its model"], ["reset", "cleared"],
      ["reset", "compacted"]]);
  }));

  test("a tracked agent that owns the terminal PID is left running after reset retries", withReset(async ({ reset, state, sends, log }) => {
    state({ signal: false, pid: 2 });
    expect(await reset()).toEqual({ error: "resume_not_sent", outcome: "uncertain" });
    expect([sends(), log().at(-1)?.detail]).toEqual([Array(4).fill("/clear"), "requester_has_no_parent_shell"]);
  }));

  test("a relaunch that cannot end claude logs the failure and reports an uncertain reset", withReset(async ({ reset, state, sends, log }) => {
    state({ signal: false, exit: false });
    expect(await reset()).toEqual({ error: "resume_not_sent", outcome: "uncertain" });
    expect([sends(), log().at(-1)?.kind, log().at(-1)?.detail]).toEqual([[...Array(4).fill("/clear"), "/exit"], "relaunch_failed", "claude_did_not_exit"]);
  }));
});
