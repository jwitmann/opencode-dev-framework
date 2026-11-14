# Plan 23 — Child sessions never touch the parent review artifact (phase 1)

## Problem (2026-11-14, proven in production logs)

The completion gate fired inside reviewer subagent sessions
(`ses_e2814beffffecG28VvjRxpq7Z3` block 1/3, `ses_e2814befeffeW46Jyib9KtOfsD`
blocks 1–2/3) because duty state is directory-wide: the shared tracker plus
the `git status` union makes the parent's dirt the reviewer's duty. The gate
message then ordered the exact thing the reviewer role forbids ("run the
peer-review cadence... write review.md"). The code-reviewer obeyed the gate
over its role: edited `src/format-status.ts`, edited
`tests/runtime-status.test.ts`, committed `85808cb` — procedurally wrong
though content-correct.

## Decision: castrated phase 1 (this task)

Only two roles exist today in practice: the top-level orchestrator and its
children (only one parent possible per directory state). So the predicate is
parenthood, not agent role — with a single shared `review.md`, a role
predicate would let future worker children be gated onto the same file and
reintroduce the clobber race without keying to contain it. Blunt-but-sound
beats precise-but-racy until artifacts are keyed.

- **Gate skips children.** Both levers (idle hook, event net) return early
  for `parentID != null` with a debug log line. No verdict, no
  re-prompt, no stamp. Enforcement is not lost: the child's output lands
  in the shared tree/tracker and the parent answers for it at parent idle.
- **Children cannot write `review.md`.** Deny in `execute.before`
  (load-bearing backstop) + `permission.evaluate` (defense-in-depth),
  warn-in-advisory per profile semantics. Checked only for artifact
  targets: ordinary edits (including top-level review writes) pay zero
  extra lookups; behavior for non-artifact calls is byte-identical.
- **Fail closed to current behavior.** Missing `session.get` (older core),
  empty sessionID, or lookup throw → treated as top-level: gated, writable.
  An outage degrades to exactly today's behavior, loudly logged nowhere
  (deliberate: the skip is the new behavior, the fallback is the old one).
- **No other behavior changes.** Single file, shared duty set, shared
  tracker, no attribution, no `review.d/`, no GC, no migration, no config.

## Deferred: full subtree design (phase 2, on second strike)

Once orchestrator children exist (a subagent that owns a sub-component and
owes its own review), phase 1's "children never gated" becomes wrong for
worker branches. Then: gate by reviewer-role (reviewers skip, workers are
gated), attribute authorship per session subtree, key artifacts by
orchestrator session (`review.d/<sessionID>.md`), guard by ownership,
GC on `session.deleted` + TTL sweep. Triggers: first worker-child user or
first peer-top-level leakage confusion — the two-strike rule, not sooner.
Seams are in place: `resolveIsChildSession` (predicate),
`isReviewArtifact` (path), per-site wiring — phase 2 swaps their insides.

## Validation

New `tests/child-sessions.test.ts` (12 tests): unit (child/top/missing/
throwing/cached; artifact path matching incl. `./`, absolute, rejections)
plus handler-level wiring (idle skip logged, no continuation; top-level
still gates with a single cached lookup; execute.before deny/allow matrix;
permission.evaluate deny/allow matrix with zero lookups for non-targets).
Full matrix per AGENTS.md; commit locally, never push.
