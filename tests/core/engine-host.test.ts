import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { isRecord } from '../../src/core/kernel/guards.js';
import {
  createEngineHost,
  type EngineHost,
  type EngineHostOptions,
} from '../../src/core/engine/host.js';
import {
  chooseRuntime,
  memoryLimitMb,
  runtimeArgs,
  type EngineRuntime,
} from '../../src/core/engine/runtime.js';
import {
  beginBuild,
  openPublished,
  publishBuild,
  readFiles,
  stagingPath,
  writeFiles,
} from '../../src/storage/sqlite.js';

const TEST_ENV = { ...process.env, EI_ENGINE_TEST_OPS: '1' };

async function withHost(
  options: Partial<EngineHostOptions>,
  body: (host: EngineHost) => Promise<void>,
): Promise<void> {
  const runtime = options.runtime ?? (await chooseRuntime());
  const host = createEngineHost({ memoryLimitMb: 512, env: TEST_ENV, ...options, runtime });
  try {
    await body(host);
  } finally {
    await host.stop();
  }
}

async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(20);
  }
}

/** A request that outlives `ms` fails the test; `withHost` then kills the child. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const late = Symbol('late');
  const settled = await Promise.race([promise, delay(ms, late)]);
  if (settled === late) assert.fail(`timed out waiting for ${what}`);
  return settled;
}

function field(value: unknown, key: string): unknown {
  assert.ok(isRecord(value), `reply value is an object: ${JSON.stringify(value)}`);
  return value[key];
}

function pidOf(value: unknown): number {
  const pid = field(value, 'pid');
  assert.equal(typeof pid, 'number');
  return Number(pid);
}

function bunOnPath(): EngineRuntime | null {
  try {
    const out = execFileSync('bun', ['-p', 'process.execPath + "\\n" + Bun.version'], {
      encoding: 'utf8',
    });
    const [command = '', version = ''] = out.trim().split('\n');
    return { kind: 'bun', command, version };
  } catch {
    return null;
  }
}

describe('engine runtime choice', () => {
  it('picks node >= 22.5 from PATH, else the current runtime at execPath', async () => {
    const chosen = await chooseRuntime();
    assert.equal(chosen.kind, 'node', 'the test machines have node >= 22.5 on PATH');
    const [major = 0, minor = 0] = chosen.version.split('.').map(Number);
    assert.ok(major > 22 || (major === 22 && minor >= 5), chosen.version);

    const fallback = await chooseRuntime({ ...process.env, PATH: '' }, '/opt/omp/bin/omp');
    assert.equal(fallback.command, '/opt/omp/bin/omp', 'no node on PATH: use this process runtime');
    assert.equal(fallback.kind, process.versions.bun === undefined ? 'node' : 'bun');
  });

  it('gives node the heap flag and bun nothing (bun is watched by RSS instead)', () => {
    assert.deepEqual(runtimeArgs({ kind: 'node', command: 'node', version: '24.1.0' }, 6144), [
      '--max-old-space-size=6144',
    ]);
    assert.deepEqual(runtimeArgs({ kind: 'node', command: 'node', version: '22.5.1' }, 100), [
      '--max-old-space-size=100',
      '--experimental-sqlite',
    ]);
    assert.deepEqual(runtimeArgs({ kind: 'bun', command: 'omp', version: '1.4.4' }, 6144), []);
  });

  it('memory limit: configured value, else min(8192, half of RAM)', () => {
    assert.equal(memoryLimitMb(3000, 64 * 2 ** 30), 3000);
    assert.equal(memoryLimitMb(null, 64 * 2 ** 30), 8192);
    assert.equal(memoryLimitMb(null, 8 * 2 ** 30), 4096);
  });
});

describe('engine host', () => {
  it('test ops are unreachable unless the child env sets EI_ENGINE_TEST_OPS=1; no request can set it', async () => {
    const unknown = (op: string) => ({
      ok: false,
      code: 'INVALID_INPUT',
      message: `unknown engine op: ${op}`,
    });
    const saved = process.env.EI_ENGINE_TEST_OPS;
    // Even set in the session's own environment, it is not inherited by the child.
    process.env.EI_ENGINE_TEST_OPS = '1';
    const host = createEngineHost({ runtime: await chooseRuntime(), memoryLimitMb: 256 });
    try {
      for (const op of ['allocate', 'stage-and-hang', 'constructor', '__proto__', 'toString']) {
        assert.deepEqual(await host.request(op, { cacheDir: tmpdir() }), unknown(op));
      }
      // Tool input reaches the engine only as op arguments, never as the child's environment.
      const smuggled = { EI_ENGINE_TEST_OPS: '1', env: { EI_ENGINE_TEST_OPS: '1' } };
      assert.equal((await host.request('ping', smuggled)).ok, true);
      assert.deepEqual(await host.request('allocate', smuggled), unknown('allocate'));
      assert.equal(host.status().starts, 1, 'one child answered every request');
    } finally {
      await host.stop();
      if (saved === undefined) delete process.env.EI_ENGINE_TEST_OPS;
      else process.env.EI_ENGINE_TEST_OPS = saved;
    }

    // Control: an explicit child env from the caller enables them.
    await withHost({ env: TEST_ENV }, async (enabled) => {
      assert.deepEqual(await enabled.request('stage-and-hang', {}), {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'cacheDir must be a non-empty string',
      });
    });
  });

  it('starts the child lazily on the chosen runtime and answers requests', async () => {
    await withHost({}, async (host) => {
      assert.equal(host.status().pid, null, 'no child before the first request');
      const reply = await host.request('ping');
      assert.ok(reply.ok, JSON.stringify(reply));
      const { runtime } = host.status();
      assert.equal(field(reply.value, 'runtime'), runtime.kind);
      assert.equal(field(reply.value, 'version'), runtime.version);
      assert.equal(pidOf(reply.value), host.status().pid);
      assert.equal(host.status().starts, 1);

      const unknown = await host.request('no-such-op');
      assert.deepEqual(unknown, {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'unknown engine op: no-such-op',
      });
      assert.equal((await host.request('ping')).ok, true, 'an op error leaves the child usable');
      assert.equal(host.status().starts, 1);
    });
  });

  it('loads TypeScript by absolute path inside the child (D44)', async () => {
    const path = createRequire(import.meta.url).resolve('typescript');
    await withHost({}, async (host) => {
      const reply = await host.request('typescript', { path });
      assert.ok(reply.ok, JSON.stringify(reply));
      assert.deepEqual(reply.value, { version: '5.9.3' });
      const bad = await host.request('typescript', { path: join(tmpdir(), 'no-typescript.js') });
      assert.equal(bad.ok, false);
    });
  });

  it('the child exits after a cold build; the next request runs in a new child from the published index', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-retire-')));
    const repo = join(work, 'repo');
    const typescriptPath = createRequire(import.meta.url).resolve('typescript');
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(
        join(repo, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
      );
      await writeFile(join(repo, 'src/a.ts'), 'export const a: number = 1;\n');
      const args = { typescriptPath, root: repo, cacheDir: join(work, 'cache') };
      await withHost({}, async (host) => {
        const cold = await host.request('index', args);
        assert.ok(cold.ok, JSON.stringify(cold));
        assert.equal(field(cold.value, 'action'), 'cold');
        await until(
          () => host.status().lastExit !== null,
          'the child to exit after the cold build',
        );
        assert.equal(host.status().lastExit?.reason, 'retired');
        assert.equal(host.status().pid, null, 'no child is kept after a cold build');

        await writeFile(join(repo, 'src/a.ts'), 'export const a: number = 2;\n');
        const update = await host.request('index', { ...args, freshness: 'hash' });
        assert.ok(update.ok, JSON.stringify(update));
        assert.equal(field(update.value, 'action'), 'update');
        assert.equal(host.status().starts, 2, 'a second child answered the update');
        assert.equal(host.status().lastExit?.reason, 'retired');

        // An update does not retire the child: the next one chains from its programs.
        const pid = host.status().pid;
        assert.notEqual(pid, null);
        await writeFile(join(repo, 'src/a.ts'), 'export const a: number = 3;\n');
        assert.equal((await host.request('index', { ...args, freshness: 'hash' })).ok, true);
        assert.equal(host.status().pid, pid);
        assert.equal(host.status().starts, 2);
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('node child above its heap limit fails with index-failed / memory-limit', async () => {
    await withHost({ memoryLimitMb: 64 }, async (host) => {
      const reply = await host.request('allocate');
      assert.deepEqual(
        { ok: reply.ok, code: !reply.ok && reply.code, reason: !reply.ok && reply.reason },
        { ok: false, code: 'index-failed', reason: 'memory-limit' },
      );
      assert.equal(host.status().lastExit?.reason, 'memory-limit');
      assert.equal(host.status().pid, null);
      assert.equal((await host.request('ping')).ok, true, 'restarted lazily after the kill');
      assert.equal(host.status().starts, 2);
    });
  });

  it('RSS watchdog kills a child without a heap flag above the limit (the Bun path)', async () => {
    // Runtime kind bun gets no heap flag; node stands in for bun so this runs where bun is absent.
    const runtime: EngineRuntime = { kind: 'bun', command: process.execPath, version: 'stand-in' };
    await withHost({ runtime, memoryLimitMb: 160, samplerMs: 50 }, async (host) => {
      const reply = await host.request('allocate');
      assert.equal(reply.ok, false);
      assert.equal(!reply.ok && reply.reason, 'memory-limit');
      assert.equal(!reply.ok && reply.code, 'index-failed');
      assert.equal(host.status().lastExit?.signal, 'SIGKILL', 'killed by the watchdog');
    });
  });

  const bun = bunOnPath();
  it(
    'real bun child runs and the watchdog contains it',
    { skip: !bun && !process.env.CI && 'bun not on PATH' },
    async () => {
      assert.ok(bun);
      await withHost({ runtime: bun, memoryLimitMb: 200, samplerMs: 50 }, async (host) => {
        const ping = await host.request('ping');
        assert.ok(ping.ok, JSON.stringify(ping));
        assert.equal(field(ping.value, 'runtime'), 'bun');
        const reply = await host.request('allocate');
        assert.equal(!reply.ok && reply.reason, 'memory-limit');
        assert.equal(host.status().lastExit?.signal, 'SIGKILL');
      });
    },
  );

  it('retires an idle child and starts a new one on the next request', async () => {
    await withHost({ idleMs: 100 }, async (host) => {
      const reply = await host.request('ping');
      assert.ok(reply.ok);
      const pid = pidOf(reply.value);
      await until(() => host.status().lastExit !== null, 'idle exit');
      assert.deepEqual(host.status().lastExit, { code: 0, signal: null, reason: 'idle' });
      assert.equal(host.status().pid, null);
      const again = await host.request('ping');
      assert.ok(again.ok);
      assert.notEqual(pidOf(again.value), pid);
      assert.equal(host.status().starts, 2);
    });
  });

  it('a child killed mid-request fails that request and is restarted lazily', async () => {
    const cacheDir = await realpath(await mkdtemp(join(tmpdir(), 'ei-host-kill-')));
    try {
      await withHost({}, async (host) => {
        let staged = false;
        const pending = host.request(
          'stage-and-hang',
          { cacheDir, paths: ['a.ts'] },
          {
            onProgress: (message) => {
              staged ||= message === 'staged';
            },
          },
        );
        await until(() => staged, 'staging progress');
        const pid = host.status().pid;
        assert.ok(pid);
        process.kill(pid, 'SIGKILL');
        const reply = await pending;
        assert.equal(reply.ok, false);
        assert.equal(!reply.ok && reply.code, 'index-failed');
        assert.equal(!reply.ok && reply.reason, 'crashed');
        const next = await host.request('ping');
        assert.ok(next.ok);
        assert.notEqual(pidOf(next.value), pid);
      });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('a child that hangs without exiting is killed at the request limit and reported', async () => {
    const cacheDir = await realpath(await mkdtemp(join(tmpdir(), 'ei-host-hang-')));
    try {
      await withHost({ env: TEST_ENV }, async (host) => {
        const ping = await host.request('ping');
        assert.ok(ping.ok);
        const first = pidOf(ping.value);
        const started = performance.now();
        // The test op stages a database and then never answers, and never exits.
        const reply = await within(
          host.request('stage-and-hang', { cacheDir, paths: ['a.ts'] }, { timeoutMs: 400 }),
          5_000,
          'the request limit to kill a hung child',
        );
        assert.equal(reply.ok, false);
        assert.equal(!reply.ok && reply.code, 'index-failed');
        assert.equal(!reply.ok && reply.reason, 'timeout');
        assert.match(
          !reply.ok ? reply.message : '',
          /did not answer 'stage-and-hang' within 400 ms/,
        );
        assert.ok(performance.now() - started < 5_000, 'reported at the limit, not later');
        assert.equal(host.status().lastExit?.reason, 'timeout');
        assert.equal(host.status().pid, null, 'the hung child is gone');
        const next = await host.request('ping');
        assert.ok(next.ok);
        assert.notEqual(pidOf(next.value), first, 'a new child answers');
      });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('a request that sets no limit still has one: the host default', async () => {
    const cacheDir = await realpath(await mkdtemp(join(tmpdir(), 'ei-host-default-')));
    try {
      await withHost({ env: TEST_ENV, requestMs: 300 }, async (host) => {
        const reply = await within(
          host.request('stage-and-hang', { cacheDir, paths: ['a.ts'] }),
          5_000,
          'the host default limit to end a request that sets none',
        );
        assert.equal(!reply.ok && reply.reason, 'timeout');
      });
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('interrupted build: killing the child mid-build leaves the published index intact', async () => {
    const cacheDir = await realpath(await mkdtemp(join(tmpdir(), 'ei-host-recovery-')));
    const record = (path: string) => ({
      path,
      size: 1,
      mtimeMs: 1,
      hash: null,
      kind: 'ts',
      package: null,
      tsconfig: null,
      status: 'indexable',
      reason: null,
    });
    try {
      const first = beginBuild(cacheDir);
      writeFiles(first, [record('published.ts')]);
      publishBuild(first, cacheDir);

      await withHost({}, async (host) => {
        let staged = false;
        const pending = host.request(
          'stage-and-hang',
          { cacheDir, paths: ['half-a.ts', 'half-b.ts'] },
          { onProgress: (message) => (staged ||= message === 'staged') },
        );
        await until(() => staged, 'the child to write its staging database');
        await host.stop();
        assert.equal((await pending).ok, false);
      });

      assert.ok(existsSync(stagingPath(cacheDir)), 'the interrupted staging database is left over');
      const published = openPublished(cacheDir);
      assert.ok(published, 'the previously published index still opens');
      try {
        assert.deepEqual(
          readFiles(published).map((file) => file.path),
          ['published.ts'],
        );
      } finally {
        published.close();
      }

      const rebuild = beginBuild(cacheDir);
      writeFiles(rebuild, [record('rebuilt.ts')]);
      publishBuild(rebuild, cacheDir);
      const after = openPublished(cacheDir);
      assert.ok(after);
      try {
        assert.deepEqual(
          readFiles(after).map((file) => file.path),
          ['rebuilt.ts'],
        );
      } finally {
        after.close();
      }
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });
});
