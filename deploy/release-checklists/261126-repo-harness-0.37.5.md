# repo-harness 0.37.5 publication record

## Release scope

- Release date is 2026-11-26. The release includes `repo-harness` and `repo-harness-operator-web`.
- The base source is `06207f40bf1fe05e59d9e8000c6803a2c63ef99f`. The range `v0.37.4..06207f40b` has 6 commits.
- Owner release word for publishing both packages, creating `v0.37.5` and creating the GitHub Release is pending (after this prep PR merges; scope logged on `#3564`).

| PR | Commit | Change |
|---|---|---|
| [#3554](https://github.com/aimpact-inc/repo-harness/pull/3554) | `f51d49f64` | Record the 0.37.4 released managed values (`#3552`) |
| [#3556](https://github.com/aimpact-inc/repo-harness/pull/3556) | `2202569a2` | I2: managed sweep rotates its live-checkout and pruned-intent batches so a slow or kept checkout cannot starve the rest (`#3555`) |
| [#3558](https://github.com/aimpact-inc/repo-harness/pull/3558) | `debc72faa` | I2: native Windows process CWD observer with directory identity matching for managed sweep and board closeout; a live or unproved occupancy keeps the checkout (`#3550` item 1) |
| [#3559](https://github.com/aimpact-inc/repo-harness/pull/3559) | `398bd2747` | I2: explicit `rh worktrees cleanup` preview and apply use the same occupancy proof, with volume-serial disjointness for share-limited paths (`#3550` item 2) |
| [#3562](https://github.com/aimpact-inc/repo-harness/pull/3562) | `3e0121489` | Native Windows `rh install`: skill sync path, junction links without symlink privilege, and one Windows launcher rule that never starts a checkout-supplied executable in a read-only probe (`#3560`) |
| [#3563](https://github.com/aimpact-inc/repo-harness/pull/3563) | `06207f40b` | Projection refresh of generated architecture outputs for main `3e0121489241` |

## Upgrade

- Run `rh update` once on each host after installing 0.37.5.
- On native Windows, explicit `rh worktrees cleanup <slug>` now refuses a checkout that a live process holds, and keeps one whose occupancy it cannot prove; a clean merged checkout with no occupant is still removed. Managed sweep and board closeout rotate their batches, so a kept entry no longer blocks the rest across runs (`#3556`, `#3558`, `#3559`).
- On native Windows, `rh install` completes for a standard, non-elevated account without symlink privilege or Developer Mode, and a read-only tooling probe refuses a launcher that the checkout supplies (`#3562`).
- See the full [0.37.5 upgrade instructions](../../docs/CHANGELOG.md#upgrade).

## Verification

The prep PR records the local commands, results and tested commit. `Required / CI` runs on the prep PR.

## Acceptance environment

Pending: the orchestrator runs `gh workflow run probe.yml --ref release/0.37.5 -f lane=release-rehearsal -f runner=ubuntu-latest` after a joint decision and green `Required / CI`, and records the run URL, `[rehearsal] OK: 0.37.4 -> 0.37.5`, `TARBALL SERVED repo-harness 0.37.5`, and `TARBALL SERVED repo-harness-operator-web 0.37.5`. Both Windows items (`#3558`, `#3559`) and the Windows install path (`#3562`) have no rehearsal runner; their evidence is the native Windows 11 replays recorded in those PRs.

## Order of the owner steps

After the prep PR merges, run `git fetch origin` and then `bash scripts/release-owner-steps.sh plan 0.37.5` from the main checkout. Keep the plan. It binds each command to the merged release commit.

1. Create the detached release worktree at the commit from the plan. Run `bun install --frozen-lockfile` and `bun run check:release` there.
2. Run the plan's guard and publish `repo-harness-operator-web@0.37.5` from `packages/operator-web`.
3. Wait for npm to show the Operator Web version. Run the guard again and publish `repo-harness@0.37.5` from the release worktree root.
4. Wait for npm to show the core version. Run `bash scripts/release-owner-steps.sh check published 0.37.5` to verify both packages.
5. Create the annotated tag `v0.37.5` at the release commit and push the tag.
6. Extract the notes with `bash scripts/release-owner-steps.sh notes 0.37.5`. Create the GitHub Release from those notes and the verified tag.
7. Run `bash scripts/release-owner-steps.sh check tagged 0.37.5`.
8. Run `bun scripts/check-released-managed-values.ts --write`. Submit the generated index in one Low PR.

If a step stops, use the saved plan's resume checks to determine which steps already succeeded.

## Publication

Release merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.37.5` | pending | pending | pending |
| 2 | `repo-harness@0.37.5` | pending | pending | pending |

Tag `v0.37.5` and the GitHub Release are pending.

## Post-publish checks

- Record the package and tag readbacks from steps 4 and 7. Record the released managed values PR from step 8.
- After step 7 passes, install `0.37.5` and run `rh update` on the seat hosts.
- On a native Windows host, hold a shell CWD inside a managed checkout and run `rh worktrees cleanup <slug>`: preview and apply must report `process_in_use` and keep the checkout. After the occupant exits, apply must remove it. This covers the `#3559` path that the rehearsal cannot reach, and the `#3558` share-limited `process_unknown` case: an SMB or mapped-drive CWD with no provable ancestry must keep the checkout.
- On a native Windows host with a standard account, verify `rh install` exits `0` and that the written skill links are NTFS directory junctions (`fsutil reparsepoint query` reports tag `0xa0000003`). The `#3562` local proof ran on a host where Developer Mode was enabled, so the absent-privilege case is the one to read back.
- Verify sweep rotation on the seat host: with more eligible checkouts than one batch holds, three ordinary sweeps must reach the entries that earlier runs kept (`#3556`).

## Rollback

Before publication, close the prep PR or run `git revert <squash-commit>` after merge. After publication, keep the tag and release a corrective patch.

Version 0.37.4 does not prove process occupancy for explicit `rh worktrees cleanup`, never rotates its sweep batches, and its `rh install` fails and rolls back on native Windows. Keep 0.37.5 on upgraded hosts; if you must return to 0.37.4, reinstall 0.37.4 and run `rh update`.
