import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  SCHEMA_VERSION,
  beginBuild,
  indexPath,
  openPublished,
  publishBuild,
  readFiles,
  readMeta,
  readSchemaVersion,
  stagingPath,
  writeFiles,
  writeMeta,
  type FileRecord,
} from '../../src/storage/sqlite.js';

function fileRecord(path: string, overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    path,
    size: 10,
    mtimeMs: 1_700_000_000_123.5,
    hash: 'ab'.repeat(32),
    kind: 'ts',
    package: 'packages/payments',
    tsconfig: 'packages/payments/tsconfig.json',
    status: 'indexable',
    reason: null,
    ...overrides,
  };
}

function publish(cacheDir: string, paths: string[]): void {
  const db = beginBuild(cacheDir);
  writeMeta(db, { typescript_version: '5.9.3' });
  writeFiles(
    db,
    paths.map((path) => fileRecord(path)),
  );
  publishBuild(db, cacheDir);
}

function publishedPaths(cacheDir: string): string[] {
  const db = openPublished(cacheDir);
  assert.ok(db, 'a published index exists');
  try {
    return readFiles(db).map((file) => file.path);
  } finally {
    db.close();
  }
}

describe('sqlite index store', () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = join(await realpath(await mkdtemp(join(tmpdir(), 'ei-store-'))), 'repo-cache');
  });
  afterEach(async () => {
    await rm(join(cacheDir, '..'), { recursive: true, force: true });
  });

  it('builds in staging and publishes by rename: schema, meta and census read back', () => {
    const db = beginBuild(cacheDir);
    assert.ok(existsSync(stagingPath(cacheDir)));
    assert.equal(openPublished(cacheDir), null, 'nothing is published before publishBuild');
    writeMeta(db, { typescript_version: '5.9.3', config_hash: 'c0ffee' });
    const records = [
      fileRecord('packages/payments/src/fee.ts'),
      fileRecord('README.md', {
        kind: 'other',
        package: null,
        tsconfig: null,
        status: 'unindexed',
        reason: 'other-kind',
      }),
      fileRecord('.env', {
        hash: null,
        kind: 'other',
        package: null,
        tsconfig: null,
        status: 'excluded',
        reason: 'secret',
      }),
    ];
    writeFiles(db, records);
    publishBuild(db, cacheDir);

    assert.equal(existsSync(stagingPath(cacheDir)), false, 'staging is renamed, not copied');
    for (const sidecar of ['-wal', '-shm', '-journal']) {
      assert.equal(existsSync(indexPath(cacheDir) + sidecar), false, `no ${sidecar} left behind`);
    }
    const published = openPublished(cacheDir);
    assert.ok(published);
    try {
      assert.equal(readSchemaVersion(published), SCHEMA_VERSION);
      // Published files use a rollback journal, so readers create no -wal/-shm beside a file that
      // the next publish renames over.
      assert.equal(published.prepare('PRAGMA journal_mode').get()?.journal_mode, 'delete');
      for (const sidecar of ['-wal', '-shm']) {
        assert.equal(existsSync(indexPath(cacheDir) + sidecar), false, `reader made no ${sidecar}`);
      }
      const meta = readMeta(published);
      assert.equal(meta.schema_version, String(SCHEMA_VERSION));
      assert.equal(meta.typescript_version, '5.9.3');
      assert.equal(meta.config_hash, 'c0ffee');
      assert.deepEqual(
        readFiles(published),
        [...records].sort((a, b) => (a.path < b.path ? -1 : 1)),
        'every field round-trips (nulls, fractional mtime), in code-point path order',
      );
      assert.throws(() => writeMeta(published, { x: 'y' }), /readonly|read-only/i);
    } finally {
      published.close();
    }
  });

  it(
    'keeps the cache dir 0700 and the database files 0600',
    { skip: process.platform === 'win32' },
    () => {
      const db = beginBuild(cacheDir);
      assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
      assert.equal(statSync(stagingPath(cacheDir)).mode & 0o777, 0o600);
      writeFiles(db, [fileRecord('a.ts')]);
      assert.equal(statSync(`${stagingPath(cacheDir)}-wal`).mode & 0o777, 0o600, 'WAL file too');
      publishBuild(db, cacheDir);
      assert.equal(statSync(indexPath(cacheDir)).mode & 0o777, 0o600);
    },
  );

  it('a reader of the old index keeps its snapshot while a new index is published', () => {
    publish(cacheDir, ['old.ts']);
    const reader = openPublished(cacheDir);
    assert.ok(reader);
    try {
      publish(cacheDir, ['new-a.ts', 'new-b.ts']);
      assert.deepEqual(
        readFiles(reader).map((file) => file.path),
        ['old.ts'],
      );
      assert.deepEqual(publishedPaths(cacheDir), ['new-a.ts', 'new-b.ts']);
    } finally {
      reader.close();
    }
  });

  it('discards leftovers of an interrupted build and never touches the published index', async () => {
    publish(cacheDir, ['published.ts']);
    // An interrupted build leaves a staging file and its WAL behind.
    await writeFile(stagingPath(cacheDir), 'partial garbage');
    await writeFile(`${stagingPath(cacheDir)}-wal`, 'partial wal');
    assert.deepEqual(publishedPaths(cacheDir), ['published.ts']);

    const db = beginBuild(cacheDir);
    assert.equal(readSchemaVersion(db), SCHEMA_VERSION, 'staging starts fresh and migrated');
    assert.deepEqual(readFiles(db), []);
    writeFiles(db, [fileRecord('rebuilt.ts')]);
    publishBuild(db, cacheDir);
    assert.deepEqual(publishedPaths(cacheDir), ['rebuilt.ts']);
  });
});
