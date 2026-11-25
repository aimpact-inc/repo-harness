# Lessons

reviewed-through: 51519eaa0f7fb851d5305949b02d837b3ef9489b

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

- Date: 2026-11-22
- Name: Check sign-in before quota
- Mistake pattern: check-catalog-auth-before-quota
- Prevention rule: Treat a catalog sign-in failure as a runtime refusal before checking model quota. Test when the two probes disagree and quota is exhausted or reserved.
- Enforced by: tests/cli/quota.test.ts
- Missed by: self-verify
- Why: In #3333, a catalog sign-in failure could produce a quota refusal if the runtime probe still reported signed in. Review found the diagnostic error and deferred its fix to #3334. The launch still refused to start.
- Triggered by correction: 9ecbed98b
- Seen: 1×

- Date: 2026-11-22
- Name: Publish complete acceptance records
- Mistake pattern: publish-acceptance-after-companion-writes
- Prevention rule: Write the result and observation under immutable identifiers before publishing the receipt that selects them. Verify that an interrupted write leaves the prior acceptance usable.
- Enforced by: tests/acceptance-receipt.test.ts
- Missed by: unknown
- Why: A failed or interrupted write could leave the previous receipt pointing to a different result. A fresh verifier then rejected the valid acceptance. The earlier verification record does not show a fault test with an existing receipt.
- Triggered by correction: 7ba980291
- Seen: 1×

- Date: 2026-11-22
- Name: Keep ignored local data
- Mistake pattern: inventory-ignored-data-before-worktree-removal
- Prevention rule: Check for ignored local data in cleanup preview and again under the removal lock. Keep the worktree when the inventory finds an ignored path outside the generated outputs or cannot complete.
- Enforced by: tests/contract-worktree.test.ts
- Missed by: unknown
- Why: Slug cleanup used ordinary Git status, which hid ignored local files that removal could delete. The earlier verification record does not show an ignored-only checkout through the cleanup command.
- Triggered by correction: 9b6879ed6
- Seen: 1×

- Date: 2026-11-22
- Name: Test read-only command matches
- Mistake pattern: verify-readonly-command-prefix-matches
- Prevention rule: Limit read-only tool permissions to complete read commands. Test how the host matches full command lines with options and subcommands.
- Enforced by: tests/cli/seats-argv.test.ts
- Missed by: self-verify
- Why: The test in #3363 checked that exact write commands were absent. A broader allowed prefix still matched write operations and needed a follow-up fix.
- Triggered by correction: 71fb12c57
- Seen: 1×

- Date: 2026-11-22
- Name: Require explicit review seat
- Mistake pattern: require-explicit-seat-for-review-publication
- Prevention rule: Require the producing seat before writing a manual review record. Exercise the documented command for each seat and check what round two carries forward.
- Enforced by: tests/cli/review.test.ts
- Missed by: human
- Why: The documented command defaulted a reviewer PASS to gatekeeper, so round two could schedule the wrong seat. A reviewer flagged the defect as P1 on the final head of #3369 before it merged.
- Triggered by correction: 47a528867
- Seen: 1×

- Date: 2026-11-22
- Name: Isolate packaged Pi smoke
- Mistake pattern: isolate-mutable-state
- Prevention rule: Keep the packaged smoke HOME and Pi settings in the same scratch environment. Configure the required shell there and run the smoke without caller overrides.
- Enforced by: scripts/check-tarball-install-smoke.sh
- Missed by: human
- Why: The 0.36.0 release prep smoke hit macOS Bash 3.2. The recorded pass used a caller-supplied Pi config to select Bash 5.3. The packaged smoke needed a follow-up fix to pass with its own settings for 0.36.1.
- Triggered by correction: dc5ae3646
- Seen: 6×

- Date: 2026-11-25
- Name: Deny what the host auto-approves
- Mistake pattern: never-ask-when-host-auto-approves
- Prevention rule: Return `deny` from a guard when its question cannot reach the user. Set `capabilities.ask: false` for a host that approves a confirmation without a prompt, and test each prompt-skipping mode.
- Enforced by: tests/mutation-guard.test.ts
- Missed by: self-verify
- Why: The Antigravity `UserFileGuard` returned `force_ask`, and the guard assumed that agy shows it. The #3487 probe record found that agy 1.5.16 approves the confirmation without a prompt under `--dangerously-skip-permissions`, `auto` and `always-proceed`. An ordinary `run_command` then overwrote a user file outside the allowed roots (I2). No test ran the real confirmation path.
- Triggered by correction: a1a07470b, #3489
- Seen: 1×

- Date: 2026-11-25
- Name: Probe outside every allowed root
- Mistake pattern: probe-target-outside-allowed-roots
- Prevention rule: Point a guard probe at a file outside the probe HOME, its TMPDIR and the worktree root that the probe runtime resolves. Prove the target through `realpath`, and run the probe with the CI TMPDIR.
- Enforced by: tests/cli/doctor.test.ts
- Missed by: self-verify
- Why: The Antigravity guard probe put its HOME inside TMPDIR and its protected target next to the scratch root. A stale hook that allowed protected-file overwrites still reported the guard ready. On Linux the worktree root resolves `/tmp`, so a `/tmp` target proves nothing there. #3493 moved the probe TMPDIR beside the HOME and targeted `/etc/hosts`.
- Triggered by correction: 3979a7b41, #3493
- Seen: 1×

- Date: 2026-11-25
- Name: Read explicitOnly before discovery
- Mistake pattern: read-explicit-only-before-discovery
- Prevention rule: Set `explicitOnly: true` only to keep a skill out of every selection. To install a skill that a model must not invoke on its own, keep `explicitOnly: false`, set `discoverability: "explicit-only"` and add both host switches.
- Enforced by: tests/skill-surface/catalog.test.ts
- Missed by: unknown
- Why: #3496 asked for `explicitOnly: true` so the two new skills would never auto-trigger. The same field also removes a skill from every selection, so `rh update` would install neither one. The orchestrator changed it to `explicitOnly: false` with `discoverability: "explicit-only"` before implementation. The record names no check of the requested field against the selector rule.
- Triggered by correction: #3496, 51519eaa0
- Seen: 1×

- Date: 2026-11-25
- Name: Split a known pane
- Mistake pattern: split-an-explicit-pane-id
- Prevention rule: Put a seat in an existing tab with `pane.split --direction right --pane <pane id>` from a placement lookup. Never rely on focus or an untargeted split.
- Enforced by: judgment
- Missed by: unknown
- Why: `docs/reference-configs/herdr-notify.md` described up to three panes per tab, but no production code called `pane.split`, and both dispatch paths opened a new tab for every seat. A manual split without an explicit pane id landed in the focused space. Live multi-issue work produced duplicate `#<parent>` worker tabs and `review` tabs (#3494). No test ran a split.
- Triggered by correction: #3494
- Seen: 1×
