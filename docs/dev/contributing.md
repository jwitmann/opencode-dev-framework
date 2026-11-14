# Contributing

`AGENTS.md` (repo root) is the canonical contributor contract — this page
is a pointer, not a fork. If they ever disagree, `AGENTS.md` wins.

## Validate before finishing any change

```bash
npm install
npm run check        # fix with: npm run check:fix
npm run lint:md      # for touched Markdown
npm run typecheck
npm run test
npm run build        # verify dist/ is produced
```

Run `npm run test` frequently during work; update tests with every behavior
change. Development runtime is Node.js v22 + npm (Bun loads the plugin at
runtime but is not installed here) — keep the code Bun-compatible: no
Node-only APIs, standard ESM imports. Unit tests use a stubbed
`HostContext`; never shell out to real tools in tests.

## Local loop

Point OpenCode at the local repository **root** in your scratch project's
`opencode.jsonc` (root path resolves through `exports`, loading server +
TUI from one entry), rebuild after every source change, and clear the
plugin cache when switching sources:

```bash
npm run build
rm -rf ~/.cache/opencode/packages/opencode-dev-framework*
```

See [`../user/troubleshooting.md`](../user/troubleshooting.md) for the
duplicate-registration and stale-cache failure modes.

## Commit policy

- Commit locally when a logical unit is complete and all validation passes.
- **Never push to remote and never publish** — the user controls releases
  (see [`releasing.md`](releasing.md)).
- Present-tense messages (`feat: …`, `fix: …`, `docs: …`, `perf: …`,
  `review: …`, `test: …`, `chore: …`).
- Never commit `dist/`, `node_modules/`, or lockfiles (the release commit
  is the deliberate exception for the lockfile).
- Keep `README.md` accurate and update `docs/plans/05-implementation-checklist.md`
  when a checklist task is done. `docs/plans/` is process history — read
  `00-restart-brief.md` first when resuming work, don't rewrite it.
