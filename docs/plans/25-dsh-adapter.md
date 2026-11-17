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
   pre-flight enforcement on pre-execute (incl. `apply_patch`→`patch`
   envelope mapping, artifact exemption by resolved path), warn-tier
   allow-with-log (`ask` never emitted: it denies without an approval
   service), load-failure error-log + no-op (mirror of opencode setup
   behavior). `protect_off` scope mirrors opencode exactly: guardrails
   stand down, pre-flight + lint + gate still fire. Where the host allows
   MORE than parity, the adapter takes it (not parity-cloned):
   pre-terminal `turn-stopping` + `steer` continues the SAME turn
   (host awaits listeners, then re-reads its inbox — no re-prompt
   round-trip, unlike the opencode idle continuation), post-execute
   `block` turns lint findings into a model-facing tool error in the
   same turn (opencode `execute.after` can only log a landed edit),
   structured `info` on every denial, abort-aware steer (dropped when
   the turn is already dead), and shell redirect-target guard coverage.
   The two parity ceilings are verified, not assumed: warn→allow+log
   (nothing provides the `approval` service on headless, so `ask`
   unconditionally denies) and pre-flight/pre-execute deny (both hosts
   hard-block before the edit lands). Known intentional asymmetry
   (not a fork):
   DSH pre-execute also guard-checks shell redirect targets
   (`extractRedirectTargets` → `decideFileGuard`) while OpenCode's
   `checkToolCall` checks only dangerous commands — same policy, wider
   coverage on the new wiring. Extending the shared path is a follow-up,
   not slice 4. Likewise out of scope for slice 4: the child-session
   review-duty guard (needs a DSH child-session seam probe).

5. **Docs.** Update `05-implementation-checklist.md` per done slice;
   `README.md` + `AGENTS.md` only if the user-facing contract changes
   (packaging does; slices 1–3 don't).

## Parity audit (2026-11-16) — full OpenCode surface vs DSH

Prompted by challenge: the adapter replicated enforcement, not the
contract. Every OpenCode behavior below was checked against the DSH
sources (not assumed). Status: DONE (live-proven), GAP (missing),
N/A (by design), CEILING (parity is the max).

### Enforcement — DONE (all live-proven 2026-11-16, sessions `931700f5` + `9487c152`)

pre-execute deny, pre-flight (incl. `apply_patch` mapping, artifact
exemption, `protect_off` scope), post-execute accept/`block` with the
fault/infra line (127/empty/timeout stay accept), turn-stopping
same-turn steer (incl. abort drop), kill-switch scope, deny `info`
identity, redirect-target coverage. No further work.

### Instruction — GAP (the big one)

| OpenCode | DSH | Seam |
|---|---|---|
| Constitution injection (context/generate/compaction/title hooks) | missing (`state.constitution` stays `null`; the reload path maintains a value nothing reads) | `agent/pre-step` replace-messages, once per session |
| Duty roster (`renderDutyRoster` per request) | missing | fold into the same once-per-session prepend |
| Startup drift mention (`driftMentionLine`, once per session) | missing | same prepend when drift detected |
| Weakening detection (`snapshotEnforceable` vs live config) | DONE (inherited: `runCompletion` passes `initialEnforceable` as the gate baseline) | — |

### Tools (agent-invokable) — GAP (all portable)

`dev_framework_init`, `dev_framework_set_profile`,
`dev_framework_verify`, `dev_framework_status` exist only on OpenCode
(`tool.transform`). DSH precedent verified: `ctx.tools.register(
defineTool({...}))` (`tool-cordis`, `tool-goal`). Straight port, one
per tool, over the same core functions.

### Commands (human-invoked) — GAP (partially portable)

| OpenCode | DSH | Verdict |
|---|---|---|
| `df-status` | `df-status` (renamed from `odf-status` for the `df-*` convention) | DONE |
| `df-goal` (wrap + delegate to native `/goal`) | missing | PORT: availability probe (optional `commands.list`), pure `buildVerifiedObjective`, delegate via `ctx.goals.create(agent, ...)` (documented service, used by `command-goal` + `tool-goal`). Same contract, host-native mechanism |
| `df-verify` (TUI-only on OpenCode) | missing | PORT: `verifyGate` over the tracker snapshot, text result. Fills the on-demand slot the missing TUI leaves |
| `df-profile` (TUI-only on OpenCode) | missing | PORT: `changeProfile` with validation, text result |
| `df-init` / `df-update` | missing | PORT AS REPORT: detection + trial-run + brief-as-text (`init.ts`/`update.ts` are detection-first; full interactivity stays OpenCode/`bin`-only). `npx df init` already works for DSH projects (file scaffolding only) |
| `df-runtime`, TUI modals, keymaps | — | N/A: Solid TUI has no DSH counterpart; console text is the output surface |

### Native permission layer — CEILING (acceptable, documented)

OpenCode's `permission.evaluate` is defense-in-depth behind the
load-bearing `execute.before` deny. DSH's pipeline runs global guards
after pre-execute listeners with no equivalent second hook on
headless; our pre-execute deny IS the primary on both hosts. No
second layer exists to wire. Not a gap — the backstop, not the wall.

### Idle fallback net — N/A (no skip paths to net)

OpenCode needs the `event.subscribe` net because the idle hook has
boundaries it skips. DSH `turn-stopping` fires wherever a turn would
otherwise end (loop re-checks the inbox after awaited serial
dispatch; `concludesTurn` ends the turn through the same path).
Nothing to net. Verified by reading the loop, not assumed.

### Registry (per-project state) — N/A (by design)

Single project per mount (`ODF_WORKDIR`/cwd). No multi-project
fan-out to replicate.

### Child-session review guard — DONE (seam found in the host, not a spike)

OpenCode detects child sessions via a defensive host session lookup
(`childSessionGetter`). DSH needs no lookup: the host attaches the
session header to the agent, and the header carries parentage —
`origin === "subagent"` with `parentSession` naming the direct creator
(the host's own classification; historical forks may retain a creator
id without the origin, so both conditions are required — cf. the
host's `archive-admission` walk condition and `timeline/delegation`
reading the same fields). The DSH port is deliberately NOT a clone:
no async lookup, no cache, no depth walk — a synchronous header read
(`isChildAgent`) at the two DSH enforcement sites (turn-stopping
skip, pre-execute artifact deny). Same intent as plan 23, local shape.

### Leftovers already tracked (unchanged)

Pre-flight verb parity review; deliberate `release.sh minor` (user
action).

## Phase 43 — DSH parity completion (plan)

- 43.1 Instruction pillar: pre-step once-per-session
  constitution + roster + drift-mention prepend. Full battery
  (product code). Weakening already inherited via `runCompletion` —
  audit corrected, no work.
- 43.2 Agent tools: the four `dev_framework_*` tools via
  `ctx.tools.register(defineTool)`. Full battery.
- 43.3 Commands: `df-goal` (goals seam), `df-verify`, `df-profile`,
  `df-init`/`df-update` as report-mode. Full battery.
- 43.4 Child-session guard: DONE — the spike found the seam in the
  host session header (`origin`/`parentSession`), so no timebox exit
  was needed. DSH-native port (synchronous header read, no lookup /
  cache / walk), wired at turn-stopping + pre-execute. Full battery.
- 43.5 Deliberate release (`release.sh minor`, user action).

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
