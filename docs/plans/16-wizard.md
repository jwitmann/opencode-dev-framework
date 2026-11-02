# Plan 16 — Agent-led init wizard

## Problem

`df init` guesses bare commands; every real project tested needed wrapper
correction. The trial-run flags bad guesses but its flags are homework
addressed to the user. The `project-config` skill resolves everything but
starts cold — re-deriving what detection already knew. Interaction, not
minutes, is the scarce resource: the product promise should be "run this,
come back to a diff, answer at most 3 questions."

## Decision

Agent-led handoff (not scripted CLI prompts): we are an LLM plugin, so the
session agent is the wizard's presenter. The machine side stays thin — a
brief of machine-generated hints — and the skill gains a consumer section
with an interaction budget.

## What ships

- `buildWizardBrief` / `formatWizardBrief` (`src/installer.ts`): detected
  language + guessed commands, trial-run results, `listMakefileTargets`
  (names only, capped 30, no semantics — the agent decides), shared
  `checkConfigEnforceable` verdict, open questions capped at 3 (wrappers
  first, then trial flags, then enforceability).
- `df init --wizard` (`bin/df`): scaffold + brief, single trial run (no
  double-run with the inline trial).
- `dev_framework_init` gains `wizard: true` (`src/index.ts`): brief
  appended to the tool result, so the in-session agent picks it up
  directly — this is the primary path, the CLI flag is the fallback.
- Skill `Wizard brief` section: brief is hints, re-run everything, target
  list is names-only, interaction budget (resolve all resolvable, ≤3
  user-only questions, review diff at the end, never interrogate mid-run).
- `configuration.md`: three paths (fast / wizard / thorough) with the
  advertised budget (~5 min, review-only ending).

## Non-goals

- Makefile-target-aware detection (still out of scope): the brief *lists*
  targets, it never maps them. Heuristic mapping stays with the agent.
- Scripted interactive prompts in `bin/df` (no TTY interviews, no new
  dependencies).
- New enforcement: the brief is report-only; profile stays the only knob.

## DoD

- [ ] Brief builder + formatter + target lister, tested (cap, ordering,
  unenforceable rendering, no-Makefile case).
- [ ] `--wizard` flag + `wizard: true` tool input wired, no double trial-run.
- [ ] Skill consumer section + interaction budget.
- [ ] `configuration.md` documents the three paths + budget.
- [ ] Full suite green; dogfood `--wizard` on a real copy; commit locally.
