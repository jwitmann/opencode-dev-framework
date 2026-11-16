# Documentation

Three doors, pick yours:

- **Use the plugin** — install it in your project, configure it, run
  sessions under it. Start with the [Quickstart](../README.md#quickstart),
  then [`user/configuration.md`](user/configuration.md),
  [`user/commands.md`](user/commands.md),
  [`user/enforcement.md`](user/enforcement.md), and
  [`user/troubleshooting.md`](user/troubleshooting.md) as needed.
- **Hack on the plugin** — build it, understand the architecture, run the
  suite, cut a release. Start with
  [`dev/contributing.md`](dev/contributing.md), then
  [`dev/architecture.md`](dev/architecture.md) and
  [`dev/releasing.md`](dev/releasing.md). `AGENTS.md` (repo root) is the
  canonical contributor contract.
- **Project history** — [`plans/`](plans/00-restart-brief.md) is the
  historical implementation log (master plan, hook mapping, config spec,
  dogfood receipts, release notes). It records *how the plugin was built*,
  not how to use it — start above, not here.

## Map

- `../README.md` — front door: what it does, quickstart, concept map.
- `user/` — end-user docs (config, commands, enforcement, troubleshooting).
- `dev/` — contributor docs (architecture overview, contributing, releasing).
- `plans/` — process history. Frozen except for new dated entries; the
  authoritative references inside it are
  [`plans/03-config-spec.md`](plans/03-config-spec.md) (config schema) and
  [`plans/04-hook-mapping.md`](plans/04-hook-mapping.md) (hook mapping).
- `../examples/` — copy-paste project configs (`go-service/` today).
