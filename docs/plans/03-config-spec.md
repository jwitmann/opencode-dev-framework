# Configuration Specification

## File precedence

1. `.opencode-dev-framework.yml` (primary)
2. `.opencode-dev-framework.yaml`
3. `.opencode-dev-framework.json`
4. `.dev-framework.yml` (fallback for compatibility)
5. `.dev-framework.yaml`

The first file found wins. Project root is the current working directory (`ctx.directory`).

## Format

Primary config is real YAML. Values can be strings, booleans, numbers, arrays, or objects where noted.

## Top-level keys

### `profile`

- Type: `string`
- Values: `off`, `advisory`, `standard`, `strict`
- Default: `standard` if a config file exists, otherwise `off`

Controls enforcement intensity:

| Profile | Edit feedback | Completion gate | Protected paths |
|---|---|---|---|
| `off` | — | — | — |
| `advisory` | lint feedback | runs & reports, **never blocks** | warns |
| `standard` | lint feedback | **reports** failing type-check/tests | **denies** protected edits |
| `strict` | lint feedback | also reports lint failures on changed files | **denies** protected edits |

### `commands`

Commands are strings. They may contain substitution tokens.

| Key | Description | Token |
|---|---|---|
| `commands.test` | Full test command. | `{files}` expands to changed files if used. |
| `commands.typecheck` | Type-check command. | — |
| `commands.format` | Default formatter for edited files. | `{file}` expands to the edited file path. |
| `commands.lint` | Default linter for edited files. | `{file}` expands to the edited file path. |
| `commands.test_changed` | Scoped test command when `gate.scope` is `changed`. | `{files}` expands to changed files. |

Per-extension overrides:

```yaml
commands:
  format:
    .go: gofumpt -w {file}
    .py: ruff format {file}
  lint:
    .go: golangci-lint run {file}
    .py: ruff check {file}
```

### `protect`

- Type: `string[]`
- Default: sensible project defaults if omitted

Globs of files/paths that should not be edited. Examples:

```yaml
protect:
  - .env*
  - go.sum
  - package-lock.json
  - "**/vendor/**"
  - "**/node_modules/**"
  - bin/
```

### `protect_mode`

- Type: `string`
- Values: `warn`, `deny`
- Default: `warn` for `advisory`, `deny` for `standard`/`strict`

Whether protected-path violations are warned or denied.

### `protect_off`

- Type: `boolean`
- Default: `false`

If `true`, disable path protection entirely.

### `gate`

```yaml
gate:
  run_typecheck: true
  run_tests: true
  block_on_failure: true
  skip_unchanged: true
  scope: all          # all | changed
  lint_changed: false
  timeout: 300        # seconds per command
  max_blocks: 3       # not yet meaningful in OpenCode advisory mode
```

| Key | Type | Default | Description |
|---|---|---|---|
| `run_typecheck` | `boolean` | `true` | Run `commands.typecheck` at the gate. |
| `run_tests` | `boolean` | `true` | Run `commands.test` at the gate. |
| `block_on_failure` | `boolean` | profile-based | If true, emit failure loudly. (OpenCode cannot physically block.) |
| `skip_unchanged` | `boolean` | `true` | Skip gate if no files changed. |
| `scope` | `string` | `all` | `all` runs `commands.test`; `changed` runs `commands.test_changed`. |
| `lint_changed` | `boolean` | `true` in `strict` | Lint each changed file at the gate. |
| `timeout` | `number` | — | Per-command timeout in seconds. |
| `max_blocks` | `number` | `3` | Future use; advisory mode currently ignores this. |

### `on_edit`

```yaml
on_edit:
  format: true
  lint: true
```

| Key | Type | Default | Description |
|---|---|---|---|
| `format` | `boolean` | `true` | Run formatter on edited files. |
| `lint` | `boolean` | `true` | Run linter on edited files and report output. |

### `exclude`

- Type: `string[]`
- Default: `[]`

Globs to skip for format/lint.

### `rules`

- Type: `string[]`
- Default: auto-discover common files

Paths to Markdown rule/constitution files to inject into session context. If omitted, the plugin auto-discovers:

- `RULES.md`
- `rules/*.md`
- `AGENTS.md`
- `STYLE.md`
- `CONTRIBUTING.md`

### `style_guide`

- Type: `string`
- Default: auto-detect

Path to a project style guide to inject into context.

## Profile default overrides

Explicit config keys always override profile defaults.

| Key | `off` | `advisory` | `standard` | `strict` |
|---|---|---|---|---|
| `protect_mode` | — | `warn` | `deny` | `deny` |
| `gate.block_on_failure` | `false` | `false` | `true` | `true` |
| `gate.lint_changed` | `false` | `false` | `false` | `true` |
| `on_edit.format` | `false` | `true` | `true` | `true` |
| `on_edit.lint` | `false` | `true` | `true` | `true` |

## Example config

```yaml
profile: standard

commands:
  test: go test ./...
  typecheck: go vet ./...
  format:
    .go: gofumpt -w {file}
  lint:
    .go: golangci-lint run {file}

protect:
  - .env*
  - go.sum
  - bin/

on_edit:
  format: true
  lint: true

gate:
  skip_unchanged: true
  timeout: 300

rules:
  - AGENTS.md
  - CONTRIBUTING.md
```

## `.dev-framework.yml` compatibility mapping

When reading `.dev-framework.yml` as fallback, map flat keys to the native structure:

| `.dev-framework.yml` key | `.opencode-dev-framework.yml` key |
|---|---|
| `profile` | `profile` |
| `test` | `commands.test` |
| `typecheck` | `commands.typecheck` |
| `format` | `commands.format` |
| `lint` | `commands.lint` |
| `format.<ext>` | `commands.format.<ext>` |
| `lint.<ext>` | `commands.lint.<ext>` |
| `test_changed` | `commands.test_changed` |
| `precommit` | ignored in MVP |
| `format_on_edit` | `on_edit.format` |
| `lint_on_edit` | `on_edit.lint` |
| `gate_run_typecheck` | `gate.run_typecheck` |
| `gate_run_tests` | `gate.run_tests` |
| `gate_block_on_failure` | `gate.block_on_failure` |
| `gate_skip_unchanged` | `gate.skip_unchanged` |
| `gate_scope` | `gate.scope` |
| `gate_lint_changed` | `gate.lint_changed` |
| `gate_timeout` | `gate.timeout` |
| `gate_max_blocks` | `gate.max_blocks` |
| `protect_off` | `protect_off` |
| `protect_mode` | `protect_mode` |
| `protect` | `protect` (split on whitespace) |
| `exclude` | `exclude` (split on whitespace) |
| `style_guide` | `style_guide` |

If the flat value contains whitespace-separated globs (e.g., `protect: .env* go.sum`), split it into an array.
