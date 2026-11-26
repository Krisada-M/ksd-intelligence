// Owner-run update from a trusted local checkout. No network and no upstream execution.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineeringLock, verifyEngineeringBundle } from './engineering-bundle.mjs';

const [checkout, commit, ...extra] = process.argv.slice(2);
assert.ok(
  checkout && isAbsolute(checkout) && /^[a-f0-9]{40}$/.test(commit ?? '') && !extra.length,
  'Usage: node scripts/sync-engineering.mjs /trusted/upstream-checkout exact-commit',
);
const root = fileURLToPath(new URL('..', import.meta.url));
const source = join(root, 'src', 'engineering');
const old = readEngineeringLock(root);
verifyEngineeringBundle(source, old);
const git = (args) =>
  execFileSync('git', ['-C', checkout, ...args], { maxBuffer: 2 * 1024 * 1024, timeout: 10000 });
assert.equal(
  git(['rev-parse', '--verify', commit + '^{commit}'])
    .toString()
    .trim(),
  commit,
);
const stage = mkdtempSync(join(tmpdir(), 'ksd-engineering-sync-'));
try {
  const next = { ...old, commit, files: {} };
  for (const path of Object.keys(old.files)) {
    const full = old.sourceDirectory + '/' + path;
    const line = git(['ls-tree', commit, '--', full]).toString().trimEnd();
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    assert.ok(match && match[3] === full, 'Upstream runtime file unavailable: ' + full);
    const bytes = git(['show', commit + ':' + full]);
    const dest = join(stage, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes, { mode: parseInt(match[1].slice(-3), 8) });
    next.files[path] = { gitBlob: match[2], mode: match[1] };
    if (path === 'package.json') {
      const pkg = JSON.parse(bytes.toString('utf8'));
      assert.equal(pkg.name, old.package);
      assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
      next.version = pkg.version;
    }
  }
  verifyEngineeringBundle(stage, next);
  // The source is already verified and contains only allowlisted regular files.
  for (const path of Object.keys(next.files)) {
    const dest = join(source, path);
    writeFileSync(dest, git(['show', commit + ':' + old.sourceDirectory + '/' + path]));
    chmodSync(dest, parseInt(next.files[path].mode.slice(-3), 8));
  }
  verifyEngineeringBundle(source, next);
  writeFileSync(join(root, 'engineering.lock.json'), JSON.stringify(next, null, 2) + '\n');
  console.log(
    'Pinned engineering source updated; run rule generation, build and tests; review git diff.',
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
