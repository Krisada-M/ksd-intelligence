import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/adapters/cli/main.js', import.meta.url));

function status(root: string, env: NodeJS.ProcessEnv, ...flags: string[]) {
  return spawnSync(process.execPath, [cli, 'status', '--root', root, ...flags], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      TERM: 'xterm',
      LANG: 'en_US.UTF-8',
      ...env,
    },
  });
}

test('forced terminal presentation cannot alter plain or JSON CLI bytes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ei-ui-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plain = status(root, {});
  const styled = status(root, { FORCE_COLOR: '1' });
  const plainFlag = status(root, { FORCE_COLOR: '1' }, '--plain');
  const noColor = status(root, { FORCE_COLOR: '1', NO_COLOR: '1' });
  const json = status(root, {}, '--json');
  const styledJson = status(root, { FORCE_COLOR: '1' }, '--json');

  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /^STATUS degraded/);
  assert.match(styled.stdout, /\u001b\[/);
  assert.match(styled.stdout, /[├└]─/);
  assert.equal(styled.status, plain.status);
  assert.equal(plainFlag.stdout, plain.stdout);
  assert.equal(noColor.stdout, plain.stdout);
  assert.equal(styledJson.stdout, json.stdout);
  assert.equal(styledJson.stderr, json.stderr);
});
