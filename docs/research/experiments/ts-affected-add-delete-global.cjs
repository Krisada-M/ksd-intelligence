const ts = require('typescript');
const files = {
  '/p/a.ts': 'export function f(x: number): number { return x + 1; }\n',
  '/p/b.ts': 'import { f } from "./a";\nexport const g = () => f(1);\n',
  '/p/c.ts': 'export const unrelated = 1;\n',
  '/p/d.ts': 'import { g } from "./b";\nexport const h = g();\n',
};
const opts = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
function host() {
  const h = ts.createCompilerHost(opts);
  h.getSourceFile = (n, lv) => { const text = files[n] !== undefined ? files[n] : (ts.sys.readFile(n) ?? ''); const sf = ts.createSourceFile(n, text, lv, true); sf.version = ts.sys.createHash(text); return sf; };
  h.fileExists = n => files[n] !== undefined || ts.sys.fileExists(n);
  h.readFile = n => files[n] ?? ts.sys.readFile(n);
  h.directoryExists = d => d === '/p' || ts.sys.directoryExists(d);
  h.realpath = p => p;
  h.getCurrentDirectory = () => '/p';
  h.createHash = s => ts.sys.createHash(s);
  return h;
}
let builder;
function round(label) {
  builder = ts.createSemanticDiagnosticsBuilderProgram(Object.keys(files), opts, host(), builder);
  const affected = [];
  let r;
  while ((r = builder.getSemanticDiagnosticsOfNextAffectedFile())) {
    affected.push(r.affected.fileName ? r.affected.fileName.replace('/p/', '') : '<program>');
  }
  console.log(label.padEnd(34), '->', affected.filter(f => !f.includes('lib.')).join(', ') || '(none)');
}
console.log('typescript', ts.version);
files['/p/b.ts'] = 'import { f } from "./a";\nimport { z } from "./z";\nexport const g = () => f(1) + z;\n';
files['/p/m.ts'] = 'export function usesGlobal(): number { return (globalThis as any).K ?? 0; }\nexport const q: Extra = { n: 1 };\n';
round('cold (b imports missing ./z; m uses missing global type)');
round('no change');
files['/p/z.ts'] = 'export const z = 1;\n';
round('ADD z.ts that satisfies broken import in b');
files['/p/globals.d.ts'] = 'declare global { interface Extra { n: number } }\nexport {};\n';
round('ADD globals.d.ts declaring global type used by m');
delete files['/p/a.ts'];
round('DELETE a.ts (imported by b)');
files['/p/a.ts'] = 'export function f(x: number): number { return x; }\n';
round('RESTORE a.ts');
files['/p/a.ts'] = 'export function f(x: number): number { return x; }\nexport function extra() {}\n';
round('a.ts: add a new export');
files['/p/a.ts'] = 'function local() { return 1 }\nexport function f(x: number): number { return x + local(); }\nexport function extra() {}\n';
round('a.ts: internal-only change after shapes known');
