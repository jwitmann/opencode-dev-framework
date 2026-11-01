# Example: Python service

This directory shows how to configure `opencode-dev-framework` for a typical
Python service (mypy + pytest + ruff).

## Files

- `.opencode-dev-framework.yml` — the plugin configuration for the project.

## How to use

1. Install the plugin in your project (see the top-level `README.md`).
2. Copy `.opencode-dev-framework.yml` to your service's repository root.
3. Adjust the commands to your toolchain:
   - `typecheck` — swap `mypy` for `pyright`, or drop it if untyped.
   - `test` — whatever you run in CI.
   - `lint` / `format` — swap `ruff` for `flake8` + `black`, etc.
4. Adjust `protect` and `exclude` globs to your layout.

## What you get with this config

- Edits to `.env*` files, `__pycache__/`, `.venv/`, or `dist/` output are
  denied in the default `standard` profile.
- Every `.py` file the agent edits is linted with `ruff check` (test files
  and `__pycache__/` are excluded).
- When the agent finishes a turn, the completion gate runs `mypy .` and
  `pytest` and reports failures.
- The bundled constitution is injected into the session, reminding the agent
  to verify before declaring completion.

Start with `profile: advisory` if you want to see what would be flagged
before enforcing.
