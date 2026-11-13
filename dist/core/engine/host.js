import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { encode, lineReader, parseMessage } from './protocol.js';
import { runtimeArgs } from './runtime.js';
const run = promisify(execFile);
const IDLE_MS = 10 * 60_000;
const IDLE_KILL_GRACE_MS = 5_000;
const STDERR_TAIL = 4_096;
const NODE_OOM = /heap out of memory|Reached heap limit|Allocation failed - JavaScript heap/i;
async function rssMb(pid) {
    try {
        const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
        const kb = Number.parseInt(stdout.trim(), 10);
        return Number.isNaN(kb) ? null : kb / 1024;
    }
    catch {
        return null; // process already gone
    }
}
/**
 * Parent side of the engine (D45): one child process, spawned on the first request and again
 * on the first request after it exits, killed above its memory limit, retired when idle.
 */
export function createEngineHost(options) {
    const { runtime, memoryLimitMb } = options;
    const idleMs = options.idleMs ?? IDLE_MS;
    const watchdog = options.watchdog ?? runtime.kind === 'bun';
    // Test-only child ops need an env the caller passes explicitly; the session's own variables
    // never enable them.
    const inherited = { ...process.env };
    delete inherited.EI_ENGINE_TEST_OPS;
    const base = options.env ?? inherited;
    // Under OMP the runtime is the omp executable, which only acts as plain Bun when asked to.
    const env = runtime.kind === 'bun' ? { ...base, BUN_BE_BUN: '1' } : base;
    const childScript = fileURLToPath(new URL('./child.js', import.meta.url));
    let current = null;
    let idleTimer;
    let sequence = 0;
    let starts = 0;
    let lastExit = null;
    function kill(child, reason) {
        child.killedFor ??= reason;
        child.proc.kill('SIGKILL');
    }
    function onExit(child, code, signal) {
        clearInterval(child.sampler);
        if (current === child)
            current = null;
        const oom = signal === 'SIGABRT' || code === 134 || NODE_OOM.test(child.stderr);
        const reason = child.killedFor ?? (oom ? 'memory-limit' : 'crashed');
        lastExit = { code, signal, reason };
        const tail = child.stderr.trim().slice(-300);
        const message = reason === 'memory-limit'
            ? `engine exceeded its memory limit of ${memoryLimitMb} MB (${runtime.kind})`
            : `engine child exited (${signal ?? `code ${code}`}, ${reason})${tail ? `: ${tail}` : ''}`;
        for (const pending of child.pending.values()) {
            pending.resolve({ ok: false, code: 'index-failed', message, reason });
        }
        child.pending.clear();
    }
    function onMessage(child, message) {
        const pending = child.pending.get(message.id);
        if (!pending || message.type === 'request')
            return;
        if (message.type === 'progress') {
            pending.onProgress?.(message.message, message.data);
            return;
        }
        child.pending.delete(message.id);
        pending.resolve(message.type === 'result'
            ? { ok: true, value: message.value }
            : { ok: false, code: message.code, message: message.message });
        if (child.pending.size === 0)
            armIdle(child);
    }
    function armIdle(child) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (current !== child || child.pending.size > 0)
                return;
            // Retire: later requests start a fresh child; this one exits when its stdin closes.
            current = null;
            child.killedFor = 'idle';
            child.proc.stdin.end();
            setTimeout(() => kill(child, 'idle'), IDLE_KILL_GRACE_MS).unref();
        }, idleMs);
        idleTimer.unref();
    }
    function startSampler(child) {
        let busy = false;
        child.sampler = setInterval(() => {
            const pid = child.proc.pid;
            if (busy || pid === undefined)
                return;
            busy = true;
            void rssMb(pid).then((mb) => {
                busy = false;
                if (mb !== null && mb > memoryLimitMb)
                    kill(child, 'memory-limit');
            });
        }, options.samplerMs ?? 1_000);
        child.sampler.unref();
    }
    function spawnChild() {
        const proc = spawn(runtime.command, [...runtimeArgs(runtime, memoryLimitMb), childScript], {
            env,
            stdio: 'pipe',
        });
        let markExited = () => undefined;
        const child = {
            proc,
            pending: new Map(),
            stderr: '',
            killedFor: null,
            exited: new Promise((resolve) => (markExited = resolve)),
        };
        let done = false;
        const finish = (code, signal) => {
            if (done)
                return;
            done = true;
            onExit(child, code, signal);
            markExited();
        };
        proc.stdout.on('data', lineReader((line) => {
            const message = parseMessage(line);
            if (typeof message === 'string') {
                child.stderr = `${child.stderr}[protocol] ${message}: ${line.slice(0, 200)}\n`.slice(-STDERR_TAIL);
                return;
            }
            onMessage(child, message);
        }));
        proc.stderr.on('data', (chunk) => {
            child.stderr = (child.stderr + chunk.toString()).slice(-STDERR_TAIL);
        });
        // A write to a dying child fails with EPIPE; 'close' then reports the exit to every request.
        proc.stdin.on('error', () => undefined);
        proc.on('error', (error) => {
            child.stderr += error.message;
            if (proc.pid === undefined)
                finish(null, null);
        });
        proc.on('close', finish);
        if (watchdog)
            startSampler(child);
        starts++;
        return child;
    }
    function request(op, args, onProgress) {
        clearTimeout(idleTimer);
        const child = (current ??= spawnChild());
        const id = String(++sequence);
        return new Promise((resolve) => {
            child.pending.set(id, { resolve, onProgress });
            child.proc.stdin.write(encode({ type: 'request', id, op, args }));
        });
    }
    async function stop() {
        clearTimeout(idleTimer);
        const child = current;
        if (!child)
            return;
        kill(child, 'stopped');
        await child.exited;
    }
    function status() {
        return { runtime, memoryLimitMb, pid: current?.proc.pid ?? null, starts, lastExit };
    }
    return { request, stop, status };
}
