import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parseJsonText } from '../../../core/evidence/file-syntax';
import { isRecord } from '../../../core/evidence/is-record';
import { jsonFragment, jsonFragmentValue } from '../../../core/host-config/json-fragment';
import { shellQuote } from '../../../core/shell-quote';
import { facadesForSelection, hostSkillPlacements, parseSkillSurfaceCatalog } from '../../../core/skill-surface/catalog';
import type { PluginId, SurfaceOwner } from '../../../core/skill-surface/plugin-manifest';
import {
  ANTIGRAVITY_HOOK_SELECTOR,
  AntigravityHooksPathError,
  antigravityGlobalRulesHostPath,
  antigravityGlobalRulesPath,
  antigravityHooksPath,
  antigravityHostPath,
  antigravitySkillsDirHostPath,
  checkAntigravityPath,
  decode,
  openHostConfigGate,
  resolveUserConfigFile,
  type HostConfigFileChange,
  type HostConfigPathWrite,
} from '../../../effects/host-config/gate';
import { pathRecordIsCurrent, pathRecordKey, readPathRecords } from '../../../effects/host-config/path-records';
import { hostConfigPaths, observeFile, readLedger, readProjectedLedger } from '../../../effects/host-config/store';
import { antigravitySkillRoot } from '../../../effects/host-skill-roots';
import { requireHome } from '../../../effects/repo-harness-home';
import { ANTIGRAVITY_GUARD_DENIAL, antigravityHookMatcher } from '../../hook/host-adapter';
import {
  GLOBAL_RULES_SELECTOR,
  GLOBAL_RULES_UNBALANCED,
  applyGlobalContextRefresh,
  globalContextFileChange,
  inspectGlobalContext,
  preflightGlobalContextRefresh,
} from '../global-context';
import { defaultPluginSelection, readInstallState } from '../install-profile';
import { enabledPlugins } from '../install-state';
import { buildAntigravityHooks } from '../managed-entries';
import { bunGlobalPackageRoot, skillLinkMatches } from '../skill-projection';
import type { AgentTarget, InstallOptions, WriteResult } from '../types';

export const ANTIGRAVITY_WINDOWS_UNSUPPORTED = 'Antigravity hooks are not supported on Windows. Antigravity uses cmd /c and rh renders POSIX sh hook commands.';

const PACKAGE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Canonical package root whose catalog, global rules template, and bundled skills Antigravity projects. */
export function antigravitySourceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const globalRoot = bunGlobalPackageRoot(env);
  return globalRoot
    && existsSync(join(globalRoot, 'package.json'))
    && existsSync(join(globalRoot, 'assets', 'skill-commands', 'manifest.json'))
    ? globalRoot
    : PACKAGE_ROOT;
}

/** Validates no-symlink boundaries on ~/.gemini, config, hooks.json, AGENTS.md, and skills before any write. */
export function checkAntigravityAllPaths(env: NodeJS.ProcessEnv = process.env): void {
  const paths = hostConfigPaths(env);
  checkAntigravityPath(antigravityHostPath(env, paths));
  checkAntigravityPath(antigravityGlobalRulesHostPath(env, paths));
  checkAntigravityPath(antigravitySkillsDirHostPath(env, paths), 'directory');
}

function antigravityPlugins(env: NodeJS.ProcessEnv): readonly PluginId[] {
  const installed = readInstallState(env);
  return installed ? enabledPlugins(installed) : defaultPluginSelection('both', env).plugins;
}

export interface AntigravitySkillProjection {
  readonly host: 'antigravity';
  readonly name: string;
  readonly owner: SurfaceOwner;
  readonly source: string;
  readonly destination: string;
}

/**
 * Expected Antigravity skill symlinks under ~/.gemini/config/skills/<name>,
 * derived from assets/skill-commands/manifest.json via the shared catalog selectors.
 */
export function expectedAntigravitySkillProjections(
  sourceRoot: string,
  home: string,
  plugins: readonly PluginId[],
): readonly AntigravitySkillProjection[] {
  const manifestPath = join(sourceRoot, 'assets', 'skill-commands', 'manifest.json');
  const parsed = parseSkillSurfaceCatalog(readFileSync(manifestPath, 'utf8'), { declared: true });
  if (parsed.status !== 'valid') {
    const detail = parsed.diagnostics.map((d) => `${d.code} ${d.path}: ${d.message}`).join('; ');
    throw new Error(`invalid skill-surface catalog ${manifestPath}: ${detail}`);
  }
  const catalog = parsed.catalog;
  const facades = new Set(facadesForSelection(catalog, plugins));
  const placements = hostSkillPlacements(catalog, plugins);
  const selected = new Set([...facades, ...placements.claude, ...placements.codex, ...placements.pi]);
  const root = antigravitySkillRoot(home);
  const projections: AntigravitySkillProjection[] = [
    { host: 'antigravity', name: catalog.router, owner: 'core', source: sourceRoot, destination: join(root, catalog.router) },
  ];
  for (const pkg of catalog.packages) {
    if (pkg.source === null || !selected.has(pkg.name)) continue;
    projections.push({
      host: 'antigravity',
      name: pkg.name,
      owner: pkg.owner,
      source: join(sourceRoot, pkg.source),
      destination: join(root, pkg.name),
    });
  }
  return projections;
}

export function recordedAntigravityHooks(env: NodeJS.ProcessEnv, preview: boolean): boolean {
  return openHostConfigGate({ env, preview }).recorded(antigravityHooksPath(env)).some((record) =>
    record.owner === 'core' && record.selector === ANTIGRAVITY_HOOK_SELECTOR && record.kind === 'add');
}

export function recordedAntigravityRules(env: NodeJS.ProcessEnv, preview: boolean): boolean {
  return openHostConfigGate({ env, preview }).recorded(antigravityGlobalRulesPath(env)).some((record) =>
    record.selector === GLOBAL_RULES_SELECTOR);
}

export function recordedAntigravitySkills(env: NodeJS.ProcessEnv, preview: boolean): boolean {
  const paths = hostConfigPaths(env);
  const ledger = (preview ? readProjectedLedger : readLedger)(paths);
  return Object.values(ledger.paths).some((record) => record.host === 'antigravity');
}

export function hasRecordedAntigravityState(env: NodeJS.ProcessEnv, preview: boolean): boolean {
  checkAntigravityAllPaths(env);
  return recordedAntigravityHooks(env, preview) || recordedAntigravityRules(env, preview) || recordedAntigravitySkills(env, preview);
}

function readHooks(env: NodeJS.ProcessEnv) {
  const path = resolveUserConfigFile(env, antigravityHooksPath(env));
  const { observation, bytes } = observeFile(path);
  return { path, exists: observation.existed, content: decode(bytes, path) };
}

export function readAntigravityHooks(env: NodeJS.ProcessEnv): { path: string; value: unknown } {
  const { path, content } = readHooks(env);
  return { path, value: jsonFragmentValue(content, ANTIGRAVITY_HOOK_SELECTOR) };
}

interface AntigravityCheck {
  readonly id: string;
  readonly describe: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'na';
  readonly detail: string;
}

function probeAntigravityGuard(command: string): boolean {
  const root = mkdtempSync(join(tmpdir(), 'rh-antigravity-doctor-'));
  try {
    const home = join(root, 'home');
    const bun = join(root, 'bun');
    const bin = join(root, 'bin');
    const repo = join(root, 'fake');
    for (const dir of [home, bun, bin, join(repo, '.git'), join(repo, '.ai', 'harness')]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(repo, '.ai', 'harness', 'workflow-contract.json'), '{}\n');
    const fakeEnv = join(repo, '.env');
    writeFileSync(fakeEnv, 'FAKE=antigravity-doctor\n');
    const input = JSON.stringify({ cwd: repo, toolCall: { name: 'run_command', args: { CommandLine: `cat ${shellQuote(fakeEnv)}` } } });
    const probe = spawnSync('/bin/sh', ['-c', command], {
      cwd: repo, env: { HOME: home, PATH: bin, BUN_INSTALL: bun, TMPDIR: root }, input, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    });
    if (probe.status !== 0 || probe.stderr !== '') return false;
    const output = parseJsonText(probe.stdout, null);
    return isRecord(output) && output.decision === 'deny' && output.reason === ANTIGRAVITY_GUARD_DENIAL;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function checkAntigravityHooks(env: NodeJS.ProcessEnv = process.env): readonly [AntigravityCheck, AntigravityCheck] {
  const native = { id: 'antigravity-native-activation', describe: 'Antigravity on-disk hook activation' };
  const direct = { id: 'antigravity-direct-command', describe: 'Antigravity direct Bash guard' };
  const live = 'Live-session reload is unverified.';
  if (process.platform === 'win32') return [
    { ...native, status: 'na', detail: `${ANTIGRAVITY_WINDOWS_UNSUPPORTED} ${live}` },
    { ...direct, status: 'na', detail: ANTIGRAVITY_WINDOWS_UNSUPPORTED },
  ];
  let member: unknown;
  try { member = readAntigravityHooks(env).value; }
  catch (error) {
    const detail = error instanceof AntigravityHooksPathError ? error.message : 'Cannot read the Antigravity hook file.';
    return [{ ...native, status: 'fail', detail: `${detail} ${live}` }, { ...direct, status: 'na', detail: 'Hook file unavailable.' }];
  }
  if (member === undefined) return [
    { ...native, status: 'na', detail: `repo-harness hook member is absent. ${live}` },
    { ...direct, status: 'na', detail: 'No configured repo-harness hook command.' },
  ];
  const active = isRecord(member) && member.enabled !== false;
  const activation: AntigravityCheck = { ...native, status: active ? 'ok' : 'warn', detail: `repo-harness hook member is ${active ? 'enabled on disk' : 'disabled or invalid'}. ${live}` };
  try {
    const expected = buildAntigravityHooks(env);
    const routes = isRecord(member) ? member : {};
    const current = Object.entries(expected).every(([event, value]) => isDeepStrictEqual(value, routes[event]));
    const onDisk: AntigravityCheck = active && !current ? {
      ...native, status: 'fail', detail: `Enabled on disk with missing or stale hooks. Run rh update --target antigravity. ${live}`,
    } : activation;
    const matcher = antigravityHookMatcher('bash');
    const bash = expected.PreToolUse.find(entry => entry.matcher === matcher);
    const configured = Array.isArray(routes.PreToolUse) ? routes.PreToolUse.filter(entry => isRecord(entry) && entry.matcher === matcher) : [];
    const command = bash?.hooks[0]?.command;
    if (!command || configured.length !== 1 || !isDeepStrictEqual(bash, configured[0])) return [onDisk, {
      ...direct, status: 'fail', detail: 'The configured Bash hook differs from the current rendering. Run rh update --target antigravity.',
    }];
    const denied = probeAntigravityGuard(command);
    return [onDisk, { ...direct, status: denied ? 'ok' : 'fail', detail: denied ? 'The direct command denied a synthetic .env read.' : 'The direct command did not return the expected guard denial.' }];
  } catch {
    return [activation, { ...direct, status: 'fail', detail: 'Cannot render or run the Antigravity Bash hook. Check the Bun runtime and hook bundle.' }];
  }
}

function antigravityHooksPresent(env: NodeJS.ProcessEnv): boolean {
  try { return readAntigravityHooks(env).value !== undefined; }
  catch { return false; }
}

export function checkAntigravityGlobalRules(env: NodeJS.ProcessEnv = process.env): AntigravityCheck {
  const id = 'antigravity-global-rules';
  const describe = 'Antigravity global working rules (~/.gemini/config/AGENTS.md)';
  if (process.platform === 'win32') return { id, describe, status: 'na', detail: ANTIGRAVITY_WINDOWS_UNSUPPORTED };
  let rulesPath: string;
  try { rulesPath = resolveUserConfigFile(env, antigravityGlobalRulesPath(env)); }
  catch (error) {
    const detail = error instanceof AntigravityHooksPathError ? error.message : 'Cannot read the Antigravity global rules file.';
    return { id, describe, status: 'fail', detail };
  }
  const { observation, bytes } = observeFile(rulesPath);
  const hooksPresent = antigravityHooksPresent(env);
  let hasRecordedRules = false;
  let recordedText: string | null = null;
  try {
    const ledger = readProjectedLedger(hostConfigPaths(env));
    hasRecordedRules = Boolean(ledger.files[rulesPath]);
    recordedText = ledger.fragments.find((entry) => entry.file === rulesPath && entry.selector === GLOBAL_RULES_SELECTOR)?.inserted ?? null;
  } catch {
    // Keep read-only check resilient if the ledger is unreadable.
  }
  if (!observation.existed && !hooksPresent && !hasRecordedRules) {
    return { id, describe, status: 'na', detail: 'Antigravity hooks and global working rules are absent.' };
  }
  if (!observation.existed) {
    return { id, describe, status: 'warn', detail: `${rulesPath} is missing while Antigravity is installed. Run rh install --target antigravity.` };
  }
  let content: string;
  try { content = decode(bytes, rulesPath); }
  catch (error) { return { id, describe, status: 'fail', detail: String((error as Error).message) }; }
  try {
    const inspection = inspectGlobalContext(content, antigravitySourceRoot(env), recordedText);
    switch (inspection.state) {
      case 'managed-current':
        return { id, describe, status: 'ok', detail: `managed global working rules current (${inspection.language?.preset ?? 'recorded'}) at ${rulesPath}` };
      case 'managed-stale':
        return {
          id, describe, status: 'warn',
          detail: inspection.synced?.status === 'kept-edited'
            ? `managed rules block in ${rulesPath} was edited; sync keeps it`
            : `managed rules block in ${rulesPath} is stale. Run rh update --target antigravity.`,
        };
      case 'unbalanced':
        return { id, describe, status: 'fail', detail: `${rulesPath}: ${GLOBAL_RULES_UNBALANCED}` };
      case 'managed-unrecorded':
      case 'legacy-unmanaged':
        return { id, describe, status: 'warn', detail: `${rulesPath} has ${inspection.state} rules. Run rh update --target antigravity --report-language follow|zh-CN|en.` };
      case 'no-rules':
      case 'missing-file':
        if (!hooksPresent && !hasRecordedRules) {
          return { id, describe, status: 'na', detail: 'Antigravity hooks and managed rules are absent.' };
        }
        return { id, describe, status: 'warn', detail: `${rulesPath} has no managed repo-harness block. Run rh install --target antigravity.` };
    }
  } catch (error) {
    return { id, describe, status: 'fail', detail: String((error as Error).message) };
  }
}

export function checkAntigravitySkills(env: NodeJS.ProcessEnv = process.env): AntigravityCheck {
  const id = 'antigravity-skills';
  const describe = 'Antigravity projected skills (~/.gemini/config/skills)';
  if (process.platform === 'win32') return { id, describe, status: 'na', detail: ANTIGRAVITY_WINDOWS_UNSUPPORTED };
  let skillsDir: string;
  try {
    skillsDir = antigravitySkillsDirHostPath(env);
    checkAntigravityPath(skillsDir, 'directory');
  } catch (error) {
    const detail = error instanceof AntigravityHooksPathError ? error.message : 'Cannot read the Antigravity skills directory.';
    return { id, describe, status: 'fail', detail };
  }
  const hooksPresent = antigravityHooksPresent(env);
  let ledgerPaths: ReturnType<typeof readProjectedLedger>['paths'] = {};
  try { ledgerPaths = readProjectedLedger(hostConfigPaths(env)).paths; }
  catch {
    // Keep read-only check resilient if the ledger is unreadable.
  }
  const hasRecordedSkills = Object.values(ledgerPaths).some((record) => record.host === 'antigravity');
  if (!hooksPresent && !hasRecordedSkills) {
    return { id, describe, status: 'na', detail: 'Antigravity hooks and skill projections are absent.' };
  }
  try {
    const projections = expectedAntigravitySkillProjections(antigravitySourceRoot(env), requireHome(env), antigravityPlugins(env));
    const problems: string[] = [];
    for (const projection of projections) {
      const stat = lstatSync(projection.destination, { throwIfNoEntry: false });
      if (!stat) {
        problems.push(`${projection.name}: missing`);
        continue;
      }
      if (!skillLinkMatches(projection.destination, projection.source)) {
        problems.push(`${projection.name}: stale or wrong target`);
        continue;
      }
      const key = pathRecordKey(env, projection.destination);
      const record = ledgerPaths[key];
      if (record && !pathRecordIsCurrent(key, record)) {
        problems.push(`${projection.name}: ledger drift`);
      }
    }
    if (problems.length > 0) {
      const sample = problems.slice(0, 5).join(', ');
      const extra = problems.length > 5 ? ` (+${problems.length - 5} more)` : '';
      return { id, describe, status: 'fail', detail: `${problems.length} skill projection issue(s): ${sample}${extra}. Run rh update --target antigravity.` };
    }
    return { id, describe, status: 'ok', detail: `${projections.length} skill symlink(s) current in ${skillsDir}` };
  } catch (error) {
    return { id, describe, status: 'fail', detail: String((error as Error).message) };
  }
}

function hookChange(path: string, content: string, env: NodeJS.ProcessEnv): HostConfigFileChange {
  return {
    path,
    backup: 'overrides-only',
    fragments: [{
      owner: 'core', selector: ANTIGRAVITY_HOOK_SELECTOR,
      kind: jsonFragment.locate(content, ANTIGRAVITY_HOOK_SELECTOR) ? 'refresh' : 'add',
      strategy: jsonFragment, value: buildAntigravityHooks(env),
    }],
  };
}

function planAntigravityRules(env: NodeJS.ProcessEnv, opts: InstallOptions, preview: boolean) {
  const updateMode = opts.updateMode === true;
  const shouldSyncRules = !updateMode
    || recordedAntigravityRules(env, preview)
    || (recordedAntigravityHooks(env, preview) && opts.reportLanguage !== undefined);
  if (!shouldSyncRules) return null;
  const flag = updateMode ? opts.reportLanguage : (opts.reportLanguage ?? 'follow');
  return preflightGlobalContextRefresh(antigravitySourceRoot(env), requireHome(env), ['antigravity'], flag);
}

export const antigravityTarget: AgentTarget<'antigravity'> = {
  id: 'antigravity',
  displayName: 'Antigravity',
  supportsLocation: (location) => location === 'global',
  detect(location) {
    if (location !== 'global' || process.platform === 'win32') return { installed: false, alreadyConfigured: false };
    const { path, value } = readAntigravityHooks(process.env);
    return { installed: value !== undefined, alreadyConfigured: isRecord(value) && value.enabled !== false, configPath: path };
  },
  hostConfigChanges(_location, opts, env = process.env) {
    if (process.platform === 'win32') throw new Error(ANTIGRAVITY_WINDOWS_UNSUPPORTED);
    checkAntigravityAllPaths(env);
    const changes: HostConfigFileChange[] = [];
    const includeHooks = opts.hooks !== false && (!opts.updateMode || recordedAntigravityHooks(env, true));
    if (includeHooks) {
      const { path, content } = readHooks(env);
      changes.push(hookChange(path, content, env));
    }
    const rulesPlan = planAntigravityRules(env, opts, true);
    if (rulesPlan) {
      const rulesChange = globalContextFileChange(rulesPlan.files[0]!, rulesPlan.sourceRoot, rulesPlan.files[0]!.recorded, { includeEditedSkip: true });
      if (rulesChange) changes.push(rulesChange);
    }
    return changes;
  },
  install(_location, opts = {}): WriteResult {
    if (process.platform === 'win32') throw new Error(ANTIGRAVITY_WINDOWS_UNSUPPORTED);
    const env = process.env;
    checkAntigravityAllPaths(env);

    const home = requireHome(env);
    const sourceRoot = antigravitySourceRoot(env);
    const updateMode = opts.updateMode === true;
    const hasHooks = updateMode ? recordedAntigravityHooks(env, false) : true;
    const hasSkills = updateMode ? (recordedAntigravitySkills(env, false) || hasHooks) : true;
    const runHooks = opts.hooks !== false && hasHooks;

    // Preflight all three surfaces (hooks, global rules, skills) before writing any of them.
    const hooksInfo = runHooks ? readHooks(env) : null;
    const builtHookChange = hooksInfo ? hookChange(hooksInfo.path, hooksInfo.content, env) : null;
    const rulesPlan = planAntigravityRules(env, opts, false);
    const projections = hasSkills ? expectedAntigravitySkillProjections(sourceRoot, home, antigravityPlugins(env)) : [];
    const skillWrites: HostConfigPathWrite[] = projections.map((projection) => ({
      path: projection.destination,
      owner: projection.owner,
      entry: { type: 'symlink', target: projection.source },
    }));
    const existedSkillBefore = new Map<string, boolean>(
      projections.map((projection) => [projection.destination, lstatSync(projection.destination, { throwIfNoEntry: false }) !== undefined]),
    );
    const gate = openHostConfigGate({ env });
    if (skillWrites.length > 0) {
      const priorRecords = readPathRecords(env);
      for (const projection of projections) {
        if (!existedSkillBefore.get(projection.destination)) continue;
        const key = pathRecordKey(env, projection.destination);
        const record = priorRecords[key];
        if (!record || record.owner !== projection.owner || record.kind === 'user_managed' || !pathRecordIsCurrent(key, record)) {
          // Invoke gate.writePaths to raise the canonical host_config_replacement_refused error before any hook/rule write.
          gate.writePaths(skillWrites);
        }
      }
    }

    const files: WriteResult['files'] = [];

    if (hooksInfo && builtHookChange) {
      const hookResult = gate.apply([builtHookChange]);
      const skipped = hookResult.skipped[0];
      if (skipped) files.push({ path: hooksInfo.path, action: 'kept', detail: `${skipped.code}: ${hooksInfo.path}#${skipped.selector}` });
      else files.push({ path: hooksInfo.path, action: hookResult.written.length ? (hooksInfo.exists ? 'updated' : 'created') : 'unchanged' });
    }

    if (rulesPlan) {
      const filePlan = rulesPlan.files[0]!;
      const rulesResult = applyGlobalContextRefresh(rulesPlan, home);
      if (rulesResult.status === 'failed') throw new Error(rulesResult.detail);
      if (filePlan.outcome === 'write' && rulesResult.status === 'ok') {
        files.push({ path: filePlan.path, action: filePlan.current === null ? 'created' : 'updated', detail: rulesResult.detail });
      } else if (filePlan.outcome === 'unchanged') {
        files.push({ path: filePlan.path, action: 'unchanged' });
      } else {
        files.push({ path: filePlan.path, action: 'kept', detail: rulesResult.detail });
      }
    }

    if (skillWrites.length > 0) {
      const writtenKeys = new Set(gate.writePaths(skillWrites));
      for (const projection of projections) {
        const key = pathRecordKey(env, projection.destination);
        const action = writtenKeys.has(key) ? (existedSkillBefore.get(projection.destination) ? 'updated' : 'created') : 'unchanged';
        files.push({ path: projection.destination, action });
      }
      const expectedKeys = new Set(projections.map((projection) => pathRecordKey(env, projection.destination)));
      const retiredKeys = Object.entries(readPathRecords(env))
        .filter(([key, record]) => record.host === 'antigravity' && !expectedKeys.has(key))
        .map(([key]) => key);
      if (retiredKeys.length > 0) {
        const retired = gate.revertPaths(retiredKeys);
        for (const entry of retired) {
          if (entry.action === 'removed') files.push({ path: entry.path, action: 'removed' });
        }
      }
    }

    return { files };
  },
};
