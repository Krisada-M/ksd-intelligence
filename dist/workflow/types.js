export const TASK_TYPES = ['bug', 'feature', 'refactor', 'security', 'performance', 'ui'];
export const STAGES = ['plan', 'investigate', 'implement', 'verify', 'review', 'ship'];
export const RISKS = ['normal', 'high'];
export const PROVIDER_IDS = ['matt', 'poteto', 'osmani'];
export const SKILL_IDS = [
    'matt:diagnosing-bugs',
    'matt:codebase-design',
    'matt:tdd',
    'matt:code-review',
    'poteto:how',
    'poteto:why',
    'poteto:blast-radius',
    'osmani:spec-driven-development',
    'osmani:incremental-implementation',
    'osmani:code-review-and-quality',
    'osmani:security-and-hardening',
    'osmani:performance-optimization',
    'osmani:frontend-ui-engineering',
    'osmani:browser-testing-with-devtools',
    'osmani:shipping-and-launch',
];
export class WorkflowError extends Error {
    code;
    // Message without the code prefix, for tables that show the code in its own column.
    detail;
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.name = 'WorkflowError';
        this.code = code;
        this.detail = detail;
    }
}
export function isOneOf(list, value) {
    return list.some((item) => item === value);
}
