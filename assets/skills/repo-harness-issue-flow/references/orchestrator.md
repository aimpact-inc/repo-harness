# Orchestrator SOP

You turn one goal into a parent issue and a set of child issues. You
dispatch workers, follow their PRs to merge and close the parent. You do
not implement child issues. Seats, dependencies and the comment board are
in `board.md`. Body and comment shapes are in `templates.md`.

You run in a long-lived top-level session on any host with network
access, in this skill's orchestrator mode. Start the seat with the argv
that `rh seats argv orchestrator` prints. Any host and any
capable model may hold the seat.

Post your own `issue claim` with `Role: coordinator` on the parent before
you dispatch. Only you post `issue claim` comments: the claim for each
worker is yours, and it names the worker. Every later instruction to a
worker is a comment on its issue or PR.

Contents: §1 Preflight · §2 Split · §3 Write the boundaries (§3.1
Planning tiers and `council`) · §4 Parent issue (§4.1 Release set, §4.2 Intake
triage) · §5 Gap review · §6 Publish ·
§7 Dispatch (§7.1 Quota check) · §8 Follow up (§8.1 Triage queue) ·
§9 Merge and integrate (§9.3 Board merge, §9.4 Auto-pilot mode) · §10 Close out.

## 1. Preflight

1. Read the goal source: the user's request, a PRD, a design document or
   an existing parent issue. Note the requirement and scenario IDs. Issues
   cite them, so that acceptance can be traced.
2. Check the architecture authority. Run
   `rh arch projection status --json`. Split only when
   `modelAuthority.source` is `archcontext` and `modelAuthority.ready` is
   `true`. Otherwise stop splitting and follow `next` until the
   repository is adopted: `repo-harness-architecture`, section
   "Adopt ArchContext in a repository". A split made against an unadopted
   model writes boundaries that the capability documents do not have.
   The result of `rh arch projection check --json` does
   not carry `modelAuthority` or `next`. Do not use it as this gate.
3. Read the module map. Prefer `docs/architecture/archimap.html`. If the
   map is missing or older than the architecture model, refresh it first
   with the `repo-harness-archimap` skill. A split that is made against a
   stale map puts module boundaries in the wrong place.
4. Read the open issues and PRs in the area (`gh issue list`, `gh pr list`,
   then `gh issue view <n> --comments`). Record each active claim, linked
   PR and handoff. Reuse existing issues. Never open a duplicate for work
   that someone has already claimed.
5. Pin the base. Record `main@<short-sha>` for every "current state"
   section that you write.

## 2. Split

Make one child issue for each pair of module and observable outcome.

- **One write scope.** The files of one issue belong to one module of the
  map. Two issues that must touch the same file are one issue, or one of
  them goes first and the other depends on it.
- **Contract first.** For a cross-module change, the issue that owns the
  contract (wire format, API, schema, type, route) goes first. Producers
  and consumers depend on it. A consumer may start early only when its
  issue says so. It then stacks on the producer's PR branch and stays
  draft until the producer merges (see `board.md`). Early start is what
  lets three workers run at once on a chain of dependent modules.
- **Reviewable size.** One PR is one module + tier work package. Target
  150-500 product lines; 500 is a target, not a cap. The High-list split
  wins over size: do not mix a High-list path (credentials, deletion,
  release) with Medium or Low work. Split before acceptance,
  not after.
- **Seat fit.** Size an issue by its files too. A light seat (a small model
  with no sub-agents) converges on an issue that lists about 10 files or
  fewer; a wider issue on such a seat runs for hours and opens no PR. Give a
  wider change to a deep seat. A wide mechanical change (one helper, one
  rename, across many modules) conflicts with every open PR on its files:
  give it a plan position where no other open PR writes those files, first
  or last in the set, never beside them.
- **Order.** Contract and types → core logic → effects and adapters →
  CLI or server → UI → docs and map. Deletion of the old path goes with
  the change that replaces it, never as "cleanup later".
- **Bundles.** Fine child issues stay requirement units. In the plan,
  group the open issues of one module and write scope into one bundle
  unit, an array entry of `merge_order` (`templates.md`, plan): one
  worker, one worktree, one PR, one CI run, one review. The plan block is
  the only record of bundle membership. A `tier:high` issue never shares
  a unit with a Low or Medium issue; Low and Medium may combine. A High
  unit holds only issues of one file and one rule, two at most: in the
  #2841 retro 30 of 38 High PRs failed round 1, a High PR can close after
  round 2, and a larger High diff makes that close more probable and then
  costs the whole unit. A P2 or P3 review finding stays in the review
  record and gets no issue.

## 3. Write the boundaries

Write each child issue so that a literal and cautious worker produces the
same code as a careful senior engineer. Before writing `要做的 / Do`,
check whether relaxing one non-I1/I2 requirement or reusing an existing
authoritative value removes code; record each dropped case and its reason
in `不做 / Out of scope`. Keep changes deeper, not bigger: probe
uncertain technical choices before encoding them in `要做的 / Do`, and
leave only non-experimental preference choices to the owner. Make every
decision in the issue:

| Decision | Write it as |
|---|---|
| Module and file scope | Put the module ID from the map in the `module:` label. List the main files and test files in `模块与位置 / Module and files` |
| What must not change | `边界 / Boundaries`: forbidden files and modules, invariants that must hold |
| What gets deleted | `边界`: a delete list of old functions, flags, routes, files. Deleted in this PR |
| Compatibility | `边界`: "No compatibility path. <old thing> is removed, not aliased." When compatibility is really needed, name the exact migration, who runs it and when it is deleted |
| Error behavior | `要做的 / Do`: each failure case with its exact error code, status or message. On an I1/I2 path: "Fail closed with X", never "handle errors gracefully". Elsewhere: the error and its handling |
| Out of scope | `不做 / Out of scope`: items that a worker would plausibly add. Name the issue that owns each, when one exists |
| Proof | `验收 / Acceptance`: observable checks that start from raw inputs (live files, real protocols, real CLI/CI outputs) with test file names and scenario IDs, at least one negative check for what must NOT happen, and at least one external check beyond the writer and reviewer instead of self-confirming mocks only |
| Verification commands | `验收`: the exact commands, for example typecheck plus `test:files <files>` |

Words that leave a decision open: "robust", "graceful", "backward
compatible", "flexible", "handle edge cases", "as needed", "etc.". Replace
each one with the concrete case, or delete it.

Give the reason for a boundary when it is not obvious. A worker that knows
why a route stays server-only will not put it in the client "for
convenience".

Write the brief by responsibility, not by file list. Name the paths that
another worker owns, and the stop conditions: another owner's path, a
contract or wire format outside the issue, user data, credentials, a
release. Inside the boundary the worker edits every file the change needs.
Give the decision, not a menu: exact names, limits and the variables to
remove. Default to a clean refactor: change every caller, delete the old
path and update the tests in the same change. Keep compatibility only
where the issue names a concrete reason.

Add a blocked-by link only when writing or testing the issue requires the
merged code of the blocker. Name the required symbol or file in the plan
note. Use `merge_order` to sequence PRs that share files. After the earlier
merge, the later writer rebases unpublished work once. For a pushed branch
that conflicts with main, follow `worker.md` §7.

### 3.1 Planning tiers and `council`

Follow the three planning tiers (`ADR-0006` §4):

- **L1 (single-module, UI/UX, bounded fixes):** Write the issue `Do`,
  `Boundaries`, and `Delete list` directly (`N = 0`).
- **L2 (batch plans, replans, skeleton locking for `Sol`):** Ask `advisor`
  (`Neon`) to draft the proposal or a 15–30 line skeleton (target
  functions and signatures, delete list, exact error codes, forbidden
  fallback and compatibility branches); validate and post it (`N = 0`).
- **L3 (new large modules, cross-module contract refactors, contested
  invariants):** `advisor` selects `N ∈ {1, 2, 3}` members from
  `{fable, carbon, astra}` and triggers `rh seats council --issue <n>
  --members <csv> [--parent <n>] [--space <id>] [--question <focus>]`
  (`advisor.md` §1.1), writing blind proposals to
  `/tmp/rh-council/<repo>/issue-<n>-<member>.md` and synthesizing one
  unified proposal for you.

Keep the L1/L2/L3 ladder above when auto-pilot is off. While auto-pilot is
on (§9.4), keep council at `N = 0` by default. Consult only when code
inspection and probes do not settle a genuine technical or architectural
trade-off. Start with `1` cross-family member, and use `2` or `3` only for
an unresolved one-member consultation or a rare major fork. Never use
council to decide I1, I2, or production deployment boundaries. Park those
items for the owner (§9.4).

Review the `advisor` proposal against the architecture map, the open issues
and the rules in force. Paste only the decisions you accept into the
issue's `要做的 / Do` and `边界 / Boundaries`, then dispatch. The GitHub
issue stays the single requirement authority: a worker reads its issue and
its dispatch packet, never a file under `/tmp/rh-council/`. A proposal or
skeleton is input to the issue text. It replaces no issue field, no
acceptance row and no review row.

## 4. Parent issue

The parent issue holds the goal, the child table and the done criteria. Use the parent template. Keep the table current. Edit the
status column when a child changes state, so that the parent is one
screenful of truth.

The role/status column uses only `unclaimed`, `unclaimed · waits for
#n`, `writer <agent> · active`, `writer <agent> · PR #p` and `merged`.
The claim comment wins over the table.

A parent with more than two children gets a `plan` comment before
dispatch. Its plan block holds the merge order, the holds and
the seat limit (`templates.md`, plan). Post it with `rh board post plan`, so
its block decodes before `rh board --parent <n>` reads it. A plan change is a
new `plan` with `Supersedes:`; never edit the old comment. A parent with two
children or fewer needs no plan.

The merge order follows the dependencies, not the order of filing.
`board merge` stops at the first open entry of the merge order, so one held
entry blocks each ready PR behind it. Put a held issue, and an issue that
waits for an owner answer or an external release, at the tail. Move it
forward again when its blocker goes.

Put the rest of the plan in GitHub fields (`templates.md`, Plan data):
link each child as a sub-issue of the parent, add one blocked-by link for
each dependency, set the milestone of the release window, and add one
`tier:` label. Do not write `Depends on` lines. Nothing reads them. A
dependency is done when its blocker issue is closed.

A parent whose open children still hold old `Depends on` / `依赖` lines
moves them once, in two steps:

1. Run `rh board migrate-dependencies --parent <n>`. It writes
   nothing. It lists every planned label and every planned link as
   `#X blocked by #Y (line N: <source line>)`, each existing item, each
   skipped line, the refused or unparsed lines that stop a write, and the
   plan digest.
2. A person checks every listed link against its source line. Then run
   `rh board migrate-dependencies --parent <n> --apply --plan
   <digest>`. It plans again and writes exactly the planned items. When the
   new plan differs from the checked one, it writes nothing
   (`dependency_plan_changed`); start again at step 1.

A refused or unparsed line stops every write. A body with a code or HTML
marker refuses all of its declarations, and only the template forms parse.
Delete the refused line from the body (add the link by hand if it is
needed), then run again.

### 4.1 Release set

A release costs the owner an approval and each user an update. Plan its
content before the work, not after the merges.

- **Train.** A train is a blocked-by chain of issues that delivers one
  result, for example one contract issue and its consumers. Read the trains
  from the blocked-by links and the file overlaps of the open issues, across
  every batch parent.
- **Set.** The release set is the list of trains that the next release
  ships. Each issue of the set carries the milestone of that release; an
  issue without the milestone is not in the set. A train with an external
  blocker or an owner hold is in no set until the blocker goes, so that it
  cannot hold the release.
- **Critical path.** Name the longest serial chain of the set. Dispatch its
  head first and give it the scarce seats: the release date is its end.
- **Record.** The advisor proposes the set (`advisor.md` §4). When you
  accept it, post one `decision` comment on each batch parent with the
  train table: train, result, order, state. Update it when a train changes.
- **Release run.** Propose the release when every issue of the set is closed
  and the daily full run is green. A fix that users need before that is the
  one reason for an earlier patch release. A change that the seats
  themselves need ships with the set: the seats run the installed release,
  so a merged change does not change the host before a release, and an
  unreleased build is not installed as the host CLI.

### 4.2 Intake triage

Each new issue costs a dispatch slot and moves the end of the batch. Sort
each open or new issue once, and log the call in one line on the parent
plan:

| Call | When | Action |
|---|---|---|
| `DO` | It blocks the release set, records a P0 or P1 defect, or the owner named it | Put it in a bundle of its module |
| `CONSOLIDATE` | An older issue has the same requirement (a duplicate), or an open bundle has the same write scope | A duplicate: copy the missing text into the older issue, then close the newer one with a link. A distinct requirement in a bundle's write scope stays open: add it to the bundle claim and to the PR's `Closes` list |
| `SHELVE` | An owner roadmap item, or an item that a vendor or upstream blocks | Label `status:deferred` and keep it open, off the dispatch board. It closes only on the owner's word |
| `CLOSE` | An agent-spawned P2 or P3 issue | Close it as not planned |

When a symptom or request is ambiguous, list 2–3 candidate root problems with each candidate's observable distinguishing sign before filing or bundling so intake solves the right problem.

`advisor` leads pre-dispatch intake triage and bundling (`advisor.md` §1.2): it runs `rh board cluster --parent <n> --include-loose --json` (and handles attention rule `R8`), groups non-overlapping issues by `target_files` and `pattern:<theme>`, and sends `/tmp/rh-triage/<repo>-<parent>.json`. Audit the manifest against the three split red lines (`tier:high` isolated and `<= 2` per bundle; `route:frontend` isolated; distinct parallel units sharing zero `target_files`), resolve missing/invalid labels or truncated reads, then preview and apply labels, sub-issue links, duplicate closures, and the `plan` comment in one step:

```bash
rh board triage-apply --manifest /tmp/rh-triage/<repo>-<parent>.json --dry-run
rh board triage-apply --manifest /tmp/rh-triage/<repo>-<parent>.json
```

Use `rh board cluster --open --json` for loose issues outside a parent.

A defect of one rule in one file costs one PR, one CI run and one review.
Three rules keep it that way:

- **Same-rule sibling.** A writer sends `[rh-question] sibling <file:line>
  <size>` before PUSHED (`worker.md` §3). Answer `CONSOLIDATE` when the
  sibling is in the same file or function, has the same tier, and the
  total stays inside the reviewable size (§2). The sibling then joins the
  PR. Post one line on the issue, and add a `Closes` line only when an
  issue for the sibling exists. Otherwise name the reason. A sibling in
  another module follows the contract-first order (§2). Before the PR is
  open, the call is yours. On an open PR it grows the scope, so it is a
  joint decision.
- **Base defect in round 1.** A round-1 row can name a base defect of the
  same rule and the same file. Decide it before the merge. It joins the
  round-1 fix only when that fix already changes the same function.
  Otherwise it is one issue, and its dispatch may start from the merged
  branch state. Round 2 absorbs nothing: it checks only the round-1 fixes,
  and a new P1 inside them ends the loop.
- **Standalone lane.** Two open standalone issues with one rule and one
  file go to one seat as one brief with two `Closes` lines. Issues with
  different write scopes keep one issue per brief.

Before you file a new issue during a batch:

1. Search the open issues and PRs for the same design and consolidate a
   duplicate into the older issue.
2. File it only for a P0 or P1 defect, a blocker of the release set or an
   owner-named item. A P2 or P3 review finding stays in the review record.
3. Give it its parent, its `module:`, `tier:` and `route:` labels, its
   blocked-by links and its milestone at once. Add a `pattern:` label
   when the defect matches a known theme key. An issue without a parent
   is in no plan and no seat takes it.
4. Read an owner instruction at the scope of its words before it becomes an
   issue. A one-time authorization is an operation for now, not a product
   change; ask for the standing rule when the product needs one.

## 5. Gap review

Before you publish a set of three or more issues, or any set that crosses
more than one module boundary, send the drafts to a reviewer from a
different model family. Ask it to find holes only:

- a file that no issue owns, or that two parallel issues own;
- a dependency that is missing or circular;
- a decision that is still open (see the word list in step 3);
- an acceptance check that cannot be observed or run, or that relies only on self-confirming mocks instead of the owning runtime boundary or an external check;
- a requirement ID from the source that no issue covers.

You decide what to fold in. The reviewer does not rewrite the split. Use
the host's cross-model channel (for example a Codex terminal in a Herdr.app pane).
Record the review in the parent issue as one comment that lists the
findings and the disposition of each.

## 6. Publish

1. Write each body to a file in your scratch directory and create it with
   `gh issue create --title <title> --body-file <file>`. Never build bodies
   with shell interpolation.
2. Create children in dependency order, then edit the parent table with the
   real numbers (`gh issue edit <parent> --body-file <file>`). Add the
   sub-issue links, the blocked-by links, the milestone and the
   `module:`, `tier:` and `route:` labels.
3. Read every issue back (`gh issue view <n>`) and check the links and the
   rendering.

Title shape: `<area> <phase>.<n>｜<module>：<outcome>（<requirement IDs>）`
when the repository uses phases, otherwise `<module>: <outcome>`. The
module is in the title so that a list view shows the write scopes.

## 7. Dispatch

- One bundle goes to one worker as one decision-complete packet
  (`templates.md`, dispatch packet): the goal, the `Closes` list, the exact
  file boundary, the design choices already made, the non-goals, the exact
  fast test command, the round cap and the stop conditions. The issues
  stay the requirement authority; the packet names them and adds the
  bundle decisions, so the worker asks no design question. The worker
  replies `DONE <PR> <head>` or `BLOCKED <one question>`.
- Post the claim, then the packet. `rh board dispatch --parent <n>
  --space <id>` starts one seat, one worktree and one tab for each ready
  unit of the plan, and posts the claim on each open issue of the unit,
  with the required fields in `templates.md` § issue claim and, for a
  bundle, the `Issues:` line. A unit starts only when every open issue of
  it is ready, and starts nothing otherwise; a closed issue of a unit is
  not work and does not stop it. A bundle unit needs one tier label on
  each issue, never mixes `tier:high` with a lower tier, and never mixes
  `route:frontend` with another route; its route is the join of the
  member routes (one `important_*` makes it important, one `*_deep` makes
  it deep). `--issues <a>,<b>,<c>` selects one declared unit by its exact
  issue set; any other set is refused with `not a plan unit; post the
  plan again with rh board post plan`. The claim is the worker's identity
  on the board, and the worker never posts one. Dispatch only after the
  claim is on each issue of the bundle.
- When a worker seat is free and a bundle skips only as `blocked`, use
  `rh board dispatch --issues <unit> --early-start` if the bundle can be
  written and tested before the blocker merges. Log the decision in one
  line on the parent issue. Use the dependency rule in §3.
- Each parallel worker gets its own worktree from a clean base.
- Run `git fetch` in the main checkout before `rh worktrees start`. The
  helper bases the worktree on the upstream of the base branch and does not
  fetch.
- Keep at most 8 active writer seats under one coordinator. A seat is
  active until its PR is merged or its claim status is `done` or
  `released` (`board.md` Claim roles). Hold further
  dispatches until a seat ends. Each active worker adds notices to your
  queue (§8.1), and more than 8 makes the owner wait.
- Default model preference: no role is bound to one vendor. At dispatch,
  prefer the deepest available model for architecture and contract issues,
  and the execution model for bounded single-module issues. With one model
  available, it takes both. The preference never becomes a requirement.
- A seat may idle. When no bundle with a clear return is ready, leave the
  writer seats idle: an idle seat spends no quota and no memory. Do not
  file or propose work to fill a seat.
- Under auto-pilot (§9.4), execute each hourly `[advisor-plan]` for ready
  batch-parent units without waiting for per-batch or per-PR owner
  approval. Unattended dispatch and merge cover batch-parent units only,
  never standalone issues. Attach a standalone issue to a batch parent
  before unattended dispatch or merge. `rh board dispatch` reads holds from
  the plan block and does not skip a parked unit automatically. Before
  dispatch, check active parks (`rh autopilot status`) and do not dispatch
  a parked unit or its open `blocked-by` dependents. Pass `--issues <unit>`
  to `rh board dispatch` for each ready, non-parked unit, or hold parked
  units in the plan. Keep a soft target of about 5 working seats and 5 CI
  runs active in parallel when disjoint ready issues exist (within the
  8-worker cap). `rh board triage-apply` scales an omitted
  `max_parallel_writers` up to 5 from actual disjoint units. Never create
  synthetic issues to fill seats.
- Match the model to the issue. Give a weaker or over-defensive model the
  issues with the tightest boundaries and the clearest acceptance checks.
  Keep contract-design issues for a strong model. When the assigned model
  fills open decisions, lock them first with an L2/L3 skeleton (§3.1) and
  paste the accepted decisions into the issue before you dispatch. A
  worker never reads `/tmp/rh-council/`.
- Review rounds converge by the round rules in `acceptor.md` §2.2.
  Include this rule in the worker brief: before asking for round 2,
  check the fix delta against the open findings for sibling cases, missing
  test branches and changelog fragment text against behavior. Claude and
  non-light Pi workers (`worker-opus`, `worker-neon`, `worker-neon-deep`, `worker-deep`,
  `worker`) may call `explorer` for discovery; `worker-light` has no
  sub-agents and does a self-check. The pre-check writes no record and
  does not replace the review.
- Never wait for the review bot. Answer every bot comment by `acceptor.md` §2.3, and triage a bot finding after merge once.
- Use the host's dispatch mechanism (an hc terminal in a Herdr.app pane,
  or a top-level host session). A dispatched agent has its own process. A
  sub-agent runs inside a seat process and is not a dispatch target.
  `orchestrator` may call only the read-only sub-agent `explorer` (use
  `advisor` for `deep-reasoner` boundary checks).
  Every write, `gatekeeper` review, and `reviewer` review run in a
  seat, for worktree isolation and one writer per file. You do not review
  a PR yourself; route each review of it to another seat. A dispatch does
  not grant publication, deletion or credential authority.
  For the Herdr pane topology, follow
  [Herdr Dispatch](https://github.com/aimpact-inc/repo-harness/blob/main/docs/reference-configs/herdr-notify.md#herdr-dispatch).
- Both `orchestrator` and `advisor` seats load the `herdr` skill by default
  at session start before any `hc` or `herdr-app` read, send, or pane
  operation.
- Open every worker, review, and council seat in a Herdr.app pane, so the
  owner can see its progress: prefer `rh board dispatch`, `rh board review`,
  `rh seats council`, or `rh seats launch <seat> --cwd <worktree> --task <packet>`
  with the label flags of `rh seats argv` for a standalone issue, a fix
  round or a stacked writer. `rh seats launch` takes the space from
  `--space` or from the `herdr.space` label of your own terminal, reads the
  space layout with `herdr-app ls`, and joins a matching `< 3` pane tab via
  `hc run --bg --keep --no-parent --cwd <worktree> --label herdr.space=<id> --label herdr.tab=<tab>`
  (so `terminal.cwd` equals the worktree) or opens `<base>`, `<base> 2`,
  `<base> 3` via `tab.new`, failing closed when Herdr.app is unavailable or
  placement fails. Worker tabs are named `#<issue>` (`other` without
  `--issue`); review seats join the PR's live worker tab (`worker +
  gatekeeper + reviewer` in one tab, max 3 panes) and fall back to `PR#<pr>`
  (or `review` without `--pr`) when that tab is absent or full; `council`
  packs up to 3 panes in `council` before opening `council 2`. Close each
  PASS review pane immediately after its receipt publishes; keep only a FAIL
  `gatekeeper` pane when needed for a round-2 fix check. When calling
  `herdr-app do pane.split` directly, resolve an explicit `--pane <id>` with
  `herdr-app ls` first; never combine `pane.focus` with an untargeted
  `pane.split` (an untargeted split can land in another Herdr space). Never
  start a seat with bare `hc run --bg` (without `herdr.space` and
  `herdr.tab` from an open window): that terminal has no pane. Attention
  rule A21 names each live seat that no pane shows; give it a pane with
  `herdr-app do terminal.keep`, or close and relaunch it.
- Attention rule A22 names a stalled seat: it reports `working` for more
  than 300 s, its agent has no child process, and its screen without
  spinner frames and elapsed-time counters did not change between two
  watcher reads. Read the pane; when the stream hangs, close the seat and
  dispatch the work again. Nothing closes the seat for you. A seat with
  resident child processes (a Claude seat's MCP servers) does not show it.
- Remote topology: Herdr.app runs on one machine, and `herdr-app` on any
  other machine has no window. A coordinator on a machine without the
  window cannot open a seat tab and does not fall back to a headless
  terminal. Run the dispatch and launch commands on the machine that runs
  Herdr.app. The launch builds the seat argv and reads the worktree on that
  machine, so keep the worktrees and the rh install there too. A
  `--space <machine>/sp...` space starts its terminals on the other
  machine; use it only when that machine has the same worktree path and
  the same rh and bun paths.

### 7.1 Quota check

Before each dispatch wave, run `rh quota`. It prints the account
states, one mode line per account and one route line per task class. For
example `claude mode: saving (5% left < 20%)` and
`codex mode: normal (68% left)`. For a manual dispatch, check the configured
candidates and their quota. When Opus and Neon are both eligible, normally
choose the seat whose account has more weekly quota left. Launch with
`rh seats launch <seat> --repository-id <id> --issue <n> --cwd <worktree> --task <packet>`.
State the boundary in the task. A `none` route waits, or it changes through the seats
configuration: the owner sets the seat order and each fallback there, and
the route line then names the first eligible seat. When the gatekeeper
account is exhausted and a `gatekeeper-fallback` seat is configured, the
route line names the fallback seat, and `rh seats launch gatekeeper
--repository-id <id> --pr <n> --cwd <worktree> --task <packet>` opens it.
Never start a seat with an argv that `rh seats argv` did not print, and
never outside a Herdr.app tab.
`rh board dispatch --parent <n> --space <id>` applies this step to every ready issue of the plan: it reads the `route:<class>` label of each issue (and `touches:credentials`), starts the worktree, posts the claim and opens the worker tab. `--dry-run` prints the decisions only. An issue without one `route:<class>` label is reported and not dispatched.
`rh board review --parent <n> --space <id>` starts the `gatekeeper` (`Sol`) and/or `reviewer` (`Opus`) seats for ready, green pull requests. For a High PR with no start marker for its head, `gatekeeper` and `reviewer` start in parallel on the same head; each carries its own `Seat: gatekeeper | reviewer` marker, so one missed seat retries without restarting the other. In round 2, only the seat that raised a blocking finding restarts (and the passing seat runs a delta check only when the fix leaves the failing reviewer's files; `acceptor.md` §2.2). A Medium PR prefers `gatekeeper` (`Sol`) whenever `gatekeeperFamily !== writer_family` (covering `Opus`, `Neon`, and Flash writers) and selects `reviewer` (`Opus`) when `writer_family === 'openai'` (or when `gatekeeper` cannot launch and `reviewer` differs from `writer_family`). An unknown writer family (no claim `Model:` line, an unmatched model, or linked issues that disagree) skips as `writer_family_unknown`; start one different-family reviewer seat by hand and record its `Model relation:`. `--pr <n>` reviews that pull request only. A pull request that links a plan-held issue skips as `plan_hold`. `--dry-run` prints the decisions only.
Apply the `explorer` line through the sub-agent call when Claude is reserved (`routing.low_quota_explorer`, default `haiku` high).

Claude saving mode applies when weekly remaining quota is below
`routing.claude_saving_below_remaining` (default 20). Claude hyper mode applies
when weekly remaining quota is at or above
`routing.claude_hyper_at_or_above_remaining` (default 50); saving wins below its
own threshold. Only in Claude hyper does a Claude `advisor` take its config
entry; in every other Claude mode it uses `opus` high. Claude hyper changes no
worker route and not the `orchestrator` entry. `routing.agy_saving_below_remaining`
(default 25) reserves `agy_gemini` for `advisor` (`Neon`) by blocking
`worker-neon` and `worker-neon-deep` dispatches below 25% remaining. A Pi `advisor` on `magpie/agy-cli/`
uses its config entry at 50% or more `agy_gemini` weekly quota remaining and
uses `magpie/agy-cli/gemini-4-neon` when lower or unknown. A seat takes a new
model only at a tier-2 reset (`/clear` on Claude, `/new` on Pi), where
`seats reset` relaunches from argv; see Seat reset in `herdr-notify.md`.
`pi` `magpie/codex/*` and native `codex` seats keep their configured model
and effort at every quota level. Quota modes are derived, never stored.

Routes evaluate strictly left-to-right across configured seats after excluding
reserved or exhausted accounts (for example `important_deep`:
`['worker-opus', 'worker-neon-deep', 'worker-deep']`; `important_fast`:
`['worker-opus', 'worker-neon', 'worker', 'worker-light']`; `simple_deep`:
`['worker-neon-deep', 'worker-deep']`; `simple_fast`: `['worker-light', 'worker']`;
`frontend`: `['worker-opus', 'worker-neon']`). Claude in saving mode or
exhausted is reserved for `advisor` and `orchestrator`; routing skips
`worker-opus` and selects the next eligible non-Claude seat. `frontend` waits for an eligible
Claude or Neon seat.
`rh seats launch <seat> --repository-id <id> --owner-exception <url> --cwd <worktree> --task <packet>` lifts the
reservation refusal (`seat_quota_reserved`) for one launch. The URL must be an
owner decision on an issue or PR of the checkout's origin repository. The
seat label `repo-harness.owner-exception` and the `--json` launch record keep
the URL. The exception changes no model, tool or permission, and a launch
that is not reserved refuses it.
The owner lists Pi model prefixes with no budget, for example
`magpie/anthropic`, in `routing.unavailable_pi_providers`. While the list
is non-empty, a Pi seat with a null model is unavailable too: Pi would pick
its own default provider. Routing skips those seats and the `rh quota` lines
give the reason; their launch refuses with `seat_provider_unavailable`. Give
such a seat an explicit model, or empty the list.
An exhausted account takes no new dispatch, review seats included, except
under the stored credit mode `routing.codex_credit_mode` (`off`, `review` or
`all`; default `off`). While the ChatGPT account is exhausted and reports
credits at or above `routing.codex_credit_floor`, `review` admits `gatekeeper`,
`gatekeeper-fallback`, and a ChatGPT-bound `reviewer`, and `all`
admits every ChatGPT-bound seat. Those route and seat lines say `on credits`;
name it in the dispatch note. Only the owner sets `codex_credit_mode`; a seat
does not write it, and a joint decision does not cover it.
`tight` is a display state only; it does not reserve Claude or change routing.

Claude seats use `claude`; native `codex` and `pi` `magpie/codex/*` seats use
`chatgpt`; native `agy` and `pi` `magpie/agy-cli/*` seats use `agy_gemini` (or
`agy_other`); Flash API `worker-light` / `gatekeeper-fallback` seats have no
account reading. Put the reading in the `Dispatch reading:` line of each claim:
account state, used %, pace, reset time and reading time.

| Account state | Route rule | Coordinator action |
|---|---|---|
| normal or surplus | First pass, in configured seat order | Dispatch to the named seat. |
| unknown | Second pass; the line names the state | Dispatch to the named seat and record the unknown state. |
| tight | Display only; the seat stays eligible unless Claude is reserved | Follow the named route. |
| exhausted | The account is excluded | Start no new turn on that account. |

## 8. Follow up

Find the repository's live seats with `rh board seats --json`.
It includes seats without a parent issue. Wait for a seat with `hc wait <t>`
or follow `hc events`. Never use `sleep` loops to wait for seats.

Follow the PR and the issue comments. Do not poll CI with sleeps. Use the
host's PR events or check when the worker reports.

- **Worker PR.** A worker pushes its branch and opens its PR as soon as its
  checks pass. Do not send a push or PR go. You keep dispatch, joint
  decisions, the merge, and the review start with `rh board
  review`. A worker reports to you only `DONE <PR> <head>` or
  `BLOCKED <one question>`.
- **Draft PR.** A writer keeps its PR draft until its verification
  evidence exists. Do not follow CI on a draft push by push. Act on the
  worker's `ready for review` notice (§8.1).
- **Frontier.** Work on the lowest unmerged PR in the plan block's merge
  order first. Do not spend fix or review rounds on a PR above a red PR in the
  same chain.
- **Low and docs-only PR.** Read the status and report it. Do not push fix
  rounds of your own. The Low accept-seat skip
  (`docs/reference-configs/agentic-development-flow.md`, Review by risk)
  sets its review.
- **CI red.** The worker owns the fix. Send the failing job name and the
  log excerpt to that worker, because it has the context. Allow one rerun
  for a known flake. A second identical failure is not a flake. Classify
  it once, as the diff, the infrastructure or the main side, and act on
  that class: the worker fixes the diff, the owner gets the infrastructure
  failure, and a main-side cause is fixed on main once, in one PR. No PR
  merges main for this class: that merge makes a new head, a new CI run
  and new delta rows on every open PR. After the main fix lands, only the
  PR that is next to merge gets a CI re-trigger on its unchanged head, so
  its records stay valid. The other PRs wait until they are next. The
  re-trigger is a close and reopen, and it works once the workflow takes
  the `reopened` event (#3068). Until #3068 lands, a head with no usable
  run gets one same-tree amend push (`git diff` is empty) and one
  confirmation row that records the tree identity. A job that was
  cancelled or timed out with no failed assertion is infrastructure: it
  starts no fix round. Rerun the failed job once on the same head. A
  second identical cancel goes to the owner.
- **Uncovered path.** A CI selection failure `Affected coverage is unknown
  for: <paths>` is a map bug. The worker fixes the consumer edge
  (`scripts/ci-path-consumers.ts`) or the test import. Never widen to the
  full suite unless a real full-suite input changed.
- **Sibling question.** Answer a `[rh-question] sibling` before the
  writer pushes, and decide a round-1 base defect before the merge. The
  rules are in §4.2 (Same-rule sibling, Base defect in round 1).
- **Boundary question.** Decide fast. Either amend the issue (edit the body
  and post a `scope change` comment that says what changed and why), or
  open a new issue for the extra work and keep the PR narrow. Never let the
  worker widen the PR without an issue change.
- **Review.** Select the review depth by the diff's risk tier. A Low PR
  that meets the Low accept-seat skip gets no Codex, Herdr or OAR accept
  seat (`docs/reference-configs/agentic-development-flow.md`, Review by
  risk). Give each ready PR that needs review its own review seat at once.
  A Medium PR takes one reviewer (`gatekeeper` for non-OpenAI writers,
  `reviewer` for OpenAI writers). A High PR takes `gatekeeper` and `reviewer`
  in parallel on the same head. In round 2 the reviewer that raised a
  blocking finding runs again; the passing reviewer runs a delta check
  only when the fix leaves the failing reviewer's files (`acceptor.md`
  §2.2).
  Send each reviewer the review packet of `acceptor.md` §2.1. Each reviewer
  posts an `acceptance claim` (carrying `Seat: gatekeeper` or `Seat: reviewer`)
  before it reads. Who reviews each round, and how many claims a round
  has, follow `acceptor.md` §2.2.
  Ship the whole verdict bundle of a round before the worker pushes: the
  worker fixes and pushes once per round, not once per finding.
  Apply the finding bar in `acceptor.md` §3.
  A P2 and a P3 do not block the PR and open no issue: the `PASS`
  record carries them, and you resolve their threads with the `noted` reply
  (`acceptor.md` §2.2, `templates.md`).
  Send the findings to the worker that
  wrote the PR only when the worker cannot read them: the worker reads the
  acceptance records and review threads on its PR and runs its own fix
  rounds (`worker.md` §7). A native `codex`-runtime worker is the exception:
  you push its fix rounds (`board.md`). You make the second-finding choice of
  the class rule (`worker.md` §7). For the design change, post a
  `scope change` with one mechanism rule that covers the class, and require
  the fix to show the rule on each case that the reviews found (one
  table-driven test or a replay of those inputs). Round 2 reviews the rule.
  A fix of one instance leaves the class open after the last round.
  Record the result in one acceptance record comment on
  the PR, in the row shape of `templates.md`: `Seat`, round, role, subject,
  verdict and model relation.
  Start the attention watcher with `rh board attention start --parent <n> --review --space <id>`.
  It publishes PASS receipts and reports held FAIL receipts and collection
  errors. Close each PASS review pane immediately after its receipt
  publishes (`herdr-app do pane.close --pane <id>`, or `hc kill` and
  `hc rm`); keep only a FAIL `gatekeeper` pane when needed for a round-2
  fix check. Attention rule A19 is the fallback. It names a seat that is
  done or idle for more than 10 min without a later record for that seat.
  Inspect the receipt and use `rh review collect` when it is ready to
  publish.
- **Defensive code.** Reject compatibility branches, fallbacks and
  speculative guards that the issue did not ask for, even when the tests
  pass. Quote the boundary line. This is the most common reason to send a
  PR back.
- **Trigger challenge.** Before you publish a FAIL receipt, read the trigger
  of each P0 and P1. When a trigger is outside the bar (`acceptor.md` §3),
  you may challenge that seat once for that head.
  1. Post a `repo-harness decision` comment on the PR with the seat, subject
     SHA, finding IDs and the sentence of the bar that the trigger does
     not meet.
  2. Send the challenge text in `templates.md` to the seat.

  The reviewer's answer is final. The watcher publishes a PASS answer.
  Publish a FAIL answer with `rh review collect`. Never name a severity
  that you want. Never send a second challenge to that seat for that head.
- **Stalled worker.** Rule A12 of `rh board attention` finds a
  stalled writer: a writer claim two hours old with no PR and no
  `issue claim status` after the claim. Read its pane, its branch
  (`git log origin/main..HEAD`, `git status --short`) and its last status
  comment. Ask one time for a status. When the answer shows no convergence
  (a growing file list, the same compile error, no commit), re-route the
  issue to a deeper seat. A handoff needs a claim comment that cites the
  prior claim; the new seat starts from the pushed branch.
- **Owner wait.** Do not open a blocking question modal
  (`AskUserQuestion`, `ask_user_question`, or `request_user_input`). A
  modal holds the pane in `blocked` and stops incoming `hc` notices from
  workers and the advisor. When one task waits on the owner, park only
  that task, ask the owner in plain text (or through the advisor), and
  end the turn so `hc` messages from other seats keep arriving. A seat
  started by hand without seat identity (`REPO_HARNESS_SEAT=orchestrator`)
  is not covered by the launcher or hook guard; migrate it by relaunching
  with:

  ```bash
  rh seats launch orchestrator --repository-id <id> --cwd <repo> --task <prompt>
  ```

### 8.1 Triage queue

Owner messages and worker notices arrive in the same session. Without a
rule, the newest message takes the turn and the owner loses the thread.
Keep the notices in the host's task list tool (on Claude: `TaskCreate`,
`TaskUpdate`, `TaskList`, `TaskGet`; on Codex: its plan tool). A queue item points to
the board. It holds no state of its own, so it cannot drift from the board.

- **Classify the source.** A message whose first line starts with
  `[rh-notice]` or `[rh-attention]`, or a `repo-harness.bot-event/v1`
  event, is a notice. Any other message is from the owner.
- **Queue each notice.** A notice does not take over an open owner
  request. When no owner request is open, work the queue in the same
  turn (Work the queue). Keep one item for each issue or PR of a
  `[rh-notice]` or a bot event. The subject is
  `[P<n>] #<number> <kind>`. The description is the comment or event URL,
  or the message text of a simple notice (`worker.md` §7). When the issue
  or PR has an open item, update that item and keep the higher priority.
  An `[rh-attention]` notice comes from the attention watcher, not from
  the owner. It holds one entry for each finding, in the form
  `<priority> <rule>: <message>`. A review line
  `[rh-attention] #<parent> P3 review: <line>` is one entry, whatever
  the number of review starts: its lines join with ` · `, not with the
  `; ` of the findings, so queue it as one item. Queue one item for each
  entry, also when two entries name the same issue or PR. The
  priority of the item is the one in its entry: the entry is the
  authority, so read no row of the table below for a finding. The subject
  is `[P<n>] #<number> <rule>`. `<number>` is the first issue or pull
  request that the entry names, else the parent issue. The watcher sends
  a finding once, until its rule or its subjects change;
  `rh board attention --parent <n>` gives all open findings.
  Rule A20 names an open PR whose required check is `pending` or `missing`
  more than 60 min after its head commit: read the run, and when it holds
  no job, cancel it and start it again.
  Start the watcher of a batch parent with
  `rh board attention start --parent <n>`. When the watcher
  exits, hc types a note `t<id> exited (exit <n>)` into your terminal:
  read the last line of that terminal with `hc read`, then start the
  watcher again.
- **Priority.**

  | Priority | Notice |
  |---|---|
  | P0 | `merge_outcome_unknown`, `agent.blocked`, a failed board read or post |
  | P1 | `boundary question`, `question`, an `issue claim status` with `Status: blocked`, a stalled worker |
  | P2 | CI red, review findings, an `integration status` with a conflict |
  | P3 | ready for review, `agent.done`, `done`, `info`, other status |

- **Owner first.** Answer the owner message before you take a queue item.
  End the answer with one line: `Queue: P0 <n> · P1 <n> · P2 <n> · P3 <n>`.
  A P0 notice is the only interrupt: tell the owner in one line when it
  arrives, then continue the owner's request unless the owner stops it.
- **Work the queue.** When no owner message waits, take the item with the
  highest priority, oldest first. Read its URL and its thread again, act,
  then mark the item completed. Take one item at a time. Answer a simple
  `question` in a host message. When the answer changes scope or decides
  an open point, post it as a `scope change` or `decision` comment and
  send the URL.
- **Rebuild.** At session start, and when the queue is empty after a
  context compaction, run two commands for each open batch parent:
  - `rh board attention --parent <n>`: queue each finding with
    its priority. Read by hand each thread that a rule lists as not
    evaluated.
  - `rh board review --parent <n> --space <id> --dry-run`: the
    PRs that are ready for review.
- **Changes without a notice.** A claim release, an owner comment, an
  acceptance record or a CI result can change the board without a
  worker notice. The `repo-harness.bot-event/v1` GitHub events
  (`events.md`) catch these changes and enter the queue as notices.
  Without the event Worker, read the parent and every open child before
  each dispatch or merge decision.

## 9. Merge and integrate

You are the integrator. Do the risk-tier review (§8) before you call the
executor. The workers produce the check results and CI. The acceptor reviews
those results. The executor does not read the acceptance record. It checks
CI, review threads, change requests, closing references and branch
protection itself.

Merge only with:

```bash
rh publication merge --repository <owner/name> --repository-id <id> --pr <n> --head <sha> --base <sha> --json
```

`--head` and `--base` are the SHAs you reviewed.
`publication.acceptance_merge` in `.ai/harness/policy.json` on the PR base
decides whether the executor merges. The default branch needs required
checks and enforce_admins. There is one lane: a direct squash. The checks
need not be strict, and a base that requires a GitHub merge queue is not
supported (the provider rejects the squash, exit 6).

`Required / CI` runs one time for each PR head. A PR whose base is behind
main needs no sync: the squash lands on the current main. The executor
proves that the one parent of the merge commit is the `--base` you
reviewed or a descendant of it. For a descendant it also proves that the
tree of the merge commit is a clean `git merge-tree` of that parent and
`--head`; it fetches the commits from the checkout's `origin` with your
own git setup, so run it in a checkout of the repository. No run tests
the merge result before the merge. The daily full run finds two PRs that
pass alone and fail together.

Act on the exit code. Post every result as `integration status` on the PR.

| Exit | Meaning | Action |
|---|---|---|
| 0 | Merged | Post the merge SHA, the parent SHA and the revert command. Post `unblocked` on each dependent PR |
| 3 | Switch is off (`acceptance_merge_off`) | Post `To: owner`: the PR is ready, the owner merges. Do not merge another way |
| 4 | Refused before any merge request | For `base_protection_insufficient`, `publication_policy_invalid` (base policy) and `provider_unavailable`, hand it to the owner. For any other blocker, hand the PR to its head owner with the `blockers` |
| 5 | `merge_outcome_unknown` | Stop. Report to the owner. Never retry |
| 6 | `provider_rejected` | Post the GitHub error as it is. Hand it to the owner |

- Use `Closes #N` only in the PR that finishes the issue. Earlier PRs of a
  multi-PR issue use `Refs #N`. Before merge, check
  `gh pr view <n> --json closingIssuesReferences`. An edited body can keep
  an old closing link. The executor also checks the closing references and
  refuses with `closing_references_mismatch`, also for a closing keyword
  that targets a pull-request URL.

### 9.1 Eligible PRs

Merge each eligible PR on its own, in the order of §9.2. Do not sync a
PR with main for publication. A sync makes a new head, and each new head
needs its own CI run and its own review rows (`acceptor.md` §2.2). Only a
conflict with main needs a merge of main; the head owner makes it.

A PR is eligible when all of these are true:

- It is open and not draft.
- Its required checks are SUCCESS on its own head.
- Its tier review passed on a subject SHA. A review that returns `PASS`
  with a P2 needs no fix round: the P2 stays in the review record. A Low PR needs no review, but
  its PR body must hold the author verification evidence
  (`docs/reference-configs/agentic-development-flow.md`, Review by risk).
- Its head equals the reviewed subject. Rows of an earlier head do not
  count for a later head.
- It has no unresolved review thread that a person started. A review bot
  thread is advisory input and does not block. You resolve a P2 thread with
  the `noted` reply first (`acceptor.md` §6).
- Its closing references are correct.

```bash
gh pr view <p> --json state,isDraft,headRefOid,statusCheckRollup,closingIssuesReferences,reviewDecision
```

### 9.2 Merge order

Use the plan block's merge order. A parent with two children or fewer
and no plan uses blocked-by order: a blocker lands before the issue it
blocks. `rh board merge` and `rh board review` refuse a parent with more
than two children and no plan (`plan_unavailable`); post a plan first.
The Order column of the parent table is only a view.

Fix the merge order of in-flight PRs that touch the same files before
their CI runs: such PRs either wait or join one batch, so a later PR does
not re-cut after the earlier one lands. A stacked consumer is retargeted
to its new base before its next push, never after. A retarget takes the
`edited` event and a push to a PR whose base conflicts starts no CI run,
so a retarget after the push leaves the head with no run.

### 9.3 Board merge

A GitHub comment is a log; a local decision and CI act. For an
owner-approved batch, you start the merge from your seat:

```bash
rh board merge --parent <n> [--pr <p>] [--dry-run]
```

The command reads the board once and merges at most one PR through
`rh publication merge`, squash only. Without `--pr` it takes the
first eligible PR in plan merge order. A PR is eligible when all of these
are true:

- `publication.acceptance_merge` is `on` on the default branch, and the
  plan comment is observed.
- The PR is open and not draft, and every issue that it closes or refs
  (the parent excluded) is an item of the parent.
- No hold record is in force on the parent, on the PR's issues or on the PR.
- The plan does not hold its issues, its issues are in `merge_order`, its
  open issues are in one plan unit, and every issue of each earlier unit
  is closed. A PR whose open issues span two units is refused: split it.
  The command checks unit boundaries only; closing every open issue of
  the unit is the worker's bundle rule (§7).
- An acceptance record has a PASS row for the head, at every tier. The
  provisional `tier_low` status is not enough: post the Low record after
  you check the verification evidence.
  A High PR needs the rows of the High rule in `acceptor.md` §2.2. On a
  fix head, a round-1 `PASS` row that rule 2 of §2.2 carries forward
  counts.
- `Required / CI` passed on the head, and the readiness verdict is ready.

The executor keeps all its own gates. Exit codes follow the §9 table; exit 4
with no merge also means that no PR is eligible, and the output names the
first failed condition of each PR. Board rule A11 wakes you when a PR is
eligible; the watcher never merges. Before you run the command, answer each
review-bot comment (`acceptor.md` §2.3): the command does not read bot
comments.

A hold record narrows only. When a stop is decided locally (an owner
instruction that reaches your seat, or your call on a "stop" or "no"
comment), post the `merge hold` with `rh board post hold` in the same turn,
before any other action. A hold on the parent holds the whole batch, or only
the issues of its `Issues:` line. A hold on an issue or a PR holds that
issue or PR. Each hold stays in force until a `merge hold released` on the
same thread that is strictly newer than the hold; post that one with
`rh board post release`. A release with the same time does not end the hold.
When the newest 50 comments of a thread hold no release and older comments
exist, the command refuses with `hold_unknown`. Before you post a release to
clear it, read the full thread: a release ends every older hold on that
thread. When local auto-pilot is enabled, §9.4 sets the merge bar and
non-blocking parking rules.

### 9.4 Auto-pilot mode

- **Activation and stop.** Only the owner's local instruction turns
  auto-pilot on or off. A GitHub comment, issue text, PR body, or webhook
  never enables it. Run `rh autopilot start [--cadence <minutes>]` (default
  60 minutes) to write local state
  (`<git-common-dir>/repo-harness/autopilot.json`). Run
  `rh autopilot stop [--reason <text>]` to stop auto-pilot at once. Run
  `rh autopilot status [--json]` to inspect state and active parked items.
  An explicit local stop or no-merge instruction always wins. Run the
  resident watcher with `rh board attention start --parent <n>` so hourly
  `[rh-autopilot]` ticks wake the label-resolved `advisor` (`advisor.md`
  §2.1).
- **Merge bar while auto-pilot is on.** `rh board merge` enforces the
  auto-pilot merge bar for batch-parent PRs only and calls
  `rh publication merge` as its executor. Unattended dispatch and merge
  cover batch-parent units only, never standalone issues. Attach a
  standalone issue to a batch parent before automatic merge. Never call
  `rh publication merge` directly to skip the auto-pilot merge bar. When
  `publication.acceptance_merge` is `on`, `rh board merge` enforces:
  - Medium and High PRs require two distinct claimed `PASS` acceptance rows
    on the current head, including at least one
    `Model relation: different-family` row. Round-1 carry does not satisfy
    auto-pilot dual sign-off.
  - Low PRs keep the verified accept-seat skip when `low_tier_skip` is on
    (default): `Required / CI` passed on the head and the PR body records
    executed verification commands with passing outcomes, with no
    acceptance record needed.
  - Every PR also requires `Required / CI` `SUCCESS` on the head, a
    `Rollback:` instruction in the PR body, zero unresolved human review
    threads, and answered review-bot comments.
  - Hard owner boundaries fail closed (`autopilot_park_required`). Any hit
    on I1 (credentials/secrets or linked `touches:credentials`), I2
    (irreversible deletion), production release or deployment paths, or
    incomplete path evidence requires parking instead of merging.
- **Non-blocking parking.** Only High security / I1 / I2 uncertainty
  (`high_security_uncertain`) and production release or deployment requests
  (`deployment_request`) ask the owner. The hold protocol also accepts
  `owner_question`. Park an item with:

  ```bash
  rh board post hold --target <item> --park <category> --reason "<one-line decision>"
  ```

  Clear a park with a strictly newer release on the same thread:

  ```bash
  rh board post release --target <item> --fields-file <file>
  ```

  `<file>` is a JSON object that holds the release `reason` (for example
  `{"reason": "Owner approved"}`). Parked PRs silence attention rules A1,
  A14, A15, and A20, and appear in `rh autopilot status`.
  `rh board dispatch` does not skip a parked unit automatically. Before
  dispatch, check `rh autopilot status` and do not dispatch a parked unit
  or its open `blocked-by` dependents (§7). In `merge_order`, a park blocks
  only its own item and items with an open `blocked-by` path or stacked-PR
  dependency on it. Ordinary non-park holds keep their place in
  `merge_order`. Worked dependency case: `merge_order` is `[A, C, B]`,
  where A is parked for a deployment decision, B has an open `blocked-by`
  link to A, and C does not depend on A or stack on A's PR branch. A and B
  wait, and C merges past parked A once C's own gates pass.

## 10. Close out

1. All children are closed or shelved (`status:deferred`).
2. When module boundaries, APIs or flows changed, the architecture model
   and `docs/architecture/archimap.html` are current (`repo-harness-archimap`).
3. Post a closing comment on the parent: merged PRs, shelved issues,
   remaining risk. Then close it, when the owner's instruction covers
   closing.
4. Close each finished worker pane after its PR merges, with
   `rh board closeout --pr <n>`. It confirms that the checkout is
   clean and pushed, closes each seat terminal of the PR, then removes the
   merged worktree; a checkout with an unpushed commit is kept and the
   command exits 1.
5. Start the Lessons Retro for the range after the watermark
   (`docs/reference-configs/agentic-development-flow.md`, Lessons Retro):
   `git log --first-parent <watermark>..origin/main`. The retro is also due
   when the watermark commit is older than 7 days or more than 100
   first-parent commits behind `origin/main`. Add an entry only for a
   mistake that repeated or that a rule would have prevented. Dispatch a
   worker for the ledger PR and wait for the owner GO for that head.

Rigor rules in §3, §4.2, and §5 are adapted from pstack (`cursor/plugins`, MIT): `pstack/skills/sharpen/SKILL.md` (`bf0c7cd80abd`) and `pstack/skills/reframe/SKILL.md` (`9e278fe4d4ec`).
