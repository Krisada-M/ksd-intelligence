# ADR 0004 — Merge KSD Engineering Proxy as the policy module

**Status:** accepted 2026-11-11 (D39, D40). **Context:** two installs (KSD Engineering Proxy 0.6.0 and this library) meant two plugins to keep compatible; `docs/DESIGN.md` §6.7 freezes the KSD surface so the merge is a migration, not a rewrite.

## Decision

1. **D39 — merge as `src/policy/`:** KSD Engineering Proxy v0.6.0 (commit `73fc916`) moves into this repository at `src/policy/`, files unchanged, JavaScript staying JavaScript. Its commands, config files, session entries, status segment and policy text are a frozen contract: byte- or behaviour-identical to 0.6.0, enforced by `tests/policy/contract.test.js` against snapshots generated from the 0.6.0 clone. One extension entry (`src/adapters/omp/extension.ts`) registers KSD first, then the `ei_*` tools; `ENGINEERING_PROXY_DISABLED` and `EI_DISABLED` stay independent kill switches.
2. **D40 — marketplace packaging (supersedes D38):** the repository is the plugin. `.omp-plugin/marketplace.json` (plugin `ksd-intelligence`, source `.`, version 0.1.0) plus `package.json#omp.extensions` pointing at the built entry; `dist/` is committed and `npm run check:dist` fails on drift. The marketplace follows the default-branch head, so accepted versions are tagged on a `release` branch (owner-created; not created by M1c).

## Consequences

- Cut-over: uninstall `engineering-proxy@engineering-proxy`, then `omp plugin marketplace add Krisada-M/ksd-intelligence` and `omp plugin install ksd-intelligence@ksd-intelligence`. Rollback reverses the two steps. The policy must never be injected twice, so the old plugin is removed before or together with the new install.
- `Krisada-M/ksd-engineering` is archived (not deleted) after cut-over; its README points here.
- KSD config stays in its own files (`~/.omp/agent/engineering-proxy.json`, `.engineering-proxy.json`); it is not folded into `ei.config.json`.
