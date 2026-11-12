import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type * as TS from 'typescript';
import type { ImpactConfig } from '../kernel/config.js';
import { isRecord } from '../kernel/guards.js';
import { matchAny, matchGlob } from '../kernel/glob.js';
import type { FileRecord } from '../../storage/sqlite.js';

const run = promisify(execFile);

export type FileKind = 'ts' | 'tsx' | 'js' | 'jsx' | 'mjs' | 'cjs' | 'd.ts' | 'json' | 'other';
export type FileStatus = 'indexable' | 'orphan' | 'unindexed';
/** Why a file is not indexable. Excluded and secret files are listed, never read (RISK §6). */
export type CensusReason =
  'secret' | 'excluded' | 'outside-index-scope' | 'other-kind' | 'symlink' | 'no-tsconfig';

/** The TypeScript surface the scan needs; the module itself is loaded by absolute path (D44). */
export type TypescriptApi = Pick<
  typeof TS,
  'version' | 'sys' | 'getParsedCommandLineOfConfigFile' | 'resolveProjectReferencePath'
>;

/** Boundary check for a module imported by path: the members the scan calls are present. */
export function isTypescriptApi(value: unknown): value is TypescriptApi {
  return (
    isRecord(value) &&
    typeof value.version === 'string' &&
    isRecord(value.sys) &&
    typeof value.getParsedCommandLineOfConfigFile === 'function' &&
    typeof value.resolveProjectReferencePath === 'function'
  );
}

// RISK §6 default excludes: secrets first (reported as `secret`), then build and VCS output.
const SECRET_PATTERNS = ['**/.env*', '**/*.pem', '**/*.key', '**/*credentials*', '**/secrets/**'];
const DEFAULT_EXCLUDES = ['**/node_modules/**', '**/dist/**', '**/.git/**'];

const KINDS: Record<string, FileKind> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mjs': 'mjs',
  '.cjs': 'cjs',
  '.json': 'json',
};

const TSCONFIG_NAME = /^(?:tsconfig(?:\..+)?|jsconfig)\.json$/;
const HASH_CONCURRENCY = 32;

export function kindOf(path: string): FileKind {
  if (/\.d\.[cm]?ts$/.test(path)) return 'd.ts';
  return KINDS[extname(path)] ?? 'other';
}

/** Secret and excluded paths are decided by path alone, so their content is never read. */
export function exclusionOf(path: string, impact: ImpactConfig): 'secret' | 'excluded' | null {
  if (SECRET_PATTERNS.some((pattern) => matchGlob(pattern, path))) return 'secret';
  if (matchAny([...DEFAULT_EXCLUDES, ...impact.exclude], path)) return 'excluded';
  return null;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

// One read is ~35% faster than a stream on source-sized files (oh-my-pi: 1.6 s vs 2.5 s for
// 210 MB in 10,485 files); large files stream so a big binary never sits in memory whole.
const STREAM_ABOVE_BYTES = 8 * 2 ** 20;

export async function hashFile(path: string, size: number): Promise<string> {
  const hash = createHash('sha256');
  if (size > STREAM_ABOVE_BYTES) await pipeline(createReadStream(path), hash);
  else hash.update(await readFile(path));
  return hash.digest('hex');
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  // Workers share one iterator, so each item is taken exactly once.
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) results[index] = await work(item);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface IgnoreRule {
  glob: string;
  negate: boolean;
  dirOnly: boolean;
}

// shortcut: gitignore character classes ([abc]) and escapes are matched literally (the shared glob
// does not support them); only the non-git fallback uses this, git repositories use git itself.
function parseGitignore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trimEnd();
    if (line === '' || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const prefix = base === '' ? '' : `${base}/`;
    rules.push({ glob: anchored ? prefix + line : `${prefix}**/${line}`, negate, dirOnly });
  }
  return rules;
}

async function walkVisible(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string, inherited: IgnoreRule[]): Promise<void> => {
    const abs = join(root, dir);
    const entries = await readdir(abs, { withFileTypes: true });
    const own = await readFile(join(abs, '.gitignore'), 'utf8').then(
      (text) => parseGitignore(text, dir),
      () => [],
    );
    const rules = [...inherited, ...own];
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      const isDir = entry.isDirectory();
      let ignored = false;
      for (const rule of rules) {
        if ((!rule.dirOnly || isDir) && matchGlob(rule.glob, path)) ignored = !rule.negate;
      }
      if (ignored) continue;
      if (isDir) await visit(path, rules);
      else files.push(path);
    }
  };
  await visit('', []);
  return files;
}

/**
 * The visible set (D25): git's tracked + untracked − ignored when `root` is in a git work tree,
 * else a walk honouring .gitignore. Paths are repo-relative POSIX; the disk check comes later.
 */
export async function listVisibleFiles(
  root: string,
): Promise<{ paths: string[]; listing: 'git' | 'walk' }> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { maxBuffer: 256 * 2 ** 20 },
    );
    // Unmerged entries are listed once per stage.
    return { paths: [...new Set(stdout.split('\0').filter(Boolean))], listing: 'git' };
  } catch {
    return { paths: await walkVisible(root), listing: 'walk' };
  }
}

export interface DiskEntry {
  path: string;
  size: number;
  mtimeMs: number;
  symlink: boolean;
}

/** Disk is the truth: listed paths that are gone, or are directories (submodules), drop out. */
export async function statVisible(
  root: string,
): Promise<{ entries: DiskEntry[]; listing: 'git' | 'walk' }> {
  const { paths, listing } = await listVisibleFiles(root);
  // Synchronous on purpose: 10,502 lstat calls take ~30 ms in one loop and ~400 ms as promises
  // through the thread pool (oh-my-pi, Node 24). This runs on every query.
  const entries: DiskEntry[] = [];
  for (const path of paths) {
    let stat;
    try {
      stat = lstatSync(join(root, path), { throwIfNoEntry: false });
    } catch {
      continue; // unreadable parent directory: not on disk as far as the index can tell
    }
    if (stat === undefined || (!stat.isFile() && !stat.isSymbolicLink())) continue;
    entries.push({ path, size: stat.size, mtimeMs: stat.mtimeMs, symlink: stat.isSymbolicLink() });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1)); // listed paths are unique
  return { entries, listing };
}

interface ParsedConfig {
  path: string;
  files: Set<string>;
}

/** Repo-relative paths of configs named by a relative `extends` (string or array). */
function extendedConfigs(root: string, configPath: string, raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const values = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
  const bases: string[] = [];
  for (const value of values) {
    // Package specifiers resolve into node_modules, which is never part of the visible set.
    if (typeof value !== 'string' || !value.startsWith('.')) continue;
    const file = join(root, dirname(configPath), value.endsWith('.json') ? value : `${value}.json`);
    bases.push(toPosix(relative(root, file)));
  }
  return bases;
}

/**
 * Every tsconfig the visible set holds, plus configs reached through project references, parsed
 * by TypeScript itself so `extends`, `include`/`exclude`/`files` and `allowJs` mean exactly what
 * they mean to the compiler. A base (a config other configs extend, that no reference names and
 * that declares no `include` or `files`, such as `tsconfig.base.json`) is not a project: its
 * implicit `include` of everything below it would claim files no real project compiles.
 */
function parseConfigs(
  root: string,
  ts: TypescriptApi,
  candidates: string[],
): { configs: ParsedConfig[]; bases: string[]; errors: string[] } {
  const parsedConfigs: ParsedConfig[] = [];
  const errors: string[] = [];
  const extended = new Set<string>();
  const referenced = new Set<string>();
  const implicitInclude = new Set<string>();
  const seen = new Set<string>();
  const queue = [...candidates];
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined };
  while (queue.length > 0) {
    const path = queue.shift() ?? '';
    if (seen.has(path)) continue;
    seen.add(path);
    const parsed = ts.getParsedCommandLineOfConfigFile(join(root, path), {}, host);
    if (!parsed) {
      errors.push(`${path}: cannot be read or parsed`);
      continue;
    }
    for (const error of parsed.errors) {
      const text =
        typeof error.messageText === 'string' ? error.messageText : error.messageText.messageText;
      // TS18003 "No inputs were found" is a fact about the config, not a parse problem.
      if (error.code !== 18003) errors.push(`${path}: ${text}`);
    }
    const raw: unknown = parsed.raw;
    for (const base of extendedConfigs(root, path, raw)) extended.add(base);
    // shortcut: only the config's own `include`/`files` count; one inherited through `extends`
    // looks implicit, so a middle config that is itself extended is treated as a base. Upgrade
    // to the compiler's resolved specs if a real repository shows such a chain.
    if (!isRecord(raw) || (raw.include === undefined && raw.files === undefined)) {
      implicitInclude.add(path);
    }
    const files = new Set<string>();
    for (const file of parsed.fileNames) {
      const rel = toPosix(relative(root, file));
      if (!rel.startsWith('..') && !isAbsolute(rel)) files.add(rel);
    }
    parsedConfigs.push({ path, files });
    for (const reference of parsed.projectReferences ?? []) {
      const rel = toPosix(relative(root, ts.resolveProjectReferencePath(reference)));
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      referenced.add(rel);
      queue.push(rel);
    }
  }
  const isBase = (path: string): boolean =>
    extended.has(path) && !referenced.has(path) && implicitInclude.has(path);
  return {
    configs: parsedConfigs.filter((config) => !isBase(config.path)),
    bases: parsedConfigs.filter((config) => isBase(config.path)).map((config) => config.path),
    errors,
  };
}

function depthOf(configPath: string): number {
  const dir = dirname(configPath);
  return dir === '.' ? 0 : dir.split('/').length;
}

/** Nearest = deepest config directory; in one directory `tsconfig.json` wins, then name order. */
function nearer(a: string, b: string): boolean {
  if (depthOf(a) !== depthOf(b)) return depthOf(a) > depthOf(b);
  const aDefault = basename(a) === 'tsconfig.json';
  if (aDefault !== (basename(b) === 'tsconfig.json')) return aDefault;
  return a < b;
}

function ownerOf(path: string, configs: ParsedConfig[]): string | null {
  let best: string | null = null;
  for (const config of configs) {
    if (config.files.has(path) && (best === null || nearer(config.path, best))) best = config.path;
  }
  return best;
}

function packageOf(path: string, packageDirs: Set<string>): string | null {
  let dir = dirname(path);
  for (;;) {
    if (packageDirs.has(dir)) return dir;
    if (dir === '.') return null;
    dir = dirname(dir);
  }
}

/** One census row with the scan's own vocabulary for kind, status and reason. */
export interface CensusRecord extends FileRecord {
  kind: FileKind;
  status: FileStatus;
  reason: CensusReason | null;
}

export interface ScanSummary {
  scanned: number;
  indexable: number;
  orphan: number;
  unindexed: number;
  /** Count per non-indexable reason. */
  reasons: Partial<Record<CensusReason, number>>;
  packages: number;
  /** Configs that own files (projects). */
  tsconfigs: string[];
  /** Configs only extended by others (bases); they own nothing. */
  tsconfigBases: string[];
  tsconfigErrors: string[];
  listing: 'git' | 'walk';
  ms: number;
}

export interface ScanResult {
  records: CensusRecord[];
  summary: ScanSummary;
}

function classify(
  path: string,
  kind: FileKind,
  tsconfig: string | null,
  impact: ImpactConfig,
): Pick<CensusRecord, 'status' | 'reason'> {
  if (!matchAny(impact.include, path))
    return { status: 'unindexed', reason: 'outside-index-scope' };
  if (kind === 'json' || kind === 'other') return { status: 'unindexed', reason: 'other-kind' };
  if (tsconfig === null) return { status: 'orphan', reason: 'no-tsconfig' };
  return { status: 'indexable', reason: null };
}

/**
 * Phase 1 SCAN (DESIGN §6.2.1): census of every visible file with size, mtime, kind, content hash,
 * owning package and owning tsconfig, classified indexable · orphan · unindexed with a reason.
 */
export async function scan(
  root: string,
  impact: ImpactConfig,
  ts: TypescriptApi,
): Promise<ScanResult> {
  const started = performance.now();
  const { entries, listing } = await statVisible(root);

  const packageDirs = new Set(
    entries
      .filter((entry) => basename(entry.path) === 'package.json')
      .map((entry) => dirname(entry.path)),
  );
  const configCandidates = entries
    .filter((entry) => TSCONFIG_NAME.test(basename(entry.path)))
    .filter((entry) => !entry.symlink && exclusionOf(entry.path, impact) === null)
    .map((entry) => entry.path);
  const { configs, bases, errors } = parseConfigs(root, ts, configCandidates);

  const records = await mapLimit(entries, HASH_CONCURRENCY, async (entry) => {
    const kind = kindOf(entry.path);
    const base = { path: entry.path, size: entry.size, mtimeMs: entry.mtimeMs, kind };
    const pkg = packageOf(entry.path, packageDirs);
    const excluded = entry.symlink ? 'symlink' : exclusionOf(entry.path, impact);
    if (excluded !== null) {
      const row: CensusRecord = {
        ...base,
        package: pkg,
        hash: null,
        tsconfig: null,
        status: 'unindexed',
        reason: excluded,
      };
      return row;
    }
    const hash = await hashFile(join(root, entry.path), entry.size);
    const tsconfig = ownerOf(entry.path, configs);
    const row: CensusRecord = {
      ...base,
      package: pkg,
      hash,
      tsconfig,
      ...classify(entry.path, kind, tsconfig, impact),
    };
    return row;
  });

  const reasons: Partial<Record<CensusReason, number>> = {};
  const counts = { indexable: 0, orphan: 0, unindexed: 0 };
  for (const record of records) {
    counts[record.status]++;
    if (record.reason !== null) reasons[record.reason] = (reasons[record.reason] ?? 0) + 1;
  }
  return {
    records,
    summary: {
      scanned: records.length,
      ...counts,
      reasons,
      packages: packageDirs.size,
      tsconfigs: configs.map((config) => config.path).sort(),
      tsconfigBases: bases.sort(),
      tsconfigErrors: errors,
      listing,
      ms: Math.round(performance.now() - started),
    },
  };
}
