# MAGY1 — owner-directed Antigravity MCP bridge

**Owner authorization:** 2026-11-19. **Status:** Independent scoped integration milestone, PR review required before acceptance.

## Motivation

Google Antigravity uses MCP for local tool servers. KSD already has a TypeScript-based index and an OMP extension. Reusing the **same core** through a small local stdio adapter makes `ei_status` and `ei_impact` available to AGY without copying the engine or loading OMP policy hooks into a foreign host.

## Boundaries

- Add a local `stdio` MCP server entry in `scripts/agy-mcp.mjs`, implemented under `scripts/mcp/` as zero-dependency ESM scripts importing KSD's already-built `dist/core` modules. The scripts are the thin executable transport layer; all analysis remains in KSD Core.
- Require an explicit, existing, absolute repository root at process launch. No per-tool workspace switching.
- Implement MCP legacy and modern lifecycle, `tools/list`, `tools/call`, cancellation, bounded framing/parallelism and failures without stdout logging.
- Default tools `ei_status`, `ei_impact`. The pinned `ei_workflow` reader is optional behind `KSD_MCP_WORKFLOW=1`; no automatic skill router or script execution.
- Do not change `src/policy/**`, `src/adapters/omp/**`, `tests/golden/**` or package runtime dependencies. Do not install AGY, merge, tag or deploy.
- Antigravity-native Skills/Plugin packaging and forwarding Engineering Policy are explicitly out of scope.

## Acceptance gates

1. Unit/protocol tests cover a 2025 initialize exchange and a 2026 discover exchange, deterministic read-only tool schema, invalid/cross-root input, disabled tools, frame bounds and cancellation.
2. Existing `npm test`, lint, typecheck and dist drift checks pass on macOS and Linux CI, at the head commit.
3. README + AGY configuration instructions and an editable example are correct for currently documented AGY config paths.
4. The existing OMP adapter, KSD policy behavior and index schema are unchanged (regression check).
5. **Live host acceptance is separate:** test AGY IDE or CLI on macOS and Linux with actual repository index; never label this PASS from a fake client or mocked transport.

## Decisions and residual risks

No new runtime dependencies (repository rule). Thus this bridge implements a limited, testable MCP subset rather than claiming the complete MCP SDK feature set. MCP protocol evolution, client-specific configuration changes and AGY permission policy remain outside the adapter's control. The explicit root, read-only tool surface, local process and opt-in workflow mitigate accidental cross-repo disclosure and duplicated routers.

Five post-implementation self-review passes must inspect: (1) protocol correctness, (2) security/trust, (3) platform and OMP compatibility, (4) reliability/cancellation, (5) release readiness and evidence. Findings and fixes belong in the PR report.
