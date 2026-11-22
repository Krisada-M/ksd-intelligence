// Pure path-only risk zone matching and verdict derivation (docs/RISK.md §2.1–2.3).
// Zero filesystem imports: excluded and secret files are matched by path alone.
import { resolveRiskZones } from './config.js';
import { matchAny } from './glob.js';
export const LEVEL_RANK = {
    low: 0,
    medium: 1,
    unknown: 2,
    high: 3,
    critical: 4,
};
export const ACTION_RANK = {
    proceed: 0,
    'run-tests': 1,
    'check-gaps': 2,
    'ask-owner': 3,
};
export function normalizeRepoPath(path) {
    return path
        .replaceAll('\\', '/')
        .replace(/^\.?\//, '')
        .replace(/\/+/g, '/');
}
export function matchedRiskZones(paths, riskZones) {
    const configured = resolveRiskZones(riskZones);
    if (configured.length === 0)
        return [];
    const normalizedLower = [];
    const seen = new Set();
    for (const raw of paths) {
        const norm = normalizeRepoPath(raw).toLowerCase();
        if (norm === '' || seen.has(norm))
            continue;
        seen.add(norm);
        normalizedLower.push(norm);
    }
    if (normalizedLower.length === 0)
        return [];
    const matched = [];
    for (const zone of configured) {
        const lowerPatterns = zone.match.map((pattern) => pattern.toLowerCase());
        if (normalizedLower.some((path) => matchAny(lowerPatterns, path))) {
            matched.push(zone);
        }
    }
    return matched;
}
export function deriveVerdict(input) {
    const zones = [...new Set(input.matchedZones.map((zone) => zone.zone))].sort();
    const hasCritical = input.matchedZones.some((zone) => zone.floor === 'critical');
    const hasHigh = input.matchedZones.some((zone) => zone.floor === 'high');
    let level;
    let action;
    let requiredActions;
    if (hasCritical) {
        level = 'critical';
        action = 'ask-owner';
        requiredActions = [
            'Present the planned change to the owner before editing',
            'Never batch with other changes',
        ];
    }
    else if (hasHigh) {
        level = 'high';
        if (input.incomplete) {
            action = 'ask-owner';
            requiredActions = ['Present gaps and planned change to the owner before editing'];
        }
        else {
            action = 'run-tests';
            requiredActions = [
                'Run every file in tests. If tests is empty, say so in the report',
                'Call ei_workflow with risk: high at verify and review',
                'Call ei_changes before reporting done',
            ];
        }
    }
    else if (input.incomplete) {
        level = 'unknown';
        action = 'check-gaps';
        requiredActions = [
            'Open each site named in completeness.reasons, state what was found, then decide',
        ];
    }
    else if (input.hasFactors) {
        level = 'medium';
        action = 'run-tests';
        requiredActions = ['Run every file in tests. If tests is empty, say so in the report'];
    }
    else {
        level = 'low';
        action = 'proceed';
        requiredActions = [];
    }
    return {
        level,
        action,
        zones,
        requiredActions,
        basis: [...new Set([...input.basis, ...zones.map((zone) => `zone:${zone}`)])],
    };
}
export function applyRiskZones(base, paths, riskZones, options = {}) {
    const configured = resolveRiskZones(riskZones);
    const byPath = matchedRiskZones(paths, configured);
    const byName = new Map(byPath.map((zone) => [zone.zone, zone]));
    for (const name of options.preMatchedZones ?? base.zones) {
        if (byName.has(name))
            continue;
        const found = configured.find((zone) => zone.zone === name);
        if (found !== undefined) {
            byName.set(name, found);
        }
        else {
            byName.set(name, {
                zone: name,
                floor: base.level === 'critical' ? 'critical' : 'high',
                match: [],
            });
        }
    }
    const incomplete = options.incomplete ?? base.level === 'unknown';
    const hasFactors = options.hasFactors ?? base.level !== 'low';
    const derived = deriveVerdict({
        incomplete,
        hasFactors,
        basis: base.basis,
        matchedZones: [...byName.values()],
    });
    // Monotonicity invariant: applying risk zones never lowers level or action.
    if (LEVEL_RANK[derived.level] < LEVEL_RANK[base.level]) {
        return {
            ...derived,
            level: base.level,
            action: ACTION_RANK[derived.action] >= ACTION_RANK[base.action] ? derived.action : base.action,
        };
    }
    if (ACTION_RANK[derived.action] < ACTION_RANK[base.action]) {
        return { ...derived, action: base.action };
    }
    return derived;
}
