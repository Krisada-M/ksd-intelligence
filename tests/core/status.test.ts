import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { buildIndex } from '../../src/core/engine/build.js';
import {
  STATUS_BUDGET,
  homeRelative,
  renderStatus,
  workspaceStatus,
} from '../../src/core/engine/status.js';
import {
  pinnedTypescriptVersion,
  setupTypescriptRuntime,
} from '../../src/core/engine/typescript.js';
import { loadWorkspace } from '../../src/core/engine/workspace.js';

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/mono', import.meta.url));
const CLI = fileURLToPath(new URL('../../src/adapters/cli/main.js', import.meta.url));
const LOCK_MODULE = new URL('../../src/core/engine/lock.js', import.meta.url).href;
const FIXTURE_COVERAGE =
  'Coverage    26 scanned · 19 indexable · 0 orphan (no tsconfig) · 7 unindexed (other-kind 4 · outside-index-scope 3)';

describe('ei index and ei_status (M2a.1)', () => {
  let work: string;
  let cacheHome: string;
  let repo: string;

  before(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), 'ei-status-')));
    cacheHome = join(work, 'home');
    await mkdir(cacheHome);
    // Provision the pinned runtime offline from this repository's own TypeScript package.
    const npmEnv = {
      ...process.env,
      npm_config_offline: 'true',
      npm_config_cache: join(work, 'npm'),
    };
    const typescriptDir = dirname(dirname(createRequire(import.meta.url).resolve('typescript')));
    const { stdout } = await run('npm', ['pack', '--pack-destination', work, typescriptDir], {
      env: npmEnv,
    });
    const tarball = join(work, stdout.trim().split('\n').at(-1) ?? '');
    const setup = await setupTypescriptRuntime({
      version: pinnedTypescriptVersion(),
      cacheHome,
      spec: tarball,
      installer: 'npm',
      env: npmEnv,
    });
    assert.ok(setup.ok, JSON.stringify(setup));

    repo = join(work, 'mono');
    cpSync(FIXTURE, repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('without the TypeScript runtime: index refuses and status says what to run', async () => {
    const emptyHome = join(work, 'empty-home');
    await mkdir(emptyHome);
    const workspace = await loadWorkspace(repo, emptyHome);
    assert.deepEqual(await buildIndex(workspace, { cacheHome: emptyHome }), {
      ok: false,
      code: 'degraded',
      message: 'typescript runtime missing',
      fix: 'run: ei setup',
    });
    const status = await workspaceStatus(repo, { cacheHome: emptyHome });
    assert.equal(
      renderStatus(status).split('\n')[0],
      'STATUS degraded (typescript runtime missing) · run: ei setup',
    );
  });

  it('before the first index: degraded (no index) with the fix', async () => {
    const status = await workspaceStatus(repo, { cacheHome });
    const text = renderStatus(status);
    assert.equal(text.split('\n')[0], 'STATUS degraded (no index) · run: ei index');
    assert.match(text, /^Store {7}none yet · cache /m);
    assert.match(text, /^Lock {8}free$/m);
  });

  it('ei index publishes the census; ei_status is ready, deterministic and within budget', async () => {
    const workspace = await loadWorkspace(repo, cacheHome);
    const progress: string[] = [];
    assert.equal(
      (await buildIndex(workspace, { cacheHome, onProgress: (message) => progress.push(message) }))
        .ok,
      true,
    );
    assert.deepEqual(progress, ['scan', 'program', 'extract', 'resolve', 'verify', 'publish']);

    const status = await workspaceStatus(repo, { cacheHome });
    const text = renderStatus(status);
    const lines = text.split('\n');
    assert.equal(lines[0], 'STATUS ready');
    assert.match(
      lines[1] ?? '',
      /^Index {7}published \d{4}-\d\d-\d\d \d\d:\d\d UTC · fresh \(stat probe\) · last cold \d+\.\d s \(scan \d+\.\d · program \d+\.\d · extract \d+\.\d · resolve \d+\.\d · verify \d+\.\d · publish \d+\.\d\)$/,
    );
    assert.equal(lines[2], FIXTURE_COVERAGE);
    assert.equal(
      lines[6],
      'Scope       4 packages · tsconfigs 1 (tsconfig.json) · bases 1 · tsconfig problems none',
    );
    assert.equal(lines[7], 'Config      ei.config.json ok');
    assert.match(lines[3] ?? '', /^Graph {7}\d+ declarations · \d+ edges · programs 1$/);
    assert.equal(
      lines[4],
      'Problems    0 files failed to parse · 0 not in a program · 0 unresolved imports · 1 unresolved name matches · dependencies installed: yes · incompleteReasons: none',
    );
    assert.equal(
      lines[5],
      'Gap sites   cjs-require 1 · computed-member-access 1 · dynamic-import 1 · interface-dispatch 1',
    );
    assert.match(
      text,
      new RegExp(
        `^Runtime {5}${status.runtime.kind} ${status.runtime.version.replaceAll('.', '\\.')} .* · memory limit [\\d,]+ MB · engine peak [\\d,]+ MB \\(last build\\)$`,
        'm',
      ),
    );
    assert.match(
      text,
      /^TypeScript {2}5\.9\.3 \(runtime\) · .*typescript\.js · verified sha256 [0-9a-f]{12}$/m,
    );
    assert.match(text, /^Store {7}.*index\.sqlite · [\d,]+ KB · schema 2$/m);
    // ADR 0003: uses stored and uses skipped by category, with the ratio.
    const uses = status.index?.graph.uses ?? {};
    assert.ok((uses.indexed ?? 0) > 0 && (uses.local ?? 0) > 0 && (uses.external ?? 0) > 0);
    assert.match(
      text,
      /^Uses {8}approximate · indexed \d+ · skipped external \d+ · local \d+.* · indexed share \d+\.\d%$/m,
    );
    // D49: the text shows the cache home-relative; details keep the absolute path.
    assert.ok(status.index?.path.startsWith(cacheHome));
    assert.equal(
      homeRelative(status.index?.path ?? '', cacheHome).startsWith('~/.cache/ksd-intelligence/'),
      true,
    );
    assert.ok(text.length <= STATUS_BUDGET);
    assert.equal(
      renderStatus(await workspaceStatus(repo, { cacheHome })),
      text,
      'same state, same bytes',
    );
    assert.equal(status.index?.coverage.scanned, 26);
  });

  it('drift after the build: degraded (stale index) naming the files, until the next index', async () => {
    const workspace = await loadWorkspace(repo, cacheHome);
    assert.equal((await buildIndex(workspace, { cacheHome })).ok, true);
    await appendFile(join(repo, 'packages/payments/src/fee.ts'), '// drift\n');

    const text = renderStatus(await workspaceStatus(repo, { cacheHome }));
    assert.equal(
      text.split('\n')[0],
      'STATUS degraded (stale index: 1 files drifted) · run: ei index',
    );
    assert.match(text, /· stale: 1 changed · 0 added · 0 deleted \(stat probe\) ·/);
    assert.match(text, /^Drift {7}packages\/payments\/src\/fee\.ts$/m);

    assert.equal((await buildIndex(workspace, { cacheHome })).ok, true);
    assert.equal(
      renderStatus(await workspaceStatus(repo, { cacheHome })).split('\n')[0],
      'STATUS ready',
    );
  });

  it('while another session holds the build lock: index refused, status names the holder', async () => {
    const workspace = await loadWorkspace(repo, cacheHome);
    const holder: ChildProcess = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { acquireBuildLock } from ${JSON.stringify(LOCK_MODULE)};
         console.log(acquireBuildLock(process.env.LOCK_DIR).ok ? 'held' : 'refused');
         process.stdin.resume();`,
      ],
      { env: { ...process.env, LOCK_DIR: workspace.cacheDir }, stdio: ['pipe', 'pipe', 'inherit'] },
    );
    try {
      const said = await new Promise<string>((resolve) =>
        holder.stdout?.once('data', (chunk) => resolve(String(chunk).trim())),
      );
      assert.equal(said, 'held');
      const refused = await buildIndex(workspace, { cacheHome });
      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.code, 'busy');
      const text = renderStatus(await workspaceStatus(repo, { cacheHome }));
      assert.match(text, new RegExp(`^Lock {8}held by pid ${holder.pid} since `, 'm'));
    } finally {
      holder.kill('SIGKILL');
      await new Promise((resolve) => holder.once('exit', resolve));
    }
    const stale = renderStatus(await workspaceStatus(repo, { cacheHome }));
    assert.match(
      stale,
      new RegExp(`^Lock {8}stale \\(pid ${holder.pid} gone; the next build takes it over\\)$`, 'm'),
    );
    assert.equal((await buildIndex(workspace, { cacheHome })).ok, true, 'stale lock taken over');
  });

  it('the CLI prints the same text: ei index, then ei status', async () => {
    const env = { ...process.env, HOME: cacheHome };
    const indexed = await run(process.execPath, [CLI, 'index', '--root', repo], { env });
    assert.match(indexed.stdout, /^INDEX (cold|update|unchanged) in \d+\.\d\d s \(/);
    const status = await run(process.execPath, [CLI, 'status', '--root', repo], { env });
    // The CLI ran with HOME=cacheHome, so its `~` paths are relative to that home.
    const home = process.env.HOME;
    process.env.HOME = cacheHome;
    try {
      assert.equal(
        status.stdout.trimEnd(),
        renderStatus(await workspaceStatus(repo, { cacheHome })),
      );
    } finally {
      process.env.HOME = home;
    }
    assert.ok(status.stdout.includes(FIXTURE_COVERAGE));

    const disabled = await run(process.execPath, [CLI, 'status', '--root', repo], {
      env: { ...env, EI_DISABLED: '1' },
    });
    assert.equal(disabled.stdout.trim(), 'STATUS disabled (EI_DISABLED)');
  });
});
