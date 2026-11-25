# repo-harness 0.37.3 publication record

## Release scope

- Release date is 2026-11-25. The release includes `repo-harness` and `repo-harness-operator-web`.
- The base source is `a2fbe47f63f2cb133794ddb333098438ff9eb482`. The range `v0.37.2..a2fbe47f6` has 26 commits.
- Owner release word for publishing both packages, creating `v0.37.3` and creating the GitHub Release is pending (after this prep PR merges; scope logged on `#3536` under batch parent `#3491`).

| PR | Commit | Change |
|---|---|---|
| [#3486](https://github.com/aimpact-inc/repo-harness/pull/3486) | `345627efe` | Record the 0.37.2 released managed values and release filing |
| [#3490](https://github.com/aimpact-inc/repo-harness/pull/3490) | `8058b8b07` | Load the `herdr` skill in `orchestrator` and `advisor` seats and forbid focus-based pane splits (`#3488`) |
| [#3492](https://github.com/aimpact-inc/repo-harness/pull/3492) | `a1a07470b` | I2: Antigravity `UserFileGuard` fails closed with `deny` and a redacted failure record (`#3489`) |
| [#3493](https://github.com/aimpact-inc/repo-harness/pull/3493) | `3979a7b41` | I2: `agy` seats launch with `--dangerously-skip-permissions`; the guard readiness probe requires a protected-overwrite `deny` (`#3487`) |
| [#3498](https://github.com/aimpact-inc/repo-harness/pull/3498) | `51519eaa0` | Add the explicit-only `repo-harness-sharpen` and `repo-harness-reframe` skills (`#3496`) |
| [#3517](https://github.com/aimpact-inc/repo-harness/pull/3517) | `fbf9f278f` | `rh worktrees list` judges checkouts before directory sizing (`#3500`) |
| [#3519](https://github.com/aimpact-inc/repo-harness/pull/3519) | `c132cce48` | Split the refactor e2e suite and report killed subprocesses (`#3516`) |
| [#3515](https://github.com/aimpact-inc/repo-harness/pull/3515) | `f80d5af85` | List the sharpen and reframe skills and refresh `tasks/lessons.md` for 0.37.x (`#3501`) |
| [#3497](https://github.com/aimpact-inc/repo-harness/pull/3497) | `dc09e4c3c` | Name worker tabs by issue and put at most 3 panes in one tab (`#3494`) |
| [#3520](https://github.com/aimpact-inc/repo-harness/pull/3520) | `d41829cec` | Refactor: move write-all-sync into execution-primitives (`#3504`) |
| [#3521](https://github.com/aimpact-inc/repo-harness/pull/3521) | `7fff398a9` | Refactor: break shared operator read dependency cycles (`#3510`) |
| [#3524](https://github.com/aimpact-inc/repo-harness/pull/3524) | `4600c7f0c` | Refactor: move `providers.ts` wiring into its own component (`#3511`) |
| [#3526](https://github.com/aimpact-inc/repo-harness/pull/3526) | `89c1f791c` | Refactor: re-home MCP tool result and version into a shared leaf component (`#3512`) |
| [#3528](https://github.com/aimpact-inc/repo-harness/pull/3528) | `47a319164` | Refactor: declare `docs.ts` as a root-router entrypoint (`#3514`) |
| [#3529](https://github.com/aimpact-inc/repo-harness/pull/3529) | `1ea19fad3` | Projection refresh of generated architecture outputs for main `47a319164` |
| [#3522](https://github.com/aimpact-inc/repo-harness/pull/3522) | `f31bff9b7` | Refactor: extract trusted GitHub CLI resolution (`#3508`) |
| [#3523](https://github.com/aimpact-inc/repo-harness/pull/3523) | `c9b2cc669` | Refactor: extract checkout filesystem and host root primitives (`#3506`) |
| [#3531](https://github.com/aimpact-inc/repo-harness/pull/3531) | `4d0d4aa99` | Apply sharpen and reframe rigor to the PRD, issue-flow and seat briefs (`#3495`) |
| [#3518](https://github.com/aimpact-inc/repo-harness/pull/3518) | `7daa50ae5` | Keep the ChatGPT quota normal on available credits (`#3499`) |
| [#3525](https://github.com/aimpact-inc/repo-harness/pull/3525) | `15e7463fe` | Refactor: re-home `repo-harness-home` to `execution-primitives.primary` (`#3513`) |
| [#3532](https://github.com/aimpact-inc/repo-harness/pull/3532) | `35c6ce720` | Refactor: declare the host-installer public surface as entrypoints (`#3527`) |
| [#3534](https://github.com/aimpact-inc/repo-harness/pull/3534) | `068a42ab1` | Refactor: extract shared version and upgrade command helpers (`#3509`) |
| [#3533](https://github.com/aimpact-inc/repo-harness/pull/3533) | `8337b899e` | Projection refresh of generated architecture outputs for main `068a42ab1` |
| [#3535](https://github.com/aimpact-inc/repo-harness/pull/3535) | `be5e0462e` | Refactor: decouple review collection and publication layers (`#3507`) |
| [#3538](https://github.com/aimpact-inc/repo-harness/pull/3538) | `7d6d50c5d` | Refactor: split shared hook contracts from dispatch and guards; guard behaviour unchanged (`#3505`) |
| [#3537](https://github.com/aimpact-inc/repo-harness/pull/3537) | `a2fbe47f6` | Retire GPT-6.1 Terra from seat settings; default `worker` is GPT-6.2 Sol (`#3502`) |

## Upgrade

- Run `rh update` once on each host after installing 0.37.3. It installs the fail-closed Antigravity hook and the `repo-harness-sharpen` and `repo-harness-reframe` skills.
- Run `rh update` before you launch `agy` seats. A host that keeps the 0.37.2 hook returns `force_ask` on the readiness probe, and `rh seats launch` refuses the seat with `antigravity_guard_unready`.
- Antigravity sessions no longer prompt for an overwrite of an existing user file outside the allowed roots; the hook denies it.
- A seat configuration that saves `gpt-6.1-terra` or `magpie/codex/gpt-6.1-terra` keeps working after the update. Select a replacement model, for example GPT-6.2 Sol, in Settings before you save the seat configuration again.
- See the full [0.37.3 upgrade instructions](../../docs/CHANGELOG.md#upgrade).

## Verification

The prep PR records the local commands, results and tested commit. `Required / CI` runs on the prep PR.

## Acceptance environment

Pending: the orchestrator runs `gh workflow run probe.yml --ref release/0.37.3 -f lane=release-rehearsal -f runner=ubuntu-latest` after a joint decision and green `Required / CI`, and records the run URL, `[rehearsal] OK: 0.37.2 -> 0.37.3`, `TARBALL SERVED repo-harness 0.37.3`, and `TARBALL SERVED repo-harness-operator-web 0.37.3`.

## Order of the owner steps

After the prep PR merges, run `git fetch origin` and then `bash scripts/release-owner-steps.sh plan 0.37.3` from the main checkout. Keep the plan. It binds each command to the merged release commit.

1. Create the detached release worktree at the commit from the plan. Run `bun install --frozen-lockfile` and `bun run check:release` there.
2. Run the plan's guard and publish `repo-harness-operator-web@0.37.3` from `packages/operator-web`.
3. Wait for npm to show the Operator Web version. Run the guard again and publish `repo-harness@0.37.3` from the release worktree root.
4. Wait for npm to show the core version. Run `bash scripts/release-owner-steps.sh check published 0.37.3` to verify both packages.
5. Create the annotated tag `v0.37.3` at the release commit and push the tag.
6. Extract the notes with `bash scripts/release-owner-steps.sh notes 0.37.3`. Create the GitHub Release from those notes and the verified tag.
7. Run `bash scripts/release-owner-steps.sh check tagged 0.37.3`.
8. Run `bun scripts/check-released-managed-values.ts --write`. Submit the generated index in one Low PR.

If a step stops, use the saved plan's resume checks to determine which steps already succeeded.

## Publication

Release merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.37.3` | pending | pending | pending |
| 2 | `repo-harness@0.37.3` | pending | pending | pending |

Tag `v0.37.3` and the GitHub Release are pending.

## Post-publish checks

- Record the package and tag readbacks from steps 4 and 7. Record the released managed values PR from step 8.
- After step 7 passes, install `0.37.3` and run `rh update` on the seat hosts. Then launch one `agy` seat with `--dangerously-skip-permissions` on the installed package and confirm that the readiness probe passes and a protected-file overwrite gets `deny` (`#3493` risk line), so batch parent `#3491` can close.

## Rollback

Before publication, close the prep PR or run `git revert <squash-commit>` after merge. After publication, keep the tag and release a corrective patch.

Version 0.37.2 launches `agy` seats with `--mode accept-edits` and its Antigravity hook returns `force_ask`, which `agy 1.5.16` approves without a prompt. Keep 0.37.3 on upgraded hosts; if you must return to 0.37.2, reinstall 0.37.2 and run `rh update`, and do not launch `agy` seats on it.
