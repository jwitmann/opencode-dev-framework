# Example: project hardening (append-mode rules)

This directory shows the hardening pattern from
[`docs/user/hardening.md`](../../docs/user/hardening.md): keep the bundled
constitution and append a project-specific contract after it.

## Files

- `.opencode-dev-framework.yml` — minimal config; the only hardening part
  is the `rules:` block at the bottom.
- `.opencode/opencode-dev-framework/hardening.md` — the project contract,
  written for a fictional Node service (`example-service`). Adapt the
  commands and paths; keep the five sections.

## How to use

1. Copy both files into your project, preserving the relative paths (the
   `rules.files` entry is relative to your repo root).
2. Replace every `example-service` / `npm run …` command with your project's
   real build, test, and lint commands.
3. Replace the protected-path and generated-asset examples with your layout.
4. Keep it committable: no tokens, no internal URLs, no customer names.

See [`docs/user/hardening.md`](../../docs/user/hardening.md) for what
belongs in each section and what stays out.
