---
name: repo-harness-advisor
description: Start the advisor seat of the current repository beside its live orchestrator seat in the project Herdr space, from rh seats argv. Refuses without a live orchestrator or with a live advisor.
when_to_use: "repo-harness-advisor"
disable-model-invocation: true
---

# repo-harness-advisor

Bot entrypoint. Explicit invoke only. It starts one process. `rh seats argv`
holds the model, the effort, the tool limits, the env, the labels and the brief; this
skill copies none of them. The role rules stay in `repo-harness-issue-flow`.

A running session cannot get tool limits or env after its start, so this skill never
turns the current session into the seat. It always starts a new terminal.

## Run

Run the script below as one Bash command from the project checkout. Set `SPACE` to the
space id when the user named one (`--space <id>`); otherwise leave it empty. Every
probe is its own checked step: a failed or unparsable probe stops the script, and is
never read as "no seat" or "no space". A non-zero exit starts nothing; report its
stderr. A missing `hc` or `herdr-app` stops the script; there is no tmux fallback.

```bash
SPACE=''
stop() { printf 'repo-harness-advisor: %s\n' "$1" >&2; exit 1; }
for tool in gh git jq hc herdr-app repo-harness; do command -v "$tool" >/dev/null || stop "$tool is not available"; done

# 1. Repository: gh reads the git remote of the cwd, so each project has its own seats.
repo=$(gh api 'repos/{owner}/{repo}') || stop 'gh cannot read the repository of the cwd git remote'
id=$(printf '%s' "$repo" | jq -er '.id | numbers') || stop 'the repository has no numeric id'
name=$(printf '%s' "$repo" | jq -er '.name | strings') || stop 'the repository has no name'
common=$(git rev-parse --path-format=absolute --git-common-dir) || stop 'the cwd is not in a git checkout'
folder=$(dirname "$common")

# 2. Space: the named id, else the one local space named after the repository. Never the selected space.
layout=$(herdr-app ls) || stop 'herdr-app ls failed'
spaces=$(printf '%s' "$layout" | jq -ec --arg n "$name" --arg s "$SPACE" '.spaces | arrays
  | [.[] | select((.id | contains("/") | not) and (if $s == "" then .name == $n else .id == $s end)) | .id]') || stop 'herdr-app ls has no space list'
[ "$(printf '%s' "$spaces" | jq length)" = 1 ] || stop "space does not resolve for $name: $spaces; invoke again with --space <id>"
space=$(printf '%s' "$spaces" | jq -r '.[0]')

# 3. Live seats of the repository, local terminals only: no advisor, exactly one orchestrator.
# Seats are per host: the board reads local terminals only (src/effects/terminal/herdr-core.ts#isRemoteTerminal), and another machine may run the same seat.
live() {
  seats=$(hc ls --json --label "repo-harness.seat=$1" --label "repo-harness.repository=$id") || stop 'hc ls failed'
  printf '%s' "$seats" | jq -ec '.terminals | arrays | [.[] | .address | select(contains("/") | not)]' || stop 'hc ls has no terminal list'
}
advisors=$(live advisor) || exit 1
[ "$advisors" = '[]' ] || stop "refused: repository $id already has a live advisor seat at $(printf '%s' "$advisors" | jq -r 'join(", ")')"
orchestrators=$(live orchestrator) || exit 1
[ "$orchestrators" != '[]' ] || stop "refused: repository $id has no live orchestrator seat; the advisor serves only the orchestrator"
[ "$(printf '%s' "$orchestrators" | jq length)" = 1 ] || stop "refused: repository $id has more than one live orchestrator seat: $orchestrators"
orchestrator=$(printf '%s' "$orchestrators" | jq -r '.[0]')

# 4. The orchestrator tab in the project space.
tab_of=$(printf '%s' "$layout" | jq -ec --arg s "$space" --arg t "$orchestrator" '[.spaces[] | select(.id == $s) | .tabs[]
  | select(any(.terminals[]; .terminal == $t)) | {count: (.terminals | length), pane: (.terminals[] | select(.terminal == $t) | .pane)}] | select(length == 1) | .[0]') \
  || stop "refused: the orchestrator seat $orchestrator is not in space $space"
count=$(printf '%s' "$tab_of" | jq -r .count)
pane=$(printf '%s' "$tab_of" | jq -r .pane)

# 5. Launch: seats argv first, checked, then Herdr with the checked values. Never split down.
launch=$(rh seats argv advisor --repository-id "$id" --json) || stop 'rh seats argv advisor failed'
argv=$(printf '%s' "$launch" | jq -ec '.argv | select(type == "array" and length > 0 and all(.[]; type == "string"))') || stop 'seats argv gave no argv'
if [ "$count" -lt 3 ]; then
  herdr-app do pane.split --direction right --pane "$pane" --argv "$argv" || stop 'herdr-app pane.split failed'
else
  tab=$(printf '%s' "$launch" | jq -er '.tab | strings | select(. != "")') || stop 'seats argv gave no tab name'
  herdr-app do tab.new --space "$space" --name "$tab" --folder "$folder" --argv "$argv" || stop 'herdr-app tab.new failed'
fi
```

Then report the new terminal address from the Herdr output. When the output names
none, run the step 3 advisor probe again: the argv labels its own terminal before the
agent starts. Report the `limits` of the `seats argv` JSON.

## Architecture and refactor intake

The advisor seat reads structural observations before planning a module refactor or
during its periodic health audit (`repo-harness-issue-flow` `references/advisor.md` §2):

- Run `rh arch refactor recommendations --json` (and inspect recorded decisions
  with `rh arch refactor list` / `rh arch refactor show <id>`). Never run this on
  worker `Stop` hooks or call `archctx` from `PATH`.
- Present `recommended` findings to the owner and record each owner decision
  with
  `rh arch refactor decide <id> accept|defer|reject|acknowledge|waive --reason "<text>"`
  (optional `--kill-symbol`, `--kill-path` and `--kill-relation` targets on `accept`).
  `decide` writes `.archcontext/refactor-decisions/<id>.json` in Git directly.
  After a worker commits the fix, `rh arch refactor verify <id> --json` and
  `rh arch refactor resolve <id> --resolution-digest <resolutionDigest> --reason "<text>"`
  close the decision.
- Bind `accepted` recommendation IDs (`refactor_ids`) on the owning issue in
  `rh board triage-apply --manifest <path>`. For a cross-capability cycle or
  boundary split, attach the finding `metrics`, `evidence`, `affectedPaths` and
  `killList` with `rh arch module review-prompt <capability-id> --json` output
  to the L3 `council` consultation brief
  (`rh seats council --issue <n> --members <csv>`).
