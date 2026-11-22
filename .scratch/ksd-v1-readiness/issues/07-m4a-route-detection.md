# 07: Decide and verify evidence-backed route detectors

**What to build:** Build ONLY the framework route detectors (`B1a` Next.js App Router, `B1b` Next.js Pages Router, `B1c` Expo Router, `B2` Hono) that have **real workflow evidence in `docs/dogfood-log.md`**. If NO detector has evidence, record an explicit owner skip instead of guessing.

**Blocked by:** 06 — Find code with lexical search (owner accepted and merged on `origin/main`) + dogfood evidence from Ticket 03/M3.

**Status:** ready-for-agent (GATED — MUST start with **Round 0 — reconcile + evidence audit ONLY**)

**Requirement:** REQ-07 in the [spec](../spec.md).

**Playbook:** Read [PLAYBOOK.md](../PLAYBOOK.md) BEFORE running any command.

---

## Read First (Exact Files)
1. [PLAYBOOK.md](../PLAYBOOK.md)
2. [docs/briefs/README.md](../../../docs/briefs/README.md)
3. [docs/briefs/M4a-routes.md](../../../docs/briefs/M4a-routes.md) (entire file — 86 lines)
4. [docs/dogfood-log.md](../../../docs/dogfood-log.md)
5. [docs/DESIGN.md](../../../docs/DESIGN.md) §6.9 (B1, B2 & the 6 honesty rules), §7.2 (`route` factor, `reach.routes`), §9 (`impact.routes`, `bridges`)
6. [docs/TOOLS.md](../../../docs/TOOLS.md) §4, §5, §7
7. [tests/golden/M2-impact-cases.md](../../../tests/golden/M2-impact-cases.md) — cases `C12`, `C25`

## Allowed vs Forbidden Paths
- **Branch:** `m4a-routes` created from `origin/main` (only if at least one detector is approved in Round 0!).
- **Forbidden:**
  - NEVER build any heuristic bridges (`REQUESTS`, `NAVIGATES`, `EMITS_TO`, `fetch` path matching — those belong to gated `M4b`).
  - NEVER build a detector that the owner struck or that lacks dogfood evidence.
  - NEVER let route detection remove a completeness gap, lower a verdict, or add a non-compiler edge to `reach`.
  - NEVER edit `tests/golden/**`, `src/policy/**`, `tests/policy/**`, or existing snapshots for non-framework repos.

---

## Step-by-Step Execution Runbook (ONE Round per Session)

### Round 0 — Reconcile & Per-Detector Evidence Gate (Zero Code Changes!)
1. Read `docs/dogfood-log.md` and inspect the M3 work repository's `package.json` dependencies.
2. Produce a 4-row decision table — one row per detector (`B1a` Next.js App, `B1b` Next.js Pages, `B1c` Expo Router, `B2` Hono):
   - Columns: `Detector | Dogfood Evidence (cite exact log entry or "no evidence") | Recommendation (BUILD / SKIP)`.
3. Reconcile `M4a-routes.md` against current `src/storage/sqlite.ts` and `src/core/impact/`.
4. **STOP GATE:** Present the table to the owner.
   - If the owner records **SKIP ALL** → record the explicit owner skip in `docs/DESIGN.md` decision log and in `## Comments` below, and close Ticket 07 without writing code!
   - Otherwise, build ONLY the exact detectors the owner approved.

### Round 1 — File-Convention Routes (`B1a`, `B1b`, `B1c` — ONLY Approved Ones)
1. Add route records table to `src/storage/sqlite.ts` (bump `SCHEMA_VERSION` if needed, wire into `incremental === cold` and `ei doctor --deep`).
2. Detect framework dependency in owning package `package.json` OR monorepo root `package.json` (`next` for B1a/B1b, `expo-router` for B1c).
3. Implement path normalization (`[id]`, `[...slug]`, `[[...slug]]`, strip `(group)` and `@slot`, preserve `(.)x`, collapse `index`, Expo `(tabs)` and `+api`).
4. Respect config toggle `bridges: { B1: false }` while keeping manual `impact.routes` globs additive.
5. Write ALL 11 negative & edge-case tests from `M4a-routes.md` Round 1 (using fixture copies; do NOT edit `tests/fixtures/mono/`!). Verify `C12` and `C25` pass unchanged.
6. Run full verification gate (`PLAYBOOK.md §4`), commit locally. **STOP.**

### Round 2 — Hono (`B2` — ONLY If Approved)
1. Use the TypeScript type checker to verify the receiver's type IS a Hono app — **NEVER match `.get()` on `Map`, HTTP clients, or arbitrary classes by method name alone!**
2. Accept ONLY literal string paths (`app.get('/path', h)`, `app.on(['GET','POST'], '/x', h)`, `app.all`, `app.route('/prefix', sub)`, `basePath('/x')`).
3. **Non-literal paths** (variable, template literal with `${...}`, constant): emit **ZERO** route records and record a `computed-member-access` gap site at the call so handlers stay `partial`.
4. Write all 6 risky-case tests from `M4a-routes.md` Round 2, run full gates, commit locally. **STOP.**

### Round 3 — Tool Rendering, Live Verification, Hand-Check & Mutation Smoke
1. Surface `route` / `route METHOD /path` markers in `ei_impact`, `ei_changes`, `ei_search`, and counts by detector in `ei_status`.
2. Hand-check 20 sampled routes on the real work repo against actual framework routing (target: **0 false routes**; list any misses with cause).
3. Record 200-target verdict distribution delta + build/DB overhead in `docs/research/m4a-measurements.md`.
4. Kill all 5 required mutations in `M4a-routes.md` Round 3. **STOP.**

### Round 4 — Cross-Vendor Review & Fix
- Different-vendor read-only review against all 6 Review Focus items in `M4a-routes.md`, then test-first fix round, full gates, local commit, handoff to owner.

---

## Acceptance Criteria
- [ ] Run Round 0 on the [M4a brief](../../../docs/briefs/M4a-routes.md). Cite a dogfood case or `no evidence` per Next.js, Expo Router and Hono detector; reconcile the brief with DESIGN and the currently indexed data. Owner accepts the corrected brief and approves each detector or records a skip before any build round.
- [ ] For approved detectors, demonstrate route facts end to end in the existing impact/review/search/status surfaces per the reconciled brief. A route never removes a gap, lowers a level or adds an edge to compiler-grade reach. Keep manual route globs additive.
- [ ] For approved detectors, show negative fixtures, incremental-equals-cold and doctor coverage, and the hand-checked sample with no false routes and any misses explained. Record live OMP, performance, mutation and platform CI evidence.
- [ ] No bridges. Resolve the ticket with accepted detector evidence or a recorded owner skip; lack of evidence alone does not silently skip M4a.

## Common Traps to Avoid
- **Trap 1:** Matching `page.tsx` outside an `app/` dir or inside a package that does NOT depend on `next`.
- **Trap 2:** Matching `.get('/x', fn)` by method name without checking receiver type is Hono.
- **Trap 3:** Guessing a dynamic template route instead of recording a gap site.
- **Trap 4:** Silently skipping M4a without an explicit recorded owner skip decision.
