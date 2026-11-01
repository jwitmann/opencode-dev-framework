# Slash commands

Five slash commands are **TUI commands** registered by the bundled `./tui`
companion module. They open instantly and **never** feed text back to the LLM:

- `/df-status` — shows the current profile, guardrails, completion gate, and
  configured commands in a modal dialog.
- `/df-runtime` — shows the plugin version and live hook/gate runtime state
  (which idle-hook method the core accepted, dispatch history) in a modal
  dialog. Read from a snapshot the server writes per project; reports
  "not reported yet" before the first session instead of guessing.
- `/df-help` — lists the available dev-framework commands in a modal dialog.
- `/df-profile` — opens a profile picker (off / advisory / standard / strict) in
  a modal dialog; selecting one switches the active profile immediately (written
  to the config file). With an argument (`/df-profile standard`) it switches
  directly with a toast instead of the picker.
- `/df-verify` — runs the configured verification suite (the completion gate)
  manually and shows a pass/fail summary in a modal dialog.

You can still run `df init` to install the bundled agents, skills, and default
config; the commands themselves are provided by the plugin. The
`dev_framework_*` custom *tools* remain
available for in-agent use (e.g. when the model wants to change the profile
itself).

`/df-goal <objective>` is a **server-side command** instead (registered by the
server plugin, not the TUI): it starts a **verified** native goal. The plugin
appends a short verification contract to your objective verbatim and delegates
exactly once to native `/goal`, which keeps owning state, review,
pause/resume/clear, and continuations. Requires all three: native `/goal` on
the core, a blocking profile (`standard`/`strict`, i.e.
`gate.block_on_failure: true`), and at least one configured completion check
(typecheck/test command, changed-file lint, `gate.acceptance`, or
`gate.require_review`). Otherwise it fails with an actionable error instead of
starting an unverified goal — use native `/goal` directly for purely semantic
objectives. The objective plus addendum must fit native `/goal`'s 4,000-character
limit; overflow is rejected, never truncated.

The agent must run `dev_framework_verify` after its final changes; the native
reviewer weighs that tool result as evidence and the framework idle gate stays
an independent backstop. This is layered verification, not a hard lock:
native `/goal` can still mark complete while the gate fails (or keep going
after it passes), both tenants can admit a continuation at one idle boundary,
and the framework stands down after `gate.max_blocks`.

**Run plans under `/df-goal`.** When a task starts from a written plan, make
the objective the plan inline (short plans) or `Implement the plan in <path>`
(long plans). Native completion then requires the gate's PASS on the final
tree — a stronger enforcement than a bare turn, where only your summary stands
between the plan and "done".
