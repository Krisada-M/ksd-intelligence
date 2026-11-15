import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { openPublished } from '../../src/storage/sqlite.js';
import { fixtureRepo, impactOf } from './index-helpers.js';

const FILE = 'packages/api/src/generic-keys.ts';
const SOURCE = `export interface Base { cost: number }
export interface Usage extends Base { cost: number; total: number }
declare const u: Usage;
declare function key<T>(k: keyof T): void;
declare function get<T>(o: T, k: keyof T): void;
declare function constrained<T extends Base>(k: keyof T): void;
declare function defaulted<T = Usage>(k: keyof T): void;
declare function dependentDefault<A = Usage, T = A>(k: keyof T): void;
declare class Reader<T = Usage> { constructor(k: keyof T); }
declare const receiver: { key<T>(k: keyof T): void };
declare function second<A, T>(k: keyof T): void;
declare class Holder<T> { key<K extends keyof T>(k: K): void; }
declare const holder: Holder<Base>;
export function explicitOnly() { key<Usage>('cost'); }
export function inferredControl() { get(u, 'cost'); }
export function explicitValueControl() { get<Usage>(u, 'cost'); }
export function explicitBase() { get<Base>(u, 'cost'); }
export function constrainedExplicit() { constrained<Usage>('cost'); }
export function defaultOwner() { defaulted('cost'); }
export function defaultChain() { dependentDefault('cost'); }
export function defaultOverride() { defaulted<Base>('cost'); }
export function constructorExplicit() { new Reader<Usage>('cost'); }
export function constructorDefault() { new Reader('cost'); }
export function methodExplicit() { receiver.key<Usage>('cost'); }
export function constructorOverride() { new Reader<Base>('cost'); }
export function secondParameter() { second<Base, Usage>('cost'); }
export function receiverBinding() { holder.key<'cost'>('cost'); }
`;

describe('keyof owner substitution uses selected generic arguments, not a convenient subtype', () => {
  let repo: string;
  let cache: string;

  before(async () => {
    repo = await fixtureRepo('key-generics');
    cache = join(repo, '..', 'cache');
    await writeFile(join(repo, FILE), SOURCE);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      join(repo, 'tsconfig.json'),
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          assert.fail(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        },
      },
    );
    assert.ok(parsed);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
      [],
      'all regression calls are valid TypeScript',
    );
    const report = await new Indexer(ts, repo, cache).index({ impact: impactOf(repo), full: true });
    assert.deepEqual(report.problems, []);
  });

  after(async () => {
    await rm(join(repo, '..'), { recursive: true, force: true });
  });

  const cases = [
    ['explicitOnly', 'Usage.cost'],
    ['inferredControl', 'Usage.cost'],
    ['explicitValueControl', 'Usage.cost'],
    ['explicitBase', 'Base.cost'],
    ['constrainedExplicit', 'Usage.cost'],
    ['defaultOwner', 'Usage.cost'],
    ['defaultChain', 'Usage.cost'],
    ['defaultOverride', 'Base.cost'],
    ['constructorExplicit', 'Usage.cost'],
    ['constructorDefault', 'Usage.cost'],
    ['methodExplicit', 'Usage.cost'],
    ['constructorOverride', 'Base.cost'],
    ['secondParameter', 'Usage.cost'],
    ['receiverBinding', 'Base.cost'],
  ] as const;

  for (const [source, expected] of cases) {
    it(`${source} references ${expected} exactly, with no invented owner gap`, () => {
      const db = openPublished(cache);
      assert.ok(db);
      try {
        const rows = db
          .prepare(
            `SELECT t.key, e.kind, e.strength FROM edges e
          JOIN symbols s ON s.id = e.source JOIN symbols t ON t.id = e.target
          JOIN declarations d ON d.id = e.target
          WHERE s.key = ? AND d.name IN ('Base.cost', 'Usage.cost') ORDER BY t.key, e.kind`,
          )
          .all(`${FILE}#${source}`)
          .map((r) => `${r.key} ${r.kind} ${r.strength}`);
        assert.deepEqual(rows, [`${FILE}#${expected} REFERENCES compiler`]);
        assert.deepEqual(
          db
            .prepare('SELECT code, detail FROM gap_sites WHERE source = ?')
            .all(`${FILE}#${source}`),
          [],
        );
      } finally {
        db.close();
      }
    });
  }
});
