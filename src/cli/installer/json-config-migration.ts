import { parseJsonText } from '../../core/evidence/file-syntax';
import { existsSync, lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import { isDeepStrictEqual } from 'node:util';
import { MANAGED_TAG, isRepoHarnessManagedHookCommand } from '../../core/adoption/managed-hook-config';
import { CLAUDE_ROOT_CONFIG_BACKUP, CODEGRAPH_MCP_SELECTOR, LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR, claudeFragmentOwner } from '../../core/host-config/claude-config';
import { jsonFragment, jsonFragmentValue, managedHookSelectors, removeJsonFragment } from '../../core/host-config/json-fragment';
import { HostConfigError, type FragmentEdit } from '../../core/host-config/types';
import { openHostConfigGate, planFileRevert, type AdoptedFragment, type HostConfigAdoption, type HostConfigRevertEntry } from '../../effects/host-config/gate';
import { configurationReceiptPath, hostConfigurationRoot, readRawConfigurationReceipt, saveConfigurationReceipt, type ConfigurationReceipt } from './configuration-ownership';
import { sha256Prefixed } from '../../core/evidence/sha256';
import { CODEGRAPH_CONFIG_MARKER } from './install-profile';
import { readLegacyManifest, type LegacyManifestSurface } from './install-state';
import { canonicalManagedHookProjection, type HookHost } from './managed-entries';

/**
 * One-shot migration of the JSON host files into the host-config ledger.
 * Earlier rh versions tagged their hook entries and status line, recorded the
 * CodeGraph fragments in `configuration-restore.json`, and recorded the files
 * in the install-state ownership manifest. Each intact rh fragment becomes a
 * fragment record of one adopted file; the backup is the file with those
 * fragments set back to their text before rh, the state that the old
 * uninstall left. The migration records only what it can prove: a receipt
 * fragment whose value equals its `installed`, a CodeGraph projection whose
 * manifest hash matches, a tagged hook entry with exactly the old writer's
 * shape and a command that a release wrote (and the manifest hash when one
 * exists), and a status line whose text is exactly a rendering that a release
 * wrote. Each one
 * keeps its adopted text as `preimage`. Any other fragment is still recorded,
 * with no text: it stays and is reported, and rh does not refresh it. No
 * container and no file is recorded as created; only a later gate write
 * proves that. Then the old records go, and the receipt file goes with its
 * last entry.
 */
export interface JsonConfigMigration {
  readonly files: readonly { readonly path: string; readonly adoption: HostConfigAdoption }[];
  readonly receipt: ConfigurationReceipt | null;
}

/** An rh fragment of the old records: `before` undefined when rh added it; `installed` undefined when its text is not known to be rh's. */
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

function jsonPaths(home: string, only?: readonly string[]): { hooks: ReadonlyMap<string, HookHost>; root: string; all: readonly string[] } {
  const hooks = new Map<string, HookHost>([[join(home, '.codex', 'hooks.json'), 'codex'], [join(home, '.claude', 'settings.json'), 'claude']]);
  const root = join(home, '.claude.json');
  return { hooks, root, all: [...hooks.keys(), root].filter((path) => !only || only.includes(path)) };
}

function parseOld(value: unknown, receiptPath: string): unknown {
  if (value === null) return undefined;
  try { return JSON.parse(String(value)) as unknown; } catch { throw invalid(`invalid configuration receipt entry: ${receiptPath}`); }
}

/** The receipt's JSON entries per file; every other entry stays for its own reader. */
function receiptFragments(raw: any, paths: readonly string[], receiptPath: string): { byPath: Map<string, OldFragment[]>; rest: ConfigurationReceipt | null } {
  const byPath = new Map<string, OldFragment[]>();
  if (raw === null) return { byPath, rest: null };
  if (raw?.protocol !== 1 || !Array.isArray(raw.changes)) throw invalid(`invalid configuration receipt: ${receiptPath}`);
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

/** The hash that the old manifest recorded for a file's CodeGraph server and its codegraph `allowedTools` entries. */
function codegraphProjection(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { mcpServers?: Record<string, unknown>; allowedTools?: unknown[] };
    const server = parsed.mcpServers?.codegraph;
    const allowedTools = Array.isArray(parsed.allowedTools)
      ? parsed.allowedTools.filter((entry) => typeof entry === 'string' && entry.toLowerCase().includes('codegraph'))
      : [];
    if (server === undefined && allowedTools.length === 0) return null;
    return sha256Prefixed(JSON.stringify({ server, allowedTools }));
  } catch {
    return null;
  }
}

type LegacyManifest = ReturnType<typeof readLegacyManifest>;

/** The protocol 3 manifest's CodeGraph projection of a file, as added fragments while its hash still matches. */
function manifestFragments(manifest: LegacyManifest, path: string, content: string): { fragments: OldFragment[]; changed: boolean } {
  const surfaces = manifest?.current.filter((surface: LegacyManifestSurface) => surface.path === path && surface.managed_marker === CODEGRAPH_CONFIG_MARKER) ?? [];
  if (!surfaces.length) return { fragments: [], changed: false };
  const current = existsSync(path) ? codegraphProjection(path) : null;
  if (current === null) return { fragments: [], changed: false };
  const intact = surfaces.some((surface) => surface.content_hash === current);
  const fragments: OldFragment[] = [];
  for (const selector of [CODEGRAPH_MCP_SELECTOR, LEGACY_CODEGRAPH_ALLOWED_TOOLS_SELECTOR]) {
    const value = jsonFragmentValue(content, selector);
    if (value !== undefined) fragments.push({ selector, before: undefined, installed: intact ? value : undefined });
  }
  return { fragments, changed: !intact };
}

const ONLY = (value: object, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
const isObjectValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A path as `shellQuote` quotes it; the group is the quoted text. */
const QUOTED = String.raw`'((?:[^'\n]|'\\'')*)'`;
/** `exec <Bun> <bundle>` as v0.26.6 and later wrote it, with the machine's resolved paths. */
const MACHINE_EXEC = `exec ${QUOTED} ${QUOTED}`;
const TAGGED = `: ${MANAGED_TAG}; `;

/**
 * True when a quoted path of a released command is the path of an existing
 * regular file with the released name, and no segment of it is option-shaped.
 * The text inside the quotes is proved by the file system, not by its shape:
 * any other text gets a record with no text (I1, #3237).
 */
function isReleasedPath(quoted: string, names: readonly string[]): boolean {
  const path = quoted.replaceAll(String.raw`'\''`, "'");
  const segments = path.split(/[\\/]/);
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(path) || !names.includes(segments.at(-1)!) || segments.some((segment) => /(?:^|\s)-/.test(segment))) return false;
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** True when the command is one that a release wrote with this tail: `exec repo-harness-hook` before v0.26.6, `MACHINE_EXEC` since. */
function isReleasedExec(command: string, head: string, tail: string): boolean {
  if (command === `${head}exec repo-harness-hook${tail}`) return true;
  const [, bun, bundle] = new RegExp(`^${escapeRegExp(head)}${MACHINE_EXEC}${escapeRegExp(tail)}$`).exec(command) ?? [];
  return bun !== undefined && isReleasedPath(bun, ['bun', 'bun.exe']) && /[\\/]dist[\\/]hook-entry\.js$/.test(bundle!) && isReleasedPath(bundle!, ['hook-entry.js']);
}

/**
 * True when the command is a tagged command that a release wrote for one
 * route of a host: v0.10.0 to v0.22.x fell back to `repo-harness hook`;
 * v0.23.0 and later checked the opt-in marker first.
 */
function isReleasedHookCommand(command: string, host: HookHost, event: string, routeId: string): boolean {
  const tail = ` ${event} --route ${routeId}`;
  return command === `${TAGGED}repo=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0; export HOOK_REPO_ROOT="$repo"; if command -v repo-harness-hook >/dev/null 2>&1; then HOOK_HOST=${host} exec repo-harness-hook${tail}; fi; command -v repo-harness >/dev/null 2>&1 || exit 0; HOOK_HOST=${host} exec repo-harness hook${tail}`
    || isReleasedExec(command, `${TAGGED}repo=$(git rev-parse --show-toplevel 2>/dev/null) && [ -f "$repo/.ai/harness/workflow-contract.json" ] || exit 0; export HOOK_REPO_ROOT="$repo"; HOOK_HOST=${host} `, tail);
}

/**
 * True when a tagged hook entry has exactly the shape that the old writer
 * wrote, keys within {matcher, hooks} and one hook with keys within {type,
 * command, timeout}, type `command`, and its command is one that a release
 * wrote for the selector's route on this host. `managedHookSelectors` already
 * proved that an untagged command is a legacy typed or retired command, each
 * an exact text. A user's segment anywhere in a tagged command fails the
 * proof (I1, #3237).
 */
function isReleasedHookEntry(selector: string, value: unknown, host: HookHost): boolean {
  if (!isObjectValue(value)) return false;
  const hooks = value.hooks;
  if (!ONLY(value, ['matcher', 'hooks']) || (value.matcher !== undefined && typeof value.matcher !== 'string') || !Array.isArray(hooks) || hooks.length !== 1) return false;
  const hook = hooks[0];
  if (!isObjectValue(hook) || !ONLY(hook, ['type', 'command', 'timeout']) || hook.type !== 'command' || typeof hook.command !== 'string'
    || (hook.timeout !== undefined && typeof hook.timeout !== 'number')) return false;
  if (!hook.command.startsWith(TAGGED)) return true;
  const [, event, routeId] = /^hooks\.([^.[\]]+)\[([^[\]]+)\]$/.exec(selector) ?? [];
  return event !== undefined && isReleasedHookCommand(hook.command, host, event, routeId!);
}

/** True when the status line is one that a release wrote: v0.26.2 and later, with the same `exec` as the hook commands. */
function isReleasedStatusLine(value: unknown): boolean {
  return isObjectValue(value) && ONLY(value, ['type', 'command']) && value.type === 'command' && typeof value.command === 'string'
    && isReleasedExec(value.command, TAGGED, ' statusline');
}

/** The JSON text without the whitespace between its tokens. */
function compactJson(text: string): string {
  let out = '';
  let inString = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (inString) {
      out += char;
      if (char === '\\') out += text[++at] ?? '';
      else if (char === '"') inString = false;
    } else if (!' \t\n\r'.includes(char)) {
      out += char;
      inString = char === '"';
    }
  }
  return out;
}

/**
 * True when the fragment text is its parsed value written out, whitespace
 * aside. The proofs read the parsed value, and the ledger stores the text:
 * a repeated key parses to its last value and would hide the first (I1).
 * A member (`statusLine`) carries its key; an array element does not.
 */
function textIsValue(text: string, selector: string, value: unknown): boolean {
  const written = JSON.stringify(value);
  return compactJson(text) === (selector.includes('[') ? written : `${JSON.stringify(selector.split('.').at(-1))}:${written}`);
}

/** The hash that the old manifest recorded for the managed hook entries of a hook file, as one. */
function managedAdapterHash(content: string): string | null {
  // A blank file has no hook entries, as managedHookSelectors reads it.
  const hooks = content.trim() === '' ? undefined : (parseJsonText(content, null) as { hooks?: unknown }).hooks;
  const projection = canonicalManagedHookProjection(hooks);
  return Object.keys(projection).length ? sha256Prefixed(JSON.stringify(projection)) : null;
}

/**
 * Tagged hook entries and a tagged status line. Each one is rh's when its
 * text is its value written out and that value is a released rendering; a
 * hook entry also needs, while the old manifest holds a hash of the file's
 * hook entries, that hash to match. Any other one is not proved.
 */
function taggedFragments(manifest: LegacyManifest, path: string, content: string, host: HookHost | undefined): OldFragment[] {
  if (!host) return [];
  const hashes = manifest?.current.filter((surface) => surface.path === path && surface.managed_marker === MANAGED_TAG).map((surface) => surface.content_hash) ?? [];
  // managedHookSelectors validates the file first: its error never quotes the file's text (I1, #3164).
  const selectors = managedHookSelectors(content);
  const hashMatches = !hashes.length || hashes.includes(managedAdapterHash(content));
  const statusLine = jsonFragmentValue(content, 'statusLine') as { command?: unknown } | undefined;
  if (statusLine && isRepoHarnessManagedHookCommand(statusLine.command)) selectors.push('statusLine');
  return selectors.map((selector) => {
    const value = jsonFragmentValue(content, selector);
    const range = jsonFragment.locate(content, selector);
    const proved = range !== null && textIsValue(content.slice(range.start, range.end), selector, value) && (selector === 'statusLine'
      ? isReleasedStatusLine(value)
      : isReleasedHookEntry(selector, value, host) && hashMatches);
    return { selector, before: undefined, installed: proved ? value : undefined };
  });
}

function applyEdit(content: string, edit: FragmentEdit): string {
  return content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
}

/**
 * The adoption of one file. The backup is the file with each proved fragment
 * set back to its text before rh; the containers around it stay. An unproved
 * fragment keeps its current text in the backup and gets a record with no
 * text, so a revert keeps and reports it.
 */
function adoption(path: string, content: string, fragments: readonly OldFragment[], changed: boolean, root: string): HostConfigAdoption | null {
  let backup = content;
  let externalChange = changed;
  let override = false;
  const adopted: AdoptedFragment[] = [];
  for (const fragment of fragments) {
    const range = jsonFragment.locate(content, fragment.selector);
    const record = { owner: claudeFragmentOwner(fragment.selector), selector: fragment.selector, kind: fragment.before === undefined ? 'add' as const : 'override' as const };
    if (!range) { externalChange = true; continue; }
    if (fragment.installed === undefined || !isDeepStrictEqual(jsonFragmentValue(content, fragment.selector), fragment.installed)) {
      externalChange = true;
      adopted.push({ ...record, inserted: '' });
      continue;
    }
    backup = fragment.before === undefined
      ? applyEdit(backup, removeJsonFragment(backup, fragment.selector))
      : applyEdit(backup, jsonFragment.apply(backup, fragment.selector, fragment.before));
    override ||= fragment.before !== undefined;
    const text = content.slice(range.start, range.end);
    adopted.push({ ...record, inserted: text, preimage: text });
  }
  if (!adopted.length && !externalChange) return null;
  const keepsNoCopy = path === root && CLAUDE_ROOT_CONFIG_BACKUP === 'overrides-only' && !override;
  return { kind: 'text_block', backup: keepsNoCopy ? null : Buffer.from(backup, 'utf8'), fragments: adopted, externalChange };
}

/** Plan the migration without writing; null when no old record is left. `only` limits it to some of the files. */
export function planJsonConfigMigration(env: NodeJS.ProcessEnv, only?: readonly string[]): JsonConfigMigration | null {
  const home = hostConfigurationRoot(env);
  const paths = jsonPaths(home, only);
  const receipt = receiptFragments(readRawConfigurationReceipt(home), paths.all, configurationReceiptPath(home));
  const manifest = readLegacyManifest(env);
  // A planner writes nothing, so a dry run before the ledger schema move can use it.
  const gate = openHostConfigGate({ env, preview: true });
  const files: JsonConfigMigration['files'][number][] = [];
  for (const path of paths.all) {
    if (gate.recorded(path).length) continue;
    const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const projection = manifestFragments(manifest, path, content);
    const fromReceipt = receipt.byPath.get(path) ?? [];
    // A receipt entry is the older and more exact record of its fragment.
    const old = [...fromReceipt, ...projection.fragments.filter((fragment) => !fromReceipt.some((entry) => entry.selector === fragment.selector)), ...taggedFragments(manifest, path, content, paths.hooks.get(path))];
    const adopted = adoption(path, content, old, projection.changed, paths.root);
    if (adopted) files.push({ path, adoption: adopted });
  }
  if (!files.length && !receipt.rest) return null;
  return { files, receipt: receipt.rest };
}

/** Run the migration once: the ledger records come first, then the old records go. A later run finds none. */
export function migrateJsonConfigRecords(env: NodeJS.ProcessEnv, only?: readonly string[]): void {
  const migration = planJsonConfigMigration(env, only);
  if (!migration) return;
  const gate = openHostConfigGate({ env });
  for (const file of migration.files) gate.adopt(file.path, file.adoption);
  if (migration.receipt) saveConfigurationReceipt(migration.receipt, hostConfigurationRoot(env));
}

/** What a revert of the adopted files would report, for a dry run before the migration: the gate's own revert plan of each adopted record. */
export function previewJsonAdoptedRevert(migration: JsonConfigMigration): HostConfigRevertEntry[] {
  return migration.files.map(({ path, adoption: adopted }) => {
    const bytes = existsSync(path) ? readFileSync(path) : null;
    const records = adopted.fragments.map((fragment) => ({ file: path, ...fragment }));
    return planFileRevert({
      path, kind: adopted.kind ?? (adopted.backup === null ? 'created' : 'text_block'), hasBackup: adopted.backup !== null, externalChange: adopted.externalChange,
      committed: true, existed: bytes !== null, bytes, backup: () => adopted.backup!, own: records, all: records, filtered: false,
    }).entry;
  });
}
