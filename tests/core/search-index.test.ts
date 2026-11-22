import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import ts from 'typescript';
import { doctorDeep } from '../../src/core/indexing/doctor.js';
import { fileDeclarations, signatureText } from '../../src/core/indexing/declarations.js';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { extractorStamp } from '../../src/core/indexing/stamp.js';
import { verifyIndex } from '../../src/core/indexing/verify.js';
import {
  MAX_SEARCH_FIELD_CHARS,
  capSearchText,
  extractFirstDocParagraph,
  extractSearchRows,
  extractSearchSignature,
  ownerAndNameTokens,
  pathTokens,
  splitIdentifier,
  tokenizeForQuery,
} from '../../src/core/search/segments.js';
import { emptyCounts } from '../../src/storage/records.js';
import {
  SCHEMA_VERSION,
  beginBuild,
  indexPath,
  openPublished,
  publishBuild,
  readSchemaVersion,
  writeMeta,
} from '../../src/storage/sqlite.js';
import { assertIncrementalEqualsCold, fixtureRepo, impactOf } from './index-helpers.js';

describe('M6a Round 1 — FTS5 search index', () => {
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

  it('splits identifiers and paths across camelCase, PascalCase, snake_case, kebab, acronyms, digits, $/_, and non-ASCII', () => {
    assert.equal(splitIdentifier('retryWebhook'), 'retry webhook');
    assert.equal(splitIdentifier('HTTP_TIMEOUT_MS'), 'http timeout ms');
    assert.equal(splitIdentifier('parseURL2'), 'parse url 2');
    assert.equal(splitIdentifier('XMLHttpRequest'), 'xml http request');
    assert.equal(splitIdentifier('PascalCaseType'), 'pascal case type');
    assert.equal(splitIdentifier('snake_case_name'), 'snake case name');
    assert.equal(
      pathTokens('packages/payments/src/checkout-flow.ts'),
      'packages payments src checkout flow ts',
    );
    assert.equal(splitIdentifier('_internalFn'), 'internal fn');
    assert.equal(splitIdentifier('$stream'), 'stream');
    assert.equal(splitIdentifier('__dirname'), 'dirname');
    assert.equal(splitIdentifier('foo$_bar'), 'foo bar');
    assert.equal(splitIdentifier('v2Api'), 'v 2 api');
    assert.equal(splitIdentifier('base64Encode'), 'base 64 encode');
    assert.equal(splitIdentifier('sha256Hex'), 'sha 256 hex');
    assert.equal(splitIdentifier('caféPrice'), 'café price');
    assert.equal(splitIdentifier('naïveParser'), 'naïve parser');
    assert.equal(splitIdentifier('คำนวณFee'), 'คำนวณ fee');
    assert.deepEqual(tokenizeForQuery('XMLHttpRequest:v2!'), ['xml', 'http', 'request', 'v', '2']);
    assert.deepEqual(tokenizeForQuery('___'), []);

    assert.deepEqual(ownerAndNameTokens('calculateFee', 'calculateFee'), {
      nameTokens: 'calculateFee calculate fee',
      ownerTokens: '',
    });
    assert.deepEqual(ownerAndNameTokens('PaymentService.static:create', 'create'), {
      nameTokens: 'create',
      ownerTokens: 'PaymentService payment service',
    });
  });

  it('extracts 400-char capped signatures, surrogate-safe caps, and first-paragraph JSDoc only (never // or /* */)', () => {
    const longParams = Array.from({ length: 40 }, (_, i) => `paramNumber${i}: string`).join(', ');
    const longDoc = `${'A'.repeat(450)}\n\nSecond paragraph should be ignored.`;
    const code = [
      '/** @license MIT */',
      '',
      '// Regular line comment ignored',
      'export function noDocWithLineComment(a: number): number { return a + 1; }',
      '',
      '/* Regular block comment ignored */',
      'export function noDocWithBlockComment(a: number): number { return a + 2; }',
      '',
      `/**\n * First paragraph line one\n * line two.\n *\n * Second paragraph ignored.\n * @param x ignored param tag\n * @returns ignored return tag\n */`,
      'export function documentedFn(x: number): number { return x; }',
      '',
      '/** Arrow function JSDoc inherited from VariableStatement. */',
      'export const arrowHandler = (input: string): string => input.trim();',
      '',
      '/** Overload JSDoc on first signature. */',
      'export function overloaded(x: string): string;',
      'export function overloaded(x: number): number;',
      'export function overloaded(x: string | number): string | number { return x; }',
      '',
      `export function longSignature(${longParams}): void {}`,
      '',
      `/** ${longDoc} */`,
      'export function longDocFn(): void {}',
      '',
      'export class PaymentService {',
      '  charge(amount: number): boolean { return amount > 0; }',
      '}',
    ].join('\n');

    const sf = ts.createSourceFile('src/sample.ts', code, ts.ScriptTarget.Latest, true);
    const decls = fileDeclarations(ts, sf, 'src/sample.ts');
    const rows = extractSearchRows(ts, 'src/sample.ts', decls.declarations, decls.nodesOf, (node) =>
      signatureText(ts, sf, node),
    );
    const byKey = new Map(rows.map((row) => [row.key, row]));

    // <module> pseudo-declaration must never appear in search rows.
    assert.equal(byKey.has('src/sample.ts#<module>'), false);

    assert.equal(byKey.get('src/sample.ts#noDocWithLineComment')?.doc, '');
    assert.equal(byKey.get('src/sample.ts#noDocWithBlockComment')?.doc, '');
    assert.equal(
      byKey.get('src/sample.ts#documentedFn')?.doc,
      'First paragraph line one line two.',
    );
    assert.equal(
      byKey.get('src/sample.ts#arrowHandler')?.doc,
      'Arrow function JSDoc inherited from VariableStatement.',
    );
    assert.equal(byKey.get('src/sample.ts#overloaded')?.doc, 'Overload JSDoc on first signature.');
    assert.equal(
      byKey.get('src/sample.ts#PaymentService')?.signature,
      'export class PaymentService',
    );
    assert.equal(
      byKey.get('src/sample.ts#PaymentService.charge')?.ownerTokens,
      'PaymentService payment service',
    );

    const longSigRow = byKey.get('src/sample.ts#longSignature');
    assert.ok(longSigRow !== undefined);
    assert.ok(longSigRow.signature.length <= MAX_SEARCH_FIELD_CHARS);
    assert.equal(longSigRow.signature.length, MAX_SEARCH_FIELD_CHARS);

    const longDocRow = byKey.get('src/sample.ts#longDocFn');
    assert.ok(longDocRow !== undefined);
    assert.equal(longDocRow.doc.length, MAX_SEARCH_FIELD_CHARS);

    // Surrogate-pair boundary: 399 ASCII chars + 1 emoji (2 UTF-16 code units) must not leave a lone high surrogate.
    const withSurrogate = `${'x'.repeat(399)}🚀tail`;
    const capped = capSearchText(withSurrogate, 400);
    assert.equal(capped.length, 399);
    assert.equal(extractFirstDocParagraph(ts, []), '');
    assert.equal(
      extractSearchSignature([], () => ''),
      '',
    );
  });

  it('indexes D49 secret-named code files while excluding .env, .pem, .key, non-code secrets, and excluded dirs', async () => {
    const repo = await fixtureRepo('m6a-d49');
    tempDirs.push(join(repo, '..'));
    const cacheDir = await makeTempDir('ei-m6a-d49-cache-');

    await mkdir(join(repo, 'packages/api/src/secrets'), { recursive: true });
    await mkdir(join(repo, 'certs'), { recursive: true });
    await mkdir(join(repo, 'node_modules/fake-pkg'), { recursive: true });
    await mkdir(join(repo, 'dist'), { recursive: true });

    await writeFile(
      join(repo, 'packages/api/src/secrets/vault.ts'),
      '/** Rotates the vault key. */\nexport function rotateSecretKey(): string { return "ok"; }\n',
    );
    await writeFile(
      join(repo, 'packages/api/src/credentials-store.ts'),
      'export class CredentialManager { verifyToken(): boolean { return true; } }\n',
    );
    await writeFile(join(repo, '.env'), 'SUPER_SECRET_ENV_VALUE=hunter2\n');
    await writeFile(join(repo, '.env.local'), 'LOCAL_SECRET_TOKEN=xyz\n');
    await writeFile(join(repo, 'certs/server.pem'), 'PEM_SECRET_MATERIAL\n');
    await writeFile(join(repo, 'certs/private.key'), 'PRIVATE_KEY_MATERIAL\n');
    await writeFile(
      join(repo, 'packages/api/src/secrets/config.json'),
      '{"jsonSecretField": "should-never-index"}\n',
    );
    await writeFile(
      join(repo, 'node_modules/fake-pkg/index.ts'),
      'export function nodeModulesHiddenFn(): void {}\n',
    );
    await writeFile(join(repo, 'dist/bundle.js'), 'export function distHiddenFn() {}\n');

    const report = await new Indexer(ts, repo, cacheDir).index({ impact: impactOf(repo) });
    assert.notEqual(report.action, 'failed');
    assert.deepEqual(report.problems, []);

    const db = openPublished(cacheDir);
    assert.ok(db);
    try {
      const rotateHits = db
        .prepare(
          'SELECT stable_key FROM declarations_fts WHERE declarations_fts MATCH \'"rotate"\'',
        )
        .all();
      assert.deepEqual(
        rotateHits.map((r) => String(r.stable_key)),
        ['packages/api/src/secrets/vault.ts#rotateSecretKey'],
      );

      const credHits = db
        .prepare(
          'SELECT stable_key FROM declarations_fts WHERE declarations_fts MATCH \'"credential"\'',
        )
        .all();
      assert.deepEqual(credHits.map((r) => String(r.stable_key)).sort(), [
        'packages/api/src/credentials-store.ts#CredentialManager',
        'packages/api/src/credentials-store.ts#CredentialManager.verifyToken',
      ]);

      // Excluded / secret non-code files must contribute zero FTS5 rows.
      for (const secretTerm of [
        'hunter2',
        'SUPER_SECRET_ENV_VALUE',
        'LOCAL_SECRET_TOKEN',
        'PEM_SECRET_MATERIAL',
        'PRIVATE_KEY_MATERIAL',
        'jsonSecretField',
        'nodeModulesHiddenFn',
        'distHiddenFn',
      ]) {
        const matches: unknown[] = db
          .prepare('SELECT stable_key FROM declarations_fts WHERE declarations_fts MATCH ?')
          .all(`"${secretTerm}"`);
        assert.equal(matches.length, 0, `expected 0 FTS5 hits for ${secretTerm}`);
      }
    } finally {
      db.close();
    }
  });

  it('maintains incremental == cold and doctorDeep parity across doc-comment edit, rename, and delete', async () => {
    const repo = await fixtureRepo('m6a-inc');
    tempDirs.push(join(repo, '..'));
    const cacheDir = await makeTempDir('ei-m6a-inc-cache-');
    const coldDir = await makeTempDir('ei-m6a-cold-cache-');

    const indexer = new Indexer(ts, repo, cacheDir);
    await assertIncrementalEqualsCold(indexer, join(coldDir, 'initial'), 'initial');

    // 1. Doc-comment edit only (signature unchanged).
    const feePath = join(repo, 'packages/payments/src/fee.ts');
    const originalFee = await readFile(feePath, 'utf8');
    const updatedFee = originalFee.replace(
      'export function calculateFee(amount: number): number;',
      '/** Calculates settlement fee with updated JSDoc rule. */\nexport function calculateFee(amount: number): number;',
    );
    assert.notEqual(updatedFee, originalFee);
    await writeFile(feePath, updatedFee);
    await assertIncrementalEqualsCold(indexer, join(coldDir, 'doc-edit'), 'doc-edit');

    const afterDocDb = openPublished(cacheDir);
    assert.ok(afterDocDb);
    try {
      const hit = afterDocDb
        .prepare('SELECT doc FROM declarations_fts WHERE declarations_fts MATCH \'"settlement"\'')
        .get();
      assert.equal(String(hit?.doc), 'Calculates settlement fee with updated JSDoc rule.');
    } finally {
      afterDocDb.close();
    }

    // 2. Rename a file.
    const oldSub = join(repo, 'packages/payments/src/manual.ts');
    const newSub = join(repo, 'packages/payments/src/manual-v2.ts');
    await rename(oldSub, newSub);
    await assertIncrementalEqualsCold(indexer, join(coldDir, 'rename'), 'rename');

    const afterRenameDb = openPublished(cacheDir);
    assert.ok(afterRenameDb);
    try {
      const oldRows = afterRenameDb
        .prepare(
          "SELECT stable_key FROM declarations_fts WHERE stable_key LIKE 'packages/payments/src/manual.ts#%'",
        )
        .all();
      assert.deepEqual(oldRows, []);
      const newRows = afterRenameDb
        .prepare(
          "SELECT stable_key FROM declarations_fts WHERE stable_key LIKE 'packages/payments/src/manual-v2.ts#%'",
        )
        .all();
      assert.ok(newRows.length > 0);
    } finally {
      afterRenameDb.close();
    }

    // 3. Delete a file.
    await rm(newSub);
    await assertIncrementalEqualsCold(indexer, join(coldDir, 'delete'), 'delete');

    const doctor = await doctorDeep(ts, indexer, impactOf(repo), { differential: 0 });
    assert.equal(doctor.differences.count, 0);
    assert.deepEqual(doctor.differences.onlyActive, []);
    assert.deepEqual(doctor.differences.onlyCold, []);
  });

  it('contributes zero FTS5 rows on parse-error and lexical orphan files without breaking the build', async () => {
    const repo = await fixtureRepo('m6a-parse');
    tempDirs.push(join(repo, '..'));
    const cacheDir = await makeTempDir('ei-m6a-parse-cache-');

    await writeFile(
      join(repo, 'packages/payments/src/broken.ts'),
      'export function brokenSyntax( {\n  return 1;\n',
    );
    await writeFile(join(repo, 'orphan-script.ts'), 'export function orphanLexicalFn(): void {}\n');

    const report = await new Indexer(ts, repo, cacheDir).index({ impact: impactOf(repo) });
    assert.notEqual(report.action, 'failed');
    assert.deepEqual(report.problems, []);

    const db = openPublished(cacheDir);
    assert.ok(db);
    try {
      const fileIndex = db
        .prepare('SELECT extraction FROM file_index WHERE file = ?')
        .get('packages/payments/src/broken.ts');
      assert.equal(String(fileIndex?.extraction), 'parse-error');

      const orphanIndex = db
        .prepare('SELECT extraction FROM file_index WHERE file = ?')
        .get('orphan-script.ts');
      assert.equal(String(orphanIndex?.extraction), 'lexical');

      const brokenSearchRows = db
        .prepare(
          "SELECT stable_key FROM declarations_fts WHERE stable_key LIKE 'packages/payments/src/broken.ts#%'",
        )
        .all();
      assert.deepEqual(brokenSearchRows, []);

      const orphanSearchRows = db
        .prepare(
          'SELECT stable_key FROM declarations_fts WHERE declarations_fts MATCH \'"orphan"\'',
        )
        .all();
      assert.deepEqual(orphanSearchRows, []);

      // Clean files remain searchable.
      const cleanRows = db
        .prepare(
          'SELECT stable_key FROM declarations_fts WHERE declarations_fts MATCH \'"calculate"\'',
        )
        .all();
      assert.ok(cleanRows.length > 0);
    } finally {
      db.close();
    }
  });

  it('auto-rebuilds schema v4 and v5 databases to schema v6 with declarations_fts and NOCASE indexes', async () => {
    const repo = await fixtureRepo('m6a-v4');
    tempDirs.push(join(repo, '..'));
    const cacheDir = await makeTempDir('ei-m6a-v4-cache-');

    // Simulate a legacy schema v4 published index lacking declarations_fts and v6 indexes.
    const legacy4 = beginBuild(cacheDir);
    legacy4.exec(
      'DROP TABLE declarations_fts; DROP INDEX declarations_simple_nocase; DROP INDEX declarations_name_nocase;',
    );
    writeMeta(legacy4, { schema_version: '4', typescript_version: ts.version });
    publishBuild(legacy4, cacheDir);

    const before4 = openPublished(cacheDir);
    assert.ok(before4);
    assert.equal(readSchemaVersion(before4), 4);
    before4.close();

    const report4 = await new Indexer(ts, repo, cacheDir).index({ impact: impactOf(repo) });
    assert.equal(report4.action, 'cold');
    assert.equal(report4.reason, 'index schema 4');
    assert.deepEqual(report4.problems, []);
    assert.ok(report4.counts.declarations_fts > 0);

    const after4 = openPublished(cacheDir);
    assert.ok(after4);
    try {
      assert.equal(readSchemaVersion(after4), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 6);
      const count = Number(after4.prepare('SELECT COUNT(*) AS n FROM declarations_fts').get()?.n);
      assert.equal(count, report4.counts.declarations_fts);
      const indexes = after4
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'declarations'",
        )
        .all()
        .map((r) => String(r.name));
      assert.ok(indexes.includes('declarations_simple_nocase'));
      assert.ok(indexes.includes('declarations_name_nocase'));
    } finally {
      after4.close();
    }

    // Simulate a legacy schema v5 published index lacking v6 NOCASE partial indexes.
    const cacheDir5 = await makeTempDir('ei-m6a-v5-cache-');
    const legacy5 = beginBuild(cacheDir5);
    legacy5.exec('DROP INDEX declarations_simple_nocase; DROP INDEX declarations_name_nocase;');
    writeMeta(legacy5, { schema_version: '5', typescript_version: ts.version });
    publishBuild(legacy5, cacheDir5);

    const before5 = openPublished(cacheDir5);
    assert.ok(before5);
    assert.equal(readSchemaVersion(before5), 5);
    before5.close();

    const report5 = await new Indexer(ts, repo, cacheDir5).index({ impact: impactOf(repo) });
    assert.equal(report5.action, 'cold');
    assert.equal(report5.reason, 'index schema 5');
    assert.deepEqual(report5.problems, []);
    assert.ok(report5.counts.declarations_fts > 0);

    const after5 = openPublished(cacheDir5);
    assert.ok(after5);
    try {
      assert.equal(readSchemaVersion(after5), 6);
      const indexes = after5
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'declarations'",
        )
        .all()
        .map((r) => String(r.name));
      assert.ok(indexes.includes('declarations_simple_nocase'));
      assert.ok(indexes.includes('declarations_name_nocase'));
    } finally {
      after5.close();
    }
  });

  it('includes src/core/search/segments.js in extractorStamp and enforces verifyIndex FTS5 invariants', async () => {
    const baseStamp = extractorStamp('5.9.3', 'cfg');
    assert.match(baseStamp, /^[0-9a-f]{16}$/);

    // Copy compiled core/indexing + core/search + core/workspace into a temp dir and mutate segments.js.
    const tempDist = await makeTempDir('ei-stamp-check-');
    const coreDir = join(tempDist, 'core');
    await mkdir(coreDir, { recursive: true });
    cpSync(new URL('../../src/core/indexing', import.meta.url), join(coreDir, 'indexing'), {
      recursive: true,
    });
    cpSync(new URL('../../src/core/search', import.meta.url), join(coreDir, 'search'), {
      recursive: true,
    });
    cpSync(new URL('../../src/core/workspace', import.meta.url), join(coreDir, 'workspace'), {
      recursive: true,
    });
    const stampUrl = new URL(`file://${join(coreDir, 'indexing/stamp.js')}`).href;
    const beforeOut = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { extractorStamp } from ${JSON.stringify(stampUrl)}; console.log(extractorStamp('5.9.3', 'cfg'));`,
      ],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(beforeOut, baseStamp);

    const segPath = join(coreDir, 'search/segments.js');
    await writeFile(segPath, `${await readFile(segPath, 'utf8')}\n// stamp-bump\n`);
    const afterOut = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { extractorStamp } from ${JSON.stringify(stampUrl)}; console.log(extractorStamp('5.9.3', 'cfg'));`,
      ],
      { encoding: 'utf8' },
    ).trim();
    assert.notEqual(afterOut, beforeOut);

    // Direct verifyIndex check for orphan FTS5 row detection.
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, size INTEGER, mtime_ms REAL, hash TEXT, kind TEXT, package TEXT, tsconfig TEXT, status TEXT, reason TEXT);
      CREATE TABLE file_index (file TEXT PRIMARY KEY, extraction TEXT, lines INTEGER, surface TEXT, global INTEGER, indexed_uses INTEGER, local_uses INTEGER, external INTEGER, external_unresolved INTEGER, unresolved_other INTEGER, outside_scope INTEGER);
      CREATE TABLE symbols (id INTEGER PRIMARY KEY, key TEXT UNIQUE);
      CREATE TABLE declarations (id INTEGER PRIMARY KEY, file TEXT, name TEXT, simple TEXT, kind TEXT, exported INTEGER, start_line INTEGER, end_line INTEGER, other_spans TEXT, sig_hash TEXT);
      CREATE TABLE edges (source INTEGER, target INTEGER, kind TEXT, strength TEXT, lines TEXT);
      CREATE TABLE unresolved (file TEXT, line INTEGER, name TEXT, reason TEXT, source TEXT);
      CREATE TABLE gap_sites (file TEXT, line INTEGER, code TEXT, detail TEXT, source TEXT);
      CREATE TABLE name_tokens (file TEXT, name TEXT, kind TEXT, lines TEXT);
      CREATE TABLE external_imports (file TEXT, specifier TEXT, line INTEGER);
      CREATE TABLE exports (file TEXT, name TEXT, target TEXT);
      CREATE TABLE markers (file TEXT, line INTEGER, kind TEXT);
      CREATE VIRTUAL TABLE declarations_fts USING fts5(stable_key UNINDEXED, name_tokens, owner_tokens, kind, signature, doc, path_tokens, tokenize = 'unicode61');
      INSERT INTO declarations_fts (rowid, stable_key, name_tokens, owner_tokens, kind, signature, doc, path_tokens)
      VALUES (999, 'a.ts#ghost', 'ghost', '', 'function', 'function ghost()', '', 'a ts');
    `);
    const expected = emptyCounts();
    expected.declarations_fts = 1;
    const problems = verifyIndex(db, expected);
    assert.ok(problems.some((p) => p.startsWith('search rows without a matching declaration: 1')));
    db.close();
  });

  it(
    'keeps cache dir 0700 and published index.sqlite 0600 after FTS5 build',
    { skip: process.platform === 'win32' },
    async () => {
      const repo = await fixtureRepo('m6a-perms');
      tempDirs.push(join(repo, '..'));
      const cacheDir = join(await makeTempDir('ei-m6a-perms-'), 'cache');

      const report = await new Indexer(ts, repo, cacheDir).index({ impact: impactOf(repo) });
      assert.deepEqual(report.problems, []);
      assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
      assert.equal(statSync(indexPath(cacheDir)).mode & 0o777, 0o600);
    },
  );
});
