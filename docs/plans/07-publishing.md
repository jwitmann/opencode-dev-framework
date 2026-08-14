# Publishing Guide

## npm package setup

1. Create or log in to your npm account: <https://www.npmjs.com/>
2. Create an access token:
   - Type: **Automation** or **Publish**.
   - No 2FA prompt (automation token).
3. Copy the token.

## GitHub repository setup

1. Create the GitHub repository `opencode-dev-framework`.
2. Push the local repo:

   ```bash
   git remote add origin git@github.com:<user>/opencode-dev-framework.git
   git branch -M main
   git push -u origin main
   ```

3. Add the npm token as a repository secret:
   - Go to **Settings → Secrets and variables → Actions**.
   - Click **New repository secret**.
   - Name: `NPM_TOKEN`.
   - Value: the npm access token.

## CI workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
    tags: ["v*"]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      - run: bun install
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test
      - run: bun run build

  publish:
    needs: test
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      - run: bun install
      - run: bun run build
      - run: npm publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Note: OpenCode uses Bun, so CI should use Bun. If the project uses npm scripts, make sure they work with `bun run`.

> **As implemented:** CI uses Node.js 22 with `npm ci` (Bun is not available on
> the dev box; the plugin stays Bun-compatible at runtime). `package-lock.json`
> is committed as of the 0.1.0 release prep so `npm ci` and the `cache: npm`
> option work. GitHub Actions are pinned to `actions/checkout@v5` and
> `actions/setup-node@v5` (Node 24 runners).

## Versioning and release

Follow SemVer:

- `0.1.0` — initial release.
- `0.1.1` — bug fixes.
- `0.2.0` — new features.

Release steps:

1. Update `CHANGELOG.md`.
2. Bump version in `package.json`.
3. Commit: `git commit -am "Release v0.1.0"`.
4. Tag: `git tag -a v0.1.0 -m "Release v0.1.0"`.
5. Push: `git push origin main --tags`.
6. CI will publish automatically.

## Pre-publish checklist

- [ ] `package.json` name is `opencode-dev-framework`.
- [ ] `package.json` version is updated.
- [ ] `files` array includes `dist`, `commands`, `rules`.
- [ ] `main` points to `dist/index.js`.
- [ ] `types` points to `dist/index.d.ts`.
- [ ] `LICENSE` exists.
- [ ] `README.md` exists.
- [ ] `npm run build` succeeds.
- [ ] `npm run test` succeeds.
- [ ] `NPM_TOKEN` secret is set in GitHub.
- [ ] `.npmignore` or `files` array excludes source/tests from the published package.

## Post-publish verification

1. Visit <https://www.npmjs.com/package/opencode-dev-framework> and confirm the version is live.
2. In a scratch directory, create:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-dev-framework"]
   }
   ```

3. Run `opencode` and check the plugin loads without errors.
4. Check OpenCode logs for plugin initialization message.

## Troubleshooting

### `ENEEDAUTH` during `npm publish`

```text
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
```

This means the `publish` job ran with an empty `NODE_AUTH_TOKEN`. Check:

1. The repository secret `NPM_TOKEN` is set under **Settings → Secrets and
   variables → Actions**. It must be an **Automation** or **Publish** token from
   <https://www.npmjs.com/settings/tokens>.
2. The secret name matches exactly. The workflow uses
   `secrets.NPM_TOKEN`; `NPM-TOKEN`, `npm_token`, etc. will not work.
3. If you created an **environment** secret instead of a repository secret, add
   an `environment:` key to the `publish` job so it can access that secret.

### Tag pushed but publish job did not run

Make sure the tag name starts with `v` (for example, `v0.1.0`). The workflow
`if: startsWith(github.ref, 'refs/tags/v')` only triggers on those tags.

## Documentation of known limitations

The README and docs must clearly state:

- This is a community project, not affiliated with OpenCode or the original dev-framework team.
- The completion gate is advisory because OpenCode does not expose a blocking completion hook.
- Some features rely on OpenCode native config (`permission`, `formatter`), which may evolve.
