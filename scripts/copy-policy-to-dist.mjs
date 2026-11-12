// Copies the migrated KSD policy module (plain JavaScript, files unchanged) into the
// build trees so both the compiled extension (dist/) and the compiled tests
// (dist-test/src/) can resolve ../../policy/index.js at runtime.
// KSD's own src/*.ts stays uncompilled here: its built dist/ ships committed (PROVENANCE.md).
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const source = join(root, 'src', 'policy');

const entries = [
  'index.js',
  'index.d.ts',
  'policy.js',
  'policy.d.ts',
  'config.js',
  'sdlc.js',
  'change-scope.js',
  'check-changed.js',
  'review-verdict.js',
  'eslint-rules',
  'dist',
  'package.json',
];

function copyInto(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const entry of entries) {
    cpSync(join(source, entry), join(target, entry), { recursive: true });
  }
}

copyInto(join(root, 'dist', 'policy'));

// npm test compiles tests after `npm run build`; --test-tree mirrors the module next to
// the compiled extension copy inside dist-test/src/.
if (process.argv.includes('--test-tree')) {
  const testTree = join(root, 'dist-test', 'src');
  if (!existsSync(testTree))
    throw new Error('dist-test/src not found; compile tests first (tsc -p tests/tsconfig.json)');
  copyInto(join(testTree, 'policy'));
}
