# Cutover: `idle`-first continuation, vote retired (DECIDED, NOT IMPLEMENTED)

Date: 2026-10-27. Working directory: this repo (`~/opencode-dev-framework`).
No code changes in this note. Commit locally; never push without request.

## Decision

When upstream `anomalyco/opencode#58508` merges, the framework goes
`idle`-first and retires the `experimental.stopping` vote (`anomalyco/opencode#54487`):

- Primary: `ctx.session.hook("idle", …)` → `synthetic`, same execution.
- Net: existing `event.subscribe` idle re-prompt stays, deduped, catching
  everything the hook skips (parked steers, hook throw).
- Wall: `tool.execute.before` pre-flight deny stays the only true hard gate.
- Cap and receipt: `evaluateCompletion` + `max_blocks` + standdown confession,
  unchanged.

Do NOT implement against the draft. The hook name survived rebase so far,
but the PR is still Draft and the body can still move. Implement after merge.

## Ground truth (verified 2026-10-27, no credentials needed)

PR #58508, title `feat(core): add /goal on top of a session idle hook`,
state open Draft. Body says `Refs #27167` (the `/goal` issue). The
`Fixes #16626` line lives only in the `opencode-github-bot` review footer
(`Fixes #16626 / Related: #27167, #50133, #12472`) — that links but does not
auto-close; only the PR body closes. Bodies are clean: ours `Closes #16626`,
theirs `Refs #27167`. Stay quiet; comment only if their body flips to
`Fixes #16626` or a maintainer tags ours duplicate/superseded.

Size: `curl -sSL …/pull/58508.diff` grew 11k (6 files, 2026-10-24) → 162k
(40+ files, 2026-10-27). Receipts kept at `/tmp/opencode/58508.diff` and
`/tmp/opencode/58508-new.diff` (machine-local, not in repo).

What changed for us (idle hook itself, apart from rebase):

- Event is now `{ sessionID, background }` (was `{ sessionID }`).
  `background` lists still-running background shells/subagents from
  `SessionBackground.outstanding` so a waiter can return and be woken later.
  The framework ignores it.
- `stepped` rides through `Moved` / `Reloaded` (`DrainResult` gains
  `stepped?: true`). A move/reload landing at the idle boundary no longer
  skips the hook — one bypass closed.
- Step allowance resets at each idle boundary (now explicit in the PR body).
  Each gate block gets fresh steps; `max_blocks` is the only brake.
- Hook runs through `restore(...)`, so a slow gate stays interruptible.
  Skips unchanged: interruption, failure, steer-parked drains.
- Continuations reuse durable inbox admission (restart recovery resumes a live
  loop). No core cap — a plugin that always admits input must bound its own
  loop (the README says so). Our `max_blocks`/standdown already does.
- `session.settled` (ephemeral "done" notification gated on own background
  subagents) is notification-only. Irrelevant to the gate.
- `/goal` (`packages/core/src/plugin/goal.ts`) is a built-in plugin on public
  APIs only. Proves the cooperative loop works, and means two `idle`
  handlers (goal + gate) can coexist. Ordering undefined; both admit via
  inbox, worst case both continue the same turn. Accept.

## Why the vote retires

- Mainline reality: the framework ships on released cores. The vote never
  fires there; the probes are dead weight on every user install.
- Maintenance: voter protocol (decision merging, counter-in-continuation,
  fail-closed handling) is the most complex, least-reviewed surface we own,
  for a guarantee the framework contract ("loud disobedience, not impossible
  bypass") does not require.
- Coverage: `idle` + subscriber net + `execute.before` wall gives no silent
  bypass. The vote's remainder is one-turn delay on skip paths and in-turn
  steps — not worth a second protocol.

## Retained gaps (honest, do not re-litigate in code review)

1. Hook throw fails open to idle. The subscriber re-runs the gate a turn
   later, loudly — delayed, not silent. Accept.
2. Parked-`queue` steer completion skips the hook atomically. Subscriber
   catches it next idle. Accept.
3. Fresh step allowance per block burns `maxSteps` faster than in-turn votes.
   Bounded by `max_blocks: 3`. Accept.
4. Synthetic continuations are transcript-visible (cleaner attribution than
   `prompt`-as-user, still visible). #16626's "silent internal path" ask is
   not met by either hook. Accept; the receipt is the point.
5. Two tenants (`/goal` + gate) can double-admit. Inbox ordering absorbs it.
   Accept.

## Target architecture

```text
model work ends, nothing pending, not mid-continuation
  → idle hook (drain, interruptible): runCompletion → blocked? synthetic : abstain
    → inbox non-empty? continue same execution (no flicker, no race)
    → empty? go idle
  → session.idle event (execution ended): subscriber runs gate ONLY if the
    hook did not complete an evaluation for this session recently
    (skip caches, parked steers, hook throw)
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
   synthetic-first (prompt only if synthetic missing). Rationale: hook-handled
   pass/standdown would otherwise pay a second full suite for no new signal.
4. `src/block-store.ts` — delete `StopHookKind` rank/max logic; keep
   `blockCounts` untouched (it is the cap now). Replace stop-level persistence
   with `setIdleSupported()` or drop it if `/df-status` reads the in-memory
   level only. Smallest diff that keeps tests green wins; do not fork the store.
5. `src/format-status.ts` + `src/registry.ts` — status lines become
   `Continuation (idle): active` vs
   `Continuation (idle): not dispatched — event-subscribe fallback`.
6. `src/harness.ts`, `src/gate.ts` — no changes. The verdict runner already
   satisfies "plugin bounds its own loop".
7. `docs/plans/04-hook-mapping.md` — update the Completion-gate row:
   `session.hook("idle")` primary (synthetic, same execution, bounded by
   `gate.max_blocks`), `event.subscribe` net for skip paths, `execute.before`
   the hard wall. Remove "no `session.stopping` veto" phrasing once idle ships.

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

## Retiring #54487 (only after #58508 merges)

Close with a short factual note, no lobbying:

> Closing in favor of #58508's `idle` hook. The vote's fail-closed guarantee
> didn't justify a second protocol once `idle` plus a subscribe backstop
> covers the framework's contract (bounded by `max_blocks`, bypasses stay
> loud). Thanks for the review asks — counter-in-continuation and trigger
> placement notes carried into the dedup design.

## Watch items (no action now)

- #58508 body flips to `Fixes #16626`, or ours tagged duplicate/superseded →
  one factual comment with the parked-steer exhibit, then stop.
- `/goal` handler ordering documented upstream → revisit §2 if the runner
  ever sequences multiple `idle` voters (today inbox-absorbed).
- Released core dispatches `idle` → implement the cut; until then this note
  is the whole change.
