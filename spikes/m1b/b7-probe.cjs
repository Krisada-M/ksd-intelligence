'use strict';
// B7: probe cost on omp-src: git ls-files (spawned) + stat of every listed path.
//   node spikes/m1b/b7-probe.cjs [--runs=3] [--out=f]
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('./b-common.cjs');

async function main() {
  const { flags } = C.parseArgs(process.argv.slice(2));
  const runs = Number(flags.runs || 3);
  const iters = [];
  for (let i = 0; i < runs; i++) {
    const t0 = C.now();
    const out = cp.spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: C.OMP_SRC, maxBuffer: 1 << 28 });
    const listMs = C.now() - t0;
    if (out.status !== 0) throw new Error('git ls-files failed: ' + out.stderr);
    const files = out.stdout.toString('utf8').split('\0').filter(Boolean);

    const t1 = C.now();
    let syncOk = 0;
    let syncMissing = 0;
    for (const f of files) {
      try {
        fs.statSync(path.join(C.OMP_SRC, f));
        syncOk++;
      } catch {
        syncMissing++;
      }
    }
    const statSyncMs = C.now() - t1;

    const t2 = C.now();
    let asyncOk = 0;
    let asyncMissing = 0;
    const CHUNK = 512;
    for (let s = 0; s < files.length; s += CHUNK) {
      await Promise.all(
        files.slice(s, s + CHUNK).map(async (f) => {
          try {
            await fs.promises.stat(path.join(C.OMP_SRC, f));
            asyncOk++;
          } catch {
            asyncMissing++;
          }
        }),
      );
    }
    const statAsyncMs = C.now() - t2;
    iters.push({ run: i + 1, count: files.length, listMs: C.round1(listMs), statSyncMs: C.round1(statSyncMs), statAsyncMs: C.round1(statAsyncMs), syncOk, syncMissing, asyncOk, asyncMissing, totalMs: C.round1(listMs + statSyncMs + statAsyncMs) });
    console.error(`[b7 ${C.RUNTIME}] run${i + 1}: count=${files.length} list=${C.round1(listMs)}ms statSync=${C.round1(statSyncMs)}ms statAsync=${C.round1(statAsyncMs)}ms`);
  }
  const med = (k) => C.round1(C.median(iters.map((x) => x[k])));
  const min = (k) => C.round1(Math.min(...iters.map((x) => x[k])));
  const res = { runtime: C.RUNTIME, ompSrc: C.OMP_SRC, iters, median: { listMs: med('listMs'), statSyncMs: med('statSyncMs'), statAsyncMs: med('statAsyncMs') }, min: { listMs: min('listMs'), statSyncMs: min('statSyncMs'), statAsyncMs: min('statAsyncMs') } };
  C.writeOut(String(flags.out || `b7-probe-${C.RUNTIME}.json`), res);
  console.log(JSON.stringify({ runtime: res.runtime, iters: iters.map((i) => ({ run: i.run, count: i.count, listMs: i.listMs, statSyncMs: i.statSyncMs, statAsyncMs: i.statAsyncMs })), median: res.median, min: res.min }));
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
