'use strict';
// M1b Part B shared helpers. Throwaway spike code: measured facts only, not product code.
// Runs under node and bun (CommonJS). Uses the repo's own typescript (5.9.3), never the measured project's.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ts = require('typescript');

const K = ts.SyntaxKind;
const RUNTIME = process.versions.bun ? 'bun' : 'node';
const OUT_DIR = path.join(__dirname, 'out');
const DEFAULT_SRC = '/var/folders/tj/skmpx5kj42x6jc2zsrkb3fgw0000gn/T/m1b/omp-src';
// realpath: /var -> /private/var on macOS; TS resolves symlinks, so every path must be the real one.
const OMP_SRC = fs.realpathSync(process.env.M1B_SRC || DEFAULT_SRC);
const TMP_ROOT = path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'm1b');

const now = () => performance.now();
const maxRssKB = () => process.resourceUsage().maxRSS; // KB on macOS for both node and bun (checked vs /usr/bin/time -l)
const rssKB = () => Math.round(process.memoryUsage().rss / 1024);
const round1 = (n) => Math.round(n * 10) / 10;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

function ensureOut() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function flattenDiag(d) {
  return ts.flattenDiagnosticMessageText(d.messageText, '\n');
}

// ---------- tsconfig / project discovery ----------

function parseConfig(configPath) {
  const host = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: ts.sys.readDirectory,
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    getCurrentDirectory: () => path.dirname(configPath),
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(`config ${configPath}: ${flattenDiag(d)}`);
    },
  };
  const t0 = now();
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  const ms = now() - t0;
  if (!parsed) throw new Error(`cannot parse ${configPath}`);
  return { configPath, parsed, parseMs: ms };
}

// Projects reachable from `rootConfig` via `references` (post-order, root excluded; root returned separately).
function reachableProjects(rootConfig) {
  const seen = new Set();
  const projects = [];
  const root = parseConfig(rootConfig);
  seen.add(rootConfig);
  (function visit(p) {
    for (const ref of p.parsed.projectReferences || []) {
      const cfg = fs.realpathSync(ts.resolveProjectReferencePath(ref));
      if (seen.has(cfg)) continue;
      seen.add(cfg);
      const child = parseConfig(cfg);
      visit(child);
      projects.push(child);
    }
  })(root);
  return { root, projects };
}

function packageConfigs() {
  const dir = path.join(OMP_SRC, 'packages');
  return fs
    .readdirSync(dir)
    .map((n) => path.join(dir, n, 'tsconfig.json'))
    .filter((p) => fs.existsSync(p))
    .sort();
}

// Aliases: workspace | tools | pkg:<dirname> | an absolute tsconfig path
function resolveAlias(alias) {
  if (alias === 'workspace') return path.join(OMP_SRC, 'packages/tsconfig.workspace.json');
  if (alias === 'tools') return path.join(OMP_SRC, 'tsconfig.tools.json');
  if (alias.startsWith('pkg:')) return path.join(OMP_SRC, 'packages', alias.slice(4), 'tsconfig.json');
  return path.resolve(alias);
}

// Sets: reachable (workspace + tools) | packages (16 per-package tsconfigs) | alias list "a,b,c"
function resolveSet(spec) {
  if (spec === 'reachable') return ['workspace', 'tools'];
  if (spec === 'packages') return packageConfigs().map((p) => 'pkg:' + path.basename(path.dirname(p)));
  return spec.split(',');
}

function aliasName(alias) {
  return alias.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function workspacePackageNames() {
  const names = new Set();
  for (const d of fs.readdirSync(path.join(OMP_SRC, 'packages'))) {
    const p = path.join(OMP_SRC, 'packages', d, 'package.json');
    if (!fs.existsSync(p)) continue;
    try {
      names.add(JSON.parse(fs.readFileSync(p, 'utf8')).name);
    } catch {}
  }
  return names;
}

// ---------- program creation ----------

function createProgramFor(proj, host) {
  const { parsed } = proj;
  return ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    host: host || ts.createCompilerHost(parsed.options),
    configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
  });
}

// Compiler host that keeps SourceFile objects between programs (like a watch host / document registry)
// and overlays edited text in memory. cache:false re-reads and re-parses every file on every program.
function createOverlayHost(options, { cache = true, incremental = false } = {}) {
  const base = incremental ? ts.createIncrementalCompilerHost(options) : ts.createCompilerHost(options);
  const overlay = new Map();
  const sfCache = new Map();
  const stats = { parses: 0, reads: 0, cacheHits: 0 };
  const hash = (t) => ts.sys.createHash(t);
  const host = Object.assign(base, {
    getSourceFile(fileName, languageVersionOrOptions, onError) {
      const ov = overlay.get(fileName);
      const hit = cache ? sfCache.get(fileName) : undefined;
      if (hit && (ov === undefined ? true : hit.text === ov)) {
        stats.cacheHits++;
        return hit.sf;
      }
      let text = ov;
      if (text === undefined) {
        stats.reads++;
        text = ts.sys.readFile(fileName);
      }
      if (text === undefined) return undefined;
      stats.parses++;
      const sf = ts.createSourceFile(fileName, text, languageVersionOrOptions, false);
      sf.version = hash(text);
      if (cache) sfCache.set(fileName, { sf, text });
      return sf;
    },
    readFile: (f) => (overlay.has(f) ? overlay.get(f) : ts.sys.readFile(f)),
    fileExists: (f) => overlay.has(f) || ts.sys.fileExists(f),
    createHash: hash,
  });
  host.overlay = overlay;
  host.sfStats = stats;
  host.readOriginal = (f) => ts.sys.readFile(f);
  host.invalidate = (f) => sfCache.delete(f);
  return host;
}

// ---------- ADR 0003 classification ----------

const SCOPE_BUCKETS = [
  'edge',
  'edge-module',
  'local:binding',
  'local:member',
  'external',
  'no-declaration',
  'unresolved-name-match',
  'unresolved-other',
];

const DECL_NAME_PARENTS = new Set([
  K.FunctionDeclaration,
  K.FunctionExpression,
  K.ClassDeclaration,
  K.ClassExpression,
  K.InterfaceDeclaration,
  K.TypeAliasDeclaration,
  K.EnumDeclaration,
  K.ModuleDeclaration,
  K.VariableDeclaration,
  K.Parameter,
  K.TypeParameter,
  K.PropertyDeclaration,
  K.PropertySignature,
  K.MethodDeclaration,
  K.MethodSignature,
  K.GetAccessor,
  K.SetAccessor,
  K.PropertyAssignment,
  K.EnumMember,
  K.BindingElement,
  K.NamedTupleMember,
  K.ImportClause,
  K.NamespaceImport,
  K.NamespaceExport,
  K.ImportEqualsDeclaration,
  K.NamespaceExportDeclaration,
]);

// Kinds that can be an indexed declaration; used to limit isIndexed() calls during the walk.
const INDEXABLE_KINDS = new Set([
  K.FunctionDeclaration,
  K.ClassDeclaration,
  K.InterfaceDeclaration,
  K.TypeAliasDeclaration,
  K.EnumDeclaration,
  K.ModuleDeclaration,
  K.VariableDeclaration,
  K.BindingElement,
  K.ExportAssignment,
  K.PropertyDeclaration,
  K.MethodDeclaration,
  K.GetAccessor,
  K.SetAccessor,
  K.Constructor,
  K.PropertySignature,
  K.MethodSignature,
  K.EnumMember,
  K.PropertyAssignment,
  K.ShorthandPropertyAssignment,
  K.Parameter,
]);

const MEMBER_KINDS = new Set([
  K.PropertyDeclaration,
  K.PropertySignature,
  K.MethodDeclaration,
  K.MethodSignature,
  K.GetAccessor,
  K.SetAccessor,
  K.Constructor,
  K.PropertyAssignment,
  K.ShorthandPropertyAssignment,
  K.EnumMember,
  K.CallSignature,
  K.ConstructSignature,
  K.IndexSignature,
]);

const WRAPPERS = new Set([K.ParenthesizedExpression, K.AsExpression, K.SatisfiesExpression, K.TypeAssertionExpression, K.NonNullExpression]);

function isWrapper(n) {
  return WRAPPERS.has(n.kind);
}

function isDeclarationNameIdentifier(n) {
  const p = n.parent;
  if (!p) return false;
  if (p.kind === K.ImportSpecifier) return true; // import edge, represented by the use sites
  if (p.kind === K.ExportSpecifier) return p.propertyName !== undefined && p.name === n;
  if (p.kind === K.LabeledStatement || p.kind === K.BreakStatement || p.kind === K.ContinueStatement) return true;
  if (p.kind === K.MetaProperty || p.kind === K.ImportAttribute) return true;
  if (DECL_NAME_PARENTS.has(p.kind)) return p.name === n;
  return false;
}

// Is `node` (a declaration node) an indexed declaration per ADR 0003? Returns a label or null.
function indexedLabel(d) {
  switch (d.kind) {
    case K.FunctionDeclaration:
      return containerOk(d.parent) ? 'function' : null;
    case K.ClassDeclaration:
      return containerOk(d.parent) ? 'class' : null;
    case K.InterfaceDeclaration:
      return containerOk(d.parent) ? 'interface' : null;
    case K.TypeAliasDeclaration:
      return containerOk(d.parent) ? 'type' : null;
    case K.EnumDeclaration:
      return containerOk(d.parent) ? 'enum' : null;
    case K.ModuleDeclaration:
      return containerOk(d.parent) ? 'namespace' : null;
    case K.VariableDeclaration:
      return moduleLevelVariable(d) ? 'variable' : null;
    case K.BindingElement: {
      let n = d.parent;
      while (n && (n.kind === K.ObjectBindingPattern || n.kind === K.ArrayBindingPattern)) {
        const g = n.parent;
        if (g.kind === K.BindingElement) n = g.parent;
        else {
          n = g;
          break;
        }
      }
      return n && n.kind === K.VariableDeclaration && moduleLevelVariable(n) ? 'variable' : null;
    }
    case K.ExportAssignment:
      return d.parent.kind === K.SourceFile ? 'default-export' : null;
    case K.PropertyDeclaration:
    case K.MethodDeclaration:
    case K.GetAccessor:
    case K.SetAccessor:
    case K.Constructor:
    case K.PropertySignature:
    case K.MethodSignature:
    case K.EnumMember:
    case K.PropertyAssignment:
    case K.ShorthandPropertyAssignment: {
      const p = d.parent;
      if (!p) return null;
      if (p.kind === K.ClassDeclaration || p.kind === K.InterfaceDeclaration || p.kind === K.EnumDeclaration) return indexedLabel(p) ? 'member' : null;
      if (p.kind === K.ObjectLiteralExpression) return objectLiteralMemberOk(p) ? 'object-member' : null;
      return null; // TypeLiteral (anonymous), class expression, ...
    }
    case K.Parameter: {
      const p = d.parent;
      if (!p || p.kind !== K.Constructor) return null;
      const mods = ts.getCombinedModifierFlags(d);
      const isParamProp = mods & (ts.ModifierFlags.Public | ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Readonly | ts.ModifierFlags.Override);
      return isParamProp && p.parent.kind === K.ClassDeclaration && indexedLabel(p.parent) ? 'member' : null;
    }
    default:
      return null;
  }
}

function containerOk(parent) {
  if (!parent) return false;
  if (parent.kind === K.SourceFile) return true;
  if (parent.kind === K.ModuleBlock) return indexedLabel(parent.parent) !== null;
  if (parent.kind === K.ModuleDeclaration) return indexedLabel(parent) !== null; // namespace A.B {}
  return false;
}

function moduleLevelVariable(d) {
  const list = d.parent;
  if (!list || list.kind !== K.VariableDeclarationList) return false;
  const stmt = list.parent;
  return !!stmt && stmt.kind === K.VariableStatement && containerOk(stmt.parent);
}

// literal is the ObjectLiteralExpression owning the member; ok when bound to a module-level variable within 3 levels.
function objectLiteralMemberOk(literal) {
  let depth = 1;
  let n = literal;
  for (;;) {
    let p = n.parent;
    while (p && isWrapper(p)) p = p.parent;
    if (!p) return false;
    if (p.kind === K.VariableDeclaration) return depth <= 3 && !!p.initializer && stripWrappers(p.initializer) === n && moduleLevelVariable(p);
    if (p.kind === K.PropertyAssignment && p.initializer && stripWrappers(p.initializer) === n) {
      const owner = p.parent;
      if (!owner || owner.kind !== K.ObjectLiteralExpression) return false;
      depth++;
      if (depth > 3) return false;
      n = owner;
      continue;
    }
    return false;
  }
}

function stripWrappers(e) {
  while (e && isWrapper(e)) e = e.expression;
  return e;
}

function declName(d) {
  if (d.kind === K.ExportAssignment) return 'default';
  const n = d.name;
  if (!n) return d.kind === K.Constructor ? 'constructor' : 'default';
  if (n.kind === K.Identifier || n.kind === K.PrivateIdentifier) return n.text;
  if (n.kind === K.StringLiteral || n.kind === K.NumericLiteral || n.kind === K.NoSubstitutionTemplateLiteral) return n.text;
  return null;
}

// Enumerate indexed declarations of one source file (no descent into function bodies).
function enumerateIndexed(sf, onDecl) {
  const members = (list, label) => {
    for (const m of list) {
      if (m.kind === K.IndexSignature || m.kind === K.CallSignature || m.kind === K.ConstructSignature || m.kind === K.ClassStaticBlockDeclaration || m.kind === K.SemicolonClassElement) continue;
      onDecl(m, 'member');
    }
  };
  const objectMembers = (lit, depth) => {
    for (const m of lit.properties) {
      if (m.kind === K.SpreadAssignment) continue;
      onDecl(m, 'object-member');
      if (depth < 3 && m.kind === K.PropertyAssignment) {
        const v = stripWrappers(m.initializer);
        if (v && v.kind === K.ObjectLiteralExpression) objectMembers(v, depth + 1);
      }
    }
  };
  const bindingNames = (pattern) => {
    for (const el of pattern.elements) {
      if (el.kind !== K.BindingElement) continue;
      if (el.name.kind === K.Identifier) onDecl(el, 'variable');
      else bindingNames(el.name);
    }
  };
  const stmt = (s) => {
    switch (s.kind) {
      case K.FunctionDeclaration:
        return onDecl(s, 'function');
      case K.ClassDeclaration:
        onDecl(s, 'class');
        return members(s.members);
      case K.InterfaceDeclaration:
        onDecl(s, 'interface');
        return members(s.members);
      case K.TypeAliasDeclaration:
        return onDecl(s, 'type');
      case K.EnumDeclaration:
        onDecl(s, 'enum');
        return members(s.members);
      case K.ModuleDeclaration: {
        onDecl(s, 'namespace');
        let b = s.body;
        while (b && b.kind === K.ModuleDeclaration) {
          onDecl(b, 'namespace');
          b = b.body;
        }
        if (b && b.kind === K.ModuleBlock) for (const x of b.statements) stmt(x);
        return;
      }
      case K.VariableStatement:
        for (const v of s.declarationList.declarations) {
          if (v.name.kind === K.Identifier) {
            onDecl(v, 'variable');
            const init = stripWrappers(v.initializer);
            if (init && init.kind === K.ObjectLiteralExpression) objectMembers(init, 1);
          } else bindingNames(v.name);
        }
        return;
      case K.ExportAssignment:
        return onDecl(s, 'default-export');
      default:
    }
  };
  for (const s of sf.statements) stmt(s);
}

// ADR 0003 resolve pass factory. One resolver per program (per checker).
function createResolver(program, opts = {}) {
  const { uniqAll = false, collectImporters = false } = opts;
  const checker = program.getTypeChecker();
  const rootPrefix = OMP_SRC + path.sep;
  const wsNames = workspacePackageNames();
  const scopeCache = new Map();
  const fileIds = new Map();
  const fileIdOf = (sf) => {
    let id = fileIds.get(sf);
    if (id === undefined) fileIds.set(sf, (id = fileIds.size));
    return id;
  };
  const inScope = (sf) => {
    let v = scopeCache.get(sf);
    if (v === undefined) {
      const f = sf.fileName;
      v = f.startsWith(rootPrefix) && !f.includes('/node_modules/') && !program.isSourceFileDefaultLibrary(sf);
      scopeCache.set(sf, v);
    }
    return v;
  };

  const names = new Set(); // names of indexed declarations in scope (for unresolved-name-match)
  const declCounts = {}; // indexed declarations by label, own files only
  const declCountsAllScope = {};

  const state = {
    identifiers: 0,
    skippedDeclNames: 0,
    uses: Object.fromEntries(SCOPE_BUCKETS.map((b) => [b, 0])),
    edgeKinds: { CALLS: 0, CONSTRUCTS: 0, REFERENCES: 0 },
    edgeRecords: { CALLS: new Set(), CONSTRUCTS: new Set(), REFERENCES: new Set() },
    uniq: Object.fromEntries(SCOPE_BUCKETS.map((b) => [b, new Set()])),
    unresolvedNameSamples: [],
    imports: { total: 0, resolved: 0, 'resolved-external': 0, ambient: 0, 'unresolved-import': 0, 'external-unresolved': 0 },
    importSamples: { 'unresolved-import': [], 'external-unresolved': [] },
    files: 0,
    lines: 0,
  };
  const importers = collectImporters ? new Map() : null; // target key -> {decl, files:Set}

  function declPass(files, ownSet) {
    for (const sf of files) {
      if (!inScope(sf)) continue;
      const own = ownSet.has(sf);
      enumerateIndexed(sf, (d, label) => {
        const n = declName(d);
        if (n !== null) names.add(n);
        declCountsAllScope[label] = (declCountsAllScope[label] || 0) + 1;
        if (own) declCounts[label] = (declCounts[label] || 0) + 1;
      });
    }
  }

  function useKind(n, sym) {
    let e = n;
    while (e.parent && ((e.parent.kind === K.PropertyAccessExpression && e.parent.name === e) || (e.parent.kind === K.QualifiedName && e.parent.right === e))) e = e.parent;
    while (e.parent && (e.parent.kind === K.NonNullExpression || e.parent.kind === K.ParenthesizedExpression)) e = e.parent;
    const p = e.parent;
    if (!p) return 'REFERENCES';
    if (p.kind === K.CallExpression && p.expression === e) return 'CALLS';
    if (p.kind === K.NewExpression && p.expression === e) return sym.flags & ts.SymbolFlags.Class ? 'CONSTRUCTS' : 'CALLS';
    if (p.kind === K.TaggedTemplateExpression && p.tag === e) return 'CALLS';
    return 'REFERENCES';
  }

  function note(bucket, key) {
    state.uses[bucket]++;
    if (uniqAll) state.uniq[bucket].add(key);
  }

  function resolveFile(sf) {
    const fid = fileIdOf(sf);
    let enclosing = null;
    let encKey = fid + ':M';
    state.files++;
    state.lines += sf.getLineAndCharacterOfPosition(sf.end).line + 1;

    const handleIdentifier = (n) => {
      const parent = n.parent;
      if (isDeclarationNameIdentifier(n)) {
        state.skippedDeclNames++;
        return;
      }
      state.identifiers++;
      let sym;
      if (parent.kind === K.ShorthandPropertyAssignment && parent.name === n) sym = checker.getShorthandAssignmentValueSymbol(parent);
      else sym = checker.getSymbolAtLocation(n);
      if (sym && sym.flags & ts.SymbolFlags.Alias) {
        try {
          sym = checker.getAliasedSymbol(sym);
        } catch {
          sym = undefined;
        }
      }
      if (sym && !sym.declarations && sym.escapedName === 'unknown') sym = undefined; // unresolved alias target
      if (!sym) {
        const nm = n.text;
        if (names.has(nm)) {
          note('unresolved-name-match', encKey + '|' + nm);
          if (state.unresolvedNameSamples.length < 30) state.unresolvedNameSamples.push(`${path.relative(OMP_SRC, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${nm}`);
        } else note('unresolved-other', encKey + '|' + nm);
        return;
      }
      const decls = sym.declarations;
      if (!decls || decls.length === 0) {
        note('no-declaration', encKey + '|' + sym.name);
        return;
      }
      let decl = null;
      let dsf = null;
      for (const d of decls) {
        const s = d.kind === K.SourceFile ? d : d.getSourceFile();
        if (inScope(s)) {
          decl = d;
          dsf = s;
          break;
        }
      }
      if (!decl) {
        note('external', encKey + '|' + fileIdOf(decls[0].kind === K.SourceFile ? decls[0] : decls[0].getSourceFile()) + ':' + decls[0].pos);
        return;
      }
      const tKey = fileIdOf(dsf) + ':' + decl.pos;
      if (decl.kind === K.SourceFile) {
        note('edge-module', encKey + '|' + tKey);
        return;
      }
      if (indexedLabel(decl)) {
        const kind = useKind(n, sym);
        state.edgeKinds[kind]++;
        state.uses.edge++;
        const rk = encKey + '|' + tKey;
        state.edgeRecords[kind].add(rk);
        if (uniqAll) state.uniq.edge.add(rk + '|' + kind);
        if (importers && dsf !== sf) {
          let e = importers.get(tKey);
          if (!e) importers.set(tKey, (e = { decl, files: new Set() }));
          e.files.add(sf);
        }
        return;
      }
      note(MEMBER_KINDS.has(decl.kind) ? 'local:member' : 'local:binding', encKey + '|' + tKey);
    };

    const visit = (n) => {
      const k = n.kind;
      if (k === K.Identifier || k === K.PrivateIdentifier) {
        handleIdentifier(n);
        return;
      }
      const prevE = enclosing;
      const prevK = encKey;
      if (INDEXABLE_KINDS.has(k) && indexedLabel(n)) {
        enclosing = n;
        encKey = fid + ':' + n.pos;
      }
      ts.forEachChild(n, visit);
      enclosing = prevE;
      encKey = prevK;
    };
    ts.forEachChild(sf, visit);
  }

  function importPass(sf) {
    if (!sf.imports) return;
    for (const spec of sf.imports) {
      state.imports.total++;
      const res = program.getResolvedModuleFromModuleSpecifier(spec, sf);
      const rm = res && res.resolvedModule;
      if (rm) {
        state.imports.resolved++;
        if (rm.isExternalLibraryImport) state.imports['resolved-external']++;
        continue;
      }
      if (checker.getSymbolAtLocation(spec)) {
        state.imports.ambient++;
        continue;
      }
      const text = spec.text;
      const relOrAlias = ts.isExternalModuleNameRelative(text) || text.startsWith('#') || text.startsWith('@/') || wsNames.has(text) || [...wsNames].some((w) => text.startsWith(w + '/'));
      const cat = relOrAlias ? 'unresolved-import' : 'external-unresolved';
      state.imports[cat]++;
      if (state.importSamples[cat].length < 30) state.importSamples[cat].push(`${path.relative(OMP_SRC, sf.fileName)}: ${text}`);
    }
  }

  function resolvePass(files) {
    const t0 = now();
    for (const sf of files) resolveFile(sf);
    const t1 = now();
    for (const sf of files) importPass(sf);
    const t2 = now();
    return { identifierMs: t1 - t0, importMs: t2 - t1 };
  }

  function summary() {
    const edgeStored = state.edgeRecords.CALLS.size + state.edgeRecords.CONSTRUCTS.size + state.edgeRecords.REFERENCES.size;
    const totalUses = Object.values(state.uses).reduce((a, b) => a + b, 0);
    return {
      files: state.files,
      lines: state.lines,
      identifiers: state.identifiers,
      skippedDeclNames: state.skippedDeclNames,
      uses: state.uses,
      edgeKinds: state.edgeKinds,
      edgeRecordsByKind: { CALLS: state.edgeRecords.CALLS.size, CONSTRUCTS: state.edgeRecords.CONSTRUCTS.size, REFERENCES: state.edgeRecords.REFERENCES.size },
      recordsStored: edgeStored,
      usesTotal: totalUses,
      usesSkippedNonEdge: totalUses - state.uses.edge,
      usesCollapsedDuplicates: state.uses.edge - edgeStored,
      uniqWouldBe: uniqAll ? Object.fromEntries(SCOPE_BUCKETS.map((b) => [b, state.uniq[b].size])) : undefined,
      imports: state.imports,
      importSamples: state.importSamples,
      unresolvedNameSamples: state.unresolvedNameSamples,
      declCounts,
      declCountsAllScope,
      nameSetSize: names.size,
    };
  }

  return { checker, declPass, resolvePass, summary, state, importers, inScope, fileIdOf };
}

// Own non-declaration source files of a program: project root names that are not .d.ts and are in the program.
function ownSourceFiles(program, parsed) {
  const out = [];
  for (const f of parsed.fileNames) {
    if (f.endsWith('.d.ts') || f.endsWith('.d.mts') || f.endsWith('.d.cts') || f.endsWith('.json')) continue;
    const sf = program.getSourceFile(f);
    if (sf && !sf.isDeclarationFile) out.push(sf);
  }
  return out;
}

function runGc() {
  if (typeof Bun !== 'undefined') Bun.gc(true);
  else if (typeof global.gc === 'function') global.gc();
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['out', 'repeat', 'cap', 'lo', 'hi', 'target', 'edit', 'buildinfo', 'runs', 'concurrency', 'label'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function writeOut(name, content) {
  ensureOut();
  fs.writeFileSync(path.join(OUT_DIR, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
}

// Spawn the current runtime on a script, wrapped by /usr/bin/time -l, return {stdout, stderr, wallMs, maxRssBytes, code}
function spawnTimed(script, args, { env, timeoutMs = 3_000_000, execArgv = [] } = {}) {
  const t0 = now();
  const r = cp.spawnSync('/usr/bin/time', ['-l', process.execPath, ...execArgv, script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 28, timeout: timeoutMs });
  const m = /(\d+)\s+maximum resident set size/.exec(r.stderr || '');
  return { stdout: r.stdout, stderr: r.stderr, wallMs: now() - t0, maxRssBytes: m ? Number(m[1]) : null, code: r.status, signal: r.signal };
}

// Pick an exported function (in packages/*/src, explicit non-void return type, body) with the most importing files.
function pickTarget(program, parsed, topN = 5) {
  const resolver = createResolver(program, { collectImporters: true });
  const own = ownSourceFiles(program, parsed);
  resolver.declPass(program.getSourceFiles(), new Set(own));
  resolver.resolvePass(own);
  const cands = [];
  for (const sf of own) {
    if (!sf.fileName.includes('/src/') || /\/(test|tests|bench|examples|fixtures)\//.test(sf.fileName)) continue;
    for (const st of sf.statements) {
      if (st.kind !== K.FunctionDeclaration || !st.name || !st.body || st.asteriskToken) continue;
      if (!(st.modifiers || []).some((m) => m.kind === K.ExportKeyword)) continue;
      if (!st.type || st.type.kind === K.VoidKeyword || st.type.kind === K.AnyKeyword || st.type.kind === K.UnknownKeyword) continue;
      const imp = resolver.importers.get(resolver.fileIdOf(sf) + ':' + st.pos);
      cands.push({
        file: sf.fileName,
        rel: path.relative(OMP_SRC, sf.fileName),
        fn: st.name.text,
        importers: imp ? imp.files.size : 0,
        retType: st.type.getText(sf),
        async: !!(st.modifiers || []).some((m) => m.kind === K.AsyncKeyword),
        edits: {
          body: st.body.getStart(sf) + 1,
          paramsEnd: st.parameters.end,
          paramsEmpty: st.parameters.length === 0,
          lastParamRest: st.parameters.length > 0 && !!st.parameters[st.parameters.length - 1].dotDotDotToken,
          typeEnd: st.type.end,
        },
      });
    }
  }
  cands.sort((a, b) => b.importers - a.importers || (a.file < b.file ? -1 : 1));
  return cands.slice(0, topN);
}

module.exports = {
  pickTarget,
  ts,
  K,
  RUNTIME,
  OUT_DIR,
  OMP_SRC,
  TMP_ROOT,
  now,
  maxRssKB,
  rssKB,
  round1,
  median,
  ensureOut,
  flattenDiag,
  parseConfig,
  reachableProjects,
  packageConfigs,
  resolveAlias,
  resolveSet,
  aliasName,
  workspacePackageNames,
  createProgramFor,
  createOverlayHost,
  createResolver,
  ownSourceFiles,
  indexedLabel,
  enumerateIndexed,
  runGc,
  parseArgs,
  writeOut,
  spawnTimed,
  SCOPE_BUCKETS,
};
