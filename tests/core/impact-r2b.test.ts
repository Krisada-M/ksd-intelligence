import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { ImpactQuery, type ImpactAnswer } from '../../src/core/impact/query.js';
import type { ImpactConfig } from '../../src/core/kernel/config.js';
import type { ImpactResult } from '../../src/core/kernel/types.js';
import { initProject } from '../../src/core/workspace/init.js';
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

describe('D56 / G15 — common-name factor', () => {
  const USE = 'packages/api/src/use-common.ts';
  let db: DatabaseSync;
  let config: ImpactConfig;
  let close: () => Promise<void>;

  before(async () => {
    const files: Record<string, string> = {
      [USE]: [
        'export function runLoose(obj: any): string {',
        '  obj.common();',
        '  obj.common();',
        '  const s1: string = "common";',
        '  const s2: string = "rare";',
        '  return s1 + s2;',
        '}',
      ].join('\n'),
      [`${SHARED}/rare.ts`]: 'export function rare(): number { return 1; }\n',
    };
    for (let i = 0; i < 11; i++) {
      files[`${SHARED}/common-${i}.ts`] = `export function common(): number { return ${i}; }\n`;
    }
    ({ db, config, close } = await copyIndex('r5-common-name', files));
  });
  after(async () => await close());

  it('a name shared by more than commonName declarations gets the common-name factor and stays complete', () => {
    const c0 = result(new ImpactQuery(db, config).query(`${SHARED}/common-0.ts#common`, 10));
    assert.equal(c0.completeness.status, 'complete');
    assert.ok(!reason(c0, 'unresolved-name-match'));
    assert.ok(!reason(c0, 'string-name-match'));
    assert.ok(c0.factors.includes('common-name'));
    assert.equal(c0.verdict.level, 'medium');
    assert.equal(c0.verdict.action, 'run-tests');
    assert.ok(
      c0.verdict.basis.includes(
        'common-name: 11 declarations named "common"; 2 untyped uses, 1 equal strings not attributed',
      ),
      JSON.stringify(c0.verdict.basis),
    );
  });

  it('at the threshold (commonName = 11) the name keeps its completeness reasons and site lists', () => {
    const c0 = result(
      new ImpactQuery(db, { ...config, commonName: 11 }).query(`${SHARED}/common-0.ts#common`, 10),
    );
    assert.equal(c0.completeness.status, 'partial');
    assert.ok(reason(c0, 'unresolved-name-match'));
    assert.ok(reason(c0, 'string-name-match'));
    assert.ok(!c0.factors.includes('common-name'));
    assert.equal(c0.verdict.level, 'unknown');
    assert.equal(c0.verdict.action, 'check-gaps');
  });

  it('a rare name stays partial with its site list', () => {
    const rare = result(new ImpactQuery(db, config).query(`${SHARED}/rare.ts#rare`, 10));
    assert.equal(rare.completeness.status, 'partial');
    assert.ok(reason(rare, 'string-name-match'));
    assert.ok(!rare.factors.includes('common-name'));
    assert.equal(rare.verdict.level, 'unknown');
  });
});

describe('D57 / W1 — default scope and out-of-scope lexical name scan', () => {
  it('reproduces W1: src/ function called only from tests/ is never low/complete under ei init defaults', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-w1-repro-')));
    const repo = join(work, 'repo');
    const cache = join(work, 'cache');
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await mkdir(join(repo, 'tests'), { recursive: true });
      await writeFile(
        join(repo, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
          },
          include: ['src'],
        }),
      );
      await writeFile(
        join(repo, 'tests/tsconfig.json'),
        JSON.stringify({
          extends: '../tsconfig.json',
          include: ['../src', './**/*.ts'],
        }),
      );
      await writeFile(
        join(repo, 'src/graph.ts'),
        'export class Graph {\n  incoming(): number { return 1; }\n}\n',
      );
      await writeFile(
        join(repo, 'tests/graph.test.ts'),
        "import { Graph } from '../src/graph.js';\nexport function verifyIncoming(): number { return new Graph().incoming(); }\n",
      );
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'init', '-q']);
      execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
      execFileSync('git', [
        '-C',
        repo,
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-qm',
        'init',
      ]);

      const initialized = await initProject({ root: repo, cacheHome: work, dryRun: true });
      const report = await new Indexer(ts, repo, cache).index({
        impact: initialized.config.impact,
        full: true,
        freshness: 'hash',
      });
      assert.deepEqual(report.problems, []);
      const db = openPublished(cache);
      assert.ok(db);
      try {
        const impact = result(
          new ImpactQuery(db, initialized.config.impact).query('Graph.incoming'),
        );
        const hasTestCaller =
          impact.byDepth[0]?.some((n) => n.symbol === 'tests/graph.test.ts#verifyIncoming') &&
          impact.tests.includes('tests/graph.test.ts');
        const isPartialWithMatch =
          impact.completeness.status === 'partial' &&
          linesOf(impact, 'unresolved-name-match', 'tests/graph.test.ts').includes(2);
        assert.ok(
          hasTestCaller || isPartialWithMatch,
          `expected test caller or partial match, got: ${JSON.stringify(impact)}`,
        );
        assert.ok(
          !(impact.verdict.level === 'low' && impact.reach.total === 0),
          'must never be low with zero callers when called from tests/',
        );
        assert.ok(hasTestCaller, 'ei init default include must include tests/**');
      } finally {
        db.close();
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('lexically scans out-of-scope and owner-excluded code files, never reads node_modules or secret .json, and applies common-name', async () => {
    const files: Record<string, string> = {
      'ei.config.json': JSON.stringify({
        impact: {
          include: ['packages/**', 'apps/**'],
          exclude: ['**/dist/**', 'packages/api/src/generated/**'],
          freshness: 'hash',
        },
      }),
      'tests/outside-caller.ts':
        'export function callOutside(x: any) { x.localOnly(); x.sharedCommon(); }\n',
      'packages/api/src/generated/client.ts': 'export function gen(x: any) { x.unusedHelper(); }\n',
      'packages/api/src/secrets/credentials.json': '{"secret":"cycle-a","a":"a"}\n',
    };
    for (let i = 0; i < 11; i++) {
      files[`${SHARED}/shared-common-${i}.ts`] =
        `export function sharedCommon(): number { return ${i}; }\n`;
    }
    const { repo, db, config, close } = await copyIndex('d57-lexical-scope', files, async (r) => {
      // Unreadable node_modules and secret-named .json: reading either would throw EACCES.
      await mkdir(join(r, 'node_modules/pkg'), { recursive: true });
      await writeFile(
        join(r, 'node_modules/pkg/index.ts'),
        'export function nm(x: any) { x.a(); }\n',
      );
      if (process.getuid?.() !== 0) {
        chmodSync(join(r, 'node_modules/pkg/index.ts'), 0o000);
        chmodSync(join(r, 'packages/api/src/secrets/credentials.json'), 0o000);
      }
    });
    try {
      const q = new ImpactQuery(db, config);

      // 1. Target matched only in out-of-scope tests/outside-caller.ts is partial, never complete/low.
      const local = result(q.query(`${PAY}/fee.ts#localOnly`, 10));
      assert.equal(local.completeness.status, 'partial');
      assert.equal(local.verdict.level, 'unknown');
      assert.ok(linesOf(local, 'unresolved-name-match', 'tests/outside-caller.ts').includes(1));

      // 2. Target matched in owner-excluded generated/ file is partial.
      const helper = result(q.query(`${PAY}/fee.ts#unusedHelper`, 10));
      assert.equal(helper.completeness.status, 'partial');
      assert.equal(helper.verdict.level, 'unknown');
      assert.ok(
        linesOf(helper, 'unresolved-name-match', 'packages/api/src/generated/client.ts').includes(
          1,
        ),
      );

      // 3. node_modules and secret-named .json were never read; cycle-a#a stays complete/low.
      const a = result(q.query(`${PAY}/cycle-a.ts#a`, 10));
      assert.equal(a.completeness.status, 'complete');
      assert.equal(a.verdict.level, 'low');

      // 4. Name shared by > commonName declarations matched in out-of-scope file gives common-name, not reason.
      const common = result(q.query(`${SHARED}/shared-common-0.ts#sharedCommon`, 10));
      assert.equal(common.completeness.status, 'complete');
      assert.ok(!reason(common, 'unresolved-name-match'));
      assert.ok(common.factors.includes('common-name'));
      assert.equal(common.verdict.level, 'medium');
      assert.ok(repo);
    } finally {
      await close();
    }
  });
});
