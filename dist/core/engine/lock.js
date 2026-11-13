import { execFileSync } from 'node:child_process';
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../kernel/guards.js';
export const LOCK_FILE = 'build.lock';
function readRaw(path) {
    try {
        return readFileSync(path, 'utf8');
    }
    catch {
        return null;
    }
}
function errorCode(error) {
    return error instanceof Error && 'code' in error ? error.code : undefined;
}
// Linux: start time in clock ticks since boot (field 22 of /proc/<pid>/stat, counted after the
// parenthesised command name, which may contain spaces). Stable for the process's lifetime, unlike
// wall-clock renderings that shift when the clock is corrected (seen on WSL after resume).
// macOS: `ps -o lstart=`, rendered from the start time the kernel stored at fork.
function processIdentity(pid) {
    try {
        if (process.platform === 'linux') {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
            return ticks === undefined ? null : `ticks:${ticks}`;
        }
        const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            env: { ...process.env, LC_ALL: 'C' },
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        return lstart === '' ? null : `lstart:${lstart}`;
    }
    catch {
        return null;
    }
}
function parseHolder(raw) {
    try {
        const value = JSON.parse(raw);
        if (!isRecord(value) || !Number.isInteger(value.pid) || typeof value.startedAt !== 'string') {
            return null;
        }
        const identity = typeof value.identity === 'string' ? value.identity : null;
        return { pid: Number(value.pid), startedAt: value.startedAt, identity };
    }
    catch {
        return null; // corrupt lock file: stale
    }
}
/** False when the holder process is gone or its pid now belongs to another process. */
export function isHolderAlive(holder) {
    try {
        process.kill(holder.pid, 0);
    }
    catch (error) {
        if (errorCode(error) !== 'EPERM')
            return false; // EPERM: alive, owned by another user
    }
    const now = processIdentity(holder.pid);
    // Unknown on either side: keep the lock rather than risk two builders.
    return holder.identity === null || now === null || now === holder.identity;
}
export function readLockHolder(cacheDir) {
    const raw = readRaw(join(cacheDir, LOCK_FILE));
    return raw === null ? null : parseHolder(raw);
}
/**
 * Takes the per-repository build lock in the cache dir. Refused while a live process holds it; a
 * lock whose holder is gone, or whose pid now belongs to another process, is stale and taken over.
 * Released by release() or when this process exits normally.
 */
export function acquireBuildLock(cacheDir) {
    const path = join(cacheDir, LOCK_FILE);
    const self = {
        pid: process.pid,
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        identity: processIdentity(process.pid),
    };
    const content = JSON.stringify(self);
    for (let attempt = 0; attempt < 3; attempt++) {
        // link() publishes a fully written file atomically and fails if a lock already exists.
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, content, { mode: 0o600 });
        try {
            linkSync(temp, path);
            return { ok: true, release: holdUntilExit(path, content) };
        }
        catch (error) {
            if (errorCode(error) !== 'EEXIST')
                throw error;
        }
        finally {
            rmSync(temp, { force: true });
        }
        const raw = readRaw(path);
        if (raw === null)
            continue; // released meanwhile
        const holder = parseHolder(raw);
        if (holder !== null && isHolderAlive(holder))
            return { ok: false, holder };
        // Stale: move it aside atomically, then confirm it is the file judged stale and not a fresh
        // lock another session created after our read; a fresh one is put back.
        const tomb = `${path}.stale-${process.pid}`;
        try {
            renameSync(path, tomb);
        }
        catch {
            continue;
        }
        if (readRaw(tomb) !== raw) {
            try {
                linkSync(tomb, path);
            }
            catch {
                // a third session took the slot; the next attempt reads its lock
            }
        }
        rmSync(tomb, { force: true });
    }
    return { ok: false, holder: readLockHolder(cacheDir) };
}
function holdUntilExit(path, content) {
    const release = () => {
        process.off('exit', release);
        // Only delete our own lock, never one taken over after this holder was judged stale.
        if (readRaw(path) === content)
            rmSync(path, { force: true });
    };
    process.on('exit', release);
    return release;
}
