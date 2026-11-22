# Ticket 04 — M1d Live OMP Platform Evidence (`linux-x64`)

- **Date:** 2026-11-22
- **Host OS / Arch:** Linux WSL2 `x86_64` (`6.18.58.1-microsoft-standard-WSL2 #1 SMP PREEMPT_DYNAMIC`)
- **Repository / Commit:** `ksd-intelligence` @ `633f478` on `release/0.2.0-unified-skills` (`0.2.0`)
- **Runtime Versions:** Node `v24.21.0` · Bun `1.4.2` · OMP `19.1.0` (`omp/19.1.0`) · TypeScript `5.9.3` (runtime)
- **OMP Files Read / Loaded:** `@oh-my-pi/pi-coding-agent` `19.1.0` (`src/extensibility/extensions/loader.ts`) + `dist/adapters/omp/extension.js`
- **Isolation:** Read-only against the installed OMP runtime; zero modifications to `~/.omp/**` or `~/.gemini/**`.

---

## Verification Matrix (`linux-x64` vs `darwin`)

| Check | Scope / Platform | Status | Evidence |
|---|---|---|---|
| Unit & integration test suite | `linux-x64` (Node `v24.21.0`, Bun `1.4.2`) | `VERIFIED` | `npm test` — 641/641 passed (0 failed, 0 skipped) |
| Unified skill & runtime verifier | `linux-x64` (OMP `19.1.0` + AGY Snap) | `VERIFIED` | `npm run verify:skills -- --detect-host --json` — 5/5 checks `VERIFIED` |
| Non-interactive OMP extension load (`loadExtensions`) | `linux-x64` (OMP `19.1.0`, Bun `1.4.2`) | `VERIFIED` | Loaded `dist/adapters/omp/extension.js` with 0 errors; registered `ei_workflow`, `ei_status`, `ei_impact`, `/engineering-proxy`, `/engineering-review` |
| Live tool execution in OMP runtime (`ei_status`, `ei_impact`, `ei_workflow`) | `linux-x64` (OMP `19.1.0`) | `VERIFIED` | All 3 tools executed in Bun against `ksd-intelligence` (outputs below) |
| KSD policy `before_agent_start` single-injection guard | `linux-x64` (OMP `19.1.0`) | `VERIFIED` | 1st pass injected policy (`true`); 2nd pass with already-injected prompt returned `undefined` (`2nd pass changed: false`) |
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

### 2. Dual-runtime unified skills & OMP/AGY verifier

```text
$ EI_MATT_ROOT=~/ei-skill-sources/matt EI_POTETO_ROOT=~/ei-skill-sources/cursor-plugins EI_OSMANI_ROOT=~/ei-skill-sources/osmani npm run verify:skills -- --detect-host --json
{
  "ok": true,
  "detectHost": true,
  "checks": [
    { "name": "registry-lock", "ok": true, "label": "VERIFIED", "detail": "0 issues" },
    { "name": "agy-discovery", "ok": true, "label": "VERIFIED", "detail": "110 skills · poteto-mode opt-in=true · issues=0 · snap=true" },
    { "name": "omp-discovery", "ok": true, "label": "VERIFIED", "detail": "131 skills · poteto-mode opt-in=true · issues=0 · profile=default" },
    { "name": "agy-mcp-stdio", "ok": true, "label": "VERIFIED", "detail": "STATUS degraded (typescript runtime missing) · run: ei setup · 5/5 scenarios + potetoMode opt-in passed" },
    { "name": "omp-live-runtime", "ok": true, "label": "VERIFIED", "detail": "tools=[ei_workflow,ei_status,ei_impact] commands=[engineering-proxy,engineering-review] catalog=5 scenarios=5/5" }
  ]
}
```

*(Note: `agy-mcp-stdio` ran inside Snap's sandboxed `HOME`, where `~/.cache/ksd-intelligence/runtime/typescript-5.9.3` is absent, hence `STATUS degraded (typescript runtime missing)` — proving fail-open degradation while `ei_workflow` passed 5/5 scenarios. With real `HOME` set, `ei_status` resolves the cached TypeScript `5.9.3` runtime as verified below.)*

### 3. Direct OMP `19.1.0` `loadExtensions` tool & policy check (Bun `1.4.2`, non-interactive)

Loaded `@oh-my-pi/pi-coding-agent` `19.1.0` `loadExtensions([dist/adapters/omp/extension.js], cwd)` in Bun and invoked `ei_status`, `ei_impact`, `ei_workflow`, and `before_agent_start`:

```text
Tools: [ "ei_workflow", "ei_status", "ei_impact" ]
Commands: [ "engineering-proxy", "engineering-review" ]
Handlers: [ "session_start", "session_tree", "session_switch", "session_branch", "agent_start",
  "agent_end", "before_agent_start"
]
--- ei_status (first 4 lines) ---
STATUS degraded (stale index: 2 files drifted) · run: ei index
Index       published 2026-11-22 05:29 UTC · stale: 1 changed · 1 added · 0 deleted (stat probe) · last cold 2.7 s (scan 0.1 · program 0.7 · extract 0.0 · resolve 1.8 · verify 0.0 · publish 0.0)
Coverage    436 scanned · 93 indexable · 43 orphan (no tsconfig) · 300 unindexed (excluded 101 · other-kind 44 · outside-index-scope 155)
Graph       1,950 declarations · 5,558 edges · programs 2 (split by lib, noUncheckedIndexedAccess, types)
--- ei_impact (first 4 lines) ---
IMPACT Graph.incoming — src/core/graph/graph.ts:44
ACTION proceed · level low · picture complete
REACH 3 direct · 3 total · 2 files · 1 package · 0 routes · factors: none
--- ei_workflow (first 10 lines) ---
# KSD Workflow
KSD/project policy and explicit owner decisions take precedence over any skill text below.
Never merge or deploy without explicit approval. Report verification evidence.

Orchestrator: ksd-intelligence
Task: fix login bug
Type: bug (classifiedBy: keyword)
Stage: investigate
Risk: normal
Primary Pack: matt-sdlc
before_agent_start handler count: 1
Policy injected on 1st pass: true 1st marker count: 0 2nd pass changed: false 2nd marker count: 0
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
