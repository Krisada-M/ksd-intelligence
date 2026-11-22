import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import ts from 'typescript';
import extension, { type OmpExtensionApi } from '../../src/adapters/omp/extension.js';
import { AUDIT_FILE } from '../../src/core/audit/index.js';
import { buildIndex, type EngineOutcome } from '../../src/core/engine/build.js';
import { acquireBuildLock } from '../../src/core/engine/lock.js';
import { loadWorkspace, type Workspace } from '../../src/core/engine/workspace.js';
import { ImpactSession } from '../../src/core/impact/session.js';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { impactConfigHash } from '../../src/core/indexing/stamp.js';
import {
  SEARCH_BUDGET,
  buildFtsQuery,
  querySearch,
  quoteFtsLiteral,
  renderSearch,
  renderSearchOutcome,
  runSearch,
  type SearchHit,
} from '../../src/index.js';
import {
  SCHEMA_VERSION,
  beginBuild,
  publishBuild,
  writeFiles,
  writeMeta,
  type FileRecord,
} from '../../src/storage/sqlite.js';
import { ensureRuntime, FIXTURE } from './index-helpers.js';

const execFileAsync = promisify(execFile);

function findRepoRoot(startUrl: string): string {
  let dir = new URL('.', startUrl).pathname;
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('package.json not found');
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(import.meta.url);
const CLI_ENTRY = join(REPO_ROOT, 'dist/adapters/cli/main.js');
const MCP_TOOLS_URL = new URL('../../../scripts/mcp/tools.mjs', import.meta.url).href;

before(ensureRuntime);

function mockPi(): {
  pi: OmpExtensionApi;
  registered: Parameters<OmpExtensionApi['registerTool']>[0][];
} {
  const registered: Parameters<OmpExtensionApi['registerTool']>[0][] = [];
  const makeSchema = (): ReturnType<OmpExtensionApi['zod']['string']> => {
    const self = {
      optional: () => self,
      describe: () => self,
      int: () => self,
      min: () => self,
      max: () => self,
    };
    return self;
  };
  const pi: OmpExtensionApi = {
    zod: {
      string: makeSchema,
      boolean: makeSchema,
      number: makeSchema,
      array: makeSchema,
      enum: makeSchema,
      object: makeSchema,
    },
    registerTool: (tool) => {
      registered.push(tool);
    },
  };
  return { pi, registered };
}

function gatedBuild(): {
  build: (work: Workspace, options: Parameters<typeof buildIndex>[1]) => Promise<EngineOutcome>;
  release: () => void;
  settled: () => Promise<void>;
} {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const running: Promise<EngineOutcome>[] = [];
  return {
    build: (work, options) => {
      const task = gate.then(() => buildIndex(work, options));
      running.push(task);
      return task;
    },
    release: () => open(),
    settled: async () => {
      await Promise.allSettled(running);
    },
  };
}

async function createRepo(
  workDir: string,
  files: Record<string, string>,
  extraConfig: Record<string, unknown> = {},
): Promise<{ repo: string; cacheHome: string; workspace: Workspace }> {
  const repo = join(workDir, 'repo');
  const cacheHome = join(workDir, 'home');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(cacheHome, { recursive: true });
  await writeFile(
    join(repo, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  await writeFile(
    join(repo, 'ei.config.json'),
    JSON.stringify({
      impact: { include: ['src/**'], exclude: ['**/dist/**'], freshness: 'stat' },
      search: { enabled: true, semantic: false },
      ...extraConfig,
    }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repo, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const workspace = await loadWorkspace(repo, cacheHome);
  return { repo, cacheHome, workspace };
}

describe('M6a Round 2 — query, ranking, rendering, CLI/OMP/MCP parity, audit', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  }

  it('1. neutralizes FTS5 operators and punctuation fuzzing without SQL/FTS errors', async () => {
    const work = await makeTempDir('ei-search-fuzz-');
    const { repo, workspace } = await createRepo(work, {
      'src/ops.ts': [
        'export function alphaBeta() { return 1; }',
        'export function alphabet() { return 2; }',
        'export function fooTarget() { return 3; }',
        'export function barOnly() { return 4; }',
        'export function fooOrBar() { return 5; }',
        'export function fooBar() { return 6; }',
        'export function foobar() { return 7; }',
      ].join('\n'),
    });
    const report = await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });
    assert.deepEqual(report.problems, []);

    const session = new ImpactSession(workspace);
    const fuzzQueries = [
      '"',
      '*',
      '-',
      '(',
      ':',
      'NEAR',
      'OR',
      'AND',
      'NOT',
      'name_tokens:foo',
      'bogus_col:foo',
      'foo\\',
      '"foo" NEAR/3 bar*',
      'foo -bar',
      '"*-(:)\\!@#$%^&=[]{}|;,.<>?/'.repeat(8).slice(0, 200),
    ];
    for (const q of fuzzQueries) {
      const outcome = await runSearch(session, { query: q });
      assert.equal(
        outcome.kind,
        'result',
        `query ${JSON.stringify(q)} failed: ${JSON.stringify(outcome)}`,
      );
    }

    const notRes = await runSearch(session, { query: 'alpha NOT beta' });
    assert.equal(notRes.kind, 'result');
    assert.ok(notRes.value.hits.some((h) => h.symbol === 'src/ops.ts#alphaBeta'));

    const starRes = await runSearch(session, { query: 'alpha*' });
    assert.equal(starRes.kind, 'result');
    assert.equal(
      starRes.value.hits.some((h) => h.symbol === 'src/ops.ts#alphabet'),
      false,
      'alpha* must never prefix-match alphabet',
    );

    const orRes = await runSearch(session, { query: 'foo OR bar' });
    assert.equal(orRes.kind, 'result');
    assert.equal(orRes.value.hits[0]?.symbol, 'src/ops.ts#fooOrBar');

    const built = buildFtsQuery('foo -bar');
    assert.equal(built.matchExpr, '"foo" OR "bar" OR "-bar"');
  });

  it('2. validates empty, boundary, and disabled inputs cleanly without throwing', async () => {
    const work = await makeTempDir('ei-search-bounds-');
    const { repo, workspace } = await createRepo(work, {
      'src/sample.ts':
        'export function a() { return 1; }\nexport function validSymbol() { return 2; }\n',
    });
    await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });
    const session = new ImpactSession(workspace);

    const invalidCases: Array<{ query: unknown; limit?: unknown }> = [
      { query: '' },
      { query: '   ' },
      { query: '\t\n' },
      { query: 'x'.repeat(201) },
      { query: 'a\0b' },
      { query: 123 },
      { query: 'validSymbol', limit: 0 },
      { query: 'validSymbol', limit: 21 },
      { query: 'validSymbol', limit: 1.5 },
    ];
    for (const c of invalidCases) {
      const out = await runSearch(session, c);
      assert.equal(out.kind, 'failure');
      assert.equal(out.code, 'INVALID_INPUT');
      assert.match(renderSearchOutcome(out), /^INVALID_INPUT:/);
    }

    const oneChar = await runSearch(session, { query: 'a', limit: 1 });
    assert.equal(oneChar.kind, 'result');
    assert.equal(oneChar.value.hits.length, 1);
    assert.equal(oneChar.value.hits[0]?.symbol, 'src/sample.ts#a');

    const noMatch = await runSearch(session, { query: 'xylophoneQuasarUnmatched', limit: 20 });
    assert.equal(noMatch.kind, 'result');
    assert.equal(noMatch.value.hits.length, 0);
    const renderedNoMatch = renderSearchOutcome(noMatch);
    assert.match(
      renderedNoMatch,
      /^SEARCH "xylophoneQuasarUnmatched" — no matches\. Try identifiers that would appear in the code\./,
    );
    assert.match(renderedNoMatch, /search: lexical only/);

    const disabledWork = await makeTempDir('ei-search-disabled-cfg-');
    const disabled = await createRepo(
      disabledWork,
      { 'src/a.ts': 'export function a() { return 1; }\n' },
      { search: { enabled: false, semantic: false } },
    );
    const disabledRes = await runSearch(new ImpactSession(disabled.workspace), { query: 'a' });
    assert.equal(disabledRes.kind, 'failure');
    assert.equal(disabledRes.code, 'index-failed');
  });

  it('3. ranks exact whole-name matches first (exact) over higher-caller/doc-heavy lexical hits', async () => {
    const work = await makeTempDir('ei-search-exact-');
    const callerLines = Array.from(
      { length: 15 },
      (_, i) => `export function caller${i}() { return retryHelper(); }`,
    ).join('\n');
    const { repo, workspace } = await createRepo(work, {
      'src/a.ts': [
        '/** retry retry retry helper retry retry */',
        'export function retryHelper() { return 1; }',
        callerLines,
      ].join('\n'),
      'src/b.ts': 'function retry() { return 2; }\n',
      'src/service.ts': [
        'export class PaymentService {',
        '  charge(amount: number) { return amount; }',
        '}',
        'export class StripeService {',
        '  /** charge charge charge */',
        '  charge(amount: number) { return amount; }',
        '}',
        'export function calculateFee(x: number) { return x; }',
        'export function calculateFeeExtra(x: number) { return x; }',
      ].join('\n'),
    });
    const report = await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });
    assert.deepEqual(report.problems, []);
    const session = new ImpactSession(workspace);

    const retryOut = await runSearch(session, { query: 'retry' });
    assert.equal(retryOut.kind, 'result');
    assert.equal(retryOut.value.hits[0]?.symbol, 'src/b.ts#retry');
    assert.equal(retryOut.value.hits[0]?.kind, 'exact');
    assert.equal(retryOut.value.hits[1]?.symbol, 'src/a.ts#retryHelper');
    assert.equal(retryOut.value.hits[1]?.kind, 'lexical');

    const qualifiedOut = await runSearch(session, { query: 'PaymentService.charge' });
    assert.equal(qualifiedOut.kind, 'result');
    assert.equal(qualifiedOut.value.hits[0]?.symbol, 'src/service.ts#PaymentService.charge');
    assert.equal(qualifiedOut.value.hits[0]?.kind, 'exact');

    const multiWordExact = await runSearch(session, { query: 'find calculateFee implementation' });
    assert.equal(multiWordExact.kind, 'result');
    assert.equal(multiWordExact.value.hits[0]?.symbol, 'src/service.ts#calculateFee');
    assert.equal(multiWordExact.value.hits[0]?.kind, 'exact');
  });

  it('4. applies BM25 field weights (name > owner > signature > doc > path > kind), exact tiers, exported, and caller boosts', async () => {
    const work = await makeTempDir('ei-search-weights-');
    const longDoc =
      '/** One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen. */';
    const callers10 = Array.from(
      { length: 10 },
      (_, i) => `export function c${i}() { return tokenAlphaExtra(); }`,
    ).join('\n');
    const { repo, workspace } = await createRepo(work, {
      // Equal-token-length (22 FTS tokens), unexported, 0-caller declarations with inverted stable_key order
      'src/weights/a1_kind.ts': [
        'class BoxHost {',
        '  /** Alpha beta gamma delta epsilon zeta eta theta iota. */',
        '  get item() { return 1; }',
        '}',
      ].join('\n'),
      'src/weights/accessor/b2_path.ts': [
        '/** Alpha beta gamma delta epsilon zeta eta theta. */',
        'function pathHolder(): number { return 1; }',
      ].join('\n'),
      'src/weights/c3_doc.ts': [
        '/** Alpha beta gamma delta accessor zeta eta theta iota. */',
        'function docHolder(): number { return 1; }',
      ].join('\n'),
      'src/weights/d4_sig.ts': [
        '/** Alpha beta gamma delta epsilon zeta eta. */',
        'function sigHolder(accessor: number): number { return accessor; }',
      ].join('\n'),
      'src/weights/e5_owner.ts': [
        'class AccessorOwner {',
        '  /** Alpha beta gamma delta epsilon zeta eta. */',
        '  memberFn(): number { return 1; }',
        '}',
      ].join('\n'),
      'src/weights/f6_name.ts': [
        '/** Alpha beta gamma delta epsilon zeta eta theta iota. */',
        'function accessorHelper(): number { return 1; }',
      ].join('\n'),
      'src/boosts_a.ts': [
        'export function exportedZero() { return 1; }',
        'function unexportedZero() { return 2; }',
        'export function sharedPopular() { return 3; }',
      ].join('\n'),
      'src/boosts_z.ts': [
        'export function sharedPopular() { return 4; }',
        'export function use1() { return sharedPopular(); }',
        'export function use2() { return sharedPopular(); }',
        'export function use3() { return sharedPopular(); }',
      ].join('\n'),
      'src/case_0.ts': [
        '/** tokenAlpha tokenAlpha tokenAlpha tokenAlpha tokenAlpha */',
        'export function tokenAlphaExtra() { return 1; }',
        callers10,
      ].join('\n'),
      'src/case_a.ts': [
        longDoc,
        'export function tokenAlpha() { return 2; }',
        'export function l1() { return tokenAlpha(); }',
        'export function l2() { return tokenAlpha(); }',
        'export function l3() { return tokenAlpha(); }',
      ].join('\n'),
      'src/case_z.ts': [longDoc, 'function TokenAlpha() { return 3; }'].join('\n'),
    });
    const report = await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });
    assert.deepEqual(report.problems, []);
    const session = new ImpactSession(workspace);

    const fieldOut = await runSearch(session, { query: 'accessor', limit: 20 });
    assert.equal(fieldOut.kind, 'result');
    const symbols = fieldOut.value.hits.map((h) => h.symbol);
    const rankOf = (s: string) => symbols.indexOf(s);
    const expectedOrder = [
      'src/weights/f6_name.ts#accessorHelper',
      'src/weights/e5_owner.ts#AccessorOwner.memberFn',
      'src/weights/d4_sig.ts#sigHolder',
      'src/weights/c3_doc.ts#docHolder',
      'src/weights/accessor/b2_path.ts#pathHolder',
      'src/weights/a1_kind.ts#BoxHost.item',
    ];
    for (const sym of expectedOrder) {
      const hit: SearchHit | undefined = fieldOut.value.hits.find((h) => h.symbol === sym);
      assert.ok(hit, `missing ${sym}`);
      assert.equal(hit.kind, 'lexical');
      assert.equal(hit.exported, false);
      assert.equal(hit.callers, 0);
    }
    for (let i = 0; i < expectedOrder.length - 1; i++) {
      assert.ok(
        rankOf(expectedOrder[i]!) < rankOf(expectedOrder[i + 1]!),
        `expected ${expectedOrder[i]} before ${expectedOrder[i + 1]}`,
      );
    }

    const exportOut = await runSearch(session, { query: 'zero' });
    assert.equal(exportOut.kind, 'result');
    assert.equal(exportOut.value.hits[0]?.symbol, 'src/boosts_a.ts#exportedZero');
    assert.equal(exportOut.value.hits[1]?.symbol, 'src/boosts_a.ts#unexportedZero');

    const callerOut = await runSearch(session, { query: 'sharedPopular' });
    assert.equal(callerOut.kind, 'result');
    assert.equal(callerOut.value.hits[0]?.symbol, 'src/boosts_z.ts#sharedPopular');
    assert.equal(callerOut.value.hits[1]?.symbol, 'src/boosts_a.ts#sharedPopular');
    assert.equal(callerOut.value.hits[0]?.callers, 3);
    assert.equal(callerOut.value.hits[1]?.callers, 0);

    const exactTierOut = await runSearch(session, { query: 'TokenAlpha' });
    assert.equal(exactTierOut.kind, 'result');
    assert.equal(exactTierOut.value.hits[0]?.symbol, 'src/case_z.ts#TokenAlpha');
    assert.equal(exactTierOut.value.hits[0]?.kind, 'exact');
    assert.equal(exactTierOut.value.hits[1]?.symbol, 'src/case_a.ts#tokenAlpha');
    assert.equal(exactTierOut.value.hits[1]?.kind, 'exact');
    assert.equal(exactTierOut.value.hits[2]?.symbol, 'src/case_0.ts#tokenAlphaExtra');
    assert.equal(exactTierOut.value.hits[2]?.kind, 'lexical');
    assert.ok(exactTierOut.value.hits[0]!.score - exactTierOut.value.hits[1]!.score > 50);
    assert.ok(exactTierOut.value.hits[1]!.score - exactTierOut.value.hits[2]!.score > 800);
  });

  it('5. produces deterministic byte-identical results across repeated queries and cold vs incremental builds', async () => {
    const work = await makeTempDir('ei-search-det-');
    const { repo, workspace } = await createRepo(work, {
      'src/alpha.ts': 'export function handleEvent() { return 1; }\n',
      'src/zeta.ts': 'export function handleEvent() { return 2; }\n',
    });
    const indexer = new Indexer(ts, repo, workspace.cacheDir);
    await indexer.index({ impact: workspace.config.impact, full: true });
    const session = new ImpactSession(workspace);

    const r1 = await runSearch(session, { query: 'handleEvent' });
    const r2 = await runSearch(session, { query: 'handleEvent' });
    assert.equal(r1.kind, 'result');
    assert.equal(r2.kind, 'result');
    assert.equal(renderSearchOutcome(r1), renderSearchOutcome(r2));
    assert.deepEqual(
      r1.value.hits.map((h) => h.symbol),
      ['src/alpha.ts#handleEvent', 'src/zeta.ts#handleEvent'],
    );

    // Reverse rowid insertion order incrementally by deleting alpha.ts, indexing, recreating, indexing
    const alphaContent = await readFile(join(repo, 'src/alpha.ts'), 'utf8');
    await rm(join(repo, 'src/alpha.ts'));
    await indexer.index({ impact: workspace.config.impact, freshness: 'hash' });
    await writeFile(join(repo, 'src/alpha.ts'), alphaContent);
    await indexer.index({ impact: workspace.config.impact, freshness: 'hash' });

    const rAfter = await runSearch(session, { query: 'handleEvent' });
    assert.equal(rAfter.kind, 'result');
    assert.deepEqual(
      rAfter.value.hits.map((h) => h.symbol),
      ['src/alpha.ts#handleEvent', 'src/zeta.ts#handleEvent'],
    );
    assert.equal(renderSearchOutcome(rAfter), renderSearchOutcome(r1));
  });

  it('6. searches 50,000 declarations with stat probe at p95 < 300 ms', async (t) => {
    const work = await makeTempDir('ei-search-50k-');
    const repo = join(work, 'repo');
    const cacheHome = join(work, 'home');
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(cacheHome, { recursive: true });
    await writeFile(
      join(repo, 'ei.config.json'),
      JSON.stringify({ impact: { include: ['src/**'], exclude: [], freshness: 'stat' } }),
    );
    const workspace = await loadWorkspace(repo, cacheHome);

    const fileCount = 500;
    const perFile = 100;
    const cfgStat = statSync(join(repo, 'ei.config.json'));
    const fileRecords: FileRecord[] = [
      {
        path: 'ei.config.json',
        size: cfgStat.size,
        mtimeMs: cfgStat.mtimeMs,
        hash: null,
        kind: 'json',
        package: null,
        tsconfig: null,
        status: 'other',
        reason: 'json',
      },
    ];
    for (let f = 0; f < fileCount; f++) {
      const rel = `src/mod${f}.ts`;
      const abs = join(repo, rel);
      await writeFile(abs, `export function stub${f}() { return ${f}; }\n`);
      const st = statSync(abs);
      fileRecords.push({
        path: rel,
        size: st.size,
        mtimeMs: st.mtimeMs,
        hash: `h${f}`,
        kind: 'ts',
        package: null,
        tsconfig: 'tsconfig.json',
        status: 'indexable',
        reason: null,
      });
    }

    const db = beginBuild(workspace.cacheDir);
    writeMeta(db, {
      schema_version: String(SCHEMA_VERSION),
      config_hash: impactConfigHash(workspace.config.impact),
      typescript_version: '5.9.3',
      extractor_stamp: 'test',
      build_id: 'scale50k',
      built_at: new Date().toISOString(),
    });
    writeFiles(db, fileRecords);
    db.exec('BEGIN');
    const insSym = db.prepare('INSERT INTO symbols (id, key) VALUES (?, ?)');
    const insDecl = db.prepare(
      `INSERT INTO declarations (id, file, name, simple, kind, exported, start_line, end_line, other_spans, sig_hash)
       VALUES (?, ?, ?, ?, 'function', 1, ?, ?, '[]', 's')`,
    );
    const insFts = db.prepare(
      `INSERT INTO declarations_fts (rowid, stable_key, name_tokens, owner_tokens, kind, signature, doc, path_tokens)
       VALUES (?, ?, ?, '', 'function', ?, ?, ?)`,
    );
    const insEdge = db.prepare(
      `INSERT INTO edges (source, target, kind, strength, lines) VALUES (?, ?, 'CALLS', 'compiler', '[1]')`,
    );
    let id = 1;
    for (let f = 0; f < fileCount; f++) {
      const file = `src/mod${f}.ts`;
      const pTokens = `src mod ${f} ts`;
      for (let k = 0; k < perFile; k++) {
        const tag = k % 10 === 0 ? 'retryPaymentWebhook' : `computeValue${k}`;
        const name = `${tag}_${id}`;
        const key = `${file}#${name}`;
        insSym.run(id, key);
        insDecl.run(id, file, name, name, k + 1, k + 1);
        insFts.run(
          id,
          key,
          `${name} retry payment webhook compute value ${k}`,
          `export function ${name}(amount: number): number`,
          'Handles payment webhook retries and value calculation.',
          pTokens,
        );
        if (id > 1 && id % 5 === 0) {
          insEdge.run(id - 1, id);
        }
        id++;
      }
    }
    db.exec('COMMIT');
    publishBuild(db, workspace.cacheDir);

    const session = new ImpactSession(workspace);
    const queries = [
      'retry payment webhook',
      'computeValue5',
      'mod120',
      'retryPaymentWebhook_1001',
      'payment webhook',
      'value calculation',
      'amount number',
      'retry',
      'webhook',
      'compute',
      'mod42 computeValue3',
      'retryPaymentWebhook_49991',
      'unknownIdentifier999',
      'payment calculation',
      'retry value',
      'mod300 webhook',
      'computeValue9',
      'retryPaymentWebhook_25001',
      'webhook retries',
      'computeValue1',
      'mod10 retry',
      'payment',
      'calculation',
      'computeValue7',
      'retryPaymentWebhook_11',
    ];
    const timings: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      const res = await runSearch(session, { query: q });
      timings.push(performance.now() - t0);
      assert.equal(res.kind, 'result');
      assert.equal(res.value.indexState, 'fresh');
    }
    timings.sort((a, b) => a - b);
    const p50 = timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.5) - 1)]!;
    const p95 = timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)]!;
    const max = timings[timings.length - 1]!;
    t.diagnostic(
      `50k timings (25 queries): p50=${p50.toFixed(2)} ms, p95=${p95.toFixed(2)} ms, max=${max.toFixed(2)} ms`,
    );
    assert.ok(p95 < 300, `50k search p95 was ${p95.toFixed(2)} ms (>= 300 ms)`);
  });

  it('7. never emits semantic labels or install hints even when search.semantic is true', async () => {
    const work = await makeTempDir('ei-search-nosem-');
    const { repo, workspace } = await createRepo(
      work,
      { 'src/a.ts': 'export function processOrder() { return 1; }\n' },
      { search: { enabled: true, semantic: true } },
    );
    await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });
    const session = new ImpactSession(workspace);

    const hitRes = await runSearch(session, { query: 'processOrder' });
    assert.equal(hitRes.kind, 'result');
    assert.ok(hitRes.value.hits.every((h) => h.kind === 'exact' || h.kind === 'lexical'));
    const hitText = renderSearchOutcome(hitRes);
    assert.match(hitText, /search: lexical only/);
    assert.doesNotMatch(hitText, /semantic|install|embeddings/i);

    const missRes = await runSearch(session, { query: 'nothingMatchesHere' });
    assert.equal(missRes.kind, 'result');
    const missText = renderSearchOutcome(missRes);
    assert.match(missText, /search: lexical only/);
    assert.doesNotMatch(missText, /semantic|install|embeddings/i);
  });

  it('8. builds cold index on first query with progress and returns INDEX BUILDING guidance on timeout', async () => {
    const work = await makeTempDir('ei-search-cold-');
    const repo = join(work, 'mono');
    const cacheHome = join(work, 'home');
    cpSync(FIXTURE, repo, { recursive: true });
    await mkdir(cacheHome, { recursive: true });
    const workspace = await loadWorkspace(repo, cacheHome);

    const progress: string[] = [];
    const session = new ImpactSession(workspace);
    const first = await runSearch(session, {
      query: 'calculateFee',
      onProgress: (msg) => progress.push(msg),
    });
    assert.equal(first.kind, 'result');
    assert.equal(first.value.indexState, 'updated');
    assert.ok(first.value.hits.some((h) => h.symbol.endsWith('#calculateFee')));
    assert.ok(progress.length > 0);

    // Timeout guidance (waitMs: 1 with gated build on unindexed repo)
    const work2 = await makeTempDir('ei-search-timeout-');
    const repo2 = join(work2, 'mono');
    const cacheHome2 = join(work2, 'home');
    cpSync(FIXTURE, repo2, { recursive: true });
    await mkdir(cacheHome2, { recursive: true });

    const gate = gatedBuild();
    const { pi, registered } = mockPi();
    extension(pi, {
      env: process.env,
      cacheHome: cacheHome2,
      impactSession: { build: gate.build, waitMs: 1 },
      createPolicyExtension: () => {},
    });
    try {
      const srchTool = registered.find((t) => t.name === 'ei_search')!;
      const res = await srchTool.execute('t1', { query: 'calculateFee' }, undefined, undefined, {
        cwd: repo2,
      });
      assert.equal(res.isError, undefined, 'INDEX BUILDING must be guidance (no isError)');
      assert.match(res.content[0]?.text ?? '', /^INDEX BUILDING —/);
    } finally {
      gate.release();
      await gate.settled();
    }
  });

  it('9. falls back to published index with STALE INDEX on drift when build lock or failing update blocks', async () => {
    const work = await makeTempDir('ei-search-stale-');
    const { repo, workspace } = await createRepo(work, {
      'src/a.ts': 'export function stableSymbol() { return 1; }\n',
    });
    await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });

    // Edit file on disk so stat probe detects drift
    await writeFile(
      join(repo, 'src/a.ts'),
      'export function stableSymbol() { return 2; }\nexport function completelyDifferentToken() { return 3; }\n',
    );
    const lock = acquireBuildLock(workspace.cacheDir);
    assert.equal(lock.ok, true);
    const gate = gatedBuild();
    try {
      const session = new ImpactSession(workspace, { build: gate.build, waitMs: 1 });
      const hitRes = await runSearch(session, { query: 'stableSymbol' });
      assert.equal(hitRes.kind, 'result');
      assert.equal(hitRes.value.indexState, 'stale');
      assert.equal(hitRes.value.hits[0]?.symbol, 'src/a.ts#stableSymbol');
      const hitText = renderSearchOutcome(hitRes);
      assert.match(hitText, /STALE INDEX/);
      assert.doesNotMatch(hitText, /index fresh/);

      const missRes = await runSearch(session, { query: 'completelyDifferentToken' });
      assert.equal(missRes.kind, 'result');
      assert.equal(missRes.value.indexState, 'stale');
      assert.equal(missRes.value.hits.length, 0);
      assert.match(renderSearchOutcome(missRes), /STALE INDEX/);
    } finally {
      if (lock.ok) lock.release();
      gate.release();
      await gate.settled();
    }
  });

  it('10. enforces EI_DISABLED=1 across CLI, OMP, and AGY MCP with zero audit entries', async () => {
    const work = await makeTempDir('ei-search-disabled-');
    const { repo, cacheHome, workspace } = await createRepo(work, {
      'src/a.ts': 'export function alpha() { return 1; }\n',
    });

    const cli = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, 'search', 'alpha', '--root', repo],
      { env: { ...process.env, HOME: cacheHome, EI_DISABLED: '1' } },
    );
    assert.match(cli.stdout, /^SEARCH disabled \(EI_DISABLED\)/);

    const { pi, registered } = mockPi();
    extension(pi, { env: { EI_DISABLED: '1' }, createPolicyExtension: () => {} });
    assert.equal(registered.length, 0);

    const { createTools } = (await import(MCP_TOOLS_URL)) as {
      createTools: (opts: { root: string; env?: NodeJS.ProcessEnv }) => {
        definitions: unknown[];
        call: (
          name: string,
          args: unknown,
          signal: AbortSignal,
        ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
      };
    };
    const mcp = createTools({
      root: repo,
      env: { ...process.env, HOME: cacheHome, EI_DISABLED: '1' },
    });
    assert.deepEqual(mcp.definitions, []);
    const mcpRes = await mcp.call('ei_search', { query: 'alpha' }, new AbortController().signal);
    assert.equal(mcpRes.isError, true);

    assert.equal(existsSync(join(workspace.cacheDir, AUDIT_FILE)), false);
  });

  it('11. records truncated and redacted ei_search audit lines with zero result text', async () => {
    const work = await makeTempDir('ei-search-audit-');
    const { repo, cacheHome, workspace } = await createRepo(work, {
      'src/a.ts':
        '/** NEVER_LEAK_DOC_MARKER */\nexport function uniqueAuditTarget(secretParam: string) { return secretParam; }\n',
    });
    await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });

    const { pi, registered } = mockPi();
    extension(pi, {
      env: { ...process.env, HOME: cacheHome },
      cacheHome,
      createPolicyExtension: () => {},
    });
    const srchTool = registered.find((t) => t.name === 'ei_search')!;

    await srchTool.execute('s1', { query: 'uniqueAuditTarget', limit: 5 }, undefined, undefined, {
      cwd: repo,
    });
    // Invalid > 200 char query containing a token and home path triggers sanitized audit entry
    const ghToken = 'ghp_1234567890abcdefghij';
    const longInvalid = `find ${repo}/src/a.ts with ${ghToken} and /home/alice/work ${'z'.repeat(210)}`;
    await srchTool.execute('s2', { query: longInvalid }, undefined, undefined, { cwd: repo });

    const rawAudit = await readFile(join(workspace.cacheDir, AUDIT_FILE), 'utf8');
    const entries = rawAudit
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.tool, 'ei_search');
    assert.equal(entries[0]?.query, 'uniqueAuditTarget');
    assert.equal(entries[0]?.limit, 5);
    assert.equal(entries[0]?.hitsCount, 1);
    assert.ok(!rawAudit.includes('NEVER_LEAK_DOC_MARKER'));
    assert.ok(!rawAudit.includes('secretParam'));
    assert.ok(entries.every((e) => !('hits' in e) && !('signature' in e) && !('doc' in e)));

    const invalidQuery = String(entries[1]?.query ?? '');
    assert.ok(invalidQuery.length <= 200);
    assert.ok(!rawAudit.includes(ghToken));
    assert.ok(!rawAudit.includes('/home/alice'));
    assert.ok(!rawAudit.includes(repo));
    const realHome = homedir();
    if (realHome.length > 1) assert.ok(!rawAudit.includes(realHome));

    // AGY MCP ei_search audit parity: INVALID_INPUT logs integer limit (omits non-integer),
    // and valid args log trimmed query + default limit (matching CLI and OMP)
    const { createTools } = (await import(MCP_TOOLS_URL)) as {
      createTools: (opts: { root: string; env?: NodeJS.ProcessEnv }) => {
        call: (
          name: string,
          args: unknown,
          signal: AbortSignal,
        ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
      };
    };
    const mcpWork = await makeTempDir('ei-search-mcp-audit-');
    const mcpRepo = await createRepo(mcpWork, {
      'src/a.ts': 'export function alpha() { return 1; }\n',
    });
    const mcpTools = createTools({
      root: mcpRepo.repo,
      env: { ...process.env, HOME: mcpRepo.cacheHome },
    });
    const inv1 = await mcpTools.call(
      'ei_search',
      { query: '   ', limit: 21 },
      new AbortController().signal,
    );
    assert.equal(inv1.isError, true);
    const inv2 = await mcpTools.call(
      'ei_search',
      { query: '   ', limit: 1.5 },
      new AbortController().signal,
    );
    assert.equal(inv2.isError, true);

    const disabledMcpWork = await makeTempDir('ei-search-mcp-audit-disabled-');
    const disabledMcpRepo = await createRepo(
      disabledMcpWork,
      { 'src/a.ts': 'export function alpha() { return 1; }\n' },
      { search: { enabled: false, semantic: false } },
    );
    const disabledMcpTools = createTools({
      root: disabledMcpRepo.repo,
      env: { ...process.env, HOME: disabledMcpRepo.cacheHome },
    });
    const trimmedFail = await disabledMcpTools.call(
      'ei_search',
      { query: '  alpha  ' },
      new AbortController().signal,
    );
    assert.equal(trimmedFail.isError, true);

    const mcpAuditLines = (await readFile(join(mcpRepo.workspace.cacheDir, AUDIT_FILE), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(mcpAuditLines.length, 2);
    assert.equal(mcpAuditLines[0]?.code, 'INVALID_INPUT');
    assert.equal(mcpAuditLines[0]?.query, '   ');
    assert.equal(mcpAuditLines[0]?.limit, 21);
    assert.equal(mcpAuditLines[1]?.code, 'INVALID_INPUT');
    assert.equal(mcpAuditLines[1]?.limit, undefined);

    const disabledAuditLines = (
      await readFile(join(disabledMcpRepo.workspace.cacheDir, AUDIT_FILE), 'utf8')
    )
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(disabledAuditLines.length, 1);
    assert.equal(disabledAuditLines[0]?.outcome, 'failure');
    assert.equal(disabledAuditLines[0]?.query, 'alpha');
    assert.equal(disabledAuditLines[0]?.limit, 8);
  });

  it('12. maintains CLI/OMP/MCP output parity and enforces the 4,000-character budget', async () => {
    const work = await makeTempDir('ei-search-parity-');
    const longFile = 'src/' + 'nested_directory_segment/'.repeat(4) + 'very_long_module_name.ts';
    const decls = Array.from({ length: 20 }, (_, i) => {
      const params = Array.from({ length: 12 }, (__, j) => `longParameterName${j}: string`).join(
        ', ',
      );
      return `export function parityTargetFn${i}(${params}): string { return longParameterName0; }`;
    }).join('\n');
    const { repo, cacheHome, workspace } = await createRepo(work, {
      [longFile]: decls,
      'src/use.ts': `import { parityTargetFn0 } from './${'nested_directory_segment/'.repeat(4)}very_long_module_name.js';\nexport function runUse() { return parityTargetFn0(${Array(12).fill('"x"').join(', ')}); }\n`,
    });
    await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });

    const { pi, registered } = mockPi();
    extension(pi, {
      env: { ...process.env, HOME: cacheHome },
      cacheHome,
      createPolicyExtension: () => {},
    });
    const srchTool = registered.find((t) => t.name === 'ei_search')!;
    const ompRes = await srchTool.execute(
      'p1',
      { query: 'parityTargetFn0', limit: 8 },
      undefined,
      undefined,
      { cwd: repo },
    );
    const ompText = ompRes.content[0]?.text ?? '';

    const { createTools } = (await import(MCP_TOOLS_URL)) as {
      createTools: (opts: { root: string; env?: NodeJS.ProcessEnv }) => {
        call: (
          name: string,
          args: unknown,
          signal: AbortSignal,
        ) => Promise<{ content: { text: string }[] }>;
      };
    };
    const mcp = createTools({ root: repo, env: { ...process.env, HOME: cacheHome } });
    const mcpRes = await mcp.call(
      'ei_search',
      { query: 'parityTargetFn0', limit: 8 },
      new AbortController().signal,
    );
    const mcpText = mcpRes.content[0]?.text ?? '';

    const cli = await execFileAsync(
      process.execPath,
      [CLI_ENTRY, 'search', 'parityTargetFn0', '--limit', '8', '--root', repo],
      { env: { ...process.env, HOME: cacheHome } },
    );
    const cliText = cli.stdout.trimEnd();

    assert.equal(ompText, mcpText);
    assert.equal(cliText, ompText);
    assert.ok(cliText.length <= SEARCH_BUDGET);

    // Budget enforcement with 20 very long hits
    const session = new ImpactSession(workspace);
    const all20 = await runSearch(session, { query: 'parity', limit: 20 });
    assert.equal(all20.kind, 'result');
    assert.equal(all20.value.hits.length, 20);
    const rendered20 = renderSearch(all20.value);
    assert.ok(
      rendered20.length <= SEARCH_BUDGET,
      `rendered length ${rendered20.length} > ${SEARCH_BUDGET}`,
    );
    assert.match(rendered20, /\(\+\d+ more matches\)/);

    // Singular vs plural overflow line: (+1 more match) vs (+2 more matches)
    const sampleOverflow = (totalMatches: number): Parameters<typeof renderSearch>[0] => ({
      query: 'q',
      limit: 8,
      totalMatches,
      hits: [
        {
          kind: 'exact',
          symbol: 'src/a.ts#firstFn',
          declarationKind: 'function',
          span: { file: 'src/a.ts', startLine: 1, endLine: 1 },
          signature: 'export function firstFn(): void',
          exported: true,
          callers: 0,
          route: false,
          score: 1000,
        },
        {
          kind: 'lexical',
          symbol: 'src/a.ts#secondFn',
          declarationKind: 'function',
          span: { file: 'src/a.ts', startLine: 2, endLine: 2 },
          signature: 'export function secondFn(): void',
          exported: true,
          callers: 0,
          route: false,
          score: 10,
        },
      ],
      indexState: 'fresh',
      scannedFiles: 1,
      engine: { version: '0.2.0', typescript: '5.9.3', extractor: 'test' },
    });
    const fitOneBudget = renderSearch(sampleOverflow(2), 10_000).length - 1;
    const oneMore = renderSearch(sampleOverflow(2), fitOneBudget);
    assert.match(oneMore, /\(\+1 more match\)/);
    assert.doesNotMatch(oneMore, /\(\+1 more matches\)/);
    const twoMore = renderSearch(sampleOverflow(3), fitOneBudget);
    assert.match(twoMore, /\(\+2 more matches\)/);
  });

  it('querySearch can run directly on an open DB and neutralizes NUL bytes without semantic hits', async () => {
    assert.equal(quoteFtsLiteral('foo\0bar'), '"foobar"');
    assert.equal(quoteFtsLiteral('\0'), '""');
    const nulBuilt = buildFtsQuery('\0');
    assert.equal(nulBuilt.matchExpr, null);
    assert.equal(nulBuilt.exactMatchExpr, null);
    const fooNulBuilt = buildFtsQuery('foo\0bar');
    assert.equal(fooNulBuilt.matchExpr, '"foo" OR "bar" OR "foobar"');

    const work = await makeTempDir('ei-search-direct-');
    const { repo, workspace } = await createRepo(work, {
      'src/a.ts':
        'export function directFn() { return 1; }\nexport function fooBar() { return 2; }\n',
    });
    await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });
    const ctx = await new ImpactSession(workspace).prepareForSearch();
    assert.ok(ctx.db !== null);
    try {
      const res = querySearch(ctx.db, workspace.config.impact, 'directFn', 8);
      assert.equal(res.hits[0]?.kind, 'exact');

      const nulRes = querySearch(ctx.db, workspace.config.impact, 'foo\0bar', 8);
      assert.equal(nulRes.hits[0]?.symbol, 'src/a.ts#fooBar');
      assert.equal(nulRes.hits[0]?.kind, 'lexical');
      assert.ok(nulRes.hits.every((h) => h.kind === 'exact' || h.kind === 'lexical'));

      const onlyNulRes = querySearch(ctx.db, workspace.config.impact, '\0', 8);
      assert.deepEqual(onlyNulRes.hits, []);
      assert.equal(onlyNulRes.totalMatches, 0);
    } finally {
      ctx.db.close();
    }
  });

  it('finds buried exact matches and dotted qualified matches among > 500 FTS hits', async () => {
    const work = await makeTempDir('ei-search-buried-exact-');
    const retryFillers = Array.from(
      { length: 550 },
      (_, i) => `/** retry retry retry */\nexport function retryFiller${i}() { return ${i}; }`,
    ).join('\n');
    const chargeFillers = Array.from(
      { length: 550 },
      (_, i) => `/** charge charge charge */\nexport function chargeFiller${i}() { return ${i}; }`,
    ).join('\n');
    const unrelated = Array.from(
      { length: 700 },
      (_, i) => `export function otherThing${i}() { return ${i}; }`,
    ).join('\n');
    const paddedDoc =
      '/** alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi */';

    const { repo, workspace } = await createRepo(work, {
      'src/a_fillers.ts': `${retryFillers}\n${chargeFillers}\n`,
      'src/b_unrelated.ts': unrelated,
      'src/z_target.ts': `${paddedDoc}\nfunction retry() { return 0; }\n`,
      'src/z_upper.ts': `${paddedDoc}\nfunction RETRY_ALIAS() { return 0; }\n`,
      'src/z_service.ts': `export class PaymentService {\n  ${paddedDoc}\n  charge() { return 1; }\n}\n`,
    });
    // Also verify case-insensitive buried RETRY on a dedicated repo where only RETRY exists for 'retry'
    const upperWork = await makeTempDir('ei-search-buried-upper-');
    const upperRepo = await createRepo(upperWork, {
      'src/a_fillers.ts': retryFillers,
      'src/b_unrelated.ts': unrelated,
      'src/z_upper.ts': `${paddedDoc}\nfunction RETRY() { return 0; }\n`,
    });
    // And verify 2 exact matches (one in top-500, one buried) both get exact rank + bm25Score > 0
    const pairWork = await makeTempDir('ei-search-buried-pair-');
    const pairRepo = await createRepo(pairWork, {
      'src/a_top.ts': 'export function retry() { return 1; }\n',
      'src/b_fillers.ts': retryFillers,
      'src/c_unrelated.ts': unrelated,
      'src/z_buried.ts': `${paddedDoc}\nfunction retry() { return 2; }\n`,
    });

    await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });
    const session = new ImpactSession(workspace);

    // 1. Single buried exact lowercase match (`missingExactIds.length === 1` without anyExistingExact):
    const out = await runSearch(session, { query: 'retry', limit: 8 });
    assert.equal(out.kind, 'result');
    assert.ok(out.value.totalMatches > 500);
    assert.equal(out.value.hits[0]?.symbol, 'src/z_target.ts#retry');
    assert.equal(out.value.hits[0]?.kind, 'exact');
    assert.ok(
      (out.value.hits[0]?.score ?? 0) > 1000,
      `expected buried single exact hit to retain non-zero BM25 (> 1000), got ${out.value.hits[0]?.score}`,
    );

    // 2. Dotted qualified match (`PaymentService.charge` over > 500 chargeFiller rows):
    const dottedOut = await runSearch(session, { query: 'PaymentService.charge', limit: 8 });
    assert.equal(dottedOut.kind, 'result');
    assert.ok(dottedOut.value.totalMatches > 500);
    assert.equal(dottedOut.value.hits[0]?.symbol, 'src/z_service.ts#PaymentService.charge');
    assert.equal(dottedOut.value.hits[0]?.kind, 'exact');
    assert.ok(
      (dottedOut.value.hits[0]?.score ?? 0) > 1000,
      `expected buried dotted exact hit score > 1000, got ${dottedOut.value.hits[0]?.score}`,
    );

    // 3. Buried uppercase RETRY queried as lowercase 'retry' over > 500 matching rows:
    await new Indexer(ts, upperRepo.repo, upperRepo.workspace.cacheDir).index({
      impact: upperRepo.workspace.config.impact,
      full: true,
    });
    const upperOut = await runSearch(new ImpactSession(upperRepo.workspace), {
      query: 'retry',
      limit: 8,
    });
    assert.equal(upperOut.kind, 'result');
    assert.ok(upperOut.value.totalMatches > 500);
    assert.equal(upperOut.value.hits[0]?.symbol, 'src/z_upper.ts#RETRY');
    assert.equal(upperOut.value.hits[0]?.kind, 'exact');
    assert.ok(
      (upperOut.value.hits[0]?.score ?? 0) > 900,
      `expected buried uppercase exactLower hit score > 900, got ${upperOut.value.hits[0]?.score}`,
    );

    // 4. Two exact matches (1 in top-500 + 1 buried) both retain exact rank and bm25Score > 0:
    await new Indexer(ts, pairRepo.repo, pairRepo.workspace.cacheDir).index({
      impact: pairRepo.workspace.config.impact,
      full: true,
    });
    const pairOut = await runSearch(new ImpactSession(pairRepo.workspace), {
      query: 'retry',
      limit: 8,
    });
    assert.equal(pairOut.kind, 'result');
    assert.equal(pairOut.value.hits[0]?.symbol, 'src/a_top.ts#retry');
    assert.equal(pairOut.value.hits[0]?.kind, 'exact');
    assert.equal(pairOut.value.hits[1]?.symbol, 'src/z_buried.ts#retry');
    assert.equal(pairOut.value.hits[1]?.kind, 'exact');
    assert.ok((pairOut.value.hits[1]?.score ?? 0) > 1000);
  });

  it('bounds materialized rows and avoids declaration-table scans for queries with > 500 matches', async () => {
    const work = await makeTempDir('ei-search-eqp-');
    const retryFillers = Array.from(
      { length: 550 },
      (_, i) => `/** retry retry retry */\nexport function retryFiller${i}() { return ${i}; }`,
    ).join('\n');
    const chargeFillers = Array.from(
      { length: 550 },
      (_, i) => `/** charge charge charge */\nexport function chargeFiller${i}() { return ${i}; }`,
    ).join('\n');
    const paddedDoc =
      '/** alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi */';

    const { repo, workspace } = await createRepo(work, {
      'src/a_fillers.ts': `${retryFillers}\n${chargeFillers}\n`,
      'src/z_target.ts': `${paddedDoc}\nfunction retry() { return 0; }\n`,
      'src/z_service.ts': `export class PaymentService {\n  ${paddedDoc}\n  charge() { return 1; }\n}\n`,
    });
    await new Indexer(ts, repo, workspace.cacheDir).index({
      impact: workspace.config.impact,
      full: true,
    });

    const ctx = await new ImpactSession(workspace).prepareForSearch();
    assert.ok(ctx.db !== null);
    const capturedPlans: Array<{ query: string; sql: string; details: string[] }> = [];
    let currentQuery = '';
    const origPrepare = ctx.db.prepare.bind(ctx.db);
    ctx.db.prepare = ((sql: string) => {
      const stmt = origPrepare(sql);
      const recordPlan = (args: unknown[]): void => {
        if (sql.trimStart().toUpperCase().startsWith('EXPLAIN')) return;
        const planRows = origPrepare(`EXPLAIN QUERY PLAN ${sql}`).all(
          ...(args as never[]),
        ) as Array<{
          detail?: string;
        }>;
        capturedPlans.push({
          query: currentQuery,
          sql,
          details: planRows.map((row) => String(row.detail ?? '')),
        });
      };
      const origAll = stmt.all.bind(stmt);
      const origGet = stmt.get.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        recordPlan(args);
        const rows = origAll(...(args as never[]));
        assert.ok(
          rows.length <= 500,
          `search "${currentQuery}" materialized ${rows.length} rows in one query`,
        );
        return rows;
      }) as typeof stmt.all;
      stmt.get = ((...args: unknown[]) => {
        recordPlan(args);
        return origGet(...(args as never[]));
      }) as typeof stmt.get;
      return stmt;
    }) as typeof ctx.db.prepare;

    try {
      const checks: Array<{ q: string; expectedSymbol: string }> = [
        { q: 'retry', expectedSymbol: 'src/z_target.ts#retry' },
        { q: 'PaymentService.charge', expectedSymbol: 'src/z_service.ts#PaymentService.charge' },
        { q: 'find retry implementation', expectedSymbol: 'src/z_target.ts#retry' },
      ];
      for (const { q, expectedSymbol } of checks) {
        currentQuery = q;
        const res = querySearch(ctx.db, workspace.config.impact, q, 8);
        assert.ok(res.totalMatches > 500, `expected > 500 matches for "${q}"`);
        assert.equal(res.hits[0]?.symbol, expectedSymbol);
        assert.equal(res.hits[0]?.kind, 'exact');
      }
    } finally {
      ctx.db.close();
    }

    assert.ok(capturedPlans.length > 0);
    for (const plan of capturedPlans) {
      for (const detail of plan.details) {
        assert.doesNotMatch(
          detail,
          /\bSCAN\s+(?:TABLE\s+)?(?:d|declarations)\b/i,
          `unexpected declarations table scan for "${plan.query}" (${detail}) in SQL:\n${plan.sql}`,
        );
      }
    }
  });
});
