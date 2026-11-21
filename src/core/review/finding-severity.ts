/**
 * The one rule that decides which finding severities block a merge (#2936).
 *
 * A review returns `FAIL` only for a P0 or a P1 finding. A P2 is a real
 * defect that is small, so it stays in the review record and opens no issue;
 * a P3 is a note. The review publish receipt, the generic review result and
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
  'Only a defect that ordinary use or an accident can reach is a P0 or a P1. ' +
  'Untrusted input that the tool reads in ordinary use (repository content, PR and issue text, tool output) is ordinary use. ' +
  'When such a defect touches I1 (a credential leak) or I2 (an unauthorized deletion or overwrite of a user file), rate it at least P1. ' +
  'A finding that needs an adversary who already runs as the user (race, alias, shell trick), a client-side cache timing window, an unrequested defensive fallback and a duplicate JSON key are P3 notes, also on an I1 or I2 path.';

/** The severities that a reviewer may not merge with. Sorted by severity. */
export const BLOCKING_SEVERITIES: readonly ReviewSeverity[] = Object.freeze(['P0', 'P1']);

/** True for a severity that blocks a merge: P0 or P1. */
export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return BLOCKING_SEVERITIES.includes(severity);
}
