# Plan 25 — DSH adapter (shared core + per-harness adapters)

Status: built 2026-11-16 on `feat/dsh-adapter` (option B, in-place split:
`src/core/*` + `src/adapters/{opencode,dsh}/`). Predecessor: dsh-migration
assessment (`~/dsh-migration/README.md` — seam reference, provider decision,
review consolidation, model-first, format-runner scope). DSH upstream:
`~/deepseek-harness` @ `39163dd` (`0.2.2-rc.3`, verified seam source).
Phase-2 spike proven on stock `headless` + `--patch`: `tools/pre-execute`
deny-until-marker with recovery, `agent/turn-stopping` counter + one
`followup` continuation, no third turn. `followup` (next-turn inbox + wake)
is the working enqueue inside a serial `turn-stopping` listener.

## The principle

**One logic, two wirings.** Every verdict, rule list, budget counter, lint
rule, and config default exists once, harness-agnostic, behind injected
host functions (`RunCommand`, `LogFn`, hook state). Each harness contributes
only registration: opencode keeps `Plugin.define` + hook wiring; DSH gets a
Cordis bundle (`tools/pre-execute` deny, `tools/post-execute` lint/format,
`agent/turn-stopping` counter, `dsh-commands` slash commands, `fs/*` observation).
This is the operator-memory pattern already in-house (shared core + thin
per-harness adapters). No fork; no dual logic; no behavior change on opencode
until the DSH side dogfoods.

## Continuity: same in kind, extended in scope

Nothing below is new machinery. The codebase already isolates host contact:

- `lint.ts` (`lintFile(run, config, path)`) is pure orchestration over an
  injected runner — `formatFile` will be its mirror, same signature.
- `HookState` (`src/run-hooks.ts`) already carries `LogFn` + `RunCommand`
  instead of a host context; only `index.ts` fills it from opencode APIs.
- Only `index.ts` (+ `tui.tsx` UI half) imports `@opencode/plugin`. Every
  other module is host-agnostic (node builtins + injected fns).
- `normalizeCommandMap`, `splitCommand`, `toAbsolutePath`,
  `compileGlobMatchers` (`command-utils.ts`) are shared as-is.

## What does NOT move (stays opencode-only)

- `Plugin.define` setup, `ctx.tool.hook("execute.before"/"after")`
  registrations, `ctx.session.hook("experimental.idle")` + synthetic
  continuation, `event.subscribe` idle net, `ctx.command.transform` /
  `ctx.tool.transform` registrations, `permission.evaluate` mapping,
  config-mtime reload, TUI toast wiring.
- `tui.tsx` (`keymap.layer`, `dialog.alert`).
- The format no-op: opencode core formats natively, so the opencode adapter
  never calls `formatFile` (the "`(ignored — formatting is OpenCode core's
  job)`" strings stay true on opencode).

## Slice order (each slice green before the next)

0. **Branch + this plan.** `feat/dsh-adapter`. Done when the plan merges.
1. **Extract shared hook flows (in place, no moves).** New `src/run-hooks.ts`:
   `runPerEditLint(state)`, `runCompletion(state)` (+ `safeLog` helper),
   moved verbatim from `index.ts`, taking `HookState`. `index.ts` keeps
   registration thin and calls them. Unit tests with stub state; existing
   tests untouched. Gate green (`check`, `lint`, `lint:md`, `typecheck`,
   `test`, `build`). Zero behavior change — the diff must read as a move.
2. **`formatFile` in core.** `resolveFormatCommand` + `formatFile` mirroring
   `lint.ts` (same `{file}`/`{dir}` substitution, `existsSync` probe +
   TOCTOU re-probe, skip-vs-fail semantics, `summarizeFormat`). Unit tests
   mirroring `lint` tests (ghost files skip, timeout fails, exclude wins).
   Opencode adapter does NOT call it (no-op preserved). Gate green.
3. **DSH adapter dogfood (outside this repo).** Scratch adapter package
   (private, e.g. under `/tmp` or `~/dsh-migration`) importing core source
   directly: `tools/pre-execute` deny (protect lists verbatim),
   `tools/post-execute` format-then-lint with defensive re-entrancy guard,
   `agent/turn-stopping` counter (`gate.max_blocks`), slash commands via
   `dsh-commands`, `RunCommand` over `ctx.subprocess`, log via `ctx.logger`.
   Warn-tier mapping is allow-with-warn-log (never `ask`: without an
   approval service the host denies `ask`, which would convert advisories
   into blocks). Dogfood one real task on a scratch profile (stock
   `headless` + `--patch`, proven pattern). Exit: full ODF behavior
   observed on DSH, or a named seam gap with a fallback. No packaging
   commitment yet.
4. **Packaging decision (after dogfood).** Monorepo-ify (`packages/core`,
   `packages/opencode`, `packages/dsh`) vs in-place `src/core` +
   `src/adapters/*` vs standalone DSH package depending on the published
   core. Decide on evidence from slice 3, not before. Includes the DSH-side
   test story (vitest + `test-support` fakes; core unit tests stay shared).
   DECIDED 2026-11-16 on dogfood evidence: option B, in-place split
   (`src/core/*` harness-agnostic + `src/adapters/opencode/` thin
   registration + `src/adapters/dsh/` Cordis wiring). Rationale: the
   dogfood proved the seam is already clean (8 core modules imported, zero
   friction) — no package walls needed; single-maintainer repo keeps one
   npm flow. Promotion fixes from the spike review ride along
   (`checkToolCall` delegation via the `decideFileGuard`/`decideShellGuard`
   seam, core reason text, core block-store budget instead of an adapter
   counter, `renderStatus` reuse, profile-dependent guard-error handling
   (advisory allows, standard/strict deny — unknown = untrusted),
   pre-flight enforcement on pre-execute, warn-tier allow-with-log
   (`ask` never emitted: it denies without an approval service),
   load-failure error-log + no-op (mirror of opencode setup behavior). Known intentional asymmetry (not a fork):
   DSH pre-execute also guard-checks shell redirect targets
   (`extractRedirectTargets` → `decideFileGuard`) while OpenCode's
   `checkToolCall` checks only dangerous commands — same policy, wider
   coverage on the new wiring. Extending the shared path is a follow-up,
   not slice 4. Likewise out of scope for slice 4: child-session
   review-duty guard and pre-flight enforcement on DSH.
5. **Docs.** Update `05-implementation-checklist.md` per done slice;
   `README.md` + `AGENTS.md` only if the user-facing contract changes
   (packaging does; slices 1–3 don't).

## Validation (every slice)

Repo gate per `00-restart-brief.md`: `npm run check`, `npm run lint:md`,
`npm run typecheck`, `npm run test`, `npm run build` (`dist/` produced) —
or `./scripts/release.sh` matrix. DSH side: scratch profile runs, transcript
assertions (deny reason text, budget counter behavior, format-then-lint
ordering), never conversational self-report.

## Risks

- **DSH preview churn.** Pin `39163dd`/`0.2.2-rc.3` for seam references;
  re-verify on bump. Keep opencode ODF green and shipping throughout.
- **Re-entrancy.** `formatFile` mutates, so it re-fires `post-execute`;
  the guard lives in the DSH adapter, never in core.
- **Silent no-ops.** Any DSH seam that accepts registration but never fires
  (the base-profile-no-app hang from the spike is the template) must be
  caught by transcript assertions, not assumed from a clean boot.
