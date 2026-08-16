# Hook Mapping: dev-framework → OpenCode

## Overview

`anticomputer/dev-framework` is built on GitHub Copilot CLI's JSON hook manifest. OpenCode uses a JavaScript/TypeScript plugin model. The primitives do not map one-to-one. This document defines the mapping for the MVP.

## Primitive mapping table

| dev-framework primitive | Copilot CLI hook | OpenCode equivalent | Can block? | Notes |
|---|---|---|---|---|
| Constitution injection | `sessionStart` | `experimental.chat.system.transform` | N/A | Inject project rules into the system prompt; also maps sessionID → directory. |
| Protected-path guardrail | `preToolUse` | Native `permission` config + `tool.execute.before` | Yes (permission) / Yes (hook throw) | Native `permission` is the primary defense; plugin hook adds clearer messaging. |
| Format on edit | `postToolUse` | OpenCode native `formatter` config + `file.edited` | Indirectly | OpenCode's formatter runs automatically when enabled. Plugin supplements with project-specific commands. |
| Lint on edit | `postToolUse` | `file.edited` | No (advisory) | Run linter and feed output back. Can delegate to `pre-commit run --files`. |
| Completion gate | `agentStop` | `experimental.session.stopping` + `session.idle` | **Bounded** | PR #41811 adds a blocking hook; older builds fall back to loud `session.idle`. |
| Specialist agents | `agents/` subagents | OpenCode subagents / custom tools | N/A | Out of MVP scope. |
| Workflows / skills | `skills/` | Custom commands / custom tools | N/A | Out of MVP scope. |

## Detailed hook behavior

### `experimental.chat.system.transform`

**Purpose:** Inject constitution and project context, and map the session to its
project directory.

**Actions:**

1. Load resolved config.
2. If profile is `off`, do nothing.
3. Read `rules` files, local override directory, and any auto-discovered style guides.
4. Inject the concatenated rules into the system prompt.

### Native `permission` config (generated, not injected automatically)

**Purpose:** Suggest rules that block edits to protected paths and dangerous commands.

**How:** The plugin does not rewrite `opencode.json` on disk and does not contribute
permissions at runtime. It applies guardrails in `tool.execute.before`. Users can
use `config-to-opencode.ts` to generate suggested `permission` rules and copy
them into their `opencode.json` if desired.

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
6. If it fails, log the output. In `advisory`, continue; in `standard`, log an error; in `strict`, throw.

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

**Update (v0.1.7):** PR #41811 adds `experimental.session.stopping`, which fires
after the assistant turn is persisted but before the session goes idle. The
plugin registers this hook (via a local `HooksWithStopping` interface) and, on
gate failure in `standard`/`strict`, pushes a concise synthetic user message up
to `gate.max_blocks` times before standing down. `session.idle` remains the
fallback on older OpenCode versions.

### `/df-verify` custom command

**Purpose:** Let the user run the gate on demand.

**Definition:** `templates/.opencode/commands/df-verify.md` (copied into the
project by `df init` / `dev_framework_init`; OpenCode does not load slash
commands from plugin packages)

```markdown
---
description: Run the dev-framework completion gate manually
---
Run the completion gate for this project. Report test, type-check, and lint results. If anything fails, list the failures and suggest fixes.
```

The command body can invoke the plugin's custom tool (if we expose one) or simply prompt the agent to run the configured commands.

**Update (v0.1.7):** `templates/.opencode/commands/df-profile.md` provides
`/df-profile <profile>` as a prompt-based alternative to the
`dev_framework_set_profile` custom tool.

## Anti-patterns to avoid

- Do not claim the gate unconditionally blocks completion. Document the bounded
  blocking via `experimental.session.stopping` and the advisory fallback on
  older OpenCode builds.
- Do not rewrite `opencode.json` automatically. Generate suggestions, not silent mutations.
- Do not run network-dependent commands during `file.edited` unless explicitly configured.
