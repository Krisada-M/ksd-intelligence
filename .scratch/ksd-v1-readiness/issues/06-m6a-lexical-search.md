# 06: Find code with lexical search

**What to build:** Deliver M6a (`ei_search` — lexical-only BM25 declaration search using built-in `node:sqlite` FTS5, zero embeddings/models/dependencies) with deterministic ranking, provenance, freshness, CLI `ei search`, OMP tool, and AGY MCP tool. **A search hit is never impact evidence.**

**Blocked by:** 05 — Review the actual change with M2c (owner accepted and merged on `origin/main`).

**Status:** Round 4 Iteration 4 local verification complete: the 7 core Challenger 2 mutants and both planner regressions were killed, and proposed recall targets held. Independent post-fix review, owner acceptance of `RISK §6` / `tests/golden/search-queries.md`, the `owner-approved` PR gate, and platform CI remain pending. See [the review record](../../../docs/reviews/m6a-review.md#6-iteration-4-regression-test).

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
3. Recorded latency (`p50`/`p95` warm + cold CLI + 50k scale) and DB growth in `docs/research/m6a-measurements.md`.
4. Killed `5 / 5` mutations (`M1–M5`, `EXIT=1`) and reverted cleanly.

### Round 4 — Cross-Vendor Review & Fix (Iteration 4 Test Fix; Gate Re-Audit Pending)
- [x] Iteration 1 read-only reviews (`teamwork_reviewer_m3_1_2`, `teamwork_reviewer_m3_2_2`) & forensic audit (`teamwork_auditor_m3_1_2`) at `7df3459` recorded in `docs/reviews/m6a-review.md` §1 (same-vendor `Gemini` model caveat noted).
- [x] Iteration 2 test-first fixes (`bf715e8`): 50k `readCandidates`/`querySearch` optimization (`src/core/search/lexical.ts`), non-tautological `callerBoost`/BM25 weight/`exactLower` tests (`tests/core/search-query.test.ts` Test 4), `quoteFtsLiteral` `\0` stripping + direct-API tests, `render.ts` `(+1 more match)` singular/plural, and `scripts/mcp/tools.mjs` audit parity.
- [x] Iteration 2 Gate (`bf715e8`): `teamwork_reviewer_m3_i2_1` & `teamwork_reviewer_m3_i2_2` `APPROVE`; `teamwork_auditor_m3_i2_1` **`INTEGRITY VIOLATION`** (Checks 1–3 `CLEAN`; Check 4 `FAIL` — `npm test` Run 1 `305.90 ms >= 300 ms`, linked to unindexed `COLLATE NOCASE` `SCAN d`).
- [x] Iteration 3 test-first remediation & re-verification on Linux WSL2 `x86_64`: Schema 6 partial `COLLATE NOCASE` indexes (`src/storage/sqlite.ts`), `IN`/`UNION` + `+f.rowid IN` + single-hit `bm25Score` + conditional `COUNT(*)` (`src/core/search/lexical.ts`), `SearchSessionContext` `meta`/`scannedFiles` reuse (`src/core/impact/session.ts`), `hasGitAncestor` guard (`src/core/workspace/scan.ts`), `EXPLAIN QUERY PLAN` non-`SCAN d` + buried single-exact/uppercase and dotted tests (`tests/core/search-query.test.ts`) + v4/v5->v6 rebuild (`tests/core/search-index.test.ts`) + `schema 6` (`tests/core/status.test.ts`). Verified `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:dist`, `npm run verify:skills`, isolated `search-query.test.js` (`15/15`, `50k p95 = 48.69 ms`), **3 consecutive full `npm test` runs** (`727/727` pass on all 3: `50k p95 = 80.25 / 76.35 / 64.21 ms`, `< 300 ms`), re-measured `docs/research/m6a-measurements.md`, and `8/8` mutation kills (`M1`, `M3`–`M8` re-verified post-Iteration 3; `M2` from Round 3).
- [x] Iteration 3 gate at `3ce2a4d`: two reviewers and Challenger 1 approved, the forensic auditor was clean, and Challenger 2 rejected because the FTS rowid-filter regression survived.
- [x] Iteration 4 regression test: the unmodified code passes; removing unary `+` fails with 551 materialized rows in the >500-match fixture.
- [x] Iteration 4 local Challenger 2 recheck: 9/9 mutants killed (`M1`, `M3`–`M8`, `REG1`, `REG2`); schema-6 recall `17/20` and `20/20` top-8 with `0` missing, including `S06` rank 3.
- [ ] Post-fix Iteration 4 independent gate review and forensic audit (`NOT VERIFIED`).
- [ ] Protected-path PR gate failed on 15 inherited paths: 10 approved release footers, four proposed M2c snapshots, and the proposed search oracle. Iteration 4 changes none; the owner's PR label is still required.
- [ ] Independent non-Gemini vendor review (`NOT VERIFIED` — executed in separate read-only sessions on the same `Gemini` runtime family inside Antigravity CLI).
- [ ] macOS CI / live macOS OMP verification (`NOT VERIFIED` — Linux WSL2 `x86_64` host only).

---

## Acceptance Criteria
- [x] Run Round 0 on the [M6a brief](../../../docs/briefs/M6a-search.md) (`round-0-reconcile.md`, `D60` + `RISK §6` flagged `PROPOSED`; stop gate waived per multi-milestone owner directive).
- [x] Demonstrate exact-name and lexical lookup through CLI and live OMP (`omp -p` + Bun `loadExtensions()`), D49 exclusion rules, FTS5 operator neutralization, stale index reporting, incremental-equals-cold, and `ei doctor --deep` coverage (`VERIFIED`).
- [x] Run the `PROPOSED` fixed query sets (`tests/golden/search-queries.md`) on both `ksd-intelligence` (`17/20` top-8, `0` missing) and `work-sure` (`20/20` top-8, `0` missing), plus latency, DB growth, and `8/8` mutation smoke in `docs/research/m6a-measurements.md` (`VERIFIED`; pending owner confirmation of `tests/golden/search-queries.md`, `RISK §6`, and macOS CI).
- [x] Verify no search result contributes to completeness, reach or verdict, and zero models/embeddings/runtime dependencies were added (`VERIFIED`).
- [ ] Resolve only after Round 4 independent review, owner acceptance (`RISK §6`, `search-queries.md`, macOS CI), and merge to `origin/main`.

## Common Traps to Avoid
- **Trap 1:** Forgetting to bump `SCHEMA_VERSION` in `src/storage/sqlite.ts` when adding the FTS5 table.
- **Trap 2:** Passing raw `query` into SQLite `MATCH ?` without quoting each token (crashes on `foo-bar`, `a:b`, `OR`, `NEAR`, trailing `\`).
- **Trap 3:** Failing to store `stable_key` tie-breaker → non-deterministic ordering between cold and incremental builds.
- **Trap 4:** Blocking indexable `.ts` files under `secrets/` (violates D49!) OR accidentally indexing `.env` files (violates `RISK §6`!).

---

## Comments

### 2026-11-22 — Rounds 0–3 Complete on `m6a-search` (`9302b69`, `7df3459`)
- Implemented Round 0 (`round-0-reconcile.md`, `D60`, `RISK §6` `PROPOSED`), Round 1 (`SCHEMA_VERSION = 5`, `declarations_fts`, `segments.ts`, D49 exclusions, `ei doctor --deep`), Round 2 (`lexical.ts`, `render.ts`, CLI/OMP/AGY MCP `ei_search`, redacted `audit.jsonl`), and Round 3 (`tests/golden/search-queries.md` `PROPOSED`, `omp -p` + Bun `loadExtensions()` live smoke, `docs/research/m6a-measurements.md`).

### 2026-11-22 — Round 4 Iteration 1 Findings & Iteration 2 Remediation (`m6a-search` @ `bf715e8`)
- Iteration 1 read-only reviews and forensic audit (`docs/reviews/m6a-review.md` §1) rejected `7df3459` because Test 6 (`50,000 declarations ... p95 < 300 ms`) failed deterministically (`455.15–1114.70 ms >= 300 ms`), `quoteFtsLiteral`/`querySearch` threw on direct `\0`, Test 4 had tautological `callerBoost`/confounded BM25 checks, `render.ts` used `(+1 more matches)`, `scripts/mcp/tools.mjs` omitted `limit` on `INVALID_INPUT` / trimmed parity on `ei_search` audit, and `m6a-measurements.md` lacked `NOT VERIFIED` host/vendor notes.
- Iteration 2 (`bf715e8`) applied test-first fixes (`src/core/search/{lexical,render}.ts`, `scripts/mcp/tools.mjs`, `tests/core/search-query.test.ts`), verified `726/726` pass across two full `npm test` runs, and killed `8/8` mutations (`M1–M8`).

### 2026-11-22 — Round 4 Iteration 2 Gate & Iteration 3 Remediation (`m6a-search`)
- Iteration 2 reviewers (`teamwork_reviewer_m3_i2_1`, `teamwork_reviewer_m3_i2_2`) approved `bf715e8` with 2 minor observations (`SCAN d` on `COLLATE NOCASE`, single-hit buried `bm25Score = 0.0`), while `teamwork_auditor_m3_i2_1` issued **`INTEGRITY VIOLATION`** because `npm test` Run 1 failed (`305.90 ms >= 300 ms`) under parallel contention + unindexed `SCAN d`.
- Iteration 3 eliminated `SCAN d` via Schema 6 partial `COLLATE NOCASE` indexes (`sqlite.ts`) + `IN`/`UNION` (`lexical.ts`), fixed SQLite FTS5 `+f.rowid IN` + buried single-hit `bm25Score`, added conditional `COUNT(*)`, reused `meta`/`scannedFiles` via `SearchSessionContext` (`session.ts`), added `hasGitAncestor` guard (`scan.ts`), added `EXPLAIN QUERY PLAN` non-`SCAN d` + strengthened Test 14 + v5->v6 rebuild tests, re-measured Schema 6 (`50k` isolated `p95 = 48.69 ms`, 3 consecutive `npm test` `727/727` pass with `p95 = 80.25 / 76.35 / 64.21 ms`, `S01–S20` `17/20`, `W01–W20` `20/20`, `0/40` missing), and re-verified `7/7` mutation kills (`M1`, `M3`–`M8`).
- **Remaining Gates:** Post-fix Iteration 4 independent gate review, independent non-Gemini vendor review (`NOT VERIFIED`), macOS CI / live macOS OMP (`NOT VERIFIED`), and owner acceptance of `RISK §6` and `tests/golden/search-queries.md` (`PROPOSED`).
