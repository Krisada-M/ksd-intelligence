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
  return `"${term.replaceAll('\0', '').replaceAll('"', '""')}"`;
}

export interface BuiltFtsQuery {
  matchExpr: string | null;
  exactMatchExpr: string | null;
  rawTerms: string[];
}

interface InternalBuiltFtsQuery extends BuiltFtsQuery {
  tokenLimitHit: boolean;
}

function buildFtsQueryInternal(query: string): InternalBuiltFtsQuery {
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
  let tokenLimitHit = false;
  for (const token of [...splitTokens, ...alnumRaw.map((term) => term.toLowerCase())]) {
    if (token === '' || ftsSeen.has(token)) continue;
    if (ftsTokens.length >= MAX_FTS_TOKENS) {
      tokenLimitHit = true;
      break;
    }
    ftsSeen.add(token);
    ftsTokens.push(token);
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
    tokenLimitHit,
  };
}

export function buildFtsQuery(query: string): BuiltFtsQuery {
  const { matchExpr, exactMatchExpr, rawTerms } = buildFtsQueryInternal(query);
  return { matchExpr, exactMatchExpr, rawTerms };
}

interface CandidateRow {
  id: number;
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

function mapCandidateRow(row: Record<string, unknown>): CandidateRow {
  return {
    id: Number(row.id),
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
  };
}

function readCandidates(
  db: DatabaseSync,
  matchExpr: string,
  candidateLimit: number,
): CandidateRow[] {
  // Select top-N rowids via compact symbols B-tree before hydrating wide FTS/declaration rows and caller counts.
  const rows = db
    .prepare(
      `WITH top AS (
         SELECT
           f.rowid AS id,
           s.key AS stable_key,
           ${BM25_SQL} AS bm25_score
         FROM declarations_fts f
         JOIN symbols s ON s.id = f.rowid
         WHERE declarations_fts MATCH ?
         ORDER BY bm25_score DESC, s.key ASC
         LIMIT ?
       )
       SELECT
         top.id AS id,
         top.stable_key AS stable_key,
         f.signature AS signature,
         d.file AS file,
         d.name AS name,
         d.simple AS simple,
         d.kind AS decl_kind,
         d.exported AS exported,
         d.start_line AS start_line,
         d.end_line AS end_line,
         top.bm25_score AS bm25_score,
         (SELECT COUNT(*) FROM edges e WHERE e.target = d.id AND e.kind NOT IN ('IMPORTS', 'TESTS')) AS callers
       FROM top
       JOIN declarations d ON d.id = top.id
       JOIN declarations_fts f ON f.rowid = top.id`,
    )
    .all(matchExpr, candidateLimit) as Array<Record<string, unknown>>;

  return rows.map(mapCandidateRow);
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

  const { matchExpr, exactMatchExpr, rawTerms, tokenLimitHit } = buildFtsQueryInternal(query);
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
  const seenIds = new Set<number>();
  if (matchExpr !== null) {
    for (const row of readCandidates(db, matchExpr, MAX_CANDIDATES)) {
      candidates.set(row.stableKey, row);
      seenIds.add(row.id);
    }
  }

  const exactSet = new Set<string>([...rawTerms, query.trim()]);
  const exactLowerSet = new Set<string>([...exactSet].map((term) => term.toLowerCase()));

  if (
    (ftsTotal > MAX_CANDIDATES || tokenLimitHit || matchExpr === null) &&
    exactMatchExpr !== null
  ) {
    const exactTerms = [...exactSet].filter(
      (term) => !term.includes('\0') && /\p{L}|\p{N}/u.test(term),
    );
    const hasNonAscii = exactTerms.some((term) => /[^\x00-\x7f]/.test(term));
    const fallbackExact = (): void => {
      for (const row of readCandidates(db, exactMatchExpr, MAX_EXACT_CANDIDATES)) {
        if (!candidates.has(row.stableKey)) {
          candidates.set(row.stableKey, row);
          seenIds.add(row.id);
        }
      }
    };

    if (hasNonAscii || exactTerms.length === 0 || matchExpr === null) {
      fallbackExact();
    } else {
      const predicates: string[] = [];
      const params: string[] = [];
      for (const term of exactTerms) {
        predicates.push('d.simple = ? COLLATE NOCASE');
        params.push(term);
        if (term.includes('.') || term.includes(' ')) {
          predicates.push('d.name = ? COLLATE NOCASE');
          params.push(term);
        }
      }
      const exactIdRows = db
        .prepare(
          `SELECT d.id AS id
           FROM declarations d
           WHERE d.kind != 'module' AND (${predicates.join(' OR ')})`,
        )
        .all(...params) as Array<{ id: number }>;
      const missingExactIds: number[] = [];
      for (const row of exactIdRows) {
        const id = Number(row.id);
        if (!seenIds.has(id)) missingExactIds.push(id);
      }

      if (missingExactIds.length > MAX_EXACT_CANDIDATES) {
        fallbackExact();
      } else if (missingExactIds.length > 0) {
        const placeholders = missingExactIds.map(() => '?').join(', ');
        const missingRows = (
          db
            .prepare(
              `SELECT
                 d.id AS id,
                 s.key AS stable_key,
                 f.signature AS signature,
                 d.file AS file,
                 d.name AS name,
                 d.simple AS simple,
                 d.kind AS decl_kind,
                 d.exported AS exported,
                 d.start_line AS start_line,
                 d.end_line AS end_line,
                 0.0 AS bm25_score,
                 (SELECT COUNT(*) FROM edges e WHERE e.target = d.id AND e.kind NOT IN ('IMPORTS', 'TESTS')) AS callers
               FROM declarations d
               JOIN symbols s ON s.id = d.id
               JOIN declarations_fts f ON f.rowid = d.id
               WHERE d.id IN (${placeholders})`,
            )
            .all(...missingExactIds) as Array<Record<string, unknown>>
        ).map(mapCandidateRow);

        let anyExistingExact = false;
        for (const row of candidates.values()) {
          if (
            exactSet.has(row.name) ||
            exactSet.has(row.simple) ||
            exactLowerSet.has(row.name.toLowerCase()) ||
            exactLowerSet.has(row.simple.toLowerCase())
          ) {
            anyExistingExact = true;
            break;
          }
        }

        const bm25ById = new Map<number, number>();
        if (!tokenLimitHit && (missingExactIds.length > 1 || anyExistingExact)) {
          const bm25Rows = db
            .prepare(
              `SELECT f.rowid AS id, ${BM25_SQL} AS bm25_score
               FROM declarations_fts f
               WHERE declarations_fts MATCH ? AND f.rowid IN (${placeholders})`,
            )
            .all(matchExpr, ...missingExactIds) as Array<{ id: number; bm25_score: number }>;
          for (const bm of bm25Rows) {
            bm25ById.set(Number(bm.id), Number(bm.bm25_score));
          }
        }

        for (const row of missingRows) {
          const bm25 = bm25ById.get(row.id);
          if (bm25 !== undefined) row.bm25Score = bm25;
          if (!candidates.has(row.stableKey)) {
            candidates.set(row.stableKey, row);
            seenIds.add(row.id);
          }
        }
      }
    }
  }

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
