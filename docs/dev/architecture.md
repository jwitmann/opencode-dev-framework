# Architecture (overview)

The plugin is thin: shared logic in `src/`, per-project state in memory,
host I/O behind an injectable seam so unit tests never shell out.

## Entry points

- `src/index.ts` — the only OpenCode-facing module: `Plugin.define`,
  hook wiring, and custom tool/command registration. Everything else is
  pure logic plus a `RunCommand`.
- `tui.tsx` — TUI companion (Solid): `/df-status`, `/df-help`,
  `/df-profile`, `/df-verify` modals. Resolved through `package.json`
  `exports` from the repo root; one `plugins` entry loads server + TUI.
- `bin/df` — the `df init / profile / status / version` CLI (scaffolding
  via `src/installer.ts` + `templates/`).

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
