import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { coldLines, difference, fixtureRepo, impactOf, publishedLines } from './index-helpers.js';

const DIR = 'packages/payments/src/sound';
const key = (file: string, name: string): string => `${DIR}/${file}#${name}`;
const edge = (source: string, target: string): string => `edges\t${source}\t${target}\t`;

interface Case {
  /** Files written into the fixture copy before the cold build. */
  base: Record<string, string>;
  /** The one file edited afterwards, and its new text. */
  edit: [string, string];
  /** A canonical line prefix a cold build holds before the edit. */
  before?: string;
  /** A canonical line prefix only a cold build of the edited tree holds. */
  after: string;
}

/**
 * Cold build, one edit to a file that `a.ts` neither imports nor names, then an update by a new
 * Indexer (as in a new engine process: no builder or program state from the build). The update
 * must equal a cold build of the edited tree, counters included.
 */
async function assertSound(name: string, c: Case): Promise<void> {
  const repo = await fixtureRepo(`sound-${name}`);
  try {
    mkdirSync(join(repo, DIR), { recursive: true });
    for (const [file, text] of Object.entries(c.base)) writeFileSync(join(repo, DIR, file), text);
    assert.doesNotMatch(c.base['a.ts'] ?? '', new RegExp(`\\./${c.edit[0].replace('.ts', '')}`));
    const cache = join(repo, '..', 'cache');
    const first = await new Indexer(ts, repo, cache).index({ impact: impactOf(repo) });
    assert.deepEqual(first.problems, []);
    const has = (lines: string[], prefix: string): boolean =>
      lines.some((line) => line.startsWith(prefix));
    const beforeLines = publishedLines(cache);
    if (c.before !== undefined) assert.ok(has(beforeLines, c.before), `before: ${c.before}`);
    assert.ok(!has(beforeLines, c.after), `not yet: ${c.after}`);

    writeFileSync(join(repo, DIR, c.edit[0]), c.edit[1]);
    const update = await new Indexer(ts, repo, cache).index({
      impact: impactOf(repo),
      freshness: 'hash',
    });
    assert.equal(update.action, 'update', update.reason);
    assert.deepEqual(update.problems, []);
    const cold = await coldLines(repo, join(repo, '..', 'cold'));
    assert.ok(has(cold, c.after), `after the edit: ${c.after}`);
    assert.deepEqual(
      difference(publishedLines(cache), cold),
      { onlyFirst: [], onlySecond: [] },
      'incremental == cold',
    );
  } finally {
    rmSync(dirname(repo), { recursive: true, force: true });
  }
}

const SIZES =
  'export interface Small {\n  size: number;\n}\nexport interface Large {\n  size: number;\n}\n';

describe('update soundness: a change reaches a file through types it never names', () => {
  it('a. an overload chosen by a parameter type from z.ts; a.ts reads a property of the result', async () => {
    await assertSound('overload', {
      base: {
        'z.ts': 'export type Input = number;\n',
        'b.ts':
          "import type { Input } from './z';\n" +
          SIZES +
          'export function measure(value: Input): Small;\n' +
          'export function measure(value: string): Large;\n' +
          'export function measure(value: unknown): Small | Large {\n' +
          "  return { size: typeof value === 'string' ? value.length : 0 };\n}\n",
        'a.ts':
          "import { measure } from './b';\n" +
          "export function read(): number {\n  return measure('k').size;\n}\n",
      },
      // `measure('k')` now matches the first overload: `size` is Small's, not Large's.
      edit: ['z.ts', 'export type Input = string;\n'],
      before: edge(key('a.ts', 'read'), key('b.ts', 'Large.size')),
      after: edge(key('a.ts', 'read'), key('b.ts', 'Small.size')),
    });
  });

  it('b. a conditional type in b.ts over a type from z.ts', async () => {
    await assertSound('conditional', {
      base: {
        'z.ts': 'export type Input = number;\n',
        'b.ts':
          "import type { Input } from './z';\n" +
          SIZES +
          'export type Box = Input extends string ? Small : Large;\n' +
          'export declare function open(): Box;\n',
        'a.ts':
          "import { open } from './b';\n" +
          'export function read(): number {\n  return open().size;\n}\n',
      },
      edit: ['z.ts', 'export type Input = string;\n'],
      before: edge(key('a.ts', 'read'), key('b.ts', 'Large.size')),
      after: edge(key('a.ts', 'read'), key('b.ts', 'Small.size')),
    });
  });

  it('c. f() in b.ts returns T from c.ts; c.ts adds the member a.ts already reads', async () => {
    await assertSound('member', {
      base: {
        'c.ts': 'export interface Shape {\n  kind: string;\n}\n',
        'b.ts': "import type { Shape } from './c';\nexport declare function make(): Shape;\n",
        // `area` does not exist yet: before the edit the read resolves to nothing.
        'a.ts':
          "import { make } from './b';\n" +
          'export function read(): number {\n  return make().area;\n}\n',
      },
      edit: ['c.ts', 'export interface Shape {\n  kind: string;\n  area: number;\n}\n'],
      before: edge(key('a.ts', 'read'), key('b.ts', 'make')),
      after: edge(key('a.ts', 'read'), key('c.ts', 'Shape.area')),
    });
  });

  it('d. c.ts declares a name a.ts reads from an untyped value: the name cross-check records it', async () => {
    await assertSound('name', {
      base: {
        'c.ts': 'export const unrelated = 1;\n',
        // No type links a.ts to c.ts: only the name `area`, new to the index, does.
        'a.ts': 'export function read(x: any): number {\n  return x.area;\n}\n',
      },
      edit: ['c.ts', 'export const unrelated = 1;\nexport interface Panel {\n  area: number;\n}\n'],
      after: `unresolved\t${DIR}/a.ts\t2\tarea\tunresolved-name-match\t`,
    });
  });
});
