# Example: Go service

This directory shows how to configure `opencode-dev-framework` for a typical
Go service.

## Files

- `.opencode-dev-framework.yml` — the plugin configuration for the project.

## How to use

1. Install the plugin in your project (see the top-level `README.md`).
2. Copy `.opencode-dev-framework.yml` to your Go service's repository root.
3. Adjust the commands to your toolchain:
   - `typecheck` / `test` — whatever you run in CI.
   - `lint` — swap `golangci-lint` for `staticcheck`, `go vet`, etc.
   - `format` — `gofmt`, `goimports`, ...
4. Adjust `protect` and `exclude` globs to your layout.

## What you get with this config

- Edits to `.env*` files, `deploy/prod/`, and `migrations/` are denied in the
  default `standard` profile.
- Every `.go` file the agent edits is linted with `golangci-lint` (test files
  and `testdata/` are excluded).
- When the agent finishes a turn, the completion gate runs `go build ./...`
  and `go test ./...` and reports failures.
- The bundled constitution is injected into the session, reminding the agent
  to verify before declaring completion.

Start with `profile: advisory` if you want to see what would be flagged
before enforcing.
