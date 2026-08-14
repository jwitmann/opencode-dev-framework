# opencode-dev-framework

An [OpenCode](https://opencode.ai) plugin that enforces project-specific
quality gates during AI coding sessions. Inspired by
[anticomputer/dev-framework](https://github.com/anticomputer/dev-framework),
reimplemented as an OpenCode-native plugin.

## What it does

- **Constitution injection.** Adds a project constitution (quality bar, test
  discipline, focus rules) to the system prompt at session start. Ships with a
  bundled default; point `constitution` at your own Markdown file to override.
- **Guardrails.** Blocks or warns on edits to protected paths (`.env` files,
  `node_modules`, vendored code, your own globs) and on dangerous shell
  commands (`git push`, `rm -rf`, `git reset --hard`, ...).
- **Per-edit lint.** Runs your configured linter on each file the agent edits
  and reports failures loudly.
- **Completion gate.** When the session goes idle, runs typecheck, tests, and
  (optionally) lint on changed files, then reports the result.
- **`/df-verify` command.** Lets the agent (or you) re-run the verification
  suite on demand.

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

Create `.opencode-dev-framework.yml` in your project root:

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

constitution: "TEAM_RULES.md" # optional; bundled default if omitted
```

The legacy `.dev-framework.yml` flat-key format is read as a fallback for
compatibility, but the native format above is preferred. See
[`docs/plans/03-config-spec.md`](docs/plans/03-config-spec.md) for the full
config reference and [`examples/go-service/`](examples/go-service/) for a
complete example.

## Limitations

- **The completion gate is advisory, not a hard block.** OpenCode has no
  `agentStop` hook, so the gate runs on `session.idle` and reports failures
  loudly (error-level log) but cannot physically prevent the agent from
  stopping. This is an architectural limitation of the plugin API.
- **Guardrails run inside OpenCode.** The `tool.execute.before` hook runs
  after OpenCode's own permission system; it adds project rules on top, it
  does not replace OpenCode permissions.
- **Formatting is delegated.** Formatter config is contributed to OpenCode's
  native formatter system rather than reimplemented.

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
