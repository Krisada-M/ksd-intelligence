# R8 measurement — SYNTHETIC-FIXTURE-LANE

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
