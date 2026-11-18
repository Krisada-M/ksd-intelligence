import assert from 'node:assert/strict';
import { test } from 'node:test';
import { protectedChanges } from '../../scripts/check-protected-paths.mjs';

test('protected paths are flagged with their reason', () => {
  const hits = protectedChanges([
    'tests/golden/M2-impact-cases.md',
    'src/policy/index.js',
    'tests/policy/contract.test.js',
    'tests/snapshots/impact/C01.txt',
    'src/core/impact/query.ts',
    'docs/DESIGN.md',
    'tests/core/impact-golden.test.ts',
  ]);
  assert.deepEqual(
    hits.map((hit) => hit.path),
    [
      'tests/golden/M2-impact-cases.md',
      'src/policy/index.js',
      'tests/policy/contract.test.js',
      'tests/snapshots/impact/C01.txt',
    ],
  );
});

test('look-alike paths are not protected', () => {
  assert.deepEqual(
    protectedChanges(['tests/goldenish.md', 'src/policyx/a.ts', 'docs/tests/golden/x.md']),
    [],
  );
});
