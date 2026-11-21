import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { loadWorkspace } from '../../src/core/engine/workspace.js';
import { ImpactQuery } from '../../src/core/impact/query.js';
import { impactDetails, renderAnswer } from '../../src/core/impact/render.js';
import { ImpactSession } from '../../src/core/impact/session.js';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { openPublished } from '../../src/storage/sqlite.js';
import { fixtureRepo, impactOf } from './index-helpers.js';

describe('M2b Round 6 — F1–F7 wrong-low findings', () => {
  let repo: string;
  let cacheDir: string;

  before(async () => {
    repo = await fixtureRepo('round6-wronglow');
    cacheDir = join(repo, '..', 'cache');

    // F1: broken imports / re-exports (specifier, default, aliased named, re-export, bare external, D56)
    await writeFile(
      join(repo, 'packages/api/src/f1-specifier-target.ts'),
      'export function f1SpecTarget(): number { return 1; }\n',
    );
    await writeFile(
      join(repo, 'packages/api/src/f1-specifier-caller.ts'),
      [
        "import { f1SpecTarget } from './does-not-exist';",
        'export function f1UseSpec(): number { return f1SpecTarget(); }',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(repo, 'packages/api/src/f1-default-target.ts'),
      [
        'export function f1DefTarget(): number { return 2; }',
        'export function f1DefBrokenMod(): number { return 22; }',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repo, 'packages/api/src/f1-default-caller.ts'),
      [
        "import f1DefTarget from './f1-default-target';",
        "import f1DefBrokenMod from './no-such-mod';",
        'export function f1UseDefault(): unknown { return [f1DefTarget(), f1DefBrokenMod()]; }',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(repo, 'packages/api/src/f1-alias-target.ts'),
      [
        'export function f1AliasTarget(): number { return 3; }',
        'export function f1AliasOrigName(): number { return 4; }',
        'export function f1ResolvedAliasTarget(): number { return 5; }',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repo, 'packages/api/src/f1-alias-caller.ts'),
      [
        "import { f1AliasOrigName as f1AliasTarget } from './missing-alias-mod';",
        "import { missingExportName as f1ResolvedAliasTarget } from './f1-alias-target';",
        'export function f1UseAlias(): unknown { return [f1AliasTarget(), f1ResolvedAliasTarget]; }',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(repo, 'packages/api/src/f1-reexport-target.ts'),
      [
        'export function f1ReexportLocal(): number { return 6; }',
        'export function f1ReexportOrig(): number { return 7; }',
        'export function f1ReexportMissingExport(): number { return 8; }',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repo, 'packages/api/src/f1-reexport-barrel.ts'),
      [
        "export { f1ReexportOrig as f1ReexportLocal } from './missing-reexport-mod';",
        "export { missingReexportSym as f1ReexportMissingExport } from './f1-reexport-target';",
        '',
      ].join('\n'),
    );

    await writeFile(join(repo, 'packages/api/src/f1-ext-target.ts'), 'export class Client {}\n');
    await writeFile(
      join(repo, 'packages/api/src/f1-ext-caller.ts'),
      [
        "import { Client } from 'pg';",
        'export function f1UsePg(): unknown { return new Client(); }',
        '',
      ].join('\n'),
    );

    for (let i = 0; i < 11; i++) {
      await writeFile(
        join(repo, `packages/api/src/f1-common-${i}.ts`),
        `export function f1CommonName(): number { return ${i}; }\n`,
      );
    }
    await writeFile(
      join(repo, 'packages/api/src/f1-common-caller.ts'),
      [
        "import { f1CommonName } from './missing-common';",
        'export function f1UseCommon(): number { return f1CommonName(); }',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(repo, 'packages/api/src/f1-ns-target.ts'),
      [
        'export function f1NsBroken(): number { return 9; }',
        'export function f1NsMember(): number { return 10; }',
        'export function f1Req(): number { return 11; }',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repo, 'packages/api/src/f1-ns-caller.ts'),
      [
        "import * as f1NsBroken from './missing-ns';",
        "import f1Req = require('./missing-req');",
        'export function f1UseNsReq(): unknown { return [f1NsBroken.f1NsMember(), f1Req()]; }',
        '',
      ].join('\n'),
    );

    // F2: class `extends` override (abstract + concrete + transitive extends+implements) & interface extends
    await writeFile(
      join(repo, 'packages/api/src/f2-hierarchy.ts'),
      [
        'export interface F2Iface {',
        '  process(n: number): number;',
        '}',
        'export interface F2SubIface extends F2Iface {',
        '  process(n: number): number;',
        '}',
        'export abstract class F2AbstractBase {',
        '  abstract handle(n: number): number;',
        '}',
        'export class F2ConcreteFromAbstract extends F2AbstractBase {',
        '  override handle(n: number): number {',
        '    return n + 1;',
        '  }',
        '}',
        'export class F2BaseImpl implements F2Iface {',
        '  process(n: number): number {',
        '    return n;',
        '  }',
        '  static staticOnly(): number {',
        '    return 1;',
        '  }',
        '}',
        'export class F2SubOverride extends F2BaseImpl {',
        '  override process(n: number): number {',
        '    return n * 2;',
        '  }',
        '  static staticOnly(): number {',
        '    return 2;',
        '  }',
        '}',
        'export function f2CallAbstract(x: F2AbstractBase): number {',
        '  return x.handle(1);',
        '}',
        'export function f2CallIface(x: F2Iface): number {',
        '  return x.process(1);',
        '}',
        'export function f2CallBase(x: F2BaseImpl): number {',
        '  return x.process(2);',
        '}',
        '',
      ].join('\n'),
    );

    // F3: keyof union contextual/expression owners & string union in tokensOf
    await writeFile(
      join(repo, 'packages/api/src/f3-keys.ts'),
      [
        'export interface F3Usage {',
        '  f3Cost: number;',
        '  f3Total: number;',
        '  f3Other: number;',
        '}',
        'export interface F3Ledger {',
        '  f3Owner: string;',
        '  f3Balance: number;',
        '}',
        'export type F3Keys<T> = keyof T;',
        'export interface F3Opts {',
        '  field?: keyof F3Usage;',
        '  either: keyof F3Usage | keyof F3Ledger;',
        '  eitherGeneric?: F3Keys<F3Usage> | F3Keys<F3Ledger>;',
        '  nested?: (keyof F3Usage | keyof F3Ledger)[];',
        '}',
        'export function f3WithDefaults(',
        "  opts: F3Opts = { field: 'f3Cost', either: 'f3Total', eitherGeneric: 'f3Owner', nested: ['f3Balance'] },",
        '): F3Opts {',
        '  return opts;',
        '}',
        'export function f3ConditionalAccess(',
        '  cond: boolean,',
        '  u: F3Usage,',
        '  k1: keyof F3Usage,',
        '  k2: keyof F3Ledger,',
        '): unknown {',
        '  const k = cond ? k1 : k2;',
        '  return (u as unknown as Record<PropertyKey, unknown>)[cond ? k1 : k2] ?? (u as unknown as Record<PropertyKey, unknown>)[k];',
        '}',
        'export function f3StrTarget(): number { return 1; }',
        'export function f3TakeOptStr(name?: string): string | undefined { return name; }',
        "export const f3CallOptStr = f3TakeOptStr('f3StrTarget');",
        '',
        'export interface F3NegOwner {',
        '  f3NegField: number;',
        '}',
        'export function f3NegAccess(',
        '  obj: Record<string, number>,',
        '  strUnion: keyof F3NegOwner | string,',
        '  anyKey: keyof any,',
        '): number {',
        '  return obj[strUnion] + (obj as Record<PropertyKey, number>)[anyKey];',
        '}',
        '',
      ].join('\n'),
    );

    // F4: computed access on asserted/nested/satisfies/class/namespace receivers
    await writeFile(
      join(repo, 'packages/api/src/f4-ns-reexp.ts'),
      'export function f4ReexpFn(): number { return 40; }\n',
    );
    await writeFile(
      join(repo, 'packages/api/src/f4-ns-target.ts'),
      [
        "export { f4ReexpFn } from './f4-ns-reexp';",
        'export function f4NsFn(): number { return 41; }',
        'function f4NsLocal(): number { return 42; }',
        'export function f4UseLocal(): number { return f4NsLocal(); }',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repo, 'packages/api/src/f4-ns-barrel.ts'),
      "export * as f4BarrelNs from './f4-ns-target';\n",
    );
    await writeFile(
      join(repo, 'packages/api/src/f4-targets.ts'),
      [
        'export function f4ConstFn(): number { return 1; }',
        'export function f4SatFn(): number { return 2; }',
        'export function f4NestedFn(): number { return 3; }',
        'export function f4BracketFn(): number { return 4; }',
        'export function f4ClassPropFn(): number { return 5; }',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(repo, 'packages/api/src/f4-callers.ts'),
      [
        "import * as f4Ns from './f4-ns-target';",
        "import { f4BarrelNs } from './f4-ns-barrel';",
        "import { f4BracketFn, f4ClassPropFn, f4ConstFn, f4NestedFn, f4SatFn } from './f4-targets';",
        'export function f4CallAsConst(k: string): number {',
        '  const handlers = { fn: f4ConstFn } as const;',
        '  return (handlers as Record<string, () => number>)[k]();',
        '}',
        'export function f4CallSatisfies(k: string): number {',
        '  const sat = { fn: f4SatFn } satisfies Record<string, () => number>;',
        '  return sat[k]();',
        '}',
        'export function f4CallNested(k: string): number {',
        '  const nested: { handlers: Record<string, () => number> } = { handlers: { fn: f4NestedFn } };',
        '  return nested.handlers[k]();',
        '}',
        'export function f4CallNestedBracket(k: string): number {',
        '  const nested: { handlers: Record<string, () => number> } = { handlers: { fn: f4BracketFn } };',
        "  return nested['handlers'][k]();",
        '}',
        'export class F4Holder {',
        '  prop = { fn: f4ClassPropFn } as const;',
        '  run(k: string): number {',
        '    return (this.prop as Record<string, () => number>)[k]();',
        '  }',
        '}',
        'export function f4CallNamespace(k: string): number {',
        '  return (f4Ns as unknown as Record<string, () => number>)[k]() + (f4BarrelNs as unknown as Record<string, () => number>)[k]();',
        '}',
        '',
      ].join('\n'),
    );

    // F5: chained prefix, computed require, partial prefix, module-only target
    await mkdir(join(repo, 'packages/api/src/f5-handlers'), { recursive: true });
    await mkdir(join(repo, 'packages/api/src/f5-req-dir'), { recursive: true });
    await mkdir(join(repo, 'packages/api/src/f5-partial'), { recursive: true });
    await writeFile(
      join(repo, 'packages/api/src/f5-handlers/refund.ts'),
      'export function f5Refund(): number { return 50; }\n',
    );
    await writeFile(
      join(repo, 'packages/api/src/f5-handlers/f5-side-effect.ts'),
      'const f5SideEffectInit = 1;\nexport {};\n',
    );
    await writeFile(
      join(repo, 'packages/api/src/f5-dyn-loader.ts'),
      [
        "import { f5Refund } from './f5-handlers/refund';",
        'export function f5StaticUse(): number { return f5Refund(); }',
        'export async function f5LoadHandler(name: string): Promise<unknown> {',
        "  return import('./f5-handlers/' + name + '.js');",
        '}',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(repo, 'packages/api/src/f5-req-dir/capture.ts'),
      'export function f5Capture(): number { return 51; }\n',
    );
    await writeFile(
      join(repo, 'packages/api/src/f5-req-loader.ts'),
      [
        "import { f5Capture } from './f5-req-dir/capture';",
        'declare const require: (id: string) => unknown;',
        'export function f5UseCapture(): number { return f5Capture(); }',
        'export function f5RequireHandler(name: string): unknown {',
        "  return require('./f5-req-dir/' + name);",
        '}',
        '',
      ].join('\n'),
    );

    await writeFile(
      join(repo, 'packages/api/src/f5-partial/f5-pref-hit.ts'),
      'export function f5PrefHit(): number { return 52; }\n',
    );
    await writeFile(
      join(repo, 'packages/api/src/f5-partial/f5-other.ts'),
      ['export function f5Other(): number { return 53; }', ''].join('\n'),
    );
    await writeFile(
      join(repo, 'packages/api/src/f5-partial-loader.ts'),
      [
        "import { f5PrefHit } from './f5-partial/f5-pref-hit';",
        "import { f5Other } from './f5-partial/f5-other';",
        'declare const require: (id: string) => unknown;',
        'export function f5UsePartial(): number { return f5PrefHit() + f5Other(); }',
        'export function f5RequirePartial(name: string): unknown {',
        "  return require('./f5-partial/f5-pref' + name);",
        '}',
        '',
      ].join('\n'),
    );

    const indexer = new Indexer(ts, repo, cacheDir);
    const report = await indexer.index({ impact: impactOf(repo), full: true });
    assert.deepEqual(report.problems, []);
  });

  after(async () => {
    await rm(join(repo, '..'), { recursive: true, force: true });
  });

  function queryTarget(target: string) {
    const db = openPublished(cacheDir);
    assert.ok(db, 'published index should open');
    try {
      const iq = new ImpactQuery(db, impactOf(repo));
      const answer = iq.query(target);
      if (answer.kind !== 'result' || 'results' in answer.value) {
        assert.fail(`expected ImpactResult for ${target}, got ${JSON.stringify(answer)}`);
      }
      return answer.value;
    } finally {
      db.close();
    }
  }

  function hasUnresolvedGap(result: ReturnType<typeof queryTarget>): boolean {
    return (
      result.completeness.reasons.some(
        (r) => r.includes('unresolved-import') || r.includes('unresolved-name-match'),
      ) ||
      result.factors.some(
        (f) => f.includes('unresolved-import') || f.includes('unresolved-name-match'),
      )
    );
  }

  describe('F1: broken imports / re-exports record local + imported names', () => {
    it('flags target matching a broken module specifier import', () => {
      const result = queryTarget('packages/api/src/f1-specifier-target.ts#f1SpecTarget');
      assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
      assert.notEqual(result.completeness.status, 'complete', JSON.stringify(result));
      assert.ok(hasUnresolvedGap(result), JSON.stringify(result.completeness));
    });

    it('maps default import to local name instead of storing "default"', () => {
      const db = openPublished(cacheDir);
      assert.ok(db);
      try {
        const rows = db
          .prepare('SELECT file, name, reason FROM unresolved WHERE file = ? ORDER BY line, name')
          .all('packages/api/src/f1-default-caller.ts') as Array<{
          file: string;
          name: string;
          reason: string;
        }>;
        assert.ok(
          rows.some((r) => r.name === 'f1DefTarget'),
          JSON.stringify(rows),
        );
        assert.ok(
          rows.some((r) => r.name === 'f1DefBrokenMod'),
          JSON.stringify(rows),
        );
        assert.equal(
          rows.some((r) => r.name === 'default'),
          false,
          `default import must map to local name, not 'default': ${JSON.stringify(rows)}`,
        );
      } finally {
        db.close();
      }

      for (const target of [
        'packages/api/src/f1-default-target.ts#f1DefTarget',
        'packages/api/src/f1-default-target.ts#f1DefBrokenMod',
      ]) {
        const result = queryTarget(target);
        assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
        assert.ok(hasUnresolvedGap(result), `${target}: ${JSON.stringify(result.completeness)}`);
      }
    });

    it('records both imported and local names for aliased broken imports', () => {
      for (const target of [
        'packages/api/src/f1-alias-target.ts#f1AliasTarget',
        'packages/api/src/f1-alias-target.ts#f1AliasOrigName',
        'packages/api/src/f1-alias-target.ts#f1ResolvedAliasTarget',
      ]) {
        const result = queryTarget(target);
        assert.notEqual(
          result.verdict.level,
          'low',
          `${target} must not be low: ${JSON.stringify(result)}`,
        );
        assert.ok(
          hasUnresolvedGap(result),
          `${target} missing unresolved gap: ${JSON.stringify(result.completeness)}`,
        );
      }
    });

    it('records broken export { ... } from re-export bindings', () => {
      for (const target of [
        'packages/api/src/f1-reexport-target.ts#f1ReexportLocal',
        'packages/api/src/f1-reexport-target.ts#f1ReexportOrig',
        'packages/api/src/f1-reexport-target.ts#f1ReexportMissingExport',
      ]) {
        const result = queryTarget(target);
        assert.notEqual(
          result.verdict.level,
          'low',
          `${target} must not be low: ${JSON.stringify(result)}`,
        );
        assert.ok(
          hasUnresolvedGap(result),
          `${target} missing unresolved gap: ${JSON.stringify(result.completeness)}`,
        );
      }
    });

    it('records broken namespace import, property use on broken namespace, and import = require', () => {
      for (const target of [
        'packages/api/src/f1-ns-target.ts#f1NsBroken',
        'packages/api/src/f1-ns-target.ts#f1NsMember',
        'packages/api/src/f1-ns-target.ts#f1Req',
      ]) {
        const result = queryTarget(target);
        assert.notEqual(result.verdict.level, 'low', `${target}: ${JSON.stringify(result)}`);
        assert.ok(hasUnresolvedGap(result), `${target}: ${JSON.stringify(result.completeness)}`);
      }
    });

    it('does not treat bare external package import bindings as unresolved-import', () => {
      const db = openPublished(cacheDir);
      assert.ok(db);
      try {
        const rows = db
          .prepare('SELECT name, reason FROM unresolved WHERE file = ?')
          .all('packages/api/src/f1-ext-caller.ts');
        assert.deepEqual(rows, []);
      } finally {
        db.close();
      }

      const result = queryTarget('packages/api/src/f1-ext-target.ts#Client');
      assert.equal(result.verdict.level, 'low', JSON.stringify(result));
      assert.equal(result.completeness.status, 'complete', JSON.stringify(result));
    });

    it('applies D56 common-name threshold to unresolved-import name matches', () => {
      const result = queryTarget('packages/api/src/f1-common-0.ts#f1CommonName');
      assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
      assert.ok(
        result.factors.includes('common-name'),
        `expected common-name factor, got ${JSON.stringify(result.factors)}`,
      );
      assert.equal(
        result.completeness.reasons.some((r) => r.includes('unresolved-import')),
        false,
        `D56 common-name should absorb unresolved-import into common-name factor: ${JSON.stringify(result.completeness)}`,
      );
    });
  });

  describe('F2: class extends member overrides & transitive IMPLEMENTS', () => {
    it('surfaces abstract base caller & interface-dispatch on concrete class extends override', () => {
      const result = queryTarget('packages/api/src/f2-hierarchy.ts#F2ConcreteFromAbstract.handle');
      assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
      assert.notEqual(result.completeness.status, 'complete', JSON.stringify(result));
      assert.ok(
        result.byDepth
          .flat()
          .some((c) => c.symbol === 'packages/api/src/f2-hierarchy.ts#f2CallAbstract'),
        `expected f2CallAbstract in callers, got ${JSON.stringify(result.byDepth)}`,
      );
    });

    it('traverses IMPLEMENTS transitively for Sub extends Base implements Iface', () => {
      const result = queryTarget('packages/api/src/f2-hierarchy.ts#F2SubOverride.process');
      assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
      assert.notEqual(result.completeness.status, 'complete', JSON.stringify(result));
      const callerSymbols = result.byDepth.flat().map((c) => c.symbol);
      assert.ok(
        callerSymbols.includes('packages/api/src/f2-hierarchy.ts#f2CallBase'),
        `expected f2CallBase in ${JSON.stringify(callerSymbols)}`,
      );
      assert.ok(
        callerSymbols.includes('packages/api/src/f2-hierarchy.ts#f2CallIface'),
        `expected f2CallIface transitively in ${JSON.stringify(callerSymbols)}`,
      );
      assert.ok(
        result.completeness.reasons.some((r) => r.includes('interface-dispatch')),
        `expected interface-dispatch reason, got ${JSON.stringify(result.completeness)}`,
      );
    });

    it('records IMPLEMENTS for redeclared interface extends members, skips static members, and never emits class-level Sub IMPLEMENTS Base', () => {
      const subIface = queryTarget('packages/api/src/f2-hierarchy.ts#F2SubIface.process');
      const ifaceCallers = subIface.byDepth.flat().map((c) => c.symbol);
      assert.ok(
        ifaceCallers.includes('packages/api/src/f2-hierarchy.ts#f2CallIface'),
        `expected f2CallIface on F2SubIface.process, got ${JSON.stringify(ifaceCallers)}`,
      );

      const db = openPublished(cacheDir);
      assert.ok(db);
      try {
        const classExtEdge = db
          .prepare("SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'IMPLEMENTS'")
          .all(
            'packages/api/src/f2-hierarchy.ts#F2SubOverride',
            'packages/api/src/f2-hierarchy.ts#F2BaseImpl',
          );
        assert.deepEqual(classExtEdge, [], 'class-level Sub IMPLEMENTS Base must NOT be emitted');
        const staticExtEdge = db
          .prepare("SELECT * FROM edges WHERE source = ? AND target = ? AND kind = 'IMPLEMENTS'")
          .all(
            'packages/api/src/f2-hierarchy.ts#F2SubOverride.staticOnly',
            'packages/api/src/f2-hierarchy.ts#F2BaseImpl.staticOnly',
          );
        assert.deepEqual(staticExtEdge, [], 'static override must not get instance IMPLEMENTS');
      } finally {
        db.close();
      }
    });
  });

  describe('F3: keyof unions & string unions', () => {
    it('tracks contextual keyof | undefined and keyof A | keyof B literals including generic aliases and arrays', () => {
      for (const prop of ['f3Cost', 'f3Total']) {
        const result = queryTarget(`packages/api/src/f3-keys.ts#F3Usage.${prop}`);
        assert.notEqual(result.verdict.level, 'low', `${prop}: ${JSON.stringify(result)}`);
        const callers = result.byDepth.flat().map((c) => c.symbol);
        assert.ok(
          callers.includes('packages/api/src/f3-keys.ts#f3WithDefaults'),
          `expected f3WithDefaults reference to F3Usage.${prop}, got ${JSON.stringify(callers)}`,
        );
      }

      for (const ownerProp of ['F3Ledger.f3Owner', 'F3Ledger.f3Balance']) {
        const ownerRes = queryTarget(`packages/api/src/f3-keys.ts#${ownerProp}`);
        assert.notEqual(ownerRes.verdict.level, 'low', `${ownerProp}: ${JSON.stringify(ownerRes)}`);
        assert.ok(
          ownerRes.byDepth
            .flat()
            .some((c) => c.symbol === 'packages/api/src/f3-keys.ts#f3WithDefaults'),
          `expected f3WithDefaults reference to ${ownerProp}, got ${JSON.stringify(ownerRes.byDepth)}`,
        );
      }
    });

    it('tracks computed access through conditional keyof union expressions', () => {
      const result = queryTarget('packages/api/src/f3-keys.ts#F3Usage.f3Other');
      assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
      assert.notEqual(result.completeness.status, 'complete', JSON.stringify(result));
      assert.ok(
        result.completeness.reasons.some((r) => r.includes('computed-member-access')),
        `expected computed-member-access for conditional keyof union, got ${JSON.stringify(result.completeness)}`,
      );
    });

    it('records string literal tokens when contextual type is string | undefined', () => {
      const result = queryTarget('packages/api/src/f3-keys.ts#f3StrTarget');
      assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
      assert.notEqual(result.completeness.status, 'complete', JSON.stringify(result));
      assert.ok(
        result.completeness.reasons.some((r) => r.includes('string-name-match')),
        `expected string-name-match for string | undefined arg, got ${JSON.stringify(result.completeness)}`,
      );
    });

    it('does not treat keyof T | string, keyof any, or Record<string, V> as F3NegOwner key access', () => {
      const result = queryTarget('packages/api/src/f3-keys.ts#F3NegOwner.f3NegField');
      assert.equal(result.verdict.level, 'low', JSON.stringify(result));
      assert.equal(result.completeness.status, 'complete', JSON.stringify(result));
    });
  });

  describe('F4: computed member access on wrapped, nested, and namespace receivers', () => {
    it('flags computed access on as-const, satisfies, nested property/bracket chain, and class property holders', () => {
      for (const fn of ['f4ConstFn', 'f4SatFn', 'f4NestedFn', 'f4BracketFn', 'f4ClassPropFn']) {
        const result = queryTarget(`packages/api/src/f4-targets.ts#${fn}`);
        assert.notEqual(
          result.verdict.level,
          'low',
          `${fn} must not be low: ${JSON.stringify(result)}`,
        );
        assert.ok(
          result.completeness.reasons.some((r) => r.includes('computed-member-access')),
          `${fn} expected computed-member-access, got ${JSON.stringify(result.completeness)}`,
        );
      }
    });

    it('flags exported and re-exported declarations on namespace computed access without flagging unexported locals', () => {
      for (const target of [
        'packages/api/src/f4-ns-target.ts#f4NsFn',
        'packages/api/src/f4-ns-reexp.ts#f4ReexpFn',
      ]) {
        const result = queryTarget(target);
        assert.notEqual(result.verdict.level, 'low', `${target}: ${JSON.stringify(result)}`);
        assert.ok(
          result.completeness.reasons.some((r) => r.includes('computed-member-access')),
          `${target} expected computed-member-access: ${JSON.stringify(result.completeness)}`,
        );
      }

      const localRes = queryTarget('packages/api/src/f4-ns-target.ts#f4NsLocal');
      assert.equal(localRes.verdict.level, 'low', JSON.stringify(localRes));
      assert.equal(localRes.completeness.status, 'complete', JSON.stringify(localRes));
    });
  });

  describe('F5: dynamic-import and cjs-require prefixes, root ./, unmatched alias, module-only target', () => {
    it('extracts chained "./handlers/" + name + ".js" prefix instead of degrading to *', () => {
      const result = queryTarget('packages/api/src/f5-handlers/refund.ts#f5Refund');
      assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
      assert.ok(
        result.completeness.reasons.some(
          (r) => r.includes('dynamic-import') && r.includes('packages/api/src/f5-handlers/'),
        ),
        `expected scoped dynamic-import prefix, got ${JSON.stringify(result.completeness)}`,
      );
    });

    it('extracts computed require("./f5-req-dir/" + name) prefix onto matching statically-imported file', () => {
      const result = queryTarget('packages/api/src/f5-req-dir/capture.ts#f5Capture');
      assert.notEqual(result.verdict.level, 'low', JSON.stringify(result));
      assert.ok(
        result.completeness.reasons.some(
          (r) => r.includes('cjs-require') && r.includes('packages/api/src/f5-req-dir/'),
        ),
        `expected scoped cjs-require prefix, got ${JSON.stringify(result.completeness)}`,
      );
    });

    it('scopes partial prefix require("./f5-partial/f5-pref" + name) only to matching paths', () => {
      const hit = queryTarget('packages/api/src/f5-partial/f5-pref-hit.ts#f5PrefHit');
      assert.notEqual(hit.verdict.level, 'low', JSON.stringify(hit));
      assert.ok(
        hit.completeness.reasons.some(
          (r) => r.includes('cjs-require') && r.includes('packages/api/src/f5-partial/f5-pref'),
        ),
        `expected partial cjs-require prefix on f5PrefHit, got ${JSON.stringify(hit.completeness)}`,
      );

      const miss = queryTarget('packages/api/src/f5-partial/f5-other.ts#f5Other');
      assert.equal(
        miss.completeness.reasons.some((r) => r.includes('f5-partial/f5-pref')),
        false,
        `partial prefix must not hit non-matching f5-other.ts: ${JSON.stringify(miss.completeness)}`,
      );
    });

    it('applies root ./ dynamic import prefix even when target has a static importer', async () => {
      const isolated = await fixtureRepo('round6-f5-root');
      const isoCache = join(isolated, '..', 'cache');
      try {
        await writeFile(
          join(isolated, 'f5-root-loader.ts'),
          [
            'export async function f5RootImport(name: string): Promise<unknown> {',
            "  return import('./' + name);",
            '}',
            '',
          ].join('\n'),
        );
        await writeFile(
          join(isolated, 'tsconfig.json'),
          JSON.stringify(
            {
              extends: './tsconfig.base.json',
              include: ['f5-root-loader.ts', 'packages', 'apps'],
            },
            null,
            2,
          ),
        );
        await writeFile(
          join(isolated, 'packages/api/src/f5-root-target.ts'),
          'export function f5RootTarget(): number { return 54; }\n',
        );
        await writeFile(
          join(isolated, 'packages/api/src/f5-root-static.ts'),
          [
            "import { f5RootTarget } from './f5-root-target';",
            'export function f5CallRootTarget(): number { return f5RootTarget(); }',
            '',
          ].join('\n'),
        );
        const baseImpact = impactOf(isolated);
        const impact = {
          ...baseImpact,
          include: ['f5-root-loader.ts', ...baseImpact.include],
        };
        const isoIndexer = new Indexer(ts, isolated, isoCache);
        const isoReport = await isoIndexer.index({ impact, full: true });
        assert.deepEqual(isoReport.problems, []);

        const db = openPublished(isoCache);
        assert.ok(db);
        try {
          const iq = new ImpactQuery(db, impact);
          const ans = iq.query('packages/api/src/f5-root-target.ts#f5RootTarget');
          if (ans.kind !== 'result' || 'results' in ans.value) {
            assert.fail(`expected ImpactResult, got ${JSON.stringify(ans)}`);
          }
          assert.notEqual(ans.value.verdict.level, 'low', JSON.stringify(ans.value));
          assert.ok(
            ans.value.completeness.reasons.some((r) => r.includes('dynamic-import')),
            `expected root ./ dynamic-import on f5RootTarget, got ${JSON.stringify(ans.value.completeness)}`,
          );
        } finally {
          db.close();
        }
      } finally {
        await rm(join(isolated, '..'), { recursive: true, force: true });
      }
    });

    it('attaches prefix and unmatched alias gaps onto module-only (<module>) targets', async () => {
      const sideEffect = queryTarget('packages/api/src/f5-handlers/f5-side-effect.ts#<module>');
      assert.notEqual(sideEffect.verdict.level, 'low', JSON.stringify(sideEffect));
      assert.ok(
        sideEffect.completeness.reasons.some(
          (r) => r.includes('dynamic-import') && r.includes('packages/api/src/f5-handlers/'),
        ),
        `expected dynamic-import on module-only target, got ${JSON.stringify(sideEffect.completeness)}`,
      );

      const isolated = await fixtureRepo('round6-f5-alias');
      const isoCache = join(isolated, '..', 'cache');
      try {
        await writeFile(
          join(isolated, 'packages/api/src/f5-alias-target.ts'),
          'const onlySideEffect = 1;\nexport function f5AliasExported(): number { return onlySideEffect; }\n',
        );
        await writeFile(
          join(isolated, 'packages/api/src/f5-alias-mod.ts'),
          'const modOnly = 1;\nexport {};\n',
        );
        await writeFile(
          join(isolated, 'packages/api/src/f5-alias-caller.ts'),
          [
            "import { f5AliasExported } from './f5-alias-target';",
            'export function f5Static(): number { return f5AliasExported(); }',
            'export function f5AliasDyn(name: string): Promise<unknown> {',
            "  return import('@handlers/' + name);",
            '}',
            '',
          ].join('\n'),
        );
        const isoIndexer = new Indexer(ts, isolated, isoCache);
        const isoReport = await isoIndexer.index({ impact: impactOf(isolated), full: true });
        assert.deepEqual(isoReport.problems, []);

        const db = openPublished(isoCache);
        assert.ok(db);
        try {
          const iq = new ImpactQuery(db, impactOf(isolated));
          for (const target of [
            'packages/api/src/f5-alias-target.ts#f5AliasExported',
            'packages/api/src/f5-alias-mod.ts#<module>',
          ]) {
            const ans = iq.query(target);
            if (ans.kind !== 'result' || 'results' in ans.value) {
              assert.fail(`expected ImpactResult for ${target}`);
            }
            assert.notEqual(
              ans.value.verdict.level,
              'low',
              `${target}: ${JSON.stringify(ans.value)}`,
            );
            assert.ok(
              ans.value.completeness.reasons.some((r) => r.includes('@handlers/')),
              `${target} missing @handlers/ gap: ${JSON.stringify(ans.value.completeness)}`,
            );
          }
        } finally {
          db.close();
        }
      } finally {
        await rm(join(isolated, '..'), { recursive: true, force: true });
      }
    });
  });

  describe('F6: file targets report whole-file aggregate across exports, unexported decls, and <module>', () => {
    it('flags dynamically loaded file, legacy.cjs, unexported-decl gap, unused public export, combined caller threshold, and stale file', async () => {
      const f6Repo = await fixtureRepo('round6-f6');
      const f6Cache = join(f6Repo, '..', 'cache');
      try {
        await mkdir(join(f6Repo, 'packages/api/src/f6-handlers'), { recursive: true });
        await writeFile(
          join(f6Repo, 'packages/api/src/f6-handlers/dyn-only.ts'),
          'export function f6DynOnly(): number { return 1; }\n',
        );
        await writeFile(
          join(f6Repo, 'packages/api/src/f6-handlers-loader.ts'),
          'export function f6Load(n: string): Promise<unknown> { return import("./f6-handlers/" + n); }\n',
        );

        await writeFile(
          join(f6Repo, 'packages/api/src/f6-unexported-gap.ts'),
          [
            'function f6HiddenSecret(): number { return 1; }',
            'export function f6HiddenUse(): number { return f6HiddenSecret(); }',
            'export function f6PublicClean(): number { return 2; }',
            '',
          ].join('\n'),
        );
        await writeFile(
          join(f6Repo, 'packages/api/src/f6-unexported-caller.ts'),
          [
            "import { f6PublicClean } from './f6-unexported-gap';",
            "import { f6HiddenSecret } from './f6-missing';",
            'export function f6CallClean(): number { return f6PublicClean(); }',
            'export function f6UseBroken(): unknown { return f6HiddenSecret(); }',
            '',
          ].join('\n'),
        );

        await writeFile(
          join(f6Repo, 'packages/payments/src/f6-pub-unused.ts'),
          'export function f6PublicUnused(): number { return 3; }\n',
        );
        await writeFile(
          join(f6Repo, 'packages/payments/src/index.ts'),
          ["export * from './fee';", "export * from './f6-pub-unused';", ''].join('\n'),
        );

        await writeFile(
          join(f6Repo, 'packages/api/src/f6-many.ts'),
          [
            'export function f6ManyA(): number { return 1; }',
            'export function f6ManyB(): number { return 2; }',
            '',
          ].join('\n'),
        );
        await writeFile(
          join(f6Repo, 'packages/api/src/f6-many-callers.ts'),
          [
            "import { f6ManyA, f6ManyB } from './f6-many';",
            ...[0, 1, 2, 3, 4].map(
              (i) => `export function f6Ca${i}(): number { return f6ManyA(); }`,
            ),
            ...[0, 1, 2, 3, 4].map(
              (i) => `export function f6Cb${i}(): number { return f6ManyB(); }`,
            ),
            '',
          ].join('\n'),
        );

        await writeFile(
          join(f6Repo, 'packages/api/src/f6-stale-target.ts'),
          'export function f6StaleUnused(): number { return 4; }\n',
        );

        const impact = impactOf(f6Repo);
        const indexer = new Indexer(ts, f6Repo, f6Cache);
        const report = await indexer.index({ impact, full: true });
        assert.deepEqual(report.problems, []);

        const db = openPublished(f6Cache);
        assert.ok(db);
        try {
          const iq = new ImpactQuery(db, impact);
          const meta = { state: 'fresh' as const, updatedFiles: 0, driftedFiles: [] as string[] };

          const queryFile = (path: string) => {
            const ans = iq.query(path);
            assert.equal(ans.kind, 'result');
            if (ans.kind !== 'result' || !('results' in ans.value)) {
              assert.fail(`expected FileImpactResult for ${path}, got ${JSON.stringify(ans)}`);
            }
            const rendered = renderAnswer(ans, meta);
            const details = impactDetails({ answers: [ans], index: meta });
            return { value: ans.value, rendered, details };
          };

          const getAggregate = (res: ReturnType<typeof queryFile>) => {
            const agg = (res.value as { aggregate?: (typeof res.value.results)[number] }).aggregate;
            assert.ok(agg, `FileImpactResult for ${res.value.file} must include aggregate`);
            return agg;
          };

          // 1. Dynamic-only file with 0 static callers
          const dyn = queryFile('packages/api/src/f6-handlers/dyn-only.ts');
          assert.doesNotMatch(dyn.rendered, /\blow\b/i, dyn.rendered);
          assert.equal(dyn.details.length, 1);
          assert.equal(
            'target' in dyn.details[0]! ? dyn.details[0]!.target : null,
            'packages/api/src/f6-handlers/dyn-only.ts#<module>',
          );
          const dynAgg = getAggregate(dyn);
          assert.notEqual(dynAgg.verdict.level, 'low', dyn.rendered);

          // 2. legacy.cjs
          const cjs = queryFile('packages/shared/src/legacy.cjs');
          assert.doesNotMatch(cjs.rendered, /\blow\b/i, cjs.rendered);
          const cjsAgg = getAggregate(cjs);
          assert.notEqual(cjsAgg.verdict.level, 'low', cjs.rendered);

          // 3. Unexported decl carrying unresolved-import gap when 1 exported decl has 1 clean caller
          const unexp = queryFile('packages/api/src/f6-unexported-gap.ts');
          assert.doesNotMatch(unexp.rendered, /\blow\b/i, unexp.rendered);
          const unexpAgg = getAggregate(unexp);
          assert.notEqual(unexpAgg.verdict.level, 'low', unexp.rendered);
          assert.notEqual(unexpAgg.completeness.status, 'complete');

          // 4. Exported unused public export in @fx/payments
          const pubUnused = queryFile('packages/payments/src/f6-pub-unused.ts');
          assert.doesNotMatch(pubUnused.rendered, /\blow\b/i, pubUnused.rendered);
          const pubAgg = getAggregate(pubUnused);
          assert.ok(pubAgg.factors.includes('public-export-surface'));
          assert.notEqual(pubAgg.verdict.level, 'low', pubUnused.rendered);

          // 5. Combined callers across 2 exports (5 + 5 = 10 >= manyCallers)
          const many = queryFile('packages/api/src/f6-many.ts');
          assert.doesNotMatch(many.rendered, /\blow\b/i, many.rendered);
          const manyAgg = getAggregate(many);
          assert.equal(manyAgg.reach.total, 10);
          assert.ok(manyAgg.factors.includes('many-callers'));
          assert.equal(manyAgg.verdict.level, 'medium', many.rendered);
        } finally {
          db.close();
        }

        // 6. Stale file with 0 outside-used exports must mark aggregate unknown
        await writeFile(
          join(f6Repo, 'packages/api/src/f6-stale-target.ts'),
          'export function f6StaleUnused(): number { return 999; }\n',
        );
        const workspace = await loadWorkspace(f6Repo);
        const session = new ImpactSession(
          { ...workspace, cacheDir: f6Cache, config: { ...workspace.config, impact } },
          { waitMs: 0 },
        );
        const staleBatch = await session.query(['packages/api/src/f6-stale-target.ts']);
        const ans = staleBatch.answers[0]!;
        if (ans.kind !== 'result' || !('results' in ans.value)) {
          assert.fail(`expected stale FileImpactResult, got ${JSON.stringify(ans)}`);
        }
        const staleAgg = (ans.value as { aggregate?: (typeof ans.value.results)[number] })
          .aggregate;
        assert.ok(staleAgg, 'stale FileImpactResult must include aggregate');
        assert.equal(staleAgg.verdict.level, 'unknown');
        assert.ok(staleAgg.completeness.reasons.some((r) => r.includes('stale-index')));
        const rendered = renderAnswer(ans, staleBatch.index);
        assert.match(rendered, /\bunknown\b/i, rendered);
      } finally {
        rmSync(join(f6Repo, '..'), { recursive: true, force: true });
      }
    });
  });

  describe('F7: target resolution ties, bare names, and ambiguous D51 parents', () => {
    let f7Repo: string;
    let f7Cache: string;
    let f7Impact: ReturnType<typeof impactOf>;

    before(async () => {
      f7Repo = await fixtureRepo('round6-f7');
      f7Cache = join(f7Repo, '..', 'cache');
      await writeFile(
        join(f7Repo, 'packages/api/src/top-charge.ts'),
        'export function charge(): number { return 7; }\n',
      );
      await writeFile(
        join(f7Repo, 'packages/api/src/f7-tie.ts'),
        'export const f7TieA = 1, f7TieB = 2;\n',
      );
      await writeFile(
        join(f7Repo, 'packages/api/src/f7-d51-a.ts'),
        'export interface F7Model { cost: { input: number } }\n',
      );
      await writeFile(
        join(f7Repo, 'packages/api/src/f7-d51-b.ts'),
        'export interface F7Model { cost: { input: number } }\n',
      );
      f7Impact = impactOf(f7Repo);
      const indexer = new Indexer(ts, f7Repo, f7Cache);
      const report = await indexer.index({ impact: f7Impact, full: true });
      assert.deepEqual(report.problems, []);
    });

    after(() => {
      rmSync(join(f7Repo, '..'), { recursive: true, force: true });
    });

    function queryAny(target: string) {
      const db = openPublished(f7Cache);
      assert.ok(db);
      try {
        return new ImpactQuery(db, f7Impact).query(target);
      } finally {
        db.close();
      }
    }

    it('flags bare name collision when top-level and member declarations share a name', () => {
      const bare = queryAny('charge');
      assert.equal(bare.kind, 'guidance', JSON.stringify(bare));
      assert.equal(bare.code, 'ambiguous-target', JSON.stringify(bare));
      assert.ok(
        bare.candidates?.includes('packages/api/src/top-charge.ts#charge'),
        JSON.stringify(bare.candidates),
      );
      assert.ok(
        bare.candidates?.includes('packages/payments/src/processor.ts#PaymentProcessor.charge'),
        JSON.stringify(bare.candidates),
      );
    });

    it('resolves routes.ts:3 to innermost declaration rather than outer container', () => {
      const routesAt3 = queryAny('packages/api/src/routes.ts:3');
      assert.equal(routesAt3.kind, 'result', JSON.stringify(routesAt3));
      if (routesAt3.kind === 'result' && 'target' in routesAt3.value) {
        assert.equal(routesAt3.value.target, 'packages/api/src/routes.ts#routes.POST /charge');
      } else {
        assert.fail(`expected ImpactResult for routes.ts:3, got ${JSON.stringify(routesAt3)}`);
      }
    });

    it('keeps equal-span equal-depth sibling ties ambiguous rather than picking one', () => {
      const tie = queryAny('packages/api/src/f7-tie.ts:1');
      assert.equal(tie.kind, 'guidance', JSON.stringify(tie));
      assert.equal(tie.code, 'ambiguous-target', JSON.stringify(tie));
      assert.deepEqual(tie.candidates, [
        'packages/api/src/f7-tie.ts#f7TieA',
        'packages/api/src/f7-tie.ts#f7TieB',
      ]);
    });

    it('returns ambiguous-target when D51 parent matches multiple declarations', () => {
      const d51 = queryAny('F7Model.cost.input');
      assert.equal(d51.kind, 'guidance', JSON.stringify(d51));
      assert.equal(d51.code, 'ambiguous-target', JSON.stringify(d51));
      assert.deepEqual(d51.candidates, [
        'packages/api/src/f7-d51-a.ts#F7Model.cost',
        'packages/api/src/f7-d51-b.ts#F7Model.cost',
      ]);
    });

    it('keeps nonexistent file query as target-not-found (negative control)', () => {
      const missingFile = queryAny('packages/api/src/nonexistent-foo.ts');
      assert.equal(missingFile.kind, 'guidance', JSON.stringify(missingFile));
      assert.equal(missingFile.code, 'target-not-found', JSON.stringify(missingFile));
    });

    it('records REFERENCES from contextually typed object-literal get and set accessors to interface properties', async () => {
      const accRepo = await fixtureRepo('round6-obj-accessors');
      const accCache = join(accRepo, '..', 'cache');
      try {
        await writeFile(
          join(accRepo, 'packages/api/src/acc-tool.ts'),
          [
            'export interface AccTool {',
            '  label: string;',
            '  "quotedProp": number;',
            '}',
            'export function makeAccTool(): AccTool {',
            '  return {',
            '    get label() {',
            "      return 'ok';",
            '    },',
            '    set "quotedProp"(_v: number) {},',
            '  };',
            '}',
            '',
          ].join('\n'),
        );
        const accImpact = impactOf(accRepo);
        const indexer = new Indexer(ts, accRepo, accCache);
        await indexer.index({ impact: accImpact, full: true });
        const db = openPublished(accCache);
        assert.ok(db);
        try {
          const iq = new ImpactQuery(db, accImpact);
          const labelAns = iq.query('packages/api/src/acc-tool.ts#AccTool.label');
          assert.equal(labelAns.kind, 'result');
          if (labelAns.kind === 'result' && 'byDepth' in labelAns.value) {
            assert.deepEqual(
              labelAns.value.byDepth[0]?.map((n) => n.symbol),
              ['packages/api/src/acc-tool.ts#makeAccTool'],
            );
          }
          const quotedAns = iq.query('packages/api/src/acc-tool.ts#AccTool.quotedProp');
          assert.equal(quotedAns.kind, 'result');
          if (quotedAns.kind === 'result' && 'byDepth' in quotedAns.value) {
            assert.deepEqual(
              quotedAns.value.byDepth[0]?.map((n) => n.symbol),
              ['packages/api/src/acc-tool.ts#makeAccTool'],
            );
          }
        } finally {
          db.close();
        }
      } finally {
        rmSync(join(accRepo, '..'), { recursive: true, force: true });
      }
    });
  });
});
