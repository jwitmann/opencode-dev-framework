# Worked session 3: plan under `/df-goal`

A written plan executed as a verified goal: native `/goal` owns the
objective while the appended verification contract requires the
framework's PASS. Same fixture shape as the previous sessions — small Node
project, `standard` profile — plus a two-step `PLAN.md` and the dogfood
probe that invokes the real `/df-goal` wrapper headlessly (the same probe
used for the plan-13 live matrix). Real output, trimmed.

## Setup

`PLAN.md` in the fixture root:

```markdown
# Plan: multiply support

1. Add a `multiply(a, b)` function to `math.js`.
2. Cover it with a test in `test/` asserting `multiply(2, 0)` is `0`.
3. Run the full gate (`dev_framework_verify`) and report PASS.
```

The headless probe delegated exactly as a user typing `/df-goal` would —
`ctx.session.command({ sessionID, name: "df-goal", text })` with the
objective `Implement the plan in PLAN.md` — and recorded its receipt:

```json
{"dfGoalPresent":true,"goalPresent":true,"sessionIDFound":"ses_e6a6795d4ffeO7DiF227yoIOBR","dfGoalResult":"delegated"}
```

## What happened

The agent implemented both plan steps (4 lines in `math.js`, one new
test), then — unprompted, per the appended contract — ran the full
verification before declaring the plan met:

> Plan complete — `dev_framework_verify` reports **PASS**.
> `dev_framework_verify`: `DEV_FRAMEWORK_VERDICT: PASS` — completion gate
> passed (test step), no blocking items

And the independent idle gate agreed:

```text
[opencode-dev-framework] info completion gate passed
completion gate passed
```

Session exited 0. The diff is exactly the plan: nothing parked, nothing
extra.

## Takeaways

- The objective reached native `/goal` verbatim plus the contract — the
  agent's own closing line cites the verify PASS as the completion
  evidence, which is the contract working as designed.
- Two independent evaluations (manual verify, idle gate) agreed on the
  same full contract, same as in [session
  1](first-gated-session.md) — `/df-goal` adds the native objective
  tracking on top, it does not replace the gate.
- Headless honesty note: native goal lifecycle events don't print
  verbosely under `--print-logs`, so the delegation proof here is the
  probe receipt plus the agent's contract-driven behavior — not a
  `goal-completed` line. Interactively, `/df-goal` shows the native goal
  UI with pause/resume/clear.
