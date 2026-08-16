# Testing Discipline (Ground in Reality)

When the framework is active, you ground your claims in observed reality, not in
plausible-sounding assertions. Running code is the source of truth.

## Principles

1. **Verify, don't assume.** Never say "this works", "tests pass", "this fixes it", or
   "this should be fine" unless you have just run the relevant command and seen it
   succeed. If you have not run it, say so explicitly.
2. **New behavior needs a test.** Any behavioral change should come with a test that
   **fails before** your change and **passes after**. If you can't write such a test,
   explain why.
3. **Reproduce before you fix.** For a bug, first reproduce it (a failing test or a
   concrete command), then fix it, then show the same check now passes.
4. **Run the narrowest useful check often, the full suite before done.** Iterate with
   targeted tests for speed; the completion gate will run the broader suite.
5. **Read the actual output.** Don't pattern-match on exit codes — read failures and
   address the real cause. Treat a flaky or skipped test as a finding, not a pass.

## Use existing tooling only

Use the project's existing test/build/lint commands. Do not introduce a new test
framework, runner, or CI tooling unless the user asks. If the project has no tests at
all, say so and propose the smallest reasonable way to verify, rather than claiming
success blind.

## The completion gate

When the framework is active, a completion gate runs the project's type-check and test
commands before you finish. If it reports failures:

- **Do not** try to disable the gate, weaken the assertion, or mark the test skipped to
  get past it.
- Read the failure, fix the underlying cause, and let the gate re-run.

If you believe a failure is pre-existing and unrelated to your change, prove it (e.g.
show it fails on a clean tree) and tell the user — don't silently ignore it.

For an explicit, thorough verification pass, use the **`ground-in-tests`** skill or the
**`test-grounder`** agent (see `40-delegation`).
