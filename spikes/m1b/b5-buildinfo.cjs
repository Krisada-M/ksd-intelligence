'use strict';
// B5: can builder state be written and read back so a new process avoids a cold resolve?
//   node|bun b5-buildinfo.cjs write <alias>              process 1: incremental program, drain ALL semantic diagnostics, emit tsbuildinfo
//   node|bun b5-buildinfo.cjs read  <alias> none|body|sig process 2: fresh process, tsbuildinfo from disk, one own file edited via overlay
//   node|bun b5-buildinfo.cjs cold  <alias>              fresh process, no build info: program + restricted resolve of every own file
// Earlier version drained nothing before emit, so every file stayed "pending diagnostics" in the saved state;
// the read then reported the whole program as affected. This version drains first.
const fs = require('fs');
const path = require('path');
const C = require('./b-common.cjs');
const { ts } = C;

const mode = process.argv[2] || 'read';
const ALIAS = process.argv[3] || 'tools';
const EDIT = process.argv[4] || 'none';
const TAG = C.aliasName(ALIAS);
const DIR = path.join(C.TMP_ROOT, 'b5');
const BUILDINFO = path.join(DIR, `${TAG}.tsbuildinfo`);

const proj = C.parseConfig(C.resolveAlias(ALIAS));
const options = { ...proj.parsed.options, incremental: true, tsBuildInfoFile: BUILDINFO, noEmit: true };
const rss = () => Math.round(C.maxRssKB() / 1024);
const report = (name, out) => {
  C.writeOut(name, out);
  console.log(JSON.stringify(out));
};

// First own file: end-of-file comment = no shape change; appended export = shape change.
function editedText(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (EDIT === 'body') return text + '\n// m1b\n';
  if (EDIT === 'sig') return text + '\nexport const __m1bSig: number = 1;\n';
  return text;
}

if (mode === 'write') {
  fs.mkdirSync(DIR, { recursive: true });
  fs.rmSync(BUILDINFO, { force: true });
  const host = C.createOverlayHost(options, { cache: true, incremental: true });
  const t0 = C.now();
  const builder = ts.createIncrementalProgram({ rootNames: proj.parsed.fileNames, options, host, configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(proj.parsed) });
  const createMs = C.now() - t0;
  const t1 = C.now();
  let n = 0;
  while (builder.getSemanticDiagnosticsOfNextAffectedFile()) n++;
  const drainMs = C.now() - t1;
  const t2 = C.now();
  const er = builder.emit();
  const emitMs = C.now() - t2;
  const st = fs.existsSync(BUILDINFO) ? fs.statSync(BUILDINFO) : null;
  report(`b5-write-${TAG}-${C.RUNTIME}.json`, { runtime: C.RUNTIME, mode, alias: ALIAS, createMs: C.round1(createMs), drainMs: C.round1(drainMs), drainedFiles: n, emitMs: C.round1(emitMs), emitDiags: er.diagnostics.length, buildinfoBytes: st ? st.size : null, maxRssMB: rss() });
} else if (mode === 'cold') {
  const t0 = C.now();
  const program = ts.createProgram({ rootNames: proj.parsed.fileNames, options: proj.parsed.options, host: ts.createCompilerHost(proj.parsed.options) });
  const createMs = C.now() - t0;
  const own = C.ownSourceFiles(program, proj.parsed);
  const resolver = C.createResolver(program);
  resolver.declPass(program.getSourceFiles(), new Set(own));
  const t2 = C.now();
  resolver.resolvePass(own);
  report(`b5-cold-${TAG}-${C.RUNTIME}.json`, { runtime: C.RUNTIME, mode, alias: ALIAS, createMs: C.round1(createMs), resolveMs: C.round1(C.now() - t2), ownFiles: own.length, maxRssMB: rss() });
} else {
  const host = C.createOverlayHost(options, { cache: true, incremental: true });
  const target = proj.parsed.fileNames.find((f) => !f.endsWith('.d.ts') && !f.includes('node_modules') && /\.tsx?$/.test(f));
  host.overlay.set(target, editedText(target));
  const t0 = C.now();
  const builder = ts.createIncrementalProgram({ rootNames: proj.parsed.fileNames, options, host, configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(proj.parsed) });
  const createMs = C.now() - t0;
  const affected = [];
  const t1 = C.now();
  // No ignoreSourceFile: it would stop propagation through importers (found in B4).
  while (builder.getSemanticDiagnosticsOfNextAffectedFile(undefined, (sf) => (affected.push(sf.fileName), false))) void 0;
  const affectedMs = C.now() - t1;
  const prog = builder.getProgram();
  const own = C.ownSourceFiles(prog, proj.parsed);
  const resolver = C.createResolver(prog);
  resolver.declPass(prog.getSourceFiles(), new Set(own));
  const sfs = affected.map((f) => prog.getSourceFile(f)).filter((sf) => sf && !sf.isDeclarationFile);
  const t2 = C.now();
  resolver.resolvePass(sfs);
  report(`b5-read-${TAG}-${EDIT}-${C.RUNTIME}.json`, {
    runtime: C.RUNTIME, mode, alias: ALIAS, edit: EDIT, target: path.relative(C.OMP_SRC, target), buildinfoBytes: fs.statSync(BUILDINFO).size,
    createMs: C.round1(createMs), affectedMs: C.round1(affectedMs), affectedCount: affected.length, affectedNonDts: affected.filter((f) => !f.endsWith('.d.ts')).length,
    resolveAffectedMs: C.round1(C.now() - t2), resolveAffectedFiles: sfs.length, ownFiles: own.length, maxRssMB: rss(),
  });
}
