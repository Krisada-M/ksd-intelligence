// Minimal glob matcher for repo-relative POSIX paths. Dependency-free by AGENTS.md.
//
// Supported: `**` (a whole path segment: zero or more directories), `*` (anything but `/`),
// `?` (one char but `/`), `{a,b}` alternation (nestable, items may hold globs). Dotfiles are
// ordinary names, so `**/.env*` matches `.env`. Not supported: character classes, backslash
// escapes. An unbalanced `{`, and `,` or `}` outside braces, are literals.

interface Piece {
  src: string;
  /** Index of the `,` or `}` that stopped the scan, or the pattern length. */
  end: number;
}

const cache = new Map<string, RegExp>();

function hasClosingBrace(p: string, open: number): boolean {
  let depth = 0;
  for (let i = open; i < p.length; i++) {
    if (p[i] === '{') depth++;
    if (p[i] === '}' && --depth === 0) return true;
  }
  return false;
}

function escapeChar(c: string): string {
  return /[.+^$()|[\]\\{}]/.test(c) ? `\\${c}` : c;
}

function translate(p: string, start: number, inBrace: boolean): Piece {
  let src = '';
  let i = start;
  while (i < p.length) {
    const c = p[i];
    if (inBrace && (c === ',' || c === '}')) break;

    if (c === '*') {
      let stars = 0;
      while (p[i + stars] === '*') stars++;
      const after = i + stars;
      const prev = p[i - 1];
      const next = p[after];
      const startsSegment = i === start || prev === '/';
      const endsSegment =
        after === p.length || next === '/' || (inBrace && (next === ',' || next === '}'));
      if (stars >= 2 && startsSegment && endsSegment) {
        // `**/` also matches zero directories, so `**/a` matches `a`.
        if (next === '/') {
          src += '(?:.*/)?';
          i = after + 1;
        } else {
          src += '.*';
          i = after;
        }
        continue;
      }
      src += '[^/]*';
      i = after;
      continue;
    }

    if (c === '?') {
      src += '[^/]';
      i++;
      continue;
    }

    if (c === '{' && hasClosingBrace(p, i)) {
      const alternatives: string[] = [];
      let j = i + 1;
      for (;;) {
        const piece = translate(p, j, true);
        alternatives.push(piece.src);
        j = piece.end;
        if (p[j] !== ',') break;
        j++;
      }
      src += `(?:${alternatives.join('|')})`;
      i = j + 1;
      continue;
    }

    src += escapeChar(c ?? '');
    i++;
  }
  return { src, end: i };
}

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) return cached;
  const regex = new RegExp(`^${translate(pattern, 0, false).src}$`);
  cache.set(pattern, regex);
  return regex;
}

export function matchGlob(pattern: string, repoRelativePosixPath: string): boolean {
  return compile(pattern).test(repoRelativePosixPath);
}

/**
 * True when at least one positive pattern matches and no `!`-prefixed pattern does. Order does
 * not matter. Negation only subtracts, so a list of only negations matches nothing.
 */
export function matchAny(patterns: readonly string[], repoRelativePosixPath: string): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (matchGlob(pattern.slice(1), repoRelativePosixPath)) return false;
      continue;
    }
    if (matchGlob(pattern, repoRelativePosixPath)) matched = true;
  }
  return matched;
}
