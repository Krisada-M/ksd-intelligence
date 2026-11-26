# Changelog

## 1.1.0 — UI polish

- Added compact result trees for terminal commands and expandable OMP tool results. Non-interactive, `--plain`, and JSON output retain their existing formats.
- Added a measured terminal HUD for `ei index`, `ei setup`, and `ei doctor`, plus themed KSD status in OMP. Neither affects engineering decisions or policy.
- Added opt-in Markdown for AGY via `KSD_MCP_MARKDOWN=1`. Default MCP text is unchanged. The opt-in changes the text the model reads; it is not a separate display channel.

## 1.0.0 — release candidate

- **M0/M1 — workflow:** ported the staged skill router to TypeScript. Owner-provided task type overrides keyword guesses. Pin skill provenance by commit and SHA-256; fail closed on unavailable or modified inputs (D05, M1).
- **M1c/M1d — OMP:** merged Engineering Proxy 0.6.0 without changing its policy or commands. One marketplace installation; checked-in `dist/` and macOS/Linux CI (#6, #12, #13; D39–D41).
- **M1b/M2a — index:** built-in SQLite, pinned TypeScript from `ei setup`, `ei init`, `ei index`, `ei_status`, and deep differential doctor. Child-process isolation, private cache, atomic publish, and conservative incremental updates (#8–#11, #17–#20; D43–D52).
- **M2b — impact:** compiler-grade callers with provenance, tests, gaps, reach, and one advisory verdict. Owner golden cases and regression checks protect stale and false-low results (#24–#30, #32; D54–D59).
- **MAGY1 and unified skills:** local fixed-root AGY MCP stdio bridge and optional workflow, shared skill packs, and owner-controlled local skill updates (#31, #33).
- **M2c/M6a — review and discovery:** risk zones, `ei_changes`, `ei audit`, `ei cache clear`, workflow stage guidance, and SQLite FTS5 `ei_search` (#34; D58, D60, D62). Includes schema 6 index rebuild handling.
- **M3 and remaining scope:** dogfood decisions recorded (D63). Framework route detectors skipped; manual route globs work (D61). Heuristic bridges, watcher/worktree seeding, embeddings, and V2 modules are not shipped (D63/D64; #35).
- **Packaging and close-out:** scoped `@krisada-m/ksd-intelligence` npm delivery for CLI/AGY, separate OMP marketplace delivery, matching tag and npm trusted publishing checks (#36; D65). All installed bins accept `--help`; freeze policy implementation, golden inputs, and accepted snapshots. See the [release checklist](docs/release-checklist.md) for live-host and publication gates.
