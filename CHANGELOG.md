# Changelog

<!-- markdownlint-disable MD024 --><!-- repeated bucket headings -->

Generated from conventional commits (`scripts/changelog.sh`).
Single source: CI publishes each version's section as the GitHub
release notes, so this file and the release page never diverge.

## [v1.12.0] - 2026-11-24

### Features

- require duties before summary in Definition of done ([`3700e87`](https://github.com/jwitmann/opencode-dev-framework/commit/3700e87a120fbebddabb5a953a4cc2e099a13b49))
- structured specialist findings on DSH via outputSchema ([`eb84aec`](https://github.com/jwitmann/opencode-dev-framework/commit/eb84aec911a80419910fb4c63670f7a50520815e))
- least-privilege permissions on shipped reviewer agents ([`3c7035d`](https://github.com/jwitmann/opencode-dev-framework/commit/3c7035d88ea38b6bbe278beb5b3f4b2f1fe71d3d))

### Fixes

- prefix unused goals.create stub param ([`ffc45e5`](https://github.com/jwitmann/opencode-dev-framework/commit/ffc45e501e23737ded2f4ac7fb8598915256f97a))
- single-line boolean returns in agents.test.ts ([`196a271`](https://github.com/jwitmann/opencode-dev-framework/commit/196a27133703a96abb7ee7839d7a7fdf0b70d0c4))
- clear all biome warnings (literal keys, non-null assertions) ([`15520e7`](https://github.com/jwitmann/opencode-dev-framework/commit/15520e76112e613f599fcdb7b6ce663c285925b6))

### Documentation

- point OpenCode users at host formatter config ([`0b7a733`](https://github.com/jwitmann/opencode-dev-framework/commit/0b7a733d7250b776479deac0fd9f3fdf920f61b9))
- skill flags missing host formatter on OpenCode, skips DSH ([`5976271`](https://github.com/jwitmann/opencode-dev-framework/commit/5976271a9962b8d4ea7a46fde9b135dc8a4e96c3))
- tick 26.0 plan-written box, executed 2026-11-17 ([`df5bff9`](https://github.com/jwitmann/opencode-dev-framework/commit/df5bff9876e7166a87d05470e3d8da039c050d25))
- record parked-list ranking and verdicts ([`ab50764`](https://github.com/jwitmann/opencode-dev-framework/commit/ab50764739fef1d72752dd2038716f0ea148e5b3))
- correct parked-list ranking against host source ([`eebd967`](https://github.com/jwitmann/opencode-dev-framework/commit/eebd9671e6794a2ac7749d119d90d572d60bed7d))
- record OpenCode side of toolFilter intent as covered ([`1940e34`](https://github.com/jwitmann/opencode-dev-framework/commit/1940e34d6248dc9fdd7e344ff6c31be5b0221fd5))
- close out #1 with the mirrored OpenCode/DSH designs ([`befe5c8`](https://github.com/jwitmann/opencode-dev-framework/commit/befe5c82fc896a528f047c41181a04b66e466563))
- record model-pinning rejection as deliberate non-goal ([`c2ad222`](https://github.com/jwitmann/opencode-dev-framework/commit/c2ad222ec9c0dc0ec9e653c02763559522c92cb8))
- reframe model pinning as deferred-until-requested ([`20f7cca`](https://github.com/jwitmann/opencode-dev-framework/commit/20f7ccaadfda48f5c000d676a7f3e7617251453c))
- note agentOptions feasible on spawn provider ([`f79923d`](https://github.com/jwitmann/opencode-dev-framework/commit/f79923d56907f9f4fedf46b327267b79769d08b0))
- record depth-cap decline alongside deferred model pinning ([`8a1c309`](https://github.com/jwitmann/opencode-dev-framework/commit/8a1c309cf4987b62705cd763a005b99a95557db6))
- depth-cap decline originated OpenCode-side ([`d6ff014`](https://github.com/jwitmann/opencode-dev-framework/commit/d6ff014d232f3466017bc2dfa5be281f689a9848))
- note least-privilege reviewer frontmatter in README ([`5a7935f`](https://github.com/jwitmann/opencode-dev-framework/commit/5a7935f5e9b6d37e59104f83590cc2fb09ba2a93))

### Other

- drop V1 agent frontmatter for native V2 format ([`0c4a159`](https://github.com/jwitmann/opencode-dev-framework/commit/0c4a159a32b6022abc1330257c9f9d1002f9d69d))
- remove dead V1 client path from logger ([`e4a0065`](https://github.com/jwitmann/opencode-dev-framework/commit/e4a0065cb2cf290f41a3c322d8a67b0d1a4d7b2a))

## [v1.11.1] - 2026-11-24

### Documentation

- record secret-output redaction as evaluated and rejected non-goal ([`0fb6786`](https://github.com/jwitmann/opencode-dev-framework/commit/0fb6786e1979227397c60033fa47f4fa3d0166ab))
- highlight enforcement principles in README ([`9c0d2ce`](https://github.com/jwitmann/opencode-dev-framework/commit/9c0d2ceff073ab998a261dda14d2d2a916766884))
- embed rendered flow SVG so npm shows the diagram ([`3dcd813`](https://github.com/jwitmann/opencode-dev-framework/commit/3dcd813cac7073e14c91d6cdc0984471182005ef))
- add Secrets section recommending gitleaks at the commit boundary ([`ab76191`](https://github.com/jwitmann/opencode-dev-framework/commit/ab76191ef08ada542c7194502a7e36db12ad0f06))
- name runtime-redaction plugins in Secrets section, without endorsement ([`6a32297`](https://github.com/jwitmann/opencode-dev-framework/commit/6a322973bc8967d8902fbbfcb7610b4439dff33d))
- point README guardrails bullet at Secrets section ([`df89287`](https://github.com/jwitmann/opencode-dev-framework/commit/df8928724f268e56479815f95b3da08c3698376b))
- fix stale plugin key, npx package name, and lint wording in install docs ([`1d98ad6`](https://github.com/jwitmann/opencode-dev-framework/commit/1d98ad6b17d7a2ec89845644f778385290789d91))
- correct intro to host-split formatting truth, clarify who runs formatter ([`eb08b50`](https://github.com/jwitmann/opencode-dev-framework/commit/eb08b503c4831e6665f005481b5ad053a08c3291))
- add DSH compat floor to install step ([`c3cad0f`](https://github.com/jwitmann/opencode-dev-framework/commit/c3cad0fc627062953bc25f1f4586459e86b2130b))

## [v1.11.0] - 2026-11-23

### Documentation

- restore native OpenCode plugin statement with compat floor ([`daee7ca`](https://github.com/jwitmann/opencode-dev-framework/commit/daee7ca65e27e783295c7bfa663b7ff8d31ff051))
- record DSH community-docs observations and parked subagent enhancements ([`1c0747c`](https://github.com/jwitmann/opencode-dev-framework/commit/1c0747ccff774f22d1f3ee9dae7eabfb78ee2518))
- host-upgrade skew pends odf-gates, downgrade-or-redetect ([`067801b`](https://github.com/jwitmann/opencode-dev-framework/commit/067801b38a77a6ef3dc7a21e3c5e3623bc1ecd0b))
- surface OpenCode v2.x compat floor in install step ([`27cc6d9`](https://github.com/jwitmann/opencode-dev-framework/commit/27cc6d96423261da6f24388bfcb463af97589abe))
- record OIDC trusted-publishing cutover in notes log ([`811189d`](https://github.com/jwitmann/opencode-dev-framework/commit/811189d7b9f5390be6a0da60e044a264632a9e4a))
- add dsh-plugin.org verified-listing badge to README ([`58f9eed`](https://github.com/jwitmann/opencode-dev-framework/commit/58f9eed9396d25071002feed3948cce7a0ceb526))
- add npm version, CI, and license badges to README row ([`9983578`](https://github.com/jwitmann/opencode-dev-framework/commit/99835785cc4c2aeb883e0be16a9b002a8bf3636d))
- use live-verified compat phrasing the opencode.im checker recognizes ([`98eada0`](https://github.com/jwitmann/opencode-dev-framework/commit/98eada06cd5dcf9194ff36142c18b1fee333b8a9))
- add OpenCode V2 badge to README row, matching VCC README ([`f124421`](https://github.com/jwitmann/opencode-dev-framework/commit/f124421f088fc06a50b871be4bd122afa158fe20))
- correct CLI help and release status ([`ca5fda2`](https://github.com/jwitmann/opencode-dev-framework/commit/ca5fda25ecb8094f2e86b5c7f91324d573fafd49))

### Other

- restore native OpenCode plugin statement with compat floor" ([`89bde5f`](https://github.com/jwitmann/opencode-dev-framework/commit/89bde5f6c2faad75aeab9fd93182dfa3d2438794))
- publish via OIDC trusted publishing, drop NPM_TOKEN ([`6ab4290`](https://github.com/jwitmann/opencode-dev-framework/commit/6ab42902bb060c71f11045e3b7548d180596563b))
- update reuse guidance and brain ignores ([`578c589`](https://github.com/jwitmann/opencode-dev-framework/commit/578c5892767fd2261a584facd5874efda8dc4fba))

## [v1.10.2] - 2026-11-18

### Fixes

- drop stale after-release wording from legacy-upgrade warning ([`3910bde`](https://github.com/jwitmann/opencode-dev-framework/commit/3910bde3be3496bb98d1a5a49c53da61c6811ec3))

### Documentation

- add opencode.json plugin declaration example ([`0d45e65`](https://github.com/jwitmann/opencode-dev-framework/commit/0d45e65d60e7db460a685fa373341aad42f2c85f))

### Other

- add opencode-plugin discovery keyword ([`326bc62`](https://github.com/jwitmann/opencode-dev-framework/commit/326bc623f08f25e702b785c547d3591a2879b0e6))

## [v1.10.1] - 2026-11-18

### Documentation

- post-release install wording ([`aad6e24`](https://github.com/jwitmann/opencode-dev-framework/commit/aad6e2458ba8c5a4c864d8aebaa19d25f341a4d9))

### Other

- add dsh-plugin discovery keywords ([`549f097`](https://github.com/jwitmann/opencode-dev-framework/commit/549f0977fc63870524565aa6ed48c3267e016bc2))
- dual-harness package description ([`2c5dca1`](https://github.com/jwitmann/opencode-dev-framework/commit/2c5dca100a338a295c1f3852db39cbe7900c1682))

## [v1.10.0] - 2026-11-18

### Features

- add shared formatFile runner + tests (plan 25 slice 2) ([`d368329`](https://github.com/jwitmann/opencode-dev-framework/commit/d36832923fe20b5c368b4bae62fed219c1ff7c97))
- package DSH adapter in-place (plan 25 slice 4) ([`b9d335e`](https://github.com/jwitmann/opencode-dev-framework/commit/b9d335e18b3ccc0f0be8dc5888e05af05eace21f))
- correct DSH guard contracts (warn, guard-error, pre-flight, load) ([`d9ff568`](https://github.com/jwitmann/opencode-dev-framework/commit/d9ff568effb86ecaa83ca2f41e9f3107c52c7572))
- close DSH contract gaps (apply_patch pre-flight, kill-switch parity, artifact path) ([`4fa1266`](https://github.com/jwitmann/opencode-dev-framework/commit/4fa1266c0f6348e40040619c9585fd32858091aa))
- DSH superiority round (post-execute block, abort-aware steer, deny identity) ([`51d9adf`](https://github.com/jwitmann/opencode-dev-framework/commit/51d9adf1a32f4fde5ddd7663cc3ee28e44c8d09a))
- DSH shippables (export entry, user docs, staged live-fire) ([`0902491`](https://github.com/jwitmann/opencode-dev-framework/commit/090249181725325a9c2a84f472997370c0f0f623))
- DSH parity completion (constitution injection, df-goal/verify/profile/init/update) ([`52a5689`](https://github.com/jwitmann/opencode-dev-framework/commit/52a56893fbb61d185eb18baa3637f68b91f090b2))
- DSH df-runtime, stamp honesty, four agent tools ([`d51fb9a`](https://github.com/jwitmann/opencode-dev-framework/commit/d51fb9aaf11495760542a690898f534855715b55))
- DSH child-session guard (header read, gate skip, artifact deny) ([`d3df391`](https://github.com/jwitmann/opencode-dev-framework/commit/d3df391dad0e6dd82284ee5402b6deeda1d8c13f))
- DSH-native df-init (skill mirror, tool brief) + warn asks human ([`9ec3307`](https://github.com/jwitmann/opencode-dev-framework/commit/9ec3307bf08cb9201af6ed7b647a8719a9963b1f))
- honest df-status on DSH (formatter attribution, seam visibility) ([`661d093`](https://github.com/jwitmann/opencode-dev-framework/commit/661d093218756adbf7fa08e0eaf97d34d22e0dcd))
- maintain the DSH skill mirror (update drift, init tool, df-help) ([`ef33a8f`](https://github.com/jwitmann/opencode-dev-framework/commit/ef33a8f0d4b9b5334d08a5ce96f1bcf6bce353c3))
- model-invokable update + runtime tools on both harnesses ([`3031aa5`](https://github.com/jwitmann/opencode-dev-framework/commit/3031aa570806771418bb544df53965c30b1820ed))
- wire tool triggers into gate steer and init brief ([`e040193`](https://github.com/jwitmann/opencode-dev-framework/commit/e040193852d1e1457d2a2f4c613b7842bc2aefec))
- drift mention names dev_framework_update, model calls it unprompted (live-proven) ([`04819e6`](https://github.com/jwitmann/opencode-dev-framework/commit/04819e638ac1bc1a07a18b201d9435a6aea3ca7e))
- harness-neutral framework home (.dev-framework/) with legacy fallback (Phase 44) ([`e0c8ec8`](https://github.com/jwitmann/opencode-dev-framework/commit/e0c8ec8626db59a823d83e9c66ecf3ad50c967f6))
- dispatch pattern-guardian child on DSH gate block (plan 26.2) ([`2139e72`](https://github.com/jwitmann/opencode-dev-framework/commit/2139e725619cb9f5175c474466d137fba82ed299))
- multi-kind specialist dispatch on review-blocks + read-only reviewer preset (plan 26.3) ([`e5d3ff8`](https://github.com/jwitmann/opencode-dev-framework/commit/e5d3ff8e63edfb627f78f14d9f73c551f330708e))
- neutral-first specialist brief chain (no OpenCode home required on DSH) ([`ae11ca6`](https://github.com/jwitmann/opencode-dev-framework/commit/ae11ca6d5ba0a8662b7f49e6541b47c2f47e54d2))
- child-deny on gate tools + df init --dsh skill mirror (hardening) ([`8711a46`](https://github.com/jwitmann/opencode-dev-framework/commit/8711a469fbb0bacbd5630495dfc5e59e74383857))
- df install-dsh one-command DSH profile wiring (npm-first, preset auto-detect) ([`d8060a7`](https://github.com/jwitmann/opencode-dev-framework/commit/d8060a74f704e1f0f4fa4bd5163a08216535861d))
- dsh.bundle auto-layer + install-dsh bundle-aware preset upgrade ([`7fb765b`](https://github.com/jwitmann/opencode-dev-framework/commit/7fb765ba4b66b545ee50c8388c172084592917fe))

### Fixes

- tracker refuses out-of-tree absolute paths ([`ea35ae0`](https://github.com/jwitmann/opencode-dev-framework/commit/ea35ae022ba678b728e752d4ce29a8eea77dc474))
- name omitted files in lint block tail (no false gate-coverage claim) ([`30196d3`](https://github.com/jwitmann/opencode-dev-framework/commit/30196d36866701c59674bb45a836ce1606fbd87c))
- battery findings (nullable status holder, deterministic runtime test) ([`ccae207`](https://github.com/jwitmann/opencode-dev-framework/commit/ccae207f210e956ba8b3b011a381bd49e47f9c2d))
- redirect phantoms (heredoc/quoted/2>&1) + inject-guard hardening ([`d74ec5a`](https://github.com/jwitmann/opencode-dev-framework/commit/d74ec5abda8d3e81979457657e4fbc0e61d56418))
- preserve service receiver on tool registration + review ([`5828ca3`](https://github.com/jwitmann/opencode-dev-framework/commit/5828ca343f196817d1543a0820ff1cf5a079bdb4))
- preserve agent receiver on followup handoff + review ([`ea3cf59`](https://github.com/jwitmann/opencode-dev-framework/commit/ea3cf5951b891ac24202510fb0ab8eb91c11967f))
- stamp host session-event ids on DSH messages (resume-shaping) ([`4728bdd`](https://github.com/jwitmann/opencode-dev-framework/commit/4728bdda3dee471ede7e3e56f369325124f7af37))

### Documentation

- record live-fire proof (deny, block, same-turn steer all observed) ([`d0f8e3d`](https://github.com/jwitmann/opencode-dev-framework/commit/d0f8e3d585423bf2be8832d8034a09f2663f3d6b))
- DSH parity audit (full OpenCode surface mapped) + Phase 43 plan ([`02a6e7c`](https://github.com/jwitmann/opencode-dev-framework/commit/02a6e7c60efc43fd47acbb5456e003aecf96d836))
- pin child-guard mechanism to host pipeline source ([`a2e055e`](https://github.com/jwitmann/opencode-dev-framework/commit/a2e055e5927b10e2245c87152493be716aee2a7a))
- record live proof for status tool + child artifact deny ([`419aa27`](https://github.com/jwitmann/opencode-dev-framework/commit/419aa27ee17727717412a365c2e0a4378def697a))
- mark Phase 32 DONE (items complete since f735166) ([`a7a3390`](https://github.com/jwitmann/opencode-dev-framework/commit/a7a339075c6cf16571ac0fa3e57bfa20960e59d4))
- record TUI warn->ask live proof (proof 1 closed) ([`6999297`](https://github.com/jwitmann/opencode-dev-framework/commit/699929749d2c0b12552b934a66128c0ad914f178))
- record human-typed df-goal live proof (proof 3 closed) ([`ef91f8f`](https://github.com/jwitmann/opencode-dev-framework/commit/ef91f8f715ad20cfd2b22d2d9ebe53520273633a))
- note placeholder keyword trips review template check (tvmRSS observation) ([`30db588`](https://github.com/jwitmann/opencode-dev-framework/commit/30db58851d2965b0c00858105cd677cdb1debb6e))
- track message-id resume fix in checklist ([`6ed83f1`](https://github.com/jwitmann/opencode-dev-framework/commit/6ed83f1a5b342d1ecf968d961e6c213b7ccbee70))
- README reflects dual-harness reality (config name, DSH live proofs) ([`78ab8de`](https://github.com/jwitmann/opencode-dev-framework/commit/78ab8debe0212f128da0fe442958832b91afd186))
- restructure README for dual-harness (split quickstart, differences matrix) ([`ab99fb2`](https://github.com/jwitmann/opencode-dev-framework/commit/ab99fb2b148829e92047d26f53d843513fb63d36))
- scope delegation rule per harness (DSH inline is primary, not fallback) ([`2d98ac9`](https://github.com/jwitmann/opencode-dev-framework/commit/2d98ac9fd5ac3d1de2cd559a57245b42f88cc82d))
- scope Phase 26 (DSH specialist subagents via ctx.subagents) ([`ccdca42`](https://github.com/jwitmann/opencode-dev-framework/commit/ccdca42884073d3b1c583880507f1e06a4f5b18c))
- fix list style in plan 26 (MD004) ([`8061080`](https://github.com/jwitmann/opencode-dev-framework/commit/8061080cd54ae0d2732041cad03f0012e3a1ef72))
- correct plan 26 (plugin ships reviewer preset; spawn-only) ([`53d6844`](https://github.com/jwitmann/opencode-dev-framework/commit/53d68445403ac336260de6c751d96c1f5aaca202))
- record Phase 26 probe results (subagents loop green) ([`e9a77f2`](https://github.com/jwitmann/opencode-dev-framework/commit/e9a77f2e278c5c842fb77cabdfb7b51545009eb6))
- record Phase 26.3 live proof (multi-kind dispatch, gate PASS) ([`6cac4e9`](https://github.com/jwitmann/opencode-dev-framework/commit/6cac4e9d7713a65f179d3cb2d204af241e46138e))
- dsh.md + matrix reflect specialist dispatch (plan 26.4 docs half) ([`bc0d5d3`](https://github.com/jwitmann/opencode-dev-framework/commit/bc0d5d3f7c0922cbb92cf0948c0c3879b1b05709))
- record neutral-first brief chain in plan 26 ([`d3e6ee2`](https://github.com/jwitmann/opencode-dev-framework/commit/d3e6ee22161adce8b700cccc514a8b02e5d9ca3b))
- close Phase 26 with TUI preset live proof (session 78def5ff) ([`d3dd0a2`](https://github.com/jwitmann/opencode-dev-framework/commit/d3dd0a27a3520c448d0855fcaf41ef0eebe4f55e))
- record post-merge hardening in checklist ([`7946f01`](https://github.com/jwitmann/opencode-dev-framework/commit/7946f015214ffc4aab7ce09df1df1eb8913255f7))
- record df install-dsh in checklist ([`77c5540`](https://github.com/jwitmann/opencode-dev-framework/commit/77c554015be12f7be9216af384f972a2ba780641))
- refresh user docs for dispatch, bundle install, child-deny ([`80ad57a`](https://github.com/jwitmann/opencode-dev-framework/commit/80ad57a043d306f7edd82a8ccfed1d3b178c3953))
- rebalance README as dual-harness, mark where DSH enforces harder ([`e155ab1`](https://github.com/jwitmann/opencode-dev-framework/commit/e155ab13c05ee17a1aa9881ad295eb7a7344837f))
- make DSH quickstart and reference first-class ([`a24ca80`](https://github.com/jwitmann/opencode-dev-framework/commit/a24ca806e381f4e53c214393e4032602ca9d3039))
- split README limitations by harness ([`be6d71c`](https://github.com/jwitmann/opencode-dev-framework/commit/be6d71cd58c4a06ff09696a82dd866fe89e2af1f))
- defer OpenCode stopping-hook restoration ([`341a351`](https://github.com/jwitmann/opencode-dev-framework/commit/341a351843f21e325c63063708f304ee7a60b3d3))
- simplify README introduction ([`e223c02`](https://github.com/jwitmann/opencode-dev-framework/commit/e223c02bf5a47f232199658e83bfa867ac9dffb9))
- link DSH alongside OpenCode ([`086847e`](https://github.com/jwitmann/opencode-dev-framework/commit/086847eeff20379703f3ccc3e4bb8f10cd68cc44))
- spec DSH continuity probe, scope 61884 watchlist ([`876c717`](https://github.com/jwitmann/opencode-dev-framework/commit/876c7171f06f447c2d92b132cc2b39f50a92eb1f))
- final README accuracy pass, fix publishing checklist ([`c470958`](https://github.com/jwitmann/opencode-dev-framework/commit/c4709584abbc7543592b646b1706f6f80fee5e4e))
- move source build to local development section ([`64cb3f2`](https://github.com/jwitmann/opencode-dev-framework/commit/64cb3f263662a6ca6c1c1203ef000fe79c651af9))
- registry-first install wording for 1.10.0 release ([`4916411`](https://github.com/jwitmann/opencode-dev-framework/commit/491641197c417592dfb34acd693446d8befe64fb))

### Other

- extract shared hook flows to src/run-hooks.ts (plan 25 slice 1) ([`a21270a`](https://github.com/jwitmann/opencode-dev-framework/commit/a21270a82dcd9dcf76f4cce84da46bf7983fa09c))
- address peer-review findings on DSH slices 1-2 ([`2b553d2`](https://github.com/jwitmann/opencode-dev-framework/commit/2b553d2800043ef898df151860c4fefa335f9655))
- cover lint feedback cap and preflight-deny identity ([`1f4b044`](https://github.com/jwitmann/opencode-dev-framework/commit/1f4b04470711bb471440e346266cb620fc676b86))
- DSH odf-status to df-status for df-* convention ([`0f2b926`](https://github.com/jwitmann/opencode-dev-framework/commit/0f2b9262eeb2b7a2df8f7c702934b1472483579c))
- receiver-enforcing coverage for df-update followup handoff ([`bfa6834`](https://github.com/jwitmann/opencode-dev-framework/commit/bfa6834ded0064b18e33bd18d4e52fe5bb13d2e6))
- ignore local-only dirs (.operator, .dsh, .dev-framework) ([`816c57d`](https://github.com/jwitmann/opencode-dev-framework/commit/816c57d694d0c0258110c7c05e225ab0bd869ade))
- framework home and config are local-only, never tracked ([`920182c`](https://github.com/jwitmann/opencode-dev-framework/commit/920182c259ba4f6dc57b343260ff8ccfc589b37e))
- stop tracking legacy self-host config (local-only from here) ([`912f35a`](https://github.com/jwitmann/opencode-dev-framework/commit/912f35a01abcf9be132e40a07688a75c6d724999))
- DSH adapter line — neutral home, message ids, specialist dispatch (live-proven both harnesses) ([`de5b026`](https://github.com/jwitmann/opencode-dev-framework/commit/de5b026734dbe3c656f88876e2e02c317e990a8f))
- pin bounded pre-terminal completion blocking ([`3f9d175`](https://github.com/jwitmann/opencode-dev-framework/commit/3f9d175df518265013d4b83e36372c8c638373f7))
- enforce temporal review freshness, narrow placeholder check ([`01600b6`](https://github.com/jwitmann/opencode-dev-framework/commit/01600b6f32b862fc44580ca03a9fbec63b1e1111))
- add continuity probe with session log tail ([`dfe7eb7`](https://github.com/jwitmann/opencode-dev-framework/commit/dfe7eb7543416da8bcb99637494f76c446de3646))

## [v1.9.5] - 2026-11-16

### Documentation

- DSH migration assessment; docs-only cadence is lint ([`d3965d8`](https://github.com/jwitmann/opencode-dev-framework/commit/d3965d871aafce91ac7b2561b6fc3130ccc3acbc))
- relocate DSH migration assessment out of repo ([`a37aa27`](https://github.com/jwitmann/opencode-dev-framework/commit/a37aa27d497f2b7e5fa4ea85fd448a6e355d4467))

### Other

- single cached child walk, mkdir-once log writes, log level gate ([`0376839`](https://github.com/jwitmann/opencode-dev-framework/commit/037683901754c15baba53ddf7ad9f4e001a84ba4))

## [v1.9.4] - 2026-11-14

### Features

- log session chain depth on child-gated decisions (plan-24 tripwire) ([`f390caf`](https://github.com/jwitmann/opencode-dev-framework/commit/f390caf068b7bb8ab84fe24e1708235bd7711121))

### Documentation

- nested review receipts design (requester judges) ([`8efe95e`](https://github.com/jwitmann/opencode-dev-framework/commit/8efe95e7d9524d19c3e8ed4b19d1613bfdcc0691))
- harden nested-receipts design through three review passes ([`b39f37c`](https://github.com/jwitmann/opencode-dev-framework/commit/b39f37cc3d53ce3ddff311bea374987731957ec1))
- plan 24 deferred to subagent_depth raise, depth cap refused as core duty ([`3ddeb16`](https://github.com/jwitmann/opencode-dev-framework/commit/3ddeb16c68581fa919d75b1278344d6b4b53a8dd))
- drop adversarial bypass framing from plan 24 ([`37eb346`](https://github.com/jwitmann/opencode-dev-framework/commit/37eb3463727e8430a0a999989a289d75c694b8ce))
- pin core revision for subagent_depth claims in plan 24 ([`c4bf7da`](https://github.com/jwitmann/opencode-dev-framework/commit/c4bf7da1c9819afdf22ae5abd56f8e20d4ccd6a7))
- re-verify subagent_depth claims against resynced core ([`c957d3e`](https://github.com/jwitmann/opencode-dev-framework/commit/c957d3e94a900d63b67d1282c9f1eadc19359403))
- record plan-24 depth tripwire as checklist Phase 38 ([`55fc4c2`](https://github.com/jwitmann/opencode-dev-framework/commit/55fc4c2c26c25bed7d983eeaf6b2fe54fb55ea5b))
- correct tripwire entry to Phase 41, fix future dates ([`3184b03`](https://github.com/jwitmann/opencode-dev-framework/commit/3184b034b133c00b12518bb143e6aae6c60b50d5))

## [v1.9.3] - 2026-11-14

### Other

- retry temp-dir removal in lint-after cleanup (CI ENOTEMPTY flake) ([`331b65f`](https://github.com/jwitmann/opencode-dev-framework/commit/331b65f77ad4eebb4b37a067ae9cab22f2e6f0ab))

## [v1.9.2] - 2026-11-14

### Features

- silent no-op turns for /df-update and /df-init ([`0044eb1`](https://github.com/jwitmann/opencode-dev-framework/commit/0044eb154eb3702d1c48e9eb6699f0955bc80216))
- template drift state in /df-runtime snapshot ([`3da862e`](https://github.com/jwitmann/opencode-dev-framework/commit/3da862e7c47965cceb1787105b4f51382477fcf1))
- child sessions never touch the parent review artifact ([`4480483`](https://github.com/jwitmann/opencode-dev-framework/commit/4480483d699432fcd4e6c2303377ee98517aec0b))

### Fixes

- apply review findings on runtime template state ([`195aab3`](https://github.com/jwitmann/opencode-dev-framework/commit/195aab3d2ddfb2cf6a2949a8336d788105879e59))
- close reviewer-found bypasses in child artifact guard ([`aab03cd`](https://github.com/jwitmann/opencode-dev-framework/commit/aab03cd34188a803899c800fa72b91a8def71adf))

### Documentation

- correct predicate formula in plan 21 ([`32b6e7b`](https://github.com/jwitmann/opencode-dev-framework/commit/32b6e7bfe4008924e45c819df6ddbe067b3252cb))
- stale serve backend troubleshooting entry ([`2e57427`](https://github.com/jwitmann/opencode-dev-framework/commit/2e574276fd07218d545f9bae1a5230d6c093947f))

### Other

- use static mkdirSync import in new tolerance tests ([`85808cb`](https://github.com/jwitmann/opencode-dev-framework/commit/85808cb3a4b4da6c05b935403734239420f952ce))
- enforce import organization via biome check ([`47072f9`](https://github.com/jwitmann/opencode-dev-framework/commit/47072f9cf3343d9b4652fe98643a800a799f9ac3))

## [v1.9.1] - 2026-11-13

### Features

- startup template-drift mention once per session ([`c37c94a`](https://github.com/jwitmann/opencode-dev-framework/commit/c37c94ab3e15e1be1198805e03fa9cbfd2369318))

### Fixes

- specialists never write files; report text is the entire output ([`bf55dac`](https://github.com/jwitmann/opencode-dev-framework/commit/bf55dac904d66925d8103ce8602ef09ce8651830))

### Documentation

- track skill-line fix, startup mention, and this week's findings ([`863c629`](https://github.com/jwitmann/opencode-dev-framework/commit/863c629e14647e86f038f947921734d1015d0492))

## [v1.9.0] - 2026-11-13

### Features

- reuse fresh specialist reports instead of re-running the full cadence ([`61b9772`](https://github.com/jwitmann/opencode-dev-framework/commit/61b9772fe11bc3ebf46bfb1b664290b5d7edf880))
- /df-update brings deployed templates current with per-file approval ([`3587887`](https://github.com/jwitmann/opencode-dev-framework/commit/358788770a2a34563f945e68e0c2216fda338e47))

### Documentation

- configuration documents review freshness alongside substance ([`2eb1cb7`](https://github.com/jwitmann/opencode-dev-framework/commit/2eb1cb7f526a2969604ddd8c22ef724f5e32e634))
- record deferred npm update hint in 08-notes ([`067b373`](https://github.com/jwitmann/opencode-dev-framework/commit/067b37339fdaef915989e902a682ad53acf68234))
- README covers /df-update; checklist tracks phases 33-35 ([`59d9206`](https://github.com/jwitmann/opencode-dev-framework/commit/59d9206f29867b3760020d558c07f87d2cb71f02))

## [v1.8.0] - 2026-11-12

### Features

- gate fails substantive reviews that ignore the session's changed files ([`960bcf3`](https://github.com/jwitmann/opencode-dev-framework/commit/960bcf31c6459fc89d705ca2bd2a6861ce238681))

### Documentation

- readme readability (quickstart, commands table, limitations bullets) ([`c72790d`](https://github.com/jwitmann/opencode-dev-framework/commit/c72790d6e1a4e8d92775a3addc155c3caa23c0ef))

## [v1.7.0] - 2026-11-12

### Features

- /df-init server command for one-step per-project setup ([`83f98dd`](https://github.com/jwitmann/opencode-dev-framework/commit/83f98dd47caf55561bddd1a57d6cbfa381c443c5))

### Documentation

- skill brief section covers all setup entry points ([`2cb7639`](https://github.com/jwitmann/opencode-dev-framework/commit/2cb7639aeed81765bd7d9fe698d528aa6067cb72))

## [v1.6.0] - 2026-11-12

### Features

- session duty roster injected beside constitution at session start ([`22d5bef`](https://github.com/jwitmann/opencode-dev-framework/commit/22d5bef064e9005a812b649f125c5653e39df217))
- config-weakening detection surfaces mid-session duty reduction at the gate ([`e007c38`](https://github.com/jwitmann/opencode-dev-framework/commit/e007c3899423c394d12722f051a27fdfed69598c))
- review substance floor blocks checkbox peer-reviews at the gate ([`1bea171`](https://github.com/jwitmann/opencode-dev-framework/commit/1bea171cda125bf1d98d8df1de00adbe766fa0fb))
- default user-level log file so the loud record exists unconfigured ([`ddd4b83`](https://github.com/jwitmann/opencode-dev-framework/commit/ddd4b832e89542e4d5d6341b7e1edfbbeeef383b))

### Fixes

- changelog backfill writes newest-first ([`805b639`](https://github.com/jwitmann/opencode-dev-framework/commit/805b6395b90a02142be753d4e57194ad033f2038))
- address peer-review findings on default log file ([`7306764`](https://github.com/jwitmann/opencode-dev-framework/commit/73067641c631f079fdecd602f8002235fcf77ccb))

### Documentation

- upstream watchlist (stopping, settled-continuity, background, ralph) ([`2042847`](https://github.com/jwitmann/opencode-dev-framework/commit/2042847f89ea27def0f43914e93d028da8def0c6))
- limitations point at V2 stopping issue #60461; ralph verdict closed ([`6ad0161`](https://github.com/jwitmann/opencode-dev-framework/commit/6ad0161347460509bf6536b3e56b381eab695963))
- upstream watchlist adds interrupt-cancel synthetic scope opt-in ([`0c82b9e`](https://github.com/jwitmann/opencode-dev-framework/commit/0c82b9e3fefb8cba8387eac352807e042dd3c407))
- drop shell-edit attribution (§4) as low-value ([`4bf94ab`](https://github.com/jwitmann/opencode-dev-framework/commit/4bf94abe2a619a42969b70ce8feef43f6045aeb9))
- drop PATH sanitization half of §5, keep audit ([`f50d3f0`](https://github.com/jwitmann/opencode-dev-framework/commit/f50d3f0c84d9b935bce74eb747c0f40139fd74fd))
- record §6 verdict-visibility audit findings ([`4c9b7ae`](https://github.com/jwitmann/opencode-dev-framework/commit/4c9b7aef316e659d4bbe88f386fd1d12fa365280))
- close out plan 17, decline §§5-6 on dogfood evidence ([`d8b5300`](https://github.com/jwitmann/opencode-dev-framework/commit/d8b530088aab20b9bc9f5ff61390a2e166227685))
- cover review substance, weakening verdict, and duty roster in user docs ([`b7e9fa3`](https://github.com/jwitmann/opencode-dev-framework/commit/b7e9fa3ab369de7425e2b9e3d72303fd034c750f))

### Other

- self-host standard profile with peer-review enforcement ([`1720c4d`](https://github.com/jwitmann/opencode-dev-framework/commit/1720c4d577414b899eaa5b92f8037ffd5d277a89))

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
