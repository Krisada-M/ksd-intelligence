export const DEFAULT_RISK_ZONES = [
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
];
export function defaultConfig(inferred) {
    return {
        skills: { enabled: true },
        impact: {
            enabled: true,
            include: inferred?.include ?? ['packages/**', 'apps/**'],
            exclude: ['**/dist/**'],
            routes: inferred?.routes ?? ['packages/api/src/routes.ts'],
            maxDepth: 10,
            freshness: 'stat',
            watch: true,
            manyCallers: 10,
            useWorkspaceTypescript: false,
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
        ksdBridge: { enabled: false },
        gitlab: {
            enabled: false,
            host: 'https://gitlab.example.com',
            project: 'group/repo',
        },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function parseToggle(section, fallback, name, errors) {
    if (section === undefined)
        return fallback;
    if (!isRecord(section) || typeof section.enabled !== 'boolean') {
        errors.push(`Invalid or missing "${name}" section; using defaults`);
        return fallback;
    }
    return { enabled: section.enabled };
}
function parseImpact(section, fallback, errors) {
    if (section === undefined)
        return fallback;
    if (!isRecord(section)) {
        errors.push('Invalid "impact" section; using defaults');
        return fallback;
    }
    const enabled = typeof section.enabled === 'boolean' ? section.enabled : fallback.enabled;
    const include = isStringArray(section.include) ? section.include : fallback.include;
    const exclude = isStringArray(section.exclude) ? section.exclude : fallback.exclude;
    const routes = isStringArray(section.routes) ? section.routes : fallback.routes;
    const maxDepth = typeof section.maxDepth === 'number' && section.maxDepth > 0
        ? section.maxDepth
        : fallback.maxDepth;
    const freshness = section.freshness === 'stat' || section.freshness === 'hash'
        ? section.freshness
        : fallback.freshness;
    const watch = typeof section.watch === 'boolean' ? section.watch : fallback.watch;
    const manyCallers = typeof section.manyCallers === 'number' && section.manyCallers > 0
        ? section.manyCallers
        : fallback.manyCallers;
    const useWorkspaceTypescript = typeof section.useWorkspaceTypescript === 'boolean'
        ? section.useWorkspaceTypescript
        : fallback.useWorkspaceTypescript;
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
    if (section.maxDepth !== undefined &&
        (typeof section.maxDepth !== 'number' || section.maxDepth <= 0)) {
        errors.push('impact.maxDepth must be positive number');
    }
    if (section.freshness !== undefined &&
        section.freshness !== 'stat' &&
        section.freshness !== 'hash') {
        errors.push('impact.freshness must be "stat" | "hash"');
    }
    if (section.watch !== undefined && typeof section.watch !== 'boolean') {
        errors.push('impact.watch must be boolean');
    }
    if (section.manyCallers !== undefined &&
        (typeof section.manyCallers !== 'number' || section.manyCallers <= 0)) {
        errors.push('impact.manyCallers must be positive number');
    }
    if (section.useWorkspaceTypescript !== undefined &&
        typeof section.useWorkspaceTypescript !== 'boolean') {
        errors.push('impact.useWorkspaceTypescript must be boolean');
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
    };
}
function parseBridges(section, fallback, errors) {
    if (section === undefined)
        return fallback;
    if (!isRecord(section)) {
        errors.push('Invalid "bridges" section; using defaults');
        return fallback;
    }
    const result = {};
    for (const [key, value] of Object.entries(section)) {
        if (typeof value === 'boolean') {
            result[key] = value;
        }
        else {
            errors.push(`bridges.${key} must be boolean`);
            result[key] = fallback[key] ?? true;
        }
    }
    return result;
}
function parseSearch(section, fallback, errors) {
    if (section === undefined)
        return fallback;
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
function parseRiskZones(section, fallback, errors) {
    if (section === undefined || section === 'default') {
        return 'default';
    }
    if (!Array.isArray(section)) {
        errors.push('riskZones must be "default" or array of RiskZoneConfig');
        return fallback;
    }
    const validZones = [];
    for (const item of section) {
        if (isRecord(item) &&
            typeof item.zone === 'string' &&
            (item.floor === 'high' || item.floor === 'critical') &&
            isStringArray(item.match)) {
            validZones.push({
                zone: item.zone,
                floor: item.floor,
                match: item.match,
            });
        }
        else {
            errors.push('Invalid item in riskZones array');
        }
    }
    return validZones;
}
function parseGitlab(section, fallback, errors) {
    if (section === undefined)
        return fallback;
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
export function parseProjectConfig(raw) {
    const errors = [];
    const defaults = defaultConfig();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        errors.push(`JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
        return { config: defaults, errors };
    }
    if (!isRecord(parsed)) {
        errors.push('Root configuration must be a JSON object');
        return { config: defaults, errors };
    }
    const config = {
        skills: parseToggle(parsed.skills, defaults.skills, 'skills', errors),
        impact: parseImpact(parsed.impact, defaults.impact, errors),
        bridges: parseBridges(parsed.bridges, defaults.bridges, errors),
        search: parseSearch(parsed.search, defaults.search, errors),
        riskZones: parseRiskZones(parsed.riskZones, defaults.riskZones, errors),
        context: parseToggle(parsed.context, defaults.context, 'context', errors),
        compression: parseToggle(parsed.compression, defaults.compression, 'compression', errors),
        knowledge: parseToggle(parsed.knowledge, defaults.knowledge, 'knowledge', errors),
        verification: parseToggle(parsed.verification, defaults.verification, 'verification', errors),
        ksdBridge: parseToggle(parsed.ksdBridge, defaults.ksdBridge, 'ksdBridge', errors),
        gitlab: parseGitlab(parsed.gitlab, defaults.gitlab, errors),
    };
    return { config, errors };
}
