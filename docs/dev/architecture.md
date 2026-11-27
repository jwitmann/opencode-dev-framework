# Architecture (overview)

The plugin is thin: shared logic in `src/`, per-project state in memory,
host I/O behind an injectable seam so unit tests never shell out.

## Entry points

- `src/adapters/opencode/index.ts` — the only OpenCode-facing module: `Plugin.define`,
  hook wiring, and custom tool/command registration. Everything else is
  pure logic plus a `RunCommand`. The DSH-facing counterpart is
  `src/adapters/dsh/index.ts` (Cordis wiring over the same `src/core/`).
- `tui.tsx` — TUI companion (Solid): `/df-status`, `/df-help`,
  `/df-profile`, `/df-verify` modals. Resolved through `package.json`
  `exports` from the repo root; one `plugins` entry loads server + TUI.
- `bin/df` — the `df init / profile / status / version` CLI (scaffolding
  via `src/installer.ts` + `templates/`; `df init --wizard` also prints the
  wizard brief).

## Modules

| Module | Owns |
| ------ | ---- |
| `config.ts` | Config loading, precedence, profile defaults, Zod validation |
| `rules.ts` | Constitution assembly (bundled + local + style guide) |
| `protect.ts` | Protected-path and dangerous-command verdicts |
| `lint.ts` | Per-edit lint orchestration + concurrency limiter |
| `gate.ts` | Completion gate steps (typecheck / tests / lint / acceptance) |
| `harness.ts` | Pre/post-flight verdicts, changed-file union, pass cache |
| `goal.ts` | `/df-goal` pure policy (thin adapter over native `/goal`) |
| `commands.ts` | Shared slash-command logic (`verifyGate`, `changeProfile`) |
| `installer.ts` | Template scaffolding, detection config writer, trial-run, wizard brief |
| `registry.ts` | Per-project hook state registry |
| `host.ts` | `RunCommand` abstraction (stubbed in tests, real spawn in prod) |
| `block-store.ts` | Storage-backed gate block counts |

## Hook wiring (summary)

| OpenCode hook | Plugin behavior |
| ------------- | --------------- |
| `session.hook("context")` (+ `generate`/`compaction`/`title`) | Constitution injection |
| `permission.hook("evaluate")` | Guardrail verdicts (deny or abstain, never allow) |
| `tool.hook("execute.before")` | Guardrails + pre-flight hard block |
| `tool.hook("execute.after")` | Per-edit lint + change tracking |
| `session.hook("experimental.idle")` (+ `idle` alias) | Completion gate, synthetic continuation on failure |
| `event.subscribe` | File tracking + idle-net fallback |
| `tool.transform` / `command.transform` | Custom tools + `/df-goal` wrapper |

## Canonical references

This page is an orientation map, not a spec. Authority lives in:

- [`../plans/02-architecture.md`](../plans/02-architecture.md) — package
  type, entry point, modules, host abstraction, build output.
- [`../plans/04-hook-mapping.md`](../plans/04-hook-mapping.md) — full
  primitive mapping table, per-hook behavior, anti-patterns.
- [`../plans/12-idle-hook-cutover.md`](../plans/12-idle-hook-cutover.md) —
  idle-hook cutover and the event-net fallback.

## Deferred and declined options

- **Additional host adapters.** Not scheduled without actual maintainer usage
  or a concrete supported-user request. The dated
  [host-expansion survey](../plans/28-host-expansion-survey.md) records the
  verified surfaces for Pi, Gemini CLI, Goose, Copilot CLI, Claude Code, Codex
  CLI, and Cursor, plus the durable-state cost of command-hook hosts.

- **Per-reviewer model pinning (`agentOptions` / `model:`).** Deferred
  until someone asks for it — e.g. an advanced option for users who want
  the gate to always run on model X. Until then the default stands:
  reviewer children inherit the parent session's model on both hosts
  (DSH `agentOptions` left unset — feasible when requested: the `spawn`
  provider honors `agentOptions`, unlike the ACP/out-of-process providers;
  shipped OpenCode agents carry no `model:` field). Notes for the day it's requested: pinning cheap models
  on reviewers saves cents per task but risks silent-PASS laundering (a
  weak PASS is indistinguishable from a real one downstream), so it must
  ship as explicit opt-in with a loud default-inherit rule, never a quiet
  default. And the safety case is hard to build at reasonable cost —
  scoring reviewer quality needs seeded-defect cases plus human rubric and
  spot-check labor, and any model-as-judge layer reintroduces the
  subjectivity the measurement is supposed to resolve.

- **Plugin-level depth cap (no-grandchildren rule).** Declined. The idea
  originated OpenCode-side, where depth is an experimental global
  (`experimental.subagent_depth`), not a per-dispatch knob — so a plugin
  rule would be home-rolled enforcement duplicating host machinery. On
  DSH the same objection holds in mirror: the `spawn` provider already
  enforces its own recursion caps (budgets, not prohibitions). No action
  unless a host drops its own machinery.
