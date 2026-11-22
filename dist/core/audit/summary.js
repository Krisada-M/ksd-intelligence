import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../kernel/guards.js';
import { AUDIT_FILE, MAX_ROTATIONS } from './log.js';
const DURATION_RE = /^(\d+)([dhm])$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
export function parseSince(raw, nowMs = Date.now()) {
    const trimmed = raw.trim();
    if (trimmed === '')
        return null;
    const dur = DURATION_RE.exec(trimmed);
    if (dur !== null) {
        const amount = Number.parseInt(dur[1] ?? '', 10);
        const unit = (dur[2] ?? '').toLowerCase();
        if (!Number.isSafeInteger(amount) || amount <= 0)
            return null;
        const unitMs = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
        return nowMs - amount * unitMs;
    }
    if (ISO_DATE_RE.test(trimmed)) {
        const parsed = Date.parse(trimmed);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return null;
}
function fileOfKey(key) {
    const hash = key.indexOf('#');
    return hash === -1 ? key : key.slice(0, hash);
}
function parseEntry(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (!isRecord(raw) ||
        typeof raw.ts !== 'string' ||
        typeof raw.tool !== 'string' ||
        typeof raw.ms !== 'number' ||
        !Number.isFinite(raw.ms)) {
        return null;
    }
    const tsMs = Date.parse(raw.ts);
    if (!Number.isFinite(tsMs))
        return null;
    return { entry: raw, tsMs };
}
export function summarizeAudit(cacheDir, options = {}) {
    const maxRotations = Math.max(0, options.maxRotations ?? MAX_ROTATIONS);
    const paths = [];
    for (let i = maxRotations; i >= 1; i--) {
        paths.push(join(cacheDir, `${AUDIT_FILE}.${i}`));
    }
    paths.push(join(cacheDir, AUDIT_FILE));
    const parsedEntries = [];
    let corruptLines = 0;
    let filesRead = 0;
    let seq = 0;
    for (const path of paths) {
        let raw;
        try {
            raw = readFileSync(path, 'utf8');
        }
        catch {
            continue;
        }
        filesRead++;
        const lines = raw.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '')
                continue;
            const parsed = parseEntry(trimmed);
            if (parsed === null) {
                corruptLines++;
                continue;
            }
            if (options.sinceMs !== undefined && parsed.tsMs < options.sinceMs)
                continue;
            parsedEntries.push({ entry: parsed.entry, tsMs: parsed.tsMs, seq: seq++ });
        }
    }
    parsedEntries.sort((a, b) => (a.tsMs !== b.tsMs ? a.tsMs - b.tsMs : a.seq - b.seq));
    const callsByTool = {};
    const verdictDistribution = {};
    const priorImpactKeys = new Set();
    const priorImpactFiles = new Set();
    const changedWithoutSet = new Set();
    for (const { entry } of parsedEntries) {
        callsByTool[entry.tool] = (callsByTool[entry.tool] ?? 0) + 1;
        if (typeof entry.risk === 'string' && entry.risk.length > 0) {
            verdictDistribution[entry.risk] = (verdictDistribution[entry.risk] ?? 0) + 1;
        }
        if (entry.tool === 'ei_impact' && entry.outcome === 'result') {
            const recorded = [];
            if (typeof entry.target === 'string' && entry.target !== '')
                recorded.push(entry.target);
            if (Array.isArray(entry.targets)) {
                for (const t of entry.targets) {
                    if (typeof t === 'string' && t !== '')
                        recorded.push(t);
                }
            }
            for (const item of recorded) {
                priorImpactKeys.add(item);
                if (!item.includes('#'))
                    priorImpactFiles.add(item);
            }
        }
        if (entry.tool === 'ei_changes' &&
            entry.outcome === 'result' &&
            Array.isArray(entry.changedSymbols)) {
            for (const sym of entry.changedSymbols) {
                if (typeof sym !== 'string' || sym === '')
                    continue;
                if (!priorImpactKeys.has(sym) && !priorImpactFiles.has(fileOfKey(sym))) {
                    changedWithoutSet.add(sym);
                }
            }
        }
    }
    const slowestCalls = [...parsedEntries]
        .sort((a, b) => (b.entry.ms !== a.entry.ms ? b.entry.ms - a.entry.ms : b.tsMs - a.tsMs))
        .slice(0, 10)
        .map(({ entry }) => ({
        ts: entry.ts,
        tool: entry.tool,
        ...(entry.target !== undefined ? { target: entry.target } : {}),
        ms: entry.ms,
        outcome: entry.outcome,
        ...(entry.risk !== undefined ? { risk: entry.risk } : {}),
    }));
    return {
        since: options.sinceLabel ?? null,
        totalCalls: parsedEntries.length,
        corruptLines,
        filesRead,
        callsByTool,
        verdictDistribution,
        slowestCalls,
        changedWithoutPriorImpact: [...changedWithoutSet],
    };
}
export function renderAuditSummary(summary) {
    const scope = summary.since ? `since ${summary.since}` : 'all';
    const corruptNote = summary.corruptLines > 0 ? ` · ${summary.corruptLines} corrupt lines skipped` : '';
    const lines = [
        `AUDIT ${scope} · ${summary.totalCalls.toLocaleString('en-US')} calls · ${summary.filesRead} files${corruptNote}`,
    ];
    const toolEntries = Object.entries(summary.callsByTool).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    lines.push(`Calls by tool: ${toolEntries.length === 0 ? 'none' : toolEntries.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    const verdictOrder = ['low', 'medium', 'high', 'critical', 'unknown'];
    const verdictParts = [];
    for (const level of verdictOrder) {
        const count = summary.verdictDistribution[level];
        if (count !== undefined && count > 0)
            verdictParts.push(`${level} ${count}`);
    }
    for (const [level, count] of Object.entries(summary.verdictDistribution).sort(([a], [b]) => a < b ? -1 : 1)) {
        if (!verdictOrder.includes(level) && count > 0)
            verdictParts.push(`${level} ${count}`);
    }
    lines.push(`Verdicts: ${verdictParts.length === 0 ? 'none' : verdictParts.join(' · ')}`);
    if (summary.slowestCalls.length === 0) {
        lines.push('Slowest calls: none');
    }
    else {
        lines.push(`Slowest calls (${summary.slowestCalls.length}):`);
        for (const call of summary.slowestCalls) {
            const target = call.target ? ` ${call.target}` : '';
            const risk = call.risk ? ` (${call.risk})` : '';
            lines.push(`  ${call.ms.toFixed(1)} ms  ${call.tool}${target}  ${call.outcome}${risk}  ${call.ts}`);
        }
    }
    if (summary.changedWithoutPriorImpact.length === 0) {
        lines.push('Changed without prior ei_impact: none');
    }
    else {
        lines.push(`Changed without prior ei_impact (${summary.changedWithoutPriorImpact.length}):`);
        for (const sym of summary.changedWithoutPriorImpact) {
            lines.push(`  ${sym}`);
        }
    }
    return lines.join('\n');
}
