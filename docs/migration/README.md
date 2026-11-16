# Migration to DeepSeek Harness (DSH)

Assessment written 2026-11-16. Question: can the current working setup
(TUI daily driver, operator-memory, opencode-dev-framework gates, Kimi +
opencode-go models with switching) be replicated on
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), and what
must be ported? (Kept as a folder rather than a `plans/NN` entry because
this is a cross-harness assessment with multi-file future — spike results,
port log — not a single build-log entry.)

## Verdict

The port is **one thing, not two**: `opencode-dev-framework` is the real
project (~7k lines, opencode-V2-coupled). Everything else already exists or
rides along:

- **Memory: no port.** `operator-memory/packages/deepseek` (`@aerovato/operator-deepseek`)
  is a thin shell over `@aerovato/operator-core` (`workspace:*`). Feature
  branches (`feat/brain-updates`, `feat/context-management`,
  `feat/preamble-refresh`) live in core and flow to the DSH adapter on
  rebuild. Remaining work is verify-only (Phase 0).
- **Providers: no adapter code.** Kimi looks like an OpenAI-compatible
  gateway route under `llm-pi-ai` (to confirm with the same `curl` as
  opencode-go); opencode-go gets the same treatment if it speaks HTTP
  OpenAI-compatible + `GET /models` (one `curl` each to confirm). Separately,
  the first-party [OpenCode Console integration](https://opencode.ai/console/integrations/deepseek-harness)
  (`npx @opencode/console setup deepseek-harness`) injects workspace models
  (including other providers), policies, MCP servers, skills, and
  instructions via `~/.dsh/cordis.patch.yml` — reversible with `--remove`.
- **TUI: exists, community-owned.** No shipped first-party TUI (removed
  2026-08-04, reintroduction proposed in discussion #1385). Frontrunner is
  `ccch1mneyyy/dsh-TUI` (MIT, `/model`, `/provider`, `/auth`, `/settings`,
  `/resume`; activity snapshot 2026-11-16). Runner-up
  `dsh-tui/dsh-tui` is dormant since 2026-08 and has no detectable license —
  rejected. Niche: opencode-inspired `dsh-oc-tui`, Rust gateway-client
  `rbelem/dsh-tui` (npm entry `@rbelem/dsh-tui`).
- **Gates: the port.** Preflight wall, completion gate + budget,
  per-edit lint, review artifact, block accounting — all re-expressible on
  DSH seams, and the seam fit is *better* than opencode's (below).

## DSH seam reference (verified 2026-11-16 against `39163dd`)

All paths relative to `deepseek-harness@39163dd` (`master` as verified;
re-verify pins on later commits — preview API breaks).

- **Terminal checkpoint:** `packages/core/agent-loop/src/agent.ts:402` —
  `await this.dispatch.serial('agent/turn-stopping', { turn, signal })`,
  fired at natural stop with empty next-step inbox, after `step/end`,
  before `turn/end` and `agent/status: idle`. Continuation = enqueue
  next-step input during the checkpoint (loop re-checks the inbox right
  after dispatch); which enqueue call works from inside a serial listener
  (`agent.followup()` vs `agent.steer()` vs inbox claim) is a Phase 1
  confirm (below). Abort via signal honored. No `next()` (serial).
  Lifecycle diagram: `docs/agent-lifecycle.md` (~line 70).
- **Per-step veto:** `agent/pre-step` waterfall — authoritative `reject` or
  `enter(messages)` before every step. `docs/architecture.md` (~line 114).
- **Budget is plugin-owned, by design:** `packages/core/agent-loop/README.md`
  line 236 — *"No built-in turn budget — a policy that bounds runaway turns
  must cancel from an existing lifecycle extension point such as
  `agent/turn-stopping`."* ODF's `gate.max_blocks` verdict budget (default
  3, `src/config.ts`) ports as the counter policy they tell you to write.
  Note the second cap on the opencode side — the host re-entry ceiling
  (`SESSION_STOPPING_REENTRY_CAP = 3`, see `plans/08-notes.md`) — has no DSH
  counterpart to replicate: DSH ships no budget at all, so the port carries
  exactly one counter.
- **Tool policy:** `docs/tool-execution-pipeline.md` — `tools/pre-execute`
  waterfall (allow/deny/ask) → `ctx.approval` (asks resolve before guards)
  → monotonic guards (deny/abstain, owner policy can't be reordered) →
  `tools/execute` (around: timeout,
  retry, metrics) → definition `projectContent`/`finalizeContent` →
  `tools/post-execute` (accept/block/replace/add-context) → `tools/result`
  (frozen). Generic pre/post waterfalls host hooks; `fs/*` events carry
  read-before-edit checks.
- **Model routing:** `packages/llm/llm-pi-ai/README.md` (the cookbook page
  `docs/cookbook/adding-an-llm-adapter.md` covers only writing a new
  `LlmAdapter` subclass). `providers` dict is the whole surface;
  per-request credential resolution (`apiKeyEnv`, nothing secret in config);
  settings hot-apply next request. Both adapters mount together (route-name
  collision fails load). `models` list replaces installed catalog wholesale;
  `modelOverrides` reshapes single entries; unlisted models take
  `defaultContextWindow`/`defaultMaxTokens` fallbacks.
- **Model discovery (config aid, not auto-register):**
  `packages/llm/llm-pi-ai/README.md` "Discover models from endpoints" —
  undescribed routes are interrogated (`GET {baseURL}/models`, bearer auth
  for OpenAI-compatible). *"The reply is candidate metadata a surface may
  offer for adoption — nothing is stored, and `cordis.patch.yml` remains the
  only thing that decides what a route serves."* Hand-declared routes require
  a non-empty `models` list. An unconfigured credential fails the request
  with `MISSING_CREDENTIAL`.
- **Commands:** `packages/interaction/commands/README.md` — `dsh-commands`
  slash registry for interactive UIs, runs against the agent with no model
  message. `ctx.commands` in the capability table (`docs/architecture.md`
  ~line 154).
- **Durability:** append-only `SessionEvent` log (`turn/*`, `step/*`,
  `tool/*` durable; `agent/*` live), JSONL generations with migration chain,
  `ctx.sessionProjections` for derived views, `session/event` for replayable
  transcript (`docs/architecture.md` ~lines 126–132).
- **Test support:** `packages/test-support` holds seven testkit
  sub-packages (`agent-loop-testkit`, `tool-testkit`, `llm-replay`, …) with
  no root package — a porter works from the testkits, not a single harness.
  Runner parity confirmed: ODF's `test` script is `vitest run`, same as DSH;
  what ports is the fake-context harness, not the runner.
- **Profiles/patching:** `apps/cli/README.md` — ordered bundle stacks +
  profile `cordis.patch.yml` + home patch + `--patch` overlays; HMR
  optional. `dsh web` / `headless` / `sdk` / `sdk-minimal` / `acp`
  profiles; `tui` is bring-your-own.

## ODF port mapping

Source modules in `opencode-dev-framework/src/` (plus repo-root `tui.tsx`
for the UI half of the commands row).

| Module (lines) | DSH target | Nature |
| --- | --- | --- |
| `protect.ts` (334) — edit/bash deny lists (allow/warn/deny), `permission.evaluate` + `execute.before` wall | `tools/pre-execute` deny + monotonic guard | Rewire; rule lists verbatim, warn tier maps onto ask |
| `harness.ts` (685) + `gate.ts` (327) — verdict runner, idle hook + event net, `max_blocks`, shared block counts | `agent/turn-stopping` listener + own budget counter | Rewire; verdict logic carries, dual `experimental.idle`/`idle` registration + dedup + config-reload throttle deleted |
| `lint.ts` (216) — per-edit lint via `execute.after` hook (completed-only, FIFO-limited); `filesystem.changed` event is fallback-only | `tools/post-execute` + `fs/*` events | Rewire; lint rules + completed-vs-error skip + limiter verbatim |
| `config.ts` (502) — opencode.json shape | schemastery Config + `cordis.patch.yml` | Re-express; hardest boring part |
| `block-store.ts`, tracker (`gate.ts` parts), `review.ts`, `runtime-status.ts` | Workspace files + session projections | Mostly portable (file-based) |
| `commands.ts` (profile/verify logic) + `index.ts` (`dev_framework_*` tool registration) + `tui.tsx` (`keymap.layer`, `dialog.alert`) | `dsh-commands` slash commands + `ctx.tools` | Rewire; confirm TUI-frontend command surface on spike |
| `index.ts` (1515) — `Plugin.define` setup | Cordis bundle (`cordis.patch.yml` + `apply(ctx)`) | Rewrite |
| `logger.ts`, `installer.ts`, `update.ts`, `goal.ts`, `roster.ts`, `detect.ts`, `format-status.ts` | DSH equivalents / portable utils | Rewire or carry |
| 31 test files in `tests/` | vitest + `test-support` fakes | Runner parity confirmed (both `vitest run`); port the fake-context harness, assertions mostly carry |

## Target structure

Follow the operator-memory pattern already in-house: **shared core + thin
per-harness adapters**. Extract ODF's harness-agnostic core (verdict
evaluation, rule lists, block accounting, config schema) and write a thin
`dsh` adapter beside the opencode one. Future patches land once, flow to
both — exactly how the memory feature branches work today. Do not fork the
repo; do not maintain two logics.

## Sequence

- **Phase 0 — verify memory (cheap).** Build `packages/deepseek` off
  `feat/brain-updates`, install into the frontrunner TUI profile
  (`dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`), and
  check the injected preamble shows up: assert on the `operator:memory`
  section (or known preamble marker) in the session transcript/logs, not on
  conversational self-report. Exit: marker present. If green, memory +
  patches are done.
- **Phase 1 — spike the seams (one evening).** Scratch Cordis plugin, two
  behaviors only: (a) `tools/pre-execute` deny until a marker file exists
  (preflight in 20 lines); (b) `agent/turn-stopping` listener with a counter
  that enqueues one continuation then cancels (budget in 30 lines). Exit:
  both behave. Kills technical risk before any port commitment. Also confirm
  during the spike: which enqueue call works inside a serial
  `turn-stopping` listener, TUI command surface for slash commands, Kimi +
  opencode-go `GET /models`, per-session `/model` switching across both.
- **Phase 2 — core/adapter split + port.** Extract ODF core, write DSH
  adapter per the table, port tests onto vitest + `test-support`. Exit:
  full suite green on a scratch profile; dogfood one real task.

## Risks & open questions

1. **Preview churn (biggest).** DSH is developer preview with promised
   breaking changes (`0.2.2-rc.x` line). The TUI frontrunner pins exact rcs;
   every rc bump can invalidate adapter + TUI together. Mitigation: pin
   versions, budget for re-verification per bump, keep the opencode ODF
   working until DSH stabilizes.
2. **Community TUI health.** Single-maintainer risk on the frontrunner.
   Mitigation: it consumes only public seams; a swap to
   another TUI (or web) doesn't touch gates or memory.
3. **Kimi + opencode-go `/models`.** One `curl` each with the key decides
   hand-list vs discovery-aided. Open until checked.
4. **Console fail-closed.** Until policies fetch, all tool calls block and no
   agent runs without the Console plugin; `run_code`/terminal tools are
   blocked only while workspace policies limit shell (conditional, not
   blanket). Verify against framework shell-outs
   before depending on the Console path for providers.
5. **Perf shape (expected, not measured).** pnpm install + heavy build graph
   should slow the *dev loop* (vs `bun dev`); runtime is LLM-bound so
   Node-vs-Bun is noise. Real perf
   question is Cordis dispatch overhead under a loaded plugin graph —
   measure event-to-agent latency in Phase 1 if it matters.
6. **Config surface.** schemastery + `cordis.patch.yml` replaces
   `opencode.json`; DSH-side `config/examples/` overlays (incl.
   `mcp-memory`) are
   opt-in only. The `/df-profile` UX needs re-derivation.

## Decisions

| Date | Decision |
| --- | --- |
| 2026-11-16 | Port scope is ODF only; memory rides via `operator-core`. |
| 2026-11-16 | Target structure: shared core + per-harness adapters (operator-memory pattern), not a fork. |
| 2026-11-16 | TUI: `ccch1mneyyy/dsh-TUI` is the spike candidate; `dsh-tui/dsh-tui` rejected (dormant, no license). |
| 2026-11-16 | Upstream opencode PR (#54487) stays frozen as citable reference regardless; this migration does not depend on it. |
