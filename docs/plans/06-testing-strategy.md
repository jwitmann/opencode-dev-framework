# Testing Strategy

## Philosophy

- **Unit tests first.** The plugin runs inside OpenCode's Bun environment, so integration testing inside OpenCode is slow. Most behavior should be testable with a stubbed `HostContext`.
- **No real shell commands in tests.** Use a fake command runner that returns configurable stdout/stderr/exit codes.
- **No real file system where possible.** Use in-memory representations for config and rules files.
- **Integration smoke test last.** Once the plugin builds, install it into a temporary OpenCode project and verify it loads.

## Test runner

Use `vitest` for fast unit tests. Alternatively, `bun test` works since OpenCode uses Bun.

Recommendation: `vitest` because it has excellent TypeScript support and runs in Node.js/Bun.

## Test layout

```text
tests/
├── config.test.ts
├── config-to-opencode.test.ts
├── protect.test.ts
├── lint.test.ts
├── gate.test.ts
├── rules.test.ts
└── host.test.ts
```

## Stub host

```ts
// tests/stub-host.ts
import type { HostContext } from "../src/host";

export function createStubHost(options?: {
  cwd?: string;
  files?: Record<string, string>;
  commandResults?: Record<string, { stdout: string; stderr: string; exitCode: number }>;
}): HostContext {
  const logs: Array<{ level: string; message: string; extra?: unknown }> = [];
  const instructions: string[] = [];

  return {
    directory: options?.cwd ?? "/project",
    worktree: options?.cwd ?? "/project",
    async runCommand(command) {
      const key = command.join(" ");
      const result = options?.commandResults?.[key];
      if (!result) {
        throw new Error(`Unexpected command: ${key}`);
      }
      return result;
    },
    async log(level, message, extra) {
      logs.push({ level, message, extra });
    },
    async injectInstructions(markdown) {
      instructions.push(markdown);
    },
    getLogs: () => logs,
    getInstructions: () => instructions,
  };
}
```

Tests should import this and cast to `HostContext`. For convenience, expose `getLogs`/`getInstructions` via an extended interface or helper.

## Config loader tests

Use an in-memory file map passed to the config loader. If the loader reads from disk directly, create a thin wrapper that accepts a `readFile` function.

Example test cases:

- `loads native yaml config`
- `falls back to .dev-framework.yml`
- `applies standard profile defaults`
- `applies strict profile defaults`
- `overrides defaults with explicit keys`
- `rejects unknown profile value`
- `parses flat protect string into array`
- `parses per-extension format map`

## Guardrail tests

- `denies edit to protected file in strict`
- `warns on edit to protected file in advisory`
- `allows edit to non-protected file`
- `denies git push bash command`
- `respects protect_off`

## Lint tests

- `runs configured linter on .go file`
- `runs per-extension linter on .py file`
- `skips excluded files`
- `substitutes {file} token`
- `times out long-running linter`

## Gate tests

- `runs test and typecheck`
- `reports failure when test fails`
- `skips when no files changed and skip_unchanged is true`
- `scopes tests to changed files`
- `runs lint on changed files in strict`

## Rules tests

- `discovers default rules files`
- `loads explicit rules list`
- `injects concatenated rules into instructions`
- `does nothing when profile off`

## Build/typecheck tests

- `npm run typecheck` passes.
- `npm run build` produces `dist/index.js` and `dist/index.d.ts`.

## Integration smoke test

After publish:

1. Create a temp directory.
2. Run `npm init -y`.
3. Install `opencode-dev-framework`.
4. Create `opencode.json` referencing the plugin.
5. Create `.opencode-dev-framework.yml`.
6. Run `opencode` and verify the plugin loads without errors.

This can be documented as a manual step rather than automated in CI.

## Coverage target

Aim for >80% line coverage on `src/` before v0.1.0. Do not chase coverage for coverage's sake; focus on behavior.
