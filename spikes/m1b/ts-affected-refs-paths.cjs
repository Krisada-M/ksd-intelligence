'use strict';
// B6: synthetic workspace in $TMPDIR: pkg-a (composite, declaration) + pkg-b, imported via paths alias or workspace package name,
// with and without project references. Reports affected sets in pkg-b's builder program and where a cross-package call resolves.
//   node|bun spikes/m1b/ts-affected-refs-paths.cjs [--out=f]
const fs = require('fs');
const path = require('path');
const C = require('./b-common.cjs');
const { ts } = C;

const BASE = path.join(C.TMP_ROOT, 'b6');

const A_SRC = {
  'src/index.ts': 'export { f } from "./util";\nexport { g } from "./util2";\n',
  'src/util.ts': 'export function f(x: number): number { return x + 1; }\n',
  'src/util2.ts': 'export function g(): string { return "g"; }\n',
  'src/unused.ts': 'export const unusedValue = 1;\n',
};

function write(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function setupVariant(name, { references, paths, wsLink, spec }) {
  const dir = path.join(BASE, name);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [f, t] of Object.entries(A_SRC)) write(path.join(dir, 'pkg-a', f), t);
  write(
    path.join(dir, 'pkg-a/package.json'),
    JSON.stringify({ name: '@ws/pkg-a', version: '0.0.1', type: 'module', exports: { '.': { types: './src/index.ts', default: './src/index.ts' } } }, null, 2),
  );
  write(
    path.join(dir, 'pkg-a/tsconfig.json'),
    JSON.stringify({ compilerOptions: { composite: true, declaration: true, outDir: 'dist', rootDir: 'src', strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' }, include: ['src'] }, null, 2),
  );
  const co = { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', composite: true, declaration: true, outDir: 'dist', rootDir: 'src', baseUrl: '.' };
  if (paths) co.paths = { '@a/*': ['../pkg-a/src/*'] };
  const bj = { compilerOptions: co, include: ['src'] };
  if (references) bj.references = [{ path: '../pkg-a' }];
  write(path.join(dir, 'pkg-b/tsconfig.json'), JSON.stringify(bj, null, 2));
  write(path.join(dir, 'pkg-b/src/b1.ts'), `import { f } from "${spec}";\nexport const callF = () => f(1);\n`);
  write(path.join(dir, 'pkg-b/src/b2.ts'), 'import { callF } from "./b1";\nexport const v = callF();\n');
  write(path.join(dir, 'pkg-b/src/b3.ts'), 'export const unrelated = 1;\n');
  if (wsLink) {
    write(path.join(dir, 'node_modules/@ws/keep'), '');
    fs.rmSync(path.join(dir, 'node_modules/@ws/keep'));
    fs.symlinkSync(path.join(dir, 'pkg-a'), path.join(dir, 'node_modules/@ws/pkg-a'), 'dir');
  }
  return dir;
}

function parseCfg(p) {
  return C.parseConfig(p);
}

function buildA(dir) {
  const proj = parseCfg(path.join(dir, 'pkg-a/tsconfig.json'));
  const prog = C.createProgramFor(proj);
  const r = prog.emit();
  return { diags: r.diagnostics.map(C.flattenDiag), emitSkipped: r.emitSkipped };
}

function bBuilder(dir, prev, useSourceRedirect) {
  const proj = parseCfg(path.join(dir, 'pkg-b/tsconfig.json'));
  const host = C.createOverlayHost(proj.parsed.options, { cache: true });
  if (useSourceRedirect) host.useSourceOfProjectReferenceRedirect = () => true;
  const builder = ts.createSemanticDiagnosticsBuilderProgram(proj.parsed.fileNames, proj.parsed.options, host, prev);
  return { proj, host, builder };
}

function drain(builder, label, round) {
  const affected = [];
  let diags = 0;
  let r;
  const t = C.now();
  while ((r = builder.getSemanticDiagnosticsOfNextAffectedFile(undefined, (sf) => { affected.push(path.relative(path.dirname(path.dirname(sf.fileName)), sf.fileName)); return true; }))) {
    if (r.affected) diags += r.result.length;
  }
  return { label, round, ms: C.round1(C.now() - t), affected, diags };
}

function resolveCheck(dir, builder, spec) {
  const prog = builder.getProgram();
  const ck = prog.getTypeChecker();
  const b1 = prog.getSourceFile(path.join(dir, 'pkg-b/src/b1.ts'));
  if (!b1) return { error: 'b1.ts not in program' };
  let out = null;
  (function visit(n) {
    if (ts.isCallExpression(n) && n.expression.getText(b1) === 'f') {
      let s = ck.getSymbolAtLocation(n.expression);
      if (s && s.flags & ts.SymbolFlags.Alias) s = ck.getAliasedSymbol(s);
      const d = s && s.declarations && s.declarations[0];
      out = d ? path.relative(path.dirname(path.dirname(path.dirname(d.getSourceFile().fileName))), d.getSourceFile().fileName) : 'unresolved';
    }
    ts.forEachChild(n, visit);
  })(b1);
  const files = prog.getSourceFiles().map((f) => path.relative(path.dirname(path.dirname(f.fileName)), f.fileName)).filter((f) => !f.includes('typescript/lib'));
  return { fDeclaresIn: out, programFiles: files.sort() };
}

function runVariant(name, opts) {
  const dir = setupVariant(name, opts);
  const res = { variant: name, ...opts, rounds: [] };
  let tA = C.now();
  buildA(dir);
  res.buildAMs = C.round1(C.now() - tA);
  let state = null;
  const round = (label) => {
    const t0 = C.now();
    const { builder } = bBuilder(dir, state && state.builder, opts.useSourceRedirect);
    const createMs = C.round1(C.now() - t0);
    const d = drain(builder, name, label);
    d.createMs = createMs;
    res.rounds.push(d);
    state = { builder };
  };
  round('cold');
  round('nochange');
  const util = path.join(dir, 'pkg-a/src/util.ts');
  const orig = fs.readFileSync(util, 'utf8');
  tA = C.now();
  fs.writeFileSync(util, orig.replace('return x + 1;', 'return x + 2;'));
  buildA(dir);
  res.rebuildAMs = C.round1(C.now() - tA);
  round('body edit in pkg-a (after rebuild)');
  fs.writeFileSync(util, orig.replace('f(x: number): number', 'f(x: number, m1b = 0): number'));
  buildA(dir);
  round('signature edit (after rebuild)');
  fs.writeFileSync(util, orig.replace('f(x: number): number', 'f(x: number): number | undefined'));
  buildA(dir);
  round('return type edit (after rebuild)');
  write(path.join(dir, 'pkg-b/src/new.ts'), `import { f } from "${opts.spec}";\nexport const nf = f(2);\n`);
  round('new file in pkg-b importing pkg-a');
  fs.rmSync(path.join(dir, 'pkg-a/src/unused.ts'));
  buildA(dir);
  round('delete unused file in pkg-a (after rebuild)');
  const fin = bBuilder(dir, state && state.builder, opts.useSourceRedirect);
  res.resolve = resolveCheck(dir, fin.builder, opts.spec);
  return res;
}

const variants = [
  { name: 'v1-paths-refs', opts: { references: true, paths: true, spec: '@a/util' } },
  { name: 'v2-paths-only', opts: { references: false, paths: true, spec: '@a/util' } },
  { name: 'v3-refs-source-redirect', opts: { references: true, paths: true, spec: '@a/util', useSourceRedirect: true } },
  { name: 'v4-ws-name-refs', opts: { references: true, wsLink: true, spec: '@ws/pkg-a' } },
  { name: 'v5-ws-name-only', opts: { references: false, wsLink: true, spec: '@ws/pkg-a' } },
];

function main() {
  const { flags } = C.parseArgs(process.argv.slice(2));
  const out = { runtime: C.RUNTIME, typescript: ts.version, base: BASE, variants: variants.map((v) => runVariant(v.name, v.opts)) };
  C.writeOut(String(flags.out || `b6-refs-paths-${C.RUNTIME}.json`), out);
  for (const v of out.variants) {
    console.log(`\n== ${v.variant} (spec ${v.spec}, references=${v.references})`);
    for (const r of v.rounds) console.log(`  ${r.round.padEnd(38)} create=${r.createMs}ms drain=${r.ms}ms affected=[${r.affected.join(', ') || '-'}]`);
    console.log(`  f() declaration resolves to: ${v.resolve.fDeclaresIn}`);
    console.log(`  program files: ${(v.resolve.programFiles || []).join(' | ')}`);
  }
}

main();
