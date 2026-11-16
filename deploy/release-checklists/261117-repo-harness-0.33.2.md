# repo-harness 0.33.2 publication record

## Release scope

- Release date: UTC 2026-11-17. Parent [#2742](https://github.com/aimpact-inc/repo-harness/issues/2742); no separate release issue.
- Owner word, relayed locally by the advisor seat and recorded in [#2742 comment 6924525557](https://github.com/aimpact-inc/repo-harness/issues/2742#issuecomment-6924525557) at 2026-11-16T17:55:00Z: "那你等一起，发0.33.2吧，我不想再发一个，下一版就直接跳0.34了". The recorded reading: one release, version 0.33.2; the next release is 0.34.0.
- The recorded reading cuts the release after #2936 and #2926 (#2916) merge. #2936 merged as `e95dee83b` (#2949). PR #2926 is open at the source commit. When it merges, this prep PR rebases and assembles its fragment into `## [0.33.2]`.
- #2898, #2922, #2894 and #2893 stay out of this release; they merge after the `v0.33.2` tag.
- Source commit before release prep: `a88a201e59c17726cd935b3404a3dfff7bbb8977`. The release range is `v0.33.1..a88a201e5`, 56 commits, 27 changelog fragments.
- Breaking removals ship in this patch version because the owner chose 0.33.2: #2863 removes `rh init-hook`, `rh update --check`, `rh update --no-runtime-refresh` and `rh update --check-updates`; #2867 replaces `rh board migrate-dependencies --write` with `--apply`.
- Release prep correction: the #2798 Fixed entry named `rh update --check`, which #2863 removes in the same release. The entry now names `rh setup check` only.
- These changes have no changelog entry: #2862 (`rh commands`), #2868 (`rh bots`), #2870 (`rh arch <command>`), #2913 (Pi review seats load the hook extension), #2923 (dispatch packet Authority line), #2843 (fleet saves user agents), #2844 (installer owns Herdr skill copies), #2917 (seats settings save decoder), #2814 and #2928 (maintenance-triage themes), #2823 to #2826 (operator console diagrams).

| PR | Commit | Change |
|---|---|---|
| [#2797](https://github.com/aimpact-inc/repo-harness/pull/2797) | `8fbc6714c` | fix(release): rebuild managed values for v0.33.1 (#2793) |
| [#2801](https://github.com/aimpact-inc/repo-harness/pull/2801) | `90b6b4ee2` | fix(doctor): mark CodeGraph index not applicable outside repositories (#2784) |
| [#2803](https://github.com/aimpact-inc/repo-harness/pull/2803) | `6b407ecda` | fix(adoption): retire the check:brain and sync:brain package scripts (#2795) |
| [#2802](https://github.com/aimpact-inc/repo-harness/pull/2802) | `1e0901c8a` | fix(review): name the retired protocol and the invalid keys in receipt errors (#2800) |
| [#2804](https://github.com/aimpact-inc/repo-harness/pull/2804) | `2f5f16698` | fix(doctor): treat the hoisted archctx at the pin as managed (#2783) |
| [#2805](https://github.com/aimpact-inc/repo-harness/pull/2805) | `cc7cf86f8` | feat(seats): an owner exception for the quota reservation and an unavailable provider list (#2769) |
| [#2828](https://github.com/aimpact-inc/repo-harness/pull/2828) | `25957bf14` | fix(cli): a remediation argv that rh accepts (#2798) |
| [#2830](https://github.com/aimpact-inc/repo-harness/pull/2830) | `bd139f5a4` | docs(lessons-retro): define cumulative Seen and Missed by: unknown (#2812) |
| [#2831](https://github.com/aimpact-inc/repo-harness/pull/2831) | `a07ceed91` | docs(adr): decide the test budget result contract (#2816) |
| [#2834](https://github.com/aimpact-inc/repo-harness/pull/2834) | `67e13cc86` | fix(cli-name): stop reporting a repository slug as a retired command call (#2799) |
| [#2835](https://github.com/aimpact-inc/repo-harness/pull/2835) | `8b370f12f` | docs(researches): measure Eraser Diagrams rendering for G39 (#2822) |
| [#2832](https://github.com/aimpact-inc/repo-harness/pull/2832) | `155b7a6c9` | docs(prds): add gap G39 to the operator console PRD (#2821) |
| [#2837](https://github.com/aimpact-inc/repo-harness/pull/2837) | `85bdeb953` | docs(prds): land the ledger enforcement and test-budget PRD (#2811) |
| [#2833](https://github.com/aimpact-inc/repo-harness/pull/2833) | `f4a907ffd` | docs(lessons): migrate the 16 entries to the Lessons Retro fields (#2813) |
| [#2836](https://github.com/aimpact-inc/repo-harness/pull/2836) | `88dd5c4f6` | fix(review): no sandboxed review process holds a native credential (#2764) |
| [#2840](https://github.com/aimpact-inc/repo-harness/pull/2840) | `699a8f783` | feat(operator): validate a diagram JSON block before any render (#2823) |
| [#2857](https://github.com/aimpact-inc/repo-harness/pull/2857) | `98a4ff9ea` | feat(maintenance-triage): list judgment themes from cumulative Seen (#2814) |
| [#2858](https://github.com/aimpact-inc/repo-harness/pull/2858) | `df01a1b4a` | docs(architecture): the acceptance-review sandbox row drops the copied auth.json (#2808) |
| [#2829](https://github.com/aimpact-inc/repo-harness/pull/2829) | `8a50c2ce8` | feat(upgrade): open one refresh PR per registered repo with --pr (#2320) |
| [#2839](https://github.com/aimpact-inc/repo-harness/pull/2839) | `462f0935d` | feat(seats): add the read-only gatekeeper-deep review seat (#2796) |
| [#2877](https://github.com/aimpact-inc/repo-harness/pull/2877) | `320ead851` | fix(fleet): save user agents before forced replacement (#2843) |
| [#2856](https://github.com/aimpact-inc/repo-harness/pull/2856) | `37bb9d559` | feat(test-budget): TestBudget rule, exception parser and rules policy section (#2817) |
| [#2876](https://github.com/aimpact-inc/repo-harness/pull/2876) | `cc4f0724f` | fix(uninstall): keep an edited rules block and report Codex hook trust as a note (#2842) |
| [#2891](https://github.com/aimpact-inc/repo-harness/pull/2891) | `b1e48b16e` | feat(test-budget): job summary of the TestBudget result (#2820) |
| [#2875](https://github.com/aimpact-inc/repo-harness/pull/2875) | `f68a70275` | docs(architecture): declare the host-config component and its write boundary (#2845) |
| [#2892](https://github.com/aimpact-inc/repo-harness/pull/2892) | `c4906daef` | chore(projection): refresh generated architecture outputs for main@f68a70275440 |
| [#2859](https://github.com/aimpact-inc/repo-harness/pull/2859) | `fc3d46cdc` | feat(operator): render a docs diagram when it changes and show it as an image (#2824) |
| [#2902](https://github.com/aimpact-inc/repo-harness/pull/2902) | `c6f8c7499` | test(oar-host): replace wall-clock upper bounds in the deadline-stop test with order assertions |
| [#2901](https://github.com/aimpact-inc/repo-harness/pull/2901) | `1e26f3aed` | feat(operator): export a shown diagram as the stored SVG on request (#2825) |
| [#2895](https://github.com/aimpact-inc/repo-harness/pull/2895) | `43ab7df07` | feat(operator): one command returns the PNG of a diagram for agent readback (#2826) |
| [#2907](https://github.com/aimpact-inc/repo-harness/pull/2907) | `2b758d771` | test: fixture bun is an exec wrapper, not a symlink to the real binary |
| [#2855](https://github.com/aimpact-inc/repo-harness/pull/2855) | `6501c27e8` | feat(review): packet names round, harness and hand-off; collect binds Pi and Claude sessions by packet (#2838) |
| [#2920](https://github.com/aimpact-inc/repo-harness/pull/2920) | `0b70a54b7` | feat(arch): rh arch runs any command of the pinned archctx (#2870) |
| [#2924](https://github.com/aimpact-inc/repo-harness/pull/2924) | `c4c5ca24d` | docs(prds): design brief for the Rules workspace of the operator console (#2884) |
| [#2918](https://github.com/aimpact-inc/repo-harness/pull/2918) | `d57c4d20b` | feat(seats): Pi review seats load the rh hook extension (#2913) |
| [#2925](https://github.com/aimpact-inc/repo-harness/pull/2925) | `5dedf0e3d` | feat(board): the dispatch packet carries the worker Authority line (#2923) |
| [#2914](https://github.com/aimpact-inc/repo-harness/pull/2914) | `d7ee6eccb` | feat(quota): the exhausted line is a seats.routing setting (default 95) (#2909) |
| [#2912](https://github.com/aimpact-inc/repo-harness/pull/2912) | `a691cf44c` | fix(installer): own the marked Herdr skill copies under core (#2844, P-a) |
| [#2929](https://github.com/aimpact-inc/repo-harness/pull/2929) | `f509d7542` | docs(adr): ADR-0005 no task inbox write from the operator console (#2883) |
| [#2928](https://github.com/aimpact-inc/repo-harness/pull/2928) | `ec820d488` | feat(maintenance-triage): report every ledger theme in --json |
| [#2927](https://github.com/aimpact-inc/repo-harness/pull/2927) | `5892b31f2` | docs(rules): security bar is I1/I2; owner list, review tiers and comment rules follow (#2915) |
| [#2921](https://github.com/aimpact-inc/repo-harness/pull/2921) | `cd4a6d621` | feat(board): review and attention take the configured reviewer seat, not Claude |
| [#2932](https://github.com/aimpact-inc/repo-harness/pull/2932) | `517c3be4a` | feat(bots): rh bots list and rh bots show read the Bot registry (#2868) |
| [#2931](https://github.com/aimpact-inc/repo-harness/pull/2931) | `c56e98332` | fix(seats): the settings save runs the read-path decoder before it writes (#2917) |
| [#2919](https://github.com/aimpact-inc/repo-harness/pull/2919) | `3c24efacd` | feat(cli): rh commands manifest and check:cli-manifest drift check (#2862) |
| [#2939](https://github.com/aimpact-inc/repo-harness/pull/2939) | `3e7360f6e` | feat(board): rh board post writes the protocol comments that the board parses |
| [#2935](https://github.com/aimpact-inc/repo-harness/pull/2935) | `75ffcfb59` | ci: macOS jobs of Required / CI run on macos-15-intel (#2934) |
| [#2943](https://github.com/aimpact-inc/repo-harness/pull/2943) | `680622548` | docs(skills): the worker SOP runs the ArchContext loop (#2872) |
| [#2944](https://github.com/aimpact-inc/repo-harness/pull/2944) | `b8a693de4` | docs: remove the retired-feature residue from reference configs and module docs (#2940) |
| [#2945](https://github.com/aimpact-inc/repo-harness/pull/2945) | `db98e500d` | fix(cli): rh commands and check:cli-manifest agree on implicit help leaves (#2942) |
| [#2946](https://github.com/aimpact-inc/repo-harness/pull/2946) | `509b08b9a` | feat(rules): rh rules status reads the ledger themes and names the promotion candidates |
| [#2951](https://github.com/aimpact-inc/repo-harness/pull/2951) | `25a33937f` | feat(cli)!: rh setup check is the one name of the setup checklist (#2863) |
| [#2950](https://github.com/aimpact-inc/repo-harness/pull/2950) | `46f82ef04` | fix(cli): check:cli-manifest resolves the target of an implicit help path (#2948) |
| [#2949](https://github.com/aimpact-inc/repo-harness/pull/2949) | `e95dee83b` | feat(review): P2 findings do not block a merge; FAIL needs a P0 or P1 |
| [#2933](https://github.com/aimpact-inc/repo-harness/pull/2933) | `ac5932523` | feat(arch): rh arch verify gives one verdict over the ArchContext checks (#2873) |
| [#2952](https://github.com/aimpact-inc/repo-harness/pull/2952) | `a88a201e5` | feat(board): High review runs as a relay, the reviewer starts after the gatekeeper PASS (#2910) |

## Verification

On Darwin arm64 with Bun 1.4.4, at source `a88a201e5` with the release prep changes:

- `bun install --frozen-lockfile`: pass, 521 packages installed.
- `bun run check:type`: pass.
- `bun run check:state-boundaries`: pass, 644 TypeScript files checked.
- `bun scripts/check-skill-version.ts`: pass, repo-harness=0.33.2, template=0.33.2.
- VERIFY_TESTS
- `bun scripts/check-changelog-released-sections.ts --base origin/main`: pass, 121 released sections keep their bytes.
- `git diff --check`: pass.

`Required / CI` and the release gate are pending. The owner release plan runs the release gate after the prep PR merges. Skill eval evidence is unavailable. Consumer architecture smoke evidence is pending; the automated case is `tests/hook-runtime.test.ts`, "a registry consumer without code facts or a projection manifest gets one architecture line (#850)".

## Order of the owner steps

1. Merge the prep PR under rule 2 after `Required / CI` and the recorded verification pass.
2. On main, run `git fetch origin && bash scripts/release-owner-steps.sh plan 0.33.2`. The plan binds the steps to the release commit.
3. Run the authorized plan in order. Publish `repo-harness-operator-web` before `repo-harness`. Confirm the npm login, then create the tag and GitHub Release. Resume a partial run by the plan's rules.
4. After step 7, the orchestrator and the advisor decide the host post-release steps. The owner word does not cover an update of the installed rh on the owner Mac.

## Acceptance environment

Release upgrade rehearsal: pending. It is a test deployment and needs a joint decision before it runs. Command: `gh workflow run probe.yml --ref release/0.33.2 -f lane=release-rehearsal -f runner=ubuntu-latest`. Record the run URL and these lines:

- `[rehearsal] OK: 0.33.1 -> 0.33.2`
- `TARBALL SERVED repo-harness 0.33.2`
- `TARBALL SERVED repo-harness-operator-web 0.33.2`

## Publication

Publish candidate merge SHA: pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.33.2` | pending | pending | pending |
| 2 | `repo-harness@0.33.2` | pending | pending | pending |

Publish both packages, create tag `v0.33.2` and create the GitHub Release: pending.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.33.2` and `bash scripts/release-owner-steps.sh check tagged 0.33.2`: pending.
- Rebuild released managed values in the post-release PR: pending.

## Rollback

Before publication, close the prep PR or revert its squash commit. After publication, retain the tag and use a patch release for a correction.
