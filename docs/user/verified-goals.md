# Verified goals (`/df-goal`)

A bare agent turn ends when the agent *says* it is done. A verified goal
ends when the agent *proves* it: native `/goal` owns the objective, the
review, and pause/resume/clear, while a verification contract appended to
your objective requires a `dev_framework_verify` PASS on the final tree —
and the native reviewer weighs that tool result as completion evidence. The
framework idle gate stays an independent backstop either way.

## When to use it

- The task starts from a **written plan**: make the objective the plan
  inline (short plans) or `Implement the plan in <path>` (long plans).
  Native completion then requires the gate's PASS, not just your summary.
- The task has deterministic checks worth enforcing (tests, typecheck,
  acceptance scripts, review).

Use native `/goal` directly for purely semantic objectives ("explore X and
summarize") — `/df-goal` refuses those rather than implying evidence where
none exists.

## What it does

`/df-goal <objective>` is a server-side command: it appends a short
verification contract to your objective **verbatim** (never rewritten, never
truncated, never double-wrapped on retry) and delegates **exactly once** to
native `/goal`. The complete string counts toward native `/goal`'s
4,000-character limit; overflow is rejected with exact lengths.

The contract requires, before the goal is declared complete:

1. Run `dev_framework_verify` after the final changes.
2. A FAIL means the goal is incomplete: fix the cause, re-verify.
   Never disable, skip, or weaken checks to obtain PASS.
3. Any later edit invalidates an earlier PASS.

This is layered verification, not a hard lock: native `/goal` can still
mark complete while the gate fails (or keep going after it passes), and the
framework stands down after `gate.max_blocks`.

## Requirements (all three, or it refuses)

1. **Native `/goal` on the core.** Otherwise a clear capability error — no
   unverified substitute is ever started silently.
2. **A blocking profile** (`standard`/`strict`, i.e.
   `gate.block_on_failure: true`). Advisory never gains a blocking side
   channel through `/df-goal`; the error names the key and points at the
   alternatives.
3. **At least one real check**: typecheck/test command, changed-file lint,
   a non-empty `gate.acceptance` list, or `gate.require_review`. A config
   with none of these is vacuous, and `/df-goal` says so instead of
   implying evidence.

Rejections are actionable errors naming the exact cause — fix the cause,
don't route around the wrapper.

## Worked run

[Plan under `/df-goal`](sessions/verified-goal-run.md): a two-step
`PLAN.md` executed as a verified goal — contract appended, agent cites the
verify PASS as its completion evidence, idle gate agrees.
