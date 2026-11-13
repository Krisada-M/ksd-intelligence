import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { isRecord } from '../kernel/guards.js';
import { matchAny, matchGlob } from '../kernel/glob.js';
const run = promisify(execFile);
/** Boundary check for a module imported by path: the members the scan calls are present. */
export function isTypescriptApi(value) {
    return (isRecord(value) &&
        typeof value.version === 'string' &&
        isRecord(value.sys) &&
        typeof value.getParsedCommandLineOfConfigFile === 'function' &&
        typeof value.resolveProjectReferencePath === 'function' &&
        typeof value.readConfigFile === 'function');
}
// RISK §6 default excludes (D49), two classes. Secrets are reported as `secret`.
// Always excluded, any kind of file:
const SECRET_PATTERNS = ['**/.env*', '**/*.pem', '**/*.key'];
const DEFAULT_EXCLUDES = ['**/node_modules/**', '**/dist/**', '**/.git/**'];
// Excluded by name only when the file is not code: source that handles credentials is indexed.
const SECRET_NAME_PATTERNS = ['**/*credentials*', '**/secrets/**'];
const IS_CODE = {
    ts: true,
    tsx: true,
    js: true,
    jsx: true,
    mjs: true,
    cjs: true,
    'd.ts': true,
    json: false,
    other: false,
};
const KINDS = {
    '.ts': 'ts',
    '.mts': 'ts',
    '.cts': 'ts',
    '.tsx': 'tsx',
    '.js': 'js',
    '.jsx': 'jsx',
    '.mjs': 'mjs',
    '.cjs': 'cjs',
    '.json': 'json',
};
const TSCONFIG_NAME = /^(?:tsconfig(?:\..+)?|jsconfig)\.json$/;
const HASH_CONCURRENCY = 32;
export function kindOf(path) {
    if (/\.d\.[cm]?ts$/.test(path))
        return 'd.ts';
    return KINDS[extname(path)] ?? 'other';
}
/** Secret and excluded paths are decided by path and kind alone; their content is never read. */
export function exclusionOf(path, impact) {
    if (SECRET_PATTERNS.some((pattern) => matchGlob(pattern, path)))
        return 'secret';
    if (!IS_CODE[kindOf(path)] && SECRET_NAME_PATTERNS.some((pattern) => matchGlob(pattern, path))) {
        return 'secret';
    }
    if (matchAny([...DEFAULT_EXCLUDES, ...impact.exclude], path))
        return 'excluded';
    return null;
}
function toPosix(path) {
    return sep === '/' ? path : path.split(sep).join('/');
}
// One read is ~35% faster than a stream on source-sized files (oh-my-pi: 1.6 s vs 2.5 s for
// 210 MB in 10,485 files); large files stream so a big binary never sits in memory whole.
const STREAM_ABOVE_BYTES = 8 * 2 ** 20;
export async function hashFile(path, size) {
    const hash = createHash('sha256');
    if (size > STREAM_ABOVE_BYTES)
        await pipeline(createReadStream(path), hash);
    else
        hash.update(await readFile(path));
    return hash.digest('hex');
}
export async function mapLimit(items, limit, work) {
    const results = new Array(items.length);
    // Workers share one iterator, so each item is taken exactly once.
    const queue = items.entries();
    const worker = async () => {
        for (const [index, item] of queue)
            results[index] = await work(item);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
// shortcut: gitignore character classes ([abc]) and escapes are matched literally (the shared glob
// does not support them); only the non-git fallback uses this, git repositories use git itself.
function parseGitignore(text, base) {
    const rules = [];
    for (const raw of text.split(/\r?\n/)) {
        let line = raw.trimEnd();
        if (line === '' || line.startsWith('#'))
            continue;
        const negate = line.startsWith('!');
        if (negate)
            line = line.slice(1);
        const dirOnly = line.endsWith('/');
        if (dirOnly)
            line = line.slice(0, -1);
        const anchored = line.includes('/');
        if (line.startsWith('/'))
            line = line.slice(1);
        const prefix = base === '' ? '' : `${base}/`;
        rules.push({ glob: anchored ? prefix + line : `${prefix}**/${line}`, negate, dirOnly });
    }
    return rules;
}
async function walkVisible(root) {
    const files = [];
    const visit = async (dir, inherited) => {
        const abs = join(root, dir);
        const entries = await readdir(abs, { withFileTypes: true });
        const own = await readFile(join(abs, '.gitignore'), 'utf8').then((text) => parseGitignore(text, dir), () => []);
        const rules = [...inherited, ...own];
        for (const entry of entries) {
            if (entry.name === '.git')
                continue;
            const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
            const isDir = entry.isDirectory();
            let ignored = false;
            for (const rule of rules) {
                if ((!rule.dirOnly || isDir) && matchGlob(rule.glob, path))
                    ignored = !rule.negate;
            }
            if (ignored)
                continue;
            if (isDir)
                await visit(path, rules);
            else
                files.push(path);
        }
    };
    await visit('', []);
    return files;
}
/**
 * The visible set (D25): git's tracked + untracked − ignored when `root` is in a git work tree,
 * else a walk honouring .gitignore. Paths are repo-relative POSIX; the disk check comes later.
 */
export async function listVisibleFiles(root) {
    try {
        const { stdout } = await run('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 256 * 2 ** 20 });
        // Unmerged entries are listed once per stage.
        return { paths: [...new Set(stdout.split('\0').filter(Boolean))], listing: 'git' };
    }
    catch {
        return { paths: await walkVisible(root), listing: 'walk' };
    }
}
/** Disk is the truth: listed paths that are gone, or are directories (submodules), drop out. */
export async function statVisible(root) {
    const { paths, listing } = await listVisibleFiles(root);
    // Synchronous on purpose: 10,502 lstat calls take ~30 ms in one loop and ~400 ms as promises
    // through the thread pool (oh-my-pi, Node 24). This runs on every query.
    const entries = [];
    for (const path of paths) {
        let stat;
        try {
            stat = lstatSync(join(root, path), { throwIfNoEntry: false });
        }
        catch {
            continue; // unreadable parent directory: not on disk as far as the index can tell
        }
        if (stat === undefined || (!stat.isFile() && !stat.isSymbolicLink()))
            continue;
        entries.push({ path, size: stat.size, mtimeMs: stat.mtimeMs, symlink: stat.isSymbolicLink() });
    }
    entries.sort((a, b) => (a.path < b.path ? -1 : 1)); // listed paths are unique
    return { entries, listing };
}
/** Repo-relative paths of configs named by a relative `extends` (string or array). */
function extendedConfigs(root, configPath, raw) {
    if (!isRecord(raw))
        return [];
    const values = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
    const bases = [];
    for (const value of values) {
        // Package specifiers resolve into node_modules, which is never part of the visible set.
        if (typeof value !== 'string' || !value.startsWith('.'))
            continue;
        const file = join(root, dirname(configPath), value.endsWith('.json') ? value : `${value}.json`);
        bases.push(toPosix(relative(root, file)));
    }
    return bases;
}
/** Whether the parsed config or any config it extends declares `include` or `files`. */
function hasExplicitInputs(ts, parsed) {
    const declares = (raw) => isRecord(raw) && (raw.include !== undefined || raw.files !== undefined);
    if (declares(parsed.raw))
        return true;
    // `include` and `files` are inherited through `extends`; the compiler lists the chain here.
    const configFile = parsed.options.configFile;
    const chain = isRecord(configFile) && Array.isArray(configFile.extendedSourceFiles)
        ? configFile.extendedSourceFiles
        : [];
    return chain.some((file) => typeof file === 'string' && declares(ts.readConfigFile(file, ts.sys.readFile).config));
}
/**
 * Every tsconfig the visible set holds, plus configs reached through project references, parsed
 * by TypeScript itself so `extends`, `include`/`exclude`/`files` and `allowJs` mean exactly what
 * they mean to the compiler. A base (a config other configs extend, that no reference names and
 * whose effective inputs are implicit, such as `tsconfig.base.json`) is not a project: its implicit
 * `include` of everything below it would claim files no real project compiles.
 */
function parseConfigs(root, ts, candidates) {
    const parsedConfigs = [];
    const errors = [];
    const extended = new Set();
    const referenced = new Set();
    const implicitInputs = new Set();
    const seen = new Set();
    const queue = [...candidates];
    const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined };
    while (queue.length > 0) {
        const path = queue.shift() ?? '';
        if (seen.has(path))
            continue;
        seen.add(path);
        const parsed = ts.getParsedCommandLineOfConfigFile(join(root, path), {}, host);
        if (!parsed) {
            errors.push(`${path}: cannot be read or parsed`);
            continue;
        }
        for (const error of parsed.errors) {
            const text = typeof error.messageText === 'string' ? error.messageText : error.messageText.messageText;
            // TS18003 "No inputs were found" is a fact about the config, not a parse problem.
            if (error.code !== 18003)
                errors.push(`${path}: ${text}`);
        }
        for (const base of extendedConfigs(root, path, parsed.raw))
            extended.add(base);
        if (!hasExplicitInputs(ts, parsed))
            implicitInputs.add(path);
        const files = new Set();
        for (const file of parsed.fileNames) {
            const rel = toPosix(relative(root, file));
            if (!rel.startsWith('..') && !isAbsolute(rel))
                files.add(rel);
        }
        parsedConfigs.push({ path, files });
        for (const reference of parsed.projectReferences ?? []) {
            const rel = toPosix(relative(root, ts.resolveProjectReferencePath(reference)));
            if (rel.startsWith('..') || isAbsolute(rel))
                continue;
            referenced.add(rel);
            queue.push(rel);
        }
    }
    const isBase = (path) => extended.has(path) && !referenced.has(path) && implicitInputs.has(path);
    return {
        configs: parsedConfigs.filter((config) => !isBase(config.path)),
        bases: parsedConfigs.filter((config) => isBase(config.path)).map((config) => config.path),
        errors,
    };
}
function depthOf(configPath) {
    const dir = dirname(configPath);
    return dir === '.' ? 0 : dir.split('/').length;
}
/** Nearest = deepest config directory; in one directory `tsconfig.json` wins, then name order. */
function nearer(a, b) {
    if (depthOf(a) !== depthOf(b))
        return depthOf(a) > depthOf(b);
    const aDefault = basename(a) === 'tsconfig.json';
    if (aDefault !== (basename(b) === 'tsconfig.json'))
        return aDefault;
    return a < b;
}
function ownerOf(path, configs) {
    let best = null;
    for (const config of configs) {
        if (config.files.has(path) && (best === null || nearer(config.path, best)))
            best = config.path;
    }
    return best;
}
function packageOf(path, packageDirs) {
    let dir = dirname(path);
    for (;;) {
        if (packageDirs.has(dir))
            return dir;
        if (dir === '.')
            return null;
        dir = dirname(dir);
    }
}
function classify(path, kind, tsconfig, impact) {
    if (!matchAny(impact.include, path))
        return { status: 'unindexed', reason: 'outside-index-scope' };
    if (kind === 'json' || kind === 'other')
        return { status: 'unindexed', reason: 'other-kind' };
    if (tsconfig === null)
        return { status: 'orphan', reason: 'no-tsconfig' };
    return { status: 'indexable', reason: null };
}
/**
 * Phase 1 SCAN (DESIGN §6.2.1): census of every visible file with size, mtime, kind, content hash,
 * owning package and owning tsconfig, classified indexable · orphan · unindexed with a reason.
 */
export async function scan(root, impact, ts, 
/**
 * Stat-level reuse (D22, freshness "stat" only): a file whose size and mtime equal this
 * fingerprint keeps its hash without being read. Rebuilds and `freshness: "hash"` pass nothing.
 */
fingerprint) {
    const started = performance.now();
    const { entries, listing } = await statVisible(root);
    const packageDirs = new Set(entries
        .filter((entry) => basename(entry.path) === 'package.json')
        .map((entry) => dirname(entry.path)));
    const configCandidates = entries
        .filter((entry) => TSCONFIG_NAME.test(basename(entry.path)))
        .filter((entry) => !entry.symlink && exclusionOf(entry.path, impact) === null)
        .map((entry) => entry.path);
    const { configs, bases, errors } = parseConfigs(root, ts, configCandidates);
    const records = await mapLimit(entries, HASH_CONCURRENCY, async (entry) => {
        const kind = kindOf(entry.path);
        const base = { path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs, kind };
        const pkg = packageOf(entry.path, packageDirs);
        const excluded = entry.symlink ? 'symlink' : exclusionOf(entry.path, impact);
        if (excluded !== null) {
            const row = {
                ...base,
                package: pkg,
                hash: null,
                tsconfig: null,
                status: 'unindexed',
                reason: excluded,
            };
            return row;
        }
        const known = fingerprint?.get(entry.path);
        const hash = known?.hash != null && known.size === entry.size && known.mtimeMs === entry.mtimeMs
            ? known.hash
            : await hashFile(join(root, entry.path), entry.size);
        const tsconfig = ownerOf(entry.path, configs);
        const row = {
            ...base,
            package: pkg,
            hash,
            tsconfig,
            ...classify(entry.path, kind, tsconfig, impact),
        };
        return row;
    });
    const reasons = {};
    const counts = { indexable: 0, orphan: 0, unindexed: 0 };
    for (const record of records) {
        counts[record.status]++;
        if (record.reason !== null)
            reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
    }
    return {
        records,
        summary: {
            scanned: records.length,
            ...counts,
            reasons,
            packages: packageDirs.size,
            tsconfigs: configs.map((config) => config.path).sort(),
            tsconfigBases: bases.sort(),
            tsconfigErrors: errors,
            listing,
            ms: Math.round(performance.now() - started),
        },
    };
}
