# Plan 22 — Template state in `/df-runtime`

## Ask (2026-11-14)

Silent no-ops (plan 21) leave no transcript trace — by construction the
server command API offers no result channel. The user asked for the
visible counterpart: `/df-runtime` says whether templates are up to
date, drifted (run update), or not installed (run df-init).
"Nothing more": three states, no file lists, no actions.

## Shape (decided, matches existing architecture)

- Snapshot gains optional `templates: TemplateState` (`current` |
  `drifted` | `empty` + counts). Optional because old snapshots lack
  it — renders as unknown, never as current.
- `summarizeDrift` in `src/update.ts` (pure, beside the other drift
  helpers; counts only). Computed in `src/index.ts` (which already
  imports both sides), keeping `runtime-status.ts` dependency-free.
- Stamped at setup ("armed") and refreshed on every continuation
  dispatch (both already write the snapshot) via one
  `stampRuntimeStatus` helper — fire-and-forget, best-effort, check
  failure renders as unknown.
- TUI needs no change: `tui.tsx` renders `renderRuntimeStatus`
  verbatim. Renderer gains the Templates line (three states + unknown).
- No toast: server-side has no toast channel (verified in plan 21 —
  `ctx.ui.toast` is TUI-process-only, `HookState.showToast` is dead).
- Tests: snapshot round-trip + old-snapshot tolerance + invalid-state
  tolerance; renderer three states + unknown; `summarizeDrift` three
  states. Docs: commands.md `/df-runtime` clause, checklist entry.

## Validation

`format:check`, `lint`, `lint:md`, `typecheck`, `test`, `build` per AGENTS.md;
peer-review pass before done; commit locally, never push.
