import { isAbsolute, posix, relative, sep } from 'node:path';
import type * as TS from 'typescript';
import {
  MODULE_NAME,
  enclosingKey,
  fileDeclarations,
  type FileDeclarations,
  type Ts,
} from './declarations.js';
import { surfaceOf } from './surface.js';

export type EdgeKind = 'CALLS' | 'CONSTRUCTS' | 'REFERENCES' | 'IMPORTS' | 'IMPLEMENTS' | 'TESTS';

export interface EdgeRecord {
  source: string;
  target: string;
  kind: EdgeKind;
  strength: 'compiler';
  /** Sorted, unique use-site lines in the source file. */
  lines: number[];
}

/** A use that resolved to nothing but must not disappear (ADR 0003). */
export interface UnresolvedRecord {
  file: string;
  line: number;
  name: string;
  reason: 'unresolved-import' | 'unresolved-name-match';
  source: string;
}

export type GapCode =
  | 'dynamic-import'
  | 'computed-member-access'
  | 'interface-dispatch'
  | 'cjs-require'
  | 'parse-error';

/** A completeness gap at a site; `detail` scopes it (golden P4). */
export interface GapRecord {
  file: string;
  line: number;
  code: GapCode;
  detail: string;
  source: string;
}

/** String literals equal to an indexed declaration's name, for `string-name-match` (ADR 0003). */
export interface NameToken {
  file: string;
  name: string;
  kind: 'str';
  lines: number[];
}

/** A bare package specifier, installed or not, for boundary detection later (RISK §3.2). */
export interface ExternalImport {
  file: string;
  specifier: string;
  line: number;
}

/** One name a module exports and the in-scope declaration it resolves to, re-exports followed. */
export interface ExportRecord {
  file: string;
  name: string;
  target: string;
}

/** All use targets, by ADR 0003 category; name matching does not limit these counts. */
export interface ResolveCounts {
  indexed: number;
  local: number;
  /** Uses resolved into a library (node_modules, the standard library). */
  external: number;
  /** Bare package specifiers that resolve to nothing (dependency not installed). */
  externalUnresolved: number;
  /** Unresolved uses whose name matches no indexed declaration. */
  unresolvedOther: number;
  /** Uses resolved into a repository file outside the index scope. */
  outsideScope: number;
}

export interface FileResolution {
  file: string;
  edges: EdgeRecord[];
  unresolved: UnresolvedRecord[];
  gaps: GapRecord[];
  tokens: NameToken[];
  externalImports: ExternalImport[];
  exports: ExportRecord[];
  /**
   * What other files can observe of this one, from syntax alone (`surface.ts`); dependents are
   * re-resolved when it changes.
   */
  surface: string;
  /** Keys of the observable declarations (`surface.ts`). */
  observableKeys: ReadonlySet<string>;
  /** A script, ambient or augmenting file: a change can alter resolution anywhere. */
  global: boolean;
  counts: ResolveCounts;
}

export interface ResolveScope {
  root: string;
  /** Repo-relative paths of indexable files (the index scope). */
  indexable: ReadonlySet<string>;
  /** Simple names of every indexed declaration (ADR 0003), for name matching and tokens. */
  declarationNames: ReadonlySet<string>;
  /** Names of workspace packages: a bare specifier naming one is an in-repo import. */
  workspacePackages: ReadonlySet<string>;
}

const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

type Target = { key: string; file: string } | 'external' | 'outside' | 'local';

/** Scripts (no module symbol), ambient modules and global augmentations affect every file. */
export function isGlobalFile(ts: Ts, checker: TS.TypeChecker, sf: TS.SourceFile): boolean {
  if (checker.getSymbolAtLocation(sf) === undefined) return true;
  return sf.statements.some(
    (statement) =>
      ts.isModuleDeclaration(statement) &&
      (!ts.isIdentifier(statement.name) ||
        (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0),
  );
}

interface FileInfo {
  path: string | null;
  inScope: boolean;
  library: boolean;
}

/** Resolves the files of one program (phase 3). Caches per-file facts it touches. */
export class Resolver {
  private readonly declarationCache = new Map<TS.SourceFile, FileDeclarations>();
  private readonly fileCache = new Map<TS.SourceFile, FileInfo>();
  private checkerInstance: TS.TypeChecker | undefined;
  private readonly declarationKinds: ReadonlySet<TS.SyntaxKind>;

  constructor(
    private readonly ts: Ts,
    private readonly program: TS.Program,
    private readonly scope: ResolveScope,
  ) {
    const k = ts.SyntaxKind;
    // Nodes whose `name` is a name being declared, not a use.
    this.declarationKinds = new Set([
      k.VariableDeclaration,
      k.FunctionDeclaration,
      k.FunctionExpression,
      k.ClassDeclaration,
      k.ClassExpression,
      k.InterfaceDeclaration,
      k.TypeAliasDeclaration,
      k.EnumDeclaration,
      k.EnumMember,
      k.ModuleDeclaration,
      k.Parameter,
      k.PropertyDeclaration,
      k.PropertySignature,
      k.MethodDeclaration,
      k.MethodSignature,
      k.GetAccessor,
      k.SetAccessor,
      k.PropertyAssignment,
      k.BindingElement,
      k.TypeParameter,
      k.ImportEqualsDeclaration,
      k.NamespaceExportDeclaration,
      k.ImportSpecifier,
      k.ImportClause,
      k.NamespaceImport,
      k.NamespaceExport,
      k.ExportSpecifier,
      k.JsxAttribute,
    ]);
  }

  // Created on first use: the declaration pass needs syntax only, and a checker is the bulk of a
  // program's memory.
  private get checker(): TS.TypeChecker {
    this.checkerInstance ??= this.program.getTypeChecker();
    return this.checkerInstance;
  }

  repoPath(fileName: string): string | null {
    const rel = relative(this.scope.root, fileName);
    const posixRel = sep === '/' ? rel : rel.split(sep).join('/');
    if (posixRel.startsWith('..') || isAbsolute(posixRel)) return null;
    if (posixRel.startsWith('node_modules/') || posixRel.includes('/node_modules/')) return null;
    return posixRel;
  }

  private infoOf(sf: TS.SourceFile): FileInfo {
    let info = this.fileCache.get(sf);
    if (info === undefined) {
      const path = this.repoPath(sf.fileName);
      info = {
        path,
        inScope: path !== null && this.scope.indexable.has(path),
        library: path === null || this.program.isSourceFileDefaultLibrary(sf),
      };
      this.fileCache.set(sf, info);
    }
    return info;
  }

  declarationsOf(sf: TS.SourceFile): FileDeclarations {
    let found = this.declarationCache.get(sf);
    if (found === undefined) {
      found = fileDeclarations(this.ts, sf, this.repoPath(sf.fileName) ?? sf.fileName);
      this.declarationCache.set(sf, found);
    }
    return found;
  }

  private targetOfDeclaration(node: TS.Node): Target {
    const sf = node.getSourceFile();
    const info = this.infoOf(sf);
    if (info.library) return 'external';
    if (!info.inScope || info.path === null) return 'outside';
    const key = this.declarationsOf(sf).keyOf.get(node);
    return key === undefined ? 'local' : { key, file: info.path };
  }

  private resolveAliases(symbol: TS.Symbol): TS.Symbol {
    return symbol.flags & this.ts.SymbolFlags.Alias
      ? this.checker.getAliasedSymbol(symbol)
      : symbol;
  }

  /** Declarations of a symbol: root symbols of union/mapped properties, aliases followed. */
  private targetNodes(symbol: TS.Symbol): TS.Node[] {
    const resolved = this.resolveAliases(symbol);
    const roots =
      resolved.flags & this.ts.SymbolFlags.Transient
        ? this.checker.getRootSymbols(resolved)
        : [resolved];
    // One use of a declaration is one target, however many instantiations reach it.
    const nodes = new Set<TS.Node>();
    for (const root of roots) {
      const first = this.resolveAliases(root).declarations?.[0];
      if (first !== undefined) nodes.add(first);
    }
    return [...nodes];
  }

  private moduleTarget(
    spec: TS.StringLiteralLike,
    sf: TS.SourceFile,
  ): { kind: 'file'; path: string } | { kind: 'external' | 'outside' | 'unresolved' | 'bare' } {
    const ts = this.ts;
    const declaration = this.checker.getSymbolAtLocation(spec)?.declarations?.[0];
    let fileName: string | undefined;
    if (declaration !== undefined && ts.isSourceFile(declaration)) fileName = declaration.fileName;
    else if (declaration !== undefined)
      return { kind: 'external' }; // `declare module "x"`
    else {
      const resolved = ts.resolveModuleName(
        spec.text,
        sf.fileName,
        this.program.getCompilerOptions(),
        ts.sys,
        undefined,
        undefined,
        this.program.getModeForUsageLocation(sf, spec),
      );
      fileName = resolved.resolvedModule?.resolvedFileName;
    }
    if (fileName === undefined) {
      return { kind: this.isInRepoSpecifier(spec.text) ? 'unresolved' : 'bare' };
    }
    const path = this.repoPath(fileName);
    if (path === null) return { kind: 'external' };
    return this.scope.indexable.has(path) ? { kind: 'file', path } : { kind: 'outside' };
  }

  /** Relative, `paths` alias or workspace package specifiers point into the repository. */
  private isInRepoSpecifier(text: string): boolean {
    if (text.startsWith('.') || text.startsWith('/')) return true;
    for (const pattern of Object.keys(this.program.getCompilerOptions().paths ?? {})) {
      const star = pattern.indexOf('*');
      if (star === -1 ? text === pattern : text.startsWith(pattern.slice(0, star))) return true;
    }
    for (const name of this.scope.workspacePackages) {
      if (text === name || text.startsWith(`${name}/`)) return true;
    }
    return false;
  }

  resolveFile(sf: TS.SourceFile): FileResolution {
    const ts = this.ts;
    const checker = this.checker;
    const file = this.repoPath(sf.fileName) ?? sf.fileName;
    const declarations = this.declarationsOf(sf);
    const edges = new Map<string, EdgeRecord>();
    const unresolved = new Map<string, UnresolvedRecord>();
    const gaps = new Map<string, GapRecord>();
    const externalImports = new Map<string, ExternalImport>();
    const counts: ResolveCounts = {
      indexed: 0,
      local: 0,
      external: 0,
      externalUnresolved: 0,
      unresolvedOther: 0,
      outsideScope: 0,
    };
    const test = isTestFile(file);
    const line = (node: TS.Node): number =>
      sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

    const addEdge = (source: string, target: string, kind: EdgeKind, at: number): void => {
      const id = `${source}\u0000${target}\u0000${kind}`;
      const existing = edges.get(id);
      if (existing === undefined) {
        edges.set(id, { source, target, kind, strength: 'compiler', lines: [at] });
      } else if (!existing.lines.includes(at)) {
        existing.lines.push(at);
      }
    };
    const addUnresolved = (record: UnresolvedRecord): void => {
      unresolved.set(`${record.line}\u0000${record.name}\u0000${record.reason}`, record);
    };
    const addGap = (record: GapRecord): void => {
      gaps.set(`${record.line}\u0000${record.code}\u0000${record.detail}`, record);
    };

    const edgeTo = (source: string, node: TS.Node, kind: EdgeKind, at: number): Target => {
      const target = this.targetOfDeclaration(node);
      if (target === 'external') counts.external++;
      else if (target === 'outside') counts.outsideScope++;
      else if (target === 'local') counts.local++;
      else {
        counts.indexed++;
        addEdge(source, target.key, kind, at);
      }
      return target;
    };

    /** File-level IMPORTS (and TESTS) edge, or a record of why there is none. */
    const fileImport = (spec: TS.StringLiteralLike, at: TS.Node): string | null => {
      const target = this.moduleTarget(spec, sf);
      if (target.kind === 'file') {
        const moduleKey = `${target.path}#${MODULE_NAME}`;
        counts.indexed++;
        addEdge(declarations.moduleKey, moduleKey, 'IMPORTS', line(at));
        if (test) addEdge(declarations.moduleKey, moduleKey, 'TESTS', line(at));
        return target.path;
      }
      if (target.kind === 'unresolved') {
        addUnresolved({
          file,
          line: line(at),
          name: spec.text,
          reason: 'unresolved-import',
          source: enclosingKey(at, declarations),
        });
        return null;
      }
      if (target.kind === 'outside') counts.outsideScope++;
      else if (target.kind === 'external') counts.external++;
      else counts.externalUnresolved++;
      if (target.kind !== 'outside' && !spec.text.startsWith('.')) {
        externalImports.set(`${spec.text}\u0000${line(at)}`, {
          file,
          specifier: spec.text,
          line: line(at),
        });
      }
      return null;
    };

    /** An import or re-export binding is unresolved when the module has no such export. */
    const binding = (name: TS.Node, imported: string, at: TS.Node): void => {
      const symbol = checker.getSymbolAtLocation(name);
      if (symbol === undefined) return;
      if ((this.resolveAliases(symbol).declarations ?? []).length > 0) return;
      addUnresolved({
        file,
        line: line(at),
        name: imported,
        reason: 'unresolved-import',
        source: declarations.moduleKey,
      });
    };

    const kindOfUse = (id: TS.Node, targetIsClass: boolean): EdgeKind => {
      let expr: TS.Node = id;
      const parent = id.parent;
      if (
        (ts.isPropertyAccessExpression(parent) && parent.name === id) ||
        (ts.isQualifiedName(parent) && parent.right === id) ||
        (ts.isElementAccessExpression(parent) && parent.argumentExpression === id)
      ) {
        expr = parent;
      }
      while (
        ts.isParenthesizedExpression(expr.parent) ||
        ts.isNonNullExpression(expr.parent) ||
        ts.isAsExpression(expr.parent) ||
        ts.isSatisfiesExpression(expr.parent)
      ) {
        expr = expr.parent;
      }
      const user = expr.parent;
      if (ts.isNewExpression(user) && user.expression === expr) {
        return targetIsClass ? 'CONSTRUCTS' : 'CALLS';
      }
      if (ts.isCallExpression(user) && user.expression === expr) return 'CALLS';
      if (ts.isTaggedTemplateExpression(user) && user.tag === expr) return 'CALLS';
      if (ts.isDecorator(user) && user.expression === expr) return 'CALLS';
      return 'REFERENCES';
    };

    const isAbstractOrInterfaceMember = (node: TS.Node): boolean =>
      ((ts.isMethodSignature(node) || ts.isPropertySignature(node)) &&
        ts.isInterfaceDeclaration(node.parent)) ||
      ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Abstract) !== 0);

    /** Names being declared, labels and syntax are not uses. */
    const isNotUse = (id: TS.Identifier | TS.PrivateIdentifier): boolean => {
      const parent = id.parent;
      if (ts.isShorthandPropertyAssignment(parent)) return false;
      if (ts.isMetaProperty(parent) || ts.isLabeledStatement(parent)) return true;
      if (ts.isBreakOrContinueStatement(parent) || ts.isTypePredicateNode(parent)) return true;
      if (ts.isNamedTupleMember(parent) || ts.isJSDocParameterTag(parent)) return true;
      // `exports.x = …`, `module.exports.x = …`: the CommonJS declaration's own name
      if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
        return declarations.keyOf.has(parent);
      }
      return (
        this.declarationKinds.has(parent.kind) &&
        'name' in parent &&
        (parent as TS.NamedDeclaration).name === id
      );
    };

    const use = (id: TS.Node, symbol: TS.Symbol): void => {
      const at = line(id);
      // A use of a broken import binding: the import site already holds the unresolved record.
      if ((this.resolveAliases(symbol).declarations ?? []).length === 0) return;
      const source = enclosingKey(id, declarations);
      const isClass = (this.resolveAliases(symbol).flags & ts.SymbolFlags.Class) !== 0;
      const kind = kindOfUse(id, isClass);
      for (const node of this.targetNodes(symbol)) {
        const target = edgeTo(source, node, kind, at);
        if (typeof target === 'object' && kind === 'CALLS' && isAbstractOrInterfaceMember(node)) {
          addGap({ file, line: at, code: 'interface-dispatch', detail: target.key, source });
        }
      }
    };

    // One contextual type per literal, not per property (it was 28% of resolve time on oh-my-pi).
    const contextual = new Map<TS.ObjectLiteralExpression, TS.Type | undefined>();
    const contextualTypeOf = (literal: TS.ObjectLiteralExpression): TS.Type | undefined => {
      if (!contextual.has(literal)) contextual.set(literal, checker.getContextualType(literal));
      return contextual.get(literal);
    };

    /**
     * The property `name` of a type; of each member when the type is a union (`A | B`, or
     * `A | undefined` for an optional parameter), where a union-wide property may not exist.
     */
    const propertiesOfType = (type: TS.Type | undefined, name: string): TS.Symbol[] => {
      if (type === undefined) return [];
      const found = new Set<TS.Symbol>();
      for (const part of type.isUnion() ? type.types : [type]) {
        const property = checker.getPropertyOfType(checker.getApparentType(part), name);
        if (property !== undefined) found.add(property);
      }
      return [...found];
    };

    const identifier = (id: TS.Identifier | TS.PrivateIdentifier): void => {
      const parent = id.parent;
      // `const { a } = obj`: the binding names a property of obj's type as well as a local.
      if (
        ts.isBindingElement(parent) &&
        parent.name === id &&
        parent.propertyName === undefined &&
        ts.isObjectBindingPattern(parent.parent)
      ) {
        for (const property of propertiesOfType(
          checker.getTypeAtLocation(parent.parent),
          id.text,
        )) {
          use(id, property);
        }
        return;
      }
      // `{ a: 1 }`, `{ a() {} }`, `{ a }` typed by context: the literal's property implements the
      // contextual one. A shorthand also uses the value it names, below.
      if (
        (ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isShorthandPropertyAssignment(parent)) &&
        parent.name === id &&
        ts.isObjectLiteralExpression(parent.parent)
      ) {
        for (const property of propertiesOfType(contextualTypeOf(parent.parent), id.text)) {
          if (!(property.declarations ?? []).includes(parent)) use(id, property);
        }
        if (!ts.isShorthandPropertyAssignment(parent)) return;
      }
      if (isNotUse(id)) return;
      const symbol =
        ts.isShorthandPropertyAssignment(parent) && parent.name === id
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(id);
      if (symbol !== undefined) {
        use(id, symbol);
        return;
      }
      const name = id.text;
      if (name === 'exports' || name === 'module' || name === 'require' || name === 'undefined') {
        return;
      }
      if (this.scope.declarationNames.has(name)) {
        addUnresolved({
          file,
          line: line(id),
          name,
          reason: 'unresolved-name-match',
          source: enclosingKey(id, declarations),
        });
      } else {
        counts.unresolvedOther++;
      }
    };

    // A literal that names a property is a use of it: `T["k"]`, and the key of `{ "k": v }` or
    // `{ 11: v }` typed by context, like the identifier forms above.
    const propertyNameLiteral = (node: TS.StringLiteralLike | TS.NumericLiteral): void => {
      const parent = node.parent;
      if (
        ts.isLiteralTypeNode(parent) &&
        ts.isIndexedAccessTypeNode(parent.parent) &&
        parent.parent.indexType === parent
      ) {
        for (const property of propertiesOfType(
          checker.getTypeFromTypeNode(parent.parent.objectType),
          node.text,
        )) {
          use(node, property);
        }
        return;
      }
      if (
        (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
        parent.name === node &&
        ts.isObjectLiteralExpression(parent.parent)
      ) {
        for (const property of propertiesOfType(contextualTypeOf(parent.parent), node.text)) {
          if (!(property.declarations ?? []).includes(parent)) use(node, property);
        }
      }
    };

    const heritage = (node: TS.ClassLikeDeclaration | TS.InterfaceDeclaration): void => {
      const ownerKey = declarations.keyOf.get(node);
      if (ownerKey === undefined) return;
      for (const clause of node.heritageClauses ?? []) {
        const isImplements = clause.token === ts.SyntaxKind.ImplementsKeyword;
        // A class `extends` is an ordinary reference; implements and interface extension are kept.
        if (ts.isClassLike(node) && !isImplements) continue;
        for (const typeNode of clause.types) {
          const expression = typeNode.expression;
          const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
          const symbol = checker.getSymbolAtLocation(name);
          if (symbol === undefined) continue;
          for (const declaration of this.targetNodes(symbol)) {
            const target = this.targetOfDeclaration(declaration);
            if (typeof target === 'object') {
              addEdge(ownerKey, target.key, 'IMPLEMENTS', line(typeNode));
            }
          }
          if (!ts.isClassLike(node)) continue;
          const implemented = checker.getTypeAtLocation(typeNode);
          for (const member of node.members) {
            const memberKey = declarations.keyOf.get(member);
            const memberName = member.name;
            if (memberKey === undefined || memberName === undefined) continue;
            if (!ts.isIdentifier(memberName) && !ts.isStringLiteral(memberName)) continue;
            const property = checker.getPropertyOfType(implemented, memberName.text);
            for (const declaration of property?.declarations ?? []) {
              const target = this.targetOfDeclaration(declaration);
              if (typeof target === 'object') {
                addEdge(memberKey, target.key, 'IMPLEMENTS', line(memberName));
              }
            }
          }
        }
      }
    };

    const staticPrefix = (arg: TS.Expression): string => {
      let head = '';
      if (ts.isTemplateExpression(arg)) head = arg.head.text;
      else if (ts.isBinaryExpression(arg) && ts.isStringLiteralLike(arg.left)) head = arg.left.text;
      if (!head.startsWith('.')) return head === '' ? '*' : head;
      // normalize keeps a trailing slash, so `./handlers/` stays a directory prefix
      return posix.normalize(posix.join(posix.dirname(file), head));
    };

    const call = (node: TS.CallExpression): void => {
      const [arg] = node.arguments;
      if (arg === undefined) return;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (ts.isStringLiteralLike(arg)) {
          fileImport(arg, node);
          return;
        }
        addGap({
          file,
          line: line(node),
          code: 'dynamic-import',
          detail: staticPrefix(arg),
          source: enclosingKey(node, declarations),
        });
        return;
      }
      const isRequire =
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        node.arguments.length === 1;
      if (!isRequire) return;
      const source = enclosingKey(node, declarations);
      if (!ts.isStringLiteralLike(arg)) {
        addGap({ file, line: line(node), code: 'cjs-require', detail: '*', source });
        return;
      }
      // TypeScript binds `require` only in JavaScript files; in TypeScript its result is untyped.
      const bound = checker.getSymbolAtLocation(arg) !== undefined;
      const path = fileImport(arg, node);
      if (!bound) {
        addGap({ file, line: line(node), code: 'cjs-require', detail: path ?? arg.text, source });
      }
    };

    const elementAccess = (node: TS.ElementAccessExpression): void => {
      const argument = node.argumentExpression;
      if (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument)) {
        // `obj['literal']` is a use of that member.
        const symbol = checker.getSymbolAtLocation(argument);
        if (symbol !== undefined) use(argument, symbol);
        return;
      }
      const receiver = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      if (!ts.isIdentifier(receiver)) return;
      const symbol = checker.getSymbolAtLocation(receiver);
      if (symbol === undefined) return;
      for (const declaration of this.targetNodes(symbol)) {
        const target = this.targetOfDeclaration(declaration);
        if (typeof target !== 'object') continue;
        const holdsMembers =
          ts.isClassLike(declaration) ||
          ts.isEnumDeclaration(declaration) ||
          ts.isModuleDeclaration(declaration) ||
          (ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            ts.isObjectLiteralExpression(declaration.initializer));
        if (holdsMembers) {
          addGap({
            file,
            line: line(node),
            code: 'computed-member-access',
            detail: target.key,
            source: enclosingKey(node, declarations),
          });
        }
      }
    };

    const visit = (node: TS.Node): void => {
      // JSDoc types (JavaScript) and {@link} references are uses too; each comment once, from its host.
      if ('jsDoc' in node) {
        for (const doc of ts.getJSDocCommentsAndTags(node)) {
          const host: TS.Node = doc.parent;
          if (ts.isJSDoc(doc) && host === node) ts.forEachChild(doc, visit);
        }
      }
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        identifier(node);
        return;
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const target = fileImport(node.moduleSpecifier, node);
        const clause = node.importClause;
        if (target !== null && clause !== undefined) {
          if (clause.name !== undefined) binding(clause.name, 'default', node);
          const bindings = clause.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              binding(element.name, (element.propertyName ?? element.name).text, element);
            }
          }
        }
        return; // import bindings are not uses; the file-level IMPORTS edge records them
      }
      if (ts.isExportDeclaration(node)) {
        const spec = node.moduleSpecifier;
        const clause = node.exportClause;
        // `export { a }` names local declarations: their export status, not a use
        if (spec === undefined || !ts.isStringLiteralLike(spec)) return;
        if (fileImport(spec, node) === null || clause === undefined) return;
        if (ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            binding(element.name, (element.propertyName ?? element.name).text, element);
          }
        }
        return; // re-exports are recorded in the exports table
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        fileImport(node.moduleReference.expression, node);
        return;
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        fileImport(node.argument.literal, node);
      }
      if (ts.isCallExpression(node)) call(node);
      if (ts.isElementAccessExpression(node)) elementAccess(node);
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) propertyNameLiteral(node);
      if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) heritage(node);
      ts.forEachChild(node, visit);
    };

    const syntaxError = this.program.getSyntacticDiagnostics(sf)[0];
    if (syntaxError !== undefined) {
      const at = sf.getLineAndCharacterOfPosition(syntaxError.start ?? 0).line + 1;
      addGap({ file, line: at, code: 'parse-error', detail: file, source: declarations.moduleKey });
    }
    ts.forEachChild(sf, visit);

    const exports = this.exportsOf(sf, file);
    const surface = surfaceOf(ts, sf, declarations);
    return {
      file,
      edges: [...edges.values()].map((edge) => ({
        ...edge,
        lines: [...edge.lines].sort((a, b) => a - b),
      })),
      unresolved: [...unresolved.values()],
      gaps: [...gaps.values()],
      tokens: this.tokensOf(sf, file),
      externalImports: [...externalImports.values()],
      exports,
      surface: surface.hash,
      observableKeys: surface.observableKeys,
      global: isGlobalFile(this.ts, this.checker, sf),
      counts,
    };
  }

  private exportsOf(sf: TS.SourceFile, file: string): ExportRecord[] {
    const moduleSymbol = this.checker.getSymbolAtLocation(sf);
    if (moduleSymbol === undefined) return [];
    const records: ExportRecord[] = [];
    for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
      for (const node of this.targetNodes(exported)) {
        const target = this.targetOfDeclaration(node);
        if (typeof target === 'object')
          records.push({ file, name: exported.name, target: target.key });
      }
    }
    return records;
  }

  /** String literals whose text is an indexed declaration's simple name. */
  private tokensOf(sf: TS.SourceFile, file: string): NameToken[] {
    const ts = this.ts;
    const names = this.scope.declarationNames;
    const found = new Map<string, NameToken>();
    const walk = (node: TS.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        names.has(node.text)
      ) {
        const at = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const token = found.get(node.text);
        if (token === undefined)
          found.set(node.text, { file, name: node.text, kind: 'str', lines: [at] });
        else if (token.lines[token.lines.length - 1] !== at) token.lines.push(at);
      }
      ts.forEachChild(node, walk);
    };
    ts.forEachChild(sf, walk);
    return [...found.values()];
  }
}
