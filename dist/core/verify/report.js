export const MAX_TAIL_LINES = 40;
/**
 * Status of a finished run. Only exit code 0 with no failed test is PASS, and a run whose
 * output reports zero tests is SKIPPED: printed words never turn a failure into a pass.
 */
export function runStatus(run, counts) {
    if (run.spawnError !== null) {
        return { status: 'ERROR', summary: `could not start: ${run.spawnError}` };
    }
    if (run.timedOut) {
        return { status: 'ERROR', summary: 'timed out; process group killed' };
    }
    if (run.cancelled)
        return { status: 'ERROR', summary: 'cancelled; process group killed' };
    if (run.exitCode !== 0) {
        const how = run.exitCode === null ? `signal ${run.signal ?? 'unknown'}` : `exit ${run.exitCode}`;
        return { status: 'FAIL', summary: `${how}` };
    }
    if (counts !== null && counts.failed > 0) {
        return { status: 'FAIL', summary: `exit 0 but ${counts.failed} failed` };
    }
    if (counts !== null && counts.tests === 0) {
        return { status: 'SKIPPED', summary: 'exit 0 but zero tests ran' };
    }
    return { status: 'PASS', summary: 'exit 0' };
}
/** Status of a result file: there is no exit code, so the counts decide. */
export function fileStatus(counts) {
    if (counts.failed > 0)
        return { status: 'FAIL', summary: `${counts.failed} failed` };
    if (counts.tests === 0)
        return { status: 'SKIPPED', summary: 'zero tests in the report' };
    return { status: 'PASS', summary: `${counts.passed} passed` };
}
export function tailLines(text, max = MAX_TAIL_LINES) {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    if (lines.length === 1 && lines[0] === '')
        return [];
    return lines.slice(-max);
}
