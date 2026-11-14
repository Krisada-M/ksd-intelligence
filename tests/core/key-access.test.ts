import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { openPublished } from '../../src/storage/sqlite.js';
import { assertIncrementalEqualsCold, fixtureRepo, impactOf } from './index-helpers.js';

const TYPES = 'packages/shared/src/key-types.ts';
const ACCESS = 'packages/api/src/key-access.ts';
const TYPE_TEXT = `export interface Usage {
  cost: { input: number };
  total: number;
  input: number;
}
export interface Ledger {
  total: number;
  owner: string;
}
export type Codes = Record<'a' | 'b', number>;
export type Anonymous = { hidden: number };
export type Keys<T> = keyof T;
`;
const ACCESS_TEXT = `import type { Usage, Ledger, Codes, Anonymous, Keys } from '../../shared/src/key-types';
declare const u: Usage;
declare const codes: Codes;
declare function get<K extends keyof Usage>(u: Usage, k: K): Usage[K];
declare function pick<T, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K>;
declare function either(k: keyof Usage | keyof Ledger): void;
declare function log(k: string): void;
declare function textUnion(k: 'cost' | 'total'): void;
declare function at<T, K extends keyof T>(o: T, k: K): T[K];
export function one() { return get(u, 'cost'); }
export function many() { return pick(u, ['cost', 'total']); }
export function variable(k: keyof Usage) { return get(u, k); }
export function element(k: keyof Usage) { return u[k]; }
export function twoOwners() { either('total'); }
export function singleOwner() { either('owner'); }
declare function disguised(k: keyof Usage | string): void;
export function logged() { log('cost'); textUnion('total'); disguised('cost'); }
export function loggedKey(k: keyof Usage) { log(k); }
export function record() { return at(codes, 'a'); }
export const assigned: keyof Usage = 'input';
export class Store<T> {
  get<K extends keyof T>(k: K): unknown { void k; return undefined; }
}
declare const store: Store<Usage>;
export function receiver() { return store.get('cost'); }
declare function aliasKey(k: Keys<Usage>): void;
declare function anonymous(k: keyof Anonymous): void;
export function aliasLiteral() { aliasKey('input'); }
export function aliasVariable(k: Keys<Usage>) { aliasKey(k); }
export function anonymousLiteral() { anonymous('hidden'); }
declare function choose(): keyof Usage;
export function chosen() { return get(u, choose()); }
declare function nestedKey(k: keyof Usage['cost']): void;
export function nestedLiteral() { nestedKey('input'); }
export const keyList: (keyof Usage)[] = ['cost', 'total'];
`;

describe('D52 key access (fixture copy, not the golden fixture)', () => {
  let repo: string;
  let indexer: Indexer;

  before(async () => {
    repo = await fixtureRepo('keys');
    await writeFile(join(repo, TYPES), TYPE_TEXT);
    await writeFile(join(repo, ACCESS), ACCESS_TEXT);
    indexer = new Indexer(ts, repo, join(repo, '..', 'cache'));
    const report = await indexer.index({ impact: impactOf(repo), full: true });
    assert.deepEqual(report.problems, []);
  });
  after(async () => {
    await rm(join(repo, '..'), { recursive: true, force: true });
  });

  // A missing key edge or false ordinary-string edge changes the caller set of a real property.
  function propertyUsers(): string[] {
    const db = openPublished(indexer.cacheDir);
    assert.ok(db);
    try {
      return db
        .prepare(
          `SELECT s.key AS source, t.key AS target, e.kind, e.strength
        FROM edges e JOIN symbols s ON s.id = e.source JOIN symbols t ON t.id = e.target
        WHERE t.key IN (?, ?, ?, ?, ?) ORDER BY s.key, t.key, e.kind`,
        )
        .all(
          `${TYPES}#Usage.cost`,
          `${TYPES}#Usage.total`,
          `${TYPES}#Usage.input`,
          `${TYPES}#Ledger.total`,
          `${TYPES}#Ledger.owner`,
        )
        .map(
          (r) =>
            `${String(r.source).split('#')[1]} -> ${String(r.target).split('#')[1]} ${r.kind} ${r.strength}`,
        );
    } finally {
      db.close();
    }
  }

  function gaps(source: string): string[] {
    const db = openPublished(indexer.cacheDir);
    assert.ok(db);
    try {
      return db
        .prepare('SELECT code, detail FROM gap_sites WHERE source = ? ORDER BY detail')
        .all(`${ACCESS}#${source}`)
        .map((r) => `${r.code}: ${String(r.detail).split('#')[1]}`);
    } finally {
      db.close();
    }
  }

  it('K extends keyof Usage: get(u, "cost") references Usage.cost', () => {
    assert.deepEqual(
      propertyUsers().filter((r) => r.startsWith('one ->')),
      ['one -> Usage.cost REFERENCES compiler'],
    );
    assert.deepEqual(gaps('one'), []);
  });

  it('pick(u, ["cost", "total"]) references each property, not just the first key', () => {
    assert.deepEqual(
      propertyUsers().filter((r) => r.startsWith('many ->')),
      ['many -> Usage.cost REFERENCES compiler', 'many -> Usage.total REFERENCES compiler'],
    );
    assert.deepEqual(gaps('many'), []);
  });

  it('a variable typed keyof Usage records a gap on Usage, both at a call and an element access', () => {
    for (const source of ['variable', 'element']) {
      assert.deepEqual(gaps(source), ['computed-member-access: Usage']);
      assert.deepEqual(
        propertyUsers().filter((r) => r.startsWith(`${source} ->`)),
        [],
      );
    }
  });

  it('a key valid for two owners records gaps on both, never an arbitrary edge', () => {
    assert.deepEqual(gaps('twoOwners'), [
      'computed-member-access: Ledger',
      'computed-member-access: Usage',
    ]);
    assert.deepEqual(
      propertyUsers().filter((r) => r.startsWith('twoOwners ->')),
      [],
    );
    assert.deepEqual(
      propertyUsers().filter((r) => r.startsWith('singleOwner ->')),
      ['singleOwner -> Ledger.owner REFERENCES compiler'],
    );
  });

  it('ordinary strings and literal unions are not keyof accesses; log(k) also reads no property', () => {
    assert.deepEqual(
      propertyUsers().filter((r) => /^(logged|loggedKey) ->/.test(r)),
      [],
    );
    assert.deepEqual(gaps('logged'), []);
    assert.deepEqual(gaps('loggedKey'), []);
  });

  it('a literal key of Record<"a" | "b", V> has no declaration: no property edge or gap', () => {
    const db = openPublished(indexer.cacheDir);
    assert.ok(db);
    try {
      assert.deepEqual(
        db
          .prepare(
            `SELECT t.key FROM edges e JOIN symbols s ON s.id = e.source
        JOIN symbols t ON t.id = e.target WHERE s.key = ? AND t.key NOT IN (?, ?, ?)`,
          )
          .all(`${ACCESS}#record`, `${ACCESS}#at`, `${ACCESS}#codes`, `${TYPES}#Codes`),
        [],
      );
    } finally {
      db.close();
    }
    assert.deepEqual(gaps('record'), []);
  });

  it('a keyof assignment and an instantiated receiver retain their declaring property', () => {
    assert.deepEqual(
      propertyUsers().filter((r) => /^(assigned|receiver) ->/.test(r)),
      ['assigned -> Usage.input REFERENCES compiler', 'receiver -> Usage.cost REFERENCES compiler'],
    );
  });

  it('generic keyof aliases and contextually typed key arrays retain owner evidence', () => {
    assert.deepEqual(
      propertyUsers().filter((r) => /^(aliasLiteral|keyList) ->/.test(r)),
      [
        'aliasLiteral -> Usage.input REFERENCES compiler',
        'keyList -> Usage.cost REFERENCES compiler',
        'keyList -> Usage.total REFERENCES compiler',
      ],
    );
    assert.deepEqual(gaps('aliasVariable'), ['computed-member-access: Usage']);
  });

  it('a declared but unindexed anonymous member records an owner gap, unlike a mapped key', () => {
    assert.deepEqual(gaps('anonymousLiteral'), ['computed-member-access: Anonymous']);
  });

  it('a non-literal call expression typed keyof Usage also records an owner gap', () => {
    assert.deepEqual(gaps('chosen'), ['computed-member-access: Usage']);
    assert.deepEqual(
      propertyUsers().filter((r) => r.startsWith('chosen ->')),
      [],
    );
  });

  it('an anonymous nested owner scopes its unresolved member to the nearest indexed parent', () => {
    assert.deepEqual(gaps('nestedLiteral'), ['computed-member-access: Usage.cost']);
    assert.deepEqual(
      propertyUsers().filter((r) => r.startsWith('nestedLiteral ->')),
      [],
    );
  });

  it('owner changes replace ambiguous gaps with an edge; incremental remains exactly cold', async () => {
    await writeFile(join(repo, TYPES), TYPE_TEXT.replace('  total: number;\n  owner:', '  owner:'));
    try {
      await assertIncrementalEqualsCold(indexer, join(repo, '..', 'cold'), 'key owner changed');
      assert.deepEqual(gaps('twoOwners'), []);
      assert.deepEqual(
        propertyUsers().filter((r) => r.startsWith('twoOwners ->')),
        ['twoOwners -> Usage.total REFERENCES compiler'],
      );
    } finally {
      await writeFile(join(repo, TYPES), TYPE_TEXT);
    }
  });
});
