import { statSync } from 'node:fs';
import { probe } from '../workspace/probe.js';
import { SCHEMA_VERSION, indexPath, openPublished, readFiles, readMeta, readSchemaVersion, } from '../../storage/sqlite.js';
import { impactConfigHash } from './indexer.js';
import { isHolderAlive, readLockHolder } from './lock.js';
import { chooseRuntime, memoryLimitMb } from './runtime.js';
import { pinnedTypescriptVersion, resolveTypescript } from './typescript.js';
import { loadWorkspace } from './workspace.js';
/** TOOLS.md §6 budget. */
export const STATUS_BUDGET = 3_000;
function stringList(raw) {
    try {
        const value = JSON.parse(raw ?? '[]');
        return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
    }
    catch {
        return [];
    }
}
export function coverageOf(files) {
    const coverage = {
        scanned: files.length,
        indexable: 0,
        orphan: 0,
        unindexed: 0,
        reasons: {},
        packages: new Set(files.map((file) => file.package).filter((pkg) => pkg !== null)).size,
    };
    for (const file of files) {
        if (file.status === 'indexable')
            coverage.indexable++;
        if (file.status === 'orphan')
            coverage.orphan++;
        if (file.status === 'unindexed')
            coverage.unindexed++;
        if (file.reason !== null)
            coverage.reasons[file.reason] = (coverage.reasons[file.reason] ?? 0) + 1;
    }
    return coverage;
}
/** The published index, read-only; null when none exists. Throws when it cannot be read. */
function readIndex(cacheDir) {
    const db = openPublished(cacheDir);
    if (db === null)
        return null;
    try {
        const schemaVersion = readSchemaVersion(db);
        const meta = readMeta(db);
        const files = schemaVersion === SCHEMA_VERSION ? readFiles(db) : [];
        return {
            info: {
                path: indexPath(cacheDir),
                sizeBytes: statSync(indexPath(cacheDir)).size,
                schemaVersion,
                meta,
                tsconfigs: stringList(meta.tsconfigs),
                tsconfigBases: stringList(meta.tsconfig_bases),
                tsconfigErrors: stringList(meta.tsconfig_errors),
                coverage: coverageOf(files),
            },
            files,
        };
    }
    finally {
        db.close();
    }
}
function driftCount(drift) {
    return drift.added.length + drift.deleted.length + drift.changed.length;
}
function degradation(status, configHash) {
    const { typescript, index, indexError, drift } = status;
    if (!typescript.ok)
        return [typescript.reason, typescript.fix];
    if (indexError !== null)
        return [`index unreadable: ${indexError}`, 'run: ei index'];
    if (index === null)
        return ['no index', 'run: ei index'];
    if (index.schemaVersion !== SCHEMA_VERSION) {
        return [
            `index schema ${index.schemaVersion}, engine expects ${SCHEMA_VERSION}`,
            'run: ei index',
        ];
    }
    if (index.meta.config_hash !== configHash)
        return ['impact config changed since the last build', 'run: ei index'];
    if (index.meta.typescript_version !== typescript.runtime.version) {
        return [
            `index built with typescript ${index.meta.typescript_version}, runtime is ${typescript.runtime.version}`,
            'run: ei index',
        ];
    }
    if (drift !== null && driftCount(drift) > 0) {
        return [`stale index: ${driftCount(drift)} files drifted`, 'run: ei index'];
    }
    return null;
}
/** Everything `ei_status` and `ei status` report; reads files only, never starts the engine. */
export async function workspaceStatus(start, options = {}) {
    const workspace = await loadWorkspace(start, options.cacheHome);
    const { impact } = workspace.config;
    const [runtime, typescript] = await Promise.all([
        chooseRuntime(options.env),
        resolveTypescript({
            version: pinnedTypescriptVersion(),
            cacheHome: options.cacheHome,
            repoRoot: workspace.root,
            useWorkspaceTypescript: impact.useWorkspaceTypescript,
        }),
    ]);
    let index = null;
    let indexError = null;
    let drift = null;
    try {
        const read = readIndex(workspace.cacheDir);
        index = read?.info ?? null;
        if (read && read.info.schemaVersion === SCHEMA_VERSION) {
            drift = await probe(workspace.root, impact, read.files);
        }
    }
    catch (error) {
        indexError = error instanceof Error ? error.message : String(error);
    }
    const holder = readLockHolder(workspace.cacheDir);
    const partial = {
        root: workspace.root,
        repoId: workspace.repoId,
        cacheDir: workspace.cacheDir,
        config: { path: workspace.configPath, errors: workspace.configErrors },
        runtime,
        memoryLimitMb: memoryLimitMb(impact.maxMemoryMb),
        typescript,
        index,
        indexError,
        drift,
        lock: holder && { pid: holder.pid, startedAt: holder.startedAt, alive: isHolderAlive(holder) },
    };
    const degraded = degradation(partial, impactConfigHash(impact));
    return {
        state: degraded === null ? 'ready' : 'degraded',
        reason: degraded?.[0] ?? null,
        fix: degraded?.[1] ?? null,
        ...partial,
    };
}
function list(items, max) {
    const shown = items.slice(0, max).join(', ');
    return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}
function seconds(ms) {
    return ms === undefined ? '?' : `${(Number(ms) / 1000).toFixed(2)} s`;
}
function kilobytes(bytes) {
    return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-US')} KB`;
}
function indexLine(status) {
    const { index, drift } = status;
    if (status.indexError !== null)
        return `unreadable (${status.indexError}) · run: ei index`;
    if (index === null)
        return 'none · run: ei index';
    const built = (index.meta.built_at ?? '?').slice(0, 16).replace('T', ' ');
    let freshness = 'not probed';
    if (drift !== null) {
        // Live timings stay in `details.drift.ms`; the text is byte-identical for the same state.
        const probeNote = `${drift.freshness} probe`;
        freshness =
            driftCount(drift) === 0
                ? `fresh (${probeNote})`
                : `stale: ${drift.changed.length} changed · ${drift.added.length} added · ${drift.deleted.length} deleted (${probeNote})`;
    }
    return `published ${built} UTC · ${freshness} · last scan ${seconds(index.meta.scan_ms)} (${index.meta.listing ?? '?'} listing)`;
}
function coverageLine(coverage) {
    const unindexedReasons = Object.entries(coverage.reasons)
        .filter(([reason]) => reason !== 'no-tsconfig')
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([reason, count]) => `${reason} ${count}`);
    const why = unindexedReasons.length > 0 ? ` (${unindexedReasons.join(' · ')})` : '';
    return (`${coverage.scanned.toLocaleString('en-US')} scanned · ${coverage.indexable.toLocaleString('en-US')} indexable · ` +
        `${coverage.orphan} orphan (no tsconfig) · ${coverage.unindexed.toLocaleString('en-US')} unindexed${why}`);
}
function typescriptLine(ts) {
    if (!ts.ok)
        return `${ts.reason} · ${ts.fix}`;
    const trust = ts.sha256 === null
        ? 'workspace copy, not hash-pinned'
        : `verified sha256 ${ts.sha256.slice(0, 12)}`;
    return `${ts.runtime.version} (${ts.runtime.source}) · ${ts.runtime.path} · ${trust}`;
}
/** The `ei_status` / `ei status` text (TOOLS.md §6), limited to what M2a.1 knows. */
export function renderStatus(status) {
    const lines = [
        status.state === 'ready'
            ? 'STATUS ready'
            : `STATUS degraded (${status.reason}) · ${status.fix}`,
        `Index       ${indexLine(status)}`,
    ];
    const { index, drift } = status;
    if (index !== null) {
        lines.push(`Coverage    ${coverageLine(index.coverage)}`);
        const problems = index.tsconfigErrors.length === 0
            ? 'none'
            : `${index.tsconfigErrors.length}: ${list(index.tsconfigErrors.map((error) => error.slice(0, 160)), 3)}`;
        lines.push(`Scope       ${index.coverage.packages} packages · tsconfigs ${index.tsconfigs.length} (${list(index.tsconfigs, 6)}) · bases ${index.tsconfigBases.length} · tsconfig problems ${problems}`);
    }
    if (drift !== null && driftCount(drift) > 0) {
        lines.push(`Drift       ${list([...drift.changed, ...drift.added, ...drift.deleted], 5)}`);
    }
    const config = status.config;
    if (config.path === null)
        lines.push('Config      no ei.config.json · detected defaults (run: ei init)');
    else if (config.errors.length === 0)
        lines.push('Config      ei.config.json ok');
    else
        lines.push(`Config      ei.config.json: ${config.errors.length} problems, defaults used for those sections: ${list(config.errors, 3)}`);
    lines.push(`Runtime     ${status.runtime.kind} ${status.runtime.version} (${status.runtime.command}) · memory limit ${status.memoryLimitMb.toLocaleString('en-US')} MB`);
    lines.push(`TypeScript  ${typescriptLine(status.typescript)}`);
    lines.push(index === null
        ? `Store       none yet · cache ${status.cacheDir}`
        : `Store       ${index.path} · ${kilobytes(index.sizeBytes)} · schema ${index.schemaVersion}`);
    const lock = status.lock;
    if (lock === null)
        lines.push('Lock        free');
    else if (lock.alive)
        lines.push(`Lock        held by pid ${lock.pid} since ${lock.startedAt}`);
    else
        lines.push(`Lock        stale (pid ${lock.pid} gone; the next build takes it over)`);
    const text = lines.join('\n');
    // Budget guard: lists above are already capped with "+N more"; this only fires on huge paths.
    return text.length <= STATUS_BUDGET
        ? text
        : `${text.slice(0, STATUS_BUDGET - 40)}\n… (truncated at ${STATUS_BUDGET} characters)`;
}
