// Engine child process entry (D45). Reads requests from stdin, answers on stdout, one JSON per line.
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { isRecord } from '../kernel/guards.js';
import { doctorDeep } from '../indexing/doctor.js';
import { Indexer } from '../indexing/indexer.js';
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
