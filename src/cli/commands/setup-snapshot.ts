// One setup snapshot from the `rh setup check` builder. This module
// runs in the collector's child process (setup-check-child.ts), never in the
// `operator serve` event loop: the builder is synchronous and spawns its own
// probes. It reads only the builder result, the skill catalog that the skill
// projection check reads, the route registry, the packaged agent fleet, and
// the entry names of each host skill root. It never runs the fleet install
// script, never reads credential files and never changes a host skill root.

import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { skillProjectionSourceRoot, type DoctorPorts } from './doctor';
import { buildSetupCheck, type SetupCheckBuild } from './setup-check';
import { HOOK_EVENT_TELEMETRY_PATH, HOOK_EVENT_TELEMETRY_PROTOCOL } from '../hook/event-telemetry';
import { ROUTES } from '../hook/route-registry';
import { resolveRepoRoot } from '../hook/runtime';
import { projectSetupSnapshot, type SetupRawCatalogPackage, type SetupRawFleetRole, type SetupRawSkillRoot } from '../../core/setup/projection';
import { SETUP_HOSTS, type SetupHookUsage, type SetupSnapshotV2 } from '../../core/setup/types';
import { parseSkillSurfaceCatalog } from '../../core/skill-surface/catalog';
import { antigravitySkillRoot, hostSkillRoot } from '../../effects/host-skill-roots';
import { AntigravityHooksPathError, checkAntigravityPath } from '../../effects/host-config/gate';
import { readHookUsage } from '../../effects/setup/hook-usage';
import { parseFrontmatter } from '../../effects/terminal/task-role-profiles';

/** The packaged fleet source, the same package-relative path the tooling check reads. */
export const SETUP_FLEET_SOURCE_DIR = fileURLToPath(new URL('../../../agents/fleet/', import.meta.url));

export function readFleetRoles(directory: string = SETUP_FLEET_SOURCE_DIR): SetupRawFleetRole[] {
  return readdirSync(directory)
    .filter(file => file.endsWith('.md'))
    .sort()
    .flatMap((file) => {
      const role = parseFrontmatter(readFileSync(join(directory, file), 'utf8'));
      return role === null ? [] : [{ name: role.name, description: role.description, model: role.model, effort: role.effort }];
    });
}

/** Catalog packages from the package root the skill projection check reads. Null when the catalog is unreadable. */
function skillCatalog(env: NodeJS.ProcessEnv): Map<string, SetupRawCatalogPackage> | null {
  try {
    const manifest = readFileSync(join(skillProjectionSourceRoot(env), 'assets', 'skill-commands', 'manifest.json'), 'utf8');
    const catalog = parseSkillSurfaceCatalog(manifest, { declared: true });
    return catalog.status === 'valid' ? new Map(catalog.catalog.packages.map(pkg => [pkg.name, { summary: pkg.summary, hosts: pkg.hosts }])) : null;
  } catch {
    return null;
  }
}

/** The HOME that the skill projection check reads. */
function skillHome(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? os.homedir();
}

/** The directories and links in each host skill root. Read only: nothing in a root is changed. */
export function readHostSkillRoots(env: NodeJS.ProcessEnv, antigravityOptedIn: boolean): SetupRawSkillRoot[] {
  const home = skillHome(env);
  return SETUP_HOSTS.map((host) => {
    const root = host === 'antigravity' ? antigravitySkillRoot(home) : hostSkillRoot(home, host, env);
    try {
      if (host === 'antigravity') {
        if (!antigravityOptedIn) return { host, root, entries: null };
        checkAntigravityPath(root, 'directory');
      }
      const entries = readdirSync(root, { withFileTypes: true });
      return { host, root, entries: entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name) };
    } catch (error) {
      if (error instanceof AntigravityHooksPathError || (error as NodeJS.ErrnoException).code === 'ENOENT') return { host, root, entries: null };
      throw error;
    }
  });
}

export function projectSetupBuild(build: SetupCheckBuild, options: {
  readonly env: NodeJS.ProcessEnv;
  readonly collected_at: string;
  readonly fleet_dir?: string;
  readonly hook_usage?: SetupHookUsage | null;
}): SetupSnapshotV2 {
  const doctorCheck = (id: string) => build.doctor.checks.find(check => check.id === id);
  const codexVersion = doctorCheck('codex-cli-version')?.version;
  const piVersion = doctorCheck('pi-cli-version')?.version;
  const agyVersion = doctorCheck('agy-cli-version')?.version;
  const antigravityOptedIn = build.report.checks.some(check => check.id === 'status.adapter.antigravity' && (check.status === 'ok' || check.status === 'warn'));
  const tools = build.tooling?.tools as Record<string, { hosts?: unknown }> | undefined;
  return projectSetupSnapshot({
    collected_at: options.collected_at,
    setup_status: build.report.status,
    summary: build.report.summary,
    checks: build.report.checks,
    check_commands: new Map([...build.check_actions].map(([checkId, action]) => [checkId, action.command])),
    adapters: build.status.targets,
    cli_versions: {
      ...(codexVersion === undefined ? {} : { codex: codexVersion }),
      ...(piVersion === undefined ? {} : { pi: piVersion }),
      ...(agyVersion === undefined ? {} : { antigravity: agyVersion }),
    },
    skill_rows: doctorCheck('skill-projection')?.skills ?? null,
    skill_catalog: skillCatalog(options.env),
    home: skillHome(options.env),
    skill_roots: readHostSkillRoots(options.env, antigravityOptedIn),
    install_selection: build.status.installState.recorded === true ? build.status.installState.selection : null,
    routes: ROUTES,
    fleet_roles: readFleetRoles(options.fleet_dir),
    fleet_hosts: tools?.agent_fleet?.hosts ?? null,
    hook_usage: options.hook_usage ?? null,
  });
}

/** Hook usage of the repository that contains `cwd`; null outside a repository or when a log is unreadable. */
function hookUsageAt(cwd: string, nowMs: number): SetupHookUsage | null {
  const repoRoot = resolveRepoRoot(cwd);
  if (repoRoot === null) return null;
  try {
    return readHookUsage(repoRoot, { path: HOOK_EVENT_TELEMETRY_PATH, protocol: HOOK_EVENT_TELEMETRY_PROTOCOL }, ROUTES, nowMs);
  } catch {
    return null;
  }
}

/** Run the setup check builder exactly as `rh setup check --target both` does (no --check-updates). */
export function collectSetupSnapshotNow(ports: DoctorPorts, options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly now?: () => number } = {}): SetupSnapshotV2 {
  const env = options.env ?? process.env;
  const build = buildSetupCheck(ports, { cwd: options.cwd, target: 'both', checkUpdates: false });
  const now = (options.now ?? Date.now)();
  return projectSetupBuild(build, { env, collected_at: new Date(now).toISOString(), hook_usage: hookUsageAt(options.cwd ?? process.cwd(), now) });
}
