# Agentic init: trial-run detection + project-config skill + shared validator

## 1. Problem

`df init` guesses and never verifies. Root-file sniffing (`detect.ts`,
first match wins) writes commands it never runs (`go test ./...`,
`black`/`flake8` in a ruff shop), cannot see Makefile/CI/CONTRIBUTING
conventions (the `make check` wrappers every hardened project uses),
and leaves the highest-value artifact — `hardening.md` — entirely
manual. The generated config is a starting guess nothing checks, and
the user is never told which parts are guesses.

## 2. Decision

Two paths, one bar. Keep `bin/df init` as the fast path (detection +
templates) but make it verify what it writes; add a thorough path where
the agent reads the project's own build files and drafts both the yml
and the hardening file. Both paths answer to the same validator —
the enforceability bar `/df-goal` already applies — so an agent can
never write itself an easy gate.

## 3. Contract

### 3.1 Trial-run in `df init` (deterministic, no agent)

After `writeDetectedConfig` writes (created or overwritten — never on
skip), run each runnable detected command once (`commands.test`,
`commands.typecheck`; lint/format templates carry `{file}`/`{dir}`
placeholders and cannot run bare) with a bounded timeout, and report
per-command PASS/FAIL in the CLI output. Trial-run never blocks file
writing and never fails `init` — it annotates guesses as
verified-or-flagged. Suggested output shape:

```text
Config: created
Trial-run:
  test (npm test): PASS (2.1s)
  typecheck (npx tsc --noEmit): FAIL (exit 1) — verify this command
```

Same behavior in the `dev_framework_init` tool path (`src/index.ts`),
which shares `writeDetectedConfig`.

### 3.2 Project-config skill (agentic, thorough path)

New `templates/.opencode/skills/project-config/SKILL.md`, shipped by
`init` like the other templates. It instructs the agent to:

1. Read the build truth: `Makefile`/`package.json` scripts/CI
   workflows/`CONTRIBUTING`/existing lint configs, in that order of
   authority (CI is the tiebreaker when scripts disagree).
2. Map what it finds onto `commands` (prefering wrapper targets like
   `make check` over bare tool invocations), `protect` (secrets, build
   output, generated assets), `exclude` (vendored, generated), and
   `gate.acceptance` for checks beyond unit scope (integration needing
   docker, contract tests, docs lint).
3. Draft `hardening.md` from observed project specifics using the five
   sections in `docs/user/hardening.md` — exact commands, ordering
   traps, evidence standard, scope discipline, `/df-goal` usage.
4. Run the shared validator (§3.3) on the draft and fix deficiencies
   before presenting.
5. Present the full diff for user review. Never write without review,
   never commit. The user owns the merge.

### 3.3 Shared validator (the fox-guard rule)

Factor the config half of `checkGoalAvailability` (`src/goal.ts`) —
blocking profile + `hasMeaningfulChecks` (`src/config.ts`, already
pure and reusable) — into an exported `checkConfigEnforceable(config)`
returning `{ ok }` or the exact deficiency (advisory profile names the
key, vacuous config names what's missing). `checkGoalAvailability`
keeps its native-`/goal` check and delegates the rest, preserving
existing messages verbatim. Consumers: the skill's self-check (§3.2
step 4), a `--validate` mode on `bin/df init` for agent-produced
files, and (unchanged) `/df-goal`.

Trust model, stated once in `docs/user/configuration.md`: the agent
proposes, the validator checks, the user reviews the diff and commits.
No party trusted alone.

## 4. Non-goals

- Changing detection heuristics (first-match, per-language guesses):
  the trial-run annotates them instead. Heuristic churn is out.
- Auto-commit of anything init or the skill produces. Never.
- In-memory skill serving for the new skill (blocked on #11060;
  separate watch in `08-notes.md`). It ships as a file like the rest.
- Trial-running lint/format templates (placeholders need a file;
  report them as unverified, don't invent invocations).

## 5. Tests (`tests/`)

- Trial-run: stub `run` — all-pass reports PASS per command with the
  command echoed; one failure reports FAIL naming the command and exit;
  skip (existing config untouched) runs nothing; timeout path reports
  instead of hanging (inject a small timeout in tests).
- Validator: vacuous config (no checks) rejected with the missing-what
  message; advisory rejected naming `block_on_failure`; blocking +
  single test command accepted; `require_review`-only accepted;
  existing `goal.test.ts` expectations unchanged (messages verbatim).
- Skill pin (mirrors `examples.test.ts`): `project-config/SKILL.md`
  exists in templates and contains the five required section hooks
  (build truth sources, command mapping, hardening draft, validator
  self-check, present-diff-no-commit). Catches rot if the skill is
  renamed or gutted.
- `installer.test.ts` additions for the trial-run result shape.

## 6. Dogfood

Disposable fixture mimicking the hardened-project shape: `Makefile`
with `check`/`test` wrappers around bare tools, CI workflow running
`make check`, integration target needing docker. Drive the skill in a
headless run (`--model kimi-code-plan-global/kimi-for-coding`) and
grade the draft: yml maps `make` targets (not bare commands),
integration lands in `acceptance` (not unit test), hardening names
the wrapper + ordering trap. Receipts in `08-notes.md`. Expect at
least oneValidator-caught deficiency in the first draft (that *is*
the test — the loop working, not first-try perfection).

## 7. Definition of done

- [ ] Trial-run in `writeDetectedConfig` callers (`bin/df`,
  `dev_framework_init`) per §3.1; report-only, bounded, tested.
- [ ] `checkConfigEnforceable` factored out; `checkGoalAvailability`
  delegates with verbatim messages; unit tests per §5.
- [ ] `project-config` skill ships in templates; pin test per §5.
- [ ] Dogfood per §6 with receipts.
- [ ] Peer-review skill gate, no Blocking; `configuration.md`
  documents fast vs thorough paths + trust model.
- [ ] Commit locally, never push.
