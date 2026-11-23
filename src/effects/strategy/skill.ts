import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillSurfaceCatalog } from '../../core/skill-surface/catalog';
import { antigravitySkillRoot, hostSkillRoot, type SkillHost } from '../host-skill-roots';
import { antigravitySkillsDirHostPath, checkAntigravityPath, openHostConfigGate, ownsPathEntry, type HostConfigPathWrite } from '../host-config/gate';
import { pathRecordKey } from '../host-config/path-records';
import { hostConfigPaths, readLedger, readProjectedLedger } from '../host-config/store';
import { globalRuntimeScope, withRuntimeTransactionLock } from '../locking/runtime-transaction-lock';

const NAME = 'repo-harness-strategy';
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
interface StrategySkillOptions {
  action: 'install' | 'uninstall';
  target?: string;
  dryRun?: boolean;
  home?: string;
}

/** Explicit host projection only. It does not configure or read any project. */
export function projectStrategySkill(opts: StrategySkillOptions,
  antigravityOptedIn?: (env: NodeJS.ProcessEnv, preview: boolean) => boolean) {
  const target = opts.target ?? 'both';
  if (!['codex', 'claude', 'antigravity', 'both'].includes(target)) throw new Error('Invalid Skill target');
  const home = realpathSync(opts.home ?? process.env.HOME ?? homedir());
  const env = { ...process.env, HOME: home };
  const includeAntigravity = () => target === 'antigravity' || antigravityOptedIn?.(env, opts.dryRun === true) === true;
  if (!opts.dryRun && includeAntigravity()) {
    return withRuntimeTransactionLock(globalRuntimeScope(env), () => projectSkill(opts, target, env, includeAntigravity()));
  }
  return projectSkill(opts, target, env, includeAntigravity());
}

function planAntigravityStrategySkill(opts: StrategySkillOptions, env: NodeJS.ProcessEnv, write: HostConfigPathWrite) {
  const paths = hostConfigPaths(env);
  checkAntigravityPath(antigravitySkillsDirHostPath(env, paths), 'directory');
  const gate = openHostConfigGate({ env, preview: opts.dryRun });
  const destination = write.path;
  const present = lstatSync(destination, { throwIfNoEntry: false }) !== undefined;
  if (opts.action === 'install') {
    const { refusals } = gate.planPaths([write]);
    if (refusals.length > 0) throw refusals[0];
    return { destination, present, apply: () => gate.writePaths([write]).length > 0 };
  }
  const key = pathRecordKey(env, destination);
  const record = (opts.dryRun ? readProjectedLedger : readLedger)(paths).paths[key];
  if (present && !ownsPathEntry(record, write.owner, key)) throw new Error('Refusing unowned Skill destination');
  return { destination, present, apply: () => gate.revertPaths([destination]).some(entry => entry.action === 'removed') };
}

function projectSkill(opts: StrategySkillOptions, target: string, env: NodeJS.ProcessEnv, includeAntigravity: boolean) {
  const home = env.HOME!;
  const catalog = parseSkillSurfaceCatalog(readFileSync(join(PACKAGE_ROOT, 'assets/skill-commands/manifest.json'), 'utf8'));
  if (catalog.status !== 'valid') throw new Error('Invalid Skill catalog');
  const pkg = catalog.catalog.packages.find(p => p.name === NAME);
  if (!pkg?.source || !pkg.explicitOnly || pkg.discoverability !== 'explicit-setup') throw new Error('Strategy Skill must remain explicit');
  const source = realpathSync(join(PACKAGE_ROOT, pkg.source));
  if (!lstatSync(join(source, 'SKILL.md')).isFile()) throw new Error('Missing strategy Skill');
  const hosts = (target === 'both' ? ['codex', 'claude'] : target === 'antigravity' ? [] : [target]) as SkillHost[];
  const antigravity = includeAntigravity && pkg.hosts.includes('antigravity')
    ? planAntigravityStrategySkill(opts, env, { path: join(antigravitySkillRoot(home), NAME), owner: pkg.owner,
      entry: { type: 'symlink', target: source } })
    : null;
  const projections = hosts.map(host => {
    const root = hostSkillRoot(home, host);
    const parents = [dirname(root), root];
    for (const parent of parents) if (existsSync(parent) && (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())) throw new Error('Refusing unsafe Skill parent');
    const destination = join(root, NAME);
    let present = false;
    try {
      const stat = lstatSync(destination); present = true;
      if (!stat.isSymbolicLink() || resolve(dirname(destination), readlinkSync(destination)) !== source) throw new Error('Refusing unowned Skill destination');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return { destination, present };
  });
  const changed: string[] = [];
  if (!opts.dryRun) {
    try {
      for (const p of projections) {
        if (opts.action === 'install' && !p.present) {
          mkdirSync(dirname(p.destination), { recursive: true });
          symlinkSync(source, p.destination, process.platform === 'win32' ? 'junction' : 'dir'); changed.push(p.destination);
        } else if (opts.action === 'uninstall' && p.present) { unlinkSync(p.destination); changed.push(p.destination); }
      }
      if (antigravity?.apply()) changed.push(antigravity.destination);
    } catch (error) {
      for (const path of changed.reverse()) {
        if (opts.action === 'install') unlinkSync(path);
        else symlinkSync(source, path, process.platform === 'win32' ? 'junction' : 'dir');
      }
      throw error;
    }
  }
  if (antigravity) projections.push({ destination: antigravity.destination, present: antigravity.present });
  return { action: opts.action, dryRun: !!opts.dryRun, changed, projections };
}
