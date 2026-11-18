# repo-harness 0.35.1 publication record

## Release scope

- Release date: UTC 2026-11-18. Parent [#3201](https://github.com/aimpact-inc/repo-harness/issues/3201); no separate release issue.
- Owner word, given locally at 21:35 (+08) and recorded in [#3201 comment 6980164312](https://github.com/aimpact-inc/repo-harness/issues/3201#issuecomment-6980164312) at 2026-11-18T13:35:59Z: 「发0.35.1」. The recorded reading: release 0.35.1 after PR #3203 and this prep PR merge and `check:release` exits 0. #3207 and #3208 merge after the publish, for the next minor. Then refresh this Mac and mini-cf.
- Source commit before release prep: `dab094af97b0d4134e9996d6d38a525806e9ee49` (#3203). The release range is `v0.35.0..dab094af9`: 3 commits and no changelog fragments on main. Main merges are frozen until this PR merges.
- Patch release: no Breaking line. No command, option, setting, protocol or managed file name leaves the package in this range.
- Release prep added one Fixed entry, from the merged PR, for each user-visible change: #3202 (#3200) and #3203 (#3201). #3199 gets the Fixed line "Rebuild the released managed values list for v0.35.0", as #3063 did in 0.35.0. The Upgrade entry names the 0.34.0 host path that #3203 repairs.

| PR | Commit | Change |
|---|---|---|
| [#3199](https://github.com/aimpact-inc/repo-harness/pull/3199) | `e3f01e149` | chore(release): record 0.35.0 released managed values (#3199) |
| [#3202](https://github.com/aimpact-inc/repo-harness/pull/3202) | `74fc5da52` | fix(cli): rh and the hook start without HOME; requireHome accepts USERPROFILE (#3200) |
| [#3203](https://github.com/aimpact-inc/repo-harness/pull/3203) | `dab094af9` | fix(installer): skill sync adopts an existing link whose target equals the desired source (#3201) |

## Upgrade

`rh update` (it runs `rh install` for the hosts) refreshes these managed surfaces on each host:

- The Global Working Rules block in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, through the gate with the `marked-block` strategy. The block text does not change in this range.
- The hook adapters in `~/.claude/settings.json` and `~/.codex/hooks.json`, and the hook code: `repo-harness-hook` starts without `HOME` and resolves the account home from `HOME`, else `USERPROFILE` (#3202).
- The bundled skills and their links. The skill sync adopts and records an unrecorded link whose target is exactly the package source of that skill (#3203).

User actions:

- A 0.34.0 host with unrecorded facade skill links (for example `~/.codex/skills/repo-harness-{orchestrator,advisor,seat-handoff}`) now updates without a manual move of those links. A link to another target, a file or a directory at such a path still stops the update with the refusal and its move-out step.
- A 0.35.0 host needs no other step: install state protocol 4 and ledger protocol 2 stay.

## Verification

On Darwin arm64 with Bun 1.4.4, at the prep commit on source `dab094af9`:

- `bun install --frozen-lockfile`: pass.
- `bun run check:type`: pass.
- `bun scripts/check-skill-version.ts`: pass, repo-harness=0.35.1, template=0.35.1.
- `bun scripts/check-changelog-released-sections.ts --base origin/main`: pass, 124 released sections keep their bytes.
- `bun run check:cli-manifest`: pass.
- `bun run check:release` (`scripts/check-npm-release.sh`): pass, exit 0. It ran the tarball smoke with the script's own mkdtemp HOME and registry under `/tmp`, with no outer HOME wrapper: `repo-harness-0.35.1.tgz installs, serves the packaged Operator, and packaged CLI bins start`; mcp serve loads 34 MCP modules, operator serve loads 84 Operator modules.
- `git diff --check`: pass.
- `bun run test:files tests/skill-version.test.ts tests/bootstrap-files.test.ts tests/readme-dx.test.ts tests/scaffold-parity.test.ts tests/installed-copy-sync.test.ts --timeout 60000 --max-concurrency 1`: pass, exit 0, 73 tests in 5 files (13, 17, 5, 2 and 36), 0 fail.

`Required / CI` is pending.

## Order of the owner steps

1. Merge the prep PR under rule 2 after `Required / CI` and the recorded verification pass.
2. On main, run `git fetch origin && bash scripts/release-owner-steps.sh plan 0.35.1`. The plan binds the steps to the release commit.
3. Run the authorized plan in order. Publish `repo-harness-operator-web` before `repo-harness`. Confirm the npm login, then create the tag and GitHub Release. Resume a partial run by the plan's rules.
4. After step 7, run step 8 (`bun scripts/check-released-managed-values.ts --write`) and merge its file in one Low PR.
5. The owner word covers the refresh of this Mac and mini-cf. On each host, run `bun add -g repo-harness@0.35.1 --no-cache && rh update --version 0.35.1` before a seat relaunch.

## Publication

Publish candidate merge SHA: pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.35.1` | pending | pending | pending |
| 2 | `repo-harness@0.35.1` | pending | pending | pending |

Publish both packages, create tag `v0.35.1` and create the GitHub Release: pending.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.35.1` and `bash scripts/release-owner-steps.sh check tagged 0.35.1`: pending.
- Rebuild released managed values in the post-release PR: pending.
- Refresh this Mac and mini-cf to 0.35.1: pending.

## Rollback

Before publication, close the prep PR or revert its squash commit. After publication, retain the tag and use a patch release for a correction. A host downgrade from 0.35.1 to 0.35.0 needs no migration step, because both read install state protocol 4 and ledger protocol 2. `src/effects/host-config/store.ts` does not change in this range, and the 0.35.0 `validPathRecord` accepts the record of an adopted link (`created`, baseline `unknown`, committed `symlink`); a downgrade below 0.35.0 follows the 0.35.0 rule: run `rh uninstall` with 0.35.0 first.
