# repo-harness 0.36.0 publication record

## Release scope

- Release date is 2026-11-21 UTC. The release includes `repo-harness` and `repo-harness-operator-web`.
- The source is `cbedaa4dc22d3a8792604d8062a547e7e5cf12c6` (#3381). The range `v0.35.2..cbedaa4dc` has 53 commits and no changelog fragments. This checklist extends the 40-commit draft in PR #3360.
- The release moves the host configuration ledger to protocol 5 and the saved seat settings to the 11-seat schema. See [Upgrade and Rollback](../../docs/CHANGELOG.md#upgrade) in the changelog.
- The owner's explicit release word gates publication of both packages, creation of `v0.36.0`, and creation of the GitHub Release.

| PR | Commit | Change |
|---|---|---|
| [#3295](https://github.com/aimpact-inc/repo-harness/pull/3295) | `3a7e0866e` | Record the 0.35.2 managed values |
| [#3290](https://github.com/aimpact-inc/repo-harness/pull/3290) | `5efc844e2` | Report and route Antigravity quota by account group |
| [#3291](https://github.com/aimpact-inc/repo-harness/pull/3291) | `1410852a7` | Add `rh board cluster` for module bundles and defect patterns |
| [#3301](https://github.com/aimpact-inc/repo-harness/pull/3301) | `583d090b6` | Refresh architecture projections through `1410852a7` |
| [#3303](https://github.com/aimpact-inc/repo-harness/pull/3303) | `9ed4d88a8` | Require file-system identity for whole-path ownership |
| [#3308](https://github.com/aimpact-inc/repo-harness/pull/3308) | `5c9a6912b` | Define rules retro seats, triggers and watermark reset |
| [#3312](https://github.com/aimpact-inc/repo-harness/pull/3312) | `142d57005` | Start the architecture timeout test after the fixture signals readiness |
| [#3309](https://github.com/aimpact-inc/repo-harness/pull/3309) | `e4b591742` | Refuse to disable runtimes used by effective seats |
| [#3310](https://github.com/aimpact-inc/repo-harness/pull/3310) | `56b0e9434` | Share the login shell and fix requester lookup and reset |
| [#3314](https://github.com/aimpact-inc/repo-harness/pull/3314) | `b3a6d7998` | Record the rules discovery pilot in the PRD |
| [#3311](https://github.com/aimpact-inc/repo-harness/pull/3311) | `2e582704a` | Report experimental rule proposals |
| [#3315](https://github.com/aimpact-inc/repo-harness/pull/3315) | `53f51613e` | Route the Magpie Antigravity advisor by Gemini weekly quota |
| [#3317](https://github.com/aimpact-inc/repo-harness/pull/3317) | `39431a07e` | Define the optional rule-opportunity marker |
| [#3318](https://github.com/aimpact-inc/repo-harness/pull/3318) | `9201d6a0f` | Refresh architecture projections through `2e582704a` |
| [#3313](https://github.com/aimpact-inc/repo-harness/pull/3313) | `a4cccb9da` | Reset the rules ledger watermark and reconcile enforcement |
| [#3316](https://github.com/aimpact-inc/repo-harness/pull/3316) | `e5b88cba7` | Document Magpie routes and check the local gateway |
| [#3319](https://github.com/aimpact-inc/repo-harness/pull/3319) | `06744d5ea` | Limit Herdr fleets to read-only scaffold roles |
| [#3320](https://github.com/aimpact-inc/repo-harness/pull/3320) | `cdfdfa7bc` | Add the shared hook host contract and Antigravity adapter |
| [#3322](https://github.com/aimpact-inc/repo-harness/pull/3322) | `4b4754157` | Refresh architecture projections through `cdfdfa7bc` |
| [#3323](https://github.com/aimpact-inc/repo-harness/pull/3323) | `7a6bb02ef` | Allow scaffold model settings on Pi seats |
| [#3325](https://github.com/aimpact-inc/repo-harness/pull/3325) | `d0490cd66` | Show available recommended models by seat |
| [#3326](https://github.com/aimpact-inc/repo-harness/pull/3326) | `6f79b193f` | Retire former fleet files through the host ledger |
| [#3327](https://github.com/aimpact-inc/repo-harness/pull/3327) | `1a66de111` | Add the optional planner seat |
| [#3321](https://github.com/aimpact-inc/repo-harness/pull/3321) | `c787cabfc` | Record the completed rules discovery retro |
| [#3328](https://github.com/aimpact-inc/repo-harness/pull/3328) | `78d49ea1d` | Refresh architecture projections through `c787cabfc` |
| [#3329](https://github.com/aimpact-inc/repo-harness/pull/3329) | `046cc9b5f` | Open planner consultations in Herdr |
| [#3330](https://github.com/aimpact-inc/repo-harness/pull/3330) | `a7cf2a803` | Document the retained read-only fleet |
| [#3331](https://github.com/aimpact-inc/repo-harness/pull/3331) | `a916673b4` | Install the opt-in Antigravity hook member as an owned fragment |
| [#3332](https://github.com/aimpact-inc/repo-harness/pull/3332) | `a467ed24b` | Document planner consultation and dispatch skeletons |
| [#3333](https://github.com/aimpact-inc/repo-harness/pull/3333) | `546269a96` | Check runtime availability and recorded review family before launch |
| [#3334](https://github.com/aimpact-inc/repo-harness/pull/3334) | `9ecbed98b` | Run the advisor on native Antigravity in Herdr |
| [#3336](https://github.com/aimpact-inc/repo-harness/pull/3336) | `7ba980291` | Preserve the prior acceptance receipt when a write fails |
| [#3337](https://github.com/aimpact-inc/repo-harness/pull/3337) | `8d7017ea6` | Seed private CodeGraph indexes from the ArchContext shared base |
| [#3342](https://github.com/aimpact-inc/repo-harness/pull/3342) | `722dd4946` | Give Pi Neon the Claude Opus seat tier |
| [#3344](https://github.com/aimpact-inc/repo-harness/pull/3344) | `e69f9b74f` | Record seat, model, fleet, review and bundling design in ADR-0006 |
| [#3355](https://github.com/aimpact-inc/repo-harness/pull/3355) | `e0d5cfa96` | Add refactor, module prompts and architecture verification to skills |
| [#3351](https://github.com/aimpact-inc/repo-harness/pull/3351) | `9b6879ed6` | Preserve ignored local data during worktree cleanup |
| [#3356](https://github.com/aimpact-inc/repo-harness/pull/3356) | `dfbacb2cd` | Reuse Node probes, scope refactor scans, preserve provider errors and retire held ArchContext commands |
| [#3357](https://github.com/aimpact-inc/repo-harness/pull/3357) | `281260593` | Resolve cited files, bundle by file overlap and include loose issues in parent scans |
| [#3358](https://github.com/aimpact-inc/repo-harness/pull/3358) | `ca528b51c` | Refresh architecture projections through `281260593` |
| [#3363](https://github.com/aimpact-inc/repo-harness/pull/3363) | `4737de0bd` | Add the logical model catalog and retire Astra and Sonnet from non-council recommendations |
| [#3361](https://github.com/aimpact-inc/repo-harness/pull/3361) | `edf29b3ab` | Seed debt base checkouts from shared CodeGraph and run constraints checks through `rh arch` |
| [#3365](https://github.com/aimpact-inc/repo-harness/pull/3365) | `4ef4645ae` | Refresh architecture projections through `edf29b3ab` |
| [#3362](https://github.com/aimpact-inc/repo-harness/pull/3362) | `4f915e4fa` | Add attention rule R8 and triage apply, and prevent overlap from creating dependency cycles |
| [#3368](https://github.com/aimpact-inc/repo-harness/pull/3368) | `71fb12c57` | Fix Antigravity board command restrictions and wire Pi seat reset and handoff |
| [#3369](https://github.com/aimpact-inc/repo-harness/pull/3369) | `932077664` | Attribute review seats from GitHub evidence and prefer the gatekeeper for Medium PRs |
| [#3374](https://github.com/aimpact-inc/repo-harness/pull/3374) | `47a528867` | Require an explicit seat for manual review publication |
| [#3373](https://github.com/aimpact-inc/repo-harness/pull/3373) | `d8df9c9de` | Adopt ArchContext 0.17.0 for batched verify and impact |
| [#3378](https://github.com/aimpact-inc/repo-harness/pull/3378) | `284404e4a` | Migrate to 11 seats, add `rh seats council` and align ADR-0006 procedures |
| [#3379](https://github.com/aimpact-inc/repo-harness/pull/3379) | `76675c26b` | Refresh architecture projections through `284404e4a` |
| [#3380](https://github.com/aimpact-inc/repo-harness/pull/3380) | `56e9a3f42` | Manage and check Antigravity Global Working Rules and skill links |
| [#3383](https://github.com/aimpact-inc/repo-harness/pull/3383) | `b59f0a3ea` | Run native Antigravity on worker, council and gatekeeper-fallback seats |
| [#3381](https://github.com/aimpact-inc/repo-harness/pull/3381) | `cbedaa4dc` | Pin ArchContext 0.17.1 and CodeGraph 1.6.4 and use native debt comparison |

## Upgrade

- Run `rh update` once on each host. It migrates the host configuration ledger from protocol 4 to 5, retires former fleet files with proven ownership and migrates saved settings to the 11-seat schema. Review renamed seats and routing, then relaunch after all participating hosts update.
- Record fresh acceptance for open reviews with the old local receipt layout. Include `--seat gatekeeper` or `--seat reviewer` when publishing manually.
- On opted-in Antigravity hosts, run `rh update --target antigravity` and `rh doctor`. Confirm the real hook command paths, guard activation in fresh `agy` sessions, and native advisor launch and handoff through Herdr. Record the live evidence for #3251 and #3246.
- After a successful native `rh arch debt --base <ref>` run, remove the retired `.git/repo-harness/cache/arch-debt` cache if present. In a linked worktree, look for `repo-harness/cache/arch-debt` under the directory that `git rev-parse --git-common-dir` prints.

## Verification

The prep PR records the local commands, results and tested commit. `Required / CI` runs on the prep PR.

## Order of the owner steps

1. Review the prep PR under the applicable release merge rule. Confirm its recorded verification, `Required / CI` and required reviews before merge.
2. After the merge and the owner's explicit release word, refresh `origin/main` with `git fetch origin`. Run `bash scripts/release-owner-steps.sh plan 0.36.0` from the main checkout. The plan binds the steps to the merged release commit.
3. Follow the authorized plan in order. Publish `repo-harness-operator-web` first, then `repo-harness`. Verify both packages on npm before creating the tag and GitHub Release. If a step stops, use the saved plan's resume checks.
4. After step 7 succeeds, run step 8 (`bun scripts/check-released-managed-values.ts --write`). Submit the generated index in one Low PR.
5. Update the seat hosts together and record the post-update checks before relying on native Antigravity seats.

## Publication

Publish candidate merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.36.0` | pending | pending | pending |
| 2 | `repo-harness@0.36.0` | pending | pending | pending |

Tag `v0.36.0` and GitHub Release are pending.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.36.0` before tagging and `bash scripts/release-owner-steps.sh check tagged 0.36.0` after creating the GitHub Release. Both are pending.
- Rebuild and merge the released managed values index. Pending.
- Update the seat hosts, check the installed versions, and verify the live hook and Herdr launch paths. Pending.

## Rollback

Before publication, close the prep PR or run `git revert <squash-commit>`. After publication, keep the tag and release a corrective patch.

Version 0.35.2 rejects protocol 5 host configuration ledgers. Keep 0.36.0 on migrated hosts, or restore the pre-upgrade ledgers with their matching host state and seat settings before returning to 0.35.2. Move native `agy` seats to a supported runtime before downgrade.
