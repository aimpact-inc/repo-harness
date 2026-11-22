# Architecture and refactor evidence

Bot reference. repo-harness supplies tools and evidence. The Bot decides what
to schedule. No hook schedules architecture or refactor work.

Read evidence in the target worktree for the subject revision. Read it again
after edits. `check` and `recommendations` write no repository files.
`apply` and `decide` write; run them only inside authorized scope.

## When to read

Read the cheap diff-scoped evidence when a worker reports `done` for a branch
that changed source, `.archcontext/model/` or `docs/architecture/` files. A
Herdr `done` push is one such report. Also read it before you request review of
such a branch, and when the user asks about architecture drift or ownership. A
`blocked` report or a branch without such changes needs no architecture
evidence.

At `done`, run only the cheap checks below: path ownership, and
`rh arch projection check` when the model or documents changed. Do not run
`rh arch refactor recommendations --json` at `done` or on worker `Stop`
hooks. Run the full-repo scan once per merge on a fixed checkout and branch
(the `main` checkout after the merge), or run a scoped scan (`--node` /
`--path`) during `advisor` audit or when the user asks about refactors. A
full-repo scan takes about 30 s and gives the same output on every branch.

When a PR modifies `.archcontext/**`, `docs/architecture/**`, or carries
`tier:high` cross-module boundary changes, read
`rh arch verify --base <base-sha> --json` in the target worktree before
acceptance (never invoke `archctx` from `PATH`):

| Check status | Meaning | Review decision |
| --- | --- | --- |
| `pass` | Measured check passed with zero findings. | Clear on this check. |
| `findings` | Check counted active constraint or proof findings. | Grade findings in diff scope under P1/P2/P3; pre-existing `main` defects are non-blocking notes. |
| `unavailable` | Subject unmeasured (`AC_CODE_FACTS_UNAVAILABLE`, `AC_CODE_FACTS_NOT_READY`, or `AC_MODEL_ADOPTION_REQUIRED`). | Record an observation gap, never a clean pass. |
| `error` | Check or envelope failed (`RH_ARCH_VERIFY_*` or timeout). | Block acceptance until the check runs cleanly. |

Read the cheap signal first:

1. Ownership of new paths. Pipe the added, copied and renamed destinations,
   for example from
   `git diff --name-only --diff-filter=ACR <base>...HEAD -- . ':!.archcontext' ':!docs'`,
   to `rh capability resolve match --repo <repo> --paths-from - --format json`.
   An entry with `"matched": false` has no capability owner. Act only on source
   or runtime config files. Plans, task files and CI files need no owner. Have a
   `repo-harness-architecture` worker claim an unowned source file in the same branch.
2. Documents. Run the `check` below. It can take a minute on a large model.
   `freshness.staleTargets` names the targets whose render differs from the committed
   manifest. A module is stale when one of them is its module document.
   Save the check output to a file. Give the file to `rh arch module list`
   or `rh arch module review-prompt` with `--projection-check <file>`. Then
   `generated_summary` is `fresh` or `stale`. Without the file it is `unknown`.
   The file must come from a check at the current HEAD.
3. Model diff and validation. When the diff changes files under `.archcontext/model/`,
   inspect `git diff -- .archcontext/model/` and the inline `rh arch apply`
   output in the PR body. Confirm `rh arch validate --format json` and
   `rh arch projection check --json` (or `rh arch sync --check --json`) pass at HEAD.

Human-written sections have a citation signal. Run
`rh arch projection anchors --json`. The command is read-only
and writes no file. It lists cited paths that are missing, line numbers out of
range, symbols that are missing and lines that moved. It reads all human-written
text after the generated summary, including §3, §4 History, the backlog and the
node prose. A finding does not fail the command. The anchors report carries no
commit. Run the command at the same HEAD as the review, on a clean worktree.
Save the output to a file and give it to `rh arch module review-prompt <id> --anchors <file>`.
The prompt then has a STALE CITATIONS section.

## Architecture documents

Run `rh arch projection render-check --json`. It reads the
per-target output decisions from the managed provider.
`renderEquivalent: null` means the check could not cover all targets; it is not
a clean result. The command exits 1 for false or null. It needs CodeGraph facts.
Use `rh arch projection status --json` for provider readiness.
Agents fix model debt and human prose in their feature PR. The upstream rolling
writer publishes generated files. Do not run apply to refresh a feature PR.

| Result | Meaning | Bot decision |
| --- | --- | --- |
| `renderEquivalent: true` | Generated output matches. | Schedule nothing. |
| `renderEquivalent: false` | archctx reports changed output in `differingPaths`. | Inspect `rh arch projection publish status` with the writer's own `ARCHCONTEXT_STATE_DIR` (another state dir reports an empty state) and the open rolling PR. An open rolling PR waits for the owner's GO. Without one, repair the writer or the reported model debt. The writer publishes generated output. |
| `human-action-required` with `unresolved-major-change` | ArchContext observed a major change that no rolling PR merge accepted yet. The writer accepts proven changes, so the writer did not run, its rolling PR is open, or the proof is unprovable. | Inspect `rh arch projection publish status` with the writer's own `ARCHCONTEXT_STATE_DIR` and the open rolling PR. An open rolling PR waits for the owner's GO; its merge is the acceptance. A writer result with `unprovable-required-flow` or `projectionStatus: "applied-partial"` needs the missing proof in a model PR; start from `rh arch debt --json`. A feature worker does not commit generated docs. |
| Other `humanActions` reason codes, or `adoption-required` | Ownership, conflict or proof needs a decision; coverage is incomplete. | Assign the bounded model or adoption repair. Preserve the writer as owner of subsequent generated updates. |
| Command error, `blocked` or a failure status | Environment, provider or incomplete render check. | Read the check and writer logs. Fix the reported cause; do not synthesize output or refresh stamps. |

## Refactor suggestions

Run `rh arch refactor recommendations --json` (pass `--node <capability-id>` or
`--path <repo-relative-path>` for a scoped read during `advisor` health audits
and pre-refactor intake, or omit both for a full-repo post-merge scan). Never
invoke `archctx` from `PATH`. The result `repo-harness.refactor-recommendations/v3`
carries `status`, `headSha`, `snapshotDigest`, `scope`, `coverage` (`imports`,
`gitHistory`, `reasonCodes`), `findings` and `suppressed`. Each finding lists
its `recommendationId`, `detector`, `severity`, `blocking`, `capabilityId`,
`affectedNodeIds`, `affectedPaths`, `killList`, `metrics` and bounded `evidence`
scalars. Inspect committed decisions with `rh arch refactor list --json` (whose
`openFindings` is best-effort; `recommendations` is the authoritative scan with
coverage) and `rh arch refactor show <id> --json`.

| Status | Bot decision |
| --- | --- |
| `recommended` | Show the findings and their evidence to the user, or schedule a bounded refactor task in the normal plan and pull request flow. |
| `no_action` | Schedule nothing. |
| `proof_required` | Read `coverage` and the message. Missing code facts: run `codegraph init` (or `rh arch index seed --json` in a linked worktree). `code-facts-import-limit`: run again with a larger `--import-node-limit <n>` and pass the same value to `decide`, `verify` and `resolve`. |
| `unavailable` | Read `code`, `action` and `message`. A missing model or provider means schedule nothing. A code with an `action` has a fix: do it first. |

Record only a decision that the user made:
`rh arch refactor decide <id> accept|defer|reject|acknowledge|waive --reason "<text>"`
(add optional `--kill-symbol <path#sym>`, `--kill-path <path>` or
`--kill-relation <id>` targets, and pass `--import-node-limit <n>` if the scan
used one). `decide` writes `.archcontext/refactor-decisions/<id>.json` in Git in one step. Commit that
decision file with the work. After a code fix lands, verify it read-only with
`rh arch refactor verify <id> --json` (exit 0 only when `disposition === "resolved"`),
then close the decision with
`rh arch refactor resolve <id> --resolution-digest <resolutionDigest> --reason "<text>"`.
A finding is evidence. It does not authorize a refactor.
