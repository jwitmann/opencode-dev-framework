# Hook Mapping: dev-framework → OpenCode V2

## Overview

`anticomputer/dev-framework` is built on GitHub Copilot CLI's JSON hook manifest. OpenCode V2 uses `Plugin.define` with `Context` domains. This document maps V2 equivalents.

## Primitive mapping table

| dev-framework primitive | Copilot CLI hook | OpenCode V2 equivalent | Can block? | Notes |
|---|---|---|---|---|
| Constitution injection | `sessionStart` | `session.hook("context")` (`system: SystemPart[]`) | N/A | Per model request; no session mapping (ctx.location). |
| Protected-path guardrail | `preToolUse` | `tool.hook("execute.before")` | Yes (throw) | Always check; V2 no host permission snapshot. |
| Format on edit | `postToolUse` | `formatter` + `event.subscribe` on `filesystem.changed` | Indirectly | Formatter auto-runs; plugin supplements. |
| Lint on edit | `postToolUse` | `event.subscribe` on `filesystem.changed` | No | Run linter; can delegate to `pre-commit`. |
| Completion gate | `agentStop` | `event.subscribe` on `session.idle`/`session.status:idle` → `session.prompt` | **Async bounded** (`gate.max_blocks`) | V2 re-prompts, no `session.stopping` veto. |
| Specialist agents | `agents/` | OpenCode subagents / `tool.transform` | N/A | Out of scope. |
| Workflows / skills | `skills/` | `command.transform` / `tool.transform` / `tui.tsx` | N/A | Out of scope. |

## Detailed hook behavior

### `session.hook("context")` (was `experimental.chat.system.transform`)

**Purpose:** Inject constitution per model request.

**Actions:**
1. `reloadConfigIfChanged` via `stat` mtime.
2. If `off`, no-op.
3. `loadConstitution` (bundled/local/`rules`/`style_guide`).
4. `event.system.push({type:"text", text:constitution})` if not present (also `generate`/`compaction`).

### `tool.hook("execute.before")`

**Purpose:** Guardrail.

**Block list:** `edit`/`write`/`patch` on protected paths; `bash` dangerous commands.

**Behavior:** `off`→allow, `advisory`→warn, `standard`/`strict`→throw `[opencode-dev-framework] ...`. No host permission short-circuit in V2.

### `filesystem.changed` via `event.subscribe` (was `file.edited`)

**Purpose:** Track changed files + per-edit lint.

**Actions:** `event.data.file` → `tracker.add`, `lintFile` with `precommit` auto-detect, `strict` throws. `exclude` handled in `lintFile`.

### `session.idle` / `session.status:idle` via `event.subscribe` (V2 gate)

**Purpose:** Completion gate.

**Actions:** `runGate` on `changedFiles`, `clearChangedFiles`, `summarizeGate`, `block_on_failure`→`error` else `warn`. On failure inside `max_blocks`, `session.prompt({sessionID, text: stoppingMessage})` (async, plugin-owned, no core 3-cap). After `max_blocks` warn + stand down.

**V1 `session.stopping` removed in V2.**

### TUI slash commands `/df-verify`, `/df-profile`, `/df-status`, `/df-help`

**V2 definition:** `tui.tsx` `Plugin.define` via `@opencode/plugin/tui`:

```ts
// tui.tsx — V2
export default Plugin.define({
  id: "opencode-dev-framework",
  setup(ctx) {
    ctx.ui.slot({
      append: "app",
      render() {
        ctx.keymap.layer(() => ({
          commands: [
            { id:"df-status", slash:{name:"df-status"}, run: () => ctx.ui.dialog.alert({...}) },
            { id:"df-help", slash:{name:"df-help"}, run: () => ctx.ui.dialog.alert({...}) },
            { id:"df-profile", slash:{name:"df-profile", arguments:true}, run: (input) => handleProfile(ctx,input) },
            { id:"df-verify", slash:{name:"df-verify"}, run: () => handleVerify(ctx) },
          ]
        }));
        return null;
      }
    });
  }
});
```

* `df-status`/`df-help` → `dialog.alert` modal.
* `df-profile` bare → `dialog.select` picker; with arg → direct `changeProfile` + `toast`.
* `df-verify` → `verifyGate` + `dialog.alert` + `toast`.

V1 `api.keymap.registerLayer` + `api.command.register` fallback and `command.execute.before` handler removed — V2 `keymap.layer` inside `ui.slot` is the correct API (see `lib/v2/tui.tsx` in `opencode-dcp` reference). `ctx.keymap.layer` directly in `setup` throws `Keymap.Provider is missing`.

Shared logic `src/commands.ts` (`changeProfile`/`verifyGate`) backs TUI and `dev_framework_set_profile` tool.

Server `tool.transform` provides `dev_framework_*` tools; no `config` hook.

## Anti-patterns to avoid

- Do not claim the gate hard-blocks. V2 is async re-prompt up to `max_blocks`, not a veto.
- Do not rewrite `opencode.json` automatically.
- Do not run network commands during `filesystem.changed` unless configured.
