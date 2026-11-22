# 06: Find code with lexical search

**What to build:** Deliver M6a (`ei_search` — lexical-only BM25 declaration search using built-in `node:sqlite` FTS5, zero embeddings/models/dependencies) with deterministic ranking, provenance, freshness, CLI `ei search`, OMP tool, and AGY MCP tool. **A search hit is never impact evidence.**

**Blocked by:** 05 — Review the actual change with M2c (owner accepted and merged on `origin/main`).

**Status:** ready-for-agent (MUST start with **Round 0 — reconcile ONLY**; do NOT write code until owner approves Round 0)

**Requirement:** REQ-06 in the [spec](../spec.md).

**Playbook:** Read [PLAYBOOK.md](../PLAYBOOK.md) BEFORE running any command.

---

## Read First (Exact Files)
1. [PLAYBOOK.md](../PLAYBOOK.md)
2. [docs/briefs/README.md](../../../docs/briefs/README.md)
3. [docs/briefs/M6a-search.md](../../../docs/briefs/M6a-search.md) (entire file — 76 lines)
4. [docs/DESIGN.md](../../../docs/DESIGN.md) §6.11, §11, D46, D49
5. [docs/TOOLS.md](../../../docs/TOOLS.md) §7 (`ei_search` exact format & 4,000-char budget), §8
6. [docs/RISK.md](../../../docs/RISK.md) §6 (note: storing capped signatures & doc comments is a **PROPOSED** change to RISK §6 that needs owner approval in Round 0!)
7. Existing code seams to inspect BEFORE editing:
   - `src/storage/sqlite.ts` (schema version, tables, `publish`, incremental updates)
   - `src/core/indexing/declarations.ts` & `src/core/indexing/indexer.ts` (per-file extraction)
   - `src/core/indexing/doctor.ts` (`ei doctor --deep` canonical diffing)
   - `src/core/indexing/stamp.ts` (extractor stamp must include search extractor!)
   - `src/adapters/omp/extension.ts`, `src/adapters/cli/main.ts`, `scripts/mcp/tools.mjs`

## Allowed vs Forbidden Paths
- **Branch:** `m6a-search` created from `origin/main` (after M2c is merged).
- **Allowed (Rounds 1–4 ONLY, NOT Round 0):** `src/core/search/**`, `src/storage/sqlite.ts`, `src/core/indexing/**`, `src/adapters/**`, `scripts/mcp/tools.mjs`, `src/index.ts`, `dist/**`, `tests/core/**`, `tests/packaging/**`, `tests/golden/search-queries.md` (NEW proposed file only!), `docs/research/m6a-measurements.md`.
- **Forbidden:** NEVER add embeddings, vector stores, model downloads, or npm dependencies. NEVER let search hits affect `ei_impact` or `ei_changes` completeness, reach, or verdict. NEVER edit `tests/golden/M2-impact-cases.md`, `src/policy/**`, `tests/policy/**`, or existing `tests/snapshots/impact/**`.

---

## Step-by-Step Execution Runbook (ONE Round per Session)

### Round 0 — Reconcile ONLY (Zero Code Changes!)
1. Compare `docs/briefs/M6a-search.md` against current `main` (`sqlite.ts` schema version, `declarations.ts`, `doctor.ts`, `M3` approved repositories in `docs/dogfood-log.md`).
2. Explicitly flag the **PROPOSED `RISK.md §6` change** (storing 400-char capped signatures & first-paragraph doc comments for indexable code files only, never `.env`/excluded files) for owner approval.
3. Reconcile the two evaluation repositories (`oh-my-pi` + the owner's M3 work repo) and confirm `tests/golden/search-queries.md` will be drafted as `PROPOSED` in Round 3.
4. **STOP GATE:** Report Round 0 findings and STOP. Wait for owner approval of both the brief corrections and the `RISK.md §6` storage change.

### Round 1 — FTS5 Search Index (`src/storage/sqlite.ts`, `src/core/search/segments.ts`)
1. Implement deterministic identifier splitter (`splitIdentifier`):
   - `retryWebhook` → `retry webhook`
   - `HTTP_TIMEOUT_MS` → `http timeout ms`
   - `parseURL2` → `parse url 2`
   - `XMLHttpRequest` → `xml http request`
   - Handles kebab paths, `$`/`_` prefixes, digits, non-ASCII identifiers.
2. Bump `SCHEMA_VERSION` in `src/storage/sqlite.ts` (so older indexes rebuild cleanly instead of crashing!) and add an FTS5 virtual table storing per indexed declaration:
   - `stable_key` (UNINDEXED), `name_tokens` (unsplit + split), `owner_tokens`, `kind`, `signature` (capped at 400 chars), `doc` (first paragraph, capped at 400 chars), `path_tokens`.
3. Enforce D49 exclusion rules strictly:
   - Indexable code under `**/secrets/**` or `**/*credentials*` IS searchable by declaration name/signature (D49).
   - `.env*`, `*.pem`, `*.key`, excluded dirs, and non-code secret files contribute ZERO rows.
   - Parse-error files contribute zero rows and never crash the build.
4. Ensure `extractorStamp` covers search extraction, `incremental === cold` tests include FTS5 rows, and `ei doctor --deep` diffs FTS5 rows canonically.
5. Measure DB size before vs after on reference repos. Run full verification gate (`PLAYBOOK.md §4`), commit locally. **STOP.**

### Round 2 — Query, Ranking, CLI, OMP & AGY MCP Tool (`src/core/search/lexical.ts`)
1. Input validation: `query` string 1–200 chars (blank/invalid → clean error or no-match line, NEVER throw); `limit` integer 1–20 (default 8).
2. **FTS5 Injection Safety (CRITICAL):** Split `query` with `splitIdentifier`, strip empty tokens, wrap EVERY token in `"..."` (escaping internal `"` as `""`). NEVER pass raw FTS5 operators (`NEAR`, `OR`, `AND`, `NOT`, `*`, `-`, `:`, `(`, `)`, `\`) unquoted!
3. Deterministic ranking:
   - BM25 weighted: `name > owner > signature > doc > path`
   - Boosts: exact whole-name match (`kind: 'exact'`), exported, log-scaled incoming caller count from `edges`
   - Deterministic tie-breaker: ascending `stable_key` (independent of DB insertion order!)
4. Render strictly per `docs/TOOLS.md §7` (budget 4,000 chars):
   - Match kind is ONLY `'exact'` or `'lexical'` (NEVER `'semantic'`; NEVER print an embedding install hint!).
   - Footer says `search: lexical only`.
   - No matches → success-shaped `SEARCH "<query>" — no matches. Try identifiers that would appear in the code.`
   - Freshness: stat probe → update within budget if drifted, else answer from published index with `STALE INDEX` in footer. No index yet → build-then-answer like `ei_impact`.
5. Register `ei_search` (`approval: 'read'`) in `src/adapters/omp/extension.ts`, add CLI `ei search <query> [--limit N] [--json]` in `src/adapters/cli/main.ts`, add `ei_search` to `scripts/mcp/tools.mjs` (AGY MCP), and write audit log line (query truncated to 200 chars, no result text).
6. Write tests for ALL 7 risky cases in `M6a-search.md` Round 2 (punctuation/operator fuzzing, empty/invalid limits, exact-first, determinism cold vs incremental, 50k declarations p95 < 300 ms, no `semantic` label, cold-build-on-first-query).
7. Run full verification gate and commit locally. **STOP.**

### Round 3 — Fixed Query Set, Live Smoke, Measurements & Mutation Smoke
1. Draft `tests/golden/search-queries.md` as **PROPOSED** (20 queries for `ksd-intelligence` + 20 for the M3 work repo, no proprietary source copied) and measure top-3 & top-8 recall on BOTH repos (default pass mark: ≥ 80% in top 8, 0 confirmed missing).
2. Live OMP run (`omp -p` or real `loadExtensions` + `execute`, labeled with OS + OMP version): find a feature without naming its symbol via `ei_search`, then follow with `ei_impact`.
3. Record latency p50/p95 + DB growth in `docs/research/m6a-measurements.md`.
4. Kill all 5 required mutations in `M6a-search.md` Round 3 (operators interpreted, secret file indexed, exact match not first, non-deterministic order, stale answered as fresh). **STOP.**

### Round 4 — Cross-Vendor Review & Fix
- Independent different-vendor review checking all 6 Review Focus items in `M6a-search.md`, then test-first fix round, full gates, local commit, handoff to owner.

---

## Acceptance Criteria
- [ ] Run Round 0 on the [M6a brief](../../../docs/briefs/M6a-search.md). Reconcile the draft query corpus with [DESIGN §13](../../../docs/DESIGN.md#13-roadmap-and-gates): evaluate `oh-my-pi` and the real GitLab project approved for M3. Build only after owner acceptance of the corrected brief and the relevant storage/risk decision.
- [ ] Demonstrate exact-name and lexical lookup through CLI and live OMP. Follow [RISK §6 / D49](../../../docs/RISK.md#6-skills-and-data): excluded files contribute no search rows, while indexable code under `**/secrets/**` or matching `**/*credentials*` remains searchable by name. Treat punctuation and operator-like input as data and never return stale results as fresh. Verify incremental-equals-cold and doctor coverage of the search rows.
- [ ] Run the owner-confirmed query sets on both named repositories. Report expected-hit ranks and top-3/top-8 hit rates. Each repository must meet the owner's pass criteria; a missing run or a result below the agreed pass mark blocks acceptance. Record latency, database growth, mutation and platform CI results.
- [ ] Verify no search result contributes to completeness, reach or verdict. No model, embeddings or additional runtime dependency.
- [ ] Resolve only after owner acceptance and after the accepted milestone is on `origin/main`. Record the owner decision and the resulting `origin/main` commit SHA for ticket 07. Only the owner pushes or merges.

## Common Traps to Avoid
- **Trap 1:** Forgetting to bump `SCHEMA_VERSION` in `src/storage/sqlite.ts` when adding the FTS5 table.
- **Trap 2:** Passing raw `query` into SQLite `MATCH ?` without quoting each token (crashes on `foo-bar`, `a:b`, `OR`, `NEAR`, trailing `\`).
- **Trap 3:** Failing to store `stable_key` tie-breaker → non-deterministic ordering between cold and incremental builds.
- **Trap 4:** Blocking indexable `.ts` files under `secrets/` (violates D49!) OR accidentally indexing `.env` files (violates `RISK §6`!).
