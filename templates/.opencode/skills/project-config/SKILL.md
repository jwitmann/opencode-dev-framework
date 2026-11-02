---
name: project-config
description: >
  Draft an opencode-dev-framework configuration for the current project:
  read its build files and CI, map the real verification commands, and
  propose the yml plus a hardening draft for user review. Use when setting
  up the plugin on a new project instead of hand-writing the config.
---

# Project Configuration

Write the plugin config the project deserves — derived from its actual
build system, not guessed. You propose; the user disposes.

## When to use

Setting up the plugin on a project for the first time, instead of
hand-writing `.opencode-dev-framework.yml` or trusting `df init`
detection alone. Also when the existing config smells wrong — gate
passing vacuously, commands that don't match CI, a red tree nobody can
explain.

## Steps

1. **Read the build truth, in authority order.** CI workflow first (it is
   the tiebreaker when scripts disagree), then the build files for the
   project's ecosystem — `Makefile`, `package.json` scripts, `go.mod`
   toolchains, `pyproject.toml` / `tox.ini` / `noxfile.py`, `Cargo.toml`
   + `.cargo/config.toml`, `pom.xml` / `build.gradle(.kts)`, `Rakefile`,
   `composer.json` — then CONTRIBUTING and existing lint configs. You are
   looking for: the full verification command(s), per-language
   lint/format invocations, integration tests with special needs (docker,
   network, credentials), generated assets and how they rebuild, and
   paths that must never be edited.

2. **Prefer wrappers over bare tools.** If the project verifies via
   `make check`, `npm run verify`, or a CI job, the config's `commands`
   must invoke the wrapper — never reconstruct it from bare tool calls
   that skip steps. Note ordering traps (generated code must rebuild
   before typecheck; lint before test when the suite counts warnings).

3. **Place what doesn't fit unit scope in `gate.acceptance`.**
   Integration suites, contract tests, docs lint, vulnerability scans —
   each as a named acceptance check with its real command.

4. **Draft `hardening.md`** from what you observed, in the five sections
   from `docs/user/hardening.md`: the project way to build, full
   verification before done, fresh review cadence, scope discipline,
   executing plans under `/df-goal`. Exact commands and paths. No vague
   injunctions ("be thorough") — those get interpreted minimally.

5. **Self-check before presenting.** The draft must satisfy the
   enforceability bar: a blocking profile (`standard`/`strict`, i.e.
   `gate.block_on_failure: true`) and at least one real check
   (typecheck/test command, changed-file lint, non-empty
   `gate.acceptance`, or `gate.require_review`). A draft with none of
   these is vacuous — fix it, don't present it.

6. **Present the full diff for review. Never write without review, never
   commit.** The user owns the merge. Say plainly which commands you
   verified by running, which you inferred from files, and which need
   the user's confirmation.

## Output

+ The proposed `.opencode-dev-framework.yml` and `hardening.md` content
  as a reviewable diff, each command annotated verified-by-running,
  inferred-from-files, or needs-confirmation.
+ The enforceability self-check result (blocking profile + at least one
  real check, or the deficiencies fixed before presenting).

## What stays out

+ Secrets, tokens, internal URLs, customer names — the config and the
  hardening file are designed to be committable.
+ Anything the gate already enforces (don't restate the config inside
  the hardening file).
+ Auto-commit. The skill ends at the reviewed diff.
