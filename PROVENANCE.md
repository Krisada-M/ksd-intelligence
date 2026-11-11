# Provenance

## Adapted code

| Source | What was adapted | Where |
|---|---|---|
| `ei-skill-router-prototype.zip` (owner's prototype, `~/workspace/private/_inputs/`, zip sha256 `bcce72726369c312f2b4bfdfc124917b0786da39b9b03dc3ec58b22b8be581f4`; package `@ksd/ei-skill-router-prototype` 0.1.0). Not an upstream project; no upstream commit or license applies. | `src/router.mjs` (workflow table, stages, high-risk additions) | `src/workflow/router.ts` |
| same | `src/catalog.mjs` (skill allowlist) | `src/workflow/catalog.ts` |
| same | `src/engine.mjs` (loader, symlink and size checks, frontmatter check, renderer) | `src/workflow/loader.ts`, `src/workflow/render.ts` |
| same | `src/cli.mjs`, `omp/extension.mjs`, `test/router.test.mjs` (8 test intents) | `src/adapters/cli/main.ts`, `src/adapters/omp/extension.ts`, `tests/workflow/*.test.ts` |

Rewritten in TypeScript with the changes listed in `docs/briefs/M0-foundation.md` (caller `type`, classifier fix, loader error codes, hash pinning).

## Referenced upstream skill sources (read at runtime, not copied)

No upstream `SKILL.md` content is stored in this repo. `skills.lock.json` pins the checkout state that `sources check --write` recorded on 2026-11-09 (the owner's local clones).

| Provider | Repo | Pinned commit | License |
|---|---|---|---|
| matt | https://github.com/mattpocock/skills.git | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | MIT (`LICENSE` in repo) |
| poteto | https://github.com/cursor/plugins.git (`pstack/`) | `6b0300214a09fd6029cfb7077043125758cd1fd2` | MIT, Copyright (c) 2026 Lauren Tan (`pstack/LICENSE`) |
| osmani | https://github.com/addyosmani/agent-skills.git | `301b02b12bff98e4688e6984af6556802322bbde` | MIT (`LICENSE` in repo) |

Use is personal and non-commercial.

## Merged code (M1c)

| Source | What was moved | Where |
|---|---|---|
| `https://github.com/Krisada-M/ksd-engineering` commit `73fc916` (v0.6.0, MIT, owner's own repository), path `plugins/engineering-proxy/` | Runtime and modules, file names unchanged: `index.js`, `config.js`, `policy.js`, `sdlc.js`, `change-scope.js`, `check-changed.js`, `review-verdict.js`, `eslint-rules/`, `src/*.ts` + committed `dist/`, `package.json`, `tsconfig.json`, `.npmignore` | `src/policy/` |
| same | `test/*.test.js`, `test/helpers/`, `test/eval/fixtures/` — unchanged except import paths (`../x.js` → `../../src/policy/x.js`, validate-release and CLI-script path fixes) | `tests/policy/` |
| same, path `docs/ACCEPTANCE.md` | acceptance notes | `docs/policy/ACCEPTANCE.md` |
| same, path `examples/` | `.engineering-proxy.json`, `eslint.config.mjs` | `examples/` |
| same, path `validate-release.js` | release validation (used by `tests/policy/release.test.js`) | `validate-release.js` |
| same, path `.omp-plugin/marketplace.json` | marketplace manifest shape; rewritten for `ksd-intelligence` 0.1.0, source `.` | `.omp-plugin/marketplace.json` |

Copied at `73fc916` without git history (the M1c no-commit rule blocks `git subtree add`, which creates commits). Frozen-contract proof: `tests/policy/contract.test.js` against snapshots generated from the same clone (`tests/policy/snapshots/`).
