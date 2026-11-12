// Worker side of the M1b probe. Started via new URL('./probe-worker.js', import.meta.url).
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const heapUsedMb = () => Math.round((process.memoryUsage?.().heapUsed ?? 0) / 1e6);

async function main() {
  if (workerData.mode === 'echo') {
    parentPort.postMessage({ final: true, echo: workerData.payload, runtime: typeof Bun === 'undefined' ? 'node' : `bun ${Bun.version}` });
    return;
  }
  if (workerData.mode === 'alloc') {
    const keep = [];
    for (let mb = 8; mb <= workerData.capMb; mb += 8) {
      // ~8 MB of JS heap per step: 1M small integers in a plain array.
      keep.push(new Array(1_000_000).fill(mb));
      parentPort.postMessage({ allocatedMb: mb, heapUsedMb: heapUsedMb() });
    }
    parentPort.postMessage({ final: true, allocatedMb: workerData.capMb, heapUsedMb: heapUsedMb(), kept: keep.length });
    return;
  }
  if (workerData.mode === 'typescript') {
    const report = {};
    try {
      report.requireResolve = createRequire(import.meta.url).resolve('typescript');
    } catch (error) {
      report.requireResolve = `FAILED ${String(error?.message ?? error).split('\n')[0]}`;
    }
    const started = performance.now();
    let mod;
    try {
      mod = await import('typescript');
      report.bareImport = 'ok';
    } catch (error) {
      report.bareImport = `FAILED ${String(error?.message ?? error).split('\n')[0]}`;
    }
    if (!mod && workerData.tsPath) {
      try {
        mod = await import(workerData.tsPath);
        report.absoluteImport = `ok ${workerData.tsPath}`;
      } catch (error) {
        report.absoluteImport = `FAILED ${String(error?.message ?? error).split('\n')[0]}`;
      }
    }
    if (!mod) {
      parentPort.postMessage({ final: true, ...report });
      return;
    }
    const ts = mod.default ?? mod;
    const importMs = performance.now() - started;
    const host = ts.createCompilerHost({});
    const source = 'export function f(x: number) { return x + 1 }\nexport const y = f(2);\n';
    host.getSourceFile = (name, lv) => (name === '/m.ts' ? ts.createSourceFile(name, source, lv, true) : undefined);
    host.fileExists = name => name === '/m.ts';
    const program = ts.createProgram(['/m.ts'], { noLib: true, noEmit: true }, host);
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile('/m.ts');
    let resolvedCall = 'none';
    ts.forEachChild(sf, function walk(node) {
      if (ts.isCallExpression(node)) {
        const decl = checker.getSymbolAtLocation(node.expression)?.declarations?.[0];
        resolvedCall = decl ? `${node.expression.getText()} -> line ${sf.getLineAndCharacterOfPosition(decl.getStart()).line + 1}` : 'unresolved';
      }
      ts.forEachChild(node, walk);
    });
    parentPort.postMessage({ final: true, ...report, version: ts.version, importMs: Math.round(importMs), resolvedCall });
  }
}

main().catch(error => parentPort.postMessage({ final: true, error: String(error?.stack ?? error) }));
