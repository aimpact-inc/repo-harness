# repo-harness 0.38.0 publication record

## Release scope

- Release date is 2026-11-28. The release includes `repo-harness` and `repo-harness-operator-web`.
- The base source is `6cb45bd99bcbd6b471ad393722e266b41f4fb4cd`. The range `v0.37.5..6cb45bd99` has 50 commits. Each commit below was read back from Git on 2026-11-28 and its PR number came from the commit's associated pull request.

| PR | Commit | Change |
|---|---|---|
| [#3566](https://github.com/aimpact-inc/repo-harness/pull/3566) | `28923fc30` | Record the 0.37.5 released managed values |
| [#3569](https://github.com/aimpact-inc/repo-harness/pull/3569) | `68a7d3da1` | Recommended CLIs and `gemini-notebook-mcp-cli` in the operator console |
| [#3570](https://github.com/aimpact-inc/repo-harness/pull/3570) | `b1785cbc3` | Route the Windows Pi probe and the Pi CLI run through `resolveWindowsLaunchTarget` (`#3568`) |
| [#3571](https://github.com/aimpact-inc/repo-harness/pull/3571) | `a091e662c` | Projection refresh for main `b1785cbc3d52` |
| [#3572](https://github.com/aimpact-inc/repo-harness/pull/3572) | `fcdc245fd` | `archctx` and `archctx-contracts` from 0.18.4 to 0.18.5 for Node 26 (`#3567`) |
| [#3582](https://github.com/aimpact-inc/repo-harness/pull/3582) | `486b03cf1` | Node engine range `>=24 <27` and restored `bun.lock` metadata (`#3573`) |
| [#3583](https://github.com/aimpact-inc/repo-harness/pull/3583) | `8dd0a1d7e` | Declare the native-session writer and the `rh` bin as entrypoints (`#3578`) |
| [#3584](https://github.com/aimpact-inc/repo-harness/pull/3584) | `97ed97a37` | Route operator imports through declared entrypoints (`#3577`) |
| [#3585](https://github.com/aimpact-inc/repo-harness/pull/3585) | `62d830741` | Hook-adapters component owners and session-lifecycle entrypoints (`#3579`) |
| [#3588](https://github.com/aimpact-inc/repo-harness/pull/3588) | `e1ae2df59` | Projection refresh for main `62d830741f43` |
| [#3590](https://github.com/aimpact-inc/repo-harness/pull/3590) | `b94d859f9` | The council seat honors a stored native `agy` runtime (`#3587`) |
| [#3591](https://github.com/aimpact-inc/repo-harness/pull/3591) | `44c6ce26c` | Assign `task-message-order` to `component.task-fleet.task-inbox` (`#3589`) |
| [#3592](https://github.com/aimpact-inc/repo-harness/pull/3592) | `5954780f4` | Route the execution-primitives and MCP boundaries (`#3580`) |
| [#3593](https://github.com/aimpact-inc/repo-harness/pull/3593) | `307d57eff` | Projection refresh for main `44c6ce26cdc6` |
| [#3586](https://github.com/aimpact-inc/repo-harness/pull/3586) | `9c181710f` | Local `rh autopilot` state and the hourly advisor tick (`#3574`) |
| [#3598](https://github.com/aimpact-inc/repo-harness/pull/3598) | `e74ff0757` | Runtime and event-telemetry entrypoints on the hook-adapters primary (`#3596`) |
| [#3600](https://github.com/aimpact-inc/repo-harness/pull/3600) | `672a83026` | Policy-file and node-runtime entrypoints (`#3594`) |
| [#3601](https://github.com/aimpact-inc/repo-harness/pull/3601) | `541e6e94e` | Publication effects entrypoints (`#3595`) |
| [#3602](https://github.com/aimpact-inc/repo-harness/pull/3602) | `8d1c73096` | Assign the core adoption files to `component.adoption.primary` (`#3597`) |
| [#3614](https://github.com/aimpact-inc/repo-harness/pull/3614) | `00f94655f` | Keep runtime selection out of the provider process-tree clock (`#3603`) |
| [#3599](https://github.com/aimpact-inc/repo-harness/pull/3599) | `219efaaaf` | Projection refresh for main `00f94655f224` |
| [#3616](https://github.com/aimpact-inc/repo-harness/pull/3616) | `f81a6399d` | Split the git runner and the repository registry (`#3604`) |
| [#3621](https://github.com/aimpact-inc/repo-harness/pull/3621) | `556d72507` | Split the publication merge-readiness core and effects files (`#3605`) |
| [#3617](https://github.com/aimpact-inc/repo-harness/pull/3617) | `fb1cfa78b` | Split the architecture projection schema and command policy (`#3608`) |
| [#3623](https://github.com/aimpact-inc/repo-harness/pull/3623) | `3f4c420fe` | Split the architecture-map model into base, flows and layers (`#3609`) |
| [#3624](https://github.com/aimpact-inc/repo-harness/pull/3624) | `2a3214e80` | Split the acceptance-receipt, diff-fingerprint and verification-execution files (`#3606`) |
| [#3625](https://github.com/aimpact-inc/repo-harness/pull/3625) | `df6b3beb8` | Split the seats CLI internals (`#3619`) |
| [#3622](https://github.com/aimpact-inc/repo-harness/pull/3622) | `996fa6095` | Projection refresh for main `df6b3beb8248` |
| [#3615](https://github.com/aimpact-inc/repo-harness/pull/3615) | `180cd7e30` | Parking and the auto-pilot dual sign-off merge gate (`#3575`) |
| [#3628](https://github.com/aimpact-inc/repo-harness/pull/3628) | `2b89c9847` | Split the general repository access tool schemas (`#3618`) |
| [#3627](https://github.com/aimpact-inc/repo-harness/pull/3627) | `a93323630` | Split the hook-adapters installer, ledger and shell internals (`#3607`) |
| [#3626](https://github.com/aimpact-inc/repo-harness/pull/3626) | `4506a0464` | Split the skill-routing eval and candidate-reconciliation files (`#3610`) |
| [#3631](https://github.com/aimpact-inc/repo-harness/pull/3631) | `174173c16` | Split the board effects internals (`#3620`) |
| [#3629](https://github.com/aimpact-inc/repo-harness/pull/3629) | `e91de6862` | Projection refresh for main `174173c16fdf` |
| [#3630](https://github.com/aimpact-inc/repo-harness/pull/3630) | `563949874` | Auto-pilot rules and skill docs (`#3576`) |
| [#3633](https://github.com/aimpact-inc/repo-harness/pull/3633) | `3e42c3908` | Move the test-only skill-routing stub into its test file (`#3610`) |
| [#3634](https://github.com/aimpact-inc/repo-harness/pull/3634) | `0af06393b` | Split six board core files (`#3612`) |
| [#3636](https://github.com/aimpact-inc/repo-harness/pull/3636) | `566d70f93` | Split the advisor-seat and seat-launch internals (`#3632`) |
| [#3640](https://github.com/aimpact-inc/repo-harness/pull/3640) | `7305ee5ea` | Refresh `docs/architecture/archimap.html` for 0.38.0 (`#3637`) |
| [#3635](https://github.com/aimpact-inc/repo-harness/pull/3635) | `35c557a1f` | Projection refresh for main `566d70f93417` |
| [#3639](https://github.com/aimpact-inc/repo-harness/pull/3639) | `c5dd7df08` | First 0.38.0 prep, withdrawn by the owner in `#3642`: one release after the remaining issues (`#3638`) |
| [#3646](https://github.com/aimpact-inc/repo-harness/pull/3646) | `ce4266c3c` | Installer selection-lines entrypoint, which clears the `install-profile.ts` god-file finding (`#3607`) |
| [#3647](https://github.com/aimpact-inc/repo-harness/pull/3647) | `5c07611e7` | Bind issue-labeled seats by branch in `seatPullRequest` (`#3645`) |
| [#3642](https://github.com/aimpact-inc/repo-harness/pull/3642) | `a139d717e` | Revert of the first prep, and the CHANGELOG rule: a base section is released unless it is the newest untagged one |
| [#3648](https://github.com/aimpact-inc/repo-harness/pull/3648) | `b89d53c83` | Split the seats migration error out of `seats-settings.ts`, which clears the `board.core` finding (`#3632`) |
| [#3649](https://github.com/aimpact-inc/repo-harness/pull/3649) | `687f49564` | Council members start on their native route (`#3644`) |
| [#3651](https://github.com/aimpact-inc/repo-harness/pull/3651) | `f11603f90` | Projection refresh for main `687f49564a3a` |
| [#3650](https://github.com/aimpact-inc/repo-harness/pull/3650) | `4f661fb71` | Owner-authorized seat route overrides and the operator API (`#3641`) |
| [#3652](https://github.com/aimpact-inc/repo-harness/pull/3652) | `a819074cb` | Operator console UI for the seat route overrides (`#3643`) |
| [#3654](https://github.com/aimpact-inc/repo-harness/pull/3654) | `6cb45bd99` | Refresh `docs/architecture/archimap.html` after the 0.38.0 seat override work (`#3653`) |

God-file and co-change findings at the base: 18 of the 19 `low-cohesion-god-file` findings clear. `assets/templates/helpers/capability-resolver.ts` (`#3611`, assessed and kept) stays recorded. The 15 `co-change-coupling` findings are classified as expected feature coupling and are not fixed (`#3613`). The first 0.38.0 prep merged as `#3639` and was withdrawn in `#3642`; no package and no tag was published from it.

## Upgrade

- Run `rh update` once on each host after installing 0.38.0.
- Auto-pilot is off until the owner runs `rh autopilot start` on the orchestrator host. `rh autopilot status` shows ON or OFF, the activation time, the last tick and the active parks, and `rh autopilot stop` ends it at once.
- While auto-pilot is on, `rh board merge` reads the auto-pilot bar: `Required / CI`, answered review-bot comments, a rollback line and two distinct claimed current-head `PASS` rows including one `different-family` row for a Medium or High PR, or the verified accept-seat skip for a Low PR. With auto-pilot off, the earlier merge rules stay.
- A parked unit is `rh board post hold --target <n> --park <category> --reason "<decision>"`. `rh board dispatch` does not skip it, and a strictly newer `rh board post release` clears it.
- A host whose only Node is 26 runs the protected helpers. 0.37.5 declares Node `>=24 <26` and refuses that host.
- A council member now starts on its native CLI (`fable` on Claude, `carbon` on Antigravity, `astra` on Codex). On a host that should keep the Pi launch path, store `seats.council.runtime: "pi"`. A host without the member's native CLI gets the launch error of the missing runtime.
- Seat route overrides are written only in the operator app. The CLI reports them read-only, and `rh seats overrides` lists each active record with its instruction and authorization time.
- See the full [0.38.0 upgrade instructions](../../docs/CHANGELOG.md#upgrade).

## Verification

The prep branch `release/0.38.0` starts at `6cb45bd99`. The commands below ran in the worktree on 2026-11-28, on macOS 26.5 arm64, Bun 1.4.3 and Node 24.22.1.

| Command | Result |
|---|---|
| `bun run check:type` | pass (exit 0) |
| `bun run check:reference-configs` | pass (`projection OK: 22 docs`) |
| `bun scripts/check-changelog-released-sections.ts --base origin/main` | pass (134 released sections keep their bytes; each fragment follows the path form) |
| `bun scripts/check-skill-version.ts` | pass (`repo-harness=0.38.0, template=0.38.0`) |
| `bun scripts/check-archimap-links.ts` | pass (`{"dead":[],"missing":[]}`) |
| `bun scripts/check-released-managed-values.ts` | pass (the index matches 109 release tags) |

`Required / CI` runs on the prep PR. The prep did not run `check:release`, the release lane or the full suite; the owner command list runs `check:release` in step 1 of the release worktree.

## Acceptance environment

Pending: the orchestrator runs `gh workflow run probe.yml --ref release/0.38.0 -f lane=release-rehearsal -f runner=ubuntu-latest` after a joint decision and green `Required / CI`, and records the run URL, `[rehearsal] OK: 0.37.5 -> 0.38.0`, `TARBALL SERVED repo-harness 0.38.0` and `TARBALL SERVED repo-harness-operator-web 0.38.0`. The native Windows item (`#3570`), the Node 26 engine range (`#3582`) and the seat route changes (`#3644`, `#3641`, `#3643`) have no rehearsal runner; their evidence is the replays recorded in their PRs.

## Order of the owner steps

After the prep PR merges, run `git fetch origin` and then `bash scripts/release-owner-steps.sh plan 0.38.0` from the main checkout. Keep the plan. It binds each command to the merged release commit.

1. Create the detached release worktree at the commit from the plan. Run `bun install --frozen-lockfile` and `bun run check:release` there.
2. Run the plan's guard and publish `repo-harness-operator-web@0.38.0` from `packages/operator-web`.
3. Wait for npm to show the Operator Web version. Run the guard again and publish `repo-harness@0.38.0` from the release worktree root.
4. Wait for npm to show the core version. Run `bash scripts/release-owner-steps.sh check published 0.38.0` to verify both packages.
5. Create the annotated tag `v0.38.0` at the release commit and push the tag.
6. Extract the notes with `bash scripts/release-owner-steps.sh notes 0.38.0`. Create the GitHub Release from those notes and the verified tag.
7. Run `bash scripts/release-owner-steps.sh check tagged 0.38.0`.
8. Run `bun scripts/check-released-managed-values.ts --write`. Submit the generated index in one Low PR.

If a step stops, use the saved plan's resume checks to determine which steps already succeeded.

## Publication

Release merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.38.0` | pending | pending | pending |
| 2 | `repo-harness@0.38.0` | pending | pending | pending |

Tag `v0.38.0` and the GitHub Release are pending.

## Post-publish checks

- Record the package and tag readbacks from steps 4 and 7. Record the released managed values PR from step 8.
- After step 7 passes, install `0.38.0` and run `rh update` on the seat hosts.
- Auto-pilot is the owner's call. If the owner starts it, read one `[advisor-plan]` tick in the orchestrator pane and confirm that `rh autopilot status` shows the tick time. Do not start it from a comment or from a test run.
- On a host whose only Node is 26, run `rh doctor` and one protected helper, and confirm that no engine warning and no Node runtime refusal appears. This covers the `#3582` and `#3572` items that the rehearsal cannot reach.
- On a native Windows host, run `rh doctor` and read the three Pi lines (`pi-package`, `pi-cli-version`, `pi-capability`). This covers the `#3570` item.
- Open the operator console Seats page and read each seat row as `Catalog` or `Owner override`. Record one authorized override and its `rh seats overrides` line, then revoke it and confirm the catalog route returns.

## Rollback

Before publication, close the prep PR or run `git revert <squash-commit>` after merge. After publication, keep the tag and release a corrective patch.

Version 0.37.5 has no auto-pilot state, no parking, no auto-pilot merge bar and no seat route overrides, it declares Node `>=24 <26`, and `rh seats council` prefers the Pi route. Keep 0.38.0 on upgraded hosts; if you must return to 0.37.5, reinstall 0.37.5 and run `rh update`, and accept that a host whose only Node is 26 cannot run the protected helpers.
