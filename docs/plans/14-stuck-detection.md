# No-progress early stand-down (stuck detection)

## 1. Problem

The completion gate's block budget (`gate.max_blocks`) is spent per
red-streak evaluation, unconditionally. When a failure is unfixable from
inside the session — missing docker, no network, broken toolchain — the
agent burns the entire budget "fixing" something it cannot fix, then
stands down. Bounded, but wasteful: N continuations that buy zero
information. The user, seeing the failure once, could call it off
immediately; the gate cannot. No new knob is wanted (the profile stays
the single axis — see troubleshooting "Diagnosing a red tree"), so the
gate must recognize stuckness itself.

## 2. Decision

Stand down early when consecutive blocked evaluations show **zero
progress**: same failure signature AND no new edits between blocks.
Progress — a moved tree or a changed failure — keeps spending budget
normally. This judges *progress*, which is observable, never
*fixability*, which would be heuristic soup.

## 3. Contract

In `evaluateCompletion` (`src/harness.ts`), on the blocked path (after
the advisory early-return, before `increment`):

1. Compute the failure signature for this evaluation:
   - gate-failed: `"gate:"` + sorted `report.failedSteps` names
     (`GateStep.name`: `typecheck`, `test`, `lint:<file>`,
     `acceptance:<name>` — content-free, no log text, no timestamps).
   - review-missing: `"review"` (reason-agnostic; an unwritten review
     across blocks is the same stuck shape).
2. Compare against the stored snapshot from the previous blocked
   evaluation in this red streak: same signature AND `changedFiles` set
   equal (order-insensitive) → no-progress repeat.
3. Two consecutive no-progress repeats (i.e. the third identical
   evaluation) → return `standdown` with the standard shape plus a
   no-progress note: what stayed identical across how many evaluations.
   Same cleanup as budget stand-down (clear tracker, clear block state).
4. Otherwise → record `{ signature, files }` as the new snapshot and
   proceed to the existing increment/block/stand-down logic.

Threshold rationale: one investigate-then-fix cycle is tolerated (block
1 fails → block 2 identical while the agent reads logs/runs diagnostics
without editing → block 3 identical means the investigation bought
nothing either). Constant `2`, hardcode — not a config key. A changed
tree OR a changed signature resets the repeat count (but not the block
budget, which keeps its existing pass-clears semantics).

State: stored per session alongside the block count (storage-backed
like `BlockStore`, same lifetime rules: cleared on pass and on any
stand-down). Snapshot shape: `{ signature: string, files: string[] }`.

## 4. Non-goals and known edges

- **Flapping (fail→pass→fail) is out of scope.** A PASS is progress by
  definition and clears both counters today; per-episode bounding stands.
- **Revert-to-identical** (agent edits then reverts, file set equal
  again) reads as no-progress and can trigger early stand-down one
  evaluation sooner than the budget would. Acceptable: the consequence
  is a loud stand-down, never a wrong PASS, and the report shows the
  identical signature.
- **Review-missing + no edits**: same rule applies — an agent that won't
  write `review.md` across three idle boundaries is stuck, not slow.
- **Advisory/off**: untouched (never block, never snapshot).
- **Dual levers**: both feed `evaluateCompletion`, so the snapshot is
  lever-agnostic by construction — no double-counting, no divergence.
- **`dev_framework_verify`**: untouched (manual verify never touches
  block state today; a manual PASS still clears via the normal pass
  path only when it runs through `evaluateCompletion` — verify is
  side-effect-free, so it neither records nor clears snapshots).

## 5. Tests (`tests/`)

Stub-host unit tests against `evaluateCompletion`:

- identical signature + identical files × 3 → third returns `standdown`
  with the no-progress note; tracker and block state cleared.
- tree moved (one new file) on the repeat → `blocked-admitted`, repeat
  count reset.
- signature changed (different failing step) → `blocked-admitted`,
  repeat count reset.
- pass after two repeats → `pass`, snapshot cleared (no phantom third).
- advisory profile → `pass`, no snapshot written.
- single identical repeat (2nd evaluation) → still `blocked-admitted`
  (tolerance for one investigate cycle).

## 6. Dogfood

Fixture with an unfixable gate (`test: "false"`, nothing to fix) +
prompt "report the result, do not change files": expect block,
no-progress repeat, early stand-down on the third identical evaluation —
2 continuations max, never the full `max_blocks` spend. Model
`kimi-code-plan-global/kimi-for-coding`, receipts in `08-notes.md`.
Risk: the agent may still try edits despite the instruction (cf. T3);
unfixable command keeps the signature identical regardless, which is
exactly the property under test.

## 7. Definition of done

- [ ] Snapshot record/compare/clear in `evaluateCompletion` per §3.
- [ ] Unit tests per §5, full suite green.
- [ ] Dogfood receipt per §6 in `08-notes.md`.
- [ ] Peer-review skill gate (pattern/style/correctness), no Blocking.
- [ ] `enforcement.md` limitations + troubleshooting red-tree entry
  updated: early stand-down on zero progress is now documented behavior.
- [ ] Commit locally, never push.
