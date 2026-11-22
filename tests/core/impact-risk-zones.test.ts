import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { loadWorkspace } from '../../src/core/engine/workspace.js';
import { ImpactQuery } from '../../src/core/impact/query.js';
import { renderAnswer, renderImpact } from '../../src/core/impact/render.js';
import { ImpactSession } from '../../src/core/impact/session.js';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { defaultConfig, type RiskZoneConfig } from '../../src/core/kernel/config.js';
import type { Action, ImpactResult, Level, Verdict } from '../../src/core/kernel/types.js';
import {
  ACTION_RANK,
  LEVEL_RANK,
  applyRiskZones,
  deriveVerdict,
  matchedRiskZones,
} from '../../src/core/kernel/verdict.js';
import { kindOf, neverReadOf } from '../../src/core/workspace/scan.js';
import { openPublished } from '../../src/storage/sqlite.js';
import { ensureRuntime, fixtureRepo, impactOf, riskZonesOf } from './index-helpers.js';

before(ensureRuntime);

const SNAP_DIR = join(process.cwd(), 'tests/snapshots/impact');
const LEVEL_RE = /\b(low|medium|high|critical|unknown)\b/gi;

function assertOneVerdict(block: string, label: string): void {
  const lines = block.split('\n');
  const actionLines = lines.filter((line) => line.startsWith('ACTION '));
  assert.equal(actionLines.length, 1, `${label}: expected one ACTION line in:\n${block}`);
  const actionMatches = actionLines[0]!.match(LEVEL_RE) ?? [];
  assert.equal(actionMatches.length, 1, `${label}: expected one level word on ACTION line`);
}

function assertNoEnvironmentLeak(text: string, repoPath: string, label: string): void {
  assert.ok(!text.includes(repoPath), `${label}: leaked repo path`);
  const home = homedir();
  if (home.length > 1) assert.ok(!text.includes(home), `${label}: leaked home dir`);
  assert.ok(!text.includes(String(process.pid)), `${label}: leaked pid`);
}

function queryWithZones(
  repo: string,
  cacheDir: string,
  target: string,
  riskZones: 'default' | readonly RiskZoneConfig[],
  depth = 2,
): ImpactResult {
  const db = openPublished(cacheDir);
  assert.ok(db);
  try {
    const answer = new ImpactQuery(db, impactOf(repo), { riskZones }).query(target, depth);
    assert.equal(answer.kind, 'result', JSON.stringify(answer));
    assert.ok('target' in answer.value);
    return answer.value;
  } finally {
    db.close();
  }
}

describe('M2c Round 1 — risk zones and verdict escalation', () => {
  let repo: string;
  let cacheDir: string;

  before(async () => {
    repo = await fixtureRepo('risk-zones');
    cacheDir = join(dirname(repo), 'cache');
    const report = await new Indexer(ts, repo, cacheDir).index({
      impact: impactOf(repo),
      full: true,
      freshness: 'hash',
    });
    assert.deepEqual(report.problems, []);
  });

  after(async () => {
    if (repo) await rm(dirname(repo), { recursive: true, force: true });
  });

  it('fixture mono explicitly sets riskZones: [] so C01–C26 remain opt-out', () => {
    assert.deepEqual(riskZonesOf(repo), []);
  });

  it('P01–P04 pass with riskZones: "default"', () => {
    // P01: complete, quiet target inside payments zone -> high, run-tests
    const p01 = queryWithZones(repo, cacheDir, 'packages/payments/src/fee.ts#localOnly', 'default');
    assert.deepEqual(p01.factors, []);
    assert.equal(p01.completeness.status, 'complete');
    assert.equal(p01.verdict.level, 'high');
    assert.equal(p01.verdict.action, 'run-tests');
    assert.deepEqual(p01.verdict.zones, ['payments']);
    assert.ok(p01.verdict.requiredActions.some((a) => a.includes('ei_workflow with risk: high')));
    assert.ok(p01.verdict.basis.includes('zone:payments'));
    const p01Text = renderAnswer({ input: 'localOnly', kind: 'result', value: p01 });
    assert.match(p01Text, /^ACTION run-tests · level high \(zone payments\) · picture complete$/m);
    assertOneVerdict(p01Text, 'P01');
    assertNoEnvironmentLeak(p01Text, repo, 'P01');

    // P02: high zone + incomplete picture -> high, ask-owner (never run-tests)
    const p02 = queryWithZones(
      repo,
      cacheDir,
      'packages/payments/src/stripe.ts#StripeProcessor.charge',
      'default',
    );
    assert.equal(p02.completeness.status, 'partial');
    assert.equal(p02.verdict.level, 'high');
    assert.equal(p02.verdict.action, 'ask-owner');
    assert.deepEqual(p02.verdict.zones, ['payments']);
    const p02Text = renderAnswer({ input: 'StripeProcessor.charge', kind: 'result', value: p02 });
    assert.match(
      p02Text,
      /^ACTION ask-owner · level high \(zone payments\) · picture partial \(\d+ gap\)$/m,
    );
    assert.match(
      p02Text,
      /^Next: present the listed gap sites and planned change to the owner before editing;/m,
    );
    assertOneVerdict(p02Text, 'P02');
    assertNoEnvironmentLeak(p02Text, repo, 'P02');

    // P03: target outside zones, impacted symbols inside payments -> high, run-tests
    const p03 = queryWithZones(
      repo,
      cacheDir,
      'packages/shared/src/money.ts#roundMoney',
      'default',
    );
    assert.ok(p03.verdict.zones.includes('payments'));
    assert.equal(p03.verdict.level, 'high');
    assert.equal(p03.verdict.action, 'run-tests');

    // P04: no zone, incomplete picture -> unknown, check-gaps
    const p04 = queryWithZones(
      repo,
      cacheDir,
      'packages/api/src/handlers/refund.ts#refund',
      'default',
    );
    assert.deepEqual(p04.verdict.zones, []);
    assert.equal(p04.verdict.level, 'unknown');
    assert.equal(p04.verdict.action, 'check-gaps');
  });

  it('zone reached only at depth 4 still applies when depth is 1', async () => {
    const deepRepo = await fixtureRepo('zone-depth4');
    try {
      await writeFile(
        join(deepRepo, 'packages/shared/src/d1.ts'),
        'export function d0(): number { return 1; }\nfunction d1(): number { return d0(); }\nfunction d2(): number { return d1(); }\nfunction d3(): number { return d2(); }\nexport const keep = d3;\n',
      );
      await writeFile(
        join(deepRepo, 'packages/payments/src/z4.ts'),
        `import { keep } from '../../shared/src/d1.js';\nexport function d4(): number { return keep(); }\n`,
      );
      // Connect d3 -> d4 cleanly at depth 4.
      await writeFile(
        join(deepRepo, 'packages/shared/src/d1.ts'),
        'export function d0(): number { return 1; }\nexport function d1(): number { return d0(); }\nexport function d2(): number { return d1(); }\nexport function d3(): number { return d2(); }\n',
      );
      await writeFile(
        join(deepRepo, 'packages/payments/src/z4.ts'),
        `import { d3 } from '../../shared/src/d1.js';\nexport function d4(): number { return d3(); }\n`,
      );
      const deepCache = join(dirname(deepRepo), 'cache');
      await new Indexer(ts, deepRepo, deepCache).index({
        impact: impactOf(deepRepo),
        full: true,
        freshness: 'hash',
      });
      const r = queryWithZones(deepRepo, deepCache, 'packages/shared/src/d1.ts#d0', 'default', 1);
      assert.equal(r.byDepth.length, 1);
      assert.deepEqual(r.verdict.zones, ['payments']);
      assert.equal(r.verdict.level, 'high');
      assert.equal(r.verdict.action, 'run-tests');
    } finally {
      await rm(dirname(deepRepo), { recursive: true, force: true });
    }
  });

  it('floor: critical with a complete quiet target yields critical, ask-owner, and no-batching Next', async () => {
    const critRepo = await fixtureRepo('zone-critical');
    try {
      await mkdir(join(critRepo, 'packages/api/migrations'), { recursive: true });
      await writeFile(
        join(critRepo, 'packages/api/migrations/001.ts'),
        'function migrateQuiet(): number { return 1; }\nvoid migrateQuiet();\n',
      );
      const critCache = join(dirname(critRepo), 'cache');
      await new Indexer(ts, critRepo, critCache).index({
        impact: impactOf(critRepo),
        full: true,
        freshness: 'hash',
      });
      const r = queryWithZones(
        critRepo,
        critCache,
        'packages/api/migrations/001.ts#migrateQuiet',
        'default',
      );
      assert.equal(r.completeness.status, 'complete');
      assert.deepEqual(r.factors, []);
      assert.deepEqual(r.verdict.zones, ['migrations']);
      assert.equal(r.verdict.level, 'critical');
      assert.equal(r.verdict.action, 'ask-owner');
      const text = renderAnswer({ input: 'migrateQuiet', kind: 'result', value: r });
      assert.match(
        text,
        /^ACTION ask-owner · level critical \(zone migrations\) · picture complete$/m,
      );
      assert.match(text, /do not batch with other changes/);
    } finally {
      await rm(dirname(critRepo), { recursive: true, force: true });
    }
  });

  it('multiple zones take the strongest action and list all matched zones sorted', () => {
    const matched = matchedRiskZones(
      ['packages/payments/src/fee.ts', 'packages/api/migrations/001.sql'],
      'default',
    );
    const v = deriveVerdict({
      incomplete: false,
      hasFactors: false,
      basis: [],
      matchedZones: matched,
    });
    assert.deepEqual(v.zones, ['migrations', 'payments']);
    assert.equal(v.level, 'critical');
    assert.equal(v.action, 'ask-owner');
  });

  it('unmatched zone glob and malformed glob never throw and change nothing', () => {
    const zones: RiskZoneConfig[] = [
      { zone: 'unused', floor: 'critical', match: ['**/does-not-exist/**'] },
      { zone: 'malformed', floor: 'critical', match: ['[unclosed', '{a,{b', 'a\\b'] },
    ];
    const withoutZones = queryWithZones(
      repo,
      cacheDir,
      'packages/payments/src/fee.ts#localOnly',
      [],
    );
    const withUnmatched = queryWithZones(
      repo,
      cacheDir,
      'packages/payments/src/fee.ts#localOnly',
      zones,
    );
    assert.deepEqual(withUnmatched.verdict, withoutZones.verdict);
  });

  it('property test: zones never lower level or action across all golden targets and matrix combinations', () => {
    const targets = [
      'packages/payments/src/fee.ts#calculateFee',
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
    ];
    const zoneConfigs: Array<'default' | RiskZoneConfig[]> = [
      'default',
      [{ zone: 'all-high', floor: 'high', match: ['**'] }],
      [{ zone: 'all-critical', floor: 'critical', match: ['**'] }],
    ];
    for (const target of targets) {
      for (const depth of [1, 2, 10]) {
        const base = queryWithZones(repo, cacheDir, target, [], depth);
        for (const zones of zoneConfigs) {
          const raised = queryWithZones(repo, cacheDir, target, zones, depth);
          assert.ok(
            LEVEL_RANK[raised.verdict.level] >= LEVEL_RANK[base.verdict.level],
            `${target} depth ${depth}: ${raised.verdict.level} < ${base.verdict.level}`,
          );
          assert.ok(
            ACTION_RANK[raised.verdict.action] >= ACTION_RANK[base.verdict.action],
            `${target} depth ${depth}: ${raised.verdict.action} < ${base.verdict.action}`,
          );
        }
      }
    }

    // Exhaustive applyRiskZones matrix over base levels × zone floors
    const bases: Array<{ incomplete: boolean; hasFactors: boolean; level: Level; action: Action }> =
      [
        { incomplete: false, hasFactors: false, level: 'low', action: 'proceed' },
        { incomplete: false, hasFactors: true, level: 'medium', action: 'run-tests' },
        { incomplete: true, hasFactors: false, level: 'unknown', action: 'check-gaps' },
        { incomplete: true, hasFactors: true, level: 'unknown', action: 'check-gaps' },
      ];
    const configs: Array<{ zones: RiskZoneConfig[]; paths: string[] }> = [
      { zones: [], paths: ['src/a.ts'] },
      { zones: [{ zone: 'h', floor: 'high', match: ['src/**'] }], paths: ['src/a.ts'] },
      { zones: [{ zone: 'c', floor: 'critical', match: ['src/**'] }], paths: ['src/a.ts'] },
      {
        zones: [
          { zone: 'h', floor: 'high', match: ['src/**'] },
          { zone: 'c', floor: 'critical', match: ['src/**'] },
        ],
        paths: ['src/a.ts'],
      },
    ];
    for (const b of bases) {
      const baseVerdict: Verdict = {
        level: b.level,
        action: b.action,
        zones: [],
        requiredActions: [],
        basis: [],
      };
      for (const c of configs) {
        const out = applyRiskZones(baseVerdict, c.paths, c.zones, {
          incomplete: b.incomplete,
          hasFactors: b.hasFactors,
        });
        assert.ok(LEVEL_RANK[out.level] >= LEVEL_RANK[baseVerdict.level]);
        assert.ok(ACTION_RANK[out.action] >= ACTION_RANK[baseVerdict.action]);
      }
    }
  });

  it('zone matching uses paths only: excluded/secret files match by path and content is never read', async () => {
    // Non-existent paths never touched on disk
    const direct = applyRiskZones(
      { level: 'low', action: 'proceed', zones: [], requiredActions: [], basis: [] },
      ['.env', 'secrets/credentials.json', 'migrations/001.sql', 'Payments\\Fee.ts'],
      'default',
      { incomplete: false, hasFactors: false },
    );
    assert.deepEqual(direct.zones, ['migrations', 'payments', 'prod-config']);
    assert.equal(direct.level, 'critical');
    assert.equal(direct.action, 'ask-owner');

    // Unreadable chmod 000 secret files alongside indexed critical-zone code files
    const secRepo = await fixtureRepo('zone-secret-path-only');
    const envFile = join(secRepo, '.env');
    const credFile = join(secRepo, 'packages/api/secrets/credentials.json');
    try {
      await writeFile(
        join(secRepo, 'ei.config.json'),
        JSON.stringify({
          impact: { routes: ['packages/api/src/routes.ts'] },
          riskZones: 'default',
        }),
      );
      await mkdir(join(secRepo, 'packages/api/secrets'), { recursive: true });
      await writeFile(envFile, 'SECRET=should-never-be-read\n');
      await writeFile(credFile, '{"secret":"never"}\n');
      await chmod(envFile, 0o000);
      await chmod(credFile, 0o000);

      await mkdir(join(secRepo, 'packages/api/drizzle'), { recursive: true });
      await writeFile(
        join(secRepo, 'packages/api/drizzle/0000.ts'),
        'export function up() { return 1; }\n',
      );
      await writeFile(
        join(secRepo, 'packages/api/src/app.production.ts'),
        'export const prodFlag = true;\n',
      );

      const workspace = await loadWorkspace(secRepo, dirname(secRepo));
      const session = new ImpactSession(workspace);
      const batch = await session.query([
        'packages/api/drizzle/0000.ts#up',
        'packages/api/src/app.production.ts#prodFlag',
      ]);
      assert.equal(batch.answers.length, 2);
      for (const ans of batch.answers) {
        assert.equal(ans.kind, 'result');
        if (ans.kind === 'result' && 'verdict' in ans.value) {
          assert.equal(ans.value.verdict.level, 'critical');
          assert.equal(ans.value.verdict.action, 'ask-owner');
        }
      }
    } finally {
      await chmod(envFile, 0o644).catch(() => {});
      await chmod(credFile, 0o644).catch(() => {});
      await rm(dirname(secRepo), { recursive: true, force: true });
    }
  });

  it('stale index preserves high/critical zone floors and depth-4 zones even when depth is 1', async () => {
    const staleRepo = await fixtureRepo('zone-stale');
    try {
      await writeFile(
        join(staleRepo, 'ei.config.json'),
        JSON.stringify({
          impact: { routes: ['packages/api/src/routes.ts'] },
          riskZones: 'default',
        }),
      );
      await writeFile(
        join(staleRepo, 'packages/shared/src/chain.ts'),
        'export function c0(): number { return 1; }\nexport function c1(): number { return c0(); }\nexport function c2(): number { return c1(); }\nexport function c3(): number { return c2(); }\n',
      );
      await writeFile(
        join(staleRepo, 'packages/payments/src/c4.ts'),
        `import { c3 } from '../../shared/src/chain.js';\nexport function c4(): number { return c3(); }\n`,
      );
      await mkdir(join(staleRepo, 'packages/api/migrations'), { recursive: true });
      await writeFile(
        join(staleRepo, 'packages/api/migrations/001.ts'),
        'function migrateQuiet(): number { return 1; }\nvoid migrateQuiet();\n',
      );

      const workspace = await loadWorkspace(staleRepo, dirname(staleRepo));
      const report = await new Indexer(ts, staleRepo, workspace.cacheDir).index({
        impact: workspace.config.impact,
        full: true,
        freshness: 'hash',
      });
      assert.deepEqual(report.problems, []);

      await appendFile(join(staleRepo, 'packages/api/src/charge.ts'), '\n// trigger drift\n');
      const session = new ImpactSession(workspace, {
        waitMs: 5,
        build: () => new Promise(() => {}),
      });

      // High zone (payments) + stale -> action ask-owner, level high
      const highBatch = await session.query(['packages/payments/src/fee.ts#localOnly']);
      const highText = renderImpact(highBatch);
      assert.match(
        highText,
        /^ACTION ask-owner · level high \(zone payments\) · picture partial \(stale index\)$/m,
      );
      assert.match(
        highText,
        /^Next: present the listed gap sites and planned change to the owner before editing;/m,
      );
      assertOneVerdict(highText, 'stale-high');

      // Depth-4 zone queried at depth 1 + stale -> preserves payments zone & ask-owner
      const depth4Batch = await session.query(['packages/shared/src/chain.ts#c0'], 1);
      const depth4Answer = depth4Batch.answers[0]!;
      assert.equal(depth4Answer.kind, 'result');
      if (depth4Answer.kind === 'result' && 'verdict' in depth4Answer.value) {
        assert.deepEqual(depth4Answer.value.verdict.zones, ['payments']);
        assert.equal(depth4Answer.value.verdict.level, 'high');
        assert.equal(depth4Answer.value.verdict.action, 'ask-owner');
      }

      // Critical zone (migrations) + stale -> action ask-owner, level critical
      const critBatch = await session.query(['packages/api/migrations/001.ts#migrateQuiet']);
      const critText = renderImpact(critBatch);
      assert.match(
        critText,
        /^ACTION ask-owner · level critical \(zone migrations\) · picture partial \(stale index\)$/m,
      );
      assertOneVerdict(critText, 'stale-critical');
    } finally {
      await rm(dirname(staleRepo), { recursive: true, force: true });
    }
  });

  it('matches PROPOSED snapshots P01.txt and P02.txt', async () => {
    const p01 = renderAnswer({
      input: 'packages/payments/src/fee.ts#localOnly',
      kind: 'result',
      value: queryWithZones(repo, cacheDir, 'packages/payments/src/fee.ts#localOnly', 'default'),
    });
    const p02 = renderAnswer({
      input: 'packages/payments/src/stripe.ts#StripeProcessor.charge',
      kind: 'result',
      value: queryWithZones(
        repo,
        cacheDir,
        'packages/payments/src/stripe.ts#StripeProcessor.charge',
        'default',
      ),
    });
    assert.equal(p01, (await readFile(join(SNAP_DIR, 'P01.txt'), 'utf8')).trimEnd());
    assert.equal(p02, (await readFile(join(SNAP_DIR, 'P02.txt'), 'utf8')).trimEnd());
  });

  it('matchedRiskZones and neverReadOf handle paths containing newline characters', () => {
    const matched = matchedRiskZones(
      ['packages/payments/src/nl\nfile.ts', 'dir\n/.env'],
      'default',
    );
    assert.deepEqual(
      matched.map(({ zone, floor }) => ({ zone, floor })),
      [
        { zone: 'payments', floor: 'high' },
        { zone: 'prod-config', floor: 'critical' },
      ],
    );
    assert.equal(neverReadOf('dir\n/.env', kindOf('dir\n/.env'), defaultConfig().impact), 'secret');
  });
});
