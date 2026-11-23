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


## 2026-11-22 — ksd-intelligence — Verify M6a Iteration 4 candidate (`7426969`) through the installed OMP extension in a clean clone
Tools called: ei_impact(`src/core/search/lexical.ts#querySearch`) · ei_changes(base `3ce2a4d`)
Correct? yes — `ei_impact` reported reach 2 direct / 11 total, 5 test files, `picture complete`, `Gaps: none`, matching the touched surface (test-only commit); `ei_changes` reported 1 modified symbol (`search-query.test.ts`), the two markdown records as `outside-index-scope`, and the harness `node_modules` symlink as `symbolic link; not followed`, with `completeness=partial` / `verdict=unknown` instead of claiming full coverage
Changed what the agent did? yes — replaced a manual `git diff --stat` review with a census that names every unanalysed path and reason, so the report could not silently drop the docs from review scope
Latency felt: fine (cold index build + `ei_impact` `5.01 s` in the fresh clone; warm `ei_changes` `427 ms`; whole clean-clone run `9.2 s` wall)
Verdict given: census `partial`/`unknown` with 3 gap sites — honest boundary for a test-only change whose docs sit outside `impact.include`
Missing: run was harness-driven (`bun` + installed OMP extension loader in an isolated `HOME`), not an interactive agent session; two earlier harness iterations mis-asserted the symlink gap before the engine output was accepted as correct (harness bug, not an engine defect)

## 2026-11-23 — ksd-intelligence (disposable clone) — Rename rehearsal: rename `pathTokens` before touching callers
Tools called: ei_impact(`src/core/search/segments.ts#pathTokens`) · ei_changes
Correct? yes — impact before the edit: `2` direct / `36` total, `medium`/`run-tests`, picture complete, 21 test files; after renaming in `src/`, `ei_changes` reported `Removed, still used (2)` (`pathTokens`, `SearchRow.pathTokens`) with the `tests/core/search-index.test.ts` break flagged as `UNRESOLVED_IMPORT`/`UNRESOLVED_NAME_MATCH`, plus `Modified (2)` and `Added (2)` — every rename surface named
Changed what the agent did? yes — the census named the broken test import before anything was run, so the rename could not be reported done without fixing it
Latency felt: fine (whole task `7.2 s` wall incl. cold index; warm impact `~1.2 s`)
Verdict given: `medium`/`run-tests` before, `unknown`/`check-gaps` after — right calls for a rename that breaks an import
Missing: —

## 2026-11-23 — ksd-intelligence (disposable clone) — Deleted export: drop `capSearchText`
Tools called: ei_impact(`src/core/search/segments.ts#capSearchText`) · ei_changes
Correct? yes — impact first (`3` direct, complete); after deletion `ei_changes` caught both in-file callers left behind plus the test import break, with `unresolved-import`/`unresolved-name-match` gap reasons and `Tests to run (1)`
Changed what the agent did? yes — deletion stayed staged until the two leftover call sites were fixed
Latency felt: fine (impact incl. index update `~1 s`)
Verdict given: `unknown`/`check-gaps` — right; the picture was genuinely incomplete until callers were resolved
Missing: —

## 2026-11-23 — ksd-intelligence (disposable clone) — Type-only widening: `mapCandidateRow(row: object)`
Tools called: ei_impact(`src/core/search/lexical.ts#mapCandidateRow`) · ei_changes
Correct? yes — `ei_changes` classified the annotation-only edit as `Signature changed, still called` with both `REFERENCES` callers (`querySearch`, `readCandidates`) and `medium`/`run-tests`, picture complete — the D59 signature semantics working on a real type-only change
Changed what the agent did? no — rehearsal task; the caller list is what a real change would have used
Latency felt: fine (block of 3 tasks `9.5 s` wall incl. one index update)
Verdict given: `medium`/`run-tests` — right for a signature change still called by two sites
Missing: —

## 2026-11-23 — ksd-intelligence (disposable clone) — Three-file comment-only edit, then immediate `ei_changes`
Tools called: ei_changes
Correct? yes — `3 files, 0 symbols`, `low`/`proceed`, picture complete; measured warm call `160 ms` right after the edits (index updated on demand)
Changed what the agent did? yes — the `low`/`proceed` let the edit ship without a test detour
Latency felt: fine (`160 ms`)
Verdict given: `low`/`proceed` — right
Missing: `Tests to run (1): tests/core/glob.test.ts` was listed for a comment-only touch of `src/core/kernel/glob.ts` — harmless but slightly over-listed

## 2026-11-23 — ksd-intelligence (disposable clone) — Impact of a name defined in an untracked root file
Tools called: ei_impact(`orphanHelper`)
Correct? yes (honest boundary) — `NOT FOUND orphanHelper` with closest name `src/core/engine/status.ts#Coverage.orphan`; the untracked root file is never indexed, and the tool said so instead of guessing
Changed what the agent did? yes — stopped assuming the helper was unused; inspected the file by hand instead
Latency felt: fine (`3.2 s` incl. on-demand index update absorbing the new file)
Verdict given: `NOT FOUND` — right
Missing: wish it mentioned that the name lives in an untracked/orphan file (it only offers closest names)

## 2026-11-23 — ksd-intelligence (git worktree) — Status from a linked worktree root
Tools called: ei_status(`--root .` inside `git worktree`)
Correct? partly — the worktree got its own empty cache: `STATUS degraded (no index)` with config/runtime resolved correctly; honest, but it did not reuse or point at the main worktree's index, so a cold re-index would be needed there
Changed what the agent did? yes — avoided assuming the worktree shared the main index
Latency felt: fine (status instant)
Verdict given: degraded — honest
Missing: share or resume the main worktree's index, or label the state `worktree: separate cache`

## 2026-11-23 — work-sure — Find the desktop status-rendering code, then check who depends on it
Tools called: ei_search(`status error message render`) · ei_impact(`desktop/src/status.ts#serverErrorMessage`, depth 2)
Correct? yes — search (`164 ms`) surfaced `serverErrorMessage` plus the three renderers (`setStatus`, `renderRemembered`, `renderServers`); impact (`175 ms`) gave `3` direct + `2` depth-2 callers, gaps none, `Next: make your change and call ei_changes before you report done`
Changed what the agent did? yes — replaced grep + manual caller scanning; the footer's next-step kept the workflow honest
Latency felt: fine (index update `2.3 s`, then `164 ms` / `175 ms`)
Verdict given: `low`/`proceed` — right for desktop-internal callers with zero tests (tests: none was stated plainly)
Missing: —

## 2026-11-23 — work-sure — Weekly health check: audit, clean-tree changes, status
Tools called: ei_audit(`--since 7d`) · ei_changes · ei_status
Correct? yes — audit listed the session's 2 calls (`100.5 ms` impact, `96.9 ms` search) and `Changed without prior ei_impact: none`; `ei_changes` on the clean tree reported `nothing changed` (`144 ms`); status honestly showed `8,434` scanned / `5` indexable / `15` orphan / `8,414` unindexed with reasons and `721` unresolved name matches
Changed what the agent did? yes — confirmed the leading indicator (impact before edit) without hand-collection
Latency felt: fine (`72 ms` / `144 ms`)
Verdict given: n/a (health check)
Missing: `721` unresolved name matches on a mostly-Rails repo reads as noise — wants a per-reason summary or quiet mode
