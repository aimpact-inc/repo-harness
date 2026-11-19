# Lessons

reviewed-through: 06744d5ea5a7f8d90e46b1a57953a6be993d24c0

- Date: 2026-10-03
- Name: Verify live state
- Mistake pattern: verify-live-state-before-relying
- Prevention rule: Verify the live checkout, declared revision and real entrypoint before relying on an issue, snapshot or agent report.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: c27a36e8, 02da1f63, eb48d698, 1d1b702a, a24990b5, 395f61aa, e13bb3fd, 8134a2af, #231-#240, 6c19234e, 12ef448b, #483
- Seen: 11×

- Date: 2026-10-03
- Name: Trace trigger to effect
- Mistake pattern: trace-trigger-to-effect
- Prevention rule: Trace the observable trigger to its final effect before fixing a bug; confirm the root cause with a real failing case.
- Enforced by: judgment
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: 395f61aa, #483
- Seen: 1×

- Date: 2026-10-03
- Name: One authority per value
- Mistake pattern: one-authority-per-value
- Prevention rule: Keep one authority per value and import its existing parser/resolver; never create a second semantic interpretation.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: d810d9e3, #132, #209, c2e4997d, 9a19af4c, 4527bfa5, d52f9a9b, #483
- Seen: 7×

- Date: 2026-10-03
- Name: Doubles match wire format
- Mistake pattern: test-doubles-match-wire-format
- Prevention rule: Match test doubles to the producer's actual wire format and terminal events; missing or truncated proof fails closed.
- Enforced by: judgment
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: 9a19af4c, #483
- Seen: 1×

- Date: 2026-10-03
- Name: Validate every egress
- Mistake pattern: validate-every-egress
- Prevention rule: Validate externally serialized fields at every egress, including mutation acknowledgements, events and errors.
- Enforced by: judgment
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: 9a19af4c, #483
- Seen: 1×

- Date: 2026-10-03
- Name: Keep authority concepts distinct
- Mistake pattern: keep-authority-concepts-distinct
- Prevention rule: Keep ownership, identity, authorization and freshness distinct; shape validation and persistence do not establish authority.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: eaae1177, #176, 24ed0178, #483
- Seen: 3×

- Date: 2026-10-03
- Name: Recover owned operation only
- Mistake pattern: recover-only-owned-operation
- Prevention rule: Recover only the exact operation/claim originally owned; never release a replacement claim or skip an unprocessed cursor.
- Enforced by: judgment
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: fe35f0a9, #483
- Seen: 1×

- Date: 2026-10-03
- Name: Preserve producer errors
- Mistake pattern: preserve-producer-errors
- Prevention rule: Preserve producer errors when draining pipelines; do not hide SIGPIPE or upstream failures with generic success fallbacks.
- Enforced by: judgment
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: ed6e7b9a, #483
- Seen: 1×

- Date: 2026-10-03
- Name: Bind assertions to run IDs
- Mistake pattern: bind-assertions-to-run-ids
- Prevention rule: Bind assertions to explicit run IDs and revisions, not timestamps or whichever artifact happens to be latest.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: f5c30cf0, e467217c, 7102269c, #483
- Seen: 3×

- Date: 2026-10-03
- Name: Run coverage once
- Mistake pattern: run-coverage-once
- Prevention rule: Run changed-behavior coverage once; reviewers reuse recorded results, and historical passes remain bound to their original inputs.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: eb48d698, 9fcf2975, 9478b705, 6c19234e, 47e1ae08, #483
- Seen: 5×

- Date: 2026-10-03
- Name: Aggregate independent failures
- Mistake pattern: aggregate-independent-failures
- Prevention rule: Aggregate independent failures so a red first lane does not conceal later faults; schedule the full suite daily.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: #319, #321, e467217c, b674ebe4, #483
- Seen: 3×

- Date: 2026-10-03
- Name: Isolate mutable state
- Mistake pattern: isolate-mutable-state
- Prevention rule: Isolate mutable process/repository/HOME state and use real synchronization signals instead of sleeps or longer timeouts.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: 6c7aec98, 16aed8af, 7ce86fdd, 01920840, b6dee923, #483
- Seen: 5×

- Date: 2026-10-03
- Name: Change sources with projections
- Mistake pattern: change-sources-and-projections-together
- Prevention rule: Change distributed authoring sources and deterministic projections together; validate dry-run against the same operation model as apply.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: dc4c7656, #173, f081c6a0, cd05083e, 8134a2af, #483
- Seen: 5×

- Date: 2026-10-03
- Name: Verify observer evidence
- Mistake pattern: verify-observer-evidence
- Prevention rule: Verify actual observer configuration and emitted evidence before claiming a mechanism runs or catches problems.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: 868d5b4e, 25944738, 0ab66370, #483
- Seen: 3×

- Date: 2026-10-03
- Name: Preserve approved scope
- Mistake pattern: preserve-approved-scope
- Prevention rule: Preserve approved scope and private operations state; never turn an advisory, capacity bound or healthy startup into delivery acceptance.
- Enforced by: judgment
- Promoted: #3023
- Missed by: unknown
- Why: #483 consolidated this rule from earlier lessons; the pre-consolidation references and count are kept here. The old entries do not name the layer that missed each event, so `Missed by` is unknown.
- Triggered by correction: a6f0921e, a47cde10, 35597741, #483
- Seen: 3×

- Date: 2026-11-05
- Name: Check mockup parity
- Mistake pattern: check-mockup-parity-on-same-data
- Prevention rule: Check mockup parity side by side on the same data, including the real empty state. A field that the mockup needs and the contract lacks is a contract gap to raise, not a visual to drop.
- Enforced by: judgment
- Missed by: human
- Why: The Office shipped without the pixel art, the repository room and the empty desks of its mockup, and the owner compared the page with the mockup himself.
- Triggered by correction: #1784, #1787
- Seen: 1×

- Date: 2026-11-19
- Name: Preserve user resets
- Mistake pattern: preserve-user-reset-files
- Prevention rule: Keep a user-reset file at revert. File emptiness alone gives no permission to remove it.
- Enforced by: tests/host-config/gate.test.ts
- Missed by: self-verify
- Why: A reset file and a recreated repository exclude file both reached the unlink path. The original verification in #3236 ran the gate and uninstall suites without the recreated exclude case. The two PRs used one fix round each for the same class.
- Triggered by correction: #3215, #3236
- Seen: 1×

- Date: 2026-11-19
- Name: Release absent claims
- Mistake pattern: retire-absent-ownership-claims
- Prevention rule: Retire a claim when its target is observed absent. A later copy at the same path gets no claim from that record.
- Enforced by: tests/cli/uninstall.test.ts
- Missed by: self-verify
- Why: Pi removal left a claim for a missing package entry. Tool removal later omitted directory claims from the durable retirement step. The original uninstall tests for #3235 covered absent tool files and omitted a stopped removal with a recreated directory.
- Triggered by correction: #3222, #3235
- Seen: 1×

- Date: 2026-11-19
- Name: Smoke test packed startup
- Mistake pattern: verify-packed-startup-without-home
- Prevention rule: Run the packed CLI version and hook usage in an environment without HOME before publishing.
- Enforced by: scripts/check-tarball-install-smoke.sh
- Missed by: unknown
- Why: The published v0.35.0 executables threw at import without HOME. Release step 4 found the failure. The record does not establish which earlier check ran with that environment.
- Triggered by correction: #3202
- Seen: 1×

- Date: 2026-11-19
- Name: Stage refresh with ignored backups
- Mistake pattern: stage-refresh-with-ignored-backups
- Prevention rule: Stage the refresh without naming an ignored backup root in the add pathspec. Reset the transaction backup from the index after staging.
- Enforced by: tests/cli/upgrade.test.ts
- Missed by: unknown
- Why: Git rejected the exclude pathspec for the ignored backup path in all eight eligible repositories. The original verification record does not show coverage of that layout.
- Triggered by correction: #3213
- Seen: 1×

- Date: 2026-11-19
- Name: Check unanswered bot threads
- Mistake pattern: require-review-bot-response-before-merge
- Prevention rule: Include unresolved bot threads without a human reply in merge readiness. Report the thread blocker before publication.
- Enforced by: src/core/publication/merge-readiness.ts
- Missed by: unknown
- Why: PR #3217 merged with two unanswered bot threads. The readiness predicate omitted bot-started threads, and the record does not establish an earlier independent check for replies.
- Triggered by correction: #3220
- Seen: 1×

- Date: 2026-11-19
- Name: Retire claims before removal
- Mistake pattern: retire-claims-before-destructive-writes
- Prevention rule: Route removal of recorded additions through the durable claim retirement step before changing the file. Keep a claim retired after rollback.
- Enforced by: tests/host-config/gate.test.ts
- Missed by: unknown
- Why: The merged revert planner treated a replacement that removed an add fragment as a restore. A failure between the write and ledger commit left removal authority for a user-restored copy. The original verification record does not establish a check for that order on replacement writes.
- Triggered by correction: #3229
- Seen: 1×

- Date: 2026-11-19
- Name: Ignore backups before copying
- Mistake pattern: ignore-checkout-backups-before-copying
- Prevention rule: Make a checkout backup directory ignore its contents before it can hold a user file.
- Enforced by: src/effects/fs-transaction.ts
- Missed by: unknown
- Why: A first init or upgrade copied user files before the Git ignore rule existed. The original verification record does not show a checkout with the root still unignored.
- Triggered by correction: #3230
- Seen: 1×

- Date: 2026-11-19
- Name: Prove released config text
- Mistake pattern: prove-released-config-text-before-inline-migration
- Prevention rule: Compare legacy hook and status-line text with a released rendering before storing it inline. Keep unproved recovery bytes in the vault.
- Enforced by: tests/cli/configuration-ownership.test.ts
- Missed by: unknown
- Why: The legacy classifier accepted user-edited commands by shape on two inputs. The original verification record does not show a case with a user edit inside a managed-looking command.
- Triggered by correction: #3233, #3239
- Seen: 1×

- Date: 2026-11-19
- Name: Remove exact package entry
- Mistake pattern: remove-only-exact-recorded-package-entry
- Prevention rule: Remove the exact recorded package fragment with the config gate. Preserve other entries for the same package.
- Enforced by: src/cli/installer/pi-package.ts
- Missed by: unknown
- Why: Pi's package removal matched more entries than the ledger selector. A scratch HOME probe confirmed removal of a user edit. The original verification record does not establish coverage of those matches.
- Triggered by correction: #3270
- Seen: 1×

- Date: 2026-11-19
- Name: Block after guard crash
- Mistake pattern: block-when-required-hook-crashes
- Prevention rule: Set guard routes to return the host's blocking status when their handler fails.
- Enforced by: tests/hook-runtime.test.ts
- Missed by: unknown
- Why: A Bash handler crash returned a status that Claude treats as advisory. The original verification record does not establish a probe of the crash through that host.
- Triggered by correction: #3271
- Seen: 1×

- Date: 2026-11-19
- Name: Recheck hook exemption ownership
- Mistake pattern: recheck-hook-exemption-ownership
- Prevention rule: Grant the mutation-guard exemption only when the shared ledger proof still identifies the current entry.
- Enforced by: tests/mutation-guard.test.ts
- Missed by: unknown
- Why: A recorded path alone bypassed the guard after the user edited or replaced the entry. The original verification record does not show a hook check after a user replacement.
- Triggered by correction: #3272
- Seen: 1×

- Date: 2026-11-19
- Name: Use fixed crash diagnostics
- Mistake pattern: use-fixed-hook-crash-diagnostics
- Prevention rule: Return fixed handler and reason codes from hook failures. Keep raw exception text out of diagnostics.
- Enforced by: tests/hook-runtime.test.ts
- Missed by: unknown
- Why: The crash branch sent exception text to Claude and Pi. The original verification record does not show a check of the diagnostic with a user value in the exception.
- Triggered by correction: #3273
- Seen: 1×

- Date: 2026-11-19
- Name: Keep commands out of refusals
- Mistake pattern: omit-command-text-from-hook-refusals
- Prevention rule: Render refusal and repair text from fixed fields. Omit raw command text from both the hook response and failure log.
- Enforced by: tests/mutation-guard.test.ts
- Missed by: unknown
- Why: A denial copied the command into the repair line and failure log. The original verification record does not show a check with an opaque user value in the command.
- Triggered by correction: #3273
- Seen: 1×

- Date: 2026-11-19
- Name: Preflight all write paths
- Mistake pattern: preflight-whole-path-write-set
- Prevention rule: Validate every destination and its link boundaries before any whole-path write. Report the path that blocks the write.
- Enforced by: src/effects/host-config/gate.ts
- Missed by: unknown
- Why: The gate could publish one file before refusing another, and link components could redirect a write. The original verification record does not show both states through the shared admission path.
- Triggered by correction: #3278
- Seen: 1×

- Date: 2026-11-19
- Name: Prove current entry identity
- Mistake pattern: prove-current-owned-entry-identity
- Prevention rule: Match the current file-system identity and content to the install-time record before removing or overwriting a whole path.
- Enforced by: src/effects/host-config/path-records.ts
- Missed by: unknown
- Why: A user could recreate a path with the same bytes before the next observation. The content comparison accepted the replacement. The original verification record does not show that replacement state for the whole-path gate.
- Triggered by correction: #3303
- Seen: 1×

- Date: 2026-11-19
- Name: Check runtime disable impact
- Mistake pattern: reject-disable-of-in-use-seat-runtime
- Prevention rule: Under the configuration transaction, refuse to disable a runtime used by an effective seat. List the seats to move first.
- Enforced by: src/effects/configuration/agents-configuration.ts
- Missed by: unknown
- Why: The Hosts write could disable a runtime that Seats still referenced. The next Seats save failed. The original verification record does not show a write sequence across both settings surfaces.
- Triggered by correction: #3309
- Seen: 1×

- Date: 2026-11-19
- Name: Share seat launch setup
- Mistake pattern: share-seat-launch-environment
- Prevention rule: Use the same login-shell wrapper for tab and split seat launches so both get the required executable paths.
- Enforced by: src/cli/commands/seats.ts
- Missed by: unknown
- Why: A seat launched through a split had no Bun on PATH. The original verification record does not show both live launch modes with the same executable lookup.
- Triggered by correction: #3310
- Seen: 1×

- Date: 2026-11-19
- Name: Refuse untracked seat waits
- Mistake pattern: refuse-reset-wait-for-untracked-seat
- Prevention rule: Check that Herdr tracks the requester before waiting during seat reset. Report the untracked requester at once.
- Enforced by: src/effects/board/seat-reset.ts
- Missed by: unknown
- Why: Reset waited 600 seconds on a requester whose Herdr status was null. The original verification record does not show that input reaching the wait step.
- Triggered by correction: #3310
- Seen: 1×

- Date: 2026-11-19
- Name: Resolve seat from requester
- Mistake pattern: resolve-seat-registry-from-requester
- Prevention rule: Resolve the repository registry entry from the requester's registered launch directory during reset.
- Enforced by: tests/cli/seats-argv.test.ts
- Missed by: unknown
- Why: A reset from a directory outside Git could not check the seat's model. The original verification record does not show reset from that directory.
- Triggered by correction: #3310
- Seen: 1×
