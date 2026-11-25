# repo-harness 0.37.4 publication record

## Release scope

- Release date is 2026-11-26. The release includes `repo-harness` and `repo-harness-operator-web`.
- The base source is `69a8b864da8a79c3c7c1b0f537c12c2b757fe5c1`. The range `v0.37.3..69a8b864d` has 7 commits.
- Owner release word for publishing both packages, creating `v0.37.4` and creating the GitHub Release is pending (after this prep PR merges; scope logged on `#3552`).

| PR | Commit | Change |
|---|---|---|
| [#3540](https://github.com/aimpact-inc/repo-harness/pull/3540) | `d70d5d669` | Projection refresh of generated architecture outputs for main `da8044050d1a` |
| [#3541](https://github.com/aimpact-inc/repo-harness/pull/3541) | `7bbf7ac7d` | Record the 0.37.3 released managed values (`#3536`) |
| [#3544](https://github.com/aimpact-inc/repo-harness/pull/3544) | `105985312` | Skip repository Git hooks on registered refresh commits (`#3543`) |
| [#3548](https://github.com/aimpact-inc/repo-harness/pull/3548) | `6bd7b4d0d` | `rh init` stops seeding the placeholder `docs/architecture/index.md` (`#3547`) |
| [#3549](https://github.com/aimpact-inc/repo-harness/pull/3549) | `f9eeae6d9` | Deliver the managed Global Working Rules to Pi `~/.pi/agent/AGENTS.md` with the filename-precedence refusal (`#3546`) |
| [#3545](https://github.com/aimpact-inc/repo-harness/pull/3545) | `c78949009` | I2: sweep, board closeout and explicit cleanup share one removal proof; sweep and board closeout keep an unknown occupancy, explicit cleanup keeps main's occupancy behavior (`#3542`; the Windows observer is `#3550`) |
| [#3551](https://github.com/aimpact-inc/repo-harness/pull/3551) | `69a8b864d` | Projection refresh of generated architecture outputs for main `c7894900916a` |

## Upgrade

- Run `rh update` once on each host after installing 0.37.4.
- A Pi host whose `~/.pi/agent` holds `AGENTS.override.md` gets a refusal that names that file, because the override would shadow the block. A Pi host that holds `CLAUDE.md` and no `AGENTS.md` gets a refusal that names it, because the new block would shadow the file. Remove or rename the named file, or move your text into it, before you select Pi again.
- See the full [0.37.4 upgrade instructions](../../docs/CHANGELOG.md#upgrade).

## Verification

The prep PR records the local commands, results and tested commit. `Required / CI` runs on the prep PR.

## Acceptance environment

Pending: the orchestrator runs `gh workflow run probe.yml --ref release/0.37.4 -f lane=release-rehearsal -f runner=ubuntu-latest` after a joint decision and green `Required / CI`, and records the run URL, `[rehearsal] OK: 0.37.3 -> 0.37.4`, `TARBALL SERVED repo-harness 0.37.4`, and `TARBALL SERVED repo-harness-operator-web 0.37.4`.

## Order of the owner steps

After the prep PR merges, run `git fetch origin` and then `bash scripts/release-owner-steps.sh plan 0.37.4` from the main checkout. Keep the plan. It binds each command to the merged release commit.

1. Create the detached release worktree at the commit from the plan. Run `bun install --frozen-lockfile` and `bun run check:release` there.
2. Run the plan's guard and publish `repo-harness-operator-web@0.37.4` from `packages/operator-web`.
3. Wait for npm to show the Operator Web version. Run the guard again and publish `repo-harness@0.37.4` from the release worktree root.
4. Wait for npm to show the core version. Run `bash scripts/release-owner-steps.sh check published 0.37.4` to verify both packages.
5. Create the annotated tag `v0.37.4` at the release commit and push the tag.
6. Extract the notes with `bash scripts/release-owner-steps.sh notes 0.37.4`. Create the GitHub Release from those notes and the verified tag.
7. Run `bash scripts/release-owner-steps.sh check tagged 0.37.4`.
8. Run `bun scripts/check-released-managed-values.ts --write`. Submit the generated index in one Low PR.

If a step stops, use the saved plan's resume checks to determine which steps already succeeded.

## Publication

Release merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.37.4` | pending | pending | pending |
| 2 | `repo-harness@0.37.4` | pending | pending | pending |

Tag `v0.37.4` and the GitHub Release are pending.

## Post-publish checks

- Record the package and tag readbacks from steps 4 and 7. Record the released managed values PR from step 8.
- After step 7 passes, install `0.37.4` and run `rh update` on the seat hosts. Then select the Pi plugin on one host and confirm that `~/.pi/agent/AGENTS.md` carries the Global Working Rules block, and that a host with `~/.pi/agent/AGENTS.override.md` gets a refusal that names the file (`#3549` risk line).

## Rollback

Before publication, close the prep PR or run `git revert <squash-commit>` after merge. After publication, keep the tag and release a corrective patch.

Version 0.37.3 seeds the placeholder `docs/architecture/index.md` on init, runs registered-repository Git hooks on refresh commits and delivers no Pi Global Working Rules. Keep 0.37.4 on upgraded hosts; if you must return to 0.37.3, reinstall 0.37.3 and run `rh update`.
