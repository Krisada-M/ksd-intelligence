import assert from 'node:assert/strict';
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { differential } from '../../src/core/indexing/differential.js';
import { doctorDeep } from '../../src/core/indexing/doctor.js';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { Graph } from '../../src/core/graph/graph.js';
import { FAILURE_FILE, indexPath, openPublished } from '../../src/storage/sqlite.js';
import { existsSync } from 'node:fs';
import { fixtureRepo, impactOf } from './index-helpers.js';

describe('differential test against TypeScript find-references (D36)', () => {
  it('every reference in scope to every fixture declaration is in the index', async () => {
    const repo = await fixtureRepo('differential');
    try {
      const indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
      await indexer.index({ impact: impactOf(repo) });
      const db = openPublished(indexer.cacheDir);
      assert.ok(db);
      try {
        const report = differential(ts, repo, db, { size: 0 });
        assert.deepEqual(report.misses, []);
        assert.ok(report.declarations >= 30, `sampled ${report.declarations} declarations`);
        assert.ok(report.covered >= 25, `checked ${report.covered} references`);
        assert.equal(report.covered, report.references);
      } finally {
        db.close();
      }
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });

  it('a reference the index does not hold is reported with file:line', async () => {
    const repo = await fixtureRepo('differential-miss');
    try {
      const indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
      await indexer.index({ impact: impactOf(repo) });
      // A new caller written after the index was built: TypeScript sees it, the index does not.
      await appendFile(
        join(repo, 'packages/api/src/charge.ts'),
        '\nexport const later = (): number => calculateFee(4);\n',
      );
      const db = openPublished(indexer.cacheDir);
      assert.ok(db);
      try {
        const report = differential(ts, repo, db, { size: 0 });
        assert.deepEqual(
          report.misses.map((miss) => `${miss.file}:${miss.line} ${miss.declaration}`),
          ['packages/api/src/charge.ts:8 packages/payments/src/fee.ts#calculateFee'],
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });

  it('references inside JSDoc comments are documentation: counted as docOnly, not misses', async () => {
    const repo = await fixtureRepo('differential-doc');
    try {
      await appendFile(
        join(repo, 'packages/api/src/charge.ts'),
        '\n/** See {@link calculateFee} and {@link chargeHandler}. */\nexport const documented = 1;\n',
      );
      const indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
      await indexer.index({ impact: impactOf(repo) });
      const db = openPublished(indexer.cacheDir);
      assert.ok(db);
      try {
        const report = differential(ts, repo, db, { size: 0 });
        assert.deepEqual(report.misses, []);
        assert.ok(report.docOnly >= 2, `doc-only references: ${report.docOnly}`);
        assert.equal(report.covered, report.references, 'no doc reference counts as checked');
      } finally {
        db.close();
      }
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });

  it('uses of the value a shorthand property names are not references of the property; T["k"] is covered', async () => {
    const repo = await fixtureRepo('differential-shorthand');
    try {
      await appendFile(
        join(repo, 'packages/api/src/charge.ts'),
        [
          '',
          'export const table = { calculateFee };',
          'export interface Shape {',
          '  size: number;',
          '}',
          'export type Size = Shape["size"];',
          'export const kindNames: Record<1 | 2, string> = { 1: "a", 2: "b" };',
          'export function kindIcons(): Record<1 | 2, string> {',
          '  return { 1: "x", 2: "y" };',
          '}',
          '',
        ].join('\n'),
      );
      const indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
      await indexer.index({ impact: impactOf(repo) });
      const db = openPublished(indexer.cacheDir);
      assert.ok(db);
      try {
        const report = differential(ts, repo, db, { size: 0 });
        assert.deepEqual(report.misses, []);
        assert.ok(
          (report.skipped['use of the value a shorthand property names'] ?? 0) >= 1,
          JSON.stringify(report.skipped),
        );
        assert.ok(
          (report.skipped['key of an object literal typed by a mapped type (no declaration)'] ??
            0) >= 1,
          JSON.stringify(report.skipped),
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });
});

describe('ei doctor --deep', () => {
  it('after a sequence of edits the updated index equals a cold rebuild; differential is clean', async () => {
    const repo = await fixtureRepo('doctor');
    try {
      const indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
      const impact = impactOf(repo);
      await indexer.index({ impact });
      await indexer.settle();
      await appendFile(
        join(repo, 'packages/api/src/charge.ts'),
        '\nexport const again = (): number => calculateFee(5);\n',
      );
      await indexer.index({ impact });
      await writeFile(join(repo, 'packages/payments/src/index.ts'), "export * from './fee';\n");
      await indexer.index({ impact });
      await indexer.settle();
      const report = await doctorDeep(ts, indexer, impact, { differential: -1 });
      assert.deepEqual(report.differences, { count: 0, onlyActive: [], onlyCold: [] });
      assert.deepEqual(report.differential?.misses, []);
      assert.equal(report.update.action, 'unchanged');
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });

  it('refuses a clean doctor result when the active update fails verification', async () => {
    const repo = await fixtureRepo('doctor-failed-update');
    let reject = false;
    const indexer = new Indexer(ts, repo, join(repo, '..', 'cache'), {
      verify: () => (reject ? ['injected verification failure'] : []),
    });
    try {
      const impact = impactOf(repo);
      await indexer.index({ impact });
      await indexer.settle();
      await appendFile(join(repo, 'packages/api/src/charge.ts'), '\n// changed bytes\n');
      reject = true;
      await assert.rejects(
        doctorDeep(ts, indexer, impact, { differential: 0 }),
        /doctor: active index verification failed/,
      );
    } finally {
      await indexer.release();
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });
});

describe('per-file use counters are statistics (ADR 0003)', () => {
  it('corrupting every counter changes no query result, status state or doctor verdict', async () => {
    const repo = await fixtureRepo('counters-inert');
    const cacheDir = join(repo, '..', 'cache');
    try {
      const indexer = new Indexer(ts, repo, cacheDir);
      const impact = impactOf(repo);
      await indexer.index({ impact });
      await indexer.release();
      const answers = (): string => {
        const graph = Graph.open(cacheDir);
        assert.ok(graph);
        try {
          const keys = [
            'packages/payments/src/fee.ts#calculateFee',
            'packages/shared/src/money.ts#roundMoney',
          ];
          return JSON.stringify(keys.map((key) => [graph.incoming(key, 3), graph.symbol(key)]));
        } finally {
          graph.close();
        }
      };
      const before = answers();

      const raw = new DatabaseSync(indexPath(cacheDir));
      raw.exec(
        `UPDATE file_index SET indexed_uses = 987654, local_uses = 987654, external = 987654,
           external_unresolved = 987654, unresolved_other = 987654, outside_scope = 987654`,
      );
      raw.close();

      assert.equal(answers(), before, 'incoming(), symbol() read the edges table only');
      const report = await doctorDeep(ts, indexer, impact, { differential: -1 });
      assert.equal(report.differences.count, 0, 'graph equality still strict and passing');
      assert.ok(report.counterDifferences.count > 0, 'the counters are listed as information');
      assert.deepEqual(report.differential?.misses, []);
      assert.equal(existsSync(join(cacheDir, FAILURE_FILE)), false, 'doctor does not fail on them');
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });
});
