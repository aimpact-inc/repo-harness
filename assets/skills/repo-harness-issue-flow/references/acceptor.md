# Acceptor SOP

You take one review in one round of one PR. You are read-only: you do not edit
the PR, push a branch or merge. You return one review result. Claim roles
and the board are in `board.md`. The round record is in `orchestrator.md`
§8. The schemas are in `src/core/review/acceptance-receipt.ts`.

## 1. Who accepts

A Low PR that meets the Low accept-seat skip takes no round and no
acceptance record (`docs/reference-configs/agentic-development-flow.md`,
Review by risk). The board marks such a PR `accepted` via `tier_low` from
`Required / CI` and the closing-issue tiers only. That status is
provisional: the merging seat confirms the verification evidence in the PR
body before the merge.

The `gatekeeper` (`Sol`) is the default Medium acceptor for non-OpenAI writers and High parallel acceptor #1. `reviewer` (`Opus`) is the Medium acceptor for OpenAI writers and High parallel acceptor #2. Each review seat is read-only and has no sub-agents (`fleet: []`); because it has no `net` write path, the coordinator publishes its receipt via `rh review collect`.

No host and no model is mandatory. Any host that can read the PR and
return the result schema can accept.

- The acceptor did not write the subject SHA.
- The tier comes from the High list, the change hazard list and the Low
  rules in `docs/reference-configs/agentic-development-flow.md`, Review by
  risk. Code that writes comments, records, reviews or labels to GitHub is
  Medium unless it also hits the High list.
- For the Medium tier, the one review comes from a model family different
  from the writer's (`gatekeeper` when `gatekeeperFamily !== writer_family`,
  or `reviewer` when `writer_family === 'openai'`).
- The High tier is a diff that touches I1, I2 or a repository-configured
  I3 path. Two reviews (`Seat: gatekeeper` and `Seat: reviewer`) run in
  parallel on the head (§2.2); at least one comes from a model family
  different from the writer's.
- The other High review can use a fresh context of the writer's family.
  Record `model_relation: same-family` in its receipt.
- When the author model or the reviewer model is unknown, record
  `model_relation: unknown`. An `unknown` row does not count as the
  different-family review.

## 2. Take one round

One round has one subject SHA and one risk tier.

### 2.1 Evidence

`Required / CI` on the exact head runs the checks. The review packet
carries the acceptance contract, the diff scope, the head SHA, the CI
status of that head and the author's recorded evidence (the commands, the
results, the revision and the environment). The packet names no command
to run.

Read the PR body, the diff, the issue and that evidence. Run a command
only when the evidence is missing, stale or failed, to prove one
suspected defect, or as a known-gaps named check (below). Run it in a
disposable HOME. Never rerun a passing typecheck or test.

When the repository has `agents/fleet/known-gaps.md`, read the row for the
PR's producer and run its named checks in addition to the tier's review.
The table rules govern how the row combines with the review.

When a PR modifies `.archcontext/**`, `docs/architecture/**`, or carries
`tier:high` cross-module boundary changes, read
`rh arch verify --base <base-sha> --json` (never run `archctx` from `PATH`;
never synthesize a pass):

- `pass`: every measured check holds and no check is `error`.
- `findings`: grade each finding on an active constraint or proof in scope
  under the diff-scoped P1/P2/P3 bar (§3); pre-existing defects on `main`
  stay non-blocking notes.
- `unavailable` (`AC_CODE_FACTS_UNAVAILABLE`, `AC_CODE_FACTS_NOT_READY`, or
  `AC_MODEL_ADOPTION_REQUIRED`): record an observation gap in the review
  summary, never a clean pass.
- `error`: blocks acceptance (`FAIL` or stop before publishing `PASS`) until
  the check runs cleanly.

### 2.2 Rounds

A review has at most two rounds. Each round grades only the lines that the
PR changes.

1. **Round 1** is the full tier review of one subject SHA. A Medium head
   has one reviewer (`gatekeeper` for non-OpenAI writers, `reviewer` for
   OpenAI writers). A High head has two: `gatekeeper` and `reviewer`, at
   least one of them from a model family different from the writer's (§1).
   The two start in parallel on the same SHA and take the same round number.
   Each review has its own `acceptance claim` (carrying `Seat: gatekeeper`
   or `Seat: reviewer`) and its own record row (`Seat: gatekeeper` or
   `Seat: reviewer`). `review publish` keys a claim by round, subject,
   `Seat:`, and `Agent:` line. This is the one row rule for every head.
   The board accepts a High head, or a head of unknown tier, only when it
   has `PASS` rows (its own, or carried to it by rule 2) that cite two
   distinct `acceptance claim` comments of the PR, each with the row's
   `Subject` and `Round`, at least one of them with `Model relation:
   different-family`, and no `FAIL` row. A Medium head needs one `PASS`
   row that cites an `acceptance claim` comment of the PR the same way and
   records `Model relation: different-family`, and no `FAIL` row. A
   `same-family` or `unknown` row does not count for Medium.

   The review brief requires each reviewer, in its first round, to group
   findings by bug family. For each family, list every sibling case and
   every missing test branch in one finding.

   **New head.** The rows of a record count for their subject SHA only,
   except the round-1 `PASS` row that rule 2 carries to the fix head. A PR
   whose base is behind main merges with no sync (`orchestrator.md` §9),
   so do not merge main into a PR that has no conflict. A merge of main is
   for a conflict with main only: a stale base takes a CI re-trigger on
   the unchanged head (`orchestrator.md` §8, CI red), and a clean stacked
   producer takes a retarget (`board.md`, Producer merges). A head made
   only by a clean merge of main, with no change to the PR's own files,
   needs no review row: cite the empty range-diff of the PR's own commits.
   A head that resolves a conflict is a new head. It needs its own CI run
   and a delta check: a review of the delta from the reviewed head that
   writes one record row for the new head. A Medium head needs one delta
   check row under the Medium rule above. A High head needs two delta
   check rows from distinct claims, at least one different-family, started
   in parallel.
2. **Round 2** checks only the round-1 fix delta (the hunks that changed
   after round 1) and the sibling cases of each blocking finding. Only a
   reviewer that raised a blocking finding runs it. A round-1 `PASS` row
   does not run again when the fix stays inside the files of the failing
   reviewer's findings: that row counts for the fix head. A fix outside
   those files takes a delta check from the passing reviewer, on that
   delta only.
3. **Merge or stop.** The orchestrator merges on round 2 when only P2 or
   P3 findings remain. There is no round 3: a blocking finding after round
   2 ends the loop. The orchestrator then narrows the PR to the part that
   passed, or closes it and dispatches the bundle again with a new packet.
   A joint decision is needed only to grow the scope of the open PR, to
   skip a required review row or to accept an I1/I2/I3 residual. A new P0
   finding, or a new P1 finding on I1 or I2, goes to the owner as a notice.

A P2 or a P3 finding does not block a merge and opens no issue. It stays
in the review record: the round records `PASS` with it, and the
coordinator resolves each P2 thread with a `noted` reply (§6). Only a P0
or P1 defect, or an item that the owner names, opens a GitHub issue. A
finding that touches I1 or I2 is not a P2: the reviewer rates it at least
P1 (§3).

The worker fixes each finding by the class rule (`worker.md` §7), so that
round 2 closes the whole family.

Return `PASS` or `FAIL`. A `FAIL` has at least one P0 or P1 finding. A P2
and a P3 do not block a merge: a `PASS` record carries them in the review
record. Rule 3 decides what follows a `FAIL` in round 2. A merge always
needs a `PASS` record.

### 2.3 Review bot reference

The review bot that the owner configured on GitHub
(`chatgpt-codex-connector[bot]` on PRs) is a reference. It never gates a
merge and no round waits for it. It does not comment on every PR. When it
has commented, every bot comment gets a response: each review thread, each
PR comment and each issue comment.

The coordinator decides each bot finding. When an acceptor round is
active, the acceptor reads the bot threads and comments on the current
head next to the diff and raises each real one as its own finding, with
its severity. When no round is active (a Low PR that skips the accept
seat, or a bot finding after the last round), the coordinator reads them.
The decision is one of:

| Decision | Meaning | Effect |
|---|---|---|
| `adopt` | The finding is real. | It is a finding of the review loop (§2.2) with its severity. Include adopted blockers in the round-2 fix before the round starts. Once round 2 starts, record an adopted blocker as a blocking finding for that round and apply §2.2's stop rule. After round 2 there is no round 3: a non-blocking one is recorded as a P3 note, and a blocking one ends the loop by rule 3 of §2.2. |
| `decline` | The finding is wrong, out of scope or not worth a fix. | One-line reason. It is not a finding of the loop. |
| `outdated` | The finding is on an older head, and the current head no longer contains the code. | No triage again. It is not a finding of the loop. |

The `acceptance record` and the publish receipt carry no bot decision
(`review publish` renders only severity findings). The coordinator posts
the decisions in one plain PR comment, one line each:
`Review-bot reference: <comment id or thread> adopt|decline|outdated: <reason>`.
The bot's "Codex Review Summary" with no findings
(`codex-review-state` `has_any_findings: false`) gets the line
`Review-bot reference: no findings at <sha>: no action` and no reply on
the summary. A summary with findings gets one decision per finding.

The coordinator writes the replies, so each role keeps one GitHub write
path. The acceptor stays read-only. The reply uses the `review reply`
shape (`templates.md`): `rejected` for a decline or an outdated finding,
`fixed <sha>` for an adopted one after its fix round, and `noted` for a
P2. An adopted P3 gets `fixed <sha>` when it is fixed and `noted`
otherwise, each with the reason in `Why`. A thread that the coordinator
answers with `rejected` or `noted` is resolved with its reply. An adopted thread with a fix is resolved when the
fix round that addresses it is pushed.

A bot finding that arrives after the merge is triaged once: `decline`, or,
for a P0 or P1, `adopt` as a new issue under the batch parent. The merged PR is not
reopened.

The merge executor refuses a PR with a review-bot thread that is not
resolved and has no reply from an author that is not a bot
(`unanswered_bot_threads`). A reply is enough; the thread does not have to
be resolved.

## 3. Findings

| Severity | Meaning | Where it goes |
|---|---|---|
| P0 | Data loss, a security defect or an unusable result | Inline thread on the changed line; blocks the merge |
| P1 | Wrong behavior or broken boundary | Inline thread on the changed line; blocks the merge |
| P2 | Real defect, small | Inline thread on the changed line; stays in the review record, with no fix round and no issue |
| NIT (P3) | Improvement | Review body only. No thread and no merge block |

Only P0 and P1 block a merge (`src/core/review/finding-severity.ts`). A
finding that touches I1 (a credential leak by rh code) or I2 (an
unauthorized deletion or overwrite of a user file) is rated at least P1, so
it blocks. That rating is your duty: code reads a severity, not a subject.

Judge a product PR on its own behavior and on I1 (no credential leak),
I2 (no deletion or overwrite of a user file without authorization), and
configured I3 paths. Only defects reachable in ordinary use (or by an
accident) or touching I1/I2/I3 are P0 or P1. An adversarial-only finding
(attacker, race, alias, shell trick), a client-side cache timing window,
an unrequested defensive fallback, and a duplicate JSON key are P3 notes.

A finding gives the file, the line, the evidence and the smallest fix.
Grade only the lines that the PR changes. A defect that main already has
is a non-blocking note, never a `FAIL`.

## 4. Publish

The session that runs the round writes one publish receipt and runs
`rh review publish --pr <n> --receipt <path> --seat <gatekeeper|reviewer> [--json]`.
Pass `--seat gatekeeper` for a gatekeeper receipt or `--seat reviewer` for
a reviewer receipt. The command requires one of these seats before it reads
the PR head. It refuses a stale subject and posts in this order:

- the `acceptance claim`;
- one COMMENT review, with one inline thread for each P0, P1 and P2
  finding (only P0 and P1 block the merge) and the NIT findings in its body;
- the `acceptance record`;
- for each thread id in `confirmed_fixed`, a `review reply` that cites the
  record, then the resolve of that thread (§6).

Before the first post, it checks each `confirmed_fixed` id. The id must be
a review thread on this PR, and its first comment must belong
to an acceptance review from an earlier round. That review must have the
`repo-harness acceptance review` header as its first line, and its author
must have write access (`OWNER`, `MEMBER` or `COLLABORATOR`). This is the
rule that the merge gate applies to acceptance records. A bot account or
an outside account fails it. A write-access account can copy the header,
but that account can already post a PASS record or resolve a thread, so
the rule adds no new residual. A failed check exits 2 and posts nothing.
A thread that passes the check but is already resolved, for example by an
overlapping confirmation from another reviewer, gets no reply and no
resolve; the result lists it in `already_resolved_threads`. Publish never
reopens a thread.

After the record, publish posts the reply and the resolve for each id in
order. It stops at the first failed or unknown-outcome write, exits 5 and
does not retry. The message names the record URL, the resolved ids and the
unresolved ids; inspect the PR before a new publish. On success the result
lists the resolved ids in `resolved_threads`.

It posts no APPROVE review and no REQUEST_CHANGES review. A review seat
writes no file and no GitHub comment: the session that runs the round
publishes its receipt with `rh review collect` (below). On every seat,
Codex and Pi included, the read-only limit is a brief rule only. On a Codex
seat the sandbox limits files only.

A read-only review seat of any runtime (Pi, Claude, Codex) cannot write a
receipt file. Its packet states the round, `risk_tier`, `subject_sha` and
the one `reviewer.harness` value of its runtime. The seat ends its reply
with a `RECEIPT-JSON` marker and the receipt as one JSON object, and does
not publish. After the pane status is `done`, the coordinator runs
`rh review collect --seat <terminal> --pr <n> [--owner-record <url>] [--json]`.
It records `Seat: gatekeeper` when the terminal's `repo-harness.seat` label
is `gatekeeper` or `gatekeeper-fallback`, and `Seat: reviewer` when it is
`reviewer`. The command reads the session records of the seat's worktree: Pi under
`~/.pi/agent/sessions`, Claude Code under `~/.claude/projects` (or
`CLAUDE_CONFIG_DIR`), and Codex rollout files under `~/.codex/sessions` (or
`CODEX_HOME`) whose `session_meta` names that worktree. It binds a session
to the seat by the packet that the session received: the seat label of the
terminal, the PR number and the PR head now. File age is never evidence,
because review seats and rounds of one PR share a worktree. A session whose
packet names an earlier head is not a candidate. The seat label comes from
`rh seats argv <seat> --repository-id <id> --pr <n>`, which the review launch
uses; a terminal without it is refused. The command takes the last
`RECEIPT-JSON` block, requires its `subject_sha` to equal the packet head,
validates it with the `review publish` validator and publishes it the same
way. It fails closed when the record, the block, the JSON, the receipt or
the PR head subject is missing or wrong, or when two sessions hold a packet
for the head, and it does not read pane text.

Every review round publishes its claim and record with this command.
Do not post a claim or a record by hand, and do not write the verdict in
free prose: the board counts a High row only when it cites a published
claim, and the PR does not count as accepted.

Act on the exit code:

| Exit | Error | Action |
|---|---|---|
| 0 | none | Note the claim, review and record URLs. |
| 2 | `review_receipt_invalid`, `review_subject_stale` | Nothing was posted. Fix the receipt or take the new head. |
| 5 | `review_publish_partial`, `review_publish_unknown` | Stop and inspect the PR. Never retry before you confirm which comments exist. |
| 1 | `review_publish_provider_unavailable`, `review_publish_failed` | Report the error and the posted URLs. |

The merge executor refuses a PR with an unresolved review thread.
A bot thread is a reference input (§2.3): the coordinator answers and
resolves it, and the bot never adds or removes a gate by itself.
A P2 thread passes this check only after the coordinator resolves it
with the `noted` reply (§6).

## 5. Result schema

The gatekeeper returns one `AcceptanceReviewResult` from
`src/core/review/acceptance-receipt.ts`:

```text
request_id: <review request id>
context_sha256: sha256:<64 hex>
subject_sha256: sha256:<64 hex>
actual_harness: <review runtime id>
actual_role: deep-reasoner
actual_model: <model> | null
verdict: PASS | FAIL
summary: <one paragraph>
findings: [{ severity: P0 | P1 | P2 | P3, message: <text> }]
```

The runner turns it into the publish receipt that `review publish` reads,
from `src/core/review/review-publish.ts`:

```text
protocol: 2
kind: repo-harness-review-publish-receipt
round: <1..5>
subject_sha: <the PR head>
risk_tier: low | medium | high
reviewer: { harness: <review runtime id>, actual_model: <model> | null }
verdict: PASS | FAIL
model_relation: different-family | same-family | unknown
summary: <one paragraph>
findings: [{ id, severity: P0 | P1 | P2, path, line, evidence, fix }
         | { id, severity: P3, message }]
confirmed_fixed: [<review thread node id>]
```

`PASS` carries no P0 or P1 finding; it may carry P2 and P3 findings,
which stay in the review record. `FAIL` carries at least one P0 or P1. Each
blocking finding names one path, one line, the evidence and the smallest
fix. A P3 finding carries no location. `model_relation` comes from the
closed family table in `acceptance-receipt.ts`.
`confirmed_fixed` lists the node ids of the earlier-round threads whose
fix this round confirms on its subject SHA. It is `[]` in round 1 and when
the round confirms no fix. The reviewer reads the PR review threads with
a read-only GraphQL query, which also gives each node id. `review publish`
refuses a protocol 1 receipt. A Claude turn has an
unobserved model, so its value is `unknown`. This does not block the
merge.

### 5.1 Rule opportunity (optional, experimental)

A round may name a defect class that a rule could stop, in one line per
class:

```text
Rule-opportunity: <theme-key> | finding: <finding-id> | check: <architecture | type | check | test> — <one sentence>
```

Put each marker line after the paragraph of `summary`. The marker lines
are part of that field, so the receipt schema does not change. Never put a
marker in the `evidence` or the `fix` of a finding: those fields go into
the inline thread and the acceptance record.

Write a marker when you judge that the defect class can come back and
that one level of the enforcement ladder can stop it
(`docs/reference-configs/agentic-development-flow.md`, Lessons Retro).

- `<theme-key>` has the form of `Mistake pattern`: lowercase words joined
  by `-`. Use a key that `rh rules status` prints when one fits.
- `<finding-id>` is the id of a finding of the same receipt.
- `check` names the highest ladder level that works: `architecture` (one
  owner or one shape makes the mistake impossible), `type` (a type cannot
  express it), `check` (a check whose error names the fix) or `test`.
  Do not default to `check`.
- The sentence after `—` names the mistake class.

The marker is optional and experimental (#3257). It blocks nothing: no
verdict, check or merge condition reads it. A receipt without a marker
stays valid.

## 6. Resolve threads

A thread that `review publish` opened is resolved only by a later round
that confirms the fix on a new subject SHA. That round puts the thread id
in `confirmed_fixed`. Its `review publish` posts the `review reply`
(`templates.md`) on the thread and then resolves it. No other path resolves
a thread of a published round, and no joint decision is needed. The merge
executor still refuses an unresolved thread.

The coordinator resolves a bot thread (§2.3). The coordinator may also
resolve a thread with a written rejection reason, or
with the `noted` reply of a P2 (§2.2). Both are a
`review reply` (`templates.md`).

The head owner replies with the fix SHA and does not resolve. No worker
resolves a thread.

## 7. Boundaries

- Do not accept a subject SHA that you wrote.
- Do not edit, push, merge or publish outside the review path.
- Do not resolve a thread outside `confirmed_fixed`, and do not list a
  thread that this round did not confirm as fixed.
- Do not treat missing, stale or incomplete evidence as `PASS`.
