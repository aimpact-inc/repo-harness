# repo-harness 0.38.1 publication record

## Release scope

- Release date is 2026-11-28. The release includes `repo-harness` and `repo-harness-operator-web`.
- The parent release is 0.38.0, tagged `v0.38.0` at `08e0d594f5de2b659359872fce10e3d223cc89a3`. The base source is `231a21d36a6e6937828ae31d86573c4e10c5b10d`. The range `v0.38.0..231a21d36` has 5 commits. Each commit below was read back from Git on 2026-11-28 and its PR number came from the commit's associated pull request.

| PR | Commit | Change |
|---|---|---|
| [#3660](https://github.com/aimpact-inc/repo-harness/pull/3660) | `16a1698ae` | Record the 0.38.0 released managed values |
| [#3659](https://github.com/aimpact-inc/repo-harness/pull/3659) | `46129ba90` | Refresh the zh-CN README summary, add `README.tr.md` and the Türkçe switcher |
| [#3658](https://github.com/aimpact-inc/repo-harness/pull/3658) | `b0d29a489` | Refresh the ja, fr and es README summaries and add the Türkçe switcher |
| [#3663](https://github.com/aimpact-inc/repo-harness/pull/3663) | `a02bfddf2` | Verify the Windows archctx launcher pair in `rh update` (`#3661`) |
| [#3664](https://github.com/aimpact-inc/repo-harness/pull/3664) | `231a21d36` | Opt-in Pi Gemini App Neon route and the `gemini_app` quota account (`#3662`) |

The release set changes no architecture document. `docs/architecture/modules/**` and `docs/architecture/archimap.html` stay at their 0.38.0 render, and the archctx rolling projection PR owns the next render.

## Upgrade

- Run `rh update` once on each host after installing 0.38.1.
- A native Windows host on Node 26 needs this release. 0.38.0 fails its `rh update` with `RH_ARCHCTX_BIN_READBACK` and rolls back, because the Windows archctx readback expected a bare link and the entry is the `.exe` and `.bunx` pair.
- The Gemini App Neon route is opt-in: a seat with `runtime: pi` and model `gemini-app/gemini-neon`. The catalog Pi route, the default seats and the recommended ranges stay on `magpie/agy-cli/gemini-4-neon`, and a seat that keeps that route changes nothing.
- The `gemini_app` quota account reports `unknown` with the reason `no Gemini App quota reader`. The Antigravity quota reader reads Antigravity accounts only.
- See the full [0.38.1 upgrade instructions](../../docs/CHANGELOG.md#upgrade).

## Verification

The prep branch `release/0.38.1` starts at `231a21d36`. The commands below ran in the worktree at `d3b86b1a3db8489e653059d86e481344603646bc` on 2026-11-28, on macOS 26.5 arm64, Bun 1.4.3 and Node 24.22.1.

| Command | Result |
|---|---|
| `bun run check:type` | pass (exit 0) |
| `bun run check:reference-configs` | pass (`projection OK: 22 docs`) |
| `bun scripts/check-changelog-released-sections.ts --base origin/main` | pass (135 released sections keep their bytes; the fragments follow `docs/changelog.d/<issue>.<category>.md`) |
| `bun scripts/check-skill-version.ts` | pass (`repo-harness=0.38.1, template=0.38.1`) |
| `bun scripts/check-archimap-links.ts` | pass (`{"dead":[],"missing":[]}`) |
| `bun scripts/check-released-managed-values.ts` | pass (the index matches 110 release tags) |
| `bash scripts/check-context-files.sh` | pass (`[ContextScan] SAFE`) |

`Required / CI` runs on the prep PR. The prep did not run `check:release`, the release lane or the full suite; the owner command list runs `check:release` in step 1 of the release worktree.

## Acceptance environment

The upgrade rehearsal passed. Run: https://github.com/aimpact-inc/repo-harness/actions/runs/46118188312 (`probe.yml`, lane `release-rehearsal`, `ubuntu-latest`, ref `release/0.38.1` at `18c505f86c01601668316fb34a87353c7d89d620`, conclusion success). The job log holds these lines:

- `[probe] head 18c505f86c01601668316fb34a87353c7d89d620`
- `[rehearsal] parent 0.38.0 -> candidate 0.38.1 (archctx pin 0.18.5)`
- `[rehearsal] OK: 0.38.0 -> 0.38.1`
- `TARBALL SERVED repo-harness 0.38.1`
- `TARBALL SERVED repo-harness-operator-web 0.38.1`

The native Windows item (`#3661`, PR `#3663`) has no rehearsal runner. Its evidence is the staged M2 run recorded in the `#3567` comment 7235449689: Windows 11, Node 26.13.0, Bun 1.4.4, tarball sha256 `643bff5a…9de7` of `231a21d36`; `rh update --no-cli --version 0.38.0` exited 0, `archctx --version` printed 0.18.5, and the install ledger stayed consistent. The `#3567` issue stays open until M2 runs `rh update` to the published 0.38.1.

The Gemini App route item (`#3662`, PR `#3664`) has no rehearsal runner either. Its evidence is the argv probe recorded in PR `#3664`: a scratch config that sets only `worker-neon` to Gemini App gives `pi --provider gemini-app --model gemini-neon --thinking high`.

## Order of the owner steps

After the prep PR merges, run `git fetch origin` and then `bash scripts/release-owner-steps.sh plan 0.38.1` from the main checkout. Keep the plan. It binds each command to the merged release commit.

1. Create the detached release worktree at the commit from the plan. Run `bun install --frozen-lockfile` and `bun run check:release` there.
2. Run the plan's guard and publish `repo-harness-operator-web@0.38.1` from `packages/operator-web`.
3. Wait for npm to show the Operator Web version. Run the guard again and publish `repo-harness@0.38.1` from the release worktree root.
4. Wait for npm to show the core version. Run `bash scripts/release-owner-steps.sh check published 0.38.1` to verify both packages.
5. Create the annotated tag `v0.38.1` at the release commit and push the tag.
6. Extract the notes with `bash scripts/release-owner-steps.sh notes 0.38.1`. Create the GitHub Release from those notes and the verified tag.
7. Run `bash scripts/release-owner-steps.sh check tagged 0.38.1`.
8. Run `bun scripts/check-released-managed-values.ts --write`. Submit the generated index in one Low PR.

If a step stops, use the saved plan's resume checks to determine which steps already succeeded.

## Publication

Release merge SHA is pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.38.1` | pending | pending | pending |
| 2 | `repo-harness@0.38.1` | pending | pending | pending |

Tag `v0.38.1` and the GitHub Release are pending.

## Post-publish checks

- Record the package and tag readbacks from steps 4 and 7. Record the released managed values PR from step 8.
- After step 7 passes, install `0.38.1` and run `rh update` on the seat hosts.
- On the native Windows M2 host (Windows 11, Node 26.13.0), run `rh update` to the published 0.38.1 and record the exit code, `rh --version`, `archctx --version` and the install ledger. This closes `#3567`, and the staged tarball comes off that host.
- On a macOS or Linux host, run `rh update` and confirm that the archctx symlink target proof still passes.
- Set one frontend seat to `runtime: pi` and model `gemini-app/gemini-neon` on a host with the Gemini App sign-in, read `rh seats argv <seat> --json` and the `gemini_app` quota row (`unknown`, `no Gemini App quota reader`), then set the seat back to `magpie/agy-cli/gemini-4-neon`.

## Rollback

Before publication, close the prep PR or run `git revert <squash-commit>` after merge. After publication, keep the tag and release a corrective patch.

Version 0.38.0 fails a Windows `rh update` with `RH_ARCHCTX_BIN_READBACK` and rolls back, and it has no `gemini-app/` model prefix and no `gemini_app` quota account. Keep 0.38.1 on upgraded hosts; if you must return to 0.38.0, reinstall 0.38.0 and run `rh update` on a macOS or Linux host.
