import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { defaultConfig, parseProjectConfig } from '../kernel/config.js';
import { matchAny } from '../kernel/glob.js';
import { isRecord } from '../kernel/guards.js';
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
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-test', '.git']);
const TSCONFIG_FILE = /^(?:tsconfig(?:\..+)?|jsconfig)\.json$/;
function stripJsonComments(raw) {
    return raw.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (match, comment) => comment ? '' : match);
}
/** Top-level directories owned by any tsconfig in `rootPath` (D57). */
export function tsconfigOwnedDirs(rootPath) {
    const configs = [];
    const walk = (relDir, depth) => {
        if (depth > 3)
            return;
        let entries;
        try {
            entries = readdirSync(join(rootPath, relDir), { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name))
                continue;
            const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
            if (entry.isDirectory()) {
                walk(relPath, depth + 1);
            }
            else if (entry.isFile() && TSCONFIG_FILE.test(entry.name)) {
                configs.push(relPath);
            }
        }
    };
    walk('', 0);
    const owned = new Set();
    const isDirectory = (dir) => {
        try {
            return statSync(join(rootPath, dir)).isDirectory();
        }
        catch {
            return false;
        }
    };
    for (const relConfig of configs) {
        if (relConfig === 'tsconfig.base.json' && configs.length > 1)
            continue;
        const configDir = dirname(relConfig);
        if (configDir !== '.') {
            const top = configDir.split('/')[0];
            if (top && !SKIP_DIRS.has(top) && isDirectory(top))
                owned.add(top);
        }
        try {
            const raw = readFileSync(join(rootPath, relConfig), 'utf8');
            const parsed = JSON.parse(stripJsonComments(raw));
            if (!isRecord(parsed))
                continue;
            const inputs = [];
            if (Array.isArray(parsed.include)) {
                for (const item of parsed.include)
                    if (typeof item === 'string')
                        inputs.push(item);
            }
            if (Array.isArray(parsed.files)) {
                for (const item of parsed.files)
                    if (typeof item === 'string')
                        inputs.push(item);
            }
            for (const pattern of inputs) {
                const norm = posix.normalize(configDir === '.' ? pattern : `${configDir}/${pattern}`);
                if (norm.startsWith('..'))
                    continue;
                const first = norm.split('/')[0];
                if (first &&
                    first !== '.' &&
                    !first.includes('*') &&
                    !SKIP_DIRS.has(first) &&
                    isDirectory(first)) {
                    owned.add(first);
                }
            }
        }
        catch {
            // Unparseable tsconfig is reported by scan; directory ownership still holds if nested.
        }
    }
    return [...owned];
}
export function detectProjectLayout(rootPath) {
    const standardDirs = ['packages', 'apps', 'src', 'test', 'tests', '__tests__', 'spec'];
    const include = [];
    for (const dir of standardDirs) {
        if (existsSync(join(rootPath, dir))) {
            include.push(`${dir}/**`);
        }
    }
    for (const dir of tsconfigOwnedDirs(rootPath)) {
        if (!matchAny(include, `${dir}/index.ts`)) {
            include.push(`${dir}/**`);
        }
    }
    if (include.length === 0) {
        // Without standard or tsconfig-owned directories there is no layout to infer; index the whole root.
        include.push('**');
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
    const omittedTsconfigDirs = tsconfigOwnedDirs(realRoot).filter((dir) => !matchAny(config.impact.include, `${dir}/index.ts`));
    if (omittedTsconfigDirs.length > 0) {
        warnings.push(`impact.include leaves out tsconfig-owned directories: ${omittedTsconfigDirs.join(', ')}`);
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
        omittedTsconfigDirs,
        git: {
            isRepo,
            gitRoot: gitRoot ?? undefined,
        },
        warnings,
    };
}
