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
  warn-in-advisory per profile semantics. Edit tools checked by target
  path, shell tools by redirect/`tee` target scan
  (`extractRedirectTargets` in `protect.ts`); bare mentions stay allowed.
  Checked only for artifact targets: ordinary calls pay zero extra
  lookups; behavior for non-artifact calls is byte-identical.
- **Lookup hygiene.** `resolveIsChildSession` caches only successful
  resolutions; throws and unknown sessions return top-level uncached (a
  transient failure can never pin a session). `clearSessionDirectory`
  evicts the verdict with the other per-session state. Receiver-preserving
  `session.get` call (no detached `this`).
- **Shared wording.** One `childArtifactDenial()` in `harness.ts`,
  referenced from both layers. Artifact identity is one normalized
  `isReviewArtifact()` (absolute + `normalize`d relative spellings).
- **Fail closed to current behavior.** Missing `session.get` (older core),
  empty sessionID, or lookup throw → treated as top-level: gated,
  writable. An outage degrades to exactly today's behavior
  (deliberate: the skip is the new behavior, the fallback is the old one).
- **No other behavior changes.** Single file, shared duty set, shared
  tracker, no attribution, no `review.d/`, no GC, no migration, no config.
  Guards only ever deny children on exact artifact matches; top-level
  behavior is byte-identical.
- **Recorded, not built:** permission layer checks every edit resource
  (multi-resource hardening); advisory stays warn-only by design;
  pre-flight binds all editors including children (correct — it guards a
  different artifact); the static constitution text still names the duty
  for children but the deny message redirects them (mixed signal mitigated
  at the enforcement point, not the prose).

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

New `tests/child-sessions.test.ts` (17 tests): unit (child/top/missing/
throwing/empty-parent/cached/uncached-failure/eviction; artifact path
matching incl. `./`, absolute, non-canonical, rejections) plus
handler-level wiring (idle skip logged, no continuation; top-level still
gates with a single cached lookup; execute.before edit + shell-redirect
deny/allow matrix; permission.evaluate deny/allow matrix incl. shell and
multi-resource, with zero lookups for non-targets).
`tests/protect.test.ts` gains the redirect-scan matrix. Dogfood: both
reviewer roles ran clean on the live build post-restart (skip line in log,
no blocks, tree clean). Full matrix per AGENTS.md; commit locally, never
push.
