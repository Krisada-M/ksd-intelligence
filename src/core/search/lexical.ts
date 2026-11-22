import type { DatabaseSync } from 'node:sqlite';
import type { BuildOptions } from '../engine/build.js';
import { engineVersion } from '../engine/typescript.js';
import type { ImpactSession } from '../impact/session.js';
import type { ImpactConfig } from '../kernel/config.js';
import { matchAny } from '../kernel/glob.js';
import type { Outcome, SearchHit, SearchMatchKind, SearchResult } from '../kernel/types.js';
import { readMeta } from '../../storage/sqlite.js';
import { tokenizeForQuery } from './segments.js';

export const DEFAULT_SEARCH_LIMIT = 8;
export const MIN_SEARCH_LIMIT = 1;
export const MAX_SEARCH_LIMIT = 20;
export const MAX_SEARCH_QUERY_CHARS = 200;

const MAX_FTS_TOKENS = 32;
const MAX_CANDIDATES = 500;
const MAX_EXACT_CANDIDATES = 100;
// Column order in declarations_fts (migration 5):
// 0: stable_key UNINDEXED, 1: name_tokens, 2: owner_tokens, 3: kind, 4: signature, 5: doc, 6: path_tokens
const BM25_SQL = '-bm25(declarations_fts, 0.0, 25.0, 10.0, 0.5, 5.0, 3.0, 1.0)';

export interface SearchOptions {
  query: unknown;
  limit?: unknown;
  signal?: AbortSignal;
  onProgress?: BuildOptions['onProgress'];
}

export type ValidatedSearchInput =
  { ok: true; query: string; limit: number } | { ok: false; message: string };

export function validateSearchInput(rawQuery: unknown, rawLimit?: unknown): ValidatedSearchInput {
  if (
    typeof rawQuery !== 'string' ||
    rawQuery.includes('\0') ||
    rawQuery.trim().length === 0 ||
    rawQuery.length > MAX_SEARCH_QUERY_CHARS
  ) {
    return {
      ok: false,
      message: 'query must be a non-empty string of 1–200 characters',
    };
  }
  let limit = DEFAULT_SEARCH_LIMIT;
  if (rawLimit !== undefined) {
    if (
      typeof rawLimit !== 'number' ||
      !Number.isInteger(rawLimit) ||
      rawLimit < MIN_SEARCH_LIMIT ||
      rawLimit > MAX_SEARCH_LIMIT
    ) {
      return { ok: false, message: 'limit must be an integer 1–20' };
    }
    limit = rawLimit;
  }
  return { ok: true, query: rawQuery.trim(), limit };
}

/** Wraps a query term as a double-quoted FTS5 string literal so no operator is ever parsed. */
export function quoteFtsLiteral(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export interface BuiltFtsQuery {
  matchExpr: string | null;
  exactMatchExpr: string | null;
  rawTerms: string[];
}

export function buildFtsQuery(query: string): BuiltFtsQuery {
  const rawTerms: string[] = [];
  const rawSeen = new Set<string>();
  const pushRaw = (term: string): void => {
    if (term === '' || rawSeen.has(term)) return;
    rawSeen.add(term);
    rawTerms.push(term);
  };

  for (const part of query.trim().split(/\s+/)) {
    if (part === '') continue;
    pushRaw(part);
    if (part.endsWith('()') && part.length > 2) {
      pushRaw(part.slice(0, -2));
    }
  }

  const alnumRaw = rawTerms.filter((term) => /\p{L}|\p{N}/u.test(term));
  const splitTokens = tokenizeForQuery(query);

  const ftsTokens: string[] = [];
  const ftsSeen = new Set<string>();
  for (const token of [...splitTokens, ...alnumRaw.map((term) => term.toLowerCase())]) {
    if (token === '' || ftsSeen.has(token)) continue;
    ftsSeen.add(token);
    ftsTokens.push(token);
    if (ftsTokens.length >= MAX_FTS_TOKENS) break;
  }

  const exactClauses: string[] = [];
  const exactSeen = new Set<string>();
  const pushExactClause = (term: string): void => {
    const clause = `name_tokens : ${quoteFtsLiteral(term)}`;
    if (exactSeen.has(clause) || exactClauses.length >= MAX_FTS_TOKENS) return;
    exactSeen.add(clause);
    exactClauses.push(clause);
  };
  for (const term of alnumRaw) {
    pushExactClause(term);
    const dot = term.lastIndexOf('.');
    if (dot > 0 && dot < term.length - 1) {
      const afterDot = term.slice(dot + 1);
      if (/\p{L}|\p{N}/u.test(afterDot)) {
        pushExactClause(afterDot);
      }
    }
  }

  return {
    matchExpr: ftsTokens.length === 0 ? null : ftsTokens.map(quoteFtsLiteral).join(' OR '),
    exactMatchExpr: exactClauses.length === 0 ? null : exactClauses.join(' OR '),
    rawTerms,
  };
}

interface CandidateRow {
  stableKey: string;
  signature: string;
  file: string;
  name: string;
  simple: string;
  declKind: string;
  exported: number;
  startLine: number;
  endLine: number;
  bm25Score: number;
  callers: number;
}

function readCandidates(
  db: DatabaseSync,
  matchExpr: string,
  candidateLimit: number,
): CandidateRow[] {
  const rows = db
    .prepare(
      `SELECT
         f.stable_key AS stable_key,
         f.signature AS signature,
         d.file AS file,
         d.name AS name,
         d.simple AS simple,
         d.kind AS decl_kind,
         d.exported AS exported,
         d.start_line AS start_line,
         d.end_line AS end_line,
         ${BM25_SQL} AS bm25_score,
         (SELECT COUNT(*) FROM edges e WHERE e.target = d.id AND e.kind NOT IN ('IMPORTS', 'TESTS')) AS callers
       FROM declarations_fts f
       JOIN symbols s ON s.key = f.stable_key
       JOIN declarations d ON d.id = s.id
       WHERE declarations_fts MATCH ?
       ORDER BY bm25_score DESC, f.stable_key ASC
       LIMIT ?`,
    )
    .all(matchExpr, candidateLimit);

  return rows.map((row) => ({
    stableKey: String(row.stable_key),
    signature: String(row.signature),
    file: String(row.file),
    name: String(row.name),
    simple: String(row.simple),
    declKind: String(row.decl_kind),
    exported: Number(row.exported),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    bm25Score: Number(row.bm25_score),
    callers: Number(row.callers),
  }));
}

export function querySearch(
  db: DatabaseSync,
  impact: ImpactConfig,
  query: string,
  limit: number,
  extras?: {
    indexState?: 'fresh' | 'updated' | 'stale';
    updatedFiles?: number;
    staleReason?: string;
  },
): SearchResult {
  const meta = readMeta(db);
  const engine = {
    version: engineVersion(),
    typescript: meta.typescript_version ?? 'unknown',
    extractor: meta.extractor_stamp ?? 'unknown',
  };
  const scannedRow = db.prepare('SELECT COUNT(*) AS n FROM files').get() as
    { n?: number } | undefined;
  const scannedFiles = Number(scannedRow?.n ?? 0);
  const indexState = extras?.indexState ?? 'fresh';

  const { matchExpr, exactMatchExpr, rawTerms } = buildFtsQuery(query);
  if (matchExpr === null && exactMatchExpr === null) {
    return {
      query,
      limit,
      totalMatches: 0,
      hits: [],
      indexState,
      ...(extras?.updatedFiles !== undefined ? { updatedFiles: extras.updatedFiles } : {}),
      scannedFiles,
      ...(extras?.staleReason !== undefined ? { staleReason: extras.staleReason } : {}),
      engine,
    };
  }

  const totalRow =
    matchExpr === null
      ? undefined
      : (db
          .prepare('SELECT COUNT(*) AS total FROM declarations_fts WHERE declarations_fts MATCH ?')
          .get(matchExpr) as { total?: number } | undefined);
  const ftsTotal = Number(totalRow?.total ?? 0);

  const candidates = new Map<string, CandidateRow>();
  if (matchExpr !== null) {
    for (const row of readCandidates(db, matchExpr, MAX_CANDIDATES)) {
      candidates.set(row.stableKey, row);
    }
  }
  if (exactMatchExpr !== null) {
    for (const row of readCandidates(db, exactMatchExpr, MAX_EXACT_CANDIDATES)) {
      const existing = candidates.get(row.stableKey);
      if (existing === undefined || row.bm25Score > existing.bm25Score) {
        candidates.set(row.stableKey, row);
      }
    }
  }

  const exactSet = new Set<string>([...rawTerms, query.trim()]);
  const exactLowerSet = new Set<string>([...exactSet].map((term) => term.toLowerCase()));

  const scored = [...candidates.values()].map((row) => {
    const exactCase = exactSet.has(row.name) || exactSet.has(row.simple);
    const exactLower =
      !exactCase &&
      (exactLowerSet.has(row.name.toLowerCase()) || exactLowerSet.has(row.simple.toLowerCase()));
    const kind: SearchMatchKind = exactCase || exactLower ? 'exact' : 'lexical';
    const exactBoost = exactCase ? 1000 : exactLower ? 900 : 0;
    const exportedBoost = row.exported === 1 ? 1.5 : 0;
    const callerBoost = Math.log(1 + row.callers) * 0.5;
    const score = row.bm25Score + exactBoost + exportedBoost + callerBoost;
    return { row, kind, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.row.stableKey < b.row.stableKey ? -1 : a.row.stableKey > b.row.stableKey ? 1 : 0;
  });

  const routeCache = new Map<string, boolean>();
  const isRoute = (file: string): boolean => {
    let cached = routeCache.get(file);
    if (cached === undefined) {
      cached = impact.routes.length > 0 && matchAny(impact.routes, file);
      routeCache.set(file, cached);
    }
    return cached;
  };

  const hits: SearchHit[] = scored.slice(0, limit).map(({ row, kind, score }) => ({
    kind,
    symbol: row.stableKey,
    declarationKind: row.declKind,
    span: {
      file: row.file,
      startLine: row.startLine,
      endLine: row.endLine,
    },
    signature: row.signature,
    exported: row.exported === 1,
    callers: row.callers,
    route: isRoute(row.file),
    score,
  }));

  return {
    query,
    limit,
    totalMatches: Math.max(ftsTotal, candidates.size),
    hits,
    indexState,
    ...(extras?.updatedFiles !== undefined ? { updatedFiles: extras.updatedFiles } : {}),
    scannedFiles,
    ...(extras?.staleReason !== undefined ? { staleReason: extras.staleReason } : {}),
    engine,
  };
}

export async function runSearch(
  session: ImpactSession,
  options: SearchOptions,
): Promise<Outcome<SearchResult>> {
  if (options.signal?.aborted) {
    return { kind: 'failure', code: 'index-failed', message: 'Cancelled' };
  }
  const workspace = session.getWorkspace();
  if (workspace.config.search.enabled === false) {
    return {
      kind: 'failure',
      code: 'index-failed',
      message: 'search is disabled in ei.config.json (search.enabled = false)',
    };
  }
  const valid = validateSearchInput(options.query, options.limit);
  if (!valid.ok) {
    return { kind: 'failure', code: 'INVALID_INPUT', message: valid.message };
  }

  const ctx = await session.prepareForSearch({
    signal: options.signal,
    onProgress: options.onProgress,
  });
  if (ctx.db === null) {
    if (ctx.indexState === 'building') {
      return {
        kind: 'guidance',
        code: 'index-building',
        message:
          'INDEX BUILDING — index build still running after 60 s. Call again; the answer will use the finished index.',
      };
    }
    return {
      kind: 'failure',
      code: 'index-failed',
      message: ctx.failureMessage ?? 'index unavailable',
      retry: ctx.failureMessage !== 'Cancelled',
    };
  }

  try {
    const result = querySearch(ctx.db, workspace.config.impact, valid.query, valid.limit, {
      indexState:
        ctx.indexState === 'updated' ? 'updated' : ctx.indexState === 'stale' ? 'stale' : 'fresh',
      updatedFiles: ctx.updatedFiles,
      ...(ctx.staleReason !== null ? { staleReason: ctx.staleReason } : {}),
    });
    return { kind: 'result', value: result };
  } finally {
    ctx.db.close();
  }
}
