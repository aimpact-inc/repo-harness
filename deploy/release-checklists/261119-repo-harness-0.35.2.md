# repo-harness 0.35.2 publication record

## Release scope

- Release date is 2026-11-19 UTC. The release parent is [#3280](https://github.com/aimpact-inc/repo-harness/issues/3280).
- The owner gave the release word locally on 2026-11-19. The first log adds #3281 to the release and holds #3266 PR A for the next release. The second confirms authorization for 0.35.2 and calls for the advisor to check the release set before the orchestrator starts the host commands. See [comment 7001652378](https://github.com/aimpact-inc/repo-harness/issues/3280#issuecomment-7001652378) and [comment 7001898870](https://github.com/aimpact-inc/repo-harness/issues/3280#issuecomment-7001898870).
- The source is `aed0560623800573bb354c33c416f1b4f33207a7` (#3289). The range `v0.35.1..aed056062` has 35 commits and no changelog fragments. The table lists the merged PRs covered by the changelog.
- This patch changes the plan block, install state and host configuration ledger protocols. The Upgrade and Rollback sections record their cutover requirements.

| PR | Commit | Change |
|---|---|---|
| [#3211](https://github.com/aimpact-inc/repo-harness/pull/3211) | `2bc463741` | Record the 0.35.1 managed values |
| [#3207](https://github.com/aimpact-inc/repo-harness/pull/3207) | `27fa99739` | Record sanitized lifecycle events |
| [#3208](https://github.com/aimpact-inc/repo-harness/pull/3208) | `19df0d3ef` | Allow Medium review for limited workflow edits |
| [#3213](https://github.com/aimpact-inc/repo-harness/pull/3213) | `55427107a` | Stage refresh PRs with an ignored backup directory |
| [#3216](https://github.com/aimpact-inc/repo-harness/pull/3216) | `4f22aed92` | Repair Operator source links |
| [#3217](https://github.com/aimpact-inc/repo-harness/pull/3217) | `ccf9028e9` | Report board bottlenecks with `rh board retro` |
| [#3220](https://github.com/aimpact-inc/repo-harness/pull/3220) | `e0b5dd8ed` | Block merges on unanswered bot threads |
| [#3215](https://github.com/aimpact-inc/repo-harness/pull/3215) | `a1bc12ace` | Revert host configuration by ledger and add `rh config` |
| [#3222](https://github.com/aimpact-inc/repo-harness/pull/3222) | `95e94be24` | Record Pi and Skills CLI writes in the ledger |
| [#3223](https://github.com/aimpact-inc/repo-harness/pull/3223) | `f43cf57fa` | Record shared tools and keep them on plain uninstall |
| [#3225](https://github.com/aimpact-inc/repo-harness/pull/3225) | `05168281e` | Retire host configuration claims before removal |
| [#3230](https://github.com/aimpact-inc/repo-harness/pull/3230) | `7f038d7d9` | Ignore checkout backups before copying |
| [#3229](https://github.com/aimpact-inc/repo-harness/pull/3229) | `a5f4530b4` | Retire claims before removing added text |
| [#3234](https://github.com/aimpact-inc/repo-harness/pull/3234) | `41bccf5fd` | Restore repository hooks through the repository ledger |
| [#3235](https://github.com/aimpact-inc/repo-harness/pull/3235) | `dea40748d` | Add `rh uninstall --with-tools` |
| [#3233](https://github.com/aimpact-inc/repo-harness/pull/3233) | `d46bf5286` | Keep user-edited status lines out of inline ledger text |
| [#3236](https://github.com/aimpact-inc/repo-harness/pull/3236) | `064aa0086` | Record the repository exclude block in the ledger |
| [#3239](https://github.com/aimpact-inc/repo-harness/pull/3239) | `fa01db7d1` | Keep user-edited hook commands out of inline ledger text |
| [#3240](https://github.com/aimpact-inc/repo-harness/pull/3240) | `974e4d32e` | Record repository writes for `rh config restore --repo` |
| [#3243](https://github.com/aimpact-inc/repo-harness/pull/3243) | `5f275d501` | Record user-state checks and release rules for open batches |
| [#3247](https://github.com/aimpact-inc/repo-harness/pull/3247) | `3a827c0f3` | Offer Gemini 4 Neon for Pi seats |
| [#3271](https://github.com/aimpact-inc/repo-harness/pull/3271) | `61e864d31` | Deny Claude Bash commands on guard failure |
| [#3270](https://github.com/aimpact-inc/repo-harness/pull/3270) | `d5aa7ce65` | Remove only the recorded Pi package entry |
| [#3272](https://github.com/aimpact-inc/repo-harness/pull/3272) | `8d0f40e62` | Check current path contents before applying the hook exemption |
| [#3273](https://github.com/aimpact-inc/repo-harness/pull/3273) | `334f3606c` | Omit denied commands and raw crash text from hook output |
| [#3277](https://github.com/aimpact-inc/repo-harness/pull/3277) | `a298004d3` | Fix same-file defects of the same rule before round 1 |
| [#3269](https://github.com/aimpact-inc/repo-harness/pull/3269) | `98c9f3f39` | Accept user-set seat model IDs and report invalid field paths |
| [#3278](https://github.com/aimpact-inc/repo-harness/pull/3278) | `a7651ac46` | Check all write destinations and refuse links outside the root |
| [#3285](https://github.com/aimpact-inc/repo-harness/pull/3285) | `112e0ed77` | Recommend models per seat kind |
| [#3289](https://github.com/aimpact-inc/repo-harness/pull/3289) | `aed056062` | Dispatch and merge by protocol 3 plan unit |

## Upgrade

- Run `rh update` after installing 0.35.2. It refreshes the managed skill and hook files, moves install state from protocol 4 to 5, and moves the host configuration ledger from protocol 2 to 4.
- If you put a secret inline in an rh-tagged hook or statusLine command before upgrading to 0.35.1, check `ledger.json` for it and rotate that secret. See [#3237 comment 6995878129](https://github.com/aimpact-inc/repo-harness/issues/3237#issuecomment-6995878129).
- After the install, use `rh board post plan` to repost the newest plan comment of each open parent with `"protocol": 3`. Update every machine that runs seats together. 0.35.2 refuses a protocol 2 plan. See [#3289](https://github.com/aimpact-inc/repo-harness/pull/3289).

## Verification

Local verification on Darwin arm64 with Bun 1.4.4, based on `aed056062`.

- `bun install --frozen-lockfile` passed.
- `bun run check:type` passed.
- `bun scripts/check-skill-version.ts` passed with repo-harness and template at 0.35.2.
- `bun scripts/check-changelog-released-sections.ts --base origin/main` passed. All 125 released sections kept their bytes.
- `bun run check:cli-manifest` passed.
- `git diff --check` passed.
- `bun run check:release` passed with exit 0. The benchmark tests passed 31 of 31. The tarball smoke used its own temporary HOME and registry. The packed CLI bins started and the packed Operator served the web console. The MCP server loaded 34 modules and the Operator server loaded 84 modules. The first launch stopped at exit 127 because Bun was absent from the terminal PATH. The retry used the shell PATH and temporary npm configuration and cache.

`Required / CI` is pending.

## Order of the owner steps

1. Check the release set with the advisor. Merge the prep PR under rule 2 after `Required / CI` and the recorded verification pass.
2. On main, run `git fetch origin && bash scripts/release-owner-steps.sh plan 0.35.2`. The plan binds the steps to the release commit. The prep worktree already occupies the path in step 1. After the merge, switch that clean worktree to the plan's release commit before running the rest of step 1.
3. Follow the authorized plan in order. Publish `repo-harness-operator-web` before `repo-harness`, then create the tag and GitHub Release. Use the plan's resume steps if publication stops partway through.
4. After step 7 passes, run step 8 (`bun scripts/check-released-managed-values.ts --write`) and merge its file in one Low PR.
5. Coordinate the updates, plan reposts and seat relaunches in steps 9 through 11 across all machines that run seats.

## Publication

Publish candidate merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.35.2` | pending | pending | pending |
| 2 | `repo-harness@0.35.2` | pending | pending | pending |

Publication of both packages, tag `v0.35.2` and the GitHub Release is pending.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.35.2` and `bash scripts/release-owner-steps.sh check tagged 0.35.2`. Both are pending.
- Rebuild released managed values in the post-release PR. Pending.
- Update machines that run seats and repost open parent plans as protocol 3. Pending.

## Rollback

Before publication, close the prep PR or revert its squash commit. After publication, retain the tag and use a patch release for a correction.

0.35.1 rejects protocol 3 plans with `unsupported protocol 3`. Repost affected plans as protocol 2 with a flat `merge_order` before using 0.35.1 for dispatch or merge. The 0.35.1 host readers also reject install state protocol 5 and ledger protocol 4. Keep the 0.35.2 runtime if the host state has already migrated.
