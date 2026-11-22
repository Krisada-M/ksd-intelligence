# M6a Round 4 — Independent Review, Forensic Audit & Fix Record

- **Date:** 2026-11-22
- **Branch Reviewed (Round 4 Iteration 1):** `m6a-search` @ `7df3459` (base `m2c-changes` @ `584e83a`; commits `9302b69` & `7df3459`)
- **Branch Remediated (Round 4 Iteration 2):** `m6a-search` @ `bf715e8`
- **Branch Remediated (Round 4 Iteration 3):** `m6a-search` (local Round 4 Iteration 3 commit; post-`bf715e8`)
- **Runtime:** Linux WSL2 `x86_64` (`6.18.58.1-microsoft-standard-WSL2`) · Node `v24.21.0` · npm `12.2.0` · Bun `1.4.2` · OMP `omp/19.1.0`
- **Model & Cross-Vendor Caveat (per `docs/briefs/README.md` & `docs/briefs/M6a-search.md`):**
  - Round 4 independent reviews and forensic audit were executed by read-only subagents running in the `Gemini` agent runtime inside Antigravity CLI — the **same model family** as the Round 0–3 and Round 4 remediation workers. True cross-vendor model diversity (an independent non-Gemini vendor model) is **`NOT VERIFIED`** in this automated local harness; the reviewers and auditor were separate read-only sessions that did not author `9302b69`, `7df3459`, `bf715e8`, or the Iteration 3 remediation commit.
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

## 2. Round 4 Iteration 2 Test-First Fixes & Re-Verification (`bf715e8`)

All Round 4 Iteration 1 findings were fixed test-first on `m6a-search` (`bf715e8`):

1. **50k `readCandidates` / `querySearch` latency optimization (`src/core/search/lexical.ts`, `tests/core/search-query.test.ts` Test 6):**
   - Added `WITH top AS (SELECT f.rowid AS id, s.key AS stable_key, -bm25(...) AS bm25_score FROM declarations_fts f JOIN symbols s ON s.id = f.rowid WHERE declarations_fts MATCH ? ORDER BY bm25_score DESC, s.key ASC LIMIT ?)` in `readCandidates`, deferring wide FTS/declaration hydration and correlated `edges` caller subqueries to `<= 500` rows.
   - Replaced unconditional second 50k `exactMatchExpr` FTS5 scan in `querySearch` with a gated `declarations` `COLLATE NOCASE` exact-match supplement (skipped when `ftsTotal <= 500 && !tokenLimitHit`), preserving existing `matchExpr` BM25 scores and adding a `> 500` buried-exact regression test without weakening Test 6 (`50,000` rows, `25` queries, `p95 < 300 ms`).
   - Post-Iteration-2 measurements (`bf715e8`): isolated `p50 = 68.22 ms`, `p95 = 83.59 ms`, `max = 91.26 ms`; full `npm test` Run 1 `p95 = 124.94 ms`, Run 2 `p95 = 110.72 ms`.
2. **Non-tautological ranking, `callerBoost`, field weights & `exactLower` tests (`tests/core/search-query.test.ts` Test 4):**
   - Replaced Test 4 with unconfounded equal-22-token 6-tier BM25 weights (`'accessor'`), IDF-invariant `'sharedPopular'` `callerBoost`, and `'TokenAlpha'` `exactCase`/`exactLower`/`lexical` tier tests; verified `8/8` mutation kills.
3. **Direct-API `\0` defense (`src/core/search/lexical.ts:61-63`, `tests/core/search-query.test.ts`):**
   - Stripped `\0` in `quoteFtsLiteral` (`term.replaceAll('\0', '').replaceAll('"', '""')`) and filtered `\0` terms from `COLLATE NOCASE` lookup, with direct `quoteFtsLiteral`, `buildFtsQuery`, and `querySearch(..., 'foo\0bar' | '\0', 8)` regression tests.
4. **Singular/plural overflow rendering (`src/core/search/render.ts:75,87`, `tests/core/search-query.test.ts`):**
   - Updated lines `75` and `87` to `plural(remaining, 'more match', 'more matches')` and added test-first verification for `(+1 more match)` vs `(+2 more matches)`.
5. **AGY MCP `ei_search` audit parity (`scripts/mcp/tools.mjs:312-320, 384-404`, `tests/core/search-query.test.ts`):**
   - Added valid integer `limit` logging on `INVALID_INPUT` audit entries and passed `validateSearchInput` (`valid.query`, `valid.limit`) to `runSearch` and `auditFieldsForSearch` (matching CLI and OMP), with parity audit test.
6. **Documentation, Protected Paths & Verification Gates:**
   - Updated `docs/research/m6a-measurements.md`, `docs/reviews/m6a-review.md`, and `.scratch/ksd-v1-readiness/issues/06-m6a-lexical-search.md`.
   - Verified `tests/golden/M2-impact-cases.md`, `src/policy/**`, `tests/policy/**`, and `tests/snapshots/**` untouched (`0` changed lines); `tests/golden/search-queries.md` remains `PROPOSED`.

---

## 3. Round 4 Iteration 2 Independent Reviews & Forensic Audit (`bf715e8`)

| Agent | Role & Scope | Verdict | Key Findings / Evidence |
|---|---|---|---|
| `teamwork_reviewer_m3_i2_1` | Read-only reviewer (`readCandidates` CTE, 29 direct-API fuzz probes, `DESIGN.md §6.11` isolation, `npm test` `726/726`) | `APPROVE` (`LOW` risk) | Verified `readCandidates` CTE `EXPLAIN QUERY PLAN`, 29 direct-API fuzz probes, `DESIGN.md §6.11` isolation, and serialized `npm test` (`726/726` pass, `50k p95 = 87.10 ms`). Noted 2 non-blocking minors: `d.simple = ? COLLATE NOCASE` triggered `SCAN d` vs `BINARY` `declarations_simple`, and `missingExactIds.length === 1 && !anyExistingExact` left `bm25Score = 0.0`. |
| `teamwork_reviewer_m3_i2_2` | Read-only reviewer (Test 4 SQLite FTS5 algebraic check, CLI/OMP/MCP audit parity, `render.ts` plural, Tests 11–14, `m6a-measurements.md`) | `APPROVE` (`LOW` risk) | Verified `726/726` `npm test` (`50k p95 = 297.20 ms` under contention / `89.98 ms` isolated), Test 4 `'accessor'`/`'sharedPopular'`/`'TokenAlpha'`, CLI/OMP/MCP audit parity, `(+1 more match)` vs `(+2 more matches)`, Tests 11–14, and `m6a-measurements.md`. |
| `teamwork_auditor_m3_i2_1` | Forensic integrity auditor (Checks 1–4 against `bf715e8`) | **`INTEGRITY VIOLATION`** (Checks 1–3 `CLEAN`; Check 4 `FAIL`) | **Checks 1–3 CLEAN:** Genuine FTS5/BM25 code, unweakened Test 6, `0` protected-path edits, `0` runtime deps, `0` network calls, `PROPOSED` labels, `0` personal paths, `work-sure` clean. **Check 4 FAIL:** Full `npm test` failed on Run 1 with `exit 1` (`725/726` pass, `50k search p95 was 305.90 ms >= 300 ms`), passing Runs 2–3 (`113.99 ms`, `90.18 ms`) and isolated (`82.91 ms`); `EXPLAIN QUERY PLAN` proved `d.simple = ? COLLATE NOCASE` (`src/core/search/lexical.ts:293-305`) could not use `BINARY` index `declarations_simple` (`src/storage/sqlite.ts:75`), causing a full `50,000`-row `SCAN d` on `ftsTotal > 500` queries. |

---

## 4. Round 4 Iteration 3 Remediation & Re-Verification

To resolve `teamwork_auditor_m3_i2_1`'s Check 4 rejection and both Iteration 2 reviewer minor observations without weakening Test 6:

1. **Schema 6 partial `COLLATE NOCASE` indexes (`src/storage/sqlite.ts:164-173`, `tests/core/status.test.ts:141`, `tests/core/search-index.test.ts:370-442`):**
   - Added migration `version: 6` (`SCHEMA_VERSION = 6`) creating `declarations_simple_nocase ON declarations (simple COLLATE NOCASE) WHERE kind != 'module'` and `declarations_name_nocase ON declarations (name COLLATE NOCASE) WHERE kind != 'module'`.
   - Updated `tests/core/status.test.ts:141` (`schema 5` -> `schema 6`) and `tests/core/search-index.test.ts` (`SCHEMA_VERSION = 6` + v4->v6 and v5->v6 auto-rebuild verification).
2. **`SCAN d` elimination, `+f.rowid IN`, conditional `COUNT(*)`, & session reuse (`src/core/search/lexical.ts`, `src/core/impact/session.ts`):**
   - Rewrote exact-match supplement predicates in `lexical.ts` from `OR` across `COLLATE NOCASE` (which still triggers SQLite `SCAN d` even with NOCASE indexes) to `d.kind != 'module' AND d.simple COLLATE NOCASE IN (...)` + `UNION` `d.kind != 'module' AND d.name COLLATE NOCASE IN (...)` when dotted/spaced terms are present.
   - Replaced `f.rowid IN (${placeholders})` with `+f.rowid IN (${placeholders})` to prevent SQLite `3.53.4` FTS5 from rewriting a 1-element `IN (?)` into `rowid = ?` (`0:=M7`, 50k scan), dropped the `anyExistingExact` loop, and guarded BM25 hydration with `missingExactIds.length > 0 && !tokenLimitHit && matchExpr !== null`.
   - Executed `readCandidates(db, matchExpr, MAX_CANDIDATES)` first and skipped `SELECT COUNT(*)` whenever `topRows.length < MAX_CANDIDATES` (`ftsTotal = topRows.length`).
   - Forwarded pre-read `meta` and `scannedFiles` (`files.length`) from `prepareSessionDb` via `SearchSessionContext` (`src/core/impact/session.ts`) into `querySearch` (preserving standalone `querySearch` fallback).
3. **`hasGitAncestor` guard (`src/core/workspace/scan.ts:197-227`):**
   - Added `hasGitAncestor(root)` (`existsSync(join(dir, '.git'))` up to `/`) before spawning `git -C root ls-files` when `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_COMMON_DIR` are unset, eliminating 25 doomed `git` spawns per Test 6 run on non-git `/tmp` repos.
4. **Regression tests & post-fix verification (`tests/core/search-query.test.ts`, `docs/research/m6a-measurements.md`):**
   - Added `EXPLAIN QUERY PLAN` non-`SCAN d` regression test across simple (`'retry'`), dotted (`'PaymentService.charge'`), and multi-word (`'find retry implementation'`) queries (`> 500` rows, zero `SCAN d`/`SCAN declarations`); strengthened Test 14 for genuinely buried single-exact `bm25Score > 1000`, buried uppercase `RETRY` (`> 900`), dotted `PaymentService.charge` (`> 1000`), and 2-match exact ranking. Preserved Test 6 (`50,000` rows, `25` queries, `stat` probe, `< 300 ms` p95) untouched.
   - Verified `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:dist`, `npm run verify:skills`, isolated `dist-test/tests/core/search-query.test.js` (`15/15`, `50k p50 = 40.11 ms / p95 = 48.69 ms / max = 48.70 ms`), **3 consecutive full `npm test` runs** (`727/727` pass on all 3: Run 1 `p50 = 57.26 / p95 = 80.25 / max = 89.97 ms`, Run 2 `p50 = 53.49 / p95 = 76.35 / max = 77.49 ms`, Run 3 `p50 = 49.91 / p95 = 64.21 / max = 68.07 ms`), `S01–S20` (`17/20` top-8, `0` missing), `W01–W20` (`20/20` top-8, `0` missing), and `7/7` re-verified mutation kills (`M1`, `M3`, `M4`, `M5`, `M6`, `M7`, `M8`, all `EXIT=1` and cleanly reverted).

---

## 5. Iteration 3 Independent Gate (`3ce2a4d`)

- Reviewers 1 and 2 and Challenger 1 reported `APPROVE`; the forensic auditor reported `CLEAN`.
- Challenger 2 reported `REJECT`: removing unary `+` from the FTS rowid filter survived the existing tests. The challenger reported 7/7 core mutations and the `OR` planner regression killed, and reproduced both proposed recall sets.
- Challenger 1 also reported a `397.26 ms` p95 under concurrent auditor load; its two uncontended runs passed.

## 6. Iteration 4 Regression Test

- `tests/core/search-query.test.ts` now asserts that each search query in the existing >500-match fixture materializes at most 500 rows per SQLite statement. This checks bounded work without depending on SQLite's query-plan encoding.
- **`VERIFIED`:** On Linux x86_64, the targeted test passed against the unmodified implementation. In a disposable copy with unary `+` removed, the same test failed: `search "retry" materialized 551 rows in one query`.
  - Clean: `./node_modules/.bin/tsc -p tests/tsconfig.json && node scripts/copy-policy-to-dist.mjs --test-tree && node --import ./tests/policy/helpers/isolated-home.js --test --test-name-pattern='bounds materialized rows' dist-test/tests/core/search-query.test.js` → `1` pass, `0` fail.
  - Mutant: remove unary `+` in a disposable copy, then run `npm run build && ./node_modules/.bin/tsc -p tests/tsconfig.json && node scripts/copy-policy-to-dist.mjs --test-tree && node --import ./tests/policy/helpers/isolated-home.js --test --test-name-pattern='bounds materialized rows' dist-test/tests/core/search-query.test.js` → exit `1`, with the expected 551-row assertion failure.
- **`VERIFIED`:** `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run check:dist`, and `npm run verify:skills` exited `0`. The full suite passed `727/727`; the 50k test reported p95 `67.07 ms`.
- **`FAIL` (PR gate):** `node scripts/check-protected-paths.mjs origin/main HEAD` exited `1` on 15 inherited paths. `git log --name-status origin/main..3ce2a4d -- tests/golden tests/snapshots src/policy tests/policy` attributes them to 10 [owner-accepted engine version footers](../../.scratch/ksd-v1-readiness/evidence/02/acceptance-record.md) (`71e30ba`), four `PROPOSED` M2c snapshots (`d790daf`), and the `PROPOSED` search query set (`7df3459`). The local patch contains zero protected changes; that does not satisfy the PR gate or waive review of the five proposals.
- `npm run verify:skills` reported the existing AGY index as degraded: schema `4`, engine expects `6`.
- **`VERIFIED` (local Challenger 2 checks):** Ran `node --import ./tests/policy/helpers/isolated-home.js --import <in-memory mutation loader> --test --test-name-pattern <case> dist-test/tests/core/search-query.test.js` per case, with no source edits. `M1`, `M3`–`M8`, `REG1`, and `REG2` each exited `1` on the expected failure (`CHALLENGER_MUTATIONS=9/9`). `REG1` materialized 551 rows; `REG2` yielded `SCAN d USING INDEX declarations_name_nocase`. `M2` was not rerun.
- **`VERIFIED` (proposed recall):** In isolated caches, `runSearch` at limits 8 and 20 gave `S01–S20` 17/20 top-8 and `W01–W20` 20/20 top-8, with zero missing. `S06` ranked third (`lexical`); all 11 exact cases ranked first (`exact`). `doctorDeep(workspace, { differential: 300 })` returned zero graph differences, counter differences, and misses on both. The `work-sure` rerun used a disposable copy of its 33 indexed desktop declarations, not a fresh whole-checkout census.
- **`NOT VERIFIED`:** Independent post-fix gate review, macOS CI / live macOS OMP, and independent non-Gemini vendor review. Owner acceptance of `tests/golden/search-queries.md`, `docs/RISK.md §6`, and `docs/DESIGN.md §15` remains `PROPOSED`.

## 7. Downstream Gate Precheck (Read-Only)

- `GIT_TERMINAL_PROMPT=0 git fetch --no-tags origin` left `origin/main` at `ac3caaa`, the merge base of `3ce2a4d`. Ticket 07 still requires owner acceptance and integration of M6a.
- Two application manifests in `work-sure` declared none of `next`, `expo-router`, or `hono`. The [M3 route census](../research/m3-work-sure-linux.md#7-route--framework-observations-for-m4a--ticket-07-gating) and [dogfood log](../dogfood-log.md) show no qualifying workflow for B1a, B1b, B1c, or B2. Recommend `SKIP ALL` when Ticket 07 opens; no owner decision is recorded.
- Ticket 08 exit is not eligible: 1/10 real tasks, 0/14 elapsed days, and no open wrong-`low` incident recorded in the log. No exit review or detector implementation started.

## 8. Independent Cross-Vendor Review (Iteration 4, post-fix)

- **Reviewer:** Anthropic `claude-opus-5` via `omp -p --no-tools --no-skills --no-rules --no-context-files --no-extensions --no-session` (print mode, no tool access, inline evidence only: brief, `lexical.ts`, `sqlite.ts`, Iteration 4 patch, ranking/REG1 test excerpts, review record §5–§7). Distinct vendor from the Gemini-authored implementation and the ZAI-authored Iteration 4 fix.
- **VERDICT: `APPROVE` for the reviewed scope** (literal FTS semantics, schema-6 mechanics, in-process determinism, ranking/REG1 validity, `Outcome` shape, search independence). Quoted on REG1: "a valid, correctly-targeted kill for the `+f.rowid IN` regression and is not defeasible by LIMIT pushdown".
- Findings and dispositions (all non-blocking per the reviewer; verified locally against source):
  - Zero-token FTS `MATCH` crash risk (**ruled out**): `splitIdentifier` strips every non-letter/digit, so no quoted token can tokenize to zero tokens; runtime probe on `7426969` returned clean `result` with 0 hits for `!!!`, `??? ...`, `__`, `a.b.c`, `-`, `NEAR OR (1)`, `signature: retry*`; whitespace-only query rejected as `INVALID_INPUT`. `VERIFIED`.
  - `totalMatches` can under-report supplement-only rows on 33+ term queries (`Math.max(ftsTotal, candidates.size)`): confirmed by reading; recorded as a lower-bound approximation. NIT, fix-forward.
  - `callers` counts edges, not distinct sources (`COUNT(*) FROM edges`, kinds `IMPORTS`/`TESTS` excluded; PK `source,target,kind`): one symbol contributing `EXTENDS` + `CALLS` counts twice, inflating `callerBoost` and the rendered "n callers" fact. Suggested remedy `COUNT(DISTINCT e.source)`. MINOR, fix-forward — changing ranking now would invalidate the proposed golden oracle; owner decides with `tests/golden/search-queries.md` acceptance.
  - Config-disabled search returns `code: 'index-failed'` (`lexical.ts` `runSearch`, `search.enabled === false` branch) with a clear message but a misleading, rebuild-implying code. MINOR, fix-forward (needs an `Outcome` code union + renderer + `TOOLS.md` contract change).
  - Unknown `indexState` values fall through to `'fresh'` in `runSearch`: **latent only** — `prepareSessionDb` pairs `failed`/`building` exclusively with `db === null`, which routes to the failure/guidance branches; `VERIFIED` by reading `session.ts` `prepareSessionDb` in full. Remedy if the state union ever grows: exhaustive mapping defaulting to `stale`.
  - REG1 robustness: threshold `500` decoupled from `MAX_CANDIDATES` (now documented in-test), and a compound mutant (drop `+` **and** add `LIMIT`) evaded REG1 while being caught only by the sibling test's `score > 1000`. Fixed in Iteration 5: REG1 now asserts each exact hit's `score > 1000` itself.
- Reviewer `LIMITS` (not re-checked here): FTS population/publish path, D49 content caps, audit writer, renderer/TOOLS text, CLI/MCP registration, golden oracle, and all execution evidence.
