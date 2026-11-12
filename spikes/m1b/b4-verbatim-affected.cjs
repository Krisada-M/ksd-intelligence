const ts=require('/Users/mezn/workspaces/private/ksd-intelligence/node_modules/typescript');
const fs=require('fs'),path=require('path');
const d=fs.mkdtempSync('/tmp/m1bx/p');
fs.writeFileSync(d+'/a.ts','export function f(): number { return 1 }\n');
fs.writeFileSync(d+'/b.ts','import {f} from "./a";\nexport const x = f();\n');
fs.writeFileSync(d+'/c.ts','import {x} from "./b";\nexport const y: number = x;\n');
fs.writeFileSync(d+'/e.ts','export const z = 1;\n');
const files=['a','b','c','e'].map(n=>d+'/'+n+'.ts');
function run(extra){
  const options={strict:true,noEmit:true,incremental:true,tsBuildInfoFile:d+'/x.tsbuildinfo',module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,target:ts.ScriptTarget.ES2022,...extra};
  const ov=new Map();
  const host=ts.createIncrementalCompilerHost(options);
  const rf=host.readFile.bind(host);host.readFile=f=>ov.has(f)?ov.get(f):rf(f);
  const gsf=host.getSourceFile.bind(host);
  host.getSourceFile=(f,l,e)=>{ if(ov.has(f)) {const sf=ts.createSourceFile(f,ov.get(f),l);sf.version=host.createHash(ov.get(f));return sf} return gsf(f,l,e)};
  let old; const out=[];
  function round(name){
    const b=ts.createSemanticDiagnosticsBuilderProgram(files,options,host,old);
    const aff=[];let r;
    while((r=b.getSemanticDiagnosticsOfNextAffectedFile(undefined,sf=>{return false})))aff.push(path.basename(r.affected.fileName||'prog'));
    old=b;out.push(name+': '+aff.join(',')); }
  round('cold');round('none');
  ov.set(d+'/a.ts','export function f(): string { return "1" }\n');round('return-type');
  ov.set(d+'/a.ts','export function f(): string { return "2" }\n');round('body');
  console.log(JSON.stringify(extra),out.slice(2).join(' | '));
}
run({});run({isolatedModules:true});run({verbatimModuleSyntax:true});run({verbatimModuleSyntax:true,isolatedModules:false});
