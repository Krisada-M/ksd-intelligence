// Offline verification of a reviewed upstream Git tree. Git blob IDs bind exact bytes;
// no runtime clone, network request, dependency install or execution of upstream scripts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://github.com/Krisada-M/ksd-engineering';
const OID = /^[a-f0-9]{40}$/;
const FILES = [
  'baseline.js',
  'change-scope.js',
  'check-changed.js',
  'config.js',
  'dist/policy.d.ts',
  'dist/policy.js',
  'dist/runtime.d.ts',
  'dist/runtime.js',
  'dist/sdlc.d.ts',
  'dist/sdlc.js',
  'eslint-rules/index.js',
  'index.d.ts',
  'index.js',
  'intelligence.js',
  'package.json',
  'policy.js',
  'practice-tool.js',
  'practices.js',
  'practices.json',
  'review-verdict.js',
  'sdlc.js',
].sort();

export function readEngineeringLock(root) {
  const lock = JSON.parse(readFileSync(join(root, 'engineering.lock.json'), 'utf8'));
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.repository, SOURCE);
  assert.match(lock.commit, OID);
  assert.equal(lock.sourceDirectory, 'plugins/erosiano-dev');
  assert.equal(lock.package, 'omp-erosiano-dev');
  assert.match(lock.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(Object.keys(lock.files).sort(), FILES);
  for (const item of Object.values(lock.files)) {
    assert.match(item.gitBlob, OID);
    assert.ok(['100644', '100755'].includes(item.mode));
  }
  return lock;
}

function walk(root, prefix = '') {
  const files = [];
  assert.ok(lstatSync(root).isDirectory(), 'Bundle directory must not be a symlink');
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const rel = prefix + name;
    const stat = lstatSync(path);
    if (stat.isDirectory()) files.push(...walk(path, rel + '/'));
    else {
      assert.ok(stat.isFile(), 'Bundle contains a nonregular file: ' + rel);
      files.push(rel);
    }
  }
  return files;
}

export function verifyEngineeringBundle(root, lock) {
  assert.deepEqual(walk(root).sort(), FILES, 'Unexpected engineering bundle file set');
  for (const path of FILES) {
    const file = join(root, path);
    const bytes = readFileSync(file);
    const blob = createHash('sha1')
      .update('blob ' + bytes.length + '\0')
      .update(bytes)
      .digest('hex');
    assert.equal(blob, lock.files[path].gitBlob, 'Engineering bundle changed: ' + path);
    if (process.platform !== 'win32') {
      const mode = lstatSync(file).mode & 0o111 ? '100755' : '100644';
      assert.equal(mode, lock.files[path].mode, 'Engineering mode changed: ' + path);
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, lock.package);
  assert.equal(pkg.version, lock.version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const lock = readEngineeringLock(root);
  verifyEngineeringBundle(join(root, 'src', 'engineering'), lock);
  verifyEngineeringBundle(join(root, 'dist', 'engineering'), lock);
  console.log('Engineering bundle verified: ' + lock.commit);
}
