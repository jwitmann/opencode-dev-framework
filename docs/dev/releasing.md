# Releasing

Releases are deliberate user actions: version bump, local commit, local tag.
**Never push** — the user pushes the tag, and CI publishes to npm automatically.

## Routine release

```bash
./scripts/release.sh minor   # or: patch | major (default: patch)
```

The script runs the full validation suite (`check`, `lint:md`,
`typecheck`, `test`, `build`), bumps `package.json` +
`package-lock.json` via `npm version`, prepends a `CHANGELOG.md` section
generated from conventional commits since the previous tag
(`scripts/changelog.sh` — no dependencies, fully offline), commits, and
tags — but does **not** push. Then, on explicit user instruction:

```bash
git push origin main --tags
```

## Release notes (generated, published twice)

`CHANGELOG.md` is the single source: generated from conventional commits,
shipped in the repo and the npm tarball. On tag push, CI extracts the
version's section and attaches it as the GitHub release body (falling back
to auto-generated notes if the section is missing), so the file and the
release page never diverge. To regenerate history (idempotent):

```bash
./scripts/changelog.sh --backfill
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
