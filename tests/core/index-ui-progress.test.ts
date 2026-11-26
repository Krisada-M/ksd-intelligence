import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { buildIndex } from '../../src/core/engine/build.js';
import { loadWorkspace } from '../../src/core/engine/workspace.js';
import { Indexer } from '../../src/core/indexing/indexer.js';
import {
  readBuildHistory,
  recordBuildHistory,
  type BuildProgress,
} from '../../src/core/indexing/ui-progress.js';
import { ensureRuntime, fixtureRepo, impactOf } from './index-helpers.js';

describe('index HUD observations and published-run history', () => {
  let repo: string;
  let cacheDir: string;
  before(async () => {
    repo = await fixtureRepo('hud');
    cacheDir = join(repo, '..', 'cache');
  });
  after(async () => rm(join(repo, '..'), { recursive: true, force: true }));

  it('keeps legacy messages and report shape while observing real cold counts and reason', async () => {
    const indexer = new Indexer(ts, repo, cacheDir);
    const legacy: Array<[string, unknown]> = [];
    const hud: BuildProgress[] = [];
    const report = await indexer.index({
      impact: impactOf(repo),
      onProgress: (message, data) => legacy.push([message, data]),
      onHudProgress: (event) => hud.push(event),
    });
    assert.equal(report.action, 'cold');
    assert.deepEqual(
      legacy.map(([message]) => message),
      ['scan', 'program', 'extract', 'resolve', 'verify', 'publish'],
    );
    assert.deepEqual(legacy[2], ['extract', { files: report.resolvedFiles }]);
    assert.deepEqual(legacy[3], ['resolve', { files: report.resolvedFiles }]);
    assert.deepEqual(Object.keys(report).sort(), [
      'action',
      'census',
      'counts',
      'drift',
      'phases',
      'problems',
      'programs',
      'reason',
      'resolvedFiles',
    ]);
    assert.ok(hud.some((event) => event.kind === 'cold' && event.reason === 'no published index'));
    assert.ok(
      hud.some(
        (event) =>
          event.phase === 'extract' &&
          event.done === report.resolvedFiles &&
          event.total === report.resolvedFiles &&
          typeof event.file === 'string',
      ),
    );
    assert.ok(
      hud.some(
        (event) =>
          event.phase === 'resolve' &&
          event.done === report.resolvedFiles &&
          event.total === report.resolvedFiles,
      ),
    );
    const history = readBuildHistory(cacheDir);
    assert.deepEqual(
      history.map(({ reason }) => reason),
      ['no published index'],
    );
    const first = history[0];
    assert.ok(first);
    assert.ok(first.durationMs >= 0);
  });

  it('records neither no-op nor verification failure and leaves prior history intact', async () => {
    const indexer = new Indexer(ts, repo, cacheDir);
    const previous = readFileSync(join(cacheDir, 'runs.json'), 'utf8');
    const hud: BuildProgress[] = [];
    const unchanged = await indexer.index({
      impact: impactOf(repo),
      onHudProgress: (event) => hud.push(event),
    });
    assert.equal(unchanged.action, 'unchanged');
    assert.ok(hud.some((event) => event.phase === 'unchanged'));
    assert.equal(readFileSync(join(cacheDir, 'runs.json'), 'utf8'), previous);

    await writeFile(join(repo, 'packages/payments/src/fee.ts'), 'export const changed = 1;\n');
    const failed = await new Indexer(ts, repo, cacheDir, {
      verify: () => ['forced failure'],
    }).index({
      impact: impactOf(repo),
      onHudProgress: () => {
        throw new Error('observer failure');
      },
    });
    assert.equal(failed.action, 'failed');
    assert.deepEqual(failed.problems, ['forced failure']);
    assert.equal(readFileSync(join(cacheDir, 'runs.json'), 'utf8'), previous);

    const updateHud: BuildProgress[] = [];
    const updated = await indexer.index({
      impact: impactOf(repo),
      onHudProgress: (event) => updateHud.push(event),
    });

    assert.equal(updated.action, 'update');
    assert.equal(readBuildHistory(cacheDir).length, 2);
    assert.equal(readBuildHistory(cacheDir)[1]?.reason, undefined);
    assert.ok(updateHud.some((event) => event.kind === 'update'));
    assert.ok(
      updateHud
        .filter((event) => event.phase === 'resolve')
        .every((event) => event.total === undefined),
    );
    assert.ok(existsSync(join(cacheDir, 'runs.json')));
  });
  it('routes opt-in child telemetry separately from legacy progress', async () => {
    await ensureRuntime();
    const workspace = await loadWorkspace(repo);
    workspace.cacheDir = join(repo, '..', 'ipc-cache');
    const legacy: string[] = [];
    const hud: BuildProgress[] = [];
    const outcome = await buildIndex(workspace, {
      onProgress: (message) => {
        legacy.push(message);
      },
      onHudProgress: (event) => {
        hud.push(event);
      },
    });
    assert.ok(outcome.ok);
    assert.equal(outcome.value.action, 'cold');
    assert.deepEqual(legacy, ['scan', 'program', 'extract', 'resolve', 'verify', 'publish']);
    assert.ok(hud.some((event) => event.phase === 'scan' && event.total !== undefined));
    assert.ok(hud.some((event) => event.phase === 'program' && event.kind === 'cold'));
    assert.ok(hud.some((event) => event.phase === 'publish'));
  });

  it('does not write history for a temporary doctor rebuild', async () => {
    const temp = join(repo, '..', 'doctor-temp');
    const report = await new Indexer(ts, repo, temp).index({
      impact: impactOf(repo),
      full: true,
      recordHistory: false,
    });
    assert.equal(report.action, 'cold');
    assert.equal(existsSync(join(temp, 'runs.json')), false);
  });

  it('keeps only the latest twenty observed runs', () => {
    for (let durationMs = 1; durationMs <= 22; durationMs++) {
      recordBuildHistory(cacheDir, { durationMs });
    }
    const history = readBuildHistory(cacheDir);
    assert.equal(history.length, 20);
    assert.equal(history[0]?.durationMs, 3);
    assert.equal(history.at(-1)?.durationMs, 22);
  });
});
