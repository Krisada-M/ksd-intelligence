# 06: Find code with lexical search

**What to build:** Deliver M6a (`ei_search` — lexical-only BM25 declaration search using built-in `node:sqlite` FTS5, zero embeddings/models/dependencies) with deterministic ranking, provenance, freshness, CLI `ei search`, OMP tool, and AGY MCP tool. **A search hit is never impact evidence.**

**Blocked by:** 05 — Review the actual change with M2c (owner accepted and merged on `origin/main`).

**Status:** round-3-complete (Rounds 0–3 verified on `m6a-search`; Round 4 independent review pending)

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

### Round 0 — Reconcile ONLY (Zero Code Changes!) ✅
1. Compare `docs/briefs/M6a-search.md` against current `main` (`sqlite.ts` schema version, `declarations.ts`, `doctor.ts`, `M3` approved repositories in `docs/dogfood-log.md`).
2. Explicitly flag the **PROPOSED `RISK.md §6` change** (storing 400-char capped signatures & first-paragraph doc comments for indexable code files only, never `.env`/excluded files) for owner approval.
3. Reconcile the two evaluation repositories (`ksd-intelligence` + the owner's M3 work repo `work-sure`) and confirm `tests/golden/search-queries.md` will be drafted as `PROPOSED` in Round 3.
4. Recorded in `.scratch/ksd-v1-readiness/evidence/06/round-0-reconcile.md`, `docs/RISK.md §6`, and `docs/DESIGN.md §15` (`D60`, `PROPOSED`).

### Round 1 — FTS5 Search Index (`src/storage/sqlite.ts`, `src/core/search/segments.ts`) ✅ (`9302b69`)
1. Implement deterministic identifier splitter (`splitIdentifier`) handling camelCase, PascalCase, snake_case, kebab paths, acronyms (`XMLHttpRequest`), digits, `$`/`_` prefixes, non-ASCII identifiers.
2. Bump `SCHEMA_VERSION` to `5` in `src/storage/sqlite.ts` and add `declarations_fts` virtual table (`stable_key UNINDEXED, name_tokens, owner_tokens, kind, signature, doc, path_tokens`).
3. Enforce D49 exclusion rules strictly (`.env*`, `*.pem`, `*.key`, excluded dirs, non-code secrets, parse-error files, and `<module>` contribute 0 rows; D49 secret-named code files remain searchable).
4. `extractorStamp` covers `segments.js`; `incremental === cold` and `ei doctor --deep` cover `declarations_fts`.

### Round 2 — Query, Ranking, CLI, OMP & AGY MCP Tool (`src/core/search/lexical.ts`, `render.ts`) ✅
1. Input validation (`query` 1–200 chars non-blank no `\0`, `limit` integer 1–20 default 8) + FTS5 literal quoting (`"..."`, `"` -> `""`) over `splitIdentifier` + raw terms.
2. Deterministic BM25 (`0.0, 25.0, 10.0, 0.5, 5.0, 3.0, 1.0`) + `exact`/`exported`/`log(1+callers)` boosts + ascending `stable_key` tie-breaker.
3. Rendered per `docs/TOOLS.md §7` (4,000-char budget, `exact`/`lexical` only, `search: lexical only` / `STALE INDEX`, zero `semantic` or install hint).
4. Registered `ei_search` across CLI (`ei search`), OMP (`extension.ts`), and AGY MCP (`scripts/mcp/tools.mjs`), with redacted/truncated `audit.jsonl` entries (`MAX_QUERY_CHARS = 200`) and all 12 Round 2 test cases in `tests/core/search-query.test.ts`.

### Round 3 — Fixed Query Set, Live Smoke, Measurements & Mutation Smoke ✅
1. Drafted `tests/golden/search-queries.md` as **PROPOSED** (`20` `ksd-intelligence` + `20` `work-sure` queries): `17/20` (`85%`) top-8 / `0` missing on `ksd-intelligence`, `20/20` (`100%`) top-8 / `0` missing on `work-sure`, `100%` `rank=1` + `exact` on all exact queries (`S01–S04`, `W01–W07`).
2. Verified live `omp -p` (`omp/19.1.0`) + Bun `1.4.2` `loadExtensions()` (`ei_search` followed by `ei_impact` + `audit.jsonl`) + CLI parity.
3. Recorded latency (`p50`/`p95` warm + cold CLI + 50k scale `p95 = 151.18 ms`) and DB growth in `docs/research/m6a-measurements.md`.
4. Killed `5 / 5` mutations (`M1–M5`, `EXIT=1`) and reverted cleanly.

### Round 4 — Cross-Vendor Review & Fix
- Independent different-vendor review checking all 6 Review Focus items in `M6a-search.md`, then test-first fix round, full gates, local commit, handoff to owner.

---

## Acceptance Criteria
- [x] Run Round 0 on the [M6a brief](../../../docs/briefs/M6a-search.md) (`round-0-reconcile.md`, `D60` + `RISK §6` flagged `PROPOSED`; stop gate waived per multi-milestone owner directive).
- [x] Demonstrate exact-name and lexical lookup through CLI and live OMP (`omp -p` + Bun `loadExtensions()`), D49 exclusion rules, FTS5 operator neutralization, stale index reporting, incremental-equals-cold, and `ei doctor --deep` coverage (`VERIFIED`).
- [x] Run the `PROPOSED` fixed query sets (`tests/golden/search-queries.md`) on both `ksd-intelligence` (`17/20` top-8, `0` missing) and `work-sure` (`20/20` top-8, `0` missing), plus latency, DB growth, and `5/5` mutation smoke in `docs/research/m6a-measurements.md` (`VERIFIED`; pending owner confirmation of `tests/golden/search-queries.md`, `RISK §6`, and macOS CI).
- [x] Verify no search result contributes to completeness, reach or verdict, and zero models/embeddings/runtime dependencies were added (`VERIFIED`).
- [ ] Resolve only after Round 4 independent review, owner acceptance (`RISK §6`, `search-queries.md`, macOS CI), and merge to `origin/main`.

## Common Traps to Avoid
- **Trap 1:** Forgetting to bump `SCHEMA_VERSION` in `src/storage/sqlite.ts` when adding the FTS5 table.
- **Trap 2:** Passing raw `query` into SQLite `MATCH ?` without quoting each token (crashes on `foo-bar`, `a:b`, `OR`, `NEAR`, trailing `\`).
- **Trap 3:** Failing to store `stable_key` tie-breaker → non-deterministic ordering between cold and incremental builds.
- **Trap 4:** Blocking indexable `.ts` files under `secrets/` (violates D49!) OR accidentally indexing `.env` files (violates `RISK §6`!).
