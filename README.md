# opencode-dev-framework

AI agents finish by *saying* they're done — and prose rules ("be
thorough", "run the tests") are interpretation surface a capable agent
routes around. This plugin replaces assertion with evidence: guardrails
that deny instead of advise, a completion gate that re-runs your checks
at the idle boundary, and verified goals whose contract requires a
tool-result PASS on the final tree. Exit codes don't negotiate.

An [OpenCode](https://opencode.ai) plugin that enforces project-specific
quality gates during AI coding sessions — and verifies whole tasks, not just
edits, through `/df-goal`. Inspired by
[anticomputer/dev-framework](https://github.com/anticomputer/dev-framework),
reimplemented for OpenCode (the original supports Copilot, Claude, and Codex).
The same core also ships a DSH adapter (Cordis wiring, same gates, host-native
execution) — see [`docs/user/dsh.md`](docs/user/dsh.md).

## Quickstart

Five minutes from zero to your first gated session.

### On OpenCode

```bash
opencode plugin add opencode-dev-framework
```

In any project, run:

```text
/df-init
```

It scaffolds the templates, writes a detected config, trial-runs it, and
hands your session agent a brief — what was detected, what passed, Makefile
targets worth mapping to wrappers, at most 3 open questions. The agent
resolves what it can, asks only genuinely user-only questions, and ends with
a config + `hardening.md` draft for your review. Budget ~5 minutes,
review-only at the end; imperfections assumed, manual always possible.

Prefer a shell? Same thing non-interactively — for CI, dotfiles, and
scripted runs:

```bash
npx df init
```

Conflicts need `--overwrite-existing` or `--skip-existing` — everything
else is under `npx df init --help`.

### On DSH

Pre-release (works today) — build once, wire the profile:

```bash
npm run build
df install-dsh --profile <name> --dist /path/to/opencode-dev-framework/dist/adapters/dsh/index.js
```

Post-release, one command (bundle auto-wires the base entry):

```bash
dsh plugin --profile <name> add opencode-dev-framework
df install-dsh --profile <name>  # preset seam + verification
```

Full reference: [`docs/user/dsh.md`](docs/user/dsh.md).

Then, per project: run `dsh` from the project root (or export
`ODF_WORKDIR`), run `df-init` once (scaffolds templates *and* the
`.dsh/skills` mirror the host `skill` tool scans), and accept the
template drift via `df-update` if the session reports any. Same config
file, same profiles, same gates. Full DSH reference:
[`docs/user/dsh.md`](docs/user/dsh.md).

Then ask the agent for a small edit. You will see the plugin working: the
edit is checked against guardrails before it lands, your linter runs on the
edited file, and when the session goes idle the completion gate runs your
typecheck/tests. `/df-status` shows the live state at any time. Start with
`profile: advisory` if you want to observe before enforcing.

## Harness differences

Same core, same config, same profiles — different wiring where the hosts
differ:

| Area | OpenCode | DSH |
| ---- | -------- | --- |
| Gate continuation | Synthetic message at the idle boundary (re-prompt round-trip) | Pre-terminal steer, same turn, no round-trip |
| Per-edit lint | Logged against the landed edit | Fails the tool call (`block`) — agent retries same turn |
| Guard `warn` | Logged (advisory never blocks) | Logged, or prompts the human as `ask` when the `approval` seam is injected |
| Redirect targets (`a > file`) | Not guard-checked | Guard-checked (wider than OpenCode) |
| denial identity | Reason text | Reason text + structured `{name, code}` |
| Skills | `.opencode/skills` (native) | `.dsh/skills` mirror (host never scans `.opencode/skills`) |
| Reviewer agents | `.opencode/agents` specialists run as subagents | Adapter-dispatched DSH children on review-blocks (one per kind; findings fold into the steer); inline steer when the seam is absent |
| Goals | `/df-goal` wraps native `/goal` | `df-goal` creates the host goal with the same verification contract |

Identical on both: pre-execute deny hardness, pre-flight ordering and
semantics, block budgeting, `protect_off` scope, and all eight
`df-*`/`dev_framework_*` command and tool names. Details:
[`docs/user/enforcement.md`](docs/user/enforcement.md) (OpenCode),
[`docs/user/dsh.md`](docs/user/dsh.md) (DSH).

## What it does

- **Constitution injection.** Adds a project quality bar to the system prompt
  at session start (bundled default, overridable per project).
- **Guardrails.** Blocks or warns on protected paths (`.env`, vendored
  code, your own globs) and dangerous shell commands (`git push`, `rm -rf`).
- **Per-edit lint.** Runs your linter on each edited file. On OpenCode
  the result is logged against the landed edit; on DSH a finding fails
  the tool call so the agent retries clean in the same turn.
- **Completion gate.** At the would-go-idle boundary, runs typecheck, tests,
  acceptance checks, and (optionally) lint on changed files — plus a required
  substantive peer-review artifact in `standard`/`strict` (length floors, no
  template checkboxes). On OpenCode, failures steer the session back via a
  synthetic continuation, bounded by `gate.max_blocks` (fewer when
  the failure repeats with no new edits — the gate stands down early on
  zero progress). On DSH the same verdict runs pre-terminal in the same
  turn — no re-prompt round-trip.
- **Verified goals (`/df-goal`).** Wraps a task in native `/goal` with a
  verification contract the reviewer weighs as evidence.
- **Pre-flight gate (optional).** Denies edits until the agent records
  required upfront research.
- **Custom tools + CLI.** `dev_framework_*` tools for in-agent use;
  `df init [--dsh] / profile / status / version / install-dsh --profile <name>`
  from the shell (children may not invoke gate tools — deny + redirect).

## Minimal configuration

Create `.dev-framework.yml` in your project root (the legacy
`.opencode-dev-framework.yml` name is still read when no neutral-named
file exists):

```yaml
profile: standard

commands:
  typecheck: "npm run typecheck"
  test: "npm test"
```

Full reference (all keys, acceptance checks, pre-flight, rule overrides):
[`docs/user/configuration.md`](docs/user/configuration.md). Copy-paste
starters: [`examples/go-service/`](examples/go-service/).

## How it fits together

Every session runs the same loop — constitution, guardrails, lint, gate —
whether or not it starts under `/df-goal`. A goal just wraps that loop in
native verification. The diagram below shows the OpenCode wiring (idle
synthetic continuation); DSH differs only at the gate step (pre-terminal
steer, same turn — see the differences table above):

```text
                        user prompt
                  (plain or /df-goal plan)
                                |
                                v
                       agent implements
                                |
                                v
                       tool.execute.before
                        /                \
                     allow                deny: protected / dangerous / pre-flight
                       |                                |
                       v                                v
                   edit lands                 BLOCKED before landing
                       |
                       v
           per-edit lint + change tracker
                /                         \
               v                           v
agent runs dev_framework_verify        session idle
               |                               |
               v                               v
            verdict               completion gate (same full contract)
             /    \                     |             |               |                    |
          PASS    FAIL                 PASS    within max_blocks   past max_blocks   identical x3, no new edits
            |       |                   |             |               |                    |
            v       v                   v             v               v                    v
      gate green   loops back         done     synthetic          STAND DOWN (honest unmet report)
      (in a goal:  to agent                        continuation
       evidence     implements                            |
       into /goal)                                        v
                                                 loops back to agent implements

wrappers (dotted lines in the diagram version):
  /df-goal plan (optional) ── delegates once, appends contract ──> native /goal (owns objective + review)
  native /goal ── wraps the loop, drives turns ──> agent implements
```

The diagram version of this flow (rendered on GitHub) lives in
[`docs/user/enforcement.md`](docs/user/enforcement.md#flow) — update both
together.

## Profiles

| Profile    | Guardrails | Gate failures | Lint on edit | Pre-flight | Review required | Notes |
| ---------- | ---------- | ------------- | ------------ | ---------- | --------------- | ----- |
| `off`      | disabled   | not reported  | no           | no         | no              | Plugin registers no hooks at all. |
| `advisory` | warn       | warn          | yes          | warn only  | warned, not blocked | Nothing blocks; everything is logged. |
| `standard` | deny       | error         | yes          | deny edits | blocks completion | The default when a config file exists. |
| `strict`   | deny       | error         | yes          | deny edits | blocks completion | Also lints changed files in the gate. |

How each layer is enforced, and what it honestly cannot do:
[`docs/user/enforcement.md`](docs/user/enforcement.md).

## Commands

| Command | What it does |
| ------- | -------------- |
| `/df-status` | Instant modal: profile, guardrails, gate, configured commands. |
| `/df-runtime` | Instant modal: plugin version + live hook/gate runtime state. |
| `/df-help` | Instant modal: lists the dev-framework commands. |
| `/df-profile` | Instant modal picker (or `/df-profile <name>`): switches profile now, written to config. |
| `/df-verify` | Runs the verification suite manually; pass/fail summary in a modal. |
| `/df-init` | Server-side command: scaffolds templates, writes the detected config, trial-runs it, hands the brief to the agent. |
| `/df-update` | Server-side command: diffs installed templates against shipped, refresh/add each with user approval (detection only, never writes). Drift is also mentioned once at session startup. |
| `/df-goal <objective>` | Server-side command: starts a **verified** native goal (requires native `/goal`, a blocking profile, and at least one real check). |

The TUI commands open instantly and never feed the LLM; `/df-init`,
`/df-update`, and `/df-goal` are server-side and drive the session. Same
eight names on DSH, where they run as host commands returning text instead
of modals. Full reference:
[`docs/user/commands.md`](docs/user/commands.md).

## Limitations (short version)

- The completion gate **steers, it does not veto**: it continues the turn
  via a synthetic message at the idle boundary — bounded by
  `gate.max_blocks` (fewer when the failure repeats with no new edits) —
  and you can always close the session. (On DSH the same verdict runs
  pre-terminal in the same turn instead of re-prompting.)
- A genuine pre-stop veto is proposed upstream
  ([`anomalyco/opencode#54487`](https://github.com/anomalyco/opencode/pull/54487),
  open) — if it lands, the gate vetoes there instead of continuing.
- The **pre-flight** gate is the one genuine hard block today.
- Guardrails add to OpenCode permissions, never replace them.
- Formatters and linters are yours — the plugin runs them, it does not
  reimplement them.
- The DSH adapter (same core, Cordis wiring: `opencode-dev-framework/dsh`)
  goes further where its host allows — pre-terminal same-turn gate,
  model-facing lint `block`s, adapter-dispatched reviewer children
  (read-only preset where the registry exists) — and is live-proven
  on both harnesses (headless guard/lint/gate/dispatch, TUI warn→ask,
  human `/df-goal`, TUI review-block dispatch with preset):
  [`docs/user/dsh.md`](docs/user/dsh.md).

Full story: [`docs/user/enforcement.md`](docs/user/enforcement.md).

## Troubleshooting

Duplicate plugin IDs, stale npm cache, TUI not loading, version matrix:
[`docs/user/troubleshooting.md`](docs/user/troubleshooting.md).

## Contributing

`AGENTS.md` is the canonical contributor contract. Build/test commands and
the release path: [`docs/dev/contributing.md`](docs/dev/contributing.md).

## Disclaimer

This plugin changes how an AI agent behaves in your repository. Review the
constitution, protected paths, and gate commands before enabling the
`standard` or `strict` profiles, and start with `advisory` if you want to
observe behavior without enforcement.

## License

MIT
