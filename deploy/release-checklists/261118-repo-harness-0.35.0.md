# repo-harness 0.35.0 publication record

## Release scope

- Release date: UTC 2026-11-18. Parent [#3190](https://github.com/aimpact-inc/repo-harness/issues/3190); no separate release issue.
- Owner word, relayed locally by the advisor seat at 18:01 (+08) and recorded in [#3190 comment 6975239685](https://github.com/aimpact-inc/repo-harness/issues/3190#issuecomment-6975239685) at 2026-11-18T10:02:21Z: "可以去重。抓紧完成工作，发布刷新这两台机器". The orchestrator reads it as: finish R2 (#3195) and R3 (#3197), then cut, merge and publish 0.35.0, and refresh this Mac and mini-cf to 0.35.0.
- Source commit before release prep: `f4150c35b279a4c3d4d32d4f4a961191d484b5ae` (#3197). The release range is `v0.34.0..f4150c35b`: 76 commits and 3 changelog fragments (`3166.added`, `3182.added`, `3182.removed`) plus the kept `README.md`. Main merges are frozen until this PR merges.
- Breaking method, as in 0.34.0: one `Migration:` line for each removed name that a user configured or that a shipped v0.34.0 document named.
  - Install state protocol 3 with `ownership_manifest` (`docs/reference-configs/install-profiles.md`) and `~/.repo-harness/agent-fleet-user-managed.json` (`external-tooling.md`) (#3085): readers fail with `install_state_protocol_retired` until `rh update` migrates them (`src/cli/installer/install-state.ts`).
  - `rh uninstall --recover-interrupted` (#3045; named in `external-tooling.md`).
  - `rh rules check TestBudget --body-file` (#3195; a required option at v0.34.0 `src/cli/commands/rules.ts`).
  - The PR-body `Test budget exception` section and the `test_budget_*` merge blockers (#3195; named in the v0.34.0 Global Working Rules block and the 0.34.0 Added entry).
  - Attention rule R6 (#3197; named in the v0.34.0 issue-flow `advisor.md`; a code constant, not a setting).
  - Not Breaking: `codex-project-path` → `configure-codex` in `rh arch codegraph configure --json` (#3022) is named in no shipped document. `~/.repo-harness/replaced-agents/` (#3100; the #2843 entry of an earlier CHANGELOG section names it) needs no user step, because `scripts/install-agent-fleet.sh` imports it once. Their Changed entries name both.
  - Method for the rest: the `.command` and `--option` names under `src/cli` at `v0.34.0` and `f4150c35b` differ only by `--recover-interrupted` (`--body-file` stays on `rh fleet message send`); no `REPO_HARNESS_*` name leaves `src`, `scripts` or `assets`; no file leaves `assets/templates/helpers`, and `helper-runner.ts` changes only its parse error; the seats and rules decoders remove no key (`rules.TestBudget` stays valid).
- Release prep added one entry, from the merged PR, for each user-visible change without a fragment. Folding rule of 0.34.0: a fix of a change that this range adds shares the entry of that change and gets no Fixed entry.
  - Host-config gate callers (v0.34.0 shipped the gate with no caller, #2898): #3022 with #3042, #3107, #3137 and #3196 (config.toml); #3045 with #3099 (JSON host files); #3078 with #3156 (rules block); #3100 and #3085 with #3196 (whole paths and path records); #3130 with #3159 (installer writers). Changed.
  - #3090 with #3097 (seat advisor model, Added); #3195 (TestBudget report, review rows, `review.i3_paths`: Added, Changed, Removed); #3154 and #3087 (models, Changed); #3170 with #3176 (review model pin, Changed); #3165 (legacy hook removal, Changed).
  - Fixed, because a v0.34.0 install can hit the defect: #3048, #3053, #3066, #3072, #3083 and #3088 (safety hook, one entry); #3193; #3047 (v0.34.0 `install-profile.ts` already writes `transactions/install-*`); #3189; #3173 with #3191 (the acceptance receipt reader keeps the parser text, a gap that #3191 names); #3192; #3089; #3063 (the #3014 precedent).
  - Documentation, for managed text that `rh update` refreshes: #3194, #3069, #3174.
  - The #3168 fragment gets a Changed line for the `rh seats argv` print-only behavior and the launch failure codes.
- Commits without an entry, and why:
  - #3064: release tooling only (`scripts/release-owner-steps.sh` step 8), the class of #3010 in 0.34.0.
  - #3145: a CI timeout of `scripts/sync-codex-installed-copies.sh` after #3130; no user-visible change.
  - Refactors with no behavior change: #3094, #3105, #3108, #3113, #3116, #3117, #3120, #3125, #3129, #3131, #3135, #3149, #3153, #3162, #3163, #3179, #3180.
  - Tests only: #3056, #3084, #3093, #3121, #3139, #3150.
  - CI only: #3071, #3126, #3160.
  - Generated architecture projection and architecture model only: #3059, #3077, #3096, #3098, #3104, #3112, #3136, #3146.

| PR | Commit | Change |
|---|---|---|
| [#3056](https://github.com/aimpact-inc/repo-harness/pull/3056) | `3f9858f00` | test(hook): make SessionStart posture timing deterministic (#3052) |
| [#3022](https://github.com/aimpact-inc/repo-harness/pull/3022) | `6bb640b26` | feat(host-config): config.toml switches to the toml-fragment strategy and keeps an explicit user value (#2847) |
| [#3048](https://github.com/aimpact-inc/repo-harness/pull/3048) | `fdbdb0533` | fix(hook): judge an over-limit glob in an in-root directory by its link children (#3037) |
| [#3059](https://github.com/aimpact-inc/repo-harness/pull/3059) | `3321f733f` | chore(projection): refresh generated architecture outputs for main@fdbdb0533dbd |
| [#3063](https://github.com/aimpact-inc/repo-harness/pull/3063) | `a50342bf6` | fix(release): rebuild released managed values for v0.34.0 (#3061) |
| [#3064](https://github.com/aimpact-inc/repo-harness/pull/3064) | `7721d49eb` | docs(release): name the released-managed-values rebuild as a step after check tagged (#3062) |
| [#3053](https://github.com/aimpact-inc/repo-harness/pull/3053) | `a43819b5c` | fix(hook): read find through one option parser for starts, link mode and exec templates (#3041) |
| [#3069](https://github.com/aimpact-inc/repo-harness/pull/3069) | `3f4e8fb8d` | docs(issue-flow): one CI run per change: no merge of main for a clean stacked PR or a main-side failure, one push per review round (#3067) |
| [#3042](https://github.com/aimpact-inc/repo-harness/pull/3042) | `6fd12f5fb` | fix(host-config): toml-fragment follow-ups of #3022 (boundary newline, linked rollback, profile switch, indented header, Claude-only uninstall) (#3038) |
| [#3066](https://github.com/aimpact-inc/repo-harness/pull/3066) | `d8bbe4263` | fix(hook): judge the output file of find -fprint, -fprint0, -fls and -fprintf (#3054) |
| [#3047](https://github.com/aimpact-inc/repo-harness/pull/3047) | `130d0711c` | fix(host-config): the lock holder settles the copies of a killed install by byte compare, and rollback keeps a path whose backup is missing (#3043) |
| [#3071](https://github.com/aimpact-inc/repo-harness/pull/3071) | `8de13cd7b` | ci: re-trigger CI on reopen and on a base change (#3068) |
| [#3045](https://github.com/aimpact-inc/repo-harness/pull/3045) | `d83d6f6c6` | feat(host-config): settings.json, hooks.json and ~/.claude.json change by text edits through the gate (#2848) |
| [#3077](https://github.com/aimpact-inc/repo-harness/pull/3077) | `0db790c68` | chore(projection): refresh generated architecture outputs for main@d83d6f6c6792 |
| [#3072](https://github.com/aimpact-inc/repo-harness/pull/3072) | `6d54f9c77` | fix(hook): judge each output that a copy writes below a possible destination directory (#3055) |
| [#3078](https://github.com/aimpact-inc/repo-harness/pull/3078) | `8a0e51d3f` | feat(host-config): CLAUDE.md and AGENTS.md rules blocks change through the gate with the marked-block strategy (#2849) |
| [#3084](https://github.com/aimpact-inc/repo-harness/pull/3084) | `53b02bdb0` | test(hook): repeat a SessionStart that ran out of notice budget (#3070) |
| [#3087](https://github.com/aimpact-inc/repo-harness/pull/3087) | `dab0f1231` | feat(seats): allow the Pi model magpie/agy-cli/gemini-4-carbon (#3086) |
| [#3083](https://github.com/aimpact-inc/repo-harness/pull/3083) | `6ed30f2c6` | fix(hook): judge each find -exec family template as a simple command, and walk the links below a link-following start (#3057) |
| [#3089](https://github.com/aimpact-inc/repo-harness/pull/3089) | `fad5f48d0` | fix(architecture): preserve corrupt resolve JSON evidence (#3075) |
| [#3090](https://github.com/aimpact-inc/repo-harness/pull/3090) | `d1cca14a5` | feat(seats): pass Claude advisor models at launch (#2930) |
| [#3093](https://github.com/aimpact-inc/repo-harness/pull/3093) | `fb4020037` | test(archctx): wait for the provider process tree to exit before removing its fixture (#3081) |
| [#3097](https://github.com/aimpact-inc/repo-harness/pull/3097) | `5b86f45d8` | fix(seats): disable the Claude advisor tool in saving mode (#3091) |
| [#3088](https://github.com/aimpact-inc/repo-harness/pull/3088) | `1a3c936b8` | fix(hook): judge install destinations under the GNU and BSD option readings (#3073) |
| [#3085](https://github.com/aimpact-inc/repo-harness/pull/3085) | `7b05e2d16` | feat(host-config): ledger path records replace ownership_manifest and the fleet receipt (#2896) |
| [#3098](https://github.com/aimpact-inc/repo-harness/pull/3098) | `16049ee66` | chore(architecture): clear the eight scoped debt items (#3095) |
| [#3096](https://github.com/aimpact-inc/repo-harness/pull/3096) | `f2ed2569d` | chore(projection): refresh generated architecture outputs for main@5b86f45d890b |
| [#3099](https://github.com/aimpact-inc/repo-harness/pull/3099) | `1e05dfd41` | fix(host-config): refuse a user hook entry that holds a retired rh command (#3058) |
| [#3094](https://github.com/aimpact-inc/repo-harness/pull/3094) | `14c223177` | refactor(operator): split server process and HTTP helpers (#3092) |
| [#3100](https://github.com/aimpact-inc/repo-harness/pull/3100) | `b33de63aa` | feat(host-config): whole host paths change through the gate with path records; uninstall, the plugin switch and the fleet use it (#2850) |
| [#3104](https://github.com/aimpact-inc/repo-harness/pull/3104) | `8943b6a3b` | chore(architecture): declare dependencies and refresh state anchors (#3103) |
| [#3105](https://github.com/aimpact-inc/repo-harness/pull/3105) | `051287dda` | refactor(review): split acceptance receipt runtime and store (#3101) |
| [#3108](https://github.com/aimpact-inc/repo-harness/pull/3108) | `e3a7cbc1f` | refactor(evidence): split verification toolchain and ledger view (#3106) |
| [#3107](https://github.com/aimpact-inc/repo-harness/pull/3107) | `1a528bc18` | fix(host-config): legacy EOF table boundary and named TOML parse errors in the Codex migration and the profile switch (#3046) |
| [#3112](https://github.com/aimpact-inc/repo-harness/pull/3112) | `93c837ff5` | docs(architecture): qualify the 3 path-ambiguous citations in global-runtime-reconciliation.md (#3111) |
| [#3113](https://github.com/aimpact-inc/repo-harness/pull/3113) | `283916579` | refactor(board): extract leaf review rules (#3110) |
| [#3117](https://github.com/aimpact-inc/repo-harness/pull/3117) | `a3baa0bc4` | refactor(board): extract protocol comment parsers and renderers (#3115) |
| [#3116](https://github.com/aimpact-inc/repo-harness/pull/3116) | `9d385126c` | refactor(board): extract seat reset store (#3114) |
| [#3121](https://github.com/aimpact-inc/repo-harness/pull/3121) | `e1510f1e2` | test(hook): repeat an expired notice run in the sibling notice tests (#3118) |
| [#3120](https://github.com/aimpact-inc/repo-harness/pull/3120) | `4eb2ea916` | refactor(fleet): extract task inbox store and activity modules (#3119) |
| [#3125](https://github.com/aimpact-inc/repo-harness/pull/3125) | `2810a406a` | refactor(review): extract waiver-grant and archive-projection leaves (#3123) |
| [#3126](https://github.com/aimpact-inc/repo-harness/pull/3126) | `9044ed51c` | ci(review): split generic review into native OAR matrix files (#3124) |
| [#3129](https://github.com/aimpact-inc/repo-harness/pull/3129) | `8732d0f4a` | refactor(state): extract policy and capability ownership modules (#3127) |
| [#3131](https://github.com/aimpact-inc/repo-harness/pull/3131) | `5828103dc` | refactor(review): extract GitHub publication transport (#3128) |
| [#3130](https://github.com/aimpact-inc/repo-harness/pull/3130) | `bfb46031a` | fix(installer): route host writers through the config gate (#3076) |
| [#3136](https://github.com/aimpact-inc/repo-harness/pull/3136) | `d15b3d509` | docs(architecture): repoint 12 stale module doc anchors to current symbols |
| [#3135](https://github.com/aimpact-inc/repo-harness/pull/3135) | `3045af21c` | refactor(review): extract change-assessment model leaf (#3134) |
| [#3145](https://github.com/aimpact-inc/repo-harness/pull/3145) | `fec8e1fe5` | fix(installer): skip absent facades before selection scans (#3140) |
| [#3146](https://github.com/aimpact-inc/repo-harness/pull/3146) | `4e35af462` | docs(architecture): move global-runtime flow proofs onto the setup transaction (#3138) |
| [#3137](https://github.com/aimpact-inc/repo-harness/pull/3137) | `20c9019e3` | fix(host-config): keep user EOF separators on fragment removal (#3109) |
| [#3149](https://github.com/aimpact-inc/repo-harness/pull/3149) | `5df63ab06` | refactor(operator): extract architecture-map model leaf from architecture-map.ts |
| [#3139](https://github.com/aimpact-inc/repo-harness/pull/3139) | `00a19cf52` | test(installer): confine bun stubs to fixture roots (#2904) |
| [#3150](https://github.com/aimpact-inc/repo-harness/pull/3150) | `ee42449cb` | test(operator-web): wait for docs render commits (#3141) |
| [#3153](https://github.com/aimpact-inc/repo-harness/pull/3153) | `dd02cf3e3` | refactor(operator): return the map refusal decoder to architecture-map.ts (#3151) |
| [#3156](https://github.com/aimpact-inc/repo-harness/pull/3156) | `8b034b82c` | fix(host-config): preserve rules refresh bytes and retire absent records (#3082) |
| [#3162](https://github.com/aimpact-inc/repo-harness/pull/3162) | `0fed8258c` | refactor(operator-web): move desk and sprite primitives to a leaf module (#3157) |
| [#3160](https://github.com/aimpact-inc/repo-harness/pull/3160) | `4435ddb17` | ci(native-oar): raise Intel job timeout to 20 minutes (#3152) |
| [#3154](https://github.com/aimpact-inc/repo-harness/pull/3154) | `5c9ddc58c` | fix(seats): move Sol and Astra defaults to 6.2 (#3147) |
| [#3163](https://github.com/aimpact-inc/repo-harness/pull/3163) | `1f600b5b8` | refactor(fleet): extract GitHub GraphQL observation leaf from provider-feedback.ts (#3158) |
| [#3159](https://github.com/aimpact-inc/repo-harness/pull/3159) | `f178aaa33` | fix(installer): recover from blocked update paths (#3132) |
| [#3170](https://github.com/aimpact-inc/repo-harness/pull/3170) | `cfbf48bcd` | fix(review): pin the review model at round 1 so a default change between rounds does not strand an open review (#3155) |
| [#3168](https://github.com/aimpact-inc/repo-harness/pull/3168) | `97093a236` | feat(seats,board): open seats in Herdr.app tabs and flag unbound seats (#3166) |
| [#3174](https://github.com/aimpact-inc/repo-harness/pull/3174) | `45bf72e03` | docs(herdr): start seats with rh seats launch in the Herdr Dispatch guide |
| [#3176](https://github.com/aimpact-inc/repo-harness/pull/3176) | `55c6df4df` | fix(review): name the unpinned-review recovery and prove pinned round-2 dispatch (#3171) |
| [#3179](https://github.com/aimpact-inc/repo-harness/pull/3179) | `2e9169eb5` | refactor(mcp): extract repository discovery into repo-discovery.ts |
| [#3180](https://github.com/aimpact-inc/repo-harness/pull/3180) | `efea7918e` | refactor(operator): extract the HTTP unavailable and refusal tables into a leaf module (#3177) |
| [#3173](https://github.com/aimpact-inc/repo-harness/pull/3173) | `3c1db89fa` | fix(host-config): strip parser error text from TOML and JSON diagnostics (#3164) |
| [#3165](https://github.com/aimpact-inc/repo-harness/pull/3165) | `041f3f75d` | fix(upgrade): remove legacy host hook commands by text edits through the gate (#3044) |
| [#3189](https://github.com/aimpact-inc/repo-harness/pull/3189) | `f30f6c79f` | fix(installer): a failed candidate under an rh 0.34.0 parent keeps converted entries and puts the parent's files back (#3167) |
| [#3191](https://github.com/aimpact-inc/repo-harness/pull/3191) | `e0bfd250f` | fix(redaction): route the remaining file parse errors through the file-syntax boundary (#3183, #3175, #3079) |
| [#3192](https://github.com/aimpact-inc/repo-harness/pull/3192) | `951eef702` | fix(arch-debt): cache base debt reports and reap killed base checkouts (#3186) |
| [#3193](https://github.com/aimpact-inc/repo-harness/pull/3193) | `b0f0359a2` | fix(hook): keep transient ownership lookup failures out of the model notice (#3190) |
| [#3194](https://github.com/aimpact-inc/repo-harness/pull/3194) | `81c6072c7` | docs(issue-flow): swarm SOP - triage, module bundles, two-round diff-only review, no P2 issues (#3190) |
| [#3196](https://github.com/aimpact-inc/repo-harness/pull/3196) | `2a6505bac` | fix(host-config): link-aware path records, recorded fragment format, one absent-file planner, one switch rule (#3102, #3065, #3161, #3079) |
| [#3195](https://github.com/aimpact-inc/repo-harness/pull/3195) | `64ab9a479` | feat(policy): TestBudget telemetry, I1/I2/I3 second review, round-1 PASS carry and parallel High round 1 (#3181, #3187) |
| [#3197](https://github.com/aimpact-inc/repo-harness/pull/3197) | `f4150c35b` | feat(board): module bundles, stalled-seat detection, review seat close, R6 retired (#3182) |

## Upgrade

`rh update` (it runs `rh install` for the hosts) refreshes these managed surfaces on each host:

- The Global Working Rules block in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, now through the gate with the `marked-block` strategy (#3078). The block changes in this range by #3194 and #3195: diff-only review, the I1/I2/I3 second row, two review rounds, the Delegation fix loop and merge paths, and the Test budget report without a cap.
- The hook adapters in `~/.claude/settings.json` and `~/.codex/hooks.json`, by text edits through the gate (#3045), and the hook code: the safety hook fixes and the quiet ownership notice (#3193).
- The bundled skills (the issue-flow skill and its references), the reference configs, Herdr and the Waza shared rules, through the gate (#3130).
- One-shot migrations: install state protocol 3 → 4, ledger protocol 1 → 2, the configuration receipt into ledger records (#3085, #3045, #3022). `scripts/install-agent-fleet.sh` imports `~/.repo-harness/replaced-agents/` once at the next fleet install (#3100). Until `rh update` runs, `rh status` fails with `install_state_protocol_retired`.

User actions:

- A hook entry that holds an rh command beside a user command stops `rh install` and `rh update` with `host_config_invalid_state`. Move the named rh command out of the entry, then run the command again (#3099).
- `rh upgrade` removes a legacy rh hook command only when it is exactly a released form; it reports the others and keeps the file bytes (#3165).

## Verification

On Darwin arm64 with Bun 1.4.4, at the prep commit on source `f4150c35b`:

- `bun install --frozen-lockfile`: pass.
- `bun run check:type`: pass.
- `bun scripts/check-skill-version.ts`: pass, repo-harness=0.35.0, template=0.35.0.
- `bun scripts/check-changelog-released-sections.ts --base origin/main`: pass, 123 released sections keep their bytes.
- `bun run check:cli-manifest`: pass.
- `bun run check:release` (`scripts/check-npm-release.sh`): pass, exit 0. It ran the tarball smoke with the script's own mkdtemp HOME and registry under `/tmp` (`TMP_DIR` in `scripts/check-tarball-install-smoke.sh`), with no outer HOME wrapper: `repo-harness-0.35.0.tgz installs, serves the packaged Operator, and packaged CLI bins start`; mcp serve loads 34 MCP modules, operator serve loads 84 Operator modules.
- `git diff --check origin/main...HEAD`: pass.
- `bun run test:files tests/skill-version.test.ts tests/bootstrap-files.test.ts tests/readme-dx.test.ts tests/scaffold-parity.test.ts tests/installed-copy-sync.test.ts --timeout 60000 --max-concurrency 1`: pass, exit 0, 70 tests in 5 files (13, 17, 5, 2 and 33), 0 fail.

`Required / CI` is pending.

## Order of the owner steps

1. Merge the prep PR under rule 2 after `Required / CI` and the recorded verification pass.
2. On main, run `git fetch origin && bash scripts/release-owner-steps.sh plan 0.35.0`. The plan binds the steps to the release commit.
3. Run the authorized plan in order. Publish `repo-harness-operator-web` before `repo-harness`. Confirm the npm login, then create the tag and GitHub Release. Resume a partial run by the plan's rules.
4. After step 7, run step 8 (`bun scripts/check-released-managed-values.ts --write`) and merge its file in one Low PR.
5. The owner word covers the refresh of this Mac and mini-cf. On each host, run `bun add -g repo-harness@0.35.0 --no-cache && rh update --version 0.35.0` before a seat relaunch, then follow the Upgrade section.

## Publication

Publish candidate merge SHA: pending.

| Order | Name | Shasum | Integrity | File count |
|---|---|---|---|---|
| 1 | `repo-harness-operator-web@0.35.0` | pending | pending | pending |
| 2 | `repo-harness@0.35.0` | pending | pending | pending |

Publish both packages, create tag `v0.35.0` and create the GitHub Release: pending.

## Post-publish checks

- Run `bash scripts/release-owner-steps.sh check published 0.35.0` and `bash scripts/release-owner-steps.sh check tagged 0.35.0`: pending.
- Rebuild released managed values in the post-release PR: pending.
- Refresh this Mac and mini-cf to 0.35.0: pending.

## Rollback

Before publication, close the prep PR or revert its squash commit. After publication, retain the tag and use a patch release for a correction. A host downgrade below 0.35.0 after `rh update` fails closed on the protocol 2 ledger and `replaced` path records; run `rh uninstall` with 0.35.0 first.
