# Plan 20 — Startup template-drift mention

## Ask (explicit, 2026-11-12, cut by mistake in plan 19)

"On startup check the skills hash, and mention we have a skill update?"
plus the `/df-update` command. Plan 19 shipped only the command;
"today's problem, nothing more" was misread as cutting the check and
the mention, which were the core of the ask. This plan restores them.
No new approval needed beyond the original ask.

## Scope

- **Startup means first `context`-hook sighting per session** (not
  plugin `setup()` — setup has no session to mention into; log-only
  is the known-invisible failure mode). In-memory seen-set, so an
  opencode restart/reload naturally re-arms the mention.
- Mention only: one line beside the roster while drift exists,
  self-clearing (next session re-checks; fixed tree mentions nothing).
  No auto-apply — the plan 19 rule stands.
- Empty tree (nothing installed) stays silent: the ask was the drift
  mention, not a new `/df-init` nag. `/df-update` itself still
  redirects empty trees.

## Wiring

- Pure `driftMentionLine(drift)` in `src/update.ts` (reuse
  `TemplateDrift`): null unless installed-but-drifted; one line with
  refresh/add counts + "run /df-update".
- Seen-set in `src/registry.ts` beside `sessionToDirectory`
  (`hasSeenSessionStart` / `markSessionStartSeen`, forgotten in
  `clearSessionDirectory` + `resetRegistry`).
- `context` hook in `src/index.ts` after the roster block: first
  sighting → mark, best-effort `checkTemplateUpdates` (never throws
  into prompt assembly; debug log on failure), push the line if any.
  After the `off` early-return, so `off` stays silent.
- Tests in `tests/update.test.ts`: line content/counts, null when
  current, null when empty.
- Docs: this plan, checklist Phase 36, one `commands.md` line under
  `/df-update`.

## Validation

`format:check`, `lint`, `lint:md`, `typecheck`, `test`, `build` per AGENTS.md;
peer-review pass before done; commit locally, never push.
