// Engine child process entry (D45). Reads requests from stdin, answers on stdout, one JSON per line.
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../kernel/guards.js';
import { MODULE_NAME, fileDeclarations, } from '../indexing/declarations.js';
import { doctorDeep } from '../indexing/doctor.js';
import { Indexer } from '../indexing/indexer.js';
import { declarationSurfaces } from '../indexing/surface.js';
import { beginBuild, writeFiles } from '../../storage/sqlite.js';
import { encode, lineReader, parseMessage } from './protocol.js';
import { loadWorkspace } from './workspace.js';
class OpError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
// stdout is the protocol channel; anything a dependency logs goes to stderr instead.
console.log = console.error;
function send(message) {
    process.stdout.write(encode(message));
}
function stringArg(args, key) {
    const value = args[key];
    if (typeof value !== 'string' || value === '') {
        throw new OpError('INVALID_INPUT', `${key} must be a non-empty string`);
    }
    return value;
}
// D44: TypeScript is always loaded by absolute path; a bare specifier does not resolve here.
async function importByPath(path) {
    const loaded = await import(pathToFileURL(path).href);
    return isRecord(loaded) && isRecord(loaded.default) ? loaded.default : loaded;
}
function isCompiler(value) {
    return (isRecord(value) &&
        typeof value.version === 'string' &&
        typeof value.createProgram === 'function' &&
        typeof value.createSemanticDiagnosticsBuilderProgram === 'function');
}
const compilers = new Map();
async function compilerAt(path) {
    let ts = compilers.get(path);
    if (ts === undefined) {
        const loaded = await importByPath(path);
        if (!isCompiler(loaded)) {
            throw new OpError('typescript-invalid', `${path} is not a TypeScript compiler`);
        }
        ts = loaded;
        compilers.set(path, ts);
    }
    return ts;
}
function indexerFor(args, ts) {
    const budget = Number(process.env.EI_MEMORY_LIMIT_MB);
    return new Indexer(ts, stringArg(args, 'root'), stringArg(args, 'cacheDir'), {
        memoryBudgetMb: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    });
}
function parseSyntaxOnly(ts, file, text) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let parseError = null;
    const host = {
        getSourceFile: (name) => (name === file ? sf : undefined),
        getDefaultLibFileName: () => 'lib.d.ts',
        writeFile: () => { },
        getCurrentDirectory: () => '',
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
        fileExists: (name) => name === file,
        readFile: (name) => (name === file ? text : undefined),
    };
    const program = ts.createProgram([file], { noLib: true, noResolve: true, types: [], allowJs: true, checkJs: false }, host);
    const diag = program.getSyntacticDiagnostics(sf)[0];
    if (diag !== undefined) {
        const pos = diag.start ?? 0;
        const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
        parseError = {
            line,
            detail: ts.flattenDiagnosticMessageText(diag.messageText, ' '),
        };
    }
    const extracted = fileDeclarations(ts, sf, file);
    const surfaces = declarationSurfaces(ts, sf, extracted);
    const declMap = new Map();
    for (const decl of extracted.declarations)
        declMap.set(decl.key, decl);
    return { declarations: declMap, surfaces, parseError };
}
function spanOfDecl(decl) {
    return { file: decl.file, startLine: decl.startLine, endLine: decl.endLine };
}
// Builds leave a child holding the programs' memory; the host retires it after each (D50).
const BUILD_OPS = new Set(['index', 'doctor']);
// A Map, not an object literal: an op name such as `constructor` must not reach a prototype member.
const ops = new Map([
    [
        'ping',
        () => ({
            pid: process.pid,
            runtime: process.versions.bun === undefined ? 'node' : 'bun',
            version: process.versions.bun ?? process.versions.node,
            rssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
        }),
    ],
    [
        'typescript',
        async (args) => {
            const ts = await importByPath(stringArg(args, 'path'));
            if (!isRecord(ts) || typeof ts.version !== 'string') {
                throw new OpError('typescript-invalid', 'module at path has no string `version` export');
            }
            return { version: ts.version };
        },
    ],
    [
        'index',
        async (args, progress) => {
            const indexer = indexerFor(args, await compilerAt(stringArg(args, 'typescriptPath')));
            const workspace = await loadWorkspace(indexer.root);
            return indexer.index({
                impact: workspace.config.impact,
                full: args.full === true,
                freshness: args.freshness === 'stat' ? 'stat' : 'hash',
                onProgress: progress,
            });
        },
    ],
    [
        'doctor',
        async (args, progress) => {
            const ts = await compilerAt(stringArg(args, 'typescriptPath'));
            const indexer = indexerFor(args, ts);
            const workspace = await loadWorkspace(indexer.root);
            const size = typeof args.differential === 'number' ? args.differential : 0;
            return doctorDeep(ts, indexer, workspace.config.impact, {
                differential: size,
                onProgress: progress,
            });
        },
    ],
    [
        'changes-diff',
        async (args) => {
            const ts = await compilerAt(stringArg(args, 'typescriptPath'));
            const rawFiles = Array.isArray(args.files) ? args.files : [];
            const symbols = [];
            const parseErrors = [];
            for (const entry of rawFiles) {
                if (!isRecord(entry) ||
                    typeof entry.path !== 'string' ||
                    typeof entry.status !== 'string') {
                    continue;
                }
                const path = entry.path;
                const status = entry.status;
                const oldPath = typeof entry.oldPath === 'string' ? entry.oldPath : undefined;
                const baseText = typeof entry.baseText === 'string' ? entry.baseText : undefined;
                const workText = typeof entry.workText === 'string' ? entry.workText : undefined;
                if (status === 'A') {
                    if (workText === undefined)
                        continue;
                    const work = parseSyntaxOnly(ts, path, workText);
                    if (work.parseError !== null) {
                        parseErrors.push({ file: path, ...work.parseError });
                    }
                    let addedCount = 0;
                    for (const [key, decl] of work.declarations) {
                        if (decl.name === MODULE_NAME)
                            continue;
                        symbols.push({ symbol: key, change: 'added', span: spanOfDecl(decl) });
                        addedCount++;
                    }
                    if (addedCount === 0) {
                        const mod = work.declarations.get(`${path}#${MODULE_NAME}`);
                        symbols.push({
                            symbol: `${path}#${MODULE_NAME}`,
                            change: 'added',
                            ...(mod === undefined ? {} : { span: spanOfDecl(mod) }),
                        });
                    }
                }
                else if (status === 'D') {
                    if (baseText === undefined)
                        continue;
                    const base = parseSyntaxOnly(ts, path, baseText);
                    let removedCount = 0;
                    for (const [key, decl] of base.declarations) {
                        if (decl.name === MODULE_NAME)
                            continue;
                        symbols.push({ symbol: key, change: 'removed', span: spanOfDecl(decl) });
                        removedCount++;
                    }
                    if (removedCount === 0) {
                        const mod = base.declarations.get(`${path}#${MODULE_NAME}`);
                        symbols.push({
                            symbol: `${path}#${MODULE_NAME}`,
                            change: 'removed',
                            ...(mod === undefined ? {} : { span: spanOfDecl(mod) }),
                        });
                    }
                }
                else if (status === 'R') {
                    if (baseText !== undefined) {
                        const baseFile = oldPath ?? path;
                        const base = parseSyntaxOnly(ts, baseFile, baseText);
                        let removedCount = 0;
                        for (const [key, decl] of base.declarations) {
                            if (decl.name === MODULE_NAME)
                                continue;
                            symbols.push({ symbol: key, change: 'removed', span: spanOfDecl(decl) });
                            removedCount++;
                        }
                        if (removedCount === 0) {
                            const mod = base.declarations.get(`${baseFile}#${MODULE_NAME}`);
                            symbols.push({
                                symbol: `${baseFile}#${MODULE_NAME}`,
                                change: 'removed',
                                ...(mod === undefined ? {} : { span: spanOfDecl(mod) }),
                            });
                        }
                    }
                    if (workText !== undefined) {
                        const work = parseSyntaxOnly(ts, path, workText);
                        if (work.parseError !== null) {
                            parseErrors.push({ file: path, ...work.parseError });
                        }
                        let addedCount = 0;
                        for (const [key, decl] of work.declarations) {
                            if (decl.name === MODULE_NAME)
                                continue;
                            symbols.push({ symbol: key, change: 'added', span: spanOfDecl(decl) });
                            addedCount++;
                        }
                        if (addedCount === 0) {
                            const mod = work.declarations.get(`${path}#${MODULE_NAME}`);
                            symbols.push({
                                symbol: `${path}#${MODULE_NAME}`,
                                change: 'added',
                                ...(mod === undefined ? {} : { span: spanOfDecl(mod) }),
                            });
                        }
                    }
                }
                else if (status === 'M') {
                    if (baseText === undefined || workText === undefined)
                        continue;
                    const base = parseSyntaxOnly(ts, path, baseText);
                    const work = parseSyntaxOnly(ts, path, workText);
                    if (work.parseError !== null) {
                        parseErrors.push({ file: path, ...work.parseError });
                    }
                    // Whitespace/comment-only edit on TS (or non-JSDoc JS) leaves fileTokenHash identical.
                    if (base.surfaces.fileTokenHash === work.surfaces.fileTokenHash) {
                        continue;
                    }
                    const baseSurfaces = base.surfaces.declarations;
                    const workSurfaces = work.surfaces.declarations;
                    for (const [key, bSurf] of baseSurfaces) {
                        const wSurf = workSurfaces.get(key);
                        if (wSurf === undefined) {
                            const bDecl = base.declarations.get(key);
                            symbols.push({
                                symbol: key,
                                change: 'removed',
                                ...(bDecl === undefined ? {} : { span: spanOfDecl(bDecl) }),
                            });
                        }
                        else if (bSurf.surfaceHash !== wSurf.surfaceHash) {
                            const wDecl = work.declarations.get(key);
                            symbols.push({
                                symbol: key,
                                change: 'signature-changed',
                                ...(wDecl === undefined ? {} : { span: spanOfDecl(wDecl) }),
                            });
                        }
                        else if (bSurf.bodyHash !== wSurf.bodyHash) {
                            const wDecl = work.declarations.get(key);
                            symbols.push({
                                symbol: key,
                                change: 'modified',
                                ...(wDecl === undefined ? {} : { span: spanOfDecl(wDecl) }),
                            });
                        }
                    }
                    for (const [key] of workSurfaces) {
                        if (!baseSurfaces.has(key)) {
                            const wDecl = work.declarations.get(key);
                            symbols.push({
                                symbol: key,
                                change: 'added',
                                ...(wDecl === undefined ? {} : { span: spanOfDecl(wDecl) }),
                            });
                        }
                    }
                    if (base.surfaces.moduleHash !== work.surfaces.moduleHash) {
                        const mod = work.declarations.get(`${path}#${MODULE_NAME}`);
                        symbols.push({
                            symbol: `${path}#${MODULE_NAME}`,
                            change: 'modified',
                            ...(mod === undefined ? {} : { span: spanOfDecl(mod) }),
                        });
                    }
                }
            }
            return { symbols, parseErrors };
        },
    ],
]);
// Test-only ops: memory pressure and a build interrupted mid-write. Read once at start-up from
// this process's own environment, which only the parent's spawn call sets; requests cannot.
if (process.env.EI_ENGINE_TEST_OPS === '1') {
    ops.set('allocate', async (_args, progress) => {
        const held = [];
        for (let mb = 1; mb <= 1024; mb++) {
            held.push(new Array(131_072).fill(mb)); // ~1 MB of heap, every page touched
            if (mb % 32 === 0) {
                progress('allocated', { mb });
                await delay(5);
            }
        }
        return { allocatedMb: held.length };
    });
    ops.set('stage-and-hang', (args, progress) => {
        const db = beginBuild(stringArg(args, 'cacheDir'));
        const records = Array.isArray(args.paths)
            ? args.paths.map((path) => ({
                path: String(path),
                size: 0,
                mtimeMs: 0,
                hash: null,
                kind: 'ts',
                package: null,
                tsconfig: null,
                status: 'indexable',
                reason: null,
            }))
            : [];
        writeFiles(db, records);
        progress('staged', { rows: records.length });
        return new Promise(() => undefined); // never publishes; the test kills this process
    });
}
async function handle(id, op, args) {
    const run = ops.get(op);
    if (!run) {
        send({ type: 'error', id, code: 'INVALID_INPUT', message: `unknown engine op: ${op}` });
        return;
    }
    const retire = BUILD_OPS.has(op);
    try {
        const value = await run(isRecord(args) ? args : {}, (message, data) => send({ type: 'progress', id, message, data }));
        send({ type: 'result', id, value, retire });
    }
    catch (error) {
        const code = error instanceof OpError ? error.code : 'index-failed';
        send({
            type: 'error',
            id,
            code,
            message: error instanceof Error ? error.message : String(error),
            retire,
        });
    }
}
process.stdin.on('data', lineReader((line) => {
    const message = parseMessage(line);
    if (typeof message === 'string' || message.type !== 'request') {
        console.error(`engine: ignored line (${typeof message === 'string' ? message : message.type})`);
        return;
    }
    void handle(message.id, message.op, message.args);
}));
// The parent closes stdin to retire the child, and the pipe closes if the parent dies.
process.stdin.on('end', () => process.exit(0));
