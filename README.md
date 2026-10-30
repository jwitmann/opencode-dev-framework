# opencode-dev-framework

An [OpenCode](https://opencode.ai) plugin that enforces project-specific
quality gates during AI coding sessions — and verifies whole tasks, not just
edits, through `/df-goal`. Inspired by
[anticomputer/dev-framework](https://github.com/anticomputer/dev-framework),
reimplemented as an OpenCode-native plugin.

## What it does

- **Constitution injection.** Adds a project constitution (quality bar, test
  discipline, focus rules) to the system prompt at session start. Ships with a
  bundled default split into numbered rule files. Override it by dropping files
  in `.opencode/opencode-dev-framework/rules/`, by setting explicit `rules`, or
  by letting the plugin auto-discover `STYLE.md` / `CONTRIBUTING.md`.
- **Guardrails.** Blocks or warns on edits to protected paths (`.env` files,
  `node_modules`, vendored code, your own globs) and on dangerous shell
  commands (`git push`, `rm -rf`, `git reset --hard`, ...).
- **Per-edit lint.** Runs your configured linter on each file the agent edits
  and reports failures loudly. Optionally delegates per-file linting to
  `pre-commit run --files` when `precommit: auto` is set.
- **Completion gate.** At the would-go-idle boundary (`session.hook("experimental.idle")`,
  with an `idle` alias registered for a future rename), runs typecheck, tests,
  named acceptance commands (`gate.acceptance`), and (optionally) lint on changed files — changed files are
  tracked from edit events and cross-checked against `git status`, so the gate cannot
  silently skip due to an event-shape mismatch. In `standard`/`strict`, sessions that
  changed files must also produce a **peer-review artifact**
  (`.opencode/opencode-dev-framework/review.md`) covering the delegation rule's review
  cadence. On failure inside `gate.max_blocks` the plugin admits a synthetic
  continuation in the same execution with the failure summary. The
  `event.subscribe` idle net catches the boundaries the hook skips
  (interruption, failure, steer-parked drains) — deduped so one boundary never
  runs the gate twice, synthetic-first with `prompt` only as fallback.
  `/df-status` shows `Continuation (idle): active` once the hook has completed
  an evaluation, else the event-subscribe fallback.
- **Verified goals (`/df-goal`).** Runs a whole task — typically a written
  plan — inside a native `/goal` with a verification contract appended:
  the agent must produce a `dev_framework_verify` PASS on the final tree,
  and the native reviewer weighs that tool result as completion evidence.
  Refuses vacuous configs, non-blocking profiles, and goal-less cores
  instead of starting an unverified substitute. See *Slash commands* below.
- **Pre-flight gate (optional).** When a `preflight:` task list is configured, edit
  tools are **denied** (standard/strict) until the agent writes its pre-flight findings
  to `.opencode/opencode-dev-framework/preflight.md`. Use it for work that requires
  establishing baseline state/knowledge first (e.g. research on an existing strategy).
  Read-only tools stay open; the block lifts automatically once the artifact exists.
- **Custom tools.** `dev_framework_init` scaffolds project-level agents,
  skills, local rules directory, and config; `dev_framework_set_profile` changes the profile
  in-session without restarting; `dev_framework_status` reports the current
  profile, guardrails, gate, and tracked changed files; `dev_framework_verify`
  runs the completion gate on demand and returns the summary to the agent.
- **CLI installer.** `df init` auto-detects your language and writes a config
  with sensible commands; `df profile <name>` changes the profile from the
  shell; `df status` / `df version` report template state and the version.
- **Slash commands.** The plugin registers four TUI commands that open instant
  modal dialogs and never feed anything to the LLM: `/df-status`, `/df-help`,
  `/df-profile` (bare for a picker, or with an argument), and `/df-verify`
  (runs the gate manually). `/df-goal <objective>` is a server-side command
  instead: it starts a verified native goal (see *Slash commands* below). The `dev_framework_*` custom *tools* above remain
  available for in-agent use.

## Profiles

| Profile    | Guardrails | Gate failures | Lint on edit | Pre-flight | Review required | Notes |
| ---------- | ---------- | ------------- | ------------ | ---------- | --------------- | ----- |
| `off`      | disabled   | not reported  | no           | no         | no              | Plugin registers no hooks at all. |
| `advisory` | warn       | warn          | yes          | warn only  | warned, not blocked | Nothing blocks; everything is logged. |
| `standard` | deny       | error         | yes          | deny edits | blocks completion | The default when a config file exists. |
| `strict`   | deny       | error         | yes          | deny edits | blocks completion | Also lints changed files in the gate; per-edit lint failures are reported loudly (error level — the edit already landed, so nothing throws there). |

## Enforcement layers

How each mechanism is enforced on OpenCode `v2` (idle hook landed via
[`anomalyco/opencode#59437`](https://github.com/anomalyco/opencode/pull/59437)):

| Mechanism | Primary layer | Backstop / fallback | Strength |
| --------- | ------------- | ------------------- | -------- |
| Pre-flight gate | `tool.execute.before` deny | — | **Hard block** on every build: the edit never lands. |
| Protected paths + dangerous commands | `tool.execute.before` deny/throw (load-bearing: the pipeline runs before-hooks first) | `permission.evaluate` native layer (deny) as defense-in-depth — it only ever sees calls the primary already passed; matters if core ever reorders the pipeline | **Hard block** via the primary deny; the native layer is belt-and-braces, never a weakening (it only denies or abstains). |
| Per-edit lint | `tool.execute.after` track + lint | `filesystem.changed` event (this release) | Report-only: the edit already landed, so failures log loudly but never throw. |
| Completion gate | `session.hook("experimental.idle")` (+ `idle` alias) → `session.synthetic` (same execution) | `event.subscribe` idle net for the boundaries the hook skips (deduped; synthetic-first, `prompt` fallback) | **Async, bounded** by `gate.max_blocks`. `/df-status` shows `Continuation (idle): active` vs the event-subscribe fallback. `execute.before` stays the only true hard wall. |

## Install

```bash
npm install opencode-dev-framework
```

Then add the plugin to your project's `opencode.jsonc`:

```json
{
  "plugins": ["opencode-dev-framework"]
}
```

Requires OpenCode `v2.x` (`@opencode/plugin` `^2`) — tested on `v2.0.26`. On `v1.18.18–1.18.31` use the `v1` branch
of this plugin (`plugin` key). The `./tui` companion (`/df-status` and `/df-help`
modals) is auto-discovered from the npm entry on `v2` — no separate `tui.json` needed.

Finally, scaffold the project-level files (agents, skills, local rules directory,
and default config) into your repo with the bundled `df` CLI:

```bash
npx df init          # if installed locally as a project dependency
# or, after npm i -g opencode-dev-framework:
df init
```

`df init` is interactive by default: it asks before overwriting existing files.
Use `--skip-existing` or `--overwrite-existing` for non-interactive runs.
`df init` auto-detects your project's language and writes a matching
`.opencode-dev-framework.yml` with sensible commands. `df status` shows what is
and isn't scaffolded; `df profile off|advisory|standard|strict` changes the
profile from the shell; `df version` prints the plugin version.

## Local development and testing

To test the plugin from source without publishing to npm, point OpenCode at the
local repository **root** in your project's `opencode.jsonc`:

```json
{
  "plugins": [{ "package": "/home/jerome/opencode-dev-framework" }]
}
```

The root path resolves through the package's `exports` map, so one entry
loads **both** parts: the server (`dist/index.js` — hooks, guardrails, gate,
custom tools) and the TUI (`tui.tsx` — `/df-status`, `/df-help` modals).
Rebuild after every source change (`npm run build`) since OpenCode loads the
compiled `dist/` output:

```bash
npm run build
```

### Important caveats

- Register the plugin **exactly once** per project. Plugin arrays **merge**
  across config files (global `opencode.jsonc`, project `./opencode.jsonc`,
  `./.opencode/opencode.json[c]`), so a second entry in another file —
  even one pointing at a different path of the same repo such as `dist/`
  — loads the same plugin ID twice and the duplicate fails with
  `Duplicate plugin ID: opencode-dev-framework` (check
  `opencode api get "/api/plugin?location[directory]=/path/to/project"`).
  If a session loads an unexpected plugin source, check all three locations.
- Do **not** point the entry at `dist/` directly: a bare directory without
  `package.json`/`exports` resolves only the server part, so the TUI
  commands (`/df-status`, `/df-help`) never load. (On OpenCode `v2.0.x` the
  entrypoint resolved as `<dir>/index.js` and ignored `package.json`, which
  is why older revisions of this section recommended `dist/` — verified on
  `v2.2.0` that the root path resolves correctly through `exports`. The
  `.opencode/tui.json` listing from that era is likewise no longer needed:
  one `plugins` entry loads every part.)
- OpenCode caches downloaded plugins in
  `~/.cache/opencode/packages/opencode-dev-framework*/`. If you previously
  loaded a published version and then switch to a local source, clear that
  cache so OpenCode does not reuse the old build:

  ```bash
  rm -rf ~/.cache/opencode/packages/opencode-dev-framework*
  ```

## Configuration

Create `.opencode-dev-framework.yml` in your project root. The easiest way to
override the bundled constitution is to run `df init` and then add Markdown
files to `.opencode/opencode-dev-framework/rules/`.

```yaml
profile: standard

commands:
  typecheck: "go build ./..."
  test: "go test ./..."
  lint:
    ".go": "golangci-lint run {dir}"

protect:
  - ".env*"
  - "deploy/prod/**"

gate:
  run_typecheck: true
  run_tests: true
  block_on_failure: true
  # standard/strict default: sessions that changed files must produce a
  # peer-review artifact (.opencode/opencode-dev-framework/review.md)
  # before the completion gate passes.
  require_review: true

# Optional: pre-flight task list. When set, edit tools are denied
# (standard/strict) until the agent writes its findings to
# .opencode/opencode-dev-framework/preflight.md.
# preflight:
#   - "Summarize the current strategy configuration and its intent"
#   - "Load the most recent backtest results and record headline metrics"

on_edit:
  lint: true

# Optional: delegate per-file linting to pre-commit when available
# precommit: auto

# Optional: explicit rule files (replace bundled; use mode: append to extend)
# rules:
#   - docs/team-rules.md

# Optional: project style guide appended to the constitution.
# Auto-discovers STYLE.md / CONTRIBUTING.md / docs/STYLE.md when not set.
# style_guide: STYLE.md
```

The legacy `.dev-framework.yml` flat-key format is read as a fallback for
compatibility, but the native format above is preferred. See
[`docs/plans/03-config-spec.md`](docs/plans/03-config-spec.md) for the full
config reference and [`examples/go-service/`](examples/go-service/) for a
complete example.

## Slash commands

Five slash commands are **TUI commands** registered by the bundled `./tui`
companion module (see *Local development* above for the `tui.json` requirement).
They open instantly and **never** feed text back to the LLM:

- `/df-status` — shows the current profile, guardrails, completion gate, and
  configured commands in a modal dialog.
- `/df-runtime` — shows the plugin version and live hook/gate runtime state
  (which idle-hook method the core accepted, dispatch history) in a modal
  dialog. Read from a snapshot the server writes per project; reports
  "not reported yet" before the first session instead of guessing.
- `/df-help` — lists the available dev-framework commands in a modal dialog.
- `/df-profile` — opens a profile picker (off / advisory / standard / strict) in
  a modal dialog; selecting one switches the active profile immediately (written
  to the config file). With an argument (`/df-profile standard`) it switches
  directly with a toast instead of the picker.
- `/df-verify` — runs the configured verification suite (the completion gate)
  manually and shows a pass/fail summary in a modal dialog.

You can still run `df init` to install the bundled agents, skills, and default
config; the commands themselves are provided by the plugin. The
`dev_framework_*` custom *tools* remain
available for in-agent use (e.g. when the model wants to change the profile
itself).

`/df-goal <objective>` is a **server-side command** instead (registered by the
server plugin, not the TUI): it starts a **verified** native goal. The plugin
appends a short verification contract to your objective verbatim and delegates
exactly once to native `/goal`, which keeps owning state, review,
pause/resume/clear, and continuations. Requires all three: native `/goal` on
the core, a blocking profile (`standard`/`strict`, i.e.
`gate.block_on_failure: true`), and at least one configured completion check
(typecheck/test command, changed-file lint, `gate.acceptance`, or
`gate.require_review`). Otherwise it fails with an actionable error instead of
starting an unverified goal — use native `/goal` directly for purely semantic
objectives. The objective plus addendum must fit native `/goal`'s 4,000-character
limit; overflow is rejected, never truncated.

The agent must run `dev_framework_verify` after its final changes; the native
reviewer weighs that tool result as evidence and the framework idle gate stays
an independent backstop. This is layered verification, not a hard lock:
native `/goal` can still mark complete while the gate fails (or keep going
after it passes), both tenants can admit a continuation at one idle boundary,
and the framework stands down after `gate.max_blocks`.

**Run plans under `/df-goal`.** When a task starts from a written plan, make
the objective the plan inline (short plans) or `Implement the plan in <path>`
(long plans). Native completion then requires the gate's PASS on the final
tree — a stronger enforcement than a bare turn, where only your summary stands
between the plan and "done".

## Limitations

- **Post-flight enforcement is a same-execution continuation, not a veto.**
  At the would-go-idle boundary the `experimental.idle` hook (landed via
  [`anomalyco/opencode#59437`](https://github.com/anomalyco/opencode/pull/59437))
  runs the gate, and on failure inside `gate.max_blocks` admits a synthetic
  continuation in the same execution. The `event.subscribe` idle net covers
  the boundaries the hook skips (interruption, failure, steer-parked drains),
  deduped so one boundary never runs the gate twice. On builds without the
  hook only the net applies. `/df-status` shows which lever completed an
  evaluation (`Continuation (idle): active` vs the event-subscribe fallback).
  The user can always close the session, so treat the gate
  as the strongest available enforcement, not an unbreakable lock. The missing piece — a pre-terminal vote hook — is proposed upstream ([`anomalyco/opencode#54487`](https://github.com/anomalyco/opencode/pull/54487), open); until it lands, the above is the enforcement story. The **pre-flight**
  gate, by contrast, is a genuine hard block on every build: it denies edit tools in
  `tool.execute.before`, before the edit lands.
- **Guardrails run inside OpenCode.** The `tool.execute.before` hook runs
  after OpenCode's own permission system; it adds project rules on top, it
  does not replace OpenCode permissions.
- **Formatting and linting are delegated.** The plugin does not reimplement
  formatters or linters; you declare your linter commands in
  `.opencode-dev-framework.yml` and the plugin runs them on edited files and
  at the completion gate. Formatting is OpenCode core's job (`formatter` in
  `opencode.json`, off by default) — the plugin's `commands.format` /
  `on_edit.format` are accepted but ignored, deliberately not duplicated.
  The plugin does not automatically rewrite `opencode.json`
  formatter/permission fragments.

## Development

```bash
npm install
npm run format:check
npm run lint
npm run lint:md
npm run typecheck
npm run test
npm run build
```

For persistent debug traces, set `OPENCODE_DEV_FRAMEWORK_LOG_FILE`:

```bash
OPENCODE_DEV_FRAMEWORK_LOG_FILE=/tmp/odf.log opencode run
```

Plugin code runs in the `opencode serve` backend, not in your terminal
process — a variable exported only in the TUI shell never reaches it. For
full server logs plus the plugin trace, run a private server:

```bash
OPENCODE_DEV_FRAMEWORK_LOG_FILE=/tmp/odf.log opencode run --standalone --print-logs
```

(There is no `cli.json` interaction: the plugin never reads or writes CLI
config; the flags above are stock OpenCode CLI options.)

See `AGENTS.md` and `docs/plans/` for the architecture and implementation
plan.

## Disclaimer

This plugin changes how an AI agent behaves in your repository. Review the
constitution, protected paths, and gate commands before enabling the
`standard` or `strict` profiles, and start with `advisory` if you want to
observe behavior without enforcement.

## License

MIT
