import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { engineVersion } from '../engine/typescript.js';
import { Graph } from '../graph/graph.js';
import { repositoryLimits } from '../graph/limits.js';
import { MODULE_NAME } from '../indexing/declarations.js';
import type { PackageInfo } from '../indexing/packages.js';
import { isTestFile } from '../indexing/resolve.js';
import type { ImpactConfig } from '../kernel/config.js';
import { matchAny, matchGlob } from '../kernel/glob.js';
import { isRecord } from '../kernel/guards.js';
import type {
  EdgeKind,
  ImpactLimits,
  ImpactNode,
  ImpactResult,
  Outcome,
  Span,
  Strength,
} from '../kernel/types.js';
import { readMeta, type FileRecord } from '../../storage/sqlite.js';

/** A `path` target: exported declarations used outside the file, plus whole-file `aggregate`. */
export interface FileImpactResult {
  file: string;
  results: ImpactResult[];
  /** Whole-file impact over all declarations and `<module>` combined (F6, F11). */
  aggregate?: ImpactResult;
  /** Other non-module indexed declarations, including exports with no users outside the file. */
  remainder: number;
  limits?: ImpactLimits;
  engine?: ImpactResult['engine'];
  scannedFiles?: number;
}

export type ImpactAnswer = Outcome<ImpactResult | FileImpactResult> & {
  /** The target as the agent wrote it. */
  input: string;
  /** Set when the input was `path:line`. */
  resolvedFromLine?: number;
  /** Set when the input named an unindexed member (D51); the result is for this parent. */
  parentTarget?: string;
};

interface Declaration {
  id: number;
  key: string;
  file: string;
  simple: string;
  kind: string;
  exported: boolean;
  start: number;
  end: number;
  ancestors: readonly string[];
}

interface Gap {
  file: string;
  line: number;
  code: string;
  detail: string;
}

interface Edge {
  source: string;
  kind: EdgeKind;
  strength: Strength;
}

/** G14: the traversal always runs to closure; this budget is the only stop. */
const NODE_BUDGET = 50_000;
const EDGE_KINDS: Record<string, true> = {
  CALLS: true,
  REFERENCES: true,
  CONSTRUCTS: true,
  IMPLEMENTS: true,
};
const STRENGTHS: Record<string, true> = {
  compiler: true,
  'syntax-exact': true,
  'scope-resolved': true,
  heuristic: true,
  unknown: true,
};
// docs/RISK.md §3.2, matched by specifier text (installed or not), subpaths included.
const SQL_MODULES = [
  'pg',
  'postgres',
  'mysql2',
  'better-sqlite3',
  'drizzle-orm',
  '@prisma/client',
  'kysely',
  'knex',
];
// An entry value that names code: a module path with or without a script extension.
const CODE_ENTRY = /(\.([cm]?[jt]sx?)|\/[^./]*)$|^[^.]*$/;
const ANONYMOUS_REASON =
  'outside-index-scope: member of an anonymous object type is not indexed; reads through an alias of the parent type or a generic key may be missing';
const BATCH_BUCKETS = [1, 4, 16, 64, 256, 512, 1024] as const;
const EMPTY_ANCESTORS: readonly string[] = [];
const SQL_SPECIFIER_WHERE = SQL_MODULES.map(
  (name) => `specifier = '${name}' OR (specifier >= '${name}/' AND specifier < '${name}0')`,
).join(' OR ');

/** `file#A.b.c` → `file#A.b`, `file#A`: the declarations that hold a member. */
function ancestors(key: string): string[] {
  const hash = key.indexOf('#');
  if (key.indexOf('.', hash + 1) === -1) return [];
  const parts = key.slice(hash + 1).split('.');
  const out: string[] = [];
  for (let n = parts.length - 1; n > 0; n--)
    out.push(`${key.slice(0, hash + 1)}${parts.slice(0, n).join('.')}`);
  return out;
}

function declaration(row: Record<string, unknown>): Declaration {
  const key = String(row.key);
  const hash = key.indexOf('#');
  return {
    id: Number(row.id),
    key,
    file: String(row.file),
    simple: String(row.simple),
    kind: String(row.kind),
    exported: Number(row.exported) === 1,
    start: Number(row.start_line),
    end: Number(row.end_line),
    ancestors: key.indexOf('.', hash + 1) === -1 ? EMPTY_ANCESTORS : ancestors(key),
  };
}

function packagesOf(raw: string | undefined): PackageInfo[] {
  const parsed: unknown = JSON.parse(raw ?? '[]');
  if (!Array.isArray(parsed)) throw new Error('index meta.packages is not a list');
  return parsed.filter(
    (item): item is PackageInfo =>
      isRecord(item) &&
      typeof item.dir === 'string' &&
      typeof item.private === 'boolean' &&
      Array.isArray(item.entries) &&
      Array.isArray(item.unresolved),
  );
}

/**
 * `ei_impact` answers over one published index (DESIGN §6.2, golden "Result contract"). Pure reads:
 * no TypeScript program, no source or manifest file is opened. The caller owns `db`.
 */
export class ImpactQuery {
  /** Prefix-less `import(x)`/`require(x)` sites: scoped per D55 to files nothing imports statically. */
  private readonly noImporter: Gap[] = [];
  /** Unmatched alias/package prefixes retain their pre-D55 conservative export scope. */
  private readonly unmatchedPrefix: Gap[] = [];
  private readonly graph: Graph;
  private readonly meta: Record<string, string>;
  private readonly engine: ImpactResult['engine'];
  private readonly freshness: ImpactResult['freshness'];
  private readonly packageOf = new Map<string, string | null>();
  // Gap sites by how golden P4 scopes them.
  private readonly everywhere: Gap[] = [];
  private readonly byPrefix: Gap[] = [];
  private readonly byFile = new Map<string, Gap[]>();
  private readonly byInterface = new Map<string, Gap[]>();
  private readonly byOwner = new Map<string, Gap[]>();
  private readonly unresolvedByName = new Map<string, Gap[]>();
  private readonly publicEntryFiles = new Set<string>();
  private readonly publicEntryGlobs: string[] = [];
  private readonly publicEntryFileCache = new Map<string, boolean>();
  private readonly publicKeyCache = new Map<string, boolean>();
  private readonly openPackages: string[] = [];
  private readonly indexableFiles = new Set<string>();
  private readonly indexableList: string[] = [];
  private readonly staticImportedCache = new Map<string, boolean>();
  /** Entry files of workspace packages: loaded directly, never "unimported" (D55). */
  private readonly entryFiles = new Set<string>();
  private readonly limits: ImpactLimits;
  private readonly scannedFiles: number;
  private readonly nodeBudget: number;
  private readonly markers = new Map<string, Set<string>>();
  private readonly sqlFiles = new Set<string>();
  private readonly boundaryCache = new Map<string, string[]>();
  private readonly implementsCache = new Map<string, string[]>();
  private readonly implementedIdsCache = new Map<number, readonly number[]>();
  private readonly incomingCache = new Map<string, Edge[]>();
  private readonly incomingFetchedIds = new Set<number>();
  private readonly checkedContainerKeys = new Set<string>();
  private readonly containerKeyToId = new Map<string, number>();
  private readonly declByKey = new Map<string, Declaration | null>();
  private readonly declById = new Map<number, Declaration>();
  private readonly containerByKeyStmts = new Map<number, StatementSync>();
  private readonly declByKeyStmts = new Map<number, StatementSync>();
  private readonly declByIdStmts = new Map<number, StatementSync>();
  private readonly incomingByIdStmts = new Map<number, StatementSync>();
  private implementsById: Map<number, number[]> | null = null;
  private globalGapsLoaded = false;
  private boundarySourcesLoaded = false;
  private hasComputedGaps: boolean | null = null;
  private readonly statements: Record<
    | 'declaration'
    | 'incoming'
    | 'implements'
    | 'gapByCodeDetail'
    | 'unresolvedByName'
    | 'staticMarker'
    | 'tokens'
    | 'nameCount'
    | 'census'
    | 'lines'
    | 'fileDecls'
    | 'outsideUser'
    | 'tests'
    | 'reexports',
    StatementSync
  >;

  constructor(
    private readonly db: DatabaseSync,
    private readonly impact: ImpactConfig,
    options: {
      nodeBudget?: number;
      files?: readonly Pick<FileRecord, 'path' | 'hash' | 'package' | 'status'>[];
      meta?: Record<string, string>;
    } = {},
  ) {
    this.nodeBudget = options.nodeBudget ?? NODE_BUDGET;
    this.graph = new Graph(db);
    this.meta = options.meta ?? readMeta(db);
    this.engine = {
      version: engineVersion(),
      typescript: this.meta.typescript_version ?? 'unknown',
      extractor: this.meta.extractor_stamp ?? 'unknown',
    };
    this.statements = {
      declaration: db.prepare(
        'SELECT d.id, s.key, d.file, d.simple, d.kind, d.exported, d.start_line, d.end_line FROM symbols s JOIN declarations d ON d.id = s.id WHERE s.key = ?',
      ),
      incoming: db.prepare(
        `SELECT s.key AS source, e.kind, e.strength FROM edges e JOIN symbols t ON t.id = e.target
         JOIN symbols s ON s.id = e.source WHERE t.key = ? AND e.kind NOT IN ('IMPORTS', 'TESTS')
         ORDER BY s.key, e.kind`,
      ),
      implements: db.prepare(
        `SELECT t.key FROM edges e JOIN symbols s ON s.id = e.source JOIN symbols t ON t.id = e.target
         WHERE s.key = ? AND e.kind = 'IMPLEMENTS'`,
      ),
      gapByCodeDetail: db.prepare(
        'SELECT file, line, code, detail FROM gap_sites WHERE code = ? AND detail = ? ORDER BY file, line, code, detail',
      ),
      unresolvedByName: db.prepare(
        'SELECT file, line, name, reason FROM unresolved WHERE name = ? ORDER BY file, line, name',
      ),
      staticMarker: db.prepare('SELECT 1 FROM markers WHERE kind = ? LIMIT 1'),
      tokens: db.prepare(
        "SELECT file, lines FROM name_tokens WHERE name = ? AND kind = 'str' ORDER BY file",
      ),
      nameCount: db.prepare(
        "SELECT COUNT(*) AS n FROM declarations WHERE simple = ? AND name != '<module>'",
      ),
      census: db.prepare('SELECT status, reason FROM files WHERE path = ?'),
      lines: db.prepare('SELECT lines FROM file_index WHERE file = ?'),
      fileDecls: db.prepare(
        `SELECT d.id, s.key, d.file, d.simple, d.kind, d.exported, d.start_line, d.end_line FROM declarations d
         JOIN symbols s ON s.id = d.id WHERE d.file = ? AND d.name != '<module>' ORDER BY s.key`,
      ),
      outsideUser: db.prepare(
        `SELECT 1 FROM edges e JOIN symbols t ON t.id = e.target JOIN declarations d ON d.id = e.source
         WHERE t.key = ? AND d.file != ? AND e.kind NOT IN ('IMPORTS', 'TESTS') LIMIT 1`,
      ),
      tests: db.prepare(
        `SELECT DISTINCT d.file FROM edges e JOIN symbols t ON t.id = e.target
         JOIN declarations d ON d.id = e.source WHERE t.key = ? AND e.kind = 'TESTS' ORDER BY d.file`,
      ),
      reexports: db.prepare('SELECT file FROM exports WHERE target = ?'),
    };

    const hash = createHash('sha256');
    const fileRows =
      options.files ??
      db.prepare('SELECT path, hash, package, status FROM files ORDER BY path').all();
    for (const row of fileRows) {
      const path = String(row.path);
      hash.update(`${path}\0${String(row.hash)}\n`);
      this.packageOf.set(path, row.package === null ? null : String(row.package));
      if (row.status === 'indexable') {
        this.indexableList.push(path);
        this.indexableFiles.add(path);
      }
    }
    // The census lists git's tracked and untracked files, or walks the tree: untracked files are in.
    this.freshness = {
      workingTreeHash: hash.digest('hex'),
      includesUntracked: this.meta.listing === 'git' || this.meta.listing === 'walk',
    };

    const packages = packagesOf(this.meta.packages);
    for (const pkg of packages) {
      for (const entry of pkg.entries) {
        this.entryFiles.add(entry);
        if (!pkg.private) this.publicEntryFiles.add(entry);
      }
      if (pkg.private) continue;
      for (const value of pkg.unresolved) {
        if (value.includes('*')) {
          this.publicEntryGlobs.push(posix.join(pkg.dir, value));
        } else if (CODE_ENTRY.test(value)) {
          // Build output the index does not hold: which exports it re-exports is unknown.
          this.openPackages.push(pkg.dir === '.' ? '' : `${pkg.dir}/`);
        }
      }
    }
    this.limits = repositoryLimits(db);
    this.scannedFiles = this.packageOf.size;
  }

  private hasIndexablePrefix(prefix: string): boolean {
    if (prefix === '') return this.indexableList.length > 0;
    let lo = 0;
    let hi = this.indexableList.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const candidate = this.indexableList[mid]!;
      if (candidate.startsWith(prefix)) return true;
      if (candidate < prefix) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  private ensureGlobalGaps(): void {
    if (this.globalGapsLoaded) return;
    this.globalGapsLoaded = true;
    const codes = this.db
      .prepare('SELECT DISTINCT code FROM gap_sites')
      .all()
      .map((row) => String(row.code))
      .filter((code) => code !== 'interface-dispatch' && code !== 'computed-member-access');
    if (codes.length === 0) return;
    const placeholders = codes.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT file, line, code, detail FROM gap_sites
         WHERE code IN (${placeholders}) ORDER BY file, line, code, detail`,
      )
      .all(...codes);
    for (const row of rows) {
      const gap: Gap = {
        file: String(row.file),
        line: Number(row.line),
        code: String(row.code),
        detail: String(row.detail),
      };
      this.classifyGlobalGap(gap);
    }
  }

  private classifyGlobalGap(gap: Gap): void {
    const push = (map: Map<string, Gap[]>, key: string): void => {
      const list = map.get(key) ?? [];
      list.push(gap);
      map.set(key, list);
    };
    const prefix = gap.detail === './' ? '' : gap.detail;
    switch (gap.code) {
      case 'parse-error':
      case 'unsupported-syntax':
        this.everywhere.push(gap);
        return;
      case 'dynamic-import':
        if (gap.detail === '*') this.noImporter.push(gap);
        else if (this.hasIndexablePrefix(prefix)) this.byPrefix.push(gap);
        else this.unmatchedPrefix.push(gap);
        return;
      case 'cjs-require':
        if (gap.detail === '*') this.noImporter.push(gap);
        else if (this.indexableFiles.has(gap.detail)) push(this.byFile, gap.detail);
        else if (this.hasIndexablePrefix(prefix)) this.byPrefix.push(gap);
        else push(this.byFile, gap.detail); // External package names scope no indexed file.
        return;
      default:
        // An unknown code is still a gap; never let it vanish.
        this.everywhere.push(gap);
    }
  }

  private interfaceGaps(detail: string): readonly Gap[] {
    let list = this.byInterface.get(detail);
    if (list === undefined) {
      list = this.statements.gapByCodeDetail.all('interface-dispatch', detail).map((row) => ({
        file: String(row.file),
        line: Number(row.line),
        code: String(row.code),
        detail: String(row.detail),
      }));
      this.byInterface.set(detail, list);
    }
    return list;
  }

  private hasComputedMemberGaps(): boolean {
    if (this.hasComputedGaps === null) {
      const row = this.db
        .prepare("SELECT 1 FROM gap_sites WHERE code = 'computed-member-access' LIMIT 1")
        .get();
      this.hasComputedGaps = row !== undefined;
    }
    return this.hasComputedGaps;
  }

  private ownerGaps(detail: string): readonly Gap[] {
    let list = this.byOwner.get(detail);
    if (list === undefined) {
      list = this.statements.gapByCodeDetail.all('computed-member-access', detail).map((row) => ({
        file: String(row.file),
        line: Number(row.line),
        code: String(row.code),
        detail: String(row.detail),
      }));
      this.byOwner.set(detail, list);
    }
    return list;
  }

  private unresolvedOf(name: string): readonly Gap[] {
    let list = this.unresolvedByName.get(name);
    if (list === undefined) {
      list = this.statements.unresolvedByName.all(name).map((row) => ({
        file: String(row.file),
        line: Number(row.line),
        code: String(row.reason),
        detail: String(row.name),
      }));
      this.unresolvedByName.set(name, list);
    }
    return list;
  }

  private isStaticImported(file: string): boolean {
    let result = this.staticImportedCache.get(file);
    if (result === undefined) {
      result = this.statements.staticMarker.get(`static-import:${file}`) !== undefined;
      this.staticImportedCache.set(file, result);
    }
    return result;
  }

  /** golden P2: what is reachable from the entry of a workspace package that is not private. */
  private isPublicEntryFile(file: string): boolean {
    if (this.publicEntryFiles.has(file)) return true;
    let cached = this.publicEntryFileCache.get(file);
    if (cached === undefined) {
      cached =
        this.indexableFiles.has(file) &&
        this.publicEntryGlobs.some((glob) => matchGlob(glob, file));
      this.publicEntryFileCache.set(file, cached);
    }
    return cached;
  }

  private isPublicKey(key: string): boolean {
    let cached = this.publicKeyCache.get(key);
    if (cached === undefined) {
      cached = this.statements.reexports
        .all(key)
        .some((row) => this.isPublicEntryFile(String(row.file)));
      this.publicKeyCache.set(key, cached);
    }
    return cached;
  }

  private isPublic(decl: Declaration): boolean {
    if (this.isPublicKey(decl.key) || decl.ancestors.some((key) => this.isPublicKey(key)))
      return true;
    return decl.exported && this.openPackages.some((dir) => decl.file.startsWith(dir));
  }

  /**
   * Keys of object-literal holders: a module-level `const` or a property that ADR 0003 indexes
   * members under (kind `variable`/`property` with dotted children). Classes, interfaces, enums
   * and namespaces hold members too, but a use of the whole container does not read a member's
   * value, so they are not containers in the D55 sense.
   */
  private isContainer(parentKey: string): boolean {
    if (this.checkedContainerKeys.has(parentKey)) return this.containerKeyToId.has(parentKey);
    const decl = this.get(parentKey);
    const result = decl !== undefined && (decl.kind === 'variable' || decl.kind === 'property');
    this.checkedContainerKeys.add(parentKey);
    if (result && decl !== undefined) this.containerKeyToId.set(parentKey, decl.id);
    return result;
  }

  private preloadContainersByKeys(keys: readonly string[]): void {
    const missing: string[] = [];
    for (const key of keys) {
      if (this.checkedContainerKeys.has(key)) continue;
      const existing = this.declByKey.get(key);
      if (existing !== undefined) {
        this.checkedContainerKeys.add(key);
        if (existing !== null && (existing.kind === 'variable' || existing.kind === 'property')) {
          this.containerKeyToId.set(key, existing.id);
        }
        continue;
      }
      this.checkedContainerKeys.add(key);
      missing.push(key);
    }
    if (missing.length === 0) return;
    this.runBucketed(
      missing,
      this.containerByKeyStmts,
      (ph) =>
        `SELECT d.id, s.key, d.file, d.simple, d.kind, d.exported, d.start_line, d.end_line
         FROM symbols s JOIN declarations d ON d.id = s.id
         WHERE s.key IN (${ph}) AND d.kind IN ('variable', 'property')`,
      (row) => {
        const decl = declaration(row);
        this.declByKey.set(decl.key, decl);
        this.declById.set(decl.id, decl);
        this.containerKeyToId.set(decl.key, decl.id);
      },
    );
  }

  private get(key: string): Declaration | undefined {
    const cached = this.declByKey.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const row = this.statements.declaration.get(key);
    if (row === undefined) {
      this.declByKey.set(key, null);
      return undefined;
    }
    const decl = declaration(row);
    this.declByKey.set(decl.key, decl);
    this.declById.set(decl.id, decl);
    return decl;
  }

  private runBucketed<T extends string | number>(
    items: readonly T[],
    cache: Map<number, StatementSync>,
    sqlForCount: (placeholders: string) => string,
    onRow: (row: Record<string, unknown>) => void,
  ): void {
    let i = 0;
    while (i < items.length) {
      const remaining = items.length - i;
      const bucket =
        BATCH_BUCKETS.find((size) => size >= remaining) ?? BATCH_BUCKETS[BATCH_BUCKETS.length - 1]!;
      const take = Math.min(remaining, bucket);
      const args: T[] = items.slice(i, i + take);
      const pad = args[args.length - 1]!;
      while (args.length < bucket) args.push(pad);
      let stmt = cache.get(bucket);
      if (stmt === undefined) {
        stmt = this.db.prepare(sqlForCount(Array<string>(bucket).fill('?').join(',')));
        cache.set(bucket, stmt);
      }
      for (const row of stmt.all(...args)) onRow(row);
      i += take;
    }
  }

  private preloadDeclarationsByKeys(keys: readonly string[]): void {
    let missing: string[] | undefined;
    let seen: Set<string> | undefined;
    for (const key of keys) {
      if (!this.declByKey.has(key)) {
        seen ??= new Set<string>();
        if (!seen.has(key)) {
          seen.add(key);
          missing ??= [];
          missing.push(key);
        }
      }
    }
    if (missing === undefined) return;
    this.runBucketed(
      missing,
      this.declByKeyStmts,
      (ph) =>
        `SELECT d.id, s.key, d.file, d.simple, d.kind, d.exported, d.start_line, d.end_line
         FROM symbols s JOIN declarations d ON d.id = s.id WHERE s.key IN (${ph})`,
      (row) => {
        const decl = declaration(row);
        this.declByKey.set(decl.key, decl);
        this.declById.set(decl.id, decl);
      },
    );
    for (const key of missing) {
      if (!this.declByKey.has(key)) this.declByKey.set(key, null);
    }
  }

  private preloadDeclarationsByIds(ids: readonly number[]): void {
    if (ids.length === 0) return;
    this.runBucketed(
      ids,
      this.declByIdStmts,
      (ph) =>
        `SELECT d.id, s.key, d.file, d.simple, d.kind, d.exported, d.start_line, d.end_line
         FROM declarations d JOIN symbols s ON s.id = d.id WHERE d.id IN (${ph})`,
      (row) => {
        const decl = declaration(row);
        this.declById.set(decl.id, decl);
        this.declByKey.set(decl.key, decl);
      },
    );
  }

  private ensureImplementsGraph(): Map<number, number[]> {
    if (this.implementsById === null) {
      this.implementsById = new Map<number, number[]>();
      for (const row of this.db
        .prepare("SELECT source, target FROM edges WHERE kind = 'IMPLEMENTS'")
        .all()) {
        const source = Number(row.source);
        const target = Number(row.target);
        const list = this.implementsById.get(source);
        if (list === undefined) this.implementsById.set(source, [target]);
        else list.push(target);
      }
    }
    return this.implementsById;
  }

  private implementedTargetIds(id: number): readonly number[] {
    let cached = this.implementedIdsCache.get(id);
    if (cached !== undefined) return cached;
    const implGraph = this.ensureImplementsGraph();
    if (!implGraph.has(id)) {
      cached = [];
      this.implementedIdsCache.set(id, cached);
      return cached;
    }
    const seen = new Set<number>([id]);
    const targets: number[] = [];
    for (const next of implGraph.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        targets.push(next);
      }
    }
    for (let i = 0; i < targets.length; i++) {
      for (const next of implGraph.get(targets[i]!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          targets.push(next);
        }
      }
    }
    this.implementedIdsCache.set(id, targets);
    return targets;
  }

  private preloadFrontier(
    frontier: readonly string[],
    heuristic: boolean,
    exactOrder: boolean,
  ): void {
    this.preloadDeclarationsByKeys(frontier);
    const ancestorKeys: string[] = [];
    for (const key of frontier) {
      const decl = this.declByKey.get(key);
      if (decl !== null && decl !== undefined && decl.ancestors.length > 0) {
        for (const parent of decl.ancestors) {
          if (!this.checkedContainerKeys.has(parent)) ancestorKeys.push(parent);
        }
      }
    }
    if (ancestorKeys.length > 0) this.preloadContainersByKeys(ancestorKeys);

    const targetIds: number[] = [];
    const targetIdSet = new Set<number>();
    const addTargetId = (id: number): void => {
      if (!this.incomingFetchedIds.has(id) && !targetIdSet.has(id)) {
        targetIdSet.add(id);
        targetIds.push(id);
      }
    };

    const implTargetsToLoad: number[] = [];
    const implLoadSet = new Set<number>();

    for (const key of frontier) {
      const decl = this.declByKey.get(key);
      if (decl === null || decl === undefined) continue;
      addTargetId(decl.id);
      if (heuristic) {
        for (const implId of this.implementedTargetIds(decl.id)) {
          if (!this.declById.has(implId) && !implLoadSet.has(implId)) {
            implLoadSet.add(implId);
            implTargetsToLoad.push(implId);
          }
          addTargetId(implId);
        }
      }
      for (const parent of decl.ancestors) {
        const containerId = this.containerKeyToId.get(parent);
        if (containerId !== undefined) addTargetId(containerId);
      }
    }

    if (implTargetsToLoad.length > 0) this.preloadDeclarationsByIds(implTargetsToLoad);
    if (targetIds.length === 0) return;

    const rawByTarget = new Map<
      number,
      { source: string; sourceId: number; kind: EdgeKind; strength: Strength }[]
    >();
    for (const id of targetIds) {
      this.incomingFetchedIds.add(id);
      rawByTarget.set(id, []);
    }
    const sourceIds: number[] = [];
    const sourceIdSet = new Set<number>();
    this.runBucketed(
      targetIds,
      this.incomingByIdStmts,
      (ph) =>
        `SELECT target, source, kind, strength FROM edges
         WHERE target IN (${ph}) AND kind NOT IN ('IMPORTS', 'TESTS')`,
      (row) => {
        const targetId = Number(row.target);
        const sourceId = Number(row.source);
        const kind = String(row.kind);
        const strength = String(row.strength);
        if (!Object.hasOwn(EDGE_KINDS, kind) || !Object.hasOwn(STRENGTHS, strength)) {
          const targetKey = this.declById.get(targetId)?.key ?? String(targetId);
          throw new Error(`index edge into ${targetKey} has kind ${kind}, strength ${strength}`);
        }
        if (!this.declById.has(sourceId) && !sourceIdSet.has(sourceId)) {
          sourceIdSet.add(sourceId);
          sourceIds.push(sourceId);
        }
        rawByTarget.get(targetId)?.push({
          source: '',
          sourceId,
          kind: kind as EdgeKind,
          strength: strength as Strength,
        });
      },
    );

    if (sourceIds.length > 0) this.preloadDeclarationsByIds(sourceIds);

    for (const [targetId, rawEdges] of rawByTarget) {
      const targetDecl = this.declById.get(targetId);
      if (targetDecl === undefined) continue;
      for (const raw of rawEdges) {
        raw.source = this.declById.get(raw.sourceId)!.key;
      }
      if (rawEdges.length > 1) {
        if (exactOrder) {
          rawEdges.sort((a, b) =>
            a.source < b.source
              ? -1
              : a.source > b.source
                ? 1
                : a.kind < b.kind
                  ? -1
                  : a.kind > b.kind
                    ? 1
                    : 0,
          );
        } else {
          rawEdges.sort(
            (a, b) => a.sourceId - b.sourceId || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
          );
        }
      }
      this.incomingCache.set(targetDecl.key, rawEdges);
    }
  }

  private incoming(key: string): Edge[] {
    let edges = this.incomingCache.get(key);
    if (edges === undefined) {
      edges = [];
      for (const row of this.statements.incoming.all(key)) {
        const kind = String(row.kind);
        const strength = String(row.strength);
        if (!Object.hasOwn(EDGE_KINDS, kind) || !Object.hasOwn(STRENGTHS, strength)) {
          throw new Error(`index edge into ${key} has kind ${kind}, strength ${strength}`);
        }
        edges.push({
          source: String(row.source),
          kind: kind as EdgeKind,
          strength: strength as Strength,
        });
      }
      this.incomingCache.set(key, edges);
    }
    return edges;
  }

  /**
   * Gaps that hide users of `decl` itself: `computed-member-access`, `interface-dispatch` and
   * `dynamic-import`/`cjs-require` in scope. Not name matches and not repository-wide gaps (R2, D56).
   */
  private userHidingGaps(decl: Declaration): Gap[] {
    this.ensureGlobalGaps();
    const found: Gap[] = [];
    if (decl.exported || decl.kind === 'module') {
      found.push(...this.unmatchedPrefix);
      for (const gap of this.byPrefix) {
        const prefix = gap.detail === './' ? '' : gap.detail;
        if (decl.file.startsWith(prefix)) found.push(gap);
      }
      // D55: a prefix-less import can load any module nothing else loads; package entries and
      // test files are loaded directly or by a runner, so they are out of this scope.
      if (
        this.noImporter.length > 0 &&
        !isTestFile(decl.file) &&
        !this.entryFiles.has(decl.file) &&
        !this.isStaticImported(decl.file)
      ) {
        found.push(...this.noImporter);
      }
    }
    found.push(...(this.byFile.get(decl.file) ?? []));
    for (const targetKey of this.implementedTargets(decl.key)) {
      found.push(...this.interfaceGaps(targetKey));
    }
    if (this.hasComputedMemberGaps()) {
      // A computed access on an object reads its members and the values stored in them,
      // and a namespace computed access (`ns[k]`) reads every export and re-export of that module.
      const owners = new Set([decl.key, ...ancestors(decl.key)]);
      if (decl.exported || ancestors(decl.key).some((key) => this.get(key)?.exported)) {
        owners.add(`${decl.file}#${MODULE_NAME}`);
      }
      for (const row of this.statements.reexports.all(decl.key)) {
        owners.add(`${String(row.file)}#${MODULE_NAME}`);
      }
      for (const edge of this.incoming(decl.key)) {
        if (edge.kind !== 'REFERENCES') continue;
        owners.add(edge.source);
        for (const key of ancestors(edge.source)) owners.add(key);
      }
      for (const owner of owners) found.push(...this.ownerGaps(owner));
    }
    return found;
  }

  /**
   * Gap sites and unresolved records whose scope covers `decl` (golden P4).
   * When `decl.simple` is shared by more than `impact.commonName` declarations and has name-match
   * sites, those sites become the `common-name` factor instead of completeness reasons (D56, G15).
   */
  private gapsOf(decl: Declaration): { gaps: Gap[]; commonNameBasis: string | null } {
    this.ensureGlobalGaps();
    const found: Gap[] = [...this.everywhere, ...this.userHidingGaps(decl)];
    const unresolved = this.unresolvedOf(decl.simple);
    const unresolvedImports = unresolved.filter((gap) => gap.code === 'unresolved-import');
    const untypedUses = unresolved.filter((gap) => gap.code === 'unresolved-name-match');

    const stringMatches: Gap[] = [];
    for (const row of this.statements.tokens.all(decl.simple)) {
      const lines: unknown = JSON.parse(String(row.lines));
      if (!Array.isArray(lines)) continue;
      for (const line of lines) {
        stringMatches.push({
          file: String(row.file),
          line: Number(line),
          code: 'string-name-match',
          detail: decl.simple,
        });
      }
    }

    const nameMatches = unresolvedImports.length + untypedUses.length;
    if (nameMatches + stringMatches.length > 0) {
      const shared = Number(this.statements.nameCount.get(decl.simple)?.n ?? 0);
      if (shared > (this.impact.commonName ?? 10)) {
        return {
          gaps: found,
          commonNameBasis: `common-name: ${shared.toLocaleString('en-US')} declarations named "${decl.simple}"; ${nameMatches.toLocaleString('en-US')} untyped uses, ${stringMatches.length.toLocaleString('en-US')} equal strings not attributed`,
        };
      }
      found.push(...unresolvedImports, ...untypedUses, ...stringMatches);
    }
    return { gaps: found, commonNameBasis: null };
  }

  private ensureBoundarySources(): void {
    if (this.boundarySourcesLoaded) return;
    this.boundarySourcesLoaded = true;
    for (const row of this.db
      .prepare(
        "SELECT file, kind FROM markers WHERE kind < 'static-import:' OR kind >= 'static-import;'",
      )
      .all()) {
      const file = String(row.file);
      const kinds = this.markers.get(file) ?? new Set<string>();
      kinds.add(String(row.kind));
      this.markers.set(file, kinds);
    }
    for (const row of this.db
      .prepare(`SELECT DISTINCT file FROM external_imports WHERE ${SQL_SPECIFIER_WHERE}`)
      .all()) {
      this.sqlFiles.add(String(row.file));
    }
  }

  private boundaries(file: string): string[] {
    let found = this.boundaryCache.get(file);
    if (found === undefined) {
      this.ensureBoundarySources();
      const kinds = new Set(this.markers.get(file) ?? []);
      if (this.sqlFiles.has(file)) kinds.add('boundary:sql');
      if (/(^|\/)(android|ios)\//.test(file)) kinds.add('boundary:native');
      found = [...kinds].sort();
      this.boundaryCache.set(file, found);
    }
    return found;
  }

  query(target: string, depth = 2): ImpactAnswer {
    if (
      typeof target !== 'string' ||
      target.trim() === '' ||
      !Number.isInteger(depth) ||
      depth < 1 ||
      depth > 10
    ) {
      return {
        input: String(target),
        kind: 'failure',
        code: 'INVALID_INPUT',
        message: 'a target is a non-empty string; depth is 1–10',
      };
    }
    const asked = target.trim();
    const atLine = /^(.+):(\d+)$/.exec(asked);
    const file = atLine?.[1] ?? (asked.includes('#') ? asked.slice(0, asked.indexOf('#')) : asked);
    const census = this.statements.census.get(file);
    if (census !== undefined && census.status !== 'indexable') {
      return {
        input: asked,
        kind: 'guidance',
        code: 'target-not-found',
        message: `NOT INDEXED ${file} — ${String(census.reason ?? census.status)}`,
      };
    }
    if (census !== undefined && atLine === null && !asked.includes('#'))
      return this.fileAnswer(asked, depth);
    if (atLine !== null) {
      const lines = this.statements.lines.get(file);
      const n = Number(atLine[2]);
      if (lines === undefined || n < 1 || n > Number(lines.lines)) {
        return {
          input: asked,
          kind: 'guidance',
          code: 'target-not-found',
          message: `NOT FOUND ${asked}: no such line in an indexed file`,
          nearest: [],
        };
      }
    }
    let match = this.graph.symbol(asked);
    let parentTarget: string | undefined;
    // D51: a member of an anonymous object type or an object literal deeper than ADR 0003's
    // 3-level limit answers for its nearest indexed parent (property or variable).
    if (
      match.kind === 'not-found' &&
      atLine === null &&
      (asked.includes('#') || !asked.includes('/'))
    ) {
      for (let parent = asked; parent.includes('.') && parentTarget === undefined;) {
        parent = parent.slice(0, parent.lastIndexOf('.'));
        const found = this.graph.symbol(parent);
        if (found.kind === 'found') {
          const kind = this.get(found.key)?.kind;
          if (kind === 'property' || kind === 'variable') {
            match = found;
            parentTarget = found.key;
          }
        } else if (found.kind === 'ambiguous') {
          const matching = found.candidates.filter((key) => {
            const kind = this.get(key)?.kind;
            return kind === 'property' || kind === 'variable';
          });
          if (matching.length === 1) {
            match = { kind: 'found', key: matching[0]! };
            parentTarget = matching[0]!;
          } else if (matching.length > 1) {
            match = { kind: 'ambiguous', candidates: matching };
            break;
          }
        }
      }
    }
    if (match.kind === 'ambiguous') {
      return {
        input: asked,
        kind: 'guidance',
        code: 'ambiguous-target',
        message: `AMBIGUOUS ${asked} — ${match.candidates.length} declarations`,
        candidates: [...match.candidates].sort(),
      };
    }
    if (match.kind === 'not-found') {
      return {
        input: asked,
        kind: 'guidance',
        code: 'target-not-found',
        message: `NOT FOUND ${asked}`,
        nearest: match.nearest.slice(0, 5),
      };
    }
    return {
      input: asked,
      kind: 'result',
      value: this.impactOf(match.key, depth, parentTarget !== undefined),
      ...(atLine === null ? {} : { resolvedFromLine: Number(atLine[2]) }),
      ...(parentTarget === undefined ? {} : { parentTarget }),
    };
  }

  /** Up to five targets; one ambiguous or missing target does not block the others. */
  batch(targets: readonly string[], depth = 2): ImpactAnswer[] {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 5) {
      return [{ input: '', kind: 'failure', code: 'INVALID_INPUT', message: 'give 1–5 targets' }];
    }
    return targets.map((target) => this.query(target, depth));
  }

  private fileAnswer(file: string, depth: number): ImpactAnswer {
    const declarations = this.statements.fileDecls.all(file).map((row) => {
      const decl = declaration(row);
      this.declByKey.set(decl.key, decl);
      this.declById.set(decl.id, decl);
      return decl;
    });
    const moduleDecl = this.get(`${file}#${MODULE_NAME}`);
    const allDecls = moduleDecl !== undefined ? [...declarations, moduleDecl] : declarations;
    const used = declarations.filter(
      (decl) => decl.exported && this.statements.outsideUser.get(decl.key, file) !== undefined,
    );
    const span: Span = {
      file,
      startLine: 1,
      endLine: Math.max(1, ...allDecls.map((decl) => decl.end)),
    };
    return {
      input: file,
      kind: 'result',
      value: {
        file,
        results: used.map((decl) => this.impactOf(decl.key, depth, false)),
        aggregate: this.buildImpact(allDecls, `${file}#${MODULE_NAME}`, span, depth, false),
        remainder: declarations.length - used.length,
        limits: { ...this.limits },
        engine: { ...this.engine },
        scannedFiles: this.scannedFiles,
      },
    };
  }

  /**
   * Breadth first over incoming edges to closure: each symbol once at its shallowest depth,
   * stopped only by the node budget (G14); `depth` limits listing elsewhere. `heuristic` adds
   * the callers of interface members the symbol implements (golden C06).
   */
  private traverse(
    key: string | readonly string[],
    heuristic: boolean,
    preloaded = false,
    displayDepth = 10,
  ): { levels: { key: string; edge: Edge }[][]; capped: boolean } {
    const seeds = typeof key === 'string' ? [key] : key;
    const seen = new Set(seeds);
    const levels: { key: string; edge: Edge }[][] = [];
    let frontier = [...seeds];
    let capped = false;
    while (frontier.length > 0) {
      const exactOrder = levels.length < displayDepth || this.nodeBudget <= 20_000;
      if (!preloaded) this.preloadFrontier(frontier, heuristic, exactOrder);
      const level: { key: string; edge: Edge }[] = [];
      for (const current of frontier) {
        for (const edge of this.dependentsOf(current, heuristic)) {
          if (!heuristic && (edge.strength === 'heuristic' || edge.strength === 'unknown'))
            continue;
          if (seen.has(edge.source)) continue;
          if (seen.size >= this.nodeBudget) {
            capped = true;
            continue;
          }
          seen.add(edge.source);
          level.push({ key: edge.source, edge });
        }
      }
      if (level.length === 0) break;
      if (exactOrder) {
        level.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      }
      levels.push(level);
      frontier = level.map((item) => item.key);
    }
    return { levels, capped };
  }

  /**
   * Who depends on `key`: its incoming edges, plus the whole-value users of each enclosing
   * object literal (spread, passed, returned, assigned — D55; that is reach, not a gap).
   * `heuristic` adds the callers of interface members the symbol implements.
   */
  private dependentsOf(key: string, heuristic: boolean): readonly Edge[] {
    const direct = this.incoming(key);
    const decl = this.declByKey.get(key);
    const parentKeys = decl !== null && decl !== undefined ? decl.ancestors : ancestors(key);
    const implTargets = heuristic ? this.implementedTargets(key) : EMPTY_ANCESTORS;
    if (parentKeys.length === 0 && implTargets.length === 0) return direct;
    const edges = [...direct];
    for (const parent of parentKeys) {
      if (!this.isContainer(parent)) continue;
      edges.push(...this.incoming(parent));
    }
    for (const targetKey of implTargets) {
      for (const edge of this.incoming(targetKey)) {
        if (edge.kind === 'CALLS') edges.push({ ...edge, strength: 'heuristic' });
      }
    }
    return edges;
  }

  /** Transitive `IMPLEMENTS` targets (interfaces / base members), guarded against cycles. */
  private implementedTargets(key: string): string[] {
    const cached = this.implementsCache.get(key);
    if (cached !== undefined) return cached;
    const decl = this.get(key);
    if (decl !== undefined) {
      const targetIds = this.implementedTargetIds(decl.id);
      if (targetIds.length === 0) {
        const empty: string[] = [];
        this.implementsCache.set(key, empty);
        return empty;
      }
      const missingIds = targetIds.filter((id) => !this.declById.has(id));
      if (missingIds.length > 0) this.preloadDeclarationsByIds(missingIds);
      const targets = targetIds
        .map((id) => this.declById.get(id)?.key)
        .filter((k): k is string => k !== undefined);
      this.implementsCache.set(key, targets);
      return targets;
    }
    const seen = new Set<string>([key]);
    const targets: string[] = [];
    const enqueue = (from: string): void => {
      for (const row of this.statements.implements.all(from)) {
        const next = String(row.key);
        if (!seen.has(next)) {
          seen.add(next);
          targets.push(next);
        }
      }
    };
    enqueue(key);
    for (let i = 0; i < targets.length; i++) {
      enqueue(targets[i]!);
    }
    this.implementsCache.set(key, targets);
    return targets;
  }

  private impactOf(key: string, depth: number, anonymous: boolean): ImpactResult {
    const target = this.get(key);
    if (target === undefined) throw new Error(`indexed declaration missing: ${key}`);
    return this.buildImpact(
      [target],
      key,
      { file: target.file, startLine: target.start, endLine: target.end },
      depth,
      anonymous,
    );
  }

  private buildImpact(
    targets: readonly Declaration[],
    targetKey: string,
    span: Span,
    depth: number,
    anonymous: boolean,
  ): ImpactResult {
    const keys = targets.map((target) => target.key);
    const listing = this.traverse(keys, true, false, depth);
    // DESIGN §7.2: reach is over compiler-grade edges only, so a path through a heuristic hop is out.
    const compiler = this.traverse(keys, false, !listing.capped, depth);

    const reasons = new Set<string>();
    const commonNameBases: string[] = [];
    for (const target of targets) {
      const { gaps: targetGaps, commonNameBasis } = this.gapsOf(target);
      for (const gap of targetGaps) {
        reasons.add(`${gap.code}: ${gap.file}:${gap.line} — ${gap.detail}`);
      }
      if (commonNameBasis !== null) commonNameBases.push(commonNameBasis);
    }
    if (anonymous) reasons.add(ANONYMOUS_REASON);
    if (listing.capped || compiler.capped)
      reasons.add('depth-limit: node budget reached with callers unvisited');

    const byDepth: ImpactNode[][] = [];
    const listed: Declaration[] = [];
    for (const level of listing.levels) {
      const includeNodes = byDepth.length < depth;
      const nodes: ImpactNode[] = [];
      for (const { key: source, edge } of level) {
        const decl = this.get(source);
        if (decl === undefined) throw new Error(`indexed declaration missing: ${source}`);
        listed.push(decl);
        if (includeNodes) {
          const isRoute = matchAny(this.impact.routes, decl.file);
          const nodeBoundaries = this.boundaries(decl.file);
          nodes.push({
            symbol: source,
            via: edge.kind,
            strength: edge.strength,
            span: { file: decl.file, startLine: decl.start, endLine: decl.end },
            ...(this.userHidingGaps(decl).length > 0 ? { gapScoped: true } : {}),
            ...(isRoute ? { route: true } : {}),
            ...(nodeBoundaries.length > 0 ? { boundaries: nodeBoundaries } : {}),
          });
        }
      }
      if (includeNodes) byDepth.push(nodes);
    }

    let reachedTotal = 0;
    const reachedFiles = new Set<string>();
    for (const level of compiler.levels) {
      reachedTotal += level.length;
      for (const item of level) {
        const file = this.declByKey.get(item.key)?.file ?? item.key.slice(0, item.key.indexOf('#'));
        reachedFiles.add(file);
      }
    }
    const targetPackage = this.packageOf.get(span.file) ?? null;
    const packages = new Set([...reachedFiles].map((file) => this.packageOf.get(file) ?? null));
    const reach: ImpactResult['reach'] = {
      direct: compiler.levels[0]?.length ?? 0,
      total: reachedTotal,
      files: reachedFiles.size,
      packages: packages.size,
      crossPackage: [...packages].some((pkg) => pkg !== targetPackage),
      // Count distinct route files until M4a provides route records (R7).
      routes:
        this.impact.routes.length > 0
          ? [...reachedFiles].filter((file) => matchAny(this.impact.routes, file)).length
          : 0,
    };

    // golden P2 over the target(s) and every listed symbol: factors may only raise the level.
    const involved = [...targets, ...listed];
    const involvedFiles = new Set(involved.map((decl) => decl.file));
    const hasRoutes = this.impact.routes.length > 0;
    const factors: string[] = [];
    if (involved.some((decl) => this.isPublic(decl))) factors.push('public-export-surface');
    if (hasRoutes && [...involvedFiles].some((file) => matchAny(this.impact.routes, file)))
      factors.push('route');
    if ([...involvedFiles].some((file) => (this.packageOf.get(file) ?? null) !== targetPackage))
      factors.push('cross-package');
    if (reach.total >= this.impact.manyCallers) factors.push('many-callers');
    if (commonNameBases.length > 0) factors.push('common-name');
    const boundaries = new Set<string>();
    for (const file of involvedFiles) {
      for (const kind of this.boundaries(file)) boundaries.add(kind);
    }
    for (const kind of ['boundary:sql', 'boundary:native'])
      if (boundaries.has(kind)) factors.push(kind);

    const tests = new Set(listed.filter((decl) => isTestFile(decl.file)).map((decl) => decl.file));
    for (const file of new Set(targets.map((target) => target.file))) {
      for (const row of this.statements.tests.all(`${file}#${MODULE_NAME}`)) {
        tests.add(String(row.file));
      }
    }

    const sortedReasons = [...reasons].sort();
    const incomplete = sortedReasons.length > 0;
    const factorBasis = factors.flatMap((factor) =>
      factor === 'common-name' && commonNameBases.length > 0
        ? [...new Set(commonNameBases)]
        : [factor],
    );
    return {
      target: targetKey,
      span,
      byDepth,
      bridged: [],
      tests: [...tests].sort(),
      completeness: { status: incomplete ? 'partial' : 'complete', reasons: sortedReasons },
      reach,
      factors,
      limits: { ...this.limits },
      scannedFiles: this.scannedFiles,
      verdict: {
        level: incomplete ? 'unknown' : factors.length > 0 ? 'medium' : 'low',
        action: incomplete ? 'check-gaps' : factors.length > 0 ? 'run-tests' : 'proceed',
        zones: [],
        requiredActions: [],
        basis: [...sortedReasons, ...factorBasis],
      },
      freshness: { ...this.freshness },
      engine: { ...this.engine },
    };
  }
}
