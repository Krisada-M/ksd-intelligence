// ESM under the repo's "type": "module". Imported relatively from ../probe-extension.mjs (A7).
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, totalmem, cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errText = error => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

// Plain filesystem walk, independent of the runtime's module resolver.
function findPackageFile(pkg, rel) {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (;;) {
    const candidate = join(dir, 'node_modules', pkg, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function a1Runtime() {
  const lines = ['## A1 runtime'];
  lines.push(`typeof Bun=${typeof globalThis.Bun} typeof Deno=${typeof globalThis.Deno}`);
  if (globalThis.Bun) lines.push(`Bun.version=${globalThis.Bun.version} Bun.revision=${globalThis.Bun.revision}`);
  lines.push(`process.platform=${process.platform} arch=${process.arch} execPath=${process.execPath}`);
  lines.push(`process.release=${JSON.stringify(process.release)}`);
  lines.push(`process.versions=${JSON.stringify(process.versions)}`);
  lines.push(`navigator.userAgent=${globalThis.navigator?.userAgent}`);
  lines.push(`host rssMB=${Math.round(process.memoryUsage().rss / 1e6)} totalmemGB=${(totalmem() / 1e9).toFixed(1)} cpus=${cpus().length}`);
  return lines;
}

function runWorker(data, options = {}, timeoutMs = 30_000) {
  return new Promise(resolve => {
    const started = performance.now();
    const messages = [];
    let settled = false;
    const settle = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, messages, ms: result.ms ?? performance.now() - started });
    };
    let worker;
    try {
      worker = new Worker(new URL('./probe-worker.js', import.meta.url), { workerData: data, ...options });
    } catch (error) {
      resolve({ ok: false, error: `constructor: ${errText(error)}`, messages, ms: 0 });
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      settle({ ok: false, error: 'timeout' });
    }, timeoutMs);
    worker.on('message', message => {
      messages.push(message);
      if (!message.final) return;
      const ms = performance.now() - started;
      // Exit after the final message is normal (the worker's main returned); only record it.
      worker.terminate().then(code => { messages.push({ terminateCode: code }); });
      settle({ ok: true, ms });
    });
    worker.on('error', error => settle({ ok: false, error: `${errText(error)} code=${error?.code}` }));
    worker.on('exit', code => settle({ ok: false, error: `exit before final message, code=${code}` }));
  });
}

async function a2Workers() {
  const lines = ['## A2 worker threads'];
  const echo = await runWorker({ mode: 'echo', payload: 'ping' });
  lines.push(`echo ok=${echo.ok} startToReplyMs=${echo.ms.toFixed(1)} reply=${JSON.stringify(echo.messages.find(m => m.final))} error=${echo.error ?? '-'}`);
  // Cap 32 MB; the worker allocates up to 512 MB in ~8 MB steps. Honoured = the worker dies before 512 MB.
  const oom = await runWorker({ mode: 'alloc', capMb: 512 }, { resourceLimits: { maxOldGenerationSizeMb: 32 } }, 60_000);
  const last = oom.messages.filter(m => m.allocatedMb !== undefined).at(-1);
  lines.push(`resourceLimits maxOldGenerationSizeMb=32: workerDied=${!oom.ok} error=${oom.error ?? '-'} lastReportedAllocatedMb=${last?.allocatedMb ?? 0} lastHeapUsedMb=${last?.heapUsedMb ?? '?'} reachedCap=${oom.ok}`);
  lines.push(`resourceLimits honoured=${!oom.ok && (last?.allocatedMb ?? 0) < 512}`);
  return lines;
}

async function a3TypeScript() {
  const lines = ['## A3 typescript'];
  try {
    const require = createRequire(import.meta.url);
    lines.push(`createRequire.resolve=${require.resolve('typescript')}`);
  } catch (error) {
    lines.push(`createRequire.resolve failed: ${errText(error)}`);
  }
  try {
    lines.push(`import.meta.resolve=${typeof import.meta.resolve === 'function' ? import.meta.resolve('typescript') : 'n/a'}`);
  } catch (error) {
    lines.push(`import.meta.resolve failed: ${errText(error)}`);
  }
  try {
    const started = performance.now();
    const mod = await import('typescript');
    const ts = mod.default ?? mod;
    lines.push(`main thread import ok version=${ts.version} importMs=${(performance.now() - started).toFixed(1)}`);
  } catch (error) {
    lines.push(`main thread import failed: ${errText(error)}`);
  }
  const tsPath = findPackageFile('typescript', 'lib/typescript.js');
  lines.push(`manual node_modules walk from probe dir -> ${tsPath ?? 'not found'}`);
  const inWorker = await runWorker({ mode: 'typescript' }, {}, 60_000);
  lines.push(`worker (bare specifier only): ok=${inWorker.ok} ${JSON.stringify(inWorker.messages.find(m => m.final))} error=${inWorker.error ?? '-'}`);
  const inWorkerAbs = await runWorker({ mode: 'typescript', tsPath }, {}, 60_000);
  lines.push(`worker (bare, then absolute path from main): ok=${inWorkerAbs.ok} ${JSON.stringify(inWorkerAbs.messages.find(m => m.final))} error=${inWorkerAbs.error ?? '-'}`);
  return lines;
}

function sqliteChecks(label, open) {
  const lines = [];
  let db;
  try {
    db = open(':memory:');
    const version = db.version();
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(name, body)');
    db.insert('calculateFee', 'computes the payment fee');
    db.insert('chargeCard', 'charges a card');
    const hits = db.match('fee');
    lines.push(`${label}: open ok sqlite_version=${version} fts5 MATCH 'fee' -> ${JSON.stringify(hits)}`);
  } catch (error) {
    lines.push(`${label}: FAILED ${errText(error)}`);
    return lines;
  } finally {
    db?.close();
  }
  const dir = mkdtempSync(join(tmpdir(), 'ei-m1b-sqlite-'));
  try {
    const file = join(dir, 'wal.db');
    const fileDb = open(file);
    const mode = fileDb.walMode();
    fileDb.exec('CREATE TABLE t (x INTEGER)');
    fileDb.exec('INSERT INTO t VALUES (1)');
    const walExists = existsSync(`${file}-wal`);
    fileDb.close();
    lines.push(`${label}: WAL journal_mode=${mode} walFileWhileOpen=${walExists}`);
  } catch (error) {
    lines.push(`${label}: WAL FAILED ${errText(error)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return lines;
}

async function a4Sqlite() {
  const lines = ['## A4 sqlite'];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    lines.push(...sqliteChecks('node:sqlite', path => {
      const db = new DatabaseSync(path);
      return {
        version: () => db.prepare('select sqlite_version() as v').get().v,
        exec: sql => db.exec(sql),
        insert: (n, b) => db.prepare('insert into docs values (?, ?)').run(n, b),
        match: q => db.prepare('select name from docs where docs match ?').all(q).map(r => r.name),
        walMode: () => db.prepare('PRAGMA journal_mode=WAL').get().journal_mode,
        close: () => db.close(),
      };
    }));
  } catch (error) {
    lines.push(`node:sqlite: import FAILED ${errText(error)}`);
  }
  try {
    const { Database } = await import('bun:sqlite');
    lines.push(...sqliteChecks('bun:sqlite', path => {
      const db = new Database(path);
      return {
        version: () => db.query('select sqlite_version() as v').get().v,
        exec: sql => db.exec(sql),
        insert: (n, b) => db.query('insert into docs values (?, ?)').run(n, b),
        match: q => db.query('select name from docs where docs match ?').all(q).map(r => r.name),
        walMode: () => db.query('PRAGMA journal_mode=WAL').get().journal_mode,
        close: () => db.close(),
      };
    }));
  } catch (error) {
    lines.push(`bun:sqlite: import FAILED ${errText(error)}`);
  }
  return lines;
}

function a7Module() {
  return [
    '## A7 module format',
    `probe-core import.meta.url=${import.meta.url}`,
    `worker URL=${new URL('./probe-worker.js', import.meta.url).href}`,
    `typeof require in ESM module=${typeof require}`,
  ];
}

export async function runFacts() {
  const sections = [a1Runtime(), await a2Workers(), await a3TypeScript(), await a4Sqlite(), a7Module()];
  return sections.map(s => s.join('\n')).join('\n');
}

export async function runProgress(onUpdate, signal) {
  const log = ['## A5 progress'];
  for (let i = 1; i <= 3; i++) {
    const at = new Date().toISOString();
    try {
      onUpdate?.({ content: [{ type: 'text', text: `ei_probe progress ${i}/3 at ${at}` }], details: { phase: 'progress', i } });
      log.push(`update ${i} sent at ${at}`);
    } catch (error) {
      log.push(`update ${i} threw ${errText(error)}`);
    }
    await sleep(1000);
  }
  log.push(`signal.aborted at end=${signal?.aborted}`);
  return log.join('\n');
}

export async function runBlock(seconds, onUpdate, signal) {
  const log = [`## A6 block ${seconds}s`];
  const started = Date.now();
  let abortedAt = null;
  signal?.addEventListener('abort', () => { abortedAt = Date.now() - started; });
  for (let s = 1; s <= seconds; s++) {
    await sleep(1000);
    if (s % 5 === 0) onUpdate?.({ content: [{ type: 'text', text: `ei_probe blocking ${s}/${seconds}s` }], details: { phase: 'block', s } });
  }
  log.push(`returned after ${Date.now() - started} ms; signal.aborted=${signal?.aborted} abortedAtMs=${abortedAt} reason=${signal?.reason ? errText(signal.reason) : '-'}`);
  return log.join('\n');
}
