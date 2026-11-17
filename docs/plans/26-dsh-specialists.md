# Plan 26 — DSH specialist subagents (close the delegation gap)

Status: scoped, not started. Probe results + design below; implementation
is phased work, not a quick patch.

## Problem

`40-delegation` promises specialist reviewers as the default loop. On
OpenCode they are runnable subagents (`.opencode/agents/`). On DSH they
do not exist: `df-init` mirrors skills only, the adapter provisions no
agents, and `list_agents` correctly shows only the lead. The interim
docs fix (harness rule in `40-delegation.md`: inline-via-skills is the
DSH primary) stops the confusion but leaves the capability gap open:
review passes run inline by the lead instead of as focused children.

## Seam (verified against the installed host, `0.2.2-rc.3` — not assumed)

- `ctx.subagents` service: `getProvider(name)`, `resolveMaxDepth()`,
  `startActivation({provider, label, name?, prompt, parent,
  agentPreset?, agentOptions?, maxDepth?, signal, delivery})`.
  (`dsh-tool-subagent/lib/index.js`, `startActivation` call site.)
- Completion is **async delivery to the parent**, not an awaited return:
  `startActivation` resolves `{name}`; findings arrive later as a
  completion notice in the parent inbox (`delivery: "parent"`).
- Providers present on stock headless (verified via
  `dsh --profile headless --dump-config`): `spawn` (self-contained;
  model tool `subagent`) and `fork` (inherits completed turns; model
  tool `subagent_fork`). `agent-team` service caps 256 tasks.
- Plugin access is via the patch `inject:` string array (schema
  confirms the shape; names are runtime-validated). The tool reads
  `ctx.subagents` directly, so the inject name is `subagents` —
  **runtime probe still required** (host throws on non-injected reads,
  so the adapter must probe-guard exactly like tools/goals/approval).
- Investigation-only is enforceable by the plugin itself — no manual
  profile step. `agentPresets.register(definition)` is designed for
  "the declaring plugin": at apply time (with `agentPresets` injected,
  probe-guarded like every other seam) the adapter registers an
  `odf-reviewer` preset whose plugin list contains read-only tools
  only, and spawns specialists with `agentPreset: "odf-reviewer"`.
  Preset selection requires the `spawn` provider (`agentPreset: true`;
  verified in host source) — `fork` sets `agentPreset: false` and
  inherits the parent preset, so reviewers spawn self-contained with
  the adapter packing the diff/context into the child prompt.
  Without the `agentPresets` service, spawn proceeds preset-less with
  prompt-level instruction only — backstopped by the existing
  per-exec guards (they gate child execs too) and the child-artifact
  deny (plan 23). Exact read-only plugin list is slice 26.3, verified
  at probe time.

## Design

At a top-level gate block (turn-stopping, never for children — the gate
already skips them, so no regress), the adapter spawns one child per
needed specialist (pattern/style/correctness/evidence — reuse the
`.opencode/agents/*.md` prompt bodies verbatim as the child prompt plus
the changed-file list):

- `fork` provider for context-inheriting reviewers (they read the
  conversation), `spawn` where self-contained fits.
- Namespaced child names (`odf-pattern-guardian`, …), `delivery:
  "parent"`.
- Findings arrive as completion notices; the adapter folds them into
  the steer message (same channel as today, now with child findings
  attached); the lead writes the artifact; the gate re-evaluates.
- Degradation: no `subagents` service (probe-guard fails) → today's
  inline steer, unchanged. The inline path stays as the floor.
- Budgeting stays core-owned (block counts, standdown); cap concurrent
  specialists (one per kind per block).

## Unknowns requiring live probes (not more source reading)

1. Exact runtime inject name + probe behavior for `subagents` from a
   plugin-owned context.
2. Parent scoping: does a plugin-spawned activation with `parent`
   attach correctly outside a tool-exec ctx? Signal/abort semantics.
3. Completion-notice shape for folding findings into the steer.
4. Agent Preset story: minimal read-only preset doc for `dsh.md`;
   behavior without one (prompt-only restriction + guards).
5. Turn-stopping ergonomics: spawn-and-return (notices steer the next
   step) vs any await shape — deadlock check with the child running
   its own turns.

## Slices

- 26.1 Probe: `subagents` inject + `startActivation` from the adapter
  ctx on headless (throwaway patch, echo child). Fail-closed record.
- 26.2 Spawn path: one specialist (pattern-guardian) at gate block,
  findings folded into steer; degenerate-to-inline when seam absent.
- 26.3 Remaining specialists + naming/budget caps + preset doc.
- 26.4 Tests (stubbed `subagents` ctx) + live proofs (headless + TUI)
  - `dsh.md`/matrix updates.

## Acceptance

- Headless live: gate block spawns named children; their findings land
  in the steer; artifact cites them; `list_agents`-equivalent shows
  the ODF children during review.
- Seam absent (stock profile without inject): byte-identical behavior
  to today (inline steer), logged as degraded.
- Full suite green; no product-scope change to the OpenCode path.
