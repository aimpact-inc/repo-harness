# repo-harness 0.37.2 publication record

## Release scope

- Release date is 2026-11-25. The release includes `repo-harness` and `repo-harness-operator-web`.
- The base source is `6ef0627ca956ad057c140fac1a9accd9c8208395`. The range `v0.37.1..6ef0627ca` has 3 commits.
- Owner release word for publishing both packages, creating `v0.37.2` and creating the GitHub Release is pending (after this prep PR merges; scope logged on `#3484` under batch parent `#3419`).

| PR | Commit | Change |
|---|---|---|
| [#3479](https://github.com/aimpact-inc/repo-harness/pull/3479) | `0c4869a32` | Record the 0.37.1 released managed values and release filing |
| [#3481](https://github.com/aimpact-inc/repo-harness/pull/3481) | `47c8dfad8` | Detect waiting nested interactive login shell and pass `-i <prompt>` with offset-0 transcript read on `agy` reset relaunch (`#3480`) |
| [#3483](https://github.com/aimpact-inc/repo-harness/pull/3483) | `6ef0627ca` | Materialize content-addressed `agy` seat `agent.md` file records under `~/.gemini/config/agents` and drop `--add-dir` (`#3474`) |

## Upgrade

- Run `rh update` once on each host after installing 0.37.2. Antigravity (`agy`) seats launched after the update materialize content-addressed agent definitions at `~/.gemini/config/agents/rh-<role>-<digest12>/agent.md` without `--add-dir` (making the target checkout workspace 0) and use `-i <prompt>` with nested-shell detection during `rh seats reset`.
- `rh uninstall --target antigravity` reverts unchanged recorded seat agent files under `~/.gemini/config/agents/` and removes rh-created directories only when empty with verified identity.
- Earlier `agy` seat agent trees under `~/.repo-harness/seats/agy/` are no longer used and are not removed automatically.
- See the full [0.37.2 upgrade instructions](../../docs/CHANGELOG.md#upgrade).

## Verification

The prep PR records the local commands, results and tested commit. `Required / CI` runs on the prep PR.

## Acceptance environment

Pending: the orchestrator runs `gh workflow run probe.yml --ref release/0.37.2 -f lane=release-rehearsal -f runner=ubuntu-latest` after a joint decision and green `Required / CI`, and records the run URL, `[rehearsal] OK: 0.37.1 -> 0.37.2`, `TARBALL SERVED repo-harness 0.37.2`, and `TARBALL SERVED repo-harness-operator-web 0.37.2`.

## Order of the owner steps

After the prep PR merges, run `git fetch origin` and then `bash scripts/release-owner-steps.sh plan 0.37.2` from the main checkout. Keep the plan. It binds each command to the merged release commit.

1. Create the detached release worktree at the commit from the plan. Run `bun install --frozen-lockfile` and `bun run check:release` there.
2. Run the plan's guard and publish `repo-harness-operator-web@0.37.2` from `packages/operator-web`.
3. Wait for npm to show the Operator Web version. Run the guard again and publish `repo-harness@0.37.2` from the release worktree root.
4. Wait for npm to show the core version. Run `bash scripts/release-owner-steps.sh check published 0.37.2` to verify both packages.
5. Create the annotated tag `v0.37.2` at the release commit and push the tag.
6. Extract the notes with `bash scripts/release-owner-steps.sh notes 0.37.2`. Create the GitHub Release from those notes and the verified tag.
7. Run `bash scripts/release-owner-steps.sh check tagged 0.37.2`.
8. Run `bun scripts/check-released-managed-values.ts --write`. Submit the generated index in one Low PR.

If a step stops, use the saved plan's resume checks to determine which steps already succeeded.

## Publication

Release merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.37.2` | pending | pending | pending |
| 2 | `repo-harness@0.37.2` | pending | pending | pending |

Tag `v0.37.2` and the GitHub Release are pending.

## Post-publish checks

- Record the package and tag readbacks from steps 4 and 7. Record the released managed values PR from step 8.
- After step 7 passes, install `0.37.2` and run `rh update` on the seat hosts, then rerun the `#3416` item 6 live signed-in `agy` seat reset probe so `#3416` and batch parent `#3419` can close.

## Rollback

Before publication, close the prep PR or run `git revert <squash-commit>` after merge. After publication, keep the tag and release a corrective patch.

Version 0.37.1 launches `agy` seats with `--add-dir` from `~/.repo-harness/seats/agy/` and uses the pre-`#3481` `rh seats reset` relaunch handshake. Keep 0.37.2 on upgraded hosts; if you must return to 0.37.1, run `rh uninstall --target antigravity` first if you want unchanged `~/.gemini/config/agents/rh-<role>-<digest12>/agent.md` records reverted, then reinstall 0.37.1 and run `rh update`. Note that `agy` seats on 0.37.1 lose nested-shell reset detection, `-i` relaunch, and workspace-0 checkout placement.
