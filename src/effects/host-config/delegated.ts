import { fragmentFormat, type FragmentFormat } from '../../core/host-config/registry';
import { HostConfigError, type FileFormat, type FragmentRecord } from '../../core/host-config/types';

/**
 * The `delegated` strategy (#2852): another tool's installer writes a host
 * file, and rh records only the fragments that it declared and saw that
 * call create. Every rule here works on the text before and after the call;
 * the gate reads the files and writes the ledger.
 */

/**
 * The installers whose write sets were measured, at the measured versions
 * (discovery 6914365319 on #2852, macOS arm64). rh pins the Skills CLI to its
 * version; the user's Pi binary is not pinned, so another Pi version gets a
 * report line and the same before/after proof.
 */
export const MEASURED_INSTALLERS = { pi: '1.5.2', skills: '1.9.0' } as const;

/** What the measurement did not cover: rh claims nothing there and names these ranges in its reports. */
export const UNVERIFIED_INSTALLER_RANGES: readonly string[] = [
  'Windows and Linux',
  'installer versions other than the measured ones',
  'the Skills CLI lock path without XDG_STATE_HOME',
  'CLAUDE_CONFIG_DIR and CODEX_HOME overrides',
  'catalog providers other than Waza and Mermaid',
  'files that an installer reads',
];

/** A host file that an out-of-process installer may edit at the declared selectors, for `owner`. */
export interface HostConfigFragmentDeclaration {
  readonly path: string;
  readonly owner: string;
  readonly selectors: readonly string[];
}

/** A watched file that the call changed outside its declared fragments: no record claims the change, and a revert never touches it. */
export interface HostConfigUnattributedDiff {
  readonly code: 'host_config_unattributed_diff';
  readonly path: string;
  /** The file after the call; null when the call removed it. */
  readonly sha256: string | null;
}

/** The text at the selector, null when it is absent; undefined when the strategy cannot read the content. */
export function locatedText(format: FragmentFormat, content: string, selector: string): string | null | undefined {
  try {
    const range = format.strategy.locate(content, selector);
    return range ? content.slice(range.start, range.end) : null;
  } catch (error) {
    if (error instanceof HostConfigError) return undefined;
    throw error;
  }
}

function formatOf(fileFormat: FileFormat | undefined, selector: string, path: string): FragmentFormat {
  const format = fragmentFormat(fileFormat, selector);
  if (!format) throw new HostConfigError('host_config_invalid_state', `no strategy reads the declared selector ${selector}, so rh does not run the installer: ${path}`);
  return format;
}

/**
 * The declared selectors in the file before the call. A file that the
 * strategy cannot read stops the call before the installer runs: rh could
 * prove nothing after it.
 */
export function observeDeclaredFragments(path: string, fileFormat: FileFormat | undefined, content: string | null, selectors: readonly string[]): ReadonlyMap<string, string | null> {
  const before = new Map<string, string | null>();
  for (const selector of selectors) {
    const format = formatOf(fileFormat, selector, path);
    // A throw here (unparseable file, a repeated entry) stops the call.
    const range = content === null ? null : format.strategy.locate(content, selector);
    before.set(selector, range && content !== null ? content.slice(range.start, range.end) : null);
  }
  return before;
}

export interface DelegatedFragmentInput {
  readonly path: string;
  readonly owner: string;
  readonly fileFormat: FileFormat | undefined;
  readonly before: string | null;
  readonly after: string | null;
  /** The declared selectors as `observeDeclaredFragments` read them before the call. */
  readonly observed: ReadonlyMap<string, string | null>;
  /** Every fragment record of the file before the call. */
  readonly recorded: readonly FragmentRecord[];
}

export interface DelegatedFragmentOutcome {
  /** Every fragment record of the file after the call. */
  readonly fragments: readonly FragmentRecord[];
  /** True when the call changed the file outside its declared fragments. */
  readonly unattributed: boolean;
}

/**
 * The records after the call, per declared selector:
 * - absent before, present after: an `add` record of the exact text, with the container that the insert created;
 * - recorded for the owner and intact before, present after: the record follows the new text (a refresh);
 * - recorded for the owner and intact before, absent after: the record goes (the tool's remove command);
 * - recorded for the owner and absent before and after: the record goes;
 * - present before with no intact record of the owner: never claimed, the record stays as it is.
 * Then the declared fragments come out of both texts by the same strategy; a
 * remainder that differs is an unattributed change. A file that did not exist
 * before must be left as an empty document. A formatting change counts too:
 * the report is conservative and grants no removal.
 */
export function settleDelegatedFragments(input: DelegatedFragmentInput): DelegatedFragmentOutcome {
  const { path, owner, fileFormat, before, after, observed, recorded } = input;
  const replaced = new Map<FragmentRecord, FragmentRecord | null>();
  const added: FragmentRecord[] = [];
  let unreadable = false;
  for (const [selector, prior] of observed) {
    const format = formatOf(fileFormat, selector, path);
    const now = after === null ? null : locatedText(format, after, selector);
    if (now === undefined) { unreadable = true; continue; }
    const record = recorded.find((entry) => entry.selector === selector);
    if (record) {
      if (record.owner !== owner) continue;
      // A record of a fragment that is in the file neither before nor after proves nothing: it goes.
      if (prior === null && now === null) { replaced.set(record, null); continue; }
      if (record.inserted === '' || prior !== record.inserted || now === record.inserted) continue;
      replaced.set(record, now === null ? null : { ...record, inserted: now });
    } else if (prior === null && now !== null) {
      const created = format.strategy.created?.(before ?? '', selector) ?? null;
      added.push({ file: path, owner, selector, kind: 'add', inserted: now, ...(created ? { created } : {}) });
    }
  }
  const fragments = [
    ...recorded.flatMap((entry) => { const next = replaced.get(entry); return next === undefined ? [entry] : next === null ? [] : [next]; }),
    ...added,
  ];
  if (unreadable) return { fragments, unattributed: true };
  const selectors = [...observed.keys()];
  const restBefore = before === null ? null : remainder(fileFormat, before, selectors, recorded);
  const restAfter = after === null ? null : remainder(fileFormat, after, selectors, fragments);
  const unattributed = restBefore === null
    ? restAfter !== null && !selectors.some((selector) => formatOf(fileFormat, selector, path).empty(restAfter))
    : restAfter !== restBefore;
  return { fragments, unattributed };
}

/** The text with every declared fragment taken out; `records` may prove a container that an insert created. */
function remainder(fileFormat: FileFormat | undefined, content: string, selectors: readonly string[], records: readonly FragmentRecord[]): string {
  for (const selector of selectors) {
    const format = fragmentFormat(fileFormat, selector)!;
    if (!format.strategy.locate(content, selector)) continue;
    const edit = format.remove(content, selector, records);
    content = content.slice(0, edit.at) + edit.inserted + content.slice(edit.at + edit.removed.length);
  }
  return content;
}
