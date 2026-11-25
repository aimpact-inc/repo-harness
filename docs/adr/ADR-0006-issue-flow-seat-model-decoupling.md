---
schemaVersion: archcontext.adr/v1
title: Decouple issue-flow seat roles, Magpie-vs-native model catalog, sub-agent topology, and pre-dispatch bundling
status: accepted
decidedAt: 2026-11-20
appliesTo:
  - capability.organization.board
  - capability.verification.acceptance-review
  - capability.workflow-engine.contract-assets
  - capability.runtime-harness.operator
  - capability.runtime-harness.hook-adapters
---

# ADR-0006: Decouple issue-flow seat roles, Magpie-vs-native model catalog, sub-agent topology, and pre-dispatch bundling

## Context

Owner decisions on 2026-11-20 ([#3343](https://github.com/aimpact-inc/repo-harness/issues/3343)) align `repo-harness-issue-flow` with two deployment environments—**Magpie-equipped hosts** (where `pi` routes Gemini, GPT, GLM, and DeepSeek through the local Magpie gateway with unified `src/pi/extension.ts` hooks and prompt caching) and **Native-only hosts** (where `claude`, `codex`, and `agy` CLIs run directly without Magpie)—under the owner's account pools (`2 × Claude Max`, `1 × Google Ultra`, `ChatGPT`, and Flash APIs).

State at `main@8d7017ea6682ca840a84163f1d96c75675c80b54` exhibits seven structural couplings:

1. **Scattered model metadata and hidden `gpt-6.2-astra` spend.** Model IDs, vendor families, quota accounts, and sub-agent targets are split across five files (`src/core/review/model-family.ts:4-13`, `src/core/board/recommended-models.ts:6-55`, `src/core/board/seats-settings.ts:33-163`, `src/core/board/seat-routing.ts:51-105`, `src/effects/terminal/task-role-profiles.ts:5-9`). `AGENT_TARGET_OVERRIDES` maps `deep-reasoner` and `harness-evaluator` to `gpt-6.2-astra` (`src/core/board/recommended-models.ts:8-9`), and `MAGPIE_REVIEW_MODEL` imports `AGENT_TARGET_OVERRIDES['deep-reasoner']` (`src/effects/review/magpie-endpoint.ts:18-25`), spending `gpt-6.2-astra` on Codex sub-agents and review rounds. `WORKER_LIGHT_MODEL` (`src/core/board/seats-settings.ts:110`) disagrees with `SEAT_RECOMMENDED_MODELS` (`src/core/board/recommended-models.ts:17-18`), marking the default `worker-light` seat `outside_recommendations` (`src/core/board/seat-pool.ts:179`).
2. **Transport coupling across `pi`, `codex`, and `agy`.** No catalog separates a logical model (`neon`, `sol`, `terra`, `hydrogen`) from its transport (`pi` `magpie/...` vs. native `codex`/`agy`). Native `codex` workers in linked worktrees cannot commit or push (`src/core/board/seat-launch.ts:153-155`), forcing `orchestrator` to commit and push for them even when `pi` `magpie/codex/*` is available. Meanwhile, native `agy` lacks `gemini-4-hydrogen` in the catalog, omits read-only `rh` commands from `AGY_COMMAND_PREFIXES` (`src/core/board/seat-launch.ts:289-294`), and risks `effectiveSeatConfig` overwriting a native `agy` model ID with Pi's `magpie/agy-cli/gemini-4-neon` (`src/core/board/seat-routing.ts:55,100-103`). Conversely, `piLaunch` (`src/core/board/seat-launch.ts:277`) unsets `REPO_HARNESS_SEAT*` without setting them on `advisor`, and `ResetHost` (`src/effects/board/seat-reset-store.ts:54`) omits `'pi'`.
3. **Inverted worker tiering, `frontend` runtime lock, and unprotected Google Ultra quota.** `WORKER` (`src/core/board/recommended-models.ts:19`) omits `gemini-4-neon` and ranks `gpt-6.2-sol` ahead of the retired Tier-B GPT model. `FRONTEND_SEAT_IDS` and `decodeSeatsRecord` (`src/core/board/seats-settings.ts:11,416`) reject non-Claude seats in `routing.frontend`, stalling UI/UX work when Claude enters `saving`. `selectSeatRoute` (`src/core/board/seat-routing.ts:156-161`) bypasses non-Claude deep seats and jumps straight to `worker-light` when Claude is reserved. `seatAccountQuotas` (`src/core/board/seat-routing.ts:29-43`) defines no saving floor for `agy_gemini`, allowing workers to exhaust the single Google Ultra account and starve `advisor`.
4. **Overloaded singleton `planner` seat and Codex sandbox failure.** `planner` (`src/core/board/seats-settings.ts:14,139`) collides semantically with `repo-harness plan`, `advisor-plan`, and Claude's built-in `Plan` agent. `SEAT_RECOMMENDED_MODELS.planner` offers `codex: gpt-6.2-astra` (`src/core/board/recommended-models.ts:31`), which `runPlannerConsult` refuses at launch (`src/effects/board/planner-consult.ts:100-102`). A single stored `SeatConfigV1` prevents opening `1..3` distinct models in one consultation.
5. **Review seat attribution coupled to local `config.json` and `Opus` drain on Medium PRs.** `collectBoard` reads local `seats.reviewer.model` (`src/effects/board/collect.ts:584-591`) and `reviewRecords` infers the review seat from `modelFamily(row.model) === reviewerFamily` (`src/core/board/review-rules.ts:214-228`). `planReview` (`src/core/board/review.ts:161`) dispatches `reviewer` (`claude/opus`) for every Medium PR whose writer is not `anthropic` (OpenAI, Google, DeepSeek, Zhipu), draining Claude Max instead of using `gatekeeper`.
6. **Over-privileged worker sub-agents and `sonnet` explorer spend.** `agents/fleet/explorer.md:5` defaults to `sonnet` on Claude. `DEFAULT_SEATS_CONFIG` (`src/core/board/seats-settings.ts:137-144`) leaves `orchestrator.fleet` empty (`[]`) while granting `deep-reasoner` to four worker seats, letting workers invent local design trade-offs instead of escalating via `boundary question`.
7. **Post-hoc bundling and fragmented clustering.** `decodeOpenIssue` (`src/effects/board/cluster.ts:88-90`) hides parent sub-issues during `--open` reads, while `--parent` hides loose repository issues. `clusterIssues` (`src/core/board/cluster.ts:221-250`) slices buckets by issue number rather than file overlap, leaves `pattern_groups` out of `suggested_merge_order`, and places intake triage on the event-bound `orchestrator` instead of `advisor`.

## Decision

### 1. Logical model catalog and Magpie-First vs. Native-First presets

`SEAT_RUNTIMES = ['claude', 'codex', 'pi', 'agy']` stays intact. One module (`src/core/board/model-catalog.ts`) defines each logical model once and maps it to its **Magpie route** (used when `pi` and `~/.pi/agent/extensions/magpie.ts` are present) and its **Native CLI route** (used when Magpie is absent). Once written to `~/.repo-harness/config.json#seats`, the stored `{ runtime, model }` remains the sole launch authority (no silent runtime fallback).

| Logical line | Family | Account pool | Magpie-First route (preferred when Magpie exists) | Native-First route (preferred without Magpie) | Permitted planes |
|---|---|---|---|---|---|
| `opus` | `anthropic` | `claude` | `claude` / `opus` | `claude` / `opus` | `orchestrator`, `worker-opus`, `reviewer` |
| `fable` | `anthropic` | `claude` | `claude` / `fable` | `claude` / `fable` | `council` only |
| `haiku` | `anthropic` | `claude` | `claude` / `haiku` | `claude` / `haiku` | Claude `explorer` sub-agent |
| `carbon` | `google` | `agy_gemini` | `pi` / `magpie/agy-cli/gemini-4-carbon` | `agy` / `gemini-4-carbon-high` | `council` (and hyper `advisor`) |
| `neon` | `google` | `agy_gemini` | `pi` / `magpie/agy-cli/gemini-4-neon` | `agy` / `gemini-4-neon-high` | `advisor`, `worker-neon` (high), `worker-neon-deep` (xhigh) |
| `hydrogen` | `google` | `agy_gemini` | `pi` / `magpie/agy-cli/gemini-4-hydrogen` | `agy` / `gemini-4-hydrogen` | Pre-paved `agy` light worker & explorer |
| `astra` | `openai` | `chatgpt` | `pi` / `magpie/codex/gpt-6.2-astra` | `codex` / `gpt-6.2-astra` (via host `-o` write) | **`council` only** (banned from coding, review, sub-agents) |
| `sol` | `openai` | `chatgpt` | `pi` / `magpie/codex/gpt-6.2-sol` | `codex` / `gpt-6.2-sol` | `worker-deep`, `worker`, `gatekeeper`, `deep-reasoner`, `harness-evaluator` |
| `luna` | `openai` | `chatgpt` | `pi` / `magpie/codex/gpt-6-luna` | `codex` / `gpt-6-luna` | Codex `explorer` sub-agent |
| `glm-flash` | `zhipu` | Flash API | `pi` / `zai/glm-5.3-flash` | — (uses `sol` / `hydrogen` natively) | `worker-light`, `gatekeeper-fallback`, Pi `rh-explorer` |
| `deepseek-flash` | `deepseek` | Flash API | `pi` / `magpie/group/deepseek-v4.1-flash` | — (uses `sol` / `hydrogen` natively) | `worker-light` alt, `gatekeeper-fallback` alt |
| `glm-5.4` | `zhipu` | Flash API | `pi` / `magpie/zcode/GLM-5.4` | — | `worker-light`, `reviewer`, `gatekeeper-fallback` |

- **Why Codex also prefers `pi` `magpie/codex/*` when Magpie is present**: `pi` workers on `magpie/codex/gpt-6.2-sol` commit, push, and run fix rounds directly in linked worktrees (eliminating `orchestrator` commit/push proxy turns), share `src/pi/extension.ts` hooks, and still meter against `chatgpt` (`isPiCodexSeat`). Only `touches:credentials` tasks exclude `pi` (`src/core/board/dispatch.ts:213`).
- **Pre-paving native `agy`**: `seatAccount` maps native `agy` `gemini-*` (`carbon`, `neon`, `hydrogen`) to `agy_gemini`; `effectiveSeatConfig` preserves native `agy` model IDs instead of substituting `magpie/agy-cli/...`; `AGY_COMMAND_PREFIXES` adds read-only `rh board`, `rh quota`, `rh seats pool`, and `rh seats council` commands. Native `agy` stays off by default in the Magpie preset until upstream prompt-cache behavior matures.
- **Quota rules**: `sonnet` is retired so `2 × Claude Max` (optionally split by seat profile between Control/Review Max #1 and Execution Max #2) serves `opus` and `fable` only. `SeatRoutingV1` adds `agy_saving_below_remaining` (default `25`, range `0..100`) to stop Neon worker dispatches below 25% weekly `agy_gemini` remaining and protect `advisor`.

### 2. Twelve-seat topology and routing chains

`SEAT_IDS` holds 12 seats. `rh update` adds `worker-neon-deep` to saved configurations.

| Plane | Seat ID | Magpie-First preset | Native-First preset | Role boundary |
|---|---|---|---|---|
| Control | `orchestrator` | `claude` / `opus` (`high`) | `claude` / `opus` (`high`) | Coordinator and integrator; owns L1 plans, plan publication, and merges |
| Control | `advisor` | `pi` / `magpie/agy-cli/gemini-4-neon` (`xhigh`) | `agy` / `gemini-4-neon-high` (or `claude/opus`) | Owner interface, pre-dispatch triage and bundling, L2 plans, `council` (`N=0..3`), 2 h audit |
| Council | `council` | `{claude:fable, pi:magpie/agy-cli/gemini-4-carbon, pi:magpie/codex/gpt-6.2-astra}` | `{claude:fable, agy:gemini-4-carbon-high, codex:gpt-6.2-astra}` | Read-only L3 competing proposals under `/tmp/rh-council/<repo>/issue-<n>-<member>.md` |
| Execution (Tier S) | `worker-opus` | `claude` / `opus` (`high`) | `claude` / `opus` (`high`) | UI/UX #1 (`frontend`), cross-module contracts #1 (`important_deep`), `touches:credentials` #1 |
| Execution (Tier S) | `worker-neon` | `pi` / `magpie/agy-cli/gemini-4-neon` (`high`) | `agy` / `gemini-4-neon-high` (when enabled) | `frontend` and `important_fast` |
| Execution (Tier S) | `worker-neon-deep` | `pi` / `magpie/agy-cli/gemini-4-neon` (`xhigh`) | `agy` / `gemini-4-neon-xhigh` (when enabled) | `important_deep` and `simple_deep` |
| Execution (Tier A) | `worker-deep` | `pi` / `magpie/codex/gpt-6.2-sol` (`high`) | `codex` / `gpt-6.2-sol` (`high`) | GPT workhorse for boundary-locked backend, CLI, and state-machine work |
| Execution (Tier B) | `worker` | `pi` / `magpie/codex/gpt-6.2-sol` (`high`) | `codex` / `gpt-6.2-sol` (`high`) | Fast GPT execution (`important_fast` #3, `simple_fast` fallback) |
| Execution (Tier B) | `worker-light` | `pi` / `zai/glm-5.3-flash` (also `deepseek-v4.1-flash` and `glm-5.4`) | `agy` / `gemini-4-hydrogen` (or `null`) | Fast bounded execution (`simple_fast` #1, <=10 files, non-credential) |
| Acceptance | `gatekeeper` | `pi` / `magpie/codex/gpt-6.2-sol` (`high`) | `codex` / `gpt-6.2-sol` (`high`) | Default Medium acceptor for non-OpenAI writers; High parallel acceptor #1 |
| Acceptance | `gatekeeper-fallback` | `pi` / `zai/glm-5.3-flash` | `null` (or `agy` / `gemini-4-hydrogen`) | Replaces `gatekeeper` only while `chatgpt` is exhausted |
| Acceptance | `reviewer` | `claude` / `opus` (`high`) | `claude` / `opus` (`high`) | Medium acceptor for OpenAI writers; High parallel acceptor #2 (0% Google Ultra review spend) |

Default `seats.routing` order (evaluated strictly left-to-right after filtering reserved or exhausted accounts, with `savingRoute` removed and `FRONTEND_SEAT_IDS = ['worker-opus', 'worker-neon']`):

- `frontend`: `['worker-opus', 'worker-neon']`
- `important_deep`: `['worker-opus', 'worker-neon-deep', 'worker-deep']`
- `important_fast`: `['worker-opus', 'worker-neon', 'worker', 'worker-light']`
- `simple_deep`: `['worker-neon-deep', 'worker-deep']`
- `simple_fast`: `['worker-light', 'worker']`

For a manual dispatch with eligible Opus and Neon candidates, the orchestrator normally picks the account with more weekly quota left.

`piLaunch` sets `REPO_HARNESS_SEAT*` on reset seats, and `ResetHost` includes `'pi'` for bidirectional automated handoff reset between `orchestrator` (`Opus`) and `advisor` (`Pi-Neon`).

### 3. Sub-agent (`fleet`) topology across `claude`, `codex`, `pi`, and pre-paved `agy`

Per-runtime sub-agent backing models:

| Fleet role | `claude` (`~/.claude/agents/*.md`) | `codex` (`~/.codex/agents/*.toml`) | `pi` (`rh-*` via `PI_SUBAGENT_EXTRA_AGENT_DIRS`) | `agy` (pre-paved) |
|---|---|---|---|---|
| `explorer` | `haiku` (`high`) | `gpt-6-luna` (`high`, `read-only`) | `zai/glm-5.3-flash` (`read, grep, find, ls, bash`) | `gemini-4-hydrogen` |
| `deep-reasoner` | `opus` (`high`) | `gpt-6.2-sol` (`high`, `read-only`) | `magpie/codex/gpt-6.2-sol` (`high`, read-only tools) | `gemini-4-carbon-high` |
| `harness-evaluator` | `opus` (`high`, standalone eval) | `gpt-6.2-sol` (`medium`, standalone eval) | Not mounted | Not mounted |

Per-seat `fleet` grants (`SEAT_ACCESS` and `DEFAULT_SEATS_CONFIG`):

| Seat group | Allowed & default `fleet` | Reason |
|---|---|---|
| `advisor` | `['explorer', 'deep-reasoner']` | Uses parallel Flash `rh-explorer` for repo-wide triage/bundling and `rh-deep-reasoner` (`Sol`) for fast boundary checks before `council` escalation |
| `orchestrator`, `council` | `['explorer']` | Offloads file/symbol discovery to `haiku`/Flash while keeping architectural judgment in the primary model |
| `worker-opus`, `worker-neon`, `worker-neon-deep`, `worker-deep`, `worker` | `['explorer']` | Locates code and runs pre-round-2 sibling checks; revoking `deep-reasoner` forces open boundary questions back to `orchestrator` |
| `worker-light`, `gatekeeper`, `gatekeeper-fallback`, `reviewer` | `[]` | Bounded <=10-file tasks and diff-scoped reviews run without sub-agent fan-out; Pi review seats enforce `--no-extensions -e src/pi/extension.ts` |

### 4. Planning tiers and `advisor`-controlled `council` (`N = 0..3`)

- **L1 (single-module, UI/UX, bounded fixes)**: `orchestrator` (`Opus`) writes the issue `Do`, `Boundaries`, and `Delete list` directly (`N = 0`).
- **L2 (batch plans, replans, skeleton locking for `Sol`)**: `advisor` (`Neon`) drafts the proposal or 15-30 line skeleton; `orchestrator` (`Opus`) validates and posts it (`N = 0`).
- **L3 (new large modules, cross-module contract refactors, contested invariants)**: `advisor` selects `N ∈ {1, 2, 3}` from `{fable, carbon, astra}` based on complexity and `rh quota`, then runs `rh seats council --issue <n> --members <csv> [--question <focus>]` (auto-resolving `herdr.space` from caller labels):
  - `N = 1`: `fable` (backed by `2 × Claude Max`, cross-family to `Neon`), or `carbon`.
  - `N = 2`: `fable,carbon` when `agy_gemini` is healthy; `fable,astra` when `agy_gemini` is near its saving floor.
  - `N = 3`: `fable,carbon,astra` only for major architectural splits or I1/I2 redesigns.
  `advisor` synthesizes the blind `/tmp/rh-council/` outputs into one proposal for `orchestrator`; workers never read `/tmp/rh-council/`.

### 5. Seat-decoupled acceptance projection

- `rh review collect` writes `Seat: <gatekeeper | reviewer>` from the terminal's `repo-harness.seat` label into `acceptance claim` and `acceptance record`. `gatekeeper` launches of `gatekeeper-fallback` carry `Seat: gatekeeper`.
- `BoardV1` removes `reviewer_family` and `collect.ts#reviewerFamily`; `reviewRecords` and `gatekeeperReviewEvidence` attribute rows by `Seat:` while `acceptance` continues to check `Model relation: different-family` from `modelFamily`.
- `planReview` selects `gatekeeper` (`Sol`) for Medium PRs whenever `gatekeeperFamily !== writer_family` (covering `Opus`, `Neon`, and Flash writers) and selects `reviewer` (`Opus`) when `writer_family === 'openai'`. High PRs start `gatekeeper` (`Sol`) and `reviewer` (`Opus`) in parallel.
- Review briefs enforce the `AGENTS.md` severity bar: only defects reachable in ordinary use or touching I1/I2/I3 are P0/P1; adversarial-only assumptions and unrequested defensive fallbacks are P3 notes.

### 6. `advisor`-led pre-dispatch triage and multi-issue PR bundling

- `advisor` (`Neon` + parallel Flash `rh-explorer`) runs pre-dispatch intake triage and writes a bundle manifest (`/tmp/rh-triage/<repo>-<parent>.json`) grouping cohesive issues into multi-issue `merge_order` array units (`[[#a, #b, #c], ...]`) so one bundle uses one worktree, one worker, one CI run, and one review.
- `rh board cluster` adds `--include-loose` (combining loose open issues with unclaimed parent sub-issues), groups standard-tier issues by explicit target-file overlap before count slicing (2-6 issues, 150-500 lines), emits cross-module mechanical bundles for shared `pattern:<theme>` labels, and caps `tier:high` same-file pairs at 2 issues. `tier:high` never mixes with lower tiers, `route:frontend` never mixes with backend routes, and parallel bundles never share a target file.
- Board attention rule `R8` (`P2`, `route: 'advisor'`) fires when `board.plan` contains two or more unclaimed single-issue entries sharing `module:` and `tier_bucket` without external blockers.
- `orchestrator` (`Opus`) audits the manifest against the three split red lines and applies labels, sub-issue links, duplicate closures, and the updated `repo-harness plan` via `rh board triage-apply --manifest <path> [--dry-run]`.

## Consequences

- Environments with Magpie run GPT (`Sol`/`Astra`) and Gemini (`Neon`/`Carbon`) through `pi` with unified hooks, prompt caching, and direct worktree git operations, while environments without Magpie run native `claude`, `codex`, and pre-paved `agy` (`gemini-4-hydrogen` included) from the same logical catalog.
- Claude Max quota is preserved for `orchestrator` (`Opus`), `worker-opus` (UI/UX #1 and core contracts), `reviewer` (`Opus`), and `council` (`Fable`); routine non-OpenAI Medium reviews spend zero Claude tokens.
- Google Ultra quota spends 0% on PR review and reserves its bottom 25% for `advisor` (`Neon`).
- `gpt-6.2-astra` spend drops to zero outside explicit `advisor`-triggered L3 `council` runs.
- Stored `~/.repo-harness/config.json#seats` sections require a one-shot `rh update` migration (`SeatsConfigMigrationRequiredError`) to rename `planner` → `council`, `worker-important` → `worker-opus`, `worker-important-fast` → `worker-neon`, retire `gatekeeper-deep`, and add `agy_saving_below_remaining`. The migration adds a missing `worker-neon-deep` key with a null value and preserves the saved routes. Use Settings > Seats to enable the seat and add it to a saved route.
- Rollback before code slices land: `git revert` of the ADR commit. Each implementation slice (#3343 children) carries its own `git revert <squash-commit>` rollback.
