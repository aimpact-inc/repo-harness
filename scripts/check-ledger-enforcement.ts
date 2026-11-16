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

/** One parser entry: `line` is the Date line, `lines` the line that set each field. */
export type LedgerEntry = { readonly line: number; readonly fields: Readonly<Record<string, string>>; readonly lines: Readonly<Record<string, number>> };
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

  // Row 1, parser completeness: each lesson line ("- " at the line start) must be the Date line or
  // the field line of one entry. A line before the first Date, in a lesson without a Date, or a
  // repeated field that the parser skips belongs to no entry, so no other row would see it.
  const held = new Set(head.flatMap((entry) => [entry.line, ...Object.values(entry.lines)]));
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.startsWith('- ') || held.has(index + 1)) continue;
    findings.push({
      entry: `${LEDGER_PATH}:${index + 1}`, field: /^- ([A-Z][A-Za-z ]*):/.exec(line)?.[1] ?? 'line',
      problem: `"${line.slice(0, 80)}" belongs to no entry`,
      fix: 'start each lesson with "- Date: <YYYY-MM-DD>", write each field once in an entry, and write no other "- " line',
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

  // Row 2 on the candidate tree: one entry per theme and day, and a cumulative Seen.
  const headKeys = new Map<string, LedgerEntry>();
  for (const entry of head) {
    const first = headKeys.get(key(entry));
    if (first && field(entry, 'Mistake pattern') && field(entry, 'Date')) {
      add(entry, 'Date', `line ${first.line} has an entry of this theme on the same day`, 'merge the two entries into one entry for that day');
    } else headKeys.set(key(entry), entry);
  }
  const headThemes = themes(head);
  for (const { entries } of headThemes.values()) {
    for (const [index, entry] of entries.entries()) {
      const before = entries[index - 1];
      if (before && seen(entry)! <= seen(before)!) {
        add(entry, 'Seen', `${seen(entry)}× does not exceed ${seen(before)}× of the earlier entry at line ${before.line}`,
          'Seen is cumulative: add the new correction events to the last valid Seen value of the theme');
      }
    }
  }

  const baseThemes = base === null ? new Map<string, Theme>() : themes(base);
  if (base !== null) {
    const baseKeys = new Set(base.map(key));
    const baseRefs = referenceSet(base);
    for (const [theme, after] of headThemes) {
      const before = baseThemes.get(theme);
      // A theme that loses an entry is merged: a merge of one cumulative series keeps the maximum,
      // does not add the values, and may keep the Date of an entry it replaces.
      const merged = before?.entries.some((entry) => !headKeys.has(key(entry))) ?? false;
      if (before) {
        for (const entry of merged ? [] : before.entries) {
          const now = headKeys.get(key(entry))!;
          if (seen(now) !== null && seen(now) !== seen(entry)) {
            add(now, 'Seen', `changed from ${seen(entry)}× to ${seen(now)}× on an existing entry`, `restore ${seen(entry)}×; do not edit Seen on older entries`);
          }
        }
        if (after.max < before.max) {
          add(after.latest, 'Seen', `the theme maximum fell from ${before.max}× to ${after.max}×`, `a merge keeps the maximum Seen value; write ${before.max}×`);
        } else if (merged && after.max > before.max) {
          add(after.latest, 'Seen', `${after.max}× exceeds the maximum ${before.max}× of the entries that this change merges`,
            `a merge of one cumulative series keeps the maximum: write ${before.max}×, and record a new correction event in its own entry`);
        }
      }
      if (merged) continue;
      // Each new entry is one new correction event: its Seen is the earlier entry of the theme plus 1,
      // and it names a correction that the merge-base ledger does not have. A new theme that takes
      // no base reference starts at 1×; one that takes base references is a reclassification, and
      // a person sets its Seen.
      const reclassified = !before && after.entries.some((entry) => references(entry).some((ref) => baseRefs.has(normalize(ref))));
      for (const [index, entry] of after.entries.entries()) {
        if (baseKeys.has(key(entry))) continue;
        const earlier = after.entries[index - 1];
        if (earlier) {
          if (seen(entry) !== seen(earlier)! + 1) {
            add(entry, 'Seen', `${seen(entry)}× is not ${seen(earlier)! + 1}×, the earlier entry plus one new event`,
              `a new correction event adds 1 to the last valid Seen value: write ${seen(earlier)! + 1}×`);
          }
          const known = referenceSet([...base, ...after.entries.slice(0, index)]);
          if (!references(entry).some((ref) => !known.has(normalize(ref)))) {
            add(entry, 'Triggered by correction', 'names no new correction', 'name the commit, PR or issue of the new correction event; a format or enforcement change adds no entry');
          }
        } else if (!before && !reclassified && seen(entry) !== 1) {
          add(entry, 'Seen', `${seen(entry)}× starts a new theme`, 'a new theme starts at 1×');
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

  // Row 4: Seen 3× or more with Enforced by: judgment needs Promoted. A theme state that the base
  // already has (same maximum, no structural enforcer, no Promoted) is carried: this change did not
  // make it, and maintenance triage lists it. Any change to that state must promote the rule.
  for (const [theme, state] of headThemes) {
    if (state.max < 3 || field(state.latest, 'Enforced by') !== 'judgment' || state.promoted) continue;
    const before = baseThemes.get(theme);
    if (before && before.max === state.max && judged(before)) {
      carried.push(`${label(state.latest)}: Seen ${state.max}× with Enforced by: judgment and no Promoted`);
    } else {
      add(state.latest, 'Promoted', `Seen ${state.max}× with Enforced by: judgment has no Promoted`,
        'promote the prevention rule into root AGENTS.md and root CLAUDE.md in this PR and add "- Promoted: #<PR>", or name the enforcing file in Enforced by');
    }
  }
  // Row 4 from the base side: a judged base theme whose key the head no longer has (a rename or a
  // delete) is settled only by a Promoted or a structural enforcer on a head entry that takes one
  // of its references.
  const headPatterns = new Set(head.map((entry) => field(entry, 'Mistake pattern')));
  for (const [theme, before] of baseThemes) {
    if (headPatterns.has(theme) || !judged(before)) continue;
    const refs = referenceSet(before.entries);
    const settled = head.some((entry) => references(entry).some((ref) => refs.has(normalize(ref)))
      && (field(entry, 'Promoted') !== '' || structural(entry)));
    if (!settled) {
      add(before.latest, 'Mistake pattern', `the theme at Seen ${before.max}× with Enforced by: judgment and no Promoted is no longer in the ledger`,
        'keep the Mistake pattern text, or add "- Promoted: #<PR>" or the enforcing file to the entry that takes its references', true);
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
    if (!Array.isArray(entries) || !entries.every((entry) => Number.isInteger(entry?.line) && record(entry.fields, 'string') && record(entry.lines, 'number'))) {
      throw new Error('the ledger parser output is not a list of {line, fields, lines}');
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
