import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { openPublished, readMeta } from '../../src/storage/sqlite.js';
import { assertIncrementalEqualsCold, fixtureRepo, impactOf } from './index-helpers.js';

describe('M2b index-only factor evidence (fixture copy)', () => {
  let repo: string;
  let indexer: Indexer;
  const boundary = 'packages/api/src/boundary.ts';

  before(async () => {
    repo = await fixtureRepo('index-additions');
    await writeFile(
      join(repo, boundary),
      `import { NativeModules as Native } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import { View } from 'react-native';
import { Client } from 'pg';
declare function sql(strings: TemplateStringsArray): unknown;
declare const db: { sql(strings: TemplateStringsArray): unknown };
export function sqlRead() { return sql\`SELECT 1\`; }
export function qualifiedSqlRead() { return db.sql\`SELECT 2\`; }
export function nativeRead() { return [Native.Example, TurboModuleRegistry.get('Example')]; }
export function ordinary() { return View; }
`,
    );
    indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
    const report = await indexer.index({ impact: impactOf(repo), full: true });
    assert.deepEqual(report.problems, []);
  });
  after(async () => {
    await rm(join(repo, '..'), { recursive: true, force: true });
  });

  it('the published index distinguishes private packages and the public barrel entry', () => {
    const db = openPublished(indexer.cacheDir);
    assert.ok(db);
    try {
      const packages: unknown = JSON.parse(readMeta(db).packages ?? 'null');
      assert.deepEqual(packages, [
        { dir: 'apps/web', name: '@fx/web', private: true, entries: [], unresolved: [] },
        { dir: 'packages/api', name: '@fx/api', private: true, entries: [], unresolved: [] },
        {
          dir: 'packages/payments',
          name: '@fx/payments',
          private: false,
          entries: ['packages/payments/src/index.ts'],
          unresolved: [],
        },
        { dir: 'packages/shared', name: '@fx/shared', private: true, entries: [], unresolved: [] },
      ]);
    } finally {
      db.close();
    }
  });

  it('tagged SQL and native bindings are retained even when dependencies are not installed', () => {
    const db = openPublished(indexer.cacheDir);
    assert.ok(db);
    try {
      assert.deepEqual(
        db
          .prepare('SELECT line, kind FROM markers WHERE file = ? ORDER BY line')
          .all(boundary)
          .map((r) => `${r.line} ${r.kind}`),
        ['1 boundary:native', '2 boundary:native', '7 boundary:sql', '8 boundary:sql'],
      );
      assert.deepEqual(
        db
          .prepare('SELECT specifier FROM external_imports WHERE file = ? ORDER BY line')
          .all(boundary)
          .map((r) => r.specifier),
        ['react-native', 'react-native', 'react-native', 'pg'],
      );
    } finally {
      db.close();
    }
  });

  it('removing boundary syntax removes its markers; incremental equals cold', async () => {
    const file = join(repo, boundary);
    await writeFile(file, 'export function ordinary() { return 1; }\n');
    await assertIncrementalEqualsCold(
      indexer,
      join(repo, '..', 'cold-markers'),
      'removed boundaries',
    );
    const db = openPublished(indexer.cacheDir);
    assert.ok(db);
    try {
      assert.deepEqual(db.prepare('SELECT * FROM markers WHERE file = ?').all(boundary), []);
    } finally {
      db.close();
    }
  });

  it('entry conditions are retained and missing output is not guessed back to source', async () => {
    await writeFile(
      join(repo, 'packages/shared/package.json'),
      JSON.stringify({
        name: '@fx/shared',
        exports: {
          '.': { import: './src/money.ts', types: './dist/money.d.ts' },
          './all/*': './dist/*.js',
        },
      }),
    );
    await assertIncrementalEqualsCold(
      indexer,
      join(repo, '..', 'cold-package'),
      'package entry changed',
    );
    const db = openPublished(indexer.cacheDir);
    assert.ok(db);
    try {
      const packages: { dir: string; private: boolean; entries: string[]; unresolved: string[] }[] =
        JSON.parse(readMeta(db).packages ?? '[]');
      assert.deepEqual(
        packages.find((p) => p.dir === 'packages/shared'),
        {
          dir: 'packages/shared',
          name: '@fx/shared',
          private: false,
          entries: ['packages/shared/src/money.ts'],
          unresolved: ['./dist/*.js', './dist/money.d.ts'],
        },
      );
    } finally {
      db.close();
    }
  });
});
