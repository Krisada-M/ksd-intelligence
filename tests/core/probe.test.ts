import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { defaultConfig, type ImpactConfig } from '../../src/core/kernel/config.js';
import { probe } from '../../src/core/workspace/probe.js';
import { scan } from '../../src/core/workspace/scan.js';
import type { FileRecord } from '../../src/storage/sqlite.js';

const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/mono', import.meta.url));
const IMPACT: ImpactConfig = { ...defaultConfig().impact, include: ['packages/**', 'apps/**'] };
// Whole seconds, so a restored mtime is bit-identical to the fingerprint's.
const FIXED_MTIME = 1_700_000_000;

function setTimes(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) utimesSync(join(entry.parentPath, entry.name), FIXED_MTIME, FIXED_MTIME);
  }
}

describe('freshness probe (D22)', () => {
  let work: string;
  let counter = 0;
  before(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), 'ei-probe-')));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  /** A git work tree copied from the fixture, plus the census fingerprint of it. */
  async function fresh(): Promise<{ dir: string; fingerprint: FileRecord[] }> {
    const dir = join(work, `copy-${counter++}`);
    cpSync(FIXTURE, dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'SECRET=1\n');
    execFileSync('git', ['init', '-q', dir]);
    setTimes(dir);
    const { records, summary } = await scan(dir, IMPACT, ts);
    assert.equal(summary.listing, 'git');
    return { dir, fingerprint: records };
  }

  it('no drift: nothing read in stat mode', async () => {
    const { dir, fingerprint } = await fresh();
    const result = await probe(dir, IMPACT, fingerprint, 'stat');
    assert.deepEqual(
      {
        added: result.added,
        deleted: result.deleted,
        changed: result.changed,
        touched: result.touched,
      },
      { added: [], deleted: [], changed: [], touched: [] },
    );
    assert.equal(result.hashed, 0);
    assert.equal(result.files, fingerprint.length);
  });

  it('edit: only the edited file is read and reported', async () => {
    const { dir, fingerprint } = await fresh();
    await appendFile(join(dir, 'packages/payments/src/fee.ts'), '// edited\n');
    const result = await probe(dir, IMPACT, fingerprint, 'stat');
    assert.deepEqual(result.changed, ['packages/payments/src/fee.ts']);
    assert.equal(result.hashed, 1);
  });

  it('add (untracked file), delete and rename', async () => {
    const { dir, fingerprint } = await fresh();
    await writeFile(join(dir, 'packages/api/src/new.ts'), 'export const n = 1;\n');
    await rm(join(dir, 'packages/shared/src/money.ts'));
    await rename(
      join(dir, 'packages/payments/src/stripe.ts'),
      join(dir, 'packages/payments/src/stripe2.ts'),
    );
    const result = await probe(dir, IMPACT, fingerprint, 'stat');
    assert.deepEqual(result.added, ['packages/api/src/new.ts', 'packages/payments/src/stripe2.ts']);
    assert.deepEqual(result.deleted, [
      'packages/payments/src/stripe.ts',
      'packages/shared/src/money.ts',
    ]);
    assert.deepEqual(result.changed, []);
  });

  it('a touched file with unchanged content is not drift', async () => {
    const { dir, fingerprint } = await fresh();
    const path = join(dir, 'packages/api/src/routes.ts');
    utimesSync(path, FIXED_MTIME + 60, FIXED_MTIME + 60);
    const result = await probe(dir, IMPACT, fingerprint, 'stat');
    assert.deepEqual(result.touched, ['packages/api/src/routes.ts']);
    assert.deepEqual(result.changed, []);
  });

  it('BLIND SPOT (documented): a same-size edit with the mtime restored passes the stat probe', async () => {
    const { dir, fingerprint } = await fresh();
    const path = join(dir, 'packages/payments/src/fee.ts');
    const before = await readFile(path, 'utf8');
    const after = before.replace('return 0;', 'return 1;');
    assert.notEqual(after, before, 'the edit changes content');
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before), 'and keeps the size');
    await writeFile(path, after);
    utimesSync(path, FIXED_MTIME, FIXED_MTIME);
    assert.equal(statSync(path).mtimeMs, FIXED_MTIME * 1000);

    const stat = await probe(dir, IMPACT, fingerprint, 'stat');
    assert.deepEqual(stat.changed, [], 'stat mode cannot see it: accepted for queries only (D22)');
    const hash = await probe(dir, IMPACT, fingerprint, 'hash');
    assert.deepEqual(hash.changed, ['packages/payments/src/fee.ts'], 'freshness: "hash" sees it');
  });

  it('freshness "hash" reads every readable file, never an excluded one', async () => {
    const { dir, fingerprint } = await fresh();
    if (process.getuid?.() !== 0) chmodSync(join(dir, '.env'), 0o000);
    const result = await probe(dir, IMPACT, fingerprint, 'hash');
    const readable = fingerprint.filter((record) => record.hash !== null).length;
    assert.equal(result.hashed, readable);
    assert.deepEqual(result.changed, []);
    assert.equal(
      fingerprint.find((record) => record.path === '.env')?.hash,
      null,
      'the secret was never hashed by the scan either',
    );
  });

  it('a change to a never-read (secret) file is detected by size and mtime alone', async () => {
    const { dir, fingerprint } = await fresh();
    await writeFile(join(dir, '.env'), 'SECRET=12\n');
    if (process.getuid?.() !== 0) chmodSync(join(dir, '.env'), 0o000);
    const result = await probe(dir, IMPACT, fingerprint, 'stat');
    assert.deepEqual(result.changed, ['.env']);
    assert.equal(result.hashed, 0);
  });
});
