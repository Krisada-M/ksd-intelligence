import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultConfig, parseProjectConfig, type ProjectConfig } from '../kernel/config.js';
import {
  computeRepoId,
  detectProjectLayout,
  findGitRoot,
  resolveCacheDir,
} from '../workspace/init.js';

export interface Workspace {
  root: string;
  repoId: string;
  cacheDir: string;
  /** `ei.config.json`, or null when the detected defaults apply (what `ei init` would write). */
  configPath: string | null;
  config: ProjectConfig;
  configErrors: string[];
}

// Searched upward from `start`, but never above the git work-tree root that contains it.
function findConfigRoot(start: string, gitRoot: string | null): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'ei.config.json'))) return dir;
    const parent = dirname(dir);
    if (dir === gitRoot || parent === dir) return null;
    dir = parent;
  }
}

/**
 * The repository a session or CLI call is about: the nearest directory holding `ei.config.json`,
 * else the git work-tree root, else `start` itself. Same repo id and cache dir as `ei init`.
 */
export async function loadWorkspace(start: string, cacheHome?: string): Promise<Workspace> {
  const real = await realpath(start);
  const gitRoot = findGitRoot(real);
  const root = findConfigRoot(real, gitRoot) ?? gitRoot ?? real;
  const repoId = computeRepoId(root);
  const configPath = join(root, 'ei.config.json');
  if (!existsSync(configPath)) {
    return {
      root,
      repoId,
      cacheDir: resolveCacheDir(repoId, cacheHome),
      configPath: null,
      config: defaultConfig(detectProjectLayout(root)),
      configErrors: [],
    };
  }
  const { config, errors } = parseProjectConfig(await readFile(configPath, 'utf8'));
  return {
    root,
    repoId,
    cacheDir: resolveCacheDir(repoId, cacheHome),
    configPath,
    config,
    configErrors: errors,
  };
}
