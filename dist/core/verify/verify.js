import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { redactSecrets } from '../audit/log.js';
import { VERIFY_NAME_RE } from '../kernel/config.js';
import { isRecord } from '../kernel/guards.js';
import { parseJunit, parseOutput, parseTap } from './parse.js';
import { fileStatus, runStatus, tailLines, } from './report.js';
import { newestCoveredChange, readRevision } from './revision.js';
import { runCheck } from './run.js';
import { saveReport } from './store.js';
const CONFIG_FILE = 'ei.config.json';
const MAX_REPORT_FILE_BYTES = 20 * 1024 * 1024;
/** Accepts exactly one of `check` or `report`, each a bare configured name; nothing else. */
export function validateVerifyInput(raw) {
    if (!isRecord(raw))
        return { ok: false, message: 'expected { check } or { report }' };
    const keys = Object.keys(raw).filter((key) => raw[key] !== undefined);
    const extra = keys.filter((key) => key !== 'check' && key !== 'report');
    if (extra.length > 0) {
        return { ok: false, message: `unknown field(s): ${extra.sort().join(', ')}` };
    }
    if (keys.length !== 1)
        return { ok: false, message: 'give exactly one of check or report' };
    const key = keys[0] === 'report' ? 'report' : 'check';
    const name = raw[key];
    if (typeof name !== 'string' || !VERIFY_NAME_RE.test(name)) {
        return {
            ok: false,
            message: `${key} must be a configured name (letters, digits, . _ : -); nothing ran`,
        };
    }
    return { ok: true, request: key === 'report' ? { report: name } : { check: name } };
}
function notVerified(name, revision, summary, source = 'none') {
    return {
        check: name,
        revision: revision.sha,
        startedAt: new Date().toISOString(),
        status: 'NOT_VERIFIED',
        artifacts: [],
        summary,
        redacted: false,
        source,
        dirty: revision.dirty,
        treeState: revision.treeState,
        failures: [],
        outputTail: [],
    };
}
function redact(text, env) {
    const out = redactSecrets(text, env);
    return { text: out, changed: out !== text };
}
async function verifyCheck(workspace, name, revision, options) {
    const check = workspace.config.verification.checks?.find((entry) => entry.name === name);
    if (check === undefined) {
        return notVerified(name, revision, `"${name}" is not in verification.checks; nothing ran`);
    }
    // The allowlist must be the owner's committed text, not an edit made in this session.
    if (revision.changedPaths.includes(CONFIG_FILE)) {
        return notVerified(name, revision, `${CONFIG_FILE} has uncommitted changes; commit it to approve the allowlist. Nothing ran`);
    }
    const env = options.env ?? process.env;
    const run = await (options.runner ?? runCheck)(check, workspace.root, {
        env,
        signal: options.signal,
    });
    const output = redact(run.output, env);
    const command = redact(check.command.join(' '), env);
    const parsed = parseOutput(output.text);
    const { status, summary } = runStatus(run, parsed.counts);
    return {
        check: name,
        command: command.text,
        revision: revision.sha,
        startedAt: run.startedAt,
        status,
        ...(run.exitCode === null ? {} : { exitCode: run.exitCode }),
        artifacts: [],
        summary: run.outputTruncated ? `${summary}; output over 2 MB, tail kept` : summary,
        redacted: output.changed || command.changed,
        source: 'check',
        dirty: revision.dirty,
        treeState: revision.treeState,
        durationMs: run.durationMs,
        ...(parsed.counts === null ? {} : { counts: parsed.counts }),
        failures: parsed.failures,
        outputTail: tailLines(output.text),
    };
}
async function verifyReportFile(workspace, name, revision, options) {
    const entry = workspace.config.verification.reports?.find((report) => report.name === name);
    if (entry === undefined) {
        return notVerified(name, revision, `"${name}" is not in verification.reports; nothing read`);
    }
    const rootReal = await realpath(workspace.root);
    const fileReal = await realpath(join(workspace.root, entry.path)).catch(() => null);
    if (fileReal === null) {
        return notVerified(name, revision, `${entry.path} not found`, entry.format);
    }
    if (!fileReal.startsWith(`${rootReal}${sep}`)) {
        return notVerified(name, revision, `${entry.path} resolves outside the repository`, entry.format);
    }
    const info = await stat(fileReal);
    if (!info.isFile() || info.size > MAX_REPORT_FILE_BYTES) {
        return notVerified(name, revision, `${entry.path} is not a file under 20 MB`, entry.format);
    }
    const others = {
        ...revision,
        changedPaths: revision.changedPaths.filter((p) => p !== entry.path),
    };
    const newest = await newestCoveredChange(workspace.root, entry.covers, others);
    if (info.mtimeMs <= newest) {
        return notVerified(name, revision, `${entry.path} is older than the last change to the files it covers; stale, not used`, entry.format);
    }
    const env = options.env ?? process.env;
    const text = redact(await readFile(fileReal, 'utf8'), env);
    const parsed = entry.format === 'junit' ? parseJunit(text.text) : parseTap(text.text);
    const counts = parsed.counts ?? { tests: 0, passed: 0, failed: 0, skipped: 0 };
    const { status, summary } = fileStatus(counts);
    return {
        check: name,
        revision: revision.sha,
        startedAt: info.mtime.toISOString(),
        status,
        artifacts: [entry.path],
        summary,
        redacted: text.changed,
        source: entry.format,
        dirty: revision.dirty,
        treeState: revision.treeState,
        counts,
        failures: parsed.failures,
        outputTail: [],
    };
}
/**
 * Runs one owner-allowlisted check or reads one configured result file, and stores the
 * redacted report. The request carries a name only; argv and paths come from the config.
 */
export async function runVerification(workspace, request, options = {}) {
    const name = 'check' in request ? request.check : request.report;
    if (!VERIFY_NAME_RE.test(name)) {
        return { kind: 'failure', code: 'INVALID_INPUT', message: 'invalid name; nothing ran' };
    }
    const revision = await readRevision(workspace.root);
    if (!workspace.config.verification.enabled) {
        return {
            kind: 'result',
            value: notVerified(name, revision, 'verification is disabled in ei.config.json; nothing ran'),
        };
    }
    const report = 'check' in request
        ? await verifyCheck(workspace, name, revision, options)
        : await verifyReportFile(workspace, name, revision, options);
    if (report.status !== 'NOT_VERIFIED')
        saveReport(workspace.cacheDir, report);
    return { kind: 'result', value: report };
}
/** A stored report describes the current tree only when HEAD and every uncommitted byte match. */
export function isCurrent(report, revision) {
    return report.revision === revision.sha && report.treeState === revision.treeState;
}
