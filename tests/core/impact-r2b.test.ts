import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { ImpactQuery, type ImpactAnswer } from '../../src/core/impact/query.js';
import type { ImpactConfig } from '../../src/core/kernel/config.js';
import type { ImpactResult } from '../../src/core/kernel/types.js';
import { fixtureRepo, impactOf } from './index-helpers.js';
import { openPublished } from '../../src/storage/sqlite.js';

const SHARED = 'packages/shared/src';
const PAY = 'packages/payments/src';

function result(answer: ImpactAnswer): ImpactResult {
  assert.equal(answer.kind, 'result');
  assert.ok(answer.kind === 'result' && 'target' in answer.value);
  return answer.value;
}

function reason(value: ImpactResult, code: string): boolean {
  return value.completeness.reasons.some((entry) => entry.startsWith(`${code}:`));
}

function linesOf(value: ImpactResult, code: string, file: string): number[] {
  return value.completeness.reasons
    .filter((entry) => entry.startsWith(`${code}: ${file}:`))
    .map((entry) => Number.parseInt(entry.slice(`${code}: ${file}:`.length), 10))
    .sort((a, b) => a - b);
}

/** A fixture copy with `files` written (and `edit` applied), indexed; the db stays open. */
async function copyIndex(
  prefix: string,
  files: Record<string, string>,
  edit?: (repo: string) => Promise<void>,
): Promise<{
  repo: string;
  db: DatabaseSync;
  config: ImpactConfig;
  close: () => Promise<void>;
}> {
  const repo = await fixtureRepo(prefix);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, file)), { recursive: true });
    await writeFile(join(repo, file), content);
  }
  await edit?.(repo);
  const cache = join(repo, '..', 'cache');
  const report = await new Indexer(ts, repo, cache).index({ impact: impactOf(repo) });
  assert.deepEqual(report.problems, []);
  const db = openPublished(cache);
  assert.ok(db);
  return {
    repo,
    db,
    config: impactOf(repo),
    close: async () => {
      db.close();
      await rm(dirname(repo), { recursive: true, force: true });
    },
  };
}

describe('D55 item 1 — traversal runs to closure under a node budget', () => {
  const CHAIN = `${SHARED}/chain25.ts`;
  const chain = Array.from(
    { length: 26 },
    (_, n) => `function c${n}(): number { return ${n === 0 ? '0' : `c${n - 1}()`}; }`,
  ).join('\n');
  let repo: string;
  let db: DatabaseSync;
  let config: ImpactConfig;
  let close: () => Promise<void>;

  before(async () => {
    ({ repo, db, config, close } = await copyIndex('r2b-closure', { [CHAIN]: chain }));
    assert.ok(repo);
  });
  after(async () => await close());

  it('a chain of 25 callers is complete and counted in reach at every depth', () => {
    const shallow = result(new ImpactQuery(db, config).query(`${CHAIN}#c0`, 1));
    assert.equal(shallow.completeness.status, 'complete');
    assert.ok(!reason(shallow, 'depth-limit'));
    assert.equal(shallow.reach.total, 25);
    assert.equal(shallow.byDepth.length, 1);
    const deep = result(new ImpactQuery(db, config).query(`${CHAIN}#c0`, 10));
    assert.equal(deep.byDepth.length, 10);
    assert.deepEqual(deep.completeness, shallow.completeness);
    assert.deepEqual(deep.reach, shallow.reach);
    assert.deepEqual(deep.factors, shallow.factors);
    assert.deepEqual(deep.verdict, shallow.verdict);
  });

  it('the node budget, not depth, caps the traversal and adds depth-limit', () => {
    const capped = result(new ImpactQuery(db, config, { nodeBudget: 5 }).query(`${CHAIN}#c0`, 10));
    assert.equal(capped.completeness.status, 'partial');
    assert.ok(reason(capped, 'depth-limit'));
    assert.equal(capped.reach.total, 4);
    assert.equal(capped.verdict.level, 'unknown');
    assert.equal(capped.verdict.action, 'check-gaps');
  });
});

describe('D55 items 2 and 3 — unbounded dynamic imports scope and repository limits', () => {
  const LOADER = 'packages/api/src/dynloader.ts';
  const REQUIRER = 'packages/api/src/requirer.ts';
  const ISOLATED = 'packages/api/src/isolated.ts';
  const ENTRYPOINT = `${PAY}/entrypoint.ts`;
  const ISOLATED_TEST = 'packages/api/src/isolated.test.ts';
  let db: DatabaseSync;
  let config: ImpactConfig;
  let close: () => Promise<void>;

  before(async () => {
    ({ db, config, close } = await copyIndex(
      'r2b-loose-import',
      {
        [LOADER]: 'export function loadAny(p: string): Promise<unknown> { return import(p); }\n',
        [REQUIRER]: 'export function requireAny(p: string): unknown { return require(p); }\n',
        [ISOLATED]: 'export function island(): number { return 1; }\n',
        [ENTRYPOINT]: 'export function entryFn(): number { return 1; }\n',
        [ISOLATED_TEST]: 'export function testOnlyHelper(): number { return 2; }\n',
        '.env': 'SECRET=calculateFee\n',
        'dist/generated.ts': 'export const calculateFee = 1;\n',
        'tools/outside.ts': 'export function calculateFee(): number { return 3; }\n',
      },
      async (repo) => {
        await writeFile(
          join(repo, 'packages/payments/package.json'),
          JSON.stringify({ name: '@fx/payments', main: 'src/entrypoint.ts' }),
        );
      },
    ));
  });
  after(async () => await close());

  it('an exported target in a file with no static importer is partial with both sites listed', () => {
    const island = result(new ImpactQuery(db, config).query(`${ISOLATED}#island`, 10));
    assert.equal(island.completeness.status, 'partial');
    assert.ok(
      island.completeness.reasons.some((entry) => entry.startsWith(`dynamic-import: ${LOADER}:`)),
      JSON.stringify(island.completeness.reasons),
    );
    assert.ok(
      island.completeness.reasons.some((entry) => entry.startsWith(`cjs-require: ${REQUIRER}:`)),
      JSON.stringify(island.completeness.reasons),
    );
    assert.equal(island.verdict.level, 'unknown');
  });

  it('repository limits accompany results without becoming completeness reasons', () => {
    const island = result(new ImpactQuery(db, config).query(`${ISOLATED}#island`, 10));
    assert.deepEqual(island.limits, {
      unboundedDynamicImports: 2,
      excludedFiles: 3,
      failedFiles: 0,
    });
    assert.ok(!reason(island, 'outside-index-scope'));
  });

  it('a statically imported file is complete; the sites are repository limits, not reasons', () => {
    // cycle-b.ts imports cycle-a.ts statically, so the prefix-less import cannot add a caller.
    const a = result(new ImpactQuery(db, config).query(`${PAY}/cycle-a.ts#a`, 10));
    assert.equal(a.completeness.status, 'complete');
    assert.ok(!reason(a, 'dynamic-import'));
    assert.ok(!reason(a, 'cjs-require'));
    assert.equal(a.limits.unboundedDynamicImports, 2);
    assert.equal(a.limits.excludedFiles, 3);
    assert.equal(a.limits.failedFiles, 0);
  });

  it('test files and package entry files are excepted from the scope', () => {
    const query = new ImpactQuery(db, config);
    const helper = result(query.query(`${ISOLATED_TEST}#testOnlyHelper`, 10));
    assert.equal(helper.completeness.status, 'complete');
    assert.ok(!reason(helper, 'dynamic-import'));
    assert.ok(!reason(helper, 'cjs-require'));
    const entry = result(query.query(`${ENTRYPOINT}#entryFn`, 10));
    assert.equal(entry.completeness.status, 'complete');
    assert.ok(!reason(entry, 'dynamic-import'));
    assert.ok(!reason(entry, 'cjs-require'));
  });

  it('an unexported declaration in an unimported file stays complete', () => {
    const query = new ImpactQuery(db, config);
    const local = result(query.query(`${PAY}/fee.ts#localOnly`, 10));
    assert.equal(local.completeness.status, 'complete');
  });
});

describe('D55 item 4 — code files without a tsconfig feed the name cross-check', () => {
  const LOOSE = 'tools/loose.ts';
  let repo: string;
  let db: DatabaseSync;
  let config: ImpactConfig;
  let close: () => Promise<void>;

  before(async () => {
    ({ repo, db, config, close } = await copyIndex('r2b-orphan', {
      // The root tsconfig stops claiming every file: tools/ has no owning config.
      'tsconfig.json':
        '{"extends":"./tsconfig.base.json","include":["packages/**/*","apps/**/*"]}\n',
      'ei.config.json':
        '{"impact":{"include":["packages/**","apps/**","tools/**"],"freshness":"hash"}}\n',
      [LOOSE]: [
        'export function looseRun(): number {',
        '  const target = calculateFee;',
        '  const key = "unusedHelper";',
        '  return target === undefined ? key.length : 0;',
        '}',
      ].join('\n'),
      'tools/.env': 'calculateFee=mentioned-but-secret\n',
      'tools/dist/skip.ts': 'export const calculateFee = 1;\n',
    }));
    const row = db.prepare('SELECT status, reason FROM files WHERE path = ?').get(LOOSE);
    assert.deepEqual({ ...row }, { status: 'orphan', reason: 'no-tsconfig' });
  });
  after(async () => await close());

  it('identifier and string matches from the orphan file make the targets partial', () => {
    const query = new ImpactQuery(db, config);
    const fee = result(query.query(`${PAY}/fee.ts#calculateFee`, 10));
    assert.ok(reason(fee, 'unresolved-name-match'), JSON.stringify(fee.completeness.reasons));
    assert.ok(linesOf(fee, 'unresolved-name-match', LOOSE).includes(2));
    const helper = result(query.query(`${PAY}/fee.ts#unusedHelper`, 10));
    assert.ok(reason(helper, 'string-name-match'), JSON.stringify(helper.completeness.reasons));
    assert.ok(linesOf(helper, 'string-name-match', LOOSE).includes(3));
  });

  it('secret and excluded files are never read for the cross-check', () => {
    const query = new ImpactQuery(db, config);
    for (const target of [`${PAY}/fee.ts#calculateFee`, `${PAY}/fee.ts#unusedHelper`]) {
      const value = result(query.query(target, 10));
      assert.ok(
        value.completeness.reasons.every(
          (entry) => !entry.includes('tools/.env') && !entry.includes('tools/dist/skip.ts'),
        ),
        JSON.stringify(value.completeness.reasons),
      );
    }
  });

  it('an update re-scans the orphan file after an edit', async () => {
    await writeFile(join(repo, LOOSE), 'export function looseRun(): number { return 0; }\n');
    const report = await new Indexer(ts, repo, join(repo, '..', 'cache')).index({
      impact: impactOf(repo),
    });
    assert.deepEqual(report.problems, []);
    const updated = openPublished(join(repo, '..', 'cache'));
    assert.ok(updated);
    try {
      const fee = result(new ImpactQuery(updated, config).query(`${PAY}/fee.ts#calculateFee`, 10));
      assert.deepEqual(linesOf(fee, 'unresolved-name-match', LOOSE), []);
    } finally {
      updated.close();
    }
  });
});

describe('D55 item 5 — typed string literals are not name matches', () => {
  const DISC = 'packages/api/src/discriminant.ts';
  const INPUT = `${SHARED}/input.ts`;
  let db: DatabaseSync;
  let config: ImpactConfig;
  let close: () => Promise<void>;

  before(async () => {
    ({ db, config, close } = await copyIndex('r2b-typed-literals', {
      [INPUT]: 'export function input(): number { return 1; }\n',
      [DISC]: [
        'export type Shape =',
        '  | { kind: "input"; value: number }',
        '  | { kind: "output"; value: number };',
        'export const typed: Shape = { kind: "input", value: 1 };',
        'export const kindString: string = "input";',
        'export function takesAny(x: any): void { takesAny2("input"); void x; }',
        'declare function takesAny2(x: any): void;',
      ].join('\n'),
    }));
  });
  after(async () => await close());

  it('only string- and any-typed literals match; discriminants do not', () => {
    const input = result(new ImpactQuery(db, config).query(`${INPUT}#input`, 10));
    const found = linesOf(input, 'string-name-match', DISC);
    assert.deepEqual(found, [5, 6], JSON.stringify(input.completeness.reasons));
    assert.equal(input.completeness.status, 'partial');
  });
});

describe('D55 items 6 and 7 — value flow into containers and arrays', () => {
  const PRESETS = `${SHARED}/presets.ts`;
  const THEME = 'packages/api/src/theme.ts';
  const ARRAY = `${SHARED}/array.ts`;
  let db: DatabaseSync;
  let config: ImpactConfig;
  let close: () => Promise<void>;

  before(async () => {
    ({ db, config, close } = await copyIndex('r2b-value-flow', {
      [PRESETS]: [
        'export type SymbolKey = "boxRound.topRight" | "boxRound.bottomRight";',
        'export const PRESETS: Record<SymbolKey, string> = {',
        '  "boxRound.topRight": "corner-top", "boxRound.bottomRight": "corner-bottom",',
        '};',
      ].join('\n'),
      [THEME]: [
        'import { PRESETS, type SymbolKey } from "@fx/shared/presets";',
        'type SymbolMap = Record<SymbolKey, string>;',
        'export class Theme {',
        '  readonly symbols: SymbolMap = { ...PRESETS };',
        '  pick(k: SymbolKey): string { return this.symbols[k]; }',
        '}',
      ].join('\n'),
      [ARRAY]: [
        'export function a(): number { return 1; }',
        'export function b(): number { return 2; }',
        'export const hs = [a, b];',
        'export function run(i: number): number { return hs[i](); }',
      ].join('\n'),
    }));
  });
  after(async () => await close());

  it('a preset member lists the storing symbol, then its readers, with no gap', () => {
    const member = result(
      new ImpactQuery(db, config).query(`${PRESETS}#PRESETS.boxRound.topRight`, 10),
    );
    assert.ok(
      member.byDepth[0]?.some((n) => n.symbol === `${THEME}#Theme.symbols`),
      JSON.stringify(member.byDepth),
    );
    assert.ok(
      member.byDepth[1]?.some((n) => n.symbol === `${THEME}#Theme.pick`),
      JSON.stringify(member.byDepth),
    );
    assert.ok(!reason(member, 'computed-member-access'));
    assert.equal(member.completeness.status, 'complete');
    assert.ok(member.factors.includes('cross-package'));
  });

  it('an array of functions chains through the array declaration with no gap', () => {
    const a = result(new ImpactQuery(db, config).query(`${ARRAY}#a`, 10));
    assert.ok(
      a.byDepth[0]?.some((n) => n.symbol === `${ARRAY}#hs` && n.via === 'REFERENCES'),
      JSON.stringify(a.byDepth),
    );
    assert.ok(
      a.byDepth[1]?.some((n) => n.symbol === `${ARRAY}#run`),
      JSON.stringify(a.byDepth),
    );
    assert.ok(!reason(a, 'computed-member-access'));
    assert.equal(a.completeness.status, 'complete');
    assert.equal(a.reach.total, 2);
  });
});
