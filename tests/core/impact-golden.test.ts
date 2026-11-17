import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { ImpactQuery } from '../../src/core/impact/query.js';
import type { ImpactResult } from '../../src/core/kernel/types.js';
import { openPublished } from '../../src/storage/sqlite.js';
import { fixtureRepo, impactOf } from './index-helpers.js';

const pay = 'packages/payments/src';
const api = 'packages/api/src';
const money = 'packages/shared/src/money.ts#roundMoney';
const fee = `${pay}/fee.ts#calculateFee`;
const charge = `${api}/charge.ts#chargeHandler`;
const code = (entries: string[]): string[] => entries.map((entry) => entry.split(': ')[0] ?? '');

async function indexed(
  prefix: string,
): Promise<{ repo: string; indexer: Indexer; close: () => Promise<void> }> {
  const repo = await fixtureRepo(prefix);
  const indexer = new Indexer(ts, repo, join(dirname(repo), 'cache'));
  return { repo, indexer, close: () => rm(dirname(repo), { recursive: true, force: true }) };
}

function result(indexer: Indexer, repo: string, target: string, depth?: number): ImpactResult {
  const db = openPublished(indexer.cacheDir);
  assert.ok(db);
  try {
    const answer = new ImpactQuery(db, impactOf(repo)).query(target, depth);
    assert.ok(answer.kind === 'result', JSON.stringify(answer));
    assert.ok('target' in answer.value, `symbol result for ${target}`);
    return answer.value;
  } finally {
    db.close();
  }
}

function has(r: ImpactResult, depth: number, symbol: string, via: string, strength?: string): void {
  assert.ok(
    r.byDepth[depth - 1]?.some(
      (n) => n.symbol === symbol && n.via === via && (!strength || n.strength === strength),
    ),
    `${symbol} via ${via} at ${depth}: ${JSON.stringify(r.byDepth)}`,
  );
}

async function build(indexer: Indexer, repo: string, full = false): Promise<void> {
  const report = await indexer.index({ impact: impactOf(repo), full, freshness: 'hash' });
  assert.deepEqual(report.problems, []);
}

describe('M2b owner-confirmed query oracle', () => {
  let repo: string;
  let indexer: Indexer;
  before(async () => {
    ({ repo, indexer } = await indexed('impact-golden'));
    await build(indexer, repo);
  });
  after(async () => rm(dirname(repo), { recursive: true, force: true }));

  it('C01 direct compiler call, complete cross-package route/public reach', () => {
    const r = result(indexer, repo, fee, 1);
    has(r, 1, `${pay}/service.ts#PaymentService.charge`, 'CALLS', 'compiler');
    assert.equal(r.completeness.status, 'complete');
    for (const factor of ['public-export-surface', 'route', 'cross-package'])
      assert.ok(r.factors.includes(factor));
    assert.equal(r.reach.crossPackage, true);
    assert.ok(r.reach.routes >= 1);
    assert.equal(r.verdict.level, 'medium');
    assert.equal(r.verdict.action, 'run-tests');
  });
  it('C02 barrel re-export resolves to original declaration', () => {
    const r = result(indexer, repo, fee);
    has(r, 1, charge, 'CALLS');
    assert.equal(r.target, fee);
    assert.equal(r.verdict.level, 'medium');
  });
  it('C03 aliased import does not create alias declaration', () => {
    const r = result(indexer, repo, fee);
    has(r, 1, 'apps/web/src/checkout.ts#submit', 'CALLS');
    assert.ok(
      ![r.target, ...r.byDepth.flat().map((n) => n.symbol)].some(
        (key) => key.split('#')[1] === 'fee',
      ),
    );
  });
  it('C04 tsconfig path alias reaches depth two with cross-package route/public factors', () => {
    const r = result(indexer, repo, money, 2);
    has(r, 1, fee, 'CALLS');
    has(r, 2, `${pay}/service.ts#PaymentService.charge`, 'CALLS');
    has(r, 2, charge, 'CALLS');
    for (const factor of ['public-export-surface', 'route', 'cross-package'])
      assert.ok(r.factors.includes(factor));
    assert.equal(r.verdict.level, 'medium');
  });
  it('C05 default class renamed through barrel preserves member call and construction', () => {
    const member = result(indexer, repo, `${pay}/service.ts#PaymentService.charge`);
    has(member, 1, charge, 'CALLS');
    assert.equal(member.verdict.level, 'medium');
    const parent = result(indexer, repo, `${pay}/service.ts#PaymentService`);
    has(parent, 1, charge, 'CONSTRUCTS');
    assert.equal(parent.verdict.level, 'medium');
  });
  it('C06 interface dispatch remains heuristic and incomplete', () => {
    const r = result(indexer, repo, `${pay}/stripe.ts#StripeProcessor.charge`);
    has(r, 1, `${pay}/checkout-flow.ts#runCheckout`, 'CALLS', 'heuristic');
    assert.equal(r.completeness.status, 'partial');
    assert.ok(code(r.completeness.reasons).includes('interface-dispatch'));
    assert.equal(r.verdict.level, 'unknown');
    assert.equal(r.verdict.action, 'check-gaps');
  });
  it('C07 callback reference is not a call', () => {
    const r = result(indexer, repo, money);
    has(r, 1, `${pay}/checkout-flow.ts#normalizeAll`, 'REFERENCES');
    assert.ok(
      !r.byDepth[0]?.some(
        (n) => n.symbol === `${pay}/checkout-flow.ts#normalizeAll` && n.via === 'CALLS',
      ),
    );
  });
  it('C08 both overload signatures resolve to one target', () => {
    assert.equal(result(indexer, repo, `${pay}/fee.ts:7`).target, fee);
    assert.equal(result(indexer, repo, `${pay}/fee.ts:8`).target, fee);
    assert.equal(result(indexer, repo, fee).target, fee);
  });
  it('C09 type-only import is a reference without pulling fee callers', () => {
    const r = result(indexer, repo, `${pay}/fee.ts#Fee`);
    assert.ok(
      r.byDepth[0]?.some(
        (n) => n.symbol.startsWith('apps/web/src/checkout.ts#') && n.via === 'REFERENCES',
      ),
    );
    assert.ok(!r.byDepth.flat().some((n) => n.via === 'CALLS'));
    assert.ok(!r.byDepth.flat().some((n) => n.symbol === charge));
    for (const caller of [
      `${pay}/service.ts#PaymentService.charge`,
      `${pay}/checkout-flow.ts#lazyFee`,
      `${pay}/fee.test.ts#<module>`,
    ]) {
      assert.ok(!r.byDepth.flat().some((n) => n.symbol === caller));
    }
    assert.ok(r.factors.includes('public-export-surface'));
    assert.equal(r.verdict.level, 'medium');
  });
  it('C10 literal dynamic import keeps a resolved call without a gap', () => {
    const r = result(indexer, repo, fee);
    assert.ok(
      r.byDepth[0]?.some(
        (n) =>
          n.symbol === `${pay}/checkout-flow.ts#lazyFee` &&
          n.via === 'CALLS' &&
          ['scope-resolved', 'compiler'].includes(n.strength),
      ),
    );
    assert.equal(r.completeness.status, 'complete');
  });
  it('C11 computed dynamic import scopes only matching handler files', () => {
    const r = result(indexer, repo, `${api}/handlers/refund.ts#refund`);
    assert.equal(r.completeness.status, 'partial');
    assert.ok(
      r.completeness.reasons.some((reason) =>
        reason.startsWith(`dynamic-import: ${api}/handlers.ts:`),
      ),
    );
    assert.equal(r.verdict.level, 'unknown');
    assert.equal(r.verdict.action, 'check-gaps');
    for (const target of [
      fee,
      money,
      `${pay}/service.ts#PaymentService.charge`,
      `${pay}/service.ts#PaymentService`,
      `${pay}/fee.ts#Fee`,
      `${pay}/stripe.ts#StripeProcessor.charge`,
    ]) {
      assert.ok(
        !code(result(indexer, repo, target).completeness.reasons).includes('dynamic-import'),
      );
    }
  });
  it('C12 route table and computed registry mark chargeHandler incomplete', () => {
    const r = result(indexer, repo, charge);
    assert.ok(
      r.byDepth[0]?.some((n) => n.symbol.startsWith(`${api}/routes.ts#`) && n.via === 'REFERENCES'),
    );
    assert.ok(
      r.byDepth[0]?.some(
        (n) => n.symbol.startsWith(`${api}/handlers.ts#`) && n.via === 'REFERENCES',
      ),
    );
    assert.equal(r.completeness.status, 'partial');
    assert.ok(code(r.completeness.reasons).includes('computed-member-access'));
    assert.ok(r.factors.includes('route'));
    assert.equal(r.verdict.level, 'unknown');
  });
  it('C13 unused public export is medium despite zero callers', () => {
    const r = result(indexer, repo, `${pay}/fee.ts#unusedHelper`);
    assert.deepEqual(r.byDepth, []);
    assert.equal(r.reach.total, 0);
    assert.equal(r.completeness.status, 'complete');
    assert.ok(r.factors.includes('public-export-surface'));
    assert.equal(r.verdict.level, 'medium');
  });
  it('C14 unexported unused local stays complete and low', () => {
    const r = result(indexer, repo, `${pay}/fee.ts#localOnly`);
    assert.deepEqual(r.byDepth, []);
    assert.deepEqual(r.reach, {
      direct: 0,
      total: 0,
      files: 0,
      packages: 0,
      crossPackage: false,
      routes: 0,
    });
    assert.equal(r.completeness.status, 'complete');
    assert.deepEqual(r.factors, []);
    assert.equal(r.verdict.level, 'low');
    assert.equal(r.verdict.action, 'proceed');
  });
  it('C15 bare charge is ambiguous with all five exact declarations', () => {
    const db = openPublished(indexer.cacheDir);
    assert.ok(db);
    try {
      const r = new ImpactQuery(db, impactOf(repo)).query('charge');
      assert.equal(r.kind, 'guidance');
      assert.equal(r.code, 'ambiguous-target');
      assert.deepEqual(
        r.candidates,
        [
          `${api}/handlers.ts#registry.charge`,
          `${pay}/manual.ts#ManualProcessor.charge`,
          `${pay}/processor.ts#PaymentProcessor.charge`,
          `${pay}/service.ts#PaymentService.charge`,
          `${pay}/stripe.ts#StripeProcessor.charge`,
        ].sort(),
      );
    } finally {
      db.close();
    }
  });
  it('C17 CommonJS require never reports zero callers as complete', () => {
    const r = result(indexer, repo, 'packages/shared/src/legacy.cjs#toCents');
    const resolved =
      r.byDepth[0]?.some((n) => n.symbol === fee && n.via === 'CALLS') &&
      r.completeness.status === 'complete' &&
      r.verdict.level === 'medium';
    const incomplete =
      r.completeness.status === 'partial' &&
      code(r.completeness.reasons).includes('cjs-require') &&
      r.verdict.level === 'unknown';
    assert.ok(resolved || incomplete);
  });
  it('C18 plain JavaScript caller participates in TypeScript target impact', () => {
    has(result(indexer, repo, money), 1, `${api}/report.js#report`, 'CALLS');
  });
  it('C19 cyclic calls visit each declaration once and never revisit target', () => {
    const target = `${pay}/cycle-a.ts#a`;
    const r = result(indexer, repo, target, 5);
    assert.deepEqual(
      r.byDepth[0]?.map((n) => `${n.symbol} ${n.via}`),
      [`${pay}/cycle-b.ts#b CALLS`],
    );
    const keys = r.byDepth.flat().map((n) => n.symbol);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(!keys.includes(target));
    assert.equal(r.reach.direct, 1);
    assert.equal(r.reach.crossPackage, false);
    assert.deepEqual(r.factors, []);
    assert.equal(r.verdict.level, 'low');
  });
  it('C20 adjacent test file appears in tests', () => {
    assert.ok(result(indexer, repo, fee).tests.includes(`${pay}/fee.test.ts`));
  });
  it('golden unknown targets never yield low or medium for any display depth', () => {
    for (const target of [
      `${pay}/stripe.ts#StripeProcessor.charge`,
      `${api}/handlers/refund.ts#refund`,
      charge,
      'packages/shared/src/legacy.cjs#toCents',
    ]) {
      const full = result(indexer, repo, target, 10);
      if (target.endsWith('#toCents') && full.completeness.status === 'complete') continue; // C17 permits outcome A.
      for (let depth = 1; depth <= 10; depth++) {
        const r = result(indexer, repo, target, depth);
        assert.equal(r.verdict.level, 'unknown', `${target} depth ${depth}`);
        assert.deepEqual(r.completeness, full.completeness);
        assert.deepEqual(r.reach, full.reach);
        assert.deepEqual(r.factors, full.factors);
      }
    }
  });
});

describe('M2b copy-only golden mutations', () => {
  async function copyCase(
    name: string,
    mutate: (repo: string) => Promise<void>,
    target: string,
  ): Promise<ImpactResult> {
    const { repo, indexer, close } = await indexed(name);
    try {
      await mutate(repo);
      await build(indexer, repo);
      const value = result(indexer, repo, target);
      if (value.verdict.level === 'unknown') {
        for (let depth = 1; depth <= 10; depth++) {
          const atDepth = result(indexer, repo, target, depth);
          assert.equal(atDepth.verdict.level, 'unknown', `${name} at depth ${depth}`);
          assert.deepEqual(atDepth.completeness, value.completeness);
          assert.deepEqual(atDepth.reach, value.reach);
          assert.deepEqual(atDepth.factors, value.factors);
        }
      }
      return value;
    } finally {
      await close();
    }
  }
  it('C16 parse error in index scope preserves callers but marks picture partial', async () => {
    const r = await copyCase(
      'impact-c16',
      (repo) => writeFile(join(repo, api, 'broken.ts'), 'export function broken( {\n'),
      fee,
    );
    has(r, 1, charge, 'CALLS');
    has(r, 1, `${pay}/service.ts#PaymentService.charge`, 'CALLS');
    has(r, 1, 'apps/web/src/checkout.ts#submit', 'CALLS');
    assert.equal(r.completeness.status, 'partial');
    assert.ok(
      r.completeness.reasons.some((reason) => reason.startsWith(`parse-error: ${api}/broken.ts`)),
    );
    assert.equal(r.verdict.level, 'unknown');
  });
  it('C21 JSX reference from Pay to Button has compiler strength', async () => {
    const r = await copyCase(
      'impact-c21',
      async (repo) => {
        await writeFile(
          join(repo, 'apps/web/src/Button.tsx'),
          'export function Button() { return null; }\n',
        );
        await writeFile(
          join(repo, 'apps/web/src/Pay.tsx'),
          "import { Button } from './Button';\nexport function Pay() { return <Button />; }\n",
        );
      },
      'apps/web/src/Button.tsx#Button',
    );
    has(r, 1, 'apps/web/src/Pay.tsx#Pay', 'REFERENCES', 'compiler');
    assert.equal(r.completeness.status, 'complete');
  });
  it('C22 unresolved member-name match makes localOnly partial', async () => {
    const r = await copyCase(
      'impact-c22',
      (repo) => writeFile(join(repo, pay, 'loose.js'), 'function loose(obj) { obj.localOnly() }\n'),
      `${pay}/fee.ts#localOnly`,
    );
    assert.equal(r.completeness.status, 'partial');
    assert.ok(
      r.completeness.reasons.some((reason) =>
        reason.startsWith(`unresolved-name-match: ${pay}/loose.js:`),
      ),
    );
    assert.equal(r.verdict.level, 'unknown');
  });
  it('C23 string token matching an unused exported symbol makes picture partial', async () => {
    const r = await copyCase(
      'impact-c23',
      (repo) => writeFile(join(repo, api, 'names.ts'), "export const k = 'unusedHelper';\n"),
      `${pay}/fee.ts#unusedHelper`,
    );
    assert.ok(code(r.completeness.reasons).includes('string-name-match'));
    assert.equal(r.completeness.status, 'partial');
    assert.equal(r.verdict.level, 'unknown');
  });
  it('C24 SQL boundary is factor, not gap', async () => {
    const r = await copyCase(
      'impact-c24',
      (repo) =>
        writeFile(
          join(repo, api, 'db.ts'),
          "import { Client } from 'pg';\nexport function findUser() { return Client; }\n",
        ),
      `${api}/db.ts#findUser`,
    );
    assert.ok(r.factors.includes('boundary:sql'));
    assert.equal(r.completeness.status, 'complete');
    assert.equal(r.verdict.level, 'medium');
  });
  it('C25 glob-matched route in temp copy affects full reach', async () => {
    const r = await copyCase(
      'impact-c25',
      async (repo) => {
        const config = JSON.parse(await readFile(join(repo, 'ei.config.json'), 'utf8'));
        config.impact.routes = ['apps/web/app/**/page.tsx'];
        await writeFile(join(repo, 'ei.config.json'), JSON.stringify(config));
        await mkdir(join(repo, 'apps/web/app/pay'), { recursive: true });
        await writeFile(
          join(repo, 'apps/web/app/pay/page.tsx'),
          "import { calculateFee } from '@fx/payments';\nexport default function Page() { calculateFee(1); return null; }\n",
        );
      },
      fee,
    );
    assert.ok(r.factors.includes('route'));
    assert.ok(r.reach.routes >= 1);
  });
  it('C26 nine callers stay low; ten trigger many-callers medium', async () => {
    const { repo, indexer, close } = await indexed('impact-c26');
    const file = join(repo, 'packages/shared/src/many.ts');
    const callers = (count: number): string =>
      `function tiny() {}\n${Array.from({ length: count }, (_, i) => `function f${i}() { tiny(); }`).join('\n')}\n`;
    try {
      await writeFile(file, callers(9));
      await build(indexer, repo);
      const nine = result(indexer, repo, 'packages/shared/src/many.ts#tiny');
      assert.equal(nine.reach.total, 9);
      assert.deepEqual(nine.factors, []);
      assert.equal(nine.verdict.level, 'low');
      await writeFile(file, callers(10));
      await build(indexer, repo);
      const ten = result(indexer, repo, 'packages/shared/src/many.ts#tiny');
      assert.equal(ten.reach.total, 10);
      assert.ok(ten.factors.includes('many-callers'));
      assert.equal(ten.verdict.level, 'medium');
    } finally {
      await close();
    }
  });
});
