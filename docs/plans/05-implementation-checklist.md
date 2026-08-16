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
  - `commands/`
  - `rules/`
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
  - Create `commands/df-verify.md`.
  - Optionally expose a custom tool `devFramework_verify`. (skipped — optional; see 08-notes.md)
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
    confirms the published tarball contains `dist/`, `commands/`, `rules/`,
    `README.md`, and `LICENSE`.
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
- [x] 11.2 `constitution` config key overrides bundled rules; `rules` appends.
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

## Notes for the implementer

- Do all tests first; use the stub host.
- Keep the plugin lightweight — avoid heavy runtime dependencies.
- If an OpenCode API is unclear, spike a minimal TypeScript file and test inside a real OpenCode session before committing to a design.
- Document any deviations from this plan in `docs/plans/08-notes.md`.
