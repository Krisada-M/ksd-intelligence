import { spawn } from 'node:child_process';
import { isSecretEnvName } from '../audit/log.js';
import type { VerificationCheckConfig } from '../kernel/config.js';

export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface CheckRun {
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Set when the process could not be started (e.g. ENOENT). */
  spawnError: string | null;
  /** Interleaved stdout and stderr; the tail is kept when it exceeds the cap. */
  output: string;
  outputTruncated: boolean;
  pid: number | null;
}

export interface RunCheckOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

/** The inherited environment minus every variable whose name looks like a credential. */
export function checkEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isSecretEnvName(key)) continue;
    out[key] = value;
  }
  return out;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // Negative pid: the whole process group, so grandchildren (npm → sh → node) die too.
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: the group is already gone.
  }
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first === undefined) break;
      const excess = this.size - this.cap;
      this.truncated = true;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
        continue;
      }
      this.chunks[0] = first.subarray(excess);
      this.size -= excess;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Runs one allowlisted check without a shell: argv comes only from the owner's config.
 * Timeout or cancel kills the whole process group; so does a normal exit, so no orphan survives.
 */
export function runCheck(
  check: VerificationCheckConfig,
  root: string,
  options: RunCheckOptions = {},
): Promise<CheckRun> {
  const startedAt = new Date();
  const started = performance.now();
  const tail = new TailBuffer(options.maxOutputBytes ?? MAX_OUTPUT_BYTES);
  const [file, ...args] = check.command;

  return new Promise((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;
    let settled = false;

    const child = spawn(file ?? '', args, {
      cwd: root,
      env: checkEnvironment(options.env ?? process.env),
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, check.timeoutSec * 1000);

    const onAbort = (): void => {
      cancelled = true;
      killGroup(child.pid);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout.on('data', (chunk: Buffer) => tail.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => tail.push(chunk));

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        startedAt: startedAt.toISOString(),
        durationMs: Math.round(performance.now() - started),
        exitCode,
        signal,
        timedOut,
        cancelled,
        spawnError,
        output: tail.text(),
        outputTruncated: tail.truncated,
        pid: child.pid ?? null,
      });
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      spawnError = error.code ?? error.message;
      finish(null, null);
    });
    // A leader that exits while background children hold the pipes would block 'close'.
    child.on('exit', () => killGroup(child.pid));
    child.on('close', (code, signal) => finish(code, signal));
  });
}
