import assert from 'node:assert/strict';
import { statSync, utimesSync } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildIndex, type EngineOutcome } from '../../src/core/engine/build.js';
import { loadWorkspace, type Workspace } from '../../src/core/engine/workspace.js';
import { ImpactSession, type ImpactBatch } from '../../src/core/impact/session.js';
import type { ImpactAnswer } from '../../src/core/impact/query.js';
import type { ImpactResult } from '../../src/core/kernel/types.js';
import { acquireBuildLock } from '../../src/core/engine/lock.js';
import {
  coldLines,
  difference,
  ensureRuntime,
  fixtureRepo,
  publishedLines,
} from './index-helpers.js';

// Real builds run in the engine child, which needs the pinned runtime in the isolated HOME.
before(ensureRuntime);

const TARGET = 'packages/payments/src/fee.ts#calculateFee';
const CHARGE = 'packages/api/src/charge.ts';
const CHECKOUT = 'apps/web/src/checkout.ts';
const PAYMENT_ENTRY = 'packages/payments/src/index.ts';

function result(answer: ImpactAnswer): ImpactResult {
  assert.equal(answer.kind, 'result', JSON.stringify(answer));
  assert.ok('value' in answer && 'target' in answer.value, JSON.stringify(answer));
  return answer.value;
}

function first(batch: ImpactBatch): ImpactAnswer {
  const answer = batch.answers[0];
  assert.ok(answer, 'one answer per queried target');
  return answer;
}

function callerFiles(answer: ImpactAnswer): string[] {
  return result(answer).byDepth[0]?.map((node) => node.span.file) ?? [];
}

function reasonCodes(answer: ImpactAnswer): string[] {
  return result(answer).completeness.reasons.map((reason) => reason.split(':')[0] ?? '');
}

async function indexFixture(repo: string): Promise<Workspace> {
  const workspace = await loadWorkspace(repo, dirname(repo));
  const outcome = await buildIndex(workspace);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.notEqual(outcome.value.action, 'failed', JSON.stringify(outcome));
  return workspace;
}

async function query(session: ImpactSession, target = TARGET): Promise<ImpactAnswer> {
  const batch = await session.query([target]);
  assert.equal(batch.answers.length, 1);
  const answer = batch.answers[0];
  assert.ok(answer);
  return answer;
}

async function assertColdEqual(repo: string, cacheDir: string, label: string): Promise<void> {
  const coldDir = await mkdtemp(join(tmpdir(), 'ei-fresh-cold-'));
  try {
    const diff = difference(publishedLines(cacheDir), await coldLines(repo, coldDir));
    assert.deepEqual(diff, { onlyFirst: [], onlySecond: [] }, `${label}: incremental == full`);
  } finally {
    await rm(coldDir, { recursive: true, force: true });
  }
}

async function addChargeCaller(repo: string): Promise<void> {
  const path = join(repo, CHARGE);
  await writeFile(
    path,
    `${await readFile(path, 'utf8')}\nexport function newChargeCaller(): void { calculateFee(11); }\n`,
  );
}

/**
 * A real build held at a gate. Tests await `settled` before they end, so no build outlives its test
 * holding the lock or writing into a temp directory that is being removed.
 */
function gatedBuild(): {
  build: (work: Workspace, options: Parameters<typeof buildIndex>[1]) => Promise<EngineOutcome>;
  release: () => void;
  settled: () => Promise<void>;
  calls: () => number;
} {
  // The test lib predates Promise.withResolvers (ES2024), so the executor form captures resolve.
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const running: Promise<EngineOutcome>[] = [];
  return {
    build: (work, options) => {
      const task = gate.then(() => buildIndex(work, options));
      running.push(task);
      return task;
    },
    release: () => open(),
    settled: async () => {
      await Promise.allSettled(running);
    },
    calls: () => running.length,
  };
}

describe('golden F01–F06: live index freshness', () => {
  let repo: string;
  let workspace: Workspace;
  let session: ImpactSession;
  before(async () => {
    repo = await fixtureRepo('fresh-golden');
    const configPath = join(repo, 'ei.config.json');
    const fixtureConfig = await readFile(configPath, 'utf8');
    await writeFile(configPath, fixtureConfig.replace('"routes"', '"freshness": "hash", "routes"'));
    workspace = await indexFixture(repo);
    session = new ImpactSession(workspace);
  });
  after(async () => {
    await rm(dirname(repo), { recursive: true, force: true });
  });

  it('F01: uncommitted edit adds a depth-1 caller and changes workingTreeHash', async () => {
    const previous = result(await query(session));
    await addChargeCaller(repo);
    const next = result(await query(session));
    assert.ok(next.byDepth[0]?.some((node) => node.symbol === `${CHARGE}#newChargeCaller`));
    assert.notEqual(next.freshness.workingTreeHash, previous.freshness.workingTreeHash);
    await assertColdEqual(repo, workspace.cacheDir, 'F01');
  });

  it('F02: untracked file contributes a caller and is marked untracked', async () => {
    const extra = 'packages/api/src/extra.ts';
    await writeFile(
      join(repo, extra),
      "import { calculateFee } from '@fx/payments';\nexport function extraCharge(): number { return calculateFee(12); }\n",
    );
    const next = result(await query(session));
    assert.ok(next.byDepth[0]?.some((node) => node.symbol === `${extra}#extraCharge`));
    assert.equal(next.freshness.includesUntracked, true);
    await assertColdEqual(repo, workspace.cacheDir, 'F02');
  });

  it('F03: rename and delete remove old edges without retaining stale callers', async () => {
    const pay = 'apps/web/src/pay.ts';
    await rename(join(repo, CHECKOUT), join(repo, pay));
    const renamed = await query(session);
    assert.ok(callerFiles(renamed).includes(pay));
    assert.ok(!callerFiles(renamed).includes(CHECKOUT));
    await assertColdEqual(repo, workspace.cacheDir, 'F03 rename');

    await rm(join(repo, pay));
    const deleted = await query(session);
    assert.ok(!callerFiles(deleted).includes(pay));
    assert.ok(!callerFiles(deleted).includes(CHECKOUT));
    await assertColdEqual(repo, workspace.cacheDir, 'F03 delete');
  });

  it('F04: removing barrel export removes imported calls and reports unresolved-import', async () => {
    const path = join(repo, PAYMENT_ENTRY);
    const source = await readFile(path, 'utf8');
    assert.ok(source.includes("export * from './fee'"));
    await writeFile(path, source.replace("export * from './fee';", ''));
    const next = await query(session);
    const impact = result(next);
    assert.ok(
      !impact.byDepth[0]?.some(
        (node) => node.symbol === `${CHARGE}#chargeHandler` && node.via === 'CALLS',
      ),
    );
    assert.equal(impact.completeness.status, 'partial');
    assert.ok(reasonCodes(next).includes('unresolved-import'));
    assert.equal(impact.verdict.level, 'unknown');
    for (let depth = 1; depth <= 10; depth++) {
      const atDepth = result(first(await session.query([TARGET], depth)));
      assert.equal(atDepth.completeness.status, 'partial', `F04 depth ${depth}`);
      assert.equal(atDepth.verdict.level, 'unknown', `F04 depth ${depth}`);
      assert.ok(
        atDepth.completeness.reasons.some((reason) => reason.startsWith('unresolved-import:')),
        `F04 depth ${depth}`,
      );
    }
    await assertColdEqual(repo, workspace.cacheDir, 'F04');
  });

  it('F05: incremental index matches full rebuild after F01, F02, F03 and F04', async () => {
    await assertColdEqual(repo, workspace.cacheDir, 'F01–F04 final working tree');
  });
});

describe('F06: stat probe blind spot and explicit full-hash indexing', () => {
  it('same-size edit with restored mtime never crashes; explicit index detects the edit', async () => {
    const repo = await fixtureRepo('fresh-stat');
    try {
      const configPath = join(repo, 'ei.config.json');
      const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
      assert.ok(config && typeof config === 'object' && 'impact' in config);
      const impact = config.impact;
      assert.ok(impact && typeof impact === 'object');
      const configured = JSON.stringify({ ...config, impact: { ...impact, freshness: 'stat' } });
      await writeFile(configPath, configured);
      // Whole seconds: a Date restores milliseconds only, and filesystems keep finer mtimes, so a
      // restored sub-millisecond mtime would be real drift and the query itself would update.
      const charge = join(repo, CHARGE);
      const fixed = 1_700_000_000;
      utimesSync(charge, fixed, fixed);
      const workspace = await indexFixture(repo);
      const session = new ImpactSession(workspace);
      await query(session);
      const original = await readFile(charge, 'utf8');
      const edited = original.replace('chargeHandler', 'chargeHandleX');
      assert.notEqual(edited, original);
      assert.equal(Buffer.byteLength(edited), Buffer.byteLength(original));
      await writeFile(charge, edited);
      utimesSync(charge, fixed, fixed);
      assert.equal(statSync(charge).mtimeMs, fixed * 1000);
      assert.equal((await query(session)).kind, 'result', 'stat blind spot must not crash');
      const fullHash = await buildIndex(workspace);
      assert.ok(fullHash.ok, JSON.stringify(fullHash));
      assert.notEqual(
        fullHash.value.action,
        'unchanged',
        'explicit index hashes files despite stat freshness',
      );
      assert.ok(
        result(await query(session)).byDepth[0]?.some(
          (node) => node.symbol === `${CHARGE}#chargeHandleX`,
        ),
      );
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });
});

describe('query freshness safety', () => {
  let repo: string;
  let workspace: Workspace;
  before(async () => {
    repo = await fixtureRepo('fresh-safety');
    workspace = await indexFixture(repo);
  });
  after(async () => {
    await rm(dirname(repo), { recursive: true, force: true });
  });

  it('no drift answers from the published index without starting a build', async () => {
    let builds = 0;
    const session = new ImpactSession(workspace, {
      build: async () => {
        builds++;
        throw new Error('a fresh query must not build');
      },
    });
    assert.equal(result(await query(session)).target, TARGET);
    assert.equal(builds, 0);
  });

  it('a drifted file is updated by the real indexer within the wait budget', async () => {
    await addChargeCaller(repo);
    const session = new ImpactSession(workspace);
    const batch = await session.query([TARGET]);
    assert.equal(batch.index.state, 'updated');
    assert.ok(batch.index.updatedFiles >= 1);
    assert.ok(
      result(first(batch)).byDepth[0]?.some((node) => node.symbol === `${CHARGE}#newChargeCaller`),
    );
  });

  it('a slow build leaves a stale result with drift paths and continues after timeout', async () => {
    await writeFile(join(repo, 'packages/api/src/slow.ts'), 'export const slow = 1;\n');
    const gated = gatedBuild();
    const session = new ImpactSession(workspace, { waitMs: 20, build: gated.build });
    try {
      const batch = await session.query([TARGET]);
      assert.equal(batch.index.state, 'stale');
      assert.ok(batch.index.driftedFiles.includes('packages/api/src/slow.ts'));
      const impact = result(first(batch));
      assert.equal(impact.completeness.status, 'partial');
      assert.equal(impact.verdict.level, 'unknown');
      assert.equal(impact.verdict.action, 'check-gaps');
      assert.ok(reasonCodes(first(batch)).includes('stale-index'));
    } finally {
      gated.release();
      await gated.settled();
    }
    // The build the timed-out call started kept running and published; nothing was rebuilt.
    const next = await session.query([TARGET]);
    assert.equal(next.index.state, 'fresh');
    assert.equal(gated.calls(), 1);
  });

  it('live foreign lock never starts a second engine child', async () => {
    await writeFile(join(repo, 'packages/api/src/locked.ts'), 'export const locked = 1;\n');
    const lock = acquireBuildLock(workspace.cacheDir);
    assert.ok(lock.ok);
    let progress = 0;
    try {
      const session = new ImpactSession(workspace, {
        waitMs: 20,
        onProgress: () => {
          progress++;
        },
      });
      const batch = await session.query([TARGET]);
      assert.equal(batch.index.state, 'stale');
      assert.equal(result(first(batch)).verdict.level, 'unknown');
      assert.equal(progress, 0, 'the lock holder prevents any child progress');
    } finally {
      lock.release();
    }
  });

  it('concurrent calls in one session share one in-flight build', async () => {
    await writeFile(join(repo, 'packages/api/src/concurrent.ts'), 'export const concurrent = 1;\n');
    const gated = gatedBuild();
    const session = new ImpactSession(workspace, { waitMs: 20, build: gated.build });
    try {
      const [first, second] = await Promise.all([session.query([TARGET]), session.query([TARGET])]);
      assert.equal(gated.calls(), 1);
      assert.equal(first.index.state, 'stale');
      assert.equal(second.index.state, 'stale');
    } finally {
      gated.release();
      await gated.settled();
    }
  });

  it('failed update retains the old index, marks it stale and includes the failure', async () => {
    await writeFile(join(repo, 'packages/api/src/failed.ts'), 'export const failed = 1;\n');
    let builds = 0;
    const session = new ImpactSession(workspace, {
      build: async (): Promise<EngineOutcome> => {
        builds++;
        return {
          ok: false,
          code: 'index-failed',
          message: 'verification failed',
          fix: 'retry once',
        };
      },
    });
    for (let i = 0; i < 3; i++) {
      const batch = await session.query([TARGET]);
      assert.equal(batch.index.state, 'stale');
      const impact = result(first(batch));
      assert.equal(impact.completeness.status, 'partial');
      assert.equal(impact.verdict.level, 'unknown');
      assert.ok(
        impact.completeness.reasons.some((reason) => reason.includes('verification failed')),
      );
    }
    assert.equal(builds, 1, 'three calls with unchanged drift fingerprint run one build');
    await writeFile(join(repo, 'packages/api/src/failed.ts'), 'export const failed = 222;\n');
    await session.query([TARGET]);
    assert.equal(builds, 2, 'a changed drift fingerprint retries the build');
  });

  it('waitAfterExpiry mode waits for a build slower than waitMs instead of exiting stale', async () => {
    await writeFile(join(repo, 'packages/api/src/cli-slow.ts'), 'export const cliSlow = 1;\n');
    const gated = gatedBuild();
    const timer = setTimeout(() => gated.release(), 50);
    try {
      const session = new ImpactSession(workspace, {
        waitMs: 10,
        waitAfterExpiry: true,
        build: gated.build,
      });
      const batch = await session.query([TARGET]);
      assert.equal(batch.index.state, 'updated');
      assert.equal(gated.calls(), 1);
    } finally {
      clearTimeout(timer);
      gated.release();
      await gated.settled();
    }
  });

  it('all golden declaration targets stay unknown and partial when index is stale', async () => {
    await writeFile(
      join(repo, 'packages/api/src/stale-golden.ts'),
      'export const staleGolden = 1;\n',
    );
    const goldenTargets = [
      TARGET,
      'packages/shared/src/money.ts#roundMoney',
      'packages/payments/src/service.ts#PaymentService.charge',
      'packages/payments/src/stripe.ts#StripeProcessor.charge',
      'packages/payments/src/fee.ts#Fee',
      'packages/api/src/handlers/refund.ts#refund',
      'packages/api/src/charge.ts#chargeHandler',
      'packages/payments/src/fee.ts#unusedHelper',
      'packages/payments/src/fee.ts#localOnly',
      'packages/shared/src/legacy.cjs#toCents',
      'packages/payments/src/cycle-a.ts#a',
      'packages/payments/src/checkout-flow.ts#normalizeAll',
      'packages/payments/src/processor.ts#PaymentProcessor.charge',
      'packages/payments/src/manual.ts#ManualProcessor.charge',
      'packages/payments/src/checkout-flow.ts#runCheckout',
      'packages/payments/src/service.ts#PaymentService',
    ];
    const session = new ImpactSession(workspace, {
      build: async (): Promise<EngineOutcome> => ({
        ok: false,
        code: 'index-failed',
        message: 'offline',
        fix: 'retry once',
      }),
    });
    for (const target of goldenTargets) {
      const batch = await session.query([target]);
      assert.equal(batch.index.state, 'stale');
      const impact = result(first(batch));
      assert.equal(impact.completeness.status, 'partial', target);
      assert.equal(impact.verdict.level, 'unknown', target);
      assert.equal(impact.verdict.action, 'check-gaps', target);
    }
    const fileBatch = await session.query(['packages/payments/src/fee.ts']);
    assert.equal(fileBatch.answers[0]?.kind, 'result');
    if (fileBatch.answers[0]?.kind === 'result' && 'results' in fileBatch.answers[0].value) {
      for (const impact of fileBatch.answers[0].value.results) {
        assert.equal(impact.completeness.status, 'partial');
        assert.equal(impact.verdict.level, 'unknown');
      }
    }
  });
});

describe('absent index safety', () => {
  it('failed cold build returns index-failed instead of a fabricated low result', async () => {
    const repo = await fixtureRepo('fresh-absent');
    try {
      const workspace = await loadWorkspace(repo, dirname(repo));
      const session = new ImpactSession(workspace, {
        build: async (): Promise<EngineOutcome> => ({
          ok: false,
          code: 'index-failed',
          message: 'engine offline',
          fix: 'retry once',
        }),
      });
      const batch = await session.query([TARGET]);
      assert.equal(batch.answers[0]?.kind, 'failure');
      assert.equal(batch.answers[0]?.kind === 'failure' && batch.answers[0].code, 'index-failed');
      assert.match(batch.answers[0]?.message ?? '', /engine offline/);
    } finally {
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });

  it('absent index after the wait returns index-building while build continues', async () => {
    const repo = await fixtureRepo('fresh-building');
    const gated = gatedBuild();
    try {
      const workspace = await loadWorkspace(repo, dirname(repo));
      const session = new ImpactSession(workspace, { waitMs: 20, build: gated.build });
      const batch = await session.query([TARGET]);
      assert.equal(batch.index.state, 'building');
      assert.equal(batch.answers[0]?.kind, 'guidance');
      assert.equal(
        batch.answers[0]?.kind === 'guidance' && batch.answers[0].code,
        'index-building',
      );
      gated.release();
      await gated.settled();
      // The build continued past the wait; the next call answers from it without a second build.
      assert.equal(result(await query(session)).target, TARGET);
      assert.equal(gated.calls(), 1);
    } finally {
      gated.release();
      await gated.settled();
      await rm(dirname(repo), { recursive: true, force: true });
    }
  });
});
