/**
 * LedgerEnforcement: checks tasks/lessons.md of the candidate tree, and its change since the
 * merge-base with a base ref, against the Lessons Retro contract
 * (docs/reference-configs/agentic-development-flow.md). It reads the entries through the one ledger
 * parser, `scripts/maintenance-triage.sh --entries`, and fails each lesson line that the parser
 * does not put into an entry. It does not read the ledger history: the merge-base is the only
 * earlier state.
 *
 * Usage: bun scripts/check-ledger-enforcement.ts --base <git-ref>
 * Exit 0: pass, human review or skipped. Exit 1: violation. Exit 2: error. An error is never a pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES } from '../src/core/ci/rules';

export const LEDGER_PATH = 'tasks/lessons.md';

const REQUIRED_FIELDS = ['Date', 'Name', 'Mistake pattern', 'Prevention rule', 'Enforced by', 'Missed by', 'Why', 'Triggered by correction', 'Seen'];
const FIELDS = [...REQUIRED_FIELDS, 'Promoted'];
const MISSED_BY = ['self-verify', 'ci', 'independent-review', 'human', 'none', 'unknown'];
const SEEN = /^([1-9][0-9]*)×$/;
const PROMOTED = /^(#[1-9][0-9]*|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/[1-9][0-9]*)$/;
const RULE_ID = /^[A-Z][A-Za-z0-9]*$/;

/** One parser entry: `line` is the Date line, `owned` every line that the entry holds. */
export type LedgerEntry = { readonly line: number; readonly fields: Readonly<Record<string, string>>; readonly owned: readonly number[] };
export type Finding = { readonly entry: string; readonly field: string; readonly problem: string; readonly fix: string };
export type LedgerReport = { readonly findings: Finding[]; readonly review: string[]; readonly carried: string[] };

type Theme = { readonly entries: LedgerEntry[]; readonly latest: LedgerEntry; readonly max: number; readonly promoted: boolean };

const field = (entry: LedgerEntry, name: string): string => entry.fields[name]?.trim() ?? '';
const seen = (entry: LedgerEntry): number | null => {
  const match = SEEN.exec(field(entry, 'Seen'));
  return match ? Number(match[1]) : null;
};
const key = (entry: LedgerEntry): string => `${field(entry, 'Mistake pattern')}\n${field(entry, 'Date')}`;
const label = (entry: LedgerEntry, base = false): string =>
  `${base ? 'base ' : ''}${LEDGER_PATH}:${entry.line} ${field(entry, 'Mistake pattern') || '<no Mistake pattern>'} (${field(entry, 'Date') || 'no Date'})`;
// The same reference normalization as maintenance triage: case, a leading '#', and a short SHA.
const normalize = (ref: string): string => {
  const value = ref.toLowerCase().replace(/^[\s#]+|\s+$/g, '');
  return /^[0-9a-f]{8,40}$/.test(value) ? value.slice(0, 8) : value;
};
const references = (entry: LedgerEntry): string[] => field(entry, 'Triggered by correction').split(',')
  .map((ref) => ref.trim()).filter(Boolean);
const referenceSet = (entries: readonly LedgerEntry[]): Set<string> => new Set(entries.flatMap(references).map(normalize));
/** A structural enforcer is a path or a rule id; `judgment` and an empty value are not. */
const structural = (entry: LedgerEntry): boolean => !['', 'judgment'].includes(field(entry, 'Enforced by'));
/** The state that row 4 fails: Seen 3× or more, no structural enforcer, no Promoted. */
const judged = (theme: Theme): boolean => theme.max >= 3 && !structural(theme.latest) && !theme.promoted;

/** Groups the entries with a theme and a valid Seen by theme, in ledger order. */
function themes(entries: readonly LedgerEntry[]): Map<string, Theme> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const theme = field(entry, 'Mistake pattern');
    if (theme && seen(entry) !== null) groups.set(theme, [...groups.get(theme) ?? [], entry]);
  }
  return new Map([...groups].map(([theme, group]) => {
    const latest = group.reduce((top, entry) => seen(entry)! >= seen(top)! ? entry : top);
    return [theme, { entries: group, latest, max: seen(latest)!, promoted: group.some((entry) => field(entry, 'Promoted') !== '') }];
  }));
}

/**
 * Applies the decision table to the head ledger and to its change against the base entries.
 * `text` is the head ledger text and `head` its parser entries. `base` is null when the merge-base
 * has no ledger. `resolves` tells whether a repository path is a file of the candidate tree.
 */
export function evaluateLedger(text: string, head: readonly LedgerEntry[], base: readonly LedgerEntry[] | null, resolves: (path: string) => boolean): LedgerReport {
  const findings: Finding[] = [];
  const review: string[] = [];
  const carried: string[] = [];
  const add = (entry: LedgerEntry, name: string, problem: string, fix: string, inBase = false) =>
    findings.push({ entry: label(entry, inBase), field: name, problem, fix });

  // Row 1, parser completeness: each non-blank line must be owned by one parsed entry. Before the
  // first entry, only headings and the `reviewed-through:` watermark may stand alone. A lesson
  // without a Date, another bullet style, a repeated field that the parser skips, or any other text
  // belongs to no entry, so no other row would see it.
  const owned = new Set(head.flatMap((entry) => entry.owned));
  const first = head[0]?.line ?? Infinity;
  for (const [index, line] of text.split('\n').entries()) {
    const number = index + 1;
    if (!line.trim() || owned.has(number) || (number < first && /^(#{1,6} |reviewed-through: )/.test(line))) continue;
    findings.push({
      entry: `${LEDGER_PATH}:${number}`, field: /^[-*+]? ?([A-Z][A-Za-z ]*):/.exec(line)?.[1] ?? 'line',
      problem: `"${line.slice(0, 80)}" belongs to no entry`,
      fix: 'start each lesson with "- Date: <YYYY-MM-DD>" and write each field once as "- <Field>: <value>"',
    });
  }

  // Row 1: required and known fields, the Missed by enum, the Seen count and the Promoted format.
  // Row 3: an Enforced by path or rule id that does not exist. Row 6: one that exists needs human review.
  for (const entry of head) {
    for (const name of REQUIRED_FIELDS) {
      if (!field(entry, name)) add(entry, name, 'is missing or empty', `add "- ${name}: <value>" as the Lessons Retro template states`);
    }
    for (const name of Object.keys(entry.fields).filter((name) => !FIELDS.includes(name))) {
      add(entry, name, 'is not a Lessons Retro field', `remove it, or use one of ${FIELDS.join(', ')}`);
    }
    const missedBy = field(entry, 'Missed by');
    if (missedBy && !MISSED_BY.includes(missedBy)) add(entry, 'Missed by', `"${missedBy}" is not a valid value`, `write one of ${MISSED_BY.join(', ')}`);
    const count = field(entry, 'Seen');
    if (count && seen(entry) === null) add(entry, 'Seen', `"${count}" is not a positive integer count`, 'write the cumulative event count of the theme as <N>×');
    const promoted = field(entry, 'Promoted');
    if (promoted && !PROMOTED.test(promoted)) add(entry, 'Promoted', `"${promoted}" is not a PR reference`, 'write "- Promoted: #<PR>" or the pull request URL');
    const enforcer = field(entry, 'Enforced by');
    if (!structural(entry)) continue;
    if (resolves(enforcer)) {
      review.push(`${label(entry)}: Enforced by ${enforcer} exists`);
    } else if (!RULE_ID.test(enforcer)) {
      add(entry, 'Enforced by', `${enforcer} is not a file of the candidate tree`, 'name the repository file that fails when the mistake comes back, or write judgment');
    } else if (Object.hasOwn(RULES, enforcer)) {
      review.push(`${label(entry)}: Enforced by rule ${enforcer} exists`);
    } else {
      add(entry, 'Enforced by', `${enforcer} is neither a file of the candidate tree nor a rule id in src/core/ci/rules.ts`,
        `name a registered rule id (${Object.keys(RULES).join(', ')}), a repository file, or write judgment`);
    }
  }

  // Row 2 on the candidate tree: one entry per theme and day, and a cumulative Seen. References
  // bound events from above: one event names at least one new reference, and it can name several
  // (an issue and its fix PR). So an entry's Seen increase over the earlier entry of its theme is
  // at least 1 and at most the references that the earlier entries do not name. A first entry's
  // Seen is at most its own references. An undercount passes: a reference set cannot count events.
  const headKeys = new Map<string, LedgerEntry>();
  for (const entry of head) {
    const earlier = headKeys.get(key(entry));
    if (earlier && field(entry, 'Mistake pattern') && field(entry, 'Date')) {
      add(entry, 'Date', `line ${earlier.line} has an entry of this theme on the same day`, 'merge the two entries into one entry for that day');
    } else headKeys.set(key(entry), entry);
  }
  const headThemes = themes(head);
  for (const { entries } of headThemes.values()) {
    for (const [index, entry] of entries.entries()) {
      const before = entries[index - 1];
      const known = referenceSet(entries.slice(0, index));
      const fresh = new Set(references(entry).map(normalize).filter((ref) => !known.has(ref))).size;
      const increase = seen(entry)! - (before ? seen(before)! : 0);
      if (before && increase < 1) {
        add(entry, 'Seen', `${seen(entry)}× does not exceed ${seen(before)}× of the earlier entry at line ${before.line}`,
          'Seen is cumulative: add the new correction events to the last valid Seen value of the theme');
      } else if (increase > fresh) {
        add(entry, 'Seen', `${seen(entry)}× adds ${increase} events, but the entry names ${fresh} references that the earlier entries of the theme do not name`,
          'each new correction event names at least one new reference in Triggered by correction; lower Seen or name the corrections');
      }
    }
  }

  // A head theme corresponds to the merge-base theme with the same Mistake pattern. A new head theme
  // corresponds to each merge-base theme that the head no longer has and that shares one of its
  // Triggered by correction references: a rename or a reclassification keeps the references. A
  // reference that several kept themes share (a consolidation PR) links no theme.
  const baseThemes = base === null ? new Map<string, Theme>() : themes(base);
  const partners = (theme: string, state: Theme): Theme[] => {
    const same = baseThemes.get(theme);
    if (same) return [same];
    const refs = referenceSet(state.entries);
    return [...baseThemes].filter(([name, other]) => !headThemes.has(name) && [...referenceSet(other.entries)].some((ref) => refs.has(ref)))
      .map(([, other]) => other);
  };
  if (base !== null) {
    for (const [theme, after] of headThemes) {
      const sources = partners(theme, after);
      if (sources.length === 0) continue;
      const floor = Math.max(...sources.map((source) => source.max));
      const ceiling = sources.reduce((sum, source) => sum + source.max, 0);
      const baseRefs = referenceSet(sources.flatMap((source) => source.entries));
      const fresh = [...referenceSet(after.entries)].filter((ref) => !baseRefs.has(ref));
      if (after.max < floor) {
        add(after.latest, 'Seen', `the theme maximum fell from ${floor}× to ${after.max}×`, `the maximum of a theme never falls; write ${floor}×`);
        continue;
      }
      if (after.max > ceiling + fresh.length) {
        add(after.latest, 'Seen', `${after.max}× exceeds the merge-base maximum ${ceiling}× plus ${fresh.length} new references`,
          'each new correction event names at least one new reference in Triggered by correction; lower Seen or name the corrections');
      }
      const [source] = sources;
      if (sources.length !== 1) continue;
      // A consolidation (fewer entries than the corresponding base theme) keeps the base maximum and
      // adds at most the consolidating reference, so a new event goes to its own PR.
      if (after.entries.length < source.entries.length) {
        if (after.max !== source.max || fresh.length > 1) {
          add(after.latest, 'Seen', `a consolidation of ${source.entries.length} entries into ${after.entries.length} gives ${after.max}× with ${fresh.length} new references`,
            `a consolidation keeps the maximum ${source.max}× and adds only the consolidating PR to Triggered by correction; record a new correction event in its own PR`);
        }
        continue;
      }
      // Otherwise an older entry (same Date in the corresponding theme) keeps its Seen.
      for (const entry of source.entries) {
        const now = after.entries.find((candidate) => field(candidate, 'Date') === field(entry, 'Date'));
        if (now && seen(now) !== seen(entry)) {
          add(now, 'Seen', `changed from ${seen(entry)}× to ${seen(now)}× on an existing entry`, `restore ${seen(entry)}×; do not edit Seen on older entries`);
        }
      }
    }
    // Row 5: a merge keeps every Triggered by correction reference of the entries it replaces.
    const kept = referenceSet(head);
    for (const entry of base) {
      const lost = references(entry).filter((ref) => !kept.has(normalize(ref)));
      if (lost.length) {
        add(entry, 'Triggered by correction', `${lost.join(', ')} is no longer in the ledger`,
          'keep every reference of the entries that a merge replaces, and add the consolidating PR beside them', true);
      }
    }
  }

  // Row 4: Seen 3× or more with Enforced by: judgment needs Promoted. A state that the corresponding
  // merge-base theme already has (same maximum, no structural enforcer, no Promoted) is carried: this
  // change did not make it, and maintenance triage lists it. A rename keeps it carried; any other
  // change to that state must promote the rule.
  for (const [theme, state] of headThemes) {
    if (state.max < 3 || field(state.latest, 'Enforced by') !== 'judgment' || state.promoted) continue;
    const sources = partners(theme, state);
    if (sources.length > 0 && sources.every(judged) && sources.some((source) => source.max === state.max)) {
      carried.push(`${label(state.latest)}: Seen ${state.max}× with Enforced by: judgment and no Promoted`);
    } else {
      add(state.latest, 'Promoted', `Seen ${state.max}× with Enforced by: judgment has no Promoted`,
        'promote the prevention rule into root AGENTS.md and root CLAUDE.md in this PR and add "- Promoted: #<PR>", or name the enforcing file in Enforced by');
    }
  }
  return { findings, review, carried };
}

function run(command: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: string[]): string {
  const result = run('git', args);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout;
}

/** Parses one ledger text with the triage parser and checks the shape of its output. */
function parseLedger(text: string): LedgerEntry[] {
  const directory = mkdtempSync(join(tmpdir(), 'ledger-enforcement-'));
  try {
    const file = join(directory, 'lessons.md');
    writeFileSync(file, text);
    const result = run('bash', [join(import.meta.dir, 'maintenance-triage.sh'), '--entries', file]);
    if (result.status !== 0) throw new Error(`the ledger parser failed: ${result.stderr.trim()}`);
    const entries: unknown = JSON.parse(result.stdout);
    const record = (value: unknown, type: string) => value !== null && typeof value === 'object' && Object.values(value).every((item) => typeof item === type);
    if (!Array.isArray(entries) || !entries.every((entry) => Number.isInteger(entry?.line) && record(entry.fields, 'string')
      && Array.isArray(entry.owned) && entry.owned.every(Number.isInteger))) {
      throw new Error('the ledger parser output is not a list of {line, fields, owned}');
    }
    return entries as LedgerEntry[];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function main(args: string[]): number {
  if (args.length !== 2 || args[0] !== '--base' || !args[1] || args[1].startsWith('-')) {
    console.error('Usage: bun scripts/check-ledger-enforcement.ts --base <git-ref>');
    return 2;
  }
  const root = git(['rev-parse', '--show-toplevel']).trim();
  process.chdir(root);
  // The change of this PR starts at the merge-base, so a base commit made after the branch cut
  // does not count as part of it.
  const ref = git(['rev-parse', '--verify', `${args[1]}^{commit}`]).trim();
  const baseSha = git(['merge-base', ref, 'HEAD']).trim();
  const inBase = git(['ls-tree', '--name-only', baseSha, '--', LEDGER_PATH]).trim() === LEDGER_PATH;
  const inHead = existsSync(LEDGER_PATH);
  const where = `merge-base ${baseSha.slice(0, 12)}`;
  if (!inHead && !inBase) {
    console.log(`[ledger] LedgerEnforcement: skipped. Neither the candidate tree nor ${where} has ${LEDGER_PATH}.`);
    return 0;
  }
  if (!inHead) {
    console.log(`[ledger] LedgerEnforcement: violation. ${LEDGER_PATH} is the one lessons ledger and this change removes it. Fix: restore ${LEDGER_PATH}.`);
    return 1;
  }
  const text = readFileSync(LEDGER_PATH, 'utf8');
  const head = parseLedger(text);
  const base = inBase ? parseLedger(git(['show', `${baseSha}:${LEDGER_PATH}`])) : null;
  const files = new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean));
  const report = evaluateLedger(text, head, base, (path) => files.has(path) && existsSync(path));
  const state = report.findings.length ? 'violation' : report.review.length ? 'human review' : 'pass';
  console.log(`[ledger] LedgerEnforcement: ${state}. ${head.length} entries, ${report.findings.length} findings, against ${where}.`);
  for (const finding of report.findings) console.log(`[ledger] ${finding.entry}: ${finding.field} ${finding.problem}. Fix: ${finding.fix}.`);
  for (const line of report.carried) console.log(`[ledger] Carried from the base, not changed here: ${line}. rh run maintenance-triage lists it.`);
  for (const line of report.review) console.log(`[ledger] Human review: ${line}. This check does not prove that it covers the whole mistake class.`);
  if (report.findings.length) console.log(`[ledger] ${RULES.LedgerEnforcement.repair}`);
  return report.findings.length ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.log(`[ledger] LedgerEnforcement: error. ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
