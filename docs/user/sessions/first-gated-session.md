# Worked session 1: first gated session

A minimal Node project, `standard` profile, one small task. The whole
plugin loop — constitution, per-edit lint, verification, idle gate — in a
single session. Real output, trimmed (timestamps and core internals
removed); the fixture is disposable (`/tmp`, not this repo).

## Setup

`package.json` with `"test": "node --test test/*.test.js"`, a `math.js`
with one function, one test file, and:

```yaml
profile: standard

commands:
  test: "npm test"
  lint:
    ".js": "node --check {file}"

gate:
  run_typecheck: false
  run_tests: true
  block_on_failure: true
  require_review: false

on_edit:
  lint: true
```

Prompt:

> Add a `subtract(a, b)` function to math.js and cover it with a test in
> test/. Keep the change minimal.

## What happened

The plugin announced itself on load (`constitution injected into system
prompt`, `registered experimental.idle hook`). The agent made two edits —
`math.js` and `test/math.test.js` — and each landed edit was linted
immediately:

```text
[opencode-dev-framework] info lint passed for .../test/math.test.js
[opencode-dev-framework] info lint passed for .../math.js
```

Before finishing, the agent ran the full contract itself:

> Tests pass. Let me run the framework completion gate to close out.

`dev_framework_verify` returned `DEV_FRAMEWORK_VERDICT: PASS` (`npm test`
→ 2 pass, 0 fail), and the idle gate agreed:

```text
[opencode-dev-framework] info completion gate passed
completion gate passed
```

Session exited 0 with the diff committed-worthy: 4 added lines in
`math.js`, one new test.

## Takeaways

- Nothing was configured beyond the yml: lint, tracking, verification, and
  the gate all fired from the two edits.
- The agent verified *before* declaring done (constitution + review
  discipline), and two independent evaluations — manual verify, idle gate —
  agreed on the same full contract.
- Failure mode to know: had the agent edited via raw shell redirects
  instead of the Edit tool, the tracker would have missed it (only `git
  status` unioning would have caught the files). Use the Edit tool.
