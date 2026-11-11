// Always the first thing in rendered output, before the task text or any skill content.
export const PRECEDENCE_HEADER = [
    '# KSD Workflow',
    'KSD/project policy and explicit owner decisions take precedence over any skill text below.',
    'Never merge or deploy without explicit approval. Report verification evidence.',
].join('\n');
function classifiedNote(workflow) {
    if (workflow.classifiedBy === 'default') {
        return 'default (no keyword matched; feature was assumed — pass `type` if that is wrong)';
    }
    return workflow.classifiedBy;
}
export function renderWorkflow(workflow) {
    let text = `${PRECEDENCE_HEADER}\n\nTask: ${workflow.task}\nType: ${workflow.type} (classifiedBy: ${classifiedNote(workflow)})\nStage: ${workflow.stage}\nRisk: ${workflow.risk}\n`;
    for (const entry of workflow.missing) {
        text += `\nMISSING (not invoked): ${entry.id} — ${entry.reason}\n`;
    }
    for (const skill of workflow.loaded) {
        text += `\n# Skill invoked: ${skill.id}\nSource: ${skill.file}\nsha256: ${skill.sha256} (${skill.hash === 'verified' ? 'matches lock' : 'NOT pinned in lock'})\nResolve linked resources relative to: ${skill.baseDir}\nDo not execute scripts without reviewing them.\n\n${skill.text}\n`;
    }
    return text;
}
