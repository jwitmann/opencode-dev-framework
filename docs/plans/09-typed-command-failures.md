# Typed `/df <arg>` command — Investigation Report (Attempts & Failures)

> **Purpose of this document.** A complete, objective record of every attempt to
> add a *typed* dev-framework slash command (e.g. `/df profile standard`) that
> applies an action **server-side without the argument reaching the LLM**, and
> why each attempt failed. Written so a fresh investigator can pick up the trail.
> The working baseline is preserved; only the typed form failed.

---

## 1. Objective

Provide a slash command that takes an argument and performs work server-side,
**without the argument ever producing a model turn** (no LLM sees / acts on the
raw argument). The reference behavior is DCP's `/dcp manual on`, where the user
types the command, the input disappears, and a server-side result is shown — no
model turn, no "no credit" error.

The dev-framework already has four **bare** TUI commands that work fine
(`/df-status`, `/df-help`, `/df-profile` picker, `/df-verify`). The goal was only
to add a *typed* variant.

---

## 2. Environment (facts)

- **Plugin:** `opencode-dev-framework` — an OpenCode plugin in TypeScript
  (Bun runtime at load time; dev/CI on Node 22 + npm). Local-filesystem dev path.
- **OpenCode:** v1.18.18.
- **User's provider:** Kimi K2.6 Code. The **leak detector** is the Kimi
  *"You've reached your usage limit for this billing cycle…"* message — that
  message only appears when a **model turn actually fires**. So every time the
  user saw that message, the argument reached the model.
- **DCP reference:** `~/opencode-dynamic-context-pruning` — an independent
  OpenCode plugin. **Both DCP and DF run in the *same* OpenCode session** (user
  confirmed). Therefore any "OpenCode version difference" explanation is invalid
  between the two.

---

## 3. What DCP does (verified by reading its source)

- `tui.tsx` registers **one** TUI keymap command:

  ```ts
  { title: "DCP", name: "dcp.panel", description: "Open DCP panel",
    slashName: "dcp", run: () => openPanelModal(api, config) }
  ```

  i.e. a single **non-hyphenated** slash command `dcp` whose `name` is namespaced
  (`dcp.panel`) but `slashName` is `dcp`.
- `index.ts:89-103` — the `config` hook registers **only** a server prompt
  command:

  ```ts
  opencodeConfig.command["dcp-compress"] = {
    template: "",   // EMPTY template
    description: "Trigger DCP manual compression with: /dcp-compress [focus]",
  }
  ```

  Plain `dcp` is **not** a `config.command`; it is only a TUI command.
- `index.ts:72` — `"command.execute.before": createCommandExecuteHandler(...)`.
  For subcommands (`manual`, `context`, `stats`, `sweep`, `decompress`, …) it
  does the work and **returns without modifying `output.parts`** — yet no model
  turn occurs. (Only the `compress` subcommand pushes a custom `output.parts`.)
- **User-observed behavior (decisive):** typing `/dcp manual on` → the input
  disappears → result `"Manual mode is now ON…"` is shown. No model turn, no
  credit error. **This proves** that for a TUI command, returning from
  `command.execute.before` consumes the command and suppresses the model turn.

**Key takeaway:** DCP's typed arg form works because (a) `dcp` is a
non-hyphenated TUI command, and (b) `command.execute.before` handles the arg and
returns, which suppresses the model turn.

---

## 4. Attempts and results

**Attempt A — keymap commands *without* `slashName` (pre-v0.1.25).**

- Registered the four commands as keymap entries without a `slashName`.
- **Result:** bare `/df-profile` opened the picker; `/df-profile standard`
  leaked `standard` to the model.
- **Failure cause:** OpenCode only matched the commands *without* arguments.

**Attempt B — TUI-only (commit `ec4174e`, the `v0.1.25` tag) — KNOWN-GOOD BASELINE.**

- Four bare TUI commands via `keymap.registerLayer` + `slashName`, with a legacy
  `api.command?.register` fallback.
- **Result:** the bare commands **work** (user confirmed `/df`, `/df-status`,
  etc. behave correctly). The argument form is explicitly unsupported.
- This is where we ultimately returned (see §7).

**Attempt C — `df-set-profile` TUI command + `command.execute.before` (commits `0563b5c` → `860322a`).**

- Added a `df-set-profile` TUI command (`slashName: "df-set-profile"`) and a
  `command.execute.before` handler covering `df-set-profile` / `df-profile` /
  `df-verify` arguments.
- **Bug:** the handler began with
  `if (!getStateForSession(input.sessionID)) return;` — session state is only
  populated *after* a chat message or tool call, so a command issued as the first
  interaction had `state === undefined` → handler bailed → command fell through to
  the model.
- **User test:** `/df-set-profile standard` → **Kimi usage-limit message**
  (leak).
- **Fix attempt (`860322a`):** map the session at the top of the handler
  (`setSessionDirectory(input.sessionID, ctx.directory)` + fall back to
  `getHookState(ctx.directory)`), and clear `output.parts`.
- **But it still leaked**, because the real problem is that a *hyphenated*
  `/df-set-profile <arg>` **never routes to `command.execute.before` at all** in
  OpenCode 1.18.x — the handler never fired. The session fix was necessary but
  not sufficient.

**Attempt D — single non-hyphenated `/df` dispatcher (commit `79bc196`, intended `v0.1.26`).**

- Removed `df-set-profile`. Added a **single** `df` command
  (`name: "df.panel"`, `slashName: "df"`) to mirror DCP's single non-hyphenated
  `dcp`. The `command.execute.before` handler dispatches the argument as a
  subcommand:
  - `profile` / `set-profile <p>` → `changeProfile`
  - `verify` → `verifyGate`
  - `status` → `renderConfigStatus` toast
  - `help` / empty → `renderHelp` toast
  - unknown → usage toast
  - every branch clears `output.parts`.
- **Rationale:** the only structural difference between DCP's working `dcp` and
  our failing `df-set-profile` was the hyphenated name; a non-hyphenated
  `slashName` should route args like DCP's does.
- **User test:**
  - `/df` (bare) → help TUI modal **WORKS**.
  - `/df help` → **Kimi usage-limit message (LEAK)**.
  - `/df profile standard` → **Kimi usage-limit message (LEAK)**.
- **Conclusion:** even a non-hyphenated `/df` argument form did **not** route to
  `command.execute.before`. The hyphen was *not* the (only) cause.

**Attempt E — hidden `df-routing` `config.command` enabler (commit `aada856`).**

- **Hypothesis:** OpenCode only routes a TUI command's *arguments* to
  `command.execute.before` when the plugin declares **≥1 `config.command`** (a
  server prompt command) — and DCP's `dcp-compress` fills that role. We had none.
- **Change:** in the `config` hook,
  `typedConfig.command["df-routing"] = { template: "", description: "Internal
  command that enables /df <arg> routing" }` (structurally identical to DCP's
  `dcp-compress`). The handler added a harmless no-op branch that just clears
  `output.parts` for `df-routing` (it is never meant to be typed).
- The name was changed `df-compress` → `df-routing` after the user questioned
  the "compress" naming (it has nothing to do with compression).
- **User test:** `/df profile standard` → **STILL Kimi usage-limit message
  (LEAK)**.
- **Conclusion:** the `config.command` enabler hypothesis is **WRONG** — adding a
  server prompt command did not enable argument routing for `/df`.

---

## 5. Root-cause hypotheses — status

| # | Hypothesis | Status |
|---|-----------|--------|
| H1 | State-missing early return in handler | Partially real (Attempt C) but **not** the root cause — the handler never fired for hyphenated args. |
| H2 | Hyphenated slash commands don't route args to `command.execute.before` | **Supported** by Attempt D (even non-hyphenated `/df` leaked). |
| H3 | A `config.command` presence "trains" OpenCode to route `/df <args>` | **Rejected** by Attempt E. |
| H4 | "Server prompt commands always produce a model turn" | **Challenged by user** — DCP does not produce a model turn for `/dcp manual on`. The genuinely *untested* path is registering `df` itself as a real server prompt command. |
| H5 | OpenCode version difference between DCP and DF | **Rejected by user** — both run in the same OpenCode session. |

---

## 6. Open questions for a fresh investigator

These are **unresolved**. A new model should attack them directly rather than
repeating Attempts A–E.

1. **Why does `/dcp manual on` route to `command.execute.before` (with
   `input.command === "dcp"`) but `/df profile standard` does not, when both are
   structurally identical TUI keymap commands with `slashName`?** The only
   external difference is that DCP also declares `dcp-compress` as a
   `config.command`. We replicated that with `df-routing` (Attempt E) and it did
   not help — but maybe the *enabler must share the command prefix* or the
   mechanism is something else entirely.

2. **Does OpenCode route a TUI command's args to `command.execute.before` only
   when that command is ALSO a `config.command`?** If so, the fix may be to
   register `df` **itself** (not a hidden sibling) as a server prompt command and
   do all work in `command.execute.before`. Per DCP precedent (H4), this might
   *not* produce a model turn.

3. **Does the `config.command` `template` need to be non-empty?** Both
   `dcp-compress` and our `df-routing` used `template: ""`. If OpenCode ignores
   empty-template commands, the enabler never registered — try a real template.

4. **Slash-parser behavior:** when the user types `/df profile standard`,
   OpenCode may match `df` (a bare TUI command) and then treat `profile standard`
   as literal chat text rather than `arguments`. DCP's `/dcp manual on` somehow
   becomes `command="dcp", arguments="manual on"`. What makes OpenCode parse it
   that way? (Inspecting the OpenCode binary's slash parser — the
   `let[x,...A]=P.slice(1).split(/\s+/)` pattern — suggests args are taken when a
   command is recognized; the question is what "recognized" means.)

5. **Could the `df` TUI command and a `df` `config.command` conflict or need to
   coexist?** DCP's `dcp` is TUI-only while `dcp-compress` is the config command.
   A clean experiment: register `df` as a config command with a minimal template
   and see if `/df <x>` then routes to `command.execute.before`.

---

## 7. Current state (as of this report)

- **Reset to `ec4174e`** (the TUI-only `v0.1.25` tag). `/df` and all typed-form
  code are removed.
- **Only four bare commands remain**, all confirmed working:
  `/df-status`, `/df-help`, `/df-profile` (picker), `/df-verify`.
- Working tree is clean; `dist/` rebuilt; **167 tests pass**.
- User's final instruction: *"remove /DF, I'll keep what already works."* The
  typed-form work is shelved.

---

## 8. Key files & references

- `src/index.ts` — plugin hooks; `command.execute.before` (now only the
  enforcement hooks; no `df` arg handling after reset).
- `tui.tsx` — TUI command registration (`registerCommands`).
- `src/commands.ts` — `changeProfile`, `verifyGate`.
- `src/format-status.ts` — `renderConfigStatus`, `renderHelp` (shared, pure).
- `tests/tui.test.ts`, `tests/commands.test.ts` — command registration + handler
  tests.
- **DCP reference (read-only):** `~/opencode-dynamic-context-pruning/`
  - `index.ts` (config hook L89-103; `command.execute.before` L72)
  - `tui.tsx` (single `dcp` TUI command)
  - `lib/hooks.ts` (`createCommandExecuteHandler`)
  - `lib/ui/notification.ts` (`sendIgnoredMessage`)

---

## 9. Empirical test log (what the user actually saw)

| Command tried | Observed | Interpretation |
|---|---|---|
| `/df-set-profile standard` (Attempt C) | Kimi usage-limit | Model turn fired → leak |
| `/df` (bare, Attempt D) | Help TUI modal | TUI `run` fired correctly |
| `/df help` (Attempt D) | Kimi usage-limit | Arg form → leak |
| `/df profile standard` (Attempt D) | Kimi usage-limit | Arg form → leak |
| `/df profile standard` (Attempt E, after `df-routing`) | Kimi usage-limit | Enabler did not help → leak |
| `/df-status`, `/df-help`, `/df-profile`, `/df-verify` (baseline) | Correct modals/pickers | Bare TUI commands work |

> **Bottom line for the next investigator:** the bare commands are fine; the
> typed form is the only open problem. DCP proves a no-model-turn typed command
> is achievable in *this exact OpenCode environment*, so the failure is in our
> plugin's registration/handler wiring, not an OpenCode limitation. The most
> promising unexplored path (§6, Q2/Q5) is to register `df` **itself** as a
> `config.command` (server prompt command) and handle everything in
> `command.execute.before`, trusting DCP's precedent that returning from the
> handler suppresses the model turn.
