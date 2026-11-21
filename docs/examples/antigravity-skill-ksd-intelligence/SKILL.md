---
name: ksd-intelligence
description: Evidence-backed TypeScript/JavaScript code intelligence (ei_status, ei_impact, ei_workflow, and ei CLI) for blast-radius analysis, caller tracing, and pinned skill routing in Antigravity (AGY).
---

# KSD Engineering Intelligence (`ksd-intelligence`) — Antigravity Skill

Use `ksd-intelligence` before editing TypeScript or JavaScript symbols to inspect blast radius, callers, confidence, and analysis gaps, or to route tasks through the pinned workflow catalog.

## 1. MCP Tools (when `ksd-intelligence` MCP server is connected)

- `ei_status` (`{}`): Check index state (`ready` | `degraded` | `disabled`), schema version, indexed files/declarations/edges, and pinned TypeScript runtime status.
- `ei_impact` (`{ targets: ["SymbolName" | "path/to/file.ts#SymbolName" | "path/to/file.ts"], depth?: 1..10 }`):
  - Query 1–5 targets at once before modifying exported or shared TypeScript/JavaScript declarations.
  - Read `risk`, `confidence` (`high` | `medium` | `low` | `unknown`), `reasons`, `gaps`, and `nextAction` in the output.
- `ei_workflow` (`{ task: "...", stage?: "plan"|"investigate"|"implement"|"verify"|"review"|"ship", risk?: "normal"|"high", type?: "bug"|"feature"|"refactor"|"security"|"performance"|"ui" }`):
  - Route a task to 0–3 allowlisted skills from the pinned `skills.lock.json` catalog.

## 2. CLI Fallback & Multi-Repository Usage (`ei` CLI)

Because the MCP stdio server binds to a single explicit `--root`, or when you need to initialize/rebuild an index on any workspace `<ROOT>`, invoke the compiled CLI directly with Node >= 22.5:

```bash
export HOME=/home/mezn
export PATH="/home/mezn/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
KSD_CLI="/home/mezn/workspace/private/ksd-intelligence/dist/adapters/cli/main.js"

# 1. Check status of a workspace
node "$KSD_CLI" status --root "<ROOT>"

# 2. Initialize ei.config.json (first time only)
node "$KSD_CLI" init --root "<ROOT>"

# 3. Build or incrementally update the index
node "$KSD_CLI" index --root "<ROOT>"

# 4. Run blast-radius / caller impact analysis (1-5 targets, depth 1-10)
node "$KSD_CLI" impact <target1> [target2...] --depth 2 --root "<ROOT>"

# 5. Deep doctor verification (cold rebuild diff + differential check against ts.LanguageService)
node "$KSD_CLI" doctor --deep --differential 100 --root "<ROOT>"

# 6. Route or load pinned workflow skills
EI_MATT_ROOT=/home/mezn/ei-skill-sources/matt \
EI_POTETO_ROOT=/home/mezn/ei-skill-sources/cursor-plugins \
EI_OSMANI_ROOT=/home/mezn/ei-skill-sources/osmani \
node "$KSD_CLI" load --task "<task description>" --stage investigate --risk normal
```

## 3. Non-Negotiable Evidence Rules

1. **Zero callers never proves "safe" or "low risk" on its own.** Always inspect `confidence` (`high` | `medium` | `low` | `unknown`), `reasons`, and `gaps`.
2. **Treat `unknown` or `low` confidence as incomplete static evidence.** When `ei_impact` reports `confidence: unknown` or `low` (e.g., `dynamic-import`, `eval-or-function`, `computed-member-access`, `string-name-match`, `namespace-escape`, `untyped-Boundary`, `many-callers`), follow up with targeted text search (`grep`) and manual inspection of the cited gap sites before editing.
3. **Skills are instructions, not executors.** Never execute scripts from upstream skill directories; host and owner rules always outrank skill text.
