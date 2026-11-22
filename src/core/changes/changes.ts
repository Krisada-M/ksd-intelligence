import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { runChangesDiff, type BuildOptions, type ChangesDiffFileInput } from '../engine/build.js';
import { engineVersion } from '../engine/typescript.js';
import type { Workspace } from '../engine/workspace.js';
import { ImpactQuery } from '../impact/query.js';
import { ImpactSession } from '../impact/session.js';
import { MODULE_NAME } from '../indexing/declarations.js';
import type { ImpactConfig } from '../kernel/config.js';
import { matchAny } from '../kernel/glob.js';
import { isRecord } from '../kernel/guards.js';
import type {
  ChangedFile,
  ChangedSymbol,
  ChangedSymbolLiveUser,
  ChangesResult,
  Outcome,
  Span,
  SymbolChangeKind,
  UnindexedChangeDetail,
} from '../kernel/types.js';
import { applyRiskZones, deriveVerdict, matchedRiskZones } from '../kernel/verdict.js';
import { exclusionOf, isCodeKind, kindOf, neverReadOf } from '../workspace/scan.js';
import { readFiles, readMeta, type FileRecord } from '../../storage/sqlite.js';
import {
  collectWorkingTreeChanges,
  readBaseBlob,
  resolveDiffBase,
  validateBaseRef,
  type GitDiffEntry,
} from './git.js';
import { evaluatePlan } from './plan.js';

export interface ChangesOptions {
  base?: string;
  depth?: number;
  planned?: readonly string[];
  signal?: AbortSignal;
  onProgress?: BuildOptions['onProgress'];
}

function unindexedReasonDescription(reason: string): string {
  switch (reason) {
    case 'secret':
      return 'secret file; content never read';
    case 'excluded':
      return 'excluded by configuration; content never read';
    case 'outside-index-scope':
      return 'outside impact.include scope';
    case 'no-tsconfig':
      return 'orphan file (no owning tsconfig)';
    case 'not-in-program':
      return 'file excluded by owning tsconfig';
    case 'other-kind':
      return 'non-TS/JS file; not analysed';
    case 'json':
      return 'JSON file; not analysed';
    case 'binary':
      return 'binary file; not analysed';
    case 'symlink':
      return 'symbolic link; not followed';
    case 'submodule':
      return 'git submodule; not analysed';
    case 'stale-index':
      return 'added while index update failed; not in stale index';
    case 'unreadable':
      return 'file could not be read';
    default:
      return reason;
  }
}

function classifyUnindexedKind(path: string, impact: ImpactConfig): string {
  const kind = kindOf(path);
  const excl = exclusionOf(path, impact);
  if (excl !== null) return excl;
  if (kind === 'json') return 'json';
  if (!isCodeKind(kind)) return 'other-kind';
  if (!matchAny(impact.include, path)) return 'outside-index-scope';
  return 'no-tsconfig';
}

function normalizeSpecifierTarget(fromFile: string, specifier: string): string[] {
  if (!specifier.startsWith('.')) return [];
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const stripped = joined.replace(/\.(?:[cm]?[jt]sx?)$/i, '');
  return [
    joined,
    `${stripped}.ts`,
    `${stripped}.tsx`,
    `${stripped}.mts`,
    `${stripped}.cts`,
    `${stripped}.js`,
    `${stripped}.jsx`,
    `${stripped}.mjs`,
    `${stripped}.cjs`,
    `${stripped}/index.ts`,
    `${stripped}/index.tsx`,
    `${stripped}/index.js`,
    `${stripped}/index.jsx`,
  ];
}

function findRemovedLiveUsers(
  db: DatabaseSync,
  removedSymbols: readonly ChangedSymbol[],
  deletedFiles: ReadonlySet<string>,
): {
  usersBySymbol: Map<string, ChangedSymbolLiveUser[]>;
  gapReasons: string[];
} {
  const usersBySymbol = new Map<string, ChangedSymbolLiveUser[]>();
  const gapReasons = new Set<string>();
  if (removedSymbols.length === 0) return { usersBySymbol, gapReasons: [] };

  const unresolvedByNameStmt = db.prepare(
    `SELECT file, line, reason, source FROM unresolved WHERE name = ? AND reason IN ('unresolved-import', 'unresolved-name-match') ORDER BY file, line`,
  );
  const tokensByNameStmt = db.prepare(
    `SELECT file, lines FROM name_tokens WHERE name = ? AND kind = 'str' ORDER BY file`,
  );
  const exportsByTargetStmt = db.prepare(
    `SELECT file, name FROM exports WHERE target = ? ORDER BY file, name`,
  );
  const allUnresolvedImports =
    deletedFiles.size > 0
      ? (db
          .prepare(
            `SELECT file, line, name, source FROM unresolved WHERE reason = 'unresolved-import' ORDER BY file, line`,
          )
          .all() as Array<{ file: string; line: number; name: string; source: string }>)
      : [];

  for (const sym of removedSymbols) {
    const hashIdx = sym.symbol.indexOf('#');
    const file = hashIdx === -1 ? sym.symbol : sym.symbol.slice(0, hashIdx);
    const qualified = hashIdx === -1 ? '' : sym.symbol.slice(hashIdx + 1);
    const simple =
      qualified
        .split('.')
        .pop()
        ?.replace(/^static:/, '')
        .replace(/~\d+$/, '') ?? '';
    const seen = new Set<string>();
    const users: ChangedSymbolLiveUser[] = [];
    const addUser = (user: ChangedSymbolLiveUser, reasonDetail?: string): void => {
      const k = `${user.file}\0${user.line}\0${user.source}\0${user.reason}`;
      if (seen.has(k)) return;
      seen.add(k);
      users.push(user);
      if (reasonDetail !== undefined) gapReasons.add(reasonDetail);
    };

    if (simple !== '' && simple !== MODULE_NAME && simple !== 'default') {
      const rows = unresolvedByNameStmt.all(simple) as Array<{
        file: string;
        line: number;
        reason: string;
        source: string;
      }>;
      for (const row of rows) {
        const r =
          row.reason === 'unresolved-import' ? 'unresolved-import' : 'unresolved-name-match';
        addUser(
          { file: row.file, line: row.line, source: row.source, reason: r },
          `${r}: ${row.file}:${row.line} — ${simple} (removed from ${file})`,
        );
      }

      const tokenRows = tokensByNameStmt.all(simple) as Array<{ file: string; lines: string }>;
      for (const row of tokenRows) {
        let parsedLines: unknown = [];
        try {
          parsedLines = JSON.parse(row.lines);
        } catch {
          parsedLines = [];
        }
        const firstLine =
          Array.isArray(parsedLines) && typeof parsedLines[0] === 'number' ? parsedLines[0] : 1;
        addUser(
          {
            file: row.file,
            line: firstLine,
            source: `${row.file}#${MODULE_NAME}`,
            reason: 'string-name-match',
          },
          `string-name-match: ${row.file}:${firstLine} — ${simple}`,
        );
      }
    }

    const exportRows = exportsByTargetStmt.all(sym.symbol) as Array<{ file: string; name: string }>;
    for (const row of exportRows) {
      addUser({
        file: row.file,
        line: 1,
        source: `${row.file}#${row.name}`,
        reason: 're-export',
      });
    }

    if (deletedFiles.has(file)) {
      for (const row of allUnresolvedImports) {
        if (!row.name.startsWith('.')) continue;
        const candidates = normalizeSpecifierTarget(row.file, row.name);
        if (candidates.includes(file)) {
          addUser(
            { file: row.file, line: row.line, source: row.source, reason: 'unresolved-import' },
            `unresolved-import: ${row.file}:${row.line} — ${row.name} (deleted/renamed ${file})`,
          );
        }
      }
    }

    if (users.length > 0) {
      users.sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line));
      usersBySymbol.set(sym.symbol, users);
    }
  }

  return { usersBySymbol, gapReasons: [...gapReasons].sort() };
}

function symbolOrderWeight(sym: ChangedSymbol): number {
  const hasUsers = (sym.callers ?? 0) > 0 || (sym.liveUsers?.length ?? 0) > 0;
  if ((sym.change === 'removed' || sym.change === 'signature-changed') && hasUsers) return 0;
  if (sym.change === 'signature-changed') return 1;
  if (sym.change === 'removed') return 2;
  if (sym.change === 'modified') return 3;
  return 4;
}

async function readWorkingText(root: string, path: string): Promise<string | null> {
  try {
    const buf = await readFile(join(root, path));
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

export async function runChanges(
  sessionOrWorkspace: ImpactSession | Workspace,
  options: ChangesOptions = {},
): Promise<Outcome<ChangesResult>> {
  const session =
    sessionOrWorkspace instanceof ImpactSession
      ? sessionOrWorkspace
      : new ImpactSession(sessionOrWorkspace);
  const workspace = session.getWorkspace();

  if (options.signal?.aborted) {
    return { kind: 'failure', code: 'index-failed', message: 'Cancelled', retry: true };
  }

  const depth = options.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > 10) {
    return {
      kind: 'failure',
      code: 'INVALID_INPUT',
      message: 'depth must be an integer 1–10',
    };
  }
  if (options.base !== undefined) {
    const baseErr = validateBaseRef(options.base);
    if (baseErr !== null) {
      return { kind: 'failure', code: 'INVALID_INPUT', message: baseErr };
    }
  }

  const baseRes = await resolveDiffBase(workspace.root, options.base);
  if (!baseRes.ok) {
    return { kind: 'failure', code: 'INVALID_INPUT', message: baseRes.message };
  }
  const { baseLabel, baseSha, mergeBase, gitPrefix } = baseRes.value;

  const diffRes = await collectWorkingTreeChanges(workspace.root, baseSha);
  if (!diffRes.ok) {
    return { kind: 'failure', code: 'index-failed', message: diffRes.message, retry: true };
  }
  const rawChanges = diffRes.value;

  // Empty diff fast-path: return immediately before probing or updating the index (M2c §Round 2).
  if (rawChanges.length === 0) {
    return {
      kind: 'result',
      value: {
        base: baseLabel,
        ...(mergeBase === undefined ? {} : { mergeBase }),
        changedFiles: [],
        changedSymbols: [],
        unindexedChanges: [],
        unindexedDetails: [],
        impact: {
          byDepth: [],
          tests: [],
          completeness: { status: 'complete', reasons: [] },
          reach: { direct: 0, total: 0, files: 0, packages: 0, crossPackage: false, routes: 0 },
          factors: [],
        },
        verdict: deriveVerdict({
          incomplete: false,
          hasFactors: false,
          basis: [],
          matchedZones: [],
        }),
        freshness: { workingTreeHash: '', includesUntracked: true },
        engine: { version: engineVersion(), typescript: 'n/a', extractor: '' },
        limits: { unboundedDynamicImports: 0, excludedFiles: 0, failedFiles: 0 },
        scannedFiles: 0,
        nothingChanged: true,
        timings: { updateMs: 0, baseParseMs: 0, traverseMs: 0, renderMs: 0 },
      },
    };
  }

  const updateStart = performance.now();
  const ctx = await session.prepareForChanges({
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const updateMs = Math.round((performance.now() - updateStart) * 100) / 100;

  if (ctx.indexState === 'building') {
    return {
      kind: 'guidance',
      code: 'index-building',
      message: 'index-building: index update is still running; retry shortly',
    };
  }
  if (ctx.indexState === 'failed' || ctx.db === null) {
    return {
      kind: 'failure',
      code: 'index-failed',
      message: ctx.failureMessage ?? 'index update failed',
      retry: true,
    };
  }

  const db = ctx.db;
  try {
    const files = readFiles(db);
    const fileMap = new Map<string, FileRecord>(files.map((f) => [f.path, f]));
    const extractionMap = new Map<string, string>();
    for (const row of db.prepare('SELECT file, extraction FROM file_index').all() as Array<{
      file: string;
      extraction: string;
    }>) {
      extractionMap.set(row.file, row.extraction);
    }
    const meta = readMeta(db);
    const { impact } = workspace.config;

    const changedFiles: ChangedFile[] = [];
    const unindexedDetails: UnindexedChangeDetail[] = [];
    const diffInputs: ChangesDiffFileInput[] = [];
    const deletedOrRenamedOldPaths = new Set<string>();

    const recordUnindexed = (entry: GitDiffEntry, reason: string): void => {
      changedFiles.push({
        path: entry.path,
        status: entry.status,
        indexed: false,
        ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
      });
      unindexedDetails.push({
        path: entry.path,
        reason: unindexedReasonDescription(reason),
        status: entry.status,
      });
    };

    for (const entry of rawChanges) {
      if (entry.invalidUtf8) {
        recordUnindexed(entry, 'unreadable');
        continue;
      }
      if (entry.isSubmodule) {
        recordUnindexed(entry, 'submodule');
        continue;
      }
      const kind = kindOf(entry.path);
      // Secret & excluded files are classified strictly by path before any disk or git-blob read.
      const neverRead = neverReadOf(entry.path, kind, impact);
      const excl = exclusionOf(entry.path, impact);
      if (neverRead !== null || excl !== null) {
        recordUnindexed(entry, neverRead ?? excl ?? 'excluded');
        if (entry.status === 'R' && entry.oldPath !== undefined) {
          const oldNever = neverReadOf(entry.oldPath, kindOf(entry.oldPath), impact);
          const oldExcl = exclusionOf(entry.oldPath, impact);
          if (oldNever === null && oldExcl === null && isCodeKind(kindOf(entry.oldPath))) {
            const oldWasIndexed =
              ctx.preUpdateIndexable?.has(entry.oldPath) === true ||
              matchAny(impact.include, entry.oldPath);
            if (oldWasIndexed) {
              const baseText = await readBaseBlob(
                workspace.root,
                baseSha,
                gitPrefix,
                entry.oldPath,
              );
              if (baseText !== null) {
                deletedOrRenamedOldPaths.add(entry.oldPath);
                diffInputs.push({
                  path: entry.oldPath,
                  status: 'D',
                  baseText,
                });
              }
            }
          }
        }
        continue;
      }

      if (entry.status === 'D') {
        const wasIndexable =
          isCodeKind(kind) &&
          (ctx.preUpdateIndexable?.has(entry.path) === true ||
            matchAny(impact.include, entry.path));
        if (!wasIndexable) {
          recordUnindexed(entry, classifyUnindexedKind(entry.path, impact));
          continue;
        }
        const baseText = await readBaseBlob(workspace.root, baseSha, gitPrefix, entry.path);
        if (baseText === null) {
          recordUnindexed(entry, 'binary');
          continue;
        }
        deletedOrRenamedOldPaths.add(entry.path);
        changedFiles.push({ path: entry.path, status: 'D', indexed: true });
        diffInputs.push({ path: entry.path, status: 'D', baseText });
        continue;
      }

      // Working-tree file: A, M, or R
      const census = fileMap.get(entry.path);
      const extraction = extractionMap.get(entry.path);
      let isIndexed = false;
      let unindexedReason: string | null = null;
      if (census !== undefined) {
        if (census.status === 'indexable' && extraction !== 'not-in-program') {
          isIndexed = true;
        } else if (extraction === 'not-in-program') {
          unindexedReason = 'not-in-program';
        } else {
          unindexedReason = census.reason ?? classifyUnindexedKind(entry.path, impact);
        }
      } else if (ctx.indexState === 'stale') {
        unindexedReason =
          isCodeKind(kind) && matchAny(impact.include, entry.path)
            ? 'stale-index'
            : classifyUnindexedKind(entry.path, impact);
      } else {
        unindexedReason = classifyUnindexedKind(entry.path, impact);
      }

      if (!isIndexed) {
        recordUnindexed(entry, unindexedReason ?? 'outside-index-scope');
        if (entry.status === 'R' && entry.oldPath !== undefined) {
          const oldNever = neverReadOf(entry.oldPath, kindOf(entry.oldPath), impact);
          const oldExcl = exclusionOf(entry.oldPath, impact);
          if (oldNever === null && oldExcl === null && isCodeKind(kindOf(entry.oldPath))) {
            const oldWasIndexed =
              ctx.preUpdateIndexable?.has(entry.oldPath) === true ||
              matchAny(impact.include, entry.oldPath);
            if (oldWasIndexed) {
              const baseText = await readBaseBlob(
                workspace.root,
                baseSha,
                gitPrefix,
                entry.oldPath,
              );
              if (baseText !== null) {
                deletedOrRenamedOldPaths.add(entry.oldPath);
                diffInputs.push({ path: entry.oldPath, status: 'D', baseText });
              }
            }
          }
        }
        continue;
      }

      const workText = await readWorkingText(workspace.root, entry.path);
      if (workText === null) {
        recordUnindexed(entry, 'binary');
        continue;
      }

      let baseText: string | undefined;
      if (entry.status === 'M') {
        const blob = await readBaseBlob(workspace.root, baseSha, gitPrefix, entry.path);
        if (blob === null) {
          recordUnindexed(entry, 'binary');
          continue;
        }
        baseText = blob;
      } else if (entry.status === 'R') {
        const oldPath = entry.oldPath;
        if (
          oldPath !== undefined &&
          neverReadOf(oldPath, kindOf(oldPath), impact) === null &&
          exclusionOf(oldPath, impact) === null
        ) {
          const blob = await readBaseBlob(workspace.root, baseSha, gitPrefix, oldPath);
          if (blob !== null) {
            baseText = blob;
            deletedOrRenamedOldPaths.add(oldPath);
          }
        }
      }

      changedFiles.push({
        path: entry.path,
        status: entry.status,
        indexed: true,
        ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
      });
      diffInputs.push({
        path: entry.path,
        status: entry.status,
        ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
        ...(baseText === undefined ? {} : { baseText }),
        workText,
      });
    }

    const baseParseStart = performance.now();
    let parsedSymbols: Array<{ symbol: string; change: SymbolChangeKind; span?: Span }> = [];
    let parseErrors: Array<{ file: string; line: number; detail: string }> = [];
    if (diffInputs.length > 0) {
      const diffOutcome = await runChangesDiff(workspace, diffInputs, {
        signal: options.signal,
        onProgress: options.onProgress,
      });
      if (!diffOutcome.ok) {
        return {
          kind: 'failure',
          code: 'index-failed',
          message: diffOutcome.message,
          retry: true,
        };
      }
      const rawSymbols = diffOutcome.value.symbols;
      if (Array.isArray(rawSymbols)) {
        parsedSymbols = rawSymbols.filter(
          (item): item is { symbol: string; change: SymbolChangeKind; span?: Span } =>
            isRecord(item) && typeof item.symbol === 'string' && typeof item.change === 'string',
        );
      }
      const rawParseErrors = diffOutcome.value.parseErrors;
      if (Array.isArray(rawParseErrors)) {
        parseErrors = rawParseErrors.filter(
          (item): item is { file: string; line: number; detail: string } =>
            isRecord(item) &&
            typeof item.file === 'string' &&
            typeof item.line === 'number' &&
            typeof item.detail === 'string',
        );
      }
    }
    const baseParseMs = Math.round((performance.now() - baseParseStart) * 100) / 100;

    const traverseStart = performance.now();
    const removedSymbols: ChangedSymbol[] = parsedSymbols
      .filter((s) => s.change === 'removed')
      .map((s) => ({ symbol: s.symbol, change: s.change, ...(s.span ? { span: s.span } : {}) }));
    const existingChanged = parsedSymbols.filter((s) => s.change !== 'removed');
    const existingKeys = existingChanged.map((s) => s.symbol);

    const { usersBySymbol: removedLiveUsers, gapReasons: removedGapReasons } = findRemovedLiveUsers(
      db,
      removedSymbols,
      deletedOrRenamedOldPaths,
    );

    const indexedFilePaths = changedFiles.filter((f) => f.indexed).map((f) => f.path);
    const impactQuery = new ImpactQuery(db, impact, {
      files,
      meta,
      riskZones: workspace.config.riskZones,
    });
    const unionResult = impactQuery.unionForChanges(existingKeys, depth, indexedFilePaths);
    const traverseMs = Math.round((performance.now() - traverseStart) * 100) / 100;

    const combinedSymbols: ChangedSymbol[] = [];
    for (const s of existingChanged) {
      const symResult = unionResult.perSymbol.get(s.symbol);
      const d1 = symResult?.byDepth[0] ?? [];
      const liveUsers: ChangedSymbolLiveUser[] = d1.map((node) => ({
        file: node.span.file,
        line: node.span.startLine,
        source: node.symbol,
        reason: 'caller',
      }));
      combinedSymbols.push({
        symbol: s.symbol,
        change: s.change,
        ...(s.span ? { span: s.span } : symResult?.span ? { span: symResult.span } : {}),
        callers: symResult?.reach.total ?? 0,
        ...(d1.length > 0 ? { directCallers: d1 } : {}),
        ...(liveUsers.length > 0 ? { liveUsers } : {}),
      });
    }
    for (const s of removedSymbols) {
      const users = removedLiveUsers.get(s.symbol) ?? [];
      combinedSymbols.push({
        ...s,
        callers: users.length,
        ...(users.length > 0 ? { liveUsers: users } : {}),
      });
    }

    combinedSymbols.sort((a, b) => {
      const wa = symbolOrderWeight(a);
      const wb = symbolOrderWeight(b);
      if (wa !== wb) return wa - wb;
      return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    });

    const unindexedChanges = unindexedDetails.map((d) => d.path).sort();
    const extraReasons = new Set<string>(unionResult.union.completeness.reasons);
    for (const detail of unindexedDetails) {
      extraReasons.add(`outside-index-scope: ${detail.path} — ${detail.reason}`);
    }
    for (const pe of parseErrors) {
      extraReasons.add(`parse-error: ${pe.file}:${pe.line} — ${pe.detail}`);
    }
    for (const r of removedGapReasons) {
      extraReasons.add(r);
    }
    if (ctx.indexState === 'stale' && ctx.staleReason !== null) {
      extraReasons.add(ctx.staleReason);
    }

    const sortedReasons = [...extraReasons].sort();
    const incomplete = sortedReasons.length > 0 || ctx.indexState === 'stale';
    const allZonePaths = new Set<string>([
      ...unionResult.allInvolvedFiles,
      ...changedFiles.map((f) => f.path),
      ...changedFiles.flatMap((f) => (f.oldPath === undefined ? [] : [f.oldPath])),
      ...unindexedChanges,
    ]);
    const matchedZones = matchedRiskZones(allZonePaths, workspace.config.riskZones);
    const basis = [
      ...unionResult.basis,
      ...sortedReasons,
      ...(ctx.indexState === 'stale' ? ['stale-index'] : []),
    ];
    const baseVerdict = deriveVerdict({
      incomplete,
      hasFactors: unionResult.union.factors.length > 0,
      basis,
      matchedZones,
    });
    const verdict = applyRiskZones(baseVerdict, allZonePaths, workspace.config.riskZones, {
      incomplete,
      hasFactors: unionResult.union.factors.length > 0,
      preMatchedZones: matchedZones.map((z) => z.zone),
    });

    const plan = evaluatePlan(options.planned, {
      db,
      changedFiles,
      changedSymbols: combinedSymbols,
      unindexedChanges,
    });

    return {
      kind: 'result',
      value: {
        base: baseLabel,
        ...(mergeBase === undefined ? {} : { mergeBase }),
        changedFiles,
        changedSymbols: combinedSymbols,
        unindexedChanges,
        unindexedDetails: unindexedDetails.sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        ),
        impact: {
          ...unionResult.union,
          completeness: {
            status: incomplete ? 'partial' : 'complete',
            reasons: sortedReasons,
          },
        },
        verdict,
        freshness: unionResult.freshness,
        engine: unionResult.engine,
        limits: unionResult.limits,
        scannedFiles: unionResult.scannedFiles,
        indexState:
          ctx.indexState === 'stale' ? 'stale' : ctx.indexState === 'updated' ? 'updated' : 'fresh',
        updatedFiles: ctx.updatedFiles,
        nothingChanged: false,
        ...(plan.provided ? { plan } : {}),
        timings: { updateMs, baseParseMs, traverseMs, renderMs: 0 },
      },
    };
  } finally {
    db.close();
  }
}
