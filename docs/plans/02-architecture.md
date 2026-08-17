# Architecture

## Package type

`opencode-dev-framework` is an npm package that exports one or more OpenCode plugin functions.

OpenCode plugins are loaded from:

- `.opencode/plugins/` (project-local)
- `~/.config/opencode/plugins/` (global)
- npm packages declared in `opencode.json` under `plugin`

We ship as an npm package so users can install with just a config line.

## Entry point

`src/index.ts` exports plugin functions. OpenCode will call each exported function at startup with a context object.

```ts
import type { Plugin } from "@opencode-ai/plugin";

export const devFramework: Plugin = async (ctx) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      /* inject constitution + map session */
    },
    "tool.execute.before": async (input, output) => { /* guardrails */ },
    event: async ({ event }) => {
      /* file.edited -> lint; session.idle -> gate; session.deleted -> cleanup */
    },
    "experimental.session.stopping": async (input, output) => {
      /* blocking completion gate on supported OpenCode builds */
    },
    tool: {
      dev_framework_init: { /* scaffold project files */ },
      dev_framework_set_profile: { /* change profile in-session */ },
      dev_framework_status: { /* report current plugin state */ },
    },
  };
};
```

The package may export a single default plugin or multiple named plugins. Use one default export to keep user config simple:

```json
{
  "plugin": ["opencode-dev-framework"]
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
| `src/rules.ts` | Load and inject constitution / project rules via `experimental.chat.system.transform`. |
| `src/tools.ts` | Custom tools (`dev_framework_init`, `dev_framework_set_profile`, `dev_framework_status`). |
| `src/registry.ts` | Module-level hook state registry (avoids closure-capture issues in OpenCode's Effect runtime). Captures base directory and host permission snapshots. |
| `src/format-status.ts` | Shared status renderer for `dev_framework_status` tool and `/df-status` slash command. |
| `src/installer.ts` | Template copy and detected-config generation used by `bin/df` and the `dev_framework_init` tool. |
| `src/logger.ts` | Structured logging wrapper around `client.app.log()` with optional file fallback. |
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

- If profile is `off`, register no hooks and do not inject rules.
- If profile is `advisory`, register hooks but never throw/deny; only warn/log.
- If profile is `standard` or `strict`, register hooks and enforce.

## Tool guardrails

The plugin applies guardrails directly in `tool.execute.before`:

1. `protect.ts` matches file-edit and shell tools against the configured `protect`
   globs and the dangerous-command list.
2. The `config` hook captures the host's permission snapshot from OpenCode's
   effective config and stores it in hook state. When the host already denies a
   tool (OpenCode `permission` mode `"deny"`), the plugin skips its own block to
   avoid redundant or conflicting denials.
3. The hook throws a clear `[opencode-dev-framework] ...` error when the plugin
   denies a call.

The plugin does not modify `opencode.json` on disk and does not contribute
permissions at runtime.

## Completion gate

On `session.idle`:

1. Detect changed files since session start or last gate run.
2. If `gate.skip_unchanged` is true and no files changed, skip.
3. Run `typecheck`, `test`, and `lint` commands as configured.
4. If any command fails, log a structured error with the full output and add a user-facing note that the gate failed.

On OpenCode builds with PR #41811, the `experimental.session.stopping` hook can
push a synthetic user message on failure, keeping the session running up to
`gate.max_blocks` times before standing down. Without it, the gate falls back
to `session.idle` and is advisory. Make the failure message extremely visible.

## Custom commands

`/df-verify`, `/df-profile`, `/df-status`, and `/df-help` are custom OpenCode
slash commands registered by the plugin through the `config` hook. OpenCode does
not load slash commands from plugin packages automatically, but a plugin can
mutate the effective OpenCode config at runtime to add them. The
`command.execute.before` hook intercepts these commands and posts the result as
a synthetic chat message via `src/messenger.ts` so it is displayed in the UI
without being processed as a user turn. When the messenger API is unavailable,
the handler falls back to returning the result on `output.parts` with
`synthetic: true`.

- `/df-verify` — run the completion gate manually.
- `/df-profile` — switch the active profile.
- `/df-status` — show the current profile, guardrails, gate, and tracked changed
  files.
- `/df-help` — list the available slash commands.

The project template directory no longer contains command files; only agents,
skills, and the local rules directory are copied by `df init`.

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

- `@opencode-ai/plugin` (dev dependency for types)
- `yaml` (parsing)
- `zod` (validation)
- `picomatch` (glob matching)

Avoid heavy dependencies. The plugin runs inside OpenCode's Bun environment.
