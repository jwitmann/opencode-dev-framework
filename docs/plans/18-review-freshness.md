# Plan 18 — Review freshness (stale reviews fail the gate)

## Incident

Dogfood (`~/tvmRSS`, 2026-11-12): agent committed with a `review.md` written
for a *previous* task, no `dev_framework_verify` PASS in the transcript.
Self-reported and repaired (fresh review, real gate PASS), but only
self-reporting caught it — the gate's substance floors (plan 17 §3: 200
chars / 30 words, no template markers) pass a substantive review of the
wrong task. Known limitation, now with a specimen.

## Rule

A review that does not cover this session's changed files is not this
session's review — regardless of length. The gate fails it visibly with the
uncovered files named, in `standard`/`strict` (block) and `advisory`
(warn + pass, like `thin`).

This is reveal, not sanitize: a mismatched review is genuinely wrong, never
legitimate use, so no bypass or escape hatch is needed. Commit ordering
(review-before-commit) stays convention + gate pressure — the gate runs at
idle and cannot see commits happen; freshness shrinks the hole to ordering
only.

## Matching

- Pure function `findUncoveredFiles(content, files)` in `src/review.ts`:
  each changed file (repo-relative, `/`-normalized) must appear in the
  review text. Absolute paths in reviews contain the relative form, so both
  styles pass.
- Boundary-guarded substring (`(?<![\w-])` / `(?![\w-])`, escaped): a review
  mentioning `b-a.ts` does not cover changed `a.ts`; a review mentioning
  `a.tsx` does not cover `a.ts`.
- Case-sensitive (paths are, on Linux). No config knobs — "what counts as a
  review" stays a framework contract (plan 17 §3 precedent).

## Exclusions (harness-owned)

Coverage applies to files the session changed **except the plugin's own
bookkeeping**, which the agent did not author and should not have to eulogize:

- the review artifact itself (`REVIEW_ARTIFACT_REL` — always in the tracked
  set once written; self-reference would be absurd),
- the runtime snapshot (`RUNTIME_STATUS_DIR/RUNTIME_STATUS_FILE` — plugin-
  written every continuation; surfaces via git in repos that do not
  gitignore `.opencode/`).

`hardening.md`, config, and everything else the session touched stay covered.

## Wiring

- New `ReviewState`: `"stale"` (substance passed, coverage failed).
  `reviewMissing` stays true for it; summary chain gains a
  `staleReviewMessage` branch naming the uncovered files.
- Stuck signature `review:${reviewState}` distinguishes `stale` from `thin`
  automatically (a fresh-but-thin rewrite resets the streak, as today).
- Pass-cache fingerprint already covers review content: rewriting the review
  misses the cache and re-runs. No change needed.
- Advisory mirrors `thin` exactly (loud warn, pass). No new profile logic.

## Tests (`tests/review.test.ts`)

- Unit: covered via relative path, via absolute path, uncovered file
  reported, `b-a.ts` ≠ `a.ts`, `a.tsx` ≠ `a.ts`.
- Gate: stale review (wrong task's files) blocks with reason `review` and
  names the missing file; review artifact itself in the changed set needs
  no self-mention; absolute-path review passes; advisory warns + passes.
- Existing `REVIEW_BODY` (mentions `src/a.ts`, tracker `src/a.ts`) keeps
  passing unchanged.

## Docs

- `docs/user/hardening.md` §3: freshness is now gate-enforced, not just
  asked — one clause.
- Nothing else: `commands.md`/`configuration.md` describe `require_review`
  as a duty; the duty is unchanged, only its checking got honest.

## Validation

`format:check`, `lint`, `lint:md`, `typecheck`, `test`, `build` per AGENTS.md;
peer-review pass before done; commit locally, never push.
