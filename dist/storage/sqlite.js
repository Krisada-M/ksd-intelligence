import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
export const INDEX_FILE = 'index.sqlite';
export const STAGING_FILE = 'index.staging.sqlite';
/** Written when a build fails VERIFY: the previous index was kept; these are `incompleteReasons`. */
export const FAILURE_FILE = 'last-failure.json';
// Numbered migrations; a database at version n gets every migration with version > n, in order.
const MIGRATIONS = [
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
    {
        // M2a.2: extract-local and resolve records (ADR 0002, ADR 0003). Keys are stored once, in
        // `symbols`; declarations and edges refer to them by id (an index of text keys was 80% of
        // the oh-my-pi database).
        version: 2,
        sql: `
      CREATE TABLE file_index (
        file                TEXT PRIMARY KEY,
        extraction          TEXT NOT NULL,
        lines               INTEGER NOT NULL,
        surface             TEXT NOT NULL,
        global              INTEGER NOT NULL,
        indexed_uses INTEGER NOT NULL,
        local_uses INTEGER NOT NULL,
        external            INTEGER NOT NULL,
        external_unresolved INTEGER NOT NULL,
        unresolved_other    INTEGER NOT NULL,
        outside_scope       INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE symbols (
        id  INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE TABLE declarations (
        id          INTEGER PRIMARY KEY,
        file        TEXT NOT NULL,
        name        TEXT NOT NULL,
        simple      TEXT NOT NULL,
        kind        TEXT NOT NULL,
        exported    INTEGER NOT NULL,
        start_line  INTEGER NOT NULL,
        end_line    INTEGER NOT NULL,
        other_spans TEXT NOT NULL,
        sig_hash    TEXT NOT NULL
      ) STRICT;
      CREATE INDEX declarations_file ON declarations (file);
      CREATE INDEX declarations_simple ON declarations (simple);
      CREATE TABLE edges (
        source   INTEGER NOT NULL,
        target   INTEGER NOT NULL,
        kind     TEXT NOT NULL,
        strength TEXT NOT NULL,
        lines    TEXT NOT NULL,
        PRIMARY KEY (source, target, kind)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX edges_target ON edges (target);
      CREATE TABLE unresolved (
        file   TEXT NOT NULL,
        line   INTEGER NOT NULL,
        name   TEXT NOT NULL,
        reason TEXT NOT NULL,
        source TEXT NOT NULL
      ) STRICT;
      CREATE INDEX unresolved_file ON unresolved (file);
      CREATE TABLE gap_sites (
        file   TEXT NOT NULL,
        line   INTEGER NOT NULL,
        code   TEXT NOT NULL,
        detail TEXT NOT NULL,
        source TEXT NOT NULL
      ) STRICT;
      CREATE INDEX gap_sites_file ON gap_sites (file);
      CREATE TABLE name_tokens (
        file  TEXT NOT NULL,
        name  TEXT NOT NULL,
        kind  TEXT NOT NULL,
        lines TEXT NOT NULL,
        PRIMARY KEY (file, name, kind)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX name_tokens_name ON name_tokens (name);
      CREATE TABLE external_imports (
        file      TEXT NOT NULL,
        specifier TEXT NOT NULL,
        line      INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX external_imports_file ON external_imports (file);
      CREATE TABLE exports (
        file   TEXT NOT NULL,
        name   TEXT NOT NULL,
        target TEXT NOT NULL,
        PRIMARY KEY (file, name, target)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX exports_target ON exports (target);`,
    },
];
export const SCHEMA_VERSION = MIGRATIONS.length;
export function indexPath(cacheDir) {
    return join(cacheDir, INDEX_FILE);
}
export function stagingPath(cacheDir) {
    return join(cacheDir, STAGING_FILE);
}
function removeDatabase(path) {
    for (const suffix of ['', '-wal', '-shm', '-journal'])
        rmSync(path + suffix, { force: true });
}
export function readSchemaVersion(db) {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'");
    if (table.get() === undefined)
        return 0;
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row === undefined ? 0 : Number(row.value);
}
/** All of `work` or none of it; nests (a savepoint inside a transaction is its own unit). */
export function transaction(db, work) {
    db.exec('SAVEPOINT work');
    try {
        work();
        db.exec('RELEASE work');
    }
    catch (error) {
        db.exec('ROLLBACK TO work');
        db.exec('RELEASE work');
        throw error;
    }
}
function migrate(db) {
    const from = readSchemaVersion(db);
    for (const migration of MIGRATIONS) {
        if (migration.version <= from)
            continue;
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
export function beginBuild(cacheDir) {
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
/**
 * Starts an update as a copy of the published index (D49: every publish is copy-then-rename).
 * Null when nothing is published or the published schema is not this engine's.
 */
export function beginUpdate(cacheDir) {
    const published = indexPath(cacheDir);
    if (!existsSync(published))
        return null;
    const path = stagingPath(cacheDir);
    removeDatabase(path);
    // A reflink where the filesystem has one (APFS, Btrfs, XFS), a plain copy otherwise.
    copyFileSync(published, path, constants.COPYFILE_FICLONE);
    chmodSync(path, 0o600);
    const db = new DatabaseSync(path);
    if (readSchemaVersion(db) !== SCHEMA_VERSION) {
        db.close();
        removeDatabase(path);
        return null;
    }
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    return db;
}
/** Drops a staging database that will not be published (a failed verify, an abandoned build). */
export function discardBuild(db, cacheDir) {
    if (db.isOpen)
        db.close();
    removeDatabase(stagingPath(cacheDir));
}
/** Atomically replaces the published index with the staging database and closes it. */
export function publishBuild(db, cacheDir) {
    // Back to a rollback journal: the WAL is folded into the file, so the rename carries every page,
    // and readers of the published file never create -wal/-shm files that a later rename would orphan.
    db.exec('PRAGMA journal_mode = DELETE');
    db.close();
    const staging = stagingPath(cacheDir);
    const fd = openSync(staging, 'r');
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(staging, indexPath(cacheDir));
    const dir = openSync(cacheDir, 'r');
    try {
        fsyncSync(dir);
    }
    finally {
        closeSync(dir);
    }
}
/** Opens the published index read-only; null when none has been published yet. */
export function openPublished(cacheDir) {
    const path = indexPath(cacheDir);
    if (!existsSync(path))
        return null;
    return new DatabaseSync(path, { readOnly: true });
}
export function writeMeta(db, entries) {
    const upsert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
    for (const [key, value] of Object.entries(entries))
        upsert.run(key, value);
}
export function readMeta(db) {
    const meta = {};
    for (const row of db.prepare('SELECT key, value FROM meta').all()) {
        meta[String(row.key)] = String(row.value);
    }
    return meta;
}
export function writeFiles(db, records) {
    const insert = db.prepare(`INSERT INTO files (path, size, mtime_ms, hash, kind, package, tsconfig, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    transaction(db, () => {
        for (const r of records) {
            insert.run(r.path, r.size, r.mtimeMs, r.hash, r.kind, r.package, r.tsconfig, r.status, r.reason);
        }
    });
}
function textOrNull(value) {
    return value === null ? null : String(value);
}
export function readFiles(db) {
    const rows = db
        .prepare('SELECT path, size, mtime_ms, hash, kind, package, tsconfig, status, reason FROM files ORDER BY path')
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
