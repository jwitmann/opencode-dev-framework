# opencode-dev-framework

An [OpenCode](https://opencode.ai) plugin that enforces project-specific
quality gates during AI coding sessions. Inspired by
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
- **Completion gate.** When the session goes idle (`session.idle`/`session.status:idle`),
  runs typecheck, tests, and (optionally) lint on changed files. On failure inside
  `gate.max_blocks` the plugin re-prompts the session with the failure summary,
  keeping the agent loop alive (V2 async replacement for `session.stopping`).
- **Custom tools.** `dev_framework_init` scaffolds project-level agents,
  skills, local rules directory, and config; `dev_framework_set_profile` changes the profile
  in-session without restarting; `dev_framework_status` reports the current
  profile, guardrails, gate, and tracked changed files.
- **CLI installer.** `df init` auto-detects your language and writes a config
  with sensible commands; `df profile <name>` changes the profile from the
  shell; `df status` / `df version` report template state and the version.
- **Slash commands.** The plugin registers four commands. None of them feed
  anything to the LLM:
  - `/df-status` and `/df-help` are TUI commands (bundled `./tui` companion module)
    that open an instant modal dialog.
  - `/df-profile <profile>` and `/df-verify` are server-side commands. They are
    registered with an empty template so the argument (e.g. `standard`) is
    captured by the plugin and the model never sees it; the result is shown as a
    toast and the user turn is suppressed.
  - The `dev_framework_init` and `dev_framework_set_profile` custom *tools* remain
    available for in-agent use.

## Profiles

| Profile    | Guardrails | Gate failures | Lint on edit | Notes |
| ---------- | ---------- | ------------- | ------------ | ----- |
| `off`      | disabled   | not reported  | no           | Plugin registers no hooks at all. |
| `advisory` | warn       | warn          | yes          | Nothing blocks; everything is logged. |
| `standard` | deny       | error         | yes          | The default when a config file exists. |
| `strict`   | deny       | error         | yes          | Also lints changed files in the gate and throws on per-edit lint failures. |

## Install

```bash
npm install opencode-dev-framework
```

Then add the plugin to your project's `opencode.json`:

```json
{
  "plugins": ["opencode-dev-framework"]
}
```

Requires OpenCode `v2.0.0+` (`@opencode/plugin` `^2`). On `v1.18.18–1.18.31` use the `v1` branch
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
local repository path in your project's `opencode.json` **and** in a `tui.json`.
The TUI module (`/df-status`, `/df-help` modals) is **not** auto-discovered for
local filesystem paths — it only loads when the package is listed in the TUI
config. OpenCode reads `tui.json` from the global config dir
(`~/.config/opencode/tui.json`) and the project dir (`.opencode/tui.json`).

`opencode.json` (V2):

```json
{
  "plugins": ["/home/jerome/opencode-dev-framework"]
}
```

The path must be the **repository root** (where `package.json` lives). OpenCode
loads the plugin from `dist/index.js` (TUI from `tui.tsx`), so rebuild after every source change:

```bash
npm run build
```

### Important caveats

- The `opencode plugin <module>` command creates a `.opencode/opencode.json`
  file in the project directory that takes precedence over the project-level
  `opencode.json`. If you used that command while testing, either delete
  `.opencode/opencode.json` or make sure it also points to the local path.
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
    ".go": "golangci-lint run {file}"

protect:
  - ".env*"
  - "deploy/prod/**"

gate:
  run_typecheck: true
  run_tests: true
  block_on_failure: true

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

All four slash commands are **TUI commands** registered by the bundled `./tui`
companion module (see *Local development* above for the `tui.json` requirement).
They open instantly and **never** feed text back to the LLM:

- `/df-status` — shows the current profile, guardrails, completion gate, and
  configured commands in a modal dialog.
- `/df-help` — lists the available dev-framework commands in a modal dialog.
- `/df-profile` — opens a profile picker (off / advisory / standard / strict) in
  a modal dialog; selecting one switches the active profile immediately (written
  to the config file). Run it **bare** — the argument form
  (`/df-profile standard`) is not wired up in this build.
- `/df-verify` — runs the configured verification suite (the completion gate)
  manually and shows a pass/fail summary in a modal dialog.

You can still run `df init` to install the bundled agents, skills, and default
config; the commands themselves are provided by the plugin. The
`dev_framework_init` and `dev_framework_set_profile` custom *tools* remain
available for in-agent use (e.g. when the model wants to change the profile
itself).

## Limitations

- **The completion gate in V2 re-prompts instead of vetoing.** `session.stopping`
  (`PR #44712`) was removed in the V2 plugin API. On failure inside `gate.max_blocks`
  the plugin now calls `ctx.session.prompt()` from the `session.idle`/`session.status`
  event, waking the agent with the failure summary — same UX, async instead of a
  synchronous `stop=false` veto. Standing down after `max_blocks` is plugin-owned
  (no core 3-re-entry cap). There is no synchronous hard block in V2.
- **Guardrails run inside OpenCode.** The `tool.execute.before` hook runs
  after OpenCode's own permission system; it adds project rules on top, it
  does not replace OpenCode permissions.
- **Formatting and linting are delegated.** The plugin does not reimplement
  formatters or linters; you declare your formatter and linter commands in
  `.opencode-dev-framework.yml` and the plugin runs them on edited files and
  at the completion gate. It does not automatically rewrite `opencode.json`
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

See `AGENTS.md` and `docs/plans/` for the architecture and implementation
plan.

## Disclaimer

This plugin changes how an AI agent behaves in your repository. Review the
constitution, protected paths, and gate commands before enabling the
`standard` or `strict` profiles, and start with `advisory` if you want to
observe behavior without enforcement.

## License

MIT
