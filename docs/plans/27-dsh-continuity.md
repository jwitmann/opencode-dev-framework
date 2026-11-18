# Plan 27 — DSH continuity probe (explicit unknown-state after restart)

Status: IMPLEMENTED (2026-11-18) on `main`; spec §8 acceptance met
(full suite green, red-before/green-after on stubbed `sessionQuery`,
no new dep/config, no bundle inject change — the probe resolves via
the sandbox `get` lookup with a guarded property fallback). Companion
to the upstream watchlist scoping in `08-notes.md` (issue 61884): that issue asks OpenCode for
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
- As built, the probe uses `readSession` and scans the raw tail: the
  investigation confirmed filtered documents (`SessionEventRecord`)
  carry no `data`, so `filterEvents` cannot see `reason.kind`
  (`dsh-session-query/src/index.ts:196-208` for `readSession`,
  `:292-297` for the filter path, union at `types.ts:216-221`).
- No bundle inject change was needed: the probe resolves the service
  through the sandbox `get` lookup (never throws for absent services)
  with a guarded property read as fallback, so unmounted profiles
  degrade to `unknown` without pending the plugin. This keeps the
  bundle's resolve-everywhere rule intact with zero placement risk.

## 3. Design

- **Session identity:** reuse `sessionOf(agent, turn)` (header id with
  agent-id/turn fallbacks). If the identity is a `turn-*` fallback, the
  probe reports `unknown` without querying — never guess across
  sessions.
- **When:** once per session per process, lazily at the first
  turn-stopping evaluation (the earliest point the adapter provably
  runs inside a live turn). Memoized in an adapter-local map (not core
  `HookState` — DSH-specific); never re-query. The memoized unit is the
  in-flight promise, so a stopping evaluation racing a status check
  shares one query, and a terminal `.catch` keeps the whole path total.
  `df-status` also ensures the probe for the invoking session, so a
  status check before any turn boundary still names the state.
- **What:** read the session log and scan raw events; if any `turn/end`
  carries `reason.kind: 'interrupted'`, continuity is
  `resumed-interrupted`, else `clean`. Any failure (service absent,
  query throws, header incompatible, uninterpretable log) reports
  `unknown`. All non-clean states keep today's behavior — the
  difference is the report, not the verdict.
- **Effect today:** none on verdicts. The probe result feeds
  `df-status` (a continuity line for the invoking session) and is
  logged once at debug level. `df-runtime` is deliberately excluded:
  its file snapshot is directory-scoped and cannot hold per-session
  state without last-writer-wins misattribution. Explicitly NOT:
  replaying passes, restoring budgets, opening `sessionPersistence`
  write handles (agent-loop owns them), or treating pre-step messages
  as continuity proof.
- **Forward seam:** the probe result is the documented input for
  durable receipts if option C is ever approved. Do not build C here.

## 4. Edge cases

- Aborted turn dropping its steer is orthogonal: abort handling stays
  as-is; the probe concerns process/session lifetime, not turn
  lifetime.
- No timeout on the `readSession` await: a hung corpus read would
  stall turn-stopping and `df-status` alike. Accepted as pathological
  (the bundled backend is a local corpus read; every other host read
  on this path is equally unbounded) — revisit if ever observed.
- Child reviewer sessions return before the probe site (existing
  review-duty skip), so children never query — only top-level sessions
  are assessed, and the parent answers for the shared tree.
- Fresh session (empty log): `clean` — an empty event array is a
  successful read, distinct from a failed one.

## 5. Honest scope

- This plan delivers observability + a seam, not enforcement. The
  fail-safe default (amnesia ⇒ re-verify) already holds and is the
  correct posture; the probe makes it visible and gives future durable
  state something to key on.
- The liveness generosity (fresh block budget per restart) is accepted
  and bounded by human relaunch. Closing it requires durable receipts
  (option C), deliberately out of scope.

## 6. Tests (fail-before where the seam is stubbed)

As built (9 tests, all red-before/green-after on stubbed seams):

- `sessionQuery` absent: `unknown`, gate unchanged; seam row reads
  unavailable (characterization of the degrade path).
- Interrupted tail: `resumed-interrupted`; gate still passes with no
  steer (no verdict delta).
- Balanced log and empty log: `clean` (empty array is a successful
  read, distinct from a failed one).
- Malformed payload (non-array `events`) and throwing query:
  `unknown`, gate still passes.
- `turn-*` fallback identity: no query issued, `unknown`.
- Direct `sessionQuery` property (no facade `get`): resolves.
- Concurrent stopping + status callers share one query.
- Mounted seam: `sessionQuery: available` snapshot row.
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
