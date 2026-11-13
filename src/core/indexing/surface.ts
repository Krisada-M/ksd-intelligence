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

/**
 * The surface hash of one file (DESIGN §6.2.1, ADR 0003). Per observable declaration, the text
 * that states its type: the signature when types are written, the whole declaration (body or
 * initializer) when a type is inferred. A declaration is observable when it is exported, or when
 * the text of an observable declaration names it. Over-reporting a change is allowed; missing
 * one is not, so anything unrecognised is hashed whole, and JavaScript files (types come from
 * inference and JSDoc) are hashed whole.
 */
export function surfaceOf(ts: Ts, sf: TS.SourceFile, declarations: FileDeclarations): Surface {
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
