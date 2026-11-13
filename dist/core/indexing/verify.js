import { tableCounts } from '../../storage/records.js';
/** Phase 4 (DESIGN §6.2.1): structural invariants of a staged index. Empty means it may publish. */
export function verifyIndex(db, expected) {
    const problems = [];
    const check = (label, sql) => {
        const n = Number(db.prepare(sql).get()?.n ?? 0);
        if (n > 0)
            problems.push(`${label}: ${n}`);
    };
    // Unique keys: `symbols.key` is UNIQUE and `declarations.id` its primary key; this checks the link.
    check('declarations without a symbol key', 'SELECT COUNT(*) AS n FROM declarations d LEFT JOIN symbols s ON s.id = d.id WHERE s.id IS NULL');
    check('declarations whose key names another file', `SELECT COUNT(*) AS n FROM declarations d JOIN symbols s ON s.id = d.id
     WHERE substr(s.key, 1, length(d.file) + 1) != d.file || '#'`);
    check('declaration spans outside their file', `SELECT COUNT(*) AS n FROM declarations d LEFT JOIN file_index f ON f.file = d.file
     WHERE f.file IS NULL OR d.start_line < 1 OR d.end_line < d.start_line OR d.end_line > f.lines`);
    check('edges whose source is not a declaration', 'SELECT COUNT(*) AS n FROM edges e LEFT JOIN declarations d ON d.id = e.source WHERE d.id IS NULL');
    check('edges whose target is not a declaration', 'SELECT COUNT(*) AS n FROM edges e LEFT JOIN declarations d ON d.id = e.target WHERE d.id IS NULL');
    check('edge sites outside their file', `SELECT COUNT(*) AS n FROM edges e JOIN declarations d ON d.id = e.source
     JOIN file_index f ON f.file = d.file, json_each(e.lines) j
     WHERE j.value < 1 OR j.value > f.lines`);
    check('exports of a declaration that does not exist', `SELECT COUNT(*) AS n FROM exports x LEFT JOIN symbols s ON s.key = x.target
     LEFT JOIN declarations d ON d.id = s.id WHERE d.id IS NULL`);
    check('indexable files neither indexed nor listed with a reason', `SELECT COUNT(*) AS n FROM files f LEFT JOIN file_index i ON i.file = f.path
     WHERE f.status = 'indexable' AND i.file IS NULL`);
    check('scanned files that are not indexable and have no reason', "SELECT COUNT(*) AS n FROM files WHERE status != 'indexable' AND reason IS NULL");
    check('index records for files that are not indexable', `SELECT COUNT(*) AS n FROM file_index i LEFT JOIN files f ON f.path = i.file
     WHERE f.path IS NULL OR f.status != 'indexable'`);
    check('indexed files without their module declaration', `SELECT COUNT(*) AS n FROM file_index i
     LEFT JOIN symbols s ON s.key = i.file || '#<module>' LEFT JOIN declarations d ON d.id = s.id
     WHERE i.extraction != 'not-in-program' AND d.id IS NULL`);
    check('records of files that are not indexed', `SELECT (SELECT COUNT(*) FROM unresolved u LEFT JOIN file_index i ON i.file = u.file WHERE i.file IS NULL)
          + (SELECT COUNT(*) FROM gap_sites g LEFT JOIN file_index i ON i.file = g.file WHERE i.file IS NULL)
          + (SELECT COUNT(*) FROM name_tokens t LEFT JOIN file_index i ON i.file = t.file WHERE i.file IS NULL)
       AS n`);
    const actual = tableCounts(db);
    for (const [table, n] of Object.entries(expected)) {
        if (actual[table] !== n)
            problems.push(`${table}: produced ${n}, read back ${actual[table]}`);
    }
    return problems;
}
