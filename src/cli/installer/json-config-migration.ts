import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { isDeepStrictEqual } from 'node:util';
import { MANAGED_TAG, isRepoHarnessManagedHookCommand } from '../../core/adoption/managed-hook-config';
import { CLAUDE_ROOT_CONFIG_BACKUP, CODEGRAPH_MCP_SELECTOR, LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR, claudeFragmentOwner } from '../../core/host-config/claude-config';
import { jsonDocumentIsEmpty, jsonFragment, jsonFragmentValue, managedHookSelectors, removeJsonFragment } from '../../core/host-config/json-fragment';
import { HostConfigError, type FragmentEdit } from '../../core/host-config/types';
import { openHostConfigGate, type AdoptedFragment, type HostConfigAdoption, type HostConfigRevertEntry } from '../../effects/host-config/gate';
import { configurationReceiptPath, hostConfigurationRoot, readRawConfigurationReceipt, saveConfigurationReceipt, type ConfigurationReceipt } from './configuration-ownership';
import { CODEGRAPH_CONFIG_MARKER, codegraphProjection, readInstallState, writeState, type InstallState, type ManagedInstallSurface } from './install-profile';

/**
 * One-shot migration of the JSON host files into the host-config ledger.
 * Earlier rh versions tagged their hook entries and status line, recorded the
 * CodeGraph fragments in `configuration-restore.json`, and recorded the files
 * in the install-state ownership manifest. Each intact rh fragment becomes a
 * fragment record of one adopted file; the backup is the file with those
 * fragments set back to their text before rh, the state that the old
 * uninstall left. Then the old records go, and the receipt file goes with its
 * last entry.
 */
export interface JsonConfigMigration {
  readonly files: readonly { readonly path: string; readonly adoption: HostConfigAdoption }[];
  readonly receipt: ConfigurationReceipt | null;
  readonly state: InstallState | null;
}

/** An rh fragment of the old records: `before` undefined when rh added it. */
interface OldFragment {
  readonly selector: string;
  readonly before: unknown;
  readonly installed: unknown;
}

const OLD_SELECTORS: Readonly<Record<string, string>> = {
  'mcpServers.codegraph': CODEGRAPH_MCP_SELECTOR,
  'allowedTools.codegraph': LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR,
};

function invalid(message: string): HostConfigError {
  return new HostConfigError('host_config_invalid_state', message);
}

function jsonPaths(home: string): { hooks: readonly string[]; root: string; all: readonly string[] } {
  const hooks = [join(home, '.codex', 'hooks.json'), join(home, '.claude', 'settings.json')];
  const root = join(home, '.claude.json');
  return { hooks, root, all: [...hooks, root] };
}

function parseOld(value: unknown, receiptPath: string): unknown {
  if (value === null) return undefined;
  try { return JSON.parse(String(value)) as unknown; } catch { throw invalid(`invalid configuration receipt entry: ${receiptPath}`); }
}

/** The receipt's JSON entries per file; every other entry stays for its own reader. */
function receiptFragments(raw: any, paths: readonly string[], receiptPath: string): { byPath: Map<string, OldFragment[]>; rest: ConfigurationReceipt | null } {
  const byPath = new Map<string, OldFragment[]>();
  if (raw === null || !Array.isArray(raw?.changes)) return { byPath, rest: null };
  const pending = Array.isArray(raw.pending?.before) ? raw.pending.before.filter((entry: any) => paths.includes(entry?.path)) : [];
  if (pending.length) {
    const named = pending.map((entry: any) => `${String(entry.selector)} in ${String(entry.path)}`).join(', ');
    throw invalid(`interrupted configuration change (${named}). Restore each fragment from its value in the "pending" block of ${receiptPath}, then remove those entries from the block`);
  }
  const entries = raw.changes.filter((entry: any) => paths.includes(entry?.path));
  if (!entries.length) return { byPath, rest: null };
  for (const entry of entries) {
    const selector = OLD_SELECTORS[entry.selector];
    if (!selector || typeof entry.active !== 'boolean') throw invalid(`invalid configuration receipt entry: ${receiptPath}`);
    if (!entry.active || entry.installed === null) continue;
    const list = byPath.get(entry.path) ?? [];
    list.push({ selector, before: parseOld(entry.before, receiptPath), installed: parseOld(entry.installed, receiptPath) });
    byPath.set(entry.path, list);
  }
  return { byPath, rest: { ...raw, changes: raw.changes.filter((entry: any) => !entries.includes(entry)) } };
}

function isOldJsonSurface(paths: readonly string[]) {
  return (surface: ManagedInstallSurface) => paths.includes(surface.path)
    && (surface.managed_marker === MANAGED_TAG || surface.managed_marker === CODEGRAPH_CONFIG_MARKER);
}

/** The manifest's CodeGraph projection of a file, as added fragments while its hash still matches. */
function manifestFragments(state: InstallState | null, path: string, content: string): { fragments: OldFragment[]; changed: boolean } {
  const surfaces = state?.ownership_manifest.filter((surface) => surface.path === path && surface.managed_marker === CODEGRAPH_CONFIG_MARKER) ?? [];
  if (!surfaces.length) return { fragments: [], changed: false };
  const current = existsSync(path) ? codegraphProjection(path) : null;
  if (current === null) return { fragments: [], changed: false };
  if (!surfaces.some((surface) => surface.content_hash === current)) return { fragments: [], changed: true };
  const fragments: OldFragment[] = [];
  for (const selector of [CODEGRAPH_MCP_SELECTOR, LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR]) {
    const value = jsonFragmentValue(content, selector);
    if (value !== undefined) fragments.push({ selector, before: undefined, installed: value });
  }
  return { fragments, changed: false };
}

/** Tagged hook entries and a tagged status line: rh added them. */
function taggedFragments(content: string, hookFile: boolean): OldFragment[] {
  if (!hookFile) return [];
  const fragments: OldFragment[] = managedHookSelectors(content).map((selector) => ({ selector, before: undefined, installed: jsonFragmentValue(content, selector) }));
  const statusLine = jsonFragmentValue(content, 'statusLine') as { command?: unknown } | undefined;
  if (statusLine && isRepoHarnessManagedHookCommand(statusLine.command)) fragments.push({ selector: 'statusLine', before: undefined, installed: statusLine });
  return fragments;
}

function applyEdit(content: string, edit: FragmentEdit): string {
  return content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
}

function adoption(path: string, content: string, fragments: readonly OldFragment[], changed: boolean, root: string): HostConfigAdoption | null {
  let backup = content;
  let externalChange = changed;
  let override = false;
  const adopted: AdoptedFragment[] = [];
  for (const fragment of fragments) {
    const range = jsonFragment.locate(content, fragment.selector);
    if (!range || !isDeepStrictEqual(jsonFragmentValue(content, fragment.selector), fragment.installed)) {
      externalChange = true;
      continue;
    }
    backup = fragment.before === undefined ? applyEdit(backup, removeJsonFragment(backup, fragment.selector)) : applyEdit(backup, jsonFragment.apply(backup, fragment.selector, fragment.before));
    override ||= fragment.before !== undefined;
    adopted.push({ owner: claudeFragmentOwner(fragment.selector), selector: fragment.selector, kind: fragment.before === undefined ? 'add' : 'override', inserted: content.slice(range.start, range.end) });
  }
  if (!adopted.length && !externalChange) return null;
  // The old uninstall removed a file that held nothing else: rh created it.
  if (jsonDocumentIsEmpty(backup)) return { kind: 'created', backup: null, fragments: adopted, externalChange };
  if (path === root && CLAUDE_ROOT_CONFIG_BACKUP === 'overrides-only' && !override) return { kind: 'text_block', backup: null, fragments: adopted, externalChange };
  return { kind: 'text_block', backup: Buffer.from(backup, 'utf8'), fragments: adopted, externalChange };
}

/** Plan the migration without writing; null when no old record is left. */
export function planJsonConfigMigration(env: NodeJS.ProcessEnv): JsonConfigMigration | null {
  const home = hostConfigurationRoot(env);
  const paths = jsonPaths(home);
  const receipt = receiptFragments(readRawConfigurationReceipt(home), paths.all, configurationReceiptPath(home));
  const state = readInstallState(env);
  const gate = openHostConfigGate({ env });
  const files: JsonConfigMigration['files'][number][] = [];
  for (const path of paths.all) {
    if (gate.recorded(path).length) continue;
    const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const manifest = manifestFragments(state, path, content);
    const fromReceipt = receipt.byPath.get(path) ?? [];
    // A receipt entry is the older and more exact record of its fragment.
    const old = [...fromReceipt, ...manifest.fragments.filter((fragment) => !fromReceipt.some((entry) => entry.selector === fragment.selector)), ...taggedFragments(content, paths.hooks.includes(path))];
    const adopted = adoption(path, content, old, manifest.changed, paths.root);
    if (adopted) files.push({ path, adoption: adopted });
  }
  const surfaces = state ? [...state.ownership_manifest, ...(state.previous?.ownership_manifest ?? [])].some(isOldJsonSurface(paths.all)) : false;
  const rest: InstallState | null = state && surfaces ? {
    ...state,
    ownership_manifest: state.ownership_manifest.filter((surface) => !isOldJsonSurface(paths.all)(surface)),
    previous: state.previous && { ...state.previous, ownership_manifest: state.previous.ownership_manifest.filter((surface) => !isOldJsonSurface(paths.all)(surface)) },
  } : null;
  if (!files.length && !receipt.rest && !rest) return null;
  return { files, receipt: receipt.rest, state: rest };
}

/** Run the migration once: the ledger records come first, then the old records go. A later run finds none. */
export function migrateJsonConfigRecords(env: NodeJS.ProcessEnv): void {
  const migration = planJsonConfigMigration(env);
  if (!migration) return;
  const gate = openHostConfigGate({ env });
  for (const file of migration.files) gate.adopt(file.path, file.adoption);
  if (migration.receipt) saveConfigurationReceipt(migration.receipt, hostConfigurationRoot(env));
  if (migration.state) writeState(migration.state, env);
}

/**
 * What a revert of the adopted files would report, for a dry run before the
 * migration; it follows the gate's revert rules for each adopted record.
 */
export function previewJsonAdoptedRevert(migration: JsonConfigMigration): HostConfigRevertEntry[] {
  return migration.files.map(({ path, adoption: adopted }): HostConfigRevertEntry => {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (!adopted.externalChange && (adopted.kind === 'created' || adopted.backup !== null)) {
      if (adopted.backup === null) return { path, action: 'removed' };
      return { path, action: adopted.backup.toString('utf8') === current ? 'released' : 'text_removed' };
    }
    // Every adopted fragment is intact, so the per-fragment rule removes each `add` and keeps each override.
    const kept = adopted.fragments.filter((fragment) => fragment.kind !== 'add').map((fragment) => fragment.selector);
    if (kept.length) return { path, action: 'kept_edited', kept };
    if (!adopted.fragments.length) return { path, action: adopted.kind === 'text_block' && adopted.backup === null ? 'released' : 'kept_edited' };
    const left = adopted.fragments.reduce((content, fragment) => applyEdit(content, removeJsonFragment(content, fragment.selector)), current);
    return { path, action: adopted.kind === 'created' && jsonDocumentIsEmpty(left) ? 'removed' : 'text_removed' };
  });
}
