/** The line of a byte offset in `content`, from precomputed line starts. */
function lineOf(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((lineStarts[mid] ?? 0) <= offset)
            low = mid;
        else
            high = mid - 1;
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
export function scanLexically(ts, file, content, names) {
    const lineStarts = [0];
    for (let at = content.indexOf('\n'); at !== -1; at = content.indexOf('\n', at + 1))
        lineStarts.push(at + 1);
    const identifiers = new Map();
    const strings = new Map();
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, content);
    const templateBraces = [];
    let previous = ts.SyntaxKind.Unknown;
    const controlParens = [];
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (token === ts.SyntaxKind.OpenParenToken) {
            controlParens.push(previous === ts.SyntaxKind.IfKeyword ||
                previous === ts.SyntaxKind.WhileKeyword ||
                previous === ts.SyntaxKind.ForKeyword ||
                previous === ts.SyntaxKind.WithKeyword ||
                previous === ts.SyntaxKind.SwitchKeyword ||
                previous === ts.SyntaxKind.CatchKeyword);
        }
        if (token === ts.SyntaxKind.CloseBraceToken && templateBraces.at(-1) === 0) {
            templateBraces.pop();
            token = scanner.reScanTemplateToken(false);
        }
        else if (token === ts.SyntaxKind.OpenBraceToken && templateBraces.length > 0) {
            templateBraces[templateBraces.length - 1] = (templateBraces.at(-1) ?? 0) + 1;
        }
        else if (token === ts.SyntaxKind.CloseBraceToken && templateBraces.length > 0) {
            templateBraces[templateBraces.length - 1] = (templateBraces.at(-1) ?? 0) - 1;
        }
        if (token === ts.SyntaxKind.TemplateHead || token === ts.SyntaxKind.TemplateMiddle) {
            templateBraces.push(0);
        }
        if (token === ts.SyntaxKind.SlashToken &&
            (previous === ts.SyntaxKind.Unknown ||
                previous === ts.SyntaxKind.EqualsToken ||
                previous === ts.SyntaxKind.OpenParenToken ||
                previous === ts.SyntaxKind.SemicolonToken ||
                previous === ts.SyntaxKind.BarBarToken ||
                previous === ts.SyntaxKind.AmpersandAmpersandToken ||
                previous === ts.SyntaxKind.QuestionQuestionToken ||
                previous === ts.SyntaxKind.ExclamationToken ||
                previous === ts.SyntaxKind.PlusToken ||
                previous === ts.SyntaxKind.MinusToken ||
                previous === ts.SyntaxKind.AsteriskToken ||
                previous === ts.SyntaxKind.EqualsEqualsToken ||
                previous === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                previous === ts.SyntaxKind.OpenBracketToken ||
                previous === ts.SyntaxKind.OpenBraceToken ||
                previous === ts.SyntaxKind.CommaToken ||
                previous === ts.SyntaxKind.ColonToken ||
                previous === ts.SyntaxKind.QuestionToken ||
                previous === ts.SyntaxKind.ReturnKeyword ||
                previous === ts.SyntaxKind.ThrowKeyword ||
                previous === ts.SyntaxKind.CaseKeyword ||
                previous === ts.SyntaxKind.EqualsGreaterThanToken ||
                previous === ts.SyntaxKind.TemplateHead ||
                previous === ts.SyntaxKind.TemplateMiddle)) {
            token = scanner.reScanSlashToken();
        }
        const isString = token === ts.SyntaxKind.StringLiteral ||
            token === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
        const isIdentifier = token === ts.SyntaxKind.Identifier || token === ts.SyntaxKind.PrivateIdentifier;
        if (isIdentifier || isString) {
            const text = scanner.getTokenValue();
            if (names.has(text)) {
                const at = lineOf(lineStarts, scanner.getTokenStart());
                const target = isString ? strings : identifiers;
                const lines = target.get(text) ?? [];
                if (lines[lines.length - 1] !== at)
                    lines.push(at);
                target.set(text, lines);
            }
        }
        previous =
            token === ts.SyntaxKind.CloseParenToken && controlParens.pop()
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
        unresolved: [...identifiers].flatMap(([name, lines]) => lines.map((line) => ({
            file,
            line,
            name,
            reason: 'unresolved-name-match',
            source: `${file}#<module>`,
        }))),
        gaps: [],
        tokens: [...strings].map(([name, lines]) => ({ file, name, kind: 'str', lines })),
        externalImports: [],
        exports: [],
        markers: [],
    };
}
