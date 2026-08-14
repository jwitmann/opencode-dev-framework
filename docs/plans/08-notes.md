# Notes and Open Questions

Use this file to capture anything that comes up during implementation that future sessions need to know.

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
