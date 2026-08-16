# Master Plan

## Goal

Build and publish `opencode-dev-framework`, an OpenCode plugin that brings dev-framework-style enforcement to OpenCode sessions:

- **Constitution injection:** project-specific rules and style guides loaded at session start.
- **Protected-path guardrails:** block edits to sensitive files and dangerous commands.
- **Continuous enforcement:** format and lint files as they are edited.
- **Completion gate:** run tests / type-check / lint when the session goes idle and report failures loudly.

## Non-goals

- Do not implement an unconditional "agent cannot finish" block. OpenCode has no
  native `agentStop` hook; the `experimental.session.stopping` hook (PR #41811)
  can keep a session running up to `gate.max_blocks` times, then stands down.
- ~~Do not build a CLI launcher like `bin/df`.~~ **Superseded in v0.1.7+:** the
  user explicitly requested a `df` CLI. It now scaffolds templates (`init`),
  auto-detects project commands, switches profile (`profile`), reports status,
  and prints the version.
- Do not support Copilot/Claude/Codex in the MVP. Keep the internal design host-agnostic enough that future hosts could be added, but ship only OpenCode support now.

## Target users

Teams or individuals who:

- Use OpenCode for agentic coding.
- Want deterministic enforcement of project conventions (not just instructions in `AGENTS.md`).
- Want a failing test suite to be surfaced before the agent declares victory.

## Distribution

- npm package: `opencode-dev-framework`
- Users add it to their `opencode.json` plugin array:

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["opencode-dev-framework"]
  }
  ```

- OpenCode installs npm plugins automatically via Bun at startup.

## Success criteria

- [x] Plugin installs cleanly from npm and loads in OpenCode.
- [x] `.opencode-dev-framework.yml` configures the plugin.
- [x] `.dev-framework.yml` is read as a fallback for compatibility.
- [x] Protected-path edits are denied in `standard`/`strict` profiles.
- [x] Formatters and linters run on edited files.
- [x] Completion gate runs on `session.idle` and reports failures.
- [x] Blocking gate works via `experimental.session.stopping` on supported OpenCode builds.
- [x] Unit tests cover config loading, guardrails, gate logic, rules, lint, and installer.
- [x] CI runs tests on every PR and publishes to npm on tagged releases.

## High-level phases

### Phase 1 — Scaffold

Initialize npm/TypeScript project, CI, directory structure, and basic build/test pipeline.

### Phase 2 — Core plugin

Implement config loading, native OpenCode settings generation, guardrail hooks, per-edit lint hook, completion gate, and constitution injection.

### Phase 3 — Tests & docs

Write unit tests, README, config reference, working example, and a `/df-verify` custom command.

### Phase 4 — Publish

Bump version, tag, publish to npm, and verify end-to-end in a real OpenCode session.
