# R8 measurement — VERIFIED on `oh-my-pi` reference corpus (WSL2 Linux x86_64) + historical synthetic lane

## 1. Real-corpus R8 before/after measurement (`oh-my-pi`, WSL2 Linux x86_64, 2026-11-22)

Host: Linux WSL2 x86_64; Node `v24.21.0`; TypeScript `5.9.3`.
Corpus: `/var/tmp/m2a2/omp-src` at `04cd1a7549a02d62ad1d24826198d52507595683` (`10,502` scanned files, `6,829` indexable, `165,011` declarations, `637,638` edges).
Targets: the 20 mixed-size targets from `/var/tmp/ksd-m2b-r5b-w2/latency.json` (SHA-256 `7af57a620f287448252ed98878bbd49a27b9574327bfa46930085f6696656e11`), compiler closures ranging from `0` to `10,745` dependents, display depth `2`, zero working-tree drift (`builds: 0`).
Raw artifacts: `/var/tmp/ksd-m2b-r6/before-r8-latency.json` and `/var/tmp/ksd-m2b-r6/after-r8-latency.json`.
All 20 targets were asserted bit-for-bit identical in normalized answer (`verdict`, `completeness`, `reach`, `factors`, `tests`, `byDepth`) and rendered character length before vs after R8.

| Measurement | Before R8 p50 (ms) | Before R8 p95 (ms) | Before R8 Max (ms) | After R8 p50 (ms) | After R8 p95 (ms) | After R8 Max (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Actual whole call (`ImpactSession.query` + `renderImpact`) | 1497.78 | 2106.21 | 2460.86 | **201.18** | **291.54** | 312.52 |
| Replay: `openPublished` + `readMeta` + `readFiles` | 23.69 | 27.89 | 30.61 | 15.21 | 17.80 | 20.60 |
| Replay: `probe` (`stat`) | 102.44 | 111.25 | 132.95 | 65.14 | 69.76 | 69.89 |
| Replay: construct `ImpactQuery` (load) | 729.64 | 821.12 | 838.39 | **18.30** | **24.75** | 25.23 |
| Replay: query/traverse (`iq.query(target, 2)`) | 617.64 | 819.67 | 1237.95 | **119.77** | **143.04** | 203.53 |
| Replay: `renderImpact` | 0.14 | 0.58 | 1.15 | 0.09 | 0.22 | 0.32 |
| Replay: `db.close` | 0.39 | 0.61 | 0.77 | 0.39 | 0.63 | 0.64 |
| Replay: total staged | 1479.50 | 1667.23 | 2133.13 | **221.72** | **240.56** | **298.54** |

One-file body edit latency on `oh-my-pi` (`packages/ai/test/issue-6913-harmony-marker-escaping.test.ts`, target `#ESCAPED`):
- Wall time: **`26,338.98 ms` (`26.34 s`)**, `index.state = "updated"`, `updatedFiles = 1`, `lastReason = "1 changed · 0 removed · 1 resolved"`, phases `scan 2,149 ms · program 20,558 ms · extract 206 ms · resolve 195 ms · verify 2,196 ms · publish 0 ms`.

## 2. Historical synthetic fixture measurement (macOS arm64)

Host: macOS arm64; Node v24.22.0. Immutable artifacts: before `d6eb8e9` (the parent of `262c7c3`) and after `368695e`. Both runs used the **same literal temporary corpus directory** (`/var/folders/tj/skmpx5kj42x6jc2zsrkb3fgw0000gn/T/ksd-r8-corpus`); the harness rewrote the same config and source files before each run. Each run used a distinct cache directory (`cache-${process.pid}`), since each command ran in its own Node process. The corpus had a strict `tsconfig.json`, `ei.config.json` with impact enabled and `src/**` included, and 20 independent exported declarations (`src/target0.ts` … `src/target19.ts`). Each answer was verified as `kind: "result"`.

Commands executed (the temporary harness itself was deleted after measurement):

```sh
node /tmp/r8-time.mjs /tmp/r8-before.rd7Iq2/dist
node /tmp/r8-time.mjs /tmp/r8-after.BOpck1/dist
```

The harness imported `loadWorkspace` and `ImpactSession` from the specified snapshot's `dist/` modules, loaded the synthetic workspace with the per-process temporary cache, and ran an initial `session.query(targets.slice(0, 5), 1)` as warmup/index build. It then collected 20 samples. **Each sample is the elapsed time for a batch of 20 targets**, implemented as four sequential in-process `session.query(targets.slice(i, i + 5), 1)` calls for `i = 0, 5, 10, 15` (five-target API limit). Therefore these are p50/p95 of 20-target batches, **not individual whole-call p50/p95**. `performance.now()` wall-clock milliseconds were used; samples were sorted and nearest-rank percentiles computed as `samples[Math.ceil(q * samples.length) - 1]`. The exact throwaway script is no longer retained, so the commands above are exact but a byte-for-byte rerun of the harness is unavailable; the setup and timing procedure are recorded here.

| Artifact | samples | 20-target batch p50 | p95 |
| --- | ---: | ---: | ---: |
| before `d6eb8e9` | 20 | 56.092 ms | 60.873 ms |
| after `368695e` | 20 | 57.974 ms | 59.426 ms |

Phase split **probe / open / load / traverse / render: NOT AVAILABLE**. The public in-process session boundary combines those phases; no instrumentation or production changes were made, so attributing subphase durations would be fabricated. The whole-batch figures are synthetic fixture timings only, not a real-corpus gate and not evidence for the 20-target replay/hand-check lane, WSL, or live OMP. This corpus is deliberately small and contains no caller edges; the measurements do not establish representative impact-graph performance.
