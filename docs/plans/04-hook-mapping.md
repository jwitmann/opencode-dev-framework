# Hook Mapping: dev-framework → OpenCode

## Overview

`anticomputer/dev-framework` is built on GitHub Copilot CLI's JSON hook manifest. OpenCode uses a JavaScript/TypeScript plugin model. The primitives do not map one-to-one. This document defines the mapping for the MVP.

## Primitive mapping table

| dev-framework primitive | Copilot CLI hook | OpenCode equivalent | Can block? | Notes |
|---|---|---|---|---|
| Constitution injection | `sessionStart` | `session.created` + OpenCode `rules`/`instructions` | N/A | Inject project rules into context. |
| Protected-path guardrail | `preToolUse` | Native `permission` config + `tool.execute.before` | Yes (permission) / Yes (hook throw) | Native `permission` is the primary defense; plugin hook adds clearer messaging. |
| Format on edit | `postToolUse` | OpenCode native `formatter` config + `file.edited` | Indirectly | OpenCode's formatter runs automatically when enabled. Plugin supplements with project-specific commands. |
| Lint on edit | `postToolUse` | `file.edited` / `tool.execute.after` | No (advisory) | Run linter and feed output back. |
| Completion gate | `agentStop` | `session.idle` + `/df-verify` command | **No** | This is the biggest gap. OpenCode fires `session.idle` after the agent goes idle. We can only report failure loudly. |
| Specialist agents | `agents/` subagents | OpenCode subagents / custom tools | N/A | Out of MVP scope. |
| Workflows / skills | `skills/` | Custom commands / custom tools | N/A | Out of MVP scope. |

## Detailed hook behavior

### `session.created`

**Purpose:** Inject constitution and project context.

**Actions:**

1. Load resolved config.
2. If profile is `off`, do nothing.
3. Read `rules` files and any auto-discovered style guides.
4. Inject a summary into session instructions via `client.instructions` or a lightweight system message. The exact API must be validated against `@opencode-ai/plugin`.

### Native `permission` config (generated)

**Purpose:** Block edits to protected paths and dangerous commands.

**How:** The plugin does not rewrite `opencode.json` on disk. Instead, it dynamically contributes permission rules by registering as an OpenCode plugin. If OpenCode does not allow dynamic permission contributions from plugins, we rely entirely on the `tool.execute.before` hook and document that users should manually add generated `permission` rules to their `opencode.json`.

**Investigation required:** confirm whether a plugin can contribute `permission`/`formatter`/`rules` fragments at runtime, or whether it can only enforce them in hooks. Document the answer here.

### `tool.execute.before`

**Purpose:** Secondary guardrail and clear error messaging.

**Block list:**

- `edit`, `write`, `patch` tools targeting protected paths.
- `bash` commands matching dangerous patterns (`git push`, destructive `rm`, etc.) when `protect_mode` is `deny`.

**Behavior:**

- `off` profile: do nothing.
- `advisory` profile: log a warning but do not throw.
- `standard`/`strict` profile: throw an error with a clear message to deny the tool call.

### `file.edited`

**Purpose:** Run lint on the edited file.

**Actions:**

1. Determine the file path.
2. Skip if file matches `exclude` globs.
3. Resolve per-extension linter from `commands.lint.<ext>` or `commands.lint`.
4. Substitute `{file}`.
5. Run the command with timeout.
6. If it fails, log the output. In `advisory`, continue; in `standard`/`strict`, optionally throw depending on policy.

### `tool.execute.after`

**Purpose:** Observe tool results and collect changed files for the gate.

**Actions:**

1. Track edited files in session state.
2. If the tool was a formatter, note that formatting was applied.

### `session.idle`

**Purpose:** Run the completion gate.

**Actions:**

1. Collect changed files.
2. If `gate.skip_unchanged` and no changes, skip.
3. Run typecheck (if `gate.run_typecheck`).
4. Run tests (if `gate.run_tests`), scoped to changed files if `gate.scope === "changed"`.
5. Run lint on changed files if `gate.lint_changed`.
6. If any step fails, emit a structured, high-visibility log entry and append a message telling the user/agent that the gate failed.

**Limitation:** By the time `session.idle` fires, the agent has already finished its turn. We cannot force it to continue. The best we can do is make the failure impossible to miss.

### `/df-verify` custom command

**Purpose:** Let the user run the gate on demand.

**Definition:** `commands/df-verify.md`

```markdown
---
description: Run the dev-framework completion gate manually
---
Run the completion gate for this project. Report test, type-check, and lint results. If anything fails, list the failures and suggest fixes.
```

The command body can invoke the plugin's custom tool (if we expose one) or simply prompt the agent to run the configured commands.

## Anti-patterns to avoid

- Do not try to fake a blocking completion gate. Document the advisory behavior.
- Do not rewrite `opencode.json` automatically. Generate suggestions, not silent mutations.
- Do not run network-dependent commands during `file.edited` unless explicitly configured.
