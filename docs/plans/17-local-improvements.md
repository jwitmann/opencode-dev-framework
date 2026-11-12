# Plan 17 — Local-only improvements (no upstream PR)

Status: proposal, not scheduled — except §1 (session duty roster),
§2 (config-weakening detection), and §3 (review substance), all
implemented 2026-11-12 (`src/roster.ts` + `src/weakening.ts` +
`src/review.ts`, wired in `src/index.ts` / `src/harness.ts`,
tests in `tests/roster.test.ts` / `tests/weakening.test.ts` /
`tests/review.test.ts`). Nothing else here is approved
to implement.

Re-grounded 2026-11-12: the first draft ranked these from memory
under mixed framings. This version follows a code re-read
(`index.ts` hook wiring, `rules.ts`, `commands.ts`, `goal.ts`,
`00-activation.md`) under the honesty framing, and corrects the
ranking — including one wrong claim (block messages were never
pure prose; see 6).

## Framing

We are not dealing with attackers. The agent is honest but eager
to be done; the plugin's job is to make the honest path the path
of least resistance, and to make skipped duties visible rather than
impossible to skip. Nothing in this doc buys prevention against
deliberate sabotage — that threat is out of scope. Each proposal
below is judged on whether it removes an accidental wrong result
or puts a corner-cutting shortcut on the record.

## Guiding constraint

No hardcoded patterns for behavior that varies per user, project,
shell, OS, or toolchain. Anything in that class must be configurable
with safe defaults and, where cheap, platform-aware — never a global
hardcoded list that silently changes enforcement for everyone.

## 1. Session duty roster (new, top candidate)

Problem: the constitution states generic obligations
(`rules/00-activation.md`: follow the rules, use the specialists,
never bypass a gate) but never the concrete per-project roster:
which steps will run at idle, over what file scope, whether the
review artifact is required, what the block budget is. Generic
obligations plus surprise specifics is how honest agents end up
corner-cutting.

Value: the honest path made legible upfront. The only proposal
here that prevents corner-cutting instead of catching it afterward.

Shape: a pure render function (`ResolvedConfig` to a ~10-line
block) injected beside the constitution on the existing `context`
hook (`src/index.ts`, no new hooks, no behavior change). Tests are
render-only.

Implemented 2026-11-12: `renderDutyRoster` in `src/roster.ts`
(typecheck / test+scope / lint / acceptance capped at 5 / review /
preflight, advisory non-blocking note, `max_blocks` + skip footer,
`off` returns null, empty renders an explicit skip line),
`rosterPresent` / `findRosterIndex` helpers for dedup + replace on
config change, second `event.system` part in the `context` hook
(constitution-independent, marker-keyed upsert).

## 2. Config-weakening detection

Problem: the duties document is freely rewritable mid-session.
`DEFAULT_PROTECT` (`src/config.ts`) does not cover the yml, and
the config reloads on mtime — so deleting checks, dropping
`require_review`, or lowering `max_blocks` silently moves the
goalposts. Rewriting the duties to make them pass is the canonical
duty-escape.

Value: turns "gate passed" from "passed current config" into
"passed the original contract, or the change was explicit".

Shape: snapshot enforceable checks in `HookState` at setup,
diff in `reloadConfigIfChanged`, surface in the gate summary.
`warn` in advisory, `deny` in standard/strict — no new axis.
Detection over prevention is deliberate: hard-denying config
edits would break legitimate agent-driven flows like `df init`.

Implemented 2026-11-12: `snapshotEnforceable` / `diffWeakening`
in `src/weakening.ts` (boolean flags, `require_review`,
`max_blocks` lowered, removed gate commands while their step
still runs, removed acceptance names, reduced preflight count,
scope narrowing that would skip tests; profile downgrade
collapses to one line; command *modifications* deliberately
unflagged). `HookState.initialEnforceable` snapshotted at setup
and never re-baselined (covers `set_profile` too); the diff runs
at evaluation time in `inspectCompletion`/`evaluateCompletion`
(`src/harness.ts`, `baseline` opt-in so manual `/df-verify`
still evaluates the live contract as-is), ahead of the pass-cache
lookup so a weakened contract never replays a cached pass. New
`"weakened"` verdict reason: blocks with its own continuation
wording in standard/strict, warns-and-passes in advisory. Stuck
stand-down tracks a `weakened:<lines>` signature.

## 3. Review substance (beyond existence)

Problem: `artifactState()` (`src/harness.ts`) returns `present`
for any non-empty file. A five-word "looks good" or an unfilled
template passes `require_review` — checkboxing the duty, not
doing it.

Value: raises the bar from "a file exists" to "a file has
substance", on the existing `FAIL(review)` path.

Shape: non-empty plus minimum meaningful length plus rejection
of template-only content, with new reason strings. Thresholds
stay constants in code with tests, not user config — "what counts
as a review" is a framework contract.

Implemented 2026-11-12: `assessReviewContent` in `src/review.ts`
(`REVIEW_MIN_CHARS` 200 / `REVIEW_MIN_WORDS` 30 floors, universal
placeholder markers with word boundaries plus unfilled-checklist
detection; deliberate padding out of scope). `readReviewState`
in `src/harness.ts` grades the artifact (`missing` | `empty` |
`thin` | `template` | `present`); only `present` satisfies the
duty. Thin/template block with their own summaries in
standard/strict, warn-and-pass in advisory. Messages are
constitution-agnostic (no `40-delegation` citation — the
constitution can be superseded, so the gate text stands alone).
Stuck stand-down tracks `review:<state>`, so partial progress
resets the streak.

## 4. Shell-edit attribution for the changed-file tracker

Problem: the tracker is fed by file-tool hooks, so shell-spawned
writes (`echo x > file`, `cat <<EOF > file`, `tee`) bypass it.
`git status --porcelain` backfills git repos only; non-git
projects have the hole wide open and `skip_unchanged` can skip a
session that did real work.

Value: the gate sees everything the session changed, however it
was changed.

Shape: parse the unambiguous core (`>`, `>>`, `tee`, heredoc
`<<`) out of `bash`/`shell` command strings into tracker adds,
plus optional user `shell_track_patterns` for project-specific
generators. Report-only, never deny; `off` preserves today.

## 5. Slimmed PATH/env (audit first, sanitization second)

Problem: `runCommand` (`src/host.ts`) inherits the agent's full
`PATH` and env, so "gate passed" can mean "gate ran the wrong
binary" through nobody's fault (dogfood D2b: `~/bin/false`).

Value, in honesty order: first, the audit — resolved binary
paths promoted into `GateStep`/the report ("`/usr/bin/tsc`
passed", not "`tsc` passed"), so the evidence is self-describing
and any oddity is on the record. Second, accident-prevention: a
permissive default sanitized `PATH` (denylist, per-OS
composition, unknown platforms inherit + warn) and the small
standard preload-variable strip as hygiene, not armor.

Shape: thread `env` through `RunCommandOptions` (`spawn`
already supports it; it is just never passed). Uniform scope —
gate steps, acceptance checks, the `git status` probe, per-edit
lint — one behavior, no special cases. Escape hatch
(`DF_ALLOW_UNSAFE_PATH=1`), logged loudly when active.

## 6. Verdict visibility (investigation-first, not yet a build task)

Problem: `actOnVerdict` (`src/index.ts`) returns null on
stand-down — after `max_blocks` or no-progress stand-down, the
record is the log file, the runtime-status file, and whatever
the agent chooses to say next. If the agent then writes
"done", what does the *user* see that contradicts it?

Next step is an audit, not code: what do `format-status.ts`,
`/df-status`, and the log surface to the user today on
blocked/stand-down/advisory-fail outcomes, and what is the
cheapest plugin-written, user-surfaced ledger for them? A
correction to the first draft: block messages were never pure
prose (`summarizeGate` is already one line per step), so any
message change here is an increment (resolved paths, explicit
remaining duties), not a rewrite.

## Explicitly out of scope for this goal

- **Dangerous-command expansion → safety track.** Preventing
  `curl | sh` footguns serves accident-prevention, not duties.
  May still be worth doing on its own track; the design notes
  stand (open platform-keyed sets by `process.platform` and
  shell family, universal-only fallback, user regex layer —
  never a bigger hardcoded universal list).
- **Dead `format` keys → hygiene track.** Goal-independent
  cleanup; batch with the next breaking release.

## Open investigations (not proposals)

- **Per-edit lint delivery path.** Failures go through `safeLog`
  to the log file (`src/index.ts`); nothing found so far puts
  them in the agent's context before idle. Confirm the delivery
  path first — if log-only, scope the feedback gap before
  proposing anything.

## Open questions

- Roster content: exact fields and length cap (steps? commands
  verbatim? protected paths? budget?).
- Review thresholds: length floor and template-detection rules.
- PATH denylist composition per OS; audit in the report vs the
  debug log.
- Verdict audit outcome (see 6).

## Ranking (proposer's take, not a decision)

Roster, then config-weakening, then review, then shell
attribution, then slimmed PATH, then verdict visibility (after
its investigation). Danger sets and format keys are off this
list — different tracks, different justifications.

## Next steps (not scheduled)

Pick at most one or two to flesh out into an implementation-ready
plan. Full validation per `AGENTS.md` applies to any of them
(`format:check`, `lint`, `lint:md`, `typecheck`, `test`, `build`).
