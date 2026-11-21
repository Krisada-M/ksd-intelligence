# Antigravity (AGY) — local MCP integration

**Status:** MCP stdio adapter implemented on the feature branch; native AGY IDE/CLI runtime **NOT VERIFIED**. This adapter does not transfer KSD's OMP policy injection, slash commands, approval rules or model routing into Antigravity.

## Architecture

AGY (MCP client) -> local `node scripts/agy-mcp.mjs --root <path> [--workflow]` (or `node dist/adapters/cli/main.js mcp --root <path> [--workflow]`) -> KSD compiled Core (`dist/core`, `dist/workflow`) -> per-repository SQLite index. OMP's extension remains unchanged. No TCP server, credentials or network activity are required by the MCP process.

The AGY MCP configuration defines a **fixed absolute repository root**. Tool arguments cannot change it. Each repository needs its own server instance/config entry; do not share a process between unrelated workspaces. An optional companion skill template is provided at `docs/examples/antigravity-skill-ksd-intelligence/SKILL.md` to guide Antigravity agents on calling `ei_status` / `ei_impact` / `ei_workflow` and falling back to the `ei` CLI for multi-repository indexing and queries.

## Prerequisites

- Node.js >= 22.5 and a built KSD checkout (`npm ci && npm run build`).
- A workspace with TS/JS source and an optional `ei.config.json`.
- For `ei_impact` to build an index, provision the pinned TypeScript runtime once using `node dist/adapters/cli/main.js setup` (owner-run; this can use the network), or opt in to a workspace TypeScript copy in KSD config. Runtime failures are returned as error text, not treated as complete analysis.
- Antigravity App, IDE or CLI with custom local stdio MCP support. Follow the official documentation at https://antigravity.google/docs/mcp.

## Workspace MCP configuration

In Antigravity IDE: open the agent panel's MCP Servers menu -> Manage MCP Servers -> View raw config. Its per-project location is `<workspace>/.agents/mcp_config.json`; global is `~/.gemini/config/mcp_config.json`. Copy the example at `docs/examples/antigravity-mcp_config.json` and replace both **absolute** placeholder paths:

```json
{
  "mcpServers": {
    "ksd-intelligence": {
      "command": "node",
      "args": ["/ABS/PATH/ksd-intelligence/scripts/agy-mcp.mjs", "--root", "/ABS/PATH/my-project"],
      "enabledTools": ["ei_status", "ei_impact"],
      "timeoutSeconds": 180
    }
  }
}
```

Avoid relying on the IDE's process working directory: it may be different from the repository. Restart or reload MCP in AGY after updating the config. `ei_status` reports degraded when the runtime/index is not ready; it does not build the index. `ei_impact` can trigger the normal bounded KSD index update and will report uncertainty when evidence is incomplete.

## Tools

| Name | Availability | Behavior |
|---|---|---|
| `ei_status` | Default | Read-only index status and setup guidance |
| `ei_impact` | Default | Same core query and evidence-based rendering used in OMP |
| `ei_workflow` | **Opt-in only** via `KSD_MCP_WORKFLOW=1` in the server's `env` | Loads strictly pinned local SKILL.md sources; no scripts are executed |

For `ei_workflow`, configure the reviewed `EI_MATT_ROOT`, `EI_POTETO_ROOT`, and `EI_OSMANI_ROOT` environment variables for the local checkouts. Do not enable a second automatic upstream skills router; this MCP tool is a user/agent-called reader, **not** Antigravity native skills provisioning. Pinned skills can still contain untrusted instructions.

`EI_DISABLED=1` hides all `ei_*` MCP tools. Unlike the OMP extension, the MCP process never installs KSD policy hooks or changes an AGY session.

## Protocol and failure boundaries

- Local stdio newline-delimited JSON-RPC only; stdout is exclusively protocol messages. Maximum input frame 1 MiB and eight concurrent calls.
- Supports MCP `2025-11-25` (`initialize` / `notifications/initialized`) and `2026-07-28` (`server/discover`, per-request version metadata, `resultType` and private zero-TTL tool list). The official spec is https://modelcontextprotocol.io/specification/2026-07-28.
- Cancellation aborts in-flight KSD calls; the server does not emit a final result after cancellation.
- Unexpected failures are returned as `isError: true` tool results; wrong tool names, invalid JSON-RPC and unsupported versions are bounded protocol errors.
- The adapter does not accept a root path from tool arguments, expose shell execution, expose a write tool, touch production systems or bypass KSD's existing index limits.

## Verification checklist (not automatic acceptance)

1. Run `npm test`, `npm run lint` and `npm run check:dist` on macOS and Linux. CI tests the transport and KSD engine on its runner architecture, not a real AGY host.
2. In **real AGY** on each target OS family, configure exactly one workspace root, verify connected status and discover `ei_status` / `ei_impact`.
3. Call `ei_status`, `ei_impact` on a known symbol, then edit a file and rerun; compare results with the KSD CLI/OMP on the same root and index generation.
4. Confirm disabled tools and malformed requests do not expose data or crash AGY. Confirm the old OMP policy and `ei_workflow` are unchanged.
5. Record exact AGY version, Node version, OS/arch, raw tool responses, and any missing permission prompts. Until these steps are performed, classify **AGY LIVE: NOT VERIFIED**.

AGY's native Plugin packaging and Skill packaging are intentionally separate milestones; this PR implements local MCP tools, not a full installable AGY plugin.
