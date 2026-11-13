---
name: peer-review
description: >
  Run a continuous-peer-review pass over the current changes to prevent
  fragmentation and drift before completion. Orchestrates the pattern-guardian,
  style-enforcer, and code-reviewer agents, then consolidates only the
  blocking items. Use after a batch of edits and before declaring a non-trivial
  change done.
---

# Peer Review Pass

Catch consistency, style, and correctness issues while they're cheap to fix —
not after the codebase has already drifted.

## When to use

After implementing a non-trivial change and before you declare it done, or
whenever the user asks for a review of the current changes.

## Steps

These steps are the orchestrator's. If you are running as one of the
specialist subagents below, do only your assigned step and report back —
never consolidate, fix, or re-run anything. Only the orchestrator writes
the review artifact: as a specialist you never write files, your report
text is your entire output. This overrides any session duty telling you
to write the review file.

 1. **Scope the change.** Determine exactly what changed:

    ```bash
    git --no-pager diff --staged
    git --no-pager diff
    # if the tree is clean, review the branch: git --no-pager diff main...HEAD
    ```

    If there is nothing to review, say so and stop.

 2. **Run the specialists in parallel.** Delegate each as a subagent, giving
    each the diff scope and the relevant file paths:
    - **pattern-guardian** — duplication, re-invented helpers, divergent
      conventions, a second way to do a thing, unjustified new dependencies.
    - **style-enforcer** — adherence to the project style guide / lint config /
      local conventions on the changed files.
    - **code-reviewer** — general correctness: bugs, logic errors, security,
      resource/concurrency issues. High bar, high signal only.

    On a repeat pass, run only the specialists whose scope changed since
    their last report — reuse fresh reports instead of running them again.

    If the `code-reviewer` agent is not installed in this project (or cannot be
    invoked in the current environment), perform that correctness pass yourself
    inline: read the diff in full, and for each changed file check for logic
    errors, unsafe edge cases, security issues, and concurrency/resource leaks,
    reporting the same `Blocking` / `Should-fix` / `Note` findings.

 3. **Consolidate.** Merge their findings. Drop duplicates and anything
    non-actionable. Group by severity: **Blocking**, **Should-fix**, **Note**.

 4. **Act, don't summarize.** For every Blocking and Should-fix item: fix it
    now, or state precisely why it does not apply. Do not produce a report of
    issues you then leave unaddressed.

 5. **Confirm.** Re-run only the specialist relevant to what you fixed,
    until no blocking items remain. Never restart the full set when a
    single area changed — reuse the fresh reports.

## Output

A short consolidated list (Blocking / Should-fix / Note) and, for each, the
action you took. If the specialists found nothing, say "Peer review clean — no
blocking issues."
