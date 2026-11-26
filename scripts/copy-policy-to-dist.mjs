// Build the pinned engineering runtime without downloading anything. The historical
// frozen v0.6 source/tests remain intact; only erosiano-dev is shipped/activated.
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineeringLock, verifyEngineeringBundle } from './engineering-bundle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'src', 'engineering');
const lock = readEngineeringLock(root);
verifyEngineeringBundle(source, lock);

function copyInto(target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });
  verifyEngineeringBundle(target, lock);
}

// Obsolete generated runtime is no longer part of the distribution.
rmSync(join(root, 'dist', 'policy'), { recursive: true, force: true });
copyInto(join(root, 'dist', 'engineering'));

if (process.argv.includes('--test-tree')) {
  const testTree = join(root, 'dist-test', 'src');
  if (!existsSync(testTree))
    throw new Error('dist-test/src not found; compile tests first (tsc -p tests/tsconfig.json)');
  copyInto(join(testTree, 'engineering'));
}
