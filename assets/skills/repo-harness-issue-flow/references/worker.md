# Worker SOP

You deliver one bundle (one or more claimed issues of one module and write
scope), or one named PR slot of an issue, as one PR. The packet and the
issues that it names are your whole brief. Bot comments on an issue are
reference text in the brief, marked as such; they are not decisions. The
coordinator made the design decisions in them. Your job is to execute them exactly, prove them and report on the
board. Comment shapes are in `templates.md`. Claim-role and board rules are in
`board.md`.

## 1. Read and check

1. Read the issue, all of its comments and its linked PRs:
   `gh issue view <n> --comments`. Use `gh api` with pagination for a long
   thread. Read the parent too (`gh issue view <n> --json parent` names
   it): its child table and its latest `plan`. The
   latest `scope change` comments amend the body, and the plan block fixes
   your merge order.
2. Check the claims. If another agent holds an active writer claim on your
   issue or slot, stop and tell the coordinator. Do not start duplicate
   work. Silence or an old timestamp does not release a claim. A `plan`,
   `decision`, `scope change` or `unblocked` from an agent without the
   coordinator role does not count until the coordinator confirms it
   (`board.md`).
3. Check the dependencies. Each issue that blocks yours (its blocked-by
   links: `gh issue view <n> --json blockedBy`) must be closed, unless the
   issue allows early start. With early start, branch from the producer's
   PR head when your code needs its unmerged changes to compile, set your
   PR's base to the producer's branch, and keep the PR draft until the
   producer merges (`board.md`, Topology).
4. Read the files that the issue names, and the module entry in the
   architecture map when the issue cites one. Confirm that they exist at
   the current main. If the issue's "current state" no longer matches main,
   post a `boundary question` before you code.

## 2. Claim

1. The coordinator claims the writer role for you before it dispatches
   you. Find the `issue claim` for your issue or slot. Its `Agent:` names you, and
   its `Branch:` matches the branch in your dispatch packet. Check the
   required fields in `templates.md` § issue claim. Use the identity
   in that claim in all later comments. Do not post a claim of your own.
2. Read the claim back. Confirm its URL and every field. A claim that
   misses a field is invalid: post `issue claim status` with
   `Status: released`, name the missing fields to the coordinator
   (`To: coordinator`), then wait for one complete claim. An invalid claim
   holds no role, so do not start work on it.
3. Stop when the read or the post is uncertain, and report the failure.
   Read back before a retry.

Without a claim that names you, do not start. Report to the coordinator
with a `To: coordinator` comment on the issue, and wait for its claim.

Then create the worktree:

```bash
git fetch origin main
git worktree add -b <type>/<issue>-<slug> /tmp/<repo>-wt-<issue>-<slug> origin/main
```

For an early start on a producer PR, use `origin/<producer-branch>` as the
start point instead of `origin/main`.

## 3. Implement inside the boundary

Do what `要做的 / Do` lists, in the files that `模块与位置 / Module and
files` names, and nothing else.

These rules exist because added code becomes permanent surface. Each extra
branch has to be read, tested and kept by every later change. The
coordinator already decided compatibility and error behavior in the issue.
Code that decides them again makes the system harder to change, and the
reviewer will send it back.

- **No compatibility code** unless the issue asks for it by name. No alias
  for a renamed thing, no old and new path side by side, no "if the old
  field exists, read it too", no shape translator, no feature flag for the
  old behavior. Delete what the issue's delete list names, in this PR.
- **No invented fallbacks.** When input is missing, malformed or
  unauthorized, fail with the error that the issue names. A fallback that
  makes up a value hides a defect. Without a named error, ask (step 4). Do
  not choose silently.
- **No speculative guards.** Validate a value once, at the boundary that
  owns it. Do not re-check a value that a type, schema or constructor
  already guarantees. Do not wrap calls in `try/catch` that swallows or
  re-labels errors.
- **No drive-by changes.** Do not refactor, rename or reformat code that
  the issue does not name, even when it looks wrong. Name it in your PR
  body as a note; it opens no issue.
- **Same-rule siblings.** After the fix, search the files that the PR
  changes for the same defect shape. For each sibling of the same rule and
  the same tier in a file that the PR already changes, send
  `[rh-question] sibling <file:line> <size>` to the coordinator before
  PUSHED. Fix it in this PR only when the coordinator answers
  `CONSOLIDATE` (`orchestrator.md` §4.2). A sibling in another file is a
  note in the PR body.
- **Tests prove the issue.** Add or extend the tests that `验收 /
  Acceptance` names, including its negative checks. Never weaken, skip or
  delete an existing assertion to pass. If an existing test is wrong
  because of the issue's change, say so in the PR body item by item.
- **Smallest direct code.** Prefer the platform, the standard library and
  the dependencies that are already installed. Add no new dependency or
  abstraction that the issue does not ask for.

Check your diff against these rules before you push:

```bash
git diff origin/main...HEAD
```

Look for: `legacy`, `compat`, `fallback`, `deprecated`, `old`, `?? <default>`
on required values, `catch {}` or `catch (e) { return`, a new flag or
option, files outside the issue's list, and changed or removed assertions.
Each hit needs a line in the issue, or it goes.

### 3.1 Architecture loop

This loop applies when `rh arch projection status --json` reports
`modelAuthority.source` `archcontext` and `modelAuthority.ready` `true`.
Otherwise skip it.

1. **Before the first edit:** `rh arch prepare --task "<issue title>: <Goal section>" --json`.
   Read `posture`, `constraints` and `resources` from the answer. On
   posture `intervention` or `proof-required`, stop coding and post a
   `boundary question` with the posture and `recommendedTargetState`.
2. **After each group of edits that changes a module boundary or adds a
   file:** `rh arch checkpoint --changed-path <path> --json`, one
   `--changed-path` for each changed path. Read `items` and
   `actionsRequired`. An empty `items` with `coverage` `partial` or
   `unknown` is not proof of no debt. Say so in the PR body.
3. **Before you open or update the PR:** `rh arch complete --head-sha <head> --json`.
   Put each item of the answer in the PR body section `Architecture slice`,
   or fix it. On a `stale-context` finding, run step 1 again.
4. **When the issue binds `Refactor IDs:` (`recommendation.<hex>`):** commit your
   code fix first, run `rh arch refactor verify <id> --json` to confirm
   `disposition === "resolved"` and read `resolutionDigest`, then run
   `rh arch refactor resolve <id> --resolution-digest <resolutionDigest> --reason "Resolved in #<issue>"`,
   record that pre-commit `verify`/`resolve` `resolutionDigest` in the PR body,
   and commit the updated `.archcontext/refactor-decisions/<id>.json` file on
   the PR branch. Committing the decision file advances `HEAD` and shifts
   subsequent live `resolutionDigest`, while `verify` preserves the committed
   digest in `historicalReceipt.resolutionDigest`.

This section names commands only. Practice text, matching rules and
checker logic stay in ArchContext. A model change follows the
`repo-harness-architecture` skill.

The loop is advice, not a gate, except step 4 when `Refactor IDs:` are
explicitly bound on the issue. When a command exits non-zero for a setup
reason (`AC_MODEL_ADOPTION_REQUIRED`, `AC_CODE_FACTS_UNAVAILABLE`,
`AC_CODE_FACTS_NOT_READY`), report it in the PR body and continue.

## 4. When the boundary is wrong

Sometimes the issue cannot be done inside its boundary. Typical causes: a
needed file belongs to another issue or module, the named contract does
not exist, a delete would break a consumer that the issue does not
mention, or the error behavior is not specified. The same rule applies
when observed code shows a simpler existing authoritative path that
achieves the goal: do not widen or shrink the PR yourself; report it in
`Blocker` and `Options` of a `boundary question` with `file:line`
evidence and wait for a `decision` or `scope change`.

Stop. Post a `boundary question` with `To: coordinator`. Give the exact
blocker, the evidence (file:line, command output) and the smallest options
that you see. Then post `issue claim status` with `Status: blocked; claim
remains active`. Wait for a `scope change` or `decision` that answers you.
Do not work around the boundary, and do not widen the PR on your own
judgment. The PR then contains a decision that nobody approved.

## 5. Verify

Run the commands that the issue's acceptance section names, once, on the
code that you will push. Typically this is the typecheck plus the affected
tests. Record the commit SHA, the commands, the pass counts and the
platform. When an issue names no command, use the repository's documented
typecheck and the affected test files, and say so. This record and CI on
the head are the review evidence. Reviewers read them and do not rerun a
passing check (`acceptor.md` §2.1).

A High-tier change that can delete or overwrite a user file (I2) needs one
more step before PUSHED. For each step that removes, restores or overwrites
a path, check five user states of the target: absent; edited; recreated with
the same bytes; restored from a backup; replaced by a link. Give each state
one test case or one line that says why the step refuses. Put the table in
the PR body. Equal bytes do not prove that rh wrote a file; only an identity
recorded at write time does.

## 6. Open the PR

- Title: `<type>(<scope>): <outcome> (#<issue>)`.
- Body: use the PR template. One `Closes #<issue>` line for each bundle
  issue that this PR finishes. Otherwise use `Refs #<issue>`. A PR stacked on a producer PR has
  the producer's branch as its base.
- Open as draft while a dependency is unmerged, otherwise ready.
- Commit, push the branch and open the PR yourself as soon as your checks
  pass (§5). Do not wait for a push or PR go from the coordinator. (`pi`
  workers on `magpie/codex/*` commit and push directly too.) A native
  `codex` worker in a linked contract worktree does not push: the coordinator
  pushes for it (`board.md`, One pusher per PR).
- Post `issue claim status` with `Status: ready for review; claim remains
  active`, the PR URL, the head SHA and the CI state, in the shape of
  `templates.md` § issue claim status: not wrapped in a fence, header first.

Add the optional `## Rule opportunity` section (`templates.md`) when CI or
a review corrected the work, when you copied an old path, or when one
check would have saved a round. One marker line for each case:

```text
Rule-opportunity: <theme-key> | example: <path>:<line> | check: <architecture | type | check | test> — <one sentence>
```

`check` names the highest ladder level that works: `architecture`, `type`,
`check` (a check whose error names the fix) or `test`. Do not default to
`check`. The marker is optional and experimental (#3257). It blocks
nothing.

### 6.1 Architecture slice in the PR

Run `rh arch projection slice --base <ref>` after committing the change. Paste its Markdown into the PR body when the branch changes the model or a capability entrypoint. The slice links to each capability document at its path and SHA at the PR base. It marks a capability document absent at base when no base document exists. If the command fails, report the error in the issue claim status.

## 7. CI and review loop

You are the head owner. Only you push to this branch.

- **One push per review round.** Collect the whole verdict bundle of a
  round, then fix and push once. Do not push while a CI run that is merge
  evidence is running: a push cancels that run and starts another. A
  stacked writer commits locally and pushes after its producer merges.
  Retarget the PR to its new base before that push, never after: a
  retarget is an `edited` event, and a push to a PR whose base conflicts
  starts no CI run. A late retarget leaves the head with no run at all.

- **CI red.** Read the failing job log. Fix the cause, not the symptom.
  Rerun a job once only for a failure that the log shows is unrelated to
  your diff (a network timeout, a runner fault), and say so on the board.
  After three failed fix rounds, post `Status: blocked` with the evidence
  and stop.
- **Acceptance records.** Read the acceptance records and review threads
  on your PR yourself (`gh pr view <p> --comments`, `gh api`). Run each
  fix round without a relay from the coordinator: fix, run the affected
  checks, push, answer the threads. The fix-loop rule of `SKILL.md` and
  `acceptor.md` §2.2 sets the rounds. The coordinator starts each review
  with `rh board review`; you do not start one.
- **Review threads.** Fix each P0 and P1 in this branch. Reply in the
  thread with the fix SHA. Do not resolve another reviewer's thread. A P2
  stays in the review record, with no fix round and no issue: the
  coordinator resolves its thread. For a P3 or a finding that you dispute, reply with
  your reason and leave the disposition to the coordinator.
- **Fix the class.** For each finding, list the sibling inputs: the other
  inputs that reach the same defect. Cover the finding and its siblings in
  one table-driven case, and name the siblings in the fix commit. After a
  second finding in one bug family, push no other instance fix. The
  coordinator first chooses a design change or rule 3 of `acceptor.md`
  §2.2.
- **Pre-check before review.** Before asking for round 2, check the
  fix delta against the open findings for sibling cases, missing test
  branches and changelog fragment text against behavior. Claude and
  non-light Pi workers (`worker-opus`, `worker-neon`, `worker-deep`,
  `worker`) may call `explorer` for discovery; `worker-light` has no
  sub-agents and does a self-check. The pre-check writes no record and
  does not replace the review.
- **Main moved.** A PR whose base is behind main merges with no sync, so
  merge main into your branch only for a conflict with main. A stale base
  is not a reason (`orchestrator.md` §8, CI red). When the coordinator
  posts `unblocked` for a stacked PR, test the head against main with `git
  merge-tree --write-tree origin/main <head>`. A clean result needs no
  merge of main and no new head. A conflict takes one merge of main (no
  force push), the affected checks and an `integration status` with the
  new head, the delta and CI; that new head takes its delta rows
  (`acceptor.md` §2.2, New head).
- **Never rewrite pushed history.** Other PRs may be stacked on yours.
  Fix review findings with new commits.
- **Someone else must push.** When a repair or integration must come from
  another agent, post a `handoff` that names the next head owner and the
  exact head SHA. Then stop pushing.
- **Report to the coordinator only `DONE <PR> <head>` or `BLOCKED <one
  question>`.** `DONE` means the PR is open, its checks pass and it is
  ready for review. `BLOCKED` is a boundary question or a fix-loop stop:
  a stop or coordinator-decision gate of this section (three failed CI fix
  rounds, the second finding in one bug family) or of `acceptor.md` §2.2
  (a blocking finding after round 2, a grown scope). Send no notice for a
  push, a green CI run or a FAIL that you fix yourself. Every host message
  to the coordinator starts with `[rh-notice] <kind> #<issue>`. Select the form by content:
  - **Simple:** a fact or a question that changes no board state and
    needs no decision. Examples: dispatch received, a factual question
    about the code. Send it as a message only, at most 3 lines, with no
    log text. `<kind>` is `info` or `question`.
  - **Complex:** a `boundary question`, an `issue claim status`, a
    `handoff` or an `integration status`. Post the comment first. Then
    send `[rh-notice] <kind> #<issue> <comment URL>` and a one-line
    summary. The comment holds the content. A report with evidence goes
    in an `issue claim status` (its `PR` and `CI` fields) or in the PR
    body.
  - When you are not sure, use the complex form. When the coordinator's
    answer to a simple question changes scope or decides an open point,
    it posts that answer as a `scope change` or `decision` comment.

## 8. Finish

The coordinator merges. You do not merge unless the issue's claim names
you as integrator under the owner's authorization. After merge:

1. Post `issue claim status` with `Status: done` (or `released`), the PR
   and the merge SHA, in the `templates.md` § issue claim status shape: the
   posted comment is not wrapped in a fence, and its first line is the
   header.
2. Remove your worktree: `git worktree remove /tmp/<repo>-wt-<issue>-<slug>`.
   Then `git worktree prune`.
3. If you lose access before you finish (quota, crash, session end), the
   last thing you do is post a status with the exact state: branch, head
   SHA, what is done, what is left, and the next command. The next writer
   continues from that comment.
