'use strict';
// B4: builder program on the largest project (workspace) with in-memory overlay edits.
//   node|bun spikes/m1b/b4-builder.cjs pick                       -> writes out/b4-target.json (top candidates)
//   node|bun spikes/m1b/b4-builder.cjs rounds --chain=affected|check [--target=out/b4-target.json] [--out=f]
// Rounds: cold, nochange, body, sig (optional param), ret (return type), dglobal (global interface in types/),
//         dambient (member inside a `declare module` in types/assets/index.d.ts).
const fs = require('fs');
const path = require('path');
const C = require('./b-common.cjs');
const { ts } = C;

const ALIAS = 'workspace';

function loadTarget(flags) {
  const p = flags.target || path.join(C.OUT_DIR, 'b4-target.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return j.candidates ? j.candidates[0] : j;
}

function applyEdits(original, edits) {
  let t = original;
  for (const e of [...edits].sort((a, b) => b.pos - a.pos)) t = t.slice(0, e.pos) + e.insert + t.slice(e.pos);
  return t;
}

function main() {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const mode = pos[0] || 'rounds';
  const proj = C.parseConfig(C.resolveAlias(ALIAS));
  if (mode === 'pick') {
    const program = C.createProgramFor(proj);
    const candidates = C.pickTarget(program, proj.parsed, 8);
    const out = { runtime: C.RUNTIME, tsconfig: path.relative(C.OMP_SRC, proj.configPath), picked: candidates[0], candidates };
    C.writeOut('b4-target.json', out);
    console.log(JSON.stringify({ picked: out.picked, top: candidates.map((c) => `${c.rel} ${c.fn} importers=${c.importers}`) }));
    return;
  }
  const chain = flags.chain || 'affected';
  const target = loadTarget(flags);
  const dtsPath = path.join(C.OMP_SRC, 'types/assets/index.d.ts');
  const targetOrig = fs.readFileSync(target.file, 'utf8');
  const dtsOrig = fs.readFileSync(dtsPath, 'utf8');
  const ambAnchor = dtsOrig.indexOf('const content: string;');
  const targetEdits = [];
  const dtsEdits = [];
  const host = C.createOverlayHost(proj.parsed.options, { cache: true });
  const rounds = [];
  let prev;

  const round = (label, prepare) => {
    prepare && prepare();
    host.overlay.set(target.file, applyEdits(targetOrig, targetEdits));
    host.overlay.set(dtsPath, applyEdits(dtsOrig, dtsEdits));
    const t0 = C.now();
    const builder = ts.createSemanticDiagnosticsBuilderProgram(proj.parsed.fileNames, proj.parsed.options, host, prev);
    const createMs = C.now() - t0;
    const affected = [];
    let diags = 0;
    const ignore = chain === 'affected' ? (sf) => (affected.push(path.relative(C.OMP_SRC, sf.fileName)), true) : undefined;
    const t1 = C.now();
    let r;
    while ((r = builder.getSemanticDiagnosticsOfNextAffectedFile(undefined, ignore))) {
      if (chain !== 'affected' && r.affected) affected.push(r.affected.fileName ? path.relative(C.OMP_SRC, r.affected.fileName) : '<program>');
      diags += r.result.length;
    }
    const program = builder.getProgram();
    const rec = { round: label, createMs: C.round1(createMs), affectedMs: C.round1(C.now() - t1), affectedCount: affected.length, affectedNonDts: affected.filter((f) => !f.endsWith('.d.ts')).length, diags, sample: affected.slice(0, 6) };
    if (chain === 'affected' && affected.length) {
      const t2 = C.now();
      const resolver = C.createResolver(program);
      resolver.declPass(program.getSourceFiles(), new Set());
      const sfs = affected.map((f) => program.getSourceFile(path.join(C.OMP_SRC, f))).filter((sf) => sf && !sf.isDeclarationFile);
      const p = resolver.resolvePass(sfs);
      rec.resolveAffectedMs = C.round1(C.now() - t2);
      rec.resolveAffectedFiles = sfs.length;
      rec.resolveDetailMs = { identifiers: C.round1(p.identifierMs), imports: C.round1(p.importMs) };
      void resolver;
    }
    rounds.push(rec);
    prev = builder;
    console.error(`[b4 ${C.RUNTIME} ${chain}] ${label}: create=${rec.createMs}ms affected=${rec.affectedMs}ms n=${rec.affectedCount} (non-dts ${rec.affectedNonDts}) diags=${diags}${rec.resolveAffectedMs ? ' resolve=' + rec.resolveAffectedMs + 'ms' : ''}`);
  };

  round('cold');
  round('nochange');
  round('body edit', () => targetEdits.push({ pos: target.edits.body, insert: '/*m1b*/ void 0;' }));
  round('signature edit', () => targetEdits.push({ pos: target.edits.paramsEnd, insert: (target.edits.paramsEmpty ? '' : ', ') + 'm1bSig?: number' }));
  round('return type edit', () => targetEdits.push({ pos: target.edits.typeEnd, insert: ' | undefined' }));
  round('global d.ts edit', () => dtsEdits.push({ pos: dtsOrig.length, insert: '\ninterface M1bSpikeGlobal { m1b?: boolean }\n' }));
  round('ambient module member edit', () => dtsEdits.push({ pos: ambAnchor + 'const content: string;'.length, insert: '\n\tconst m1bExtra?: string;' }));

  const out = {
    runtime: C.RUNTIME,
    chain,
    tsconfig: path.relative(C.OMP_SRC, proj.configPath),
    typescript: ts.version,
    target: { rel: target.rel, fn: target.fn, importers: target.importers, retType: target.retType },
    maxRssMB: Math.round(C.maxRssKB() / 1024),
    hostStats: host.sfStats,
    rounds,
  };
  C.writeOut(String(flags.out || `b4-${chain}-${C.RUNTIME}.json`), out);
  console.log(JSON.stringify(out));
}

main();
