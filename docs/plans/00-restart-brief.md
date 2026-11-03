# Restart Brief

Use this file to get back up to speed in a new session.

## Project identity

- **Name:** `opencode-dev-framework`
- **Local path:** `~/opencode-dev-framework`
- **GitHub repo:** `github.com/jwitmann/opencode-dev-framework` (push the local repo when ready)
- **npm package:** `opencode-dev-framework`
- **License:** MIT
- **Inspiration:** `anticomputer/dev-framework` (GitHub Copilot CLI plugin). This is an independent, OpenCode-native implementation.

## What this project does

It is an OpenCode plugin that enforces a project-specific quality bar on AI coding sessions:

- Injects constitution/rules into context (bundled, local override, or explicit `rules`).
- Guards protected paths and dangerous commands.
- Formats and lints edited files, with optional `pre-commit` delegation.
- Runs a completion gate (tests / type-check / lint) when the session goes idle.
- Wraps whole tasks as verified goals (`/df-goal`) with a tool-result
  evidence contract.

The gate continues the turn via `synthetic` at the would-go-idle boundary
(`session.hook("experimental.idle")`, same execution) up to
`gate.max_blocks` times, with an `event.subscribe` idle net for the
boundaries the hook skips; it is a bounded continuation, not a veto.
Deleted tracked files never fail it (lint skips ghosts, typecheck still
runs — a deletion can break dependents).

## Key decisions already made

1. OpenCode-only scope, but keep internal host abstraction light so future hosts are possible.
2. Primary config: `.opencode-dev-framework.yml`.
3. Fallback config: `.dev-framework.yml` (for migration/compatibility with the original).
4. Plugin distributed as an npm package installed via `opencode.json`.
5. No upstream PR to dev-framework; we reference it as inspiration only.

## Where to start next session

The implementation plan is complete (all checklist items done through
Phase 32; `v1.5.0` on npm). There is no next unchecked item. Instead:

1. Read `05-implementation-checklist.md` for state and `08-notes.md`
   for tripwires (pre-stop veto, plugin skill hooks, Effect-first
   landing) — next work starts when the user directs it or a tripwire
   fires, not from the list.
2. `01-master-plan.md` for goals and scope.
3. `03-config-spec.md` for the config schema.
4. `02-architecture.md` for the technical design.

## Mandatory validation before any commit

- `npm run format:check` (fix with `format:fix`), `npm run lint`,
  `npm run lint:md`, `npm run typecheck`, `npm run test`,
  `npm run build` with `dist/` produced — or just
  `./scripts/release.sh [patch|minor|major]`, which runs the matrix.

## Mandatory validation before any release

- `npm test` passes.
- `npm run lint` passes.
- `npm run build` produces `dist/`.
- GitHub Actions CI passes on the PR.
- npm token `NPM_TOKEN` is configured as a GitHub Actions secret.

## Contacts / references

- OpenCode plugin docs: <https://opencode.ai/docs/plugins>
- OpenCode permissions docs: <https://opencode.ai/docs/permissions>
- OpenCode formatters docs: <https://opencode.ai/docs/formatters>
- Original inspiration: <https://github.com/anticomputer/dev-framework>
