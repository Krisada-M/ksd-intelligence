---
name: ksd-intelligence
description: Evidence-backed TypeScript/JavaScript code intelligence (ei_status, ei_impact, ei_workflow, and ei CLI) for blast-radius analysis, caller tracing, and pinned skill routing in Antigravity (AGY).
---

# KSD Engineering Intelligence (`ksd-intelligence`) — Antigravity Skill Template

Use `ksd-intelligence` before editing TypeScript or JavaScript symbols to inspect blast radius, callers, confidence, and analysis gaps, or to route tasks through the pinned KSD workflow catalog (`matt-sdlc`, `pstack-analysis`, `osmani-quality`, and explicit opt-in `poteto-mode`).

## 1. MCP Tools (when `ksd-intelligence` MCP server is connected)

- `ei_status` (`{}`): Check index state (`ready` | `degraded` | `disabled`), schema version, indexed files/declarations/edges, and pinned TypeScript runtime status.
- `ei_impact` (`{ targets: ["SymbolName" | "path/to/file.ts#SymbolName" | "path/to/file.ts"], depth?: 1..10 }`):
  - Query 1–5 targets at once before modifying exported or shared TypeScript/JavaScript declarations.
  - Read `verdict`, `completeness`, `reach`, `factors`, `gaps`, and `next` in the output.
- `ei_workflow` (`{ task: "...", stage: "plan"|"investigate"|"implement"|"verify"|"review"|"ship", risk?: "normal"|"high", type?: "bug"|"feature"|"refactor"|"security"|"performance"|"ui", potetoMode?: boolean }`):
  - Route a task to one primary workflow owner per stage from KSD's pinned `skills.lock.json` catalog.
  - Set `potetoMode: true` only when the user explicitly opts into deep multi-phase mode.

## 2. Portable CLI Fallback & Multi-Repository Usage (`ei` CLI)

Because the MCP stdio server binds to a single explicit `--root`, or when you need to initialize/rebuild an index on any workspace `<WORKSPACE_ROOT>`, invoke the compiled CLI directly with Node >= 22.5 (replace `<KSD_ROOT>` and `<SKILL_SOURCES_ROOT>` with your local checkout paths):

```bash
KSD_CLI="<KSD_ROOT>/dist/adapters/cli/main.js"

# 1. Check status of a workspace
node "$KSD_CLI" status --root "<WORKSPACE_ROOT>"

# 2. Initialize ei.config.json (first time only)
node "$KSD_CLI" init --root "<WORKSPACE_ROOT>"

# 3. Build or incrementally update the index
node "$KSD_CLI" index --root "<WORKSPACE_ROOT>"

# 4. Run blast-radius / caller impact analysis (1-5 targets, depth 1-10)
node "$KSD_CLI" impact <target1> [target2...] --depth 2 --root "<WORKSPACE_ROOT>"

# 5. Deep doctor verification (cold rebuild diff + differential check against ts.LanguageService)
node "$KSD_CLI" doctor --deep --differential 100 --root "<WORKSPACE_ROOT>"

# 6. Route or load pinned workflow skills
EI_MATT_ROOT="<SKILL_SOURCES_ROOT>/matt" \
EI_POTETO_ROOT="<SKILL_SOURCES_ROOT>/cursor-plugins" \
EI_OSMANI_ROOT="<SKILL_SOURCES_ROOT>/osmani" \
node "$KSD_CLI" load --task "<task description>" --stage investigate --risk normal

# 7. Audit KSD skill catalog discovery for AGY
node "$KSD_CLI" skills check --platform agy
```

## 3. Non-Negotiable Evidence Rules

1. **Zero callers never proves "safe" or "low risk" on its own.** Always inspect `completeness`, `gaps`, and `factors`.
2. **Treat `unknown` or `partial` completeness as incomplete static evidence.** Follow up with targeted text search and manual inspection of cited gap sites before editing.
3. **Skills are instructions, not executors.** Never execute scripts from upstream skill directories; host and owner rules always outrank skill text.
