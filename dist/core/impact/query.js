import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { engineVersion } from '../engine/typescript.js';
import { Graph } from '../graph/graph.js';
import { repositoryLimits } from '../graph/limits.js';
import { isTestFile } from '../indexing/resolve.js';
import { matchAny, matchGlob } from '../kernel/glob.js';
import { isRecord } from '../kernel/guards.js';
import { readMeta } from '../../storage/sqlite.js';
/** G14: the traversal always runs to closure; this budget is the only stop. */
const NODE_BUDGET = 50_000;
const EDGE_KINDS = {
    CALLS: true,
    REFERENCES: true,
    CONSTRUCTS: true,
    IMPLEMENTS: true,
};
const STRENGTHS = {
    compiler: true,
    'syntax-exact': true,
    'scope-resolved': true,
    heuristic: true,
    unknown: true,
};
// docs/RISK.md §3.2, matched by specifier text (installed or not), subpaths included.
const SQL_MODULES = [
    'pg',
    'postgres',
    'mysql2',
    'better-sqlite3',
    'drizzle-orm',
    '@prisma/client',
    'kysely',
    'knex',
];
// An entry value that names code: a module path with or without a script extension.
const CODE_ENTRY = /(\.([cm]?[jt]sx?)|\/[^./]*)$|^[^.]*$/;
const ANONYMOUS_REASON = 'outside-index-scope: member of an anonymous object type is not indexed; reads through an alias of the parent type or a generic key may be missing';
/** `file#A.b.c` → `file#A.b`, `file#A`: the declarations that hold a member. */
function ancestors(key) {
    const hash = key.indexOf('#');
    const parts = key.slice(hash + 1).split('.');
    const out = [];
    for (let n = parts.length - 1; n > 0; n--)
        out.push(`${key.slice(0, hash + 1)}${parts.slice(0, n).join('.')}`);
    return out;
}
function declaration(row) {
    return {
        key: String(row.key),
        file: String(row.file),
        simple: String(row.simple),
        kind: String(row.kind),
        exported: Number(row.exported) === 1,
        start: Number(row.start_line),
        end: Number(row.end_line),
    };
}
function packagesOf(raw) {
    const parsed = JSON.parse(raw ?? '[]');
    if (!Array.isArray(parsed))
        throw new Error('index meta.packages is not a list');
    return parsed.filter((item) => isRecord(item) &&
        typeof item.dir === 'string' &&
        typeof item.private === 'boolean' &&
        Array.isArray(item.entries) &&
        Array.isArray(item.unresolved));
}
/**
 * `ei_impact` answers over one published index (DESIGN §6.2, golden "Result contract"). Pure reads:
 * no TypeScript program, no source or manifest file is opened. The caller owns `db`.
 */
export class ImpactQuery {
    db;
    impact;
    /** Prefix-less `import(x)`/`require(x)` sites: scoped per D55 to files nothing imports statically. */
    noImporter = [];
    /** Unmatched alias/package prefixes retain their pre-D55 conservative export scope. */
    unmatchedPrefix = [];
    graph;
    meta;
    engine;
    freshness;
    packageOf = new Map();
    // Gap sites by how golden P4 scopes them.
    everywhere = [];
    byPrefix = [];
    byFile = new Map();
    byInterface = new Map();
    byOwner = new Map();
    unresolvedByName = new Map();
    publicKeys = new Set();
    openPackages = [];
    /** Enclosing object literals: their whole-value users depend on every member (D55). */
    containers = new Set();
    /** Files some indexed file imports statically: a prefix-less import adds nothing there (D55). */
    staticImported = new Set();
    /** Entry files of workspace packages: loaded directly, never "unimported" (D55). */
    entryFiles = new Set();
    limits;
    nodeBudget;
    markers = new Map();
    boundaryCache = new Map();
    incomingCache = new Map();
    statements;
    constructor(db, impact, options = {}) {
        this.db = db;
        this.impact = impact;
        this.nodeBudget = options.nodeBudget ?? NODE_BUDGET;
        this.graph = new Graph(db);
        this.meta = readMeta(db);
        this.engine = {
            version: engineVersion(),
            typescript: this.meta.typescript_version ?? 'unknown',
            extractor: this.meta.extractor_stamp ?? 'unknown',
        };
        this.statements = {
            declaration: db.prepare('SELECT s.key, d.file, d.simple, d.kind, d.exported, d.start_line, d.end_line FROM symbols s JOIN declarations d ON d.id = s.id WHERE s.key = ?'),
            incoming: db.prepare(`SELECT s.key AS source, e.kind, e.strength FROM edges e JOIN symbols t ON t.id = e.target
         JOIN symbols s ON s.id = e.source WHERE t.key = ? AND e.kind NOT IN ('IMPORTS', 'TESTS')
         ORDER BY s.key, e.kind`),
            implements: db.prepare(`SELECT t.key FROM edges e JOIN symbols s ON s.id = e.source JOIN symbols t ON t.id = e.target
         WHERE s.key = ? AND e.kind = 'IMPLEMENTS'`),
            tokens: db.prepare("SELECT file, lines FROM name_tokens WHERE name = ? AND kind = 'str' ORDER BY file"),
            imports: db.prepare('SELECT specifier FROM external_imports WHERE file = ?'),
            census: db.prepare('SELECT status, reason FROM files WHERE path = ?'),
            lines: db.prepare('SELECT lines FROM file_index WHERE file = ?'),
            fileDecls: db.prepare(`SELECT s.key, d.file, d.simple, d.kind, d.exported, d.start_line, d.end_line FROM declarations d
         JOIN symbols s ON s.id = d.id WHERE d.file = ? AND d.name != '<module>' ORDER BY s.key`),
            outsideUser: db.prepare(`SELECT 1 FROM edges e JOIN symbols t ON t.id = e.target JOIN declarations d ON d.id = e.source
         WHERE t.key = ? AND d.file != ? AND e.kind NOT IN ('IMPORTS', 'TESTS') LIMIT 1`),
            tests: db.prepare(`SELECT DISTINCT d.file FROM edges e JOIN symbols t ON t.id = e.target
         JOIN declarations d ON d.id = e.source WHERE t.key = ? AND e.kind = 'TESTS' ORDER BY d.file`),
        };
        const hash = createHash('sha256');
        const indexable = [];
        for (const row of db
            .prepare('SELECT path, hash, package, status, reason FROM files ORDER BY path')
            .all()) {
            const path = String(row.path);
            hash.update(`${path}\0${String(row.hash)}\n`);
            this.packageOf.set(path, row.package === null ? null : String(row.package));
            if (row.status === 'indexable')
                indexable.push(path);
        }
        // The census lists git's tracked and untracked files, or walks the tree: untracked files are in.
        this.freshness = {
            workingTreeHash: hash.digest('hex'),
            includesUntracked: this.meta.listing === 'git' || this.meta.listing === 'walk',
        };
        for (const row of db
            .prepare('SELECT file, line, code, detail FROM gap_sites ORDER BY file, line, code, detail')
            .all()) {
            const gap = {
                file: String(row.file),
                line: Number(row.line),
                code: String(row.code),
                detail: String(row.detail),
            };
            this.classify(gap, indexable);
        }
        for (const row of db
            .prepare('SELECT file, line, name, reason FROM unresolved ORDER BY file, line, name')
            .all()) {
            const gap = {
                file: String(row.file),
                line: Number(row.line),
                code: String(row.reason),
                detail: String(row.name),
            };
            const list = this.unresolvedByName.get(gap.detail) ?? [];
            list.push(gap);
            this.unresolvedByName.set(gap.detail, list);
        }
        for (const row of db.prepare('SELECT file, kind FROM markers').all()) {
            const kind = String(row.kind);
            if (kind.startsWith('static-import:')) {
                this.staticImported.add(kind.slice('static-import:'.length));
                continue;
            }
            const kinds = this.markers.get(String(row.file)) ?? new Set();
            kinds.add(kind);
            this.markers.set(String(row.file), kinds);
        }
        const packages = packagesOf(this.meta.packages);
        for (const pkg of packages)
            for (const entry of pkg.entries)
                this.entryFiles.add(entry);
        this.publicSurface(packages, indexable);
        this.readContainers();
        this.limits = repositoryLimits(db);
    }
    classify(gap, indexable) {
        const push = (map, key) => {
            const list = map.get(key) ?? [];
            list.push(gap);
            map.set(key, list);
        };
        switch (gap.code) {
            case 'parse-error':
            case 'unsupported-syntax':
                this.everywhere.push(gap);
                return;
            case 'dynamic-import':
                if (gap.detail === '*')
                    this.noImporter.push(gap);
                else if (indexable.some((path) => path.startsWith(gap.detail)))
                    this.byPrefix.push(gap);
                else
                    this.unmatchedPrefix.push(gap);
                return;
            case 'cjs-require':
                if (gap.detail === '*')
                    this.noImporter.push(gap);
                else
                    push(this.byFile, gap.detail); // External package names scope no indexed file.
                return;
            case 'interface-dispatch':
                push(this.byInterface, gap.detail);
                return;
            case 'computed-member-access':
                push(this.byOwner, gap.detail);
                return;
            default:
                // An unknown code is still a gap; never let it vanish.
                this.everywhere.push(gap);
        }
    }
    /** golden P2: what is reachable from the entry of a workspace package that is not private. */
    publicSurface(packages, indexable) {
        const exportsOf = this.db.prepare('SELECT target FROM exports WHERE file = ?');
        for (const pkg of packages) {
            if (pkg.private)
                continue;
            const entries = new Set(pkg.entries);
            for (const value of pkg.unresolved) {
                const path = posix.join(pkg.dir, value);
                if (value.includes('*')) {
                    for (const file of indexable)
                        if (matchGlob(path, file))
                            entries.add(file);
                }
                else if (CODE_ENTRY.test(value)) {
                    // Build output the index does not hold: which exports it re-exports is unknown.
                    this.openPackages.push(pkg.dir === '.' ? '' : `${pkg.dir}/`);
                }
            }
            for (const entry of entries) {
                for (const row of exportsOf.all(entry))
                    this.publicKeys.add(String(row.target));
            }
        }
    }
    /**
     * Keys of object-literal holders: a module-level `const` or a property that ADR 0003 indexes
     * members under (kind `variable`/`property` with dotted children). Classes, interfaces, enums
     * and namespaces hold members too, but a use of the whole container does not read a member's
     * value, so they are not containers in the D55 sense.
     */
    readContainers() {
        const kindOf = this.db.prepare('SELECT d.kind AS kind FROM declarations d JOIN symbols s ON s.id = d.id WHERE s.key = ?');
        const dottedKinds = new Map();
        const parents = new Set();
        for (const row of this.db
            .prepare("SELECT s.key AS key, d.kind AS kind FROM declarations d JOIN symbols s ON s.id = d.id WHERE d.name LIKE '%.%'")
            .all()) {
            const key = String(row.key);
            dottedKinds.set(key, String(row.kind));
            for (let dot = key.indexOf('.', key.indexOf('#')); dot !== -1; dot = key.indexOf('.', dot + 1))
                parents.add(key.slice(0, dot));
        }
        for (const parent of parents) {
            const kind = dottedKinds.get(parent) ?? kindOf.get(parent)?.kind;
            if (kind === 'variable' || kind === 'property')
                this.containers.add(parent);
        }
    }
    isPublic(decl) {
        if ([decl.key, ...ancestors(decl.key)].some((key) => this.publicKeys.has(key)))
            return true;
        return decl.exported && this.openPackages.some((dir) => decl.file.startsWith(dir));
    }
    get(key) {
        const row = this.statements.declaration.get(key);
        return row === undefined ? undefined : declaration(row);
    }
    incoming(key) {
        let edges = this.incomingCache.get(key);
        if (edges === undefined) {
            edges = [];
            for (const row of this.statements.incoming.all(key)) {
                const kind = String(row.kind);
                const strength = String(row.strength);
                if (!Object.hasOwn(EDGE_KINDS, kind) || !Object.hasOwn(STRENGTHS, strength)) {
                    throw new Error(`index edge into ${key} has kind ${kind}, strength ${strength}`);
                }
                edges.push({
                    source: String(row.source),
                    kind: kind,
                    strength: strength,
                });
            }
            this.incomingCache.set(key, edges);
        }
        return edges;
    }
    /** Gap sites and unresolved records whose scope covers `decl` (golden P4). */
    gapsOf(decl) {
        const found = [...this.everywhere];
        if (decl.exported) {
            found.push(...this.unmatchedPrefix);
            for (const gap of this.byPrefix)
                if (decl.file.startsWith(gap.detail))
                    found.push(gap);
            // D55: a prefix-less import can load any module nothing else loads; package entries and
            // test files are loaded directly or by a runner, so they are out of this scope.
            if (!isTestFile(decl.file) &&
                !this.staticImported.has(decl.file) &&
                !this.entryFiles.has(decl.file)) {
                found.push(...this.noImporter);
            }
        }
        found.push(...(this.byFile.get(decl.file) ?? []));
        for (const row of this.statements.implements.all(decl.key)) {
            found.push(...(this.byInterface.get(String(row.key)) ?? []));
        }
        // A computed access on an object reads its members and the values stored in them.
        const owners = new Set([decl.key, ...ancestors(decl.key)]);
        for (const edge of this.incoming(decl.key)) {
            if (edge.kind !== 'REFERENCES')
                continue;
            owners.add(edge.source);
            for (const key of ancestors(edge.source))
                owners.add(key);
        }
        for (const owner of owners)
            found.push(...(this.byOwner.get(owner) ?? []));
        for (const record of this.unresolvedByName.get(decl.simple) ?? [])
            found.push(record);
        for (const row of this.statements.tokens.all(decl.simple)) {
            const lines = JSON.parse(String(row.lines));
            if (!Array.isArray(lines))
                continue;
            for (const line of lines) {
                found.push({
                    file: String(row.file),
                    line: Number(line),
                    code: 'string-name-match',
                    detail: decl.simple,
                });
            }
        }
        return found;
    }
    boundaries(file) {
        let found = this.boundaryCache.get(file);
        if (found === undefined) {
            const kinds = new Set(this.markers.get(file) ?? []);
            for (const row of this.statements.imports.all(file)) {
                const spec = String(row.specifier);
                if (SQL_MODULES.some((name) => spec === name || spec.startsWith(`${name}/`)))
                    kinds.add('boundary:sql');
            }
            if (/(^|\/)(android|ios)\//.test(file))
                kinds.add('boundary:native');
            found = [...kinds].sort();
            this.boundaryCache.set(file, found);
        }
        return found;
    }
    query(target, depth = 2) {
        if (typeof target !== 'string' ||
            target.trim() === '' ||
            !Number.isInteger(depth) ||
            depth < 1 ||
            depth > 10) {
            return {
                input: String(target),
                kind: 'failure',
                code: 'INVALID_INPUT',
                message: 'a target is a non-empty string; depth is 1–10',
            };
        }
        const asked = target.trim();
        const atLine = /^(.+):(\d+)$/.exec(asked);
        const file = atLine?.[1] ?? (asked.includes('#') ? asked.slice(0, asked.indexOf('#')) : asked);
        const census = this.statements.census.get(file);
        if (census !== undefined && census.status !== 'indexable') {
            return {
                input: asked,
                kind: 'guidance',
                code: 'target-not-found',
                message: `NOT INDEXED ${file} — ${String(census.reason ?? census.status)}`,
            };
        }
        if (census !== undefined && atLine === null && !asked.includes('#'))
            return this.fileAnswer(asked, depth);
        if (atLine !== null) {
            const lines = this.statements.lines.get(file);
            const n = Number(atLine[2]);
            if (lines === undefined || n < 1 || n > Number(lines.lines)) {
                return {
                    input: asked,
                    kind: 'guidance',
                    code: 'target-not-found',
                    message: `NOT FOUND ${asked}: no such line in an indexed file`,
                    nearest: [],
                };
            }
        }
        let match = this.graph.symbol(asked);
        let parentTarget;
        // D51: a member of an anonymous object type answers for its nearest indexed parent property.
        if (match.kind === 'not-found' &&
            atLine === null &&
            (asked.includes('#') || !asked.includes('/'))) {
            for (let parent = asked; parent.includes('.') && parentTarget === undefined;) {
                parent = parent.slice(0, parent.lastIndexOf('.'));
                const found = this.graph.symbol(parent);
                if (found.kind === 'found' && this.get(found.key)?.kind === 'property') {
                    match = found;
                    parentTarget = found.key;
                }
            }
        }
        if (match.kind === 'ambiguous') {
            return {
                input: asked,
                kind: 'guidance',
                code: 'ambiguous-target',
                message: `AMBIGUOUS ${asked} — ${match.candidates.length} declarations`,
                candidates: [...match.candidates].sort(),
            };
        }
        if (match.kind === 'not-found') {
            return {
                input: asked,
                kind: 'guidance',
                code: 'target-not-found',
                message: `NOT FOUND ${asked}`,
                nearest: match.nearest.slice(0, 5),
            };
        }
        return {
            input: asked,
            kind: 'result',
            value: this.impactOf(match.key, depth, parentTarget !== undefined),
            ...(atLine === null ? {} : { resolvedFromLine: Number(atLine[2]) }),
            ...(parentTarget === undefined ? {} : { parentTarget }),
        };
    }
    /** Up to five targets; one ambiguous or missing target does not block the others. */
    batch(targets, depth = 2) {
        if (!Array.isArray(targets) || targets.length < 1 || targets.length > 5) {
            return [{ input: '', kind: 'failure', code: 'INVALID_INPUT', message: 'give 1–5 targets' }];
        }
        return targets.map((target) => this.query(target, depth));
    }
    fileAnswer(file, depth) {
        const declarations = this.statements.fileDecls.all(file).map(declaration);
        const used = declarations.filter((decl) => decl.exported && this.statements.outsideUser.get(decl.key, file) !== undefined);
        return {
            input: file,
            kind: 'result',
            value: {
                file,
                results: used.map((decl) => this.impactOf(decl.key, depth, false)),
                remainder: declarations.length - used.length,
            },
        };
    }
    /**
     * Breadth first over incoming edges to closure: each symbol once at its shallowest depth,
     * stopped only by the node budget (G14); `depth` limits listing elsewhere. `heuristic` adds
     * the callers of interface members the symbol implements (golden C06).
     */
    traverse(key, heuristic) {
        const seen = new Set([key]);
        const levels = [];
        let frontier = [key];
        let capped = false;
        while (frontier.length > 0) {
            const level = [];
            for (const current of frontier) {
                for (const edge of this.dependentsOf(current, heuristic)) {
                    if (!heuristic && (edge.strength === 'heuristic' || edge.strength === 'unknown'))
                        continue;
                    if (seen.has(edge.source))
                        continue;
                    if (seen.size >= this.nodeBudget) {
                        capped = true;
                        continue;
                    }
                    seen.add(edge.source);
                    level.push({ key: edge.source, edge });
                }
            }
            if (level.length === 0)
                break;
            level.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            levels.push(level);
            frontier = level.map((item) => item.key);
        }
        return { levels, capped };
    }
    /**
     * Who depends on `key`: its incoming edges, plus the whole-value users of each enclosing
     * object literal (spread, passed, returned, assigned — D55; that is reach, not a gap).
     * `heuristic` adds the callers of interface members the symbol implements.
     */
    dependentsOf(key, heuristic) {
        const edges = [...this.incoming(key)];
        for (const parent of ancestors(key)) {
            if (!this.containers.has(parent))
                continue;
            edges.push(...this.incoming(parent));
        }
        if (!heuristic)
            return edges;
        for (const row of this.statements.implements.all(key)) {
            for (const edge of this.incoming(String(row.key))) {
                if (edge.kind === 'CALLS')
                    edges.push({ ...edge, strength: 'heuristic' });
            }
        }
        return edges;
    }
    impactOf(key, depth, anonymous) {
        const target = this.get(key);
        if (target === undefined)
            throw new Error(`indexed declaration missing: ${key}`);
        const listing = this.traverse(key, true);
        // DESIGN §7.2: reach is over compiler-grade edges only, so a path through a heuristic hop is out.
        const compiler = this.traverse(key, false);
        const reasons = new Set();
        for (const gap of this.gapsOf(target))
            reasons.add(`${gap.code}: ${gap.file}:${gap.line} — ${gap.detail}`);
        if (anonymous)
            reasons.add(ANONYMOUS_REASON);
        if (listing.capped || compiler.capped)
            reasons.add('depth-limit: node budget reached with callers unvisited');
        const byDepth = [];
        const listed = [];
        for (const level of listing.levels) {
            const nodes = [];
            for (const { key: source, edge } of level) {
                const decl = this.get(source);
                if (decl === undefined)
                    throw new Error(`indexed declaration missing: ${source}`);
                listed.push(decl);
                nodes.push({
                    symbol: source,
                    via: edge.kind,
                    strength: edge.strength,
                    span: { file: decl.file, startLine: decl.start, endLine: decl.end },
                    ...(this.gapsOf(decl).length > 0 ? { gapScoped: true } : {}),
                });
            }
            byDepth.push(nodes);
        }
        const reached = compiler.levels.flat().map((item) => item.key);
        const reachedFiles = new Set(reached.map((source) => source.slice(0, source.indexOf('#'))));
        const targetPackage = this.packageOf.get(target.file) ?? null;
        const packages = new Set([...reachedFiles].map((file) => this.packageOf.get(file) ?? null));
        const reach = {
            direct: compiler.levels[0]?.length ?? 0,
            total: reached.length,
            files: reachedFiles.size,
            packages: packages.size,
            crossPackage: [...packages].some((pkg) => pkg !== targetPackage),
            routes: reached.filter((source) => matchAny(this.impact.routes, source.slice(0, source.indexOf('#')))).length,
        };
        // golden P2 over the target and every listed symbol: factors may only raise the level.
        const involved = [target, ...listed];
        const factors = [];
        if (involved.some((decl) => this.isPublic(decl)))
            factors.push('public-export-surface');
        if (involved.some((decl) => matchAny(this.impact.routes, decl.file)))
            factors.push('route');
        if (involved.some((decl) => (this.packageOf.get(decl.file) ?? null) !== targetPackage))
            factors.push('cross-package');
        if (reach.total >= this.impact.manyCallers)
            factors.push('many-callers');
        const boundaries = new Set(involved.flatMap((decl) => this.boundaries(decl.file)));
        for (const kind of ['boundary:sql', 'boundary:native'])
            if (boundaries.has(kind))
                factors.push(kind);
        const tests = new Set(listed.filter((decl) => isTestFile(decl.file)).map((decl) => decl.file));
        for (const row of this.statements.tests.all(`${target.file}#<module>`))
            tests.add(String(row.file));
        const sortedReasons = [...reasons].sort();
        const incomplete = sortedReasons.length > 0;
        return {
            target: key,
            byDepth: byDepth.slice(0, depth),
            bridged: [],
            tests: [...tests].sort(),
            completeness: { status: incomplete ? 'partial' : 'complete', reasons: sortedReasons },
            reach,
            factors,
            limits: { ...this.limits },
            verdict: {
                level: incomplete ? 'unknown' : factors.length > 0 ? 'medium' : 'low',
                action: incomplete ? 'check-gaps' : factors.length > 0 ? 'run-tests' : 'proceed',
                zones: [],
                requiredActions: [],
                basis: [...sortedReasons, ...factors],
            },
            freshness: { ...this.freshness },
            engine: { ...this.engine },
        };
    }
}
