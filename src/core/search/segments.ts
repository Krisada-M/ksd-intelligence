import type * as TS from 'typescript';
import type { SearchRow } from '../../storage/records.js';

type TsApi = Omit<typeof TS, 'default'>;

/** Maximum length in UTF-16 code units for cached signature and doc fields (RISK §6, D60). */
export const MAX_SEARCH_FIELD_CHARS = 400;

export interface SearchDeclarationInput {
  key: string;
  name: string;
  simple: string;
  kind: string;
}

/**
 * Splits an identifier or repo-relative path into lowercase search tokens:
 * camelCase, PascalCase, acronyms (`XMLHttpRequest`), letter-digit boundaries (`parseURL2`),
 * snake/kebab/dot/slash/dollar/underscore separators, and Unicode letters.
 */
export function splitIdentifier(input: string): string {
  return input
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/([\p{Ll}\p{Lo}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Tokenizes a raw user query using the same rules as indexed identifiers. */
export function tokenizeForQuery(query: string): string[] {
  const split = splitIdentifier(query);
  return split === '' ? [] : split.split(' ');
}

export function pathTokens(repoRelativePosixPath: string): string {
  return splitIdentifier(repoRelativePosixPath);
}

function combineTokens(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const split = splitIdentifier(trimmed);
  if (split === '') return trimmed;
  if (trimmed.toLowerCase() === split) return split;
  return `${trimmed} ${split}`;
}

/**
 * Keeps owner tokens separate from simple-name tokens so querying an owner name ranks the
 * owner declaration itself (`name_tokens`) above its members (`owner_tokens`).
 */
export function ownerAndNameTokens(
  name: string,
  simple: string,
): { nameTokens: string; ownerTokens: string } {
  const dot = name.lastIndexOf('.');
  const rawOwner = dot > 0 ? name.slice(0, dot) : '';
  return {
    nameTokens: combineTokens(simple),
    ownerTokens: rawOwner === '' ? '' : combineTokens(rawOwner),
  };
}

/** Caps text at `max` UTF-16 code units without splitting a surrogate pair. */
export function capSearchText(text: string, max = MAX_SEARCH_FIELD_CHARS): string {
  if (max <= 0 || text.length === 0) return '';
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, end).trimEnd();
}

/** Formats bodyless signature headers for a declaration's AST nodes, capped at 400 chars. */
export function extractSearchSignature(
  nodes: readonly TS.Node[],
  signatureOf: (node: TS.Node) => string,
): string {
  const parts = nodes
    .map((node) =>
      signatureOf(node)
        .replace(/\s+/g, ' ')
        .replace(/\s*\{\s*$/, '')
        .trim(),
    )
    .filter((part) => part.length > 0);
  return capSearchText(parts.join(' ; '));
}

/**
 * Extracts the first paragraph of the declaration's JSDoc comment (`/** ... *\/`), ignoring
 * subsequent paragraphs, JSDoc tags, and regular `//` or `/* ... *\/` comments.
 */
export function extractFirstDocParagraph(ts: TsApi, nodes: readonly TS.Node[]): string {
  for (const node of nodes) {
    const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
    const doc = docs.at(-1);
    if (doc === undefined) continue;
    const raw = ts.getTextOfJSDocComment(doc.comment) ?? '';
    const normalized = raw.replace(/\r\n/g, '\n').trim();
    if (normalized === '') continue;
    const paragraphs = normalized
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter((p) => p.length > 0);
    const first = paragraphs[0] ?? '';
    if (first !== '') return capSearchText(first);
  }
  return '';
}

/**
 * Builds FTS5 search rows for an `ok`-extracted indexable file, skipping the synthetic
 * `<module>` declaration. Callers must never invoke this on `parse-error`, `not-in-program`,
 * `lexical`, or excluded/secret files.
 */
export function extractSearchRows(
  ts: TsApi,
  file: string,
  declarations: readonly SearchDeclarationInput[],
  nodesOf: ReadonlyMap<string, readonly TS.Node[]>,
  signatureOf: (node: TS.Node) => string,
): SearchRow[] {
  const fileTokens = pathTokens(file);
  const rows: SearchRow[] = [];
  for (const decl of declarations) {
    if (decl.kind === 'module') continue;
    const nodes = nodesOf.get(decl.key) ?? [];
    const { nameTokens, ownerTokens } = ownerAndNameTokens(decl.name, decl.simple);
    rows.push({
      key: decl.key,
      nameTokens,
      ownerTokens,
      kind: decl.kind,
      signature: extractSearchSignature(nodes, signatureOf),
      doc: extractFirstDocParagraph(ts, nodes),
      pathTokens: fileTokens,
    });
  }
  return rows;
}
