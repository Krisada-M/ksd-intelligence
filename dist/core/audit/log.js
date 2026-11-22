import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync, } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACTION_RANK, LEVEL_RANK } from '../kernel/verdict.js';
export const AUDIT_FILE = 'audit.jsonl';
export const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
export const MAX_ROTATIONS = 3;
export const MAX_TASK_CHARS = 200;
const failureStates = new Map();
function errorCodeOf(error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = error.code;
        if (typeof code === 'string' && code !== '')
            return code;
    }
    return 'WRITE_FAILED';
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const SECRET_KEY_RE = /(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|AUTH|CREDENTIAL)/i;
const TOKEN_PATTERNS = [
    { re: /\bgh[pousr]_[A-Za-z0-9_]{6,}\b/g, replacement: '[REDACTED]' },
    { re: /\bgithub_pat_[A-Za-z0-9_]{6,}\b/g, replacement: '[REDACTED]' },
    { re: /\bglpat-[A-Za-z0-9_-]{6,}\b/g, replacement: '[REDACTED]' },
    { re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{6,}\b/g, replacement: '[REDACTED]' },
    { re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_]{6,}\b/g, replacement: '[REDACTED]' },
    { re: /\bxox[baprs]-[A-Za-z0-9-]{6,}\b/g, replacement: '[REDACTED]' },
    { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED]' },
    { re: /\bAIza[0-9A-Za-z_-]{10,}\b/g, replacement: '[REDACTED]' },
    {
        re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?\b/g,
        replacement: '[REDACTED]',
    },
    { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, replacement: '$1 [REDACTED]' },
    {
        re: /(\b[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|AUTH|API_KEY|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
        replacement: '$1[REDACTED]',
    },
];
function stripHomePrefixes(text, env) {
    let out = text;
    const homes = new Set();
    const osHome = homedir();
    if (osHome && osHome !== '/')
        homes.add(osHome);
    if (env.HOME && env.HOME !== '/')
        homes.add(env.HOME);
    if (env.USERPROFILE && env.USERPROFILE !== '/')
        homes.add(env.USERPROFILE);
    for (const home of homes) {
        const clean = home.replace(/[\\/]+$/, '');
        if (clean === '')
            continue;
        out = out.split(`${clean}/`).join('~/');
        out = out.split(`${clean}\\`).join('~/');
        out = out.replace(new RegExp(`${escapeRegExp(clean)}(?=$|[\\s'":])`, 'g'), '~');
    }
    out = out.replace(/\/home\/[^/\s'":]+/g, '~');
    out = out.replace(/\/Users\/[^/\s'":]+/g, '~');
    out = out.replace(/[A-Za-z]:\\Users\\[^\\\s'":]+/g, '~');
    return out;
}
export function sanitizeAuditText(raw, options = {}) {
    const env = options.env ?? process.env;
    let out = raw.replace(/[\r\n]+/g, ' ');
    if (options.root) {
        const cleanRoot = options.root.replace(/[\\/]+$/, '');
        if (cleanRoot !== '') {
            out = out.split(`${cleanRoot}/`).join('');
            out = out.split(`${cleanRoot}\\`).join('');
            out = out.split(cleanRoot).join('.');
        }
    }
    out = stripHomePrefixes(out, env);
    for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string' && value.length >= 6 && SECRET_KEY_RE.test(key)) {
            out = out.split(value).join('[REDACTED]');
        }
    }
    for (const pattern of TOKEN_PATTERNS) {
        out = out.replace(pattern.re, pattern.replacement);
    }
    return options.maxLen !== undefined ? out.slice(0, options.maxLen) : out;
}
export function stripCodeDetail(raw) {
    const match = /^([a-z0-9-]+):\s/i.exec(raw);
    if (match?.[1])
        return match[1];
    return sanitizeAuditText(raw, { maxLen: 80 });
}
function sanitizeStringList(items, options) {
    if (items === undefined || items.length === 0)
        return undefined;
    const seen = new Set();
    for (const item of items) {
        const clean = options.stripDetail
            ? stripCodeDetail(item)
            : sanitizeAuditText(item, { env: options.env, root: options.root, maxLen: options.maxLen });
        if (clean !== '')
            seen.add(clean);
    }
    return seen.size > 0 ? [...seen] : undefined;
}
function sanitizeEntry(entry, options) {
    const clean = {
        ts: entry.ts,
        tool: entry.tool,
        outcome: entry.outcome,
        ms: Math.round(entry.ms * 100) / 100,
        engine: sanitizeAuditText(entry.engine, { env: options.env, maxLen: 40 }),
    };
    if (entry.ts_version !== undefined) {
        clean.ts_version = sanitizeAuditText(entry.ts_version, { env: options.env, maxLen: 40 });
    }
    if (entry.adapter !== undefined)
        clean.adapter = entry.adapter;
    if (entry.target !== undefined) {
        clean.target = sanitizeAuditText(entry.target, {
            env: options.env,
            root: options.root,
            maxLen: 500,
        });
    }
    const targets = sanitizeStringList(entry.targets, {
        env: options.env,
        root: options.root,
        maxLen: 500,
    });
    if (targets !== undefined)
        clean.targets = targets;
    if (entry.task !== undefined) {
        clean.task = sanitizeAuditText(entry.task, {
            env: options.env,
            root: options.root,
            maxLen: MAX_TASK_CHARS,
        });
    }
    if (entry.stage !== undefined)
        clean.stage = entry.stage;
    if (entry.type !== undefined)
        clean.type = entry.type;
    if (entry.workflowRisk !== undefined)
        clean.workflowRisk = entry.workflowRisk;
    const skills = sanitizeStringList(entry.skills, { env: options.env, maxLen: 100 });
    if (skills !== undefined)
        clean.skills = skills;
    if (entry.risk !== undefined)
        clean.risk = entry.risk;
    if (entry.completeness !== undefined)
        clean.completeness = entry.completeness;
    if (entry.action !== undefined)
        clean.action = entry.action;
    const zones = sanitizeStringList(entry.zones, { env: options.env, maxLen: 100 });
    if (zones !== undefined)
        clean.zones = zones;
    const codes = sanitizeStringList(entry.codes, {
        env: options.env,
        root: options.root,
        stripDetail: true,
    });
    if (codes !== undefined)
        clean.codes = codes;
    if (entry.base !== undefined) {
        clean.base = sanitizeAuditText(entry.base, {
            env: options.env,
            root: options.root,
            maxLen: 200,
        });
    }
    const changedSymbols = sanitizeStringList(entry.changedSymbols, {
        env: options.env,
        root: options.root,
        maxLen: 500,
    });
    if (changedSymbols !== undefined)
        clean.changedSymbols = changedSymbols;
    if (entry.changedFilesCount !== undefined)
        clean.changedFilesCount = entry.changedFilesCount;
    if (entry.unindexedCount !== undefined)
        clean.unindexedCount = entry.unindexedCount;
    if (entry.plannedCount !== undefined)
        clean.plannedCount = entry.plannedCount;
    if (entry.notInPlanCount !== undefined)
        clean.notInPlanCount = entry.notInPlanCount;
    if (entry.plannedUnchangedCount !== undefined) {
        clean.plannedUnchangedCount = entry.plannedUnchangedCount;
    }
    if (entry.statusState !== undefined)
        clean.statusState = entry.statusState;
    if (entry.code !== undefined) {
        clean.code = sanitizeAuditText(entry.code, {
            env: options.env,
            root: options.root,
            maxLen: 80,
        });
    }
    return clean;
}
function rotateAuditFiles(auditPath, maxRotations) {
    const count = Math.max(1, maxRotations);
    for (let i = count; i >= 1; i--) {
        const src = i === 1 ? auditPath : `${auditPath}.${i - 1}`;
        const dst = `${auditPath}.${i}`;
        if (i === count) {
            try {
                unlinkSync(dst);
            }
            catch (error) {
                if (errorCodeOf(error) !== 'ENOENT')
                    throw error;
            }
        }
        try {
            renameSync(src, dst);
        }
        catch (error) {
            if (errorCodeOf(error) !== 'ENOENT')
                throw error;
        }
    }
}
function noteAuditFailure(cacheDir, error) {
    const code = sanitizeAuditText(errorCodeOf(error), { maxLen: 40 }) || 'WRITE_FAILED';
    const existing = failureStates.get(cacheDir);
    if (existing === undefined) {
        failureStates.set(cacheDir, { pending: code, reported: false });
    }
    else if (!existing.reported) {
        existing.pending = code;
    }
}
function resetAuditFailure(cacheDir) {
    failureStates.set(cacheDir, { pending: null, reported: false });
}
export function consumeAuditWarning(cacheDir) {
    const state = failureStates.get(cacheDir);
    if (state === undefined || state.pending === null)
        return null;
    const warning = state.pending;
    state.pending = null;
    state.reported = true;
    return warning;
}
export function clearAuditState(cacheDir) {
    if (cacheDir === undefined)
        failureStates.clear();
    else
        failureStates.delete(cacheDir);
}
/**
 * Append one sanitized JSONL record to `<cacheDir>/audit.jsonl`.
 * Never throws, sleeps, or retries; write failures are captured for one-time `ei_status` display.
 */
export function recordAudit(cacheDir, entry, options = {}) {
    const env = options.env ?? process.env;
    if (env.EI_DISABLED === '1')
        return;
    try {
        // Only set 0700 when creating the directory so read-only (0500) test restrictions are preserved.
        if (!existsSync(cacheDir)) {
            mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
            chmodSync(cacheDir, 0o700);
        }
        const clean = sanitizeEntry(entry, { env, root: options.root });
        const line = `${JSON.stringify(clean)}\n`;
        const auditPath = join(cacheDir, AUDIT_FILE);
        const maxBytes = options.maxBytes ?? MAX_AUDIT_BYTES;
        const maxRotations = options.maxRotations ?? MAX_ROTATIONS;
        let size = 0;
        try {
            size = statSync(auditPath).size;
        }
        catch (error) {
            if (errorCodeOf(error) !== 'ENOENT')
                throw error;
        }
        if (size > 0 && size >= maxBytes) {
            rotateAuditFiles(auditPath, maxRotations);
        }
        if (options.writeLine !== undefined) {
            options.writeLine(auditPath, line);
        }
        else {
            const fd = openSync(auditPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
            try {
                writeSync(fd, Buffer.from(line, 'utf8'));
            }
            finally {
                closeSync(fd);
            }
        }
        resetAuditFailure(cacheDir);
    }
    catch (error) {
        noteAuditFailure(cacheDir, error);
    }
}
export function auditFieldsForWorkflow(workflow) {
    return {
        outcome: 'result',
        task: workflow.task,
        stage: workflow.stage,
        type: workflow.type,
        workflowRisk: workflow.risk,
        skills: [...workflow.skillIds, ...workflow.optInPacks],
        ...(workflow.missing.length > 0 ? { codes: workflow.missing.map((m) => m.code) } : {}),
    };
}
export function auditFieldsForImpact(batch, fallbackEngine) {
    const targets = [];
    const zones = new Set();
    const codes = new Set();
    let strongestRisk;
    let strongestAction;
    let completeness;
    let engine = fallbackEngine;
    let tsVersion;
    let hasResult = false;
    let hasGuidance = false;
    let allFailure = batch.answers.length > 0;
    const absorbResult = (res) => {
        hasResult = true;
        targets.push(res.target);
        if (strongestRisk === undefined || LEVEL_RANK[res.verdict.level] > LEVEL_RANK[strongestRisk]) {
            strongestRisk = res.verdict.level;
        }
        if (strongestAction === undefined ||
            ACTION_RANK[res.verdict.action] > ACTION_RANK[strongestAction]) {
            strongestAction = res.verdict.action;
        }
        if (res.completeness.status === 'partial')
            completeness = 'partial';
        else if (res.completeness.status === 'unknown' && completeness !== 'partial') {
            completeness = 'unknown';
        }
        else if (completeness === undefined) {
            completeness = res.completeness.status;
        }
        for (const z of res.verdict.zones)
            zones.add(z);
        for (const f of res.factors)
            codes.add(f);
        for (const r of res.completeness.reasons)
            codes.add(stripCodeDetail(r));
        if (res.engine.version)
            engine = res.engine.version;
        if (res.engine.typescript && res.engine.typescript !== 'unknown') {
            tsVersion = res.engine.typescript;
        }
    };
    for (const answer of batch.answers) {
        if (answer.kind === 'result') {
            allFailure = false;
            if ('results' in answer.value) {
                for (const sub of answer.value.results)
                    absorbResult(sub);
                if (answer.value.results.length === 0)
                    targets.push(answer.value.file);
            }
            else {
                absorbResult(answer.value);
            }
        }
        else if (answer.kind === 'guidance') {
            allFailure = false;
            hasGuidance = true;
            targets.push(answer.input);
            codes.add(answer.code);
        }
        else {
            targets.push(answer.input);
            codes.add(answer.code);
        }
    }
    if (batch.index.state === 'stale' && hasResult) {
        completeness = 'partial';
        codes.add('stale-index');
    }
    const outcome = allFailure
        ? 'failure'
        : hasGuidance && !hasResult
            ? 'guidance'
            : 'result';
    return {
        outcome,
        engine,
        ...(tsVersion !== undefined ? { ts_version: tsVersion } : {}),
        ...(targets[0] !== undefined ? { target: targets[0] } : {}),
        ...(targets.length > 0 ? { targets } : {}),
        ...(strongestRisk !== undefined ? { risk: strongestRisk } : {}),
        ...(completeness !== undefined ? { completeness } : {}),
        ...(strongestAction !== undefined ? { action: strongestAction } : {}),
        ...(zones.size > 0 ? { zones: [...zones].sort() } : {}),
        ...(codes.size > 0 ? { codes: [...codes].sort() } : {}),
    };
}
export function auditFieldsForChanges(outcome, fallbackEngine) {
    if (outcome.kind === 'failure') {
        return {
            outcome: 'failure',
            engine: fallbackEngine,
            code: outcome.code,
            codes: [outcome.code],
        };
    }
    if (outcome.kind === 'guidance') {
        return {
            outcome: 'guidance',
            engine: fallbackEngine,
            code: outcome.code,
            codes: [outcome.code],
        };
    }
    const v = outcome.value;
    const codes = new Set(v.impact.factors);
    for (const r of v.impact.completeness.reasons)
        codes.add(stripCodeDetail(r));
    return {
        outcome: 'result',
        engine: v.engine.version || fallbackEngine,
        ...(v.engine.typescript && v.engine.typescript !== 'unknown'
            ? { ts_version: v.engine.typescript }
            : {}),
        base: v.base,
        changedSymbols: v.changedSymbols.map((s) => s.symbol),
        changedFilesCount: v.changedFiles.length,
        unindexedCount: v.unindexedChanges.length,
        risk: v.verdict.level,
        completeness: v.impact.completeness.status,
        action: v.verdict.action,
        ...(v.verdict.zones.length > 0 ? { zones: [...v.verdict.zones].sort() } : {}),
        ...(codes.size > 0 ? { codes: [...codes].sort() } : {}),
        ...(v.plan?.provided
            ? {
                plannedCount: v.plan.plannedCount,
                notInPlanCount: v.plan.notInPlan.length,
                plannedUnchangedCount: v.plan.unchanged.length,
            }
            : {}),
    };
}
