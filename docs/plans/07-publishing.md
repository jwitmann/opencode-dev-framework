# Publishing Guide

This project publishes to npm using **trusted publishing (OIDC)** from GitHub
Actions. No long-lived npm token is stored in GitHub secrets.

## npm account setup

1. Create or log in to your npm account: <https://www.npmjs.com/>
2. npm now requires either **two-factor authentication (2FA)** on your account
   or a **granular access token with "Bypass 2FA" enabled** for direct
   publishing. For the one-time first publish, the bypass-token route below is
   usually fastest.

## First-time package creation

Trusted publishing requires the package to already exist on npm. If
`opencode-dev-framework` has never been published, create a one-time granular
access token and publish manually:

1. On npmjs.com, go to **Settings → Access Tokens → Generate New Token →
   Granular Access Token**.
2. Set the token permissions:
   - **Package:** `opencode-dev-framework`
   - **Permissions:** `Publish`
   - **Bypass two-factor authentication:** enabled
3. Copy the token.
4. Back in your terminal:

   ```bash
   npm logout
   export NPM_TOKEN=<paste-token-here>
   NODE_AUTH_TOKEN=$NPM_TOKEN npm publish --access public
   unset NPM_TOKEN
   ```

5. Revoke the token on npmjs.com once the package exists.

After the package exists, configure the GitHub Actions trusted publisher and
use OIDC for all future publishes.

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
        node-version: 22
        registry-url: https://registry.npmjs.org

    - run: npm ci
    - run: npm run build
    - run: npm publish --access public
```

Requirements:

- `permissions: id-token: write` is mandatory; without it OIDC fails.
- `registry-url: https://registry.npmjs.org` tells `setup-node` to configure
  the registry for publishing.
- No `NODE_AUTH_TOKEN` or `secrets.NPM_TOKEN` is used.
- Provenance attestations are generated automatically because the package is
  public, the repo is public, and publishing is via OIDC.

## Versioning and release

Follow SemVer:

- `0.1.0` — initial release.
- `0.1.1` — bug fixes.
- `0.2.0` — new features.

Release steps:

1. Update `CHANGELOG.md` (optional).
2. Bump version in `package.json`.
3. Commit: `git commit -am "Release v0.1.0"`.
4. Tag: `git tag -a v0.1.0 -m "Release v0.1.0"`.
5. Push: `git push origin main --tags`.
6. CI validates and publishes automatically.

## Pre-publish checklist

- [ ] `package.json` name is `opencode-dev-framework`.
- [ ] `package.json` version is updated.
- [ ] `package.json` `repository.url` exactly matches the GitHub repo.
- [ ] `files` array includes `dist`, `commands`, `rules`.
- [ ] `main` points to `dist/index.js`.
- [ ] `types` points to `dist/index.d.ts`.
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
     "plugin": ["opencode-dev-framework"]
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
- The completion gate is advisory because OpenCode does not expose a blocking
  completion hook.
- Some features rely on OpenCode native config (`permission`, `formatter`),
  which may evolve.
