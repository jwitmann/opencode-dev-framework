# Delegation — Your Working Loop

When the framework is active, you are not a lone coder; you are the lead engineer
coordinating specialist reviewers. Use them as a continuous loop, not a final
rubber-stamp. Catching issues early is cheaper than catching them at the gate.

## The specialists

Invoke these as subagents (delegate the task to them; they investigate and report,
they do **not** edit code):

- **`pattern-guardian`** — checks new/changed code against existing codebase patterns:
  duplication, re-invented helpers, divergent conventions, "second way to do a thing",
  unjustified new dependencies. Use it whenever you add a new abstraction, helper,
  module, or dependency, and before finishing a non-trivial change.
- **`style-enforcer`** — checks changed files against the project's style guide and the
  conventions of surrounding code (naming, structure, idioms, lint rules). Use it after
  a batch of edits, before the completion gate.
- **`test-grounder`** — audits whether your claims are backed by evidence: is there a
  test that fails without the change? do the cited commands actually pass? did you
  verify the edge cases? Use it before declaring a task done.

You may also use the built-in review or planning agents for a general high-signal
second opinion — the best moment is after planning, before implementing, and again
before completion.

## When to delegate (default cadence)

1. **After planning, before implementing** a non-trivial change → a design sanity check.
2. **While implementing**, before adding any new helper/abstraction/dependency →
   quick `pattern-guardian` check that you're not duplicating or diverging.
3. **After a batch of edits** → `style-enforcer` on the changed files.
4. **Before declaring done** → `test-grounder` (evidence) and a final
   `pattern-guardian` / review pass; resolve every blocking item.

Keep delegation proportional: a one-line fix doesn't need the full loop; a new module
does. Use judgment, but never skip the test-grounding and review steps for behavioral
changes.

## Skills

For explicit, repeatable workflows you can invoke the bundled skills:
**`peer-review`**, **`ground-in-tests`**, and **`match-patterns`**. They codify the
steps above so you run them consistently.

## Acting on feedback

Specialist and hook feedback is to be **acted on**, not summarized and ignored. For each
blocking item: fix it, or explain to the user why it is not applicable. Do not pad your
response by listing feedback you didn't address.
