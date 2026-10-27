# Cutover: `idle`-first continuation (DECIDED, NOT IMPLEMENTED)

Date: 2026-10-27. Working directory: this repo (`~/opencode-dev-framework`).
No code changes in this note. Commit locally; never push without request.

## Decision

When upstream `anomalyco/opencode#58508` merges, the framework goes
`idle`-first and drops the `experimental.stopping` probes:

- Primary: `ctx.session.hook("idle", …)` → `synthetic`, same execution.
- Net: existing `event.subscribe` idle re-prompt stays, deduped, catching
  everything the hook skips (parked steers, hook throw).
- Wall: `tool.execute.before` pre-flight deny stays the only true hard gate.
- Cap and receipt: `evaluateCompletion` + `max_blocks` + standdown confession,
  unchanged.

Do NOT implement against the draft. Implement after merge.

## Hook shape (verified 2026-10-27 from the draft diff)

- Event is `{ sessionID, background }`. The framework ignores `background`.
- `stepped` rides through `Moved` / `Reloaded`; a move/reload landing at the
  idle boundary no longer skips the hook.
- Step allowance resets at each idle boundary. Each gate block gets fresh
  steps; `max_blocks` is the only brake.
- Hook runs through `restore(...)`, so a slow gate stays interruptible.
  Skips: interruption, failure, steer-parked drains.
- Continuations reuse durable inbox admission. No core cap — the plugin must
  bound its own loop; `max_blocks`/standdown already does.
- Two `idle` handlers (e.g. `/goal` + gate) can coexist; both admit via inbox.
  Ordering undefined; worst case both continue the same turn. Accept.

## Retained gaps

1. Hook throw fails open to idle. The subscriber re-runs the gate a turn
   later, loudly — delayed, not silent. Accept.
2. Parked-`queue` steer completion skips the hook atomically. Subscriber
   catches it next idle. Accept.
3. Fresh step allowance per block burns `maxSteps` faster than in-turn votes.
   Bounded by `max_blocks: 3`. Accept.
4. Synthetic continuations are transcript-visible. Accept; the receipt is the
   point.
5. Two tenants can double-admit. Inbox ordering absorbs it. Accept.

## Target architecture

```text
model work ends, nothing pending, not mid-continuation
  → idle hook (drain, interruptible): runCompletion → blocked? synthetic : abstain
    → inbox non-empty? continue same execution (no flicker, no race)
    → empty? go idle
  → session.idle event (execution ended): subscriber runs gate ONLY if the
    hook did not complete an evaluation for this session recently
  → edits: execute.before pre-flight deny (true hard wall, unaffected)
```

## Cut spec (execute after #58508 merges)

1. `src/index.ts` — delete §1b `stopping` probe + §1c
   `experimental.stopping` probe, `StoppingOutput` /
   `ExperimentalStoppingEvent` types, `recordStopLevel`. Replace
   `stopHookKind`/`stopHookSupported` with
   `continuationLevel: "idle" | "fallback" | undefined` (single flag, no rank).
2. `src/index.ts` — add §1b `idle` hook, defensive (`any`-cast, try/catch
   around registration like the probes today):
   stale-guard → `reloadConfigIfChanged` → `off` check → resolve sessionID
   (`event.sessionID ?? getEventSessionID`) → `runCompletion` →
   `actOnVerdict` → completed evaluation stamps `lastIdleHandled(sessionID)`.
   Blocked → `ctx.session.synthetic({ sessionID, text: message })` + info log.
   Throw path logs warn, abstains, and does NOT stamp (subscriber must retry).
   `background` ignored. Never `prompt` here.
3. `src/index.ts` — subscriber: before running the gate on idle, skip when
   `wasIdleHandledRecently(sessionID, 5_000)`. Switch admit to
   synthetic-first (prompt only if synthetic missing).
4. `src/block-store.ts` — delete `StopHookKind` rank/max logic; keep
   `blockCounts` untouched (it is the cap now). Smallest diff that keeps
   tests green wins; do not fork the store.
5. `src/format-status.ts` + `src/registry.ts` — status lines become
   `Continuation (idle): active` vs
   `Continuation (idle): not dispatched — event-subscribe fallback`.
6. `src/harness.ts`, `src/gate.ts` — no changes. The verdict runner already
   satisfies "plugin bounds its own loop".
7. `docs/plans/04-hook-mapping.md` — update the Completion-gate row:
   `session.hook("idle")` primary (synthetic, same execution, bounded by
   `gate.max_blocks`), `event.subscribe` net for skip paths, `execute.before`
   the hard wall.

## Dedup map (10 lines, in `src/index.ts` or a 20-line module)

- `Map<string, number>` sessionID → `Date.now()` at completed evaluation only
  (pass, blocked-admitted, standdown all stamp; throw/early-return do not).
- `wasIdleHandledRecently(id, windowMs = 5_000)`: timestamp within window.
- No persistence (memory only; worst case on reload is one extra suite run).
- No cap logic here — `max_blocks` in `harness.ts` stays the single brake.

## Tests (vitest, existing harness style)

- Remove stopping-vote mocks; mock `session.hook("idle")` + `session.synthetic`.
- `blocked → synthetic called with continuationMessage, blockCount+1`.
- `pass → no synthetic, counts cleared`.
- `hook throws → no synthetic, no handled-stamp` (subscriber must run).
- `subscriber skips when stamp fresh, runs when stale/absent`.
- Keep `tests/experimental-stopping.test.ts` until the cut lands, then delete
  with the probes (note the deletion in the cut commit message).

## Independent corroboration

- `robertelee78/agent-memory#19` (comment 2026-10-27) cites
  `anomalyco/opencode#16626` as blocking guaranteed final-turn work —
  same pre-stop/teardown-race conclusion.
- Draft `robertelee78/agent-memory#212`, design doc
  `docs/design/v0.0.4-harness-boundaries.md`: idle without a reliable
  exactly-one continuation is insufficient; tool-after callbacks and
  `session.updated` are not pre-stop gates; permission rules are mutable
  (later hooks can flip `ask`→`deny` to `allow`), so `execute.before`
  stays the load-bearing wall. Their OpenCode adapter settled on
  `context`-injection only with no post-response worker — same boundary
  reality our `idle` + subscriber net assumes.

## Portable lessons from #212 (useful, not load-bearing)

- Permission rules are mutable at runtime. A `session-update`-style call can
  replace the whole ruleset, and a later hook can flip an earlier denial to
  `allow`. Never trust `permission.evaluate` ordering alone — `execute.before`
  stays the wall because it runs in the pipeline before the call lands.
  No code change; confirms Phase 25's conclusion in `08-notes.md`.
- Installer discipline: journal owned entries, remove only owned entries on
  uninstall, preserve foreign hooks. Matches `installer.ts` behavior — keep
  it that way when touching install/update paths.
- Hook dedup by marker prefix (`startsWith`) is cheaper than full-text
  `includes()` on every request. Only worth adopting in `context` injection
  if constitution checks ever show up in profiles; today the cost is noise.
- Cost calibration from their trials: turn-start refresh ~132s / 18 tool
  calls with no delta; governed admission ~180s; OpenCode runs hit 6-min
  bounds without finishing. Our gate has the same shape — keep
  `skip_unchanged` cheap and the default `timeout` bounded; an expensive
  gate on every idle is the failure mode to avoid.
- Detached continuations are unsafe without serialization: their
  same-session probe got both answers in one stream, so "child exited 0"
  proves nothing. Another vote for in-drain `synthetic` over detached
  `prompt` once `idle` ships.
