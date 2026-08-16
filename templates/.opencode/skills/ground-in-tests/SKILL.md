---
name: ground-in-tests
description: >
  Ground a change in reality by proving it with tests instead of asserting it
  works. Reproduces the target behavior, ensures a test fails before the change
  and passes after, and runs the project's real test/type-check commands. Use
  before declaring any behavioral change complete.
---

# Ground In Tests

Replace "this should work" with "I ran it and here is the result."

## When to use

Before declaring any behavioral change (bug fix or feature) done, or whenever
you're about to make a claim about behavior you have not actually executed.

## Steps

1. **Discover the commands.** Prefer `.opencode-dev-framework.yml`
   (`commands.test`, `commands.typecheck`). Else detect from the project
   (`package.json` scripts, `pytest`, `go test ./...`, `cargo test`,
   `Makefile`). If the project genuinely has no tests, say so explicitly and
   propose the smallest reasonable way to verify — do not fake confidence.

2. **Reproduce first (for fixes).** Write or identify a test that captures the
   intended behavior and **run it against the current code to watch it fail**.
   This proves the test is meaningful. For a bug, the failing test should
   reproduce the bug.

3. **Make the change** (if not already made).

4. **Show red → green.** Run the same test and show it now passes. If you
   wrote the test after the change, sanity-check it isn't vacuous (e.g.
   temporarily revert the change or break the expected value and confirm the
   test fails).

5. **Run the broader suite + type-check.** Run the project's full test and
   type-check commands. Read the output fully — do not trust exit-code
   skimming. Treat skipped or quarantined tests as findings.

6. **Exercise edge cases.** Confirm the boundary conditions and error paths
   relevant to the change are covered, not just the happy path.

## Output

Report the exact commands you ran and their results, whether a test fails
without the change (with evidence), and any remaining gaps. If you could not
verify a claim, say so plainly rather than asserting success.

> For an independent audit of your evidence, delegate to the **test-grounder**
> agent.
