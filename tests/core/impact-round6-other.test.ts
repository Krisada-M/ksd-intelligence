import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync, statSync, utimesSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
import { acquireBuildLock } from '../../src/core/engine/lock.js';
import { loadWorkspace } from '../../src/core/engine/workspace.js';
import { ImpactQuery, type ImpactAnswer } from '../../src/core/impact/query.js';
import { renderAnswer, renderImpact } from '../../src/core/impact/render.js';
import { ImpactSession } from '../../src/core/impact/session.js';
import type { ImpactResult } from '../../src/core/kernel/types.js';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { scanLexically } from '../../src/core/indexing/lexical.js';
import { probe } from '../../src/core/workspace/probe.js';
import { canonicalLines } from '../../src/storage/records.js';
import { openPublished, readFiles } from '../../src/storage/sqlite.js';
import { assertIncrementalEqualsCold, fixtureRepo, impactOf } from './index-helpers.js';

describe('M2b Round 6 — F8–F15 findings', () => {
  describe('F9: probe aligns readability with scan neverReadOf for owner-excluded code files', () => {
    it('detects same-size/same-mtime edits under hash freshness and treats timestamp-only touch on owner-excluded code as touched, not changed', async () => {
      const repo = await fixtureRepo('round6-f9');
      const cacheDir = join(repo, '..', 'cache');
      try {
        const excludedDir = join(repo, 'packages/api/src/excluded');
        await mkdir(excludedDir, { recursive: true });
        const codeRel = 'packages/api/src/excluded/f9-legacy.ts';
        const mdRel = 'packages/api/src/excluded/notes.md';
        const codeAbs = join(repo, codeRel);
        const mdAbs = join(repo, mdRel);

        await writeFile(codeAbs, 'export const f9Val = 111;\n');
        await writeFile(mdAbs, 'hello world\n');
        const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
        utimesSync(codeAbs, fixedTime, fixedTime);

        const base = impactOf(repo);
        const impact = { ...base, exclude: [...base.exclude, 'packages/api/src/excluded/**'] };
        const indexer = new Indexer(ts, repo, cacheDir);
        const report = await indexer.index({ impact, full: true });
        assert.deepEqual(report.problems, []);

        const db = openPublished(cacheDir);
        assert.ok(db);
        const files = readFiles(db);
        db.close();

        const codeRecord = files.find((f) => f.path === codeRel);
        const mdRecord = files.find((f) => f.path === mdRel);
        assert.ok(codeRecord && codeRecord.hash !== null, 'excluded code file should be hashed');
        assert.ok(mdRecord && mdRecord.hash === null, 'excluded non-code file must not be hashed');

        // 1. Same-size edit with identical mtime under hash freshness
        await writeFile(codeAbs, 'export const f9Val = 222;\n');
        utimesSync(codeAbs, fixedTime, fixedTime);
        const hashProbe = await probe(repo, impact, files, 'hash');
        assert.ok(hashProbe.hashed > 0);
        assert.ok(
          hashProbe.changed.includes(codeRel),
          `hash probe must detect same-size/same-mtime edit in excluded code: ${JSON.stringify(hashProbe)}`,
        );

        // 2. Restore original content & bump mtime only -> stat probe sees touched, NOT changed
        await writeFile(codeAbs, 'export const f9Val = 111;\n');
        const bumped = new Date(fixedTime.getTime() + 2000);
        utimesSync(codeAbs, bumped, bumped);
        const touchProbe = await probe(repo, impact, files, 'stat');
        assert.equal(
          touchProbe.changed.includes(codeRel),
          false,
          `timestamp-only touch on excluded code must not be reported changed: ${JSON.stringify(touchProbe)}`,
        );
        assert.ok(
          touchProbe.touched.includes(codeRel),
          `timestamp-only touch on excluded code should be touched: ${JSON.stringify(touchProbe)}`,
        );

        // 3. Negative: non-code excluded file stays never-read (mtime bump -> changed)
        const mdStat = statSync(mdAbs);
        utimesSync(mdAbs, new Date(mdStat.atimeMs + 2000), new Date(mdStat.mtimeMs + 2000));
        const mdProbe = await probe(repo, impact, files, 'hash');
        assert.ok(mdProbe.changed.includes(mdRel), 'excluded non-code remains stat-driven');
      } finally {
        rmSync(join(repo, '..'), { recursive: true, force: true });
      }
    });
  });

  describe('F12: shared-build abort, teardown ordering, and finite untilPublished lock exit', () => {
    function isPidAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    it('keeps shared build alive on partial abort when sibling waiter is unaborted', async () => {
      const repo = await fixtureRepo('round6-f12-partial');
      const cacheDir = join(repo, '..', 'cache');
      try {
        const base = await loadWorkspace(repo);
        const workspace = { ...base, cacheDir, config: { ...base.config, impact: impactOf(repo) } };
        let abortCount = 0;
        let buildCount = 0;

        const session = new ImpactSession(workspace, {
          waitMs: 5_000,
          build: async (ws, opts) => {
            buildCount++;
            opts?.signal?.addEventListener('abort', () => {
              abortCount++;
            });
            await delay(80);
            if (opts?.signal?.aborted) {
              return { ok: false, code: 'index-failed', message: 'aborted', fix: 'retry' };
            }
            const indexer = new Indexer(ts, ws.root, ws.cacheDir);
            const report = await indexer.index({ impact: ws.config.impact, full: true });
            return { ok: true, value: { ...report } };
          },
        });

        const ac1 = new AbortController();
        const ac2 = new AbortController();
        const p1 = session.query(['packages/payments/src/fee.ts#calculateFee'], 2, {
          signal: ac1.signal,
        });
        const p2 = session.query(['packages/payments/src/fee.ts#calculateFee'], 2, {
          signal: ac2.signal,
        });

        await delay(15);
        ac1.abort();

        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(buildCount, 1);
        assert.equal(abortCount, 0, 'sibling still waiting must keep build un-aborted');
        assert.equal(r1.answers[0]?.kind, 'failure');
        assert.equal(r2.answers[0]?.kind, 'result');
        assert.equal(r2.index.state, 'updated');
      } finally {
        rmSync(join(repo, '..'), { recursive: true, force: true });
      }
    });

    it('waits for child teardown when all waiters abort and starts a fresh build for live query arriving mid-teardown', async () => {
      const repo = await fixtureRepo('round6-f12-teardown');
      const cacheDir = join(repo, '..', 'cache');
      try {
        const base = await loadWorkspace(repo);
        const workspace = { ...base, cacheDir, config: { ...base.config, impact: impactOf(repo) } };
        let firstPid = 0;
        let teardownStarted!: () => void;
        const inTeardown = new Promise<void>((r) => {
          teardownStarted = r;
        });
        let callIdx = 0;

        const session = new ImpactSession(workspace, {
          waitMs: 5_000,
          build: async (ws, opts) => {
            const idx = ++callIdx;
            if (idx === 1) {
              const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
                stdio: 'ignore',
              });
              firstPid = child.pid!;
              await new Promise<void>((resolve) => {
                opts?.signal?.addEventListener(
                  'abort',
                  () => {
                    teardownStarted();
                    setTimeout(() => {
                      child.kill('SIGKILL');
                      child.once('exit', () => resolve());
                    }, 60);
                  },
                  { once: true },
                );
              });
              return { ok: false, code: 'index-failed', message: 'aborted', fix: 'retry' };
            }
            const indexer = new Indexer(ts, ws.root, ws.cacheDir);
            const report = await indexer.index({ impact: ws.config.impact, full: true });
            return { ok: true, value: { ...report } };
          },
        });

        const ac = new AbortController();
        const cancelledPromise = session.query(['packages/payments/src/fee.ts#calculateFee'], 2, {
          signal: ac.signal,
        });
        await delay(25);
        ac.abort();
        await inTeardown;

        // Live query arrives during cancelled teardown (before child exits at +60ms)
        const livePromise = session.query(['packages/payments/src/fee.ts#calculateFee'], 2);

        const cancelled = await cancelledPromise;
        assert.equal(cancelled.answers[0]?.kind, 'failure');
        assert.equal(
          isPidAlive(firstPid),
          false,
          `child pid ${firstPid} must be dead when Cancelled returns`,
        );

        const live = await livePromise;
        assert.equal(callIdx, 2, 'live query mid-teardown must start a fresh build');
        assert.equal(live.answers[0]?.kind, 'result');
        assert.equal(live.index.state, 'updated');
      } finally {
        rmSync(join(repo, '..'), { recursive: true, force: true });
      }
    });

    it('exits untilPublished early on finite waitMs when foreign lock releases without publishing', async () => {
      const repo = await fixtureRepo('round6-f12-lock');
      const cacheDir = join(repo, '..', 'cache');
      try {
        const base = await loadWorkspace(repo);
        const workspace = { ...base, cacheDir, config: { ...base.config, impact: impactOf(repo) } };
        const indexer = new Indexer(ts, repo, cacheDir);
        const report = await indexer.index({ impact: workspace.config.impact, full: true });
        assert.deepEqual(report.problems, []);

        // Drift so query attempts a build and encounters foreign lock
        await writeFile(
          join(repo, 'packages/payments/src/fee.ts'),
          'export function fee(n: number): number { return n + 2; }\n',
        );

        const lock = acquireBuildLock(cacheDir);
        assert.ok(lock.ok);
        setTimeout(() => lock.release(), 40);

        const session = new ImpactSession(workspace, {
          waitMs: 5_000,
          build: async () => ({
            ok: false,
            code: 'busy',
            message: 'lock held',
            fix: 'wait',
          }),
        });

        const t0 = performance.now();
        const res = await session.query(['packages/payments/src/fee.ts#calculateFee']);
        const elapsedMs = performance.now() - t0;
        assert.ok(
          elapsedMs < 1_000,
          `expected early exit after foreign lock released without publishing; took ${Math.round(elapsedMs)} ms`,
        );
        assert.equal(res.index.state, 'stale');
      } finally {
        rmSync(join(repo, '..'), { recursive: true, force: true });
      }
    });
  });

  describe('F8: lexical scanner regex-vs-division disambiguation', () => {
    it('scans regex containing backtick after }, keywords, and /= while keeping division after object and function literals as division', () => {
      const braceAndDiv = [
        'function testF8(s) {',
        '  const divObj = { a: 1 } / f8DivObjTarget / 2;',
        '  const divFn = function() { return 1; } / f8DivFnTarget / 2;',
        '  if (!s) { return; }',
        '  /`/.test(s);',
        '  f8AfterCloseBrace();',
        '  return [divObj, divFn];',
        '}',
        '',
      ].join('\n');
      const braceNames = new Set(['f8DivObjTarget', 'f8DivFnTarget', 'f8AfterCloseBrace']);
      const braceRes = scanLexically(ts, 'orphan.js', braceAndDiv, braceNames);
      assert.deepEqual(
        braceRes.unresolved.map((u) => u.name).sort(),
        ['f8AfterCloseBrace', 'f8DivFnTarget', 'f8DivObjTarget'],
        `brace+division mismatch: ${JSON.stringify(braceRes.unresolved)}`,
      );

      const keywords = [
        'async function testKeywords(x) {',
        '  if (false) {} else /`/.test(x);',
        '  await /`/.test(x);',
        '  (function* () { yield /`/; })();',
        '  const t = typeof /`/;',
        '  const v = void /`/;',
        '  const d = delete /`/;',
        '  do /`/.test(x); while (false);',
        '  const i = "source" in /`/;',
        '  const inst = x instanceof /`/;',
        '  const bit = 1 & /`/.source.length;',
        '  const eq = /=backtick`/.test(x);',
        '  f8AfterKeywords();',
        '  return [t, v, d, i, inst, bit, eq];',
        '}',
        '',
      ].join('\n');
      const kwRes = scanLexically(ts, 'orphan-kw.js', keywords, new Set(['f8AfterKeywords']));
      assert.deepEqual(
        kwRes.unresolved.map((u) => u.name),
        ['f8AfterKeywords'],
        `keywords+regex mismatch: ${JSON.stringify(kwRes.unresolved)}`,
      );
      const elseOnly = scanLexically(
        ts,
        'orphan-else.js',
        'if (false) x(); else /`/.test(x); f8AfterElse();',
        new Set(['f8AfterElse']),
      );
      assert.deepEqual(
        elseOnly.unresolved.map((u) => u.name),
        ['f8AfterElse'],
        `else+regex mismatch: ${JSON.stringify(elseOnly.unresolved)}`,
      );
    });
  });

  describe('F14: incremental entering names match unicode, braced, hex, and template escapes', () => {
    it('re-resolves unchanged files with \\u, \\u{}, \\x, and template escapes when matching declarations enter', async () => {
      const repo = await fixtureRepo('round6-f14');
      const cacheDir = join(repo, '..', 'cache');
      const coldDir = join(repo, '..', 'cold');
      try {
        await writeFile(
          join(repo, 'packages/api/src/f14-escapes.ts'),
          [
            "export const f14a = '\\x6614Hex';",
            "export const f14b = '\\u006614Uni';",
            "export const f14c = '\\u{66}14Braced';",
            'export const f14d = `\\u006614Tpl`;',
            '',
          ].join('\n'),
        );
        const impact = impactOf(repo);
        const indexer = new Indexer(ts, repo, cacheDir);
        const initial = await indexer.index({ impact, full: true });
        assert.deepEqual(initial.problems, []);

        // New declarations enter whose raw substrings do not appear in f14-escapes.ts.
        await writeFile(
          join(repo, 'packages/api/src/f14-targets.ts'),
          [
            'export function f14Hex(): number { return 1; }',
            'export function f14Uni(): number { return 2; }',
            'export function f14Braced(): number { return 3; }',
            'export function f14Tpl(): number { return 4; }',
            '',
          ].join('\n'),
        );

        await assertIncrementalEqualsCold(indexer, coldDir, 'F14 escaped entering names');

        const db = openPublished(cacheDir);
        assert.ok(db);
        try {
          const rows = db
            .prepare('SELECT name, lines FROM name_tokens WHERE file = ? ORDER BY name')
            .all('packages/api/src/f14-escapes.ts') as Array<{ name: string; lines: string }>;
          assert.deepEqual(
            rows.map((r) => r.name),
            ['f14Braced', 'f14Hex', 'f14Tpl', 'f14Uni'],
            `expected all 4 decoded names in name_tokens, got ${JSON.stringify(rows)}`,
          );
          assert.ok(canonicalLines(db).length > 0);
        } finally {
          db.close();
        }
      } finally {
        rmSync(join(repo, '..'), { recursive: true, force: true });
      }
    });
  });

  describe('F10, F11, F15: rendering fidelity, file union reach/depth, and overflow wording', () => {
    function makeResult(overrides: Partial<ImpactResult> = {}): ImpactResult {
      return {
        target: 'packages/api/src/low/medium-target.ts#criticalHandler',
        span: { file: 'packages/api/src/low/medium-target.ts', startLine: 1, endLine: 5 },
        byDepth: [
          [
            {
              symbol: 'packages/api/src/high/unknown-caller.ts#unknownCaller',
              via: 'CALLS',
              strength: 'compiler',
              span: {
                file: 'packages/api/src/high/unknown-caller.ts',
                startLine: 10,
                endLine: 12,
              },
            },
          ],
        ],
        bridged: [],
        tests: ['packages/api/src/low/critical.test.ts'],
        completeness: { status: 'complete', reasons: [] },
        reach: { direct: 1, total: 1, files: 1, packages: 1, crossPackage: false, routes: 0 },
        factors: [],
        limits: { unboundedDynamicImports: 0, excludedFiles: 0, failedFiles: 0 },
        scannedFiles: 10,
        verdict: { level: 'low', action: 'proceed', zones: [], requiredActions: [], basis: [] },
        freshness: { workingTreeHash: 'abc', includesUntracked: true },
        engine: { version: '0.1.0', typescript: '5.9.3', extractor: 'stamp' },
        ...overrides,
      };
    }

    it('F10: preserves level-word identifiers and paths without underscore mangling in results and guidance', () => {
      const resAnswer: ImpactAnswer = {
        input: 'packages/api/src/low/medium-target.ts#criticalHandler',
        kind: 'result',
        value: makeResult(),
      };
      const out = renderAnswer(resAnswer);
      assert.ok(out.includes('packages/api/src/low/medium-target.ts'), out);
      assert.ok(out.includes('criticalHandler'), out);
      assert.ok(out.includes('packages/api/src/high/unknown-caller.ts'), out);
      assert.ok(out.includes('unknownCaller'), out);
      assert.ok(out.includes('packages/api/src/low/critical.test.ts'), out);
      assert.equal(
        /_(low|medium|high|critical|unknown)|l_ow|m_edium|h_igh|c_ritical|u_nknown/.test(out),
        false,
        out,
      );

      const amb: ImpactAnswer = {
        input: 'low',
        kind: 'guidance',
        code: 'ambiguous-target',
        message: 'AMBIGUOUS low — 2 declarations',
        candidates: ['src/low/unknown.ts#mediumFn', 'src/high/critical.ts#lowFn'],
      };
      const ambOut = renderAnswer(amb);
      assert.ok(ambOut.includes('AMBIGUOUS low'), ambOut);
      assert.ok(ambOut.includes('src/low/unknown.ts#mediumFn'), ambOut);
      assert.ok(ambOut.includes('src/high/critical.ts#lowFn'), ambOut);

      const notFound: ImpactAnswer = {
        input: 'unknownSymbol',
        kind: 'guidance',
        code: 'target-not-found',
        message: 'NOT FOUND unknownSymbol',
        nearest: ['src/low/critical.ts#mediumHelper'],
      };
      const nfOut = renderAnswer(notFound);
      assert.ok(nfOut.includes('NOT FOUND unknownSymbol'), nfOut);
      assert.ok(nfOut.includes('src/low/critical.ts#mediumHelper'), nfOut);
    });

    it('F11: deduplicates shared callers across exports and packages by shallowest depth and distinct file/package/route union', async () => {
      const repo = await fixtureRepo('round6-f11');
      const cacheDir = join(repo, '..', 'cache');
      try {
        await writeFile(
          join(repo, 'packages/payments/src/fee.ts'),
          [
            "import { formatMoney, type Money } from '@fx/shared/money';",
            'export interface Fee { amount: Money; }',
            'export function unusedHelper(): number { return 0; }',
            'export function calculateFee(amount: number): Money;',
            'export function calculateFee(amount: number, rate: number): Money;',
            'export function calculateFee(amount: number, rate = 0.1): Money {',
            '  return formatMoney(Math.round(amount * rate));',
            '}',
            'export function secondFee(amount: number): Money {',
            '  return formatMoney(amount + 1);',
            '}',
            '',
          ].join('\n'),
        );
        // PaymentService.charge already calls calculateFee (depth 1); add secondFee call inside PaymentService.charge
        // AND add a direct call to secondFee from apps/web AND packages/api/src/routes.ts (distinct packages & route).
        await writeFile(
          join(repo, 'packages/payments/src/service.ts'),
          [
            "import { calculateFee, secondFee } from './fee';",
            'export default class PaymentService {',
            '  charge(amount: number) { return [calculateFee(amount), secondFee(amount)]; }',
            '}',
            '',
          ].join('\n'),
        );
        await writeFile(
          join(repo, 'packages/api/src/f11-route.ts'),
          [
            "import { secondFee } from '../../payments/src/fee';",
            'export function routeSecond() { return secondFee(5); }',
            '',
          ].join('\n'),
        );
        const baseImpact = impactOf(repo);
        const impact = {
          ...baseImpact,
          routes: [...baseImpact.routes, 'packages/api/src/f11-route.ts'],
        };
        const indexer = new Indexer(ts, repo, cacheDir);
        const report = await indexer.index({ impact, full: true });
        assert.deepEqual(report.problems, []);

        const db = openPublished(cacheDir);
        assert.ok(db);
        try {
          const iq = new ImpactQuery(db, impact);
          const ans = iq.query('packages/payments/src/fee.ts');
          if (ans.kind !== 'result' || !('results' in ans.value) || !ans.value.aggregate) {
            assert.fail(`expected FileImpactResult with aggregate, got ${JSON.stringify(ans)}`);
          }
          const agg = ans.value.aggregate;
          const allSymbols = agg.byDepth.flat().map((n) => n.symbol);
          assert.equal(
            new Set(allSymbols).size,
            allSymbols.length,
            `duplicate caller symbols in aggregate.byDepth: ${JSON.stringify(allSymbols)}`,
          );
          const naiveDirectSum = ans.value.results.reduce((s, r) => s + r.reach.direct, 0);
          assert.ok(
            agg.reach.direct < naiveDirectSum,
            `expected deduplicated direct reach < sum (${agg.reach.direct} vs ${naiveDirectSum})`,
          );
          assert.equal(agg.reach.crossPackage, true);
          // Distinct routes: packages/api/src/routes.ts (depth 2) and packages/api/src/f11-route.ts (depth 1) = 2
          assert.equal(agg.reach.routes, 2, JSON.stringify(agg.reach));
        } finally {
          db.close();
        }
      } finally {
        rmSync(join(repo, '..'), { recursive: true, force: true });
      }

      // Also verify renderFileBlock fallback deduplicates shallowest depth and union counts when aggregate is absent
      const sharedNode = {
        symbol: 'packages/api/src/shared.ts#sharedCaller',
        via: 'CALLS' as const,
        strength: 'compiler' as const,
        span: { file: 'packages/api/src/shared.ts', startLine: 1, endLine: 2 },
        route: true,
      };
      const fileFallback: ImpactAnswer = {
        input: 'packages/payments/src/fee.ts',
        kind: 'result',
        value: {
          file: 'packages/payments/src/fee.ts',
          results: [
            makeResult({
              target: 'packages/payments/src/fee.ts#a',
              byDepth: [[sharedNode]],
              reach: { direct: 1, total: 1, files: 1, packages: 1, crossPackage: false, routes: 1 },
            }),
            makeResult({
              target: 'packages/payments/src/fee.ts#b',
              byDepth: [[], [sharedNode]],
              reach: { direct: 0, total: 1, files: 1, packages: 1, crossPackage: false, routes: 1 },
            }),
          ],
          remainder: 0,
        },
      };
      const fallbackText = renderAnswer(fileFallback);
      assert.equal(
        fallbackText.split('sharedCaller').length - 1,
        1,
        `sharedCaller must appear once at shallowest depth:\n${fallbackText}`,
      );
      assert.match(fallbackText, /REACH 1 direct · 1 total · 1 file/, fallbackText);
    });

    it('F15: omits futile "depth 1 and a single target" advice on single-target depth 1 overflow and prints true depth range on multi-depth fallback', () => {
      const manyD1 = Array.from({ length: 100 }, (_, i) => ({
        symbol: `packages/api/src/c${i}.ts#caller${i}`,
        via: 'CALLS' as const,
        strength: 'compiler' as const,
        span: { file: `packages/api/src/c${i}.ts`, startLine: 1, endLine: 2 },
      }));
      const singleD1: ImpactAnswer = {
        input: 'packages/api/src/target.ts#target',
        kind: 'result',
        value: makeResult({
          target: 'packages/api/src/target.ts#target',
          byDepth: [manyD1],
          reach: {
            direct: 100,
            total: 100,
            files: 100,
            packages: 1,
            crossPackage: false,
            routes: 0,
          },
        }),
      };
      const d1Text = renderAnswer(singleD1);
      assert.equal(
        d1Text.includes('Call again with depth 1 and a single target'),
        false,
        `single-target depth 1 cannot narrow further:\n${d1Text}`,
      );

      // Multi-depth fallback when budget forces summary of both depths
      const multiDepth: ImpactAnswer = {
        input: 'packages/api/src/target.ts#target',
        kind: 'result',
        value: makeResult({
          target: 'packages/api/src/target.ts#target',
          byDepth: [manyD1.slice(0, 5), manyD1.slice(5, 10)],
          reach: { direct: 5, total: 10, files: 10, packages: 1, crossPackage: false, routes: 0 },
        }),
      };
      const tightText = renderImpact(
        {
          answers: [multiDepth],
          index: { state: 'fresh', updatedFiles: 0, driftedFiles: [] },
        },
        { targetBudget: 350, batchBudget: 350 },
      );
      assert.match(tightText, /Depth 1–2:/, tightText);
    });

    it('ei init --dry-run prints (would create) and (would overwrite)', async () => {
      const repo = await fixtureRepo('round6-init-dry');
      const cliMain = resolve(process.cwd(), 'dist/adapters/cli/main.js');
      const runInit = (args: string[]): Promise<{ code: number | null; stdout: string }> =>
        new Promise((res, rej) => {
          const child = spawn(process.execPath, [cliMain, 'init', ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
          });
          child.on('error', rej);
          child.on('close', (code) => res({ code, stdout }));
        });
      try {
        const overwriteRun = await runInit(['--root', repo, '--dry-run', '--force']);
        assert.equal(overwriteRun.code, 0);
        assert.match(overwriteRun.stdout, /\(would overwrite\)/, overwriteRun.stdout);

        await rm(join(repo, 'ei.config.json'), { force: true });
        const createRun = await runInit(['--root', repo, '--dry-run']);
        assert.equal(createRun.code, 0);
        assert.match(createRun.stdout, /\(would create\)/, createRun.stdout);
      } finally {
        rmSync(join(repo, '..'), { recursive: true, force: true });
      }
    });
  });
});
