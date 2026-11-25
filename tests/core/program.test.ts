import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import { createAnalysisHost, groupPrograms, splitBy } from '../../src/core/indexing/program.js';

describe('analysis programs (D43, DESIGN §6.2.1)', () => {
  let root = '';
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'ei-program-'));
    const configs: Record<string, object> = {
      'a/tsconfig.json': { compilerOptions: { strict: true, verbatimModuleSyntax: true } },
      // Differs from a only in options that never change what a name resolves to.
      'b/tsconfig.json': { compilerOptions: { strict: true, outDir: 'dist', composite: true } },
      'c/tsconfig.json': { compilerOptions: { strict: true, jsx: 'react-jsx' } },
      'd/tsconfig.json': { compilerOptions: { strict: false } },
    };
    for (const [path, config] of Object.entries(configs)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), JSON.stringify(config));
    }
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('one program unless resolution options conflict; the split names the options', () => {
    const owners = new Map([
      ['a/tsconfig.json', ['a/x.ts']],
      ['b/tsconfig.json', ['b/y.ts']],
      ['c/tsconfig.json', ['c/z.tsx']],
      ['d/tsconfig.json', ['d/x.ts']],
    ]);
    const { groups, errors } = groupPrograms(ts, root, owners);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      groups.map((group) => group.configs),
      [['a/tsconfig.json', 'b/tsconfig.json'], ['c/tsconfig.json'], ['d/tsconfig.json']],
    );
    assert.deepEqual(splitBy(groups), ['jsx', 'strict']);
    assert.deepEqual(splitBy(groups.slice(0, 1)), []);
    const [merged] = groups;
    assert.equal(merged?.options.verbatimModuleSyntax, false, 'D43 override');
    assert.equal(merged?.options.isolatedModules, false, 'D43 override');
    assert.equal(merged?.options.noEmit, true);
    assert.equal(merged?.options.strict, true, 'everything else as configured');
  });

  it('an unreadable config is reported, not grouped', () => {
    const { groups, errors } = groupPrograms(
      ts,
      root,
      new Map([['missing/tsconfig.json', ['missing/a.ts']]]),
    );
    assert.deepEqual(groups, []);
    assert.deepEqual(errors, ['missing/tsconfig.json: cannot be read or parsed']);
  });

  it('refreshes a program that resolves duplicate copies of the same dependency', async () => {
    const rootNames = ['a', 'b'].map((app) => join(root, app, 'main.ts'));
    for (const app of ['a', 'b']) {
      const dependency = join(root, app, 'node_modules', 'dep');
      await mkdir(dependency, { recursive: true });
      await writeFile(
        join(dependency, 'package.json'),
        JSON.stringify({ name: 'dep', version: '1.0.0', types: 'index.d.ts' }),
      );
      await writeFile(join(dependency, 'index.d.ts'), "export declare const value: 'ok';\n");
      await writeFile(
        join(root, app, 'main.ts'),
        "import { value } from 'dep';\nexport const result: 'ok' = value;\n",
      );
    }

    const options = { module: ts.ModuleKind.Node16, types: [], noEmit: true };
    const oldProgram = ts.createProgram({
      rootNames,
      options,
      host: createAnalysisHost(ts, options, undefined),
    });
    oldProgram.getTypeChecker();
    const refreshed = ts.createProgram({
      rootNames,
      options,
      host: createAnalysisHost(ts, options, oldProgram),
      oldProgram,
    });

    assert.deepEqual(refreshed.getSemanticDiagnostics(), []);
  });
});
