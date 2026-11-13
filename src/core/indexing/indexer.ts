import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type * as TS from 'typescript';
import type { ImpactConfig } from '../kernel/config.js';
import { isRecord } from '../kernel/guards.js';
import { scan, type CensusRecord, type ScanSummary } from '../workspace/scan.js';
import {
  FAILURE_FILE,
  SCHEMA_VERSION,
  beginBuild,
  beginUpdate,
  discardBuild,
  openPublished,
  publishBuild,
  readFiles,
  readMeta,
  readSchemaVersion,
  transaction,
  writeFiles,
  writeMeta,
  type FileRecord,
} from '../../storage/sqlite.js';
import {
  RECORD_TABLES,
  declarationNamesOf,
  deleteFileRecords,
  deleteOrphanSymbols,
  emptyCounts,
  filesImportingPrefix,
  filesReferencingNames,
  filesWithEdgesInto,
  filesWithUnresolvedImports,
  readFileIndex,
  recordWriter,
  simpleNameCounts,
  tableCounts,
  type FileRows,
  type TableCounts,
} from '../../storage/records.js';
import { fileDeclarations, type FileDeclarations, type Ts } from './declarations.js';
import { createAnalysisHost, groupPrograms, splitBy, type ProgramGroup } from './program.js';
import { Resolver, isGlobalFile, type FileResolution, type ResolveScope } from './resolve.js';
import { extractorStamp, impactConfigHash } from './stamp.js';
import { verifyIndex } from './verify.js';

export type Progress = (message: string, data?: unknown) => void;

export interface IndexRequest {
  impact: ImpactConfig;
  /** Ignore every cache: cold build (`ei index --full`). */
  full?: boolean;
  /** `hash` reads every file (`ei index`, rebuilds); `stat` trusts unchanged size and mtime. */
  freshness?: 'hash' | 'stat';
  onProgress?: Progress;
}

export interface IndexerOptions {
  /** The engine's memory limit (D45): above half of it an update frees each checker early. */
  memoryBudgetMb?: number;
  /** VERIFY; replaceable so tests can prove a failed check keeps the previous index. */
  verify?: (db: DatabaseSync, expected: TableCounts) => string[];
}

export interface PhaseTimes {
  scan: number;
  program: number;
  extract: number;
  resolve: number;
  verify: number;
  publish: number;
}

export interface IndexReport {
  action: 'cold' | 'update' | 'unchanged' | 'failed';
  /** Why a cold build ran, or what an update covered. */
  reason: string;
  census: ScanSummary;
  drift: { added: number; changed: number; deleted: number };
  /** Files resolved in this run (every indexable file on a cold build). */
  resolvedFiles: number;
  programs: number;
  counts: TableCounts;
  /** VERIFY failures; non-empty means the previous index was kept (`incompleteReasons`). */
  problems: string[];
  phases: PhaseTimes;
}

interface Group extends ProgramGroup {
  program: TS.Program;
}

interface Programs {
  groups: Group[];
  /** tsconfigs whose options could not be read. */
  errors: string[];
}

interface Published {
  schema: number;
  meta: Record<string, string>;
  files: FileRecord[];
}

interface Census {
  records: CensusRecord[];
  summary: ScanSummary;
}

interface CensusDrift {
  added: Set<string>;
  changed: Set<string>;
  deleted: Set<string>;
  /** Files whose size or mtime changed but not their content. */
  touched: number;
  /** A file whose kind, status, package, owner or reason changed without a content change. */
  reclassified: string | null;
}

type Outcome = Omit<IndexReport, 'census' | 'counts' | 'problems' | 'phases'>;

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const CONFIG_NAME = /^(?:tsconfig(?:\..+)?|jsconfig)\.json$/;
const CODE_OR_JSON = /\.(?:[cm]?[jt]sx?|json)$/;

/** A change to one of these can change how any file resolves: always a cold build. */
function isConfigLevel(path: string): boolean {
  const name = basename(path);
  return (
    CONFIG_NAME.test(name) ||
    name === 'package.json' ||
    name === 'ei.config.json' ||
    LOCKFILES.has(name)
  );
}

function diffCensus(before: readonly FileRecord[], now: readonly CensusRecord[]): CensusDrift {
  const old = new Map(before.map((file) => [file.path, file]));
  const drift: CensusDrift = {
    added: new Set(),
    changed: new Set(),
    deleted: new Set(),
    touched: 0,
    reclassified: null,
  };
  for (const record of now) {
    const previous = old.get(record.path);
    old.delete(record.path);
    if (previous === undefined) {
      drift.added.add(record.path);
      continue;
    }
    const sameStat = previous.size === record.size && previous.mtimeMs === record.mtimeMs;
    // Never-read files (secret, excluded) change by size and mtime alone.
    const sameContent = record.hash === null ? sameStat : previous.hash === record.hash;
    if (!sameContent) drift.changed.add(record.path);
    else if (!sameStat) drift.touched++;
    const sameClass =
      previous.kind === record.kind &&
      previous.status === record.status &&
      previous.package === record.package &&
      previous.tsconfig === record.tsconfig &&
      previous.reason === record.reason;
    if (!sameClass) drift.reclassified ??= record.path;
  }
  for (const path of old.keys()) drift.deleted.add(path);
  return drift;
}

function rowsOf(
  file: string,
  sf: TS.SourceFile | undefined,
  declarations: FileDeclarations | undefined,
  resolution: FileResolution | undefined,
): FileRows {
  if (sf === undefined || declarations === undefined || resolution === undefined) {
    // Owned by a tsconfig that could not be read: listed with a reason, never dropped.
    return {
      index: {
        file,
        extraction: 'not-in-program',
        lines: 0,
        surface: '',
        global: false,
        counts: {
          indexed: 0,
          local: 0,
          external: 0,
          externalUnresolved: 0,
          unresolvedOther: 0,
          outsideScope: 0,
        },
      },
      declarations: [],
      edges: [],
      unresolved: [],
      gaps: [],
      tokens: [],
      externalImports: [],
      exports: [],
    };
  }
  const parseError = resolution.gaps.some((gap) => gap.code === 'parse-error');
  return {
    index: {
      file,
      extraction: parseError ? 'parse-error' : 'ok',
      lines: sf.getLineAndCharacterOfPosition(sf.end).line + 1,
      surface: resolution.surface,
      global: resolution.global,
      counts: resolution.counts,
    },
    declarations: declarations.declarations,
    edges: resolution.edges,
    unresolved: resolution.unresolved,
    gaps: resolution.gaps,
    tokens: resolution.tokens,
    externalImports: resolution.externalImports,
    exports: resolution.exports,
  };
}

function roundPhases(phases: PhaseTimes): PhaseTimes {
  const rounded = { ...phases };
  for (const key of Object.keys(rounded) as (keyof PhaseTimes)[]) {
    rounded[key] = Math.round(rounded[key]);
  }
  return rounded;
}

/**
 * The index pipeline of one repository (DESIGN §6.2.1): scan → extract-local → resolve → verify →
 * publish. It keeps nothing between runs: every update creates its programs from the census.
 */
export class Indexer {
  constructor(
    private readonly ts: Ts,
    readonly root: string,
    readonly cacheDir: string,
    private readonly options: IndexerOptions = {},
  ) {}

  get memoryBudgetMb(): number | undefined {
    return this.options.memoryBudgetMb;
  }

  async index(request: IndexRequest): Promise<IndexReport> {
    const progress = request.onProgress ?? (() => undefined);
    const phases: PhaseTimes = {
      scan: 0,
      program: 0,
      extract: 0,
      resolve: 0,
      verify: 0,
      publish: 0,
    };
    const stamp = extractorStamp(this.ts.version, impactConfigHash(request.impact));

    const started = performance.now();
    const published = this.readPublished();
    const fingerprint =
      request.freshness === 'stat' && published !== null
        ? new Map(published.files.map((file) => [file.path, file]))
        : undefined;
    progress('scan');
    const census = await scan(this.root, request.impact, this.ts, fingerprint);
    phases.scan = performance.now() - started;

    const drift = published === null ? null : diffCensus(published.files, census.records);
    const coldReason = this.coldReason(request, stamp, published, drift);
    if (coldReason !== null || published === null || drift === null) {
      return this.cold(
        census,
        coldReason ?? 'no published index',
        stamp,
        request,
        phases,
        progress,
      );
    }
    const contentDrift = drift.added.size + drift.changed.size + drift.deleted.size;
    if (contentDrift === 0 && drift.touched === 0) {
      return this.unchanged(census, phases);
    }
    if (contentDrift === 0) {
      return this.update(census, drift, published, stamp, request, phases, progress, null);
    }

    const programStarted = performance.now();
    progress('program');
    const programs = this.createPrograms(census.records);
    const late = this.programLevelChange(programs.groups, drift, published);
    phases.program = performance.now() - programStarted;
    if (late !== null) return this.cold(census, late, stamp, request, phases, progress);
    return this.update(census, drift, published, stamp, request, phases, progress, programs);
  }

  private readPublished(): Published | null {
    const db = openPublished(this.cacheDir);
    if (db === null) return null;
    try {
      const schema = readSchemaVersion(db);
      if (schema !== SCHEMA_VERSION) return { schema, meta: {}, files: [] };
      return { schema, meta: readMeta(db), files: readFiles(db) };
    } finally {
      db.close();
    }
  }

  private coldReason(
    request: IndexRequest,
    stamp: string,
    published: Published | null,
    drift: CensusDrift | null,
  ): string | null {
    if (request.full === true) return 'full rebuild requested';
    if (published === null || drift === null) return 'no published index';
    if (published.schema !== SCHEMA_VERSION) return `index schema ${published.schema}`;
    if (published.meta.extractor_stamp !== stamp) return 'extractor stamp changed';
    for (const path of [...drift.changed, ...drift.added, ...drift.deleted]) {
      if (isConfigLevel(path)) return `config changed: ${path}`;
    }
    if (drift.reclassified !== null) return `classification changed: ${drift.reclassified}`;
    return null;
  }

  /**
   * Checks that need the new programs. A changed global file, or a changed file that a program
   * compiles without indexing it (its types reach indexed files untracked), forces a cold build.
   */
  private programLevelChange(
    groups: readonly Group[],
    drift: CensusDrift,
    published: Published,
  ): string | null {
    const wasIndexable = new Set(
      published.files.filter((file) => file.status === 'indexable').map((file) => file.path),
    );
    const globalBefore = this.globalFiles();
    for (const path of [...drift.changed, ...drift.added, ...drift.deleted]) {
      if (globalBefore.has(path)) return `global file changed: ${path}`;
      const abs = join(this.root, path);
      const group = groups.find((g) => g.program.getSourceFile(abs) !== undefined);
      const sf = group?.program.getSourceFile(abs);
      if (group !== undefined && sf !== undefined) {
        if (isGlobalFile(this.ts, group.program.getTypeChecker(), sf)) {
          return `global file changed: ${path}`;
        }
      }
      if (wasIndexable.has(path) || drift.added.has(path) || !CODE_OR_JSON.test(path)) continue;
      // No previous programs: a deleted file's membership is unknown, so assume it was compiled.
      const wasCompiled = drift.deleted.has(path);
      if (sf !== undefined || wasCompiled) return `non-indexed program file changed: ${path}`;
    }
    return null;
  }

  private globalFiles(): Set<string> {
    const db = openPublished(this.cacheDir);
    if (db === null) return new Set();
    try {
      const found = new Set<string>();
      for (const [file, info] of readFileIndex(db)) if (info.global) found.add(file);
      return found;
    } finally {
      db.close();
    }
  }

  /** Programs for the census, one per set of compatible tsconfigs. */
  private createPrograms(census: readonly CensusRecord[]): Programs {
    const owners = new Map<string, string[]>();
    for (const record of census) {
      if (record.status !== 'indexable' || record.tsconfig === null) continue;
      const list = owners.get(record.tsconfig) ?? [];
      list.push(record.path);
      owners.set(record.tsconfig, list);
    }
    const { groups, errors } = groupPrograms(this.ts, this.root, owners);
    return {
      groups: groups.map((group) => ({
        ...group,
        program: this.ts.createProgram({
          rootNames: group.rootNames,
          options: group.options,
          host: createAnalysisHost(this.ts, group.options, undefined),
        }),
      })),
      errors,
    };
  }

  private workspacePackages(census: readonly CensusRecord[]): Set<string> {
    const names = new Set<string>();
    for (const record of census) {
      if (basename(record.path) !== 'package.json' || record.hash === null) continue;
      try {
        const pkg: unknown = JSON.parse(readFileSync(join(this.root, record.path), 'utf8'));
        if (isRecord(pkg) && typeof pkg.name === 'string') names.add(pkg.name);
      } catch {
        // an unreadable package.json names no package
      }
    }
    return names;
  }

  /** The program group of each indexable file's owning tsconfig. */
  private ownerGroups(
    groups: readonly Group[],
    census: readonly CensusRecord[],
  ): Map<string, Group> {
    const byConfig = new Map<string, Group>();
    for (const group of groups) for (const config of group.configs) byConfig.set(config, group);
    const result = new Map<string, Group>();
    for (const record of census) {
      if (record.status !== 'indexable' || record.tsconfig === null) continue;
      const group = byConfig.get(record.tsconfig);
      if (group !== undefined) result.set(record.path, group);
    }
    return result;
  }

  /**
   * Each indexable file's group, source file and a resolver of the group's current program
   * (made on demand; a lightened group gets a new one).
   */
  private sources(
    groups: readonly Group[],
    census: readonly CensusRecord[],
    scope: ResolveScope,
  ): (path: string) => { group: Group; sf: TS.SourceFile; resolver: Resolver } | undefined {
    const ownerGroup = this.ownerGroups(groups, census);
    const resolvers = new WeakMap<TS.Program, Resolver>();
    return (path) => {
      const group = ownerGroup.get(path);
      const sf = group?.program.getSourceFile(join(this.root, path));
      if (group === undefined || sf === undefined) return undefined;
      let resolver = resolvers.get(group.program);
      if (resolver === undefined) {
        resolver = new Resolver(this.ts, group.program, scope);
        resolvers.set(group.program, resolver);
      }
      return { group, sf, resolver };
    };
  }

  /** Over this share of the memory budget, programs give up their checkers between batches. */
  private memoryTight(fraction: number): boolean {
    const budget = this.options.memoryBudgetMb;
    return budget !== undefined && process.memoryUsage().rss / 2 ** 20 > budget * fraction;
  }

  /** Swaps a group's program for one sharing every parsed file but no checker, to free memory. */
  private lighten(group: Group): void {
    const host = createAnalysisHost(this.ts, group.options, group.program);
    group.program = this.ts.createProgram({
      rootNames: group.rootNames,
      options: group.options,
      host,
      oldProgram: group.program,
    });
  }

  private cold(
    census: Census,
    reason: string,
    stamp: string,
    request: IndexRequest,
    phases: PhaseTimes,
    progress: Progress,
  ): IndexReport {
    let started = performance.now();
    progress('program');
    const programs = this.createPrograms(census.records);
    phases.program += performance.now() - started;

    const indexable = census.records.filter((r) => r.status === 'indexable').map((r) => r.path);
    const declarationNames = new Set<string>();
    const scope: ResolveScope = {
      root: this.root,
      indexable: new Set(indexable),
      declarationNames,
      workspacePackages: this.workspacePackages(census.records),
    };
    const ownerGroup = this.ownerGroups(programs.groups, census.records);
    const sourceFile = (path: string): TS.SourceFile | undefined =>
      ownerGroup.get(path)?.program.getSourceFile(join(this.root, path));

    // EXTRACT-LOCAL: declarations from each file's syntax tree; their names scope the resolve.
    progress('extract', { files: indexable.length });
    started = performance.now();
    const declarations = new Map<string, FileDeclarations>();
    for (const path of indexable) {
      const sf = sourceFile(path);
      if (sf === undefined) continue;
      const found = fileDeclarations(this.ts, sf, path);
      declarations.set(path, found);
      for (const declaration of found.declarations) {
        if (declaration.kind !== 'module') declarationNames.add(declaration.simple);
      }
    }
    phases.extract = performance.now() - started;

    // RESOLVE one program at a time; a resolved program gives up its checker before the next.
    progress('resolve', { files: indexable.length });
    started = performance.now();
    const db = beginBuild(this.cacheDir);
    try {
      writeFiles(db, census.records);
      const writer = recordWriter(db);
      transaction(db, () => {
        for (const path of indexable) {
          if (sourceFile(path) === undefined)
            writer.write(rowsOf(path, undefined, undefined, undefined));
        }
        for (const group of programs.groups) {
          const resolver = new Resolver(this.ts, group.program, scope);
          for (const path of indexable) {
            if (ownerGroup.get(path) !== group) continue;
            const sf = sourceFile(path);
            if (sf === undefined) continue;
            writer.write(rowsOf(path, sf, declarations.get(path), resolver.resolveFile(sf)));
          }
          this.lighten(group);
        }
      });
      phases.resolve = performance.now() - started;
      return this.finish(db, census, writer.inserted, stamp, request, phases, progress, programs, {
        action: 'cold',
        reason,
        drift: { added: 0, changed: 0, deleted: 0 },
        resolvedFiles: indexable.length,
        programs: programs.groups.length,
      });
    } catch (error) {
      discardBuild(db, this.cacheDir);
      throw error;
    }
  }

  private update(
    census: Census,
    drift: CensusDrift,
    published: Published,
    stamp: string,
    request: IndexRequest,
    phases: PhaseTimes,
    progress: Progress,
    programs: Programs | null,
  ): IndexReport {
    const indexableNow = new Set(
      census.records.filter((r) => r.status === 'indexable').map((r) => r.path),
    );
    const changed = [...drift.changed, ...drift.added].filter((path) => indexableNow.has(path));
    const removed = published.files
      .filter((file) => file.status === 'indexable' && !indexableNow.has(file.path))
      .map((file) => file.path);

    const db = beginUpdate(this.cacheDir);
    if (db === null) {
      return this.cold(census, 'published index unreadable', stamp, request, phases, progress);
    }
    try {
      let started = performance.now();
      progress('extract', { files: changed.length });
      const before = tableCounts(db);
      const oldIndex = readFileIndex(db);
      const oldKeys = declarationNamesOf(db, [...changed, ...removed]);
      const nameCounts = simpleNameCounts(db);
      const oldNames = new Set([...nameCounts].filter(([, n]) => n > 0).map(([name]) => name));
      for (const simple of oldKeys.values()) {
        nameCounts.set(simple, (nameCounts.get(simple) ?? 0) - 1);
      }
      const declarationNames = new Set<string>();
      const scope: ResolveScope = {
        root: this.root,
        indexable: indexableNow,
        declarationNames,
        workspacePackages: this.workspacePackages(census.records),
      };
      const sourceOf =
        programs === null ? () => undefined : this.sources(programs.groups, census.records, scope);
      const newKeys = new Map<string, string>();
      for (const path of changed) {
        const source = sourceOf(path);
        if (source === undefined) continue;
        for (const declaration of source.resolver.declarationsOf(source.sf).declarations) {
          newKeys.set(declaration.key, declaration.simple);
          nameCounts.set(declaration.simple, (nameCounts.get(declaration.simple) ?? 0) + 1);
        }
      }
      for (const [name, n] of nameCounts) {
        if (n > 0 && name !== '<module>') declarationNames.add(name);
      }
      // Names whose declarations appeared or disappeared change other files' resolution.
      const names = new Set<string>();
      for (const [key, simple] of oldKeys) if (!newKeys.has(key)) names.add(simple);
      for (const [key, simple] of newKeys) if (!oldKeys.has(key)) names.add(simple);
      names.delete('<module>');
      const entering = [...declarationNames].filter((name) => !oldNames.has(name));
      phases.extract = performance.now() - started;

      // Affected set: changed files and this repository's cross-checks (no builder state, D47).
      started = performance.now();
      const pending = new Set<string>(changed);
      if (drift.added.size + drift.deleted.size > 0) {
        // A new or removed file can change how imports resolve.
        for (const path of filesWithUnresolvedImports(db)) pending.add(path);
        const prefixes = [...drift.added, ...drift.deleted].map((path) =>
          dirname(path) === '.' ? '' : `${dirname(path)}/`,
        );
        for (const path of filesImportingPrefix(db, prefixes)) pending.add(path);
      }
      for (const path of filesWithEdgesInto(db, removed)) pending.add(path);
      for (const path of filesReferencingNames(db, names)) pending.add(path);
      if (entering.length > 0) {
        // A name new to the index: files mentioning it were never recorded under it.
        for (const path of indexableNow) {
          const text = sourceOf(path)?.sf.text;
          if (text !== undefined && entering.some((name) => text.includes(name))) pending.add(path);
        }
      }

      progress('resolve', { files: pending.size });
      const resolved = new Map<string, FileRows>();
      // A file's surface counts as changed when its text-derived surface differs, or when one of
      // its observable declarations (types written or inferred) has an edge into a file whose
      // surface changed: an overload, a conditional or an inferred type can then resolve to
      // something else with no edit to the file itself, and its dependents see a different type.
      const changedSurface = new Set<string>();
      const observableKeysOf = new Map<string, ReadonlySet<string>>();
      const isObservableSource = (keys: ReadonlySet<string>, source: string): boolean => {
        if (keys.has(source)) return true;
        for (let dot = source.indexOf('.', source.indexOf('#')); dot !== -1;) {
          if (keys.has(source.slice(0, dot))) return true;
          dot = source.indexOf('.', dot + 1);
        }
        return false;
      };
      const leaks = (path: string): boolean => {
        const keys = observableKeysOf.get(path);
        const rows = resolved.get(path);
        if (keys === undefined || rows === undefined) return false;
        return rows.edges.some(
          (edge) =>
            changedSurface.has(edge.target.slice(0, edge.target.indexOf('#'))) &&
            isObservableSource(keys, edge.source),
        );
      };
      let next: string[] = [];
      const markChanged = (start: string): void => {
        const stack = [start];
        for (let path = stack.pop(); path !== undefined; path = stack.pop()) {
          if (changedSurface.has(path)) continue;
          changedSurface.add(path);
          for (const dependent of filesWithEdgesInto(db, [path])) {
            if (resolved.has(dependent)) {
              if (leaks(dependent)) stack.push(dependent);
            } else if (!pending.has(dependent)) {
              next.push(dependent);
            }
          }
        }
      };
      // Rounds: each resolves its files one program at a time, like the cold build, and queues
      // the dependents of changed surfaces for the next round.
      let round = [...pending];
      while (round.length > 0) {
        next = [];
        const byGroup = new Map<Group | undefined, string[]>();
        for (const path of new Set(round)) {
          if (resolved.has(path) || !indexableNow.has(path)) continue;
          const group = sourceOf(path)?.group;
          byGroup.set(group, [...(byGroup.get(group) ?? []), path]);
        }
        for (const [group, paths] of byGroup) {
          for (const path of paths) {
            const source = sourceOf(path);
            const resolution = source?.resolver.resolveFile(source.sf);
            resolved.set(
              path,
              rowsOf(path, source?.sf, source?.resolver.declarationsOf(source.sf), resolution),
            );
            if (resolution === undefined) continue;
            observableKeysOf.set(path, resolution.observableKeys);
            if (oldIndex.get(path)?.surface !== resolution.surface || leaks(path)) {
              markChanged(path);
            }
          }
          if (group !== undefined && this.memoryTight(0.5)) this.lighten(group);
        }
        round = next;
      }
      const expected = emptyCounts();
      transaction(db, () => {
        db.exec('DELETE FROM files');
        writeFiles(db, census.records);
        const deleted = deleteFileRecords(db, [...resolved.keys(), ...removed]);
        const writer = recordWriter(db);
        for (const rows of resolved.values()) writer.write(rows);
        for (const table of RECORD_TABLES) {
          expected[table] = before[table] - deleted[table] + writer.inserted[table];
        }
        deleteOrphanSymbols(db);
      });
      phases.resolve = performance.now() - started;
      return this.finish(db, census, expected, stamp, request, phases, progress, programs, {
        action: 'update',
        reason: `${changed.length} changed · ${removed.length} removed · ${resolved.size} resolved`,
        drift: {
          added: drift.added.size,
          changed: drift.changed.size,
          deleted: drift.deleted.size,
        },
        resolvedFiles: resolved.size,
        programs: programs?.groups.length ?? Number(published.meta.programs ?? 0),
      });
    } catch (error) {
      discardBuild(db, this.cacheDir);
      throw error;
    }
  }

  /**
   * VERIFY, then PUBLISH; on failure the previous index stays and the report lists why.
   * `programs` null: the census alone changed (sizes or times), not any file's content.
   */
  private finish(
    db: DatabaseSync,
    census: Census,
    produced: TableCounts,
    stamp: string,
    request: IndexRequest,
    phases: PhaseTimes,
    progress: Progress,
    programs: Programs | null,
    outcome: Outcome,
  ): IndexReport {
    progress('verify');
    let started = performance.now();
    const verify = this.options.verify ?? verifyIndex;
    const problems = verify(db, { ...produced, files: census.records.length });
    phases.verify = performance.now() - started;
    const counts = tableCounts(db);
    if (problems.length > 0) {
      discardBuild(db, this.cacheDir);
      const failure = { at: new Date().toISOString(), reason: `${outcome.action} build`, problems };
      writeFileSync(join(this.cacheDir, FAILURE_FILE), JSON.stringify(failure), { mode: 0o600 });
      return {
        ...outcome,
        action: 'failed',
        census: census.summary,
        counts,
        problems,
        phases: roundPhases(phases),
      };
    }
    progress('publish');
    started = performance.now();
    const buildId = randomUUID();
    writeMeta(db, {
      build_id: buildId,
      built_at: (programs === null ? readMeta(db).built_at : undefined) ?? new Date().toISOString(),
      last_action: outcome.action,
      last_reason: outcome.reason,
      extractor_stamp: stamp,
      typescript_version: this.ts.version,
      config_hash: impactConfigHash(request.impact),
      runtime: `${process.versions.bun === undefined ? 'node' : 'bun'} ${process.versions.bun ?? process.versions.node}`,
      scan_ms: String(Math.round(phases.scan)),
      listing: census.summary.listing,
      tsconfigs: JSON.stringify(census.summary.tsconfigs),
      tsconfig_bases: JSON.stringify(census.summary.tsconfigBases),
      tsconfig_errors: JSON.stringify([
        ...census.summary.tsconfigErrors,
        ...(programs?.errors ?? []),
      ]),
      programs: String(outcome.programs),
      ...(programs === null ? {} : { program_split: JSON.stringify(splitBy(programs.groups)) }),
      resolved_last: String(outcome.resolvedFiles),
      phases: JSON.stringify(roundPhases(phases)),
      // Peak of the engine process so far. maxRSS is in kilobytes (libuv converts macOS's bytes);
      // shortcut: Bun's unit on macOS is not verified, check it in the macOS run.
      peak_rss_mb: String(Math.round(process.resourceUsage().maxRSS / 1024)),
    });
    publishBuild(db, this.cacheDir);
    if (programs !== null) rmSync(join(this.cacheDir, FAILURE_FILE), { force: true });
    phases.publish = performance.now() - started;
    return { ...outcome, census: census.summary, counts, problems, phases: roundPhases(phases) };
  }

  private unchanged(census: Census, phases: PhaseTimes): IndexReport {
    return {
      action: 'unchanged',
      reason: 'no drift',
      census: census.summary,
      drift: { added: 0, changed: 0, deleted: 0 },
      resolvedFiles: 0,
      programs: 0,
      counts: emptyCounts(),
      problems: [],
      phases: roundPhases(phases),
    };
  }
}
