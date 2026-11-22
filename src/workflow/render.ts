import type { Workflow } from './types.js';

// Always the first thing in rendered output, before the task text or any skill content.
export const PRECEDENCE_HEADER = [
  '# KSD Workflow',
  'KSD/project policy and explicit owner decisions take precedence over any skill text below.',
  'Never merge or deploy without explicit approval. Report verification evidence.',
].join('\n');

function classifiedNote(workflow: Workflow): string {
  if (workflow.classifiedBy === 'default') {
    return 'default (no keyword matched; feature was assumed — pass `type` if that is wrong)';
  }
  return workflow.classifiedBy;
}

export function renderWorkflow(workflow: Workflow): string {
  const secondaryLine =
    workflow.secondaryPacks.length > 0
      ? `Secondary Packs: ${workflow.secondaryPacks
          .map((pack) => {
            const reason = workflow.secondaryReasons[pack];
            return reason ? `${pack} (${reason})` : pack;
          })
          .join(', ')}\n`
      : '';
  const optInLine =
    workflow.optInPacks.length > 0 ? `Opt-In Modes: ${workflow.optInPacks.join(', ')}\n` : '';
  const complianceLine = workflow.requirementCompliance.required
    ? `Compliance Gate: ${workflow.requirementCompliance.dimensions.join(' × ')}\n`
    : '';

  let text =
    `${PRECEDENCE_HEADER}\n\n` +
    `Orchestrator: ${workflow.orchestrator}\n` +
    `Task: ${workflow.task}\n` +
    `Type: ${workflow.type} (classifiedBy: ${classifiedNote(workflow)})\n` +
    `Stage: ${workflow.stage}\n` +
    `Risk: ${workflow.risk}\n` +
    `Primary Pack: ${workflow.primaryPack}\n` +
    secondaryLine +
    optInLine +
    complianceLine;
  for (const entry of workflow.missing) {
    text += `\nMISSING (not invoked): ${entry.id} — ${entry.reason}\n`;
  }
  for (const skill of workflow.loaded) {
    text += `\n# Skill invoked: ${skill.id}\nSource: ${skill.file}\nsha256: ${skill.sha256} (${skill.hash === 'verified' ? 'matches lock' : 'NOT pinned in lock'})\nResolve linked resources relative to: ${skill.baseDir}\nDo not execute scripts without reviewing them.\n\n${skill.text}\n`;
  }
  for (const pack of workflow.packInstructions) {
    text += `\n# Opt-in pack invoked: ${pack.id}\nSource: ${pack.file}\nsha256: ${pack.sha256} (bundled KSD catalog)\nResolve linked resources relative to: ${pack.baseDir}\nDo not execute scripts without reviewing them.\n\n${pack.text}\n`;
  }
  return text;
}
