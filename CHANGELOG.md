# Changelog

<!-- markdownlint-disable MD024 --><!-- repeated bucket headings -->

Generated from conventional commits (`scripts/changelog.sh`).
Single source: CI publishes each version's section as the GitHub
release notes, so this file and the release page never diverge.

## [v1.5.1] - 2026-11-03

### Features

- generated changelog, published twice (CHANGELOG + GitHub releases) ([`ba4637b`](https://github.com/jwitmann/opencode-dev-framework/commit/ba4637bdf900da3b108d0ee0cbe87202445d97fd))

### Fixes

- drop duplicated dialog title from runtime status body ([`cb600bb`](https://github.com/jwitmann/opencode-dev-framework/commit/cb600bbc803af55b8c3a39a69b0b4e40ea2874fa))
- strip duplicated headings at all TUI dialog call sites ([`a744437`](https://github.com/jwitmann/opencode-dev-framework/commit/a7444372292e890fa592897d6e9fde1026576ee4))

### Documentation

- restart brief reflects plan-complete state and ghost semantics ([`38608f8`](https://github.com/jwitmann/opencode-dev-framework/commit/38608f8420a2f096bb3ad40295500c1127633e5f))

## [v1.5.0] - 2026-11-03

### Fixes

- skip lint for files deleted mid-session instead of failing the gate ([`0656efa`](https://github.com/jwitmann/opencode-dev-framework/commit/0656efa446c15505fb96590f9b1cded4d5f9b524))
- ghosts filtered at path-consuming legs, deletions still gate (simplify) ([`f1ecba6`](https://github.com/jwitmann/opencode-dev-framework/commit/f1ecba6b5dd4fe8b91072a21073416cc852d2321))
- re-probe existence on lint failure, excuse TOCTOU ghosts ([`c78273f`](https://github.com/jwitmann/opencode-dev-framework/commit/c78273f4a827a9fdb2f73762382f404648908f3f))
- excuse ghost races in file-substitution gate steps ([`d4fd712`](https://github.com/jwitmann/opencode-dev-framework/commit/d4fd712dd5b754e24d92ae853442d8192f84621f))

### Documentation

- troubleshooting covers deleted-file gate semantics ([`068ecae`](https://github.com/jwitmann/opencode-dev-framework/commit/068ecaee30f0027be97ad723d9b42f095f425f88))

### Other

- single toAbsolutePath helper for ghost path resolution ([`3f8585f`](https://github.com/jwitmann/opencode-dev-framework/commit/3f8585fcfe213541e438bc3054cd68960d8360e8))

## [v1.4.0] - 2026-11-02

### Documentation

- README quickstart offers fast/wizard/thorough paths (v1.3.0) ([`4bf8b47`](https://github.com/jwitmann/opencode-dev-framework/commit/4bf8b4779a75fe1218f24d65c39ea2c4340cfbfb))
- review pass before v1.4.0 — wizard in commands/architecture, installer module row ([`db3f927`](https://github.com/jwitmann/opencode-dev-framework/commit/db3f927fde0bf205b8ef05aa8f0a0dd13952a278))

## [v1.3.0] - 2026-11-02

### Features

- agentic init — trial-run, shared validator, project-config skill (Phase 31, plan 15) ([`d6241b3`](https://github.com/jwitmann/opencode-dev-framework/commit/d6241b3a454be5382a836ac5b2fef40b74a9fb76))
- agent-led init wizard — brief, handoff, interaction budget (Phase 32, plan 16) ([`f735166`](https://github.com/jwitmann/opencode-dev-framework/commit/f7351661b8066807072b0a93c6dbca5b509c7ec5))

### Documentation

- ASCII flow in README, mermaid moved to enforcement.md ([`fbc6925`](https://github.com/jwitmann/opencode-dev-framework/commit/fbc6925b6641d46e5f150fb91d6bb6e6f37b98d3))
- host capability matrix + design-assumes-both sentence ([`750ab9e`](https://github.com/jwitmann/opencode-dev-framework/commit/750ab9e0ed4820242329b8ffffbc24157a12a281))
- correct host matrix — Claude Code has /goal, differentiator is proof ([`1ea73b4`](https://github.com/jwitmann/opencode-dev-framework/commit/1ea73b4ade409460be5c325082e640acf8582e74))
- state the adversarial premise — prose is interpretation surface ([`561650a`](https://github.com/jwitmann/opencode-dev-framework/commit/561650a366b56f3af445092f210e3a9436882b29))
- README states the problem up front — assertion vs evidence ([`e0521e0`](https://github.com/jwitmann/opencode-dev-framework/commit/e0521e06a94e094884aacac565b9989f0294e2c6))
- watch in-memory skills for df-init simplification ([`aef281c`](https://github.com/jwitmann/opencode-dev-framework/commit/aef281c552a4fa53bebd343befdb4015719a1fa6))
- security gate on in-memory skill watch entry ([`2ca6a2e`](https://github.com/jwitmann/opencode-dev-framework/commit/2ca6a2ece3c23259e8da56cfc73c7dd3de1a9fb0))
- plan 15 + Phase 31 for agentic init ([`70868ee`](https://github.com/jwitmann/opencode-dev-framework/commit/70868eeab3b3b009ed9ccd5c5876d6d423ecd596))
- project-config skill names per-ecosystem build files ([`fadf98c`](https://github.com/jwitmann/opencode-dev-framework/commit/fadf98ca55e9d7fafecaf0d25715d85e82449ca4))
- project-config skill covers CMake, Bazel, Meson, SCons, Ninja ([`ac4450c`](https://github.com/jwitmann/opencode-dev-framework/commit/ac4450cb2d7c350cab760d5a89b062e3f2b91104))
- mark stale release checkboxes superseded by release.sh ([`0e0da7e`](https://github.com/jwitmann/opencode-dev-framework/commit/0e0da7ec7d7acb9212ba4550641259ed9b6870c9))
- Effect tripwire gains ecosystem-consolidation trigger ([`fd21406`](https://github.com/jwitmann/opencode-dev-framework/commit/fd21406d1d88f495ce7f48f4dfc7e522120a61bf))
- bot Effect example as direction-of-travel datum ([`7e8f151`](https://github.com/jwitmann/opencode-dev-framework/commit/7e8f1513660ba72f4a6aeead05b7d0618abcf205))
- Effect tripwire names effect-first landing as the skew signal ([`164101b`](https://github.com/jwitmann/opencode-dev-framework/commit/164101b5a9199f68b717bc8a2caa7c703aeee510))

## [v1.2.0] - 2026-11-01

### Features

- no-progress early stand-down (Phase 30, plan 14) ([`ddb33e2`](https://github.com/jwitmann/opencode-dev-framework/commit/ddb33e2f1a4e050f27bc8b509d2f6a4983d6f22c))

### Documentation

- README graph shows agent loop as primary, /df-goal as optional entry ([`b672a5c`](https://github.com/jwitmann/opencode-dev-framework/commit/b672a5cc32c0f903c8a5c37ac8f21a8dbeea120c))
- audience-split reorg, quickstart-first README ([`eb74556`](https://github.com/jwitmann/opencode-dev-framework/commit/eb74556539e23324f3f122d3e607049a06edb9bb))
- Phase 2 guides, examples, anti-rot pin ([`00106b8`](https://github.com/jwitmann/opencode-dev-framework/commit/00106b8f7fefcb836583d063c1c27b42d2a54d78))
- Phase 2 transcripts, session links ([`43cc57e`](https://github.com/jwitmann/opencode-dev-framework/commit/43cc57e045ae4e5c137b4d79409e368b45349f1b))
- record Phase 2 live-run receipts in 08-notes ([`338adc6`](https://github.com/jwitmann/opencode-dev-framework/commit/338adc6f3d2d7a061acd876842c811035e007ac6))
- troubleshooting entry for red-tree diagnosis without fixes ([`ebb9aec`](https://github.com/jwitmann/opencode-dev-framework/commit/ebb9aecb7a1c775d3a125471606968d54f616785))
- README limitations note the proposed upstream pre-stop veto ([`74c9a1a`](https://github.com/jwitmann/opencode-dev-framework/commit/74c9a1adb78a7f7c423b197b051a3a1a50b00528))
- README commands as a quick-reference table ([`4c4c2f8`](https://github.com/jwitmann/opencode-dev-framework/commit/4c4c2f844c1d99162c02b051078ecc961f007bd7))
- README graph shows user prompt as entry, goal as wrapper ([`b001425`](https://github.com/jwitmann/opencode-dev-framework/commit/b001425ee754f55492894b1c8ccd68ecce2bf6d6))
- README graph entry covers plain prompt or /df-goal ([`32b349e`](https://github.com/jwitmann/opencode-dev-framework/commit/32b349ef9f543efbc095f91ae0d490678e294838))
- plan 14 + Phase 30 for no-progress early stand-down ([`57d95c2`](https://github.com/jwitmann/opencode-dev-framework/commit/57d95c25f8e9c26046e0dc4743522338a8c75c79))
- early stand-down reflected in README, commands, verified-goals ([`88e8a52`](https://github.com/jwitmann/opencode-dev-framework/commit/88e8a52789380607b1b1df9464a81c016400bf18))

## [v1.1.0] - 2026-10-30

### Features

- teach plan-under-df-goal execution in bundled delegation rule ([`68b3973`](https://github.com/jwitmann/opencode-dev-framework/commit/68b39732e4d2bb687c14940edb2d92050ac039c3))

### Documentation

- recommend running plans under df-goal in README ([`a3c55c5`](https://github.com/jwitmann/opencode-dev-framework/commit/a3c55c50797ead6592657aab108b9257f5211b05))
- mention acceptance commands in README What-it-does gate bullet ([`cc9ae1f`](https://github.com/jwitmann/opencode-dev-framework/commit/cc9ae1f55076323d54fd2945c4be56b5272a61b0))
- correct enforcement-layers table (execute.before is load-bearing) ([`18b6028`](https://github.com/jwitmann/opencode-dev-framework/commit/18b60283280db0539bd1731538619213fa2f27c4))
- give df-goal lede presence and its own What-it-does bullet ([`8faa321`](https://github.com/jwitmann/opencode-dev-framework/commit/8faa3216750cfc14c8fcbceddb14f7ee1a1c7d34))
- add enforcement flow diagram to README What-it-does ([`d061cdc`](https://github.com/jwitmann/opencode-dev-framework/commit/d061cdc8cd62ead6b3187f8bb9e33e511328a0bc))
- show gate.acceptance and rules-append form in README config example ([`323b024`](https://github.com/jwitmann/opencode-dev-framework/commit/323b024e0ecd571a7a60966e4f4713b6b76d466e))

### Other

- cache matchers, parallelize gate, skip redundant suites ([`77d84bc`](https://github.com/jwitmann/opencode-dev-framework/commit/77d84bca0f8d47729c2c38bcf97dfef094dbb5fd))
- address peer-review findings on perf pass ([`ecb20a9`](https://github.com/jwitmann/opencode-dev-framework/commit/ecb20a91b9d178495387a0aeddf137a0ee622a05))
- retrospective Phase 2 pass findings (stale-drop, session.command, docs) ([`0b9ac76`](https://github.com/jwitmann/opencode-dev-framework/commit/0b9ac76d544b7a2d5bbb9754c8346228a4e7ad1a))
- retrospective Phase 1A+1B pass findings (schema, docs, style) ([`e2e0567`](https://github.com/jwitmann/opencode-dev-framework/commit/e2e0567bbadbc4218a9fc6418b00444b1277a846))

## [v1.0.0] - 2026-10-30

Initial stable release line.
