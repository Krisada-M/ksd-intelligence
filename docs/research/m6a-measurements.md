# M6a Rounds 3 & 4 — Fixed Query Recall, Latency, DB Growth, Live Smoke & Mutation Report

- **Date:** 2026-11-22
- **Branch / Engine:** `m6a-search` · engine `0.2.0` · schema `5`
- **Runtime:** Linux WSL2 `x86_64` (`6.18.58.1-microsoft-standard-WSL2`) · Node `v24.21.0` · npm `12.2.0` · Bun `1.4.2` · OMP `omp/19.1.0` · TypeScript `5.9.3` (runtime)
- **Safety / Isolation:**
  - All `work-sure` measurements ran on a disposable `/tmp/m6a-*` copy with an isolated temporary `HOME` cache (`runtime/` symlinked); both temporary directories were deleted afterward (`trap`) and the read-only `work-sure` checkout remained completely unmodified (`git status --short` clean).
  - All live smoke checks (`omp -p`, Bun `loadExtensions()`, CLI parity) ran on a disposable `/tmp/m6a-*` copy of `ksd-intelligence` with an isolated temporary `HOME`; both were deleted afterward.
  - Zero personal paths and zero proprietary `work-sure` code snippets appear in this document or `tests/golden/search-queries.md`.
- **Verification Scope & `NOT VERIFIED` Boundaries:**
  - `VERIFIED` only on Linux WSL2 `x86_64` (`Node v24.21.0`, `Bun 1.4.2`, `OMP omp/19.1.0`).
  - **`NOT VERIFIED: macOS CI / live macOS OMP`** — macOS CI workflow and live macOS OMP runtime were not available on this host and require owner verification on macOS / CI push.
  - **`NOT VERIFIED: independent non-Gemini vendor review`** — Round 4 reviews and audit ran in separate read-only sessions on the same `Gemini` runtime family inside Antigravity CLI.

---

## 1. Database Growth (Schema 4 vs Schema 5 FTS5) — `VERIFIED`

| Repository | Indexed Declarations (non-`<module>`) | Pre-FTS5 Size (Schema 4) | Post-FTS5 Size (Schema 5) | Delta / Growth | `ei doctor --deep --differential 300` |
|---|---|---|---|---|---|
| `ksd-intelligence` (`m6a-search` same-tree `DROP TABLE declarations_fts; VACUUM;` vs schema 5, R1) | `2,268` (R1) | `2,508 KB` (`2,568,192` B) | `3,508 KB` (`3,592,192` B) | `+1,000 KB` (`+1,024,000` B, `+39.87%`) | `0` differences, `0` counterDifferences, `0` misses |
| `ksd-intelligence` (`m6a-search` after R2 additions) | `2,355` (R3) | `2,324 KB` (M3 baseline @ `45cea76`, `1,950` decls) | `3,596 KB` (`3,682,304` B) | `+1,272 KB` (includes M2c+M6a new files) | `0` differences, `0` counterDifferences, `0` misses |
| `work-sure` (`5` indexable `.ts` files, `8,434` scanned) | `33` (`33` FTS rows) | `2,216 KB` (`2,269,184` B) | `2,236 KB` (`2,289,664` B) | `+20 KB` (`+20,480` B, `+0.90%`) | `0` differences, `0` counterDifferences, `0` misses |

---

## 2. Fixed Query Set Recall (`tests/golden/search-queries.md`, `PROPOSED`) — `VERIFIED`

Evaluated at `limit = 8` (primary recall window) and `limit = 20` (missing check).

### 2.1 Summary

| Repository | Top-3 Share | Top-8 Share (Pass Mark `>= 16/20`) | Missing (`rank > 20` or absent; Gate `= 0`) | Exact Queries (`rank = 1`, `kind = 'exact'`) |
|---|---:|---:|---:|---|
| `ksd-intelligence` (`S01–S20`) | **13 / 20 (65%)** | **17 / 20 (85%)** | **0 / 20** | **4 / 4 (`S01–S04`)** |
| `work-sure` (`W01–W20`) | **20 / 20 (100%)** | **20 / 20 (100%)** | **0 / 20** | **7 / 7 (`W01–W07`)** |

*Note on `S15–S17` signatures:* Verified in `declarations_fts.signature` that union/interface bodies are stored cleanly within the 400-character cap:
- `FailureCode` (`S15`, rank `1`): `"export type FailureCode = 'index-failed' | 'INVALID_INPUT' | 'HASH_MISMATCH' | 'PATH_ESCAPE' | 'LOCK_INVALID';"`
- `GapCode` (`S16`, rank `1`): `"export type GapCode = | 'dynamic-import' | 'computed-member-access' | 'interface-dispatch' | 'cjs-require' | 'parse-error';"`
- `UnresolvedRecord` (`S17`, rank `4`): `"export interface UnresolvedRecord { file: string; line: number; name: string; reason: 'unresolved-import' | 'unresolved-name-match'; source: string; }"`

*Graph-proximity decision (`M6a-search.md` Round 2 / `DESIGN §6.11`):* Left out because both reference repositories already meet the 80% top-8 pass mark (`85%` and `100%`) with `0` missing declarations under BM25 + exact/exported/log-caller boosts alone.

### 2.2 `ksd-intelligence` (`S01–S20`)

| ID | Query | Expected Target | Rank (`limit=8` / `20`) | Match Kind | Total Matches | Top-1 Hit (when rank > 1) |
|---|---|---|---:|---|---:|---|
| S01 | `deriveVerdict` | `src/core/kernel/verdict.ts#deriveVerdict` | **1** | `exact` | 32 | — |
| S02 | `acquireBuildLock` | `src/core/engine/lock.ts#acquireBuildLock` | **1** | `exact` | 147 | — |
| S03 | `fileDeclarations` | `src/core/indexing/declarations.ts#fileDeclarations` | **1** | `exact` | 311 | — |
| S04 | `ImpactSession` | `src/core/impact/session.ts#ImpactSession` | **1** | `exact` | 356 | — |
| S05 | `holder alive` | `src/core/engine/lock.ts#isHolderAlive` | **2** | `lexical` | 17 | `tests/core/lock.test.ts#HOLDER` |
| S06 | `sanitize audit text` | `src/core/audit/log.ts#sanitizeAuditText` | **3** | `lexical` | 172 | `src/workflow/types.ts#LoadedSkill.text` |
| S07 | `matched risk zones` | `src/core/kernel/verdict.ts#matchedRiskZones` | **9** (outside top-8) | `lexical` | 52 | `src/core/kernel/types.ts#Verdict.zones` |
| S08 | `schema_version` | `src/storage/sqlite.ts#SCHEMA_VERSION` | **1** | `exact` | 68 | — |
| S09 | `max_audit_bytes` | `src/core/audit/log.ts#MAX_AUDIT_BYTES` | **1** | `exact` | 141 | — |
| S10 | `default_risk_zones` | `src/core/kernel/config.ts#DEFAULT_RISK_ZONES` | **1** | `exact` | 80 | — |
| S11 | `classify task workflow` | `src/workflow/classify.ts#classifyTask` | **8** | `lexical` | 533 | `src/workflow/router.ts#RouteInput.task` |
| S12 | `parse project config` | `src/core/kernel/config.ts#parseProjectConfig` | **5** | `lexical` | 142 | `src/core/workspace/init.ts#InitProjectResult.config` |
| S13 | `differential find references` | `src/core/indexing/differential.ts#differential` | **3** | `exact` | 41 | `src/core/indexing/differential.ts#DifferentialReport.references` |
| S14 | `stat probe freshness drift` | `src/core/workspace/probe.ts#probe` | **2** | `exact` | 60 | `src/core/workspace/probe.ts#ProbeResult.freshness` |
| S15 | `index-failed INVALID_INPUT` | `src/core/kernel/types.ts#FailureCode` | **1** | `lexical` | 160 | — |
| S16 | `computed-member-access interface-dispatch` | `src/core/indexing/resolve.ts#GapCode` | **1** | `lexical` | 237 | — |
| S17 | `unresolved-name-match` | `src/core/indexing/resolve.ts#UnresolvedRecord` | **4** | `lexical` | 126 | `src/core/indexing/resolve.ts#UnresolvedRecord.reason` |
| S18 | `audit summary render` | `src/core/audit/summary.ts#renderAuditSummary` | **8** | `lexical` | 207 | `src/workflow/packs.ts#SKILL_PACKS.matt-sdlc.summary` |
| S19 | `changes git base ref` | `src/core/changes/git.ts#validateBaseRef` | **9** (outside top-8) | `lexical` | 156 | `src/core/changes/changes.ts#ChangesOptions.base` |
| S20 | `agy skills config` | `src/adapters/agy/skills.ts#buildAgySkillsConfig` | **15** (outside top-8) | `lexical` | 213 | `src/core/kernel/config.ts#ProjectConfig.skills` |

### 2.3 `work-sure` (`W01–W20`)

| ID | Query | Expected Target | Rank (`limit=8` / `20`) | Match Kind | Total Matches | Top-1 Hit (when rank > 1) |
|---|---|---|---:|---|---:|---|
| W01 | `serverErrorMessage` | `desktop/src/status.ts#serverErrorMessage` | **1** | `exact` | 13 | — |
| W02 | `goToServer` | `desktop/src/main.ts#goToServer` | **1** | `exact` | 13 | — |
| W03 | `renderRemembered` | `desktop/src/main.ts#renderRemembered` | **1** | `exact` | 3 | — |
| W04 | `renderServers` | `desktop/src/prefs.ts#renderServers` | **1** | `exact` | 4 | — |
| W05 | `setStatus` | `desktop/src/main.ts#setStatus` | **1** | `exact` | 2 | — |
| W06 | `autostart` | `desktop/src/prefs.ts#autostart` | **1** | `exact` | 1 | — |
| W07 | `unreachable` | `desktop/src/strings.ts#S.unreachable` | **1** | `exact` | 1 | — |
| W08 | `server label` | `desktop/src/strings.ts#S.serverLabel` | **3** | `lexical` | 12 | `desktop/src/main.ts#ServerEntry.label` |
| W09 | `url placeholder` | `desktop/src/strings.ts#S.urlPlaceholder` | **3** | `lexical` | 7 | `desktop/src/main.ts#ServerEntry.url` |
| W10 | `invalid url` | `desktop/src/strings.ts#S.invalidUrl` | **3** | `lexical` | 7 | `desktop/src/main.ts#ServerEntry.url` |
| W11 | `launch at login` | `desktop/src/strings.ts#P.launchAtLogin` | **1** | `lexical` | 2 | — |
| W12 | `switch to` | `desktop/src/strings.ts#P.switchTo` | **1** | `lexical` | 3 | — |
| W13 | `main connect rawUrl` | `desktop/src/main.ts#connect` | **1** | `exact` | 16 | — |
| W14 | `main boot` | `desktop/src/main.ts#boot` | **1** | `exact` | 10 | — |
| W15 | `main fill` | `desktop/src/main.ts#fill` | **1** | `exact` | 10 | — |
| W16 | `prefs ServerEntry` | `desktop/src/prefs.ts#ServerEntry` | **1** | `exact` | 15 | — |
| W17 | `main ServerEntry url` | `desktop/src/main.ts#ServerEntry.url` | **2** | `exact` | 20 | `desktop/src/main.ts#ServerEntry` |
| W18 | `prefs ServerEntry label` | `desktop/src/prefs.ts#ServerEntry.label` | **1** | `exact` | 15 | — |
| W19 | `strings checking` | `desktop/src/strings.ts#S.checking` | **1** | `exact` | 16 | — |
| W20 | `strings P servers` | `desktop/src/strings.ts#P.servers` | **1** | `exact` | 17 | — |

---

## 3. Search Latency (`p50` / `p95`, Warm Probe + Cold CLI + 50k Scale) — `VERIFIED` (Post-Round 4 Fix)

| Benchmark | Sample Size | `p50` | `p95` | Notes |
|---|---|---:|---:|---|
| `ksd-intelligence` warm `runSearch(limit=8)` (incl. `stat` probe) | `3 x 20 = 60` calls | **16.60 ms** | **19.36 ms** | Runs 1/2/3 `p50`: `16.45 / 17.03 / 16.26 ms`; `p95`: `18.85 / 20.00 / 19.04 ms` |
| `ksd-intelligence` cold CLI `ei search ... --json` | `3` invocations | **132.54 ms** | — | `132.76 / 132.54 / 127.69 ms` |
| `work-sure` warm `runSearch(limit=8)` (incl. `stat` probe) | `3 x 20 = 60` calls | **79.69 ms** | **88.34 ms** | Runs 1/2/3 `p50`: `78.83 / 78.33 / 80.40 ms`; `p95`: `87.52 / 89.74 / 83.56 ms` |
| `work-sure` cold CLI `ei search ... --json` | `3` invocations | **228.91 ms** | — | `228.91 / 236.15 / 222.66 ms` |
| **Synthetic 50,000-declaration scale — isolated** (`search-query.test.js` Test 6, `500` `.ts` files, incl. `stat` probe) | `25` queries | **68.22 ms** | **83.59 ms** | Max `91.26 ms`; well below `300 ms` gate |
| **Synthetic 50,000-declaration scale — full `npm test` (2 runs)** (76 suites concurrent, incl. `stat` probe) | `2 x 25` queries | **85.82–87.84 ms** | **110.72–124.94 ms** | Run 1: `p50=87.84 / p95=124.94 / max=127.99 ms`; Run 2: `p50=85.82 / p95=110.72 / max=111.45 ms` (`< 300 ms` gate) |

---

## 4. Live Check (`omp -p`, Bun `loadExtensions`, CLI Parity, and `audit.jsonl`) — `VERIFIED`

### 4.1 Live `omp -p` (`omp/19.1.0` on Linux WSL2 `x86_64`) — `VERIFIED`

Executed against a disposable `/tmp` copy of `ksd-intelligence` with isolated `HOME` (`--tools ""` so only extension tools were active):

```text
$ HOME="$THOME" omp -p --no-session --no-extensions --no-skills --no-rules --no-context-files --no-lsp --no-pty --tools "" --cwd "$SCRATCH" -e "$SCRATCH/dist/adapters/omp/extension.js" "Find where audit text redaction is implemented without naming the symbol, then check its impact."
OMP_EXIT=0
Working...
Location: `src/core/audit/log.ts` line 141 – the redaction function `sanitizeAuditText`.

Impact (from ei_impact):
- Direct callers: 4  
- Total reachable callers: 21  
- Tests covering the function: 5 (including core/audit.test.ts, core/impact-tool.test.ts, core/search-query.test.ts, workflow/omp-extension.test.ts, workflow/skills-integration.test.ts)  
- No gaps in test coverage.

No modification was made; the impact analysis is complete.
```

Observed `audit.jsonl` entries emitted by that live `omp -p` run:

```json
{"ts":"2026-11-22T10:44:37.713Z","tool":"ei_search","outcome":"result","ms":3493.25,"engine":"0.2.0","ts_version":"5.9.3","adapter":"omp","query":"audit redaction","limit":10,"hitsCount":10,"totalMatches":116,"indexState":"updated"}
{"ts":"2026-11-22T10:44:40.085Z","tool":"ei_impact","outcome":"result","ms":34.79,"engine":"0.2.0","ts_version":"5.9.3","adapter":"omp","target":"src/core/audit/log.ts#sanitizeAuditText","targets":["src/core/audit/log.ts#sanitizeAuditText"],"risk":"medium","completeness":"complete","action":"run-tests","codes":["many-callers"]}
```

- Confirmed the live OMP agent discovered `ei_search`, searched without naming `sanitizeAuditText` (auto-building the cold index on first call), and immediately followed with `ei_impact` on `src/core/audit/log.ts#sanitizeAuditText`.

### 4.2 Real OMP Extension Loader (`loadExtensions` on Bun `1.4.2`) & CLI Parity — `VERIFIED`

```text
BUN_TOOLS=ei_workflow,ei_status,ei_impact,ei_changes,ei_search
--- BUN ei_search ---
SEARCH "sanitize audit text" — 5 of 172 matches
  exact     src/workflow/types.ts:85  text: string;  exported · 4 callers
  exact     src/core/indexing/differential.ts:13  text: string;  exported · 1 caller
  lexical   src/core/audit/log.ts:141  export function sanitizeAuditText( raw: string, options: { maxLen?: number; env…  exported · 4 callers
  lexical   src/core/search/render.ts:15  function sanitizeDisplay(text: string): string  2 callers
  lexical   src/core/audit/log.ts:191  function sanitizeEntry( entry: AuditEntry, options: { env: NodeJS.ProcessEnv; r…  1 caller
Next: call ei_impact with the symbol you intend to change.
— index updated · search: lexical only · 627 files · ts 5.9.3 · engine 0.2.0
--- BUN ei_impact (src/core/audit/log.ts#sanitizeAuditText) ---
IMPACT sanitizeAuditText — src/core/audit/log.ts:141
ACTION run-tests · level medium · picture complete
REACH 4 direct · 21 total · 8 files · 1 package · 0 routes · factors: many-callers
...
— index fresh · 627 files · limits: 5 unbounded dynamic imports, 139 excluded files · ts 5.9.3 · engine 0.2.0
```

Sanitized `audit.jsonl` from the Bun `loadExtensions()` session:

```json
{"ts":"2026-11-22T10:44:17.011Z","tool":"ei_search","outcome":"result","ms":3577.88,"engine":"0.2.0","ts_version":"5.9.3","adapter":"omp","query":"sanitize audit text","limit":5,"hitsCount":5,"totalMatches":172,"indexState":"updated"}
{"ts":"2026-11-22T10:44:17.034Z","tool":"ei_impact","outcome":"result","ms":21.78,"engine":"0.2.0","ts_version":"5.9.3","adapter":"omp","target":"src/core/audit/log.ts#sanitizeAuditText","targets":["src/core/audit/log.ts#sanitizeAuditText"],"risk":"medium","completeness":"complete","action":"run-tests","codes":["many-callers"]}
```

CLI `ei search "sanitize audit text" --limit 5 --root <SCRATCH>` produced identical hit lines and footer (`index fresh` after initial build).

---

## 5. Mutation Smoke (`8 / 8` Killed, Cleanly Reverted — `VERIFIED`)

Each localized mutation was applied to `src/`, compiled (`npm run build && tsc -p tests/tsconfig.json && node scripts/copy-policy-to-dist.mjs --test-tree`), executed via `node --import ./tests/policy/helpers/isolated-home.js --test ...`, confirmed `EXIT=1`, and cleanly reverted (`src/core/search/lexical.ts` byte-identical to clean state):

| # | Required Break (`M6a-search.md` / Round 4) | File & Mutation | Targeted Command & Failing Test | Exit Code |
|---|---|---|---|---:|
| **M1** | **Operators interpreted by FTS5** | `src/core/search/lexical.ts` (`buildFtsQueryInternal`: pass `query.trim()` to `matchExpr` instead of `quoteFtsLiteral` tokens) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `1. neutralizes FTS5 operators...` (`fts5: syntax error near "OR"`), `3.` (`fts5: syntax error near "."`), & direct `\0` test (re-verified post-Round 4) | `1` (**KILLED**) |
| **M2** | **A secret file indexed** | `src/core/indexing/indexer.ts` (`cold`: insert `census.records` with `reason === 'secret'` into `declarations_fts`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-index.test.js` — fails `indexes D49 secret-named code files while excluding .env, .pem, .key, non-code secrets, and excluded dirs` (Round 3; `indexer.ts` unchanged in Round 4) | `1` (**KILLED**) |
| **M3** | **Exact match not first** | `src/core/search/lexical.ts` (`querySearch`: set `exactBoost = 0`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `3. ranks exact whole-name matches first`, `4.`, & buried `> 500` exact test (re-verified post-Round 4) | `1` (**KILLED**) |
| **M4** | **Non-deterministic result order** | `src/core/search/lexical.ts` (`readCandidates` / `querySearch`: drop `s.key ASC` and `stableKey` comparator tie-breaker) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `5. produces deterministic byte-identical results across repeated queries and cold vs incremental builds` (re-verified post-Round 4) | `1` (**KILLED**) |
| **M5** | **Stale index answered as fresh** | `src/core/impact/session.ts` (`prepareForSearch`: map `'stale'` to `'fresh'`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `9. falls back to published index with STALE INDEX on drift when build lock or failing update blocks` (Round 3; `session.ts` unchanged in Round 4) | `1` (**KILLED**) |
| **M6** | **Caller boost disabled (`callerBoost = 0`)** | `src/core/search/lexical.ts` (`querySearch`: set `callerBoost = 0`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `4.` (`boosts_a.ts#sharedPopular` beats `boosts_z.ts#sharedPopular`) | `1` (**KILLED**) |
| **M7** | **Flat BM25 column weights** | `src/core/search/lexical.ts` (`BM25_SQL`: `(0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0)`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `4.` (`expected src/weights/f6_name.ts#accessorHelper before src/weights/e5_owner.ts#AccessorOwner.memberFn`) | `1` (**KILLED**) |
| **M8** | **`exactCase === exactLower` (`900`)** | `src/core/search/lexical.ts` (`querySearch`: set `exactBoost = exactCase \|\| exactLower ? 900 : 0`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `4.` (`src/case_a.ts#tokenAlpha` beats `src/case_z.ts#TokenAlpha`) | `1` (**KILLED**) |

---

## 6. Round 4 Remediation & Re-Measurements (Post-`lexical.ts` Optimization) — `VERIFIED`

- **Why re-measured:** Round 3 recorded synthetic 50k `p95 = 151.18 ms`, but Round 4 Iteration 1 independent review & forensic audit at `7df3459` proved Test 6 (`50,000 declarations ... p95 < 300 ms`) failed deterministically (`455.15–1114.70 ms >= 300 ms`) because `readCandidates` joined `symbols`/`declarations` and evaluated the correlated `edges` subquery before `LIMIT`, and `querySearch` ran a second 50k `exactMatchExpr` FTS5 `bm25()` scan unconditionally.
- **Optimization & Fixes Applied:**
  1. `src/core/search/lexical.ts`: Added `WITH top AS (SELECT f.rowid AS id, s.key AS stable_key, -bm25(...) AS bm25_score FROM declarations_fts f JOIN symbols s ON s.id = f.rowid ... LIMIT ?)` in `readCandidates` so wide FTS/declaration rows and correlated `edges` caller counts run only on the `<= 500` top rows; replaced unconditional `exactMatchExpr` FTS5 scan in `querySearch` with a gated `declarations` `COLLATE NOCASE` exact-match supplement (skipped when `ftsTotal <= 500 && !tokenLimitHit`); stripped `\0` in `quoteFtsLiteral`.
  2. `src/core/search/render.ts`: Updated overflow lines (`L75`, `L87`) to `plural(remaining, 'more match', 'more matches')` (`(+1 more match)` vs `(+2 more matches)`).
  3. `scripts/mcp/tools.mjs`: Added integer `limit` logging on `INVALID_INPUT` audit entries and `validateSearchInput` parity (`valid.query`, `valid.limit`) on `runSearch` and `auditFieldsForSearch`.
  4. `tests/core/search-query.test.ts`: Replaced Test 4 with unconfounded 6-tier `'accessor'` equal-22-token BM25 tests, IDF-invariant `'sharedPopular'` `callerBoost` test, and `'TokenAlpha'` `exactCase`/`exactLower`/`lexical` tier tests; added MCP audit parity test, singular/plural overflow test, direct `\0` test, and `> 500` buried-exact test; preserved Test 6 (`50,000` rows, `25` queries, `< 300 ms` p95) untouched.
- **Re-Measurement Summary (Linux WSL2 `x86_64`, post-fix):**
  - **Test 6 isolated** (`node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js`): `14/14` pass; `p50 = 68.22 ms`, **`p95 = 83.59 ms`**, `max = 91.26 ms` (`< 300 ms`).
  - **Full `npm test` (2 runs, 76 suites concurrent):** `726/726` pass in both runs; Run 1 `p50 = 87.84 ms`, **`p95 = 124.94 ms`**, `max = 127.99 ms`; Run 2 `p50 = 85.82 ms`, **`p95 = 110.72 ms`**, `max = 111.45 ms` (`< 300 ms`).
  - **Recall parity (`S01–S20` & `W01–W20`):** Unchanged top-8 recall (`17/20` = `85%` on `ksd-intelligence`, `20/20` = `100%` on `work-sure`, `0/40` missing, `100%` rank `1` + `exact` on `S01–S04` & `W01–W07`).
  - **Section 1 (Schema 4 vs 5 DB growth) & Section 4 (`omp -p` / Bun `loadExtensions()` live transcripts):** Carried forward unchanged from `9302b69`/`7df3459` (`segments.ts` and `render.ts` non-overflow formatting unchanged).

