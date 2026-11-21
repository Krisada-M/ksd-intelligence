import assert from 'node:assert/strict';
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { scanLexically } from '../../src/core/indexing/lexical.js';
import { openPublished } from '../../src/storage/sqlite.js';
import { assertIncrementalEqualsCold, fixtureRepo, impactOf } from './index-helpers.js';

const SHARED = 'packages/shared/src/input.ts';
const LOOSE = 'tools/loose.ts';

describe('D55 lexical and contextual name scoping', () => {
  it('recognizes orphan identifiers and decoded literals, but not comments, regex or template text', () => {
    const rows = scanLexically(
      ts,
      LOOSE,
      [
        '// input',
        '/* input */ const value = /input/.test("input");',
        'const a = `input ${input} input`;',
        'const b = "inp\\u0075t";',
        'const c = `input`;',
        'if (true) /input/.test("input");',
      ].join('\n'),
      new Set(['input']),
    );
    assert.deepEqual(
      rows.unresolved.map(({ line }) => line),
      [3],
    );
    assert.deepEqual(rows.tokens, [
      { file: LOOSE, name: 'input', kind: 'str', lines: [2, 4, 5, 6] },
    ]);
  });

  it('does not read excluded or secret files; rescans orphan after name appears and disappears', async () => {
    const repo = await fixtureRepo('r2b-extractor');
    const cache = join(repo, '..', 'cache');
    const cold = join(repo, '..', 'cold');
    const configPath = join(repo, 'tsconfig.json');
    writeFileSync(
      configPath,
      JSON.stringify({ extends: './tsconfig.base.json', include: ['packages/**/*', 'apps/**/*'] }),
    );
    writeFileSync(
      join(repo, 'ei.config.json'),
      JSON.stringify({
        impact: { include: ['packages/**', 'apps/**', 'tools/**'], freshness: 'hash' },
      }),
    );
    mkdirSync(join(repo, 'tools'), { recursive: true });
    writeFileSync(join(repo, LOOSE), 'const x = input; const y = "input";\n');
    writeFileSync(join(repo, 'tools/.env'), 'input=secret\n');
    writeFileSync(join(repo, SHARED), 'export function input() { return 1; }\n');
    writeFileSync(
      join(repo, 'packages/shared/src/typed.ts'),
      [
        'type Shape = { kind: "input" } | { kind: "output" };',
        'const shape: Shape = { kind: "input" };',
        'const literal: "input" = "input";',
        'const finite: "input" | "output" = "input";',
        'const broad: string | undefined = "input";',
        'const unknownValue: unknown = "input";',
        'const anyValue: any = "input";',
        'const untyped = "input";',
        'void [shape, literal, finite, broad, unknownValue, anyValue, untyped];',
      ].join('\n'),
    );
    writeFileSync(
      join(repo, 'packages/shared/src/import-sites.ts'),
      ['import "./input"; import("./typed");', 'import("./input");'].join('\n'),
    );
    try {
      const indexer = new Indexer(ts, repo, cache);
      const built = await indexer.index({ impact: impactOf(repo) });
      assert.deepEqual(built.problems, []);
      let db = openPublished(cache);
      assert.ok(db);
      assert.deepEqual(
        db
          .prepare('SELECT line FROM unresolved WHERE file = ? AND name = ?')
          .all(LOOSE, 'input')
          .map((r) => r.line),
        [1],
      );
      const typed = db
        .prepare("SELECT lines FROM name_tokens WHERE file = ? AND name = 'input'")
        .get('packages/shared/src/typed.ts');
      assert.deepEqual(JSON.parse(String(typed?.lines)), [5, 6, 7, 8]);
      assert.deepEqual(
        db
          .prepare("SELECT line, kind FROM markers WHERE file = ? AND kind LIKE 'static-import:%'")
          .all('packages/shared/src/import-sites.ts')
          .map((row) => ({ line: row.line, kind: row.kind })),
        [{ line: 1, kind: `static-import:${SHARED}` }],
      );
      db.close();
      assert.equal((await indexer.index({ impact: impactOf(repo) })).action, 'unchanged');
      const orphanPath = join(repo, LOOSE);
      const mtime = statSync(orphanPath).mtime;
      utimesSync(orphanPath, mtime, new Date(mtime.getTime() + 2_000));
      await assertIncrementalEqualsCold(indexer, cold, 'orphan touch');
      writeFileSync(join(repo, LOOSE), 'const x = 0;\n');
      await assertIncrementalEqualsCold(indexer, cold, 'orphan edit');
      writeFileSync(join(repo, LOOSE), 'const x = input;\n');
      await assertIncrementalEqualsCold(indexer, cold, 'orphan restored');
      writeFileSync(join(repo, SHARED), 'export function different() { return 1; }\n');
      await assertIncrementalEqualsCold(indexer, cold, 'name disappeared');
      db = openPublished(cache);
      assert.ok(db);
      assert.deepEqual(db.prepare('SELECT name FROM unresolved WHERE file = ?').all(LOOSE), []);
      db.close();
      writeFileSync(join(repo, SHARED), 'export function input() { return 1; }\n');
      await assertIncrementalEqualsCold(indexer, cold, 'name reappeared');
      rmSync(join(repo, LOOSE));
      await assertIncrementalEqualsCold(indexer, cold, 'orphan removed');
      writeFileSync(join(repo, LOOSE), 'const fromAdded = "input";\n');
      await assertIncrementalEqualsCold(indexer, cold, 'orphan added');
    } finally {
      rmSync(join(repo, '..'), { recursive: true, force: true });
    }
  });
});
