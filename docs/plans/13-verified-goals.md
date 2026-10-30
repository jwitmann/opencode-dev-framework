# Verified goals: native `/goal` + deterministic completion contracts

> **Status:** PROPOSED — research and design only; no implementation has been
> made from this document.
>
> **Date:** 2026-10-30.
>
> **Session handoff:** Work in `~/opencode-dev-framework`, on a suitable local
> branch. Read `AGENTS.md`, `docs/plans/00-restart-brief.md`,
> `docs/plans/10-experimental-stopping-dogfood.md`,
> `docs/plans/11-fork-pr-handover.md`, and
> `docs/plans/12-idle-hook-cutover.md` before implementing. OpenCode upstream is
> read-only ground truth for this work; our open stopping PR
> [`anomalyco/opencode#54487`](https://github.com/anomalyco/opencode/pull/54487)
> is a second, explicitly versioned compatibility target, not mainline behavior.
> Commit locally when a phase is complete; never push without an explicit user
> request.

## 1. Executive decision

Add a **verified-goal layer** to `opencode-dev-framework`; do **not** add a second
goal engine.

The proposed user-facing command is:

```text
/df-goal <objective>
```

It should delegate to OpenCode's native `/goal` and add a verification contract
to the objective. The contract requires the agent to run
`dev_framework_verify` after its final changes and obtain a passing result.
The native reviewer can then use that tool result as transcript evidence,
while the framework's existing idle gate remains the deterministic backstop.

The composition is deliberately:

```text
Native /goal
  = objective state + semantic review + persistence + continuations
  + stall handling + compaction handling + background-work handling

opencode-dev-framework
  = deterministic tests/typecheck/lint/acceptance commands
  + review requirements + pre-flight enforcement + bounded idle backstop

/df-goal
  = a thin adapter joining them; no new reviewer or goal state machine
```

There are two enforcement tracks to preserve from the start: mainline
`experimental.idle` continuation now, and our open `#54487`
`experimental.stopping` pre-`Complete()` vote when that core is available. The
shared completion report must support both. The first wrapper must not depend on
the unmerged PR, and the later stopping consumer must not double-admit alongside
idle.

Recommended first release scope:

1. Spike native `/goal` delegation on a core that contains it.
2. Make `dev_framework_verify` evaluate the full completion contract without
   mutating retry state.
3. Add named project-specific acceptance commands.
4. Add `/df-goal` as a native `/goal` wrapper.
5. Dogfood and document the coexistence limitations.

Evidence freshness and native-goal RPC status are follow-up phases, not reasons
to expand the first patch.

## 2. Research context

### 2.1 External harness patterns investigated

The research compared completion/correctness gates and prerequisite gates across
coding agents, agent runtimes, and workflow systems.

| System | Relevant gate pattern | Lesson for this project |
|---|---|---|
| Claude Code | `PreToolUse`, `TaskCreated`, `TaskCompleted`, `Stop`, and `SubagentStop` hooks can reject actions or completion. | Deterministic admission and completion checks are complementary extension points. |
| OpenAI Codex | `PreToolUse`, `PostToolUse`, `Stop`, and `SubagentStop`; a blocking stop response feeds work back to the agent. | A completion failure should become actionable agent feedback, not only a log line. |
| OpenHands Agent SDK | Blocking `PreToolUse` and `Stop` hooks, plus a built-in Goal Completion Loop with a separate judge and iteration cap. | A semantic goal judge and deterministic stop checks can be composed instead of choosing one. |
| Gemini CLI | `BeforeTool`, `AfterTool`, and `AfterAgent`; final response validation can trigger a retry. | Final-agent review is useful, but it does not replace project verification commands. |
| Aider | Automatic lint after edits and configurable test/fix feedback. | Narrow deterministic checks are high-value even without a workflow graph. |
| LangGraph | Explicit graph nodes, conditional edges, verification loops, persistence, and interrupts. | Hard prerequisites belong in controller-owned transitions when building a custom orchestrator. |
| Google ADK | Deterministic sequential/loop/graph workflows, callbacks, and human input. | Model discretion is not a reliable prerequisite mechanism. |
| Microsoft Agent Framework | Graph workflows, checkpoints, and human-in-the-loop requests. | Durable workflow state matters for long-running or multi-stage gates. |
| CrewAI | Task guardrails plus Flows for routing and dependencies. | Output validation and task ordering are separate concerns. |
| OpenAI Agents SDK | Input/output/tool guardrails, approvals, and lifecycle hooks. | Guardrails are useful primitives, but a task DAG still needs an outer controller. |
| Temporal/DBOS/Restate-style controllers | Durable external orchestration around agent workers. | This is the strongest boundary for non-bypassable multi-task prerequisites, but is outside this plugin's scope. |

Primary external references:

- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Codex hooks: <https://developers.openai.com/codex/hooks>
- OpenHands goal loop: <https://docs.openhands.dev/sdk/guides/convo-goal>
- OpenHands hooks: <https://docs.openhands.dev/sdk/guides/hooks>
- Gemini CLI hooks: <https://geminicli.com/docs/hooks>
- Aider lint/test: <https://aider.chat/docs/usage/lint-test.html>
- LangGraph workflows: <https://langchain-ai.github.io/langgraph/tutorials/workflows>
- Google ADK workflows: <https://google.github.io/adk-docs/agents/workflow-agents/sequential-agents>
- Microsoft Agent Framework workflows:
  <https://learn.microsoft.com/en-us/agent-framework/concepts/workflows>
- OpenAI Agents SDK guardrails:
  <https://openai.github.io/openai-agents-python/guardrails>

Conclusion from this comparison: the framework should not import another
runtime or build a durable DAG controller. OpenCode now supplies the semantic
objective loop natively; the highest-value addition is a reliable deterministic
proof contract around it.

### 2.2 Native OpenCode `/goal` findings

Native `/goal` landed through
[`anomalyco/opencode#59437`](https://github.com/anomalyco/opencode/pull/59437),
merged into `dev` on 2026-10-29. The same PR introduced the
`experimental.idle` hook already consumed by this framework. The 2.2.1 release
references the PR; the implementation spike must still feature-test the actual
core instead of assuming behavior from a version string.

Sources inspected (pin to the `#59437` merge commit SHA in addition to
these branch URLs before implementing; `dev` links drift):

- Implementation:
  <https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/plugin/goal.ts>
- Public schema/RPC:
  <https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/schema/src/goal.ts>
- Reviewer prompt:
  <https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/plugin/goal/judge.txt>
- Continuation prompt:
  <https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/plugin/goal/continuation.txt>
- Merge/behavior description:
  <https://github.com/anomalyco/opencode/pull/59437>

Observed native behavior:

- Commands: `/goal <objective>`, `/goal pause`, `/goal resume`, and
  `/goal clear`.
- Objective input is limited to 4,000 characters.
- A goal has `active`, `paused`, or `complete` status, with an objective,
  reason, round budget, stall count, boot ID, and update timestamp.
- The default backstop is 50 continuation rounds; three stalled rounds pause
  the goal. Resume starts a fresh round budget.
- At the would-go-idle boundary, `ctx.session.generate` asks the session's model
  to review the full conversation, including tool results.
- The reviewer returns one of `done`, `continue`, `blocked`, `paused`, or `wait`.
  The reviewer is instructed not to call tools and to require transcript
  evidence rather than the assistant's claim of success.
- `continue` admits a synthetic message through `experimental.idle`, so the
  goal remains one execution rather than a sequence of unrelated turns.
- Native code restates the objective in continuations and adds a transient
  reminder after compaction when needed.
- Native code handles reviewer parse failures, context overflow, background
  subagents/shells, a 30-minute wait limit, process restarts, user interruption,
  and pause/clear races.
- Public observability exists through RPC `opencode.goal`, with `get` and
  `changed`. Its storage prefix is private implementation detail and must not be
  consumed by this framework.

Relevant native limitations:

- There is no public external-verifier callback that can veto a reviewer
  `done` verdict before native state becomes `complete`.
- The reviewer currently uses the session model; the PR did not add a
  configurable reviewer model or token budget.
- The PR explicitly says `/goal` is not yet available through `opencode run`
  because that interface has no slash commands.
- The native goal plugin and this framework are independent idle-hook tenants.
  Their registration order is not a coordination contract, and both can admit a
  continuation at one boundary.

### 2.3 Our `experimental.stopping` PR (`#54487`)

This design must also account for our own upstream PR,
[`anomalyco/opencode#54487`](https://github.com/anomalyco/opencode/pull/54487),
authored by `jwitmann`. It was still open, targeting `dev`, when this plan was
researched. The inspected head was `dd3913ac484592294bf84418b133e5f30c408d6b`;
re-check the head and contract before using it.

Current PR behavior, distinct from mainline:

- `experimental.stopping` fires at natural turn end **before `Complete()`**.
- A voter can return `shouldContinue` plus steer text, admitted as a synthetic
  steer, or abstain so the turn ends.
- Continuation grants are capped at **two per turn**. The counter is owned by
  the drain continuation rather than session metadata, moves carry it, and
  fresh-input/reset behavior has explicit parked-queue handling.
- The default is fail-closed stop. A throwing voter logs a warning and stops;
  empty continuation text abstains.
- The vote runs interruptibly through `restore(...)`; an untrusted slow voter
  must not make abort/shutdown unresponsive.
- The documented boundary limitations still matter: votes occur only with no
  fresh input waiting, `step` is budget-relative, and an idle-boundary
  reload/move can end without a vote rather than manufacturing an extra one.

Our framework already dogfooded this contract from the PR consumer side. The
receipts in plans 10 and 11 and the PR description cover gate-fail → continue →
rework → pass, persistent failure → two grants then silent stop, counter/reset
races, interruptibility, and fail-closed voter behavior. The PR description
records dogfood with framework `v0.5.1`.

The relationship between the two upstream PRs is important:

| Capability | Mainline core with `#59437` | Older core such as our tested 2.0.26 | Core with our `#54487` |
|---|---|---|---|
| Native `/goal` | Yes | No native-goal assumption | Yes only if the PR core is current enough to include `#59437` |
| `experimental.idle` | Yes | No idle-hook assumption; event net remains fallback | Same native-goal/idle prerequisite |
| `experimental.stopping` | No, unless `#54487` later merges | No | Yes, behind the PR's experimental contract |
| Framework completion backstop | Idle synthetic continuation | Event idle net, or idle when backported/available | Can add a bounded pre-`Complete()` vote, with explicit idle/stopping arbitration |

`docs/plans/12-idle-hook-cutover.md` deliberately removed the old stopping probes
and made mainline idle-first. Do **not** resurrect the legacy V1 `"stopping"`
adapter and do not make the first `/df-goal` patch depend on our unmerged PR.
Instead, keep a clean optional consumer path for the current
`experimental.stopping` contract and validate both core lines.

Landing our stopping PR would improve terminal enforcement, but it would **not**
by itself make native goal status transactional. Native `/goal` could still set
its own status to `complete` before a framework stopping vote requests more
work. Terminal control and native goal-state agreement remain separate problems.

### 2.4 Current framework state and gaps

The framework already has most of the deterministic half:

- `src/index.ts` registers `experimental.idle` (plus the forward-compatible
  `idle` alias), runs completion evaluation, and admits a synthetic continuation
  on failure inside `gate.max_blocks`.
- The `event.subscribe` idle net covers boundaries skipped by the hook and is
  deduplicated against hook-handled boundaries.
- `src/gate.ts` runs typecheck, tests, and optional changed-file linting.
- `src/harness.ts` adds Git changed-file discovery, peer-review requirements,
  pre-flight artifact enforcement, block counting, and stand-down behavior.
- `tool.execute.before` remains the only genuine hard wall: pre-flight and
  protected-path denials happen before an edit lands.
- `docs/plans/12-idle-hook-cutover.md` already records that native `/goal` and
  this gate can coexist and can double-admit; ordering is undefined.

Gaps exposed by the proposed composition:

1. **Manual verification is not full completion verification.**
   `dev_framework_verify` calls `verifyGate` in `src/commands.ts`, which calls
   only `runGate`. It does not evaluate `gate.require_review`, even though its
   description calls it the completion gate.
2. **The gate vocabulary is fixed.** Tests, typecheck, and lint cannot express
   project-specific acceptance scripts without overloading one of those
   commands.
3. **Artifacts have no freshness binding.** `artifactState` treats every
   non-empty review or pre-flight artifact as present. An artifact from another
   session or an older change set can satisfy the requirement.
4. **There is no goal-aware evidence contract.** A native reviewer can assess
   the original objective without ever seeing a current deterministic gate
   result.
5. **Two independent completion decisions can diverge.** Native `/goal` may
   become `complete` while the framework still admits a correction for a failed
   gate. Conversely, native may continue after the framework has passed.
6. **Two loop budgets exist.** Native has rounds/stall limits; the framework has
   `gate.max_blocks` and stand-down/reset behavior. Their interaction must be
   observed, not imagined.

## 3. Recommended architecture

### 3.1 User flow

```text
User: /df-goal Implement the API contract change

/df-goal
  -> validate that verified-goal mode is meaningful and available
  -> append the framework verification addendum
  -> invoke native /goal exactly once

Native /goal
  -> owns kickoff, state, reviewer, pause/resume/clear, and continuations

Agent
  -> implements the objective
  -> runs dev_framework_verify after its last change
  -> receives PASS or FAIL as ordinary tool output in the transcript

Native reviewer
  -> evaluates both the original objective and the verification addendum
  -> uses the verification output as evidence

Framework idle gate
  -> independently evaluates the current workspace
  -> retains its existing bounded synthetic-continuation backstop
```

This is **layered verification**, not a transactional guarantee. A native
reviewer can still make a mistake, and the two idle tenants can still produce
different decisions. Documentation must say so.

### 3.2 Proposed objective addendum

`src/goal.ts` should build the final objective without rewriting the user's
text. The exact wording can be refined in tests, but it should be short and
semantically equivalent to:

```text
Verification contract added by opencode-dev-framework:

Before declaring this goal complete, run dev_framework_verify after your final
changes. A FAIL result means the goal is incomplete: fix the underlying cause
and run verification again. Any later edit invalidates an earlier verification
result. PASS is required but does not replace the original objective or its
acceptance criteria. Do not disable, skip, or weaken the configured checks to
obtain PASS.
```

Requirements:

- Preserve the original objective verbatim before the addendum.
- Treat the complete string as counting toward native `/goal`'s 4,000-character
  limit. Reject overflow with the original length, addendum length, and limit;
  never silently truncate.
- Count using the same unit native uses, confirmed by the Phase 0 spike (do not
  assume UTF-16 code units, bytes, or grapheme clusters). Compute the addendum
  length from the exact built string at delegation time, not a hardcoded
  constant, so future wording edits cannot desynchronize the accounting.
- Detect an objective that already contains the addendum text and append exactly
  once (never double-wrap on retry).
- Do not interpolate the objective into a framework-owned trusted system prompt.
  Native `/goal` already wraps and escapes its objective as untrusted data.
- Delegate once through `ctx.session.command({ sessionID, name: "goal", ... })`.
  The wrapper itself must not also admit a kickoff synthetic message.
- Do not create a second pause/resume/clear interface. Users continue to use
  native `/goal` controls and native goal status UI.

### 3.3 Availability and profile semantics

`/df-goal` means **verified goal**, not merely an alias for `/goal`.

- On a core without native `/goal`, return a clear capability error. Do not
  silently start an unverified substitute and do not fall back to a synthetic
  prompt with similar wording.
- When `profile: off`, reject with guidance to enable a blocking profile or use
  native `/goal` directly. A vacuous verification tool must not be presented as
  evidence.
- Respect existing `gate.block_on_failure` semantics. Do not make `advisory`
  acquire a new blocking side channel merely because `/df-goal` was used.
  The recommended initial rule is to allow `/df-goal` only when
  `gate.block_on_failure` is true. The rejection error must name the exact
  config key and value found, and point at the two alternatives: enable a
  blocking profile or use native `/goal` directly.
- Fail fast when the resolved configuration provides no meaningful completion
  check at all. "Meaningful" is a static config predicate, locked in `config.ts`
  with unit tests before `src/goal.ts` uses it: at least one of `gate.typecheck`,
  `gate.tests`, changed-file lint, a non-empty `gate.acceptance` list, or
  `gate.require_review` must be active. A configuration with none of these is
  vacuous. Users wanting a purely semantic objective can use native
  `/goal`; `/df-goal` must not imply deterministic evidence where none exists.
  This should be a static config validation, not an extra test-suite run before
  the goal starts.

The implementation spike may discover a cleaner capability-detection mechanism;
if so, record it rather than catching every error and mislabeling it as
“native goal unavailable.”

### 3.4 Full, side-effect-free completion inspection

Refactor `src/harness.ts` so the current completion logic has two layers:

```text
inspectCompletion (new, side-effect-free policy inputs -> raw report)
  -> changed files
  -> GateReport
  -> review required / state / missing
  -> raw ok or fail
  -> human- and transcript-readable summary

evaluateCompletion (existing policy owner)
  -> inspectCompletion
  -> off/advisory behavior
  -> block counting
  -> tracker clearing
  -> stand-down
  -> existing CompletionVerdict
```

The exact names are tentative; preserve the current public/tested behavior of
`evaluateCompletion` unless a change is explicitly intended.

`dev_framework_verify` and `/df-verify` should use the inspection layer so they
report the **same full contract** as idle completion, including review state.
Manual verification must not:

- increment or clear `gate.max_blocks` state;
- clear the changed-file tracker;
- admit `prompt` or `synthetic` input;
- change profile or configuration;
- convert a raw failed check into `PASS` merely because the active profile is
  advisory.

Use the live tracker when called from the server tool and retain Git changed-
file discovery so manual verification does not silently miss changes.

Give the tool output a stable first-line verdict, for example:

```text
DEV_FRAMEWORK_VERDICT: PASS
```

or:

```text
DEV_FRAMEWORK_VERDICT: FAIL
```

Follow it with the existing detailed gate/review summary. The line is evidence
formatting, not a security boundary; do not claim it prevents an agent from
writing misleading prose elsewhere. The evidence the native reviewer should
weigh is the `dev_framework_verify` *tool result* (role `tool_result`), not a
grep for the verdict string in assistant prose — document this so users check
the tool-result role.

### 3.5 Named acceptance commands

Add an optional native-config field:

```yaml
gate:
  acceptance:
    - name: api-contract
      command: ./scripts/verify-api-contract.sh
    - name: migration-safety
      command: ./scripts/check-migrations.sh
      timeout: 120
```

Suggested shape:

```ts
interface AcceptanceCheck {
  name: string
  command: string
  timeout?: number
}
```

Behavior:

- Default to `[]`, preserving all existing configurations.
- Require unique, non-empty names and non-empty command strings; timeouts must
  be positive.
- Run after existing typecheck/test steps and before or after changed-file lint
  in a documented fixed order. Prefer preserving the existing steps and
  appending acceptance checks to minimize behavior change.
- Continue aggregating other steps after a failure, matching `runGate`'s current
  all-results behavior.
- Represent steps as `acceptance:<name>` in `GateReport` and summaries.
- Reuse `splitCommand`, `substituteFiles`, `RunCommand`, the project `cwd`, and
  the existing default/gate timeout behavior. Do not add a shell execution
  pathway or a new dependency.
- Execute sequentially in the first version. Parallel checks complicate shared
  build directories, output ordering, and resource use.
- Follow the existing `skip_unchanged` rule: acceptance checks run when the gate
  runs and are skipped when the gate skips. Document this explicitly so contract
  scripts that depend on generated (untracked) state declare their needs rather
  than assuming they always execute.
- Do not add `dependsOn` or a prerequisite DAG to this field. Actual pre-work
  prerequisites remain the pre-flight gate's responsibility.
- Native YAML/JSON config only in the first version. Do not invent a lossy flat
  `.dev-framework.yml` representation unless a compatibility requirement appears.

### 3.6 Two enforcement tracks: mainline idle and our stopping PR

The completion-inspection refactor in §3.4 must be enforcement-neutral. Both of
these consumers should be able to reuse the same raw report:

```text
Mainline core
  -> experimental.idle / event idle net
  -> existing bounded synthetic continuation

Core with #54487
  -> experimental.stopping before Complete()
  -> bounded pre-terminal continuation vote
  -> idle hook/net only as deliberately deduplicated backup, never a duplicate
     continuation for the same boundary
```

The first `/df-goal` wrapper uses the mainline track and must not require the PR.
A later stopping-consumer patch may defensively register the current
`experimental.stopping` hook, subject to these rules:

- Reintroduce only the PR's current contract, not the removed legacy V1 probe.
- Respect both `event.continuations` (the core's two-grant cap) and
  `gate.max_blocks`; never fight or reset the core budget.
- Define one owner per completion boundary and a shared verdict/dedup strategy
  before registering both paths. A pass at stopping must not cause the same test
  suite to run again immediately at idle, and a stopping grant must not be
  followed by an idle grant for the same failure.
- Keep voter bodies interruptible and internally guarded, matching the existing
  idle handler's no-escape error policy and the PR's fail-closed/logging
  semantics.
- Preserve the idle event net for documented stopping skip paths, but prove that
  it cannot double-continue an already granted boundary.
- Report the active enforcement path accurately in `/df-status` and
  `/df-runtime`: mainline idle, stopping-capable, or fallback. Do not describe
  the PR path as unbounded or as native goal-state synchronization.

If this arbitration cannot be made clear and testable, ship `/df-goal` with the
existing idle track and leave stopping re-registration for a subsequent patch.
Do not block the wrapper on an unmerged API, but do not design the shared report
so that a stopping consumer becomes impossible.

## 4. Explicit non-goals and rejected designs

### 4.1 Do not clone native `/goal` or OpenHands' goal loop

No new goal reviewer, goal storage schema, boot IDs, timers, stall detector,
compaction reminder, pause/resume state, or 50-round driver. Native `/goal`
already has these and is more complete than a small plugin-local copy would be.

### 4.2 Do not intercept `session.generate` to force native verdicts

The native reviewer uses `session.generate`, but that API is also available to
other callers. An active goal does not prove that every `generate` request is
the goal reviewer. Matching the current reviewer prompt would be brittle and
would couple the plugin to private prompt text. Overriding `event.result` or
injecting a fabricated verdict risks unrelated generation calls.

### 4.3 Do not read or write native goal storage directly

The native storage prefix and replace logic are private. Direct access would
create race conditions and schema drift. Read-only status integration, if added
later, must use public RPC `opencode.goal`.

### 4.4 Do not automatically pause/resume/restart native goals

Using native commands to pause on framework failure and resume after a pass
would change user-visible state, interact with native races, and reset budgets
on resume. A premature native `complete` cannot be safely repaired by secretly
starting another goal. Keep the framework backstop independent.

### 4.5 Do not claim an unconditional completion veto

On mainline, `/df-goal` adds evidence and an idle backstop; it does not make
native completion transactional. The user can stop a session, the native
reviewer can err, and the framework can stand down after its own cap. Existing
documentation language about bounded continuation remains authoritative there.

On a core with our `#54487`, the framework may instead use a **bounded
pre-`Complete()` continuation vote**. That is stronger and earlier than the idle
backstop, but it is still capped, interruptible, and independent of native goal
status. Never describe either track as an unbreakable or unlimited lock.

### 4.6 Do not add an external workflow engine

Temporal, LangGraph, ADK, DBOS, and similar systems are valid architectures for
larger orchestrators, but they are unnecessary dependencies for this plugin
feature.

## 5. Implementation phases and file map

### Phase 0 — Capability and coexistence spike

**Objective:** Prove the adapter against a real native-goal core before changing
production behavior.

Tasks:

1. Use an OpenCode build containing `/goal` (2.2.1 is the initial release line to
   check) and the locally built framework loaded exactly once from the repo root.
2. Confirm a server `ctx.command.transform` command can invoke native `/goal`
   through `ctx.session.command` with the expected objective and delivery.
3. Confirm error behavior when the native command is absent.
4. Confirm the 4,000-character accounting and whether any wrapper text is
   transformed before native storage.
5. Observe one boundary where both native `/goal` and the framework idle gate
   want to continue. Record ordering, transcript messages, and native goal
   status; do not promise deduplication.
6. Record whether the test interface is interactive-only, matching the native PR
   limitation for `opencode run`.
7. Repeat the relevant probe on a core containing our current `#54487` **and**
   native `/goal`/`experimental.idle`. If the stopping branch needs a rebase to
   include `#59437`, that is fork work for its owner/session, not an excuse to
   test against an outdated contract and call it current.
8. On the PR core, map the actual sequence of native goal review, stopping vote,
   idle hook, and terminal completion for pass, framework-fail, native-continue,
   and dual-continue cases. Determine whether shared verdict caching/deduplication
   is necessary before proposing stopping re-registration.

Files:

- Prefer focused tests/spike scaffolding only until behavior is known.
- Expected follow-ups: `tests/goal.test.ts`, `docs/plans/08-notes.md`.
- Any core changes belong to the separately owned `#54487` branch/PR, not this
  framework patch.

Exit condition: delegation and error semantics are known well enough to avoid
guessing in `src/goal.ts`, and the mainline/PR enforcement tracks have an actual
observed ordering rather than an assumed one.

### Phase 1 — Full verification + acceptance commands

These can be two local commits. They may be developed in parallel only after
agreeing on the raw completion report shape; otherwise do full verification
first and acceptance commands second.

#### 1A. Full verification refactor

Files:

- `src/harness.ts`
- `src/commands.ts`
- `src/index.ts`
- `tests/harness.test.ts`
- `tests/commands.test.ts`
- `tests/verify-tool.test.ts`
- Any TUI verification tests affected by full review reporting

Requirements:

- Extract side-effect-free inspection from retry policy.
- Keep the raw report independent of idle versus `experimental.stopping`
  transport so our PR consumer can reuse it without a second gate implementation.
- Preserve existing idle verdict/block/stand-down behavior.
- Include review status in manual verification.
- Add stable PASS/FAIL output.
- Prove manual verification has no retry/tracker/continuation mutations.

#### 1B. Acceptance commands

Files:

- `src/types.ts`
- `src/config.ts`
- `src/gate.ts`
- `tests/config.test.ts`
- `tests/gate.test.ts`
- `examples/go-service/.opencode-dev-framework.yml`
- `docs/plans/03-config-spec.md`

Requirements:

- Implement the schema and sequential aggregation described above.
- Keep default behavior byte-for-byte compatible where practical.
- Test command timeout selection and `{files}` handling if supported.

### Phase 2 — `/df-goal` wrapper

Files:

- New `src/goal.ts`
- `src/index.ts`
- `src/format-status.ts` for `/df-help`
- New `tests/goal.test.ts`
- Registration-count updates in `tests/smoke.test.ts`,
  `tests/teardown.test.ts`, or their current equivalents
- `README.md`
- Relevant existing architecture/hook/configuration documentation

Tasks:

1. Implement objective validation and addendum construction as pure functions.
2. Register `df-goal` through `ctx.command.transform` and dispose its
   registration through the existing teardown mechanism.
3. Delegate exactly once to native `/goal`.
4. Implement the availability/profile/meaningful-check rules from §3.3.
5. Keep native goal controls and native status UI untouched.
6. Update `/df-help` without implying that `/df-goal` is a hard lock.
7. Document that native `/goal` and the framework can both continue a session
   and can disagree about completion.

### Phase 3 — Optional `#54487` stopping-consumer track

This phase is not a prerequisite for the mainline wrapper. It is required before
claiming support for the stronger pre-`Complete()` path on our PR core.
Entry criterion: Phase 0 must have produced the observed ordering table
(native goal review vs. stopping vote vs. idle hook vs. terminal completion for
pass, framework-fail, native-continue, and dual-continue cases) on both cores.
Phase 3 does not start on assumed ordering.

Likely files:

- `src/index.ts`
- `src/harness.ts` or a small boundary-verdict/dedup module
  (preferred: a new tiny `src/boundary-verdict.ts` owning the raw-report cache
  keyed by completion boundary/turn with invalidation on any new tracked or
  Git-discovered edit; do not merge this cache into `block-store.ts`, which owns
  retry policy, without an explicit reason)
- `src/block-store.ts` only if the existing store is the right owner; do not
  revive its removed stop-rank model by default
- `src/runtime-status.ts` and `src/format-status.ts`
- New stopping/idle arbitration tests plus existing idle, teardown, and runtime
  tests
- `README.md` and current enforcement/hook documentation

Tasks:

1. Register only the current `experimental.stopping` contract defensively,
   alongside but not conflated with the mainline idle path.
2. Implement one-boundary/one-verdict/one-continuation arbitration based on the
   Phase 0 observations. Include pass, failure, stand-down, throw, interruption,
   and native-goal continuation cases.
3. Respect the PR's two-grant core cap and our plugin cap. Surface effective
   behavior honestly rather than allowing both budgets to reset independently
   without explanation.
4. Keep voter execution interruptible and errors contained/logged according to
   the PR contract. Test the event-net fallback for skip paths without duplicate
   continuations.
5. Dogfood the same objective on mainline and on a current PR core containing
   native `/goal`; record differences in native status, terminal timing, and
   continuation counts.
6. If clean arbitration is not achievable with public events, stop at the
   mainline implementation and record the missing receipt/ordering primitive.
   Do not use private core state to manufacture coordination.

### Phase 4 — Evidence freshness and stronger prerequisites (follow-up)

Do not hide this work inside the first wrapper patch.

Problems to solve:

- A non-empty `review.md` or `preflight.md` from an old session currently passes.
- A review produced before later product edits may no longer describe the final
  change set.

Required design work before coding:

1. Choose a session identity and change-set binding that survives resume/reload
   without making every server restart invalidate legitimate evidence.
2. Exclude framework evidence artifacts themselves from the product-change
   fingerprint or freshness calculation.
3. Handle Git and non-Git workspaces, untracked files, generated files, and
   edits made outside tracked tool events.
4. Preserve the pre-flight artifact's writability while it is required.
5. Add optional machine-checked pre-flight verification only after the freshness
   model is clear. A reasonable target is an optional command whose success is
   cached for the applicable session/precondition, with failures included in
   the existing hard-deny reason.

Likely files:

- `src/harness.ts`
- `src/index.ts`
- A small evidence-store module if `block-store.ts` is not an appropriate owner
- `src/types.ts` and `src/config.ts` for any pre-flight command config
- `tests/harness.test.ts`, storage tests, config tests, and idle/edit integration
  tests

Acceptance scenarios:

- Last session's non-empty artifact does not satisfy a new session.
- Evidence remains valid across an intended resume of the same session/goal.
- A product edit after review invalidates review evidence.
- Rewriting only the evidence artifact does not create an infinite invalidation
  loop.
- A failing pre-flight command denies product edits before they land; read-only
  inspection remains available.

### Phase 5 — Native goal status through public RPC (optional)

Only after the wrapper is stable:

- Upgrade/probe the plugin SDK as a separate compatibility task if necessary.
- Consume `opencode.goal` `get`/`changed` through the public RPC definition.
- Show native objective/status/reason in `/df-status` or a separate status view.
- Treat this as observability only. Do not suppress the framework's failed-gate
  continuation merely because native status is `complete`.
- Do not implement goal control through RPC; the public definition inspected
  during research exposes read/change notifications, not a gate-vote API.

## 6. Test plan

### 6.1 Unit tests for `/df-goal`

Cover at least:

- Objective is preserved verbatim and addendum is appended once.
- An objective already containing the addendum is not double-wrapped.
- Empty/whitespace-only objective is rejected.
- Exact native-limit objective is accepted; one character over is rejected with
  useful length information.
- No silent truncation or Unicode-unaware slicing.
- Native `/goal` is called exactly once with no wrapper-owned kickoff.
- Native command errors propagate without an unverified fallback.
- Missing native capability produces the intended actionable error.
- `off`, non-blocking, and vacuous-check configurations follow §3.3.
- Registration is disposed during teardown and stale handlers cannot delegate.

### 6.2 Unit tests for full verification

Cover at least:

- Green commands plus valid review evidence produce PASS.
- Green commands plus required/missing review evidence produce FAIL.
- Failed commands produce FAIL even when review evidence exists.
- Manual verification does not increment, clear, or reset block counts.
- Manual verification does not clear the changed-file tracker or admit input.
- Advisory manual output reports raw failure while idle advisory behavior stays
  non-blocking.
- Idle `evaluateCompletion` retains its existing block and stand-down tests.
- Git-discovered changes are included when the tracker is empty.

### 6.3 Unit tests for acceptance commands

Cover at least:

- Missing `acceptance` preserves old behavior.
- Invalid names, duplicate names, empty commands, and invalid timeouts fail
  config validation with readable paths.
- Steps run in declared order and are labeled `acceptance:<name>`.
- One failed acceptance command produces a failed report while other configured
  steps still run.
- Per-check timeout overrides and gate/default fallback are correct.
- Changed-file substitution and project `cwd` match existing command semantics.

### 6.4 Optional stopping-track tests

When Phase 3 is implemented, cover at least:

- Current `SessionStopping` grant shape maps from the same raw failure report
  used by idle/manual verification.
- Pass and stand-down abstain; empty grant text never manufactures a turn.
- `event.continuations` and `gate.max_blocks` are both respected without trying
  to reset the core-owned counter.
- One boundary produces at most one framework continuation across stopping,
  idle hook, and event net, including error and move/reload paths.
- A stopping pass does not immediately rerun the same suite at idle without a
  new workspace/turn boundary.
- A throwing/interrupted voter follows the PR's documented behavior and does not
  escape into an unhandled core failure.
- No legacy V1 `"stopping"` handler is reintroduced.

### 6.5 Live dogfood matrix

Use a disposable project or worktree with a small deterministic test/acceptance
command. Load the local plugin exactly once and rebuild `dist/` first. Run the
matrix on mainline native-goal core; repeat the enforcement-sensitive rows on a
current core containing both native `/goal` and our `#54487`.

| Scenario | Required observation | Live receipt (2026-10-30) |
|---|---|---|
| Initial failure, then fix | `dev_framework_verify` FAIL is visible in the transcript; the goal does not legitimately complete; after the fix PASS is visible and native goal can complete. | ✅ D1 (headless): tracked edit → single verify PASS → native complete, exit 0; idle re-passed 4× on later boundaries. Interactive D-live-1–4: same cycle in TUI, `Goal complete`/`goal met`. |
| Verify, then edit again after PASS | A product edit after PASS invalidates the earlier result: the addendum clause fires in the agent loop and the idle gate rechecks current state rather than accepting the stale PASS. | ✅ D1b (headless): PASS → re-break → FAIL `test: failed (exit 1)`. Interactive round 4: post-complete shell re-break → idle FAIL → synthetic → agent diagnosed, fixed, re-verified PASS. |
| Green commands, missing review | Full verification returns FAIL for review, demonstrating the manual/idle contract now matches. | ✅ D3/D3b: agent wrote `review.md` from constitution knowledge before first verify; exact FAIL verdict unit-pinned (`tests/commands.test.ts`), live shows self-remediation. |
| Native and framework both fail | Record whether one or two continuations arrive. No deadlock, config edits, or hidden goal restart. | ✅ D2c: exactly one synthetic continuation per boundary (1/2, 2/2); native silent; no deadlock, no double-admit. |
| Native reviewer says done while framework fails | Record native status and framework backstop behavior; document this as a known possibility, not an unexpected hard guarantee. | ➖ Documented, not observed: two labeled-trap runs (`df-goal-diverge/`) produced agreement both times — diligent agent never declares done on FAIL, reviewer never contradicted the gate in any run. Divergence with a diligent agent appears structurally hard to reach; needs a deceived/non-diligent agent class. |
| Persistent failure | Observe native stalls/rounds and framework `max_blocks`/stand-down/reset interaction. Confirm there is a bounded path out and an honest unmet-requirement message. | ✅ D2c: FAIL ×2 → block → block → stand-down with STILL-unmet message naming the check; fixture untouched, exit 0. |
| PR-core stopping grant and cap | On `#54487`, failure requests a pre-`Complete()` continuation, the two-grant core cap remains intact, and idle does not duplicate the grant. Persistent failure still ends with an honest unmet-requirement report. | ➖ Partial (2026-10-30): P2 on the PR checkout (`feat/experimental-session-stopping` + `#59437` in HEAD, dev CLI + channel-DB override) reproduces the mainline cap path exactly (block → synthetic → block → stand-down, no double-admit). But no stopping voter is registered (Phase 3 not implemented), so grant/cap arbitration is untested; headless logs also carry no stopping-vote events. |
| PR-core stopping/idle pass boundary | A passing stopping evaluation does not immediately rerun the same gate at idle; native goal review and native status remain distinct from terminal enforcement. | ➖ Partial: P1 passes on the PR core with no duplicate gate run observed — but with no voter registered this is the idle tenant alone, not an arbitration result. Needs the Phase 3 voter. |
| PR-core interruption and move/reload | A slow verification remains interruptible; documented no-vote boundaries use the fallback without duplicate continuations or an increased budget. | ❌ NOT run: needs the Phase 3 voter plus targeted skip-path fixtures (PR checkout itself is available and runs the framework — see `08-notes.md` PR-core section). |
| User pause/clear during verification | Native user control wins for native state; framework does not rewrite goal state or issue goal resume. | ✅ Pause receipted interactively (rounds 2–3): 40 s runs outran pause twice (boundary-paced, not preemption); with a 45 s slow gate, pause landed (`goal paused`), user resumed, agent re-verified fresh → PASS; framework never touched goal state. `clear` mid-run exercised 2026-10-30 (issued while `dev_framework_verify` spun; status UI vanished, stayed dark, framework re-issued nothing). |
| Compaction during active goal | Objective and verification addendum survive through native reminder/continuation behavior; verification still runs on the current tree. | ❌ NOT run: needs context pressure / a long session; no receipt. |
| Older core | `/df-goal` fails clearly while existing guardrails and idle gate continue to work. | ✅ Sandboxed v2.2.0: `dfGoalPresent: true, goalPresent: false`, §3.3 capability error verbatim, no substitute; guardrails + `dev_framework_verify` work (D6-220 FAIL-review). Idle-backstop engagement on old core unconfirmed. (2.0.26 negative finding: its resolver silently skips conditional-`exports` packages, so the plugin can't load there at all.) |
| No meaningful checks configured | `/df-goal` rejects instead of manufacturing a vacuous PASS; native `/goal` remains available directly. | ✅ D4 (headless) + D4-220 (old core): rejected pre-delegation with the actionable error; session exited 0, no substitute. |

Capture logs and actual transcript evidence in `docs/plans/08-notes.md` or the
implementation handoff. Do not record invented expected behavior as a receipt.

## 7. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Native and framework both admit at one idle boundary | Duplicate or conflicting work | Preserve inbox behavior, test it live, document it; do not claim cross-plugin deduplication. |
| Native marks goal complete before a failed framework gate | UI says met while correction continues | Keep deterministic backstop; document non-transactional completion even when `#54487` supplies a terminal vote; consider a future native goal gate API for status agreement. |
| Mainline and our stopping PR diverge | Wrapper works on one core but double-runs or loses enforcement on the other | Keep the first wrapper mainline-only; Phase 0 observes both cores; Phase 3 requires explicit stopping/idle arbitration and dual-core receipts. |
| Agent verifies and then edits again | Stale PASS evidence | Addendum invalidates earlier verification; idle gate rechecks current state; Phase 4 strengthens artifact evidence. |
| No real commands are configured | Vacuous “verified” goal | Static meaningful-check validation before delegation. |
| Old non-empty artifacts satisfy review/pre-flight | False prerequisite/completion evidence | Explicitly document until Phase 4; then bind evidence to session/change set. |
| Objective plus addendum exceeds native limit | Native rejection or truncation | Validate total length before delegation; never truncate silently. |
| Goal prompt becomes an instruction-injection channel | Reviewer or agent follows unintended text | Preserve objective as untrusted native input; keep framework addendum concise; do not intercept trusted system generation. |
| Gate cost on every goal round | Slow, expensive loops | Retain `skip_unchanged`, bounded timeouts, sequential checks; inspect live cost before adding caching or extra model calls. |
| SDK/version drift | Wrapper or RPC breaks on older cores | Feature-test native command; keep `/df-goal` isolated; make SDK upgrade/RPC a separate phase. |
| Two independent caps interact badly | Premature stand-down or prolonged looping | Dogfood persistent failure and record actual behavior before tuning either budget. |

## 8. Validation, review, and delivery

For every implementation phase, follow `AGENTS.md`:

```bash
npm install
npm run format:check
npm run lint
npm run lint:md
npm run typecheck
npm run test
npm run build
```

Additional requirements:

- Run the existing idle continuation, teardown, permission, and verification
  suites; do not treat only the new tests as sufficient.
- Run the mandatory peer-review process for the applicable phase and write the
  required review artifact. Resolve every Blocking and Should-fix finding or
  record a justified disposition.
- Update `docs/plans/05-implementation-checklist.md`, `README.md`, `AGENTS.md`,
  and relevant existing architecture/config/hook documents as behavior lands.
- Keep `dist/` and release actions consistent with repository policy.
- Commit each coherent phase locally. Never push or publish without an explicit
  user request.

## 9. Definition of done

### First verified-goal release

- [x] Native delegation and unsupported-core behavior were established by a real
      spike. (Phase 0 C-series; receipted in `08-notes.md`.)
- [x] Manual and idle verification evaluate the same full completion contract.
      (Phase 1A; `inspectCompletion`, `DEV_FRAMEWORK_VERDICT`.)
- [x] Manual verification is free of retry/tracker/continuation mutations.
      (Phase 1A; unit-pinned, no mutations observed live.)
- [x] Named acceptance commands are validated, aggregated, and documented.
      (Phase 1B; `gate.acceptance`, `03-config-spec.md`, example yml.)
- [x] `/df-goal` preserves the objective, enforces total length, and delegates
      exactly once. (Phase 2; `src/goal.ts`, 23 unit tests; one delegation
      per run observed live.)
- [x] `/df-goal` cannot silently become an unverified or advisory substitute.
      (Phase 2 §3.3 rejections; D4/D4-220 live receipts, no substitute started.)
- [x] Existing idle gate behavior and teardown protections remain intact.
      (Full suite green throughout; D2c cap path; teardown tests.)
- [x] Dual-continuation and divergent-verdict limitations are documented without
      claiming a hard veto or cross-plugin coordination. (One-tenant D2c;
      divergence documented-but-unobserved after two trap runs; `03`, `08`.)
- [ ] Mainline `/df-goal` does not require unmerged `#54487`; a current PR core
      was included in the Phase 0 ordering/capability observations.
      (First half holds — wrapper is mainline-only. Second half OPEN: no PR
      core containing both native `/goal` and `#54487` was available; Phase 3
      entry criterion unmet, not a prerequisite.)
- [x] The live dogfood matrix has actual receipts, including failure and cap
      paths. (Headless D1/D1b/D2c/D3/D4 + interactive D-live + divergence
      trap + sandboxed 2.2.0 old-core + PR-core delegation/parity (P1/P2/P3);
      compaction, `clear`, and PR-core arbitration rows explicitly open — see §6.5.)
- [x] Full validation and peer review pass. (Format/lint/typecheck/test/build
      green per phase; peer-review clean before each commit.)
- [x] Changes are committed locally; nothing is pushed without user approval.

### Optional stopping-track completion

Required only if Phase 3 ships or release notes claim `#54487` support:

- [ ] Current `experimental.stopping` is supported without reviving legacy V1
      stopping behavior.
- [ ] Stopping, idle hook, and event net have tested one-boundary arbitration;
      no duplicate grant or immediate duplicate gate run is observed.
- [ ] Core and plugin caps, interruption, voter failure, and move/reload behavior
      have dual-core receipts.
- [ ] Documentation distinguishes pre-`Complete()` terminal enforcement from
      native goal status, which can still diverge.

### Follow-up evidence work

- [ ] Old artifacts no longer satisfy unrelated sessions/change sets.
- [ ] Evidence artifacts do not invalidate themselves.
- [ ] Machine-checked pre-flight prerequisites fail before product edits land.
- [ ] Any native goal status integration uses only public RPC and does not weaken
      the deterministic backstop.

## 10. Upstream paths

### 10.1 Land our stopping PR first for stronger terminal enforcement

`#54487` is the existing upstream path for a bounded pre-`Complete()` vote. If it
merges, re-run the Phase 0 contract check against the merged shape and implement
or enable Phase 3; do not wait for a second goal-specific API merely to obtain
the terminal primitive. Also do not assume the merged PR makes native `/goal`
and framework verdicts atomic.

### 10.2 Possible native goal completion-gate API

If transactional native goal-state integration becomes a requirement, prefer an
upstream public **goal completion-gate contribution API**: native `/goal` would
collect required deterministic verdicts before accepting a reviewer's `done` and
before publishing `complete`. The contributed verdict should carry the raw
report (which checks failed and why), not just pass/fail, so native can surface
the reason in its own status.

That would be cleaner than intercepting `session.generate`, depending on
registration order, or trying to reverse a native completion after the fact. It
could complement our general stopping hook rather than replace it. This second
API is not part of the plugin-only plan and should not be simulated with private
APIs.
