import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';
import { repositoryLimits } from '../../src/core/graph/limits.js';

it('repository limits distinguish prefix-less imports, policy exclusions and extraction failures', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE gap_sites (code TEXT, detail TEXT);
      CREATE TABLE files (reason TEXT, kind TEXT);
      CREATE TABLE file_index (extraction TEXT);
      INSERT INTO gap_sites VALUES
        ('dynamic-import', '*'), ('cjs-require', '*'),
        ('dynamic-import', 'missing/prefix/'), ('cjs-require', 'external-package');
      INSERT INTO files VALUES
        ('excluded', 'ts'), ('secret', 'other'), ('symlink', 'js'),
        ('outside-index-scope', 'tsx'), ('outside-index-scope', 'json'),
        ('other-kind', 'json'), ('no-tsconfig', 'js'), (NULL, 'ts');
      INSERT INTO file_index VALUES ('ok'), ('parse-error'), ('lexical'), ('not-in-program');
    `);
    assert.deepEqual(repositoryLimits(db), {
      unboundedDynamicImports: 2,
      excludedFiles: 4,
      failedFiles: 1,
    });
  } finally {
    db.close();
  }
});
