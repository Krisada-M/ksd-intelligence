import { execFile } from 'node:child_process';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';
const run = promisify(execFile);
/**
 * D45: `node` from PATH when it is >= 22.5 (built-in SQLite, faster checker); otherwise the
 * runtime this process runs on, which inside OMP is its own Bun executable.
 */
export async function chooseRuntime(env = process.env, execPath = process.execPath) {
    try {
        const { stdout } = await run('node', ['-p', 'process.execPath + "\\n" + process.versions.node'], {
            env,
            timeout: 10_000,
        });
        const [command, version = ''] = stdout.trim().split('\n');
        const [major = 0, minor = 0] = version.split('.').map(Number);
        if (command && (major > 22 || (major === 22 && minor >= 5))) {
            return { kind: 'node', command, version };
        }
    }
    catch {
        // no usable node on PATH; fall through to this process's runtime
    }
    const bun = process.versions.bun;
    return bun === undefined
        ? { kind: 'node', command: execPath, version: process.versions.node }
        : { kind: 'bun', command: execPath, version: bun };
}
/** Arguments placed before the child script. */
export function runtimeArgs(runtime, memoryLimitMb) {
    if (runtime.kind === 'bun')
        return [];
    const args = [`--max-old-space-size=${memoryLimitMb}`];
    // node:sqlite is unflagged from 22.13 / 23.4; earlier releases need the flag.
    const [major = 0, minor = 0] = runtime.version.split('.').map(Number);
    if ((major === 22 && minor < 13) || (major === 23 && minor < 4)) {
        args.push('--experimental-sqlite');
    }
    return args;
}
/** `impact.maxMemoryMb`, or when null the smaller of 8,192 MB and half of physical RAM (D45). */
export function memoryLimitMb(configured, totalBytes = totalmem()) {
    return configured ?? Math.min(8192, Math.floor(totalBytes / 2 / 2 ** 20));
}
