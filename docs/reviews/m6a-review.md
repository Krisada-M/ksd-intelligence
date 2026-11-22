# M6a Round 4 — Independent Review, Forensic Audit & Fix Record

- **Date:** 2026-11-22
- **Branch Reviewed (Round 4 Iteration 1):** `m6a-search` @ `7df3459` (base `m2c-changes` @ `584e83a`; commits `9302b69` & `7df3459`)
- **Branch Remediated (Round 4 Iteration 2):** `m6a-search` (local Round 4 Iteration 2 commit)
- **Runtime:** Linux WSL2 `x86_64` (`6.18.58.1-microsoft-standard-WSL2`) · Node `v24.21.0` · npm `12.2.0` · Bun `1.4.2` · OMP `omp/19.1.0`
- **Model & Cross-Vendor Caveat (per `docs/briefs/README.md` & `docs/briefs/M6a-search.md`):**
  - Round 4 independent reviews and forensic audit were executed by read-only subagents running in the `Gemini` agent runtime inside Antigravity CLI — the **same model family** as the Round 0–3 and Round 4 remediation workers. True cross-vendor model diversity (an independent non-Gemini vendor model) is **`NOT VERIFIED`** in this automated local harness; the reviewers and auditor were separate read-only sessions that did not author `9302b69`, `7df3459`, or the Round 4 remediation commit.
  - Host boundaries unchanged: `macOS CI / live macOS OMP` (`NOT VERIFIED` on Linux WSL2 `x86_64`).
  - Owner-approval boundaries unchanged: `tests/golden/search-queries.md` (`PROPOSED`), `docs/RISK.md §6` (`PROPOSED` D60 exception), and `docs/DESIGN.md §15` (`D60`, `PROPOSED`) remain `PROPOSED` awaiting owner confirmation.

---

## 1. Round 4 Iteration 1 Independent Reviews & Forensic Audit (`7df3459`)

| Agent | Role & Scope | Verdict | Key Findings / Evidence |
|---|---|---|---|
| `teamwork_reviewer_m3_1_2` | Read-only reviewer & adversarial critic (`M6a-search.md` Focus #1, #2, #3, #6; `lexical.ts`, `segments.ts`, `sqlite.ts`, `records.ts`, `stamp.ts`, `verify.ts`, `doctor.ts`, `scan.ts`, `DESIGN §6.11` isolation) | `REQUEST_CHANGES` | **Major Finding 1:** `tests/core/search-query.test.ts:560` Test 6 (`50,000 declarations ... p95 < 300 ms`) failed deterministically (`455.15 ms` in `npm test`, `557.39 ms` isolated) because `readCandidates` (`lexical.ts:140-167`) joined `symbols`/`declarations` + correlated `edges` subquery before `LIMIT`, and `querySearch` ran two 50k FTS5 `bm25()` queries. **Minor Finding 2:** Direct library calls to exported `quoteFtsLiteral` / `querySearch` (`lexical.ts:61-63`, `src/index.ts:196-198`) threw `Error: unterminated string` on `\0` (tool adapters blocked `\0` via `validateSearchInput`). **Info Finding 3:** `docs/reviews/m6a-review.md` missing and `06-m6a-lexical-search.md` still at `round-3-complete`. Verified clean: Focus #1 (47-input FTS5 fuzz probe: 0 operator bypasses), Focus #2 (400-char caps, first-paragraph JSDoc, D49 exclusions), Focus #3 (`SCHEMA_VERSION = 5`, `segments.js` stamp, `deleteFileRecords`, `recordWriter`, `CANONICAL`, `doctorDeep`), Focus #6 (0 `search` imports in `impact/`, `changes/`, `verdict.ts`, `src/policy/**`). |
| `teamwork_reviewer_m3_2_2` | Read-only reviewer & adversarial critic (`M6a-search.md` Focus #4 ranking/scale, #5 `TOOLS.md §7` rendering/budget/no-`semantic`; CLI/OMP/MCP parity; `EI_DISABLED=1`; `audit/log.ts`; docs & personal paths) | `REQUEST_CHANGES` | **Critical Finding 1:** Confirmed Test 6 failure (`496.87 ms` `npm test`, `527.71 ms` isolated) and proved via SQLite `EXPLAIN QUERY PLAN` that `readCandidates` scanned/joined all 50,000 rows (`USE TEMP B-TREE FOR ORDER BY`) before `LIMIT 500`, plus a 50k `COUNT(*)`. **Major Finding 2:** `callerBoost` (`Math.log(1 + callers) * 0.5`) was tautologically untested in `tests/core/search-query.test.ts` Test 4 (`popularFn` vs `unpopularFn` tied on BM25/exact/exported and passed via `'src/boosts.ts#popularFn' < 'src/boosts.ts#unpopularFn'`); `name_tokens > owner_tokens` compared an `exact` (`+1000`) hit against a non-exact hit (`beacon` vs `Beacon.memberFn`); `Beacon.memberFn` vs `sigMatch` was confounded by token count (`2` vs `4`); `kind` (`0.5`) and `exactLower` (`900`) lacked direct tests. **Minor Finding 3:** `render.ts:75,87` always used `(+N more matches)` for `remaining === 1`; `scripts/mcp/tools.mjs:312,399` omitted integer `limit` on `INVALID_INPUT` audit entries and passed untrimmed `args.query` / `args.limit` on `runSearch` failure/guidance; `docs/research/m6a-measurements.md` lacked explicit `NOT VERIFIED: macOS CI / live macOS OMP`; `m6a-review.md` and `06-m6a-lexical-search.md` pending. Verified clean: `exact` first, `exported` boost, `signature > doc > path`, `stable_key` tie-breaker (`Test 5`), `TOOLS.md §7` rendering/4,000-char budget/no-`semantic`, CLI/OMP/MCP parity, `EI_DISABLED=1`, audit redaction, zero personal paths. |
| `teamwork_auditor_m3_1_2` | Forensic integrity auditor (Checks 1–4: diff forensics, protected paths, deps, network, `PROPOSED` labels, personal paths, `work-sure` cleanliness, independent test execution) | `INTEGRITY VIOLATION` (Check 4 failed; Checks 1–3 `CLEAN`) | **Checks 1–3 CLEAN:** Genuine FTS5 + BM25 code, `0` edits to `tests/golden/M2-impact-cases.md`, `src/policy/**`, `tests/policy/**`, `tests/snapshots/**`, `package.json` unchanged, zero network calls, `PROPOSED` labels present, zero personal home paths, `work-sure` `git status --short` clean. **Check 4 FAIL:** `dist-test/tests/core/search-query.test.js` Test 6 failed reproducibly in 3/3 runs (`1114.70 ms` concurrent, `735.01 ms` isolated, `859.94 ms` in `npm test` — `724/725` pass, `1` fail), invalidating the prior `725/725 pass` and `50k p95 = 151.18 ms` claim. |

---

## 2. Round 4 Iteration 2 Test-First Fixes & Re-Verification

All Round 4 Iteration 1 findings were fixed test-first on `m6a-search`:

1. **50k `readCandidates` / `querySearch` latency optimization (`src/core/search/lexical.ts`, `tests/core/search-query.test.ts` Test 6):**
   - Added `WITH top AS (SELECT f.rowid AS id, s.key AS stable_key, -bm25(...) AS bm25_score FROM declarations_fts f JOIN symbols s ON s.id = f.rowid WHERE declarations_fts MATCH ? ORDER BY bm25_score DESC, s.key ASC LIMIT ?)` in `readCandidates`, deferring wide FTS/declaration hydration and correlated `edges` caller subqueries to `<= 500` rows.
   - Replaced unconditional second 50k `exactMatchExpr` FTS5 scan in `querySearch` with a gated `declarations` `COLLATE NOCASE` exact-match supplement (skipped when `ftsTotal <= 500 && !tokenLimitHit`), preserving existing `matchExpr` BM25 scores and adding a `> 500` buried-exact regression test without weakening Test 6 (`50,000` rows, `25` queries, `p95 < 300 ms`).
   - Re-measured `50k` Test 6 (`VERIFIED`): isolated `p50 = 68.22 ms`, **`p95 = 83.59 ms`**, `max = 91.26 ms` (`14/14` pass); full `npm test` Run 1 `p50 = 87.84 ms`, **`p95 = 124.94 ms`**, `max = 127.99 ms`; Run 2 `p50 = 85.82 ms`, **`p95 = 110.72 ms`**, `max = 111.45 ms`.
   - Re-measured `ksd-intelligence` (`17/20` top-8, `0/20` missing; warm `p50 = 16.60 ms`, `p95 = 19.36 ms`; cold CLI median `132.54 ms`) and `work-sure` (`20/20` top-8, `0/20` missing; warm `p50 = 79.69 ms`, `p95 = 88.34 ms`; cold CLI median `228.91 ms`) in `docs/research/m6a-measurements.md`.
2. **Non-tautological ranking, `callerBoost`, field weights & `exactLower` tests (`tests/core/search-query.test.ts` Test 4):**
   - Replaced Test 4 with unconfounded equal-22-token 6-tier BM25 weights (`'accessor'`), IDF-invariant `'sharedPopular'` `callerBoost`, and `'TokenAlpha'` `exactCase`/`exactLower`/`lexical` tier tests.
   - Re-verified `8/8` mutation kills (`M1`, `M3`, `M4`, `callerBoost = 0`, flat `(0,1,1,1,1,1,1)` BM25, and `exactCase = 900` executed post-fix, all `EXIT=1` and cleanly reverted; `M2` and `M5` unchanged from Round 3).
3. **Direct-API `\0` defense (`src/core/search/lexical.ts:61-63`, `tests/core/search-query.test.ts`):**
   - Stripped `\0` in `quoteFtsLiteral` (`term.replaceAll('\0', '').replaceAll('"', '""')`) and filtered `\0` terms from `COLLATE NOCASE` lookup, with direct `quoteFtsLiteral`, `buildFtsQuery`, and `querySearch(..., 'foo\0bar' | '\0', 8)` regression tests.
4. **Singular/plural overflow rendering (`src/core/search/render.ts:75,87`, `tests/core/search-query.test.ts`):**
   - Updated lines `75` and `87` to `plural(remaining, 'more match', 'more matches')` and added test-first verification for `(+1 more match)` vs `(+2 more matches)`.
5. **AGY MCP `ei_search` audit parity (`scripts/mcp/tools.mjs:312-320, 384-404`, `tests/core/search-query.test.ts`):**
   - Added valid integer `limit` logging on `INVALID_INPUT` audit entries and passed `validateSearchInput` (`valid.query`, `valid.limit`) to `runSearch` and `auditFieldsForSearch` (matching CLI and OMP), with parity audit test.
6. **Documentation, Protected Paths & Verification Gates:**
   - Updated `docs/research/m6a-measurements.md` (with post-fix re-measurements and explicit `NOT VERIFIED` boundaries), `docs/reviews/m6a-review.md`, and `.scratch/ksd-v1-readiness/issues/06-m6a-lexical-search.md`.
   - Verified `tests/golden/M2-impact-cases.md`, `src/policy/**`, `tests/policy/**`, and `tests/snapshots/**` remain untouched (`0` changed lines); `tests/golden/search-queries.md` remains `PROPOSED`.

---

## 3. Iteration 2 Independent Re-Verification & Forensic Audit (`PENDING`)

- **`NOT VERIFIED` (pending Iteration 2 Gate re-audit):** Independent Round 4 Iteration 2 re-review and forensic audit on the post-fix commit have not yet completed at the time of this commit; this section will be finalized once the independent Iteration 2 auditor and reviewer issue their post-fix verdicts.
