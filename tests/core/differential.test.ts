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
        assert.equal(report.declarations, 31);
        assert.equal(report.references, 48);
        assert.deepEqual(report.coveredBy, { edge: 48, exportStatus: 0, recordOnly: 0 });
        assert.equal(report.covered, report.references);
        // Exact, so a reference that moves into a skip reason cannot pass unnoticed.
        assert.deepEqual(report.skipped, {
          definition: 33,
          'declaration name of a related symbol': 6,
        });
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
        // A gap site on that line accounts for the reference, but only as a record, not an edge.
        const writable = new DatabaseSync(indexPath(indexer.cacheDir));
        writable
          .prepare('INSERT INTO gap_sites VALUES (?, ?, ?, ?, ?)')
          .run('packages/api/src/charge.ts', 8, 'test', '', 'packages/api/src/charge.ts#<module>');
        writable.close();
        const recorded = differential(ts, repo, db, { size: 0 });
        assert.deepEqual(recorded.misses, []);
        assert.deepEqual(recorded.coveredBy, { ...report.coveredBy, recordOnly: 1 });
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
        assert.equal(report.docOnly, 2);
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
          'export const first = kindNames[1];',
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
        assert.deepEqual(report.skipped, {
          definition: 43,
          'declaration name of a related symbol': 9,
          'use of the value a shorthand property names': 13,
          'key of an object literal typed by a mapped type (no declaration)': 2,
          // `kindNames[1]`: the `Record` property it reads has no declaration.
          'use of a property of a mapped type (no declaration)': 1,
        });
        assert.deepEqual(report.coveredBy, { edge: 52, exportStatus: 0, recordOnly: 0 });
      } finally {
        db.close();
      }
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });

  it('a member of an anonymous type is skipped by kind; a quoted property name is matched', async () => {
    const repo = await fixtureRepo('differential-kinds');
    try {
      await appendFile(
        join(repo, 'packages/api/src/charge.ts'),
        [
          '',
          'export interface Rate {',
          '  cost: { input: number };',
          '}',
          'export const RATE: Rate = { cost: { input: 1 } };',
          'export function inputOf(rate: Rate): number {',
          '  return rate.cost.input;',
          '}',
          'export interface Glyphs {',
          "  'tab.shell': string;",
          '}',
          "export const ASCII: Glyphs = { 'tab.shell': '>' };",
          "export const FANCY: Glyphs = { 'tab.shell': '»' };",
          "export const shell = ASCII['tab.shell'];",
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
        // `Rate.cost.input` is a member of an anonymous type: not indexed (ADR 0003). The quoted
        // `'tab.shell'` members are indexed: their references are checked, their names skipped.
        assert.deepEqual(report.skipped, {
          definition: 46,
          'declaration name of a related symbol': 14,
          'target is not an indexed declaration: property': 2,
        });
        assert.deepEqual(report.coveredBy, { edge: 58, exportStatus: 0, recordOnly: 0 });
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
      await appendFile(
        join(repo, 'packages/api/src/charge.ts'),
        '\nexport const again = (): number => calculateFee(5);\n',
      );
      await indexer.index({ impact });
      await writeFile(join(repo, 'packages/payments/src/index.ts'), "export * from './fee';\n");
      await indexer.index({ impact });
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
      await appendFile(join(repo, 'packages/api/src/charge.ts'), '\n// changed bytes\n');
      reject = true;
      await assert.rejects(
        doctorDeep(ts, indexer, impact, { differential: 0 }),
        /doctor: active index verification failed/,
      );
    } finally {
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
