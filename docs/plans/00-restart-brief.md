# Restart Brief

Use this file to get back up to speed in a new session.

## Project identity

- **Name:** `opencode-dev-framework`
- **Local path:** `~/opencode-dev-framework`
- **GitHub repo:** `github.com/<user>/opencode-dev-framework` (push the local repo when ready)
- **npm package:** `opencode-dev-framework`
- **License:** MIT
- **Inspiration:** `anticomputer/dev-framework` (GitHub Copilot CLI plugin). This is an independent, OpenCode-native implementation.

## What this project does

It is an OpenCode plugin that enforces a project-specific quality bar on AI coding sessions:

- Injects constitution/rules into context (bundled, local override, or explicit `rules`).
- Guards protected paths and dangerous commands.
- Formats and lints edited files, with optional `pre-commit` delegation.
- Runs a completion gate (tests / type-check / lint) when the session goes idle.

On OpenCode builds with PR #41811, the gate blocks finishing via
`experimental.session.stopping` up to `gate.max_blocks` times. On older builds,
without that hook, the gate is **advisory/loud**, not a hard physical block.

## Key decisions already made

1. OpenCode-only scope, but keep internal host abstraction light so future hosts are possible.
2. Primary config: `.opencode-dev-framework.yml`.
3. Fallback config: `.dev-framework.yml` (for migration/compatibility with the original).
4. Plugin distributed as an npm package installed via `opencode.json`.
5. No upstream PR to dev-framework; we reference it as inspiration only.

## Where to start next session

Read this file, then open:

1. `01-master-plan.md` for goals and scope.
2. `03-config-spec.md` for the config schema.
3. `05-implementation-checklist.md` for the task list.
4. `02-architecture.md` for the technical design.

Then run the next unchecked checklist item (or continue the current phase).

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
