import { globalConfigurationPath, mutateGlobalConfiguration } from '../../effects/configuration/global-configuration';
import { globalRuntimeScope, withRuntimeTransactionContext, type RuntimeTransactionContext } from '../../effects/locking/runtime-transaction-lock';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { hostSkillRoot, providerSkillLock, type ProviderSkillLock } from '../../effects/host-skill-roots';
import { ownedPiPackages, piPackagePresent, removePiPackage } from './pi-package';
import { piExecutable } from '../../effects/pi-executable';
import { globalContextPath, inspectUnrecordedGlobalRules, previewGlobalRulesAdoptedRevert } from './global-context';
import { removeRuntimeStateIgnoreBlock } from '../../effects/adoption/gitignore-plan';
import { readRepositoryExcludes, repositoryCommonDirectory, repositoryExcludesLedgerPath, repositoryExcludeTarget, serializeRepositoryExcludes, type RepositoryExclude } from './repository-excludes';
import { readInstallState } from './install-profile';
import { installStatePendingMigration, migrateInstallState, planInstallStateMigration } from './install-state-migration';
import type { PathRecord } from '../../core/host-config/types';
import { partitionPathRecords, pathRecordRoot, pathRecordsDigest, readPathRecords, writePathRecords, type PathRecords } from '../../effects/host-config/path-records';
import { InstallStateError, installProfileStatePath } from './install-state';
import { assertConfigurationPath, configurationReceiptPath, hostConfigurationRoot, writePrivateConfiguration } from './configuration-ownership';
import { migrateCodexConfigRecords, planCodexConfigMigration, previewAdoptedRevert } from './codex-config-migration';
import { migrateJsonConfigRecords, planJsonConfigMigration, previewJsonAdoptedRevert } from './json-config-migration';
import { UNVERIFIED_INSTALLER_RANGES } from '../../effects/host-config/delegated';
import { openHostConfigGate, planPathRevert, userPathLabel, type HostConfigAdoption, type HostConfigGate, type HostConfigRevertEntry, type HostConfigToolRevertEntry } from '../../effects/host-config/gate';
import { hostConfigPaths, projectedLedgerPaths, readLedger, readProjectedLedger, resolveHostPath } from '../../effects/host-config/store';
import { planToolRemoval, removeTools, windowsPowershellPath, windowsUserPathPort, type ToolRemovalEntry } from '../../effects/host-config/tools';
import { HostConfigError, type ToolId, type ToolRecord } from '../../core/host-config/types';
import { FileSyntaxError, parseJsonText, parseTomlText } from '../../core/evidence/file-syntax';

export interface UninstallOptions {
  target: 'codex' | 'claude' | 'both';
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  runtimeLock?: RuntimeTransactionContext;
  /** Rules files whose recorded block goes also when the user edited it (`--remove-edited-block`); the whole file goes to the vault first. */
  removeEditedBlocks?: readonly string[];
  /** `--with-tools`: also remove the removable shared tools that still hold what rh wrote. */
  withTools?: boolean;
}
/**
 * `restored`: the result was checked equal to the state before rh.
 * `reverted`: rh's changes went, with no such proof. `kept`: rh leaves it.
 * `note`: nothing to do. `unresolved`: preserved because it changed. `failed`:
 * the check before the write failed; nothing was written.
 */
export type UninstallAction = 'restored' | 'reverted' | 'kept' | 'note' | 'unresolved' | 'failed';
export interface UninstallItem { path: string; action: UninstallAction; reason: string }
export interface UninstallResult { exitCode: number; status: 'complete' | 'partial' | 'failed'; dryRun: boolean; items: UninstallItem[]; lines: string[] }

/** The running CLI's package root: its rules template proves which global rules block install wrote. */
const SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function selected(path: string, target: UninstallOptions['target'], home: string): boolean {
  if (target === 'both') return true;
  return path.startsWith(join(home, `.${target}`) + '/') || (target === 'claude' && path === join(home, '.claude.json'));
}
function fileExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function fingerprint(path: string): string | null {
  if (!fileExists(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
  if (stat.isDirectory()) return `dir:${readdirSync(path).sort().map((name) => `${name}:${fingerprint(join(path, name))}`).join('|')}`;
  if (!stat.isFile()) throw new Error(`unsupported installed surface: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
/** The uninstall item names the file, so a syntax failure gives the path-free text. */
function object(raw: string): Record<string, any> {
  const parsed = parseJsonText(raw, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected JSON object');
  return parsed as Record<string, any>;
}

/** The item of a failed read before planning: the file that failed, and a reason that does not repeat its path. */
function failedRead(error: unknown, fallback: string): UninstallItem {
  const cause = error instanceof Error ? error.cause : undefined;
  const syntax = error instanceof FileSyntaxError ? error : cause instanceof FileSyntaxError ? cause : null;
  if (syntax?.path) return { path: syntax.path, action: 'unresolved', reason: syntax.detail };
  if (error instanceof InstallStateError) return { path: error.path, action: 'unresolved', reason: error.message };
  return { path: fallback, action: 'unresolved', reason: String((error as Error).message) };
}

/** Plan completely before writing; dry-run neither takes a filesystem lock nor creates receipts. */
export function runUserUninstall(opts: UninstallOptions): UninstallResult {
  if (opts.dryRun) return runUserUninstallLocked(opts);
  // Reject invalid authority without creating a lock directory. Read it again
  // under the lock before planning any mutation, since another writer can run here.
  // A protocol 3 state is read after its migration under the lock; an older
  // ledger is read as its schema move under the lock will leave it.
  try { if (!installStatePendingMigration(opts.env ?? process.env)) readUninstallState({ ...opts, dryRun: true }); }
  catch (error) {
    return uninstallResult([failedRead(error, configurationReceiptPath(hostConfigurationRoot(opts.env)))], false);
  }
  return withRuntimeTransactionContext(globalRuntimeScope(opts.env), opts.runtimeLock, (runtimeLock) => runUserUninstallLocked({ ...opts, runtimeLock }));
}

/** The host files that the host-config ledger owns, by uninstall target. */
function hostConfigFiles(home: string, target: UninstallOptions['target']): { codex: string | null; json: string[] } {
  const codex = join(home, '.codex/config.toml');
  const json = [join(home, '.codex/hooks.json'), join(home, '.claude/settings.json'), join(home, '.claude.json')];
  return { codex: selected(codex, target, home) ? codex : null, json: json.filter((path) => selected(path, target, home)) };
}

/**
 * Before the migrations run (a dry run, or the check before the lock), they
 * are planned in memory. A target leaves the files of the other host and their
 * old records as they are, also when a migration would reject such a file.
 */
function readUninstallState(opts: UninstallOptions) {
  const env = opts.env ?? process.env;
  const home = hostConfigurationRoot(env);
  assertConfigurationPath(installProfileStatePath(env), home);
  const lock = providerSkillLock(home, env);
  const files = hostConfigFiles(home, opts.target);
  const codexMigration = files.codex ? planCodexConfigMigration(env) : null;
  const jsonMigration = files.json.length ? planJsonConfigMigration(env, files.json) : null;
  // A dry run on a protocol 3 state plans with the migration's projection and writes nothing.
  const projected = opts.dryRun && installStatePendingMigration(env) ? planInstallStateMigration(env) : null;
  const state = projected?.state ?? readInstallState(env);
  // A dry run reads the ledger as the schema move would leave it.
  const records = projected ? projected.records : !state ? {} : opts.dryRun ? partitionPathRecords(env, projectedLedgerPaths(hostConfigPaths(env))).records : readPathRecords(env);
  // The Pi package entries that the ledger records under owner `pi`, or that the migration would record.
  const piPackages = opts.target !== 'both' ? [] : projected ? projected.piPackages : ownedPiPackages(env, openHostConfigGate({ env, preview: opts.dryRun === true }));
  return { state, records, piPackages, lock, files, codexMigration, jsonMigration };
}

const REVERT_REASONS: Readonly<Record<HostConfigRevertEntry['action'], string>> = {
  removed: 'host-config ledger: rh created this file',
  restored: 'host-config ledger: the file before rh',
  text_removed: 'host-config ledger: rh text removed',
  released: 'host-config ledger: rh text already gone',
  already_absent: 'file already absent',
  kept_edited: 'changed since rh wrote it; preserved',
  failed: 'host_config_restore_mismatch: the reverted file would not equal the file before rh; nothing written, the ledger record and its vault copy kept',
};

const BASELINE_UNKNOWN = 'baseline unknown: equality with the file before install cannot be proved';

/** The report item of one gate revert entry; `rh config restore` uses the same mapping. */
export function revertItem(entry: HostConfigRevertEntry): UninstallItem {
  const action: UninstallAction = entry.action === 'kept_edited' ? 'unresolved' : entry.action === 'already_absent' ? 'note'
    : entry.action === 'failed' ? 'failed' : entry.baseline === 'proved' ? 'restored' : 'reverted';
  const reason = [REVERT_REASONS[entry.action], ...(entry.baseline === 'unknown' && action === 'reverted' ? [BASELINE_UNKNOWN] : [])].join('; ');
  return { path: entry.path, action, reason: entry.kept?.length ? `${reason}: ${entry.kept.join(', ')}` : reason };
}

/** A `failed` item blocks like an `unresolved` one and takes exit code 2 over 1. */
function blocking(items: readonly UninstallItem[]): boolean {
  return items.some((item) => item.action === 'unresolved' || item.action === 'failed');
}

export function exitCodeOf(items: readonly UninstallItem[]): 0 | 1 | 2 {
  return items.some((item) => item.action === 'failed') ? 2 : items.some((item) => item.action === 'unresolved') ? 1 : 0;
}

function sameRevert(left: readonly HostConfigRevertEntry[], right: readonly HostConfigRevertEntry[]): boolean {
  const key = (entries: readonly HostConfigRevertEntry[]) => entries.map((entry) => `${entry.action}:${entry.kept?.join(',') ?? ''}`).join();
  return key(left) === key(right);
}

function toolSummary(tool: string, record: ToolRecord): string {
  const where = Object.keys(record.paths).map((path) => path.split(/[\\/]/u).at(-1)).join(', ');
  return `${tool} ${record.version}${where ? ` (${where})` : ''}${record.path_entry ? ' and its user PATH entry' : ''}`;
}

/**
 * The tool items. An uninstall keeps every tool record and prints one `kept`
 * line (#2853); it releases the entries that are gone, so a target that comes
 * back is not rh's. `--with-tools` also removes each entry of a removable
 * tool that still holds what rh wrote, and keeps an entry that changed. The
 * release or removal plans as a dry run, and the apply must equal it.
 */
interface ToolPlan {
  readonly items: UninstallItem[];
  readonly released: readonly HostConfigToolRevertEntry[];
  readonly removal: readonly ToolRemovalEntry[];
}

const TOOL_REMOVAL_ITEMS: Readonly<Record<ToolRemovalEntry['action'], { readonly action: UninstallAction; readonly reason: string }>> = {
  removed: { action: 'restored', reason: 'rh installed it; removed' },
  already_absent: { action: 'note', reason: 'already absent; the tool record goes' },
  kept_edited: { action: 'unresolved', reason: 'changed since rh installed it; preserved' },
  kept_released: { action: 'kept', reason: 'a directory tree that rh installed; rh does not remove a tree and no longer records it; remove it by hand' },
};

function planTools(env: NodeJS.ProcessEnv, gate: HostConfigGate, opts: UninstallOptions): ToolPlan {
  const paths = hostConfigPaths(env);
  const ledger = (opts.dryRun ? readProjectedLedger : readLedger)(paths);
  const tools = Object.entries(ledger.tools) as [ToolId, ToolRecord][];
  if (!tools.length) return { items: [], released: [], removal: [] };
  if (opts.withTools) {
    const removal = planToolRemoval(ledger, userPathPort(env, paths.harness));
    const items: UninstallItem[] = removal.map((entry) => {
      const item = TOOL_REMOVAL_ITEMS[entry.action];
      // Other entries of the user PATH value can differ from the value before rh, so its removal proves no equality.
      const action = entry.action === 'removed' && entry.kind === 'user_path' ? 'reverted' : item.action;
      return { path: entry.path, action, reason: `${entry.tool}: ${item.reason}` };
    });
    const gone = new Set(removal.filter((entry) => entry.action === 'already_absent').map((entry) => entry.path));
    const left = tools.filter(([, record]) => !record.removable && (Object.keys(record.paths).some((key) => !gone.has(key))
      || (record.path_entry !== undefined && !gone.has(userPathLabel(record.path_entry.entry)))));
    if (left.length) items.push({ path: paths.ledger, action: 'kept', reason: `shared tools that rh installed stay: ${left.map(([tool, record]) => toolSummary(tool, record)).join('; ')}` });
    return { items, released: [], removal };
  }
  const released = gate.releaseAbsentTools(userPathPort(env, paths.harness), { dryRun: true });
  const gone = new Set(released.map((entry) => entry.path));
  const left = tools.map(([tool, record]) => [tool, { ...record, paths: Object.fromEntries(Object.entries(record.paths).filter(([key]) => !gone.has(key))),
    ...(record.path_entry && gone.has(userPathLabel(record.path_entry.entry)) ? { path_entry: undefined } : {}) }] as const)
    .filter(([, record]) => Object.keys(record.paths).length || record.path_entry);
  const items: UninstallItem[] = released.map((entry) => ({ path: entry.path, action: 'note', reason: `${entry.tool}: already absent; the tool record goes` }));
  if (left.length) items.push({ path: paths.ledger, action: 'kept', reason: `shared tools that rh installed stay: ${left.map(([tool, record]) => toolSummary(tool, record)).join('; ')}` });
  return { items, released, removal: [] };
}

function userPathPort(env: NodeJS.ProcessEnv, cwd: string) {
  return () => {
    const powershell = windowsPowershellPath(env);
    if (powershell === null) throw new HostConfigError('host_config_invalid_state', 'SystemRoot is not set, so rh cannot read the user PATH');
    return windowsUserPathPort(powershell, cwd, env);
  };
}

function uninstallResult(items: UninstallItem[], dryRun: boolean): UninstallResult {
  const exitCode = exitCodeOf(items);
  const status = exitCode === 2 ? 'failed' : exitCode === 1 ? 'partial' : 'complete';
  return { exitCode, status, dryRun, items,
    lines: [...items.map((item) => `[${item.action}] ${item.path}: ${item.reason}`), `[uninstall] ${status}${dryRun ? ' (dry-run)' : ''}`] };
}

function runUserUninstallLocked(opts: UninstallOptions): UninstallResult {
  const env = opts.env ?? process.env;
  const home = hostConfigurationRoot(env);
  const items: UninstallItem[] = [];
  const writes = new Map<string, string | null>();
  const originals = new Map<string, string | null>();
  const surfaceRemovals: string[] = [];
  const piRemovals: string[] = [];
  const piSkills = hostSkillRoot(home, 'pi', env);
  let lock: ProviderSkillLock;
  // A repository exclude file, its links followed, has its own directory as its root.
  const repositoryExcludes = new Set<string>();
  // A path record's key has its parent links followed, so it is checked under the root with links followed.
  const recordRoots = new Map<string, string>();
  const surfaceRoot = (path: string) => recordRoots.get(path) ?? (path === lock.path ? lock.root : repositoryExcludes.has(path) ? dirname(path) : path.startsWith(piSkills + '/') ? dirname(piSkills) : home);
  const removedSurfaces = new Set<string>();
  // The gate's dry-run revert of each path record in removedSurfaces; the apply must match it.
  const pathReverts = new Map<string, HostConfigRevertEntry>();
  const removedPi = new Set<string>();
  const remember = (path: string): void => { if (!originals.has(path)) originals.set(path, fingerprint(path)); };
  const read = (path: string): string => writes.has(path) ? writes.get(path) ?? '' : existsSync(path) ? readFileSync(path, 'utf8') : '';
  const change = (path: string, value: string | null, reason: string, action: UninstallAction = 'reverted'): void => {
    remember(path); writes.set(path, value); items.push({ path, action, reason });
  };
  const unresolved = (path: string, reason: string): void => { items.push({ path, action: 'unresolved', reason }); };
  let state: ReturnType<typeof readInstallState> = null;
  let records: PathRecords = {};
  let piPackages: readonly string[] = [];
  let files: ReturnType<typeof hostConfigFiles>;
  let codexMigration: ReturnType<typeof planCodexConfigMigration>;
  let jsonMigration: ReturnType<typeof planJsonConfigMigration>;
  try {
    if (!opts.dryRun) migrateInstallState(env);
    const targets = hostConfigFiles(home, opts.target);
    if (!opts.dryRun && targets.codex) migrateCodexConfigRecords(env);
    if (!opts.dryRun && targets.json.length) migrateJsonConfigRecords(env, targets.json);
    ({ state, records, piPackages, lock, files, codexMigration, jsonMigration } = readUninstallState(opts));
  } catch (error) { items.push(failedRead(error, configurationReceiptPath(home))); return result(); }

  const gate = openHostConfigGate({ env, preview: opts.dryRun === true });
  // The Skills CLI lock is a staging file: its recorded entries go with a full uninstall only.
  const hostPaths = [...(files.codex ? [files.codex] : []), ...files.json, ...(opts.target === 'both' && gate.recorded(lock.path).length ? [lock.path] : [])];
  // The Global Working Rules files go by the ledger too. Two host paths that name one file are one revert.
  const rulesAdoptions = new Map<string, HostConfigAdoption>();
  const resolvedHostPaths = new Set<string>();
  const globalContextPaths = new Set<string>();
  for (const host of ['codex', 'claude'] as const) {
    if (opts.target !== 'both' && opts.target !== host) continue;
    const contextPath = globalContextPath(home, host);
    globalContextPaths.add(contextPath);
    try {
      const resolved = resolveHostPath(hostConfigPaths(env), contextPath);
      if (resolvedHostPaths.has(resolved)) continue;
      resolvedHostPaths.add(resolved);
      if (!gate.recorded(contextPath).length) {
        const unrecorded = inspectUnrecordedGlobalRules(contextPath, SOURCE_ROOT);
        if (unrecorded.kind === 'none') continue;
        if (unrecorded.kind === 'preserved') { unresolved(contextPath, unrecorded.reason); continue; }
        // The one-shot migration: a dry run plans it in memory.
        if (opts.dryRun) rulesAdoptions.set(contextPath, unrecorded.adoption);
        else gate.adopt(contextPath, unrecorded.adoption);
      }
      hostPaths.push(contextPath);
    } catch (error) { unresolved(contextPath, String((error as Error).message)); }
  }
  for (const named of opts.removeEditedBlocks ?? []) {
    try {
      const target = resolveHostPath(hostConfigPaths(env), named);
      const rulesPath = [...globalContextPaths].find((path) => hostPaths.includes(path) && resolveHostPath(hostConfigPaths(env), path) === target);
      if (!rulesPath) throw new Error('not a recorded rules file of this target; nothing removed');
      const removal = gate.removeEditedBlock(rulesPath);
      // The dry run cannot plan the revert of the file after the removal, so it leaves the file out.
      if (opts.dryRun) hostPaths.splice(hostPaths.indexOf(rulesPath), 1);
      items.push({ path: removal.path, action: 'reverted', reason: removal.recovery === null
        ? `the ${removal.selector} block goes on your word; the whole file goes to the vault first`
        : `the ${removal.selector} block went on your word; whole-file copy: ${removal.recovery}` });
    } catch (error) { unresolved(named, String((error as Error).message)); }
  }
  const previewOf = (path: string): readonly HostConfigRevertEntry[] => {
    const rules = rulesAdoptions.get(path);
    if (rules) return [previewGlobalRulesAdoptedRevert(path, rules)];
    if (path === files.codex && codexMigration?.adoption) return previewAdoptedRevert(env, codexMigration);
    const planned = jsonMigration?.files.find((file) => file.path === path);
    return planned ? previewJsonAdoptedRevert({ ...jsonMigration!, files: [planned] }) : gate.revert([path], { dryRun: true });
  };
  let hostRevert: readonly HostConfigRevertEntry[] = [];
  for (const path of hostPaths) {
    try {
      const preview = previewOf(path);
      hostRevert = [...hostRevert, ...preview];
      for (const entry of preview) if (entry.action !== 'released') items.push(revertItem(entry));
    } catch (error) { unresolved(path, String((error as Error).message)); }
  }
  if (files.codex && existsSync(files.codex)) {
    try {
      const parsed = parseTomlText(readFileSync(files.codex, 'utf8'), null) as Record<string, any>;
      // Codex writes these after the user trusts the hooks; they never block completion.
      if (parsed.hooks?.state && Object.keys(parsed.hooks.state).length) items.push({ path: files.codex, action: 'note', reason: 'Codex keeps its hook trust entries in [hooks.state]; rh does not remove them.' });
    } catch (error) { unresolved(files.codex, String((error as Error).message)); }
  }

  for (const source of piPackages) {
    try {
      if (piExecutable(env) === null) {
        items.push({ path: source, action: 'kept', reason: 'pi not found on PATH; package removal skipped; ownership retained for retry' });
        continue;
      }
      // An entry that is gone from the Pi settings releases its record with no pi remove, so a later hand registration is never rh's.
      items.push({ path: source, action: 'reverted', reason: piPackagePresent(source, env)
        ? 'recorded Pi package entry through pi remove; the entry is read back'
        : 'recorded Pi package entry is already absent; its record is released with no pi remove' });
      piRemovals.push(source);
      removedPi.add(source);
    } catch (error) { unresolved(source, (error as Error).message); }
  }
  for (const [key, record] of Object.entries(records) as [string, PathRecord][]) {
    // The host comes from the path as the install named it, so a linked ~/.claude still is `claude`.
    if (opts.target !== 'both' && record.host !== opts.target) continue;
    // The user keeps the file; the uninstall only releases the record.
    if (record.kind === 'user_managed') {
      if (opts.target === 'both') { removedSurfaces.add(key); pathReverts.set(key, { path: key, action: 'released' }); }
      continue;
    }
    if (record.host === 'bin') {
      items.push({ path: key, action: 'kept', reason: 'package-manager installation retained; remove separately after configuration cleanup' });
      continue;
    }
    try {
      // The record is checked beneath its own host root, which a link can put outside HOME.
      const root = pathRecordRoot(env, key, record);
      if (root === null) throw new Error(`the record is outside the root of its host: ${key}`);
      recordRoots.set(key, root);
      // A record may own the final symlink, but never a symlinked parent directory.
      assertConfigurationPath(dirname(key), surfaceRoot(key));
      // The records of a dry-run migration are not in the ledger yet, so the plan reads them from `records`.
      const action = planPathRevert(key, record);
      if (action === 'kept_edited') { unresolved(key, 'owned surface changed since installation; preserved'); continue; }
      pathReverts.set(key, { path: key, action });
      removedSurfaces.add(key);
      if (action === 'released') continue;
      remember(key); surfaceRemovals.push(key);
      items.push(action === 'restored'
        ? { path: key, action: 'restored', reason: 'unchanged transaction-owned file; the user file it replaced comes back from the vault' }
        : { path: key, action: record.baseline.state === 'known' && !record.baseline.existed ? 'restored' : 'reverted', reason: 'unchanged transaction-owned surface' });
    } catch (error) { unresolved(key, String((error as Error).message)); }
  }

  if (opts.target === 'both') {
    const path = join(home, '.repo-harness/config.json');
    try {
      assertConfigurationPath(path, home);
      if (existsSync(path)) {
        const data = object(read(path));
        if ('protectedHelperRuntime' in data || 'architecture' in data || 'refactor_recommendations' in data) {
          delete data.protectedHelperRuntime; delete data.architecture; delete data.refactor_recommendations;
          change(path, Object.keys(data).length ? `${JSON.stringify(data, null, 2)}\n` : null, 'rh helper/architecture configuration; data directories retained');
        }
      }
    } catch (error) { unresolved(path, String((error as Error).message)); }
    const ledgerPath = repositoryExcludesLedgerPath(env);
    let ledger: RepositoryExclude[] = [];
    try { ledger = readRepositoryExcludes(env); } catch (error) { items.push(failedRead(error, ledgerPath)); }
    const retained = ledger.filter((entry) => {
      try {
        if (!existsSync(entry.repo_path)) throw new Error(`repository ${entry.repo_path} is unavailable; block and ledger entry kept`);
        const path = repositoryExcludeTarget(repositoryCommonDirectory(entry.repo_path, env), env);
        if (path !== entry.exclude_path) throw new Error(`repository ${entry.repo_path} now resolves its exclude file to ${path}; preserved`);
        repositoryExcludes.add(path);
        // Read as latin1 and written back the same way, so the bytes outside the block stay.
        const removal = removeRuntimeStateIgnoreBlock(existsSync(path) ? readFileSync(path, 'latin1') : '');
        if (removal.status === 'unbalanced') unresolved(path, 'unbalanced runtime-state ignore block; preserved');
        else if (removal.status === 'edited') unresolved(path, 'runtime-state ignore block was edited; preserved. Move your rules outside the markers, then delete the block.');
        else if (removal.status === 'removed') change(path, removal.content, 'runtime-state ignore block');
        return removal.status === 'unbalanced' || removal.status === 'edited';
      } catch (error) { unresolved(entry.exclude_path, String((error as Error).message)); return true; }
    });
    if (retained.length !== ledger.length) change(ledgerPath, serializeRepositoryExcludes(retained), 'repository excludes ledger');
  }

  const statePath = installProfileStatePath(env);
  // A retired state drops every path record that the gate revert leaves (the preserved `bin` entries); a partial run keeps them for a retry or the other host.
  let retireRecords = false;
  const recordsDigest = pathRecordsDigest(records);
  if (state) {
    const pendingPi = piPackages.filter((source) => !removedPi.has(source));
    if (opts.target === 'both' && !pendingPi.length && !blocking(items)) {
      change(statePath, null, 'install state retired');
      retireRecords = true;
    }
  }
  // After the retirement check: a tool that stays does not keep the install state; a failed tool read sets the exit code.
  let tools: ToolPlan = { items: [], released: [], removal: [] };
  try { tools = planTools(env, gate, opts); } catch (error) { unresolved(hostConfigPaths(env).ledger, String((error as Error).message)); }
  items.push(...tools.items);
  items.push({ path: join(home, '.repo-harness'), action: 'kept', reason: 'archives, runtime history and the MCP config retained; third-party packages/plugins retained' });
  // The records of another tool's installer cover only what its measurement proved (#2852).
  if (piPackages.length || hostPaths.includes(lock.path)) {
    items.push({ path: hostConfigPaths(env).ledger, action: 'note', reason: `installer writes outside the declared sets are not verified, and rh claims nothing there: ${UNVERIFIED_INSTALLER_RANGES.join('; ')}` });
  }

  if (!opts.dryRun) {
    try {
      for (const [path, expected] of originals) {
        assertConfigurationPath(dirname(path), surfaceRoot(path));
        if (fingerprint(path) !== expected) throw new Error(`configuration changed after preview: ${path}`);
      }
      // A failed Pi readback stops before the ownership ledger is written.
      for (const source of piRemovals) removePiPackage(source, env);
      const surfaces = [...removedSurfaces];
      if ((surfaces.length || retireRecords) && pathRecordsDigest(readPathRecords(env)) !== recordsDigest) throw new Error(`configuration changed after preview: ${hostConfigPaths(env).ledger}`);
      // The gate undoes each entry and then drops its record, so a stop between them leaves a record of a missing path, which a retry releases.
      if (surfaces.length && !sameRevert(gate.revertPaths(surfaces), surfaces.map((key) => pathReverts.get(key)!))) throw new Error(`configuration changed after preview: ${surfaces.join(', ')}`);
      if (retireRecords) writePathRecords(env, {});
      for (const [path, content] of writes) {
        assertConfigurationPath(path, surfaceRoot(path));
        if (path === globalConfigurationPath(env)) {
          mutateGlobalConfiguration(env, () => ({ config: content === null ? null : object(content), value: undefined }), { runtimeLock: opts.runtimeLock });
        } else if (content === null) { if (existsSync(path)) unlinkSync(path); }
        else if (repositoryExcludes.has(path)) writeFileSync(path, content, 'latin1');
        else writePrivateConfiguration(path, content, surfaceRoot(path));
      }
      if (hostPaths.length && !sameRevert(gate.revert(hostPaths), hostRevert)) throw new Error(`configuration changed after preview: ${hostPaths.join(', ')}`);
      if (tools.released.length && JSON.stringify(gate.releaseAbsentTools(userPathPort(env, hostConfigPaths(env).harness))) !== JSON.stringify(tools.released)) {
        throw new Error(`configuration changed after preview: ${hostConfigPaths(env).ledger}`);
      }
      if (tools.removal.length) {
        // A failed removal replaces the planned `removed` item of its entry; a created directory has no planned item.
        for (const failure of removeTools(env, userPathPort(env, hostConfigPaths(env).harness), tools.removal)) {
          const item: UninstallItem = { path: failure.path, action: 'unresolved', reason: `${failure.tool}: ${failure.reason}` };
          const index = items.findIndex((planned) => planned.path === failure.path && planned.reason.startsWith(`${failure.tool}: `));
          if (index === -1) items.push(item); else items[index] = item;
        }
      }
      for (const path of [...originals.keys()]) {
        const parent = dirname(path);
        // Never remove a host root or history tree; only now-empty managed leaf containers.
        if (['skills', 'rules', 'agents'].includes(parent.split('/').at(-1) ?? '') && existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
      }
    } catch (error) { unresolved(home, `uninstall incomplete: ${String((error as Error).message)}`); }
  }
  return result();
  function result(): UninstallResult { return uninstallResult(items, opts.dryRun === true); }
}
