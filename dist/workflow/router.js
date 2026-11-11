import { classifyTask } from './classify.js';
import { RISKS, STAGES, TASK_TYPES, WorkflowError, isOneOf, } from './types.js';
// One primary skill per stage, indexed by STAGES order:
// plan, investigate, implement, verify, review, ship.
const WORKFLOWS = {
    bug: ['matt:diagnosing-bugs', 'matt:diagnosing-bugs', 'matt:tdd', 'osmani:code-review-and-quality', 'poteto:blast-radius', 'osmani:shipping-and-launch'],
    feature: ['osmani:spec-driven-development', 'poteto:how', 'matt:tdd', 'osmani:code-review-and-quality', 'matt:code-review', 'osmani:shipping-and-launch'],
    refactor: ['matt:codebase-design', 'poteto:how', 'osmani:incremental-implementation', 'osmani:code-review-and-quality', 'poteto:blast-radius', 'osmani:shipping-and-launch'],
    security: ['osmani:security-and-hardening', 'matt:diagnosing-bugs', 'matt:tdd', 'osmani:security-and-hardening', 'poteto:blast-radius', 'osmani:shipping-and-launch'],
    performance: ['osmani:performance-optimization', 'poteto:why', 'osmani:incremental-implementation', 'osmani:performance-optimization', 'poteto:blast-radius', 'osmani:shipping-and-launch'],
    ui: ['osmani:frontend-ui-engineering', 'poteto:how', 'osmani:frontend-ui-engineering', 'osmani:browser-testing-with-devtools', 'poteto:blast-radius', 'osmani:shipping-and-launch'],
};
function invalid(field, value, allowed) {
    return new WorkflowError('INVALID_INPUT', `invalid ${field} ${JSON.stringify(value)}; expected one of: ${allowed.join(', ')}`);
}
function primarySkill(type, stage) {
    const skill = WORKFLOWS[type][STAGES.indexOf(stage)];
    if (skill === undefined)
        throw new WorkflowError('INVALID_INPUT', `no workflow entry for ${type}/${stage}`);
    return skill;
}
export function routeTask(input) {
    const { task, stage = 'plan', risk = 'normal', type } = input;
    if (typeof task !== 'string' || !task.trim())
        throw new WorkflowError('INVALID_INPUT', 'non-empty task required');
    if (!isOneOf(STAGES, stage))
        throw invalid('stage', stage, STAGES);
    if (!isOneOf(RISKS, risk))
        throw invalid('risk', risk, RISKS);
    if (type !== undefined && !isOneOf(TASK_TYPES, type))
        throw invalid('type', type, TASK_TYPES);
    const cleanTask = task.trim();
    const resolved = type === undefined ? classifyTask(cleanTask) : { type, classifiedBy: 'caller' };
    const skillIds = [primarySkill(resolved.type, stage)];
    // High risk adds at most one extra reviewer/verifier, and only at review/verify.
    if (risk === 'high' && stage === 'review')
        skillIds.push('poteto:blast-radius');
    if (risk === 'high' && stage === 'verify')
        skillIds.push('osmani:security-and-hardening');
    return {
        task: cleanTask,
        type: resolved.type,
        classifiedBy: resolved.classifiedBy,
        stage,
        risk,
        skillIds: [...new Set(skillIds)],
        mayMerge: false,
        mayDeploy: false,
    };
}
