---
schemaVersion: archcontext.adr/v1
title: GitHub is the sole collaboration authority; local task state commits one-way at explicit checkpoints
status: accepted
decidedAt: 2026-11-23
appliesTo:
  - capability.organization.board
  - capability.organization.task-fleet
  - capability.organization.publication
---

# ADR-0007: GitHub is the sole collaboration authority; local task state commits one-way at explicit checkpoints

## Context

`repo-harness-issue-flow` coordinates work across GitHub, local host configuration, linked worktrees, and temporary task files.
Calling GitHub the sole persistent authority on the machine overstates the boundary.
The host also holds persistent non-collaboration authorities and I2-protected worktrees alongside disposable task scratch.

This ADR separates those three state classes at `main@41f46bf2e`, locks the one-way commit boundary and Decision A2, and records two blocked or deferred capabilities.

## Decision

### 1. Three-class state classification

| Class | Scope and owner | Examples and verified paths |
|---|---|---|
| **Cloud Collaboration Authority** (GitHub) | Cross-seat coordination, task ownership, plan ordering, review status, and merges | Issues, labels, milestones, sub-issues, and `blockedBy` edges (`src/effects/board/collect.ts:41,51-66`; `src/core/board/source.ts:174-206`); issue `Boundaries` and `decision`/`scope change` protocol comments (`assets/skills/repo-harness-issue-flow/references/templates.md:16,113-120,307-325`); `repo-harness plan` comments (`src/core/board/plan-block.ts:7-39`; `src/core/board/board.ts:421-431`); `repo-harness issue claim` and `repo-harness issue claim status` (`src/core/board/protocol-comments.ts:46-47,90-97,157-168`; `src/core/board/board.ts:433-438`; `src/effects/board/dispatch.ts:70-86`); `repo-harness boundary question` (`src/core/board/protocol-comments.ts:49,100-145`; `src/effects/board/post.ts:76-87`); PR head SHA and CI checks (`src/effects/board/collect.ts:69-80`; `src/core/board/review-rules.ts:121-130`); PR review threads (`src/effects/review/review-publish-gh.ts:261-282`; `src/effects/review/review-publish.ts:64-65,200-223`); `repo-harness acceptance record` and disposition (`src/core/board/review-rules.ts:32,260-304`; `src/core/board/protocol-comments.ts:202-230,284-291`); squash merges (`src/effects/publication/merge-executor.ts:627-671`; `src/effects/board/merge.ts:29-41`) |
| **Local Persistent Non-Collaboration Authorities** (Host; **never** disposable scratch) | Host settings, cryptographic/immutable verification gates, admission grants, and unpushed git work | `~/.repo-harness/config.json` (`#seats`) via `globalConfigurationPath` (`src/effects/configuration/global-configuration.ts:19-23`), `readSeatsConfiguration`, and `applySeatsSettings` (`src/effects/board/seats-configuration.ts:129-137,426-448`); `~/.repo-harness/gates/<repo>/acceptance-receipts/` (`AcceptanceReceipt`) keyed by `gatesDirectoryName` (`src/effects/git/repository-identity.ts:70-72`), persisted write-once and verified by digest (`src/effects/review/acceptance-receipt-store.ts:32-34,42-100,291-308`; `src/core/review/acceptance-receipt.ts:49-98`); `~/.repo-harness/` review admission grants under `.repo-harness/gates/<worktree>/review-admissions/<campaign>` (`src/effects/admission/admission-store.ts:36-54,88-180`); I2-protected linked worktrees (`/tmp/<repo>-wt-<slug>`, `src/core/worktree-location.mjs:2`; `src/effects/git/managed-worktree.ts:7-25`) holding dirty files, unpushed commits, owner markers, or unallowlisted ignored local data (`src/effects/board/closeout.ts:130-144,158-180`; `src/effects/state/coordination-worktree-topology.ts:109-146,238-250,357-414,679-737`) |
| **Local Ephemeral Task Scratch & Telemetry** (Host; disposable, zero collaboration authority) | Uncommitted single-seat drafts, handoff buffers, and sanitized append-only telemetry | `os.tmpdir()/rh-council/<repo-slug>/issue-<n>-<member>.md` (optional `-<qualifier>`) via `defaultCouncilPlanPath` (`src/core/board/planner-consult.ts:46-51`) and `runCouncilConsult` (`src/effects/board/planner-consult.ts:112-127,154-177`); explicit `--manifest` triage JSON files passed to `rh board triage-apply --manifest <path>` (`src/cli/commands/board.ts:391-414`; `src/effects/board/triage-apply.ts:49-61`; `src/core/board/triage-apply.ts:183-308`), staged by `advisor` at `/tmp/rh-triage/<repo>-<parent>.json` (`assets/skills/repo-harness-issue-flow/references/advisor.md:63-68`); `/tmp/repo-harness-seats/<repository-id>/<seat>/` reset state (`handoff.md`, `request.json`, `session.json`, `reset-log.jsonl`, `claim-*`) (`src/core/board/seat-reset.ts:59,78-96`; `src/effects/board/seat-reset-store.ts:82-181`; `src/effects/board/seat-reset.ts:186-229`); sanitized telemetry at `~/.repo-harness/lifecycle/<repository-id>.jsonl` (`src/effects/board/lifecycle-index.ts:88-110`) and `~/.repo-harness/board/attention-*.jsonl` (`src/effects/board/attention-watch.ts:31-33,46-74`) |

### 2. Core invariants

1. **Local scratch admission test.** Deleting disposable local scratch loses only uncommitted drafts or local telemetry logs; GitHub collaboration state stays intact. Persistent local authorities (`config.json#seats`, `acceptance-receipts/`, admission grants) and linked worktrees with unpushed commits or unallowlisted ignored local data fail this test and never enter disposable scratch. The board itself (`src/core/board/board.ts:60-63`) is a read-only projection over GitHub and `hc` and never writes back.
2. **No editable local mirror and no two-way reconciler.** Every local draft exits only by explicit one-way authoritative CLI commit or abandonment. Unconfirmed or partial writes fail closed and require read-back; commands never write an optimistic local `synced` flag:
   - `rh board triage-apply --manifest <path>` validates red lines (`src/core/board/triage-apply.ts:250-294`), checks `Supersedes:` against live parent comments (`src/effects/board/triage-apply.ts:224`), preflights issue metadata (`:236-238`), and posts labels, sub-issues, refactor bindings, duplicate closures, and the plan comment to GitHub (`:240-275`) without modifying the manifest.
   - `rh board post`, `rh board dispatch`, and `gh` issue/PR commands post directly to GitHub (`src/effects/board/post.ts:76-87`; `src/effects/board/dispatch.ts:129-166`). `dispatch` releases partial or unsent claims on failure (`:106-108,143-146,157-160`) and stops with an inspection error on unknown launch outcomes (`:161`).
   - `rh review publish` and `rh review collect` check the live PR head before each step (`confirmHead`, `src/effects/review/review-publish.ts:151-162`) and fail closed with exit code `5` (`review_publish_unknown` with `inspect_required: true`, or `review_publish_partial`, `:97-107`; `src/cli/commands/review.ts:75`; `src/effects/review/review-collect.ts:171-208`).
   - `rh publication merge` and `rh board merge` send `mergePullRequest` once (`sendMergeOnce`, `src/effects/publication/merge-executor.ts:619-625`), verify bounded GitHub read-back and squash tree proofs (`proveMerge`, `:547-568`; `proveSquashContent`, `:530-544`), and exit `5` (`merge_outcome_unknown`, `:647-651`) when confirmation fails (`src/effects/board/merge.ts:29-41`).
3. **Decision A2: keep existing scratch paths.** Keep `os.tmpdir()/rh-council/<repo-slug>/...`, explicit `--manifest` paths, `/tmp/repo-harness-seats/<repository-id>/<seat>/`, and `~/.repo-harness/{lifecycle,board}/`. Do not migrate them into `/tmp/rh-local/`, do not build a unified TTL garbage collector, and do not extend `rh board closeout` (`src/effects/board/closeout.ts:292-300`) to delete council, triage, or seat-reset directories. Those directories key by repository slug, caller-chosen manifest path across a parent batch, or long-lived repository seat (`src/core/board/planner-consult.ts:46-51`; `src/cli/commands/board.ts:393`; `src/core/board/seat-reset.ts:5,59,78`). By contrast, `runBoardCloseout` authorizes cleanup solely from one merged PR and its linked worktree and panes (`src/effects/board/closeout.ts:81-102,158-204`). Deleting council, triage, or seat-reset directories during PR closeout lacks PR-derived ownership proof under I2.

### 3. Recorded deferrals and blocks

- **Local Investigation Run (`board.jsonl` micro-swarm) — deferred.** Defer until `rh board retro` (`src/cli/commands/board.ts:264-300,488-494`; `src/core/board/retro.ts:149-208`) or issue logs record `>= 3` multi-round (`>= 3` hops) cross-seat investigations that `advisor` + `explorer` (`ALLOWED_SEAT_FLEET_ROLES.advisor` at `src/core/board/seats-settings.ts:162`; `SEAT_ACCESS.advisor` at `src/effects/board/seats-configuration.ts:77`) and two-round `rh seats council --qualifier` (`src/cli/commands/seats.ts:620-626`; `src/core/board/planner-consult.ts:46-50`; `src/effects/board/planner-consult.ts:112-125,138`) cannot cover.
- **In-place Pi worker model switching — blocked.** Blocked until `writerFamily` (`src/core/board/review-rules.ts:415-429`; `src/core/board/board.ts:495`) aggregates all contributing author model families on the head branch instead of reading only `newestProtocolComment` per linked issue (`src/core/board/review-rules.ts:424`) and returning a single `BoardWriterFamily | null` (`:428`). `planReview` (`src/core/board/review.ts:170,190-192,211,220`) uses that single family to select Medium reviewers and check family independence. In-place model switching would drop earlier contributing author families on the branch, unlike `AcceptanceReceipt.author_actual_models` and `modelRelation` (`src/core/review/acceptance-receipt.ts:78,102-109`).

## Consequences

- Agents and operators treat GitHub as the sole collaboration authority while preserving `config.json`, `acceptance-receipts/`, admission grants, and unpushed or ignored-data worktrees under local I2 protection.
- Failed or uncertain remote writes (`dispatch`, `review publish`, `publication merge`) halt for explicit read-back rather than silently syncing or retrying.
- Rollback: `git revert` of this commit. The ADR changes no runtime behavior.
