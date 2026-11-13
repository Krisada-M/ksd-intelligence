import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type * as TS from 'typescript';
import { enclosingKey, fileDeclarations, type FileDeclarations, type Ts } from './declarations.js';
import { groupPrograms } from './program.js';

/** A reference TypeScript reports inside the index scope that the index does not hold. */
export interface DifferentialMiss {
  declaration: string;
  file: string;
  line: number;
  /** Source text of the reference's line, trimmed. */
  text: string;
  /** Syntax around the reference, innermost first, as the starting point for a cause. */
  context: string;
}

export interface DifferentialReport {
  declarations: number;
  references: number;
  /** References the index holds: `edge` + `exportStatus` + `recordOnly`. */
  covered: number;
  coveredBy: {
    /** An edge from the enclosing symbol at the line (an IMPORTS edge for a binding). */
    edge: number;
    /** `export { x }`: recorded as the declaration's export status, not as an edge. */
    exportStatus: number;
    /** No edge: only an unresolved record or gap site on the same line accounts for it. */
    recordOnly: number;
  };
  /** References not checked, by reason (outside the scope, definitions, unindexed targets). */
  skipped: Record<string, number>;
  /** References inside JSDoc comments (`{@link}`, `@see`, …): documentation, not dependencies. */
  docOnly: number;
  misses: DifferentialMiss[];
}

interface Sample {
  key: string;
  file: string;
}

/** Deterministic sample: every declaration when `size` is 0, else `size` of them by a seeded shuffle. */
function sample(db: DatabaseSync, size: number, seed: number): Sample[] {
  const rows = db
    .prepare(
      `SELECT s.key AS key, d.file AS file FROM declarations d JOIN symbols s ON s.id = d.id
       WHERE d.name != '<module>' ORDER BY s.key`,
    )
    .all()
    .map((row) => ({ key: String(row.key), file: String(row.file) }));
  if (size <= 0 || size >= rows.length) return rows;
  let state = seed >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = rows[i];
    const other = rows[j];
    if (swap === undefined || other === undefined) continue;
    rows[i] = other;
    rows[j] = swap;
  }
  return rows.slice(0, size).sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Ranges of every JSDoc comment of a file: `[pos, end)`. */
function jsDocRanges(ts: Ts, sf: TS.SourceFile): [number, number][] {
  const ranges: [number, number][] = [];
  const visit = (node: TS.Node): void => {
    if ('jsDoc' in node && Array.isArray(node.jsDoc)) {
      for (const doc of node.jsDoc) if (ts.isJSDoc(doc)) ranges.push([doc.pos, doc.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return ranges;
}

function nameNode(ts: Ts, node: TS.Node): TS.Node | undefined {
  if (ts.isBinaryExpression(node)) {
    const left = node.left;
    return ts.isPropertyAccessExpression(left) ? left.name : undefined;
  }
  if (ts.isSourceFile(node)) return undefined;
  const name = ts.getNameOfDeclaration(node as TS.Declaration);
  return name;
}

/** The innermost node at a position. */
function nodeAt(ts: Ts, sf: TS.SourceFile, position: number): TS.Node {
  let current: TS.Node = sf;
  for (;;) {
    let next: TS.Node | undefined;
    ts.forEachChild(current, (child) => {
      if (next === undefined && child.getStart(sf) <= position && position < child.getEnd()) {
        next = child;
      }
    });
    if (next === undefined) return current;
    current = next;
  }
}

function contextOf(ts: Ts, node: TS.Node): string {
  const kinds: string[] = [];
  let current: TS.Node | undefined = node;
  for (let depth = 0; current !== undefined && depth < 4; depth++) {
    kinds.push(ts.SyntaxKind[current.kind] ?? String(current.kind));
    current = current.parent;
  }
  return kinds.join(' < ');
}

function insideImportOrReexport(ts: Ts, node: TS.Node): TS.Node | 'local-export' | null {
  for (let current: TS.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isImportEqualsDeclaration(current)) return current;
    if (ts.isExportDeclaration(current)) {
      return current.moduleSpecifier === undefined ? 'local-export' : current;
    }
    if (ts.isStatement(current)) return null;
  }
  return null;
}

/**
 * D36 differential test: for sampled indexed declarations, every reference TypeScript's language
 * service reports inside the index scope must be an edge in the index at that line, or a recorded
 * unresolved use or gap site there. Import and re-export bindings must have their file-level
 * IMPORTS edge (ADR 0003 stores bindings at file level).
 */
export function differential(
  ts: Ts,
  root: string,
  db: DatabaseSync,
  options: { size: number; seed?: number },
): DifferentialReport {
  const owners = new Map<string, string[]>();
  const indexable = new Set<string>();
  for (const row of db
    .prepare("SELECT path, tsconfig FROM files WHERE status = 'indexable'")
    .all()) {
    const path = String(row.path);
    indexable.add(path);
    if (row.tsconfig === null) continue;
    const list = owners.get(String(row.tsconfig)) ?? [];
    list.push(path);
    owners.set(String(row.tsconfig), list);
  }
  const ownerOf = new Map<string, string>();
  for (const [config, files] of owners) for (const file of files) ownerOf.set(file, config);

  const edgeLines = db.prepare(
    `SELECT e.lines AS lines FROM edges e JOIN symbols s ON s.id = e.source
     JOIN symbols t ON t.id = e.target WHERE s.key = ? AND t.key = ?`,
  );
  const importLines = db.prepare(
    `SELECT e.lines AS lines FROM edges e JOIN symbols s ON s.id = e.source
     WHERE s.key = ? AND e.kind = 'IMPORTS'`,
  );
  const recorded = db.prepare(
    `SELECT 1 FROM gap_sites WHERE file = ? AND line = ?
     UNION ALL SELECT 1 FROM unresolved WHERE file = ? AND line = ? LIMIT 1`,
  );
  const hasLine = (rows: Record<string, unknown>[], line: number): boolean =>
    rows.some((row) => {
      const lines: unknown = JSON.parse(String(row.lines));
      return Array.isArray(lines) && lines.includes(line);
    });

  const report: DifferentialReport = {
    declarations: 0,
    references: 0,
    covered: 0,
    coveredBy: { edge: 0, exportStatus: 0, recordOnly: 0 },
    skipped: {},
    docOnly: 0,
    misses: [],
  };
  const skip = (reason: string): void => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };

  const samples = sample(db, options.size, options.seed ?? 1);
  const { groups } = groupPrograms(ts, root, owners);
  for (const group of groups) {
    const members = samples.filter((s) => group.configs.includes(ownerOf.get(s.file) ?? ''));
    if (members.length === 0) continue;
    const host: TS.LanguageServiceHost = {
      getCompilationSettings: () => group.options,
      getScriptFileNames: () => group.rootNames,
      getScriptVersion: () => '1',
      getScriptSnapshot: (fileName) => {
        const text = ts.sys.readFile(fileName);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => root,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
    };
    const service = ts.createLanguageService(host, ts.createDocumentRegistry());
    const program = service.getProgram();
    if (program === undefined) continue;
    const declarationsCache = new Map<string, FileDeclarations>();
    const declarationsOf = (path: string, sf: TS.SourceFile): FileDeclarations => {
      let found = declarationsCache.get(path);
      if (found === undefined) {
        found = fileDeclarations(ts, sf, path);
        declarationsCache.set(path, found);
      }
      return found;
    };
    const docRanges = new Map<string, [number, number][]>();
    const insideJsDoc = (sf: TS.SourceFile, position: number): boolean => {
      let ranges = docRanges.get(sf.fileName);
      if (ranges === undefined) {
        ranges = jsDocRanges(ts, sf);
        docRanges.set(sf.fileName, ranges);
      }
      return ranges.some(([pos, end]) => pos <= position && position < end);
    };
    const keyAtName = (path: string, sf: TS.SourceFile, start: number): string | undefined => {
      for (const [node, key] of declarationsOf(path, sf).keyOf) {
        const name = nameNode(ts, node);
        if (name === undefined) continue;
        // TypeScript's span of a quoted name (`"tab.shell": …`) starts inside the quotes.
        if (name.getStart(sf) + (ts.isStringLiteralLike(name) ? 1 : 0) === start) return key;
      }
      return undefined;
    };

    /** The indexed declaration a group of references belongs to. */
    const targetOf = (
      definition: TS.ReferencedSymbolDefinitionInfo,
      queried: string,
    ): string | undefined => {
      // An import or re-export binding is the queried declaration under another name.
      if (definition.kind === ts.ScriptElementKind.alias) return queried;
      const path = repoPath(root, definition.fileName);
      const file = path === null ? undefined : program.getSourceFile(definition.fileName);
      if (path === null || file === undefined) return undefined;
      return keyAtName(path, file, definition.textSpan.start);
    };

    for (const { key, file } of members) {
      const sf = program.getSourceFile(join(root, file));
      if (sf === undefined) continue;
      const entry = [...declarationsOf(file, sf).keyOf].find(([, k]) => k === key);
      const name = entry === undefined ? undefined : nameNode(ts, entry[0]);
      if (name === undefined) {
        skip('declaration without a name node');
        continue;
      }
      report.declarations++;
      for (const symbol of service.findReferences(sf.fileName, name.getStart(sf)) ?? []) {
        const target = targetOf(symbol.definition, key);
        // ADR 0003 explains each kind: parameters, locals, type parameters, members of anonymous
        // types and library declarations are not indexed declarations.
        const outside = repoPath(root, symbol.definition.fileName) === null;
        const unindexed = `target is not an indexed declaration: ${symbol.definition.kind}${outside ? ' (outside the repository)' : ''}`;
        for (const reference of symbol.references) {
          if (reference.isDefinition === true) {
            skip('definition');
            continue;
          }
          const path = repoPath(root, reference.fileName);
          if (path === null || !indexable.has(path)) {
            skip('outside the index scope');
            continue;
          }
          if (target === undefined) {
            skip(unindexed);
            continue;
          }
          const refFile = program.getSourceFile(reference.fileName);
          if (refFile === undefined) continue;
          const start = reference.textSpan.start;
          const line = refFile.getLineAndCharacterOfPosition(start).line + 1;
          if (insideJsDoc(refFile, start)) {
            report.docOnly++;
            continue;
          }
          const node = nodeAt(ts, refFile, start);
          // TypeScript lists the names of related declarations (an implementing or overriding
          // member) among the references; a name is a declaration, not a use, unless it is a
          // shorthand `{ x }`, which is both.
          if (
            keyAtName(path, refFile, start) !== undefined &&
            !ts.isShorthandPropertyAssignment(node.parent)
          ) {
            skip('declaration name of a related symbol');
            continue;
          }
          // `{ x }` is a property and a use of `x`; findReferences on the property also lists the
          // uses of the value `x` itself, which belong to x's declaration, not to the property.
          const sampled = entry?.[0];
          if (sampled !== undefined && ts.isShorthandPropertyAssignment(sampled)) {
            const symbol = program.getTypeChecker().getSymbolAtLocation(node);
            if (symbol !== undefined && !(symbol.declarations ?? []).includes(sampled)) {
              skip('use of the value a shorthand property names');
              continue;
            }
          }
          // A key of an object literal typed by a mapped type over literal keys (`Record<1 | 2, V>`)
          // has no declaration to be a use of: TypeScript relates it to every other literal typed the
          // same way, but none uses another. Keys that have declarations are still checked.
          const member = node.parent;
          if (
            (ts.isPropertyAssignment(member) || ts.isMethodDeclaration(member)) &&
            member.name === node &&
            ts.isObjectLiteralExpression(member.parent) &&
            (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
          ) {
            const properties = contextualProperties(
              program.getTypeChecker(),
              member.parent,
              node.text,
            );
            if (
              properties.length > 0 &&
              properties.every((p) => (p.declarations ?? []).length === 0)
            ) {
              skip('key of an object literal typed by a mapped type (no declaration)');
              continue;
            }
          }
          // The same holds for an access (`map["k"]` on a `Record<"k" | …, V>`): the property it
          // uses has no declaration, so ADR 0003 stores no edge, yet TypeScript lists the access
          // under each object literal's `"k"`.
          const own = program.getTypeChecker().getSymbolAtLocation(node);
          if (own !== undefined && (own.declarations ?? []).length === 0) {
            skip('use of a property of a mapped type (no declaration)');
            continue;
          }
          report.references++;
          const declarations = declarationsOf(path, refFile);
          const binding = insideImportOrReexport(ts, node);
          let by: keyof DifferentialReport['coveredBy'] | null = null;
          if (binding === 'local-export') {
            by = 'exportStatus';
          } else if (binding !== null) {
            const statementLine =
              refFile.getLineAndCharacterOfPosition(binding.getStart(refFile)).line + 1;
            if (hasLine(importLines.all(declarations.moduleKey), statementLine)) by = 'edge';
          } else if (hasLine(edgeLines.all(enclosingKey(node, declarations), target), line)) {
            by = 'edge';
          } else if (recorded.get(path, line, path, line) !== undefined) {
            by = 'recordOnly';
          }
          if (by !== null) {
            report.covered++;
            report.coveredBy[by]++;
            continue;
          }
          report.misses.push({
            declaration: target,
            file: path,
            line,
            text: (refFile.text.split('\n')[line - 1] ?? '').trim().slice(0, 160),
            context: contextOf(ts, node),
          });
        }
      }
    }
    service.dispose();
  }
  return report;
}

/** The property `name` of an object literal's contextual type; of each member for a union. */
function contextualProperties(
  checker: TS.TypeChecker,
  literal: TS.ObjectLiteralExpression,
  name: string,
): TS.Symbol[] {
  const type = checker.getContextualType(literal);
  if (type === undefined) return [];
  const found = new Set<TS.Symbol>();
  for (const part of type.isUnion() ? type.types : [type]) {
    const property = checker.getPropertyOfType(checker.getApparentType(part), name);
    if (property !== undefined) found.add(property);
  }
  return [...found];
}

function repoPath(root: string, fileName: string): string | null {
  if (!fileName.startsWith(`${root}/`)) return null;
  const rel = fileName.slice(root.length + 1);
  return rel.includes('node_modules/') ? null : rel;
}
