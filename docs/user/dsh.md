# DSH adapter

> Status: implemented and unit-tested (29 adapter tests, full suite
> green). Live-fire validation on stock `headless` is still pending —
> until that run lands, treat this page as the setup contract, not a
> support claim.

Same core (`src/core/`), different wiring: the DSH adapter registers
the ODF gates on a DeepSeek Harness Cordis context instead of OpenCode.
Project config is the same `.opencode-dev-framework.yml` (fallback
`.dev-framework.yml`) in the project directory.

## Mount

`apply(ctx)` is the plugin entry (`opencode-dev-framework/dsh`). Mount
it with a `--patch` overlay naming the built file:

```yaml
- insert:
    - id: odf-gates
      name: /path/to/opencode-dev-framework/dist/adapters/dsh/index.js
```

```bash
dsh --profile headless --patch ./odf-livefire.patch.yml "your task"
```

The adapter resolves the project directory from `ODF_WORKDIR`, else the
process working directory — run `dsh` from the project (or export
`ODF_WORKDIR`). A missing or broken config error-logs and registers
nothing (mirroring the OpenCode setup behavior); it never throws at
mount.

## Contracts

| Mechanism | DSH hook | Strength |
| --------- | -------- | -------- |
| Protected paths + dangerous commands | `tools/pre-execute` deny (+ structured `info`) | **Hard block** before the tool runs. Shell redirect targets are guard-checked too (wider than the OpenCode path). |
| Pre-flight gate | `tools/pre-execute` deny, before guardrails | **Hard block**; advisory warns and continues; the artifact path stays writable (relative or absolute spelling). |
| Per-edit lint + format | `tools/post-execute` | Findings **fail the tool call** (`block` with the linter output as model-facing feedback) so the agent fixes its edit in the same turn — the OpenCode `execute.after` can only log a landed edit. Timeouts, exit-127, and silent nonzero exits stay accept + error-log with the file tracked (infra the model cannot fix). Feedback is capped (4000 chars/body, 5 files + named tail). |
| Completion gate | `agent/turn-stopping` + `steer` | **Pre-terminal**: the host awaits listeners, then continues the SAME turn on steer — no re-prompt round-trip, unlike the OpenCode idle continuation. Steer is dropped when the turn already aborted. Budget exhaustion stands down silently. |
| Warn tier | allow + warn log on every hook | **Ceiling, verified**: nothing provides the `approval` service on headless, so `ask` would unconditionally deny — advisory never blocks by construction. |
| Kill switch | profile `off` skips everything; `protect_off` stands down guardrails only | Pre-flight, lint, and the gate still fire under `protect_off` — exactly the OpenCode scope. |

## Differences from the OpenCode adapter

Stronger where the host allows more: pre-terminal same-turn gate
steering, model-facing post-execute `block`, structured denial
identity, abort-aware steering, redirect-target guard coverage.
Identical where the hosts agree: pre-execute deny hardness,
warn→allow-with-log, pre-flight ordering and semantics, block
budgeting, `protect_off` scope.

## Troubleshooting

- Gates silent: check the host log for `[odf]` lines — a config load
  failure disables everything by design. Run with a valid
  `.opencode-dev-framework.yml` in the project directory.
- Lint `block`s every edit with the same message: the linter itself is
  broken (missing binary, bad config) — but a healthy linter prints
  findings and exits nonzero, while infra stays accept. Check the
  `[odf post-execute]` error log, not the model feedback.
- Turn ends despite a failing gate: `profile: off` skips the gate, and
  budget exhaustion (`gate.max_blocks`) stands down — both by design;
  the `odf-status` command shows the live state.
