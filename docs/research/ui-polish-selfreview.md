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

`npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (764 passed), and `node --test tests/packaging/npm-tarball.test.js` (1 passed) passed. A real 80-column `script` pseudo-terminal captured cursor hide/restore and `◆ index built  cold · 27 files · 0.66s` on a disposable fixture. Run `npm run check:dist` after committing the regenerated dist files.
