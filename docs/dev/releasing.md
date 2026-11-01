# Releasing

Releases are deliberate user actions: version bump, local commit, local tag.
**Never push** — the user pushes the tag, and CI publishes to npm automatically.

## Routine release

```bash
./scripts/release.sh minor   # or: patch | major (default: patch)
```

The script runs the full validation suite (`format:check`, `lint`,
`lint:md`, `typecheck`, `test`, `build`), bumps `package.json` +
`package-lock.json` via `npm version`, commits, and tags — but does **not**
push. Then, on explicit user instruction:

```bash
git push origin main --tags
```

## Choosing the bump

- `patch` — bug fixes, no user-visible behavior change.
- `minor` — user-visible improvements (faster gate, new errors that fail
  loud instead of silent, stricter validation of configs that could never
  pass). Backward compatible.
- `major` — breaking contract change.

Post-`1.0.0` doc-only commits ride the next version; no patch release for
docs alone.

## One-time npm setup

Trusted publishing, granular tokens, the `ci.yml` publish job, and the
troubleshooting for `ENEEDAUTH`/provenance live in
[`../plans/07-publishing.md`](../plans/07-publishing.md) — consulted when
setting up publishing, not on every release.
