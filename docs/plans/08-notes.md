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
- **`experimental.session.stopping` gate.** The hook from OpenCode PR #41811
  is registered with a local type assertion (`HooksWithStopping`). On gate
  failure it pushes a concise synthetic user message and continues the loop,
  up to `gate.max_blocks` times per session. After the max it stands down with
  a warning. The `session.idle` hook remains as a fallback for older OpenCode.
- **Session-to-directory mapping.** `experimental.chat.system.transform`
  records `sessionID → directory` so the `session.stopping` hook (which only
  receives a session ID) can look up the right hook state.

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
  own block when the host permission model already denies the same tool/target,
  avoiding redundant/conflicting blocks.
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

## v0.1.25 release decisions (corrected — DCP `keymap` + `slashName` pattern)

- **All four `/df-*` commands register via the TUI `keymap.registerLayer` with a
  `slashName` field** (`tui.tsx`, the `opencode-dev-framework/tui` module). The
  `slashName` is the key: it makes OpenCode recognize `/df-profile <arg>` *with*
  an argument and route the trailing text to the server `command.execute.before`
  hook carrying `input.arguments` — exactly how DCP registers `/dcp`. No command
  feeds text to the model:
  - `df-status` / `df-help` → `run` opens a `DialogAlert` modal (state / help).
  - `df-profile` → `run` opens a `DialogSelect` picker (off / advisory /
    standard / strict); picking an option calls `changeProfile` + toast.
  - `df-verify` → `run` calls `verifyGate` and shows a `DialogAlert` + toast.
  - The **no-argument** case is fully handled inside the TUI `run` callbacks, so
    no chat text is produced.
  - The **with-argument** case (`/df-profile standard`) is intercepted by the
    server `command.execute.before` hook, which validates/handles the argument,
    shows a toast, and **clears `output.parts`** (`output.parts.length = 0`) so
    the argument never reaches the model. This mirrors DCP's
    `command.execute.before`, which clears the parts when handling `/dcp <sub>`.
  - **`registerCommands` also keeps a legacy `api.command?.register` fallback**
    (exactly as DCP does): if `keymap.registerLayer` is unavailable, it registers
    the same entries via the v1 API with `slash: { name }`. This maximizes
    recognition across OpenCode 1.18.x builds. When neither API is present the
    registration is a safe no-op.
- **The server plugin does NOT register these commands in the `config` hook.**
  Registering them as prompt commands there does NOT make OpenCode recognize them
  with arguments (the v0.1.25 first-cut attempt did this and it was worse: no
  picker on the bare command and the model fired on `/df-verify`). Recognition is
  purely via the TUI `keymap.registerLayer` `slashName` field.
- **Why v0.1.24 leaked the argument.** v0.1.24 registered the four commands as
  `keymap` entries *without* `slashName`, so OpenCode only matched them without
  arguments. `/df-profile` (no arg) opened the picker correctly, but
  `/df-profile standard` was treated as a plain chat line and `standard` leaked
  to the model. Adding `slashName` to every entry fixes recognition for both the
  bare and argument forms.
- **Shared command logic extracted to `src/commands.ts`.** Added
  `changeProfile(directory, profile)` (writes the profile line via
  `setProfileInFile`, returns a message) and `verifyGate(run, directory, config?,
  changedFiles=[])` (runs `runGate`, returns `{ report, summary }`). The TUI
  `run` callbacks, the server `command.execute.before` handler, and the
  `dev_framework_set_profile` tool all call them, so every path shares one
  implementation. `tui.tsx` imports `changeProfile`/`verifyGate` from
  `./dist/commands.js`, `runCommand` from `./dist/host.js`, `loadConfig` from
  `./dist/config.js`, and `Profile` from `./dist/types.js`.
- **Out-of-process config edits now reload automatically.** `/df-profile` (TUI
  picker or server arg) writes the config file directly (outside the server
  process), so the server's in-memory config would go stale. Added
  `HookState.configMtime` (set initially via `stat` in `devFramework`) and a
  `reloadConfigIfChanged(state)` helper in `src/index.ts` that stats the config
  file and, on mtime change, clears the config cache and reloads config +
  constitution via `loadConfig`/`loadConstitution`. Wired into every enforcement
  hook (`tool.execute.before`, `event`, `experimental.session.stopping`,
  `experimental.chat.system.transform`). This removes the need for a plugin
  restart after a `/df-profile` change.
- **`package.json` gained `pretypecheck`/`pretest` scripts (`npm run build`).**
  `tui.tsx` imports from `./dist/*.js` (gitignored) and CI runs `typecheck` and
  `test` before `build`, so the pre-scripts guarantee the dist exists.
- **Tests updated.** `tests/commands.test.ts` asserts the `config` hook registers
  **NO** `df-*` prompt commands, and covers `changeProfile`/`verifyGate` plus the
  `command.execute.before` handling (no-arg early-return leaves parts untouched;
  valid/invalid `df-profile` arg applies/suppresses; `df-verify` with a non-empty
  arg runs the gate and suppresses output). `tests/tui.test.ts` now expects 4
  commands and exercises the `run` callbacks (status dialog, profile picker with
  4 options, verify runs without throwing).
- **Validation:** 172 tests pass; format/lint/lint:md/typecheck/build all green.
- **Testing caveat (user-reported leak was a stale build / plan-mode test).** After
  the keymap+`slashName` fix, `/df-profile standard` should no longer reach the
  model. A leak observed in a running session was almost certainly one of: (1) the
  OpenCode process was started before the rebuilt `dist/` was in place, (2) the
  plugin cache (`~/.cache/opencode/packages/opencode-dev-framework*`) still held an
  older build, or (3) the command was typed while OpenCode was in **plan mode**,
  where slash-command routing differs. To verify, rebuild, clear the cache, restart
  OpenCode in execution (non-plan) mode, and test `/df-status` (modal) before
  `/df-profile standard`.

## References

- OpenCode plugin docs: <https://opencode.ai/docs/plugins>
- OpenCode permissions docs: <https://opencode.ai/docs/permissions>
- OpenCode formatters docs: <https://opencode.ai/docs/formatters>
- OpenCode commands docs: <https://opencode.ai/docs/commands>
- Original inspiration: <https://github.com/anticomputer/dev-framework>
