import { chmod, mkdir } from 'node:fs/promises';
import { createEngineHost } from './host.js';
import { acquireBuildLock } from './lock.js';
import { chooseRuntime, memoryLimitMb } from './runtime.js';
import { pinnedTypescriptVersion, resolveTypescript } from './typescript.js';
/**
 * `ei index` (part 1): with the pinned TypeScript verified and the repository's build lock held,
 * the engine child scans and publishes the census. Only the lock holder starts a child (D35).
 */
export async function buildIndex(workspace, options = {}) {
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
        const reply = await host.request('index', {
            root: workspace.root,
            cacheDir: workspace.cacheDir,
            typescriptPath: typescript.runtime.path,
        }, options.onProgress);
        if (reply.ok)
            return { ok: true };
        const fix = reply.reason === 'memory-limit'
            ? 'narrow impact.include or raise impact.maxMemoryMb, then run: ei index'
            : 'retry once: ei index';
        return { ok: false, code: 'index-failed', message: reply.message, fix };
    }
    finally {
        await host.stop();
        lock.release();
    }
}
