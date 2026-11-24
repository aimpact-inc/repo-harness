# Herdr dispatch and notify

`rh herdr`, `events`, and `review round|status|close|cancel` need
`peer-runtime` in the recorded plugin set. Their help stays open. An absent
plugin exits 1 with empty stdout and `install_plugin_unavailable` before any
prompt, credential read or process start. Run the printed repair: for `all`,
`rh update`; for an explicit list, add `peer-runtime` with
`rh install --plugins <your plugins>,peer-runtime`. No migration runs.
The plugin is available on every target; its portal skill installs on Claude
only. `hc`, the Herdr skill, fleet files, worktree closeout and doctor stay in
core. The hidden Operator cleanup-investigation job also needs `peer-runtime`;
the server records `host_failed` when the guard refuses that child.

## Herdr Dispatch

- Claude, Codex, Pi and the agy advisor run in herdr-core terminals that Herdr.app shows as panes. Start a seat with `rh seats launch`, which opens its Herdr.app tab, and talk to it with `hc` ([Runtime commands](#runtime-commands)). Receipt-bearing acceptance uses `rh review round`; its OAR host runs the reviewer. Select Pi with `--harness pi`. Never call a vendor CLI directly for acceptance.
- Pi review uses an OAR RPC subprocess under Seatbelt. Its private agent directory links native model configuration and credentials for read-only access. An owner-written mode-0600 `settings.json` contains only native `defaultProvider`, `defaultModel` and `defaultThinkingLevel`; packages, proxy and trust policy are excluded. User extensions, skills, context files, prompt templates and MCP are disabled. The Pi reviewer uses the user's Pi default model. The Receipt's `actual_model` records OAR's actual `provider/model`. A null actual model records `model_relation: unknown` and grants no cross-model claim. A non-string or blank model fails with `review_actual_model_unverified`.
- A cross-model review means Receipt `model_relation: different-family`. The OAR host records the reviewer model and the model of each ended turn of the one author task session bound to the caller pane, campaign and reviewed root. One closed family table in `src/core/review/acceptance-receipt.ts` compares vendor families, not routing providers. Harness kind does not prove a model difference. A shared family is `same-family`. A missing author binding, an unobserved or running turn, a Claude turn (its model is not observed) or a model outside the table is `unknown`. Interactive authors are not OAR-observed, so they give `unknown` and a High-tier cross-model review stays a manual Herdr peer review. The review runtime records identity; it adds no cross-model gate.
- Exception: in the Claude desktop app, operator-attended acceptance review can use `rh review round --launch app-terminal`. The CLI prints the fixed OAR host command. Claude runs that exact command once in an app Terminal tab, then repeats the same round. The same OAR host, Seatbelt profile and Receipt apply.
- Send the root tests-and-implementation review to the other model through Herdr when it is available. Otherwise, run that read-only review in a separate same-model pane.

### Issue-flow topology

This topology applies to issue-flow work (`repo-harness-issue-flow`) on herdr-core (`hc` with Herdr.app).

- Pane layout: put at most 3 panes side by side in one tab. Do not stack panes vertically. When the tab is full, open a new tab.
- Tab 1 holds two panes: the orchestrator on the left and its advisor on the right. Tab 1 may take one worker as its third pane.
- The orchestrator holds the issue-flow coordinator and integrator seats. It only dispatches, accepts and merges. It does not implement a child issue.
- The advisor is the owner interface and serves the orchestrator. It relays each owner directive once, writes the parent bundle plan, audits triage and merges every two hours, does research and writes proposals. It may edit files for its proposals. It does not commit or write to GitHub. It collects evidence through the sub-agents of its seat (`seats.advisor.fleet`) and keeps judgment, synthesis and the proposal. The orchestrator asks it for a board replan by [Replan](https://github.com/aimpact-inc/repo-harness/blob/main/assets/skills/repo-harness-issue-flow/references/replan.md).
- Owner decisions and seat authority (owner, 2026-11-09, #2008): the root `CLAUDE.md` and `AGENTS.md` hold the life-cycle rules and the owner list. The orchestrator triages intake, dispatches an owner-approved batch plan in order as module bundles, merges by rule 2 at every tier and runs at most two review rounds by rule 1. A seat that receives an owner decision in its pane posts it on the issue or PR; that comment authorizes the other seats. A seat message carries pointers, not content: it names the issue, the PR, the comment URL or the sha, and the content lives in GitHub. The message still wakes the receiving seat; it does not replace the record. The advisor sends the orchestrator only a mismatch between a seat report and the GitHub state, not a confirmation. A comment is a record: a local seat writes it, and a locally run command may read it as data; it never starts an action. A joint decision of the orchestrator and the advisor covers only scope growth on an open PR, a skipped required review row or an accepted I1/I2/I3 residual; the orchestrator posts it first as `Joint decision (orchestrator + advisor)` with the reason. Every other call is the orchestrator's. The advisor makes no GitHub write. A "stop" or "no" comment from any participant, the owner account included, is a reference that the orchestrator weighs; a stop on an I1/I2 item goes to the owner.
- One bundle PR has one pane and one worker agent. Each further worker gets its own pane, as the right split of a tab that is not full or in a new tab. The worker may use the agent-fleet sub-agents (`agents/fleet/`) inside its own pane.
- Recommended models (ADR-0006): in a Magpie-First setup, `orchestrator` runs Claude `opus` high and `advisor` runs Pi `magpie/agy-cli/gemini-4-neon` xhigh; in a Native-First setup, `orchestrator` runs Claude `opus` high and `advisor` runs `agy` `gemini-4-neon-high` (or Claude `opus` high). No seat requires a single fixed vendor when configured otherwise.
- Cleanup: after a PR merges, the orchestrator runs `rh board closeout --pr <n>` in the primary checkout. It first proves the merge and the worktree: merge commit in the fetched `origin/main`, PR head worktree at the PR head sha, not locked, clean, and no owner marker but its own. A missing proof stops before any pane closes. It then closes each seat terminal bound to the PR (its `pr` label, or the `issue` label of a closing issue in this repository, or a cwd in the PR head worktree on the PR head branch when the seat has an `issue` label that the PR body names after `Refs`; a cwd in the primary checkout never binds; a binding without the PR's `pr` label next to another PR's `pr` label is a conflict) whose checkout belongs to this repository, is clean and has no commit outside `origin/<branch>`. When every bound pane is closed and no process runs in the worktree, it removes the worktree and the local branch through the exact closeout path of `rh worktrees cleanup`, which drops only the worktree's own active-worktree marker. The same pass removes each finished seat terminal of the repository whose cwd directory is gone, also one that no merge binds, and lists it in `stale_terminals`; a failed `hc rm` there is listed as `kept` and keeps no worktree. A dirty, unpushed, conflicting, locked, other-owner or unmerged pane or worktree stays; the JSON names the reason, and the board rule A9 reports each live seat of a merged PR. The remote branch is left to GitHub.
- Before a worker reports DONE, it stops the background programs it started (a dev server, a daemon started with `nohup` or `setsid`). On Linux and macOS, herdr-core 0.1.19 keeps a deliberately detached program running after its terminal closes, and Windows ends it.

### Runtime commands

Start a worker or reviewer seat with `rh seats launch <seat> --cwd <path> --task <text>`, `rh board dispatch` or `rh board review`; each opens a Herdr.app tab. Use `hc` for terminals and `herdr-app do` for a further pane in an open tab. In an hc terminal, `HC_TERMINAL_ID` is your address. `hc --help`, `herdr-app commands` and `rh seats launch --help` are the syntax authority.

Find every live seat of the repository with `rh board seats --json`, including seats without a parent issue. Wait with `hc wait <t>` or follow `hc events`. Never use `sleep` loops to wait for seats.

Commands for the topology steps:

| Step | Command |
|---|---|
| Start the orchestrator | `rh seats launch orchestrator --repository-id <repository-id> --cwd <repository> --task <brief>` |
| Dispatch a plan | `rh board dispatch --parent <n> --space <id>` |
| Start one worker | `rh seats launch worker --repository-id <repository-id> --parent <n> --issue <n> --cwd <worktree> --task <packet>` |
| Start a reviewer | `rh board review --parent <n> --space <id>`, or `rh seats launch reviewer --repository-id <repository-id> --pr <n> --cwd <worktree> --task <brief>` for one pull request |
| Start the advisor | `herdr-app do pane.split --direction right --pane <orchestrator pane> --argv "$(rh seats argv advisor --repository-id <repository-id>)"` |
| Second worker in an open tab | `herdr-app do pane.split --direction right --pane <pane> --argv "$(rh seats argv worker --repository-id <repository-id> --parent <n> --issue <n>)"` |
| Message a worker | `hc send <t> <comment URL>` |
| Read a worker | `hc read <t>` |
| Wait for a worker | `hc wait <t>` |
| Close a worker pane | `herdr-app do pane.close --pane <pane>` |

The board of a parent selects a worker, gatekeeper or reviewer seat by its `issue` label (an item of the parent) or its `pr` label (a pull request of the board). `--parent` is optional for that. It names the worker tab `#<n>` (`other` without it), so the worker rows keep it.

A native `codex` worker seat in a linked contract worktree edits files and runs checks only. It runs no `git fetch`, `git commit` or `git push`. Its last message gives the commit subject and body, the PR title and body, and the check results. The orchestrator commits the worktree diff with that message and explicit paths only, pushes the branch and opens the PR. The orchestrator is the head owner of record and pushes each fix round; no other agent pushes to that PR. The Codex seat remains the content author and answers review threads through the orchestrator. (`pi` workers on `magpie/codex/*` commit, push, and run fix rounds directly in their worktrees.) A seat with the `net` tool group can use the network. A writable Codex seat with `net` can reach loopback services, including the Operator console and herdr-core socket (#1961).

`rh seats argv <seat>` prints arguments only: it starts no process and opens no tab. The argv comes from the `seats` section of `~/.repo-harness/config.json`, or from the seat defaults when the section is absent. The argv holds the model, the effort, the tool limits and the seat brief. Its stderr names the source and each limit. A limit marked `instructions_only` is written into the launch instructions only; the host does not enforce it. `rh seats launch` opens this argv in a Herdr.app tab; the `--argv` of `herdr-app do tab.new` and `pane.split` takes it too. Without `--argv`, the pane opens a shell.

With `--repository-id`, the same argv starts both tabs and splits through an interactive login shell. The launcher adds its Bun directory and the directories where the caller found `rh` and `hc` to the end of the login shell’s `PATH`. The shell stays alive while `hc` tracks the agent and accepts commands after the agent exits.

Before each dispatch wave, run `rh quota`. For a manual dispatch, check the route's candidates and their quota. When Opus and Neon are both eligible, normally choose the seat whose account has more weekly quota left. Launch with `rh seats launch <seat> --cwd <worktree> --task <packet>`. State the task boundary in the packet.

| Seat | Magpie-First default (runtime, model, effort, fleet) | Native-First default |
|---|---|---|
| `orchestrator` | Claude, `opus`, high; `gh`, `mcp`, `net`, `read`, `shell`, `tasks`; `['explorer']` | Claude, `opus`, high |
| `advisor` | Pi, `magpie/agy-cli/gemini-4-neon`, xhigh; `mcp`, `net`, `read`, `shell`; `['explorer', 'deep-reasoner']` | `agy`, `gemini-4-neon-high` (or Claude `opus` high) |
| `council` | L3 member pool `{claude:fable, pi:magpie/agy-cli/gemini-4-carbon, pi:magpie/codex/gpt-6.2-astra}`, read-only, `['explorer']`; opened via `rh seats council` | `{claude:fable, agy:gemini-4-carbon-high, codex:gpt-6.2-astra}` |
| `worker-opus` | Claude, `opus`, high; worker tools; `['explorer']` | Claude, `opus`, high |
| `worker-neon` | Pi, `magpie/agy-cli/gemini-4-neon`, high; worker tools; `['explorer']` | `agy`, `gemini-4-neon-high` (when enabled) |
| `worker-neon-deep` | Pi, `magpie/agy-cli/gemini-4-neon`, xhigh; worker tools; `['explorer']` | `agy`, `gemini-4-neon-xhigh` (when enabled) |
| `worker-deep` | Pi, `magpie/codex/gpt-6.2-sol`, high; worker tools; `['explorer']` | Codex, `gpt-6.2-sol`, high |
| `worker` | Pi, `magpie/codex/gpt-6.1-terra`, high; worker tools; `['explorer']` | Codex, `gpt-6.1-terra`, high |
| `worker-light` | Pi, `zai/glm-5.3-flash` (also `magpie/group/deepseek-v4.1-flash` and `magpie/zcode/GLM-5.4`), no effort; worker tools; `[]` | `agy`, `gemini-4-hydrogen` (or `null`) |
| `gatekeeper` | Pi, `magpie/codex/gpt-6.2-sol`, high; read, shell, network; `[]` | Codex, `gpt-6.2-sol`, high |
| `gatekeeper-fallback` | Pi, `zai/glm-5.3-flash` (or `null`); read, shell, network; `[]` | `null` (or `agy`, `gemini-4-hydrogen`) |
| `reviewer` | Claude, `opus`, high; read, shell, network; `[]` | Claude, `opus`, high |

All worker seats use worker briefs, labels and pane names. `gatekeeper` and `reviewer` need `--pr <n>`, and `--repository-id <id>` too, because `rh review collect` finds the seat by its `repo-harness.seat` label; their pane names are `<prefix>-gk-<pr>` and `<prefix>-rv-<pr>`. `council` panes opened by `rh seats council --issue <n> --members <csv>` use `<prefix>-cn-<issue>` (`council` tab). `gatekeeper-deep` is retired. Review seats report a read-only verdict first and do not edit, commit, push or write to GitHub.

`gatekeeper-fallback` is optional and is no launch target: `seats argv gatekeeper-fallback` returns `seat_unknown`. While the gatekeeper account is exhausted and the fallback account is not, the route line names the fallback, for example `gatekeeper: gatekeeper-fallback (pi zai/glm-5.3-flash; gatekeeper: chatgpt exhausted)`, and `seats argv gatekeeper --repository-id <id> --pr <n>` prints the fallback argv with the gatekeeper label, pane name and brief. A tight, unknown or reserved gatekeeper keeps its own rule; with no usable fallback the line stays `gatekeeper: none (...)`. `rh board review` starts a gatekeeper only when this effective gatekeeper has a known model family, and not `anthropic` when the head needs a non-Claude gatekeeper. Its family must differ from the writer's only where it gives the different-family row: a Medium head, or a High head that needs no Claude review. A High head with a Claude review may use a gatekeeper of the writer's family; else it skips the PR with `review_family_unavailable` and the route line. A stored section without the key needs `rh update`, which sets it to `null`.

On Pi, review seats pass `--exclude-tools edit,write`. Direct edit/write tools are off. The edit limit is `common_commands` because the shell stays available; shell writes remain prohibited by the brief. Codex review seats use the read-only sandbox.

`seats.routing` holds ordered lists for `important_deep`, `important_fast`, `simple_deep`, `simple_fast` and `frontend`. Lists are non-empty and distinct. The first four accept configured worker seats only; a list cannot name a null seat. `frontend` accepts `worker-opus` and `worker-neon` when they run Claude or Neon (`magpie/agy-cli/gemini-4-neon` or `gemini-4-neon*`). Defaults are `[worker-opus, worker-neon-deep, worker-deep]`, `[worker-opus, worker-neon, worker, worker-light]`, `[worker-neon-deep, worker-deep]`, `[worker-light, worker]` and `[worker-opus, worker-neon]`, in that order. `worker-light` defaults to the Pi seat above. A stored `null` stays null during migration; its argv returns `seat_not_configured`. Each configured seat must use an enabled runtime when saved. The default Pi seat prevents a Seats page save until Pi is enabled or `worker-light` is set to `null`.

Routing evaluates strictly left-to-right across the configured list after excluding reserved or exhausted accounts, selecting the first eligible seat with a known account state (or a Flash API seat without an account such as `zai/glm-5.3-flash` / `deepseek-v4.1-flash`). A Pi seat on `magpie/codex/` has the `chatgpt` account. Pi models with the `magpie/agy-cli/gemini-` prefix and native `agy` models with the `gemini-` prefix use the `agy_gemini` account. Routing selects an unknown account only when no known-state seat in the route is eligible. A window at or above `routing.exhausted_at_or_above_used` percent used (default 95, range 50–100) is `exhausted`; a provider-reported `rate_limit_reached_type` is exhausted at any value. Exhausted accounts are excluded. The one exception is `routing.codex_credit_mode` (`off`, `review` or `all`; default `off`): while the ChatGPT account is exhausted and reports credits at or above `routing.codex_credit_floor` (default 0), `review` admits `gatekeeper`, `gatekeeper-fallback`, and a ChatGPT-bound `reviewer`, and `all` admits every ChatGPT-bound seat. Their route and seat lines say `on credits`; the `chatgpt` account line stays `exhausted`. Only the owner sets `codex_credit_mode`, on the console Seats page; a seat does not write it, and a joint decision does not cover it. Claude in saving mode or exhausted stays reserved for `advisor` and `orchestrator`; routing skips `worker-opus` and selects the next eligible seat in the configured list. `routing.agy_saving_below_remaining` (default `25`, range `0..100`) reserves `agy_gemini` for `advisor` (`Neon`) by excluding both Neon worker tiers when `agy_gemini` weekly remaining quota is below that threshold. Frontend waits for an eligible Claude or Neon seat in its own route. `rh seats launch <seat> --repository-id <id> --owner-exception <url>` lifts the Claude reservation refusal (`seat_quota_reserved`) for one launch. The URL must name an owner decision on an issue or PR of the checkout's origin repository; the seat label `repo-harness.owner-exception` and the `--json` launch record keep it. The exception changes no model, tool or permission, does not lift an exhausted account, and a launch that is not reserved refuses it. `routing.unavailable_pi_providers` (default empty) lists Pi model prefixes that the owner marks unavailable, for example `magpie/anthropic`. A prefix matches a seat model only at a `/` boundary. While the list is non-empty, a Pi seat with a null model is unavailable too, because Pi then picks its own default provider. Routing skips each unavailable seat, the route, gatekeeper, reviewer and advisor lines of `rh quota` give the reason, and its launch refuses with `seat_provider_unavailable`. For a null model the reason says to give the seat an explicit model or to empty the list. `tight` is a display state only. When Claude is reserved, the explorer line uses `routing.low_quota_explorer` (default `haiku` high). Pass its model when you call the explorer. Otherwise the line says `default`.

`routing.claude_saving_below_remaining` defaults to 20. Claude saving mode applies when weekly remaining quota is below that percent. `routing.claude_hyper_at_or_above_remaining` defaults to 50. Claude hyper mode applies when weekly remaining quota is at or above that percent and saving does not apply; otherwise its mode is normal. Only in Claude hyper does a Claude advisor take its config entry; in normal, saving, exhausted and unknown it uses `opus` high, and the `advisor:` line of `rh quota` names it. Claude hyper routes workers as normal and does not change the orchestrator entry. Codex seats and Pi seats on `magpie/codex/` keep their configured model and effort at every quota level. A Codex advisor keeps its own configured model and effort too; a Pi advisor on `magpie/agy-cli/` uses its config entry at 50% or more `agy_gemini` weekly quota remaining and uses `magpie/agy-cli/gemini-4-neon` when the remaining quota is lower or unknown. A missing weekly reading gives an unknown mode. Quota modes are derived, never stored; the credit mode is the one stored owner choice. Reserved Claude advisor and orchestrator seats use `opus` high. Other Pi seats, tools, fleet and class lists stay as configured. An absent seats section uses defaults. Run `rh update` for the one-shot migration of stored sections (`planner` → `council`, `worker-important` → `worker-opus`, `worker-important-fast` → `worker-neon`, `gatekeeper-deep` removed, `agy_saving_below_remaining` added). When the stored section lacks `worker-neon-deep`, `rh update` adds it as `null` and preserves the saved route lists. Turn on the seat in Settings > Seats and add it to the routes you want. The Settings save checks the complete section before it writes.

`rh seats launch` takes the space from `--space` or from the `herdr.space` label of the calling terminal, opens the argv in a `tab.new` of that space, and fails closed when Herdr.app opens no tab; `--json` prints the launch, the space and the placement. With `--repository-id`, the argv labels its own terminal before the agent starts: it runs `rh seats label`, which sets the seat labels on `HC_TERMINAL_ID`, and then starts the agent. The board finds seats only by these labels; a terminal without them leaves the execution axis `unavailable` (`no_seat_terminals`). When the label fails, the agent does not start and the terminal shows the error. Each start prints the new `terminal`. `<repository-id>` is the GitHub numeric repository id (`gh api repos/<owner>/<repo> --jq .id`). Leave out `--issue` and `--pr` for the orchestrator and the advisor.

### Seat reset

The Claude, Pi and Antigravity `orchestrator` and `advisor` seats can reset each other through a handoff (#1972, #3364, #3416, #3462). With `--repository-id`, `seats argv` sets `REPO_HARNESS_SEAT` and `REPO_HARNESS_SEAT_REPOSITORY` for these two seats. It also sets `REPO_HARNESS_SEAT_MODEL` and `REPO_HARNESS_SEAT_EFFORT` from the effective launch configuration (#2633). Each seat launch unsets these four inherited values before assigning its own. SessionStart uses this identity to record the host, source, transcript path, model and effort in `session.json`. Worker seats do not reset.

1. At 380,000 context tokens, the Stop hook asks for a handoff. Antigravity can repeat the reminder on a later turn while its request is open. A recorded `NO-RESET` release suppresses further reminders for that request. For Claude and Pi, a transcript below 32 MiB gives `compact`. A transcript at or above 32 MiB gives `reset`. Antigravity always uses `reset`. The hook records the timestamp, transcript path, byte count, action and host (`claude`, `pi` or `antigravity`) in `/tmp/repo-harness-seats/<repository-id>/<seat>/request.json`. A seat can also run `rh seats handoff` to record a request and print the steps.
2. The requester finishes its current planning and dispatch, then writes `handoff.md` next to the request using the required sections. Antigravity passes the completed Markdown on stdin to `rh seats handoff --write`. The command writes the handoff and prints `RESET-REQUEST <path> <sha256>` for the open request. The requester sends this line to the peer seat and ends its turn. When both seats request a reset, the advisor goes first.
3. The peer runs `rh seats reset <path> <sha256>` in the background. It locates the requester by the seat and repository labels. A missing, stale, damaged or incomplete handoff gives up to three `REWRITE` messages, then `NO-RESET`. An invalid request gives `NO-RESET` after the peer checks. A missing request gives `request_missing` and sends nothing.
4. The peer waits for the requester. The reset checks the live foreground using the basename of `hc get`'s `foreground.argv[0]` (`claude`, `pi` or `agy`). A live terminal with `status: null` gives `requester_status_untracked`. A finished terminal gives `requester_exited`. The peer claims the request with an exclusive create of `claim-<requested_at digits>` before it processes the handoff. It removes its claim when the run stops before any key attempt. Once it attempts keys, the claim stays and a second run gives `already_claimed`. The Stop hook, handoff check, and first-key gate use the same request state. A recorded `NO-RESET` makes a retry of that request return `request_released` with `nothing_sent`. A completed reset closes the request. A newer session segment also closes the request and can send `NO-RESET` once. Under the claim, reset checks the request and handoff again immediately before the first key. A changed handoff or a requester that left the original idle or done turn gives `nothing_sent`.
5. In the same runtime, the peer types `/compact` for a compact request, `/clear` for a Claude reset, or `/new` for a Pi reset. Antigravity always relaunches in the same pane. On a Claude or Pi `reset` request, an eligible model or effort change also relaunches. An unknown quota mode or a failed model check keeps the current model for an in-process reset.
6. A switch to Claude can relaunch the seat in its pane, including on a compact request. The destination must pass the normal launch checks and confirm its SessionStart integration for the planned executable, flags and checkout. Claude confirms this with a successful repo-harness `SessionStart:startup` hook response in its startup stream. The probe sends no prompt and clears the seat identity. A failed probe gives `seat_reset_destination_unavailable` with `nothing_sent`. Switches to Antigravity (`agy`), Pi, and Codex give the same refusal because these runtimes provide no safe, complete pre-exit SessionStart evidence. Use `rh seats argv <seat> --repository-id <id>` to get the configured runtime's launch command.
7. The first-key gate checks the configured runtime again and refuses with `seat_reset_runtime_changed` if it changed during preparation. The live SessionStart record must match the source host and transcript, and the requester must still be in the checkout used for preparation. A relaunch after retries waits for a settled turn again. It accepts the new session segment from the earlier keys and uses the handoff already checked for this claim. The peer types `/exit` on Claude or Antigravity, or `/quit` on Pi. After the original parent shell returns to the foreground, it types `sh <reset dir>/relaunch-<requested_at digits>.sh`. Each request has its own script path. The reset types commands with `hc keys` and sends the resume prompt with `hc send`.
8. The reset sends the prompt after a new transcript appears for `/clear` or `/new` (60 s), a `compact` record appears for the same transcript (300 s), or the destination writes a `startup` record after relaunch (60 s). In the appended transcript, the reset looks for the user prompt, the assistant command `hc send <peer> RESUMED`, and that command's successful tool result. Antigravity records these as `USER_INPUT`, a `PLANNER_RESPONSE` with a `run_command` call, and the result in the next `GENERIC` step. The requester reads the handoff and sends `RESUMED`. After a reset or relaunch, it checks the current state with git and gh. After compaction, it continues from the summary.

The peer sends no other messages between `RESET-REQUEST` and `RESUMED`. With no peer or after `NO-RESET`, the requester continues. Claude and Pi then use their own auto-compaction. A missing compaction signal stops the reset after the first `/compact`. A missing `/clear` or `/new` signal retries that command. A missing `RESUMED` retries the prompt. After one attempt and up to three retries, the reset attempts an in-pane relaunch. A failure after keys may require manual recovery.

The reset log `reset-log.jsonl` tracks rewrites, retries and outcomes. A successful record has detail `compacted`, `cleared`, `relaunched` or `restarted`. Each failure writes a log entry and sends a `seat.reset_failed` notification when configured. The run waits up to 5 s for all notices. The result reports any log write errors in `logErrors`. A path outside the handoff convention gives a command error with no log or notice.

### Pane and tab names

With `--repository-id`, `seats argv` also prints the pane name (`name`) and the base tab name (`tab`). Do not type a name.

`herdr-app do tab.new` and `pane.split` set no terminal name: the `--name` of `tab.new` is the tab name, and `pane.split` takes no name. `rh seats launch` passes the base tab name as that `--name`. So a seat terminal started by the launch rows has no hc name. Only a Claude seat carries the pane name, as its session name (`-n`) in the argv. A Codex seat has no session-name flag and carries no name. Find a seat terminal with `rh board seats --json`, which reads its labels.

The pane name is `<prefix>-<role>[-<item>][-<qualifier>]`: at most 32 characters of `a-z 0-9 -`. Examples: `rh-orch`, `rh-adv`, `rh-w-1508`, `rh-w-rel0252`, `rh-rv-1536-codex`, `aip-w-485-device`.

| Part | Values | Source |
|---|---|---|
| `prefix` | 2-6 characters, `[a-z][a-z0-9]{1,5}`, one per registered repository, unique on the machine | `panePrefix` of the repository entry in `~/.repo-harness/registered-repos.json` |
| `role` | `orch`, `adv`, `cn`, `w`, `gk`, `rv` | the seat |
| `item` | worker / `council`: the issue number (`--issue`) or `rel<digits>` for release prep (`--release`); reviewer: the PR number. None for `orch` and `adv` | the dispatch |
| `qualifier` | worker: a slice word when one issue has two live worker panes (`--qualifier`); `council`: member key (`fable`, `carbon`, `astra`); reviewer: the review runtime id (`claude`, `codex`, `pi`) | the dispatch |

- Set `panePrefix` with `rh seats prefix --repo <path> --pane-prefix <p>`. Every registry writer keeps it. The registry read refuses a malformed or duplicate prefix.
- `seats argv` reads the entry of the primary checkout of the current directory; a linked worktree resolves to its primary checkout. No entry, or an entry without `panePrefix`, fails with `pane_name_invalid`. A name over 32 characters fails the same way.
- One pane serves one item. Do not reuse a pane for another issue: close it and start a new one. Only `hc run --name` sets an hc terminal name, and hc refuses a second live terminal with that name.
- The name carries no state (round, status, PR state). The board reads those from GitHub and the labels.
- Reserved names stay as they are: `rh-notify-relay` and `task-<uuid20>`.

| Tab | Holds | Name |
|---|---|---|
| Tab 1 | the orchestrator (left), the advisor (right), one optional worker | `orch` |
| Worker tab | up to 3 worker panes whose issues have the same parent | `#<parent>` |
| Worker tab, no parent | up to 3 worker panes of issues without a parent | `other` |
| Council tab | up to 3 blind `council` panes (`rh seats council`) | `council` |
| Review tab | up to 3 reviewer panes (`gatekeeper`, `reviewer`) | `review` |

A new pane goes into the first tab of its kind with fewer than 3 panes. When every tab of that kind is full, add ` 2`, ` 3` to the base name, for example `#1000 2`. A tab closes with its last pane. The space name stays the repository name.

### Test and Review Rules

- A writer runs `bun run check:type`, `bun run check:helpers` and at most 3 test files that own the change. `Required / CI` on the head is the affected-gate evidence.
- `bash scripts/check-ci.sh <lane>` on the host only reproduces a CI failure.
- A reviewer runs no test that CI passed.
- The full suite runs in the daily run and for a release.
- Test commands take the host test queue themselves: `bash scripts/check-ci.sh <lane>`, `bun run test:files` and the `test:*` suites wait their turn, run alone and release. Release checks go first, then FIFO. Do not wait for a coordinator message to start them. `bun scripts/host-test-queue.ts status` shows the holder and the waiters.
- Full runs use eight isolated file workers. Run files with shared ports or shared HOME writes in the serial tail.
- Tests with port 0 and an isolated HOME can run in parallel.
- For a baseline comparison, run only the test files that failed.
- Run long tasks in the background.
- Wait for the completion notice, or check at intervals of 5 to 10 minutes.
- Do not report each check.
- Before commit, remove debug writes to `/tmp` and other debug instrumentation.

## Notify setup

The notify relay sends herdr-core agent events to a Bot and selected human channels.
The Bot routine webhook is required. Human channels are optional.
The default event is `blocked`. Each channel can also receive `done`.

## Install

Use macOS or Linux. Install repo-harness, Bun, and herdr-core (`hc`).
Windows is not supported because this command requires POSIX file permissions.
Run this command in a terminal. The hc core must run.

```sh
rh herdr notify install
```

Enter the required Bot URL and key. Then enter each optional channel value.
Press Enter to skip an optional value. Input is hidden.
Each active channel has an “also notify on done” question. Its default is no.

The command writes the config to `~/.repo-harness/herdr/notify.env` with file mode `600`.
Then it starts the relay with `hc run --bg --no-parent` in an hc terminal named `rh-notify-relay` with the label `repo-harness.role=notify-relay`.
The relay terminal has no parent, so it stays when the install terminal ends.
An hc terminal starts with the core's environment, so install passes the repo-harness home to the relay as `--home <absolute path>`.
The relay child runs `rh herdr notify relay`, a `peer-runtime` command. Its plugin gate reads the recorded selection under the `HOME` of the hc core, not under `--home`. Select `peer-runtime` for that `HOME` too. Otherwise the relay exits 1 with `install_plugin_unavailable`.
When a live relay terminal already exists, install starts no second one.
The relay reads the config again on each event, so a new config takes effect without a restart.
Each read applies the install rules: HTTPS URLs without user information, a Bot URL and key, a complete Telegram target and done flags of `0` or `1`. An invalid config sends nothing, and the relay screen names the broken rule without its value.
Last, the command writes `~/.repo-harness/herdr/notify-install.json` with file mode `600`. It names the relay terminal and its label.
The operator console finds the relay only through that record and reads it on each collection.
Without the record, the console shows `notify_session_missing`. A record that names a session in place of a relay terminal is refused as `notify_session_invalid`. Run install once to write a new record.
Run the command again to replace the config.
Supply all values again. An omitted value removes that channel.

To stop delivery, run `rh herdr notify uninstall`.
It ends and removes the relay terminal with `hc kill` and `hc rm`. Then it removes the config, the install record and the delivery record.
When hc fails, uninstall keeps the files.

## Bot routine webhook

1. Create or select the Bot routine that must receive events.
2. Enable the routine's incoming webhook.
3. Get its HTTPS webhook URL and key from the routine config.
4. Enter `WEBHOOK_URL` and `WEBHOOK_KEY` during install.

The Bot needs this webhook to receive pushes.
The relay sends one bot event envelope as JSON. `assets/herdr/github-events/bot-event.mjs` is the one source of its shape.
The GitHub event Worker sends the same envelope.
It sends the key in `Authorization: Bearer` and `x-webhook-key` headers.
The receiving routine must check the key before it acts on an event.

```json
{
  "protocol": "repo-harness.bot-event/v1",
  "source": "herdr",
  "repository": "repo-harness",
  "kind": "agent.blocked",
  "ts": "2026-11-01T08:00:00.000Z",
  "data": { "host": "mac", "terminal": "t7", "name": "rh-d26-1479", "agent": "codex", "blocked_kind": "permission", "task": "1479", "request_id": "r1" }
}
```

| Field | Rule |
|---|---|
| `protocol` | Exactly `repo-harness.bot-event/v1`. |
| `source` | `herdr` or `github`. The notify relay sends `herdr`. |
| `repository` | The `repo-harness.repository` label value, or `null` when the terminal has no valid label. It never holds a path. |
| `kind` | Lowercase dotted name. The relay sends `agent.done` or `agent.blocked`. |
| `ts` | ISO-8601 UTC time in `Date.prototype.toISOString` form. |
| `data` | A plain object. The relay puts `host`, `terminal` (the hc address), `name`, `agent` (the 7501 `app`), and `blocked_kind` (the 7501 `kind` of a blocked turn) in it, and `task` and `request_id` when the labels give them. |

`assertBotEvent` checks a received body against these rules. It throws `invalid bot event: <field>` for the first invalid field.

`data` names the task and the request id only from the terminal's `repo-harness.task` and `repo-harness.request` labels.
A label value that is not a valid id is left out. The relay never reads them from the working directory or the screen.
The event does not name the branch.
On `done`, the Bot assesses the worker's checks with `repo-harness-check`.
When the branch changed source files, the Bot also reads the architecture evidence in that skill.
On `blocked`, the Bot reads the terminal with `hc read` and resolves the blocker.

## Slack incoming webhook

1. Create a Slack app for your workspace.
2. Open **Incoming Webhooks**. Enable incoming webhooks.
3. Select **Add New Webhook to Workspace**. Choose the target channel.
4. Enter the webhook URL as `SLACK_WEBHOOK_URL`.

See [Slack's setup steps](https://api.slack.com/messaging/webhooks).

## Discord webhook

1. Open the server's **Server Settings** and **Integrations**.
2. Create a webhook. Choose its text channel.
3. Copy the webhook URL.
4. Enter it as `DISCORD_WEBHOOK_URL`.

See [Discord's webhook guide](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks).
The relay disables mentions in its messages.

## Telegram bot

1. Open `@BotFather` in Telegram. Send `/newbot`.
2. Follow its steps. Keep the bot token private.
3. Send a message to the new bot. For a group, add the bot and send a message there.
4. Use the Bot API `getUpdates` method. Read `message.chat.id` for the target chat.
5. Enter `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

A bot with an existing webhook cannot use `getUpdates` at the same time.
Use that bot's received update to get the chat id.
See [Telegram's tutorial](https://core.telegram.org/bots/tutorial) and [Bot API](https://core.telegram.org/bots/api#getupdates).

## Non-interactive install

Use `--non-interactive` to disable prompts.
Flags take priority over environment values.
Pass secrets through your CI secret environment. Shell arguments can enter shell history.

```sh
# Set WEBHOOK_URL and WEBHOOK_KEY through your secret store first.
rh herdr notify install --non-interactive
```

| Value | Flag | Environment variable |
| --- | --- | --- |
| Bot URL | `--webhook-url` | `WEBHOOK_URL` |
| Bot key | `--webhook-key` | `WEBHOOK_KEY` |
| Slack URL | `--slack-webhook-url` | `SLACK_WEBHOOK_URL` |
| Discord URL | `--discord-webhook-url` | `DISCORD_WEBHOOK_URL` |
| Telegram token | `--telegram-bot-token` | `TELEGRAM_BOT_TOKEN` |
| Telegram chat id | `--telegram-chat-id` | `TELEGRAM_CHAT_ID` |

Use `--webhook-notify-done`, `--slack-notify-done`, `--discord-notify-done`,
or `--telegram-notify-done` to add `done` for that channel.
Telegram needs both its token and chat id. URLs must use HTTPS.
Config values cannot contain quotes, backslashes, or control characters.
The command prints no config values. The relay terminal's environment and argv carry no config value.

## Filters and delivery

The relay runs `rh herdr notify relay --home <path>`. It follows `hc events --json --label repo-harness.notify=on`.
Only terminals that carry `repo-harness.notify=on` reach it. repo-harness sets this label when it starts or labels an agent terminal.
A terminal that gets the label after it starts is followed from that point.
The relay sends on each hc `turn` event whose state is `blocked` or `done`. hc raises a turn when the program's OSC 7501 status leaves `working`.
A terminal without 7501 reports has no turns and sends nothing.
Missing Bot config stops delivery for the event.

Each request has a five-second timeout. Redirects stop delivery.
Channels are independent: a failure or an exception in one channel does not stop or hide another channel.
A turn is sent at most once per channel: a successful channel does not send the same terminal, hc turn and state again.
The next hc turn is a new notice and is sent at once.
A failed channel can retry on the next event of the same turn.
There is no background retry queue.

The relay writes the newest result of each channel, and the result of the newest event, to `~/.repo-harness/herdr/notify-deliveries.json` with file mode `600`.
The operator console reads each channel's result from that record. A failed channel does not change the result of another channel.
The relay terminal screen shows one line per attempt, for example `[notify-relay] SLACK: HTTP 200`. Read it with `hc read rh-notify-relay`.
Slack, Discord, and Telegram messages end with the same repository name, task, and request id when known.
HTTP success shows that the endpoint accepted a request.
Check the Bot routine or human channel to confirm receipt.

The relay does not restart itself. When the relay terminal ends, the operator console and `rh doctor` show `relay_stopped`.
Each hc call starts a stopped hc core, and the console status read is an hc call. After the hc core stops, the next status read starts a new core without the relay, so the console shows `relay_stopped`, not `hc_unavailable`.
`hc_unavailable` means that hc did not answer in time. Start a new relay with the written config:

```bash
rh herdr notify start
```

`start` starts nothing when a relay is live. Without a config it stops and names the install command.
`rh herdr notify uninstall` stops a live relay and removes every relay terminal, also finished ones, then the notify files.
