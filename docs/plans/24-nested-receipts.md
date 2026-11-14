# Plan 24 — Nested review receipts (requester judges)

Status: design, agreed 2026-11-14. Not built. Predecessor: plan 23
(child sessions never touch the parent review artifact, phase 1).

## The principle

**You may only request what you can judge.** Requesting a review receipt
and judging it are the same act: whoever asks a subagent for a `review`
receipt owes judged consolidation of that receipt upward. Scope that
exceeds your judgment bounces up, never sideways.

## Continuity: same in kind, extended in scope

Nothing below is a new kind of machinery. Each item generalizes something
already shipped:

- **Freshness (plan 18) → citation closure.** The gate already checks
  artifact completeness mechanically (review must name every
  session-changed file). Extended: the consolidating artifact must cite
  every present keyed child receipt. Same check shape, widened coverage
  (changed files + child receipts), same exclusions extended (scratch
  dir alongside the review artifact and runtime snapshot).
- **Child skip + artifact deny (plan 23 §1) → ownership rule.** Today a
  child session may write no review path; extended: it may write exactly
  one — its own key, `review-<own-session-id>.md`. Same enforcement
  (exact-match deny on artifact paths), widened from one path to a keyed
  pattern. The Phase 40 incident stays impossible: the child cannot name
  the parent's file without deliberately reaching for another id, which
  is auditable rather than accidental.
- **`parentID` chain (registry) → requester identification.** The same
  primitive that powers the child skip, read one hop further: a keyed
  file's requester is its writer's parent. No new lookup, no new cache.
- **`clearSessionDirectory` eviction → reader cleans up.** Established
  lifecycle hygiene, applied to files instead of cache entries: whoever
  consolidates a child's receipt deletes it. Orphans from dead sessions
  are harmless litter in a gitignored dir.
- **"Only the orchestrator writes the artifact" (skill) → "only
  requesters consolidate; only depth 0 writes the gate artifact."** Same
  role clarity, applied per level instead of once globally.
- **Gate existence-vs-quality split → unchanged.** The gate checks
  presence and substance, never content judgment — extended to keyed
  files without changing its nature.

Genuinely new, in one line: writer-keyed receipt files, and the
requester-judges rule itself.

## The receipt contract

- **Two receipt types, declared at launch.** `report`: findings in the
  result text, nothing on disk. `review`: findings in the result text
  plus `review-<writer-session-id>.md` in the scratch dir. The launcher
  states which it expects ("leave your file" vs "report back").
- **Writer-keyed, scratch-scoped, gitignored.** The key is the writer's
  own session id — known without asking, collision-free by construction.
  One glob covers the scratch dir; receipts are evidence in transit, not
  history.
- **Requester consolidates and vouches.** A mid-level session that
  requested sub-reviews folds their judged content into its own keyed
  file. What travels up is never raw grandchildren — it is judged
  subtrees with a named judge on each edge.
- **Depth instrumented, uncapped.** Log chain depth on child-gated
  decisions (same log lines as plan 23). No cap, no counter enforcement
  — the keyed files plus the parent chain *are* the audit trail. A
  nonlinear fan-out, if it ever happens, will be sitting in the scratch
  dir, self-organized, as the evidence for the cap.

## Gate linkage: citation, not content

- At idle, every present keyed file must be cited in its requester's
  artifact — grandchildren's files in the child's file, children's files
  in the depth-0 artifact. Transitive closure, no top-level omniscience
  required.
- Dead subtrees owe nothing: no file, no citation duty, no strand risk.
- The gate never judges review content. A gate that judges reviews is a
  gate that writes them — the Phase 40 role confusion in formal dress.
- Trust model, stated plainly: the gate trusts *delivery* (the file is
  present and cited); each requester vouches for the *quality* of what
  it requested; spot-checks happen at every requester–requestee edge
  instead of all at the top.

## Refused machinery (with revisit triggers)

- **Expectation tracker** (`childID → expected receipt` pre-declared
  for the gate to enforce): refused. It needs a staleness/timeout story
  for dead children or it strands the parent's gate — machinery needing
  an escape hatch. Revisit only on a real incident of uncertain delivery
  (two-strike rule); the citation-closure check covers the need today.
- **Content-judging gate**: refused constitutively, no revisit trigger.
- **Depth cap**: deferred, not refused. Revisit on the first observed
  nonlinear fan-out.
- **Per-child consolidation ban** ("only depth 0 consolidates"):
  considered and rejected. Requester-judges legitimizes subtree
  consolidation; the ban would force raw grandchildren on the top-level
  orchestrator, which is *less* manageable, not more.

## Priced requests

Expecting a receipt costs the requester a judgment duty. That friction
is load-bearing: ten cheap review requests equal ten owed judgments, so
fan-out spam prices itself out while legitimate delegation is untouched.
Manageability via economics, not caps.

## When built (not now)

Launch-contract wording lands in the peer-review skill ("scope +
expected receipt + do not delegate further; bounce oversized scope
up"), the artifact-deny generalizes to the keyed pattern, and freshness
generalizes to citation closure. No new tracker, no new gate verdict,
no schema validation. Checklist entry only when a build is approved.
