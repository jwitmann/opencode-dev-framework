# §13.6 Dogfood: `experimental.stopping` consumer probe

> **Session handoff.** Working directory for this plan is the framework repo
> (`~/opencode-dev-framework`), on its own branch. Do NOT touch the OpenCode
> fork (`~/opencode`) from this session — it is read-only ground truth.
> Commit locally when done; never push without an explicit request.

## 1. Objective

Adapt the existing defensive `session.stopping` probe to the new V2
`experimental.stopping` contract and validate block / continue /
cap-exhaustion against a locally-built core running a real GATE scenario.
This is step 6 of the fork's work breakdown; steps 1–5, 7–8 are done and
committed there.

## 2. Ground truth (read-only, in `~/opencode`)

- Branch `feat/experimental-session-stopping`, commit `d6389406a0`.
- Contract: `docs/01-design.md` §4 in
  `/home/jerome/opencode-session-stopping/docs/01-design.md`
  (hook name `experimental.stopping`, single mutable event).
- Event shape (authoritative — do not guess, do not port the V1 shape):

```ts
interface SessionStopping {
  readonly sessionID: string
  readonly step: number          // model steps executed this turn
  readonly stepsLimit?: number   // agent's configured step limit, when set
  readonly continuations: number // grants so far this turn (pre-increment)
  decision: { shouldContinue: false } | { shouldContinue: true; text: string }
}
```

- Semantics: default `{ shouldContinue: false }` (fail-closed); registration
  order, last-writer-wins; at most **2** continuations per turn, exhaustion
  stops silently **without calling voters**; a throwing voter stops the turn
  (interruption still propagates); empty/whitespace-only `text` abstains.
- Two code-vs-design deviations already in the committed core (do not
  "fix" these from here — they are intentional, report them if they bite):
  - the vote's `step` is a dedicated `executedSteps` counter, not
    `step - 1` (the drain resets `step` to 1 just before mid-work votes);
  - the durable-counter reset runs on `!continuing` alone, not
    `!force && !continuing` (`session.resume` starts forced drains).
- Reference docs for the hook (mirrors of the implementation):
  `services/www/src/docs/content/build/plugins/effect.mdx` and `index.mdx`,
  "Stopping" subsections.

## 3. Current state (this repo)

- `src/index.ts:387-437` (§1b) registers a defensive `"stopping"` probe in
  the **old V1 shape** (`out.stop = false` + `out.message`, PR #44712).
  It is the ONLY `any`-cast in `src/` — deliberate, because the hook is
  not in `SessionHooks` on released cores.
- Fallback enforcement is `session.idle` re-prompt via `ctx.session.prompt`
  inside `gate.max_blocks` (plugin-owned; see `docs/plans/04-hook-mapping.md`).
- Supporting modules: `src/harness.ts` (verdict orchestration),
  `src/gate.ts` (adapter), `src/registry.ts` (`stopHookSupported` flag —
  extend it, don't fork it, to distinguish "old probe fired" from
  "new hook fired" for `/df-status`).

## 4. Tasks

1. **Register `experimental.stopping` alongside the `"stopping"` probe**
   (alongside, NOT replacing — the same dist must keep working on
   mainline builds that lack the new core). Keep the same defensive
   `try/catch` + `safeLog` pattern as §1b.
2. **Map the existing verdict**: reuse `runCompletion(state, sessionID)` /
   `actOnVerdict`; gate fail →
   `event.decision = { shouldContinue: true, text: message }`;
   gate pass → leave the default (abstain). Respect `event.continuations`
   for tighter local policy; never fight the core cap — expect silence
   after 2 grants.
3. **No provider scoping** for the new hook: the event carries no model, so
   a `providerID` option would never fire. Do not add one.
4. **Extend `stopHookSupported` reporting** (registry + `/df-status`) so
   operators can see which enforcement level is active:
   none → idle-fallback → old probe → new hook.
5. **Tests** (vitest, existing harness style): fail→grant shape,
   pass→abstain, `continuations` pre-increment observed, both probes
   co-registered. Do not assert core-side behavior (cap silence,
   throw-is-stop) — that belongs to the fork's `session-runner.test.ts`.
6. **Rebuild** (`npm run build`) so `dist/` picks up the probe, then
   validate live (see §5).

## 5. Live validation (fork + `~/animeRSS`)

- Launch the fork (plain `bun dev` — never `dev:live`, which would attach
  to the installed mainline service and bypass the new core):
  `cd ~/opencode && bun dev ~/animeRSS`.
- Never run fork and installed `opencode` concurrently on the same session.
- Scenario: break typecheck in `~/animeRSS`, then:
  - gate fails → turn continues with the steer text, agent re-works;
  - gate passes → turn ends naturally;
  - persistent failure → exactly 2 continuations, third stop is silent
    (voters not called — confirm from logs).
- **Receipts for the upstream PR**: which votes fired with which
  `continuations`/`step`, request counts, cap-exhaustion silence.

## 6. Done when

- [ ] `experimental.stopping` registered alongside `"stopping"`, verdict
  mapped, status reporting distinguishes the levels.
- [ ] `npm run build`, `npm test`, `npm run lint`, `npm run format:check`,
  `npm run lint:md` all green (repo commands — npm, not bun; dev runtime
  is Node 22).
- [ ] Live-validation receipts recorded (paste logs into the PR/dogfood
  note, not into this plan).
- [ ] Committed locally on a framework-repo branch; nothing pushed.
