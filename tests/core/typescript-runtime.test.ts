import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { isRecord } from '../../src/core/kernel/guards.js';
import { createEngineHost } from '../../src/core/engine/host.js';
import { chooseRuntime } from '../../src/core/engine/runtime.js';
import {
  checkTypescriptRuntime,
  pinnedTypescriptVersion,
  resolveTypescript,
  setupTypescriptRuntime,
  typescriptRuntimeDir,
} from '../../src/core/engine/typescript.js';

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = fileURLToPath(new URL('../../src/adapters/cli/main.js', import.meta.url));
const MISSING = { ok: false, reason: 'typescript runtime missing', fix: 'run: ei setup' };

let work: string;
// npm runs offline with a private cache: any registry access fails the test instead of passing.
let npmEnv: NodeJS.ProcessEnv;

/** A stand-in `typescript` package packed into a local tarball (no registry involved). */
async function fakeTarball(version: string): Promise<string> {
  const dir = join(work, `pkg-${version}`);
  await mkdir(join(dir, 'lib'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'typescript', version, main: 'lib/typescript.js' }),
  );
  await writeFile(
    join(dir, 'lib', 'typescript.js'),
    `module.exports = { version: ${JSON.stringify(version)} };\n`,
  );
  await writeFile(join(dir, 'lib', 'lib.d.ts'), '/// <reference lib="es5" />\n');
  await writeFile(join(dir, 'lib', 'lib.es5.d.ts'), 'interface Array<T> { length: number }\n');
  const { stdout } = await run('npm', ['pack', '--pack-destination', work, dir], { env: npmEnv });
  return join(work, stdout.trim().split('\n').at(-1) ?? '');
}

async function freshHome(name: string): Promise<string> {
  const home = join(work, name);
  await mkdir(home, { recursive: true });
  return home;
}

function bunAvailable(): boolean {
  try {
    execFileSync('bun', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('TypeScript runtime provisioning (ei setup, D44)', () => {
  const version = pinnedTypescriptVersion();
  let tarball: string;

  before(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), 'ei-ts-runtime-')));
    npmEnv = {
      ...process.env,
      npm_config_offline: 'true',
      npm_config_cache: join(work, 'npm-cache'),
      npm_config_update_notifier: 'false',
    };
    tarball = await fakeTarball(version);
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('pins exactly the TypeScript version this repository builds with', () => {
    const pkg: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.ok(isRecord(pkg));
    assert.deepEqual(pkg.eiRuntime, { typescript: version });
    const devTypescript = dirname(dirname(createRequire(import.meta.url).resolve('typescript')));
    const built: unknown = JSON.parse(readFileSync(join(devTypescript, 'package.json'), 'utf8'));
    assert.ok(isRecord(built));
    assert.equal(built.version, version, 'the dev compiler from package-lock.json');
    assert.equal(version, '5.9.3');
  });

  it('check reports a missing runtime with the fix, and never installs', async () => {
    const cacheHome = await freshHome('empty');
    assert.deepEqual(await checkTypescriptRuntime({ version, cacheHome }), MISSING);
    assert.equal(existsSync(typescriptRuntimeDir({ version, cacheHome })), false);
  });

  it('setup installs the pinned version, writes the manifest, and check verifies it', async () => {
    const cacheHome = await freshHome('installed');
    const result = await setupTypescriptRuntime({
      version,
      cacheHome,
      spec: tarball,
      installer: 'npm',
      env: npmEnv,
    });
    assert.ok(result.ok, JSON.stringify(result));
    const dir = typescriptRuntimeDir({ version, cacheHome });
    assert.equal(
      dir,
      join(cacheHome, '.cache', 'ksd-intelligence', 'runtime', `typescript-${version}`),
    );
    assert.equal(
      result.runtime.path,
      join(dir, 'node_modules', 'typescript', 'lib', 'typescript.js'),
    );
    assert.ok(isAbsolute(result.runtime.path));
    assert.equal(result.runtime.source, 'runtime');

    const manifest: unknown = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    assert.ok(isRecord(manifest));
    assert.equal(manifest.sha256, result.sha256);
    if (process.platform !== 'win32') {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(join(dir, 'manifest.json')).mode & 0o777, 0o600);
    }
    assert.deepEqual(await checkTypescriptRuntime({ version, cacheHome }), result);
  });

  it('the engine child loads the provisioned runtime by its absolute path', async () => {
    const cacheHome = await freshHome('load');
    const result = await setupTypescriptRuntime({
      version,
      cacheHome,
      spec: tarball,
      installer: 'npm',
      env: npmEnv,
    });
    assert.ok(result.ok);
    const host = createEngineHost({ runtime: await chooseRuntime(), memoryLimitMb: 256 });
    try {
      assert.deepEqual(await host.request('typescript', { path: result.runtime.path }), {
        ok: true,
        value: { version },
      });
    } finally {
      await host.stop();
    }
  });

  it('check catches a modified or incomplete runtime', async () => {
    const cacheHome = await freshHome('tampered');
    const result = await setupTypescriptRuntime({
      version,
      cacheHome,
      spec: tarball,
      installer: 'npm',
      env: npmEnv,
    });
    assert.ok(result.ok);
    const lib = dirname(result.runtime.path);

    await appendFile(result.runtime.path, '// edited\n');
    assert.deepEqual(await checkTypescriptRuntime({ version, cacheHome }), {
      ok: false,
      reason: 'typescript runtime modified (sha256 mismatch)',
      fix: 'run: ei setup',
    });

    await rm(join(lib, 'lib.es5.d.ts'));
    assert.deepEqual(await checkTypescriptRuntime({ version, cacheHome }), {
      ok: false,
      reason: 'typescript runtime incomplete (missing lib/lib.es5.d.ts)',
      fix: 'run: ei setup',
    });

    const again = await setupTypescriptRuntime({
      version,
      cacheHome,
      spec: tarball,
      installer: 'npm',
      env: npmEnv,
    });
    assert.ok(again.ok, 'setup repairs it');
  });

  it('setup refuses a package that is not the pinned version and writes no manifest', async () => {
    const cacheHome = await freshHome('wrong-version');
    const other = await fakeTarball('5.9.2');
    const result = await setupTypescriptRuntime({
      version,
      cacheHome,
      spec: other,
      installer: 'npm',
      env: npmEnv,
    });
    assert.deepEqual(result, {
      ok: false,
      reason: `typescript runtime mismatch (installed 5.9.2, pinned ${version})`,
      fix: 'run: ei setup',
    });
    assert.equal(
      existsSync(join(typescriptRuntimeDir({ version, cacheHome }), 'manifest.json')),
      false,
    );
    assert.deepEqual(await checkTypescriptRuntime({ version, cacheHome }), MISSING);
  });

  it('setup reports an install failure instead of throwing', async () => {
    const cacheHome = await freshHome('broken');
    const result = await setupTypescriptRuntime({
      version,
      cacheHome,
      spec: join(work, 'no-such-tarball.tgz'),
      installer: 'npm',
      env: npmEnv,
    });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /^typescript install failed \(npm\)/);
  });

  it(
    'setup with bun when bun is the installer',
    { skip: !bunAvailable() && !process.env.CI && 'bun not on PATH' },
    async () => {
      const cacheHome = await freshHome('bun');
      const result = await setupTypescriptRuntime({
        version,
        cacheHome,
        spec: tarball,
        installer: 'bun',
      });
      assert.ok(result.ok, JSON.stringify(result));
      assert.deepEqual(await checkTypescriptRuntime({ version, cacheHome }), result);
    },
  );

  it('workspace TypeScript only with useWorkspaceTypescript: true', async () => {
    const cacheHome = await freshHome('workspace');
    assert.deepEqual(
      await resolveTypescript({
        version,
        cacheHome,
        repoRoot: REPO_ROOT,
        useWorkspaceTypescript: false,
      }),
      MISSING,
      'default: the provisioned runtime, never the repository copy',
    );
    const workspace = await resolveTypescript({
      version,
      cacheHome,
      repoRoot: REPO_ROOT,
      useWorkspaceTypescript: true,
    });
    assert.ok(workspace.ok);
    assert.equal(workspace.runtime.source, 'workspace');
    assert.equal(workspace.runtime.version, '5.9.3');
    assert.equal(
      workspace.runtime.path,
      createRequire(join(REPO_ROOT, 'package.json')).resolve('typescript'),
    );

    const bare = await resolveTypescript({
      version,
      cacheHome,
      repoRoot: cacheHome,
      useWorkspaceTypescript: true,
    });
    assert.equal(bare.ok, false);
    assert.equal(!bare.ok && bare.reason, 'workspace typescript missing');
  });

  it('ei setup --check prints degraded with the fix, then ready after setup', async () => {
    const cacheHome = await freshHome('cli');
    const env = { ...process.env, HOME: cacheHome };
    const missing: unknown = await run(process.execPath, [CLI, 'setup', '--check'], { env }).then(
      () => assert.fail('expected exit code 1'),
      (error: unknown) => error,
    );
    assert.ok(isRecord(missing));
    assert.equal(missing.code, 1);
    assert.equal(
      String(missing.stdout).trim(),
      `typescript ${version}: degraded (typescript runtime missing) · run: ei setup`,
    );

    const result = await setupTypescriptRuntime({
      version,
      cacheHome,
      spec: tarball,
      installer: 'npm',
      env: npmEnv,
    });
    assert.ok(result.ok);
    const ready = await run(process.execPath, [CLI, 'setup', '--check'], { env });
    assert.equal(
      ready.stdout.trim(),
      `typescript ${version}: ready · ${result.runtime.path} · sha256 ${result.sha256}`,
    );
  });
});
