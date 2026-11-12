'use strict';
// B3: sequential all-reachable-projects run inside a node:worker_threads Worker with a heap cap.
//   node spikes/m1b/b3-worker.cjs <capMb> <set> [--out=f]      (set: reachable | packages | alias list)
//   bisect: node spikes/m1b/b3-worker.cjs bisect <lo> <hi> <set>   finds smallest cap in [lo,hi] that completes
// Bun is expected to ignore resourceLimits; run the same command under bun to confirm.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const v8 = require('v8');
const C = require('./b-common.cjs');

async function workerMain() {
  const { runSequential, totals } = require('./b2-cost.cjs');
  const t0 = C.now();
  const res = await runSequential(C.resolveSet(workerData.set), {
    onProject: (r) => parentPort.postMessage({ phase: 'project', alias: r.alias, programMs: r.programMs, checkerMs: r.checkerMs, resolvePassMs: r.resolvePassMs, maxRssMB: r.maxRssMB }),
  });
  parentPort.postMessage({
    phase: 'done',
    heapLimitMB: Math.round(v8.getHeapStatistics().heap_size_limit / 1e6),
    totalMs: C.round1(C.now() - t0),
    totals: totals(res.per),
    per: res.per.map((p) => ({ alias: p.alias, programMs: p.programMs, checkerMs: p.checkerMs, declPassMs: p.declPassMs, resolvePassMs: p.resolvePassMs, ownFiles: p.ownFiles, programFiles: p.programFiles, maxRssMB: p.maxRssMB, rssAfterReleaseMB: p.rssAfterReleaseMB, recordsStored: p.summary.recordsStored })),
  });
  process.exit(0);
}

function runCapped(capMb, set, out) {
  return new Promise((resolve) => {
    const t0 = C.now();
    const w = new Worker(__filename, { resourceLimits: { maxOldGenerationSizeMb: capMb }, workerData: { set } });
    const res = { runtime: C.RUNTIME, capMb, set, phases: [], completed: false, oom: false };
    let lastErr = null;
    w.on('message', (m) => {
      if (m.phase === 'project') console.error(`[b3 ${C.RUNTIME} cap=${capMb}] ${m.alias} program=${m.programMs} checker=${m.checkerMs} resolve=${m.resolvePassMs} maxRSS=${m.maxRssMB}MB`);
      else Object.assign(res, m), (res.completed = true);
    });
    w.on('error', (e) => {
      lastErr = e;
      res.error = (e && (e.stack || e.message || String(e))).split('\n').slice(0, 3).join(' | ');
      res.oom = /ERR_WORKER_OUT_OF_MEMORY|heap out of memory|JavaScript heap/i.test(e && (e.message + e.stack) || String(e));
    });
    w.on('exit', (code) => {
      res.workerExitCode = code;
      res.wallMs = C.round1(C.now() - t0);
      res.mainThreadMaxRssMB = Math.round(C.maxRssKB() / 1024);
      resolve(res);
    });
    void out;
  });
}

async function main() {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  if (pos[0] === 'bisect') {
    let lo = Number(pos[1]);
    let hi = Number(pos[2]);
    const set = pos[3] || 'reachable';
    const at = async (cap) => (await runCapped(cap, set)).completed;
    if (!(await at(hi))) {
      const r = { runtime: C.RUNTIME, bisect: [lo, hi], set, result: 'NOT VERIFIED: even hi cap failed' };
      C.writeOut(String(flags.out || `b3-bisect-${C.RUNTIME}.json`), r);
      console.log(JSON.stringify(r));
      return;
    }
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await at(mid)) hi = mid;
      else lo = mid + 1;
    }
    const r = { runtime: C.RUNTIME, set, smallestCompletingCapMb: lo };
    C.writeOut(String(flags.out || `b3-bisect-${C.RUNTIME}.json`), r);
    console.log(JSON.stringify(r));
    return;
  }
  const capMb = Number(pos[0]);
  const set = pos[1] || 'reachable';
  const r = await runCapped(capMb, set);
  C.writeOut(String(flags.out || `b3-cap${capMb}-${set}-${C.RUNTIME}.json`), r);
  console.log(JSON.stringify(r));
}

if (isMainThread) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
else workerMain().catch((e) => { try { parentPort.postMessage({ phase: 'workerError', message: String(e && e.message) }); } catch {} process.exit(3); });
