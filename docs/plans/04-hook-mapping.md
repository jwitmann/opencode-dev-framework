# Hook Mapping: dev-framework → OpenCode V2

## Overview

`anticomputer/dev-framework` is built on GitHub Copilot CLI's JSON hook manifest. OpenCode V2 uses `Plugin.define` with `Context` domains. This document maps V2 equivalents.

## Primitive mapping table

| dev-framework primitive | Copilot CLI hook | OpenCode V2 equivalent | Can block? | Notes |
|---|---|---|---|---|
| Constitution injection | `sessionStart` | `session.hook("context")` (`system: SystemPart[]`) | N/A | Per model request; no session mapping (ctx.location). |
| Protected-path guardrail | `preToolUse` | `permission.hook("evaluate")` (deny) + `tool.hook("execute.before")` (backstop, throw) | Yes (deny/throw) | Phase 25: pipeline runs before-hooks FIRST (proven), so evaluate only sees calls the backstop passed — native layer is defense-in-depth; `execute.before` is the load-bearing wall. Advisory warns stay debug in evaluate (no double noise). |
| Format on edit | `postToolUse` | `formatter` + `event.subscribe` on `filesystem.changed` | Indirectly | Formatter auto-runs; plugin supplements. |
| Lint on edit | `postToolUse` | `event.subscribe` on `filesystem.changed` | No | Run linter; can delegate to `pre-commit`. |
| Completion gate | `agentStop` | `session.hook("experimental.idle")` → `session.synthetic` (same execution) | **Async bounded** (`gate.max_blocks`) | Idle-first (12-idle-hook-cutover). Hook skips (interruption, failure, steer-parked drains) fall through to the `event.subscribe` net below. `execute.before` stays the only true hard wall. |
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

### `session.hook("experimental.idle")` (V2 gate, primary)

**Purpose:** Completion gate, same execution.

**Actions:** stale-guard → `reloadConfigIfChanged` → `off` check → resolve `sessionID` (`event.sessionID ?? getEventSessionID`) → `runCompletion` → `actOnVerdict` → completed evaluation stamps `lastIdleHandled(sessionID)`. Blocked → `session.synthetic({ sessionID, text })` (same execution; never `prompt` here) + info log. Throw path logs warn, abstains, does NOT stamp (subscriber net retries). `background` ignored (gate evaluates the tree, never waits on running work).

**Forward-compat:** the unprefixed `idle` alias is registered alongside `experimental.idle` so a future stabilization rename is a non-event; a 1s same-boundary double-fire guard makes that safe.

### `session.idle` / `session.status:idle` via `event.subscribe` (V2 gate net)

**Purpose:** Completion gate fallback for the boundaries the hook skips.

**Actions:** skip when `lastIdleHandled(sessionID)` is fresh (5s — the hook just handled this boundary; only the hook stamps). Otherwise `runGate` on `changedFiles`, `clearChangedFiles`, `summarizeGate`, `block_on_failure`→`error` else `warn`. On failure inside `max_blocks`, `session.synthetic({sessionID, text: stoppingMessage})` (synthetic-first; `prompt` fallback). After `max_blocks` warn + stand down.

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

* Do not claim the gate hard-blocks. V2 is async re-prompt up to `max_blocks`, not a veto.
* Do not rewrite `opencode.json` automatically.
* Do not run network commands during `filesystem.changed` unless configured.
