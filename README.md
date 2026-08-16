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
- **Completion gate.** When the session goes idle, runs typecheck, tests, and
  (optionally) lint on changed files. In OpenCode versions with the
  `experimental.session.stopping` hook, gate failures keep the session running
  (up to `gate.max_blocks` times) so the agent must fix the failures. In older
  versions the gate reports loudly via `session.idle`.
- **Custom tools.** `dev_framework_init` scaffolds project-level agents,
  skills, commands, and config; `dev_framework_set_profile` changes the profile
  in-session without restarting; `dev_framework_status` reports the current
  profile, guardrails, gate, and tracked changed files.
- **CLI installer.** `df init` auto-detects your language and writes a config
  with sensible commands; `df profile <name>` changes the profile from the
  shell; `df status` / `df version` report template state and the version.
- **Slash commands.** `/df-status`, `/df-verify`, and `/df-profile` are
  registered directly by the plugin so they work without template files.
  `/df-status` and `/df-verify` read live in-memory state; `/df-profile`
  updates the config and applies the change immediately.

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

Then add it to your project's `opencode.json`:

```json
{
  "plugin": ["opencode-dev-framework"]
}
```

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
local repository path in your project's `opencode.json`:

```json
{
  "plugin": ["/home/jerome/opencode-dev-framework"]
}
```

The path must be the **repository root** (where `package.json` lives). OpenCode
loads `dist/index.js`, so rebuild after every source change:

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

The plugin registers three slash commands directly (no template files required):

- `/df-status` — shows the current profile, guardrails, completion gate,
  configured commands, and tracked changed files. Reads live in-memory state.
- `/df-verify` — runs the configured verification suite manually.
- `/df-profile <profile>` — changes the active profile and applies it
  immediately.

You can still run `df init` to install the bundled agents, skills, and default
config; the commands themselves are provided by the plugin.

## Limitations

- **The completion gate blocks only in newer OpenCode versions.** The
  `experimental.session.stopping` hook (PR #41811) lets the plugin keep the
  session running until checks pass. In older OpenCode versions the gate runs
  on `session.idle` and reports failures loudly but cannot force the agent to
  keep working.
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

See `AGENTS.md` and `docs/plans/` for the architecture and implementation
plan.

## Disclaimer

This plugin changes how an AI agent behaves in your repository. Review the
constitution, protected paths, and gate commands before enabling the
`standard` or `strict` profiles, and start with `advisory` if you want to
observe behavior without enforcement.

## License

MIT
