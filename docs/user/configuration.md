# Configuration

Create `.opencode-dev-framework.yml` in your project root. Two paths:

- **Conversational (default):** run `/df-init` in the project. It scaffolds
  the templates, writes a detected config, trial-runs it, and hands the
  wizard brief to the agent — which reads your Makefile, CI, and
  CONTRIBUTING, maps the real verification commands (wrappers like
  `make check`, never reconstructed bare tools), asks at most 3 genuinely
  user-only questions, and ends at a config + `hardening.md` diff for your
  review. Never merge unreviewed.
- **Scripted:** `df init` from a shell (see the [Quickstart](../README.md#quickstart))
  auto-detects your language and writes a matching config — then adjust
  it. `init` also trial-runs the detected test/typecheck once and
  reports PASS/FAIL per command, so guesses arrive verified or flagged.
  Same scaffold, no conversation; conflicts need `--overwrite-existing` or
  `--skip-existing`.

Trust model for the agentic path: the agent proposes, the shared
enforceability bar checks the draft (blocking profile plus at least one
real check — the same bar `/df-goal` applies, so no vacuous config can
pass), and you review the diff and commit. No party trusted alone.

What follows is the full commented reference. The authoritative schema
lives in [`../plans/03-config-spec.md`](../plans/03-config-spec.md); this
page shows it in usable form.

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
  # before the completion gate passes. Substance is enforced, not just
  # existence: at least 200 chars / 30 words, no template markers or
  # unfilled checklists — a "looks good" checkbox fails the gate.
  require_review: true

  # Optional: named project-specific acceptance checks. Run sequentially
  # after the typecheck/test steps; a failure fails the gate but other
  # steps still run. Timeouts are per-check seconds (default: gate timeout).
  # acceptance:
  #   - name: api-contract
  #     command: "./scripts/verify-api-contract.sh"
  #   - name: migration-safety
  #     command: "./scripts/check-migrations.sh"
  #     timeout: 120

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
# Append form (keeps the bundled rules, adds project files after them):
# rules:
#   mode: append
#   files:
#     - .opencode/opencode-dev-framework/hardening.md

# Optional: project style guide appended to the constitution.
# Auto-discovers STYLE.md / CONTRIBUTING.md / docs/STYLE.md when not set.
# style_guide: STYLE.md
```

## Notes

- **Profiles** (`off` / `advisory` / `standard` / `strict`) set the
  defaults: `advisory` warns where `standard`/`strict` deny, and the gate
  only blocks when `block_on_failure` is true (`standard`/`strict`
  default). See [`enforcement.md`](enforcement.md).
- **Constitution.** The bundled rules ship with the plugin. Override them by
  dropping Markdown files into `.opencode/opencode-dev-framework/rules/`,
  by setting explicit `rules`, or by letting the plugin auto-discover your
  `STYLE.md` / `CONTRIBUTING.md`.
- **Legacy fallback.** The flat-key `.dev-framework.yml` format is read for
  compatibility, but the native format above is preferred.
- **Worked example.** [`../../examples/go-service/`](../../examples/go-service/)
  shows a complete Go-service config.
