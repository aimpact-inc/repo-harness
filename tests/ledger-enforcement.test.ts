import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, initGitRepo, run, withTempRepo } from './helpers/repo-fixture';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-ledger-enforcement.ts');

const DEFAULTS: Record<string, string> = {
  Date: '2026-10-01',
  Name: 'Keep evidence',
  'Mistake pattern': 'theme-a',
  'Prevention rule': 'Keep the failure evidence.',
  'Enforced by': 'judgment',
  'Missed by': 'unknown',
  Why: 'The old entries do not name the missed layer.',
  'Triggered by correction': '#10',
  Seen: '1×',
};

/** One ledger entry in the Lessons Retro field order; null removes a field. */
function entry(fields: Record<string, string | null> = {}): string {
  const merged: Record<string, string | null> = { ...DEFAULTS, ...fields };
  return Object.entries(merged).filter(([, value]) => value !== null).map(([name, value]) => `- ${name}: ${value}`).join('\n');
}

const ledger = (...entries: string[]) => `# Lessons\n\nreviewed-through: ${'a'.repeat(40)}\n\n${entries.join('\n\n')}\n`;

type Case = { name: string; base: string | null; head: string | null; files?: Record<string, string>; ref?: string; status: number; output: string[] };

function check({ base, head, files = {}, ref = 'HEAD' }: Case) {
  let result!: ReturnType<typeof run>;
  withTempRepo('ledger-enforcement-', (repo) => {
    initGitRepo(repo);
    mkdirSync(join(repo, 'tasks'));
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    if (base !== null) writeFileSync(join(repo, 'tasks', 'lessons.md'), base);
    commitAll(repo, 'base');
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    if (head === null) rmSync(join(repo, 'tasks', 'lessons.md'), { force: true });
    else writeFileSync(join(repo, 'tasks', 'lessons.md'), head);
    result = run('bun', [SCRIPT, '--base', ref], repo);
  });
  return result;
}

const valid = ledger(entry());
const series = ledger(entry({ 'Triggered by correction': '#10' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '2×' }));
const judged = ledger(entry({ Seen: '3×' }));

const cases: Case[] = [
  // Row 1: a required field, the Missed by enum and the Seen count.
  { name: 'a complete entry passes', base: null, head: valid, status: 0, output: ['LedgerEnforcement: pass. 1 entries, 0 findings'] },
  { name: 'a missing required field fails', base: null, head: ledger(entry({ Name: null })), status: 1, output: ['(2026-10-01): Name is missing or empty. Fix: add "- Name: <value>"'] },
  { name: 'an invalid Missed by value fails', base: null, head: ledger(entry({ 'Missed by': 'reviewer' })), status: 1, output: ['Missed by "reviewer" is not a valid value. Fix: write one of self-verify, ci, independent-review, human, none, unknown'] },
  { name: 'a Seen that is not a positive integer fails', base: null, head: ledger(entry({ Seen: '0×' })), status: 1, output: ['Seen "0×" is not a positive integer count'] },
  { name: 'a Promoted that is not a PR reference fails', base: null, head: ledger(entry({ Seen: '3×', Promoted: 'yes' })), status: 1, output: ['Promoted "yes" is not a PR reference'] },
  // Row 2: the cumulative count of a theme.
  { name: 'a cumulative series passes', base: null, head: series, status: 0, output: ['LedgerEnforcement: pass. 2 entries'] },
  { name: 'a repeat that does not raise Seen fails', base: null, head: ledger(entry(), entry({ Date: '2026-10-02', 'Triggered by correction': '#11' })), status: 1, output: ['(2026-10-02): Seen 1× does not exceed 1× of the earlier entry'] },
  { name: 'two entries of a theme on one day fail', base: null, head: ledger(entry(), entry({ 'Triggered by correction': '#11', Seen: '2×' })), status: 1, output: ['Date line 5 has an entry of this theme on the same day'] },
  { name: 'an edited Seen on an older entry fails', base: valid, head: ledger(entry({ Seen: '2×' })), status: 1, output: ['Seen changed from 1× to 2× on an existing entry. Fix: restore 1×'] },
  { name: 'a merge that keeps the maximum and the references passes', base: series, head: ledger(entry({ 'Triggered by correction': '#10, #11, #20', Seen: '2×' })), status: 0, output: ['LedgerEnforcement: pass. 1 entries'] },
  { name: 'a merge that adds the Seen values fails', base: series, head: ledger(entry({ 'Triggered by correction': '#10, #11, #20', Seen: '3×' })), status: 1, output: ['Seen 3× exceeds the maximum 2× of the entries that this change merges'] },
  { name: 'a merge that lowers the maximum fails', base: series, head: ledger(entry({ 'Triggered by correction': '#10, #11, #20' })), status: 1, output: ['Seen the theme maximum fell from 2× to 1×'] },
  // Row 3: the Enforced by reference exists. Row 6: an existing reference stops at human review.
  { name: 'a missing Enforced by path fails', base: null, head: ledger(entry({ 'Enforced by': 'tests/guard.test.ts' })), status: 1, output: ['Enforced by tests/guard.test.ts is not a file of the candidate tree'] },
  { name: 'an unknown Enforced by rule id fails', base: null, head: ledger(entry({ 'Enforced by': 'NoSuchRule' })), status: 1, output: ['Enforced by rule id NoSuchRule is not in src/core/ci/rules.ts'] },
  {
    name: 'an existing path and rule id stop at human review',
    base: null,
    head: ledger(entry({ 'Enforced by': 'tests/guard.test.ts' }), entry({ 'Mistake pattern': 'theme-b', 'Enforced by': 'TestBudget' })),
    files: { 'tests/guard.test.ts': 'export {};\n' },
    status: 0,
    output: ['LedgerEnforcement: human review. 2 entries, 0 findings', 'Human review: tasks/lessons.md:5 theme-a (2026-10-01): Enforced by tests/guard.test.ts exists. This check does not prove', 'Enforced by rule TestBudget exists'],
  },
  // Row 4: Seen 3× or more with judgment needs Promoted; a state that the base already has is carried.
  { name: 'Seen 3× with judgment and no Promoted fails', base: null, head: judged, status: 1, output: ['Promoted Seen 3× with Enforced by: judgment has no Promoted. Fix: promote the prevention rule'] },
  { name: 'Seen 3× with judgment and Promoted passes', base: null, head: ledger(entry({ Seen: '3×', Promoted: '#30' })), status: 0, output: ['LedgerEnforcement: pass'] },
  { name: 'an unchanged judgment theme from the base is carried', base: judged, head: judged, status: 0, output: ['LedgerEnforcement: pass', 'Carried from the base, not changed here: tasks/lessons.md:5 theme-a (2026-10-01): Seen 3×'] },
  { name: 'a new event on a carried theme fails', base: judged, head: ledger(entry({ Seen: '3×' }), entry({ Date: '2026-10-02', 'Triggered by correction': '#11', Seen: '4×' })), status: 1, output: ['(2026-10-02): Promoted Seen 4× with Enforced by: judgment has no Promoted'] },
  // Row 5: a merge keeps every original correction reference.
  { name: 'a merge that keeps only the consolidation reference fails', base: series, head: ledger(entry({ 'Triggered by correction': '#20', Seen: '2×' })), status: 1, output: ['base tasks/lessons.md:5 theme-a (2026-10-01): Triggered by correction #10 is no longer in the ledger', 'base tasks/lessons.md:15 theme-a (2026-10-02): Triggered by correction #11 is no longer in the ledger'] },
  // The ledger file and the base commit.
  { name: 'a removed ledger fails', base: valid, head: null, status: 1, output: ['LedgerEnforcement: violation. tasks/lessons.md is the one lessons ledger and this change removes it'] },
  { name: 'no ledger on either side is skipped', base: null, head: null, status: 0, output: ['LedgerEnforcement: skipped'] },
  { name: 'an unreadable base is an error, not a pass', base: valid, head: valid, ref: 'no-such-ref', status: 2, output: ['LedgerEnforcement: error. git rev-parse --verify no-such-ref^{commit} failed'] },
];

describe('LedgerEnforcement decision table', () => {
  for (const item of cases) {
    test(item.name, () => {
      const result = check(item);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: item.status, stderr: '' });
      for (const text of item.output) expect(result.stdout).toContain(text);
    });
  }
});
