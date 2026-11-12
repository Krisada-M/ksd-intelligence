'use strict';
// B2/B8: cost of config parse + createProgram + ADR 0003 restricted resolve pass, per project.
//   node spikes/m1b/b2-cost.cjs one <alias> [--uniq] [--out=file]        fresh process, one project (prints one JSON line)
//   node spikes/m1b/b2-cost.cjs seq <set|a,b,c> [--gc] [--uniq]          one process, projects sequentially, each program released
//   node spikes/m1b/b2-cost.cjs fresh <set|a,b,c> [--repeat=N]           driver: spawns `one` per project under /usr/bin/time -l
// alias: workspace | tools | pkg:<dir> | tsconfig path.  set: reachable | packages
// Same file runs under node and bun.
const fs = require('fs');
const path = require('path');
const C = require('./b-common.cjs');

function heapMB() {
  return Math.round(process.memoryUsage().heapUsed / 1e6);
}

function measureProject(alias, opts = {}) {
  const phases = [];
  const mark = (name) => phases.push({ name, maxRssMB: Math.round(C.maxRssKB() / 1024), rssMB: Math.round(C.rssKB() / 1024), heapMB: heapMB() });
  const r = { alias, runtime: C.RUNTIME, startedAtUptimeS: C.round1(process.uptime()) };
  const tAll = C.now();

  const proj = C.parseConfig(C.resolveAlias(alias));
  r.configMs = C.round1(proj.parseMs);
  r.rootNames = proj.parsed.fileNames.length;
  r.configErrors = proj.parsed.errors.map(C.flattenDiag);
  mark('config');

  let t = C.now();
  let program = C.createProgramFor(proj);
  r.programMs = C.round1(C.now() - t);
  r.programFiles = program.getSourceFiles().length;
  r.programFilesInNodeModules = program.getSourceFiles().filter((f) => f.fileName.includes('/node_modules/')).length;
  mark('program');

  t = C.now();
  const resolver = C.createResolver(program, { uniqAll: !!opts.uniq });
  r.checkerMs = C.round1(C.now() - t); // getTypeChecker: binds every file + merges globals
  mark('checker');

  const own = C.ownSourceFiles(program, proj.parsed);
  r.ownFiles = own.length;
  t = C.now();
  resolver.declPass(program.getSourceFiles(), new Set(own));
  r.declPassMs = C.round1(C.now() - t);
  mark('declPass');

  t = C.now();
  const pass = resolver.resolvePass(own);
  r.resolvePassMs = C.round1(C.now() - t);
  r.identifierMs = C.round1(pass.identifierMs);
  r.importMs = C.round1(pass.importMs);
  mark('resolvePass');

  r.totalMs = C.round1(C.now() - tAll);
  r.coldIndexMs = C.round1(r.programMs + r.checkerMs + r.declPassMs + r.resolvePassMs); // program..resolve, excludes config parse
  r.phases = phases;
  r.maxRssMB = Math.round(C.maxRssKB() / 1024);
  r.summary = resolver.summary();
  program = undefined;
  return r;
}

async function runSequential(aliases, opts = {}) {
  const t0 = C.now();
  const per = [];
  for (const a of aliases) {
    const r = measureProject(a, opts);
    per.push(r);
    if (opts.gc) {
      C.runGc();
      r.rssAfterGcMB = Math.round(C.rssKB() / 1024);
      r.heapAfterGcMB = heapMB();
    }
    r.rssAfterReleaseMB = Math.round(C.rssKB() / 1024);
    if (opts.onProject) opts.onProject(r);
  }
  return { runtime: C.RUNTIME, mode: 'seq', gc: !!opts.gc, projects: aliases, totalMs: C.round1(C.now() - t0), maxRssMB: Math.round(C.maxRssKB() / 1024), per };
}

function totals(per) {
  const sum = (f) => per.reduce((a, p) => a + f(p), 0);
  return { programMs: C.round1(sum((p) => p.programMs)), checkerMs: C.round1(sum((p) => p.checkerMs)), resolvePassMs: C.round1(sum((p) => p.resolvePassMs)), declPassMs: C.round1(sum((p) => p.declPassMs)) };
}

function compact(r) {
  const { summary, phases, ...rest } = r;
  return { ...rest, uses: summary.uses, recordsStored: summary.recordsStored, identifiers: summary.identifiers, lines: summary.lines, imports: summary.imports };
}

async function main() {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const [mode, arg] = pos;
  if (mode === 'one') {
    const r = measureProject(arg, { uniq: !!flags.uniq });
    const line = JSON.stringify(r);
    if (flags.out) C.writeOut(String(flags.out), r);
    console.log(line);
    return;
  }
  if (mode === 'seq') {
    const res = await runSequential(C.resolveSet(arg), { gc: !!flags.gc, uniq: !!flags.uniq, onProject: (r) => console.error(`[seq ${C.RUNTIME}] ${r.alias} program=${r.programMs}ms checker=${r.checkerMs}ms resolve=${r.resolvePassMs}ms maxRSS=${r.maxRssMB}MB rssAfterRelease=${r.rssAfterReleaseMB}MB`) });
    res.totals = totals(res.per);
    if (flags.out) C.writeOut(String(flags.out), res);
    console.log(JSON.stringify(res));
    return;
  }
  if (mode === 'fresh') {
    const aliases = C.resolveSet(arg);
    const repeat = Number(flags.repeat || 1);
    const rows = [];
    for (let rep = 1; rep <= repeat; rep++) {
      for (const a of aliases) {
        const execArgv = C.RUNTIME === 'node' ? ['--max-old-space-size=' + (flags.heapMb || 6144)] : [];
        const t = C.spawnTimed(__filename, ['one', a, ...(flags.uniq ? ['--uniq'] : [])], { execArgv });
        if (t.code !== 0) {
          rows.push({ alias: a, rep, error: true, code: t.code, signal: t.signal, wallMs: C.round1(t.wallMs), timeMaxRssMB: t.maxRssBytes ? Math.round(t.maxRssBytes / 1e6) : null, stderrTail: (t.stderr || '').slice(-600) });
          console.error(`[fresh ${C.RUNTIME}] ${a} rep${rep} FAILED code=${t.code} signal=${t.signal}`);
          continue;
        }
        const r = JSON.parse(t.stdout.trim().split('\n').pop());
        rows.push({ rep, wallMs: C.round1(t.wallMs), timeMaxRssMB: Math.round(t.maxRssBytes / 1e6), ...compact(r) });
        console.error(`[fresh ${C.RUNTIME}] ${a} rep${rep} wall=${C.round1(t.wallMs)}ms program=${r.programMs} checker=${r.checkerMs} decl=${r.declPassMs} resolve=${r.resolvePassMs} resourceUsageMaxRSS=${r.maxRssMB}MB time-l=${Math.round(t.maxRssBytes / 1e6)}MB`);
      }
    }
    const out = { runtime: C.RUNTIME, mode: 'fresh', set: arg, repeat, rows };
    if (flags.out) C.writeOut(String(flags.out), out);
    console.log(JSON.stringify(out));
    return;
  }
  console.error('usage: b2-cost.cjs one|seq|fresh ...');
  process.exit(2);
}

module.exports = { measureProject, runSequential, totals };

if (require.main === module) {
  main().catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}
