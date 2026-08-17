---
name: code-review
description: >
  Standalone correctness review of the current changes. Delegates to the
  code-reviewer agent for bugs, logic errors, security, and resource/concurrency
  issues, then drives the blocking findings to resolution. Use directly (instead
  of the broader peer-review pass) when you want a focused correctness audit —
  e.g. after a batch of edits, before a commit, or when the user asks for a
  code review.
---

# Code Review

A focused, correctness-first audit of what you just changed — independent of
style and pattern concerns (those live in `style-enforcer` / `pattern-guardian`
and the broader `peer-review` pass).

## When to use

- After a non-trivial batch of edits and before you declare it done.
- Before committing or opening a PR.
- When the user explicitly asks for a code review or "check my changes".
- As a lighter-weight alternative to the full peer-review pass when you only
  care about correctness.

## Steps

 1. **Scope the change.** Get exactly what changed:

    ```bash
    git --no-pager diff --staged
    git --no-pager diff
    # if the tree is clean, review the branch: git --no-pager diff main...HEAD
    ```

    If there is nothing to review, say so and stop.

 2. **Run the code-reviewer pass.** Delegate to the **code-reviewer** agent,
    giving it the diff scope and the paths that changed. The agent is
    investigation-only: it returns `Blocking` / `Should-fix` / `Note` findings
    with absolute file paths and line numbers, and never edits.

    If the `code-reviewer` agent is not installed in this project (or cannot be
    invoked in the current environment), perform the pass yourself inline: read
    the diff in full, and for each changed file check for logic errors, unsafe
    edge cases, security issues, and concurrency/resource leaks, reporting the
    same `Blocking` / `Should-fix` / `Note` findings.

 3. **Triage.** Drop duplicates and anything non-actionable. Group by severity:
    **Blocking**, **Should-fix**, **Note**.

 4. **Act, don't just report.** For every **Blocking** and **Should-fix** item:
    fix it now (you may edit here — the agent may not), or state precisely why
    it does not apply. Do not produce a list of issues you then leave
    unaddressed.

 5. **Confirm.** Re-run the code-reviewer pass after non-trivial fixes, until no
    blocking items remain.

## Output

A short list grouped by **Blocking / Should-fix / Note**, and for each the
action you took. If the review found nothing, say "Code review clean — no
blocking issues."

> For the broader review (consistency + style + correctness together), use the
> **peer-review** skill instead.
