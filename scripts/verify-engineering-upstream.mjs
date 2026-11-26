// Verify the reviewed lock against a separate pinned local Git checkout (CI or owner).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineeringLock, verifyEngineeringBundle } from './engineering-bundle.mjs';

const checkout = process.argv[2];
assert.ok(
  process.argv.length === 3 && checkout && isAbsolute(checkout),
  'Expected upstream checkout',
);
const root = fileURLToPath(new URL('..', import.meta.url));
const lock = readEngineeringLock(root);
verifyEngineeringBundle(join(root, 'src', 'engineering'), lock);
verifyEngineeringBundle(join(root, 'dist', 'engineering'), lock);
function git(args) {
  return execFileSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10000,
  }).trimEnd();
}
assert.equal(git(['rev-parse', 'HEAD']), lock.commit);
for (const [path, info] of Object.entries(lock.files)) {
  const full = lock.sourceDirectory + '/' + path;
  assert.equal(
    git(['ls-tree', lock.commit, '--', full]),
    info.mode + ' blob ' + info.gitBlob + '\t' + full,
    'Upstream tree mismatch: ' + full,
  );
}
console.log('Verified upstream commit and all ' + Object.keys(lock.files).length + ' Git blobs.');
