# 03: Start M3 dogfood on real repositories

**What to build:** Start owner-led dogfood with a repeatable, measured baseline (`docs/research/m3-<repo>-<os>.md`) and first real task entries in `docs/dogfood-log.md`. **No product code is written in this ticket.**

**Blocked by:** 02 — Accept M2b on final evidence (owner disposition). *Note: Prerequisite cut-over branch `release/0.2.0-unified-skills` (`71e30ba`) should be merged + `omp plugin upgrade` + AGY MCP reloaded so dogfood runs on `0.2.0`.*

**Status:** ready-for-agent (after owner names the work repository path)

**Requirement:** REQ-03 in the [spec](../spec.md).

**Playbook:** Read [PLAYBOOK.md](../PLAYBOOK.md) BEFORE running any command.

---

## Read First (Exact Files)
1. [PLAYBOOK.md](../PLAYBOOK.md)
2. [docs/briefs/M3-dogfood.md](../../../docs/briefs/M3-dogfood.md) (entire file — 90 lines)
3. [docs/DESIGN.md](../../../docs/DESIGN.md) §13 (M3 exit gate) and §14 (performance targets)
4. [docs/dogfood-log.md](../../../docs/dogfood-log.md)

## Allowed vs Forbidden Paths
- **Allowed:** `docs/research/m3-<repo>-<os>.md`, `docs/dogfood-log.md`, and (ONLY after owner sets limits) `docs/DESIGN.md` §14.
- **Forbidden:** Do NOT edit `src/**`, `tests/**`, `src/policy/**`, or commit any source code/secrets/paths from the private work repository. Do NOT write `ei.config.json` into the target repository until the owner approves the `--dry-run` output.

---

## Step-by-Step Execution Runbook (Repeat Once per Repository: `ksd-intelligence` + Owner-Named Work Repo)

### Step 0 — Reconcile Repository List with Owner (STOP if work repo is unnamed)
Ask the owner to confirm:
1. Exact absolute path of the read-only real work repository clone (`<WORK_REPO>`), plus the sanitized alias name to use in `docs/dogfood-log.md` (no private code or secrets committed).
2. Confirmation that `oh-my-pi` remains the stress reference and `ksd-intelligence` is supplemental smoke (per `DESIGN §13` vs `M3-dogfood.md`).

### Step 1 — Dry-Run Init & Runtime Check (Read-Only)
```bash
export HOME="${SNAP_REAL_HOME:-$HOME}"
export PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$HOME/.bun/bin:$PATH"
KSD_CLI="$PWD/dist/adapters/cli/main.js"

node "$KSD_CLI" setup --check
node "$KSD_CLI" init --dry-run --root "<TARGET_REPO>"
```
**STOP GATE:** Show the proposed `ei.config.json` (`include`, `exclude`, `tsconfigs`, `omittedTsconfigDirs`, `warnings`) to the owner. Do NOT run `ei init` without `--dry-run` until the owner approves the scope!

### Step 2 — Build Cold Index & Capture Baseline Census
After the owner approves/writes `ei.config.json`:
```bash
node "$KSD_CLI" index --full --root "<TARGET_REPO>"
node "$KSD_CLI" status --root "<TARGET_REPO>" --json > /tmp/m3-status.json
node "$KSD_CLI" status --root "<TARGET_REPO>"
```
Record in `docs/research/m3-<repo-alias>-<os>.md`:
- OS, arch, Node version, Bun version, TypeScript version, KSD commit SHA
- Scanned / indexable / orphan / unindexed counts (with top unindexed reasons)
- Declarations, edges, cold build duration, phase split (`scan / program / extract / resolve / verify / publish`), peak RSS MB
- Gap-site counts by reason (`computed-member-access`, `dynamic-import`, `interface-dispatch`, etc.)

### Step 3 — Measure 4 Latency Benchmarks (3 Runs Each, Report Median + Min–Max Range)
Run against a **disposable temp copy** of `<TARGET_REPO>` (NEVER edit the owner's real checkout!):
1. **No-drift query latency (p50 & p95 over 20 seeded targets):** call `ei impact <target> --root <COPY> --json` 20 times and record median/p95 ms.
2. **One-file body edit update (3 runs):** add a harmless local `const _m3Probe = 1;` inside a function body, time `ei impact <target> --root <COPY>`, revert.
3. **Widely-used export signature edit update (3 runs):** add an optional param `_m3?: number` to a widely imported export, time `ei impact`, revert.
4. **Add new file update (3 runs):** create a new `.ts` file importing an existing export, time `ei impact`, delete file.

### Step 4 — Differential Oracle (`ei doctor --deep --differential 300`)
```bash
node "$KSD_CLI" doctor --deep --differential 300 --root "<TARGET_REPO>" --json
```
Expected: `differences.count === 0` AND `differential.misses.length === 0`. If ANY miss occurs, STOP and report immediately!

### Step 5 — Seeded 200-Target Distribution + 10 `low` Hand-Checks
Write a small throwaway script in `/tmp/m3-audit.mjs` (never commit it) that:
1. Samples 200 deterministic declarations from the repo's published SQLite index (using fixed seed, e.g. `42`).
2. Runs `ImpactQuery` on each and counts `low`, `medium`, `unknown`, plus the top 10 completeness reasons.
3. Picks 10 `low` results and checks EVERY ONE against TypeScript's `ts.LanguageService.findReferences` (and manual inspection of callers).
- **HARD STOP RULE (Contingency D):** If even **ONE** `low` result misses a real in-scope caller → **STOP ALL OTHER WORK**, reproduce as a failing fixture test, fix the layer that lost it, and log it in `docs/dogfood-log.md`.

### Step 6 — Owner Sets Limits & Logs First Real Task
**STOP GATE:** Present `docs/research/m3-<repo-alias>-<os>.md` to the owner. The owner sets daily-use limits (cold build, body edit, signature edit) for `docs/DESIGN.md §14` and logs Task #1 + start date in `docs/dogfood-log.md` using the 6-line template in `M3-dogfood.md`.

---

## Acceptance Criteria
- [ ] Reconcile the repository list in the [M3 brief](../../../docs/briefs/M3-dogfood.md#repositories) with [DESIGN §13](../../../docs/DESIGN.md#13-roadmap-and-gates): `oh-my-pi` plus one real GitLab project. The owner names and approves the read-only work clone. Use `ksd-intelligence` for supplemental smoke, not as a substitute. Do not copy work-repository source or secrets into evidence.
- [ ] Run `ei setup --check` and `ei init --dry-run`; obtain owner approval for scope before writing config. Record index counts, gap/orphan counts, runtime, cold/warm/drift timings and peak RSS. Record seeded verdict distribution, sampled `low` checks and `ei doctor --deep --differential 300` per the approved setup round.
- [ ] After setup, the owner sets daily-use limits for cold build, body-edit update and signature-edit update on the work repository. Record the approved limits in [DESIGN §14](../../../docs/DESIGN.md#14-quality-and-testing) before resolving this ticket. Use Contingency E if a measurement misses a limit.
- [ ] Start the dogfood log with the first real task and the start date. Record correctness, action change, latency, verdict and missing evidence; report measured operator friction, not just tool success.
- [ ] Apply Contingency D immediately if an incorrect `low` is found. M2c can enter Round 0 after setup, limits and the dogfood start are recorded; it does not wait for M3 exit.

## Common Traps to Avoid
- NEVER edit the owner's real work repo during Step 3 latency edits — always benchmark edits on a `/tmp` copy and delete the copy afterwards.
- NEVER paste proprietary code snippets, env values, or private file contents into `docs/research/m3-*.md` or `docs/dogfood-log.md`.
- Do NOT tune or optimize performance during setup — report raw numbers first; optimization uses Contingency E only after owner approval.
