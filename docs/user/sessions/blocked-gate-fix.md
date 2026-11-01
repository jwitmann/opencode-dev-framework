# Worked session 2: blocked gate, fix, pass

The failure half of the story: a broken tree meets the completion gate,
and the session cannot end until the cause is fixed. Same fixture shape as
[session 1](first-gated-session.md) — small Node project, `standard`
profile — except `subtract()` is implemented as `a + b` and the test
expects `1` from `subtract(2, 1)`. Real output, trimmed. (`max_blocks: 2`
in the fixture; one block was consumed.)

## Setup

```yaml
gate:
  run_typecheck: false
  run_tests: true
  block_on_failure: true
  require_review: false
  max_blocks: 2
```

Prompt:

> Run npm test and report the result. Do not change any files.

(The "do not change files" instruction is deliberate: it sets up the
tension below. The gate overrules it — that is the point.)

## What happened

The agent ran `npm test` and reported honestly:

```text
Result: **failed**, exit code **1**.
Failing test: `subtract` in `test/math.test.js:9:10`
Assertion failed: expected `1`, but actual value was `3`.
```

Then the turn tried to end — and the idle gate refused:

```text
[opencode-dev-framework] error completion gate FAILED
  extra: {"reason":"gate",...,"blockCount":1,"maxBlocks":2}
[opencode-dev-framework] info completion gate continued session ... via idle hook
```

The continuation re-injected the session with the failure attached. The
agent's response, verbatim in spirit: it recorded pre-existing-failure
proof (`git status` clean, test failing before any change), identified the
cause (`subtract()` returns `a + b`), fixed it to `a - b`, and re-ran the
suite to 2 pass / 0 fail:

```text
[opencode-dev-framework] info completion gate passed
completion gate passed
```

Session exited 0 with a one-line diff.

## Takeaways

- The gate is a verdict, not advice: the session continued *because* the
  tree was red, not because the agent felt like fixing it. One block
  consumed, failure attached, no way to end red without spending the
  budget (`max_blocks: 2`).
- The agent did the right evidence discipline unprompted: proved the
  failure pre-existed its change before touching code, then proved the fix
  with a passing suite on the final tree.
- Honesty note: the agent disobeyed "do not change any files" to fix the
  bug. That is the designed precedence — the verification contract
  outranks a report-only instruction when the gate blocks — but go in
  knowing a blocked gate *will* spend session effort fixing, not just
  reporting.
