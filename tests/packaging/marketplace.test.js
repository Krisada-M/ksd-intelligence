// Guards the OMP marketplace catalog against rules OMP enforces silently.
// OMP 18.18.8 skips (with only a log warning) any plugin entry whose string `source`
// does not start with "./" (packages/coding-agent/src/extensibility/plugins/marketplace/fetcher.ts),
// which surfaces later as `Plugin "<name>" not found in marketplace "<name>"` on install.
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const readJson = (relativePath) => JSON.parse(readFileSync(join(root, relativePath), 'utf8'));

// OMP's own name rule (marketplace/types.ts, NAME_RE and MAX_NAME_LENGTH = 64), copied at oh-my-pi 17e8c17.
const NAME_SEGMENT = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

test('marketplace catalog satisfies the rules OMP enforces', () => {
  const catalog = readJson('.omp-plugin/marketplace.json');

  assert.match(catalog.name, NAME_SEGMENT, 'catalog name must be a valid name segment');
  assert.ok(catalog.name.length <= 64, 'catalog name must be at most 64 characters');
  assert.equal(typeof catalog.owner?.name, 'string', 'owner.name is required');
  assert.ok(
    Array.isArray(catalog.plugins) && catalog.plugins.length > 0,
    'plugins must be a non-empty array',
  );

  for (const plugin of catalog.plugins) {
    assert.match(
      plugin.name,
      NAME_SEGMENT,
      `plugin name "${plugin.name}" must be a valid name segment`,
    );
    assert.equal(typeof plugin.source, 'string', 'this repo uses a relative string source');
    assert.ok(
      plugin.source.startsWith('./'),
      `plugin "${plugin.name}" source "${plugin.source}" must start with "./" or OMP silently skips it`,
    );
  }
});

test('catalog version matches package.json and the extension entry exists', () => {
  const catalog = readJson('.omp-plugin/marketplace.json');
  const pkg = readJson('package.json');
  const [plugin] = catalog.plugins;

  assert.equal(
    plugin.version,
    pkg.version,
    'catalog plugin version must equal package.json version',
  );
  assert.equal(
    catalog.metadata?.version,
    pkg.version,
    'catalog metadata version must equal package.json version',
  );

  const entries = pkg.omp?.extensions ?? [];
  assert.ok(entries.length > 0, 'package.json#omp.extensions must list the extension entry');
  for (const entry of entries) {
    assert.ok(
      existsSync(join(root, entry)),
      `extension entry ${entry} must exist (committed dist/)`,
    );
  }
});
