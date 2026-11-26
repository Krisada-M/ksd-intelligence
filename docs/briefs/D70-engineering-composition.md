# D70 — single-install engineering composition

Owner request: link the two repositories; only KSD Intelligence is installed as the product. Keep erosiano-dev's upstream repository independent, pin its reviewed runtime, and share the engineering standard across OMP and AGY.

## Acceptance

- Exact reviewed upstream commit and runtime allowlist, byte/mode verification of source and dist, explicit owner-run update; no runtime network or dependency loader.
- Only one OMP entry; new factory once, native ei_* tools remain registered with existing approval/engine contracts, legacy commands delegate, prior settings/session replay retained. Do not co-install standalone policy.
- Package consumer installs the four engineering companion binaries and exports the current ESLint module. No old dist/policy runtime in the tarball.
- Native AGY manifest and generated balanced rule plus on-demand review skill; fixed-root existing MCP remains explicit, no OMP lifecycle emulation. Validate against actual agy before acceptance.
- Preserve frozen v0.6 source/tests, all golden expectations, V2 behavior, and native gates. New regression and package tests. No version bump, merge or publish before owner acceptance.
- Cross-host checks: actual OMP local marketplace install, one policy block, native tool availability, migration and rollback; actual AGY validate/install and rule/skill/MCP discovery. Mock and protocol evidence are not live AGY acceptance.

The exact upstream candidate is PR #26, commit f8c85ce74dc9d94d73417e032f10b4a17232b754. Review that PR and its CI before accepting the downstream bundle. No external runtime dependency is added.
