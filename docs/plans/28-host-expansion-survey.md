# Host-expansion survey — research only

**Status 2026-11-27:** no additional host adapter is scheduled. OpenCode and
DSH remain the supported product. This document records technical feasibility,
not a roadmap or a commitment.

## Decision rule

Do not add hosts for feature parity. A new adapter becomes worth considering
only when the maintainer actually adopts that host or a concrete user request
includes a commitment to installation, live dogfooding, and ongoing support.
Supporting every harness would create maintenance and verification cost without
user value.

If that trigger ever fires, **Pi is the strongest architectural fit** and
**Gemini CLI is the strongest command-hook candidate** found in this survey.

## Extension models matter

There are two materially different adapter shapes:

1. **In-process extension APIs** can reuse ODF's long-lived `HookState`,
   registry, event subscriptions, tools, and commands directly. OpenCode and
   DSH already use this model; Pi does too.
2. **Plugin-packaged command hooks** run external programs with JSON input and
   output. They can reuse the pure core, but need host-specific envelope
   adapters and durable state for data that is memory-only in the current
   adapters.

For a one-shot command-hook adapter, durable-state work includes changed-file
tracking, block/no-progress accounting, the initial anti-weakening snapshot,
session-scoped ignores, and optionally the clean-pass cache. Tool-envelope
extraction, reviewer packaging, installation/trust, and live verification are
separate per-host work. TUI modals and native-goal integration do not translate
automatically.

MCP, rules, skills, custom commands, or a marketplace alone do **not** make a
host suitable. ODF needs lifecycle interception, pre-tool denial where
promised, post-edit feedback, and a bounded completion-continuation mechanism.

## Candidates

| Host | Verified extension surface | Assessment |
| ---- | -------------------------- | ---------- |
| **Pi** | In-process TypeScript extensions; `tool_call` can block or mutate input, `tool_result` can modify results, commands/tools are registerable, and settlement/turn events support continuation | Best architectural fit after OpenCode/DSH. No current usage, so no adapter is scheduled. |
| **Gemini CLI** | Synchronous command hooks: `SessionStart`/`BeforeAgent`, denying `BeforeTool`, contextual `AfterTool`, and `AfterAgent` response rejection with retry | Strongest command-hook fit. Spikes would still be needed for packaging, real envelopes, retry bounds, reviewers, and durable session state. |
| **Goose** | Open Plugins bundles skills and hooks; `PreToolUse` and `Stop` can block, while most other lifecycle events are advisory | Technically viable with a smaller blocking surface. Not scheduled without usage. |
| **Copilot CLI** | `sessionStart`, `preToolUse`, `postToolUse`, and `agentStop`; pre-tool allow/deny/modify and stop `decision: block` | Core enforcement is feasible, including native completion blocking. No current product reason to build it. |
| **Claude Code** | Plugins bundle hooks, agents, and skills; `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop` | Feasible with native reviewer restrictions. The host overrides Stop hooks after eight consecutive blocks without progress; external state is still required. |
| **Codex CLI** | Plugin manifests can bundle `SessionStart`, `PreToolUse`, `PostToolUse`, and `Stop` hooks | Possible but deliberately degraded: hooks require trust and may be off by default, and official docs say tool hooks are not a complete enforcement boundary. |
| **Cursor** | Plugins/hooks cover pre-tool, post-edit, and stop/follow-up flows across Agent/CLI surfaces | Feasible but a broad support matrix: IDE, CLI, cloud behavior, trust, and fail-open defaults need explicit scoping. |

Copilot CLI, Claude Code, and Codex CLI are also supported by the current
`anticomputer/dev-framework`; that project is useful implementation evidence,
but the capabilities above were checked against official host documentation.

## Unverified or insufficient surfaces

- **Qwen Code:** do not infer current hook support merely from Gemini lineage.
- **Aider, Continue, Cline, Amp, and Crush:** no equivalent blocking lifecycle
  surface was established in this survey. Their MCP, rules, commands, or
  extension support is not enough by itself.
- Any future host must be assessed from its current official documentation and
  real hook envelopes, not from marketplace claims alone.

## Spike required before any future commitment

A host moving from "possible" to "supported" needs, at minimum:

1. Real session/edit/shell/completion envelopes captured from that host.
2. A primitive-by-primitive enforcement matrix, including documented degraded
   paths and host-owned block caps.
3. A durable-session-state design where hooks are short-lived processes.
4. Reviewer delegation and read-only restriction packaging.
5. Install, update, trust, and uninstall behavior.
6. Stubbed unit coverage plus live dogfooding on the actual host.

No spike is currently scheduled.

## Official references

- Pi: <https://pi.dev/docs/latest/extensions>
- Gemini CLI: <https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md>
  and <https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md>
- Goose: <https://goose-docs.ai/docs/guides/context-engineering/hooks>
- Copilot CLI:
  <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference>
- Claude Code: <https://docs.anthropic.com/en/docs/claude-code/plugins> and
  <https://docs.anthropic.com/en/docs/claude-code/hooks>
- Codex CLI: <https://developers.openai.com/codex/plugins/build/> and
  <https://developers.openai.com/codex/hooks>
- Cursor: <https://cursor.com/docs/reference/plugins> and
  <https://cursor.com/docs/hooks>
