import { isCurrent } from './verify.js';
export const VERIFY_BUDGET = 6_000;
function counts(report) {
    if (report.counts === undefined)
        return 'tests: not reported by the output';
    const { tests, passed, failed, skipped } = report.counts;
    return `tests ${tests} · passed ${passed} · failed ${failed} · skipped ${skipped}`;
}
/** Line 1 carries name, status, revision and dirty state; the rest is evidence. */
export function renderVerifyReport(report, engine) {
    const revision = report.revision === 'unknown' ? 'no commit' : report.revision.slice(0, 12);
    const lines = [
        `VERIFY ${report.check} — ${report.status} · ${revision}${report.dirty ? ' · dirty' : ''}`,
        report.summary,
    ];
    if (report.source === 'check') {
        const exit = report.exitCode === undefined ? 'exit none' : `exit ${report.exitCode}`;
        const seconds = ((report.durationMs ?? 0) / 1000).toFixed(1);
        lines.push(`${exit} · ${seconds} s · ${counts(report)}`);
        if (report.command !== undefined)
            lines.push(`Command: ${report.command}`);
    }
    if (report.source === 'junit' || report.source === 'tap') {
        lines.push(`From ${report.artifacts.join(', ')} (${report.source}) · ${counts(report)}`);
    }
    if (report.failures.length > 0) {
        lines.push(`Failing (${report.failures.length})`, ...report.failures.map((name) => `  ${name}`));
    }
    const tail = report.outputTail.length === 0
        ? []
        : [`Output (last ${report.outputTail.length} lines)`, ...report.outputTail];
    const closing = [];
    if (report.status === 'NOT_VERIFIED') {
        closing.push('Next: say the result is not verified; do not report tests as passing.');
    }
    else if (report.status !== 'PASS') {
        closing.push('Next: report this status as it is; fix and call ei_verify again only after a change.');
    }
    else if (report.dirty) {
        closing.push('Next: report PASS for this working tree; it is not committed.');
    }
    closing.push(`— ${report.redacted ? 'secrets redacted · ' : ''}engine ${engine}`);
    const text = [...lines, ...tail, ...closing].join('\n');
    if (text.length <= VERIFY_BUDGET)
        return text;
    // Over budget: the output tail goes first; line 1, summary and failures stay.
    return [...lines, '… (output tail omitted: over budget)', ...closing]
        .join('\n')
        .slice(0, VERIFY_BUDGET);
}
export function renderVerifyOutcome(outcome, engine) {
    if (outcome.kind === 'failure')
        return `${outcome.code}: ${outcome.message}`;
    return renderVerifyReport(outcome.value, engine);
}
export function changesVerificationNote(reports, revision, checkNames) {
    const current = reports.filter((report) => isCurrent(report, revision));
    if (current.length > 0) {
        const parts = current.map((report) => `${report.check} ${report.status}`);
        return { line: `Verified for this tree: ${parts.join(' · ')} (ei_verify)` };
    }
    if (checkNames.length === 0)
        return {};
    return {
        nextHint: ` No test result is recorded for this tree: call ei_verify (${checkNames.join(', ')}).`,
    };
}
