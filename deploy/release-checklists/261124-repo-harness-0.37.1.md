# repo-harness 0.37.1 publication record

## Release scope

- Release date is 2026-11-24. The release includes `repo-harness` and `repo-harness-operator-web`.
- The base source is `7f0552b3116004a319033a9746d73ef0acb355b0`. The range `v0.37.0..7f0552b31` has 4 commits.
- The owner gave the release word on 2026-11-24 for publishing both packages, creating `v0.37.1` and creating the GitHub Release (logged on `#3477` comment `7132560020`; expectation logged on `#3419` and progress in `#3419` comment `7131741875`).

| PR | Commit | Change |
|---|---|---|
| [#3472](https://github.com/aimpact-inc/repo-harness/pull/3472) | `10d596e79` | Record the 0.37.0 released managed values |
| [#3443](https://github.com/aimpact-inc/repo-harness/pull/3443) | `d5ae4b131` | Cut over to `archctx@0.18.4` and `archctx-contracts@0.18.4` with clean v2 store and pure-Git refactor lifecycle (`#3388`) |
| [#3475](https://github.com/aimpact-inc/repo-harness/pull/3475) | `38d0392cf` | Resolve Antigravity opted-in repo across `workspacePaths` and probe multi-workspace payload in `rh doctor` (`#3473`) |
| [#3476](https://github.com/aimpact-inc/repo-harness/pull/3476) | `7f0552b31` | Refresh generated architecture outputs for `main@38d0392cfd09` |

## Upgrade

- Run `rh update` once on each host after installing 0.37.1 to reconcile the `archctx@0.18.4` / `archctx-contracts@0.18.4` (`ARCHITECTURE_CONTRACT_VERSION` 3) cutover and refresh the installed Antigravity hook bundle.
- After `rh update`, Antigravity (`agy`) seats launched by `rh seats launch` enforce `SessionStart`, `PreToolUse` (I1/I2 guards), `PreInvocation` and `Stop` across `workspacePaths`, and fail closed on `PreToolUse` on multi-repo ambiguity, malformed `workspacePaths`, or corrupted sibling markers. Run `rh doctor` to verify the updated `antigravity-direct-command` multi-workspace guard probe.
- Update callers of `rh arch refactor` and `rh board closeout --json` for the breaking CLI and schema changes: remove `--node`/`--path` on `recommendations` (v3 JSON schema), remove `record` and the removed digest flags on `decide|verify|resolve`, switch `resolve` from `--evidence-digest` to `--resolution-digest`, and read `codegraph_stop_failures` instead of `daemon_stop_failures`.
- See the full [0.37.1 upgrade instructions](../../docs/CHANGELOG.md#upgrade).

## Verification

The prep PR records the local commands, results and tested commit. `Required / CI` runs on the prep PR.

## Acceptance environment

- Run URL: https://github.com/aimpact-inc/repo-harness/actions/runs/45398949739 (`probe.yml`, lane `release-rehearsal`, runner `ubuntu-latest`, ref `main` at `8f57ffdfe`)
- `[rehearsal] OK: 0.37.0 -> 0.37.1`
- `TARBALL SERVED repo-harness 0.37.1`
- `TARBALL SERVED repo-harness-operator-web 0.37.1`

## Order of the owner steps

After the prep PR merges, run `git fetch origin` and then `bash scripts/release-owner-steps.sh plan 0.37.1` from the main checkout. Keep the plan. It binds each command to the merged release commit.

1. Create the detached release worktree at the commit from the plan. Run `bun install --frozen-lockfile` and `bun run check:release` there.
2. Run the plan's guard and publish `repo-harness-operator-web@0.37.1` from `packages/operator-web`.
3. Wait for npm to show the Operator Web version. Run the guard again and publish `repo-harness@0.37.1` from the release worktree root.
4. Wait for npm to show the core version. Run `bash scripts/release-owner-steps.sh check published 0.37.1` to verify both packages.
5. Create the annotated tag `v0.37.1` at the release commit and push the tag.
6. Extract the notes with `bash scripts/release-owner-steps.sh notes 0.37.1`. Create the GitHub Release from those notes and the verified tag.
7. Run `bash scripts/release-owner-steps.sh check tagged 0.37.1`.
8. Run `bun scripts/check-released-managed-values.ts --write`. Submit the generated index in one Low PR.

If a step stops, use the saved plan's resume checks to determine which steps already succeeded.

## Publication

Release merge SHA is `8f57ffdfedab549d0821c73a4dcfbfe9d4d5c660`, the `v0.37.1` tag commit.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.37.1` | `d9a269da2247a59fc2734ba9394e36279ba8b43a` | `sha512-bnUNzHHqpakeZhJfNz2UG/fSJeNpgUF1a3eSiNzmMlJCxVsi9DGiQU7W8xclM6VmRFP+VHH3EPtjR16a8nS75g==` | 129 |
| 2 | `repo-harness@0.37.1` | `0cc2c35f69869f84dad23ff5653a9692006e3c27` | `sha512-dCVei0gmNfiknfymPjiLpE52liv8VBrkiXHfHJts0z4XJWfMVsWnLUKufA1Ka09pN63aZ9AVik5nRqIo7AePqg==` | 819 |

Step 3 stopped on its first attempt at npm web auth (`E404` on `/-/v1/done`, nothing published). The owner reran the publish and `repo-harness@0.37.1` is on `latest`.

Tag `v0.37.1` and the GitHub Release are published: https://github.com/aimpact-inc/repo-harness/releases/tag/v0.37.1 (2026-11-24T14:05:27Z). The release record is https://github.com/aimpact-inc/repo-harness/issues/3419#issuecomment-7133831578.

## Post-publish checks

- Record the package and tag readbacks from steps 4 and 7. Record the released managed values PR from step 8.
- After step 7 passes, install `0.37.1` and run `rh update` on the seat hosts, run `rh doctor` to confirm the multi-workspace `antigravity-direct-command` guard probe, then rerun the `#3416` item 6 live signed-in `agy` reset probe under Option A.

## Rollback

Before publication, close the prep PR or run `git revert <squash-commit>` after merge. After publication, keep the tag and release a corrective patch.

Version 0.37.0 uses `archctx@0.17.1` (`ARCHITECTURE_CONTRACT_VERSION` 2), the retired archctx daemon, v2 refactor recommendation schemas and `cwd`-only Antigravity hook resolution. Keep 0.37.1 on upgraded hosts; if you must return to 0.37.0, reinstall 0.37.0 and run `rh update` to reconcile the `archctx@0.17.1` runtime and host hooks, noting that `agy` seats launched with a non-git agent directory as `cwd` lose hook enforcement on 0.37.0.
