# DSH adapter

> Status: implemented (40 adapter tests, full suite green);
> enforcement live-proven 2026-11-16 on stock `headless`
> (sessions `931700f5` + `9487c152`, model
> `muse-spark-1.3-contributor`). Instruction pillar
> (`agent/pre-step` constitution prepend), commands (`df-status`,
> `df-goal`, `df-verify`, `df-profile`, `df-runtime`, `df-init`,
> `df-update`),
> and agent tools (`dev_framework_verify/set_profile/status/init/
> update/runtime`) are wired and unit-proven; `dev_framework_status`
> since invoked live by the model (full status text returned), and
> the child artifact deny live-proven (subagent attempted
> `review.md`, got the guard text, reported back as text). No goal
> tool by design (goal creation is human-initiated on both
> harnesses). Deliberate release still pending.

## Agent tools

The same six `dev_framework_*` agent tools the OpenCode adapter
installs, callable by the model mid-turn: `dev_framework_verify`
(mid-session gate check, reports only), `dev_framework_set_profile`
(applies immediately), `dev_framework_status` (live state),
`dev_framework_init` (scaffold + report), `dev_framework_update`
(drift brief, mirror included — present each file before editing),
`dev_framework_runtime` (read-only snapshot). The definitions are plain
objects in the host's compiled tool shape — no host-internal import,
no new dependency.

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
- id: odf-gates
  inject:
    - tools
    - goals
    # Ask the human instead of logging: guard `warn` verdicts arrive as
    # `ask` decisions only when this seam is injected. Without it the
    # adapter allows with a warn log (agent-run headless keeps working).
    - approval
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
| Protected paths + dangerous commands | `tools/pre-execute` deny (+ structured `info`) | **Hard block** before the tool runs. Shell redirect targets are guard-checked too (wider than the OpenCode path). Live: `.env` write → `write on protected path ".env" is blocked (matched ".env*")` + `{"name":"opencode-dev-framework","code":"guard-deny"}`; file absent afterwards. |
| Pre-flight gate | `tools/pre-execute` deny, before guardrails | **Hard block**; advisory warns and continues; the artifact path stays writable (relative or absolute spelling). |
| Per-edit lint + format | `tools/post-execute` | Findings **fail the tool call** (`block` with the linter output as model-facing feedback) so the agent fixes its edit in the same turn — the OpenCode `execute.after` can only log a landed edit. Live: marker edit → `[odf post-execute] your edit introduced lint findings; fix them and retry` + `lint failed for greet.js (exit 1)` + `{"code":"lint-block"}`; the agent retried clean in the same turn. Timeouts, exit-127, and silent nonzero exits stay accept + error-log with the file tracked (infra the model cannot fix). Feedback is capped (4000 chars/body, 5 files + named tail). |
| Completion gate | `agent/turn-stopping` + `steer` | **Pre-terminal**: the host awaits listeners, then continues the SAME turn on steer — no re-prompt round-trip, unlike the OpenCode idle continuation. Live: after a one-edit task said "Done", the gate blocked on the missing review and steered turn 1 onward — the agent ran a style/test/correctness review loop, wrote the review artifact, and only then did the turn end (15 steps, one turn, no new turn). Steer is dropped when the turn already aborted. Budget exhaustion stands down silently. |
| Warn tier | allow + warn log on every hook | **Ceiling, verified**: nothing provides the `approval` service on headless, so `ask` would unconditionally deny — advisory never blocks by construction. |
| Kill switch | profile `off` skips everything; `protect_off` stands down guardrails only | Pre-flight, lint, and the gate still fire under `protect_off` — exactly the OpenCode scope. |

## Differences from the OpenCode adapter

Stronger where the host allows more: pre-terminal same-turn gate
steering, model-facing post-execute `block`, structured denial
identity, abort-aware steering, redirect-target guard coverage.
Identical where the hosts agree: pre-execute deny hardness,
warn→allow-with-log, pre-flight ordering and semantics, block
budgeting, `protect_off` scope.

## Instruction and commands

- **Constitution**: `agent/pre-step` prepends the constitution, the
  duty roster, and any startup drift mention once per session, so the
  agent works under the contract from its first step (mirror of the
  OpenCode context-hook injection; refreshes when the config
  changes). Advisory-warn on load failure — the gates still enforce.
- **`df-goal <objective>`**: checks native `/goal` and the profile,
  wraps the objective with the verification contract exactly once,
  and creates the host goal — the DSH-native shape of `/df-goal`.
- **`df-verify`**: runs the full completion gate on demand and
  reports PASS/FAIL (side-effect-free: never retries, never steers).
- **`df-profile <off|advisory|standard|strict>`**: switches profile
  (same core as the OpenCode modal/tool); invalid names rejected.
- **`df-init` / `df-update`**: deterministic scaffold/drift-check in
  code, judgment half handed to the agent via `followup` (the
  operator-memory `operator-project-init` pattern). DSH-native: the
  scaffold also mirrors the shipped skills into `.dsh/skills/` (the
  host `skill` tool only scans `.dsh/skills`, `.agents/skills`, and
  the user roots — never `.opencode/skills`), and the brief tells the
  agent to load `project-config` with the `skill` tool and ask
  user-only questions (at most 3) with `ask_user_question`. Safe to
  re-run; mirrors never clobber user edits unasked and never read as
  drift. Reviewer agents (`.opencode/agents/`) have no DSH equivalent
  and stay inert files — the review loop runs through gate steer text
  instead.
- **`df-status`**: live gate status (profile, config, level) plus host
  seam availability (tools/goals/approval) and who runs the formatter —
  a degraded mount reads as degraded, never as silently whole.
- **Warn asks the human (TUI)**: a guard `warn` arrives as an `ask`
  decision when the approval seam is injected, so it prompts instead
  of scrolling by in the log. Child sessions never ask (they report
  back; the parent decides). Without the seam, warn allows with a
  warn log.
- **Child sessions**: the turn-stopping gate skips subagents (they owe
  no review duty — the parent answers for the shared tree), and
  children cannot write `review.md` (`child-artifact-deny`; advisory
  warns). Parentage is read synchronously from the host session
  header (`origin`/`parentSession`), no lookup needed. Live: the
  subagent attempted the review write, received the denial text,
  and reported back while the parent wrote the artifact.

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
  the `df-status` command shows the live state.
