# Dogfood log

## Wrong-`low` incidents (Contingency D)

| Date | Repository | Target | Missing dependent | Cause (layer) | Fix |
|---|---|---|---|---|---|
| 2026-11-17 | `ksd-intelligence` | `src/core/graph/graph.ts#Graph.incoming` | `tests/core/indexing.test.ts` (lines 24, 60, 72, 117, 118, 132) and `tests/core/differential.test.ts:253` | Two layers (D57): (1) `ei init` (`detectProjectLayout`) proposed `include: ["src/**"]` only when `src/` existed without `packages/`/`apps/`, leaving `tests/` (`tests/tsconfig.json`) outside `impact.include`; (2) D55 item 4 lexical name scan covered only `orphan` files (`no-tsconfig`), not `outside-index-scope` or owner-`excluded` code files. | (1) `detectProjectLayout` now includes `src/**`, `test/**`, `tests/**`, `__tests__/**`, `spec/**` when present plus every directory owned by a tsconfig in the repo, and `ei init` reports omitted tsconfig dirs; (2) lexical name scan now covers every visible out-of-scope code file (`no-tsconfig`, `outside-index-scope`, owner `excluded`) except secrets, symlinks, and default excludes (`node_modules`, `dist`, `.git`). |
