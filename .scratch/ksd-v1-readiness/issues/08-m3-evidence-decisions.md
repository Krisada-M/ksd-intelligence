# 08: Turn M3 evidence into owner decisions

**What to build:** After two weeks of real use and at least 10 logged real tasks (with ZERO open wrong-`low` incidents), produce a factual M3 exit summary and record every owner decision on daily limits, propagation, scoping, M4a detectors, and gated optional milestones (`M4b`, `M5`, `M6b`). **No product code is written in this ticket.**

**Blocked by:** 03 — Start M3 dogfood on real repositories (and 2 weeks + ≥ 10 real logged tasks elapsed).

**Status:** ready-for-agent (once ≥ 10 real tasks & 2 weeks are logged in `docs/dogfood-log.md`)

**Requirement:** REQ-08 in the [spec](../spec.md).

**Playbook:** Read [PLAYBOOK.md](../PLAYBOOK.md) BEFORE running any command.

---

## Read First (Exact Files)
1. [PLAYBOOK.md](../PLAYBOOK.md)
2. [docs/briefs/M3-dogfood.md](../../../docs/briefs/M3-dogfood.md) — `#weekly-review-round-agent` and `#exit` sections
3. [docs/briefs/gated-M4b-M5-M6b.md](../../../docs/briefs/gated-M4b-M5-M6b.md) — `#gate-check-round-agent-read-only`
4. [docs/dogfood-log.md](../../../docs/dogfood-log.md)
5. `docs/research/m3-*.md` (all setup-round measurement files from Ticket 03)
6. [docs/DESIGN.md](../../../docs/DESIGN.md) §13, §14, §15 (Decision log)

## Allowed vs Forbidden Paths
- **Allowed:** `.scratch/ksd-v1-readiness/evidence/08/**`, `docs/research/m3-exit-review.md`, and (ONLY after owner confirms decisions) appending owner decisions to `docs/DESIGN.md` §14–§15.
- **Forbidden:** Do NOT edit `src/**`, `tests/**`, or start implementing `M4b`, `M5`, or `M6b` even if a gate is met! Do NOT invent retrospective audit numbers if `ei audit` did not exist for earlier tasks.

---

## Step-by-Step Execution Runbook

### Step 1 — Pre-Check Gate (STOP if not met)
Count real task entries in `docs/dogfood-log.md`:
- Elapsed time ≥ 14 days?
- Logged real tasks ≥ 10?
- Open wrong-`low` count === 0?
If ANY check fails → **STOP** and report exact counts (`X/10 tasks`, `Y/14 days`, `Z open wrong-low`). Do NOT fabricate entries!

### Step 2 — Extract Audit Data (Only If M2c `ei audit` Exists)
```bash
export HOME="${SNAP_REAL_HOME:-$HOME}"
export PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
node dist/adapters/cli/main.js audit --since 14d --root "<WORK_REPO>" 2>&1 || echo "ei audit not yet shipped"
```
Keep measured audit counts in a separate column from owner log impressions.

### Step 3 — Produce the 7-Item M3 Review Report (`docs/research/m3-exit-review.md`)
Include ALL 7 items from `docs/briefs/M3-dogfood.md`:
1. Tasks logged; % correct; % where tool output changed agent action.
2. Every wrong or partly wrong answer grouped by losing layer (any wrong `low` listed FIRST).
3. Most frequent completeness reasons producing `unknown` — classify each as **real gap** vs **noise**.
4. Slow calls with measured time + phase split vs the daily-use limits set in Ticket 03.
5. Symbols edited without prior `ei_impact` (from `ei audit` or `no data`).
6. Grouped "Missing" requests from owner log entries.
7. Gate evaluation table for `M4a` (per detector), `M4b` (per bridge B3–B6), `M5` (watcher/worktree), `M6b` (semantic search) — each strictly marked `met` | `not met` | `no data` with exact citing task dates.

### Step 4 — Fill the 6-Row Exit Decision Table for Owner Sign-Off
Present the exact 6 rows from `M3-dogfood.md#exit` (daily limits, D50 propagation narrowing, anonymous object-type members, scoping rules, M4a detectors, M4b/M5/M6b go/no-go).

### STOP GATE — Owner Records Final Decisions
Wait for the owner to confirm each of the 6 decisions, then record them in `docs/DESIGN.md` §15 (Decision log). Keep `docs/dogfood-log.md` open through V1 close-out.

---

## Acceptance Criteria
- [ ] After two weeks and at least ten logged real tasks, with no open wrong `low`, summarize correctness, action changes, useful and noisy `unknown` reasons, latency, missed calls and rework. Separate measurements from owner impressions and do not invent retrospective audit data.
- [ ] Use the [M3 exit table](../../../docs/briefs/M3-dogfood.md#exit) to review the daily-use limits recorded in ticket 03 against dogfood results. Record any owner-approved changes and the decisions on propagation, anonymous members, scoping and detector demand. Keep the dogfood log running through close-out.
- [ ] Report each [optional gate](../../../docs/briefs/gated-M4b-M5-M6b.md#gate-check-round-agent-read-only) as met, not met or no data, with supporting entries or timings. A met gate is not approval to implement; M6b still needs separate owner approval. No optional build is required by this ticket.

## Common Traps to Avoid
- Never treat a `met` gate as permission to start building `M4b`, `M5`, or `M6b`.
- Never merge owner subjective impressions with measured `ei audit` numbers.
- Never hide `no data` — explicitly write `no data` whenever a capability was not exercised.
