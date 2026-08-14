# AGENTS.md — opencode-dev-framework

Context file for AI agents working on the `opencode-dev-framework` project.

## Project purpose

`opencode-dev-framework` is an OpenCode plugin that enforces project-specific quality gates during AI coding sessions. It is inspired by `anticomputer/dev-framework` but is an independent, OpenCode-native implementation.

The plugin provides:

- Constitution / rule injection at session start.
- Protected-path guardrails and dangerous-command blocking.
- Per-edit lint feedback.
- A completion gate (tests / type-check / lint) that runs when the session goes idle.

Because OpenCode has no `agentStop` hook, the completion gate is **advisory/loud**, not a hard block. This is a documented architectural limitation.

## Tech stack

- **Language:** TypeScript
- **Runtime target:** Bun (OpenCode uses Bun to load plugins)
- **Development runtime:** Node.js v22 + npm (Bun is not installed on this box)
- **Package manager:** npm for development; npm publishing
- **Build output:** `dist/`
- **Test runner:** vitest
- **Formatter & Linter:** Biome (dev dependency)
- **Markdown linter:** markdownlint-cli2
- **Plugin API:** `@opencode-ai/plugin`

## Linting and formatting

We enforce code style automatically. The exact tools are configured in `package.json`, but the interface is:

```bash
# Check formatting
npm run format:check

# Fix formatting
npm run format:fix

# Check TypeScript lint
npm run lint

# Fix TypeScript lint where auto-fixable
npm run lint:fix

# Check Markdown lint
npm run lint:md
```

Before finishing any change:

1. Run `npm run format:check`. If it fails, run `npm run format:fix`.
2. Run `npm run lint`. If it fails, fix the issues or run `npm run lint:fix` for auto-fixable issues.
3. Run `npm run lint:md` on any Markdown files you changed.
4. Re-run `npm run lint` and `npm run lint:md` to confirm everything is clean.
5. Do not suppress lint warnings without a comment explaining why.

If you add a new file, make sure it is covered by the `biome.json` `files.include` glob.

## Build / test / validate

Run these before finishing any change:

```bash
npm install
npm run format:check
npm run lint
npm run lint:md
npm run typecheck
npm run test
npm run build
```

OpenCode loads the plugin via Bun at runtime, but all development and CI on this box use npm/Node. Keep the code Bun-compatible: avoid Node-only APIs and prefer standard ESM imports.

## Conventions

- Keep the plugin lightweight. Avoid heavy runtime dependencies.
- Prefer explicit types. Use Zod for config validation.
- Use a stubbed `HostContext` in unit tests; do not shell out to real tools in tests.
- Match behavior across profiles (`off`, `advisory`, `standard`, `strict`) consistently.
- When in doubt, document the limitation in `docs/plans/08-notes.md`.

## Important rules

### Do

- Run `npm run test` after any code change.
- Run `npm run build` and verify `dist/` is produced.
- Update tests when adding or changing behavior.
- Update `docs/plans/05-implementation-checklist.md` when a task is done.
- Keep `README.md` accurate with install/config instructions.
- Prefer real YAML/JSON for `.opencode-dev-framework.yml`; support `.dev-framework.yml` only as a fallback.

### Don't

- Don't rewrite `opencode.json` automatically from the plugin.
- Don't claim the completion gate can physically block OpenCode from finishing — it cannot.
- Don't add heavy dependencies without discussing.
- Don't commit `dist/`, `node_modules/`, or lockfiles unless intentionally releasing.
- **Never push to remote.** Commit changes locally only. Pushing releases or changes is a deliberate user action, not an agent action.

## Project layout

```
opencode-dev-framework/
├── src/                    # Plugin source code
│   ├── index.ts            # Plugin entry point
│   ├── config.ts           # Config loader
│   ├── config-to-opencode.ts # OpenCode settings generator
│   ├── protect.ts          # Guardrail logic
│   ├── lint.ts             # Per-edit lint runner
│   ├── gate.ts             # Completion gate
│   ├── rules.ts            # Constitution injection
│   ├── host.ts             # Host abstraction
│   ├── logger.ts           # Structured logging
│   └── types.ts            # Shared types
├── commands/               # Custom OpenCode slash commands
│   └── df-verify.md        # /df-verify command
├── rules/                  # Default constitution/rules
│   └── constitution.md
├── tests/                  # Unit tests
├── examples/               # Example project configs
│   └── go-service/
├── docs/plans/             # Implementation plans
│   ├── 00-restart-brief.md
│   ├── 01-master-plan.md
│   ├── 02-architecture.md
│   ├── 03-config-spec.md
│   ├── 04-hook-mapping.md
│   ├── 05-implementation-checklist.md
│   ├── 06-testing-strategy.md
│   ├── 07-publishing.md
│   └── 08-notes.md
├── package.json
├── tsconfig.json
└── README.md
```

## Committing

- Commit work locally when a logical unit is complete and all validation passes.
- **Never push to remote.** The user controls when and if anything is published.
- Use clear, concise commit messages. Prefer present tense and describe what the change does.

Example:

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config loader with .dev-framework.yml fallback"
```

## Planning docs

The authoritative plan lives in `docs/plans/`. Start any new session with `docs/plans/00-restart-brief.md`, then read the relevant detailed doc for the area you are changing.

## Restart brief

If you are resuming work:

1. Read `docs/plans/00-restart-brief.md`.
2. Read `docs/plans/05-implementation-checklist.md` to see what is done.
3. Pick the next unchecked item.
4. Run `npm run test` frequently.
