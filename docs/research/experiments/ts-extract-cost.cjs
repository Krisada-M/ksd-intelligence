const ts = require('typescript'); const fs = require('fs'); const path = require('path');
const root = process.argv[2];
const files = [];
(function walk(d){ for (const e of fs.readdirSync(d,{withFileTypes:true})) { if (e.name==='node_modules'||e.name==='dist'||e.name.startsWith('.')) continue; const p=path.join(d,e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p);} })(root);
const opts = { strict:true, noEmit:true, skipLibCheck:true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs:false };
let t=Date.now(); const prog = ts.createProgram(files, opts); const tProg=Date.now()-t;
t=Date.now(); const ck = prog.getTypeChecker();
let ids=0, resolved=0, cross=0, unresolved=0, loc=0;
for (const sf of prog.getSourceFiles()) { if (sf.isDeclarationFile || !files.includes(sf.fileName)) continue; loc += sf.getLineAndCharacterOfPosition(sf.end).line;
  (function visit(n){ if (ts.isIdentifier(n)) { ids++; let s = ck.getSymbolAtLocation(n); if (s && (s.flags & ts.SymbolFlags.Alias)) { try { s = ck.getAliasedSymbol(s);} catch {} } const d = s && s.declarations && s.declarations[0]; if (d) { resolved++; if (d.getSourceFile() !== sf) cross++; } else unresolved++; } ts.forEachChild(n, visit); })(sf); }
const tRes=Date.now()-t;
console.log(JSON.stringify({ files: files.length, loc, programMs: tProg, resolvePassMs: tRes, identifiers: ids, resolved, crossFile: cross, unresolved, rssMB: Math.round(process.memoryUsage().rss/1e6) }));
