import { existsSync, readFileSync, realpathSync } from 'node:fs';
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

export interface WorkspaceCacheInfo {
  root: string;
  repoId: string;
  cacheDir: string;
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

/** Lightweight repository root + cache directory lookup (no config read or layout detection). */
export async function resolveWorkspaceCache(
  start: string,
  cacheHome?: string,
): Promise<WorkspaceCacheInfo> {
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
export async function loadWorkspace(start: string, cacheHome?: string): Promise<Workspace> {
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

/**
 * The project config that applies at `start`, read synchronously for load-time decisions
 * (which V2 tools to register). Null when there is no `ei.config.json` or it cannot be read.
 */
export function readProjectConfigSync(start: string): ProjectConfig | null {
  try {
    const real = realpathSync(start);
    const root = findConfigRoot(real, findGitRoot(real));
    if (root === null) return null;
    return parseProjectConfig(readFileSync(join(root, 'ei.config.json'), 'utf8')).config;
  } catch {
    return null;
  }
}
