import { openPublished } from '../../storage/sqlite.js';
// Declarations with their keys; symbol lookups filter this.
const DECLARED = 'declarations d JOIN symbols s ON s.id = d.id';
// File-level edges say which modules a file loads or tests, not who uses a symbol.
const FILE_LEVEL = "('IMPORTS', 'TESTS')";
/**
 * Read-only queries over a published index (DESIGN §6.2.1: an impact query is a graph traversal).
 * Internal: tests and M2b use it; no agent tool is registered on it in M2a.
 */
export class Graph {
    db;
    constructor(db) {
        this.db = db;
    }
    static open(cacheDir) {
        const db = openPublished(cacheDir);
        return db === null ? null : new Graph(db);
    }
    close() {
        this.db.close();
    }
    /**
     * Who uses `key`, breadth first over incoming symbol edges: `result[0]` holds direct users.
     * Each symbol appears once, at its shallowest depth; the target is never its own user.
     */
    incoming(key, depth = 10) {
        const statement = this.db.prepare(`SELECT s.key AS source, e.kind AS kind, e.strength AS strength, d.file AS source_file,
         e.lines AS lines
       FROM edges e JOIN symbols t ON t.id = e.target JOIN symbols s ON s.id = e.source
       JOIN declarations d ON d.id = e.source
       WHERE t.key = ? AND e.kind NOT IN ${FILE_LEVEL} ORDER BY s.key, e.kind`);
        const seen = new Set([key]);
        const levels = [];
        let frontier = [key];
        while (frontier.length > 0 && levels.length < depth) {
            const level = [];
            const next = [];
            for (const target of frontier) {
                for (const row of statement.all(target)) {
                    const source = String(row.source);
                    if (seen.has(source))
                        continue;
                    seen.add(source);
                    next.push(source);
                    const lines = JSON.parse(String(row.lines));
                    level.push({
                        symbol: source,
                        via: String(row.kind),
                        strength: String(row.strength),
                        file: String(row.source_file),
                        lines: Array.isArray(lines) ? lines.map(Number) : [],
                    });
                }
            }
            if (level.length === 0)
                break;
            level.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
            levels.push(level);
            frontier = next;
        }
        return levels;
    }
    /**
     * Resolves what an agent would type to a key: `path#name`, `path:line`, `Owner.member` or a bare
     * name. A bare name matches module-level names first, then member names.
     */
    symbol(query) {
        const keys = (sql, ...params) => this.db
            .prepare(sql)
            .all(...params)
            .map((row) => String(row.key));
        let candidates;
        const atLine = /^(.+):(\d+)$/.exec(query);
        if (query.includes('#')) {
            candidates = keys(`SELECT s.key AS key FROM ${DECLARED} WHERE s.key = ?`, query);
        }
        else if (atLine !== null) {
            const [, file = '', line = '0'] = atLine;
            // The innermost declaration whose span (or an overload's) holds the line.
            const rows = this.db
                .prepare(`SELECT s.key AS key, d.start_line AS start_line, d.end_line AS end_line,
             d.other_spans AS other_spans FROM ${DECLARED} WHERE d.file = ? AND d.name != '<module>'`)
                .all(file);
            const n = Number(line);
            const holding = rows
                .map((row) => {
                const spans = JSON.parse(String(row.other_spans));
                const all = [
                    [Number(row.start_line), Number(row.end_line)],
                    ...(Array.isArray(spans) ? spans : []).map((span) => String(span).split('-').map(Number)),
                ];
                const hit = all.filter(([start = 0, end = 0]) => start <= n && n <= end);
                const width = Math.min(...hit.map(([start = 0, end = 0]) => end - start));
                return { key: String(row.key), width, hit: hit.length > 0 };
            })
                .filter((row) => row.hit)
                .sort((a, b) => a.width - b.width);
            candidates = holding.length === 0 ? [] : [holding[0]?.key ?? ''];
            if (candidates.length === 0)
                candidates = keys(`SELECT s.key AS key FROM ${DECLARED} WHERE s.key = ?`, `${file}#<module>`);
        }
        else if (query.includes('.')) {
            candidates = keys(`SELECT s.key AS key FROM ${DECLARED} WHERE d.name = ? ORDER BY 1`, query);
        }
        else {
            candidates = keys(`SELECT s.key AS key FROM ${DECLARED} WHERE d.name = ? ORDER BY 1`, query);
            if (candidates.length === 0) {
                candidates = keys(`SELECT s.key AS key FROM ${DECLARED} WHERE d.simple = ? ORDER BY 1`, query);
            }
        }
        if (candidates.length === 1)
            return { kind: 'found', key: candidates[0] ?? '' };
        if (candidates.length > 1)
            return { kind: 'ambiguous', candidates };
        const stem = query.replace(/^.*[#.]/, '').slice(0, 4);
        const nearest = keys(`SELECT s.key AS key FROM ${DECLARED} WHERE d.simple LIKE ? AND d.name != '<module>'
       ORDER BY length(d.simple), s.key LIMIT 5`, `${stem}%`);
        return { kind: 'not-found', nearest };
    }
}
