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
round('cold build');
round('no change');
files['/p/a.ts'] = 'export function f(x: number): number { return x + 2; }\n';
round('a.ts body change only');
files['/p/a.ts'] = 'export function f(x: number, y = 0): number { return x + y; }\n';
round('a.ts signature change');
files['/p/a.ts'] = 'export function f(x: number, y = 0): string { return String(x + y); }\n';
round('a.ts return type change');
files['/p/e.ts'] = 'import { f } from "./a";\nexport const k = f(2);\n';
round('new file e.ts importing a');
delete files['/p/c.ts'];
round('delete c.ts');
// reference resolution check with the checker
const prog = builder.getProgram(); const ck = prog.getTypeChecker();
const b = prog.getSourceFile('/p/b.ts');
ts.forEachChild(b, function walk(n){ if (ts.isCallExpression(n)) { let s = ck.getSymbolAtLocation(n.expression); if (s && s.flags & ts.SymbolFlags.Alias) s = ck.getAliasedSymbol(s); const d = s?.declarations?.[0]; console.log('call', n.expression.getText(), '=>', d ? d.getSourceFile().fileName + ':' + (b.getLineAndCharacterOfPosition(d.getStart()).line+1) : 'unresolved'); } ts.forEachChild(n, walk); });
