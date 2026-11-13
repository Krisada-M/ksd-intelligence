import { isRecord } from './guards.js';

export interface RiskZoneConfig {
  zone: string;
  floor: 'high' | 'critical';
  match: string[];
}

export interface ImpactConfig {
  enabled: boolean;
  include: string[];
  exclude: string[];
  routes: string[];
  maxDepth: number;
  freshness: 'stat' | 'hash';
  watch: boolean;
  manyCallers: number;
  useWorkspaceTypescript: boolean;
  /** Engine child memory limit in MB; null = min(8192, half of physical RAM) (D45). */
  maxMemoryMb: number | null;
}

export interface GitlabConfig {
  enabled: boolean;
  host?: string;
  project?: string;
}

export interface ToggleConfig {
  enabled: boolean;
}

export interface SearchConfig {
  enabled: boolean;
  semantic: boolean;
}

export interface ProjectConfig {
  skills: ToggleConfig;
  impact: ImpactConfig;
  bridges: Record<string, boolean>;
  search: SearchConfig;
  riskZones: 'default' | RiskZoneConfig[];
  context: ToggleConfig;
  compression: ToggleConfig;
  knowledge: ToggleConfig;
  verification: ToggleConfig;
  gitlab: GitlabConfig;
}

export const DEFAULT_RISK_ZONES: readonly RiskZoneConfig[] = [
  {
    zone: 'payments',
    floor: 'high',
    match: ['**/payments/**', '**/billing/**', '**/subscription*/**'],
  },
  {
    zone: 'auth',
    floor: 'high',
    match: ['**/auth/**', '**/session*/**', '**/middleware.ts'],
  },
  {
    zone: 'migrations',
    floor: 'critical',
    match: ['**/migrations/**', '**/*.sql', '**/schema.prisma', '**/drizzle/**'],
  },
  {
    zone: 'prod-config',
    floor: 'critical',
    match: ['**/.env*', '**/*production*.{json,ts,yaml,yml}'],
  },
] as const;

export function defaultConfig(inferred?: { include?: string[]; routes?: string[] }): ProjectConfig {
  return {
    skills: { enabled: true },
    impact: {
      enabled: true,
      include: inferred?.include ?? ['packages/**', 'apps/**'],
      exclude: ['**/dist/**'],
      routes: inferred?.routes ?? [],
      maxDepth: 10,
      freshness: 'stat',
      watch: true,
      manyCallers: 10,
      useWorkspaceTypescript: false,
      maxMemoryMb: null,
    },
    bridges: {
      B1: true,
      B2: true,
      B3: true,
      B4: true,
      B5: true,
      B6: true,
    },
    search: { enabled: true, semantic: false },
    riskZones: 'default',
    context: { enabled: false },
    compression: { enabled: false },
    knowledge: { enabled: false },
    verification: { enabled: false },
    gitlab: {
      enabled: false,
      host: 'https://gitlab.example.com',
      project: 'group/repo',
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseToggle(
  section: unknown,
  fallback: ToggleConfig,
  name: string,
  errors: string[],
): ToggleConfig {
  if (section === undefined) return fallback;
  if (!isRecord(section) || typeof section.enabled !== 'boolean') {
    errors.push(`Invalid or missing "${name}" section; using defaults`);
    return fallback;
  }
  return { enabled: section.enabled };
}

function parseImpact(section: unknown, fallback: ImpactConfig, errors: string[]): ImpactConfig {
  if (section === undefined) return fallback;
  if (!isRecord(section)) {
    errors.push('Invalid "impact" section; using defaults');
    return fallback;
  }

  const enabled = typeof section.enabled === 'boolean' ? section.enabled : fallback.enabled;
  const include = isStringArray(section.include) ? section.include : fallback.include;
  const exclude = isStringArray(section.exclude) ? section.exclude : fallback.exclude;
  const routes = isStringArray(section.routes) ? section.routes : fallback.routes;
  const maxDepth =
    typeof section.maxDepth === 'number' && section.maxDepth > 0
      ? section.maxDepth
      : fallback.maxDepth;
  const freshness =
    section.freshness === 'stat' || section.freshness === 'hash'
      ? section.freshness
      : fallback.freshness;
  const watch = typeof section.watch === 'boolean' ? section.watch : fallback.watch;
  const manyCallers =
    typeof section.manyCallers === 'number' && section.manyCallers > 0
      ? section.manyCallers
      : fallback.manyCallers;
  const useWorkspaceTypescript =
    typeof section.useWorkspaceTypescript === 'boolean'
      ? section.useWorkspaceTypescript
      : fallback.useWorkspaceTypescript;
  const maxMemoryMb =
    section.maxMemoryMb === null || isPositiveInteger(section.maxMemoryMb)
      ? section.maxMemoryMb
      : fallback.maxMemoryMb;

  if (section.enabled !== undefined && typeof section.enabled !== 'boolean') {
    errors.push('impact.enabled must be boolean');
  }
  if (section.include !== undefined && !isStringArray(section.include)) {
    errors.push('impact.include must be string[]');
  }
  if (section.exclude !== undefined && !isStringArray(section.exclude)) {
    errors.push('impact.exclude must be string[]');
  }
  if (section.routes !== undefined && !isStringArray(section.routes)) {
    errors.push('impact.routes must be string[]');
  }
  if (
    section.maxDepth !== undefined &&
    (typeof section.maxDepth !== 'number' || section.maxDepth <= 0)
  ) {
    errors.push('impact.maxDepth must be positive number');
  }
  if (
    section.freshness !== undefined &&
    section.freshness !== 'stat' &&
    section.freshness !== 'hash'
  ) {
    errors.push('impact.freshness must be "stat" | "hash"');
  }
  if (section.watch !== undefined && typeof section.watch !== 'boolean') {
    errors.push('impact.watch must be boolean');
  }
  if (
    section.manyCallers !== undefined &&
    (typeof section.manyCallers !== 'number' || section.manyCallers <= 0)
  ) {
    errors.push('impact.manyCallers must be positive number');
  }
  if (
    section.useWorkspaceTypescript !== undefined &&
    typeof section.useWorkspaceTypescript !== 'boolean'
  ) {
    errors.push('impact.useWorkspaceTypescript must be boolean');
  }
  if (
    section.maxMemoryMb !== undefined &&
    section.maxMemoryMb !== null &&
    !isPositiveInteger(section.maxMemoryMb)
  ) {
    errors.push('impact.maxMemoryMb must be a positive integer or null');
  }

  return {
    enabled,
    include,
    exclude,
    routes,
    maxDepth,
    freshness,
    watch,
    manyCallers,
    useWorkspaceTypescript,
    maxMemoryMb,
  };
}

function parseBridges(
  section: unknown,
  fallback: Record<string, boolean>,
  errors: string[],
): Record<string, boolean> {
  if (section === undefined) return fallback;
  if (!isRecord(section)) {
    errors.push('Invalid "bridges" section; using defaults');
    return fallback;
  }
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(section)) {
    if (typeof value === 'boolean') {
      result[key] = value;
    } else {
      errors.push(`bridges.${key} must be boolean`);
      result[key] = fallback[key] ?? true;
    }
  }
  return result;
}

function parseSearch(section: unknown, fallback: SearchConfig, errors: string[]): SearchConfig {
  if (section === undefined) return fallback;
  if (!isRecord(section)) {
    errors.push('Invalid "search" section; using defaults');
    return fallback;
  }
  const enabled = typeof section.enabled === 'boolean' ? section.enabled : fallback.enabled;
  const semantic = typeof section.semantic === 'boolean' ? section.semantic : fallback.semantic;
  if (section.enabled !== undefined && typeof section.enabled !== 'boolean') {
    errors.push('search.enabled must be boolean');
  }
  if (section.semantic !== undefined && typeof section.semantic !== 'boolean') {
    errors.push('search.semantic must be boolean');
  }
  return { enabled, semantic };
}

function parseRiskZones(
  section: unknown,
  fallback: 'default' | RiskZoneConfig[],
  errors: string[],
): 'default' | RiskZoneConfig[] {
  if (section === undefined || section === 'default') {
    return 'default';
  }
  if (!Array.isArray(section)) {
    errors.push('riskZones must be "default" or array of RiskZoneConfig');
    return fallback;
  }
  const validZones: RiskZoneConfig[] = [];
  for (const item of section) {
    if (
      isRecord(item) &&
      typeof item.zone === 'string' &&
      (item.floor === 'high' || item.floor === 'critical') &&
      isStringArray(item.match)
    ) {
      validZones.push({
        zone: item.zone,
        floor: item.floor,
        match: item.match,
      });
    } else {
      errors.push('Invalid item in riskZones array');
    }
  }
  return validZones;
}

function parseGitlab(section: unknown, fallback: GitlabConfig, errors: string[]): GitlabConfig {
  if (section === undefined) return fallback;
  if (!isRecord(section)) {
    errors.push('Invalid "gitlab" section; using defaults');
    return fallback;
  }
  const enabled = typeof section.enabled === 'boolean' ? section.enabled : fallback.enabled;
  const host = typeof section.host === 'string' ? section.host : fallback.host;
  const project = typeof section.project === 'string' ? section.project : fallback.project;
  if (section.enabled !== undefined && typeof section.enabled !== 'boolean') {
    errors.push('gitlab.enabled must be boolean');
  }
  if (section.host !== undefined && typeof section.host !== 'string') {
    errors.push('gitlab.host must be string');
  }
  if (section.project !== undefined && typeof section.project !== 'string') {
    errors.push('gitlab.project must be string');
  }
  return { enabled, host, project };
}

export function parseProjectConfig(raw: string): { config: ProjectConfig; errors: string[] } {
  const errors: string[] = [];
  const defaults = defaultConfig();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push(`JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
    return { config: defaults, errors };
  }

  if (!isRecord(parsed)) {
    errors.push('Root configuration must be a JSON object');
    return { config: defaults, errors };
  }

  const config: ProjectConfig = {
    skills: parseToggle(parsed.skills, defaults.skills, 'skills', errors),
    impact: parseImpact(parsed.impact, defaults.impact, errors),
    bridges: parseBridges(parsed.bridges, defaults.bridges, errors),
    search: parseSearch(parsed.search, defaults.search, errors),
    riskZones: parseRiskZones(parsed.riskZones, defaults.riskZones, errors),
    context: parseToggle(parsed.context, defaults.context, 'context', errors),
    compression: parseToggle(parsed.compression, defaults.compression, 'compression', errors),
    knowledge: parseToggle(parsed.knowledge, defaults.knowledge, 'knowledge', errors),
    verification: parseToggle(parsed.verification, defaults.verification, 'verification', errors),
    gitlab: parseGitlab(parsed.gitlab, defaults.gitlab, errors),
  };

  return { config, errors };
}
