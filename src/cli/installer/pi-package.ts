import { parseJsonText } from '../../core/evidence/file-syntax';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { homedir } from 'node:os';
import { piAgentDir } from '../../effects/pi-agent-dir';
import { realPathOrResolved } from '../../effects/path-identity';
import { piExecutable } from '../../effects/pi-executable';
import { resolveWindowsLaunchTarget } from '../../effects/process-windows-launcher';
import { decode, openHostConfigGate, type HostConfigGate } from '../../effects/host-config/gate';
import { expectedOf, hostConfigPaths, observeFile, replaceTarget, resolveHostPath } from '../../effects/host-config/store';
import { jsonFragment, removeJsonFragment } from '../../core/host-config/json-fragment';
import { HostConfigError } from '../../core/host-config/types';
import { MEASURED_INSTALLERS, type HostConfigFragmentDeclaration } from '../../effects/host-config/delegated';

/** Package commands run at HOME so project settings cannot supply ownership. */
export function runPi(args: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const executable = piExecutable(env);
  if (executable === null) throw new Error('pi not found on PATH');
  const target = resolveWindowsLaunchTarget(executable, {
    env,
    label: 'pi',
    failOnRefusal: true,
    requireDirectLaunch: true,
  });
  if (target === null) throw new Error('pi not found on PATH');
  const result = spawnSync(target.command, [...target.args, ...args], {
    cwd: env.HOME ?? env.USERPROFILE, env: { ...env, NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) throw new Error(`pi ${args.join(' ')} failed: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  return stripVTControlCharacters(result.stdout).trim();
}

/** Pi 1.4 list prints sources at two spaces and resolved paths at four. */
export function piUserPackageSources(output: string): readonly string[] {
  if (output === 'No packages installed.') return [];
  const lines = output.split(/\r?\n/);
  const start = lines.lastIndexOf('User packages:');
  if (start < 0) {
    if (lines.includes('Project packages:')) return [];
    throw new Error('PI_PACKAGE_LIST_INVALID');
  }
  const nextHeader = lines.findIndex((line, index) => index > start && (line === 'User packages:' || line === 'Project packages:'));
  return lines.slice(start + 1, nextHeader < 0 ? undefined : nextHeader)
    .filter(line => /^  \S/.test(line))
    .map(line => line.slice(2).replace(/ \(filtered\)$/, ''));
}

export function piPackagePresent(source: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const sources = piUserPackageSources(runPi(['list'], env));
  if (sources.length === 0) return false;
  const expected = realPathOrResolved(source);
  const agentDir = piAgentDir(env.HOME ?? env.USERPROFILE ?? homedir(), env);
  return sources.some(entry => realPathOrResolved(resolve(agentDir, entry)) === expected);
}

export interface PiPackageStep {
  readonly step: 'install Pi package';
  readonly status: 'ok' | 'skipped' | 'failed';
  readonly detail: string;
  readonly command?: readonly string[];
  readonly source: string;
  /** The ledger records the entry that this run created under owner `pi`. */
  readonly created: boolean;
}

export function piSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(piAgentDir(env.HOME ?? env.USERPROFILE ?? homedir(), env), 'settings.json');
}

/** The entry that `pi install <source>` writes in `packages[]`, by Pi's own rule (1.5.2 normalizePackageSourceForSettings). */
function piPackageSelector(source: string, env: NodeJS.ProcessEnv): string {
  return `packages[${relative(dirname(piSettingsPath(env)), resolve(source)) || '.'}]`;
}

function piDeclaration(source: string, env: NodeJS.ProcessEnv): HostConfigFragmentDeclaration {
  return { path: piSettingsPath(env), owner: 'pi', selectors: [piPackageSelector(source, env)] };
}

/** The Pi package sources whose entry the ledger records under owner `pi`, each with the entry text that rh recorded: only these may an uninstall or a switch remove. */
export function recordedPiPackages(env: NodeJS.ProcessEnv = process.env, gate: HostConfigGate = openHostConfigGate({ env })): ReadonlyMap<string, string> {
  const settings = piSettingsPath(env);
  return new Map(gate.recorded(settings).flatMap((record) => {
    const entry = record.owner === 'pi' ? /^packages\[(.+)\]$/.exec(record.selector)?.[1] : undefined;
    return entry === undefined ? [] : [[resolve(dirname(settings), entry), record.inserted] as const];
  }));
}

export function ownedPiPackages(env: NodeJS.ProcessEnv = process.env, gate: HostConfigGate = openHostConfigGate({ env })): readonly string[] {
  return [...recordedPiPackages(env, gate).keys()];
}

/** The report line for a Pi version that the write set was not measured at; null at the measured version. */
export function unmeasuredPiVersionLine(env: NodeJS.ProcessEnv = process.env): string | null {
  const version = runPi(['--version'], env);
  return version === MEASURED_INSTALLERS.pi ? null : `pi ${version} is not the measured ${MEASURED_INSTALLERS.pi}; writes outside the declared set were not measured`;
}

/** The entry text of the source in the Pi settings, by its declared selector; null when the file or the entry is absent. An unreadable file throws. */
export function piPackageEntry(source: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const settings = piSettingsPath(env);
  if (!existsSync(settings)) return null;
  const content = readFileSync(settings, 'utf8');
  const range = jsonFragment.locate(content, piPackageSelector(source, env));
  return range ? content.slice(range.start, range.end) : null;
}

export function piPackageEntryPresent(source: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return piPackageEntry(source, env) !== null;
}

/**
 * The one-shot migration of a `pi_packages` claim of an older install state
 * (#2852): the entry that is in the Pi settings now becomes a `pi` record with
 * an unknown baseline, as adopted text (`preimage`): Pi wrote the bytes, and rh
 * cannot prove which version. A settings file that rh already records must already
 * hold that record; anything else stops the move.
 */
export function adoptPiPackage(source: string, env: NodeJS.ProcessEnv = process.env): void {
  const { path, owner, selectors: [selector] } = piDeclaration(source, env);
  const inserted = piPackageEntry(source, env);
  if (inserted === null) return;
  const gate = openHostConfigGate({ env });
  if (gate.recorded(path).some((record) => record.owner === owner && record.selector === selector)) return;
  const adopted = gate.adopt(path, { kind: 'text_block', backup: null, fragments: [{ owner, selector: selector!, kind: 'add', inserted, preimage: inserted }], externalChange: false });
  if (adopted === 'recorded') throw new HostConfigError('host_config_invalid_state', `rh records this Pi settings file without the Pi package entry that the install state claims, so rh does not move the claim: ${path}`);
}

export function planPiPackage(source: string, enabled: boolean, env: NodeJS.ProcessEnv = process.env): PiPackageStep {
  const base = { step: 'install Pi package' as const, source: resolve(source), created: false };
  if (!enabled) return { ...base, status: 'skipped', detail: 'Pi host not selected' };
  if (piExecutable(env) === null) return { ...base, status: 'skipped', detail: 'pi not found on PATH' };
  return { ...base, status: 'ok', detail: 'Pi will check the user package entry before installation', command: ['pi', 'install', base.source] };
}

/**
 * `pi install` runs as a delegated writer: the gate records the declared
 * `packages[]` entry when the run created it, and reports a change outside it.
 * An entry that was there before stays unowned. A failure keeps the record of
 * what the run created, so the runtime transaction rollback takes it out.
 */
export function installPiPackage(source: string, enabled: boolean, env: NodeJS.ProcessEnv = process.env): PiPackageStep {
  const plan = planPiPackage(source, enabled, env);
  if (plan.status === 'skipped') return plan;
  try {
    if (piPackagePresent(plan.source, env)) return { ...plan, detail: 'Pi user package entry already present, unowned; no duplicate added' };
    const manifestPath = join(plan.source, 'package.json');
    const manifest = parseJsonText(readFileSync(manifestPath, 'utf8'), manifestPath) as { name?: unknown; pi?: { extensions?: unknown } };
    if (manifest.name !== 'repo-harness' || !Array.isArray(manifest.pi?.extensions) || manifest.pi.extensions.length === 0) {
      throw new Error('installed repo-harness package has no Pi extension declaration');
    }
    const version = unmeasuredPiVersionLine(env);
    const declaration = piDeclaration(plan.source, env);
    const gate = openHostConfigGate({ env });
    const { unattributed } = gate.delegate([declaration], () => { runPi(['install', plan.source], env); });
    if (!piPackagePresent(plan.source, env)) throw new Error('PI_PACKAGE_INSTALL_NOT_RECORDED');
    const created = gate.recorded(declaration.path).some((record) => record.owner === 'pi' && record.selector === declaration.selectors[0]);
    const lines = [
      created ? 'Pi user package entry installed and recorded' : 'Pi user package entry installed; rh did not find the declared entry, so it claims none',
      ...unattributed.map((diff) => `${diff.code}: ${diff.path} ${diff.sha256 ?? 'removed'}`),
      ...(version ? [version] : []),
    ];
    return { ...plan, created, detail: lines.join('; ') };
  } catch (error) {
    return { ...plan, status: 'failed', detail: (error as Error).message };
  }
}

export type PiPackageRemoval = 'remove' | 'released' | 'edited';

/**
 * What an uninstall or a switch may do with a recorded entry (#3249), by the
 * per-fragment rule on the declared selector alone: the exact element that rh
 * recorded goes, an absent one releases its record, and other text there is
 * the user's edit. Any other element (a `~/`, `file://` or filtered spelling
 * of the same package) is never rh's, so Pi's package matching does not decide.
 */
export function piPackageRemoval(source: string, recorded: string, env: NodeJS.ProcessEnv = process.env): PiPackageRemoval {
  const entry = piPackageEntry(source, env);
  return entry === null ? 'released' : entry === recorded ? 'remove' : 'edited';
}

/**
 * Takes out only the recorded element, as a delegated write so that the gate
 * settles the record from the file that it finds after the write. `pi remove`
 * is not used: Pi 1.5.2 takes out every entry with the package identity, a
 * user's alias too. The element is checked and taken out on one read of the
 * file, and the result replaces the file atomically only while the file still
 * has those bytes, so a failed write leaves the settings and the record as they
 * were. Text at the selector that is not rh's stops the removal.
 */
export function removePiPackage(source: string, recorded: string, env: NodeJS.ProcessEnv = process.env): void {
  const declaration = piDeclaration(source, env);
  const selector = declaration.selectors[0]!;
  openHostConfigGate({ env }).delegate([declaration], ([settings]) => {
    const path = resolveHostPath(hostConfigPaths(env), settings);
    const { observation, bytes } = observeFile(path);
    if (bytes === null) return;
    const content = decode(bytes, path);
    const range = jsonFragment.locate(content, selector);
    if (range === null) return;
    if (content.slice(range.start, range.end) !== recorded) throw new Error(`the Pi package entry changed since rh wrote it; preserved: ${source}`);
    const edit = removeJsonFragment(content, selector);
    replaceTarget(path, Buffer.from(content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length), 'utf8'), expectedOf(observation, path));
  });
}
