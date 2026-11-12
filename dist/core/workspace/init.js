import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultConfig, parseProjectConfig } from '../kernel/config.js';
export function computeRepoId(rootPath) {
    const real = realpathSync(rootPath);
    return createHash('sha256').update(real).digest('hex').slice(0, 16);
}
export function resolveCacheDir(repoId, customHome) {
    const base = customHome ?? homedir();
    return join(base, '.cache', 'ksd-intelligence', repoId);
}
export function findGitRoot(startDir) {
    let current = startDir;
    while (true) {
        if (existsSync(join(current, '.git'))) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) {
            return null;
        }
        current = parent;
    }
}
export function detectProjectLayout(rootPath) {
    const hasPackages = existsSync(join(rootPath, 'packages'));
    const hasApps = existsSync(join(rootPath, 'apps'));
    const hasSrc = existsSync(join(rootPath, 'src'));
    const include = [];
    if (hasPackages)
        include.push('packages/**');
    if (hasApps)
        include.push('apps/**');
    if (include.length === 0) {
        // Without packages/, apps/ or src/ there is no layout to infer; index the whole root.
        include.push(hasSrc ? 'src/**' : '**');
    }
    // `impact.routes` holds file globs (DESIGN §9), so a detected directory becomes the glob
    // for the route files a framework loads from it, never the bare directory path.
    const candidateRoutes = [
        { probe: 'src/routes.ts', route: 'src/routes.ts' },
        { probe: 'src/routes/index.ts', route: 'src/routes/index.ts' },
        { probe: 'src/app/api', route: 'src/app/api/**/route.{ts,tsx,js,jsx}' },
        { probe: 'src/pages/api', route: 'src/pages/api/**/*.{ts,tsx,js,jsx}' },
        { probe: 'app/api', route: 'app/api/**/route.{ts,tsx,js,jsx}' },
        { probe: 'pages/api', route: 'pages/api/**/*.{ts,tsx,js,jsx}' },
        { probe: 'packages/api/src/routes.ts', route: 'packages/api/src/routes.ts' },
    ];
    const routes = [];
    for (const candidate of candidateRoutes) {
        if (existsSync(join(rootPath, candidate.probe))) {
            routes.push(candidate.route);
        }
    }
    return { include, routes };
}
export async function discoverTsconfigs(rootPath) {
    const results = [];
    const entries = await readdir(rootPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isFile() &&
            (entry.name === 'tsconfig.json' ||
                (entry.name.startsWith('tsconfig.') && entry.name.endsWith('.json')))) {
            results.push(entry.name);
        }
    }
    const subdirsToScan = ['packages', 'apps', 'src', 'tests'];
    for (const subdir of subdirsToScan) {
        const subdirPath = join(rootPath, subdir);
        if (!existsSync(subdirPath))
            continue;
        try {
            const subEntries = await readdir(subdirPath, { withFileTypes: true });
            for (const sub of subEntries) {
                if (sub.isDirectory()) {
                    const nestedTsconfig = join(subdir, sub.name, 'tsconfig.json');
                    if (existsSync(join(rootPath, nestedTsconfig))) {
                        results.push(nestedTsconfig.replace(/\\/g, '/'));
                    }
                }
                else if (sub.isFile() &&
                    (sub.name === 'tsconfig.json' ||
                        (sub.name.startsWith('tsconfig.') && sub.name.endsWith('.json')))) {
                    const relPath = join(subdir, sub.name).replace(/\\/g, '/');
                    results.push(relPath);
                }
            }
        }
        catch {
            // Ignore unreadable subdirectories
        }
    }
    results.sort();
    return results;
}
export async function initProject(options = {}) {
    const targetPath = options.root ? resolve(options.root) : process.cwd();
    let realRoot;
    try {
        realRoot = realpathSync(targetPath);
    }
    catch {
        throw new Error(`Target root path does not exist: ${targetPath}`);
    }
    const warnings = [];
    const gitRoot = findGitRoot(realRoot);
    const isRepo = gitRoot !== null;
    if (!isRepo) {
        warnings.push(`Not a git repository: ${realRoot}`);
    }
    const repoId = computeRepoId(realRoot);
    const cacheDir = resolveCacheDir(repoId, options.cacheHome);
    if (!options.dryRun) {
        // The cache holds index records and the audit log; keep it private to the user (RISK §5).
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        await chmod(cacheDir, 0o700);
    }
    const configPath = join(realRoot, 'ei.config.json');
    const configExists = existsSync(configPath);
    let configCreated = false;
    let configOverwritten = false;
    let configSkipped = false;
    let config;
    if (configExists && !options.force) {
        configSkipped = true;
        const raw = await readFile(configPath, 'utf8');
        const parsed = parseProjectConfig(raw);
        config = parsed.config;
        if (parsed.errors.length > 0) {
            for (const error of parsed.errors) {
                warnings.push(`Existing config: ${error}`);
            }
        }
    }
    else {
        const layout = detectProjectLayout(realRoot);
        config = defaultConfig(layout);
        if (configExists && options.force) {
            configOverwritten = true;
        }
        else {
            configCreated = true;
        }
        if (!options.dryRun) {
            await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        }
    }
    const tsconfigs = await discoverTsconfigs(realRoot);
    if (tsconfigs.length === 0) {
        warnings.push('No tsconfig files found in repository');
    }
    return {
        root: realRoot,
        repoId,
        cacheDir,
        configPath,
        configCreated,
        configOverwritten,
        configSkipped,
        config,
        tsconfigs,
        git: {
            isRepo,
            gitRoot: gitRoot ?? undefined,
        },
        warnings,
    };
}
