/**
 * The one rule that decides which finding severities block a merge (#2936).
 *
 * A review returns `FAIL` only for a P0 or a P1 finding. A P2 is a real
 * defect below the blocking bar. It stays in the review record and opens no
 * issue. A P3 is a note. The review publish receipt, the generic review result and
 * the acceptance receipt each derive a verdict or a blocking count from a
 * severity through this module, so the rule has one authority.
 *
 * The rating of a finding stays a reviewer duty: `REVIEW_SEVERITY_BAR` states
 * the owner-confirmed ordinary-use and I1/I2 rating rule (owner, 2026-11-21,
 * #2742). No code reads a severity to move a finding between those tiers.
 */
export type ReviewSeverity = 'P0' | 'P1' | 'P2' | 'P3';

/** Owner-confirmed rating rule injected into review prompts (owner, 2026-11-21). */
export const REVIEW_SEVERITY_BAR =
  'Fail the PR only for a defect that ordinary use or one accident reaches at this head. ' +
  'A P0 or a P1 needs a trigger: the command or input, in a default environment, that reaches the defect. ' +
  'A trigger can be several steps in order. ' +
  'Documented commands, options and settings are ordinary use. ' +
  'A process that ends normally and the state that earlier ordinary use left are also ordinary use. ' +
  'Untrusted input that the tool reads in ordinary use (repository content, PR and issue text, tool output) is ordinary use. ' +
  'A trigger that needs an undocumented override, hand-edited tool state, a second independent fault, or an adversary who already runs as the user (race, alias, shell trick) is not ordinary use, also on an I1 or I2 path. ' +
  'A client-side cache timing window, an unrequested defensive fallback and a duplicate JSON key are P3 notes. ' +
  'A real defect that has no such trigger, or that has a small effect and an easy recovery, is a P2. ' +
  'When the trigger leaks a credential (I1) or deletes or overwrites a user file without authorization (I2), rate the finding at least P1.';

/** The severities that a reviewer may not merge with. Sorted by severity. */
export const BLOCKING_SEVERITIES: readonly ReviewSeverity[] = Object.freeze(['P0', 'P1']);

/** True for a severity that blocks a merge: P0 or P1. */
export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return BLOCKING_SEVERITIES.includes(severity);
}
