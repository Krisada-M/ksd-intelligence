import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { defaultSkillsDir, discoverSkillsForPlatform, } from '../../workflow/packs.js';
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function uniquePaths(paths) {
    const seen = new Set();
    const out = [];
    for (const raw of paths) {
        if (!raw)
            continue;
        const normalized = resolve(raw);
        if (seen.has(normalized))
            continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
// Resolves AGY workspace, Snap, global, shared, and KSD catalog paths dynamically
// using OS/Snap environment variables without hardcoding any username.
export function detectAgyPaths(options = {}) {
    const env = options.env ?? process.env;
    const realHome = options.homeDir ?? env.SNAP_REAL_HOME ?? env.HOME ?? homedir();
    const ksdCatalogDir = resolve(options.skillsDir ?? defaultSkillsDir());
    const workspaceSkillsDir = options.workspaceRoot
        ? resolve(options.workspaceRoot, '.agents', 'skills')
        : null;
    const workspaceSkillsConfig = options.workspaceRoot
        ? resolve(options.workspaceRoot, '.agents', 'skills.json')
        : null;
    const snapCandidates = [];
    if (env.ANTIGRAVITY_APP_DATA_DIR) {
        snapCandidates.push(join(env.ANTIGRAVITY_APP_DATA_DIR, 'skills'));
    }
    if (env.SNAP_USER_COMMON) {
        snapCandidates.push(join(env.SNAP_USER_COMMON, '.gemini', 'antigravity-cli', 'skills'));
    }
    snapCandidates.push(join(realHome, 'snap', 'antigravity-cli', 'common', '.gemini', 'antigravity-cli', 'skills'));
    const snapSkillsDirs = uniquePaths(snapCandidates);
    const globalSkillsDirs = uniquePaths([
        join(realHome, '.gemini', 'config', 'skills'),
        join(realHome, '.gemini', 'antigravity-cli', 'skills'),
    ]);
    const sharedSkillsDir = resolve(realHome, '.agents', 'skills');
    const detected = [];
    if (workspaceSkillsDir) {
        detected.push({
            scope: 'workspace',
            label: 'agy:workspace',
            path: workspaceSkillsDir,
            exists: existsSync(workspaceSkillsDir),
        });
    }
    for (const dir of snapSkillsDirs) {
        detected.push({ scope: 'snap', label: 'agy:snap', path: dir, exists: existsSync(dir) });
    }
    for (const dir of globalSkillsDirs) {
        detected.push({ scope: 'global', label: 'agy:global', path: dir, exists: existsSync(dir) });
    }
    detected.push({
        scope: 'shared',
        label: 'agy:shared',
        path: sharedSkillsDir,
        exists: existsSync(sharedSkillsDir),
    });
    detected.push({
        scope: 'catalog',
        label: 'ksd:catalog',
        path: ksdCatalogDir,
        exists: existsSync(ksdCatalogDir),
    });
    const snapDetected = Boolean(env.SNAP_USER_COMMON || env.ANTIGRAVITY_APP_DATA_DIR) ||
        snapSkillsDirs.some((dir) => existsSync(dir));
    return {
        realHome,
        snapDetected,
        workspaceSkillsDir,
        workspaceSkillsConfig,
        snapSkillsDirs,
        globalSkillsDirs,
        sharedSkillsDir,
        ksdCatalogDir,
        detected,
    };
}
function resolveAgyConfigPath(rawPath, workspaceRoot, realHome) {
    const trimmed = rawPath.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('~/'))
        return resolve(realHome, trimmed.slice(2));
    return isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed);
}
async function readDeclaredAgyEntries(workspaceRoot, realHome) {
    const configPath = join(workspaceRoot, '.agents', 'skills.json');
    let raw;
    try {
        raw = await readFile(configPath, 'utf8');
    }
    catch {
        return [];
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return [];
    }
    if (typeof parsed !== 'object' || parsed === null || !('entries' in parsed))
        return [];
    const entries = parsed.entries;
    if (!Array.isArray(entries))
        return [];
    const roots = [];
    for (const item of entries) {
        if (typeof item !== 'object' || item === null || !('path' in item))
            continue;
        const rawPath = item.path;
        if (typeof rawPath !== 'string')
            continue;
        const resolved = resolveAgyConfigPath(rawPath, workspaceRoot, realHome);
        if (!resolved)
            continue;
        const includeOnly = isStringArray(item.include_only)
            ? item.include_only
            : undefined;
        const exclude = isStringArray(item.exclude)
            ? item.exclude
            : undefined;
        roots.push({
            path: resolved,
            label: `agy:skills.json(${rawPath})`,
            optional: false,
            includeOnly,
            exclude,
        });
    }
    return roots;
}
// Builds a portable AGY `.agents/skills.json` entry without hardcoded user-home paths.
export function buildAgySkillsConfig(options = {}) {
    const target = options.skillsDir ?? defaultSkillsDir();
    const entryPath = options.workspaceRoot ? relative(options.workspaceRoot, target) || '.' : target;
    const entry = { path: entryPath };
    if (options.exclude && options.exclude.length > 0)
        entry.exclude = [...options.exclude];
    return { entries: [entry] };
}
// Native AGY skill discovery honoring AGY precedence:
// workspace `.agents/skills` > `.agents/skills.json` > snap > global/user > shared > KSD catalog.
export async function discoverAgySkills(options = {}) {
    const paths = detectAgyPaths({
        workspaceRoot: options.workspaceRoot,
        env: options.env,
        homeDir: options.homeDir,
        skillsDir: options.skillsDir,
    });
    const roots = [];
    const seenPaths = new Set();
    const addRoot = (root) => {
        const key = resolve(root.path);
        if (seenPaths.has(key))
            return;
        seenPaths.add(key);
        roots.push(root);
    };
    if (options.workspaceRoot) {
        addRoot({
            path: join(options.workspaceRoot, '.agents', 'skills'),
            label: 'agy:workspace',
            optional: true,
        });
        for (const declared of await readDeclaredAgyEntries(options.workspaceRoot, paths.realHome)) {
            addRoot(declared);
        }
    }
    if (options.snapSkillsDir) {
        addRoot({
            path: options.snapSkillsDir,
            label: 'agy:snap',
            optional: true,
            allowExternalSymlinks: true,
            auditContent: false,
        });
    }
    else if (options.detectHostPaths) {
        for (const snapDir of paths.snapSkillsDirs) {
            addRoot({
                path: snapDir,
                label: 'agy:snap',
                optional: true,
                allowExternalSymlinks: true,
                auditContent: false,
            });
        }
    }
    if (options.userSkillsDir) {
        addRoot({
            path: options.userSkillsDir,
            label: 'agy:user',
            optional: true,
            allowExternalSymlinks: true,
            auditContent: false,
        });
    }
    else if (options.detectHostPaths) {
        for (const globalDir of paths.globalSkillsDirs) {
            addRoot({
                path: globalDir,
                label: 'agy:global',
                optional: true,
                allowExternalSymlinks: true,
                auditContent: false,
            });
        }
    }
    if (options.sharedSkillsDir) {
        addRoot({
            path: options.sharedSkillsDir,
            label: 'agy:shared',
            optional: true,
            allowExternalSymlinks: true,
            auditContent: false,
        });
    }
    else if (options.detectHostPaths) {
        addRoot({
            path: paths.sharedSkillsDir,
            label: 'agy:shared',
            optional: true,
            allowExternalSymlinks: true,
            auditContent: false,
        });
    }
    addRoot({
        path: paths.ksdCatalogDir,
        label: 'ksd:catalog',
        optional: false,
        auditContent: true,
    });
    const discovery = await discoverSkillsForPlatform({
        platform: 'agy',
        roots,
        requireCatalog: options.requireCatalog ?? true,
    });
    return { ...discovery, paths };
}
