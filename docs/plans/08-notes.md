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

## References

- OpenCode plugin docs: <https://opencode.ai/docs/plugins>
- OpenCode permissions docs: <https://opencode.ai/docs/permissions>
- OpenCode formatters docs: <https://opencode.ai/docs/formatters>
- OpenCode commands docs: <https://opencode.ai/docs/commands>
- Original inspiration: <https://github.com/anticomputer/dev-framework>
