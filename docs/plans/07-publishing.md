# Publishing Guide

This project publishes to npm from GitHub Actions. It uses npm OIDC
**trusted publishing** with `--provenance` Sigstore attestations — no
long-lived npm token, no `NPM_TOKEN` secret.

## npm account setup

1. Create or log in to your npm account: <https://www.npmjs.com/>
2. npm now requires either **two-factor authentication (2FA)** on your account
   or a **granular access token with "Bypass 2FA" enabled** for direct
   publishing. For the one-time first publish, the bypass-token route below is
   usually fastest.

## First-time package creation

Trusted publishing requires the package to already exist on npm, which it
does (`opencode-dev-framework` is live since `0.1.x`). No bootstrap publish
is needed. If you ever need to recreate the package from scratch, publish
once manually (`npm publish --access public` from your workstation), revoke
any one-time credential, then configure the trusted publisher below and use
OIDC for all future publishes. The one-time manual publish uses your own
npm login (`npm login`), not a stored token — do **not** commit an `.npmrc`
containing a token.

## Configure trusted publishing on npmjs.com

1. Go to the package page on npmjs.com:
   <https://www.npmjs.com/package/opencode-dev-framework>
2. Click **Settings** → **Trusted publishing**.
3. Under **Select your publisher**, choose **GitHub Actions**.
4. Fill in the form exactly as follows:
   - **Organization or user**: `jwitmann`
   - **Repository**: `opencode-dev-framework`
   - **Workflow filename**: `ci.yml`
   - **Environment name**: leave blank
   - **Allowed actions**: check **npm publish**
5. Save the trusted publisher.

> ⚠️ npm does not validate this form when you save it. Typos only show up as
> `ENEEDAUTH` when the workflow runs, so double-check every field.

## Required `package.json` field

The `repository.url` in `package.json` must exactly match the GitHub repository
used for trusted publishing:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/jwitmann/opencode-dev-framework.git"
}
```

## CI workflow

The repository already contains `.github/workflows/ci.yml`. The relevant
publish job looks like this:

```yaml
publish:
  name: Publish to npm
  if: startsWith(github.ref, 'refs/tags/v')
  needs: validate
  runs-on: ubuntu-latest
  permissions:
    contents: read
    id-token: write
  steps:
    - uses: actions/checkout@v5

    - uses: actions/setup-node@v5
      with:
        node-version: 26
        registry-url: https://registry.npmjs.org

    - run: npm ci
    - run: npm run build
    # No NODE_AUTH_TOKEN — npm exchanges the GitHub OIDC token automatically.
    - run: npm publish --provenance --access public
```

Requirements:

- `permissions: id-token: write` is mandatory; without it the OIDC exchange
  and provenance signing fail.
- `registry-url: https://registry.npmjs.org` tells `setup-node` to configure
  the registry for publishing.
- `--provenance` adds a Sigstore attestation via OIDC.
- No token secret: the publish step must **not** set `NODE_AUTH_TOKEN` —
  its presence would override the OIDC exchange.

## Local development and testing

Point OpenCode at the local repository root in the project's `opencode.json`:

```json
{
  "plugins": ["/home/jerome/opencode-dev-framework"]
}
```

OpenCode loads `dist/index.js`, so run `npm run build` after every source
change. To clear the OpenCode plugin cache and rebuild in one step:

```bash
npm run dev:clean
```

Caveats:

- `opencode plugin <module>` writes a `.opencode/opencode.json[c]` file whose
  plugin array **merges** with (never replaces) the project-level config.
  Delete it or keep its plugin list consistent with the project-level config.
- Clear OpenCode's plugin cache after switching from a published version to a
  local path:

  ```bash
  rm -rf ~/.cache/opencode/packages/opencode-dev-framework*
  ```

## No token to rotate

There is no `NPM_TOKEN` secret — trusted publishing mints a short-lived
OIDC token per run. If a legacy `NPM_TOKEN` secret still exists in the repo
settings, delete it (**Settings → Secrets and variables → Actions**); the
publish job no longer reads it, and leaving it just widens the blast radius
if it ever leaks.

## Versioning and release

Follow SemVer:

- `0.1.0` — initial release.
- `0.1.1` — bug fixes.
- `0.2.0` — new features.

Release steps:

1. Run the release script, which handles everything:

   ```bash
   npm run release          # default: patch bump
   npm run release:minor    # minor bump
   npm run release:major    # major bump
   ```

   The script runs the full validation suite, bumps the version in both
   `package.json` and `package-lock.json` via `npm version`, commits, and
   creates a git tag.

2. Push the tag:

   ```bash
   git push origin main --tags
   ```

3. CI validates and publishes automatically.

## Pre-publish checklist

- [ ] `package.json` name is `opencode-dev-framework`.
- [ ] `package.json` version is updated.
- [ ] `package.json` `repository.url` exactly matches the GitHub repo.
- [ ] `files` array includes `dist`, `bin`, `rules`, `templates`.
- [ ] `main` points to `dist/adapters/opencode/index.js` (dual-harness
  layout; `./dsh` export serves `dist/adapters/dsh/index.js`).
- [ ] `types` points to `dist/adapters/opencode/index.d.ts`.
- [ ] `LICENSE` exists.
- [ ] `README.md` exists.
- [ ] npm trusted publisher is configured for `jwitmann/opencode-dev-framework` with workflow `ci.yml`.
- [ ] `npm run build` succeeds.
- [ ] `npm run test` succeeds.
- [ ] `.npmignore` or `files` array excludes source/tests from the published package.

## Post-publish verification

1. Visit <https://www.npmjs.com/package/opencode-dev-framework> and confirm the
   version is live.
2. In a scratch directory, create:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": ["opencode-dev-framework"]
   }
   ```

3. Run `opencode` and check the plugin loads without errors.
4. Check OpenCode logs for plugin initialization message.

## Troubleshooting

### `Set the BROWSER environment variable` during `npm login`

`npm login` defaults to web authentication and tries to open a browser. In a
headless shell, WSL, or SSH session this fails with:

```text
npm error Set the BROWSER environment variable to your desired browser.
```

Use legacy terminal-based login instead:

```bash
npm login --auth-type=legacy
```

Then enter your npm username, password, and 2FA/OTP code. Alternatively, print
the web URL instead of opening a browser:

```bash
BROWSER=echo npm login
```

### `ENEEDAUTH` during `npm publish`

```text
npm error code ENEEDAUTH
npm error need auth This command requires you to be logged in to https://registry.npmjs.org/
```

With OIDC, this almost always means the trusted publisher configuration does not
match the workflow run. Check:

1. npmjs.com trusted publisher fields exactly match:
   - organization/user: `jwitmann`
   - repository: `opencode-dev-framework`
   - workflow filename: `ci.yml` (case-sensitive, including `.yml`)
2. The publish job has `permissions: id-token: write`.
3. The workflow file exists on the commit that the tag points to.
4. `package.json` `repository.url` exactly matches
   `git+https://github.com/jwitmann/opencode-dev-framework.git`.
5. You are using GitHub-hosted runners. Self-hosted runners do not support
   OIDC trusted publishing.

### Provenance is not generated

Provenance is only auto-generated for public packages published from public
repositories via OIDC. Private repos must disable provenance or publish
manually.

## Documentation of known limitations

The README and docs must clearly state:

- This is a community project, not affiliated with OpenCode or the original
  dev-framework team.
- The completion gate continues the turn via `synthetic` at the idle
  boundary (`session.hook("experimental.idle")`, same execution), bounded
  by `gate.max_blocks`; the `event.subscribe` idle net covers the
  boundaries the hook skips. The pre-flight `tool.execute.before` deny is
  the only true hard block.
- Some features rely on OpenCode native config (`permission`, `formatter`),
  which may evolve.
