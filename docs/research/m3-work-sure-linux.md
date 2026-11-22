# M3 Setup Round — `work-sure` (Linux WSL2 x86_64)

- **Date:** 2026-11-22
- **Repository:** `work-sure` (read-only work repository clone; all indexing and edit benchmarks executed on a disposable `/tmp` copy with an isolated temporary `HOME` cache, both deleted afterward; real checkout untouched)
- **Commit / Engine:** `45cea76` on `release/0.2.0-unified-skills` · engine `0.2.0` · schema `4`
- **Runtime:** Linux WSL2 `x86_64` · Node `v24.21.0` · Bun `1.4.2` · TypeScript `5.9.3` (runtime)
- **Verification status:** `VERIFIED` (commands executed on this host; no product code tuned or modified)

---

## 1. Setup & Dry-Run Init (`ei setup --check`, `ei init --dry-run`)

```text
$ node dist/adapters/cli/main.js setup --check
typescript 5.9.3: ready · ~/.cache/ksd-intelligence/runtime/typescript-5.9.3/node_modules/typescript/lib/typescript.js · sha256 3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675

$ node dist/adapters/cli/main.js init --dry-run --root <WORK_REPO>
Project initialized:
  Repo ID:    e0c6179f5c185cab
  Root:       <WORK_REPO>
  Cache dir:  ~/.cache/ksd-intelligence/e0c6179f5c185cab
  Config:     <WORK_REPO>/ei.config.json (would create)
  Git:        yes (<WORK_REPO>)
  Include:    test/**, spec/**, desktop/**
  TS configs: none found
  Omitted tsconfig dirs: none

Warnings:
  - No tsconfig files found in repository
```

Observations:
- Proposed `ei.config.json`: `impact.include: ["test/**", "spec/**", "desktop/**"]`, `impact.exclude: ["**/dist/**"]`, `freshness: "stat"`, `riskZones: "default"`.
- `desktop/tsconfig.json` exists (`"include": ["src"]`, covering 5 `.ts` files), so `tsconfigOwnedDirs()` added `desktop/**` to `impact.include`. However, `discoverTsconfigs()` (`src/core/workspace/init.ts:196`) only inspects `['packages', 'apps', 'src', 'tests']`, causing `ei init --dry-run` to print `TS configs: none found` and warn `No tsconfig files found in repository`.
- Neither root `node_modules/` nor `desktop/node_modules/` is installed in the read-only checkout.

---

## 2. Cold Index & Coverage (`ei index --full`, `ei status`)

Executed on a disposable copy of `work-sure` with isolated `HOME` (cache under `<TEMP_HOME>/.cache/ksd-intelligence/<repoId>/index.sqlite`, deleted after measurement):

```text
STATUS ready
Index       published 2026-11-22 06:17 UTC · fresh (stat probe) · last cold 1.7 s (scan 1.2 · program 0.3 · extract 0.0 · resolve 0.3 · verify 0.0 · publish 0.0)
Coverage    8,435 scanned · 5 indexable · 15 orphan (no tsconfig) · 8,415 unindexed (other-kind 1583 · outside-index-scope 6823 · secret 9)
Graph       33 declarations · 56 edges · programs 1
Problems    0 files failed to parse · 0 not in a program · 0 unresolved imports · 721 unresolved name matches · dependencies installed: no (4 bare imports unresolved) · incompleteReasons: none
Gap sites   none
Limits      0 unbounded dynamic imports · 219 excluded files · 0 failed to index
Scope       2 packages · tsconfigs 1 (desktop/tsconfig.json) · bases 0 · tsconfig problems none
Config      ei.config.json ok
Runtime     node 24.21.0 · memory limit 7,997 MB · engine peak 243 MB (last build)
TypeScript  5.9.3 (runtime) · ~/.cache/ksd-intelligence/runtime/typescript-5.9.3/node_modules/typescript/lib/typescript.js · verified sha256 3ae902c92cc4
Store       ~/.cache/ksd-intelligence/<repo-id>/index.sqlite · 2,216 KB · schema 4
Lock        free
Uses        approximate · indexed 95 · skipped external 174 · external-unresolved 4 · local 134 · unresolved-other 27 · indexed share 21.9%
```

### Summary metrics

| Metric | Value |
|---|---|
| Scanned files | 8,435 |
| Indexable files | 5 (`354` lines across `desktop/src/{bridge,main,prefs,status,strings}.ts`; `25,028` lines across `230` `file_index` rows including lexical-scanned out-of-scope code files) |
| Orphan files (`no-tsconfig`) | 15 (`2,350` lines: `desktop/vite.config.ts` + 14 `test/javascript/**/*.mjs` files) |
| Unindexed files | 8,415 (`outside-index-scope: 6,823` [incl. `210` lexically scanned JS/MJS files = `22,324` lines], `other-kind: 1,583`, `secret: 9`) |
| Declarations (non-`<module>`) | 33 (`38` total rows including `<module>`) |
| Edges | 56 |
| TS programs | 1 (`desktop/tsconfig.json`) |
| Dependencies installed | `no` (`4` bare imports unresolved: `@tauri-apps/api/*`) |
| Engine peak RSS (last build) | 243 MB |
| Store size / schema | 2,216 KB (`2,269,184` bytes) / schema 4 |
| Gap sites | none (`0`) |
| Repository limits | `0` unbounded dynamic imports · `219` excluded files · `0` failed to index |

---

## 3. Timings (3 Runs Each, Median & Min–Max Range)

Measured on a disposable `/tmp` clone of `work-sure` with an isolated cache directory (both deleted after measurement) on Node `v24.21.0`:
- Build/update benchmarks invoke `node dist/adapters/cli/main.js index ... --json` end-to-end (wall-clock ms + engine phase split).
- No-drift query benchmark runs `ImpactSession.query` over 20 seeded non-`<module>` targets (3 runs of 20 queries on a warmed `ImpactSession`, plus separate cold-process CLI `ei impact` sanity checks).

| Benchmark | Runs (ms) | Median | Range (min–max) | Notes / Phase split |
|---|---|---|---|---|
| **Cold build** (`index --full`) | 2,317.5 · 2,139.4 · 2,081.7 | **2,139.4 ms** (2.14 s) | 2,081.7–2,317.5 ms | `scan 1,249–1,343` · `program 224–256` · `extract 3–4` · `resolve 283–327` · `verify 2–3` · `publish 6–7` ms; peak RSS `240–248` MB |
| **No-drift impact (20 targets, p50)** | 74.53 · 66.10 · 65.95 | **66.10 ms** | 65.95–74.53 ms | `ImpactSession.query` (includes stat `probe` across repo); 20 seeded targets per run |
| **No-drift impact (20 targets, p95)** | 88.53 · 75.48 · 70.01 | **75.48 ms** | 70.01–88.53 ms | Well under `300 ms` clean-probe p95 gate; cold CLI `ei impact` sanity check: `171.4 ms` (`desktop/src/status.ts#serverErrorMessage`) |
| **One-file body edit** (`desktop/src/main.ts#setStatus`) | 2,055.1 · 2,570.0 · 2,344.4 | **2,344.4 ms** (2.34 s) | 2,055.1–2,570.0 ms | `1 changed · 0 removed · 1 resolved`; `scan 1,299–1,571` · `program 303–499` · `extract 5–14` · `resolve 102–153` · `verify 2–3` · `publish 5` ms |
| **Widely-used export signature edit** (`desktop/src/status.ts#serverErrorMessage`) | 2,231.9 · 2,112.9 · 2,076.5 | **2,112.9 ms** (2.11 s) | 2,076.5–2,231.9 ms | `1 changed · 0 removed · 3 resolved`; `scan 1,323–1,386` · `program 302–375` · `extract 4` · `resolve 110–132` · `verify 2–3` · `publish 4–5` ms |
| **Add new `.ts` file** (`desktop/src/_m3_probe_*.ts`) | 2,147.7 · 2,206.7 · 2,251.4 | **2,206.7 ms** (2.21 s) | 2,147.7–2,251.4 ms | `1 added · 0 removed · 4 resolved`; `scan 1,302–1,371` · `program 291–311` · `extract 3–4` · `resolve 203–233` · `verify 2–3` · `publish 5` ms |

*Key observation:* Because `work-sure` has 8,435 git-tracked files, `scan` dominates every `ei index` run (`1.25–1.57 s`, ~60% of wall time), while `program + resolve` over the 5 TS files in `desktop/src/` takes only `~0.4–0.6 s`.

---

## 4. Differential Oracle (`ei doctor --deep --differential 300`)

Command: `node dist/adapters/cli/main.js doctor --deep --differential 300 --root <DISPOSABLE_COPY> --json`

```json
{
  "differences": { "count": 0, "onlyActive": [], "onlyCold": [] },
  "counterDifferences": { "count": 0, "files": [] },
  "differential": {
    "declarations": 33,
    "references": 96,
    "covered": 96,
    "coveredBy": { "edge": 96, "exportStatus": 0, "recordOnly": 0 },
    "skipped": { "definition": 33 },
    "docOnly": 0,
    "misses": []
  }
}
```

Result: **`0` update-vs-cold differences, `0` counter differences, `96 / 96` references covered by graph edges across all `33` non-`<module>` declarations, `0` misses** (`VERIFIED`).

---

## 5. Seeded Distribution (`min(200, 33)` = 33 Targets)

Deterministic Mulberry32 sample (`seed = 20261122`) covering all `33` non-`<module>` declarations in `work-sure`, queried through `ImpactSession`:

| Verdict level | Count | Share |
|---|---:|---:|
| `low` | 15 | 45.5% |
| `medium` | 0 | 0.0% |
| `high` | 0 | 0.0% *(M2c risk zones not yet wired)* |
| `unknown` | 18 | 54.5% |
| Non-result / error | 0 | 0.0% |

Completeness split: **`complete`: 15 (45.5%) · `partial`: 18 (54.5%)**.

### Top 10 completeness reasons

| # | Completeness reason | Targets affected |
|---|---|---:|
| 1 | `string-name-match: app/javascript/controllers/coinstats_exchange_fields_controller.js:40 — label` | 2 |
| 2 | `string-name-match: app/javascript/controllers/color_icon_picker_controller.js:124 — label` | 2 |
| 3 | `string-name-match: app/javascript/controllers/trade_republic_qr_controller.js:4 — label` | 2 |
| 4 | `unresolved-name-match: app/javascript/controllers/account_logo_picker_controller.js:106 — label` | 2 |
| 5 | `unresolved-name-match: app/javascript/controllers/account_logo_picker_controller.js:113 — label` | 2 |
| 6 | `unresolved-name-match: app/javascript/controllers/activity_label_quick_edit_controller.js:110 — label` | 2 |
| 7 | `unresolved-name-match: app/javascript/controllers/activity_label_quick_edit_controller.js:59 — label` | 2 |
| 8 | `unresolved-name-match: app/javascript/controllers/activity_label_quick_edit_controller.js:62 — label` | 2 |
| 9 | `unresolved-name-match: app/javascript/controllers/activity_label_quick_edit_controller.js:68 — label` | 2 |
| 10 | `unresolved-name-match: app/javascript/controllers/activity_label_quick_edit_controller.js:72 — label` | 2 |

*(Why 18 targets are `unknown`: short common names such as `label`, `url`, `connect`, `fill`, and `$` in `desktop/src/*.ts` trigger lexical `unresolved-name-match` / `string-name-match` hits across the 210 out-of-scope JS/MJS files under `app/javascript/**`, causing the engine to conservatively downgrade to `unknown` / `partial` per D57.)*

---

## 6. Hand-Check of 10 `low` Results vs `ts.LanguageService.findReferences`

Checked against `desktop/tsconfig.json` indexable files (`desktop/src/*.ts`):

| # | Target | Kind | `ei_impact` (direct / total) | `findReferences` non-def in-scope refs | Missed callers | Verdict check |
|---|---|---|---:|---:|---:|---|
| 1 | `desktop/src/main.ts#boot` | function | 1 / 1 | 1 (`main.ts:111`) | 0 | OK |
| 2 | `desktop/src/strings.ts#P.launchAtLogin` | property | 1 / 1 | 1 (`prefs.ts:12`) | 0 | OK |
| 3 | `desktop/src/strings.ts#S.invalidUrl` | property | 6 / 8 | 1 (`status.ts:7`; plus parent `S` callers) | 0 | OK |
| 4 | `desktop/src/main.ts#goToServer` | function | 3 / 4 | 3 (`main.ts:55,105,114`) | 0 | OK |
| 5 | `desktop/src/strings.ts#P.switchTo` | property | 1 / 1 | 0 (parent `P` referenced at `prefs.ts:1`) | 0 | OK |
| 6 | `desktop/src/prefs.ts#ServerEntry` | interface | 1 / 2 | 1 (`prefs.ts:16`) | 0 | OK |
| 7 | `desktop/src/strings.ts#S.serverLabel` | property | 6 / 8 | 1 (`main.ts:28`; plus parent `S` callers) | 0 | OK |
| 8 | `desktop/src/main.ts#renderRemembered` | function | 1 / 2 | 2 (`main.ts:80,109`) | 0 | OK |
| 9 | `desktop/src/strings.ts#P.servers` | property | 1 / 1 | 1 (`prefs.ts:10`) | 0 | OK |
| 10 | `desktop/src/strings.ts#S.unreachable` | property | 6 / 8 | 3 (`status.ts:7`, `main.ts:50`, `prefs.ts:56`; plus parent `S` callers) | 0 | OK |

**Result:** **0 wrong-`low` / 0 missed in-scope callers** across all 10 checked targets. Contingency D is **not** triggered.

---

## 7. Route & Framework Observations (for M4a / Ticket 07 Gating)

Factual stack census of `work-sure`:
- **Web application:** Ruby on Rails 8.1 (`Gemfile`, `config/routes.rb`, `app/controllers`, `app/models`, `app/views`, `app/components`) + Hotwire/Stimulus JS (`app/javascript/`, `167` `.js`/`.mjs` files loaded via `config/importmap.rb` bare specifiers, plus `14` `.mjs` tests under `test/javascript/`).
- **Desktop wrapper:** Tauri v2 + Vite + TypeScript (`desktop/package.json`, `desktop/tsconfig.json`, `5` `.ts` files in `desktop/src/` + `desktop/vite.config.ts`).
- **Mobile application:** Flutter / Dart (`mobile/pubspec.yaml`, plus `1` token-generator `.mjs` script).

Explicit check against `docs/briefs/M4a-routes.md` detectors (`B1a`, `B1b`, `B1c`, `B2`):
- **Next.js App Router (`B1a`):** `0` matches (`"next"` absent from `package.json` and `desktop/package.json`; `0` `next.config.*` files; `app/` is Rails MVC, not Next.js).
- **Next.js Pages Router (`B1b`):** `0` matches (`"next"` absent; `app/views/pages` is Rails ERB).
- **Expo Router (`B1c`):** `0` matches (`"expo-router"` absent across repo; `0` `*+api*` files; mobile app is Flutter/Dart).
- **Hono (`B2`):** `0` matches (`"hono"` absent from `package.json` and `desktop/package.json`; `0` JS/TS matches for `\bhono\b`; HTTP routing is Rails `config/routes.rb`).

---

## 8. Open Items & Dogfood Observations

1. **`discoverTsconfigs()` blind spot (`src/core/workspace/init.ts:196`):** `init` only scans `['packages', 'apps', 'src', 'tests']` for display in `TS configs:`, so `ei init --dry-run` printed `TS configs: none found` and warned `No tsconfig files found in repository` even though `desktop/tsconfig.json` exists and was correctly included in `impact.include` by `tsconfigOwnedDirs()` (and indexed by `scan()`). Flagged as factual setup-round evidence; no code tuned.
2. **Unindexed JS surface & Rails importmap (`app/javascript/**`):** `app/javascript/` (`167` `.js`/`.mjs` files) has no `tsconfig.json`/`jsconfig.json` and uses Rails `importmap-rails` bare specifiers (`config/importmap.rb`, e.g. `"utils/sankey_zoom"`), so `ei impact app/javascript/utils/sankey_zoom.mjs#zoomSankeyData` reports `NOT INDEXED app/javascript/utils/sankey_zoom.mjs — outside-index-scope` while its tokens remain visible to lexical name cross-check.
3. **Absent `node_modules` in read-only checkout:** `ei status` accurately reports `dependencies installed: no (4 bare imports unresolved)` for `@tauri-apps/api/*`.
4. **Daily-use limits & Task #1:** Recorded as `PROPOSED` in `docs/DESIGN.md §14` and logged as Task #1 in `docs/dogfood-log.md`.
