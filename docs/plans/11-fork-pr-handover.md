# Handover: `experimental.stopping` fork PR (from framework dogfood)

Consumer-side validation is DONE and released. This note hands everything
the fork session needs to write the upstream PR for
`feat/experimental-session-stopping` (`d6389406a0`, fork HEAD verified
2026-10-11, tree clean).

## What was validated (and where it lives)

- Consumer: `opencode-dev-framework` **v0.4.0** (npm, `main` post-merge
  `4277134`). Registers `experimental.stopping` ALONGSIDE the legacy
  `stopping` probe — same dist works on cores with neither, either, or
  both hooks (fallback is always the `session.status:idle` re-prompt).
- Probe mapping: gate fail → `decision = { shouldContinue: true, text }`;
  gate pass/stand-down → abstain (fail-closed default untouched);
  voter body in try/catch → internal failure abstains, never throws into
  core (pinned by test).
- Unit tests: 213/213 green, incl. `tests/experimental-stopping.test.ts`
  (co-registration, verdict shapes, pre-increment, stand-down, voter-error
  abstain, monotonicity, store round-trip, status levels).
- Peer review: 3-specialist pass, no Blocking; dispositions recorded in
  framework `docs/plans/08-notes.md` ("Peer-review dispositions").

## Live receipts (fork standalone core + `~/animeRSS`, model `kimi-code-plan-global/kimi-for-coding`, agent `build`)

Raw logs (on this machine, keep with the PR or paste excerpts):

- `/tmp/opencode/df-dogfood-run3.log` — block→continue→rework→pass.
  Main session: `continuations:0 decision:blocked step:4` (grant, turn
  continued) → agent fixed the scratch type error, `go build ./...`
  green → `continuations:1 decision:pass` (abstain, natural exit).
  Same 0→1 shape in spawned subagent sessions. `RUN EXIT:0`.
- `/tmp/opencode/df-dogfood-run4.log` — persistent failure, report-only,
  no subagents. Single session: `continuations:0 blocked step:2` →
  `continuations:1 blocked step:3` → **third stop silent, zero vote
  lines** (core cap: voters not called past 2 grants). `RUN EXIT:0`.
- Legacy `stopping` probe stayed registered-but-silent on the fork (all
  vote lines `experimental.stopping`); both probes co-register in
  independent try/catch blocks.

## Repro (for future dogfooders — the gotcha that cost an hour)

The fork run via `bun dev` reports `channel=local`, so
`packages/cli/src/database-path.ts` isolates it on the near-empty
`opencode-local.db`, while official builds use `opencode.db` (all
connections). Credentials live in the DB (`CredentialTable`), so the
fork saw 23 models and `Model unavailable` for subscription providers —
same version string, same `auth.json`, same directory. Fix:

```bash
cd ~/opencode && OPENCODE_DISABLE_CHANNEL_DB=1 bun dev ~/animeRSS
# or for scripted runs:
OPENCODE_DISABLE_CHANNEL_DB=1 bun --cwd packages/cli src/index.ts run \
  --standalone --print-logs --model "kimi-code-plan-global/kimi-for-coding" \
  --agent build "<prompt>"
```

`--print-logs` is what captures server logs (vote lines); without it
only the agent transcript lands in the log. Console dynamic providers
(`kimi-code-plan-global`, `opencode-go`) are backend-issued
entitlements, not fork source.

## Upstream-reportable observations (fork PR body candidates)

1. Cap-exhaustion silence confirmed from the consumer side: exactly 2
   grants, third stop dispatches no vote.
2. Free-tier `opencode/*` inference rejects fork clients server-side
   ("can only be used from within OpenCode") — client-identity gate,
   not auth; subscription entitlements are withheld the same way for
   `channel=local` builds (see DB note above — separate mechanism,
   same symptom family).
3. Known core deviation (already committed in the fork, do not "fix"
   from the consumer side): vote `step` is a dedicated `executedSteps`
   counter, not `step - 1`. (A second deviation noted earlier —
   durable-counter reset gated on `!continuing` alone — is gone:
   `6d6e841e91` reworked the counter to be drain-owned, carried across
   reloads/moves, with no entry vote.)

## Open items (fork session's job)

- PR text + `services/www` docs already mirror the hook (Stopping
  subsections in `effect.mdx`/`index.mdx`) — confirm they match the
  validated behavior (cap silence, throw-is-stop, empty-text abstains).
- Scratch break used for validation (`dogfood-stopping/`, untracked)
  was deleted; `~/animeRSS` builds green. One agent-added parking-lot
  entry in `~/animeRSS/docs/NOTES.md` (tracked cache churn) was kept
  at the owner's request — unrelated to the hook, leave it alone.
