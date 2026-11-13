import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { defaultConfig } from '../../src/core/kernel/config.js';
import { difference, publishedLines } from './index-helpers.js';

const Z = 'export function pick(key: "b" | "a"): string {\n  return key;\n}\n';
const impact = { ...defaultConfig().impact, include: ['src/**'], freshness: 'hash' as const };

/** z.ts exports `pick`; user.ts calls it; a.ts makes the checker meet the literal "a" first. */
async function withRepo(
  body: (
    repo: string,
    indexer: Indexer,
    editZ: (returned: string) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-surface-')));
  const repo = join(work, 'repo');
  const indexer = new Indexer(ts, repo, join(work, 'cache'));
  try {
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(
      join(repo, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
    );
    await writeFile(join(repo, 'src/a.ts'), 'export const first = "a" as const;\n');
    await writeFile(join(repo, 'src/z.ts'), Z);
    await writeFile(
      join(repo, 'src/user.ts'),
      'import { pick } from "./z";\nexport const picked = pick("a");\n',
    );
    await body(repo, indexer, (returned) =>
      writeFile(join(repo, 'src/z.ts'), Z.replace('return key;', `return ${returned};`)),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

describe('affected set: export-surface cross-check', () => {
  it('a body edit re-resolves only the edited file, whatever order the checker met the types in', async () => {
    await withRepo(async (_repo, indexer, editZ) => {
      // The cold build checks a.ts first, so the literal type "a" exists before z.ts's union and
      // prints first; an update checks z.ts alone and prints its union as written, "b" first.
      await indexer.index({ impact });
      await editZ('`${key}`');
      const report = await indexer.index({ impact });
      assert.equal(report.action, 'update');
      assert.equal(report.resolvedFiles, 1, report.reason);
    });
  });
});

describe('affected set: an inferred type carries a change through a file that did not change', () => {
  const file = (n: string, type: string): string =>
    `import type { ${type} } from './${n}';\nexport function make() {\n  return {} as ${type};\n}\n`;

  it('the files that read a re-typed value are re-resolved, incremental == cold', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-chain-')));
    const repo = join(work, 'repo');
    const indexer = new Indexer(ts, repo, join(work, 'cache'));
    try {
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(
        join(repo, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }),
      );
      await writeFile(join(repo, 'src/d1.ts'), 'export interface One {\n  n: number;\n}\n');
      await writeFile(join(repo, 'src/d2.ts'), 'export interface Two {\n  n: string;\n}\n');
      await writeFile(join(repo, 'src/b.ts'), file('d1', 'One'));
      // a.ts holds an inferred type (`value`) and its text never changes below.
      await writeFile(
        join(repo, 'src/a.ts'),
        "import { make } from './b';\nexport const value = make();\n",
      );
      // c.ts has no edge into b.ts: only a.ts's inferred type links them.
      await writeFile(
        join(repo, 'src/c.ts'),
        "import { value } from './a';\nexport function read() {\n  return value.n;\n}\n",
      );
      // e.ts uses b.ts too but states its result type; f.ts uses e.ts.
      await writeFile(
        join(repo, 'src/e.ts'),
        "import { make } from './b';\nexport function typed(): number {\n  return make().n === undefined ? 1 : 2;\n}\n",
      );
      await writeFile(
        join(repo, 'src/f.ts'),
        "import { typed } from './e';\nexport const x = typed();\n",
      );
      // g.ts uses b.ts only inside a helper no observable declaration names; h.ts uses g.ts.
      await writeFile(
        join(repo, 'src/g.ts'),
        "import { make } from './b';\nfunction helper() {\n  return make();\n}\nexport const k: number = helper() === undefined ? 0 : 1;\n",
      );
      await writeFile(join(repo, 'src/h.ts'), "import { k } from './g';\nexport const y = k;\n");
      await indexer.index({ impact });
      await writeFile(join(repo, 'src/b.ts'), file('d2', 'Two'));
      const report = await indexer.index({ impact });
      assert.equal(report.action, 'update');
      assert.deepEqual(report.problems, []);
      // b.ts and its direct users a.ts, e.ts and g.ts; c.ts through a.ts's inferred type; f.ts
      // through e.ts: `typed` is observable and uses b.ts, and an observable declaration carries a
      // change whether its type is written or inferred (D50: an overload or conditional can turn).
      // h.ts is not re-resolved: in g.ts only `helper`, which nothing observable names, uses b.ts.
      assert.equal(report.resolvedFiles, 6, report.reason);
      const cold = join(work, 'cold');
      await new Indexer(ts, repo, cold).index({ impact, full: true });
      assert.deepEqual(
        difference(publishedLines(indexer.cacheDir), publishedLines(cold)),
        { onlyFirst: [], onlySecond: [] },
        'incremental == cold',
      );
      assert.ok(
        publishedLines(indexer.cacheDir).some((line) =>
          line.startsWith('edges\tsrc/c.ts#read\tsrc/d2.ts#Two.n\t'),
        ),
        'c.ts now reads Two.n',
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
