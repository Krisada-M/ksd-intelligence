import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import {
  checkTypescriptRuntime,
  pinnedTypescriptVersion,
  setupTypescriptRuntime,
} from '../../src/core/engine/typescript.js';
import { parseProjectConfig, type ImpactConfig } from '../../src/core/kernel/config.js';
import { Indexer, type IndexReport } from '../../src/core/indexing/indexer.js';
import { canonicalLines } from '../../src/storage/records.js';
import { openPublished } from '../../src/storage/sqlite.js';

const run = promisify(execFile);

export const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/mono', import.meta.url));

/**
 * The pinned TypeScript runtime in this process's HOME, which `npm test` isolates per file.
 * Provisioned offline from this repository's own TypeScript package when it is absent.
 */
export async function ensureRuntime(): Promise<void> {
  const version = pinnedTypescriptVersion();
  if ((await checkTypescriptRuntime({ version })).ok) return;
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-runtime-')));
  try {
    const env = { ...process.env, npm_config_offline: 'true', npm_config_cache: join(work, 'npm') };
    const typescriptDir = dirname(dirname(createRequire(import.meta.url).resolve('typescript')));
    const { stdout } = await run('npm', ['pack', '--pack-destination', work, typescriptDir], {
      env,
    });
    const spec = join(work, stdout.trim().split('\n').at(-1) ?? '');
    const setup = await setupTypescriptRuntime({ version, spec, installer: 'npm', env });
    assert.ok(setup.ok, JSON.stringify(setup));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** A temp copy of the fixture as a git repository with the base committed (golden F-cases). */
export async function fixtureRepo(prefix: string): Promise<string> {
  const work = await realpath(await mkdtemp(join(tmpdir(), `ei-${prefix}-`)));
  const repo = join(work, 'mono');
  cpSync(FIXTURE, repo, { recursive: true });
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      stdio: 'ignore',
    });
  };
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return repo;
}

/** The repository's own impact config, freshness forced to "hash" (golden F-cases). */
export function impactOf(repo: string): ImpactConfig {
  const { config } = parseProjectConfig(readFileSync(join(repo, 'ei.config.json'), 'utf8'));
  return { ...config.impact, freshness: 'hash' };
}

export function riskZonesOf(repo: string) {
  const { config } = parseProjectConfig(readFileSync(join(repo, 'ei.config.json'), 'utf8'));
  return config.riskZones;
}

export function publishedLines(cacheDir: string): string[] {
  const db = openPublished(cacheDir);
  assert.ok(db, `a published index in ${cacheDir}`);
  try {
    // Strict on the fixture: counters included, though doctor treats them as statistics.
    return canonicalLines(db, { counters: true });
  } finally {
    db.close();
  }
}

/** A cold build of the working tree into its own cache dir, canonicalised. */
export async function coldLines(repo: string, cacheDir: string): Promise<string[]> {
  const report = await new Indexer(ts, repo, cacheDir).index({
    impact: impactOf(repo),
    full: true,
  });
  assert.deepEqual(report.problems, [], 'the cold build verifies');
  return publishedLines(cacheDir);
}

/** Lines only in `a`, lines only in `b`; both empty means equal indexes. */
export function difference(
  a: string[],
  b: string[],
): { onlyFirst: string[]; onlySecond: string[] } {
  const inA = new Set(a);
  const inB = new Set(b);
  return {
    onlyFirst: a.filter((line) => !inB.has(line)),
    onlySecond: b.filter((line) => !inA.has(line)),
  };
}

/** Incremental index == cold build on the same tree, with the diff printed on failure (F05). */
export async function assertIncrementalEqualsCold(
  indexer: Indexer,
  coldDir: string,
  label: string,
): Promise<IndexReport> {
  const report = await indexer.index({ impact: impactOf(indexer.root), freshness: 'hash' });
  assert.deepEqual(report.problems, [], `${label}: the update verifies`);
  const diff = difference(publishedLines(indexer.cacheDir), await coldLines(indexer.root, coldDir));
  assert.deepEqual(diff, { onlyFirst: [], onlySecond: [] }, `${label}: incremental == cold`);
  return report;
}
