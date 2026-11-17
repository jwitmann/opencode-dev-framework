# Example-service Hardening (appended after the bundled constitution)

This project hardens beyond the completion gate. The gate runs
`npx tsc --noEmit` plus `npm test` (unit only) and changed-file lint. That
is the backstop, not the full check. Before declaring any non-trivial task
done, do the following without being asked.

## Build the example-service way

- Use `npm run build` or `npm run test:unit`, never bare `tsc` or
  `node --test`. The build regenerates `dist/` from `src/` plus the
  OpenAPI client (`npm run codegen`); a stale `src/client/generated/`
  compiles fine and fails only at runtime with a confusing shape mismatch.
- After EVERY `openapi.yaml` edit: run `npm run codegen`, then
  `npm run build`.
- Never hand-edit `dist/**` or `src/client/generated/**`. Edit the source
  and rebuild.
- Protected paths (`.env*`, `dist/**`, `config/production.json`) deny
  edits. That denial is correct. Work around it with `npm run`, do not
  weaken it.

## Full verification before done

- Run `npm run check` for the full pass: typecheck, unit tests, `eslint`,
  and `prettier --check`.
- For changes touching `src/queue/`, also run `npm run test:integration`
  (needs docker; skip only for docs-only changes and say so).
- For Markdown docs, run `npx markdownlint-cli2 "docs/**/*.md"`. This is
  separate from the unit suite.
- A PASS before your last edit is stale. Re-run on the final tree.
- Docs-only changes do not need a test re-run.

## Fresh review every task

- Rewrite `.opencode/opencode-dev-framework/review.md` for THIS task's
  changed files. A file left from a previous task never counts.
- Default cadence: style pass on changed files, then evidence (a test that
  fails without the change and passes with it, commands actually observed
  passing), then correctness and pattern review. Use reviewer agents
  proportionally to the change; resolve every blocking finding or state
  precisely why it does not apply.
- Investigation-only reviewers never edit product code.

## Scope discipline

- Implement the written plan verbatim. Check every requirement before
  finishing and fix gaps rather than declaring success.
- Park unrelated findings in `docs/NOTES.md` as one line each under a dated
  heading. Do not expand scope. Report parked entries in the final summary,
  or state explicitly that none were parked.
- Commit locally when done. Never push.

## Execute plans under `/df-goal`

- When the user hands you a written plan, execute it as
  `/df-goal <objective>` — the objective is the plan inline when short, or
  `Implement the plan in <path>` when long — so native completion requires
  the framework gate's PASS, not just your summary.
- The gate's `dev_framework_verify` FAIL is a verdict, not advice: fix the
  underlying cause and re-verify. Never declare the plan met without a
  tool-result PASS in the transcript.
