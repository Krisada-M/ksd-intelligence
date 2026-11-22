# Ticket 04 — M1d Live OMP Platform Evidence (`linux-x64`)

- **Date:** 2026-11-22
- **Host OS / Arch:** Linux WSL2 `x86_64` (`6.18.58.1-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC`)
- **Repository / Commit:** `ksd-intelligence` @ `45cea76` on `release/0.2.0-unified-skills` (`0.2.0`)
- **Runtime Versions:** Node `v24.21.0` · Bun `1.4.2` · OMP `19.1.0` (`omp/19.1.0`) · TypeScript `5.9.3` (runtime)
- **OMP Files Read / Loaded:** `@oh-my-pi/pi-coding-agent` `19.1.0` (`src/extensibility/extensions/loader.ts`) + `dist/adapters/omp/extension.js`
- **Isolation:** Read-only against the installed OMP runtime; zero modifications to `~/.omp/**` or `~/.gemini/**`.

---

## Verification Matrix (`linux-x64` vs `darwin`)

| Check | Scope / Platform | Status | Evidence |
|---|---|---|---|
| Unit & integration test suite | `linux-x64` (Node `v24.21.0`, Bun `1.4.2`) | `VERIFIED` | `npm test` — 641/641 passed (0 failed, 0 skipped) |
| Unified skill & runtime verifier | `linux-x64` (OMP `19.1.0` + AGY Snap) | `VERIFIED` | `HOME="$REAL_HOME" npm run verify:skills -- --detect-host --json` — 5/5 checks `VERIFIED` |
| Non-interactive OMP extension load (`loadExtensions`) | `linux-x64` (OMP `19.1.0`, Bun `1.4.2`) | `VERIFIED` | Loaded `dist/adapters/omp/extension.js` with 0 errors; registered `ei_workflow`, `ei_status`, `ei_impact`, `/engineering-proxy`, `/engineering-review` |
| Live tool execution in OMP runtime (`ei_status`, `ei_impact`, `ei_workflow`) | `linux-x64` (OMP `19.1.0`) | `VERIFIED` | All 3 tools executed in Bun against `ksd-intelligence` (`STATUS ready`; outputs below) |
| KSD policy `before_agent_start` single-injection guard | `linux-x64` (OMP `19.1.0`) | `VERIFIED` | 1st pass injected policy (`true`); 2nd pass with already-injected prompt returned unchanged (`2nd pass changed: false`) |
| Non-interactive `omp -p` live LLM turn | `linux-x64` (OMP `19.1.0`) | `NOT VERIFIED` | Isolated `omp -p` exited `1` (`No API key` in isolated env; recorded in Ticket 02 evidence) |
| Manual OMP TUI checks (`/engineering-proxy status`, `/engineering-review`, status bar `🛡 KSD`, `/skill:poteto-mode`) | `linux-x64` | `NOT VERIFIED` | Requires interactive owner-run TUI session after `omp plugin upgrade` |
| GitHub Actions CI matrix (Linux + macOS) | GitHub Actions runners | `VERIFIED` (CI only; runner arch not inspected) | CI green on `origin/main` / PR #33; **NOT** proof of live OMP compatibility |
| Live OMP smoke (non-interactive + TUI) | **macOS (`darwin`)** | `NOT VERIFIED` | No macOS host available in this session; Ticket 04 remains open |

---

## Commands Executed & Exact Output (`linux-x64`)

### 1. Host environment

```text
$ uname -a
Linux DESKTOP-PS9EAEH 6.18.58.1-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC Tue Oct 27 00:24:11 UTC 2026 x86_64 GNU/Linux
$ node -v
v24.21.0
$ bun --version
1.4.2
$ omp --version
omp/19.1.0
```

### 2. Dual-runtime unified skills & OMP/AGY verifier (`HOME="$REAL_HOME"`)

```text
$ HOME="$REAL_HOME" EI_MATT_ROOT="$REAL_HOME/ei-skill-sources/matt" EI_POTETO_ROOT="$REAL_HOME/ei-skill-sources/cursor-plugins" EI_OSMANI_ROOT="$REAL_HOME/ei-skill-sources/osmani" npm run verify:skills -- --detect-host --json
{
  "ok": true,
  "detectHost": true,
  "checks": [
    { "name": "registry-lock", "ok": true, "label": "VERIFIED", "detail": "0 issues" },
    { "name": "agy-discovery", "ok": true, "label": "VERIFIED", "detail": "110 skills · poteto-mode opt-in=true · issues=0 · snap=true" },
    { "name": "omp-discovery", "ok": true, "label": "VERIFIED", "detail": "131 skills · poteto-mode opt-in=true · issues=0 · profile=default" },
    { "name": "agy-mcp-stdio", "ok": true, "label": "VERIFIED", "detail": "STATUS degraded (stale index: 73 files drifted) · run: ei index · 5/5 scenarios + potetoMode opt-in passed" },
    { "name": "omp-live-runtime", "ok": true, "label": "VERIFIED", "detail": "tools=[ei_workflow,ei_status,ei_impact] commands=[engineering-proxy,engineering-review] catalog=5 scenarios=5/5" }
  ]
}
```

### 3. Direct OMP `19.1.0` `loadExtensions` tool & policy check (Bun `1.4.2`, non-interactive)

After refreshing the local repo index (`HOME="$REAL_HOME" node dist/adapters/cli/main.js index --root "$PWD"`), loaded `@oh-my-pi/pi-coding-agent` `19.1.0` `loadExtensions([dist/adapters/omp/extension.js], cwd)` in Bun and invoked `ei_status`, `ei_impact`, `ei_workflow`, and `before_agent_start`:

```text
Tools: [ "ei_workflow", "ei_status", "ei_impact" ]
Commands: [ "engineering-proxy", "engineering-review" ]
Handlers: [ "session_start", "session_tree", "session_switch", "session_branch", "agent_start",
  "agent_end", "before_agent_start"
]
--- ei_status ({}) isError=false ---
STATUS ready
Index       published 2026-11-22 06:19 UTC · fresh (stat probe) · last cold 2.9 s (scan 0.1 · program 0.7 · extract 0.0 · resolve 2.1 · verify 0.0 · publish 0.0)
Coverage    439 scanned · 93 indexable · 43 orphan (no tsconfig) · 303 unindexed (excluded 101 · other-kind 44 · outside-index-scope 158)
Graph       1,950 declarations · 5,558 edges · programs 2 (split by lib, noUncheckedIndexedAccess, types)
Problems    0 files failed to parse · 0 not in a program · 0 unresolved imports · 4868 unresolved name matches · dependencies installed: yes · incompleteReasons: none
Gap sites   computed-member-access 51 · dynamic-import 2 · interface-dispatch 118
Limits      2 unbounded dynamic imports · 128 excluded files · 0 failed to index
Scope       7 packages · tsconfigs 3 (src/policy/tsconfig.json, tests/tsconfig.json, tsconfig.json) · bases 0 · tsconfig problems none
Config      ei.config.json ok
Runtime     node 24.21.0 (~/.local/share/fnm/node-versions/v24.21.0/installation/bin/node) · memory limit 7,997 MB · engine peak 465 MB (last build)
TypeScript  5.9.3 (runtime) · ~/.cache/ksd-intelligence/runtime/typescript-5.9.3/node_modules/typescript/lib/typescript.js · verified sha256 3ae902c92cc4
Store       ~/.cache/ksd-intelligence/e14e18b119a2d32b/index.sqlite · 2,324 KB · schema 4
--- ei_impact ({"targets":["src/core/graph/graph.ts#Graph.incoming"],"depth":2}) isError=false ---
IMPACT Graph.incoming — src/core/graph/graph.ts:44
ACTION proceed · level low · picture complete
REACH 3 direct · 3 total · 2 files · 1 package · 0 routes · factors: none

Callers, depth 1 (3)
  tests/core/differential.test.ts:1  <module>  CALLS
  tests/core/indexing.test.ts:1  <module>  CALLS
  tests/core/indexing.test.ts:23  users  CALLS
Tests (2)
  tests/core/differential.test.ts
  tests/core/indexing.test.ts
Gaps: none
--- ei_impact ({"targets":["status"],"depth":2}) isError=false ---
AMBIGUOUS status — 5 declarations. Call again with one of:
  src/core/engine/host.ts#EngineHost.status
  src/core/kernel/types.ts#Completeness.status
  src/core/workspace/scan.ts#CensusRecord.status
  src/storage/sqlite.ts#FileRecord.status
  src/workflow/updates.ts#StagedSkillUpdate.status
--- ei_workflow ({"task":"fix login bug","stage":"investigate"}) isError=false ---
# KSD Workflow
KSD/project policy and explicit owner decisions take precedence over any skill text below.
Never merge or deploy without explicit approval. Report verification evidence.

Orchestrator: ksd-intelligence
Task: fix login bug
Type: bug (classifiedBy: keyword)
Stage: investigate
Risk: normal
Primary Pack: matt-sdlc

# Skill invoked: matt:diagnosing-bugs
before_agent_start handler count: 1
Policy injected 1st pass: true
2nd pass changed: false
```

---

## Remaining `NOT VERIFIED` Items (Manual TUI + macOS)

1. **Linux/WSL2 manual TUI (owner-run after `omp plugin upgrade` to `0.2.0`):**
   - Start `omp` in `ksd-intelligence`.
   - Run `/engineering-proxy status` → verify `○ 🛡 KSD: BALANCED` (or `● 🛡 KSD: ADAPTIVE`) appears once.
   - Run `/engineering-review` → verify policy loads cleanly.
   - Confirm `/skill:poteto-mode` does not auto-trigger without explicit opt-in.
2. **macOS (`darwin`) live OMP smoke + manual TUI:**
   - Run Steps 1–3 of `.scratch/ksd-v1-readiness/issues/04-m1d-live-omp.md` on a real macOS machine and record `.scratch/ksd-v1-readiness/evidence/04/darwin-<arch>.md`.
