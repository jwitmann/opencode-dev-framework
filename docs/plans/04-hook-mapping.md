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
denies: when OpenCode already denies a tool, the plugin skips its own block to
avoid redundant/conflicting denials.

**Shape:** OpenCode's `permission` is a per-agent, tool-to-mode object (e.g.
`{ edit: "deny", bash: "deny", read: "allow", task: { ... } }`), **not an
array**. The plugin maps its own tool names onto OpenCode's keys — `edit`,
`write`, `patch` map to `edit`, and `bash`, `shell` map to `bash` — and stands
down only when that key's mode is the literal `"deny"`. OpenCode's model cannot
express path-scoped rules (e.g. "deny writes to `.env`"), so the plugin keeps
guarding those itself. Object-form `bash` maps and `ask`/`allow` modes are not
treated as denials.

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
- When the host permission model already denies the tool (OpenCode `permission`
   mode `"deny"` for `edit`/`bash`), the plugin skips its own block to avoid
   redundant/conflicting denials.

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

**Definition (v0.1.25 final — TUI-only):** every `/df-*` command is a **TUI
command** registered by the companion module (`tui.tsx`, exported as
`opencode-dev-framework/tui`) via `api.keymap.registerLayer` with a `slashName`
(and a legacy `api.command?.register` fallback, like DCP). TUI commands are
UI-only — they never insert text into the chat stream, so they cannot leak into a
model turn. The `run(ctx)` callback does all the work:

- `df-status` / `df-help` → `run` opens a `DialogAlert` modal (status / help).
- `df-profile` → `run` calls `handleProfile(api, dir, ctx?.input)`:
  - OpenCode passes the command **name** (`"df-profile"`) as `ctx.input` for the
    bare command. That is normalized to the "bare" case, which opens a
    `DialogSelect` picker (off / advisory / standard / strict); selecting one
    calls `changeProfile` + toast.
  - If a build ever passes a real profile string as `ctx.input`, it is applied
    directly (`changeProfile`) when valid; otherwise a usage toast is shown.
- `df-verify` → `run` calls `handleVerify(api, dir)` which runs `verifyGate` and
  shows a `DialogAlert` + toast.

```typescript
// tui.tsx — all four registered as keymap commands with slashName
keymap.registerLayer({
  commands: [
    { name: "df-status",  slashName: "df-status",  run: () => showStatusDialog(api, dir) },
    { name: "df-help",    slashName: "df-help",    run: () => showHelpDialog(api) },
    { name: "df-profile", slashName: "df-profile", run: (ctx) => handleProfile(api, dir, ctx?.input) },
    { name: "df-verify",  slashName: "df-verify",  run: () => handleVerify(api, dir) },
  ].map((c) => ({ namespace: "palette", ...c, title: c.name, desc: c.name, category: "dev-framework" })),
});
```

Shared logic lives in `src/commands.ts` (`changeProfile` and `verifyGate`) so the
TUI `run` callbacks and the `dev_framework_set_profile` tool reuse the same code
path.

**Argument form (`/df-profile standard`) is intentionally NOT supported.**
In the current OpenCode runtime (v1.18.18) a command typed *with* an argument is
routed to a model turn and never reaches the TUI `run` callback. We confirmed a
`command.execute.before` server hook also fires a model turn for these TUI
commands (clearing `output.parts` does not suppress it), and server *prompt*
commands (`config.command`) likewise always produce a model turn. Per user
preference (m0106) the plugin is **TUI-only**: run the bare `/df-profile` and pick
from the dialog. The `command.execute.before` handler and any `config.command`
registration for these commands were removed — they could not prevent the leak and
are dead code.

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

**Update (v0.1.24 → v0.1.25 corrected):** earlier attempts tried (a) keymap
entries *without* `slashName` (only the bare command worked; `/df-profile
standard` leaked `standard` to the model), and (b) a `command.execute.before`
hook to suppress the argument form (could not suppress the model turn for a TUI
command). The final v0.1.25 decision is **TUI-only**: all four are TUI commands
whose `run(ctx)` does the work via the picker / dialog, and the argument form is
explicitly unsupported. The shared `changeProfile`/`verifyGate` helpers in
`src/commands.ts` back the TUI `run` callbacks and the `dev_framework_set_profile`
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
