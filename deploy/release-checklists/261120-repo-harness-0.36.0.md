# repo-harness 0.36.0 publication record

## Release scope

- Release date is 2026-11-20 UTC. The release includes `repo-harness` and `repo-harness-operator-web`.
- The source is `ca528b51c1102c39e83bf2cb2dc07034bec5902d` (#3358). The range `v0.35.2..ca528b51c` has 40 commits and no changelog fragments. The table lists every commit in that range.
- The prep is ready for Rule 2 merge review. Publication of both packages, the tag and the GitHub Release awaits the owner's explicit release word.
- The release moves the host configuration ledger to protocol 5. See Upgrade and Rollback for the host cutover.

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
| [#3337](https://github.com/aimpact-inc/repo-harness/pull/3337) | `8d7017ea6` | Seed private CodeGraph indexes from an archctx 0.16.0 shared base |
| [#3342](https://github.com/aimpact-inc/repo-harness/pull/3342) | `722dd4946` | Give Pi Neon the Claude Opus seat tier |
| [#3344](https://github.com/aimpact-inc/repo-harness/pull/3344) | `e69f9b74f` | Record seat, model, fleet, review and bundling design in ADR-0006 |
| [#3355](https://github.com/aimpact-inc/repo-harness/pull/3355) | `e0d5cfa96` | Add refactor, module prompt and architecture verification to skills |
| [#3351](https://github.com/aimpact-inc/repo-harness/pull/3351) | `9b6879ed6` | Preserve ignored local data during worktree cleanup |
| [#3356](https://github.com/aimpact-inc/repo-harness/pull/3356) | `dfbacb2cd` | Reuse Node probes, scope refactor scans, preserve provider errors and retire held archctx commands |
| [#3357](https://github.com/aimpact-inc/repo-harness/pull/3357) | `281260593` | Resolve cited files, bundle by file overlap and include loose issues in parent scans |
| [#3358](https://github.com/aimpact-inc/repo-harness/pull/3358) | `ca528b51c` | Refresh architecture projections through `281260593` |

## Upgrade

- Run `rh update` after installing 0.36.0. It moves the user and repository host configuration ledgers from protocol 4 to 5. Install state stays at protocol 5, plan blocks at protocol 3, and the hook bridge at protocol 1. The Antigravity hook member has no group protocol field.
- The update adds `planner: null` where needed and removes retired roles from saved seat fleets. It removes or restores retired files with proven identity. It preserves edited or unproved files and reports retained vault copies.
- Record fresh acceptance for open reviews that still use the old local receipt layout. The protocol stays at 4. Results and observations now use digest paths.
- Run `rh install --target antigravity` to opt in. Run `rh update --target antigravity` to refresh the recorded member. `rh doctor` checks the direct command and on-disk activation. Native session activation needs a live check.

## Verification

Local verification on macOS 26.5 arm64 with Bun 1.4.4, Node 24.22.1 and npm 11.19.1, based on `ca528b51c`.

- `bun install --frozen-lockfile` passed.
- `bun run check:type` passed.
- `bun scripts/check-skill-version.ts` passed with repo-harness and template at 0.36.0.
- The prep PR records the release commit result of `bun scripts/check-changelog-released-sections.ts --base origin/main`. A byte comparison against the base passed.
- `bun run check:cli-manifest` passed.
- `git diff --check` passed.
- `bun run check:release` passed. All 31 benchmark tests passed. The tarball smoke used a temporary HOME and registry. The packed CLI bins started, and the packed Operator served the web console.

`Required / CI` is pending.

## Order of the owner steps

1. Check the release set with the advisor. Merge the prep PR under Rule 2 when its recorded verification, `Required / CI` and the applicable review requirements pass.
2. After the merge and the owner's explicit release word, run `git fetch origin && bash scripts/release-owner-steps.sh plan 0.36.0` on main. The plan binds publication to the merged release commit.
3. Follow the authorized plan in order. Publish `repo-harness-operator-web` before `repo-harness`, then create the tag and GitHub Release. Use the plan's resume checks if a step stops.
4. After step 7 passes, run step 8 (`bun scripts/check-released-managed-values.ts --write`) and merge its file in one Low PR.
5. Coordinate host updates and seat relaunches across the machines that run seats.

## Publication

Publish candidate merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.36.0` | pending | pending | pending |
| 2 | `repo-harness@0.36.0` | pending | pending | pending |

Publication of both packages, tag `v0.36.0` and the GitHub Release awaits the owner's explicit release word.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.36.0` and `bash scripts/release-owner-steps.sh check tagged 0.36.0`. Both are pending.
- Rebuild released managed values in the post-release PR. Pending.
- Update the seat hosts and relaunch their seats. Pending.

## Rollback

Before publication, close the prep PR or revert its squash commit. After publication, keep the tag and release a corrective patch.

Version 0.35.2 rejects protocol 5 host configuration ledgers. Keep 0.36.0 on migrated hosts, or restore the pre-upgrade ledgers with their matching host state before returning to 0.35.2. Move any native `agy` seats to a runtime that 0.35.2 supports.
