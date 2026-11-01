# Troubleshooting

## Plugin fails to load: `Duplicate plugin ID`

Each project must register the plugin **exactly once**. Plugin arrays
**merge** across config files (global `opencode.jsonc`, project
`./opencode.jsonc`, `./.opencode/opencode.json[c]`), so a second entry in
another file — even one pointing at a different path of the same repo such
as `dist/` — loads the same plugin ID twice and the duplicate fails. Check
all three locations, and verify with:

```bash
opencode api get "/api/plugin?location[directory]=/path/to/project"
```

(The server log only shows harmless `loading plugin` lines for both
entries — the API view is the one that tells the truth.)

## TUI commands (`/df-status`, `/df-help`) never load

Point the entry at the repository **root**, not at `dist/` directly: a bare
directory without `package.json`/`exports` resolves only the server part.
One root entry loads every part (server via `dist/index.js`, TUI via
`tui.tsx`, resolved through the `exports` map).

## Stale version after switching sources

OpenCode caches downloaded plugins in
`~/.cache/opencode/packages/opencode-dev-framework*/`. If you previously
loaded a published version and then switch to a local source, clear that
cache so OpenCode does not reuse the old build:

```bash
rm -rf ~/.cache/opencode/packages/opencode-dev-framework*
```

After every source change, rebuild — OpenCode loads the compiled `dist/`
output:

```bash
npm run build
```

## Version matrix

Requires OpenCode `v2.x` (`@opencode/plugin` `^2`) — tested on `v2.0.26`
and `v2.2.0`. On `v1.18.18–1.18.31` use the `v1` branch of this plugin
(`plugin` key). The `./tui` companion (`/df-status` and `/df-help` modals)
is auto-discovered from the npm entry on `v2` — no separate `tui.json`
needed.

## Diagnosing a red tree without triggering fixes

Under `standard`/`strict`, a red tree at the idle boundary continues the
session until the cause is fixed — even if you asked for a report-only
diagnosis (see [Blocked gate, fix,
pass](sessions/blocked-gate-fix.md)). That is the documented price of a
blocking profile, not a bug. Your options:

- Call `dev_framework_verify` directly mid-turn for the report, then
  close the session yourself — the verdict is pure report, but the
  continuation still fires if you let the turn go idle on the red tree.
- Drop to `advisory` for the session (`/df-profile advisory`) and flip
  back after — the gate reports instead of blocking. This is the only
  true look-without-touching.
- Do nothing: if the failure is identical with no new edits across three
  evaluations, the gate stands down early on zero progress instead of
  spending the rest of `gate.max_blocks`. Bounded either way, but the
  early stop saves the wasted continuations.

## Still stuck

Run a private server with the plugin trace on and read the log:

```bash
OPENCODE_DEV_FRAMEWORK_LOG_FILE=/tmp/odf.log opencode run --standalone --print-logs
```

Plugin code runs in the `opencode serve` backend, not in your terminal
process — a variable exported only in the TUI shell never reaches it.
