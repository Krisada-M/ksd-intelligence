# Antigravity (AGY) — local MCP integration

**Status:** MCP stdio adapter merged to `main`. Earlier schema 4 build: live AGY on Linux **VERIFIED** ([MAGY1 record](../reviews/MAGY1-self-review.md)). Live AGY on the 1.0.0 candidate and live AGY on macOS are **NOT VERIFIED**. This adapter does not transfer OMP policy, commands or approvals into Antigravity.

## Architecture

AGY (MCP client) -> local `node scripts/agy-mcp.mjs --root <path> [--workflow]` (or `node dist/adapters/cli/main.js mcp --root <path> [--workflow]`) -> KSD compiled Core (`dist/core`, `dist/workflow`) -> per-repository SQLite index. OMP's extension remains unchanged. No TCP server, credentials or network activity are required by the MCP process.

The AGY MCP configuration defines a **fixed absolute repository root**. Tool arguments cannot change it. Each repository needs its own server instance/config entry; do not share a process between unrelated workspaces. An optional companion skill template is provided at `docs/examples/antigravity-skill-ksd-intelligence/SKILL.md` to guide Antigravity agents on calling `ei_status` / `ei_impact` / `ei_workflow` and falling back to the `ei` CLI for multi-repository indexing and queries.

## Prerequisites

- Node.js >= 22.5 and the npm install above, or a built KSD checkout (`npm ci && npm run build`).
- A workspace with TS/JS source and an optional `ei.config.json`.
- For `ei_impact` to build an index, provision the pinned TypeScript runtime once using `node dist/adapters/cli/main.js setup` (owner-run; this can use the network), or opt in to a workspace TypeScript copy in KSD config. Runtime failures are returned as error text, not treated as complete analysis.
- Antigravity App, IDE or CLI with custom local stdio MCP support. Follow the official documentation at https://antigravity.google/docs/mcp.

## Install without cloning (npm)

```sh
npm install -g @krisada-m/ksd-intelligence
ei setup
```

Then point AGY at `ei mcp` (config below). `ei setup` is the only step that uses the network. Update with `npm update -g @krisada-m/ksd-intelligence`. Registry installs never run the repository's `prepare` hook (D65).

## Workspace MCP configuration

In Antigravity IDE: open the agent panel's MCP Servers menu -> Manage MCP Servers -> View raw config. Its per-project location is `<workspace>/.agents/mcp_config.json`; global is `~/.gemini/config/mcp_config.json`. Use `ei` from the npm install above, or, from a checkout, `"command": "node"` with `"args": ["/ABS/PATH/ksd-intelligence/scripts/agy-mcp.mjs", "--root", "/ABS/PATH/my-project"]` (example at `docs/examples/antigravity-mcp_config.json`). The root must be **absolute**:

```json
{
  "mcpServers": {
    "ksd-intelligence": {
      "command": "ei",
      "args": ["mcp", "--root", "/ABS/PATH/my-project"],
      "enabledTools": ["ei_status", "ei_impact", "ei_changes", "ei_search"],
      "timeoutSeconds": 180
    }
  }
}
```

Avoid relying on the IDE's process working directory: it may be different from the repository. Restart or reload MCP in AGY after updating the config. `ei_status` reports degraded when the runtime/index is not ready; it does not build the index. `ei_impact` can trigger the normal bounded KSD index update and will report uncertainty when evidence is incomplete.

Default MCP text is unchanged. The experimental `KSD_MCP_MARKDOWN=1` server environment option changes the text sent to the model for `ei_status`, `ei_impact`, `ei_changes`, and `ei_search`. Leave it unset for the original format. Live host and model acceptance are not yet verified for this option.

## Tools

| Name | Availability | Behavior |
|---|---|---|
| `ei_status` | Default | Read-only index status and setup guidance |
| `ei_impact` | Default | Same core query and evidence-based rendering used in OMP |
| `ei_changes` | Default | Changed-code review (M2c) |
| `ei_search` | Default | Lexical declaration search (M6a) |
| `ei_workflow` | **Opt-in only** via `KSD_MCP_WORKFLOW=1` in the server's `env` | Loads strictly pinned local SKILL.md sources; no scripts are executed |

For `ei_workflow`, configure the reviewed `EI_MATT_ROOT`, `EI_POTETO_ROOT`, and `EI_OSMANI_ROOT` environment variables for the local checkouts. Pass `potetoMode: true` only when the user explicitly opts into deep multi-phase mode; `poteto-mode` is never enabled automatically. Do not enable a second automatic upstream skills router; KSD stays the primary orchestrator. Pinned skills can still contain untrusted instructions.

For native AGY skill discovery of KSD's platform-agnostic skill catalog (`skills/`), see `docs/integrations/skills-catalog.md` and `docs/examples/antigravity-skills.json`.

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
