export const RECORD_TABLES = [
    'file_index',
    'declarations',
    'edges',
    'unresolved',
    'gap_sites',
    'name_tokens',
    'external_imports',
    'exports',
];
export function emptyCounts() {
    return {
        files: 0,
        file_index: 0,
        declarations: 0,
        edges: 0,
        unresolved: 0,
        gap_sites: 0,
        name_tokens: 0,
        external_imports: 0,
        exports: 0,
    };
}
/** Deletes every record these files contributed; returns rows deleted per table. */
export function deleteFileRecords(db, files) {
    const deleted = emptyCounts();
    // Edges first: they are found through their source declaration's file.
    const edges = db.prepare('DELETE FROM edges WHERE source IN (SELECT id FROM declarations WHERE file = ?)');
    const byFile = [
        'file_index',
        'declarations',
        'unresolved',
        'gap_sites',
        'name_tokens',
        'external_imports',
        'exports',
    ].map((table) => [table, db.prepare(`DELETE FROM ${table} WHERE file = ?`)]);
    for (const file of files) {
        deleted.edges += Number(edges.run(file).changes);
        for (const [table, statement] of byFile)
            deleted[table] += Number(statement.run(file).changes);
    }
    return deleted;
}
/** Symbols no declaration carries any more (their keys were deleted or renamed). */
export function deleteOrphanSymbols(db) {
    db.exec('DELETE FROM symbols WHERE id NOT IN (SELECT id FROM declarations)');
}
export function recordWriter(db) {
    const symbol = db.prepare('INSERT INTO symbols (key) VALUES (?) ON CONFLICT (key) DO UPDATE SET key = excluded.key RETURNING id');
    const ids = new Map();
    const idOf = (key) => {
        let id = ids.get(key);
        if (id === undefined) {
            id = Number(symbol.get(key)?.id);
            ids.set(key, id);
        }
        return id;
    };
    const fileIndex = db.prepare(`INSERT INTO file_index (file, extraction, lines, surface, global, indexed_uses, local_uses,
       external, external_unresolved, unresolved_other, outside_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const declaration = db.prepare(`INSERT INTO declarations (id, file, name, simple, kind, exported, start_line, end_line,
       other_spans, sig_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const edge = db.prepare('INSERT INTO edges (source, target, kind, strength, lines) VALUES (?, ?, ?, ?, ?)');
    const unresolved = db.prepare('INSERT INTO unresolved (file, line, name, reason, source) VALUES (?, ?, ?, ?, ?)');
    const gap = db.prepare('INSERT INTO gap_sites (file, line, code, detail, source) VALUES (?, ?, ?, ?, ?)');
    const token = db.prepare('INSERT INTO name_tokens (file, name, kind, lines) VALUES (?, ?, ?, ?)');
    const external = db.prepare('INSERT INTO external_imports (file, specifier, line) VALUES (?, ?, ?)');
    const exported = db.prepare('INSERT INTO exports (file, name, target) VALUES (?, ?, ?)');
    const inserted = emptyCounts();
    return {
        inserted,
        write(rows) {
            const i = rows.index;
            fileIndex.run(i.file, i.extraction, i.lines, i.surface, i.global ? 1 : 0, i.counts.indexed, i.counts.local, i.counts.external, i.counts.externalUnresolved, i.counts.unresolvedOther, i.counts.outsideScope);
            inserted.file_index++;
            for (const d of rows.declarations) {
                declaration.run(idOf(d.key), d.file, d.name, d.simple, d.kind, d.exported ? 1 : 0, d.startLine, d.endLine, JSON.stringify(d.otherSpans), d.sigHash);
            }
            inserted.declarations += rows.declarations.length;
            for (const e of rows.edges) {
                edge.run(idOf(e.source), idOf(e.target), e.kind, e.strength, JSON.stringify(e.lines));
            }
            inserted.edges += rows.edges.length;
            for (const u of rows.unresolved)
                unresolved.run(u.file, u.line, u.name, u.reason, u.source);
            inserted.unresolved += rows.unresolved.length;
            for (const g of rows.gaps)
                gap.run(g.file, g.line, g.code, g.detail, g.source);
            inserted.gap_sites += rows.gaps.length;
            for (const t of rows.tokens)
                token.run(t.file, t.name, t.kind, JSON.stringify(t.lines));
            inserted.name_tokens += rows.tokens.length;
            for (const x of rows.externalImports)
                external.run(x.file, x.specifier, x.line);
            inserted.external_imports += rows.externalImports.length;
            for (const x of rows.exports)
                exported.run(x.file, x.name, x.target);
            inserted.exports += rows.exports.length;
        },
    };
}
export function tableCounts(db) {
    const counts = emptyCounts();
    for (const table of ['files', ...RECORD_TABLES]) {
        counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
    }
    return counts;
}
function filesFrom(db, sql, params, repeat = 1) {
    const found = new Set();
    const statement = db.prepare(sql);
    for (const param of params) {
        for (const row of statement.all(...Array(repeat).fill(param)))
            found.add(String(row.file));
    }
    return found;
}
/** Files with any edge into a declaration of one of `files` (importers, callers, users). */
export function filesWithEdgesInto(db, files) {
    return filesFrom(db, `SELECT DISTINCT s.file AS file FROM declarations t JOIN edges e ON e.target = t.id
     JOIN declarations s ON s.id = e.source WHERE t.file = ?`, files);
}
/** Files importing a module whose path starts with one of `prefixes` (resolution may change). */
export function filesImportingPrefix(db, prefixes) {
    return filesFrom(db, `SELECT DISTINCT s.file AS file FROM edges e JOIN declarations t ON t.id = e.target
     JOIN declarations s ON s.id = e.source
     WHERE e.kind = 'IMPORTS' AND substr(t.file, 1, length(?)) = ?`, prefixes, 2);
}
/**
 * Files whose records depend on which declarations carry these simple names: an unresolved name
 * match, a string token, or an edge to a declaration with that name.
 */
export function filesReferencingNames(db, names) {
    const list = [...names];
    const found = filesFrom(db, "SELECT DISTINCT file FROM unresolved WHERE reason = 'unresolved-name-match' AND name = ?", list);
    for (const file of filesFrom(db, 'SELECT DISTINCT file FROM name_tokens WHERE name = ?', list)) {
        found.add(file);
    }
    const viaEdges = filesFrom(db, `SELECT DISTINCT s.file AS file FROM declarations d JOIN edges e ON e.target = d.id
     JOIN declarations s ON s.id = e.source WHERE d.simple = ?`, list);
    for (const file of viaEdges)
        found.add(file);
    return found;
}
export function filesWithUnresolvedImports(db) {
    const rows = db
        .prepare("SELECT DISTINCT file FROM unresolved WHERE reason = 'unresolved-import'")
        .all();
    return new Set(rows.map((row) => String(row.file)));
}
export function readFileIndex(db) {
    const result = new Map();
    for (const row of db.prepare('SELECT file, surface, global FROM file_index').all()) {
        result.set(String(row.file), {
            surface: String(row.surface),
            global: Number(row.global) === 1,
        });
    }
    return result;
}
/** Declaration keys of these files, each with its simple name. */
export function declarationNamesOf(db, files) {
    const result = new Map();
    const statement = db.prepare('SELECT s.key AS key, d.simple AS simple FROM declarations d JOIN symbols s ON s.id = d.id WHERE d.file = ?');
    for (const file of files) {
        for (const row of statement.all(file))
            result.set(String(row.key), String(row.simple));
    }
    return result;
}
/** How many declarations carry each simple name. */
export function simpleNameCounts(db) {
    const result = new Map();
    for (const row of db
        .prepare('SELECT simple, COUNT(*) AS n FROM declarations GROUP BY simple')
        .all()) {
        result.set(String(row.simple), Number(row.n));
    }
    return result;
}
const CANONICAL = {
    // mtime is left out: the same tree indexed at another time is the same index.
    files: 'SELECT path, size, hash, kind, package, tsconfig, status, reason FROM files ORDER BY path',
    // The per-file use counters are statistics, not graph content: see `counterLines`.
    file_index: 'SELECT file, extraction, lines, surface, global FROM file_index ORDER BY file',
    // Symbol ids are storage details; keys are what the index states.
    declarations: `SELECT s.key, d.file, d.name, d.simple, d.kind, d.exported, d.start_line, d.end_line,
                 d.other_spans, d.sig_hash FROM declarations d JOIN symbols s ON s.id = d.id ORDER BY s.key`,
    // Aliased: a row object keeps one value per column name, so two `key` columns would be one.
    edges: `SELECT s.key AS source, t.key AS target, e.kind, e.strength, e.lines FROM edges e
          JOIN symbols s ON s.id = e.source JOIN symbols t ON t.id = e.target ORDER BY 1, 2, 3`,
    unresolved: 'SELECT * FROM unresolved ORDER BY file, line, name, reason, source',
    gap_sites: 'SELECT * FROM gap_sites ORDER BY file, line, code, detail, source',
    name_tokens: 'SELECT * FROM name_tokens ORDER BY file, name, kind',
    external_imports: 'SELECT * FROM external_imports ORDER BY file, line, specifier',
    exports: 'SELECT * FROM exports ORDER BY file, name, target',
};
/** The use counters of every file, as sorted text lines (statistics only; never graph content). */
export function counterLines(db) {
    return db
        .prepare(`SELECT file, indexed_uses, local_uses, external, external_unresolved, unresolved_other,
         outside_scope FROM file_index ORDER BY file`)
        .all()
        .map((row) => `counters\t${Object.values(row).map(String).join('\t')}`);
}
/**
 * Every graph record as sorted text lines, `table\tcolumns…`; equal indexes give equal lines.
 * The use counters are left out unless asked for: TypeScript infers lazily, so they depend on
 * checking order, and nothing in a query or verdict may depend on them.
 */
export function canonicalLines(db, options = {}) {
    const lines = [];
    for (const [table, sql] of Object.entries(CANONICAL)) {
        for (const row of db.prepare(sql).all()) {
            lines.push(`${table}\t${Object.values(row)
                .map((value) => String(value))
                .join('\t')}`);
        }
    }
    if (options.counters === true)
        lines.push(...counterLines(db));
    return lines;
}
