import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../kernel/guards.js';
import { VERIFY_NAME_RE } from '../kernel/config.js';
export const REPORTS_PER_CHECK = 10;
const VERIFY_DIR = 'verify';
function checkDir(cacheDir, check) {
    // Names are validated before they reach here; this keeps a bad one out of the path anyway.
    if (!VERIFY_NAME_RE.test(check))
        throw new Error(`verify store: invalid check name "${check}"`);
    return join(cacheDir, VERIFY_DIR, check);
}
/** Stores an already-redacted report and keeps the newest {@link REPORTS_PER_CHECK}. */
export function saveReport(cacheDir, report) {
    const dir = checkDir(cacheDir, report.check);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = report.startedAt.replace(/[:.]/g, '-');
    const file = `${stamp}-${randomBytes(4).toString('hex')}.json`;
    writeFileSync(join(dir, file), `${JSON.stringify(report)}\n`, { mode: 0o600 });
    const files = readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort();
    for (const old of files.slice(0, Math.max(0, files.length - REPORTS_PER_CHECK))) {
        rmSync(join(dir, old), { force: true });
    }
}
function isReport(value) {
    return (isRecord(value) &&
        typeof value.check === 'string' &&
        typeof value.revision === 'string' &&
        typeof value.treeState === 'string' &&
        typeof value.status === 'string' &&
        typeof value.startedAt === 'string');
}
/** Newest stored report per check, sorted by check name; unreadable files are skipped. */
export function latestReports(cacheDir) {
    const root = join(cacheDir, VERIFY_DIR);
    let checks;
    try {
        checks = readdirSync(root).filter((name) => VERIFY_NAME_RE.test(name));
    }
    catch {
        return [];
    }
    const out = [];
    for (const check of checks.sort()) {
        const files = readdirSync(join(root, check))
            .filter((name) => name.endsWith('.json'))
            .sort()
            .reverse();
        for (const file of files) {
            try {
                const parsed = JSON.parse(readFileSync(join(root, check, file), 'utf8'));
                if (!isReport(parsed))
                    continue;
                out.push(parsed);
                break;
            }
            catch {
                // A torn or foreign file: try the next older one.
            }
        }
    }
    return out;
}
