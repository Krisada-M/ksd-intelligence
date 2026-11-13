import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { setImmediate as yieldToEvents } from 'node:timers/promises';
import { isRecord } from '../kernel/guards.js';
import { scan } from '../workspace/scan.js';
import { FAILURE_FILE, SCHEMA_VERSION, beginBuild, beginUpdate, discardBuild, openPublished, publishBuild, readFiles, readMeta, readSchemaVersion, transaction, writeFiles, writeMeta, } from '../../storage/sqlite.js';
import { RECORD_TABLES, declarationNamesOf, deleteFileRecords, deleteOrphanSymbols, emptyCounts, filesImportingPrefix, filesReferencingNames, filesWithEdgesInto, filesWithUnresolvedImports, readFileIndex, recordWriter, simpleNameCounts, tableCounts, } from '../../storage/records.js';
import { fileDeclarations } from './declarations.js';
import { createAnalysisHost, groupPrograms, splitBy } from './program.js';
import { Resolver, isGlobalFile } from './resolve.js';
import { extractorStamp, impactConfigHash } from './stamp.js';
import { verifyIndex } from './verify.js';
const LOCKFILES = new Set([
    'package-lock.json',
    'npm-shrinkwrap.json',
    'bun.lock',
    'bun.lockb',
    'pnpm-lock.yaml',
    'yarn.lock',
]);
const CONFIG_NAME = /^(?:tsconfig(?:\..+)?|jsconfig)\.json$/;
const CODE_OR_JSON = /\.(?:[cm]?[jt]sx?|json)$/;
/** A change to one of these can change how any file resolves: always a cold build. */
function isConfigLevel(path) {
    const name = basename(path);
    return (CONFIG_NAME.test(name) ||
        name === 'package.json' ||
        name === 'ei.config.json' ||
        LOCKFILES.has(name));
}
function diffCensus(before, now) {
    const old = new Map(before.map((file) => [file.path, file]));
    const drift = {
        added: new Set(),
        changed: new Set(),
        deleted: new Set(),
        touched: 0,
        reclassified: null,
    };
    for (const record of now) {
        const previous = old.get(record.path);
        old.delete(record.path);
        if (previous === undefined) {
            drift.added.add(record.path);
            continue;
        }
        const sameStat = previous.size === record.size && previous.mtimeMs === record.mtimeMs;
        // Never-read files (secret, excluded) change by size and mtime alone.
        const sameContent = record.hash === null ? sameStat : previous.hash === record.hash;
        if (!sameContent)
            drift.changed.add(record.path);
        else if (!sameStat)
            drift.touched++;
        const sameClass = previous.kind === record.kind &&
            previous.status === record.status &&
            previous.package === record.package &&
            previous.tsconfig === record.tsconfig &&
            previous.reason === record.reason;
        if (!sameClass)
            drift.reclassified ??= record.path;
    }
    for (const path of old.keys())
        drift.deleted.add(path);
    return drift;
}
function rowsOf(file, sf, declarations, resolution) {
    if (sf === undefined || declarations === undefined || resolution === undefined) {
        // Owned by a tsconfig that could not be read: listed with a reason, never dropped.
        return {
            index: {
                file,
                extraction: 'not-in-program',
                lines: 0,
                surface: '',
                global: false,
                counts: {
                    indexed: 0,
                    local: 0,
                    external: 0,
                    externalUnresolved: 0,
                    unresolvedOther: 0,
                    outsideScope: 0,
                },
            },
            declarations: [],
            edges: [],
            unresolved: [],
            gaps: [],
            tokens: [],
            externalImports: [],
            exports: [],
        };
    }
    const parseError = resolution.gaps.some((gap) => gap.code === 'parse-error');
    return {
        index: {
            file,
            extraction: parseError ? 'parse-error' : 'ok',
            lines: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
            surface: resolution.surface,
            global: resolution.global,
            counts: resolution.counts,
        },
        declarations: declarations.declarations,
        edges: resolution.edges,
        unresolved: resolution.unresolved,
        gaps: resolution.gaps,
        tokens: resolution.tokens,
        externalImports: resolution.externalImports,
        exports: resolution.exports,
    };
}
function roundPhases(phases) {
    const rounded = { ...phases };
    for (const key of Object.keys(rounded)) {
        rounded[key] = Math.round(rounded[key]);
    }
    return rounded;
}
/**
 * The builders' first semantic pass, one program at a time, yielding between files. A program
 * gives its checker back as soon as its pass ends, so the peak is one checker, as in the cold
 * resolve. Stops only when its session is released.
 */
async function drainInBackground(groups, cancelled, drained) {
    for (const group of groups) {
        while (!cancelled()) {
            if (group.builder?.getSemanticDiagnosticsOfNextAffectedFile() === undefined)
                break;
            await yieldToEvents();
        }
        if (cancelled())
            return false;
        drained(group);
    }
    return true;
}
/**
 * The index pipeline of one repository (DESIGN §6.2.1): scan → extract-local → resolve → verify →
 * publish. It keeps the programs of the last build, so the next update chains from them.
 */
export class Indexer {
    ts;
    root;
    cacheDir;
    options;
    session = null;
    generation = 0;
    constructor(ts, root, cacheDir, options = {}) {
        this.ts = ts;
        this.root = root;
        this.cacheDir = cacheDir;
        this.options = options;
    }
    get memoryBudgetMb() {
        return this.options.memoryBudgetMb;
    }
    /** Waits for background work; true when the builders are ready to chain from. */
    async settle() {
        return (await this.session?.drained) ?? false;
    }
    /** Cancels background work and releases every retained program before returning. */
    async release() {
        const session = this.session;
        this.session = null;
        this.generation++;
        await session?.drained;
    }
    async index(request) {
        const progress = request.onProgress ?? (() => undefined);
        const phases = {
            scan: 0,
            program: 0,
            extract: 0,
            resolve: 0,
            verify: 0,
            publish: 0,
        };
        const stamp = extractorStamp(this.ts.version, impactConfigHash(request.impact));
        const started = performance.now();
        const published = this.readPublished();
        const fingerprint = request.freshness === 'stat' && published !== null
            ? new Map(published.files.map((file) => [file.path, file]))
            : undefined;
        progress('scan');
        const census = await scan(this.root, request.impact, this.ts, fingerprint);
        phases.scan = performance.now() - started;
        const drift = published === null ? null : diffCensus(published.files, census.records);
        const coldReason = this.coldReason(request, stamp, published, drift);
        // Programs of another build (an older publish, another stamp) are of no use: free them.
        if (this.session !== null && published?.meta.build_id !== this.session.buildId) {
            this.session = null;
        }
        if (coldReason !== null || published === null || drift === null) {
            this.session = null; // free the old programs before building new ones
            return this.cold(census, coldReason ?? 'no published index', stamp, request, phases, progress);
        }
        const contentDrift = drift.added.size + drift.changed.size + drift.deleted.size;
        if (contentDrift === 0 && drift.touched === 0) {
            return this.unchanged(census, phases);
        }
        if (contentDrift === 0) {
            return this.update(census, drift, published, stamp, request, phases, progress, null);
        }
        const programStarted = performance.now();
        progress('program');
        const prepared = await this.preparePrograms(census.records, drift, published);
        phases.program = performance.now() - programStarted;
        if (prepared.programs === null || prepared.late !== null) {
            return this.cold(census, prepared.late ?? 'program change', stamp, request, phases, progress);
        }
        return this.update(census, drift, published, stamp, request, phases, progress, {
            programs: prepared.programs,
            warm: prepared.builderReady,
        });
    }
    /**
     * Programs for an update, chained from the session's when it belongs to the published build.
     * The session is dropped here: the new programs share every unchanged parsed file, and the old
     * checkers would double the memory of the update.
     */
    async preparePrograms(census, drift, published) {
        const session = this.session;
        this.session = null;
        const builderReady = session !== null && (await session.drained);
        const changedAbs = new Set([...drift.changed, ...drift.added, ...drift.deleted].map((path) => join(this.root, path)));
        const programs = this.createPrograms(census, session, changedAbs, builderReady);
        const late = programs === null
            ? 'a tsconfig without a program owns files'
            : this.programLevelChange(programs.groups, drift, published, session);
        return { programs, late, builderReady };
    }
    readPublished() {
        const db = openPublished(this.cacheDir);
        if (db === null)
            return null;
        try {
            const schema = readSchemaVersion(db);
            if (schema !== SCHEMA_VERSION)
                return { schema, meta: {}, files: [] };
            return { schema, meta: readMeta(db), files: readFiles(db) };
        }
        finally {
            db.close();
        }
    }
    coldReason(request, stamp, published, drift) {
        if (request.full === true)
            return 'full rebuild requested';
        if (published === null || drift === null)
            return 'no published index';
        if (published.schema !== SCHEMA_VERSION)
            return `index schema ${published.schema}`;
        if (published.meta.extractor_stamp !== stamp)
            return 'extractor stamp changed';
        for (const path of [...drift.changed, ...drift.added, ...drift.deleted]) {
            if (isConfigLevel(path))
                return `config changed: ${path}`;
        }
        if (drift.reclassified !== null)
            return `classification changed: ${drift.reclassified}`;
        return null;
    }
    /**
     * Checks that need the new programs. A changed global file, or a changed file that a program
     * compiles without indexing it (its types reach indexed files untracked), forces a cold build.
     */
    programLevelChange(groups, drift, published, session) {
        const wasIndexable = new Set(published.files.filter((file) => file.status === 'indexable').map((file) => file.path));
        const globalBefore = this.globalFiles();
        for (const path of [...drift.changed, ...drift.added, ...drift.deleted]) {
            if (globalBefore.has(path))
                return `global file changed: ${path}`;
            const abs = join(this.root, path);
            const group = groups.find((g) => g.program.getSourceFile(abs) !== undefined);
            const sf = group?.program.getSourceFile(abs);
            if (group !== undefined && sf !== undefined) {
                if (isGlobalFile(this.ts, group.program.getTypeChecker(), sf)) {
                    return `global file changed: ${path}`;
                }
            }
            if (wasIndexable.has(path) || drift.added.has(path) || !CODE_OR_JSON.test(path))
                continue;
            // Without the old programs a deleted file's membership is unknown: assume it was compiled.
            const wasCompiled = session === null
                ? drift.deleted.has(path)
                : session.groups.some((g) => g.program.getSourceFile(abs) !== undefined);
            if (sf !== undefined || wasCompiled)
                return `non-indexed program file changed: ${path}`;
        }
        return null;
    }
    globalFiles() {
        const db = openPublished(this.cacheDir);
        if (db === null)
            return new Set();
        try {
            const found = new Set();
            for (const [file, info] of readFileIndex(db))
                if (info.global)
                    found.add(file);
            return found;
        }
        finally {
            db.close();
        }
    }
    /**
     * Programs for the census. With a session: its groups again, each chained from its old program
     * and builder so unchanged files are not parsed again. Null when an owning tsconfig has no group.
     */
    createPrograms(census, session, changedAbs, builderReady = false) {
        const owners = new Map();
        const versions = new Map();
        for (const record of census) {
            if (record.hash !== null)
                versions.set(join(this.root, record.path), record.hash);
            if (record.status !== 'indexable' || record.tsconfig === null)
                continue;
            const list = owners.get(record.tsconfig) ?? [];
            list.push(record.path);
            owners.set(record.tsconfig, list);
        }
        let plans;
        let errors = [];
        if (session === null) {
            const grouping = groupPrograms(this.ts, this.root, owners);
            errors = grouping.errors;
            plans = grouping.groups.map((group) => ({ group, previous: null }));
        }
        else {
            const known = new Set(session.groups.flatMap((group) => group.configs));
            for (const config of owners.keys())
                if (!known.has(config))
                    return null;
            plans = session.groups.map((previous) => ({
                previous,
                group: {
                    configs: previous.configs,
                    options: previous.options,
                    rootNames: previous.configs
                        .flatMap((config) => owners.get(config) ?? [])
                        .map((path) => join(this.root, path))
                        .sort(),
                },
            }));
        }
        const groups = plans.map(({ group, previous }) => {
            const host = createAnalysisHost(this.ts, group.options, versions, changedAbs, previous?.program);
            const program = this.ts.createProgram({
                rootNames: group.rootNames,
                options: group.options,
                host,
                oldProgram: previous?.program,
            });
            // Chained from a drained builder it reports the affected set (D43).
            const builder = builderReady && previous?.builder !== undefined
                ? this.ts.createSemanticDiagnosticsBuilderProgram(program, host, previous.builder)
                : undefined;
            return { ...group, program, builder };
        });
        return { groups, errors };
    }
    repoPath(fileName) {
        const rel = relative(this.root, fileName);
        const posixRel = sep === '/' ? rel : rel.split(sep).join('/');
        if (posixRel.startsWith('..') || isAbsolute(posixRel))
            return null;
        return posixRel.includes('node_modules/') ? null : posixRel;
    }
    workspacePackages(census) {
        const names = new Set();
        for (const record of census) {
            if (basename(record.path) !== 'package.json' || record.hash === null)
                continue;
            try {
                const pkg = JSON.parse(readFileSync(join(this.root, record.path), 'utf8'));
                if (isRecord(pkg) && typeof pkg.name === 'string')
                    names.add(pkg.name);
            }
            catch {
                // an unreadable package.json names no package
            }
        }
        return names;
    }
    /** The program group of each indexable file's owning tsconfig. */
    ownerGroups(groups, census) {
        const byConfig = new Map();
        for (const group of groups)
            for (const config of group.configs)
                byConfig.set(config, group);
        const result = new Map();
        for (const record of census) {
            if (record.status !== 'indexable' || record.tsconfig === null)
                continue;
            const group = byConfig.get(record.tsconfig);
            if (group !== undefined)
                result.set(record.path, group);
        }
        return result;
    }
    /**
     * Each indexable file's group, source file and a resolver of the group's current program
     * (made on demand; a lightened group gets a new one).
     */
    sources(groups, census, scope) {
        const ownerGroup = this.ownerGroups(groups, census);
        const resolvers = new WeakMap();
        return (path) => {
            const group = ownerGroup.get(path);
            const sf = group?.program.getSourceFile(join(this.root, path));
            if (group === undefined || sf === undefined)
                return undefined;
            let resolver = resolvers.get(group.program);
            if (resolver === undefined) {
                resolver = new Resolver(this.ts, group.program, scope);
                resolvers.set(group.program, resolver);
            }
            return { group, sf, resolver };
        };
    }
    /** Over this share of the memory budget, programs give up their checkers between batches. */
    memoryTight(fraction) {
        const budget = this.options.memoryBudgetMb;
        return budget !== undefined && process.memoryUsage().rss / 2 ** 20 > budget * fraction;
    }
    /**
     * Swaps a group's program for one sharing every parsed file but no checker: what a later update
     * needs to reuse unchanged files, at a fraction of the memory. A drained builder keeps its
     * signatures and references without the program, and the next update chains from it.
     */
    lighten(group) {
        group.builder?.releaseProgram?.();
        const host = createAnalysisHost(this.ts, group.options, new Map(), new Set(), group.program);
        group.program = this.ts.createProgram({
            rootNames: group.rootNames,
            options: group.options,
            host,
            oldProgram: group.program,
        });
    }
    cold(census, reason, stamp, request, phases, progress) {
        let started = performance.now();
        progress('program');
        const programs = this.createPrograms(census.records, null, new Set());
        if (programs === null)
            throw new Error('cold build: tsconfig grouping returned no programs');
        phases.program += performance.now() - started;
        const indexable = census.records.filter((r) => r.status === 'indexable').map((r) => r.path);
        const declarationNames = new Set();
        const scope = {
            root: this.root,
            indexable: new Set(indexable),
            declarationNames,
            workspacePackages: this.workspacePackages(census.records),
        };
        const ownerGroup = this.ownerGroups(programs.groups, census.records);
        const sourceFile = (path) => ownerGroup.get(path)?.program.getSourceFile(join(this.root, path));
        // EXTRACT-LOCAL: declarations from each file's syntax tree; their names scope the resolve.
        progress('extract', { files: indexable.length });
        started = performance.now();
        const declarations = new Map();
        for (const path of indexable) {
            const sf = sourceFile(path);
            if (sf === undefined)
                continue;
            const found = fileDeclarations(this.ts, sf, path);
            declarations.set(path, found);
            for (const declaration of found.declarations) {
                if (declaration.kind !== 'module')
                    declarationNames.add(declaration.simple);
            }
        }
        phases.extract = performance.now() - started;
        // RESOLVE one program at a time; a resolved program gives up its checker before the next.
        progress('resolve', { files: indexable.length });
        started = performance.now();
        const db = beginBuild(this.cacheDir);
        try {
            writeFiles(db, census.records);
            const writer = recordWriter(db);
            transaction(db, () => {
                for (const path of indexable) {
                    if (sourceFile(path) === undefined)
                        writer.write(rowsOf(path, undefined, undefined, undefined));
                }
                for (const group of programs.groups) {
                    const resolver = new Resolver(this.ts, group.program, scope);
                    for (const path of indexable) {
                        if (ownerGroup.get(path) !== group)
                            continue;
                        const sf = sourceFile(path);
                        if (sf === undefined)
                            continue;
                        writer.write(rowsOf(path, sf, declarations.get(path), resolver.resolveFile(sf)));
                    }
                    this.lighten(group);
                }
            });
            phases.resolve = performance.now() - started;
            return this.finish(db, census, writer.inserted, stamp, request, phases, progress, programs, {
                action: 'cold',
                reason,
                drift: { added: 0, changed: 0, deleted: 0 },
                resolvedFiles: indexable.length,
                builderAffected: null,
                supplemented: 0,
                programs: programs.groups.length,
            });
        }
        catch (error) {
            discardBuild(db, this.cacheDir);
            throw error;
        }
    }
    update(census, drift, published, stamp, request, phases, progress, created) {
        const indexableNow = new Set(census.records.filter((r) => r.status === 'indexable').map((r) => r.path));
        const changed = [...drift.changed, ...drift.added].filter((path) => indexableNow.has(path));
        const removed = published.files
            .filter((file) => file.status === 'indexable' && !indexableNow.has(file.path))
            .map((file) => file.path);
        // TypeScript's affected set: only from builders chained to this session's drained ones.
        let started = performance.now();
        let builderAffected = null;
        if (created?.warm === true) {
            builderAffected = new Set();
            for (const group of created.programs.groups) {
                for (;;) {
                    const next = group.builder?.getSemanticDiagnosticsOfNextAffectedFile();
                    if (next === undefined)
                        break;
                    const affected = next.affected;
                    const files = 'fileName' in affected ? [affected] : affected.getSourceFiles();
                    for (const sf of files) {
                        const path = this.repoPath(sf.fileName);
                        if (path !== null && indexableNow.has(path))
                            builderAffected.add(path);
                    }
                }
            }
        }
        phases.program += performance.now() - started;
        const db = beginUpdate(this.cacheDir);
        if (db === null) {
            this.session = null;
            return this.cold(census, 'published index unreadable', stamp, request, phases, progress);
        }
        try {
            started = performance.now();
            progress('extract', { files: changed.length });
            const before = tableCounts(db);
            const oldIndex = readFileIndex(db);
            const oldKeys = declarationNamesOf(db, [...changed, ...removed]);
            const nameCounts = simpleNameCounts(db);
            const oldNames = new Set([...nameCounts].filter(([, n]) => n > 0).map(([name]) => name));
            for (const simple of oldKeys.values()) {
                nameCounts.set(simple, (nameCounts.get(simple) ?? 0) - 1);
            }
            const declarationNames = new Set();
            const scope = {
                root: this.root,
                indexable: indexableNow,
                declarationNames,
                workspacePackages: this.workspacePackages(census.records),
            };
            const sourceOf = created === null
                ? () => undefined
                : this.sources(created.programs.groups, census.records, scope);
            const newKeys = new Map();
            for (const path of changed) {
                const source = sourceOf(path);
                if (source === undefined)
                    continue;
                for (const declaration of source.resolver.declarationsOf(source.sf).declarations) {
                    newKeys.set(declaration.key, declaration.simple);
                    nameCounts.set(declaration.simple, (nameCounts.get(declaration.simple) ?? 0) + 1);
                }
            }
            for (const [name, n] of nameCounts) {
                if (n > 0 && name !== '<module>')
                    declarationNames.add(name);
            }
            // Names whose declarations appeared or disappeared change other files' resolution.
            const names = new Set();
            for (const [key, simple] of oldKeys)
                if (!newKeys.has(key))
                    names.add(simple);
            for (const [key, simple] of newKeys)
                if (!oldKeys.has(key))
                    names.add(simple);
            names.delete('<module>');
            const entering = [...declarationNames].filter((name) => !oldNames.has(name));
            phases.extract = performance.now() - started;
            // Affected set: changed files, the builder's set, and this repository's cross-checks.
            started = performance.now();
            const pending = new Set(changed);
            for (const path of builderAffected ?? [])
                pending.add(path);
            if (drift.added.size + drift.deleted.size > 0) {
                // A new or removed file can change how imports resolve.
                for (const path of filesWithUnresolvedImports(db))
                    pending.add(path);
                const prefixes = [...drift.added, ...drift.deleted].map((path) => dirname(path) === '.' ? '' : `${dirname(path)}/`);
                for (const path of filesImportingPrefix(db, prefixes))
                    pending.add(path);
            }
            for (const path of filesWithEdgesInto(db, removed))
                pending.add(path);
            for (const path of filesReferencingNames(db, names))
                pending.add(path);
            if (entering.length > 0) {
                // A name new to the index: files mentioning it were never recorded under it.
                for (const path of indexableNow) {
                    const text = sourceOf(path)?.sf.text;
                    if (text !== undefined && entering.some((name) => text.includes(name)))
                        pending.add(path);
                }
            }
            progress('resolve', { files: pending.size });
            const resolved = new Map();
            const viaSurface = new Set();
            // A file's surface counts as changed when its text-derived surface differs, or when one of
            // its inferred-type declarations uses a file whose surface changed: an inferred type can
            // change with no edit to the file itself, and its dependents then see a different type
            // (D47: no builder state to say so).
            const changedSurface = new Set();
            const inferredKeysOf = new Map();
            const isInferredSource = (keys, source) => {
                if (keys.has(source))
                    return true;
                for (let dot = source.indexOf('.', source.indexOf('#')); dot !== -1;) {
                    if (keys.has(source.slice(0, dot)))
                        return true;
                    dot = source.indexOf('.', dot + 1);
                }
                return false;
            };
            const leaks = (path) => {
                const keys = inferredKeysOf.get(path);
                const rows = resolved.get(path);
                if (keys === undefined || rows === undefined)
                    return false;
                return rows.edges.some((edge) => changedSurface.has(edge.target.slice(0, edge.target.indexOf('#'))) &&
                    isInferredSource(keys, edge.source));
            };
            let next = [];
            const markChanged = (start) => {
                const stack = [start];
                for (let path = stack.pop(); path !== undefined; path = stack.pop()) {
                    if (changedSurface.has(path))
                        continue;
                    changedSurface.add(path);
                    for (const dependent of filesWithEdgesInto(db, [path])) {
                        if (resolved.has(dependent)) {
                            if (leaks(dependent))
                                stack.push(dependent);
                        }
                        else if (!pending.has(dependent)) {
                            viaSurface.add(dependent);
                            next.push(dependent);
                        }
                    }
                }
            };
            // Rounds: each resolves its files one program at a time, like the cold build, and queues
            // the dependents of changed surfaces for the next round.
            let round = [...pending];
            while (round.length > 0) {
                next = [];
                const byGroup = new Map();
                for (const path of new Set(round)) {
                    if (resolved.has(path) || !indexableNow.has(path))
                        continue;
                    const group = sourceOf(path)?.group;
                    byGroup.set(group, [...(byGroup.get(group) ?? []), path]);
                }
                for (const [group, paths] of byGroup) {
                    for (const path of paths) {
                        const source = sourceOf(path);
                        const resolution = source?.resolver.resolveFile(source.sf);
                        resolved.set(path, rowsOf(path, source?.sf, source?.resolver.declarationsOf(source.sf), resolution));
                        if (resolution === undefined)
                            continue;
                        inferredKeysOf.set(path, resolution.inferredKeys);
                        if (oldIndex.get(path)?.surface !== resolution.surface || leaks(path)) {
                            markChanged(path);
                        }
                    }
                    if (group !== undefined && this.memoryTight(0.5))
                        this.lighten(group);
                }
                round = next;
            }
            // affected-set-supplemented: dependents of a changed surface the builder did not report.
            const supplemented = builderAffected === null
                ? 0
                : [...viaSurface].filter((path) => !builderAffected.has(path)).length;
            const expected = emptyCounts();
            transaction(db, () => {
                db.exec('DELETE FROM files');
                writeFiles(db, census.records);
                const deleted = deleteFileRecords(db, [...resolved.keys(), ...removed]);
                const writer = recordWriter(db);
                for (const rows of resolved.values())
                    writer.write(rows);
                for (const table of RECORD_TABLES) {
                    expected[table] = before[table] - deleted[table] + writer.inserted[table];
                }
                deleteOrphanSymbols(db);
            });
            phases.resolve = performance.now() - started;
            const total = Number(published.meta.supplemented_total ?? 0) + supplemented;
            writeMeta(db, { supplemented_total: String(total) });
            const groups = created?.programs ?? null;
            return this.finish(db, census, expected, stamp, request, phases, progress, groups, {
                action: 'update',
                reason: `${changed.length} changed · ${removed.length} removed · ${resolved.size} resolved`,
                drift: {
                    added: drift.added.size,
                    changed: drift.changed.size,
                    deleted: drift.deleted.size,
                },
                resolvedFiles: resolved.size,
                builderAffected: builderAffected?.size ?? null,
                supplemented,
                programs: groups?.groups.length ?? Number(published.meta.programs ?? 0),
            }, created?.warm === true);
        }
        catch (error) {
            discardBuild(db, this.cacheDir);
            throw error;
        }
    }
    /**
     * VERIFY, then PUBLISH; on failure the previous index stays and the report lists why.
     * `programs` null: the census alone changed and the session's programs stay current.
     */
    finish(db, census, produced, stamp, request, phases, progress, programs, outcome, drained = false) {
        progress('verify');
        let started = performance.now();
        const verify = this.options.verify ?? verifyIndex;
        const problems = verify(db, { ...produced, files: census.records.length });
        phases.verify = performance.now() - started;
        const counts = tableCounts(db);
        if (problems.length > 0) {
            discardBuild(db, this.cacheDir);
            const failure = { at: new Date().toISOString(), reason: `${outcome.action} build`, problems };
            writeFileSync(join(this.cacheDir, FAILURE_FILE), JSON.stringify(failure), { mode: 0o600 });
            return {
                ...outcome,
                action: 'failed',
                census: census.summary,
                counts,
                problems,
                phases: roundPhases(phases),
            };
        }
        progress('publish');
        started = performance.now();
        const buildId = randomUUID();
        writeMeta(db, {
            build_id: buildId,
            built_at: (programs === null ? readMeta(db).built_at : undefined) ?? new Date().toISOString(),
            last_action: outcome.action,
            last_reason: outcome.reason,
            extractor_stamp: stamp,
            typescript_version: this.ts.version,
            config_hash: impactConfigHash(request.impact),
            runtime: `${process.versions.bun === undefined ? 'node' : 'bun'} ${process.versions.bun ?? process.versions.node}`,
            scan_ms: String(Math.round(phases.scan)),
            listing: census.summary.listing,
            tsconfigs: JSON.stringify(census.summary.tsconfigs),
            tsconfig_bases: JSON.stringify(census.summary.tsconfigBases),
            tsconfig_errors: JSON.stringify([
                ...census.summary.tsconfigErrors,
                ...(programs?.errors ?? []),
            ]),
            programs: String(outcome.programs),
            ...(programs === null ? {} : { program_split: JSON.stringify(splitBy(programs.groups)) }),
            resolved_last: String(outcome.resolvedFiles),
            builder_affected_last: outcome.builderAffected === null ? '' : String(outcome.builderAffected),
            supplemented_last: String(outcome.supplemented),
            phases: JSON.stringify(roundPhases(phases)),
            // Peak of the engine process so far. maxRSS is in kilobytes (libuv converts macOS's bytes);
            // shortcut: Bun's unit on macOS is not verified, check it in the macOS run.
            peak_rss_mb: String(Math.round(process.resourceUsage().maxRSS / 1024)),
        });
        publishBuild(db, this.cacheDir);
        if (programs !== null)
            rmSync(join(this.cacheDir, FAILURE_FILE), { force: true });
        phases.publish = performance.now() - started;
        if (programs !== null)
            this.keepSession(programs.groups, buildId, drained);
        else if (this.session !== null)
            this.session.buildId = buildId;
        return { ...outcome, census: census.summary, counts, problems, phases: roundPhases(phases) };
    }
    /**
     * Keeps what the next update chains from: each group's parsed files and a drained builder.
     * After an update that chained, the builders are current. After a cold build or a new session's
     * update, new builders run their first semantic pass in the background.
     */
    keepSession(groups, buildId, drained) {
        if (drained && groups.every((group) => group.builder !== undefined)) {
            for (const group of groups)
                this.lighten(group); // a published build needs no checker
            this.session = { buildId, groups, drained: Promise.resolve(true) };
            return;
        }
        for (const group of groups) {
            const host = createAnalysisHost(this.ts, group.options, new Map(), new Set(), group.program);
            group.builder = this.ts.createSemanticDiagnosticsBuilderProgram(group.program, host);
        }
        const generation = ++this.generation;
        const drainedFully = drainInBackground(groups, () => generation !== this.generation, (group) => this.lighten(group));
        this.session = { buildId, groups, drained: drainedFully };
    }
    unchanged(census, phases) {
        return {
            action: 'unchanged',
            reason: 'no drift',
            census: census.summary,
            drift: { added: 0, changed: 0, deleted: 0 },
            resolvedFiles: 0,
            builderAffected: null,
            supplemented: 0,
            programs: this.session?.groups.length ?? 0,
            counts: emptyCounts(),
            problems: [],
            phases: roundPhases(phases),
        };
    }
}
