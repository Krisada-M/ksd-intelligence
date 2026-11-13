import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isRecord } from '../kernel/guards.js';

const run = promisify(execFile);

// Files the checker cannot work without; their absence means a broken or partial install.
const REQUIRED_LIB_FILES = ['lib.d.ts', 'lib.es5.d.ts'];

export interface TypescriptRuntime {
  version: string;
  /** Absolute path of `lib/typescript.js`; the engine imports exactly this file (D44). */
  path: string;
  source: 'runtime' | 'workspace';
}

export type TypescriptCheck =
  | { ok: true; runtime: TypescriptRuntime; sha256: string | null }
  | { ok: false; reason: string; fix: string };

export interface RuntimeOptions {
  version: string;
  /** Home directory holding `.cache/ksd-intelligence`; defaults to the user's. */
  cacheHome?: string;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** `eiRuntime.typescript` from this package's own package.json: the one pinned version. */
export function pinnedTypescriptVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = join(dir, 'package.json');
    const pkg = existsSync(file) ? readJson(file) : null;
    if (isRecord(pkg) && pkg.name === 'ksd-intelligence') {
      const pinned = isRecord(pkg.eiRuntime) ? pkg.eiRuntime.typescript : undefined;
      if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned)) {
        throw new Error(`eiRuntime.typescript must be an exact version in ${file}`);
      }
      return pinned;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`ksd-intelligence package.json not found above ${dir}`);
    dir = parent;
  }
}

export function typescriptRuntimeDir(options: RuntimeOptions): string {
  const home = options.cacheHome ?? homedir();
  return join(home, '.cache', 'ksd-intelligence', 'runtime', `typescript-${options.version}`);
}

const SETUP_FIX = 'run: ei setup';

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** Problems with an installed package, or null when it is complete and at `version`. */
function inspectPackage(packageDir: string, version: string): string | null {
  const pkgFile = join(packageDir, 'package.json');
  if (!existsSync(pkgFile)) return 'typescript runtime missing';
  const pkg = readJson(pkgFile);
  const installed = isRecord(pkg) ? pkg.version : undefined;
  if (installed !== version) {
    return `typescript runtime mismatch (installed ${String(installed)}, pinned ${version})`;
  }
  const missing = ['typescript.js', ...REQUIRED_LIB_FILES].filter(
    (name) => !existsSync(join(packageDir, 'lib', name)),
  );
  return missing.length === 0 ? null : `typescript runtime incomplete (missing lib/${missing[0]})`;
}

/** Verifies the provisioned runtime against its manifest; reads files, never the network. */
export async function checkTypescriptRuntime(options: RuntimeOptions): Promise<TypescriptCheck> {
  const dir = typescriptRuntimeDir(options);
  const packageDir = join(dir, 'node_modules', 'typescript');
  const path = join(packageDir, 'lib', 'typescript.js');
  try {
    const manifestFile = join(dir, 'manifest.json');
    if (!existsSync(manifestFile))
      return { ok: false, reason: 'typescript runtime missing', fix: SETUP_FIX };
    const manifest = readJson(manifestFile);
    if (!isRecord(manifest) || manifest.version !== options.version) {
      return { ok: false, reason: 'typescript runtime mismatch (manifest)', fix: SETUP_FIX };
    }
    const problem = inspectPackage(packageDir, options.version);
    if (problem !== null) return { ok: false, reason: problem, fix: SETUP_FIX };
    const sha256 = await sha256Of(path);
    if (sha256 !== manifest.sha256) {
      return { ok: false, reason: 'typescript runtime modified (sha256 mismatch)', fix: SETUP_FIX };
    }
    return { ok: true, runtime: { version: options.version, path, source: 'runtime' }, sha256 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `typescript runtime unreadable (${message})`, fix: SETUP_FIX };
  }
}

export interface SetupOptions extends RuntimeOptions {
  /** What to install; defaults to `typescript@<version>` from the registry. Tests pass a tarball. */
  spec?: string;
  /** Defaults to npm when it is on PATH, else bun. */
  installer?: 'npm' | 'bun';
  env?: NodeJS.ProcessEnv;
}

async function onPath(command: string, env: NodeJS.ProcessEnv | undefined): Promise<boolean> {
  try {
    await run(command, ['--version'], { env });
    return true;
  } catch {
    return false;
  }
}

/**
 * `ei setup` (D44): installs exactly the pinned TypeScript into the private runtime directory,
 * verifies it and writes the manifest last, so an interrupted install never passes the check.
 * The only network use in the library; owner-run.
 */
export async function setupTypescriptRuntime(options: SetupOptions): Promise<TypescriptCheck> {
  const dir = typescriptRuntimeDir(options);
  const spec = options.spec ?? `typescript@${options.version}`;
  const installer = options.installer ?? ((await onPath('npm', options.env)) ? 'npm' : 'bun');
  // A clean reinstall: npm and bun skip a package already at the version, even if its files changed.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(join(dir, 'package.json'), '{ "private": true }\n');

  const args =
    installer === 'npm'
      ? [
          'install',
          '--prefix',
          dir,
          '--no-save',
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '--ignore-scripts',
          spec,
        ]
      : ['add', '--cwd', dir, '--exact', '--ignore-scripts', '--no-save', spec];
  try {
    await run(installer, args, { env: options.env, maxBuffer: 16 * 2 ** 20 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `typescript install failed (${installer}): ${message.trim()}`,
      fix: SETUP_FIX,
    };
  }

  const packageDir = join(dir, 'node_modules', 'typescript');
  const problem = inspectPackage(packageDir, options.version);
  if (problem !== null) return { ok: false, reason: problem, fix: SETUP_FIX };
  const manifest = {
    version: options.version,
    sha256: await sha256Of(join(packageDir, 'lib', 'typescript.js')),
    installer,
    installedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return checkTypescriptRuntime(options);
}

/**
 * The TypeScript the engine loads: the provisioned runtime, or only with
 * `impact.useWorkspaceTypescript: true` the analysed repository's own copy (D30, D44).
 */
export async function resolveTypescript(
  options: RuntimeOptions & { repoRoot: string; useWorkspaceTypescript: boolean },
): Promise<TypescriptCheck> {
  if (!options.useWorkspaceTypescript) return checkTypescriptRuntime(options);
  try {
    const path = createRequire(join(options.repoRoot, 'package.json')).resolve('typescript');
    const pkg = readJson(join(dirname(dirname(path)), 'package.json'));
    const version = isRecord(pkg) && typeof pkg.version === 'string' ? pkg.version : 'unknown';
    return { ok: true, runtime: { version, path, source: 'workspace' }, sha256: null };
  } catch {
    return {
      ok: false,
      reason: 'workspace typescript missing',
      fix: 'install typescript in the repository, or set impact.useWorkspaceTypescript: false and run: ei setup',
    };
  }
}
