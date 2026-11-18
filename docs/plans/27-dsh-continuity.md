# Plan 27 — DSH continuity probe (explicit unknown-state after restart)

Status: SPEC ONLY (2026-11-18). No implementation. Companion to the
upstream watchlist scoping in `08-notes.md` (issue 61884): that issue asks OpenCode for
durable execution lineage; the DSH host already persists session logs
and marks interrupted tails, so the adapter-side work is to *read* that
signal, not to request a new host API.

## 1. Objective

Make the DSH adapter's post-restart continuity state explicit instead
of implicit:

- After a restart, prior gate state (block budget, no-progress streak,
  cached passes) is unknown. Today's behavior is already fail-safe —
  all of it lives in memory, so a fresh process re-verifies from
  scratch and a cached pass never survives — but nothing reports it.
- The probe reads the host's own interruption markers and reports
  `clean | resumed-interrupted | unknown` in `df-status`, giving the
  agent a true statement about the session it woke up in.
- It builds the seam durable receipts (deferred option C) would later
  plug into. It changes no gate verdict today; the spec is honest about
  that in §5.

## 2. What the host provides (verified on the installed DSH build)

- `dsh-base` is mounted by all three profiles (headless, tui, web), and
  it includes `dsh-session-persistence-jsonl` (durable append-only
  session logs, single-writer ownership, `flush()` durability barrier),
  `dsh-session-query-sqlite` (`ctx.sessionQuery`), and the durable KV
  stack (`ctx.storage` hub + json backend + `ctx.storage-domain`).
- On resume, agent-loop reads the persisted log and appends
  `interruptedTurnClosers`: synthetic tool errors, `step/end`, and
  `turn/end { reason: { kind: 'interrupted' } }`
  (`dsh-session/src/repair.ts:209-211`, closer shape at `:88-97`,
  event type at `dsh-session/src/types.ts:303`).
- `ctx.sessionQuery.filterEvents(sessionId, [{ kind: 'type', values:
  ['turn/end'] }])` returns semantic documents in ascending seq order
  (`dsh-session-query/src/index.ts:292-297`, filter union at
  `types.ts:216-221`). Whether the returned documents carry `data.reason`
  must be confirmed at implementation; if not, use `readSession` and scan
  the raw tail (same file, `:196-208`).
- The sandbox guard permits guarded optional reads of any mounted
  service with graceful degradation — the adapter's existing
  `hasServiceMethod`/`canAskUser` idiom. Property access requires an
  `inject` declaration; `ctx.get(name)` never throws for absent
  services. Since `dsh-base` is universal, declaring `sessionQuery` in
  the `odf-gates` inject block meets the bundle's resolve-everywhere
  rule, but verify against a profile dump before committing to the
  bundle vs. installer-override placement.

## 3. Design

- **Session identity:** reuse `sessionOf(agent, turn)` (header id with
  agent-id/turn fallbacks). If the identity is a `turn-*` fallback, the
  probe reports `unknown` without querying — never guess across
  sessions.
- **When:** once per session per process, lazily at the first
  turn-stopping evaluation (the earliest point the adapter provably
  runs inside a live turn). Memory flag on `HookState`; never re-query.
- **What:** query the session's `turn/end` events; if any event after
  the session's first `turn/start` carries `reason.kind:
  'interrupted'`, continuity is `resumed-interrupted`, else `clean`.
  Any failure (service absent, query throws, header incompatible,
  uninterpretable log) reports `unknown`. All three non-clean states
  keep today's behavior — the difference is the report, not the
  verdict.
- **Effect today:** none on verdicts. The probe result feeds
  `df-status`/`df-runtime` (a continuity line next to the existing
  seam-availability snapshot) and is logged once at debug level.
  Explicitly NOT: replaying passes, restoring budgets, opening
  `sessionPersistence` write handles (agent-loop owns them), or
  treating pre-step messages as continuity proof.
- **Forward seam:** the probe result is the documented input for
  durable receipts if option C is ever approved. Do not build C here.

## 4. Edge cases

- Fresh session (no prior log): `clean`, no query needed if the log is
  empty — but an empty read must not be confused with a failed read.
- Aborted turn dropping its steer is orthogonal: abort handling stays
  as-is; the probe concerns process/session lifetime, not turn
  lifetime.
- Child reviewer sessions: probe runs for the session the adapter
  instance serves; children inherit the adapter but must not duplicate
  the query — gate on the same once-per-session flag.
- `filterEvents` documents lacking `data`: fall back to `readSession`
  tail scan (bounded: last N events only; the interrupted marker, if
  any, is at the tail by construction).

## 5. Honest scope

- This plan delivers observability + a seam, not enforcement. The
  fail-safe default (amnesia ⇒ re-verify) already holds and is the
  correct posture; the probe makes it visible and gives future durable
  state something to key on.
- The liveness generosity (fresh block budget per restart) is accepted
  and bounded by human relaunch. Closing it requires durable receipts
  (option C), deliberately out of scope.

## 6. Tests (fail-before where the seam is stubbed)

- `sessionQuery` absent: probe reports `unknown`, gate behavior
  unchanged (characterization of the degrade path).
- Log with an interrupted tail: probe reports `resumed-interrupted`;
  gate still blocks-then-recovers exactly as today (no verdict delta).
- Clean log: reports `clean`.
- `turn-*` fallback identity: no query issued, reports `unknown`.
- Follow the existing `withSubagents` stub pattern: test-owned
  `sessionQuery` object on the stub context; no host imports, no real
  subprocess.

## 7. Docs

- `docs/user/dsh.md` continuity/troubleshooting note: the restart rule
  in one paragraph (unknown ⇒ re-verify, passes never survive).
- `df-status` documents the new continuity line.
- Update this plan's status line when implemented; move the watchlist
  entry only if the host side changes.

## 8. Acceptance

- Probe runs at most once per session per process; never throws out of
  the stopping path; every failure mode reports `unknown`.
- All existing suites green; new tests red-before/green-after against
  stubbed `sessionQuery`.
- No new dependency, no new config key, no bundle inject change
  without a profile-dump proof that the service resolves everywhere.
