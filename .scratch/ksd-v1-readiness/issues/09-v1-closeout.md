# 09: Close V1 with install and upgrade evidence

**What to build:** Deliver the audited V1.0.0 release candidate: every documented claim verified against code (or explicitly marked `PLANNED (V2)`), safety & packaging swept clean, CLI/OMP/AGY parity tested, isolated fresh-install + schema-upgrade rehearsals recorded, and exact owner release checklist ready.

**Blocked by:** 04 — Close M1d live OMP platform evidence; 07 — Decide and verify evidence-backed route detectors; 08 — Turn M3 evidence into owner decisions.

**Status:** ready-for-agent (MUST start with **Round 0 — reconcile ONLY**)

**Requirement:** REQ-09 in the [spec](../spec.md).

**Playbook:** Read [PLAYBOOK.md](../PLAYBOOK.md) BEFORE running any command.

---

## Read First (Exact Files)
1. [PLAYBOOK.md](../PLAYBOOK.md)
2. [docs/briefs/README.md](../../../docs/briefs/README.md)
3. [docs/briefs/V1-closeout.md](../../../docs/briefs/V1-closeout.md) (entire file — 73 lines)
4. [AGENTS.md](../../../AGENTS.md), [README.md](../../../README.md), [PROVENANCE.md](../../../PROVENANCE.md)
5. [docs/DESIGN.md](../../../docs/DESIGN.md) §8, §13–§16, [docs/TOOLS.md](../../../docs/TOOLS.md), [docs/RISK.md](../../../docs/RISK.md)
6. [docs/integrations/skills-catalog.md](../../../docs/integrations/skills-catalog.md), [docs/integrations/antigravity.md](../../../docs/integrations/antigravity.md)

## Allowed vs Forbidden Paths
- **Branch:** `v1-closeout` created from `origin/main`.
- **Forbidden:**
  - NEVER start any V2 module.
  - NEVER tag, push, merge, publish to npm, or touch the owner's real `~/.omp/**` or `~/.gemini/**`.
  - NEVER restructure `src/` directories purely to match the diagram in `DESIGN §5.2` (record architecture drift honestly instead!).
  - NEVER edit `tests/golden/**`, `src/policy/**`, or `tests/policy/**`. (Snapshot footer updates for `1.0.0` require explicit owner approval + `owner-approved` label!)

---

## Step-by-Step Execution Runbook (ONE Round per Session)

### Round 0 — Reconcile ONLY (Zero Code Changes!)
1. Verify preconditions: check that M2b, M2c, M6a, M4a (or explicit owner skip), M1d live platform evidence (both OSes), and M3 exit decisions are all recorded on `origin/main`.
2. Reconcile `docs/briefs/V1-closeout.md` against current repo state (including AGY MCP + Unified AGY/OMP Skills + `npm run verify:skills` added in PR `#33` / `0.2.0`).
3. **STOP GATE:** Report Round 0 status and wait for owner approval before Round 1.

### Round 1 — Audit & Tidy (No Behaviour Change!)
Execute ALL 9 audit items from `V1-closeout.md`:
1. **Claims-vs-code matrix:** table of EVERY tool, CLI subcommand, config key, completeness reason, factor, guidance, and failure code across `DESIGN.md`, `TOOLS.md`, `RISK.md`, `README.md` → `exists? | tested? | registered? | action (keep / mark PLANNED V2 / gap)`.
2. **Leftovers list for owner decision** (do NOT build yet!): `ei doctor` canary, `ei_status` OMP version mismatch warning, per-capability `enabled` flags, `ei cache clear`, `ei symbol`, 5 s per-query budget.
3. **CLI vs Tool parity tests:** one automated test per tool confirming CLI and tool output match for identical input.
4. **Dead code & stale doc sweep:** grep for removed concepts (`builder chaining`, `releaseProgram`, `supplemented counter`, withdrawn M1b timing gates) and `TODO`; delete only provably unused code.
5. **Tool discovery snippet (`TOOLS §9`):** verify copy-paste `AGENTS.md` block matches registered tool descriptions.
6. **Packaging check:** `.omp-plugin/marketplace.json` `source: "./"`, `package.json#omp.extensions`, `dist/` clean (`npm run check:dist`), zero outside-package paths, all `bin` scripts run with `--help`.
7. **Safety sweep (paste exact grep output!):**
   ```bash
   git grep -nE "\b(fetch|http|https|net|dns|child_process)\b" -- src/ scripts/
   git grep -nE "/home/|/Users/|C:\\\\Users\\\\" -- src/ scripts/ skills/ docs/ tests/snapshots/
   ```
   Justify every match; verify cache/audit modes `0700`/`0600`; test `EI_DISABLED=1` and `ENGINEERING_PROXY_DISABLED=1` alone and together.
8. **Agent-behaviour evals (`evals/`):** 10–20 tasks from `docs/dogfood-log.md` with transcript checks (`ei_impact` before edit, verdict action followed, `ei_changes` before done) + runner script (manual only, NOT in CI).
9. **Full gates:** `typecheck`, `lint`, `format:check`, `npm test`, `check:dist`, `verify:skills`, mutation smoke, `ei doctor --deep --differential 300`.
10. **STOP GATE:** Present audit table + Round 1 leftovers list to owner. Wait for owner decisions before Round 2.

### Round 2 — Release Candidate (`1.0.0`)
1. Apply ONLY the owner's approved Round 1 decisions; mark unbuilt items `PLANNED (V2)`.
2. Bump version to `1.0.0` in `package.json`, `.omp-plugin/marketplace.json`, `scripts/mcp/stdio.mjs`, `src/core/impact/render.ts` (note snapshot footer `engine 1.0.0` updates require `owner-approved` label!). Write `CHANGELOG.md`.
3. Update `README.md`, `DESIGN.md`, and `AGENTS.md` status tables so every claim matches reality.
4. **Fresh-install rehearsal in isolated temp `HOME` (NEVER touch real `~/.omp`!):**
   ```bash
   ISOLATED_HOME="$(mktemp -d /tmp/ksd-v1-fresh-XXXXXX)"
   HOME="$ISOLATED_HOME" node dist/adapters/cli/main.js setup
   HOME="$ISOLATED_HOME" node dist/adapters/cli/main.js index --root "$PWD"
   HOME="$ISOLATED_HOME" node dist/adapters/cli/main.js status --root "$PWD"
   HOME="$ISOLATED_HOME" npm run verify:skills
   # Plus isolated OMP load + one call per ei_* tool; paste full transcript + label OS!
   rm -rf "$ISOLATED_HOME"
   ```
5. **Previous-schema upgrade rehearsal:** open an index written with `schema_version = SCHEMA_VERSION - 1` and verify it degrades/rebuilds cleanly (never read as current!).
6. Write `docs/release-checklist.md` with exact owner-only commands for macOS + Linux/WSL2 (push, PR, tag `v1.0.0`, marketplace install/upgrade, AGY MCP reload, archive `Krisada-M/ksd-engineering`).
7. Run cross-vendor independent review (`V1-closeout.md` Review Focus 1–5), fix any findings, run full verification gate, commit locally on `v1-closeout`, and **STOP** (do NOT push or tag).

---

## Acceptance Criteria
- [ ] Run Round 0 on the [V1 close-out brief](../../../docs/briefs/V1-closeout.md). Record required milestone acceptance or explicit owner skips and M3 exit decisions. Wait for corrected-brief approval before Round 1.
- [ ] Audit claims against shipped contracts, tests, CLI/OMP parity and packaging. Show safety and kill-switch evidence. Record material architecture-document drift without restructuring code solely to match a planned tree. Mark unsupported claims as planned or gaps, not shipped.
- [ ] Record the approved close-out suite, agent-behavior evals, CI on both OS families, and isolated fresh-install and previous-schema upgrade rehearsals. A stale index must not be treated as current. Record known limits and supply exact owner checklist commands.
- [ ] Verify the owner has completed the required live release checks on both machines before calling V1 accepted. Release, merge, tag and publication remain owner-only. No V2 work starts here.

## Common Traps to Avoid
- **Trap 1:** Running fresh-install rehearsal with real `HOME` (corrupts owner's `~/.omp` or `~/.cache`!). Always use `mktemp -d`.
- **Trap 2:** Putting `evals/` into GitHub Actions / GitLab CI (spends real LLM API calls!). Keep manual-only.
- **Trap 3:** Claiming macOS or AGY IDE live smoke is `VERIFIED` without actually running on that host.
- **Trap 4:** Moving files around to match `DESIGN §5.2` (explicitly forbidden; document drift instead).
