# Notes and Open Questions

Use this file to capture anything that comes up during implementation that future sessions need to know.

## Pre/post-flight enforcement harness (v0.2.3)

**Teardown disposal + fail-open guard (issue #1, fixed in working tree):**
`setup()` discarded the `Registration` (`{ dispose() }`) handles returned by
`ctx.session.hook` / `ctx.tool.hook` / `ctx.tool.transform`, while teardown
nulled module-level `activeState`. The orphaned `execute.before` closure then
threw `plugin state is not available` on every tool call with no in-session
recovery (`session_move` repro on desktop v2.0.18). Fix: track every
registration and `dispose()` it in the setup cleanup (only clearing
`activeState` when it is still this setup's instance), and make
`execute.before` fail-open (warn + allow) when state is absent — consistent
with the other hooks which already no-op. Regression covered by
`tests/teardown.test.ts`. See `05-implementation-checklist.md` Phase 20.

**Ground truth on hard stops (verified against the v2.0.12 tag source,
2026-09-21):** `packages/plugin/src/promise/session.ts` `SessionHooks` has no
`stopping` entry. PR #44712 (fail-closed `session.stopping`) is still **open**;
the earlier PR #41811 (`experimental.session.stopping`) was **closed unmerged**.
The 0.1.x README/checklist claims about a working `session.stopping` adapter
(11.6/11.11 below) were therefore aspirational — the V2 rewrite (0.2.x) dropped
the adapter, which silently weakened post-flight enforcement to advisory.

**What shipped instead (`src/harness.ts`):**

- One shared verdict runner, `evaluateCompletion`, consumed by BOTH the
  `session.stopping` hook (registered defensively; if a future core dispatches
  it, blocked verdicts set `stop=false` + message — a true hard stop) and the
  `session.idle` fallback (re-prompt via `ctx.session.prompt`). Block counts
  are shared so the budget applies across either path.
- Changed files = union of the edit-event tracker and
  `git status --porcelain=v1` (`gitChangedFiles`), so an event-shape mismatch
  can no longer silently empty the tracker and let `skip_unchanged` swallow
  the gate.
- `gate.require_review` (default on for every profile except `off`): sessions
  that changed files must write `.opencode/opencode-dev-framework/review.md`.
  Standard/strict block (counted, loud stand-down after `max_blocks`); advisory
  warns. Wording ported from the original `stop-gate.sh`, including the
  "prove pre-existing failures on a clean tree" escape clause.
- `preflight:` task list: **the one true hard gate on every build** — edit
  tools are denied in `tool.execute.before` (before the edit lands) until
  `.opencode/opencode-dev-framework/preflight.md` exists. The artifact path
  itself is always writable; read-only tools are never blocked.
- `/df-status` shows the active enforcement mode via `stopHookSupported`
  (flips the first time core actually dispatches `session.stopping`).

**Tracking:** watch opencode PR #44712. When a release dispatches
`session.stopping`, the plugin upgrades automatically with no config change.

## V2 migration (0.2.0) — `@opencode/plugin` ^2

**V1 is dead.** `opencode v2.0.11` requires `@opencode/plugin` (`Plugin.define` + `Context`). Key changes:

- `plugin` → `plugins` in `opencode.json` (`{package, options}` object, not tuple).
- `src/index.ts`: `Plugin = async (ctx:PluginInput)=>Hooks` → `Plugin.define({id, setup: async (ctx:Context)=>...})` with `ctx.session.hook("context")`, `ctx.tool.hook("execute.before")`, `ctx.event.subscribe()`, `ctx.tool.transform()`. No `config` hook, no `experimental.chat.system.transform`, no `session.stopping`.
- Gate: `session.stopping` (sync `output.stop=false`) removed. V2 re-prompts via `ctx.event.subscribe` on `session.idle`/`session.status:idle` → `ctx.session.prompt({sessionID, text: stoppingMessage})` inside `gate.max_blocks` (plugin-owned, no core 3-cap). `filesystem.changed` replaces `file.edited`.
- TUI: `api.keymap.registerLayer` in `setup` → `ctx.ui.slot({append:"app",render(){ ctx.keymap.layer(()=>({commands:[{id, slash:{name}}]})) }})` via `@opencode/plugin/tui` + `solid-js` peer. Direct `keymap.layer` in `setup` throws `Keymap.Provider is missing` when called on server.
- Tools: `tool()` helper + `zod` args → `tool.transform` with JSON Schema, `editor.add({name,input,execute})`.
- `src/logger.ts`: `client.app.log` → `stderr` + file fallback; V1 `client` kept for tests.
- `package.json` dev `solid-js`, `tui.tsx` still ships as source via `exports "./tui"`.

Historical V1 notes below remain for context but are no longer runtime-relevant.

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

## Full dev-framework parity (v0.1.7)

- **Constitution split into numbered rule files.** `rules/` now contains
  `00-activation.md`, `10-quality-bar.md`, `20-match-existing-patterns.md`,
  `30-testing-discipline.md`, and `40-delegation.md`, ported from the original
  dev-framework and adapted for OpenCode. `loadConstitution` concatenates all
  `.md` files in sorted order. The `constitution` config key still overrides
  the bundled set; `rules` appends extra files.
- **Project templates.** `templates/` contains the default config,
  specialist agents, skills, and a local rules directory scaffold. These are
  copied into a project by the CLI or the `dev_framework_init` tool.
- **`bin/df` CLI.** `df init [dir]` scaffolds templates; interactive by
  default with `[o]verwrite / [s]kip / [a]ll / [n]one` prompts. Flags
  `--skip-existing` and `--overwrite-existing` make it non-interactive. `df
  status [dir]` reports missing/present/different files.
- **Custom tools.** `dev_framework_init` and `dev_framework_set_profile` are
  registered as OpenCode plugin tools. `dev_framework_set_profile` edits
  `.opencode-dev-framework.yml`, clears the config cache, reloads config and
  constitution, and updates the in-memory hook registry so the change takes
  effect immediately without restarting OpenCode.
- **`session.stopping` gate (PR #44712).** A first-class loop-continuation
  hook registered via a local `HooksWithStopping` type assertion. It uses the
  fail-closed contract `{ stop: boolean; message?: string }` (default
  `stop: true`; the plugin sets `stop: false` plus a message to continue).
  It fires only on natural loop exits and OpenCode core enforces a hard
  re-entry cap of 3. On gate failure in `standard`/`strict`, it pushes a
  concise synthetic user message up to `gate.max_blocks` times before
  standing down. The `session.idle` hook remains as a fallback for older
  OpenCode.
  genuine natural loop exit and is awaited by OpenCode core; provider/tool
  errors, blocked stops, retry exhaustion, and compaction skip it. OpenCode
  core enforces its own hard `SESSION_STOPPING_REENTRY_CAP = 3` ceiling
  regardless of `gate.max_blocks`, so effective blocks are capped at 3 even
  if the config requests more. Both hooks share a single `runStoppingGate`
  runner so one session's block count applies to either hook.
- **Session-to-directory mapping.** `experimental.chat.system.transform`
  records `sessionID → directory` so the stopping hooks (which only
  receive a session ID) can look up the right hook state.

## v0.1.16 release decisions

- **Dead code removed.** `src/config-to-opencode.ts` and its tests were deleted;
  the generator helpers were unused in production. Shared command parsing moved
  to `src/command-utils.ts`. Stale `commands/` directory references were removed
  from docs, README, and architecture snippets.
- **`bin/df profile` positional parsing fixed.** The `positional` array was used
  before it was constructed; parsing now happens before any command branch reads it.
- **Guardrails no longer silently no-op when session state is missing.**
  `getStateForSession` falls back to the project `baseDirectory` set at plugin
  init. If state is still missing, `tool.execute.before` fails closed (denies),
  and `command.execute.before` returns a visible error text part.
- **`injectConstitution` appends to the last system entry** instead of adding a
  new array element, keeping the system prompt compact.
- **Host permissions are respected.** The `config` hook captures
   `opencodeConfig.permission` and stores it in hook state. Guardrails skip their
   own block when the host permission model already denies the tool (OpenCode
   `permission` mode `"deny"`), avoiding redundant/conflicting blocks.
- **Host-permission crash fixed (root cause of "{} is not iterable").** OpenCode's
   `permission` is a tool-to-mode object, not the `HostPermission[]` shape the
   guardrail originally assumed. The old code assigned it verbatim and iterated
   it with `for...of`, throwing `{} is not iterable` on every `write`/`edit`/`bash`
   call for any non-`off` profile. Fixed by consuming the real shape in
   `protect.ts` `hostDenies` (map tool names to `edit`/`bash`; stand down only on
   `"deny"`). Regression tests added in `tests/protect.test.ts`.
- **`/df-help` and unknown `/df-*` handling added.** `/df-help` lists the three
  supported commands; unrecognized `/df-*` commands return a hint.
- **Config load errors are surfaced.** If `.opencode-dev-framework.yml` is
  invalid, the plugin logs an error, shows a TUI toast when available, and
  disables itself for that project.
- **Optional file logging.** Setting `OPENCODE_DEV_FRAMEWORK_LOG_FILE` appends a
  JSON line for every log call, which helps debug production runs where
  `client.app.log` may not be visible.

## v0.1.19 release decisions

- **Corrected slash-command messenger API shape.** The initial v0.1.17
  messenger used the SDK v1 wrapper (`{ path: { id }, body: { ... }}`) but
  guessed the part flag incorrectly. We first tried `synthetic: true`, then
  switched to `ignored: true`. After testing against the actual OpenCode runtime,
  the right combination is the SDK v1 wrapper with `synthetic: true`:

  ```ts
  client.session.prompt({
    path: { id: sessionID },
    body: {
      noReply: true,
      parts: [{ type: "text", text, synthetic: true }],
    },
  })
  ```

  `synthetic: true` makes the message visible in the conversation UI without
  treating it as a user turn. `ignored: true` hid the message from the UI while
  still including it in the model context, which is why the status text leaked
  into the next assistant turn. If the prompt API is unavailable, the messenger
  falls back to `client.tui.showToast`. The `output.parts` fallback (used in
  tests or when the messenger is absent) also marks the part `synthetic: true`.

## v0.1.17 release decisions

- **Slash-command responses moved from `output.parts` to a messenger.** The
  original slash-command handler wrote to `output.parts`, which OpenCode treated
  as a user message on the next turn. `src/messenger.ts` now posts responses via
  `client.session.prompt` with `noReply: true` so the result appears in the chat
  without being fed back to the model.

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
- **Slash commands are registered by the plugin, not markdown templates.** As of
  v0.1.15, `/df-verify`, `/df-profile`, and `/df-status` are registered via the
  `config` hook and handled in `command.execute.before`. Project-level
  `.opencode/commands/` templates are no longer used or copied.

## v0.1.12 release decisions

- **`df init` auto-detects project commands.** `src/detect.ts` inspects root
  files (`package.json`, `go.mod`, `pyproject.toml`, etc.) and writes a
  `.opencode-dev-framework.yml` with matching test/typecheck/format/lint
  commands instead of a static Go-oriented template.
- **`df profile <profile>` CLI.** The CLI can now change the project profile
  from the shell, using the same text-level YAML edit as the in-session
  `dev_framework_set_profile` tool.
- **Style-guide auto-discovery.** When `style_guide` is not configured, the
  plugin looks for `STYLE.md`, `docs/STYLE.md`, `CONTRIBUTING.md`, and
  `docs/CONTRIBUTING.md` (in that order) and appends the first found file under
  a "Style Guide" heading.
- **`precommit: auto` integration.** When enabled and the `pre-commit` binary
  is available, per-file linting (`on_edit.lint` and `gate.lint_changed`) uses
  `pre-commit run --files <file>` instead of the configured lint command. If
  the binary is missing, the plugin falls back to the normal lint command.
  `df init` sets `precommit: auto` automatically when a
  `.pre-commit-config.yaml` file is present.

## v0.1.15 release decisions

- **Slash commands migrated from templates to plugin handlers.** The original
  `/df-verify`, `/df-profile`, and `/df-status` were markdown templates copied
  into `.opencode/commands/`. They relied on the LLM to interpret the prompt and
  call the right tool. As of v0.1.15, the plugin registers the commands via the
  `config` hook and handles them in `command.execute.before`, returning the
  result as a text part directly from in-memory state. This makes `/df-status`
  instant and deterministic.

## v0.1.14 release decisions

- **`/df-status` slash command + `dev_framework_status` tool.** Users wanted an
  in-session way to inspect plugin state. We added a custom tool that returns the
  active profile, guardrails, completion gate, configured commands, pre-commit
  status, changed-file tracker, and per-session block counts. A
  `templates/.opencode/commands/df-status.md` slash-command template instructs
  the agent to call the tool and present the result.

## v0.1.11 release decisions

- **`constitution` config key removed.** The original `dev-framework` has no
  `constitution` config key; it calls the injected content the constitution but
  sources it from `rules/*.md`. To stay faithful and avoid config-key collision
  with other tools, the plugin now:
  1. Loads explicit `rules` (array = replace; object with `mode`/`files`).
  2. Auto-discovers `.opencode/opencode-dev-framework/rules/*.md` in the project
     (replace bundled when no explicit config).
  3. Falls back to the bundled `rules/*.md`.
  4. Appends `style_guide` content if configured or auto-discovered.
- **`style_guide` is now injected.** It matches the original `dev-framework`
  behavior: a project-specific style guide file is appended to the constitution.

## v0.1.10 release decisions

- **`config.rules` semantics changed from append to explicit replace/append.**
  The original `dev-framework` has no `rules` key; the plugin invented it. The
  previous "append after bundled" behavior was confusing. As of v0.1.10,
  `rules` can be an array (replace the bundled constitution) or an object with
  `mode: "replace" | "append"` and `files`.

## v0.1.8 release decisions

- **Logging must never throw, but total swallow is dangerous.** During
  development, `client.app.log` itself threw in some OpenCode builds, making
  plugin failures invisible. `createLogger` now catches `app.log` errors and
  writes a fallback line to `process.stderr`; even if stderr fails, the log
  call still resolves.

## v0.1.9 release decisions

- **`config.rules` is now appended to the constitution.** Previously the key
  was parsed and passed through `resolveConfig` but never read. `loadConstitution`
  now loads each rules file and appends it after the bundled (or custom)
  constitution, with warnings for missing files.
- **Session-aware hook state lookups.** `tool.execute.before` and
  `session.idle` now resolve hook state via `sessionID → directory` mapping
  instead of relying on `activeDirectory`. `file.edited` still uses the active
  directory because the event does not include a session ID.
- **CLI flags are mutually exclusive.** `df init --skip-existing
  --overwrite-existing` now exits with an error instead of silently skipping.
- **No automatic OpenCode config mutation.** The plugin enforces guardrails in
  `tool.execute.before` and lints in `file.edited`. It does **not** inject
  `permission` or `formatter` fragments into OpenCode's effective config at
  runtime, and docs no longer claim it does. The generator helpers that produced
  those fragments were removed in v0.1.16; command parsing helpers moved to
  `src/command-utils.ts`.

## v0.1.22 release decisions

- **Slash-command status/help moved to a TUI plugin module.** After months of
  iterating on a chat-message side channel (`client.session.prompt` with
  `synthetic`/`ignored` flags), we adopted DCP's pattern: a separate TUI plugin
  (`tui.tsx`, exported as `opencode-dev-framework/tui`) registers `/df-status` and
  `/df-help` via `api.command.register` and opens a `DialogAlert` modal. The output
  renders in the TUI and is never inserted into the chat stream, so it cannot be
  re-processed as a user turn.
- **`package.json` now exports `./tui`** pointing to `tui.tsx` (shipped as source,
  compiled by OpenCode/Bun at runtime, like DCP). The main `tsconfig.json` stays
  NodeNext-friendly; a separate `tsconfig.tui.json` typechecks the TUI module with
  `jsx: preserve` and `jsxImportSource: @opentui/solid`.
- **Server-side `command.execute.before` no longer handles `/df-status` or
  `/df-help`.** It still handles `/df-profile` (edits config + reloads hook state)
  and `/df-verify` (runs the gate). They remain server-side because they mutate
  state or execute commands.
- **`format-status.ts` split.** Added `renderConfigStatus(config)` (stateless, used
  by the TUI module) and `renderHelp()` so the TUI module does not depend on live
  hook state. `renderStatus(config, state)` now composes the config portion plus
  the live state portion.

## v0.1.23 release decisions

- **TUI registration uses the current `api.keymap.registerLayer` API.** The
  previous `tui.tsx` registered commands via the deprecated `api.command` v1 API.
  That API is `undefined` in current OpenCode runtimes, so the `if (!commandApi)
  return;` guard silently bailed and `/df-status`/`/df-help` were never
  registered (the symptom: "not a valid command"). The module now registers
  exclusively through `api.keymap.registerLayer({ commands, bindings })`, which is
  exactly how DCP registers `/dcp`. This also removes dead deprecated code.
- **`df-profile` / `df-verify` results now use a TUI toast, not chat.** The old
  `command.execute.before` handler wrote results to `output.parts` (which is fed
  back to the model) or via the broken `client.session.prompt` messenger. Both
  leaked into the model. Results now surface via `client.tui.showToast` (visible,
  non-chat), stored as `HookState.showToast`. The `src/messenger.ts` helper and
  its test were deleted as dead code.
- **TUI module requires a `tui.json` entry (not just `opencode.json`).** Even
  after the `keymap.registerLayer` fix, `/df-status`/`/df-help` remained
  unregistered because the TUI plugin was never loaded. OpenCode's spec
  (`packages/opencode/specs/tui-plugins.md`) is explicit: **server plugins load
  from `opencode.json`; TUI plugins load from `tui.json`.** The `./tui` export is
  only consulted when the package is listed in a TUI config. DCP works with a
  single `opencode.json` entry only because it is an **npm** package and
  OpenCode 1.18.18 auto-resolves `./tui` from an npm entry; a **local
  filesystem path** does not get `./tui` auto-loaded. Confirmed by `grep` on the
  `opencode` binary (references `tui.json`, `registerLayer`, version 1.18.18).
  For local development, add the repo path to both `opencode.json` (server) and
  `tui.json` (project `.opencode/tui.json` or global
  `~/.config/opencode/tui.json`). The published npm package still works with a
  single `opencode.json` entry on 1.18.18+.
- **Validation:** 165 tests pass; format/lint/lint:md/typecheck/build all green.

## v0.1.25 release decisions (final — all four `/df-*` are TUI commands, no model turn)

- **TUI-only design (per user preference, m0106).** All four `/df-*` commands
  (`df-status`, `df-help`, `df-profile`, `df-verify`) are registered as **TUI
  commands** in `tui.tsx` via `api.keymap.registerLayer` with a `slashName` (plus
  the legacy `api.command?.register` fallback, mirroring DCP). TUI commands are
  UI-only: they never insert text into the chat stream, so they **cannot** leak
  into a model turn — exactly why `df-status`/`df-help` already worked.
- **`run(ctx)` does all the work:**
  - `df-status` / `df-help` → `run` opens a `DialogAlert` modal.
  - `df-profile` → `run` calls `handleProfile(api, dir, ctx?.input)`. OpenCode
    passes the command **name** (`"df-profile"`) as `ctx.input` for the bare
    command, which is normalized to the picker case (a `DialogSelect` with off /
    advisory / standard / strict; selecting one calls `changeProfile` + toast). If
    a build ever passes a real profile string as `ctx.input`, it is applied
    directly when valid; otherwise a usage toast is shown.
  - `df-verify` → `run` calls `handleVerify(api, dir)` which runs `verifyGate` and
    shows a `DialogAlert` + toast.
- **Argument form (`/df-profile standard`) is intentionally NOT supported.**
  In the current OpenCode runtime (v1.18.18) a command typed *with* an argument is
  routed to a model turn and never reaches the TUI `run` callback, so it still
  leaks `standard` to the model. We confirmed a `command.execute.before` server
  hook fires for TUI commands but **cannot suppress** the model turn (clearing
  `output.parts` does not stop it), and server *prompt* commands (`config.command`)
  likewise always produce a model turn. Per the user's decision we dropped the
  `command.execute.before` handler and any `config.command` registration for these
  commands entirely — they were dead/leaking code. The bare commands (picker /
  dialog) are the supported interface.
- **Shared command logic extracted to `src/commands.ts`.** `changeProfile`
  (writes the profile line via `setProfileInFile`, returns a message) and
  `verifyGate` (runs `runGate`, returns `{ report, summary }`) are called by the
  TUI `run` callbacks and the `dev_framework_set_profile` tool, so those two paths
  share one implementation. The server `command.execute.before` handler no longer
  exists.
- **Out-of-process config edits now reload automatically.** The `df-profile` TUI
  picker writes the config file directly (outside the server process), so the
  server's in-memory config would go stale. Added `HookState.configMtime` (set
  initially via `stat` in `devFramework`) and a `reloadConfigIfChanged(state)`
  helper in `src/index.ts` that stats the config file and, on mtime change,
  clears the config cache and reloads config + constitution via
  `loadConfig`/`loadConstitution`. Wired into every enforcement hook
  (`tool.execute.before`, `event`,
  `experimental.chat.system.transform`). This removes the need for a plugin
  restart after a `/df-profile` change.
- **`package.json` gained `pretypecheck`/`pretest` scripts (`npm run build`).**
  `tui.tsx` imports from `./dist/*.js` (gitignored) and CI runs `typecheck` and
  `test` before `build`, so the pre-scripts guarantee the dist exists.
- **Tests updated.** `tests/commands.test.ts` asserts the `config` hook registers
  **no** `df-*` prompt commands (all four are TUI commands) and still covers the
  `changeProfile`/`verifyGate` helpers. `tests/tui.test.ts` now expects 4 TUI
  commands and exercises the status dialog and the `df-profile` picker.
- **Validation:** 167 tests pass; format/lint/lint:md/typecheck/build all green.
- **Documented limitation (arg form leaks in this runtime).** Because the argument
  form cannot be intercepted for a TUI command, `/df-profile standard` will still
  hit the model in OpenCode v1.18.18 — that is a known limitation, not a fixable
  leak in the TUI-only design. Use the bare `/df-profile` picker. To verify,
  rebuild, clear the OpenCode plugin cache
  (`~/.cache/opencode/packages/opencode-dev-framework*`), restart OpenCode, and
  test `/df-status` (modal) and bare `/df-profile` (picker).

## v0.1.28 release decisions (seamless off → standard transition)

- **Root cause of `state.log is not a function` on a runtime profile switch.**
  Before this change, `devFramework` early-returned `{}` (no hooks) for
  `profile: off`. Because the per-hook `HookState` (which carries `log`) was
  only populated inside `buildHooks` for non-`off` profiles, switching from
  `off` to `standard` at runtime via `/df-profile` left a hook that was
  registered against a `HookState` whose `log` was `undefined`. The next
  enforcement hook call threw `TypeError: state.log is not a function`. A full
  OpenCode restart worked because the plugin re-ran `devFramework` with the new
  profile and populated `HookState.log` correctly.
- **Fix: always register hooks, gate by profile (seamless transition).**
  `devFramework` no longer early-returns for `off`; it always runs
  `setBaseDirectory` and `setHookState` (populating `log` at init). Each
  enforcement hook now performs its own `if (state.config.profile === "off") return;`
  guard right after `reloadConfigIfChanged(state)`:
  - `experimental.chat.system.transform` (before constitution injection),
  - `tool.execute.before` (before `checkToolCall`),
  - `event` (before `file.edited` / `session.idle` processing).
  `session.stopping` already bailed on `off`. This makes the
  behavior driven by the live config, not by registration, so an
  out-of-process `/df-profile` write is picked up on the next hook call via
  `reloadConfigIfChanged` — no restart required.
- **Defensive `safeLog` fallback.** Added a module-level `fallbackLog` (set to
  the real `createLogger(ctx.client)` inside `devFramework`) and a `safeLog`
  helper that calls `state.log` when it is a function, otherwise `fallbackLog`.
  This guarantees a hook can never crash on a missing `log` even if
  `HookState.log` is somehow undefined (e.g. direct `buildHooks` callers in
  tests that pass no logger). `buildHooks` is the composition root and is used
  directly by tests; in production it is always reached through `devFramework`,
  which always sets `fallbackLog`.
- **Test contamination gotcha (same-file, module-level `sessionToDirectory`).**
  `sessionToDirectory` is a module-level `Map` keyed by `sessionID`. Once a test
  registers the `experimental.chat.system.transform` hook and calls it with a
  given `sessionID`, that `sessionID` is pinned to the test's project directory
  for the lifetime of the test file. Reusing `sessionID: "s1"` across tests
  (one with `off`, later ones with `strict`/`advisory`) made the later tests'
  `tool.execute.before` resolve the `off` state and no-op. Fixed by giving every
  test a unique `sessionID` (`off-s1`, `strict-s1`, `adv-s1`, `tx1`–`tx5`). This
  is a test-only concern; real OpenCode sessions use a stable, unique `sessionID`
  within a session and do not collide.
- **`tool.execute.before` reads `output.args`, not `input.args`.** Confirmed the
  hook reads tool arguments from `output.args` (matching the documented OpenCode
  `tool.execute.before` signature in this file's Phase-3 notes). The transition
  regression tests previously passed args in `input.args`; corrected to
  `output.args` so the guardrail actually evaluates them.
- **New regression tests.** `tests/transition.test.ts` (5 tests) covers the
  off→standard transition (inject after switch), off no-inject, off `tool.execute`
  no-op, strict still blocks, and the missing-`log` `safeLog` fallback.
  `tests/smoke.test.ts` now asserts hooks are registered even for `off` (the
  off-guard is what makes them inert), and its strict/advisory guardrail tests
  use unique session IDs.
- **Validation:** 180 tests pass; format/lint/lint:md/typecheck/build all green.

## Future work — Effect-API rewrite (post-process, not scheduled)

**`@opencode/plugin/effect` evaluation (deferred):** the V2 Effect entrypoint
(`Plugin.define` via `@opencode/plugin/effect` + `effect` package, scoped
plugin effect with finalizers/fibers/registrations auto-released on reload)
could replace the hand-rolled `AbortController` + manual `Registration.dispose()`
event loop in `src/index.ts`. Current approach works and is regression-covered
by `tests/teardown.test.ts` (Phase 20), so migration is churn with no behavior
gain today. Re-evaluate when: (a) the promise API shows strain (leaked loops,
reload races the stale-guard can't cover), (b) we need structured concurrency
for parallel gate runs, or (c) the Effect API goes stable (it is beta, same as
the promise API). Spike first: port only the `event.subscribe` loop to an
Effect fiber with a finalizer, compare teardown behavior against
`teardown.test.ts`, then decide. Do NOT rewrite the whole plugin to Effect
without that spike + peer review.

**Re-checked 2026-10-09 (no code changed):** triggers still unmet — (a) no
strain observed (see strain probe below), (b) gate steps still run
sequentially (`Promise.all` would cover parallelism if ever needed), (c)
`@opencode/plugin@2.0.26` pins `effect@4.0.0-rc.112` — Effect 4 is still a
release candidate. Two corrections since first writing (paragraph above now fixed): the entrypoint
path was originally recorded here as `@opencode/plugin/v2/effect` — it is
`@opencode/plugin/effect` — and
"port only the loop" is narrower than it sounds — the Effect `Stream`
`subscribe` is only reachable through the Effect `Context`, so a
promise-entrypoint spike would manage its own `Runtime` + `Scope` (fiber
interruption without the auto-release-on-reload payoff), while the full
payoff requires switching the whole plugin to the Effect entrypoint (all
hooks move to the Effect domain APIs; `teardown.test.ts`'s `setup()`
harness shape changes). Either route also adds `effect@4.0.0-rc` as a
direct dependency, which needs explicit approval under the
lightweight-deps convention.

**Strain probe (2026-10-09, `tests/teardown.test.ts`):** rapid setup/teardown
cycles (5x) with hanging abort-ignorant streams, late idle events into every
dead stream (stale guard must drop them, live loop must still re-prompt via
a hermetic failing-gate config), plus throwing subscribers (sync throw and
mid-iteration throw must neither break `setup()` nor brick the session).
Result: no leaks, no double-enforcement, no unhandled rejections — the
promise loop holds. This stays deferred.

## v0.2.5 upgrade probe: 2.0.11 → 2.0.26 (Phase 21, 2026-10-09)

Branch `chore/plugin-2.0.26`. `package.json`: `@opencode/plugin ^2.0.11` →
`^2.0.26`; `@opentui/{core,keymap,solid}` `^0.5.1x` → `^0.5.17` (required:
plugin 2.0.26 declares `peerOptional @opentui/core|solid >=0.5.17`; bare
`npm install @opencode/plugin@2.0.26` fails with ERESOLVE otherwise).
Pulled transitive: `@opencode/{ai,client,protocol,schema,util}` all `2.0.26`,
`effect 4.0.0-rc.112` (unchanged). Note: plugin 2.0.26 dropped `zod` from its
own deps (was `4.1.8`); our direct `zod ^4.4.3` dep is unaffected.

Validation on 2.0.26, no source changes: `typecheck` green, `build` green,
`test` **169/169 pass** (14 files). No breakage — the 4x `as any` casts hide
everything, which is exactly why Phase 22 types the hooks.

SDK type diff (`dist/promise/*.d.ts`, 2.0.11 → 2.0.26):

- `SessionHooks` keys UNCHANGED: `prompt/context/compaction/generate/title/
  model.request/http.request/http.response/experimental.ws.*/retry`. **No
  `request` hook exists in the installed SDK** — web docs describing
  `ctx.session.hook("request", {system, messages, tools})` do not match this
  export path (`@opencode/plugin`, `./promise`). `context: SessionContext
  extends SessionRequest + agent + tools` is the same shape under its real
  name, so our `context` hook is correct and no rename is needed. Treat
  `request` as docs-ahead-of-SDK (or a `@opencode-ai/plugin/v2` export
  difference); re-check on the next upgrade.
- `SessionDomain` (actions) gained two: `remove` and `compact` (were absent in
  2.0.11). Unused by us; `compact` may matter for the compaction-hook story
  later — recorded, not adopted.
- `ToolContext` gained `signal: AbortSignal` (was only `progress`). Our custom
  tools ignore it (short config ops); no change needed.
- `PermissionEvaluation` / `PermissionHooks`, `CommandDomain`,
  `StorageDomain`, `Context` keys: all UNCHANGED. Phase 23/25/26 premises hold.
- `stopping` still absent from `SessionHooks` — defensive probe stays.

Decision: UPGRADE. No blockers. Proceed to Phase 22 on this branch.

## Phase 22 notes (type hardening + `title`, 2026-10-09)

- All hooks typed via SDK inference (`ctx.session.hook("context" | …)`,
  `ctx.tool.hook("execute.before")`, `ctx.tool.transform`); `grep "as any"
  src/` = 1 hit, the defensive `stopping` probe (not in `SessionHooks` as of
  2.0.26, PR #44712). The cast stays until core dispatches `stopping` or the
  SDK types it — typing it away would silently drop the registration.
- `title` joins the constitution loop; `SessionTitle.system` is required, so
  the `if (!event.system) return` guard is dead-but-harmless uniformity with
  the loop body.
- Peer-review skill gate (3 specialists, parallel): no drift, no style
  issues, no correctness issues. Verdict recorded in the Phase 22 commit
  message.

## Phase 23 notes (storage-backed block counts, 2026-10-09)

- `src/block-store.ts`: `BlockStore` over `ctx.storage` (keys
  `df:blocks:<sessionID>`, `df:stopSupported`), write-through into the
  existing `blockCounts` Map so `format-status.ts` keeps reading live data.
  `evaluateCompletion` now takes the store (`increment`/`clear`) instead of
  the raw Map. Assumption: session IDs are globally unique, so the keys are
  safe even if storage is shared across projects.
- Fallback never masks: any storage throw sets `isDegraded()` (only counts
  and one boolean are ever stored — no secrets); setup logs a warn when
  degraded after hydration. Stored values are validated (`asCount`); corrupt
  values are treated as missing and overwritten.
- Peer-review skill gate: code-reviewer clean; pattern-guardian +
  style-enforcer found 4 Should-fix items (mid-file import, docstring-after-
  import, unsorted test import, undocumented index/registry HookState fork) —
  all fixed, suite re-greened. Verdict recorded in the Phase 23 commit
  message.

## Phase 24 notes (per-edit lint via execute.after, 2026-10-09)

- `execute.after` is now the primary per-edit path: typed hook, edit tools
  (`FILE_TOOLS` from `protect.ts`, shared with the `execute.before`
  taxonomy) with `completed` status → `tracker.add` + shared
  `runPerEditLint` flow; `error` status tracks without linting; read-only
  tools and path-less events return early. Never throws (reports only).
- `runPerEditLint` extracts the old `filesystem.changed` inline block
  unchanged (same guards, args, log levels); the fallback branch now
  `has()`-checks first (debug log on already-tracked, so one edit yields
  one lint, not two) and stays for one release as the shell-edit safety net
  (`bash` heredocs carry no file path in tool input). `has`/`add` share one
  `normalizeTrackedPath` helper, both call sites pass `state.directory`.
- 24.4 is NOT done here: the one-lint-per-edit real-session check needs a
  live OpenCode session (user action). The filesystem branch must stay until
  that check passes, then schedule its deletion.
- Peer-review skill gate (3 specialists, parallel): no drift, no style
  issues, no correctness issues. Verdict recorded in the Phase 24 commit
  message.

## Phase 24 verification (24.4, real session, 2026-10-09)

- **Verdict: PASS.** Drove the full loop from this box (user asked to hand
  over driving): probe wrapper as the `.go` lint command (appends
  `lint-ran <file>` then execs the real `golangci-lint` by absolute path),
  one agent `Edit` via `opencode run` on a standalone `--print-logs`
  server. Result: exactly **1** `lint-ran` marker + one `info "lint
  passed for internal/httpapi/httpapi.go"` per edit — not zero, not two.
  No `already-tracked` fallback line fired (this build did not emit
  `filesystem.changed` for the edit at all). Suite: 187/187 still green
  (no src changes for 24.4). All probe artifacts reverted in animeRSS
  (config, wrapper, scratch file, my probe comment lines; the user's own
  probe line kept).
- **Incidental guardrail proof:** with the plugin correctly loaded, an
  `Edit` to `.env.probe` was denied with `edit on protected path
  ".env.probe" is blocked (matched ".env*")` — enforcement live
  end-to-end. All earlier "successful" protected edits in this saga were
  made while the plugin was absent (see below), not bypasses.

## Plugin-registration discovery (v2.0.26, 2026-10-09)

Real-session debugging surfaced a registration trap future sessions must
know (README install section updated accordingly):

- The shared `opencode serve --service` backend (not the TUI process)
  executes plugin code, so `OPENCODE_DEV_FRAMEWORK_LOG_FILE` must be in
  the **server's** environment — a TUI-side export is invisible. Used
  `opencode run --standalone --print-logs` (private server, env
  inherited) for full observability instead of restarting shared infra.
- `~/animeRSS/.opencode/opencode.json` with the V1 singular `"plugin"`
  key is **silently ignored** on v2 (and `opencode plugin list`
  misleadingly still displays the entry). The working project file is the
  root `opencode.json[c]` with the plural `"plugins"` key.
- Local directory entries resolve the entrypoint as `<dir>/index.js`
  (`<dir>/server.js` also observed for operator-memory) and **ignore
  `package.json` `main`**. A repo-root path fails silently (`Plugin
  entrypoint not found`, visible only in `/plugins` or server logs) with
  zero hooks running — including zero guardrails. Working form:
  `"plugins": [{ "package": "/path/to/opencode-dev-framework/dist" }]`
  (object→dist verified; object→root and string→root both fail).
- `GET /api/*` needs auth (401 on bare curl); `opencode api plugin.list`
  handles auth but resolves location to the server default, so it cannot
  show project-scoped plugin states. Server `--print-logs` + `loading
  plugin` lines are the reliable load signal.

## Phase 25 spike — `permission.evaluate` real shapes (25.1, 2026-10-09)

Drove from this box: standalone `--print-logs` server in animeRSS with
the spike hook logging every evaluation. OpenCode v2.0.26,
`PermissionEvaluation = {sessionID, agent?, action, resources[],
metadata?, source?, effect, message?}` with
`Effect = "allow" | "deny" | "ask"`. Observed (never guessed):

- File edit via edit tool: `action="edit"`,
  `resources=["internal/httpapi/httpapi.go"]` (repo-relative),
  `metadata.files=[{file, patch, status:"modified", additions, deletions}]`,
  `source={type:"tool", messageID, id}`, `effect="allow"`.
- File create via **write** tool: `action="edit"` (NOT `"write"`),
  `resources=["PERM-SPIKE-25-1.tmp"]`,
  `metadata.files=[{status:"added", ...}]`.
- Shell via **bash** tool: `action="shell"` (NOT `"bash"`),
  `resources=["echo spike-done"]` (raw command string), no metadata.
- The `toPermissionGuard` mapper (`src/protect.ts`) adapts exactly these
  two shapes into the existing `checkToolCall` verdicts and abstains
  (`null`) on anything else — unknown actions, empty resources.

Firing-coverage finding — SOLVED (follow-up investigation, same day):
`evaluate` skipping block-worthy calls is NOT an engine quirk. Controlled
sandbox experiments (isolated `/tmp` project, debug server logs, DCP ruled
out — it registers no evaluate hook, zero `permission.asked` events on the
bus) proved the pipeline runs **`execute.before` FIRST**: a custom-guarded
`notes-guard-*.txt` edit (no engine heuristic could flag it) still skipped
evaluate while the backstop blocked it, and flipping to `advisory` produced
TWIN warn lines — one per layer — for the same call. So evaluate only ever
sees calls the backstop already passed, with identical matchers and config.
In `standard`/`strict` the native layer is therefore structurally redundant
(but harmless); its value is defense-in-depth if core ever reorders the
pipeline or adds paths bypassing tool hooks. One real wart found and fixed:
advisory double-warned — the evaluate warn path now logs at debug (the
backstop already warned). The mapper's core invariant stands (peer-review
focus): it only ever denies or abstains, never allows — it cannot weaken
host/engine enforcement. Live enforcement check 2026-10-09: protected edit
denied, file byte-identical, via the backstop. All spike artifacts reverted
in animeRSS.

## Phase 26 verdict — DROP both, with evidence (2026-10-09)

Both spikes ran live against the shared backend (OpenCode v2.0.26) from an
isolated `/tmp/odf-26` sandbox (own `opencode.jsonc` → our `dist/`,
standard profile). All sandbox artifacts removed afterwards.

### 26.1 `command.transform` — probe dropped, but the SPIRIT reshaped into a shipped tool

The probe-command delivery matrix (void=silent, throw=CommandExecutionError,
zero token delta) proved the mechanism but weakens our UX, so the primitive
was dropped. However the *real* question — "can the agent invoke the gate
mid-session, server-side?" — has a better answer than the command: a
**custom tool**. Shipped: `dev_framework_verify` (server-side
`ctx.tool.transform`), which runs `runGate` and returns the summary as
tool `{content}` — delivered into the conversation automatically (the
`{content}` return is SDK-guaranteed, same delivery path as the long-shipped
`dev_framework_status`). Unlike the TUI modal, the report lands IN the
model's context, so the agent can read and react to it — and unlike the
idle gate it never re-prompts.

- Live verification (2026-10-09, sandbox, `--model kimi-code-plan-global/kimi-for-coding`):
  gate ran (typecheck step executed), agent reported
  `completion gate passed / typecheck: passed` back. (Agent-side note: it
  reached the tool via Code Mode after two namespace-form misfires —
  `tools.dev_framework_verify({})` — a model quirk, not a plugin bug.)
- Why not the command primitive: throw-on-fail / silent-on-pass delivery,
  plus a duplicate `/df-verify` slash-menu entry risk unverifiable headlessly.
- Why not just the TUI modal: the modal is strictly richer where the TUI
  exists, but it does not put the report into the model's context.
- Future trigger recorded: non-TUI frontends (web/IDE/ACP) wanting a
  headless gate → the probe's throw-on-fail delivery path is known.

### 26.2 `session.interrupt` — mechanism PROVEN, integration DROPPED

- `session.interrupt --param sessionID=…` on a session mid-`sleep 90`
  returned `{"interrupted":true}`; the run aborted promptly (`Tool
  execution interrupted` / `Step interrupted`), session outcome
  `interrupted`. The stop mechanism genuinely works.
- DROP reasons (no safe call site in this architecture): at `session.idle`
  the session is idle by definition (nothing to interrupt); inside
  `execute.before/after` interrupting would abort the very turn being gated
  (the throw/deny already handles the call with feedback intact); a timer
  watchdog is out-of-scope creep for this event-driven plugin.
  Future trigger: a runaway-loop watchdog (e.g. around `doom_loop`) — the
  stop primitive is proven, no re-spike needed.

## Phase 27 notes (docs, release prep, 2026-10-09)

- README accuracy sweep (the 27.3 review focus): fixed four stale claims —
  (1) the "What it does" slash-commands paragraph still described the Phase 17
  server-side design (empty template + toast); all four commands are TUI
  keymap-layer modals since Phase 18. (2) `strict` row claimed per-edit lint
  "throws" — `runPerEditLint` only ever reports (the edit already landed).
  (3) `/df-profile` argument form "not wired up" — `tui.tsx` wires it
  (direct switch + toast). (4) min-version `v2.0.0+` → `v2.x`, tested on
  `v2.0.26`.
- Added the missing pieces: `dev_framework_verify` in the custom-tools bullet,
  a new **Enforcement layers** table (pre-flight hard block; guardrails =
  `execute.before` load-bearing + `permission.evaluate` defense-in-depth;
  per-edit lint report-only; gate async-bounded + defensive stopping veto),
  and a debugging note (plugin runs in the serve backend — TUI env never
  reaches it — use `--standalone --print-logs`; no `cli.json` interaction).
- Example config check: `examples/go-service/.opencode-dev-framework.yml`
  loads clean via `loadConfig` (profile standard, `gate.max_blocks` 3).
  No changes needed.
- Versioning: do NOT bump by hand — `scripts/release.sh` owns it
  (`npm run release:minor` validates, bumps `0.2.4` → `0.3.0`, commits,
  tags; then `git push origin main --tags` and CI publishes to npm).
  A manual 0.3.0 edit was made and reverted for exactly this reason.
  Tag + push remain user actions (never push from agent sessions).
- Released 2026-10-09: user ran `npm run release:minor` (needed one
  `ac58c67` biome-format fixup first — two whitespace hunks the earlier
  `format:check` had passed, cause unknown), then pushed release commit
  `7f84b81` with tag `v0.3.0`; CI publishes to npm from the tag.

## References

- OpenCode plugin docs: <https://opencode.ai/docs/plugins>
- OpenCode permissions docs: <https://opencode.ai/docs/permissions>
- OpenCode formatters docs: <https://opencode.ai/docs/formatters>
- OpenCode commands docs: <https://opencode.ai/docs/commands>
- Original inspiration: <https://github.com/anticomputer/dev-framework>
