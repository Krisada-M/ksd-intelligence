import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export const INDEX_FILE = 'index.sqlite';
export const STAGING_FILE = 'index.staging.sqlite';

// Numbered migrations; a database at version n gets every migration with version > n, in order.
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE files (
        path     TEXT PRIMARY KEY,
        size     INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        hash     TEXT,
        kind     TEXT NOT NULL,
        package  TEXT,
        tsconfig TEXT,
        status   TEXT NOT NULL,
        reason   TEXT
      ) STRICT;`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** One census row. `hash` is null for files whose content is never read (excluded paths). */
export interface FileRecord {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string | null;
  kind: string;
  package: string | null;
  tsconfig: string | null;
  status: string;
  reason: string | null;
}

export function indexPath(cacheDir: string): string {
  return join(cacheDir, INDEX_FILE);
}

export function stagingPath(cacheDir: string): string {
  return join(cacheDir, STAGING_FILE);
}

function removeDatabase(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
}

export function readSchemaVersion(db: DatabaseSync): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
  if (table.get() === undefined) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row === undefined ? 0 : Number(row.value);
}

function transaction(db: DatabaseSync, work: () => void): void {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function migrate(db: DatabaseSync): void {
  const from = readSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    transaction(db, () => {
      db.exec(migration.sql);
      writeMeta(db, { schema_version: String(migration.version) });
    });
  }
}

/**
 * Starts a build in a fresh staging database. Leftovers of an interrupted build are discarded;
 * the published index is never touched until publishBuild renames over it.
 */
export function beginBuild(cacheDir: string): DatabaseSync {
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  chmodSync(cacheDir, 0o700);
  const path = stagingPath(cacheDir);
  removeDatabase(path);
  // SQLite gives its -wal/-shm/-journal files the main file's mode, so creating it 0600 covers them.
  closeSync(openSync(path, 'wx', 0o600));
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

/** Atomically replaces the published index with the staging database and closes it. */
export function publishBuild(db: DatabaseSync, cacheDir: string): void {
  // Back to a rollback journal: the WAL is folded into the file, so the rename carries every page,
  // and readers of the published file never create -wal/-shm files that a later rename would orphan.
  db.exec('PRAGMA journal_mode = DELETE');
  db.close();
  const staging = stagingPath(cacheDir);
  const fd = openSync(staging, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staging, indexPath(cacheDir));
  const dir = openSync(cacheDir, 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** Opens the published index read-only; null when none has been published yet. */
export function openPublished(cacheDir: string): DatabaseSync | null {
  const path = indexPath(cacheDir);
  if (!existsSync(path)) return null;
  return new DatabaseSync(path, { readOnly: true });
}

export function writeMeta(db: DatabaseSync, entries: Record<string, string>): void {
  const upsert = db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(entries)) upsert.run(key, value);
}

export function readMeta(db: DatabaseSync): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const row of db.prepare('SELECT key, value FROM meta').all()) {
    meta[String(row.key)] = String(row.value);
  }
  return meta;
}

export function writeFiles(db: DatabaseSync, records: readonly FileRecord[]): void {
  const insert = db.prepare(
    `INSERT INTO files (path, size, mtime_ms, hash, kind, package, tsconfig, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  transaction(db, () => {
    for (const r of records) {
      insert.run(
        r.path,
        r.size,
        r.mtimeMs,
        r.hash,
        r.kind,
        r.package,
        r.tsconfig,
        r.status,
        r.reason,
      );
    }
  });
}

function textOrNull(value: unknown): string | null {
  return value === null ? null : String(value);
}

export function readFiles(db: DatabaseSync): FileRecord[] {
  const rows = db
    .prepare(
      'SELECT path, size, mtime_ms, hash, kind, package, tsconfig, status, reason FROM files ORDER BY path',
    )
    .all();
  return rows.map((row) => ({
    path: String(row.path),
    size: Number(row.size),
    mtimeMs: Number(row.mtime_ms),
    hash: textOrNull(row.hash),
    kind: String(row.kind),
    package: textOrNull(row.package),
    tsconfig: textOrNull(row.tsconfig),
    status: String(row.status),
    reason: textOrNull(row.reason),
  }));
}
