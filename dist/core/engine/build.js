import { chmod, mkdir } from 'node:fs/promises';
import { isRecord } from '../kernel/guards.js';
import { createEngineHost } from './host.js';
import { acquireBuildLock } from './lock.js';
import { chooseRuntime, memoryLimitMb } from './runtime.js';
import { pinnedTypescriptVersion, resolveTypescript } from './typescript.js';
/** Owner commands are long (a cold oh-my-pi build is minutes) but never unbounded. */
const OWNER_COMMAND_MS = 60 * 60_000;
/**
 * Runs one engine op for the repository with the pinned TypeScript verified and its build lock
 * held. Only the lock holder starts a child (D35); the child is stopped afterwards.
 */
async function runLocked(workspace, op, args, options) {
    const typescript = await resolveTypescript({
        version: pinnedTypescriptVersion(),
        cacheHome: options.cacheHome,
        repoRoot: workspace.root,
        useWorkspaceTypescript: workspace.config.impact.useWorkspaceTypescript,
    });
    if (!typescript.ok) {
        return { ok: false, code: 'degraded', message: typescript.reason, fix: typescript.fix };
    }
    await mkdir(workspace.cacheDir, { recursive: true, mode: 0o700 });
    await chmod(workspace.cacheDir, 0o700);
    const lock = acquireBuildLock(workspace.cacheDir);
    if (!lock.ok) {
        const holder = lock.holder;
        return {
            ok: false,
            code: 'busy',
            message: holder
                ? `index build in progress (pid ${holder.pid} since ${holder.startedAt})`
                : 'index build lock is held by another session',
            fix: 'wait for it to publish, then run: ei status',
        };
    }
    const host = createEngineHost({
        runtime: await chooseRuntime(options.env),
        memoryLimitMb: memoryLimitMb(workspace.config.impact.maxMemoryMb),
        env: options.env,
    });
    try {
        const reply = await host.request(op, {
            ...args,
            root: workspace.root,
            cacheDir: workspace.cacheDir,
            typescriptPath: typescript.runtime.path,
        }, { onProgress: options.onProgress, timeoutMs: options.timeoutMs ?? OWNER_COMMAND_MS });
        if (reply.ok && isRecord(reply.value))
            return { ok: true, value: reply.value };
        if (reply.ok) {
            return { ok: false, code: 'index-failed', message: 'engine reply is not an object', fix: '' };
        }
        const fix = reply.reason === 'memory-limit'
            ? 'narrow impact.include or raise impact.maxMemoryMb, then run: ei index'
            : reply.reason === 'timeout'
                ? `the engine hung or is far slower than expected; retry ei ${op}`
                : `retry once: ei ${op}`;
        return { ok: false, code: 'index-failed', message: reply.message, fix };
    }
    finally {
        await host.stop();
        lock.release();
    }
}
/** `ei index [--full]`: an update from the published index, or a cold build. */
export function buildIndex(workspace, options = {}) {
    return runLocked(workspace, 'index', { full: options.full === true, freshness: 'hash' }, options);
}
/** `ei doctor --deep [--differential N]`: cold rebuild into a temp database, diffed. */
export function doctorDeep(workspace, options = {}) {
    return runLocked(workspace, 'doctor', { differential: options.differential ?? 0 }, options);
}
