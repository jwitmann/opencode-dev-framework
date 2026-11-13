# Plan 19 — Template updates (`/df-update`)

## Incident

`~/animeRSS` loop (2026-11-12): reviewer self-escalation + full-cadence
re-runs, fixed in `61b9772`. Refreshing the five dogfood deployments
afterwards showed the second gap: shipped `templates/` drift (two skill
files since v1.6.0) with no surgical update path. `df init` skips
differing files (never clobber) or `--overwrite-existing` clobbers all
of them (destroys project customizations). The only mechanism was manual
diff-then-copy.

## Scope (deliberately minimal)

Cover today's problem, nothing more: a way to bring a deployment's
shipped files current with per-file approval. No startup auto-check, no
roster/status integration, no CLI, no hash manifest, no auto-apply.

## Rule

- Detection in code, judgment with the agent: the command classifies
  (`statusTemplates` — reuse, no new comparison), the agent diffs,
  presents per file, and applies only what the user approves.
- Never silent, never wholesale: no auto-apply path exists by
  construction (unlike `--overwrite-existing`).
- The yml is structurally out of scope: `listTemplateFiles` never
  contained `.opencode-dev-framework.yml`, so the updater cannot touch
  user config.
- Missing shipped files are offered for adding (absence reads as
  botched/partial install — observed in three deployments). A tree with
  nothing installed redirects to `/df-init` instead of piecemeal add.

## Wiring

- New `src/update.ts`: `checkTemplateUpdates` (classify via
  `statusTemplates`), `composeUpdatePrompt` (report + standing
  instructions), `runUpdateCommand` (liveness guard, delivery
  passthrough, recoverable delivery-failure error — same shape as
  `runInitCommand`, minus the config reload which templates don't need).
- New server-side `/df-update` registration beside `/df-init` (same
  defensive pattern: try/catch, race guard). Help line in `renderHelp`.
- Tests in `tests/update.test.ts`: classification (current / refresh /
  add-missing / empty-tree redirect), prompt carries approval rules and
  the yml exclusion, command core (delivery passthrough, stale refusal,
  delivery-failure recovery).
- Docs: one `commands.md` entry. README untouched (quickstart settled).

## Validation

`format:check`, `lint`, `lint:md`, `typecheck`, `test`, `build` per AGENTS.md;
peer-review pass before done; commit locally, never push.
