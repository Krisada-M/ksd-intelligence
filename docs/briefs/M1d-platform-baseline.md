# M1d — macOS/Linux platform baseline (agent brief)

**Status:** accepted as a milestone with D48 (2026-11-12). CI part delivered in PR #12: at its head commit the matrix passed 224/224 tests on `darwin arm64` and `linux x64` (Node 24.22.2). Live OMP smoke per OS (see Acceptance) is still open, so M1d is not complete.

Read `AGENTS.md`, `docs/DESIGN.md` §§10.1, 13–14, `docs/research/m1b-runtime-facts.md`, and `docs/briefs/M2a-index.md`. Work only on the platform baseline; **do not implement M2a or modify `src/policy/**`**.

## Purpose and support contract

- Target: one implementation working on **macOS** and **Linux**, not separate engines per OS.
- Initial CI evidence: GitHub-hosted `macos-latest` and `ubuntu-latest` using Node 24. Record `process.platform`, `process.arch`, OS release, Node version. A runner exercises only the architecture it reports.
- The package entry still declares Node >= 20 for existing CLI/build interfaces. The *future engine* follows D45: Node >= 22.5 when available, otherwise OMP's Bun. Do not silently tighten `package.json#engines` to Node 24 as a shortcut.
- CI success is **not** a claim of native OMP support, Node 20 compatibility, or working M2a indexing. Full supported-OS status needs real OMP smoke and engine tests once implemented.
- No new runtime dependencies or platform-specific binaries. Keep offline library code, existing policy contract, and the shipped `dist/` unchanged.

## Implementation scope

1. Add `.github/workflows/ci.yml` on PRs and pushes to `main` with minimal permissions. Matrix: `ubuntu-latest`, `macos-latest`; Node 24, `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:dist`. Record OS and CPU architecture. Keep failure visible; no conditional skips.
2. Reproduce any macOS temporary-path mismatch before changing code. The fixture already returns canonical `realpath`; only fix a reproducible regression, and never change the loader to return a noncanonical path.
3. Ensure tests do not depend on shell-specific path delimiters, case-insensitive filesystems, GNU-only utilities, or unaccounted process semantics. If a case can only be covered manually, document it without claiming a pass.
4. After M2a lands, extend the same matrix with real index/SQLite/child-process tests; keep the engine isolated from the host and enforce resource limits on both runtimes.

## Acceptance

- CI checks on both OS families are green at the *PR head commit*, with workflow run links and runner OS/architecture recorded.
- No source, snapshot or golden test is weakened solely to obtain green status.
- `npm run check:dist` is green; this PR does not change the plugin runtime or `dist/`.
- A live OMP `ei_workflow` + policy smoke has been recorded on both macOS and Linux, or explicitly marked **NOT VERIFIED** and full cross-platform compatibility is not claimed. Existing evidence: Linux (WSL2) was covered by M1 and M1c on OMP 18.18.8, before the changes in #7–#9; macOS has only the M1b probe extension, not `ei_workflow` or the policy module. So macOS is the missing run, and Linux should be re-run on the current `main`.
- Report with the `AGENTS.md` template and stop. M2a is separately gated by its own host, SQLite, index correctness and memory tests.

## Risks and deferred work

- Hosted runners do not cover every macOS/Linux CPU architecture or local OMP installation path.
- `node:sqlite` and engine child-process behavior were probed on the owner's macOS only in M1b. Linux evidence must come from tests after those components are built.
- File watching (M5) must not become the source of truth for index freshness. Semantic search (M6b), MCP adapter, Docker distribution and Windows are not part of this milestone.
