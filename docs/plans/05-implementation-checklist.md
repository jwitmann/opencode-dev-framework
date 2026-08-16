# Implementation Checklist

Use this as the source of truth during implementation. Check items off as they are completed.

## Phase 1 — Project scaffold

- [x] 1.1 Initialize `package.json`
  - name: `opencode-dev-framework`
  - version: `0.0.1`
  - license: `MIT`
  - main: `dist/index.js`
  - types: `dist/index.d.ts`
  - files: `["dist", "commands", "rules"]`
  - scripts: `build`, `typecheck`, `test`, `lint`, `lint:fix`, `format:check`, `format:fix`, `lint:md`
- [x] 1.2 Add `.gitignore` (node_modules, dist, .DS_Store, *.log)
- [x] 1.3 Add `tsconfig.json` (target ES2022, strict, outDir dist, declaration true)
- [x] 1.4 Add `LICENSE` (MIT)
- [x] 1.5 Install dev dependencies
  - `typescript`
  - `@opencode-ai/plugin`
  - `yaml`
  - `zod`
  - `minimatch` or `picomatch`
  - `vitest` (test runner)
  - `@biomejs/biome` (formatter + linter)
  - `markdownlint-cli2` (Markdown linter)
- [x] 1.6 Add `biome.json` config
  - Enable formatter and linter.
  - Include `src/**/*.ts`, `tests/**/*.ts`.
  - Set indent and line width conventions.
- [x] 1.7 Add Markdown lint config (`.markdownlint.json` or `.markdownlint-cli2.jsonc`)
  - Disable rules that conflict with Prettier/Biome if needed.
- [x] 1.8 Create directory structure
  - `src/`
  - `bin/`
  - `rules/`
  - `templates/`
  - `tests/`
  - `examples/go-service/`
- [x] 1.9 Add GitHub Actions workflow `.github/workflows/ci.yml`
  - Use Node.js v22 (not Bun) because Bun is not available in this environment.
  - run lint
  - run lint:md
  - run tests
  - run build
  - publish to npm on tags starting with `v`
- [x] 1.10 Initial commit

## Phase 2 — Core config

- [x] 2.1 Define shared types in `src/types.ts`
  - `Profile`
  - `Config`
  - `ResolvedConfig`
  - `CommandMap`
  - `GateConfig`
- [x] 2.2 Implement `src/config.ts`
  - Find config file using precedence list.
  - Parse YAML or JSON.
  - Validate with Zod.
  - Implement `.dev-framework.yml` flat-key parser as fallback.
  - Resolve profile defaults.
  - Cache config per session.
- [x] 2.3 Unit tests for config loader
  - native YAML loads correctly
  - fallback `.dev-framework.yml` loads correctly
  - profile defaults applied
  - invalid config throws readable error
- [x] 2.4 Implement config-to-opencode generator in `src/config-to-opencode.ts`
  - Translate `protect` globs into OpenCode `permission` object.
  - Translate `commands.format` into OpenCode `formatter` object.
  - Return fragments as plain objects.
- [x] 2.5 Unit tests for generator
  - permission rules generated for protected paths
  - formatter rules generated per extension
  - `.dev-framework.yml` protect string split into array

## Phase 3 — Guardrails

- [x] 3.1 Implement `src/protect.ts`
  - Match tool name and args against protected paths.
  - Support `edit`, `write`, `patch`, `bash` tools.
  - Match globs with `minimatch`/`picomatch`.
  - Return `"allow" | "warn" | "deny"`.
- [x] 3.2 Implement `tool.execute.before` hook in `src/index.ts`
  - Use `protect.ts`.
  - `advisory` profile: log warning, allow.
  - `standard`/`strict`: throw clear error.
  - `off`: no-op.
- [x] 3.3 Unit tests for guardrails
  - edit to protected file denied in strict
  - edit to protected file warned in advisory
  - edit to allowed file passes
  - `git push` bash command denied

## Phase 4 — Edit-time lint

- [x] 4.1 Implement `src/lint.ts`
  - Resolve linter command for file extension.
  - Substitute `{file}`.
  - Run command via host adapter with timeout.
  - Return stdout, stderr, exit code.
- [x] 4.2 Implement `file.edited` hook in `src/index.ts`
  - Skip if `on_edit.lint` is false.
  - Skip if file matches `exclude`.
  - Run linter and log result.
  - In `strict`, throw on lint failure (configurable).
- [x] 4.3 Unit tests for lint
  - linter runs for changed `.go` file
  - no lint for excluded file
  - timeout respected
  - output captured

## Phase 5 — Completion gate

- [x] 5.1 Implement changed-file tracking
  - Track files edited during the session.
  - Provide `getChangedFiles()` and `clearChangedFiles()`.
- [x] 5.2 Implement `src/gate.ts`
  - Run typecheck, test, and lint-changed commands.
  - Handle `scope: changed` by substituting `{files}`.
  - Apply `timeout`.
  - Aggregate results.
- [x] 5.3 Implement `session.idle` hook in `src/index.ts`
  - Skip if `gate.skip_unchanged` and no changes.
  - Call gate.
  - On failure, emit loud structured log.
- [x] 5.4 Add `/df-verify` command
  - Original plan: create `commands/df-verify.md`. Later superseded by
    plugin-registered slash commands (Phase 17).
- [x] 5.5 Unit tests for gate
  - passes when all green
  - reports failure when test fails
  - skips when unchanged
  - scopes to changed files

## Phase 6 — Constitution injection

- [x] 6.1 Implement `src/rules.ts`
  - Discover rules files from config or defaults.
  - Read Markdown files.
  - Concatenate into a single context block.
- [x] 6.2 Implement `session.created` hook
  - If profile is not `off`, inject rules into session instructions.
  - The exact injection API must be validated against `@opencode-ai/plugin`.
  - Implemented via `experimental.chat.system.transform` (no `session.created`
    hook exists in the plugin API; see `docs/plans/08-notes.md`).
- [x] 6.3 Add default `rules/constitution.md`
  - Quality bar summary.
  - Test discipline.
  - Parking-lot discipline.
- [x] 6.4 Unit tests for rules loading
  - discovers default files
  - respects explicit `rules` list
  - returns empty when profile off

## Phase 7 — Host adapter

- [x] 7.1 Implement `src/host.ts`
  - Define `HostContext` interface.
  - Implement `OpenCodeHost` adapter mapping `ctx` to `HostContext`.
  - Implemented as injectable seams instead of a HostContext class:
    `RunCommand` (command execution) and `LogFn` (logging); `ctx.directory`
    is used directly. See `docs/plans/08-notes.md`.
- [x] 7.2 Unit tests with stub host
  - Use a fake `HostContext` for all non-integration tests.
  - All lint/gate/entry tests inject stub runners and loggers.

## Phase 8 — Integration and entry point

- [x] 8.1 Implement `src/index.ts`
  - Export single default plugin function.
  - Wire all hooks based on resolved profile.
- [x] 8.2 Ensure `off` profile registers no hooks.
- [x] 8.3 Build passes without type errors.

## Phase 9 — Documentation and examples

- [x] 9.0 Create `AGENTS.md`
  - Project purpose and conventions.
  - Build/test commands.
  - Important rules for agents working on this codebase.
- [x] 9.1 Write `README.md`
  - What it does.
  - Install instructions.
  - Config reference (link to `docs/plans/03-config-spec.md`).
  - Limitations (advisory gate).
  - Disclaimer.
- [x] 9.2 Create `examples/go-service/.opencode-dev-framework.yml`
  - Go build/test/lint commands.
  - Protected paths.
  - Gate config.
- [x] 9.3 Create `examples/go-service/README.md`
  - How to use the example.
- [x] 9.4 Update top-level `README.md` to be useful, not empty.

## Phase 10 — CI and publish

- [x] 10.1 Verify CI passes on every checklist item.
  - `.github/workflows/ci.yml` (Node 22) runs format, lint, lint:md,
    typecheck, test, and build; all pass locally. `npm pack --dry-run`
    confirms the published tarball contains `dist/`, `bin/`, `rules/`,
    `templates/`, `README.md`, and `LICENSE`.
- [x] 10.2 Add npm publish workflow secrets instructions to docs.
  - Covered by `docs/plans/07-publishing.md` (npm token + `NPM_TOKEN`
    GitHub secret).
- [x] 10.3 Bump version to `0.1.0`.
- [x] 10.4 Tag releases (done by user: `v0.1.0`…`v0.1.7`).
- [x] 10.5 Push to GitHub. (done by user)
- [x] 10.6 npm publish succeeds (initially manual; CI publish works since 0.1.5).
- [x] 10.7 Smoke test in a real OpenCode session — done in `~/finnomena` /
  `~/animeRSS`; surfaced and fixed the closure-capture crash (see 08-notes.md).

## Phase 11 — Dev-framework parity (v0.1.7)

- [x] 11.1 Split bundled constitution into numbered rule files
  (`rules/00-activation.md` … `40-delegation.md`), loaded sorted.
- [x] 11.2 `constitution` config key overrides bundled rules; `rules` replaces
  them by default or appends when given `mode: append`.
- [x] 11.3 Project templates in `templates/` (default config, `/df-verify` +
  `/df-profile` commands, agents: test-grounder / pattern-guardian /
  style-enforcer, skills: peer-review / ground-in-tests / match-patterns).
- [x] 11.4 `bin/df` CLI: `init` (interactive; `--skip-existing` /
  `--overwrite-existing`), `status`, `version`.
- [x] 11.5 Custom tools: `dev_framework_init`, `dev_framework_set_profile`
  (immediate in-session effect via hook-state registry in `src/registry.ts`).
- [x] 11.6 `experimental.session.stopping` gate hook (PR #41811) with
  `gate.max_blocks` synthetic keep-alive turns + `session.idle` fallback.
- [x] 11.7 Session-to-directory mapping via `experimental.chat.system.transform`.
- [x] 11.8 Tests for installer, tools, stopping hook (117/117 passing).
- [x] 11.9 README + plan docs updated.
- [x] 11.10 Bump version to `0.1.7`, tag `v0.1.7`.

## Phase 12 — Post-review fixes (v0.1.9)

- [x] 12.1 Load and append `config.rules` files in `loadConstitution`.
- [x] 12.2 Use session-directory mapping in `tool.execute.before` and
  `session.idle` hooks (instead of `activeDirectory` fallback).
- [x] 12.3 Reject conflicting `--skip-existing` / `--overwrite-existing` flags
  in `bin/df`.
- [x] 12.4 Correct README / architecture docs: plugin does not automatically
  inject formatter/permission fragments into OpenCode config.
- [x] 12.5 Bump version to `0.1.9`, tag `v0.1.9`.

## Phase 13 — `config.rules` explicit replace/append (v0.1.10)

- [x] 13.1 Change `rules` from implicit append to explicit replace/append:
  array form = replace; object form = `{ mode: "replace" | "append"; files: string[] }`.
- [x] 13.2 Update `src/types.ts`, `src/config.ts` schema/flat mapping/resolve,
  `src/rules.ts` loader, and tests.
- [x] 13.3 Update `03-config-spec.md`, `08-notes.md`, and this checklist.
- [x] 13.4 Bump version to `0.1.10` and tag.

## Phase 14 — Constitution/rules redesign (v0.1.11)

- [x] 14.1 Remove `constitution` config key from types/schema/loader.
- [x] 14.2 Auto-discover project `.opencode/opencode-dev-framework/rules/*.md`
  as a local override.
- [x] 14.3 Keep explicit `rules` config (`replace`/`append`).
- [x] 14.4 Implement `style_guide` injection.
- [x] 14.5 Add local rules directory to `templates/`.
- [x] 14.6 Update tests for local override and style guide.
- [x] 14.7 Update README, `03-config-spec.md`, `08-notes.md`, and this
  checklist.
- [x] 14.8 Bump version to `0.1.11`, tag.

## Phase 15 — Further parity additions (v0.1.12)

- [x] 15.1 Implement `df init` command auto-detection.
- [x] 15.2 Implement `df profile <profile>` CLI profile switching.
- [x] 15.3 Implement style-guide auto-discovery (`STYLE.md`,
  `docs/STYLE.md`, `CONTRIBUTING.md`, `docs/CONTRIBUTING.md`).
- [x] 15.4 Implement `precommit: auto` integration for per-file linting.
- [x] 15.5 Update `dev_framework_init` tool to write detected config.
- [x] 15.6 Update tests, README, `03-config-spec.md`, `08-notes.md`, and this
  checklist.
- [x] 15.7 Bump version to `0.1.12`, tag.

## Phase 16 — Status slash command + `dev_framework_status` tool (v0.1.14)

- [x] 16.1 Add `dev_framework_status` custom tool in `src/tools.ts`.
- [x] 16.2 Add `templates/.opencode/commands/df-status.md` slash command.
- [x] 16.3 Update README and plan docs (architecture, hook mapping, notes).
- [x] 16.4 Add tests for `dev_framework_status`.
- [x] 16.5 Bump version to `0.1.14` and tag.

## Phase 17 — Migrate slash commands to plugin-registered handlers (v0.1.15)

- [x] 17.1 Add `config` hook to register `/df-status`, `/df-profile`, and
  `/df-verify` slash commands in OpenCode's effective config.
- [x] 17.2 Add `command.execute.before` hook to handle those commands directly:
  read live in-memory state for `/df-status`, update config/state for
  `/df-profile`, run `runGate` for `/df-verify`.
- [x] 17.3 Extract `renderStatus` into `src/format-status.ts` and share it
  between the slash-command handler and `dev_framework_status` tool.
- [x] 17.4 Remove `templates/.opencode/commands/*.md` command templates.
- [x] 17.5 Update README, AGENTS.md, architecture, hook mapping, installer tests.
- [x] 17.6 Add tests for `config` and `command.execute.before` hooks.
- [x] 17.7 Bump version to `0.1.15` and tag.

## Phase 18 — Dead-code cleanup and hardening (v0.1.16)

- [x] 18.1 Fix `bin/df profile` `positional` reference-order bug.
- [x] 18.2 Remove dead `src/config-to-opencode.ts` generator code; move shared
  command parsing helpers to `src/command-utils.ts`.
- [x] 18.3 Consolidate `DEFAULT_PROTECT` constant (config.ts source of truth).
- [x] 18.4 Scrub stale `commands/` directory references from docs, README,
  checklists, and architecture snippets.
- [x] 18.5 Fix silent guardrail/gate no-ops: add `baseDirectory` fallback and
  `getStateForSession`; fail closed when hook state is missing.
- [x] 18.6 Harden `injectConstitution` to append to the last system entry and
  keep the prompt compact.
- [x] 18.7 Capture host permissions in the `config` hook and respect host-level
  denies in guardrail checks.
- [x] 18.8 Add `/df-help` slash command and unknown `/df-*` command response.
- [x] 18.9 Validate config on load; show TUI toast on parse error; add optional
  `OPENCODE_DEV_FRAMEWORK_LOG_FILE` debug logging.
- [x] 18.10 Post slash-command responses as ignored chat messages via
  `src/messenger.ts` so they are not re-processed as user input.
- [ ] 18.11 Run full validation suite, amend `v0.1.16`.

## Notes for the implementer

- Do all tests first; use the stub host.
- Keep the plugin lightweight — avoid heavy runtime dependencies.
- If an OpenCode API is unclear, spike a minimal TypeScript file and test inside a real OpenCode session before committing to a design.
- Document any deviations from this plan in `docs/plans/08-notes.md`.
