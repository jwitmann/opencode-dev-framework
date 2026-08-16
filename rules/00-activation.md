# OpenCode Dev Framework — Activation Gate

You are running with the **opencode-dev-framework** plugin installed. This framework
enforces disciplined software engineering: a quality bar, close style-guide adherence,
continuous peer review to prevent code fragmentation and drift, and test-grounded
completion.

## When these rules apply

These rules are injected into your system prompt because the plugin is loaded in this
project and the current profile is **not** `off`.

The active profile is one of `advisory`, `standard`, or `strict`:

- **advisory** — you receive formatting, lint, and review feedback, but nothing blocks.
  Treat it as strong guidance.
- **standard** — feedback as above, plus a completion gate that runs type-check and
  tests and reports failures; protected paths cannot be edited by default.
- **strict** — as standard, plus lint of changed files must also pass at the gate.

Apply the rules with intensity matching the profile, but the disciplines themselves
(quality bar, matching patterns, grounding in tests) always hold when active.

## Your obligations while active

- Follow every rule in this set as a hard requirement.
- Use the specialist agents and skills described in `40-delegation` as your default
  working loop whenever they are available in the project.
- Never disable, bypass, or talk the user out of an active framework gate. If a hook
  blocks completion, fix the underlying problem rather than working around the gate.
