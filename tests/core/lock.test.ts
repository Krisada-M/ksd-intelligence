import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LOCK_FILE, acquireBuildLock, readLockHolder } from '../../src/core/engine/lock.js';

const LOCK_MODULE = new URL('../../src/core/engine/lock.js', import.meta.url).href;

// A separate process that tries the lock, reports, and holds it until its stdin closes.
const HOLDER = `
  import { acquireBuildLock } from ${JSON.stringify(LOCK_MODULE)};
  const result = acquireBuildLock(process.env.LOCK_DIR);
  console.log(result.ok ? 'held' : 'refused');
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
`;

function startHolder(cacheDir: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', HOLDER], {
    env: { ...process.env, LOCK_DIR: cacheDir },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    proc.stdout?.once('data', (chunk: Buffer) => {
      if (chunk.toString().trim() === 'held') resolve(proc);
      else reject(new Error(`holder could not take the lock: ${chunk.toString()}`));
    });
    proc.once('error', reject);
  });
}

function exited(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => proc.once('exit', () => resolve()));
}

describe('build lock', () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await realpath(await mkdtemp(join(tmpdir(), 'ei-lock-')));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('one holder at a time; release frees it', () => {
    const first = acquireBuildLock(cacheDir);
    assert.ok(first.ok);
    const holder = readLockHolder(cacheDir);
    assert.equal(holder?.pid, process.pid);
    assert.ok(holder && !Number.isNaN(Date.parse(holder.startedAt)), 'start time recorded');

    const second = acquireBuildLock(cacheDir);
    assert.deepEqual(second, { ok: false, holder }, 'a live holder refuses a second builder');

    first.release();
    assert.equal(existsSync(join(cacheDir, LOCK_FILE)), false);
    const third = acquireBuildLock(cacheDir);
    assert.ok(third.ok);
    third.release();
  });

  it('refuses while another live process holds it; holder exit releases it', async () => {
    const proc = await startHolder(cacheDir);
    try {
      const refused = acquireBuildLock(cacheDir);
      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.holder?.pid, proc.pid);
    } finally {
      proc.stdin?.end();
      await exited(proc);
    }
    assert.equal(existsSync(join(cacheDir, LOCK_FILE)), false, 'normal exit removed the lock');
    const mine = acquireBuildLock(cacheDir);
    assert.ok(mine.ok);
    mine.release();
  });

  it('takes over the lock of a holder that was killed', async () => {
    const proc = await startHolder(cacheDir);
    const deadPid = proc.pid;
    proc.kill('SIGKILL');
    await exited(proc);
    assert.equal(readLockHolder(cacheDir)?.pid, deadPid, 'SIGKILL leaves the lock file behind');

    const taken = acquireBuildLock(cacheDir);
    assert.ok(taken.ok, 'a lock whose holder pid is gone is stale');
    assert.equal(readLockHolder(cacheDir)?.pid, process.pid);
    taken.release();
  });

  it('treats a lock as stale when its pid now belongs to another process', async () => {
    // The pid is alive (this process) but its start-time identity differs: a reused pid.
    const reused = { pid: process.pid, startedAt: '2020-01-01T00:00:00.000Z', identity: 'ticks:1' };
    await writeFile(join(cacheDir, LOCK_FILE), JSON.stringify(reused));
    const taken = acquireBuildLock(cacheDir);
    assert.ok(taken.ok);
    assert.notEqual(readLockHolder(cacheDir)?.identity, 'ticks:1');
    taken.release();
  });

  it('treats a corrupt lock file as stale', async () => {
    await writeFile(join(cacheDir, LOCK_FILE), '{ not json');
    const taken = acquireBuildLock(cacheDir);
    assert.ok(taken.ok);
    assert.equal(JSON.parse(readFileSync(join(cacheDir, LOCK_FILE), 'utf8')).pid, process.pid);
    taken.release();
  });

  it('another process does not misjudge a live holder as a reused pid', () => {
    const taken = acquireBuildLock(cacheDir);
    assert.ok(taken.ok);
    try {
      assert.ok(readLockHolder(cacheDir)?.identity, 'identity is available on macOS and Linux');
      const other = spawnSync(process.execPath, ['--input-type=module', '-e', HOLDER], {
        env: { ...process.env, LOCK_DIR: cacheDir },
        input: '',
        encoding: 'utf8',
      });
      assert.equal(other.stdout.trim(), 'refused', other.stderr);
    } finally {
      taken.release();
    }
  });
});
