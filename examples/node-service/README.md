# Example: Node.js service

This directory shows how to configure `opencode-dev-framework` for a typical
Node.js service (TypeScript + vitest + eslint + prettier).

## Files

- `.opencode-dev-framework.yml` — the plugin configuration for the project.

## How to use

1. Install the plugin in your project (see the top-level `README.md`).
2. Copy `.opencode-dev-framework.yml` to your service's repository root.
3. Adjust the commands to your toolchain:
   - `typecheck` / `test` — whatever you run in CI.
   - `lint` — swap `eslint` for `biome check`, `oxlint`, etc.
   - `format` — swap `prettier` for `biome format`, etc.
4. Adjust `protect` and `exclude` globs to your layout.

## What you get with this config

- Edits to `.env*` files or `dist/` output are denied in the default
  `standard` profile.
- Every `.ts` file the agent edits is linted with `eslint` (test files and
  `dist/` are excluded).
- When the agent finishes a turn, the completion gate runs `tsc --noEmit`
  and `npm test` and reports failures.
- The bundled constitution is injected into the session, reminding the agent
  to verify before declaring completion.

Start with `profile: advisory` if you want to see what would be flagged
before enforcing.
