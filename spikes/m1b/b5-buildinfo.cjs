'use strict';
// B5: incremental build info persistence (noEmit + incremental + tsBuildInfoFile in $TMPDIR).
//   node|bun spikes/m1b/b5-buildinfo.cjs write            process 1: createIncrementalProgram + emit -> tsbuildinfo
//   node|bun spikes/m1b/b5-buildinfo.cjs read --edit=body|sig|none   process 2: fresh, reads tsbuildinfo, one file edited (overlay)
//   node|bun spikes/m1b/b5-buildinfo.cjs cold             fresh process, no buildinfo: program + full restricted resolve (baseline)
const fs = require('fs');
const path = require('path');
const C = require('./b-common.cjs');
const { ts } = C;

const ALIAS = 'workspace';
const DIR = path.join(C.TMP_ROOT, 'b5');
const BUILDINFO = path.join(DIR, 'tsconfig.workspace.tsbuildinfo');

function optsFor(proj) {
  return { ...proj.parsed.options, incremental: true, tsBuildInfoFile: BUILDINFO, noEmit: true };
}

function targetEdits(target, kind) {
  if (kind === 'body') return [{ pos: target.edits.body, insert: '/*m1b*/ void 0;' }];
  if (kind === 'sig') return [{ pos: target.edits.paramsEnd, insert: (target.edits.paramsEmpty ? '' : ', ') + 'm1bSig?: number' }];
  return [];
}

function run(setName) {
  const proj = C.parseConfig(C.resolveAlias(ALIAS));
  const options = optsFor(proj);
  const host = C.createOverlayHost(options, { cache: true, incremental: true });
  const target = JSON.parse(fs.readFileSync(path.join(C.OUT_DIR, 'b4-target.json'), 'utf8'));
  const picked = target.candidates ? target.candidates[0] : target;

  if (setName === 'write') {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    const t0 = C.now();
    const program = ts.createIncrementalProgram({ rootNames: proj.parsed.fileNames, options, host, configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(proj.parsed) });
    const createMs = C.now() - t0;
    const t1 = C.now();
    const er = program.emit();
    const emitMs = C.now() - t1;
    const st = fs.existsSync(BUILDINFO) ? fs.statSync(BUILDINFO) : null;
    const out = { runtime: C.RUNTIME, mode: setName, createMs: C.round1(createMs), programFiles: program.getProgram().getSourceFiles().length, emitMs: C.round1(emitMs), emitDiags: er.diagnostics.length, buildinfoBytes: st ? st.size : null, maxRssMB: Math.round(C.maxRssKB() / 1024) };
    C.writeOut(`b5-write-${C.RUNTIME}.json`, out);
    console.log(JSON.stringify(out));
    return;
  }

  const edit = setName === 'read' ? 'body' : 'none';
  const t = JSON.parse(fs.readFileSync(path.join(C.OUT_DIR, 'b4-target.json'), 'utf8'));
  const tgt = t.candidates ? t.candidates[0] : t;

  if (setName === 'cold') {
    const t0 = C.now();
    const program = ts.createProgram({ rootNames: proj.parsed.fileNames, options: { ...proj.parsed.options }, host: ts.createCompilerHost(proj.parsed.options) });
    const createMs = C.now() - t0;
    const t1 = C.now();
    const checker = program.getTypeChecker();
    const checkerMs = C.now() - t1;
    const own = C.ownSourceFiles(program, proj.parsed);
    const resolver = C.createResolver(program);
    resolver.declPass(program.getSourceFiles(), new Set(own));
    const t2 = C.now();
    resolver.resolvePass(own);
    const resolveMs = C.now() - t2;
    const out = { runtime: C.RUNTIME, mode: 'cold', createMs: C.round1(createMs), checkerMs: C.round1(checkerMs), resolveMs: C.round1(resolveMs), ownFiles: own.length, maxRssMB: Math.round(C.maxRssKB() / 1024) };
    C.writeOut(`b5-cold-${C.RUNTIME}.json`, out);
    console.log(JSON.stringify(out));
    return;
  }

  // read: fresh process with existing buildinfo + one edited file
  const edits = targetEdits(tgt, edit);
  const original = fs.readFileSync(tgt.file, 'utf8');
  let text = original;
  for (const e of [...edits].sort((a, b) => b.pos - a.pos)) text = text.slice(0, e.pos) + e.insert + text.slice(e.pos);
  host.overlay.set(tgt.file, text);
  const tBI = C.now();
  const oldBuilder = undefined; // skipped: readBuilderProgram host mismatch, see b5 notes
  const biReadMs = C.now() - tBI;
  const t0 = C.now();
  const program = ts.createIncrementalProgram({ rootNames: proj.parsed.fileNames, options, host, configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(proj.parsed) });
  const createMs = C.now() - t0;
  const builder = program;
  const affected = [];
  const t1 = C.now();
  let r;
  while ((r = builder.getSemanticDiagnosticsOfNextAffectedFile(undefined, (sf) => (affected.push(path.relative(C.OMP_SRC, sf.fileName)), true)))) void r;
  const affectedMs = C.now() - t1;
  const prog = builder.getProgram();
  const own = C.ownSourceFiles(prog, proj.parsed);
  const resolver = C.createResolver(prog);
  resolver.declPass(prog.getSourceFiles(), new Set(own));
  const t2 = C.now();
  const sfs = affected.map((f) => prog.getSourceFile(path.join(C.OMP_SRC, f))).filter((sf) => sf && !sf.isDeclarationFile);
  resolver.resolvePass(sfs);
  const resolveAffectedMs = C.now() - t2;
  const out = {
    runtime: C.RUNTIME,
    mode: 'read',
    edit,
    target: tgt.rel + '#' + tgt.fn,
    buildinfoBytes: fs.existsSync(BUILDINFO) ? fs.statSync(BUILDINFO).size : null,
    oldBuilderProgramFiles: oldBuilder ? oldBuilder.getSourceFiles().length : null,
    biReadMs: C.round1(biReadMs),
    createMs: C.round1(createMs),
    affectedMs: C.round1(affectedMs),
    affectedCount: affected.length,
    affectedNonDts: affected.filter((f) => !f.endsWith('.d.ts')).length,
    affectedSample: affected.slice(0, 8),
    resolveAffectedMs: C.round1(resolveAffectedMs),
    resolveAffectedFiles: sfs.length,
    maxRssMB: Math.round(C.maxRssKB() / 1024),
  };
  C.writeOut(`b5-read-${C.RUNTIME}-${edit}.json`, out);
  console.log(JSON.stringify(out));
}

const mode = process.argv[2] || 'read';
run(mode);
