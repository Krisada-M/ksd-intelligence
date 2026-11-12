import { PROVIDER_IDS } from './types.js';
export const PROVIDERS = {
    matt: {
        envVar: 'EI_MATT_ROOT',
        repo: 'https://github.com/mattpocock/skills.git',
        rootSubpath: 'skills/engineering',
    },
    poteto: {
        envVar: 'EI_POTETO_ROOT',
        repo: 'https://github.com/cursor/plugins.git',
        rootSubpath: 'pstack/skills',
    },
    osmani: {
        envVar: 'EI_OSMANI_ROOT',
        repo: 'https://github.com/addyosmani/agent-skills.git',
        rootSubpath: 'skills',
    },
};
// Allowlist: only these IDs can ever be loaded.
export const catalog = {
    'matt:diagnosing-bugs': { provider: 'matt', path: 'diagnosing-bugs/SKILL.md' },
    'matt:codebase-design': { provider: 'matt', path: 'codebase-design/SKILL.md' },
    'matt:tdd': { provider: 'matt', path: 'tdd/SKILL.md' },
    'matt:code-review': { provider: 'matt', path: 'code-review/SKILL.md' },
    'poteto:how': { provider: 'poteto', path: 'how/SKILL.md' },
    'poteto:why': { provider: 'poteto', path: 'why/SKILL.md' },
    'poteto:blast-radius': { provider: 'poteto', path: 'blast-radius/SKILL.md' },
    'osmani:spec-driven-development': {
        provider: 'osmani',
        path: 'spec-driven-development/SKILL.md',
    },
    'osmani:incremental-implementation': {
        provider: 'osmani',
        path: 'incremental-implementation/SKILL.md',
    },
    'osmani:code-review-and-quality': {
        provider: 'osmani',
        path: 'code-review-and-quality/SKILL.md',
    },
    'osmani:security-and-hardening': { provider: 'osmani', path: 'security-and-hardening/SKILL.md' },
    'osmani:performance-optimization': {
        provider: 'osmani',
        path: 'performance-optimization/SKILL.md',
    },
    'osmani:frontend-ui-engineering': {
        provider: 'osmani',
        path: 'frontend-ui-engineering/SKILL.md',
    },
    'osmani:browser-testing-with-devtools': {
        provider: 'osmani',
        path: 'browser-testing-with-devtools/SKILL.md',
    },
    'osmani:shipping-and-launch': { provider: 'osmani', path: 'shipping-and-launch/SKILL.md' },
};
export function lookupSkill(id) {
    return Object.entries(catalog).find(([key]) => key === id)?.[1];
}
export function skillIdsOf(provider) {
    return Object.entries(catalog)
        .filter(([, entry]) => entry.provider === provider)
        .map(([id]) => id);
}
export function rootsFromEnv(env) {
    const roots = {};
    for (const provider of PROVIDER_IDS) {
        roots[provider] = env[PROVIDERS[provider].envVar];
    }
    return roots;
}
