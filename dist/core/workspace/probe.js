import { join } from 'node:path';
import { hashFile, kindOf, mapLimit, neverReadOf, statVisible } from './scan.js';
/**
 * Two-level freshness, level 1 (D22): list the visible files, stat each, and read only files whose
 * (size, mtime) differ from the fingerprint. Blind spot, accepted for queries: a same-size edit
 * that keeps the mtime. `freshness: "hash"` hashes every readable file and has no blind spot.
 * Excluded, secret and symlinked files are never read; for them size and mtime decide.
 */
export async function probe(root, impact, fingerprint, freshness = impact.freshness) {
    const started = performance.now();
    const known = new Map(fingerprint.map((record) => [record.path, record]));
    const { entries } = await statVisible(root);
    const added = [];
    const changed = [];
    const touched = [];
    const toHash = [];
    for (const entry of entries) {
        const previous = known.get(entry.path);
        known.delete(entry.path);
        if (!previous) {
            added.push(entry.path);
            continue;
        }
        const statSame = entry.size === previous.size && entry.mtimeMs === previous.mtimeMs;
        // The common case on every query: nothing to read, so no path matching either.
        if (statSame && freshness === 'stat')
            continue;
        const readable = !entry.symlink && neverReadOf(entry.path, kindOf(entry.path), impact) === null;
        if (!readable || previous.hash === null) {
            if (!statSame)
                changed.push(entry.path);
            continue;
        }
        toHash.push({ entry, previousHash: previous.hash, statSame });
    }
    const hashed = toHash.length;
    if (hashed > 0) {
        await mapLimit(toHash, 32, async ({ entry, previousHash, statSame }) => {
            const hash = await hashFile(join(root, entry.path), entry.size);
            if (hash !== previousHash)
                changed.push(entry.path);
            else if (!statSame)
                touched.push(entry.path);
        });
    }
    return {
        added: added.sort(),
        deleted: [...known.keys()].sort(),
        changed: changed.sort(),
        touched: touched.sort(),
        files: entries.length,
        hashed,
        freshness,
        ms: Math.round(performance.now() - started),
    };
}
