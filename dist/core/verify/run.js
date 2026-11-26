import { spawn } from 'node:child_process';
import { isSecretEnvName } from '../audit/log.js';
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** The inherited environment minus every variable whose name looks like a credential. */
export function checkEnvironment(env) {
    const out = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined || isSecretEnvName(key))
            continue;
        out[key] = value;
    }
    return out;
}
function killGroup(pid) {
    if (pid === undefined)
        return;
    try {
        // Negative pid: the whole process group, so grandchildren (npm → sh → node) die too.
        process.kill(-pid, 'SIGKILL');
    }
    catch {
        // ESRCH: the group is already gone.
    }
}
class TailBuffer {
    cap;
    chunks = [];
    size = 0;
    truncated = false;
    constructor(cap) {
        this.cap = cap;
    }
    push(chunk) {
        this.chunks.push(chunk);
        this.size += chunk.length;
        while (this.size > this.cap && this.chunks.length > 0) {
            const first = this.chunks[0];
            if (first === undefined)
                break;
            const excess = this.size - this.cap;
            this.truncated = true;
            if (first.length <= excess) {
                this.chunks.shift();
                this.size -= first.length;
                continue;
            }
            this.chunks[0] = first.subarray(excess);
            this.size -= excess;
        }
    }
    text() {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}
/**
 * Runs one allowlisted check without a shell: argv comes only from the owner's config.
 * Timeout or cancel kills the whole process group; so does a normal exit, so no orphan survives.
 */
export function runCheck(check, root, options = {}) {
    const startedAt = new Date();
    const started = performance.now();
    const tail = new TailBuffer(options.maxOutputBytes ?? MAX_OUTPUT_BYTES);
    const [file, ...args] = check.command;
    return new Promise((resolve) => {
        let timedOut = false;
        let cancelled = false;
        let spawnError = null;
        let settled = false;
        const child = spawn(file ?? '', args, {
            cwd: root,
            env: checkEnvironment(options.env ?? process.env),
            shell: false,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup(child.pid);
        }, check.timeoutSec * 1000);
        const onAbort = () => {
            cancelled = true;
            killGroup(child.pid);
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted)
            onAbort();
        child.stdout.on('data', (chunk) => tail.push(chunk));
        child.stderr.on('data', (chunk) => tail.push(chunk));
        const finish = (exitCode, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            resolve({
                startedAt: startedAt.toISOString(),
                durationMs: Math.round(performance.now() - started),
                exitCode,
                signal,
                timedOut,
                cancelled,
                spawnError,
                output: tail.text(),
                outputTruncated: tail.truncated,
                pid: child.pid ?? null,
            });
        };
        child.on('error', (error) => {
            spawnError = error.code ?? error.message;
            finish(null, null);
        });
        // A leader that exits while background children hold the pipes would block 'close'.
        child.on('exit', () => killGroup(child.pid));
        child.on('close', (code, signal) => finish(code, signal));
    });
}
