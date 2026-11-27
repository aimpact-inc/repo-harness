/**
 * The board CLI failures; the operator routes add their registry, capacity,
 * timeout and decode codes. `advisor_send_unconfirmed`: `hc send` ran or may
 * have run and did not confirm, so the text may have reached the seat.
 */
export const ADVISOR_SEAT_CLI_FAILURES = ['text_invalid', 'hc_unavailable', 'advisor_seat_absent', 'advisor_seat_ambiguous', 'advisor_send_unconfirmed', 'advisor_read_failed'] as const;
export type AdvisorSeatCliFailure = typeof ADVISOR_SEAT_CLI_FAILURES[number];

/**
 * Every refusal code of the operator advisor routes. The boss command route
 * adds `boss_cooldown`, `advisor_turn_running` and `advisor_turn_unknown`;
 * each stops before a send.
 */
export const ADVISOR_SEAT_FAILURES = [
  ...ADVISOR_SEAT_CLI_FAILURES,
  'repository_read_only', 'registry_unavailable', 'repository_not_found', 'github_unavailable',
  'advisor_busy', 'advisor_timeout', 'advisor_unavailable', 'advisor_invalid', 'invalid_request',
  'boss_cooldown', 'advisor_turn_running', 'advisor_turn_unknown',
] as const;
export type AdvisorSeatFailure = typeof ADVISOR_SEAT_FAILURES[number];

/**
 * The send failures that prove the text was not sent: each one stops before
 * `hc send` runs. Any other failure of a send leaves delivery unknown.
 */
export const ADVISOR_SEAT_NOT_SENT: ReadonlySet<AdvisorSeatFailure> = new Set<AdvisorSeatFailure>([
  'text_invalid', 'hc_unavailable', 'advisor_seat_absent', 'advisor_seat_ambiguous',
  'repository_read_only', 'repository_not_found', 'registry_unavailable', 'github_unavailable', 'advisor_busy',
  'boss_cooldown', 'advisor_turn_running', 'advisor_turn_unknown',
]);
