# Hardening a project

The completion gate is the backstop, not the full check: it runs your fast
unit gates (typecheck, unit tests, changed-file lint). Hardening teaches the
agent everything else that must hold *before it declares a task done* —
your build system, your full verification pass, your review discipline, your
scope rules — without being asked each time.

## The pattern

Two pieces, both per-project, never global:

1. **`rules: { mode: append }`** in `.opencode-dev-framework.yml` — keeps
   the bundled constitution and adds your file after it:

   ```yaml
   rules:
     mode: append
     files:
       - .opencode/opencode-dev-framework/hardening.md
   ```

2. **`.opencode/opencode-dev-framework/hardening.md`** — the project-specific
   contract. It is appended *after* the bundled constitution, so it refines
   rather than replaces the quality bar. A complete example ships at
   [`../../examples/hardening/`](../../examples/hardening/).

## What belongs in `hardening.md`

Cover these five sections, in your project's terms:

1. **Build the project way.** The exact commands (`make check`, not bare
   `go test`; rebuild generated assets after editing sources; never
   hand-edit build output). Include the non-obvious ordering traps — the
   things that compile fine and fail confusingly at runtime.
2. **Full verification before done.** The full pass beyond the gate
   (linters, race detector, vulnerability scan, docs lint), and what counts
   as sufficient for docs-only vs code changes. A PASS before the last edit
   is stale — re-run on the final tree.
3. **Fresh review every task.** Rewrite `review.md` per task (a file left
   from a previous task never counts); evidence standard (a test failing
   without the change, passing with it); which reviewer agents to use at
   which depth; blocking findings resolved or explicitly waived.
4. **Scope discipline.** Implement the written plan verbatim; park unrelated
   findings in one line each under a dated heading; report them or state
   none were parked. Commit locally, never push.
5. **Execute plans under `/df-goal`.** Route written plans through
   `/df-goal` (plan inline when short, `Implement the plan in <path>` when
   long) so native completion requires the gate's PASS — and treat a
   `dev_framework_verify` FAIL as a verdict, never advice.

## What stays out

- Anything the gate already enforces (don't restate the config).
- Anything global (other projects' conventions, your personal preferences).
- Anything secret (tokens, internal URLs, customer names) — the file is
  designed to be committable; this repo's own example is.
