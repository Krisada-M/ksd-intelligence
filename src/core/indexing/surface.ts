import { createHash } from 'node:crypto';
import type * as TS from 'typescript';
import type { FileDeclarations, Ts } from './declarations.js';

/**
 * What other files can observe of one file, computed from syntax alone: no checker, so the hash is
 * a pure function of the file's text and does not depend on what was checked before it.
 */
export interface Surface {
  hash: string;
  /**
   * Keys of the observable declarations. What one of them states can change when a file it uses
   * changes, with no change to this file's text (an inferred type, an overload or conditional
   * over an imported type); its members' keys extend the declaration's key with `.`.
   */
  observableKeys: ReadonlySet<string>;
}

const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/gu;
const SCRIPT_FILE = /\.(?:[cm]?js|jsx)$/i;

function shortHash(text: string, length: number): string {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

function unwrapExpr(ts: Ts, expr: TS.Expression): TS.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function createPiece(ts: Ts, sf: TS.SourceFile) {
  const text = sf.text;
  const script = SCRIPT_FILE.test(sf.fileName);
  const begin = (node: TS.Node): number => (script ? node.getFullStart() : node.getStart(sf));
  const whole = (node: TS.Node): string => text.slice(begin(node), node.end);

  const functionPiece = (node: TS.SignatureDeclaration, from: number): string => {
    const hasWrittenResult =
      ts.isConstructorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      node.type !== undefined;
    const written =
      !script && hasWrittenResult && node.parameters.every((p) => p.type !== undefined);
    if (!written) return text.slice(from, node.end);
    const body = 'body' in node ? node.body : undefined;
    return text.slice(from, body === undefined ? node.end : body.getStart(sf));
  };

  const piece = (node: TS.Node): string => {
    if (ts.isClassLike(node)) {
      return [text.slice(begin(node), node.members.pos), ...node.members.map(piece)].join('\n');
    }
    if (ts.isFunctionLike(node)) return functionPiece(node, begin(node));
    if (ts.isVariableDeclaration(node)) {
      // `const` and `let` infer literal types differently.
      const flags = ts.getCombinedNodeFlags(node) & (ts.NodeFlags.Const | ts.NodeFlags.Let);
      const from = begin(node);
      const init = node.initializer;
      if (!script && node.type !== undefined) {
        return `${flags}:${text.slice(from, node.type.end)}`;
      }
      if (
        !script &&
        init !== undefined &&
        (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      ) {
        return `${flags}:${functionPiece(init, from)}`;
      }
      return `${flags}:${text.slice(from, node.end)}`;
    }
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isParameter(node)) {
      if (!script && node.type !== undefined) return text.slice(begin(node), node.type.end);
      return whole(node);
    }
    if (ts.isBindingElement(node)) {
      // A destructured name takes its type from the declaration's type or initializer.
      let owner: TS.Node = node.parent;
      while (
        ts.isObjectBindingPattern(owner) ||
        ts.isArrayBindingPattern(owner) ||
        ts.isBindingElement(owner)
      ) {
        owner = owner.parent;
      }
      return piece(owner);
    }
    return whole(node);
  };

  return { text, script, begin, whole, functionPiece, piece };
}

/**
 * The surface hash of one file (DESIGN §6.2.1, ADR 0003). Per observable declaration, the text
 * that states its type: the signature when types are written, the whole declaration (body or
 * initializer) when a type is inferred. A declaration is observable when it is exported, or when
 * the text of an observable declaration names it. Over-reporting a change is allowed; missing
 * one is not, so anything unrecognised is hashed whole, and JavaScript files (types come from
 * inference and JSDoc) are hashed whole.
 */
export function surfaceOf(ts: Ts, sf: TS.SourceFile, declarations: FileDeclarations): Surface {
  const { text, begin, piece } = createPiece(ts, sf);

  const lines = new Set<string>();
  const meta = new Map(
    declarations.declarations.map((declaration) => [declaration.key, declaration]),
  );
  // Which declarations exist and whether they are exported; their types are the `src` lines below.
  for (const declaration of declarations.declarations) {
    lines.add(`decl\t${declaration.key}\t${declaration.kind}\t${declaration.exported ? 1 : 0}`);
  }

  // Roots: a member is covered by the declaration that contains it (class, object literal).
  const roots = new Map<string, TS.Node[]>();
  for (const [node, key] of declarations.keyOf) {
    let covered = false;
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      if (declarations.keyOf.has(parent)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    roots.set(key, [...(roots.get(key) ?? []), node]);
  }

  const names = new Set<string>();
  const observable = new Set<string>();
  const observe = (key: string, nodes: readonly TS.Node[]): void => {
    observable.add(key);
    const joined = nodes.map(piece).join('\n');
    lines.add(`src\t${key}\t${shortHash(joined, 16)}`);
    for (const match of joined.matchAll(IDENTIFIER)) names.add(match[0]);
  };
  for (const [key, nodes] of roots) if (meta.get(key)?.exported === true) observe(key, nodes);
  for (let grew = true; grew;) {
    grew = false;
    for (const [key, nodes] of roots) {
      const simple = meta.get(key)?.simple;
      if (observable.has(key) || simple === undefined || !names.has(simple)) continue;
      observe(key, nodes);
      grew = true;
    }
  }

  for (const statement of sf.statements) {
    if (
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      (ts.isImportEqualsDeclaration(statement) &&
        (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ||
      (ts.isModuleDeclaration(statement) && !ts.isIdentifier(statement.name))
    ) {
      lines.add(`stmt\t${shortHash(text.slice(begin(statement), statement.end), 16)}`);
      continue;
    }
    // What an import means can change an inferred type that names it.
    const bound: string[] = [];
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name !== undefined) bound.push(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) bound.push(bindings.name.text);
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) bound.push(element.name.text);
      }
    } else if (ts.isImportEqualsDeclaration(statement)) {
      bound.push(statement.name.text);
    }
    if (bound.some((name) => names.has(name))) {
      lines.add(`imp\t${shortHash(text.slice(begin(statement), statement.end), 16)}`);
    }
  }

  return { hash: shortHash([...lines].sort().join('\n'), 32), observableKeys: observable };
}

export interface DeclarationSurface {
  key: string;
  kind: string;
  exported: boolean;
  /** Normalized hash of type-stating text + kind + exported (surface.ts semantics). */
  surfaceHash: string;
  /** Normalized hash of the declaration's own body/text (excluding indexed child members). */
  bodyHash: string;
}

export interface DeclarationSurfacesResult {
  declarations: Map<string, DeclarationSurface>;
  moduleHash: string;
  fileTokenHash: string;
}

function normalizeTokens(ts: Ts, snippet: string, preserveJsDoc: boolean): string {
  if (snippet === '') return '';
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    snippet,
  );
  const parts: string[] = [];
  let prevToken: TS.SyntaxKind | undefined;
  const REGEX_PRECEDERS = new Set<TS.SyntaxKind>([
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.OpenParenToken,
    ts.SyntaxKind.OpenBracketToken,
    ts.SyntaxKind.OpenBraceToken,
    ts.SyntaxKind.CommaToken,
    ts.SyntaxKind.ColonToken,
    ts.SyntaxKind.SemicolonToken,
    ts.SyntaxKind.ExclamationToken,
    ts.SyntaxKind.AmpersandToken,
    ts.SyntaxKind.BarToken,
    ts.SyntaxKind.QuestionToken,
    ts.SyntaxKind.EqualsGreaterThanToken,
    ts.SyntaxKind.ReturnKeyword,
    ts.SyntaxKind.ThrowKeyword,
    ts.SyntaxKind.CaseKeyword,
    ts.SyntaxKind.YieldKeyword,
    ts.SyntaxKind.AwaitKeyword,
    ts.SyntaxKind.TypeOfKeyword,
    ts.SyntaxKind.VoidKeyword,
    ts.SyntaxKind.DeleteKeyword,
    ts.SyntaxKind.InKeyword,
    ts.SyntaxKind.InstanceOfKeyword,
    ts.SyntaxKind.NewKeyword,
    ts.SyntaxKind.ElseKeyword,
  ]);
  const ASI_KEYWORDS = new Set<TS.SyntaxKind>([
    ts.SyntaxKind.ReturnKeyword,
    ts.SyntaxKind.BreakKeyword,
    ts.SyntaxKind.ContinueKeyword,
    ts.SyntaxKind.ThrowKeyword,
    ts.SyntaxKind.YieldKeyword,
  ]);

  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.WhitespaceTrivia ||
      token === ts.SyntaxKind.NewLineTrivia ||
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.ShebangTrivia ||
      token === ts.SyntaxKind.ConflictMarkerTrivia
    ) {
      token = scanner.scan();
      continue;
    }
    if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
      if (preserveJsDoc) {
        const comment = scanner.getTokenText();
        if (comment.startsWith('/**') && comment !== '/**/') {
          parts.push(`jsdoc:${comment.replace(/\s+/g, ' ').trim()}`);
        }
      }
      token = scanner.scan();
      continue;
    }
    if (
      (token === ts.SyntaxKind.SlashToken || token === ts.SyntaxKind.SlashEqualsToken) &&
      (prevToken === undefined || REGEX_PRECEDERS.has(prevToken))
    ) {
      token = scanner.reScanSlashToken();
    }
    const asiBreak =
      scanner.hasPrecedingLineBreak() &&
      ((prevToken !== undefined && ASI_KEYWORDS.has(prevToken)) ||
        token === ts.SyntaxKind.PlusPlusToken ||
        token === ts.SyntaxKind.MinusMinusToken);
    if (asiBreak) parts.push('\n');
    parts.push(`${token}:${scanner.getTokenText()}`);
    prevToken = token;
    token = scanner.scan();
  }
  return parts.join('\0');
}

export function declarationSurfaces(
  ts: Ts,
  sf: TS.SourceFile,
  declarations: FileDeclarations,
): DeclarationSurfacesResult {
  const { text, script, begin, whole, functionPiece, piece } = createPiece(ts, sf);
  const normalize = (snippet: string): string => normalizeTokens(ts, snippet, script);
  const metaByKey = new Map(declarations.declarations.map((d) => [d.key, d]));

  const nodesByKey = new Map<string, TS.Node[]>();
  for (const [node, key] of declarations.keyOf) {
    let sameKeyAncestor = false;
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      if (declarations.keyOf.get(parent) === key) {
        sameKeyAncestor = true;
        break;
      }
    }
    if (sameKeyAncestor) continue;
    const list = nodesByKey.get(key) ?? [];
    list.push(node);
    nodesByKey.set(key, list);
  }

  const containerHeaderAndUnindexed = (node: TS.Node, forSurface: boolean): string | undefined => {
    const partOf = (child: TS.Node): string => (forSurface ? piece(child) : whole(child));
    if (ts.isClassLike(node)) {
      const unindexed = node.members.filter((m) => !declarations.keyOf.has(m)).map(partOf);
      return [text.slice(begin(node), node.members.pos), ...unindexed].join('\n');
    }
    if (ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
      const unindexed = node.members.filter((m) => !declarations.keyOf.has(m)).map(partOf);
      return [text.slice(begin(node), node.members.pos), ...unindexed].join('\n');
    }
    if (ts.isModuleDeclaration(node)) {
      const header = text.slice(begin(node), node.name.getEnd());
      if (node.body !== undefined && ts.isModuleBlock(node.body)) {
        const unindexed = node.body.statements
          .filter((st) => !declarations.keyOf.has(st))
          .map(partOf);
        return [header, ...unindexed].join('\n');
      }
      return header;
    }
    if (
      ts.isVariableDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isBinaryExpression(node)
    ) {
      const prefix = ts.isVariableDeclaration(node)
        ? `${ts.getCombinedNodeFlags(node) & (ts.NodeFlags.Const | ts.NodeFlags.Let)}:`
        : '';
      const rawInit = ts.isBinaryExpression(node) ? node.right : node.initializer;
      const init = rawInit && unwrapExpr(ts, rawInit);
      if (ts.isVariableDeclaration(node) && !script && node.type !== undefined && forSurface) {
        return `${prefix}${text.slice(begin(node), node.type.end)}`;
      }
      if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        return forSurface
          ? `${prefix}${functionPiece(init, begin(node))}`
          : `${prefix}${whole(node)}`;
      }
      if (init !== undefined && ts.isObjectLiteralExpression(init)) {
        const hasIndexedMembers = init.properties.some((p) => declarations.keyOf.has(p));
        if (hasIndexedMembers) {
          const unindexed = init.properties.filter((p) => !declarations.keyOf.has(p)).map(partOf);
          return [`${prefix}${text.slice(begin(node), init.getStart(sf))}`, ...unindexed].join(
            '\n',
          );
        }
      }
      if (init !== undefined && ts.isClassExpression(init)) {
        const unindexed = init.members.filter((m) => !declarations.keyOf.has(m)).map(partOf);
        return [`${prefix}${text.slice(begin(node), init.members.pos)}`, ...unindexed].join('\n');
      }
    }
    return undefined;
  };

  const surfaceSnippet = (node: TS.Node): string =>
    containerHeaderAndUnindexed(node, true) ?? piece(node);

  const bodySnippet = (node: TS.Node): string =>
    containerHeaderAndUnindexed(node, false) ?? whole(node);

  const result = new Map<string, DeclarationSurface>();
  for (const [key, nodes] of nodesByKey) {
    const meta = metaByKey.get(key);
    if (meta === undefined) continue;
    const sorted = [...nodes].sort((a, b) => a.pos - b.pos);
    const surfaceText = sorted.map((n) => normalize(surfaceSnippet(n))).join('\n');
    const bodyText = sorted.map((n) => normalize(bodySnippet(n))).join('\n');
    result.set(key, {
      key,
      kind: meta.kind,
      exported: meta.exported,
      surfaceHash: shortHash(`${meta.kind}\0${meta.exported ? 1 : 0}\0${surfaceText}`, 32),
      bodyHash: shortHash(`${meta.kind}\0${bodyText}`, 32),
    });
  }

  const moduleParts: string[] = [];
  for (const statement of sf.statements) {
    if (declarations.keyOf.has(statement)) continue;
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.length > 0 &&
      statement.declarationList.declarations.every((decl) => declarations.keyOf.has(decl))
    ) {
      continue;
    }
    moduleParts.push(normalize(whole(statement)));
  }

  return {
    declarations: result,
    moduleHash: shortHash(moduleParts.join('\n'), 32),
    fileTokenHash: shortHash(normalize(text), 32),
  };
}
