# UI polish self-review

## Round 0 — baseline

1. Agent-facing text, golden cases, and snapshots: unchanged. Round 0 adds research records only; no tests or product code change.
2. Completeness, reach, factors, and verdict: no new return values and no changes to analysis. The presentation boundary must copy these facts, not calculate replacements.
3. Disabled/default compatibility: no new mode in Round 0. Existing V1 text and output modes remain; implementation rounds must add byte-identity tests for the surfaces they touch.
4. Runtime side effects: no library networking, command execution, or repository writes added. The AGY probe used one narrowly scoped read tool in a disposable workspace; no host configuration changed.
5. Diff hygiene: the records use repository-relative links and public package names; no credentials, absolute personal paths, or event identifiers are recorded.

Gates at the tagged base, with research records only: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (742 passed, 0 failed), `npm run check:dist`, and `node --test tests/packaging/npm-tarball.test.js` (1 passed). No package or dist changes.

## Round 1 — CLI tree and HUD

1. Agent-facing text, golden cases, and snapshots: no changes. The new CLI test compares plain, `--plain`, `NO_COLOR`, and `--json` bytes with and without `FORCE_COLOR`. OMP and AGY adapters are untouched.
2. Completeness, reach, factors, and verdict: the renderer reads existing outcomes. HUD counts and timing do not reach the graph, query results, or verdicts. Indeterminate phases do not get fabricated percentages.
3. Compatibility: the no-style CLI retains original formatters and progress. Styled output selects a separate view; JSON does not go through it. UI polish is D68, not a V2 module.
4. Side effects: the engine's successful-publish path records private bounded history in its cache. Failed and unchanged builds and temporary doctor rebuilds do not record runs. No new network calls, subprocess actions, or worktree writes are in library code.
5. Diff hygiene: no secrets or absolute personal paths. A delegated edit first landed in the shared checkout; its exact changes were migrated and removed there. The shared checkout was clean afterward.

`npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (764 passed), and `node --test tests/packaging/npm-tarball.test.js` (1 passed) passed. A real 80-column `script` pseudo-terminal captured cursor hide/restore and `◆ index built  cold · 27 files · 0.66s` on a disposable fixture. `npm run check:dist` passed after commit `bf683836ec`.

## Round 2 — OMP and KSD display

1. Agent-facing text, golden cases, and snapshots: unchanged. The OMP test renders the actual adapter's result in collapsed and expanded modes and compares the existing content bytes. The D68 policy assertions change only exact themed strings; no behavior assertions or snapshots changed. `ui-polish.md` lists the protected-path presentation changes.
2. Completeness, reach, factors, and verdict: the OMP renderer reads existing results. The only additional impact data is the existing batch index metadata in the first details item. Rendering does not feed engine decisions. Legacy and progress results use a partial fallback without inventing verdicts.
3. Compatibility: JSON/content and the unstyled policy strings stay unchanged. Tests compare styled strings with the original after removing styling and verify notification severity.
4. Side effects: no new network, execution, or repository writes. The OMP launch used the locally built extension in a disposable workspace without changing host configuration.
5. Diff hygiene: no secrets or personal paths. The missing isolated login was not worked around by copying credentials or weakening `write` approval.

`npm ci`, `node_modules/.bin/tsc -p src/policy/tsconfig.json`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (769 passed), and `node --test tests/packaging/npm-tarball.test.js` (1 passed) passed. Live `omp/19.2.1` in a real 80-column pseudo-terminal showed the collapsed `ei_status` header, expanded tree after `Ctrl+O`, KSD status segment, and `/engineering-proxy status` notice. The four-tool collapse/expand and byte-identity fixture is MOCK-ONLY; live execution covered `ei_status`.

**Hard stop:** `EI_EVAL_MODEL=openai-codex/gpt-6.2-sol node evals/run.mjs` exited 2. `desktop-status` exited 1 before tool execution (`model unavailable`); all 10 cases were unscored. An isolated OMP preflight reported `No API key`. No authorized `EI_EVAL_HOME` was configured. Use the dedicated Codex login procedure in `docs/release-checklist.md`; do not change the evaluator, copy tokens, or advance to Round 3 before clearing the gate.
