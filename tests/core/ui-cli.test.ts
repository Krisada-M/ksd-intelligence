import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/adapters/cli/main.js', import.meta.url));

function run(
  command: 'status' | 'index',
  root: string,
  env: NodeJS.ProcessEnv,
  ...flags: string[]
) {
  return spawnSync(process.execPath, [cli, command, '--root', root, ...flags], {
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

const status = (root: string, env: NodeJS.ProcessEnv, ...flags: string[]) =>
  run('status', root, env, ...flags);

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

test('index and status explain shallow scope without counting outside lexical rows twice', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'ei-ui-scope-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = join(fixture, 'repo');
  mkdirSync(root);
  const typescript = createRequire(import.meta.url).resolve('typescript/package.json');
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(join(typescript, '..'), join(root, 'node_modules/typescript'), 'dir');
  mkdirSync(join(root, 'src/sub'), { recursive: true });
  mkdirSync(join(root, 'twice/sub'), { recursive: true });
  writeFileSync(join(root, 'twice/a.md'), '');
  writeFileSync(join(root, 'twice/sub/b.md'), '');
  const compilerFiles = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
  for (const file of compilerFiles) writeFileSync(join(root, file), 'export const x = 1;\n');
  for (let i = 0; i < 208; i++) {
    writeFileSync(join(root, `src/sub/${i}.js`), 'export const y = 2;\n');
  }
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { types: [] }, files: compilerFiles }),
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');
  const config = (pattern: string): void => {
    writeFileSync(
      join(root, 'ei.config.json'),
      JSON.stringify({ impact: { useWorkspaceTypescript: true, include: [pattern, 'twice/*'] } }),
    );
  };
  const styled = { FORCE_COLOR: '1', HOME: fixture, USERPROFILE: fixture };
  const text = (stdout: string): string => stdout.replaceAll(/\x1b\[[\d;]*m/g, '');
  const warning = 'include "src/*" matches 4 files; "src/**" would match 212';
  config('src/*');
  assert.ok(text(status(root, styled).stdout).includes(warning));

  const built = run('index', root, styled);
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const initial = text(built.stdout);
  assert.match(initial, /scanned · 212 code files/);
  assert.match(initial, /coverage .*2%/);
  assert.match(initial, /4 indexed · 208 outside scope/);
  assert.match(initial, /4 compiler · 0 lexical only · 0 errors/);
  assert.ok(initial.includes(warning));
  assert.doesNotMatch(initial, /include "twice/);

  const stderrTty = encodeURIComponent(
    'Object.defineProperty(process.stderr, "isTTY", {value:true})',
  );
  const redirected = run('index', root, {
    HOME: fixture,
    USERPROFILE: fixture,
    NODE_OPTIONS: `--import=data:text/javascript,${stderrTty}`,
  });
  assert.equal(redirected.status, 0, redirected.stderr || redirected.stdout);
  assert.match(redirected.stdout, /^INDEX unchanged/);
  assert.match(redirected.stderr, /\x1b\[\?25l/);

  const tree = text(status(root, styled).stdout);
  assert.match(tree, /unindexed[\s\S]*outside-index-scope 212[\s\S]*other-kind 1/);
  assert.match(
    tree,
    /extraction[\s\S]*ok 4[\s\S]*lexical 208[\s\S]*not-in-program 0[\s\S]*parse-error 0/,
  );
  assert.ok(tree.includes(warning));
  const plain = status(root, styled, '--plain').stdout;
  assert.match(plain, /^STATUS ready\nIndex /);
  assert.match(plain, /Coverage .*4 indexable.*unindexed/);
  assert.doesNotMatch(plain, /would match|├─/);

  config('src/**');
  const widened = run('index', root, styled);
  assert.equal(widened.status, 0, widened.stderr || widened.stdout);
  const expanded = text(widened.stdout).replaceAll(/\s+/g, ' ');
  assert.ok(expanded.includes(' config changed '));
  assert.match(expanded, /coverage .*100%.*212 indexed · 0 outside scope/);
  assert.match(widened.stdout, /\x1b\[33m coverage/);
  assert.match(expanded, /4 compiler · 208 lexical only · 0 errors/);
  assert.ok(
    expanded.includes(
      '› 208 files are not in a TypeScript program: ei_impact will be partial; check tsconfig include / allowJs',
    ),
  );
  assert.doesNotMatch(expanded, /ready for ei impact|would match/);

  config('src/*');
  const raw = run('index', root, styled, '--json');
  assert.equal(raw.status, 0, raw.stderr || raw.stdout);
  assert.match(raw.stdout, /"reason": "extractor stamp changed"/);
  assert.doesNotMatch(raw.stdout, /engine updated|would match|\x1b\[/);

  const statusJson: { index: { path: string } } = JSON.parse(status(root, styled, '--json').stdout);
  const db = new DatabaseSync(statusJson.index.path);
  try {
    db.prepare("UPDATE meta SET value = 'old' WHERE key = 'extractor_stamp'").run();
  } finally {
    db.close();
  }
  const updated = run('index', root, styled);
  assert.equal(updated.status, 0, updated.stderr || updated.stdout);
  assert.match(text(updated.stdout), /engine updated \(extractor stamp changed\)/);

  writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  const lockfile = run('index', root, styled);
  assert.equal(lockfile.status, 0, lockfile.stderr || lockfile.stdout);
  assert.match(text(lockfile.stdout), /lockfile changed: package-lock\.json/);
});
