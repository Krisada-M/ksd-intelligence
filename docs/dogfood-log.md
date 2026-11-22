# Dogfood log

## Wrong-`low` incidents (Contingency D)

| Date | Repository | Target | Missing dependent | Cause (layer) | Fix |
|---|---|---|---|---|---|
| 2026-11-17 | `ksd-intelligence` | `src/core/graph/graph.ts#Graph.incoming` | `tests/core/indexing.test.ts` (lines 24, 60, 72, 117, 118, 132) and `tests/core/differential.test.ts:253` | Two layers (D57): (1) `ei init` (`detectProjectLayout`) proposed `include: ["src/**"]` only when `src/` existed without `packages/`/`apps/`, leaving `tests/` (`tests/tsconfig.json`) outside `impact.include`; (2) D55 item 4 lexical name scan covered only `orphan` files (`no-tsconfig`), not `outside-index-scope` or owner-`excluded` code files. | (1) `detectProjectLayout` now includes `src/**`, `test/**`, `tests/**`, `__tests__/**`, `spec/**` when present plus every directory owned by a tsconfig in the repo, and `ei init` reports omitted tsconfig dirs; (2) lexical name scan now covers every visible out-of-scope code file (`no-tsconfig`, `outside-index-scope`, owner `excluded`) except secrets, symlinks, and default excludes (`node_modules`, `dist`, `.git`). |

## Daily-use tasks

## 2026-11-22 — work-sure — Assess blast radius of desktop/src/status.ts#serverErrorMessage and check app/javascript/utils/sankey_zoom.mjs#zoomSankeyData
Tools called: ei_status · ei_impact(desktop/src/status.ts#serverErrorMessage) · ei_impact(app/javascript/utils/sankey_zoom.mjs#zoomSankeyData)
Correct? partly — `serverErrorMessage` callers (`desktop/src/main.ts:40`, `desktop/src/prefs.ts:1,15`, depth 2 `main.ts:1,61`) matched TS `findReferences` 100%, but `sankey_zoom.mjs` returned `NOT INDEXED — outside-index-scope` (Rails `app/javascript/**` has no `jsconfig.json` and uses `config/importmap.rb` bare specifiers)
Changed what the agent did? yes — confirmed both `desktop/src/main.ts` and `desktop/src/prefs.ts` depend on `serverErrorMessage` (0 tests in `desktop/`) and prevented assuming `sankey_zoom.mjs` had zero web callers despite `outside-index-scope`
Latency felt: fine (no-drift warm `ImpactSession.query` p50 `66.1 ms` / p95 `75.5 ms`; cold CLI `ei impact` `171 ms` / `159 ms`; cold build median `2.14 s`)
Verdict given: `low`, `proceed` (`picture complete`) for `desktop/src/status.ts#serverErrorMessage` — right call for `desktop/src/`; `NOT INDEXED` for `app/javascript/utils/sankey_zoom.mjs` — honest boundary
Missing: `ei init --dry-run` `TS configs:` display missed `desktop/tsconfig.json` (`init.ts:196`), `desktop/node_modules` absent (`dependencies installed: no`), and `app/javascript/**` lacks `jsconfig.json` / Rails importmap resolution

