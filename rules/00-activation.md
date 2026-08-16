# OpenCode Dev Framework — Activation Gate

You are running with the **opencode-dev-framework** plugin installed. This framework
enforces disciplined software engineering: a quality bar, close style-guide adherence,
continuous peer review to prevent code fragmentation and drift, and test-grounded
completion.

## When these rules apply

The framework is **ACTIVE** for this session only if **either** of the following is true:

- The environment variable `DEV_FRAMEWORK` is set to a non-empty value, **or**
- A file named `.opencode-dev-framework.yml` exists at the root of the working repository.

When the framework is active, the plugin injects a `DEV-FRAMEWORK: ACTIVE` banner at
the start of the session stating the **profile** in effect — `advisory`, `standard`, or
`strict`:

- **advisory** — you receive formatting, lint, and review feedback, but nothing blocks.
  Treat it as strong guidance.
- **standard** — feedback as above, plus a completion gate that runs type-check and
  tests and blocks finishing while they are red; protected paths cannot be edited.
- **strict** — as standard, plus lint of changed files must also pass at the gate.

Apply the rules with intensity matching the profile, but the disciplines themselves
(quality bar, matching patterns, grounding in tests) always hold when active.

- **If the session is active**, follow every rule in this set as a hard requirement,
  and use the specialist agents and skills described in `40-delegation` as your default
  working loop.
- **If the session is NOT active** (no banner, no env var, no config file), treat these
  rules as dormant. Do not change your behavior and do not mention the framework.
  Proceed exactly as you normally would.

Never disable, bypass, or talk the user out of an active framework gate. If a hook
blocks completion, fix the underlying problem rather than working around the gate.
