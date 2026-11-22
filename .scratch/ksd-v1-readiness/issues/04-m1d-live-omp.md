# 04: Close M1d live OMP platform evidence

**What to build:** Collect real, non-mocked OMP runtime evidence on **both Linux/WSL2 and macOS** so the owner can distinguish a green GitHub Actions CI matrix from a working installed OMP extension + KSD policy on each OS family.

**Blocked by:** 02 — Accept M2b on final evidence.

**Status:** partial (Linux/WSL2 live OMP `19.1.0` extension + `ei_workflow`/`ei_status`/`ei_impact` + `before_agent_start` single-injection guard verified 2026-11-22 in [`evidence/04/linux-x64.md`](../evidence/04/linux-x64.md); Linux manual TUI, live `omp -p` LLM turn, and ALL macOS live OMP checks still `NOT VERIFIED`)

**Requirement:** REQ-04 in the [spec](../spec.md).

**Playbook:** Read [PLAYBOOK.md](../PLAYBOOK.md) BEFORE running any command.

---

## Read First (Exact Files)
1. [PLAYBOOK.md](../PLAYBOOK.md)
2. [docs/briefs/M1d-platform-baseline.md](../../../docs/briefs/M1d-platform-baseline.md) — `#acceptance` section
3. [scripts/m1-smoke.sh](../../../scripts/m1-smoke.sh)
4. [scripts/verify-unified-skills.mjs](../../../scripts/verify-unified-skills.mjs)

## Allowed vs Forbidden Paths
- **Allowed:** `.scratch/ksd-v1-readiness/evidence/04/**`, updating `## Comments` in this ticket, and (only after both OS families are verified) updating status line in `docs/briefs/M1d-platform-baseline.md` and `AGENTS.md`.
- **Forbidden:** NEVER modify the owner's real `~/.omp/**`, `~/.gemini/**`, or `src/policy/**`. Always use an isolated temp `HOME` or `--no-extensions -e dist/adapters/omp/extension.js`.

---

## Step-by-Step Execution Runbook (Run Separately on Linux/WSL2 and macOS)

### Step 1 — Record Exact Host Environment
```bash
export REAL_HOME="${SNAP_REAL_HOME:-$HOME}"
export PATH="$REAL_HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$REAL_HOME/.bun/bin:$PATH"
uname -a
node -p "'platform=' + process.platform + ' arch=' + process.arch + ' node=' + process.version"
bun --version
HOME="$REAL_HOME" omp --version
git rev-parse HEAD
```

### Step 2 — Run Isolated Non-Interactive OMP Extension Smoke (Zero Mutation to `~/.omp`)
Run the dual-runtime verifier (loads real `@oh-my-pi/pi-coding-agent` `loadExtensions` + `scanSkillsFromDir` + executes all 5 `ei_workflow` scenarios + `ei_status`):
```bash
HOME="$REAL_HOME" \
EI_MATT_ROOT="$REAL_HOME/ei-skill-sources/matt" \
EI_POTETO_ROOT="$REAL_HOME/ei-skill-sources/cursor-plugins" \
EI_OSMANI_ROOT="$REAL_HOME/ei-skill-sources/osmani" \
npm run verify:skills -- --detect-host
```
Then verify KSD policy injection + single-injection guard + `/engineering-proxy status` in an isolated OMP session (if an LLM API key is available for non-interactive `omp -p`; otherwise record as `NOT VERIFIED` and hand the exact interactive command to the owner):
```bash
# Non-interactive check (does NOT touch installed plugins):
HOME="$REAL_HOME" omp -p --no-extensions -e "$PWD/dist/adapters/omp/extension.js" \
  'Call ei_status and ei_workflow(task="fix login bug", stage="investigate"). Print the first 5 lines of each result.'
```

### Step 3 — Separate Manual TUI Verification (Owner-Run)
Keep manual TUI checks in their own table (never merge into non-interactive results):
1. Start `omp` in this repository after `omp plugin upgrade` (`0.2.0`).
2. Run `/engineering-proxy status` → confirm `○ 🛡 KSD: BALANCED` (or `● 🛡 KSD: ADAPTIVE`) appears ONCE (no duplicate policy injection).
3. Run `/engineering-review` → confirm policy text loads.
4. Confirm `/skill:poteto-mode` is hidden from auto-discovery and reachable only via explicit opt-in.

### Step 4 — Record OS-Specific Evidence File
Write `.scratch/ksd-v1-readiness/evidence/04/<os>-<arch>.md` with:
- Exact OS, arch, commit SHA, Node/Bun/OMP versions
- Exact commands + pasted outputs
- Explicit `VERIFIED` vs `NOT VERIFIED` rows for:
  - CI matrix (Node 24)
  - Non-interactive OMP extension load + tool calls (`ei_workflow`, `ei_status`, `ei_impact`)
  - Manual TUI status segment + `/engineering-proxy` + `/engineering-review`
- **Hard Rule:** If macOS was not run on an actual macOS host, mark macOS `NOT VERIFIED` and keep Ticket 04 open.

---

## Acceptance Criteria
- [ ] Run the applicable [M1d live acceptance checks](../../../docs/briefs/M1d-platform-baseline.md#acceptance) for `ei_workflow` and KSD on macOS and Linux/WSL2 at the accepted candidate or current `main` revision. Keep the manual TUI status checks separate from non-interactive output.
- [ ] Record OS, architecture, checkout revision, Node/Bun/OMP versions, commands and observed tool/policy behavior. Show that policy is injected once and that status/commands work in a real session. Keep engine runtime checks and CI evidence separately identified.
- [ ] Use an isolated OMP home or an owner-run session. Do not modify the owner's real OMP config or plugins. If a host or live check is unavailable, mark that OS NOT VERIFIED and do not claim full support.

## Comments
- 2026-11-22 (Linux WSL2 x86_64, Node v24.21.0, Bun 1.4.2, OMP 19.0.1, branch `release/0.2.0-unified-skills` `71e30ba`): `npm run verify:skills -- --detect-host` VERIFIED `loadExtensions` (`tools=[ei_workflow,ei_status,ei_impact]`, `commands=[engineering-proxy,engineering-review]`), 5/5 `ei_workflow` scenarios + `potetoMode: true`, and `omp-discovery` (`131 skills`, `poteto-mode opt-in=true`, `0 issues`). Manual TUI checks on Linux and ALL live checks on macOS remain `NOT VERIFIED`.
- 2026-11-22 (Linux WSL2 x86_64, Node v24.21.0, Bun 1.4.2, OMP `19.1.0`, commit `633f478`): Recorded full Linux non-interactive evidence in [`evidence/04/linux-x64.md`](../evidence/04/linux-x64.md): `npm run verify:skills -- --detect-host --json` 5/5 `VERIFIED`, plus direct OMP `19.1.0` `loadExtensions` execution of `ei_status`, `ei_impact`, `ei_workflow`, and `before_agent_start` single-injection guard (`1st pass: true`, `2nd pass changed: false`). Linux manual TUI checks, live `omp -p` LLM turn, and ALL macOS live checks remain `NOT VERIFIED`; ticket stays open.
