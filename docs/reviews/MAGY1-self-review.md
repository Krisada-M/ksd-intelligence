# MAGY1 — Five independent self-review passes

**Date:** 2026-11-19. **Scope:** AGY local stdio MCP bridge in Draft PR #31. **Reviewer:** implementation author. This report separates source inspection and GitHub Actions evidence from an untested live AGY session.

## Pass 1/5 — Protocol correctness

**Examined:** `scripts/mcp/stdio.mjs` request parsing, JSON-RPC envelope, legacy `initialize` → `notifications/initialized` → `tools/list`, modern `server/discover` / version metadata, `tools/call`, and message format. **Found and fixed:** initially the legacy handshake failed to become initialized. Commit `8398273` records a `legacyHello` flag and requires the initialization notification. The integration suite tests both protocol versions, list/call, unsupported versions and malformed requests. **Residual risk:** manually implemented protocol subset, not an SDK; real AGY-specific negotiation and optional MCP features are NOT VERIFIED. Do not advertise full MCP compatibility.

## Pass 2/5 — Security and trust boundaries

**Examined:** `scripts/agy-mcp.mjs` and `scripts/mcp/tools.mjs` root selection and tool arguments. **Found and fixed:** the KSD core's workspace resolver may walk upward to an enclosing git/config root; simply checking `--root` as absolute was insufficient to constrain scope. Commit `c77c5b2` now requires `loadWorkspace(root).root === root`; a nested-root regression test was added in `66ca6af`. Inputs reject per-tool `root`, unknown keys, invalid target count/depth; tools cannot execute shell commands, write repository files or switch roots. Legacy/modern tool surfaces default to read-only; `ei_workflow` requires an explicit environment opt-in and vetted pinned source checkouts. Inbound JSON lines are limited to 1 MiB, concurrent calls to 8. **Residual risk:** any process that has explicit OS permissions can access data under its authorized repository; start the MCP process only for trusted workspaces and avoid sharing AGY configs with secrets. The tools rely on KSD Core's existing scope/secret exclusions.

## Pass 3/5 — macOS/Linux and OMP compatibility

**Examined:** PR diff, KSD `package.json`, existing CLI, runtime and OMP boundary. No modification to `src/adapters/omp/**`, `src/policy/**`, `src/core/**`, `dist/**` or existing golden oracle. The MCP scripts import the already-built Core ESM modules, requiring Node >=22.5 (CI uses Node 24). No native package or extra runtime dependency. Existing macOS/Linux CI is the cross-platform test gate. **Residual risk:** CI covers its runner OS/architecture only, not a real AGY IDE/CLI, every Linux distro, every Mac architecture or the owner's local OMP installation. Native AGY LIVE: NOT VERIFIED.

## Pass 4/5 — Cancellation and resilience

**Examined:** stdio lifecycle, request concurrency map, partial frame accumulation, input end, abort handler, `ImpactSession` usage. MCP cancellation propagates an AbortSignal to KSD's existing impact query; the adapter suppresses final tool replies on cancellation. Unexpected tool exceptions become bounded `isError` results; protocol errors never terminate the server. Temporary formatting workflow was used to run the pinned repository Prettier version, then removed before final review. Tests exercise cancellation, 1MiB frames, malformed JSON and disabled tool listing. **Residual risk:** a malicious client could generate many small `tools/list` requests because only concurrent calls are capped; local stdio and trusted-client precondition limit exposure. The MCP transport has no standalone daemon/HTTP port.

## Pass 5/5 — Release readiness and evidence

**Examined:** owner authorization exception in `AGENTS.md`, D48/MAGY1 notes, explicit-root invocation guide and config sample, PR diff, tests and CI. Repeated failures on the first CI attempt were **format-only** at `scripts/mcp/stdio.mjs`, `scripts/mcp/tools.mjs` and `tests/packaging/agy-mcp.test.js`; these files were formatted using the pinned Prettier in a temporary GitHub workflow, and the workflow was removed from the final PR branch. Functional acceptance is tied to a **green CI run on the last PR head commit**, not earlier intermediate runs. The PR intentionally remains Draft and unmerged. **LIVE AGY on macOS/Linux: NOT VERIFIED** until a client can list tools and run a real impact query against an indexed workspace.

## Evidence and merge hold

- Pull request: https://github.com/Krisada-M/ksd-intelligence/pull/31
- Baseline CI first run: https://github.com/Krisada-M/ksd-intelligence/actions/runs/44448617093 — FAILED formatting on both OS families, correctly not reported as pass.
- Temporary Prettier job: https://github.com/Krisada-M/ksd-intelligence/actions/runs/44449516038 — SUCCESS; its workflow file was removed after formatted source was committed.
- Final macOS/Linux CI: **PENDING at report creation**; update this line with the exact head-run evidence when completed.
- Real AGY IDE/CLI integration:
  - **Linux x64 (`antigravity-cli` snap, language server `1.4.12`, Node `24.21.0`, 2026-11-22): `VERIFIED`** — Live AGY session discovered `ksd-intelligence` (`ei_status`, `ei_impact`, `ei_workflow`) from `mcp_config.json`, loaded the `ksd-intelligence` skill, executed `ei_status` (detected stale index after build), executed `ei_impact` on `src/core/impact/session.ts#ImpactSession` (incrementally updated index across 410 files, returned 7 direct / 12 total callers and 2 unresolved-name-match gaps), executed `ei_workflow` (loaded pinned skills from `/home/mezn/ei-skill-sources/{matt,cursor-plugins,osmani}`), and confirmed `ei_status` returned `STATUS ready` on schema 4.
  - **macOS live AGY IDE/CLI: `NOT VERIFIED`**.
- Merge gate: owner review + CI success, no merge/release/version bump until explicitly approved.
