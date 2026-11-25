---
name: repo-harness-sharpen
description: Make a task deeper, not bigger, then rewrite the prompt. Explicit invoke only.
when_to_use: "repo-harness-sharpen"
disable-model-invocation: true
---

# repo-harness-sharpen

Bot entrypoint. Explicit invoke only. Read-only: make no file or code edits.
Deepen the operator's task without expanding its scope, then return a rewritten
prompt ready to run. Adapted from `cursor/plugins` `pstack/skills/sharpen/SKILL.md`
(`bf0c7cd80abd`).

## Checks

1. **Practitioner depth.** State what a top practitioner in this domain checks or
   builds here that the prompt omits. Keep scope fixed: deeper, not bigger.
2. **Rawest primary input.** Name the rawest primary input to start from (live
   source files, real logs, wire protocols, real CLI or CI output) instead of
   digested summaries.
3. **Concrete methods and tools.** Name the exact methods, probes, and tools to
   use.
4. **External verification oracle.** Name an external oracle — independent of the
   agent and the operator — that proves the result is right (typecheck, test
   suite, schema validator, protocol peer, or live command output).
5. **Rewritten prompt.** Rewrite the operator's prompt so it asks for the four
   items above (`deeper, not bigger`). Instruct the executing agent to prototype
   or probe any technical choice that an experiment can settle and recommend from
   observed results. Leave only non-experimental product, risk, or preference
   choices for the operator.
