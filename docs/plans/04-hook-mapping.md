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

### Native `permission` config

**Purpose:** OpenCode's own permission model is the primary defense. The plugin
reads the host's effective `permission` config at load time and respects host
 denies: when OpenCode already denies a tool/target, the plugin skips its own
block to avoid redundant/conflicting denials.

**How:** The plugin does not rewrite `opencode.json` on disk and does not
contribute permissions at runtime. It applies guardrails in `tool.execute.before`
and uses `command-utils.ts` helpers for command parsing.

### `tool.execute.before`

**Purpose:** Secondary guardrail and clear error messaging.

**Block list:**

- `edit`, `write`, `patch` tools targeting protected paths.
- `bash` commands matching dangerous patterns (`git push`, destructive `rm`, etc.) when `protect_mode` is `deny`.

**Behavior:**

- `off` profile: do nothing.
- `advisory` profile: log a warning but do not throw.
- `standard`/`strict` profile: throw an error with a clear message to deny the tool call.
- If hook state cannot be resolved for a session, the hook fails closed (denies)
  rather than silently allowing the tool call.
- When the host permission model already denies the tool/target, the plugin
  skips its own block to avoid redundant/conflicting denials.

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

### `/df-verify`, `/df-profile`, `/df-status`, `/df-help` custom commands

**Purpose:** Let the user run the gate on demand, switch profile, inspect
plugin state, or list commands.

**Definition (v0.1.25 final — hybrid):** the four commands use two mechanisms,
and **none** feed text to the LLM:

- **`/df-status` and `/df-help`** are TUI commands registered by the companion
  module (`tui.tsx`, exported as `opencode-dev-framework/tui`) via
  `api.keymap.registerLayer` (with a legacy `api.command?.register` fallback, like
  DCP). Their `run` callbacks open a `DialogAlert` modal (status/help text). They
  are **not** registered as server prompt commands.
- **`/df-profile` and `/df-verify`** are registered as **server prompt commands**
  in the plugin's `config` hook with an empty `template`
  (`typedConfig.command["df-profile"] = { template: "" }`). The empty template
  makes OpenCode recognize `/df-profile standard` *with an argument* and route it
  to the server `command.execute.before` hook with `input.arguments`. The handler
  performs the action and **clears `output.parts`** (`output.parts.length = 0`) so
  the argument never reaches the model. This is the only mechanism that
  *guarantees* `command.execute.before` fires for the argument form.

```typescript
// server plugin — config hook
typedConfig.command["df-profile"] = { template: "", description: "Change the active dev-framework profile" };
typedConfig.command["df-verify"]  = { template: "", description: "Run the dev-framework completion gate" };

// server plugin — command.execute.before (fires for /df-profile and /df-verify, with or without args)
if (input.command === "df-profile") {
  const profile = (input.arguments ?? "").trim();
  if (!VALID_PROFILES.includes(profile)) { state.showToast?.("usage: /df-profile <off|advisory|standard|strict>", "warning"); }
  else { await changeProfile(state.directory, profile); state.showToast?.(`profile → ${profile}`, "success"); }
  output.parts.length = 0; // suppress the model turn
  return;
}
```

Shared logic lives in `src/commands.ts` (`changeProfile` and `verifyGate`) so the
server `command.execute.before` handler and the `dev_framework_set_profile` tool
reuse the same code path.

**Why not keymap-only?** Registering `df-profile`/`df-verify` via
`api.keymap.registerLayer` (even with a `slashName`) made OpenCode recognize them
*without* arguments (the no-arg palette `run` fired), but the **with-argument**
form did **not** route to `command.execute.before` — it fell through to the model
as plain chat. Reading the OpenCode binary's slash parser
(`let[x,...A]=P.slice(1).split(/\s+/); ... {name:x,args:A.join(" ").trim()}`)
confirmed a recognized command must be in the command registry the command
pipeline consults, which for the argument form is the server `config.command`
map, not a keymap layer. So the server prompt-command registration is required.

**`/df-status` and `/df-help` were the first to move to the TUI module**
(v0.1.22). The TUI module registers slash commands via
`api.keymap.registerLayer({ commands, bindings })` (the current OpenCode API) and
opens a `DialogAlert` modal with the status/help text. This matches how DCP shows
instant status: the output renders in a modal and is **never** inserted into the
chat stream, so it cannot be re-processed as a user turn.

**Update (v0.1.23):** the legacy `api.command` v1 API is deprecated and `undefined`
in current OpenCode runtimes, so the TUI module keeps it only as a fallback
(`api.command?.register`). It still registers primarily through
`api.keymap.registerLayer`, which is exactly what DCP uses. The earlier
`client.session.prompt` chat-message attempts (synthetic/ignored flags) were
abandoned in v0.1.22 because posting to the conversation always leaked into the
model context one way or another.

**Update (v0.1.24 → v0.1.25 corrected):** v0.1.24 registered the four commands as
`keymap` entries *without* `slashName`, so OpenCode only recognized them without
arguments (the bare `/df-profile` opened a picker, but `/df-profile standard`
leaked `standard` to the model). Adding `slashName` fixed bare-form recognition
but the with-argument form still did not route to `command.execute.before`. The
final v0.1.25 fix registers `df-profile`/`df-verify` as **server prompt commands**
(empty template) for reliable argument routing, and keeps `df-status`/`df-help` as
TUI modals. The shared `changeProfile`/`verifyGate` helpers in `src/commands.ts`
back the server `command.execute.before` handler and the `dev_framework_set_profile`
tool.

**Update (v0.1.23):** the TUI plugin is loaded from `tui.json`, **not**
`opencode.json`. OpenCode keeps server plugins (`opencode.json`) and TUI plugins
(`tui.json`) in separate config files. The `./tui` export is only consulted when
the package is listed in a TUI config. For the **published npm** package this is
automatic on OpenCode 1.18.18+ (the `./tui` companion is resolved from the
`opencode.json` npm entry, as DCP demonstrates). For **local filesystem paths**
used in development, add the repo path to both `opencode.json` (server) and a
`tui.json` (project `.opencode/tui.json` or global `~/.config/opencode/tui.json`).

**Update (v0.1.15):** migrated from markdown command templates (under
`templates/.opencode/commands/`) to plugin-registered, handler-backed slash
commands so the response is deterministic and does not depend on the LLM
choosing to call a tool.

## Anti-patterns to avoid

- Do not claim the gate unconditionally blocks completion. Document the bounded
  blocking via `experimental.session.stopping` and the advisory fallback on
  older OpenCode builds.
- Do not rewrite `opencode.json` automatically. Generate suggestions, not silent mutations.
- Do not run network-dependent commands during `file.edited` unless explicitly configured.
