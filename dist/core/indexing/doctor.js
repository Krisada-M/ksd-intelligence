import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAILURE_FILE, indexPath, openPublished } from '../../storage/sqlite.js';
import { canonicalLines, counterLines } from '../../storage/records.js';
import { differential } from './differential.js';
import { Indexer } from './indexer.js';
function lines(cacheDir) {
    const db = openPublished(cacheDir);
    if (db === null)
        return { graph: [], counters: [] };
    try {
        return { graph: canonicalLines(db), counters: counterLines(db) };
    }
    finally {
        db.close();
    }
}
/**
 * `ei doctor --deep`: update the active index, rebuild from scratch into a temp database and diff
 * the two (any difference is an incremental bug); optionally run the differential test against
 * TypeScript's find-references. One set of programs is alive at a time.
 */
export async function doctorDeep(ts, indexer, impact, options) {
    const progress = options.onProgress ?? (() => undefined);
    progress('doctor: update active index');
    const update = await indexer.index({ impact, freshness: 'hash', onProgress: progress });
    if (update.action === 'failed') {
        throw new Error(`doctor: active index verification failed: ${update.problems.join('; ')}`);
    }
    const temp = join(indexer.cacheDir, `doctor-${process.pid}`);
    rmSync(temp, { recursive: true, force: true });
    let cold;
    let differences;
    let counterDifferences;
    const rebuild = new Indexer(ts, indexer.root, temp, {
        memoryBudgetMb: indexer.memoryBudgetMb,
    });
    try {
        progress('doctor: cold rebuild');
        cold = await rebuild.index({ impact, full: true });
        if (cold.action === 'failed') {
            throw new Error(`doctor: cold rebuild verification failed: ${cold.problems.join('; ')}`);
        }
        const active = lines(indexer.cacheDir);
        const rebuilt = lines(temp);
        const inActive = new Set(active.graph);
        const inRebuilt = new Set(rebuilt.graph);
        const onlyActive = active.graph.filter((line) => !inRebuilt.has(line));
        const onlyCold = rebuilt.graph.filter((line) => !inActive.has(line));
        differences = {
            count: onlyActive.length + onlyCold.length,
            onlyActive: onlyActive.slice(0, 20),
            onlyCold: onlyCold.slice(0, 20),
        };
        const counterSet = new Set(rebuilt.counters);
        const drifted = active.counters.filter((line) => !counterSet.has(line));
        counterDifferences = {
            count: drifted.length,
            files: drifted.slice(0, 20).map((line) => line.split('\t')[1] ?? ''),
        };
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
    let report = null;
    if (options.differential !== 0) {
        progress('doctor: differential');
        const db = openPublished(indexer.cacheDir);
        if (db === null)
            throw new Error(`doctor: no published index at ${indexPath(indexer.cacheDir)}`);
        try {
            report = differential(ts, indexer.root, db, {
                size: Math.max(0, options.differential),
                seed: options.seed,
            });
        }
        finally {
            db.close();
        }
    }
    const problems = [
        ...(differences.count > 0 ? [`doctor: ${differences.count} canonical differences`] : []),
        ...((report?.misses.length ?? 0) > 0
            ? [`doctor: ${report?.misses.length} differential misses`]
            : []),
    ];
    const failurePath = join(indexer.cacheDir, FAILURE_FILE);
    if (problems.length > 0) {
        writeFileSync(failurePath, JSON.stringify({ at: new Date().toISOString(), reason: 'doctor', problems }), { mode: 0o600 });
    }
    else {
        rmSync(failurePath, { force: true });
    }
    return { update, cold, differences, counterDifferences, differential: report };
}
