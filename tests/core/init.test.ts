import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_RISK_ZONES,
  defaultConfig,
  parseProjectConfig,
} from '../../src/core/kernel/config.js';
import {
  computeRepoId,
  detectProjectLayout,
  discoverTsconfigs,
  findGitRoot,
  initProject,
  resolveCacheDir,
} from '../../src/core/workspace/init.js';

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ei-test-${prefix}-`));
  return realpath(dir);
}

describe('config core', () => {
  it('generates canonical default configuration', () => {
    const config = defaultConfig();
    assert.equal(config.skills.enabled, true);
    assert.equal(config.impact.enabled, true);
    assert.deepEqual(config.impact.include, ['packages/**', 'apps/**']);
    assert.deepEqual(
      config.impact.routes,
      [],
      'no route is assumed until one is detected or declared',
    );
    assert.equal(config.impact.maxDepth, 10);
    assert.equal(config.impact.freshness, 'stat');
    assert.equal(config.impact.watch, true);
    assert.equal(config.impact.manyCallers, 10);
    assert.equal(config.impact.useWorkspaceTypescript, false);
    assert.equal(config.bridges.B1, true);
    assert.equal(config.search.enabled, true);
    assert.equal(config.search.semantic, false);
    assert.equal(config.riskZones, 'default');
    assert.equal(config.context.enabled, false);
    assert.equal(config.gitlab.enabled, false);
  });

  it('respects inferred layout options in defaultConfig', () => {
    const config = defaultConfig({
      include: ['src/**'],
      routes: ['src/routes.ts'],
    });
    assert.deepEqual(config.impact.include, ['src/**']);
    assert.deepEqual(config.impact.routes, ['src/routes.ts']);
  });

  it('parses valid json configuration', () => {
    const raw = JSON.stringify({
      skills: { enabled: false },
      impact: {
        enabled: true,
        include: ['lib/**'],
        exclude: ['**/test/**'],
        routes: [],
        maxDepth: 5,
        freshness: 'hash',
        watch: false,
        manyCallers: 20,
        useWorkspaceTypescript: true,
      },
      riskZones: [{ zone: 'payments', floor: 'high', match: ['**/pay/**'] }],
    });

    const { config, errors } = parseProjectConfig(raw);
    assert.equal(errors.length, 0);
    assert.equal(config.skills.enabled, false);
    assert.deepEqual(config.impact.include, ['lib/**']);
    assert.equal(config.impact.maxDepth, 5);
    assert.equal(config.impact.freshness, 'hash');
    assert.equal(config.impact.watch, false);
    assert.equal(config.impact.manyCallers, 20);
    assert.equal(config.impact.useWorkspaceTypescript, true);
    assert.ok(Array.isArray(config.riskZones));
    assert.equal(config.riskZones.length, 1);
  });

  it('falls back to section defaults on invalid json or corrupt sections', () => {
    const { config: brokenJsonConfig, errors: brokenErrors } = parseProjectConfig('not valid json');
    assert.ok(brokenErrors.length > 0);
    assert.equal(brokenJsonConfig.skills.enabled, true);

    const partialBad = JSON.stringify({
      impact: 'invalid-should-be-object',
      search: { enabled: 'not-a-bool' },
    });
    const { config, errors } = parseProjectConfig(partialBad);
    assert.ok(errors.length >= 2);
    assert.equal(config.impact.enabled, true);
    assert.deepEqual(config.impact.include, ['packages/**', 'apps/**']);
    assert.equal(config.search.enabled, true);
  });

  it('provides default risk zones matching docs/RISK.md §2.1', () => {
    assert.equal(DEFAULT_RISK_ZONES.length, 4);
    assert.equal(DEFAULT_RISK_ZONES[0]?.zone, 'payments');
    assert.equal(DEFAULT_RISK_ZONES[0]?.floor, 'high');
    assert.equal(DEFAULT_RISK_ZONES[2]?.zone, 'migrations');
    assert.equal(DEFAULT_RISK_ZONES[2]?.floor, 'critical');
  });
});

describe('workspace init engine', () => {
  it('computes deterministic 16-hex repo id', async () => {
    const dir1 = await makeTempDir('repo-id-1');
    const dir2 = await makeTempDir('repo-id-2');
    try {
      const id1 = computeRepoId(dir1);
      const id1Again = computeRepoId(dir1);
      const id2 = computeRepoId(dir2);

      assert.match(id1, /^[0-9a-f]{16}$/);
      assert.equal(id1, id1Again);
      assert.notEqual(id1, id2);
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it('resolves cache directory under custom home or default homedir', () => {
    const repoId = '0123456789abcdef';
    const custom = resolveCacheDir(repoId, '/tmp/custom-home');
    assert.equal(custom, join('/tmp/custom-home', '.cache', 'ksd-intelligence', repoId));
  });

  it('findGitRoot detects git repository folder', async () => {
    const repo = await makeTempDir('git-root');
    const sub = join(repo, 'packages', 'pkg-a');
    try {
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(sub, { recursive: true });

      assert.equal(findGitRoot(sub), repo);
      assert.equal(findGitRoot(repo), repo);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('detects project layout for monorepos vs single-src repos', async () => {
    const mono = await makeTempDir('mono');
    const single = await makeTempDir('single');
    try {
      await mkdir(join(mono, 'packages'), { recursive: true });
      await mkdir(join(mono, 'apps'), { recursive: true });
      await mkdir(join(mono, 'packages', 'api', 'src'), { recursive: true });
      await writeFile(join(mono, 'packages', 'api', 'src', 'routes.ts'), '// routes');

      const monoLayout = detectProjectLayout(mono);
      assert.deepEqual(monoLayout.include, ['packages/**', 'apps/**']);
      assert.deepEqual(monoLayout.routes, ['packages/api/src/routes.ts']);

      await mkdir(join(single, 'src'), { recursive: true });
      await writeFile(join(single, 'src', 'routes.ts'), '// routes');

      const singleLayout = detectProjectLayout(single);
      assert.deepEqual(singleLayout.include, ['src/**']);
      assert.deepEqual(singleLayout.routes, ['src/routes.ts']);
    } finally {
      await rm(mono, { recursive: true, force: true });
      await rm(single, { recursive: true, force: true });
    }
  });

  it('turns detected route directories into file globs, never bare directories', async () => {
    const next = await makeTempDir('next-app');
    const bare = await makeTempDir('bare');
    try {
      await mkdir(join(next, 'app', 'api', 'charge'), { recursive: true });
      await mkdir(join(next, 'pages', 'api'), { recursive: true });

      const layout = detectProjectLayout(next);
      assert.deepEqual(layout.routes, [
        'app/api/**/route.{ts,tsx,js,jsx}',
        'pages/api/**/*.{ts,tsx,js,jsx}',
      ]);

      const bareLayout = detectProjectLayout(bare);
      assert.deepEqual(bareLayout.include, ['**']);
      assert.deepEqual(bareLayout.routes, []);
    } finally {
      await rm(next, { recursive: true, force: true });
      await rm(bare, { recursive: true, force: true });
    }
  });

  it('discovers root and nested tsconfigs', async () => {
    const dir = await makeTempDir('tsconfigs');
    try {
      await writeFile(join(dir, 'tsconfig.json'), '{}');
      await writeFile(join(dir, 'tsconfig.build.json'), '{}');
      await mkdir(join(dir, 'packages', 'core'), { recursive: true });
      await writeFile(join(dir, 'packages', 'core', 'tsconfig.json'), '{}');

      const found = await discoverTsconfigs(dir);
      assert.ok(found.includes('tsconfig.json'));
      assert.ok(found.includes('tsconfig.build.json'));
      assert.ok(found.includes('packages/core/tsconfig.json'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('initializes a fresh project workspace end-to-end', async () => {
    const repo = await makeTempDir('fresh-project');
    const customHome = await makeTempDir('custom-home');
    try {
      await mkdir(join(repo, '.git'), { recursive: true });
      await mkdir(join(repo, 'src'), { recursive: true });
      await writeFile(join(repo, 'tsconfig.json'), '{}');

      const result = await initProject({
        root: repo,
        cacheHome: customHome,
      });

      assert.equal(result.root, repo);
      assert.match(result.repoId, /^[0-9a-f]{16}$/);
      assert.equal(result.configCreated, true);
      assert.equal(result.configOverwritten, false);
      assert.equal(result.configSkipped, false);
      assert.equal(result.git.isRepo, true);
      assert.deepEqual(result.tsconfigs, ['tsconfig.json']);
      assert.deepEqual(result.config.impact.include, ['src/**']);

      // Check on-disk artifacts
      const configOnDisk = await readFile(result.configPath, 'utf8');
      const parsedOnDisk = JSON.parse(configOnDisk);
      assert.equal(parsedOnDisk.impact.enabled, true);
      assert.ok(existsSync(result.cacheDir));
      if (process.platform !== 'win32') {
        assert.equal(
          statSync(result.cacheDir).mode & 0o777,
          0o700,
          'cache dir must be private (RISK §5)',
        );
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(customHome, { recursive: true, force: true });
    }
  });

  it('skips existing config unless force is true', async () => {
    const repo = await makeTempDir('existing-config');
    const customHome = await makeTempDir('custom-home');
    try {
      const configPath = join(repo, 'ei.config.json');
      await writeFile(
        configPath,
        JSON.stringify({ skills: { enabled: false }, impact: { maxDepth: 42 } }),
      );

      // Run 1: without force
      const res1 = await initProject({ root: repo, cacheHome: customHome });
      assert.equal(res1.configCreated, false);
      assert.equal(res1.configOverwritten, false);
      assert.equal(res1.configSkipped, true);
      assert.equal(res1.config.skills.enabled, false);
      assert.equal(res1.config.impact.maxDepth, 42);

      // Run 2: with force
      const res2 = await initProject({ root: repo, force: true, cacheHome: customHome });
      assert.equal(res2.configCreated, false);
      assert.equal(res2.configOverwritten, true);
      assert.equal(res2.configSkipped, false);
      assert.equal(res2.config.skills.enabled, true); // Overwritten with default
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(customHome, { recursive: true, force: true });
    }
  });

  it('honors dryRun by making no filesystem changes', async () => {
    const repo = await makeTempDir('dry-run');
    const customHome = await makeTempDir('custom-home');
    try {
      const result = await initProject({
        root: repo,
        dryRun: true,
        cacheHome: customHome,
      });

      assert.equal(result.configCreated, true);
      assert.equal(existsSync(result.configPath), false);
      assert.equal(existsSync(result.cacheDir), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(customHome, { recursive: true, force: true });
    }
  });

  it('throws when root directory does not exist', async () => {
    await assert.rejects(
      initProject({ root: '/path/does/not/exist/at/all' }),
      /Target root path does not exist/,
    );
  });
});
