import { PROVIDER_IDS, type ProviderId, type SkillId } from './types.js';

export interface ProviderInfo {
  envVar: string;
  repo: string;
  // Directory under the provider root (the checkout's git top level) that holds `<skill>/SKILL.md`.
  // The lock file records the same value; `parseLock` rejects drift between the two.
  rootSubpath: string;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderInfo>> = {
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

export interface CatalogEntry {
  provider: ProviderId;
  // Relative to `<provider root>/<rootSubpath>`.
  path: string;
}

// Allowlist: only these IDs can ever be loaded.
export const catalog: Readonly<Record<SkillId, CatalogEntry>> = {
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

export function lookupSkill(id: string): CatalogEntry | undefined {
  return Object.entries(catalog).find(([key]) => key === id)?.[1];
}

export function skillIdsOf(provider: ProviderId): string[] {
  return Object.entries(catalog)
    .filter(([, entry]) => entry.provider === provider)
    .map(([id]) => id);
}

export type ProviderRoots = Partial<Record<ProviderId, string | undefined>>;

export function rootsFromEnv(env: NodeJS.ProcessEnv): ProviderRoots {
  const roots: ProviderRoots = {};
  for (const provider of PROVIDER_IDS) {
    roots[provider] = env[PROVIDERS[provider].envVar];
  }
  return roots;
}
