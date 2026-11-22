# M3 Setup Round — `ksd-intelligence` (Linux WSL2 x86_64)

- **Date:** 2026-11-22
- **Repository:** `ksd-intelligence` (supplemental smoke repo per `docs/briefs/M3-dogfood.md`; real work repository setup still pending owner path confirmation)
- **Commit / Engine:** `633f478` on `release/0.2.0-unified-skills` · engine `0.2.0` · schema `4`
- **Runtime:** Linux WSL2 `x86_64` · Node `v24.21.0` · Bun `1.4.2` · TypeScript `5.9.3` (runtime)
- **Verification status:** `VERIFIED` (commands executed on this host; no code tuned or modified)

---

## 1. Setup & Dry-Run Init (`ei setup --check`, `ei init --dry-run`)

```text
$ node dist/adapters/cli/main.js setup --check
typescript 5.9.3: ready · sha256 3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675

$ node dist/adapters/cli/main.js init --dry-run --root "$PWD"
Repo ID:            e14e18b119a2d32b
Include:            src/**, tests/**
TS configs:         src/policy/tsconfig.json, tests/tsconfig.json, tsconfig.json
Omitted tsconfig dirs: none
```

`ei.config.json` already exists in the repository (`include: ["src/**", "tests/**"]`, `exclude: ["**/dist/**", "tests/fixtures/**"]`, `freshness: "stat"`, `riskZones: "default"`). No config file was written or modified.

---

## 2. Cold Index & Coverage (`ei index --full`, `ei status`)

```text
STATUS ready
Index       published 2026-11-22 05:29 UTC · fresh (stat probe) · last cold 2.7 s (scan 0.1 · program 0.7 · extract 0.0 · resolve 1.8 · verify 0.0 · publish 0.0)
Coverage    436 scanned · 93 indexable · 43 orphan (no tsconfig) · 300 unindexed (excluded 101 · other-kind 44 · outside-index-scope 155)
Graph       1,950 declarations · 5,558 edges · programs 2 (split by lib, noUncheckedIndexedAccess, types)
Problems    0 files failed to parse · 0 not in a program · 0 unresolved imports · 4868 unresolved name matches · dependencies installed: yes · incompleteReasons: none
Gap sites   computed-member-access 51 · dynamic-import 2 · interface-dispatch 118
Limits      2 unbounded dynamic imports · 128 excluded files · 0 failed to index
Scope       7 packages · tsconfigs 3 (src/policy/tsconfig.json, tests/tsconfig.json, tsconfig.json) · bases 0 · tsconfig problems none
Config      ei.config.json ok
Runtime     node 24.21.0 · memory limit 7,997 MB · engine peak 463 MB (last build)
TypeScript  5.9.3 (runtime) · ~/.cache/ksd-intelligence/runtime/typescript-5.9.3/node_modules/typescript/lib/typescript.js · verified sha256 3ae902c92cc4
Store       ~/.cache/ksd-intelligence/e14e18b119a2d32b/index.sqlite · 2,324 KB · schema 4
Lock        free
Uses        approximate · indexed 10,348 · skipped external 13202 · local 18011 · outside-scope 4 · unresolved-other 105 · indexed share 24.8%
```

### Summary metrics

| Metric | Value |
|---|---|
| Scanned files | 436 |
| Indexable files | 93 (`27,051` lines; `35,431` lines across all `182` `file_index` rows including lexical-scanned out-of-scope code files) |
| Orphan files (`no-tsconfig`) | 43 |
| Unindexed files | 300 (`outside-index-scope: 155`, `excluded: 101`, `other-kind: 44`) |
| Declarations (non-`<module>`) | 1,950 (`2,043` total rows including `<module>`) |
| Edges | 5,558 |
| TS programs | 2 (split by `lib, noUncheckedIndexedAccess, types`) |
| Engine peak RSS (last build) | 463 MB |
| Store size / schema | 2,324 KB / schema 4 |
| Gap sites (`171` total) | `interface-dispatch: 118` · `computed-member-access: 51` · `dynamic-import: 2` |
| Repository limits | `2` unbounded dynamic imports · `128` excluded files · `0` failed to index |

---

## 3. Timings (3 Runs Each, Median & Min–Max Range)

Measured on a disposable `/tmp` clone of `ksd-intelligence` (with its own cache directory, deleted after measurement) on Node `v24.21.0`:
- Build/update benchmarks invoke `node dist/adapters/cli/main.js index ... --json` end-to-end (wall-clock ms + engine phase split).
- No-drift query benchmark runs `ImpactSession.query` over 20 seeded targets (3 runs of 20 queries on a warmed SQLite handle, matching OMP/MCP session query latency).

| Benchmark | Runs (ms) | Median | Range (min–max) | Notes / Phase split |
|---|---|---|---|---|
| **Cold build** (`index --full`) | 3,014.9 · 2,823.4 · 2,956.9 | **2,956.9 ms** (2.96 s) | 2,823.4–3,014.9 ms | `scan 80–82` · `program 622–734` · `extract 20–38` · `resolve 1,759–1,888` · `verify 9–10` · `publish 18–32` ms |
| **No-drift impact (20 targets, p50)** | 11.2 · 11.2 · 11.5 | **11.2 ms** | 11.2–11.5 ms | Warm `ImpactSession`, 20 seeded targets per run |
| **No-drift impact (20 targets, p95)** | 13.0 · 12.8 · 12.4 | **12.8 ms** | 12.4–13.0 ms | Warm `ImpactSession`, 20 seeded targets per run |
| **One-file body edit** (`src/workflow/classify.ts`) | 1,221.8 · 1,258.6 · 1,299.8 | **1,258.6 ms** (1.26 s) | 1,221.8–1,299.8 ms | `1 changed · 0 removed · 1 resolved`; `scan 81–93` · `program 773–819` · `extract 5` · `resolve 37–46` · `verify 9` · `publish 10–12` ms |
| **Widely-used export signature edit** (`src/core/kernel/guards.ts#isRecord`) | 2,419.7 · 2,464.8 · 2,444.0 | **2,444.0 ms** (2.44 s) | 2,419.7–2,464.8 ms | `1 changed · 0 removed · 49 resolved`; `scan 88–91` · `program 793–831` · `extract 4–5` · `resolve 1,166–1,177` · `verify 9` · `publish 14–41` ms |
| **Add new `.ts` file** (`src/workflow/_m3_probe_*.ts`) | 1,748.1 · 1,755.2 · 1,760.5 | **1,755.2 ms** (1.76 s) | 1,748.1–1,760.5 ms | `1 changed · 0 removed · 22 resolved`; `scan 84–85` · `program 768–772` · `extract 4` · `resolve 553–557` · `verify 9` · `publish 15` ms |

---

## 4. Differential Oracle (`ei doctor --deep --differential 300`)

Command: `node dist/adapters/cli/main.js doctor --deep --differential 300 --root "$PWD" --json`

```json
{
  "differences": { "count": 0, "onlyActive": [], "onlyCold": [] },
  "counterDifferences": { "count": 0, "files": [] },
  "differential": {
    "declarations": 300,
    "references": 1624,
    "covered": 1624,
    "coveredBy": { "edge": 1624, "exportStatus": 0, "recordOnly": 0 },
    "skipped": { "definition": 300, "declaration name of a related symbol": 160 },
    "docOnly": 0,
    "misses": []
  }
}
```

Result: **`0` update-vs-cold differences, `0` counter differences, `1,624 / 1,624` references covered by graph edges, `0` misses** (`VERIFIED`).

---

## 5. Seeded 200-Target Distribution

Deterministic Mulberry32 sample (`seed = 20261122`) of `200` declarations from `1,950` non-`<module>` declarations, queried through `ImpactSession`:

| Verdict level | Count | Share |
|---|---:|---:|
| `low` | 32 | 16.0% |
| `medium` | 80 | 40.0% |
| `high` | 0 | 0.0% *(M2c risk zones not yet wired)* |
| `unknown` | 88 | 44.0% |
| Non-result / error | 0 | 0.0% |

Completeness split: **`complete`: 112 (56.0%) · `partial`: 88 (44.0%)**.

### Top 10 completeness reasons

| # | Completeness reason | Targets affected |
|---|---|---:|
| 1 | `computed-member-access: src/workflow/loader.ts:125 — src/workflow/packs.ts#SKILL_PACKS` | 11 |
| 2 | `computed-member-access: src/workflow/packs.ts:212 — src/workflow/packs.ts#SKILL_PACKS` | 11 |
| 3 | `computed-member-access: src/workflow/registry.ts:160 — src/workflow/packs.ts#SKILL_PACKS` | 11 |
| 4 | `computed-member-access: src/workflow/updates.ts:372 — src/workflow/updates.ts#checkUpstreamUpdates` | 7 |
| 5 | `computed-member-access: src/workflow/updates.ts:471 — src/workflow/updates.ts#checkUpstreamUpdates` | 7 |
| 6 | `computed-member-access: src/workflow/updates.ts:472 — src/workflow/updates.ts#checkUpstreamUpdates` | 7 |
| 7 | `computed-member-access: src/workflow/updates.ts:260 — src/workflow/catalog.ts#catalog` | 4 |
| 8 | `computed-member-access: src/workflow/updates.ts:361 — src/workflow/catalog.ts#catalog` | 4 |
| 9 | `computed-member-access: src/workflow/updates.ts:404 — src/workflow/catalog.ts#catalog` | 4 |
| 10 | `computed-member-access: tests/workflow/fixtures.ts:50 — src/workflow/catalog.ts#catalog` | 4 |

---

## 6. Hand-Check of 10 `low` Results vs `ts.LanguageService.findReferences`

Checked across all three project tsconfigs (`tsconfig.json`, `tests/tsconfig.json`, `src/policy/tsconfig.json`) against indexable files:

| # | Target | Kind | `ei_impact` (direct / total) | `findReferences` non-def in-scope refs | Missed callers | Verdict check |
|---|---|---|---:|---:|---:|---|
| 1 | `src/core/kernel/types.ts#ImpactNode.synthesizedBy` | property | 0 / 0 | 0 | 0 | OK |
| 2 | `src/workflow/updates.ts#ReleaseSnapshot` | interface | 2 / 5 | 5 *(4 uses + 1 barrel re-export)* | 0 *(see note)* | OK (note below) |
| 3 | `src/core/indexing/differential.ts#DifferentialMiss` | interface | 1 / 7 | 1 | 0 | OK |
| 4 | `src/core/workspace/init.ts#InitProjectResult.configCreated` | property | 3 / 5 | 6 | 0 | OK |
| 5 | `src/core/workspace/scan.ts#isTypescriptApi` | function | 0 / 0 | 0 | 0 | OK |
| 6 | `src/adapters/agy/skills.ts#DiscoverAgySkillsOptions.snapSkillsDir` | property | 1 / 6 | 2 | 0 | OK |
| 7 | `tests/workflow/fixtures.ts#tempDir` | function | 7 / 7 | 44 | 0 | OK |
| 8 | `src/workflow/sources.ts#ProviderReport.skillsTotal` | property | 3 / 8 | 4 | 0 | OK |
| 9 | `src/adapters/omp/skills.ts#OmpRuntimeEnvironment.configFiles` | property | 2 / 7 | 3 | 0 | OK |
| 10 | `src/core/engine/status.ts#WorkspaceStatus.repoId` | property | 0 / 0 | 0 | 0 | OK |

**Result:** **0 wrong-`low` / 0 missed callers** across all 10 checked targets. Contingency D is **not** triggered.

> **Note on #2 (`src/workflow/updates.ts#ReleaseSnapshot`):** All 4 actual usage sites (`src/workflow/updates.ts` lines 611, 667, 716, 718) and their transitive callers (`src/adapters/cli/main.ts#run`, `tests/workflow/unified-lifecycle.test.ts#<module>`) are covered. The 5th `findReferences` hit is the barrel re-export `export type { ..., ReleaseSnapshot, ... } from './workflow/updates.js'` at `src/index.ts:83`. Per golden C02, barrel re-exports are stored in the `exports` table (verified: `exports` contains `(src/index.ts, ReleaseSnapshot -> src/workflow/updates.ts#ReleaseSnapshot)`) rather than as caller edges, and `src/index.ts` is not a package entry point in `package.json` (`exports` maps `.` to `./dist/adapters/omp/extension.js` and `./eslint` to `./dist/policy/eslint-rules/index.js`). Zero callers import `ReleaseSnapshot` via `src/index.ts`. Flagged transparently for owner awareness (relevant if a future symbol rename/removal touches an internal barrel).

---

## 7. Open Items for Ticket 03

1. Owner to name the read-only real work repository path + sanitized alias and approve its `ei init --dry-run` scope.
2. Run this same Setup Round on the real work repository (`docs/research/m3-<work-repo>-linux.md`).
3. Owner to set daily-use build/update limits in `docs/DESIGN.md §14` and log Task #1 in `docs/dogfood-log.md`.
