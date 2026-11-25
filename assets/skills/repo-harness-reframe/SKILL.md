---
name: repo-harness-reframe
description: Teach expert terms and neighboring-field analogies for what the operator is building, then rewrite their description. Explicit invoke only.
when_to_use: "repo-harness-reframe"
disable-model-invocation: true
---

# repo-harness-reframe

Bot entrypoint. Explicit invoke only. Read-only: make no file or code edits.
Map the operator's work to precise domain terms and neighboring-field analogies,
then return a rewritten description using those terms. Adapted from
`cursor/plugins` `pstack/skills/reframe/SKILL.md` (`9e278fe4d4ec`).

## Steps

1. **Raw artifacts first.** Start from the operator's actual files, code, and
   description, not a summary.
2. **Disambiguate candidate problems.** When the description can name more than
   one problem, list 2–3 candidate problems first. Give each candidate one
   precise term and the observable sign that distinguishes it. Continue with the
   most likely candidate and state why.
3. **Ranked domain terms (8–12).** Order terms by architectural impact. For each
   term give:
   - One-sentence meaning.
   - Which part of the description or code it names.
   - One verified real system, paper, or project with a confirmed link.
   - What the term lets the operator ask an agent for.
4. **Neighboring-field analogies (2–3).** Pick 2–3 neighboring fields that solved
   the same problem shape under other names. State what carries over, where the
   analogy breaks, and which terms transfer back.
5. **Omissions and rewrite.** Name what the operator omitted but should care
   about. Rewrite the operator's description using the new terms.
6. **Citation rule.** Verify every link and cited usage directly. Cut any
   citation that you cannot confirm. Add no padding.
