# Plan 21 — Silent no-ops for `/df-update` and `/df-init`

## Incident

`~/finnomena` (2026-11-14): `/df-update` on a current tree (10/10 match)
still cost a full agent turn to deliver "Nothing to do" — the model,
handed a turn, thought (`+1 thought`) for zero value. Same shape in
`/df-init`'s already-configured path (status note still prompted).

## Constraint (verified, not assumed)

Server-side `execute` returns `Promise<void>`
(`@opencode/plugin` command types): prompt-or-nothing. There is no
inline-answer channel, and throwing to surface a success would be
error-UX noise. So the turn itself is the cost, and the only lever is
whether to take it.

## Rule

Prompt only when the handoff needs agent judgment or relays something
the user doesn't already know. Pure "all good" confirmations go
nowhere (log line, no turn):

- `/df-update`: drift (refresh/add, installed tree) → prompt as today.
  Current → silent return + log. Empty tree → still prompts: the
  `/df-init` redirect is guidance to an exploring user, not a
  confirmation.
- `/df-init`: fresh scaffold → prompt as today. Already-configured
  re-run with warnings (reload/trial failures the user came to fix) →
  still prompts. Clean re-run → silent return + log.

## Feedback channel (verified 2026-11-14: no toast from the server)

"Quiet" means literally nothing in the transcript beyond the user's own
invocation line — no "nothing to do" text. The server command API
offers no result channel: `execute: Promise<void>` in the SDK types
AND the core promise protocol (`packages/plugin/src/promise/
command.ts:16` in the local fork). `session.prompt` (a full turn) or
nothing — those are the only two things a server command can do.
Toast is TUI-process-only (`ctx.ui.toast.show` in `tui.tsx`; the
server client types expose no `tui` namespace, and
`HookState.showToast` is a dead field — declared, never populated or
called). Stdout goes to the server log, invisible in the TUI. So the
no-op path is silent-by-construction with a log line as its only
trace; the startup mention + docs carry awareness instead. Unit tests
pin the mechanism (deliver not called on no-ops); no live run can add
more, since a headless transcript can't show TUI chrome anyway.

## Wiring

- Pure predicates beside their composers: `needsAgentHandoff(drift)`
  in `src/update.ts` (`refresh || add` — an empty tree's missing files
  already read as `add`, so no special-casing), equivalent in
  `src/init.ts` (fresh, or warnings non-empty).
- `runUpdateCommand` / `runInitCommand` return whether they delivered
  (`true`/`false`) instead of `void`; the `execute` site logs the skip
  (observability without a turn). Delivery-failure throw contract
  unchanged (only reachable when a delivery was attempted).
- Tests: deliver-not-called on clean no-ops, called on drift / fresh /
  warnings / empty-update; return-value assertions; existing
  delivery-failure tests keep passing.
- Docs: this plan, checklist entry, one `commands.md` clause per
  command ("stays silent when there is nothing to do").

## Validation

`format:check`, `lint`, `lint:md`, `typecheck`, `test`, `build` per AGENTS.md;
peer-review pass before done; commit locally, never push.
