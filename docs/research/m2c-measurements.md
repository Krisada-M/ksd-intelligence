# M2c Round 4 — Live Check, `work-sure` `ei_changes` Latency, and Mutation Smoke

- **Date:** 2026-11-22
- **Branch / Engine:** `m2c-changes` · engine `0.2.0` · schema `4`
- **Runtime:** Linux WSL2 `x86_64` (`6.18.58.1-microsoft-standard-WSL2`) · Node `v24.21.0` · Bun `1.4.2` · OMP `omp/19.1.0` · TypeScript `5.9.3` (runtime)
- **Safety / Isolation:**
  - All `work-sure` measurements ran on a disposable `/tmp` copy with an isolated temporary `HOME` cache (`runtime/` symlinked); both temporary directories were deleted afterward and the read-only `work-sure` checkout remained untouched.
  - All live scratch checks ran on a disposable `/tmp` copy of `ksd-intelligence` with an isolated temporary `HOME` cache; both were deleted afterward.

---

## 1. Live Check (`omp -p`, Bun `loadExtensions`, CLI, and `audit.jsonl`)

### 1.1 `omp -p` LLM Turn — `NOT VERIFIED`

Attempted `omp -p` in an isolated temporary `HOME` against a disposable scratch copy of `ksd-intelligence` (`src/core/kernel/verdict.ts#normalizeRepoPath` body edited, `riskZones` configured with `payments` matching `**/verdict.ts`):

```text
$ HOME="$THOME" omp -p --no-session --no-extensions --no-skills --no-rules --no-context-files --no-lsp --no-pty --cwd "$SCRATCH" -e "$SCRATCH/dist/adapters/omp/extension.js" "Call ei_changes with no arguments, then ei_impact on src/core/kernel/verdict.ts"
No models available. Use `/login` or set an API key environment variable.
OMP_EXIT=1
```

- **Status:** `NOT VERIFIED` (no LLM API key / model credentials configured on this host for non-interactive `omp -p`).

### 1.2 Real OMP Extension Loader (`@oh-my-pi/pi-coding-agent` `loadExtensions` on Bun `1.4.2`) & CLI — `VERIFIED`

On the same disposable scratch copy (`normalizeRepoPath` body edited), loaded `dist/adapters/omp/extension.js` through the installed `omp/19.1.0` `loadExtensions()` on Bun `1.4.2` and invoked `ei_changes` (no arguments) followed by `ei_impact` on `src/core/kernel/verdict.ts`, then verified parity via `ei changes` and `ei impact` CLI:

```text
BUN_TOOLS=ei_workflow,ei_status,ei_impact,ei_changes
--- BUN ei_changes ---
CHANGES vs main (merge-base 561194d) — 1 file, 1 symbol
ACTION run-tests · level high (zone payments) · picture complete
REACH 1 direct · 13 total · 6 files · 1 package · 0 routes · factors: public-export-surface

Modified (1)
  normalizeRepoPath  src/core/kernel/verdict.ts:22  13 callers

Tests to run: none
Gaps: none
Next: run the package tests, and include this verdict in your report.
— index updated (1 file, full hash) · 130 files · ts 5.9.3 · engine 0.2.0

--- BUN ei_impact ---
IMPACT src/core/kernel/verdict.ts — 7 symbols
ACTION run-tests · level high (zone payments) · picture partial (1 gap)
REACH 15 direct · 113 total · 17 files · 1 package · 0 routes · factors: public-export-surface

Impact per symbol (7)
  ACTION_RANK  src/core/kernel/verdict.ts:15  2 callers
  LEVEL_RANK  src/core/kernel/verdict.ts:7  2 callers
  applyRiskZones  src/core/kernel/verdict.ts:113  5 callers
  deriveVerdict  src/core/kernel/verdict.ts:54  6 callers
  matchedRiskZones  src/core/kernel/verdict.ts:29  6 callers
  normalizeRepoPath  src/core/kernel/verdict.ts:22  13 callers
  <module>  src/core/kernel/verdict.ts:1  0 callers

Gaps (1)
  unused-symbol src/core/kernel/verdict.ts:1 — <module> has 0 callers
Next: after your change, run the package tests; call ei_changes before you report done.
— index fresh · 130 files · ts 5.9.3 · engine 0.2.0
```

CLI `ei changes --root <SCRATCH>` and `ei impact src/core/kernel/verdict.ts --root <SCRATCH>` produced identical verdicts, reach counts, symbol lists, and footers (`VERIFIED`).

### 1.3 Resulting `audit.jsonl` Lines — `VERIFIED`

```json
{"ts":"2026-11-22T09:33:47.768Z","tool":"ei_changes","outcome":"result","ms":2091.85,"engine":"0.2.0","ts_version":"5.9.3","adapter":"omp","base":"main","changedSymbols":["src/core/kernel/verdict.ts#normalizeRepoPath"],"changedFilesCount":1,"unindexedCount":0,"risk":"high","completeness":"complete","action":"run-tests","zones":["payments"],"codes":["public-export-surface"]}
{"ts":"2026-11-22T09:33:47.926Z","tool":"ei_impact","outcome":"result","ms":158.13,"engine":"0.2.0","ts_version":"5.9.3","adapter":"omp","target":"src/core/kernel/verdict.ts#LEVEL_RANK","targets":["src/core/kernel/verdict.ts#LEVEL_RANK","src/core/kernel/verdict.ts#ACTION_RANK","src/core/kernel/verdict.ts#normalizeRepoPath","src/core/kernel/verdict.ts#matchedRiskZones","src/core/kernel/verdict.ts#deriveVerdict","src/core/kernel/verdict.ts#applyRiskZones","src/core/kernel/verdict.ts#<module>"],"risk":"high","completeness":"partial","action":"run-tests","zones":["payments"],"codes":["public-export-surface","unused-symbol"]}
{"ts":"2026-11-22T09:33:48.555Z","tool":"ei_changes","outcome":"result","ms":461.46,"engine":"0.2.0","ts_version":"5.9.3","adapter":"cli","base":"main","changedSymbols":["src/core/kernel/verdict.ts#normalizeRepoPath"],"changedFilesCount":1,"unindexedCount":0,"risk":"high","completeness":"complete","action":"run-tests","zones":["payments"],"codes":["public-export-surface"]}
{"ts":"2026-11-22T09:33:48.724Z","tool":"ei_impact","outcome":"result","ms":165.45,"engine":"0.2.0","ts_version":"5.9.3","adapter":"cli","target":"src/core/kernel/verdict.ts#LEVEL_RANK","targets":["src/core/kernel/verdict.ts#LEVEL_RANK","src/core/kernel/verdict.ts#ACTION_RANK","src/core/kernel/verdict.ts#normalizeRepoPath","src/core/kernel/verdict.ts#matchedRiskZones","src/core/kernel/verdict.ts#deriveVerdict","src/core/kernel/verdict.ts#applyRiskZones","src/core/kernel/verdict.ts#<module>"],"risk":"high","completeness":"partial","action":"run-tests","zones":["payments"],"codes":["public-export-surface","unused-symbol"]}
```

---

## 2. `work-sure` `ei_changes` Latency Breakdown (`VERIFIED`)

Measured on a disposable `/tmp` copy of `work-sure` (`8,435` scanned files: `5` indexable `.ts` files in `desktop/src/`, `15` orphan `.mjs`/`.ts` files, `8,415` unindexed files) via `node dist/adapters/cli/main.js changes --root <COPY> --json` (3 runs each; clean base index snapshot restored before each run so every run exercises full-hash `update + baseParse + traverse + render`):

| Scenario | File-type split | `updateMs` median (min–max) | `baseParseMs` median (min–max) | `traverseMs` median (min–max) | `renderMs` median (min–max) | `totalMs` wall median (min–max) |
|---|---|---:|---:|---:|---:|---:|
| **1-file body edit** (`desktop/src/main.ts`) | `1` indexable `.ts` · `0` unindexed (`1` symbol) | **3,098.6** (3,057.9–3,130.8) | **255.5** (254.2–259.4) | **9.6** (9.6–9.9) | **8.6** (8.3–9.0) | **3,508.7** (3,480.5–3,541.8) |
| **1-file signature edit** (`desktop/src/status.ts`) | `1` indexable `.ts` · `0` unindexed (`1` symbol) | **3,086.3** (3,066.0–3,149.4) | **249.2** (248.0–250.4) | **10.1** (9.9–10.2) | **9.0** (8.3–9.0) | **3,499.0** (3,478.8–3,555.0) |
| **20 changed files** | `5` indexable `.ts` + `15` unindexed (`1` `.ts` orphan + `14` `.mjs`) | **3,211.9** (3,191.2–3,220.7) | **283.8** (278.2–286.0) | **9.9** (9.7–10.1) | **8.7** (8.5–8.9) | **3,670.5** (3,653.6–3,686.2) |

*Observation:* `updateMs` (~`3.1–3.2 s`, ~88% of wall time) dominates because `ei_changes` enforces `freshness: 'hash'` across all `8,435` scanned files before diffing, whereas `baseParse` (`249–284 ms`), `traverse` (`~10 ms`), and `render` (`~9 ms`) complete in ~`0.3 s` combined.

---

## 3. Mutation Smoke (`8 / 8` Killed, Cleanly Reverted — `VERIFIED`)

Each 1-line break was applied to `src/`, rebuilt into both `dist/` (`npm run build`) and `dist-test/` (`tsc -p tests/tsconfig.json`), executed against its targeted test suite, confirmed to exit `1`, and immediately reverted (`git diff -- src/` empty after completion):

| # | Required Break (`M2c-changes.md`) | File & Mutation | Killing Test(s) | Result |
|---|---|---|---|---|
| **M1** | A zone that lowers | `src/core/kernel/verdict.ts` (`applyRiskZones`: force `level: 'low', action: 'proceed'` when `derived.zones.length > 0`) | `tests/core/impact-risk-zones.test.ts` — `property test: zones never lower level or action across all golden targets and matrix combinations`, `zone matching uses paths only...`, `stale index preserves high/critical zone floors...` | **KILLED** (exit `1`) |
| **M2** | Zones not applied to changed paths | `src/core/changes/changes.ts` (omit `changedFiles` & `unindexedChanges` from `allZonePaths`) | `tests/core/changes.test.ts` — `Golden P05: untracked .sql in migrations...`, `renamed file...`, `unindexed & secret files...`, `300 changed files...` | **KILLED** (exit `1`) |
| **M3** | A changed file dropped from both lists | `src/core/changes/changes.ts` (`recordUnindexed`: skip `.sql` paths) | `tests/core/changes.test.ts` — `Golden P05` (`assertX03`), `unindexed & secret files...` (`assertX03`), `300 changed files...` | **KILLED** (exit `1`) |
| **M4** | Untracked files ignored | `src/core/changes/git.ts` (`--others` → `--cached` in `ls-files`) | `tests/core/changes.test.ts` — `Golden P05`, `detects untracked, staged-only, unstaged-only...`, `unindexed & secret files...` (+8 more) | **KILLED** (exit `1`) |
| **M5** | A removed symbol with users not listed first | `src/core/changes/changes.ts` (`symbolOrderWeight`: return `5` instead of `0` for removed/signature-changed with users) | `tests/core/changes.test.ts` — `in-place symbol rename reports old symbol removed with users first and new symbol added` | **KILLED** (exit `1`) |
| **M6** | The stat probe used instead of the hash | `src/core/impact/session.ts` (`prepareForChanges`: `probe(..., 'hash')` → `'stat'`) | `tests/core/changes.test.ts` — `forces freshness: "hash" (catches same-length restored-mtime edits) and falls back to partial stale on build failure` | **KILLED** (exit `1`) |
| **M7** | Audit line containing the task untruncated | `src/core/audit/log.ts` (`sanitizeEntry`: `maxLen: MAX_TASK_CHARS` → `undefined`) | `tests/core/audit.test.ts` — `truncates task strings to 200 characters and strips secrets, tokens, and home paths` | **KILLED** (exit `1`) |
| **M8** | An unindexed change not adding `outside-index-scope` | `src/core/changes/changes.ts` (omit `outside-index-scope: ...` reason addition) | `tests/core/changes.test.ts` — `Golden P05`, `unindexed & secret files...`, `300 changed files...` | **KILLED** (exit `1`) |

*Note on M6:* Running the mutation smoke initially revealed that `tests/core/changes.test.ts` restored `origStat.mtime` (`Date`, millisecond resolution) on a Linux filesystem with sub-millisecond `mtimeMs`, which left `entry.mtimeMs !== previous.mtimeMs` under `'stat'` as well. Pinning a whole-second `mtime` (`1_700_000_000`) before indexing and after the same-length edit (matching `F06`) eliminated that sub-millisecond artifact so M6 genuinely kills `'stat'`.
