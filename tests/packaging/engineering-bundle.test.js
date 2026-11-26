import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readEngineeringLock, verifyEngineeringBundle } from '../../scripts/engineering-bundle.mjs';
import { renderAgyRule } from '../../scripts/generate-agy-engineering.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('pinned engineering source and distribution match the exact file set and Git blobs', () => {
  const lock = readEngineeringLock(root);
  verifyEngineeringBundle(join(root, 'src', 'engineering'), lock);
  verifyEngineeringBundle(join(root, 'dist', 'engineering'), lock);
  const temp = mkdtempSync(join(tmpdir(), 'ksd-bundle-'));
  try {
    cpSync(join(root, 'src', 'engineering'), temp, { recursive: true });
    verifyEngineeringBundle(temp, lock);
    writeFileSync(join(temp, 'config.js'), '// modified');
    assert.throws(() => verifyEngineeringBundle(temp, lock), /Engineering bundle changed/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('AGY manifest and generated rule use the same version and balanced policy source', () => {
  const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const manifest = readJson('.antigravity-plugin/plugin.json');
  assert.equal(manifest.name, 'ksd-intelligence');
  assert.equal(manifest.version, readJson('package.json').version);
  assert.deepEqual(manifest.skills, ['./agy-skills']);
  assert.equal(readFileSync(join(root, 'rules', 'engineering.md'), 'utf8'), renderAgyRule());
  assert.match(
    readFileSync(join(root, 'agy-skills/erosiano-review/SKILL.md'), 'utf8'),
    /name: erosiano-review/,
  );
});
