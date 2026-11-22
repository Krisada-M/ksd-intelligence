# M6a Rounds 3 & 4 — Fixed Query Recall, Latency, DB Growth, Live Smoke & Mutation Report

- **Date:** 2026-11-22
- **Branch / Engine:** `m6a-search` · engine `0.2.0` · schema `6`
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

## 1. Database Growth (Schema 4 vs Schema 5 FTS5 vs Schema 6 `NOCASE` Indexes) — `VERIFIED`

| Repository | Indexed Declarations (non-`<module>`) | Pre-FTS5 Size (Schema 4) | Schema 5 / Schema 6 Size | Delta / Growth | `ei doctor --deep --differential 300` |
|---|---|---|---|---|---|
| `ksd-intelligence` (`m6a-search` same-tree `DROP TABLE declarations_fts; VACUUM;` vs schema 5, R1) | `2,268` (R1) | `2,508 KB` (`2,568,192` B) | `3,508 KB` (`3,592,192` B, schema 5) | `+1,000 KB` (`+1,024,000` B, `+39.87%`) | `0` differences, `0` counterDifferences, `0` misses |
| `ksd-intelligence` (`m6a-search` after R2 additions, schema 5) | `2,355` (R3) | `2,324 KB` (M3 baseline @ `45cea76`, `1,950` decls) | `3,596 KB` (`3,682,304` B, schema 5) | `+1,272 KB` (includes M2c+M6a new files) | `0` differences, `0` counterDifferences, `0` misses |
| `ksd-intelligence` (`m6a-search` after R4 Iteration 3, schema 6) | `2,360` (R4 I3) | `2,324 KB` (M3 baseline @ `45cea76`, `1,950` decls) | `4,000 KB` (`4,096,000` B, schema 6) | `+404 KB` vs schema 5 (includes `declarations_*_nocase` indexes & R4 code) | `0` differences, `0` counterDifferences, `0` misses |
| `work-sure` (`5` indexable `.ts` files, `8,434` scanned, schema 5) | `33` (`33` FTS rows) | `2,216 KB` (`2,269,184` B) | `2,236 KB` (`2,289,664` B, schema 5) | `+20 KB` (`+20,480` B, `+0.90%`) | `0` differences, `0` counterDifferences, `0` misses |
| `work-sure` (`5` indexable `.ts` files, `8,434` scanned, schema 6) | `33` (`33` FTS rows) | `2,216 KB` (`2,269,184` B) | `2,244 KB` (`2,297,856` B, schema 6) | `+8 KB` (`+8,192` B, `+0.36%` vs schema 5) | `0` differences, `0` counterDifferences, `0` misses |

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

## 3. Search Latency (`p50` / `p95`, Warm Probe + Cold CLI + 50k Scale) — `VERIFIED` (Post-Round 4 Iteration 3 Fix)

| Benchmark | Sample Size | `p50` | `p95` | Notes |
|---|---|---:|---:|---|
| `ksd-intelligence` warm `runSearch(limit=8)` (incl. `stat` probe) | `3 x 20 = 60` calls | **10.18 ms** | **12.06 ms** | Runs 1/2/3 `p50`: `9.91 / 10.09 / 10.31 ms`; `p95`: `11.68 / 11.60 / 12.87 ms` |
| `ksd-intelligence` cold CLI `ei search ... --json` | `3` invocations | **95.61 ms** | — | `94.00 / 96.06 / 95.61 ms` |
| `work-sure` warm `runSearch(limit=8)` (incl. `stat` probe) | `3 x 20 = 60` calls | **63.76 ms** | **67.28 ms** | Runs 1/2/3 `p50`: `63.86 / 63.55 / 63.51 ms`; `p95`: `68.40 / 66.68 / 67.28 ms` |
| `work-sure` cold CLI `ei search ... --json` | `3` invocations | **176.90 ms** | — | `179.53 / 176.90 / 173.04 ms` |
| **Synthetic 50,000-declaration scale — isolated** (`search-query.test.js` Test 6, `500` `.ts` files, incl. `stat` probe) | `25` queries | **40.11 ms** | **48.69 ms** | Max `48.70 ms`; `> 251 ms` headroom below `300 ms` gate |
| **Synthetic 50,000-declaration scale — full `npm test` (3 consecutive runs)** (76 suites concurrent, incl. `stat` probe) | `3 x 25` queries | **49.91–57.26 ms** | **64.21–80.25 ms** | Run 1: `p50=57.26 / p95=80.25 / max=89.97 ms`; Run 2: `p50=53.49 / p95=76.35 / max=77.49 ms`; Run 3: `p50=49.91 / p95=64.21 / max=68.07 ms` (`< 300 ms` gate) |

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

Each localized mutation was applied to `src/`, compiled (`npm run build && tsc -p tests/tsconfig.json && node scripts/copy-policy-to-dist.mjs --test-tree`), executed via `node --import ./tests/policy/helpers/isolated-home.js --test ...`, confirmed `EXIT=1`, and cleanly reverted (`src/core/search/lexical.ts` and `src/core/impact/session.ts` byte-identical to clean state):

| # | Required Break (`M6a-search.md` / Round 4) | File & Mutation | Targeted Command & Failing Test | Exit Code |
|---|---|---|---|---:|
| **M1** | **Operators interpreted by FTS5** | `src/core/search/lexical.ts` (`buildFtsQueryInternal`: pass `query.trim()` to `matchExpr` instead of `quoteFtsLiteral` tokens) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `1.`, `3.`, direct `\0`, buried exact, & `EXPLAIN QUERY PLAN` tests (re-verified post-Iteration 3) | `1` (**KILLED**) |
| **M2** | **A secret file indexed** | `src/core/indexing/indexer.ts` (`cold`: insert `census.records` with `reason === 'secret'` into `declarations_fts`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-index.test.js` — fails `indexes D49 secret-named code files while excluding .env, .pem, .key, non-code secrets, and excluded dirs` (Round 3; `indexer.ts` unchanged in Round 4) | `1` (**KILLED**) |
| **M3** | **Exact match not first** | `src/core/search/lexical.ts` (`querySearch`: set `exactBoost = 0`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `3.`, `4.`, buried `> 500` exact, & `EXPLAIN QUERY PLAN` tests (re-verified post-Iteration 3) | `1` (**KILLED**) |
| **M4** | **Non-deterministic result order** | `src/core/search/lexical.ts` (`readCandidates` / `querySearch`: drop `s.key ASC` and `stableKey` comparator tie-breaker) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `5. produces deterministic byte-identical results across repeated queries and cold vs incremental builds` (re-verified post-Iteration 3) | `1` (**KILLED**) |
| **M5** | **Stale index answered as fresh** | `src/core/impact/session.ts` (`prepareSessionDb`: map `'stale'` to `'fresh'`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `9. falls back to published index with STALE INDEX on drift when build lock or failing update blocks` (re-verified post-Iteration 3) | `1` (**KILLED**) |
| **M6** | **Caller boost disabled (`callerBoost = 0`)** | `src/core/search/lexical.ts` (`querySearch`: set `callerBoost = 0`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `4.` (`boosts_a.ts#sharedPopular` beats `boosts_z.ts#sharedPopular`, re-verified post-Iteration 3) | `1` (**KILLED**) |
| **M7** | **Flat BM25 column weights** | `src/core/search/lexical.ts` (`BM25_SQL`: `(0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0)`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `4.` (`expected src/weights/f6_name.ts#accessorHelper before src/weights/e5_owner.ts#AccessorOwner.memberFn`, re-verified post-Iteration 3) | `1` (**KILLED**) |
| **M8** | **`exactCase === exactLower` (`900`)** | `src/core/search/lexical.ts` (`querySearch`: set `exactBoost = exactCase \|\| exactLower ? 900 : 0`) | `node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js` — fails `4.` (`src/case_a.ts#tokenAlpha` beats `src/case_z.ts#TokenAlpha`) & buried exact test (re-verified post-Iteration 3) | `1` (**KILLED**) |

---

## 6. Round 4 Remediation & Re-Measurements (Iterations 2 & 3) — `VERIFIED`

- **Iteration 1 -> Iteration 2 (`bf715e8`):** Round 4 Iteration 1 (`7df3459`) failed Test 6 (`455.15–1114.70 ms >= 300 ms`). Iteration 2 (`bf715e8`) introduced the `WITH top AS (...)` CTE in `readCandidates`, gated `declarations` `COLLATE NOCASE` exact-match supplement, `\0` stripping in `quoteFtsLiteral`, `plural()` overflow rendering, MCP audit parity, and unconfounded Test 4 ranking checks.
- **Iteration 2 Check 4 `INTEGRITY VIOLATION` at `bf715e8`:** Although isolated (`82.91 ms`) and warm Runs 2–3 (`113.99 ms`, `90.18 ms`) passed, `teamwork_auditor_m3_i2_1` rejected `bf715e8` because Run 1 of full `npm test` failed (`305.90 ms >= 300 ms`) under parallel contention, with `EXPLAIN QUERY PLAN` proving `d.simple = ? COLLATE NOCASE` triggered a full 50,000-row `SCAN d`.
- **Iteration 3 Remediation & Re-Measurements (`VERIFIED` on Linux WSL2 `x86_64`):**
  1. `src/storage/sqlite.ts`: Added migration `version: 6` (`SCHEMA_VERSION = 6`) creating partial indexes `declarations_simple_nocase ON declarations (simple COLLATE NOCASE) WHERE kind != 'module'` and `declarations_name_nocase ON declarations (name COLLATE NOCASE) WHERE kind != 'module'`.
  2. `src/core/search/lexical.ts`: Rewrote `OR` exact predicates to `d.kind != 'module' AND d.simple COLLATE NOCASE IN (...)` + `UNION` `d.kind != 'module' AND d.name COLLATE NOCASE IN (...)` (when dotted/spaced terms exist; never `OR`), replaced `f.rowid IN` with `+f.rowid IN` (avoiding SQLite `3.53.4` FTS5 1-element `IN (?)` -> `0:=M7` 50k scan), removed `anyExistingExact` and guarded BM25 hydration with `missingExactIds.length > 0 && !tokenLimitHit && matchExpr !== null`, executed `readCandidates` before skipping `SELECT COUNT(*)` whenever `topRows.length < MAX_CANDIDATES`, and reused optional `meta`/`scannedFiles` from `SearchSessionContext`.
  3. `src/core/impact/session.ts`: Forwarded pre-read `meta` and `scannedFiles` (`files.length`) from `prepareSessionDb` to `prepareForSearch`.
  4. `src/core/workspace/scan.ts`: Added `hasGitAncestor(root)` guard (`existsSync(join(dir, '.git'))` up to `/`) before spawning `git -C root ls-files` when `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_COMMON_DIR` are unset.
  5. `tests/core/{search-query,search-index,status}.test.ts`: Added `EXPLAIN QUERY PLAN` non-`SCAN d` regression test (`'retry'`, `'PaymentService.charge'`, `'find retry implementation'`, `> 500` rows, zero `SCAN d`/`SCAN declarations`), fixed Test 14 genuinely buried single-exact `bm25Score > 1000` + buried `RETRY` (`> 900`) + `PaymentService.charge` (`> 1000`), updated `status.test.ts:141` (`schema 6`) and `search-index.test.ts` (`SCHEMA_VERSION = 6` + v4/v5->v6 rebuild), and preserved Test 6 (`50,000` rows, `25` queries, `stat` probe, `< 300 ms` p95) untouched.
- **Re-Measurement Summary (Linux WSL2 `x86_64`, post-Iteration 3):**
  - **Test 6 isolated** (`node --import ./tests/policy/helpers/isolated-home.js --test dist-test/tests/core/search-query.test.js`): `15/15` pass; `p50 = 40.11 ms`, **`p95 = 48.69 ms`**, `max = 48.70 ms` (`< 300 ms`).
  - **Full `npm test` (3 consecutive runs, 76 suites concurrent):** `727/727` pass in all 3 runs; Run 1 `p50 = 57.26 ms`, **`p95 = 80.25 ms`**, `max = 89.97 ms`; Run 2 `p50 = 53.49 ms`, **`p95 = 76.35 ms`**, `max = 77.49 ms`; Run 3 `p50 = 49.91 ms`, **`p95 = 64.21 ms`**, `max = 68.07 ms` (`< 300 ms`).
  - **Recall parity (`S01–S20` & `W01–W20`):** Identical top-8 recall (`17/20` = `85%` on `ksd-intelligence`, `20/20` = `100%` on `work-sure`, `0/40` missing, `100%` rank `1` + `exact` on `S01–S04` & `W01–W07`).
  - **Section 4 (`omp -p` / Bun `loadExtensions()` live transcripts):** Carried forward from `7df3459` (`render.ts` non-overflow formatting and `segments.ts` unchanged; `NOT VERIFIED: macOS CI / live macOS OMP`).

