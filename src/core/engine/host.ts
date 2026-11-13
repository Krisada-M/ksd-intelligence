import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { encode, lineReader, parseMessage, type Message } from './protocol.js';
import { runtimeArgs, type EngineRuntime } from './runtime.js';

const run = promisify(execFile);

const IDLE_MS = 10 * 60_000;
/** D35: the longest a tool call waits (first build); every request has at least this limit. */
const REQUEST_MS = 60_000;
const IDLE_KILL_GRACE_MS = 5_000;
const STDERR_TAIL = 4_096;
const NODE_OOM = /heap out of memory|Reached heap limit|Allocation failed - JavaScript heap/i;

export type ExitReason = 'memory-limit' | 'crashed' | 'idle' | 'retired' | 'stopped' | 'timeout';

export type EngineReply =
  { ok: true; value: unknown } | { ok: false; code: string; message: string; reason?: ExitReason };

export interface EngineHostOptions {
  runtime: EngineRuntime;
  memoryLimitMb: number;
  /** Child environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  /** Time limit of a request that sets none (default 60 s, D35). */
  requestMs?: number;
  /** RSS sampling period of the watchdog. */
  samplerMs?: number;
  /** The parent RSS watchdog runs for Bun children (Bun has no heap flag); tests force it on. */
  watchdog?: boolean;
}

export interface EngineStatus {
  runtime: EngineRuntime;
  memoryLimitMb: number;
  pid: number | null;
  starts: number;
  lastExit: { code: number | null; signal: string | null; reason: ExitReason } | null;
}

export interface RequestOptions {
  onProgress?: (message: string, data: unknown) => void;
  /**
   * Time limit of this request. A child that has not answered by then is killed (it may be hung
   * with no exit), every request pending on it fails with reason `timeout`, and the next
   * request starts a new child. Defaults to the host's `requestMs`.
   */
  timeoutMs?: number;
}

export interface EngineHost {
  request(op: string, args?: unknown, options?: RequestOptions): Promise<EngineReply>;
  stop(): Promise<void>;
  status(): EngineStatus;
}

interface Pending {
  resolve(reply: EngineReply): void;
  onProgress?: (message: string, data: unknown) => void;
  timer: NodeJS.Timeout;
}

interface Child {
  proc: ChildProcessWithoutNullStreams;
  pending: Map<string, Pending>;
  stderr: string;
  killedFor: ExitReason | null;
  /** The limit that expired, for the failure message. */
  timedOut: { op: string; ms: number } | null;
  sampler?: NodeJS.Timeout;
  exited: Promise<void>;
}

async function rssMb(pid: number): Promise<number | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number.parseInt(stdout.trim(), 10);
    return Number.isNaN(kb) ? null : kb / 1024;
  } catch {
    return null; // process already gone
  }
}

/**
 * Parent side of the engine (D45): one child process, spawned on the first request and again
 * on the first request after it exits, killed above its memory limit, retired when idle.
 */
export function createEngineHost(options: EngineHostOptions): EngineHost {
  const { runtime, memoryLimitMb } = options;
  const idleMs = options.idleMs ?? IDLE_MS;
  const requestMs = options.requestMs ?? REQUEST_MS;
  const watchdog = options.watchdog ?? runtime.kind === 'bun';
  // Test-only child ops need an env the caller passes explicitly; the session's own variables
  // never enable them.
  const inherited = { ...process.env };
  delete inherited.EI_ENGINE_TEST_OPS;
  const base = options.env ?? inherited;
  // Under OMP the runtime is the omp executable, which only acts as plain Bun when asked to.
  // The child sizes its background work to the limit it is killed at.
  const limited = { ...base, EI_MEMORY_LIMIT_MB: String(memoryLimitMb) };
  const env = runtime.kind === 'bun' ? { ...limited, BUN_BE_BUN: '1' } : limited;
  const childScript = fileURLToPath(new URL('./child.js', import.meta.url));

  let current: Child | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  let sequence = 0;
  let starts = 0;
  let lastExit: EngineStatus['lastExit'] = null;
  let retiring: Child | null = null;

  function kill(child: Child, reason: ExitReason): void {
    child.killedFor ??= reason;
    child.proc.kill('SIGKILL');
  }

  function onExit(child: Child, code: number | null, signal: string | null): void {
    clearInterval(child.sampler);
    if (current === child) current = null;
    if (retiring === child) retiring = null;
    const oom = signal === 'SIGABRT' || code === 134 || NODE_OOM.test(child.stderr);
    const reason = child.killedFor ?? (oom ? 'memory-limit' : 'crashed');
    lastExit = { code, signal, reason };
    const tail = child.stderr.trim().slice(-300);
    const message =
      reason === 'memory-limit'
        ? `engine exceeded its memory limit of ${memoryLimitMb} MB (${runtime.kind})`
        : reason === 'timeout' && child.timedOut !== null
          ? `engine did not answer '${child.timedOut.op}' within ${child.timedOut.ms} ms and was killed`
          : `engine child exited (${signal ?? `code ${code}`}, ${reason})${tail ? `: ${tail}` : ''}`;
    for (const pending of child.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: 'index-failed', message, reason });
    }
    child.pending.clear();
  }

  function onMessage(child: Child, message: Message): void {
    const pending = child.pending.get(message.id);
    if (!pending || message.type === 'request') return;
    if (message.type === 'progress') {
      pending.onProgress?.(message.message, message.data);
      return;
    }
    clearTimeout(pending.timer);
    child.pending.delete(message.id);
    pending.resolve(
      message.type === 'result'
        ? { ok: true, value: message.value }
        : { ok: false, code: message.code, message: message.message },
    );
    if (message.type === 'result' && message.retire === true && child.pending.size === 0) {
      retire(child, 'retired');
    } else if (child.pending.size === 0) armIdle(child);
  }

  /** Later requests start a fresh child; this one exits when its stdin closes. */
  function retire(child: Child, reason: 'idle' | 'retired'): void {
    if (current === child) current = null;
    retiring = child;
    child.killedFor ??= reason;
    child.proc.stdin.end();
    setTimeout(() => kill(child, reason), IDLE_KILL_GRACE_MS).unref();
  }

  function armIdle(child: Child): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (current === child && child.pending.size === 0) retire(child, 'idle');
    }, idleMs);
    idleTimer.unref();
  }

  function startSampler(child: Child): void {
    let busy = false;
    child.sampler = setInterval(() => {
      const pid = child.proc.pid;
      if (busy || pid === undefined) return;
      busy = true;
      void rssMb(pid).then((mb) => {
        busy = false;
        if (mb !== null && mb > memoryLimitMb) kill(child, 'memory-limit');
      });
    }, options.samplerMs ?? 1_000);
    child.sampler.unref();
  }

  function spawnChild(): Child {
    const proc = spawn(runtime.command, [...runtimeArgs(runtime, memoryLimitMb), childScript], {
      env,
      stdio: 'pipe',
    });
    let markExited = (): void => undefined;
    const child: Child = {
      proc,
      pending: new Map(),
      stderr: '',
      killedFor: null,
      timedOut: null,
      exited: new Promise((resolve) => (markExited = resolve)),
    };
    let done = false;
    const finish = (code: number | null, signal: string | null): void => {
      if (done) return;
      done = true;
      onExit(child, code, signal);
      markExited();
    };
    proc.stdout.on(
      'data',
      lineReader((line) => {
        const message = parseMessage(line);
        if (typeof message === 'string') {
          child.stderr = `${child.stderr}[protocol] ${message}: ${line.slice(0, 200)}\n`.slice(
            -STDERR_TAIL,
          );
          return;
        }
        onMessage(child, message);
      }),
    );
    proc.stderr.on('data', (chunk: Buffer) => {
      child.stderr = (child.stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    // A write to a dying child fails with EPIPE; 'close' then reports the exit to every request.
    proc.stdin.on('error', () => undefined);
    proc.on('error', (error) => {
      child.stderr += error.message;
      if (proc.pid === undefined) finish(null, null);
    });
    proc.on('close', finish);
    if (watchdog) startSampler(child);
    starts++;
    return child;
  }

  function request(op: string, args?: unknown, opts: RequestOptions = {}): Promise<EngineReply> {
    // A retiring child still holds its memory: start the next one only after it has exited.
    if (retiring !== null) return retiring.exited.then(() => request(op, args, opts));
    clearTimeout(idleTimer);
    const child = (current ??= spawnChild());
    const id = String(++sequence);
    const ms = opts.timeoutMs ?? requestMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.timedOut ??= { op, ms };
        kill(child, 'timeout');
      }, ms);
      child.pending.set(id, { resolve, onProgress: opts.onProgress, timer });
      child.proc.stdin.write(encode({ type: 'request', id, op, args }));
    });
  }

  async function stop(): Promise<void> {
    clearTimeout(idleTimer);
    const children = [current, retiring].filter((child) => child !== null);
    for (const child of children) kill(child, 'stopped');
    await Promise.all(children.map((child) => child.exited));
  }

  function status(): EngineStatus {
    return { runtime, memoryLimitMb, pid: current?.proc.pid ?? null, starts, lastExit };
  }

  return { request, stop, status };
}
