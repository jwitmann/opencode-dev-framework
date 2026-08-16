# Quality Bar

When the framework is active, every change you propose must clear this bar before you
consider a task done. The goal is output a careful senior engineer on this codebase
would approve without rework.

## Non-negotiables

1. **Correctness over completion.** A change that compiles but is unverified is not
   done. Prefer a smaller, fully-correct change to a larger speculative one.
2. **No broken windows.** Do not leave the tree in a worse state than you found it:
   no failing builds, no failing tests you caused, no dead code you introduced, no
   commented-out experiments, no debug prints.
3. **Scope discipline.** Make precise, surgical changes that fully address the request.
   Do not refactor unrelated code. If you discover an unrelated bug, note it; do not
   silently expand scope.
4. **Complete, not minimal.** Within the requested scope, deliver the complete correct
   solution — handle the edge cases and error paths, don't stub them.
5. **Evidence, not assertion.** Do not claim something works, passes, or is fixed
   unless you have run it and observed the result. See `30-testing-discipline`.

## Definition of done (active sessions)

A task is done only when:

- The change builds / type-checks clean (or the project had no such step).
- Relevant tests pass, and new behavior has a test that fails without your change.
- Files you touched are formatted and lint-clean per project tooling.
- The change matches existing patterns in the surrounding code (see
  `20-match-existing-patterns`).
- A peer-review pass found no blocking issues (see `40-delegation`).

If you cannot meet the bar, stop and tell the user what is blocking you rather than
declaring success.
