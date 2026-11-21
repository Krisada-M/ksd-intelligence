import type * as TS from 'typescript';
import type { Ts } from './declarations.js';
import type { FileRows } from '../../storage/records.js';

const regexPrefixCache = new WeakMap<Ts, ReadonlySet<TS.SyntaxKind>>();

function regexPrefixTokens(ts: Ts): ReadonlySet<TS.SyntaxKind> {
  let cached = regexPrefixCache.get(ts);
  if (cached === undefined) {
    const k = ts.SyntaxKind;
    cached = new Set<TS.SyntaxKind>([
      k.Unknown,
      k.EqualsToken,
      k.OpenParenToken,
      k.SemicolonToken,
      k.BarBarToken,
      k.AmpersandAmpersandToken,
      k.QuestionQuestionToken,
      k.ExclamationToken,
      k.PlusToken,
      k.MinusToken,
      k.AsteriskToken,
      k.AsteriskAsteriskToken,
      k.SlashToken,
      k.SlashEqualsToken,
      k.PercentToken,
      k.TildeToken,
      k.DotDotDotToken,
      k.PlusEqualsToken,
      k.MinusEqualsToken,
      k.AsteriskEqualsToken,
      k.AsteriskAsteriskEqualsToken,
      k.PercentEqualsToken,
      k.LessThanLessThanToken,
      k.LessThanLessThanEqualsToken,
      k.GreaterThanGreaterThanToken,
      k.GreaterThanGreaterThanEqualsToken,
      k.GreaterThanGreaterThanGreaterThanToken,
      k.GreaterThanGreaterThanGreaterThanEqualsToken,
      k.AmpersandToken,
      k.AmpersandEqualsToken,
      k.BarToken,
      k.BarEqualsToken,
      k.CaretToken,
      k.CaretEqualsToken,
      k.BarBarEqualsToken,
      k.AmpersandAmpersandEqualsToken,
      k.QuestionQuestionEqualsToken,
      k.EqualsEqualsToken,
      k.EqualsEqualsEqualsToken,
      k.ExclamationEqualsToken,
      k.ExclamationEqualsEqualsToken,
      k.LessThanToken,
      k.LessThanEqualsToken,
      k.GreaterThanToken,
      k.GreaterThanEqualsToken,
      k.OpenBracketToken,
      k.OpenBraceToken,
      k.CommaToken,
      k.ColonToken,
      k.QuestionToken,
      k.EqualsGreaterThanToken,
      k.TemplateHead,
      k.TemplateMiddle,
      k.ReturnKeyword,
      k.ThrowKeyword,
      k.CaseKeyword,
      k.ElseKeyword,
      k.AwaitKeyword,
      k.YieldKeyword,
      k.TypeOfKeyword,
      k.VoidKeyword,
      k.DeleteKeyword,
      k.DoKeyword,
      k.TryKeyword,
      k.FinallyKeyword,
      k.InKeyword,
      k.InstanceOfKeyword,
      k.NewKeyword,
      k.OfKeyword,
      k.ExportKeyword,
      k.DefaultKeyword,
    ]);
    regexPrefixCache.set(ts, cached);
  }
  return cached;
}

/** The line of a byte offset in `content`, from precomputed line starts. */
function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * A code file no tsconfig owns (census `orphan`): no program covers it, so its names can hide
 * references. The TypeScript scanner alone reads it (D55); identifiers that equal an indexed
 * declaration's simple name become `unresolved-name-match` records and its string literals
 * become name tokens, so the query-level cross-check covers these files too. Secret and
 * excluded files never reach this function (RISK §6; they are `unindexed`, not `orphan`).
 */
export function scanLexically(
  ts: Ts,
  file: string,
  content: string,
  names: ReadonlySet<string>,
): FileRows {
  const lineStarts = [0];
  for (let at = content.indexOf('\n'); at !== -1; at = content.indexOf('\n', at + 1))
    lineStarts.push(at + 1);

  const identifiers = new Map<string, number[]>();
  const strings = new Map<string, number[]>();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    content,
  );
  const templateBraces: number[] = [];
  let previous = ts.SyntaxKind.Unknown as TS.SyntaxKind;
  const controlParens: boolean[] = [];
  const regexPrefixes = regexPrefixTokens(ts);
  let regexOffsets: ReadonlySet<number> | undefined;
  const regexStartsHere = (offset: number): boolean => {
    if (regexOffsets === undefined) {
      // Only parse a full AST on the rare `}` + `/` boundary so `{ a: 1 } / x` and
      // `function() {} / x` remain division while `if (b) {} \n /regex/` stays a regex.
      const collected = new Set<number>();
      const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, false);
      const visit = (node: TS.Node): void => {
        if (ts.isRegularExpressionLiteral(node)) collected.add(node.getStart(sf));
        ts.forEachChild(node, visit);
      };
      visit(sf);
      regexOffsets = collected;
    }
    return regexOffsets.has(offset);
  };
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.OpenParenToken) {
      controlParens.push(
        previous === ts.SyntaxKind.IfKeyword ||
          previous === ts.SyntaxKind.WhileKeyword ||
          previous === ts.SyntaxKind.ForKeyword ||
          previous === ts.SyntaxKind.WithKeyword ||
          previous === ts.SyntaxKind.SwitchKeyword ||
          previous === ts.SyntaxKind.CatchKeyword,
      );
    }
    if (token === ts.SyntaxKind.CloseBraceToken && templateBraces.at(-1) === 0) {
      templateBraces.pop();
      token = scanner.reScanTemplateToken(false);
    } else if (token === ts.SyntaxKind.OpenBraceToken && templateBraces.length > 0) {
      templateBraces[templateBraces.length - 1] = (templateBraces.at(-1) ?? 0) + 1;
    } else if (token === ts.SyntaxKind.CloseBraceToken && templateBraces.length > 0) {
      templateBraces[templateBraces.length - 1] = (templateBraces.at(-1) ?? 0) - 1;
    }
    if (token === ts.SyntaxKind.TemplateHead || token === ts.SyntaxKind.TemplateMiddle) {
      templateBraces.push(0);
    }
    if (
      (token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
      (regexPrefixes.has(previous) ||
        (previous === ts.SyntaxKind.CloseBraceToken && regexStartsHere(scanner.getTokenStart())))
    ) {
      token = scanner.reScanSlashToken();
    }
    const isString =
      token === ts.SyntaxKind.StringLiteral ||
      token === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
    const isIdentifier =
      token === ts.SyntaxKind.Identifier || token === ts.SyntaxKind.PrivateIdentifier;
    if (isIdentifier || isString) {
      const text = scanner.getTokenValue();
      if (names.has(text)) {
        const at = lineOf(lineStarts, scanner.getTokenStart());
        const target = isString ? strings : identifiers;
        const lines = target.get(text) ?? [];
        if (lines[lines.length - 1] !== at) lines.push(at);
        target.set(text, lines);
      }
    }
    previous =
      previous === ts.SyntaxKind.DotToken || previous === ts.SyntaxKind.QuestionDotToken
        ? ts.SyntaxKind.Identifier
        : token === ts.SyntaxKind.CloseParenToken && controlParens.pop()
          ? ts.SyntaxKind.Unknown
          : token;
  }

  return {
    index: {
      file,
      extraction: 'lexical',
      lines: lineStarts.length,
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
    // No checker can resolve these uses: every matching identifier is a potential reference.
    unresolved: [...identifiers].flatMap(([name, lines]) =>
      lines.map((line) => ({
        file,
        line,
        name,
        reason: 'unresolved-name-match' as const,
        source: `${file}#<module>`,
      })),
    ),
    gaps: [],
    tokens: [...strings].map(([name, lines]) => ({ file, name, kind: 'str' as const, lines })),
    externalImports: [],
    exports: [],
    markers: [],
  };
}
