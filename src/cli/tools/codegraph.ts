import { migrateCodexConfigRecords } from '../installer/codex-config-migration';
import { migrateInstallState } from '../installer/install-state-migration';
import { migrateJsonConfigRecords } from '../installer/json-config-migration';
import { CODEX_CONFIG_FRAGMENTS, codexConfigFragment, codexConfigValue, namingTomlFile, tomlFragment } from '../../core/host-config/toml-fragment';
import { CLAUDE_ROOT_CONFIG_BACKUP, CODEGRAPH_MCP_SELECTOR, CODEGRAPH_PERMISSION_RULE, CODEGRAPH_PERMISSION_SELECTOR, LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR } from '../../core/host-config/claude-config';
import { jsonFragment, jsonFragmentValue } from '../../core/host-config/json-fragment';
import { HostConfigError } from '../../core/host-config/types';
import { isRecord } from '../../core/evidence/is-record';
import { antigravityGlobalRulesHostPath, antigravityHostPath, antigravityMcpConfigHostPath, antigravityMcpConfigPath, decode, openHostConfigGate, resolveUserConfigFile } from '../../effects/host-config/gate';
import { hostConfigPaths, observeFile, readProjectedLedger } from '../../effects/host-config/store';
import { resolveRepoRoot } from '../hook/runtime';
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { runProcess as runBoundedProcess } from "../../effects/process-runner";
import { ARCHITECTURE_CONTRACT_VERSION, type ArchitectureDoctorCheck, type CodegraphHostTarget, type CodegraphPort, type CodegraphSetupStep } from "../../core/architecture/contracts";

const CODEGRAPH_SCOPED_MCP_ARGS = ["serve", "--mcp", "--path", "."] as const;
const CODEGRAPH_SCOPED_MCP_TOML_ARGS = `[${CODEGRAPH_SCOPED_MCP_ARGS.map((arg) => JSON.stringify(arg)).join(", ")}]`;

export type CodegraphSource = "local" | "global" | "missing";
export type CodegraphStatus = "present" | "warning" | "partial" | "missing";
export type CodegraphProjectIndexStatus = "not-initialized" | "up-to-date" | "stale" | "unknown" | "unavailable";
export type CodegraphActionStatus = "changed" | "unchanged" | "failed" | "skipped";
export type CodegraphConfigureLocation = "global" | "local";

export interface CodegraphResolveOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  host?: CodegraphHostTarget;
}

export interface CodegraphEnsureOptions extends CodegraphResolveOptions {
  checkOnly?: boolean;
  init?: boolean;
  sync?: boolean;
  installDeps?: boolean;
}

type CodegraphConfigureTarget = CodegraphHostTarget | "antigravity";

export interface CodegraphConfigureOptions extends CodegraphResolveOptions {
  target: CodegraphConfigureTarget;
  location: CodegraphConfigureLocation;
}

export interface CodegraphResolution {
  source: CodegraphSource;
  binPath: string | null;
  version: string | null;
  localBinPath: string | null;
  globalBinPath: string | null;
  globalFallbackUsed: boolean;
  drift: { local: string | null; global: string | null; using: string } | null;
}

export interface CodegraphCheckResult {
  status: CodegraphStatus;
  projectIndexStatus: CodegraphProjectIndexStatus;
  reason: string;
  remediation: {
    installCommand: string;
    projectIndexCommand: string;
    initCommand: string;
    syncCommand: string;
  };
  resolution: CodegraphResolution;
  raw: Record<string, unknown>;
}

export interface CodegraphEnsureResult extends CodegraphCheckResult {
  changed: boolean;
  readOnly: boolean;
  actions: CodegraphAction[];
}

export interface CodegraphConfigureResult extends CodegraphCheckResult {
  target: CodegraphConfigureTarget;
  location: CodegraphConfigureLocation;
  changed: boolean;
  readOnly: false;
  actions: CodegraphAction[];
}

export interface CodegraphAction {
  action: string;
  status: CodegraphActionStatus;
  command: string[];
  stdout?: string;
  stderr?: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");

function runJson(command: string, args: string[], repoRoot: string, env?: NodeJS.ProcessEnv) {
  const result = runBoundedProcess(command, args, { cwd: repoRoot, env });

  if (!result.ok) {
    throw new Error(result.stderr || result.stdout || String(result.error));
  }

  return JSON.parse(result.stdout);
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = runBoundedProcess(command, args, { cwd, env });

  return {
    ok: result.ok,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function trimOutput(value: string) {
  if (value.length <= 4096) return value;
  return `${value.slice(0, 4096)}\n[output truncated]`;
}

function readJson(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readToolingReport(repoRoot: string, env?: NodeJS.ProcessEnv, host: CodegraphHostTarget = "codex") {
  const checker = join(REPO_ROOT, "scripts", "check-agent-tooling.sh");
  // This module runs only in a process that holds the architecture plugin.
  const report = runJson("bash", [checker, "--json", "--architecture-selected", "--host", host], repoRoot, env);
  return report.tools.codegraph;
}

function hasCodegraphDependency(repoRoot: string) {
  const pkg = readJson(join(repoRoot, "package.json"));
  return Boolean(
    pkg?.devDependencies?.["@colbymchenry/codegraph"] ||
      pkg?.dependencies?.["@colbymchenry/codegraph"] ||
      pkg?.optionalDependencies?.["@colbymchenry/codegraph"]
  );
}

function appendAction(
  actions: CodegraphAction[],
  action: string,
  command: string[],
  result: ReturnType<typeof run>
): boolean {
  actions.push({
    action,
    status: result.ok ? "changed" : "failed",
    command,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr || result.error),
  });
  return result.ok;
}

function projectIndexStatus(raw: Record<string, any>): CodegraphProjectIndexStatus {
  const value = raw.project_index?.status;
  if (
    value !== "not-initialized" &&
    value !== "up-to-date" &&
    value !== "stale" &&
    value !== "unknown" &&
    value !== "unavailable"
  ) {
    throw new Error(`Unsupported CodeGraph project index status: ${String(value)}`);
  }
  return value;
}

function requiredCommand(path: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing CodeGraph remediation command: ${path}`);
  }
  return value;
}

function normalize(raw: Record<string, any>): CodegraphCheckResult {
  return {
    status: raw.status,
    projectIndexStatus: projectIndexStatus(raw),
    reason: raw.reason,
    remediation: {
      installCommand: requiredCommand("install_command", raw.install_command),
      projectIndexCommand: requiredCommand("project_index.command", raw.project_index?.command),
      initCommand: requiredCommand("init_command", raw.init_command),
      syncCommand: requiredCommand("sync_command", raw.sync_command),
    },
    resolution: {
      source: raw.source,
      binPath: raw.bin_path,
      version: raw.version,
      localBinPath: raw.local_bin_path,
      globalBinPath: raw.global_bin_path,
      globalFallbackUsed: Boolean(raw.global_fallback_used),
      drift: raw.drift,
    },
    raw,
  };
}

export function checkCodegraph(opts: CodegraphResolveOptions): CodegraphCheckResult {
  return normalize(readToolingReport(opts.repoRoot, opts.env, opts.host));
}

export function ensureCodegraph(opts: CodegraphEnsureOptions): CodegraphEnsureResult {
  const actions: CodegraphAction[] = [];

  if (opts.checkOnly) {
    return {
      ...checkCodegraph(opts),
      changed: false,
      readOnly: true,
      actions,
    };
  }

  let codegraph = readToolingReport(opts.repoRoot, opts.env, opts.host);
  if (opts.installDeps !== false && hasCodegraphDependency(opts.repoRoot) && !codegraph.local_bin_path) {
    appendAction(actions, "install-deps", ["bun", "install"], run("bun", ["install"], opts.repoRoot, opts.env));
    codegraph = readToolingReport(opts.repoRoot, opts.env, opts.host);
  }

  const binPath = codegraph.bin_path;
  if (binPath && opts.init && codegraph.project_index?.status === "not-initialized") {
    appendAction(actions, "init-index", [binPath, "init", "-i", "."], run(binPath, ["init", "-i", "."], opts.repoRoot, opts.env));
    codegraph = readToolingReport(opts.repoRoot, opts.env, opts.host);
  }

  if (binPath && opts.sync) {
    mkdirSync(join(opts.repoRoot, ".codegraph"), { recursive: true });
    appendAction(actions, "sync-index", [binPath, "sync", "."], run(binPath, ["sync", "."], opts.repoRoot, opts.env));
    codegraph = readToolingReport(opts.repoRoot, opts.env, opts.host);
  }

  const normalized = normalize(codegraph);
  return {
    ...normalized,
    changed: actions.some((entry) => entry.status === "changed"),
    readOnly: false,
    actions,
  };
}

function configureTargets(target: CodegraphConfigureTarget): Array<Exclude<CodegraphConfigureTarget, "both">> {
  return target === "both" ? ["codex", "claude"] : [target];
}

function appendSkippedAction(actions: CodegraphAction[], action: string, command: string[], reason: string): void {
  actions.push({
    action,
    status: "skipped",
    command,
    stderr: reason,
  });
}

function claudeSettingsPath(env?: NodeJS.ProcessEnv): string | null {
  const home = env?.HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return home ? join(home, ".claude", "settings.json") : null;
}

function claudeRootConfigPath(env?: NodeJS.ProcessEnv): string | null {
  const home = env?.HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return home ? join(home, ".claude.json") : null;
}

function codexConfigPath(env?: NodeJS.ProcessEnv): string | null {
  const home = env?.HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return home ? join(home, ".codex", "config.toml") : null;
}

function codegraphArgsAreScoped(args: unknown): boolean {
  return Array.isArray(args) &&
    args.length === CODEGRAPH_SCOPED_MCP_ARGS.length &&
    args.every((arg, index) => arg === CODEGRAPH_SCOPED_MCP_ARGS[index]);
}

const CODEX_MCP_SELECTOR = "mcp_servers.codegraph";

/** CodeGraph's own Codex table, with its args scoped to the working directory. */
function scopedCodexSection(snippet: string): string {
  const printed = codexConfigFragment(snippet, CODEX_MCP_SELECTOR);
  const server = codexConfigValue(snippet, CODEX_MCP_SELECTOR) as Record<string, unknown> | undefined;
  if (printed === null || typeof server?.command !== "string") {
    throw new Error("codegraph install --print-config codex printed no [mcp_servers.codegraph] table with a command");
  }
  const section = `${printed.trimEnd()}\n`;
  const headerEnd = section.indexOf("\n") + 1;
  const header = section.slice(0, headerEnd);
  const body = section.slice(headerEnd);
  const desiredArgsLine = `args = ${CODEGRAPH_SCOPED_MCP_TOML_ARGS}`;
  const nextBody = /^args\s*=/m.test(body)
    ? body.replace(/^args\s*=.*$/m, desiredArgsLine)
    : body.replace(/^(command\s*=.*)$/m, `$1\n${desiredArgsLine}`);
  const scoped = `${header}${nextBody}`;
  const args = (codexConfigValue(scoped, CODEX_MCP_SELECTOR) as Record<string, unknown> | undefined)?.args;
  if (!codegraphArgsAreScoped(args)) throw new Error("codegraph install --print-config codex printed args that rh cannot scope");
  return scoped;
}

/**
 * rh writes the Codex CodeGraph table itself, through the host-config gate,
 * from the snippet that `codegraph install --print-config codex` prints
 * without writing. A table that rh did not record is the user's: it is kept.
 */
function configureCodexMcp(actions: CodegraphAction[], binPath: string, repoRoot: string, env?: NodeJS.ProcessEnv): void {
  const command = [binPath, "install", "--print-config", "codex"];
  const path = codexConfigPath(env);
  if (!path) {
    actions.push({ action: "configure-codex", status: "skipped", command, stderr: "HOME environment variable not set; cannot locate ~/.codex/config.toml." });
    return;
  }
  const printed = run(binPath, command.slice(1), repoRoot, env);
  if (!printed.ok) {
    actions.push({ action: "configure-codex", status: "failed", command, stderr: trimOutput(printed.stderr || printed.error) });
    return;
  }
  try {
    const section = scopedCodexSection(printed.stdout);
    const content = existsSync(path) ? readFileSync(path, "utf8") : "";
    let existing: string | null;
    try { existing = codexConfigFragment(content, CODEX_MCP_SELECTOR); } catch (error) { throw namingTomlFile(path, error); }
    const kind = existing === null ? "add" : "refresh";
    const result = openHostConfigGate({ env: { ...process.env, ...env } }).apply([{
      path,
      fragments: [{ owner: CODEX_CONFIG_FRAGMENTS[CODEX_MCP_SELECTOR], selector: CODEX_MCP_SELECTOR, kind, strategy: tomlFragment, value: section }],
    }]);
    if (result.skipped.length) {
      actions.push({ action: "configure-codex", status: "skipped", command, stderr: `kept: [${CODEX_MCP_SELECTOR}] in ${path} is your configuration; rh did not change it.` });
    } else {
      actions.push({ action: "configure-codex", status: result.written.length ? "changed" : "unchanged", command });
    }
  } catch (error) {
    actions.push({ action: "configure-codex", status: "failed", command, stderr: String((error as Error).message ?? error) });
  }
}

function scopedJsonCodegraphServer(printed: string, host: "claude" | "antigravity"): Record<string, unknown> {
  const start = printed.search(/^[ \t]*\{/m);
  let server: unknown;
  try { server = jsonFragmentValue(start === -1 ? "" : printed.slice(start), CODEGRAPH_MCP_SELECTOR); }
  catch { server = undefined; }
  if (!isRecord(server) || typeof server.command !== "string" || !server.command.trim()) {
    throw new Error(`codegraph install --print-config ${host} printed no mcpServers.codegraph object with a command`);
  }
  const args = [...CODEGRAPH_SCOPED_MCP_ARGS];
  return host === "claude" ? { ...server, args, alwaysLoad: true } : { command: server.command, args };
}

/** Apply the printed server through the gate. An unrecorded server entry stays the user's. */
function configureJsonMcp(actions: CodegraphAction[], host: "claude" | "antigravity", binPath: string, repoRoot: string, env?: NodeJS.ProcessEnv): void {
  const action = `configure-${host}`;
  const command = [binPath, "install", "--print-config", host];
  const effectiveEnv = { ...process.env, ...env };
  const path = host === "antigravity" ? antigravityMcpConfigPath(effectiveEnv) : claudeRootConfigPath(env);
  if (!path) {
    appendSkippedAction(actions, action, command, "HOME environment variable not set; cannot locate ~/.claude.json.");
    return;
  }
  const printed = run(binPath, command.slice(1), repoRoot, env);
  if (!printed.ok) {
    actions.push({ action, status: "failed", command, stderr: trimOutput(printed.stderr || printed.error) });
    return;
  }
  try {
    const value = scopedJsonCodegraphServer(printed.stdout, host);
    // The gate chooses add or refresh from the guarded Antigravity file.
    const claude = host === "claude";
    const content = claude && existsSync(path) ? readFileSync(path, "utf8") : "";
    const kind = jsonFragment.locate(content, CODEGRAPH_MCP_SELECTOR) ? "refresh" : "add";
    const result = openHostConfigGate({ env: effectiveEnv }).apply([{
      path,
      backup: claude ? CLAUDE_ROOT_CONFIG_BACKUP : undefined,
      fragments: [{ owner: "architecture", selector: CODEGRAPH_MCP_SELECTOR, kind, strategy: jsonFragment, value }],
    }]);
    if (result.skipped.length) {
      appendSkippedAction(actions, action, command, `kept: ${CODEGRAPH_MCP_SELECTOR} in ${path} is your configuration; rh did not change it.`);
    } else {
      actions.push({ action, status: result.written.length ? "changed" : "unchanged", command });
    }
  } catch (error) {
    actions.push({ action, status: "failed", command, stderr: String((error as Error).message ?? error) });
  }
}

/**
 * The CodeGraph tool rule is a `permissions.allow` entry in
 * `~/.claude/settings.json`. The top-level `allowedTools` entry that earlier
 * rh versions wrote goes while it is still as rh wrote it.
 */
function configureClaudeToolPermission(actions: CodegraphAction[], env?: NodeJS.ProcessEnv): void {
  const path = claudeSettingsPath(env);
  const command = ["claude-settings", "allow-codegraph-tools", path ?? "<HOME>/.claude/settings.json"];
  if (!path) {
    actions.push({ action: "claude-tool-permission", status: "skipped", command, stderr: "HOME environment variable not set; cannot locate ~/.claude/settings.json." });
    return;
  }
  if (!existsSync(path)) {
    actions.push({ action: "claude-tool-permission", status: "skipped", command, stderr: `${path} not found; Claude Code is not installed for this user. Skipping the tool permission.` });
    return;
  }
  try {
    const gate = openHostConfigGate({ env: { ...process.env, ...env } });
    const legacy = gate.recorded(path).some((record) => record.selector === LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR);
    const retired = legacy ? gate.revert([path], { selectors: [LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR] }) : [];
    const content = readFileSync(path, "utf8");
    const present = jsonFragment.locate(content, CODEGRAPH_PERMISSION_SELECTOR) !== null;
    // An existing rule that rh did not write already allows the tools: it stays the user's.
    const result = gate.apply([{ path, fragments: [{ owner: "architecture", selector: CODEGRAPH_PERMISSION_SELECTOR, kind: present ? "refresh" : "add", strategy: jsonFragment, value: CODEGRAPH_PERMISSION_RULE }] }]);
    const changed = result.written.length > 0 || retired.some((entry) => entry.action === "text_removed");
    actions.push({ action: "claude-tool-permission", status: changed ? "changed" : "unchanged", command });
  } catch (error) {
    actions.push({ action: "claude-tool-permission", status: "failed", command, stderr: String((error as Error).message ?? error) });
  }
}

/** The ledger alone selects Antigravity before any path under .gemini is checked. */
function optedIntoAntigravity(env: NodeJS.ProcessEnv): boolean {
  const paths = hostConfigPaths(env);
  const ledger = readProjectedLedger(paths);
  return Boolean(ledger.files[antigravityHostPath(env, paths)]
    || ledger.files[antigravityGlobalRulesHostPath(env, paths)]
    || ledger.files[antigravityMcpConfigHostPath(env, paths)]
    || Object.values(ledger.paths).some((record) => record.host === "antigravity"));
}

function configureCodegraphRuntime(opts: CodegraphConfigureOptions): CodegraphConfigureResult {
  const actions: CodegraphAction[] = [];
  // The tooling report supplies binary resolution for Codex and Claude. The Antigravity config is checked through the gate.
  const probe = { repoRoot: opts.repoRoot, env: opts.env, host: opts.target === "antigravity" ? "codex" : opts.target } as const;
  const initial = checkCodegraph(probe);
  const binPath = initial.resolution.binPath;

  for (const target of configureTargets(opts.target)) {
    const command = [binPath ?? "codegraph", "install", "--target", target, "--location", opts.location, "--yes"];
    const actionName = `configure-${target}`;

    if (target !== "claude" && opts.location === "local") {
      const reason = target === "codex" ? "Codex has no project-local MCP configuration; use --location global."
        : "Antigravity CodeGraph configuration requires --location global.";
      if (opts.target === target) {
        actions.push({ action: actionName, status: "failed", command, stderr: reason });
      } else {
        appendSkippedAction(actions, actionName, command, reason);
      }
      continue;
    }

    if (!binPath) {
      actions.push({
        action: actionName,
        status: "failed",
        command,
        stderr: "CodeGraph CLI is missing; run rh arch codegraph ensure first.",
      });
      if (target === "claude") {
        configureClaudeToolPermission(actions, opts.env);
      }
      continue;
    }

    if (target === "codex") {
      configureCodexMcp(actions, binPath, opts.repoRoot, opts.env);
      continue;
    }
    // A local configure writes only repository files, which stay outside the host-config ledger.
    if (opts.location === "local") appendAction(actions, actionName, command, run(binPath, command.slice(1), opts.repoRoot, opts.env));
    else configureJsonMcp(actions, target, binPath, opts.repoRoot, opts.env);
    if (target === "claude") configureClaudeToolPermission(actions, opts.env);
  }

  let refreshed = initial;
  if (opts.target !== "antigravity" && actions.some((entry) => entry.status === "changed")) {
    try {
      refreshed = checkCodegraph(probe);
    } catch {
      refreshed = initial;
    }
  }

  return {
    ...refreshed,
    target: opts.target,
    location: opts.location,
    changed: actions.some((entry) => entry.status === "changed"),
    readOnly: false,
    actions,
  };
}

/** The old records of the host files move into the host-config ledger before the first gate write. */
export function configureCodegraph(opts: CodegraphConfigureOptions): CodegraphConfigureResult {
  const env = { ...process.env, ...opts.env };
  if (opts.target === "antigravity") return configureCodegraphRuntime({ ...opts, env });
  // A global configure holds the runtime lock, so it is a mutating entry of the one-shot state migration.
  if (opts.location === 'global') migrateInstallState(env);
  migrateCodexConfigRecords(env);
  migrateJsonConfigRecords(env);
  return configureCodegraphRuntime(opts);
}

// The doctor rows, the init index step and the MCP configuration step of the CodeGraph port.

function doctorStatusForCodegraph(status: CodegraphCheckResult['status']): ArchitectureDoctorCheck['status'] {
  if (status === 'present') return 'ok';
  if (status === 'missing') return 'fail';
  return 'warn';
}

function formatCodegraphDetail(result: CodegraphCheckResult): string {
  const raw = result.raw as Record<string, any>;
  const indexStatus = raw.project_index?.status ?? 'unknown';
  const codexMcpStatus = raw.mcp_hosts?.codex?.status ?? 'unknown';
  const claudeMcpStatus = raw.mcp_hosts?.claude?.status ?? 'unknown';
  const bits = [
    result.reason,
    `source=${result.resolution.source}`,
    `version=${result.resolution.version ?? 'unknown'}`,
    `codex-mcp=${codexMcpStatus}`,
    `claude-mcp=${claudeMcpStatus}`,
    `index=${indexStatus}`,
  ];
  if (result.resolution.globalFallbackUsed) bits.push('global-fallback=true');
  const remediation = codegraphRemediation(result);
  if (remediation) bits.push(`remediation=${remediation}`);
  return bits.join('; ');
}

function codegraphRemediation(result: CodegraphCheckResult): string | null {
  if (result.status === 'present') return null;

  const raw = result.raw as Record<string, any>;
  if (result.resolution.source === 'missing') {
    return String(raw.install_command ?? 'bash scripts/ensure-codegraph.sh');
  }
  if (result.resolution.globalFallbackUsed) {
    return String(raw.install_command ?? 'bun install');
  }
  if (raw.mcp_hosts?.codex?.status !== 'configured' || raw.mcp_hosts?.claude?.status !== 'configured') {
    return String(raw.mcp_install_command ?? 'rh arch codegraph configure --target both --location global');
  }
  if (raw.project_index?.status === 'not-initialized') {
    return String(raw.init_command ?? 'bash scripts/ensure-codegraph.sh --init');
  }
  if (raw.project_index?.status === 'stale') {
    return String(raw.sync_command ?? 'bash scripts/ensure-codegraph.sh --sync');
  }
  return String(raw.ensure_command ?? raw.sync_command ?? 'bash scripts/ensure-codegraph.sh --check');
}

interface CodegraphProbe {
  result?: CodegraphCheckResult;
  error?: Error;
}

function probeCodegraph(cwd: string): CodegraphProbe {
  try {
    return { result: checkCodegraph({ repoRoot: cwd, host: 'both' }) };
  } catch (err) {
    return { error: err as Error };
  }
}

function checkCodegraphReadiness(probe: CodegraphProbe): ArchitectureDoctorCheck {
  const id = 'codegraph-readiness';
  const describe = 'CodeGraph CLI, MCP, and project index readiness';
  if (probe.result) {
    return {
      id,
      describe,
      status: doctorStatusForCodegraph(probe.result.status),
      detail: formatCodegraphDetail(probe.result),
    };
  }
  return {
    id,
    describe,
    status: 'fail',
    detail: `error checking CodeGraph readiness: ${probe.error?.message ?? 'unknown error'}`,
  };
}

function readAntigravityMcpConfig(env: NodeJS.ProcessEnv) {
  const path = resolveUserConfigFile(env, antigravityMcpConfigPath(env));
  return { path, content: decode(observeFile(path).bytes, path) };
}

/** Validate the config with the same JSON edit strategy the gate will apply. */
export function preflightAntigravityCodegraph(env: NodeJS.ProcessEnv, explicitTarget: boolean): void {
  if (!explicitTarget && !optedIntoAntigravity(env)) return;
  const { path, content } = readAntigravityMcpConfig(env);
  try {
    jsonFragment.apply(content, CODEGRAPH_MCP_SELECTOR, null);
  } catch (error) {
    if (!(error instanceof HostConfigError)) throw error;
    throw new HostConfigError(error.code, `${path}: ${error.message}`, { cause: error });
  }
}

function checkAntigravityCodegraphMcp(id: string, describe: string, env: NodeJS.ProcessEnv): ArchitectureDoctorCheck {
  try {
    if (!optedIntoAntigravity(env)) return { id, describe, status: 'na', detail: 'Antigravity is not opted in' };
    const { path, content } = readAntigravityMcpConfig(env);
    const server = jsonFragmentValue(content, CODEGRAPH_MCP_SELECTOR);
    if (isRecord(server) && typeof server.command === 'string' && server.command.trim() && codegraphArgsAreScoped(server.args)) {
      return { id, describe, status: 'ok', detail: 'CodeGraph MCP args are scoped to the working directory' };
    }
    const configure = 'Run rh update --target antigravity --configure-codegraph';
    if (server === undefined) return { id, describe, status: 'warn', detail: `CodeGraph MCP entry is missing. ${configure}` };
    const range = jsonFragment.locate(content, CODEGRAPH_MCP_SELECTOR)!;
    const text = content.slice(range.start, range.end);
    const current = openHostConfigGate({ env, preview: true }).recorded(path).some((record) =>
      record.owner === 'architecture' && record.selector === CODEGRAPH_MCP_SELECTOR && record.inserted === text);
    const remedy = current ? configure : `Edit ${CODEGRAPH_MCP_SELECTOR} in ${path} to set the CodeGraph command and args ${JSON.stringify(CODEGRAPH_SCOPED_MCP_ARGS)}`;
    return { id, describe, status: 'warn', detail: `CodeGraph MCP entry needs a command and args scoped to the working directory. ${remedy}` };
  } catch (error) {
    return { id, describe, status: 'fail', detail: String((error as Error).message ?? error) };
  }
}

function checkCodegraphMcpHost(probe: CodegraphProbe, host: 'codex' | 'claude' | 'antigravity'): ArchitectureDoctorCheck {
  const id = `${host}-codegraph-mcp`;
  const label = { codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity' }[host];
  const describe = `${label} CodeGraph MCP config`;
  if (host === 'antigravity') return checkAntigravityCodegraphMcp(id, describe, process.env);
  if (!probe.result) {
    return {
      id,
      describe,
      status: 'fail',
      detail: `error checking CodeGraph MCP config: ${probe.error?.message ?? 'unknown error'}`,
    };
  }

  const raw = probe.result.raw as Record<string, any>;
  const entry = raw.mcp_hosts?.[host];
  if (entry?.status === 'configured') {
    return { id, describe, status: 'ok', detail: entry.reason ?? 'configured' };
  }
  return {
    id,
    describe,
    status: 'warn',
    detail: `${entry?.reason ?? 'missing'}; remediation=rh arch codegraph configure --target ${host} --location global`,
  };
}

function checkCodegraphIndex(probe: CodegraphProbe, cwd: string): ArchitectureDoctorCheck {
  const id = 'codegraph-index';
  const describe = 'CodeGraph project index';
  if (!resolveRepoRoot(cwd)) {
    return { id, describe, status: 'na', detail: 'not in a git repository' };
  }
  if (!probe.result) {
    return {
      id,
      describe,
      status: 'fail',
      detail: `error checking CodeGraph index: ${probe.error?.message ?? 'unknown error'}`,
    };
  }

  const raw = probe.result.raw as Record<string, any>;
  const indexStatus = raw.project_index?.status ?? 'unknown';
  const status: ArchitectureDoctorCheck['status'] = indexStatus === 'up-to-date'
    ? 'ok'
    : indexStatus === 'stale' || indexStatus === 'unknown'
      ? 'warn'
      : 'fail';
  const remediation = indexStatus === 'not-initialized'
    ? raw.init_command
    : indexStatus === 'stale'
      ? raw.sync_command
      : raw.ensure_command;
  return {
    id,
    describe,
    status,
    detail: `index=${indexStatus}${raw.project_index?.detail ? `; ${raw.project_index.detail}` : ''}${remediation ? `; remediation=${remediation}` : ''}`,
  };
}

function codegraphChecksFor(probe: CodegraphProbe, cwd: string): ArchitectureDoctorCheck[] {
  return [
    checkCodegraphReadiness(probe),
    checkCodegraphMcpHost(probe, 'codex'),
    checkCodegraphMcpHost(probe, 'claude'),
    checkCodegraphMcpHost(probe, 'antigravity'),
    checkCodegraphIndex(probe, cwd),
  ];
}

/** The `init` CodeGraph index step. */
function codegraphIndexSteps({ repoRoot, sync, env, target }: Parameters<CodegraphPort["indexSteps"]>[0]): CodegraphSetupStep[] {
  const steps: CodegraphSetupStep[] = [];
  try {
    const cg = ensureCodegraph({ repoRoot, init: true, sync, env, host: target });
    const failedActions = cg.actions.filter((entry) => entry.status === "failed");
    const indexReady = cg.projectIndexStatus === "up-to-date";
    const cgFailed = failedActions.length > 0 || !indexReady;
    const actionDetail = cg.actions.map((entry) => `${entry.action}:${entry.status}`).join(", ");
    const indexDetail = `index ${cg.projectIndexStatus}`;
    const indexRemediation = cg.projectIndexStatus === "unavailable" && cg.resolution.source === "missing"
      ? `install with: ${cg.remediation.installCommand}; then run: ${cg.remediation.initCommand} && ${cg.remediation.syncCommand}`
      : cg.projectIndexStatus === "unavailable" || cg.projectIndexStatus === "unknown"
        ? `inspect with: ${cg.remediation.projectIndexCommand}`
        : cg.projectIndexStatus === "stale"
          ? `run: ${cg.remediation.syncCommand}`
          : `run: ${cg.remediation.initCommand} && ${cg.remediation.syncCommand}`;
    const failureDetail = [
      ...failedActions.map((entry) => entry.stderr || `${entry.action} failed`),
      ...(!indexReady
        ? [`CodeGraph is enabled, but the project index is ${cg.projectIndexStatus}; ${indexRemediation}`]
        : []),
    ].filter(Boolean).join("\n");
    steps.push({
      step: "ensure codegraph index",
      status: cgFailed ? "failed" : cg.actions.length === 0 ? "skipped" : "ok",
      detail: actionDetail ? `${actionDetail}; ${indexDetail}` : indexDetail,
      stderr: failureDetail || undefined,
    });

    const mcpHosts =
      (cg.raw as { mcp_hosts?: Record<string, { status?: string }> }).mcp_hosts ?? {};
    const mcpConfigured =
      cg.resolution.source !== "missing" &&
      ["codex", "claude"].every((host) => mcpHosts[host]?.status === "configured");

    if (cg.resolution.source !== "missing" && !mcpConfigured) {
      steps.push({
        step: "codegraph mcp",
        status: "skipped",
        detail:
          "not registered; run: rh arch codegraph configure --target both --location global",
      });
    }
  } catch (error) {
    steps.push({
      step: "ensure codegraph index",
      status: "failed",
      detail: "CodeGraph readiness check failed",
      stderr: error instanceof Error ? error.message : String(error),
    });
  }
  return steps;
}

/** The global runtime `configure CodeGraph MCP` step. */
function configureCodegraphMcpStep(cwd: string, target: CodegraphHostTarget, env: NodeJS.ProcessEnv): CodegraphSetupStep {
  try {
    const result = configureCodegraph({ repoRoot: cwd, target, location: "global", env });
    return {
      step: "configure CodeGraph MCP",
      status: result.actions.some((entry) => entry.status === "failed") ? "failed" : "ok",
      detail: result.actions.map((entry) => `${entry.action}:${entry.status}`).join(", "),
    };
  } catch (error) {
    return {
      step: "configure CodeGraph MCP",
      status: "failed",
      stderr: String((error as Error).message ?? error),
    };
  }
}

export function configureAntigravityCodegraphStep(cwd: string, env: NodeJS.ProcessEnv, explicitTarget: true): CodegraphSetupStep;
export function configureAntigravityCodegraphStep(cwd: string, env: NodeJS.ProcessEnv, explicitTarget: boolean): CodegraphSetupStep | undefined;
export function configureAntigravityCodegraphStep(cwd: string, env: NodeJS.ProcessEnv, explicitTarget: boolean): CodegraphSetupStep | undefined {
  const step = 'configure Antigravity CodeGraph MCP';
  try {
    if (!explicitTarget && !optedIntoAntigravity(env)) return undefined;
    const result = configureCodegraph({ repoRoot: cwd, target: 'antigravity', location: 'global', env });
    const action = result.actions[0]!;
    return {
      step,
      status: action.status === 'failed' || action.status === 'skipped' ? action.status : 'ok',
      detail: action.stderr ?? action.status,
    };
  } catch (error) {
    return { step, status: 'failed', detail: String((error as Error).message ?? error) };
  }
}

/**
 * The CodeGraph part of the architecture plugin. The CLI root registers it
 * only when the recorded selection includes the plugin.
 */
export const CODEGRAPH_PROVIDER: CodegraphPort = {
  contractVersion: ARCHITECTURE_CONTRACT_VERSION,
  checks: (cwd) => codegraphChecksFor(probeCodegraph(cwd), cwd),
  indexSteps: codegraphIndexSteps,
  configureMcp: configureCodegraphMcpStep,
};
