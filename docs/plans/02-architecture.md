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
    "session.created": async () => { /* inject constitution */ },
    "tool.execute.before": async (input, output) => { /* guardrails */ },
    "file.edited": async (event) => { /* lint edited file */ },
    "tool.execute.after": async (input, output) => { /* observe results */ },
    "session.idle": async () => { /* completion gate */ },
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
| `src/config.ts` | Load and merge `.opencode-dev-framework.yml` and `.dev-framework.yml`, resolve profile defaults, validate with Zod. |
| `src/config-to-opencode.ts` | Translate framework config into OpenCode-native fragments: `permission`, `formatter`, `rules`. |
| `src/protect.ts` | Implement `tool.execute.before` guardrails for protected paths and dangerous commands. |
| `src/lint.ts` | Implement per-edit checks on `file.edited` / `tool.execute.after`. |
| `src/gate.ts` | Implement the `session.idle` completion gate. |
| `src/rules.ts` | Load and inject constitution / project rules. |
| `src/logger.ts` | Structured logging wrapper around `client.app.log()`. |
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
        -> generate OpenCode native config fragments
          -> if enabled, register hooks
```

## Hook registration rules

- If profile is `off`, register no hooks and do not inject rules.
- If profile is `advisory`, register hooks but never throw/deny; only warn/log.
- If profile is `standard` or `strict`, register hooks and enforce.

## Tool guardrails

Use both native `permission` config and plugin hook:

1. `config-to-opencode.ts` emits `permission.edit` rules from `protect` globs. This is the primary defense.
2. `tool.execute.before` acts as a belt-and-suspenders check and can throw a clearer error message.

The plugin does not modify `opencode.json` on disk. It returns the generated fragments to OpenCode at runtime. In practice this means the plugin itself applies guardrails in code rather than rewriting config files.

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

## Custom command

`/df-verify` is a custom OpenCode slash command that runs the completion gate on
demand. OpenCode does not load slash commands from plugin packages, so the
plugin ships it as a **template** at
`templates/.opencode/commands/df-verify.md`, copied into the project by
`df init` or the `dev_framework_init` tool. A `df-profile.md` template provides
`/df-profile` for switching profiles.

Prefer the markdown command file because it requires no code and is easy to maintain.

## Build output

`npm run build` compiles TypeScript to `dist/`.

`package.json`:

```json
{
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "commands", "rules"]
}
```

## Dependencies

- `@opencode-ai/plugin` (dev dependency for types)
- `yaml` (parsing)
- `zod` (validation)
- `minimatch` or `picomatch` (glob matching)
- `chalk` or no color library (keep minimal)

Avoid heavy dependencies. The plugin runs inside OpenCode's Bun environment.
