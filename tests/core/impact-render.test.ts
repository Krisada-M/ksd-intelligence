import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { ImpactQuery, type ImpactAnswer } from '../../src/core/impact/query.js';
import {
  BATCH_BUDGET,
  TARGET_BUDGET,
  renderAnswer,
  renderImpact,
} from '../../src/core/impact/render.js';
import { ImpactSession } from '../../src/core/impact/session.js';
import { loadWorkspace } from '../../src/core/engine/workspace.js';
import type { ImpactNode, ImpactResult } from '../../src/core/kernel/types.js';
import { openPublished } from '../../src/storage/sqlite.js';
import { fixtureRepo, impactOf, readReleaseSnapshot } from './index-helpers.js';

const execFileAsync = promisify(execFile);
const SNAP_DIR = join(process.cwd(), 'tests/snapshots/impact');
const LEVEL_RE = /\b(low|medium|high|critical|unknown)\b/gi;

function assertOneVerdict(block: string, label: string): void {
  const lines = block.split('\n');
  const actionLines = lines.filter((line) => line.startsWith('ACTION '));
  assert.equal(actionLines.length, 1, `${label}: expected exactly one ACTION line in:\n${block}`);
  const actionMatches = actionLines[0]!.match(LEVEL_RE) ?? [];
  assert.equal(
    actionMatches.length,
    1,
    `${label}: expected exactly one level word on ACTION line: ${actionLines[0]}`,
  );
  // Template+slot rendering (F10) places the verdict only on `ACTION ... · level <verdict>`
  // and never introduces a second verdict/action header line while preserving symbol names verbatim.
  for (const line of lines) {
    if (line === actionLines[0]) continue;
    assert.equal(
      /^(ACTION|VERDICT)\b/.test(line),
      false,
      `${label}: unexpected verdict/action line outside ACTION header: ${line}`,
    );
  }
}

function assertNoEnvironmentLeak(text: string, repoPath: string, label: string): void {
  assert.ok(!text.includes(repoPath), `${label}: leaked repo absolute path`);
  const home = homedir();
  if (home.length > 1) assert.ok(!text.includes(home), `${label}: leaked home directory`);
  assert.ok(!text.includes(String(process.pid)), `${label}: leaked process.pid`);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), `${label}: leaked ISO timestamp`);
}

describe('M2b Step 3.1 — impact rendering and snapshots', () => {
  let repo: string;
  let cache: string;
  let db: DatabaseSync;
  let query: ImpactQuery;

  before(async () => {
    repo = await fixtureRepo('impact-render');
    cache = join(dirname(repo), 'cache');
    const indexer = new Indexer(ts, repo, cache);
    const report = await indexer.index({ impact: impactOf(repo), full: true, freshness: 'hash' });
    assert.deepEqual(report.problems, []);
    const opened = openPublished(cache);
    assert.ok(opened);
    db = opened;
    query = new ImpactQuery(db, impactOf(repo), { riskZones: [] });
  });

  after(async () => {
    db?.close();
    if (repo) await rm(dirname(repo), { recursive: true, force: true });
  });

  it('matches PROPOSED snapshots at default depth 2 for C01, C06, C11, C13, C14, C15 and batch-3', async () => {
    const cases: Array<[string, string]> = [
      ['C01.txt', renderAnswer(query.query('packages/payments/src/fee.ts#calculateFee'))],
      [
        'C06.txt',
        renderAnswer(query.query('packages/payments/src/stripe.ts#StripeProcessor.charge')),
      ],
      ['C11.txt', renderAnswer(query.query('packages/api/src/handlers/refund.ts#refund'))],
      ['C13.txt', renderAnswer(query.query('packages/payments/src/fee.ts#unusedHelper'))],
      ['C14.txt', renderAnswer(query.query('packages/payments/src/fee.ts#localOnly'))],
      ['C15.txt', renderAnswer(query.query('charge'))],
      [
        'batch-3.txt',
        renderImpact({
          answers: query.batch([
            'packages/payments/src/fee.ts#calculateFee',
            'charge',
            'packages/payments/src/fee.ts#localOnly',
          ]),
          index: { state: 'fresh', updatedFiles: 0, driftedFiles: [] },
        }),
      ],
    ];
    for (const [file, rendered] of cases) {
      const expected = await readReleaseSnapshot(join(SNAP_DIR, file));
      assert.equal(rendered, expected, `snapshot ${file}`);
      assertNoEnvironmentLeak(rendered, repo, file);
      if (file !== 'C15.txt' && file !== 'batch-3.txt') {
        assertOneVerdict(rendered, file);
      }
    }
  });

  it('matches PROPOSED snapshots for C26 (depth 2), d51-parent (depth 2), over-budget (depth 3) and stale-index (depth 2)', async () => {
    // C26
    const c26Repo = await fixtureRepo('snap-c26');
    try {
      await writeFile(
        join(c26Repo, 'packages/shared/src/many.ts'),
        `function tiny() {}\n${Array.from({ length: 10 }, (_, i) => `function f${i}() { tiny(); }`).join('\n')}\n`,
      );
      const c26Cache = join(dirname(c26Repo), 'cache');
      await new Indexer(ts, c26Repo, c26Cache).index({
        impact: impactOf(c26Repo),
        full: true,
        freshness: 'hash',
      });
      const c26Db = openPublished(c26Cache)!;
      try {
        const rendered = renderAnswer(
          new ImpactQuery(c26Db, impactOf(c26Repo), { riskZones: [] }).query(
            'packages/shared/src/many.ts#tiny',
          ),
        );
        const expected = await readReleaseSnapshot(join(SNAP_DIR, 'C26.txt'));
        assert.equal(rendered, expected, 'C26.txt');
        assertOneVerdict(rendered, 'C26.txt');
      } finally {
        c26Db.close();
      }
    } finally {
      await rm(dirname(c26Repo), { recursive: true, force: true });
    }

    // D51 parent
    const d51Repo = await fixtureRepo('snap-d51');
    try {
      await writeFile(
        join(d51Repo, 'packages/shared/src/anonymous.ts'),
        'export interface Usage { cost: { input: number }; }\nexport function costOf(u: Usage) { return u.cost; }\n',
      );
      const d51Cache = join(dirname(d51Repo), 'cache');
      await new Indexer(ts, d51Repo, d51Cache).index({
        impact: impactOf(d51Repo),
        full: true,
        freshness: 'hash',
      });
      const d51Db = openPublished(d51Cache)!;
      try {
        const rendered = renderAnswer(
          new ImpactQuery(d51Db, impactOf(d51Repo), { riskZones: [] }).query('Usage.cost.input'),
        );
        const expected = await readReleaseSnapshot(join(SNAP_DIR, 'd51-parent.txt'));
        assert.equal(rendered, expected, 'd51-parent.txt');
        assertOneVerdict(rendered, 'd51-parent.txt');
      } finally {
        d51Db.close();
      }
    } finally {
      await rm(dirname(d51Repo), { recursive: true, force: true });
    }

    // Over-budget
    const overRepo = await fixtureRepo('snap-over');
    try {
      const lines = [
        'export function hub(): number { return 1; }',
        ...Array.from(
          { length: 6 },
          (_, i) => `export function d1_${i}(): number { return hub(); }`,
        ),
        ...Array.from(
          { length: 80 },
          (_, i) =>
            `export function d2_${String(i).padStart(2, '0')}(): number { return d1_${i % 6}(); }`,
        ),
        ...Array.from(
          { length: 80 },
          (_, i) =>
            `export function d3_${String(i).padStart(2, '0')}(): number { return d2_${String(i).padStart(2, '0')}(); }`,
        ),
      ];
      await writeFile(join(overRepo, 'packages/shared/src/budget.ts'), `${lines.join('\n')}\n`);
      const overCache = join(dirname(overRepo), 'cache');
      await new Indexer(ts, overRepo, overCache).index({
        impact: impactOf(overRepo),
        full: true,
        freshness: 'hash',
      });
      const overDb = openPublished(overCache)!;
      try {
        const rendered = renderAnswer(
          new ImpactQuery(overDb, impactOf(overRepo), { riskZones: [] }).query(
            'packages/shared/src/budget.ts#hub',
            3,
          ),
        );
        const expected = await readReleaseSnapshot(join(SNAP_DIR, 'over-budget.txt'));
        assert.equal(rendered, expected, 'over-budget.txt');
        assert.ok(rendered.length <= TARGET_BUDGET);
        assertOneVerdict(rendered, 'over-budget.txt');
      } finally {
        overDb.close();
      }
    } finally {
      await rm(dirname(overRepo), { recursive: true, force: true });
    }

    // Stale-index
    const staleRepo = await fixtureRepo('snap-stale');
    try {
      const workspace = await loadWorkspace(staleRepo, dirname(staleRepo));
      await new Indexer(ts, staleRepo, workspace.cacheDir).index({
        impact: workspace.config.impact,
        full: true,
        freshness: 'hash',
      });
      const chargePath = join(staleRepo, 'packages/api/src/charge.ts');
      await writeFile(
        chargePath,
        `${await readFile(chargePath, 'utf8')}\nexport function extra() { calculateFee(1); }\n`,
      );
      const session = new ImpactSession(workspace, {
        waitMs: 5,
        build: () => new Promise(() => {}),
      });
      const batch = await session.query(['packages/payments/src/fee.ts#calculateFee']);
      const rendered = renderImpact(batch);
      const expected = await readReleaseSnapshot(join(SNAP_DIR, 'stale-index.txt'));
      assert.equal(rendered, expected, 'stale-index.txt');
      assertOneVerdict(rendered, 'stale-index.txt');
    } finally {
      await rm(dirname(staleRepo), { recursive: true, force: true });
    }
  });

  it('produces byte-identical output twice in-process and across a fresh child process', async () => {
    const first = renderAnswer(query.query('packages/payments/src/fee.ts#calculateFee', 2));
    const second = renderAnswer(query.query('packages/payments/src/fee.ts#calculateFee', 2));
    assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0);

    const script = [
      `import { openPublished } from './dist/storage/sqlite.js';`,
      `import { ImpactQuery } from './dist/core/impact/query.js';`,
      `import { renderAnswer } from './dist/core/impact/render.js';`,
      `const db = openPublished(${JSON.stringify(cache)});`,
      `const q = new ImpactQuery(db, ${JSON.stringify(impactOf(repo))}, { riskZones: [] });`,
      `process.stdout.write(renderAnswer(q.query('packages/payments/src/fee.ts#calculateFee', 2)));`,
      `db.close();`,
    ].join(' ');
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
      },
    );
    assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(stdout)), 0);
  });

  it('enforces the one-verdict rule across all golden targets and synthetic level-word collisions', () => {
    const targets = [
      'packages/payments/src/fee.ts#calculateFee',
      'packages/shared/src/money.ts#roundMoney',
      'packages/payments/src/service.ts#PaymentService.charge',
      'packages/payments/src/stripe.ts#StripeProcessor.charge',
      'packages/payments/src/fee.ts#Fee',
      'packages/api/src/handlers/refund.ts#refund',
      'packages/api/src/charge.ts#chargeHandler',
      'packages/payments/src/fee.ts#unusedHelper',
      'packages/payments/src/fee.ts#localOnly',
      'packages/shared/src/legacy.cjs#toCents',
      'packages/payments/src/cycle-a.ts#a',
      'packages/payments/src/fee.ts',
    ];
    for (const target of targets) {
      const text = renderAnswer(query.query(target, 5));
      assertOneVerdict(text, target);
      assertNoEnvironmentLeak(text, repo, target);
    }

    // Synthetic result with 'unknown' in engine.typescript and level words in symbol/gap text.
    const baseAnswer = query.query('packages/payments/src/fee.ts#localOnly');
    assert.equal(baseAnswer.kind, 'result');
    assert.ok('target' in baseAnswer.value);
    const mutated: ImpactResult = {
      ...baseAnswer.value,
      target: 'packages/payments/src/low.ts#unknownHelper',
      completeness: {
        status: 'partial',
        reasons: ['unresolved-name-match: packages/api/src/high.ts:4 — critical'],
      },
      verdict: {
        level: 'unknown',
        action: 'check-gaps',
        zones: [],
        requiredActions: [],
        basis: [],
      },
      engine: { version: '0.1.0', typescript: 'unknown', extractor: 'unknown' },
    };
    const rendered = renderAnswer({ input: 'unknownHelper', kind: 'result', value: mutated });
    assertOneVerdict(rendered, 'synthetic-collision');
    assert.ok(rendered.includes('unknownHelper'));
    assert.ok(rendered.includes('packages/api/src/high.ts'));
    assert.ok(rendered.includes('critical'));
  });

  it('caps single-target output at 4,000 characters, keeps depth 1, and names follow-up call on overflow', () => {
    const baseAnswer = query.query('packages/payments/src/fee.ts#calculateFee', 1);
    assert.equal(baseAnswer.kind, 'result');
    assert.ok('target' in baseAnswer.value);

    const makeNodes = (depth: number, count: number): ImpactNode[] =>
      Array.from({ length: count }, (_, i) => ({
        symbol: `packages/pkg-${i % 5}/src/file-${i % 12}.ts#caller_d${depth}_${i}`,
        via: 'CALLS',
        strength: 'compiler',
        span: {
          file: `packages/pkg-${i % 5}/src/file-${i % 12}.ts`,
          startLine: i + 1,
          endLine: i + 2,
        },
      }));

    // Property check across varied depth-1 and deeper caller counts and custom budgets.
    for (const [d1Count, d2Count, d3Count] of [
      [8, 60, 40],
      [15, 100, 0],
      [3, 40, 90],
      [120, 30, 20],
    ] as const) {
      const synth: ImpactResult = {
        ...baseAnswer.value,
        byDepth: [makeNodes(1, d1Count), makeNodes(2, d2Count), makeNodes(3, d3Count)].filter(
          (level) => level.length > 0,
        ),
      };
      const text = renderAnswer({ input: synth.target, kind: 'result', value: synth });
      assert.ok(
        text.length <= TARGET_BUDGET,
        `expected length <= ${TARGET_BUDGET}, got ${text.length}`,
      );
      assertOneVerdict(text, `budget-${d1Count}-${d2Count}-${d3Count}`);
      if (d1Count <= 15) {
        for (let i = 0; i < d1Count; i++) {
          assert.ok(text.includes(`caller_d1_${i}`), `depth-1 caller ${i} kept`);
        }
      }
      const overflowLines = text.split('\n').filter((line) => /Depth \d+: .* more in /.test(line));
      assert.ok(overflowLines.length >= 1, 'expected at least one overflow summary line');
      for (const line of overflowLines) {
        if (line.trimStart().startsWith('Depth 1:')) {
          assert.equal(line.includes('Call again with depth 1 and a single target'), false, line);
        } else {
          assert.match(line, /Call again with depth \d+ and a single target to list them\./);
        }
      }
    }
  });

  it('keeps the first three lines for every target when a 5-target batch exceeds 12,000 characters', () => {
    const baseAnswer = query.query('packages/payments/src/fee.ts#calculateFee', 1);
    assert.equal(baseAnswer.kind, 'result');
    assert.ok('target' in baseAnswer.value);

    const bigCallers: ImpactNode[] = Array.from({ length: 120 }, (_, i) => ({
      symbol: `packages/payments/src/caller-${i}.ts#call_${i}`,
      via: 'CALLS',
      strength: 'compiler',
      span: { file: `packages/payments/src/caller-${i}.ts`, startLine: i + 1, endLine: i + 2 },
    }));

    const answers: ImpactAnswer[] = Array.from({ length: 5 }, (_, idx) => ({
      input: `target_${idx}`,
      kind: 'result',
      value: {
        ...baseAnswer.value,
        target: `packages/payments/src/fee.ts#target_${idx}`,
        byDepth: [bigCallers],
      },
    }));

    // Each target alone is ~3,900 chars (5 * 3,900 = ~19,500 > 12,000).
    for (const answer of answers) {
      const single = renderAnswer(answer);
      assert.ok(single.length > 3_000 && single.length <= TARGET_BUDGET);
    }

    const batchText = renderImpact({
      answers,
      index: { state: 'fresh', updatedFiles: 0, driftedFiles: [] },
    });
    assert.ok(
      batchText.length <= BATCH_BUDGET,
      `batch length ${batchText.length} > ${BATCH_BUDGET}`,
    );
    for (let idx = 0; idx < 5; idx++) {
      assert.ok(batchText.includes(`IMPACT target_${idx} — packages/payments/src/fee.ts:9`));
    }
    const blocks = batchText.split('\n\nIMPACT ');
    assert.equal(blocks.length, 5);
    for (let idx = 0; idx < blocks.length; idx++) {
      const block = idx === 0 ? blocks[idx]! : `IMPACT ${blocks[idx]!}`;
      const lines = block.split('\n');
      assert.match(lines[0] ?? '', /^IMPACT target_\d+ — /);
      assert.match(lines[1] ?? '', /^ACTION /);
      assert.match(lines[2] ?? '', /^REACH /);
    }
  });

  it('renders a target with 5,000 callers within the 4,000-char budget and under 300 ms', () => {
    const baseAnswer = query.query('packages/payments/src/fee.ts#calculateFee', 1);
    assert.equal(baseAnswer.kind, 'result');
    assert.ok('target' in baseAnswer.value);

    const fiveThousand: ImpactNode[] = Array.from({ length: 5_000 }, (_, i) => ({
      symbol: `packages/pkg-${i % 20}/src/mod-${i % 100}.ts#fn_${i}`,
      via: 'CALLS',
      strength: 'compiler',
      span: {
        file: `packages/pkg-${i % 20}/src/mod-${i % 100}.ts`,
        startLine: (i % 200) + 1,
        endLine: (i % 200) + 2,
      },
    }));

    const huge: ImpactAnswer = {
      input: 'calculateFee',
      kind: 'result',
      value: {
        ...baseAnswer.value,
        reach: { ...baseAnswer.value.reach, direct: 5_000, total: 5_000, files: 100 },
        byDepth: [fiveThousand],
      },
    };

    const started = performance.now();
    const text = renderAnswer(huge);
    const elapsedMs = performance.now() - started;

    assert.ok(text.length <= TARGET_BUDGET, `length ${text.length} <= ${TARGET_BUDGET}`);
    assert.ok(elapsedMs < 300, `5,000-caller render took ${elapsedMs.toFixed(1)} ms (>= 300 ms)`);
    assert.match(text, /Depth 1: [\d,]+ more in \d+ files\./);
    assert.equal(text.includes('Call again with depth 1 and a single target to list them.'), false);
    assertOneVerdict(text, '5000-callers');
  });

  it('renders gaps as "code path:line — what to check", capped at 10 with a count', () => {
    const baseAnswer = query.query('packages/payments/src/fee.ts#calculateFee', 1);
    assert.equal(baseAnswer.kind, 'result');
    assert.ok('target' in baseAnswer.value);

    const reasons = Array.from(
      { length: 14 },
      (_, i) =>
        `dynamic-import: packages/api/src/loader-${String(i).padStart(2, '0')}.ts:${i + 1} — packages/api/src/handlers/`,
    );
    const withManyGaps: ImpactAnswer = {
      input: 'calculateFee',
      kind: 'result',
      value: {
        ...baseAnswer.value,
        completeness: { status: 'partial', reasons },
        verdict: {
          ...baseAnswer.value.verdict,
          level: 'unknown',
          action: 'check-gaps',
        },
      },
    };

    const text = renderAnswer(withManyGaps);
    assert.ok(text.includes('Gaps (14)'));
    const gapLines = text
      .split('\n')
      .filter((line) => line.startsWith('  dynamic-import packages/api/src/loader-'));
    assert.equal(gapLines.length, 10);
    for (const line of gapLines) {
      assert.match(line, /^  [a-z-]+ [^:\s]+:\d+ — .+$/);
    }
    assert.ok(text.includes('  (+4 more)'));
    assertOneVerdict(text, '14-gaps');
  });

  it('renders guidance shapes, line-resolved targets, file targets, and footer limits', async () => {
    const notFound = renderAnswer(query.query('calcFee'));
    assert.match(notFound, /^NOT FOUND calcFee\. Closest names in the index:\n  /);
    assert.match(notFound, /If the symbol is new and unsaved, save the file and call again\.$/);

    const lineResolved = renderAnswer(query.query('packages/payments/src/fee.ts:11', 1));
    assert.match(
      lineResolved,
      /^IMPACT calculateFee — packages\/payments\/src\/fee\.ts:9 \(nearest indexed declaration enclosing line 11\)/,
    );

    const building = renderAnswer({
      input: 'calculateFee',
      kind: 'guidance',
      code: 'index-building',
      message: 'index-building',
    });
    assert.match(
      building,
      /^INDEX BUILDING — .*Call again; the answer will use the finished index\.$/,
    );

    const notIndexed = renderAnswer({
      input: '.env',
      kind: 'guidance',
      code: 'target-not-found',
      message: 'NOT INDEXED .env — secret',
    });
    assert.equal(notIndexed, 'NOT INDEXED .env — secret');

    // Footer limits when repository has unbounded dynamic imports / excluded files.
    const baseAnswer = query.query('packages/payments/src/fee.ts#localOnly');
    assert.equal(baseAnswer.kind, 'result');
    assert.ok('target' in baseAnswer.value);
    const withLimits = renderAnswer({
      input: 'localOnly',
      kind: 'result',
      value: {
        ...baseAnswer.value,
        limits: { unboundedDynamicImports: 3, excludedFiles: 7, failedFiles: 1 },
      },
    });
    assert.match(
      withLimits,
      /— index fresh · 26 files · limits: 3 unbounded dynamic imports, 7 excluded files, 1 file failed to index · ts /,
    );
  });
});
