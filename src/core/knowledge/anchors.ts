import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Learning } from './learning.js';

export type AnchorState = 'active' | 'needs-review' | 'orphaned' | 'superseded';

export interface DeclarationSpan {
  key: string;
  file: string;
  startLine: number;
  endLine: number;
  simple: string;
}

/** What anchors need from the index; `null` index means it could not be made fresh. */
export interface AnchorIndex {
  declaration(key: string): DeclarationSpan | null;
  declarationsIn(file: string): DeclarationSpan[];
}

export interface EvaluatedLearning {
  learning: Learning;
  state: AnchorState;
  reason: string;
  /** Orphaned symbol: a declaration in the same file with the same body (never applied). */
  suggestion?: string;
  /** Current hash of the anchor, for `ei learning review`; absent when the anchor is gone. */
  currentHash?: string;
}

interface Row {
  key: string;
  file: string;
  start_line: number;
  end_line: number;
  simple: string;
}

function toSpan(row: Row): DeclarationSpan {
  return {
    key: row.key,
    file: row.file,
    startLine: row.start_line,
    endLine: row.end_line,
    simple: row.simple,
  };
}

function isRow(value: unknown): value is Row {
  if (typeof value !== 'object' || value === null) return false;
  const row: Record<string, unknown> = { ...value };
  return (
    typeof row.key === 'string' &&
    typeof row.file === 'string' &&
    typeof row.start_line === 'number' &&
    typeof row.end_line === 'number' &&
    typeof row.simple === 'string'
  );
}

const SELECT = `SELECT s.key AS key, d.file AS file, d.start_line AS start_line,
  d.end_line AS end_line, d.simple AS simple FROM declarations d JOIN symbols s ON s.id = d.id`;

/** Anchor lookups over a published index database (read-only). */
export function anchorIndexFromDb(db: DatabaseSync): AnchorIndex {
  const byKey = db.prepare(`${SELECT} WHERE s.key = ?`);
  const byFile = db.prepare(`${SELECT} WHERE d.file = ? ORDER BY d.start_line`);
  return {
    declaration: (key) => {
      const row: unknown = byKey.get(key);
      return isRow(row) ? toSpan(row) : null;
    },
    declarationsIn: (file) =>
      byFile.all(file).flatMap((row: unknown) => (isRow(row) ? [toSpan(row)] : [])),
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Hash of a declaration's lines with its own name blanked: an edit to the body changes it,
 * a pure rename does not (that is how an orphan's renamed successor is recognised).
 */
export function declarationHash(fileText: string, span: DeclarationSpan): string {
  const lines = fileText.replace(/\r\n?/g, '\n').split('\n');
  const body = lines.slice(span.startLine - 1, span.endLine).join('\n');
  const name = span.simple.replace(/^static:/, '');
  const blanked =
    name === '' ? body : body.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g'), '\u0000');
  return sha256(blanked);
}

export function fileHash(fileText: string): string {
  return sha256(fileText.replace(/\r\n?/g, '\n'));
}

function fileOfKey(key: string): string {
  const hash = key.indexOf('#');
  return hash < 0 ? key : key.slice(0, hash);
}

async function readText(root: string, path: string): Promise<string | null> {
  if (path.startsWith('/') || path.split('/').includes('..')) return null;
  return readFile(join(root, path), 'utf8').catch(() => null);
}

/** Current hash of an anchor, or null when the key or file no longer exists. */
export async function currentAnchorHash(
  root: string,
  anchor: Learning['anchor'],
  index: AnchorIndex | null,
): Promise<string | null | 'unknown'> {
  if (anchor.kind === 'file') {
    const text = await readText(root, anchor.key);
    return text === null ? null : fileHash(text);
  }
  if (index === null) return 'unknown';
  const span = index.declaration(anchor.key);
  if (span === null) return null;
  const text = await readText(root, span.file);
  return text === null ? null : declarationHash(text, span);
}

async function renamedSuccessor(
  root: string,
  learning: Learning,
  index: AnchorIndex,
): Promise<string | undefined> {
  const file = fileOfKey(learning.anchor.key);
  const text = await readText(root, file);
  if (text === null) return undefined;
  return index
    .declarationsIn(file)
    .find((span) => declarationHash(text, span) === learning.anchor.contentHash)?.key;
}

/**
 * State of every learning, computed now. Stale or unresolvable anchors are never `active`;
 * `superseded` comes only from an explicit `supersedes` in another learning.
 */
export async function evaluateLearnings(
  learnings: readonly Learning[],
  root: string,
  index: AnchorIndex | null,
): Promise<EvaluatedLearning[]> {
  const superseded = new Map<string, string>();
  for (const learning of learnings) {
    if (learning.supersedes !== undefined) superseded.set(learning.supersedes, learning.id);
  }
  const out: EvaluatedLearning[] = [];
  for (const learning of learnings) {
    const by = superseded.get(learning.id);
    if (by !== undefined) {
      out.push({ learning, state: 'superseded', reason: `superseded by ${by}` });
      continue;
    }
    const hash = await currentAnchorHash(root, learning.anchor, index);
    if (hash === 'unknown') {
      out.push({
        learning,
        state: 'needs-review',
        reason: 'index unavailable; anchor not checked',
      });
      continue;
    }
    if (hash === null) {
      const suggestion =
        learning.anchor.kind === 'symbol' && index !== null
          ? await renamedSuccessor(root, learning, index)
          : undefined;
      out.push({
        learning,
        state: 'orphaned',
        reason: `${learning.anchor.key} no longer exists`,
        ...(suggestion === undefined ? {} : { suggestion }),
      });
      continue;
    }
    if (hash !== learning.anchor.contentHash) {
      out.push({
        learning,
        state: 'needs-review',
        reason: 'anchored code changed',
        currentHash: hash,
      });
      continue;
    }
    out.push({ learning, state: 'active', reason: 'anchor unchanged', currentHash: hash });
  }
  return out;
}
