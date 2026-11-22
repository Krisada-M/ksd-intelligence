import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultConfig, parseProjectConfig } from '../kernel/config.js';
import { computeRepoId, detectProjectLayout, findGitRoot, resolveCacheDir, } from '../workspace/init.js';
// Searched upward from `start`, but never above the git work-tree root that contains it.
function findConfigRoot(start, gitRoot) {
    let dir = start;
    for (;;) {
        if (existsSync(join(dir, 'ei.config.json')))
            return dir;
        const parent = dirname(dir);
        if (dir === gitRoot || parent === dir)
            return null;
        dir = parent;
    }
}
/** Lightweight repository root + cache directory lookup (no config read or layout detection). */
export async function resolveWorkspaceCache(start, cacheHome) {
    const real = await realpath(start);
    const gitRoot = findGitRoot(real);
    const root = findConfigRoot(real, gitRoot) ?? gitRoot ?? real;
    const repoId = computeRepoId(root);
    return {
        root,
        repoId,
        cacheDir: resolveCacheDir(repoId, cacheHome),
    };
}
/**
 * The repository a session or CLI call is about: the nearest directory holding `ei.config.json`,
 * else the git work-tree root, else `start` itself. Same repo id and cache dir as `ei init`.
 */
export async function loadWorkspace(start, cacheHome) {
    const { root, repoId, cacheDir } = await resolveWorkspaceCache(start, cacheHome);
    const configPath = join(root, 'ei.config.json');
    if (!existsSync(configPath)) {
        return {
            root,
            repoId,
            cacheDir,
            configPath: null,
            config: defaultConfig(detectProjectLayout(root)),
            configErrors: [],
        };
    }
    const { config, errors } = parseProjectConfig(await readFile(configPath, 'utf8'));
    return {
        root,
        repoId,
        cacheDir,
        configPath,
        config,
        configErrors: errors,
    };
}
