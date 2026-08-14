# Notes and Open Questions

Use this file to capture anything that comes up during implementation that future sessions need to know.

## Validated against `@opencode-ai/plugin` v1.18 (Phase 3)

Findings from reading the installed plugin/SDK type definitions:

1. **No named `session.created` / `session.idle` / `file.edited` hooks.** The
   `Hooks` interface has a generic `event?: (input: { event: Event }) => Promise<void>`
   hook. The SDK `Event` union includes `EventSessionCreated`
   (`properties.info: Session`), `EventSessionIdle` (`properties.sessionID`), and
   `EventFileEdited` (`properties.file`). Later phases must subscribe via `event`
   and switch on `event.type`, not via named hooks as `02-architecture.md` assumed.
2. **Plugins CAN mutate OpenCode config at runtime.** `Hooks.config?: (input: Config) => Promise<void>`
   receives the effective config for mutation. This answers the open question
   above: `config-to-opencode.ts` fragments (permission/formatter) can be
   contributed via the `config` hook instead of rewriting `opencode.json`.
3. **`tool.execute.before` signature:** input `{ tool, sessionID, callID }`,
   output `{ args }`. Throwing blocks the tool call.
4. **Logging:** `ctx.client.app.log({ body: { service, level, message, extra } })`.
   `src/logger.ts` wraps this and swallows failures.
5. **Instruction injection:** no obvious `client.instructions` API; candidates are
   `experimental.chat.system.transform` (append to `output.system`) or
   `chat.message` parts. To be spiked in Phase 6.

## Phase 5 implementation decisions

1. **The gate never throws on `session.idle`.** Failure visibility (error-level
   structured log when `gate.block_on_failure`, warning otherwise) is the
   enforcement mechanism. Throwing from an event handler could break OpenCode
   and still could not undo the finished turn.
2. **`{files}` expansion is shell-less.** Commands run via `spawn` without a
   shell, so a standalone `{files}` token expands to multiple argv entries; an
   embedded token (e.g. `--pattern={files}`) is replaced inline.
3. **Changed files are tracked from `file.edited` events** (not
   `tool.execute.after`) and cleared after each gate run. Tracking happens even
   when `on_edit.lint` is disabled.
4. **`devFramework_verify` custom tool skipped** (checklist 5.4 marks it
   optional; this file already lists it as a follow-up). `/df-verify` ships as
   a markdown slash command only.

## Open questions

### Can a plugin dynamically contribute permission/formatter/rules fragments?

**Status:** To be validated against `@opencode-ai/plugin`.

OpenCode plugins can subscribe to events and add custom tools. It is unclear whether a plugin can return `permission` or `formatter` fragments that OpenCode merges into the effective config. The docs suggest these are config-file settings, not runtime plugin outputs.

**Action:** If plugins cannot contribute fragments, the plugin enforces guardrails entirely in `tool.execute.before` and documents that users may manually copy generated fragments into `opencode.json`.

### What is the exact API to inject instructions from a plugin?

**Status:** To be validated.

The plugin context (`ctx`) includes `client`. We need to determine whether `client` exposes a method to append to system instructions, or whether we must rely on emitting a `message.updated` event with a system message.

**Action:** Spike a minimal plugin that logs `Object.keys(ctx.client)` and inspects available methods.

### Does `session.idle` fire after every assistant turn or only when the user stops?

**Status:** To be validated.

If `session.idle` fires only when the session becomes truly idle, the completion gate is useful. If it fires after every assistant message, it may be too noisy.

**Action:** Test with a logging plugin in a real OpenCode session.

### Should the plugin throw from `session.idle`?

**Status:** To be validated.

Throwing from an event handler may show an error toast but will not make the agent continue working. The better approach is likely to log loudly and, if possible, append a user message that the gate failed.

**Action:** Test behavior in OpenCode.

## Known limitations to document

1. **No hard completion block.** OpenCode has no `agentStop` hook. The gate runs on `session.idle` and reports failure; it cannot force the agent to keep working.
2. **Permission rules are best-effort.** If OpenCode plugins cannot contribute `permission` fragments dynamically, the guardrail relies on the `tool.execute.before` hook, which runs after OpenCode's native permission check.
3. **Formatting is delegated to OpenCode native formatters.** The plugin configures them but does not replace them.

## Design alternatives considered

### Alternative: rewrite `opencode.json` on disk

Rejected. Silent mutation of user config is surprising and error-prone. The plugin enforces at runtime and suggests manual config if needed.

### Alternative: implement a custom `df_verify` tool instead of `/df-verify` command

Keep both. The custom tool lets the agent call verification explicitly; the slash command lets the user trigger it. The MVP should have the slash command; the custom tool is a follow-up.

## Phases 7–8 implementation decisions

- **No `HostContext` class.** The plan called for a `HostContext` interface with an `OpenCodeHost` adapter. In practice the plugin only needs three things from the host: the project directory (`ctx.directory`, used directly), command execution (the injectable `RunCommand` function in `src/host.ts`), and logging (the injectable `LogFn` from `src/logger.ts`, created via `createLogger(ctx.client)`). Function injection is simpler than a class adapter and gives the same testability — every unit test stubs these seams, and none shell out to real tools.
- **`buildHooks` is the composition root.** `src/index.ts` exports `buildHooks(ctx, config, log, run, tracker, constitution)` so tests can build the full hook set with stubs. The default-exported plugin is a thin wrapper: load config, return `{}` when `off`, otherwise create real logger/runner and delegate to `buildHooks`.

## Phase 6 implementation decisions

- **Constitution injection uses `experimental.chat.system.transform`, not `session.created`.** The plugin API has no `session.created` hook (only the generic `event` hook, which is a notification and cannot mutate session instructions). `experimental.chat.system.transform` receives `output.system: string[]` and runs whenever the system prompt is assembled, which is the correct injection point. It also keeps the constitution present after session compaction, which a one-shot `session.created` injection would not.
- **Configured `constitution` path falls back to the bundled constitution with a warning.** A typo in the config file should never silently disable the constitution; the plugin logs a warning via `client.app.log` and injects the bundled default instead.
- **Injection is idempotent.** `injectConstitution` skips appending when the text is already present, so repeated transforms do not grow the system prompt.

## Phase 10 release decisions

- **`package-lock.json` is now committed.** Development gitignored it (AGENTS.md: no lockfiles until intentionally releasing). With 0.1.0 release prep and the first real CI run, the lockfile is tracked so `actions/setup-node`'s `cache: npm` and reproducible `npm ci` installs work.
- **Actions pinned to v5.** `actions/checkout@v5` and `actions/setup-node@v5` run on Node 24 runners; v4 targeted deprecated Node 20.
- **Publishing uses a granular access token + provenance.** After fighting npm's
  OIDC trusted-publishing UI (repeated `E404 Not Found` despite a correctly
  signed provenance attestation), the workflow fell back to a simpler, reliable
  setup: store an npm granular access token as the `NPM_TOKEN` GitHub secret
  and authenticate with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. The
  `--provenance` flag still uses OIDC for the Sigstore attestation, so builds
  get verifiable provenance without requiring npm's tricky trusted-publisher
  linking. Note: npm is deprecating 2FA-bypass GAT direct publishing around
  January 2027, so OIDC should be revisited before then.
- **Closure variables cannot survive OpenCode's async hook runtime.** Initial
  wiring passed `config`, `log`, `run`, `tracker`, and `constitution` as
  closure captures inside `buildHooks`. In production this caused
  `TypeError: undefined is not an object (evaluating 'config.gate')` and
  `log is not a function` because the Effect runtime strips those captures.
  The fix stores hook state in a module-level `hookRegistry` keyed by project
  directory and looks it up at call time. `activeDirectory` handles hooks that
  do not receive a directory hint.
- **Local source path is the best dev workflow.** Pointing
  `opencode.json` at the repository root (e.g.
  `"plugin": ["/home/jerome/opencode-dev-framework"]`) picks up source
  changes immediately after `npm run build`, without an npm publish cycle.
  Beware `.opencode/opencode.json` (created by `opencode plugin`) and
  `~/.cache/opencode/packages/opencode-dev-framework*/`, both of which can
  shadow the local source with a stale published build.

## References

- OpenCode plugin docs: <https://opencode.ai/docs/plugins>
- OpenCode permissions docs: <https://opencode.ai/docs/permissions>
- OpenCode formatters docs: <https://opencode.ai/docs/formatters>
- OpenCode commands docs: <https://opencode.ai/docs/commands>
- Original inspiration: <https://github.com/anticomputer/dev-framework>
