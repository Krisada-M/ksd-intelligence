import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { ImpactQuery, type ImpactAnswer } from '../../src/core/impact/query.js';
import type { ImpactResult } from '../../src/core/kernel/types.js';
import { openPublished } from '../../src/storage/sqlite.js';
import { fixtureRepo, impactOf } from './index-helpers.js';

const SHARED = 'packages/shared/src';
const FLOW = `${SHARED}/gap-flow.ts`;
const LINES = `${SHARED}/line-target.ts`;
const FEE = 'packages/payments/src/fee.ts#calculateFee';

function result(answer: ImpactAnswer): ImpactResult {
  assert.equal(answer.kind, 'result');
  assert.ok(answer.kind === 'result' && 'target' in answer.value);
  return answer.value;
}

function reason(value: ImpactResult, code: string): boolean {
  return value.completeness.reasons.some((entry) => entry.startsWith(`${code}:`));
}

describe('impact query edge cases and D54 target-only gaps', () => {
  let repo: string;
  let db: DatabaseSync;
  let query: ImpactQuery;
  before(async () => {
    repo = await fixtureRepo('impact-risk');
    const files: Record<string, string> = {
      [FLOW]: [
        'function leaf(): number { return 1; }',
        'function first(): number { return leaf(); }',
        'function second(): number { return first(); }',
        'function third(): number { return second(); }',
        'const dispatch = { third };',
        'export function invoke(key: keyof typeof dispatch): number { return dispatch[key](); }',
        'function unrelated(): number { return 2; }',
      ].join('\n'),
      [LINES]: [
        'export function outer(): number {',
        '  function local(): number {',
        '    return 1;',
        '  }',
        '  return local();',
        '}',
        '',
        'function quiet(): number { return 2; }',
        '',
      ].join('\n'),
      [`${SHARED}/chain.ts`]: Array.from(
        { length: 13 },
        (_, n) => `function chain${n}(): number { return ${n === 0 ? '0' : `chain${n - 1}()`}; }`,
      ).join('\n'),
      [`${SHARED}/anonymous.ts`]:
        'export interface Usage { cost: { input: number }; }\nexport function costOf(u: Usage) { return u.cost; }\n',
      [`${SHARED}/test-only.ts`]: 'export function onlyTested(): number { return 1; }\n',
      [`${SHARED}/test-only.test.ts`]: 'import { onlyTested } from "./test-only";\nonlyTested();\n',
      [`${SHARED}/empty.ts`]: 'function noExport(): number { return 1; }\n',
      [`${SHARED}/dupe.ts`]: 'export function quiet(): number { return 3; }\n',
      [`${SHARED}/file-target.ts`]:
        'export function used(): number { return 1; }\nexport function unused(): number { return 2; }\n',
      [`${SHARED}/file-user.ts`]:
        'import { used } from "./file-target";\nexport const externalUser = used();\n',
      [`${SHARED}/native.ts`]:
        'import { NativeModules } from "react-native";\nexport function nativeCall() { return NativeModules.Device.ping(); }\n',
      [`${SHARED}/sql.ts`]:
        'declare function sql(text: TemplateStringsArray): unknown;\nexport function sqlCall() { return sql`SELECT 1`; }\n',
      'orphan.ts': 'export const orphanValue = 1;\n',
      'data.json': '{"value":1}\n',
      '.env': 'SECRET=not-a-real-credential\n',
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, file)), { recursive: true });
      await writeFile(join(repo, file), content);
    }
    const cache = join(repo, '..', 'cache');
    const report = await new Indexer(ts, repo, cache).index({ impact: impactOf(repo) });
    assert.deepEqual(report.problems, []);
    const opened = openPublished(cache);
    assert.ok(opened);
    db = opened;
    query = new ImpactQuery(db, impactOf(repo));
  });
  after(async () => {
    db?.close();
    if (repo) await rm(dirname(repo), { recursive: true, force: true });
  });

  it('gaps apply to their target, not to callers one or three levels below it', () => {
    const direct = result(query.query(`${FLOW}#third`, 10));
    assert.equal(direct.completeness.status, 'partial');
    assert.ok(reason(direct, 'computed-member-access'));
    for (const name of ['second', 'leaf']) {
      const value = result(query.query(`${FLOW}#${name}`, 10));
      assert.equal(value.completeness.status, 'complete');
      assert.equal(value.verdict.level, 'low');
      assert.equal(
        value.byDepth.flat().find((node) => node.symbol === `${FLOW}#third`)?.gapScoped,
        true,
      );
    }
    const unrelated = result(query.query(`${FLOW}#unrelated`, 10));
    assert.equal(unrelated.completeness.status, 'complete');
    assert.equal(unrelated.verdict.level, 'low');
  });

  it('display depth cannot change completeness, reach, factors, or verdict', () => {
    for (const target of [FEE, `${FLOW}#leaf`, `${FLOW}#third`]) {
      const shallow = result(query.query(target, 1));
      const deep = result(query.query(target, 10));
      for (const field of ['completeness', 'reach', 'factors', 'verdict'] as const) {
        assert.deepEqual(shallow[field], deep[field], `${target}: ${field}`);
      }
    }
    assert.ok(result(query.query(`${FLOW}#leaf`, 10)).byDepth.length > 1);
    assert.equal(result(query.query(`${FLOW}#leaf`, 1)).byDepth.length, 1);
  });

  it('a chain longer than ten closes completely; only the node budget adds depth-limit', () => {
    const value = result(query.query(`${SHARED}/chain.ts#chain0`, 10));
    assert.equal(value.byDepth.length, 10);
    assert.equal(value.reach.total, 12);
    assert.equal(value.completeness.status, 'complete');
    assert.ok(value.factors.includes('many-callers'));
    assert.equal(value.verdict.level, 'medium');
    const capped = result(
      new ImpactQuery(db, impactOf(repo), { nodeBudget: 3 }).query(`${SHARED}/chain.ts#chain0`, 10),
    );
    assert.ok(reason(capped, 'depth-limit'));
    assert.equal(capped.verdict.level, 'unknown');
  });

  it('a cycle terminates without counting its starting declaration twice', () => {
    const cycle = result(query.query('packages/payments/src/cycle-a.ts#a', 10));
    assert.equal(cycle.reach.direct, 1);
    assert.equal(cycle.reach.total, 1);
    assert.deepEqual(
      cycle.byDepth.flat().map((node) => node.symbol),
      ['packages/payments/src/cycle-b.ts#b'],
    );
    assert.equal(cycle.completeness.status, 'complete');
  });

  it('name lookup preserves ambiguity and provides at most five closest names', () => {
    assert.equal(result(query.query('onlyTested')).target, `${SHARED}/test-only.ts#onlyTested`);
    const ambiguous = query.query('quiet');
    assert.ok(ambiguous.kind === 'guidance');
    assert.equal(ambiguous.code, 'ambiguous-target');
    assert.deepEqual(ambiguous.candidates, [`${SHARED}/dupe.ts#quiet`, `${LINES}#quiet`]);
    const absent = query.query('calculateFe');
    assert.ok(absent.kind === 'guidance');
    assert.equal(absent.code, 'target-not-found');
    assert.ok(absent.nearest && absent.nearest.length <= 5);
    assert.ok(absent.nearest.includes(FEE));
  });

  it('line targets resolve declaration and local-function bodies without inventing declarations', () => {
    for (const line of [1, 3, 5]) {
      const answer = query.query(`${LINES}:${line}`);
      assert.equal(result(answer).target, `${LINES}#outer`);
      if (line === 3) assert.equal(answer.resolvedFromLine, 3);
    }
    assert.equal(result(query.query(`${LINES}:7`)).target, `${LINES}#<module>`);
    const beyond = query.query(`${LINES}:1000`);
    assert.ok(beyond.kind === 'guidance');
    assert.equal(beyond.code, 'target-not-found');
  });

  it('unindexed paths return census guidance rather than zero-callers results', () => {
    for (const file of ['.env', 'data.json', 'orphan.ts']) {
      const answer = query.query(file);
      assert.ok(answer.kind === 'guidance', file);
      assert.match(answer.message, /NOT INDEXED/);
      assert.ok(answer.message.includes(file));
    }
  });

  it('file targets select exports used outside the file and count the rest', () => {
    const empty = query.query(`${SHARED}/empty.ts`);
    assert.ok(empty.kind === 'result' && 'file' in empty.value);
    assert.deepEqual(empty.value.results, []);
    const answer = query.query(`${SHARED}/file-target.ts`);
    assert.ok(answer.kind === 'result' && 'file' in answer.value);
    assert.deepEqual(
      answer.value.results.map((value) => value.target),
      [`${SHARED}/file-target.ts#used`],
    );
    assert.equal(answer.value.remainder, 1);
  });

  it('anonymous members retain the requested member and the nearest indexed parent', () => {
    const target = `${SHARED}/anonymous.ts#Usage.cost.input`;
    const answer = query.query(target);
    const value = result(answer);
    assert.equal(answer.input, target);
    assert.equal(answer.parentTarget, `${SHARED}/anonymous.ts#Usage.cost`);
    assert.equal(value.target, answer.parentTarget);
    assert.equal(value.completeness.status, 'partial');
    assert.ok(reason(value, 'outside-index-scope'));
    assert.equal(value.verdict.level, 'unknown');
  });

  it('test-only users are both listed as tests and counted as compiler-grade reach', () => {
    const value = result(query.query(`${SHARED}/test-only.ts#onlyTested`));
    assert.deepEqual(value.tests, [`${SHARED}/test-only.test.ts`]);
    assert.equal(value.reach.direct, 1);
    assert.equal(value.reach.total, 1);
    assert.equal(value.reach.files, 1);
    assert.equal(value.reach.packages, 1);
    assert.equal(value.verdict.level, 'low');
  });

  it('public barrel factors and native/SQL boundary factors use published evidence', () => {
    assert.ok(result(query.query('unusedHelper')).factors.includes('public-export-surface'));
    assert.ok(!result(query.query('onlyTested')).factors.includes('public-export-surface'));
    assert.ok(result(query.query('nativeCall')).factors.includes('boundary:native'));
    assert.ok(result(query.query('sqlCall')).factors.includes('boundary:sql'));
    const heuristic = result(query.query('StripeProcessor.charge'));
    assert.ok(heuristic.byDepth.flat().some((node) => node.strength === 'heuristic'));
    assert.equal(heuristic.reach.total, 0);
    assert.deepEqual(heuristic.bridged, []);
  });

  it('a mixed batch answers the other targets despite ambiguity and missing names', () => {
    const answers = query.batch([
      'onlyTested',
      'charge',
      'notARealTarget',
      'unusedHelper',
      'localOnly',
    ]);
    assert.equal(answers.length, 5);
    assert.deepEqual(
      answers.map((answer) => answer.kind),
      ['result', 'guidance', 'guidance', 'result', 'result'],
    );
    const first = answers[0];
    assert.ok(first);
    assert.equal(result(first).target, `${SHARED}/test-only.ts#onlyTested`);
  });
});

/** A fixture copy with `files` written (and `edit` applied), indexed; returns its query. */
async function copyQuery(
  prefix: string,
  files: Record<string, string>,
  edit?: (repo: string) => Promise<void>,
): Promise<{ query: ImpactQuery; close: () => Promise<void> }> {
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
    query: new ImpactQuery(db, impactOf(repo)),
    close: async () => {
      db.close();
      await rm(dirname(repo), { recursive: true, force: true });
    },
  };
}

async function sharedManifest(repo: string, manifest: Record<string, unknown>): Promise<void> {
  await writeFile(join(repo, 'packages/shared/package.json'), JSON.stringify(manifest));
}

const SOLO = { 'packages/shared/src/solo.ts': 'export function solo(): number { return 1; }\n' };

describe('scopes and surfaces the base fixture does not exercise (no wrong low)', () => {
  it('a prefix-less import() makes exports partial only in files with no static importer', async () => {
    const { query, close } = await copyQuery('impact-dyn-any', {
      'packages/api/src/loader.ts': 'export function loadAny(p: string) { return import(p); }\n',
      'packages/api/src/isolated.ts': 'export function island(): number { return 1; }\n',
    });
    try {
      const island = result(query.query('packages/api/src/isolated.ts#island'));
      assert.ok(reason(island, 'dynamic-import'), JSON.stringify(island.completeness));
      assert.equal(island.verdict.level, 'unknown');
      // cycle-b.ts imports cycle-a.ts statically: out of scope, a repository limit instead.
      const imported = result(query.query('packages/payments/src/cycle-a.ts#a'));
      assert.equal(imported.completeness.status, 'complete');
      assert.equal(imported.limits.unboundedDynamicImports, 1);
      const local = result(query.query('packages/payments/src/fee.ts#localOnly'));
      assert.equal(
        local.completeness.status,
        'complete',
        'a module namespace exposes exports only',
      );
    } finally {
      await close();
    }
  });
  it('a literal dynamic import is not a static importer for a prefix-less gap', async () => {
    const { query, close } = await copyQuery('impact-dyn-literal', {
      'packages/api/src/loader.ts':
        'export function load(p: string) { void import("./isolated"); return import(p); }\n',
      'packages/api/src/isolated.ts': 'export function island(): number { return 1; }\n',
    });
    try {
      const island = result(query.query('packages/api/src/isolated.ts#island'));
      assert.ok(reason(island, 'dynamic-import'), JSON.stringify(island.completeness));
      assert.equal(island.limits.unboundedDynamicImports, 1);
    } finally {
      await close();
    }
  });

  it('a computed require() follows the same no-static-importer scope', async () => {
    const { query, close } = await copyQuery('impact-req-any', {
      'packages/api/src/requirer.ts':
        'export function requireAny(p: string): unknown { return require(p); }\n',
      'packages/api/src/isolated.ts': 'export function island(): number { return 1; }\n',
    });
    try {
      const island = result(query.query('packages/api/src/isolated.ts#island'));
      assert.ok(reason(island, 'cjs-require'), JSON.stringify(island.completeness));
      assert.equal(island.verdict.level, 'unknown');
      const imported = result(query.query('packages/payments/src/cycle-a.ts#a'));
      assert.equal(imported.completeness.status, 'complete');
      assert.equal(imported.limits.unboundedDynamicImports, 1);
    } finally {
      await close();
    }
  });

  it('an unmatched computed import prefix remains a visible gap, not a silent limit', async () => {
    const { query, close } = await copyQuery('impact-dyn-alias', {
      'packages/api/src/loader.ts':
        'export function load(name: string) { return import("@handlers/" + name); }\n',
      'packages/api/src/isolated.ts': 'export function island(): number { return 1; }\n',
    });
    try {
      const island = result(query.query('packages/api/src/isolated.ts#island'));
      assert.ok(reason(island, 'dynamic-import'), JSON.stringify(island.completeness));
      assert.equal(island.limits.unboundedDynamicImports, 0);
      const local = result(query.query('packages/payments/src/fee.ts#localOnly'));
      assert.equal(local.completeness.status, 'complete');
    } finally {
      await close();
    }
  });

  it('a literal require of an external package does not scope repository declarations', async () => {
    const { query, close } = await copyQuery('impact-external-require', {
      'packages/api/src/external-requirer.ts':
        'export function readExternal() { return require("not-installed-external"); }\n',
    });
    try {
      const local = result(query.query('packages/payments/src/fee.ts#localOnly'));
      const exported = result(query.query('packages/payments/src/cycle-a.ts#a'));
      assert.equal(local.completeness.status, 'complete');
      assert.equal(exported.completeness.status, 'complete');
      assert.equal(exported.limits.unboundedDynamicImports, 0);
    } finally {
      await close();
    }
  });

  it('a public package with a wildcard subpath export makes matching exports public', async () => {
    const { query, close } = await copyQuery('impact-wild-entry', SOLO, (repo) =>
      sharedManifest(repo, { name: '@fx/shared', exports: { './*': './src/*.ts' } }),
    );
    try {
      const solo = result(query.query('packages/shared/src/solo.ts#solo'));
      assert.ok(solo.factors.includes('public-export-surface'), JSON.stringify(solo.factors));
      assert.equal(solo.verdict.level, 'medium');
    } finally {
      await close();
    }
  });

  it('a public package whose entry is unresolved build output treats its exports as public', async () => {
    const { query, close } = await copyQuery('impact-dist-entry', SOLO, (repo) =>
      sharedManifest(repo, { name: '@fx/shared', main: 'dist/index.js' }),
    );
    try {
      const solo = result(query.query('packages/shared/src/solo.ts#solo'));
      assert.ok(solo.factors.includes('public-export-surface'), JSON.stringify(solo.factors));
      assert.equal(solo.verdict.level, 'medium');
    } finally {
      await close();
    }
  });

  it('symbols reached only through a heuristic interface hop do not count toward reach', async () => {
    const { query, close } = await copyQuery('impact-heuristic-reach', {
      'packages/payments/src/flow-user.ts': [
        "import { runCheckout } from './checkout-flow';",
        "import type { PaymentProcessor } from './processor';",
        'export function useFlow(p: PaymentProcessor): void { runCheckout(p); }',
        '',
      ].join('\n'),
    });
    try {
      const stripe = result(
        query.query('packages/payments/src/stripe.ts#StripeProcessor.charge', 10),
      );
      const listed = stripe.byDepth.flat().map((node) => node.symbol);
      assert.ok(
        listed.includes('packages/payments/src/flow-user.ts#useFlow'),
        JSON.stringify(listed),
      );
      assert.equal(stripe.reach.total, 0);
      assert.equal(stripe.reach.direct, 0);
    } finally {
      await close();
    }
  });

  it('results carry this package version, and dotted names resolve parents only for members', async () => {
    const { query, close } = await copyQuery('impact-names', {
      [`${SHARED}/anonymous.ts`]: 'export interface Usage { cost: { input: number }; }\n',
    });
    try {
      const manifest: unknown = JSON.parse(await readFile('package.json', 'utf8'));
      assert.ok(manifest && typeof manifest === 'object' && 'version' in manifest);
      assert.equal(result(query.query('localOnly')).engine.version, manifest.version);
      const member = query.query('Usage.cost.input');
      assert.equal(result(member).target, `${SHARED}/anonymous.ts#Usage.cost`);
      assert.equal(member.parentTarget, `${SHARED}/anonymous.ts#Usage.cost`);
      const pathLike = query.query('calculateFee.ts');
      assert.ok(pathLike.kind === 'guidance', JSON.stringify(pathLike));
      assert.equal(pathLike.code, 'target-not-found');
    } finally {
      await close();
    }
  });
});
