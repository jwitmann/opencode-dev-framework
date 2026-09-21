# Architecture

## Package type

`opencode-dev-framework` is an npm package that exports an OpenCode V2 plugin (`@opencode/plugin`).

OpenCode V2 plugins are loaded from:

- `.opencode/plugins/` (project-local, auto-discovered)
- `~/.config/opencode/plugins/` (global)
- npm packages declared in `opencode.json` under `plugins`

We ship as an npm package so users can install with just a config line.

## Entry point

`src/index.ts` uses `Plugin.define` (V2). OpenCode calls `setup(ctx)` with a `Context` (`location`, `session`, `tool`, `event`, `command`, `storage`, …).

```ts
import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";

export default Plugin.define({
  id: "opencode-dev-framework",
  async setup(ctx: Context) {
    // constitution -> session.hook("context", e => e.system.push(...))
    await ctx.session.hook("context", async (event) => { /* inject */ });
    // guardrails -> tool.hook("execute.before", e => checkToolCall(e.tool,e.input))
    await ctx.tool.hook("execute.before", async (event) => { /* guardrails */ });
    // file tracking + gate -> event.subscribe() on filesystem.changed / session.idle -> runGate -> session.prompt on failure
    const ctrl = new AbortController();
    for await (const event of ctx.event.subscribe({ signal: ctrl.signal })) { /* ... */ }
    // tools -> tool.transform(editor.add({name, input:JSONSchema, execute}))
    await ctx.tool.transform((editor) => { editor.add({...}); });
    return () => ctrl.abort();
  },
});
```

The package exports one default V2 plugin. `tui.tsx` is a separate TUI plugin (`@opencode/plugin/tui`, `ctx.ui.slot` + `ctx.keymap.layer`):

```json
{
  "plugins": ["opencode-dev-framework"]
}
```

## Internal modules

| Module | Responsibility |
|---|---|
| `src/command-utils.ts` | Shared command parsing helpers (tokenize commands, normalize per-extension command maps). |
| `src/config.ts` | Load and merge `.opencode-dev-framework.yml` and `.dev-framework.yml`, resolve profile defaults, validate with Zod. |
| `src/detect.ts` | Detect the project's language and tooling from root files for `df init`. |
| `src/protect.ts` | Implement `tool.execute.before` guardrails for protected paths and dangerous commands. |
| `src/lint.ts` | Implement per-edit checks on `file.edited`, with optional `pre-commit` fallback. |
| `src/gate.ts` | Implement the completion gate and changed-file tracking. |
| `src/rules.ts` | Load and inject constitution via `session.hook("context")` (V2 `system: SystemPart[]`). |
| `src/tools.ts` | Legacy test helper for `buildHooks` (prod tools via `tool.transform` in `index.ts`). |
| `src/registry.ts` | Legacy per-project registry for V1 tests (`getHookState`/`updateHookState`); V2 prod uses module `activeState` + `ctx.location`. |
| `src/format-status.ts` | Shared status renderer for `dev_framework_status` tool and `/df-status` TUI. |
| `src/installer.ts` | Template copy and detected-config generation used by `bin/df` and the `dev_framework_init` tool. |
| `src/logger.ts` | Structured logging to `stderr` + `OPENCODE_DEV_FRAMEWORK_LOG_FILE` (V1 `client.app.log` kept for tests). |
| `src/types.ts` | Shared TypeScript types and interfaces. |

## Host abstraction

Although the MVP supports only OpenCode, keep the plugin function host-agnostic by abstracting the execution context:

```ts
// src/host.ts
export interface HostContext {
  directory: string;
  worktree?: string;
  runCommand(command: string[], options?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>): Promise<void>;
  injectInstructions(markdown: string): Promise<void>;
}
```

The OpenCode-specific adapter maps OpenCode's `ctx` (`project`, `directory`, `worktree`, `$`, `client.app.log`) into this interface. Future hosts (e.g., a local CLI test harness) can implement the same interface.

## Configuration flow

```text
opencode session starts
  -> plugin loaded
    -> load config (native -> fallback)
      -> resolve profile defaults
        -> load constitution (bundled / local override / explicit rules / style guide)
          -> if enabled, register hooks
```

## Hook registration rules

Hooks are always registered; each hook gates on live config (`profile === "off"` → no-op) so a runtime `df-profile` switch via `changeProfile` + `reloadConfigIfChanged` takes effect without restart.

- `off`: no injection, guardrails allow, gate not run.
- `advisory`: guardrails warn, gate `warn` on failure.
- `standard`/`strict`: guardrails deny, gate `error` (strict also lints changed files in gate).

## Tool guardrails

The plugin applies guardrails in `tool.hook("execute.before")`:

1. `protect.ts` matches file-edit and shell tools against `protect` globs and dangerous commands.
2. V1 `config` hook host-permission snapshot is gone in V2 — guardrails are conservative (always check).
3. The hook throws `[opencode-dev-framework] ...` on `deny`; `warn` only logs.

The plugin does not modify `opencode.json` on disk.

## Completion gate

On `session.idle` / `session.status:idle` (via `event.subscribe`):

1. Detect changed files via `filesystem.changed`.
2. If `gate.skip_unchanged` and no files, skip (`ran=false`).
3. Run `typecheck`/`test`/`lint_changed` sequentially.
4. On failure inside `gate.max_blocks`, call `session.prompt({sessionID, text: stoppingMessage})` to re-wake the agent (V2 async, no `session.stopping` veto). After `max_blocks` log `warn` and stand down. `clearChangedFiles` after each run.

## Custom commands / TUI

`/df-status`, `/df-help`, `/df-profile`, `/df-verify` are **TUI commands** (`tui.tsx` `Plugin.define` via `@opencode/plugin/tui`):

- `ctx.ui.slot({append:"app",render(){ ctx.keymap.layer(()=>({commands:[{id, slash:{name}, run}]})) }})`
- `df-status`/`df-help` → `ctx.ui.dialog.alert`
- `df-profile` → `ctx.ui.dialog.select` or direct `changeProfile`
- `df-verify` → `verifyGate` + `ctx.ui.dialog.alert` + `toast`

Server `tool.transform` provides `dev_framework_*` tools for in-agent use. No `config` hook or `command.execute.before`.

## Build output

`npm run build` compiles TypeScript to `dist/`.

`package.json`:

```json
{
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "bin", "rules", "templates"]
}
```

## Dependencies

- `@opencode/plugin` `^2` (V2 server + TUI), `solid-js` peer for TUI
- `yaml`, `zod`, `picomatch` (parsing/validation/glob)

Avoid heavy dependencies. The plugin runs inside OpenCode's Bun (server) + Solid (TUI).
