import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { Graph } from '../../src/core/graph/graph.js';
import { FAILURE_FILE, indexPath, openPublished, readMeta } from '../../src/storage/sqlite.js';
import {
  assertIncrementalEqualsCold,
  coldLines,
  fixtureRepo,
  impactOf,
  publishedLines,
} from './index-helpers.js';

const PAY = 'packages/payments/src';
const API = 'packages/api/src';

/** `via` edges into `target` as `source via KIND`, sorted. */
function users(graph: Graph, target: string): string[] {
  return (graph.incoming(target, 1)[0] ?? [])
    .map((node) => `${node.symbol} via ${node.via}`)
    .sort();
}

describe('index of the base fixture (ADR 0002/0003; golden edges at index level)', () => {
  let repo: string;
  let graph: Graph;
  before(async () => {
    repo = await fixtureRepo('index');
    const indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
    const report = await indexer.index({ impact: impactOf(repo) });
    assert.equal(report.action, 'cold');
    assert.deepEqual(report.problems, []);
    const opened = Graph.open(indexer.cacheDir);
    assert.ok(opened);
    graph = opened;
  });
  after(async () => {
    graph.close();
    await rm(dirname(repo), { recursive: true, force: true });
  });

  it('C01–C03, C08, C10: every call of calculateFee is one CALLS edge to the one key', () => {
    // byDepth is a set (golden assertion rules): order-insensitive.
    assert.deepEqual(
      users(graph, `${PAY}/fee.ts#calculateFee`).sort(),
      [
        `${API}/charge.ts#chargeHandler via CALLS`, // C02: through the @fx/payments barrel
        'apps/web/src/checkout.ts#submit via CALLS', // C03: imported as `fee`
        `${PAY}/checkout-flow.ts#lazyFee via CALLS`, // C10: literal dynamic import
        `${PAY}/fee.test.ts#<module> via CALLS`, // C08: both overloads, one key
        `${PAY}/service.ts#PaymentService.charge via CALLS`, // C01
      ].sort(),
    );
    const node = graph
      .incoming(`${PAY}/fee.ts#calculateFee`, 1)[0]
      ?.find((n) => n.symbol.endsWith('#<module>'));
    assert.deepEqual(node?.lines, [3, 4], 'C08: call sites of either overload');
    assert.equal(node?.strength, 'compiler');
  });

  it('C04, C07, C18: paths alias, callback reference, plain JS caller of roundMoney', () => {
    assert.deepEqual(users(graph, 'packages/shared/src/money.ts#roundMoney'), [
      `${API}/report.js#report via CALLS`, // C18
      `${PAY}/checkout-flow.ts#normalizeAll via REFERENCES`, // C07: not CALLS
      `${PAY}/fee.ts#calculateFee via CALLS`, // C04: imported as @fx/shared/money
    ]);
    const depth2 = (graph.incoming('packages/shared/src/money.ts#roundMoney', 2)[1] ?? []).map(
      (n) => n.symbol,
    );
    assert.ok(depth2.includes(`${PAY}/service.ts#PaymentService.charge`), 'C04 depth 2');
    assert.ok(depth2.includes(`${API}/charge.ts#chargeHandler`), 'C04 depth 2');
  });

  it('C05, C09: default export through the barrel; a type-only import is a reference, not a call', () => {
    assert.ok(
      users(graph, `${PAY}/service.ts#PaymentService`).includes(
        `${API}/charge.ts#chargeHandler via CONSTRUCTS`,
      ),
    );
    assert.deepEqual(users(graph, `${PAY}/fee.ts#Fee`), [
      'apps/web/src/checkout.ts#submit via REFERENCES',
    ]);
  });

  it('C06: an interface call is a CALLS edge to the interface member plus an interface-dispatch gap', () => {
    assert.deepEqual(users(graph, `${PAY}/processor.ts#PaymentProcessor.charge`), [
      `${PAY}/checkout-flow.ts#runCheckout via CALLS`,
      `${PAY}/manual.ts#ManualProcessor.charge via IMPLEMENTS`,
      `${PAY}/stripe.ts#StripeProcessor.charge via IMPLEMENTS`,
    ]);
    const db = gapsOf(repo);
    assert.ok(
      db.includes(
        `${PAY}/checkout-flow.ts:5 interface-dispatch ${PAY}/processor.ts#PaymentProcessor.charge`,
      ),
    );
  });

  it('C11, C12: computed dynamic import and computed registry access are gap sites, scoped', () => {
    const gaps = gapsOf(repo);
    assert.ok(gaps.includes(`${API}/handlers.ts:4 dynamic-import ${API}/handlers/`));
    assert.ok(
      gaps.includes(`${API}/handlers.ts:10 computed-member-access ${API}/handlers.ts#registry`),
    );
    assert.deepEqual(users(graph, `${API}/charge.ts#chargeHandler`), [
      `${API}/handlers.ts#registry.charge via REFERENCES`,
      `${API}/routes.ts#routes.POST /charge via REFERENCES`,
    ]);
  });

  it('C13, C19: no edge from a star re-export; a cycle terminates with each symbol once', () => {
    assert.deepEqual(graph.incoming(`${PAY}/fee.ts#unusedHelper`), []);
    const cycle = graph.incoming(`${PAY}/cycle-a.ts#a`, 5);
    assert.deepEqual(
      cycle.map((level) => level.map((n) => `${n.symbol} via ${n.via}`)),
      [[`${PAY}/cycle-b.ts#b via CALLS`]],
    );
  });

  it('C17: require() in TypeScript is a cjs-require gap plus an unresolved name match (outcome B)', () => {
    const gaps = gapsOf(repo);
    assert.ok(gaps.includes(`${PAY}/fee.ts:3 cjs-require packages/shared/src/legacy.cjs`));
    assert.ok(unresolvedOf(repo).includes(`${PAY}/fee.ts:12 unresolved-name-match toCents`));
  });

  it('C20: a test file has a TESTS edge to the module it tests', () => {
    const tests = graph.incoming(`${PAY}/fee.ts#<module>`, 1)[0] ?? [];
    assert.equal(tests.length, 0, 'file-level edges are not symbol users');
    assert.ok(testsEdges(repo).includes(`${PAY}/fee.test.ts#<module> -> ${PAY}/fee.ts#<module>`));
  });

  it('symbol(): key, path:line of an overload, Owner.member, bare names', () => {
    assert.deepEqual(graph.symbol(`${PAY}/fee.ts#calculateFee`), {
      kind: 'found',
      key: `${PAY}/fee.ts#calculateFee`,
    });
    assert.deepEqual(
      graph.symbol(`${PAY}/fee.ts:7`),
      { kind: 'found', key: `${PAY}/fee.ts#calculateFee` },
      'C08',
    );
    assert.deepEqual(graph.symbol('PaymentService.charge'), {
      kind: 'found',
      key: `${PAY}/service.ts#PaymentService.charge`,
    });
    const charge = graph.symbol('charge');
    assert.equal(charge.kind, 'ambiguous');
    // C15 lists four; ADR 0003 also indexes the object-literal member registry.charge (report).
    assert.deepEqual(charge.kind === 'ambiguous' && charge.candidates, [
      `${API}/handlers.ts#registry.charge`,
      `${PAY}/manual.ts#ManualProcessor.charge`,
      `${PAY}/processor.ts#PaymentProcessor.charge`,
      `${PAY}/service.ts#PaymentService.charge`,
      `${PAY}/stripe.ts#StripeProcessor.charge`,
    ]);
    assert.equal(graph.symbol('noSuchName').kind, 'not-found');
    assert.deepEqual(
      graph.symbol(`${PAY}/fee.ts:1`),
      { kind: 'found', key: `${PAY}/fee.ts#<module>` },
      'a line outside every declaration is the module',
    );
  });
});

function rows(repo: string, sql: string): string[] {
  // The published index of the `cache` sibling the `before` hook built.
  const db = new DatabaseSync(indexPath(join(repo, '..', 'cache')), { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => Object.values(row).map(String).join(' '));
  } finally {
    db.close();
  }
}
const gapsOf = (repo: string): string[] =>
  rows(repo, "SELECT file || ':' || line, code, detail FROM gap_sites");
const unresolvedOf = (repo: string): string[] =>
  rows(repo, "SELECT file || ':' || line, reason, name FROM unresolved");
const testsEdges = (repo: string): string[] =>
  rows(
    repo,
    `SELECT s.key || ' -> ' || t.key FROM edges e JOIN symbols s ON s.id = e.source
     JOIN symbols t ON t.id = e.target WHERE e.kind = 'TESTS'`,
  );

describe('freshness at index level (golden F01–F06, freshness "hash")', () => {
  let repo: string;
  let indexer: Indexer;
  let step = 0;
  const cold = (): string => join(repo, '..', `cold-${step++}`);

  before(async () => {
    repo = await fixtureRepo('fresh');
    indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
    assert.equal((await indexer.index({ impact: impactOf(repo) })).action, 'cold');
  });
  after(async () => {
    await rm(dirname(repo), { recursive: true, force: true });
  });

  it('F01 uncommitted edit: the new caller is an edge; incremental == cold', async () => {
    await appendFile(
      join(repo, `${API}/charge.ts`),
      '\nexport function chargeAgain(): number {\n  return calculateFee(2);\n}\n',
    );
    const report = await assertIncrementalEqualsCold(indexer, cold(), 'F01');
    assert.equal(report.action, 'update');
    const graph = Graph.open(indexer.cacheDir);
    assert.ok(graph);
    try {
      assert.ok(
        users(graph, `${PAY}/fee.ts#calculateFee`).includes(
          `${API}/charge.ts#chargeAgain via CALLS`,
        ),
      );
    } finally {
      graph.close();
    }
  });

  it('F02 untracked new file: indexed; incremental == cold', async () => {
    await writeFile(
      join(repo, `${API}/extra.ts`),
      "import { calculateFee } from '@fx/payments';\nexport const extra = () => calculateFee(3);\n",
    );
    await assertIncrementalEqualsCold(indexer, cold(), 'F02');
    assert.ok(
      publishedLines(indexer.cacheDir).some((line) =>
        line.startsWith(`declarations\t${API}/extra.ts#extra\t`),
      ),
    );
  });

  it('F03 rename then delete: no stale edges; incremental == cold after each', async () => {
    await rename(join(repo, 'apps/web/src/checkout.ts'), join(repo, 'apps/web/src/pay.ts'));
    await assertIncrementalEqualsCold(indexer, cold(), 'F03 rename');
    let lines = publishedLines(indexer.cacheDir);
    assert.equal(
      lines.some((line) => line.includes('apps/web/src/checkout.ts#')),
      false,
    );
    assert.ok(
      lines.some((line) =>
        line.startsWith(
          'edges\tapps/web/src/pay.ts#submit\tpackages/payments/src/fee.ts#calculateFee\tCALLS',
        ),
      ),
    );
    await rm(join(repo, 'apps/web/src/pay.ts'));
    await assertIncrementalEqualsCold(indexer, cold(), 'F03 delete');
    lines = publishedLines(indexer.cacheDir);
    assert.equal(
      lines.some((line) => line.includes('apps/web/src/pay.ts')),
      false,
    );
  });

  it('F04 barrel change: imports through @fx/payments become unresolved-import records', async () => {
    await writeFile(
      join(repo, `${PAY}/index.ts`),
      "export { default as PaymentService } from './service';\n",
    );
    await assertIncrementalEqualsCold(indexer, cold(), 'F04');
    const lines = publishedLines(indexer.cacheDir);
    assert.ok(
      lines.includes(
        `unresolved\t${API}/charge.ts\t1\tcalculateFee\tunresolved-import\t${API}/charge.ts#<module>`,
      ),
    );
    assert.equal(
      lines.some((line) =>
        line.startsWith(`edges\t${API}/charge.ts#chargeHandler\t${PAY}/fee.ts#calculateFee`),
      ),
      false,
    );
  });

  it('F05 holds after a signature edit too (importers re-resolved)', async () => {
    await writeFile(
      join(repo, 'packages/shared/src/money.ts'),
      'export function roundMoney(n: number, digits = 2): string {\n  return n.toFixed(digits);\n}\n',
    );
    const report = await assertIncrementalEqualsCold(indexer, cold(), 'signature');
    assert.ok(report.resolvedFiles > 1, 'importers of a changed surface are re-resolved');
  });

  it('F06 blind spot: a same-size edit with the mtime restored is missed by "stat", found by "hash"', async () => {
    const path = join(repo, `${PAY}/fee.ts`);
    const text = await readFile(path, 'utf8');
    const edited = text.replace('return 0;', 'return 1;');
    assert.equal(edited.length, text.length);
    // Whole seconds: a Date restores milliseconds only, and filesystems keep finer mtimes.
    const fixed = 1_700_000_000;
    utimesSync(path, fixed, fixed);
    await indexer.index({ impact: impactOf(repo), freshness: 'stat' }); // publish the fixed mtime
    await writeFile(path, edited);
    utimesSync(path, fixed, fixed);
    const impact = impactOf(repo);
    assert.equal(
      (await indexer.index({ impact, freshness: 'stat' })).action,
      'unchanged',
      'the accepted blind spot',
    );
    const report = await assertIncrementalEqualsCold(indexer, cold(), 'F06 full hash');
    assert.equal(report.action, 'update');
  });

  it('config-level change: a tsconfig paths edit is a cold build, equal to a cold build', async () => {
    const base = join(repo, 'tsconfig.base.json');
    await writeFile(
      base,
      (await readFile(base, 'utf8')).replace(
        '"@fx/payments": ["packages/payments/src/index.ts"]',
        '"@fx/payments": ["packages/payments/src/service.ts"]',
      ),
    );
    const report = await assertIncrementalEqualsCold(indexer, cold(), 'paths change');
    assert.equal(report.action, 'cold');
    assert.equal(report.reason, 'config changed: tsconfig.base.json');
  });
});

describe('verify and publish', () => {
  it('a timestamp-only publish preserves graph provenance and verification failure', async () => {
    const repo = await fixtureRepo('touch-provenance');
    const cacheDir = join(repo, '..', 'cache');
    const indexer = new Indexer(ts, repo, cacheDir);
    try {
      await indexer.index({ impact: impactOf(repo) });
      const before = openPublished(cacheDir);
      assert.ok(before);
      const meta = readMeta(before);
      before.close();
      const failurePath = join(cacheDir, FAILURE_FILE);
      await writeFile(
        failurePath,
        JSON.stringify({
          at: new Date().toISOString(),
          reason: 'doctor',
          problems: ['difference'],
        }),
      );
      const path = join(repo, `${API}/charge.ts`);
      const stat = statSync(path);
      utimesSync(path, stat.atime, new Date(stat.mtimeMs + 10_000));
      const report = await indexer.index({ impact: impactOf(repo), freshness: 'hash' });
      assert.equal(report.resolvedFiles, 0);
      const after = openPublished(cacheDir);
      assert.ok(after);
      const published = readMeta(after);
      after.close();
      assert.equal(published.programs, meta.programs);
      assert.equal(published.built_at, meta.built_at);
      assert.ok(existsSync(failurePath), 'touching files cannot validate the graph');
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });

  it('a failed VERIFY keeps the previous index and records incompleteReasons', async () => {
    const repo = await fixtureRepo('verify');
    try {
      const cacheDir = join(repo, '..', 'cache');
      await new Indexer(ts, repo, cacheDir).index({ impact: impactOf(repo) });
      const published = publishedLines(cacheDir);
      await appendFile(join(repo, `${API}/charge.ts`), '\nexport const more = 1;\n');
      const failing = new Indexer(ts, repo, cacheDir, {
        verify: () => ['edges whose target is not a declaration: 1'],
      });
      const report = await failing.index({ impact: impactOf(repo) });
      assert.equal(report.action, 'failed');
      assert.deepEqual(report.problems, ['edges whose target is not a declaration: 1']);
      assert.deepEqual(publishedLines(cacheDir), published, 'the previous index answers unchanged');
      const failure: unknown = JSON.parse(readFileSync(join(cacheDir, FAILURE_FILE), 'utf8'));
      assert.ok(typeof failure === 'object' && failure !== null && 'problems' in failure);
      assert.deepEqual(failure.problems, report.problems);
      assert.equal(existsSync(join(cacheDir, 'index.staging.sqlite')), false, 'staging discarded');

      const fixed = await new Indexer(ts, repo, cacheDir).index({ impact: impactOf(repo) });
      assert.equal(fixed.action, 'update');
      assert.equal(existsSync(join(cacheDir, FAILURE_FILE)), false, 'a good publish clears it');
      assert.deepEqual(publishedLines(cacheDir), await coldLines(repo, join(repo, '..', 'cold')));
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });

  it('an update with no drift publishes nothing', async () => {
    const repo = await fixtureRepo('noop');
    try {
      const indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
      await indexer.index({ impact: impactOf(repo) });
      const { mtimeMs } = statSync(indexPath(indexer.cacheDir));
      assert.equal((await indexer.index({ impact: impactOf(repo) })).action, 'unchanged');
      assert.equal(statSync(indexPath(indexer.cacheDir)).mtimeMs, mtimeMs);
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });
});
