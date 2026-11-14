# Plan 24 — Nested review receipts (requester judges)

Status: design, agreed 2026-11-14, hardened through review passes
2026-11-15. Not built — deferred until `experimental.subagent_depth`
is raised above 1 (core's default of 1 forbids nesting on the
subagent-tool path, so the plan's scenario cannot arise by accident).
Depth tripwire built 2026-11-15. Predecessor: plan 23
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
  primitive that powers the child skip, walked upward: a keyed file's
  requester is its writer's nearest living ancestor via `parentID`.
  Only a confirmed not-found/deleted result ends the walk; unknown
  liveness defers evaluation rather than orphaning or promoting (see
  gate linkage). Same lookup, deeper traversal while sessions resolve;
  no ancestry cache, no tracker. Structural ancestry, fork lineage, and
  review-request ancestry are distinct: `fork.sessionID` is lineage
  metadata, never a requester or child-gate edge.
- **`clearSessionDirectory` eviction → reader cleans up.** Established
  lifecycle hygiene, applied to files instead of cache entries: whoever
  consolidates a child's receipt deletes it. Receipts whose writer is
  confirmed deleted are excluded from citation closure as orphaned
  litter in the scratch dir (see gate linkage); unknown liveness never
  orphans — it defers.
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
  Investigation-only specialists default to `report`; a `review`
  request to one is valid only with the narrow exception below (own
  keyed scratch receipt, never project files, never the gate
  artifact).
- **Writer-keyed, scratch-scoped, gitignored.** The key is the writer's
  own session id — collision-free by construction, delivered to the
  writer via context injection (build requirement: the plugin exposes
  the current session id so a child can name its own file; until then
  the contract is not executable). One glob covers the scratch dir;
  receipts are evidence in transit, not history. Scratch-local ignoring
  is provisioned at build so receipts stay git-invisible in target
  projects, and the receipt dir is excluded from changed-file/gate
  inputs alongside the review artifact and runtime snapshot.
- **Requester consolidates and vouches.** A mid-level session that
  requested sub-reviews folds their judged content into its own keyed
  file. What travels up is never raw grandchildren — it is judged
  subtrees with a named judge on each edge.
- **Depth instrumented, uncapped.** Log chain depth on child-gated
  decisions (same log lines as plan 23). No cap, no counter enforcement
  — the keyed files plus the parent chain *are* the audit trail. A
  nonlinear fan-out, if it ever happens, will be sitting in the scratch
  dir, self-organized, as the evidence for the cap.
  Tripwire built 2026-11-15 (`resolveSessionDepth` in `registry.ts`,
  `depth` on all four child-gated log lines): at core's default
  `experimental.subagent_depth` of 1 the subagent tool itself refuses
  nesting, so depth 1 is the entire expected world and anything deeper
  means a raised limit or a non-tool creation path (e.g. API-supplied
  `parentID`, which has no depth check). Verified against local core @
  `5a7f398` (2026-11-06, `experimental` namespace — recheck on drift).
  The rest of this plan stays unbuilt until the tripwire fires.

## Gate linkage: citation, not content

- At idle, every present keyed file must be cited in its requester's
  artifact — grandchildren's files in the child's file, children's files
  in the depth-0 artifact — subject to the liveness rule below.
  Transitive closure, no top-level omniscience required.
- **Requester = nearest living ancestor, else self.** Walk up while
  `session.get` resolves, following `parentID` only — `fork.sessionID`
  is lineage metadata, never a requester edge (see topology). Only a
  confirmed not-found/deleted result establishes death: a writer
  confirmed deleted leaves orphaned litter, excluded from citation
  closure; any other lookup error leaves liveness unknown and defers
  (rather than passes) the citation evaluation, including any
  depth-0 promotion. If the writer is live and the walk ends at a
  confirmed-dead or absent parent (confirmed-dangling parent, detached
  session), the writer is operational depth 0: fully gated, owns its
  own artifact, cites its receipts in itself. Detached sessions (no
  `parentID`) are depth-0 of their own trees with full gate duties —
  not children owing nothing. This is a deeper read than the binary
  child/not-child check needs (which correctly stops at one hop);
  citation needs the chain while it resolves. Same primitive, deeper
  traversal.
- Dead subtrees owe nothing: no live writer with a living requester, no
  citation duty, no strand risk. A present file from a confirmed-deleted
  writer is litter, not a duty.
- The gate never judges review content. A gate that judges reviews is a
  gate that writes them — the Phase 40 role confusion in formal dress.
- Trust model, stated plainly: the gate trusts *delivery* (the file is
  present and cited); each requester vouches for the *quality* of what
  it requested; spot-checks happen at every requester–requestee edge
  instead of all at the top.

## Topology: where requester≈parent holds (verified against SDK types)

`SessionInfo.parentID?` is optional; `SessionCreateInput` accepts
caller-supplied `parentID`. Fork lineage is recorded separately: core
stores forks with `parent_id: null` and the source as `fork_session_id`,
and `SessionInfo` on a fork carries `fork.sessionID` instead of
`parentID` (probed live 2026-11-14). A fork copies a session at a
message boundary; it is not a subagent review request — so
`fork.sessionID` never acts as a requester or child-gate edge. Forks are
operational depth 0 by design, with full gate and artifact duties.

| Topology | `parentID` | Verdict |
|---|---|---|
| Task-spawned subagent | Set by core | Holds |
| API-created, honest caller | As supplied | Holds — see acceptance note |
| Shell-spawned `opencode run` (own process/server) | Absent | Own tree, full duties (dogfood pattern) |
| Forks | `parent_id: null`, source in `fork.sessionID` (probed) | Operational depth 0 by design; never a requester edge |
| Dead parent (deleted session) | Dangles; lookup throws | Confirmed deletion ends the walk (writer receipt excluded, live writer with confirmed-dead/absent terminus is operational depth 0); any other lookup error defers |
| Cross-directory child | Set (presumed) | Same-directory-only at build: cross-directory children use `report` receipts until discovery/ownership is designed |
| Sibling top-level sessions | Absent | Excluded at build: simultaneous same-directory depth-0 roots share one gate artifact, so keyed receipts scope to a single root tree until per-root ownership is designed |

Forks therefore keep the current-guard behavior permanently: they read
as top-level (gate fires, artifact writable). That state needs a
deliberate fork at a chosen message boundary — no shortcut path — so
it is the opposite of the Phase 40 failure.

## Layer boundary: core owns depth, we own duties

Core decides how deep trees may grow (`experimental.subagent_depth`,
creation validation); this plan decides duties within whatever tree
exists, and applies identically at depth 1 or depth 5. Enforcement and
attribution are inversely distributed: the tool path has both (core
cap plus core-set `parentID`), while the non-tool creation paths that
can nest at default config have neither (supplied or absent
parentage) — the tripwire watches precisely those paths. A plugin-side
depth policy would fight core's config rather than complement it (see
refused machinery).

## Acceptance: caller-supplied parentage needs no oracle

`parentID` is supplied at creation, and that is accepted outright —
there is no adversary here, only models that take shortcuts. Core
rejects creation with an unknown parent id, and an omitted `parentID`
creates a depth-0 root; there is no public `parentID` mutation, so
recovery from an existing-but-wrong parent is session recreation, not
re-pointing. No cross-check, no oracle, no residual. Recorded once,
here, so no future session relitigates it.

## Refused machinery (with revisit triggers)

- **Expectation tracker** (`childID → expected receipt` pre-declared
  for the gate to enforce): refused. It needs a staleness/timeout story
  for dead children or it strands the parent's gate — machinery needing
  an escape hatch. Revisit only on a real incident of uncertain delivery
  (two-strike rule); the citation-closure check covers the need today.
- **Content-judging gate**: refused constitutively, no revisit trigger.
- **Depth cap**: refused — core's duty, not ours. Core enforces
  `experimental.subagent_depth` (default 1) at the subagent tool; a
  plugin-side cap would fight core's config rather than complement it.
  No revisit trigger: if depth ever becomes a problem, that's core's
  knob. This plan covers duties at whatever depth exists, never how
  deep is too deep.
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
up"), the artifact-deny generalizes to the keyed pattern with a
narrow specialist exception (investigation-only roles stay
no-project-file-writes; permitted to write only their own keyed
scratch receipt when explicitly requested; the depth-0 gate artifact
stays forbidden), and freshness generalizes to citation closure. The
build also exposes the current session id via context injection (so a
writer can name its own file), provisions scratch-local ignoring in
target projects, excludes the receipt dir from changed-file/gate
inputs, scopes keyed receipts to same-directory, single-root trees
(cross-directory uses `report`; simultaneous same-directory roots
excluded until per-root ownership is designed), and treats a live
session with no living ancestor as operational depth 0. No new tracker,
no new gate verdict, no schema validation. Checklist entry only when a
build is approved.
