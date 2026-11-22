import { Graph } from '../graph/graph.js';
function matchesFileTarget(target, path) {
    return target === path;
}
export function evaluatePlan(plannedTargets, ctx) {
    if (plannedTargets === undefined) {
        return {
            provided: false,
            plannedCount: 0,
            notInPlan: [],
            unchanged: [],
            ambiguous: [],
        };
    }
    const graph = ctx.db !== null ? new Graph(ctx.db) : null;
    const changedSymbolSet = new Set(ctx.changedSymbols.map((s) => s.symbol));
    const changedFilesByPath = new Map();
    for (const file of ctx.changedFiles) {
        changedFilesByPath.set(file.path, file);
        if (file.oldPath !== undefined)
            changedFilesByPath.set(file.oldPath, file);
    }
    const unindexedSet = new Set(ctx.unindexedChanges);
    const plannedKeys = new Set();
    const unchanged = [];
    const ambiguous = [];
    for (const rawTarget of plannedTargets) {
        const target = rawTarget.trim();
        if (target === '')
            continue;
        // 1. Exact file path match against changed or unindexed files
        if (changedFilesByPath.has(target) || unindexedSet.has(target)) {
            let matchedAnySymbol = false;
            for (const sym of ctx.changedSymbols) {
                const file = sym.symbol.slice(0, sym.symbol.indexOf('#'));
                if (matchesFileTarget(target, file) || sym.span?.file === target) {
                    plannedKeys.add(sym.symbol);
                    matchedAnySymbol = true;
                }
                else {
                    const cf = changedFilesByPath.get(target);
                    if (cf?.oldPath !== undefined && file === cf.oldPath) {
                        plannedKeys.add(sym.symbol);
                        matchedAnySymbol = true;
                    }
                }
            }
            if (!matchedAnySymbol && !unindexedSet.has(target)) {
                // e.g. whitespace-only modified file still counts as changed, not unchanged
            }
            continue;
        }
        // 2. Collect candidate symbol keys from both Graph and changedSymbols (catches removed/renamed)
        const candidateSet = new Set();
        if (graph !== null) {
            const found = graph.symbol(target);
            if (found.kind === 'found') {
                candidateSet.add(found.key);
            }
            else if (found.kind === 'ambiguous') {
                for (const c of found.candidates)
                    candidateSet.add(c);
            }
        }
        for (const sym of ctx.changedSymbols) {
            const hashIdx = sym.symbol.indexOf('#');
            const qualified = hashIdx === -1 ? sym.symbol : sym.symbol.slice(hashIdx + 1);
            const simple = qualified
                .split('.')
                .pop()
                ?.replace(/^static:/, '')
                .replace(/~\d+$/, '') ?? '';
            if (sym.symbol === target || qualified === target || simple === target) {
                candidateSet.add(sym.symbol);
            }
        }
        const candidates = [...candidateSet].sort();
        if (candidates.length > 1) {
            ambiguous.push({ target, candidates });
            continue;
        }
        if (candidates.length === 1) {
            const key = candidates[0];
            if (changedSymbolSet.has(key)) {
                plannedKeys.add(key);
            }
            else {
                unchanged.push(target);
            }
            continue;
        }
        unchanged.push(target);
    }
    const notInPlan = ctx.changedSymbols
        .filter((sym) => !plannedKeys.has(sym.symbol))
        .map((sym) => ({
        symbol: sym.symbol,
        change: sym.change,
        callers: sym.callers ?? 0,
        liveUsers: sym.liveUsers ?? [],
    }));
    return {
        provided: true,
        plannedCount: plannedTargets.filter((t) => t.trim() !== '').length,
        notInPlan,
        unchanged: [...new Set(unchanged)].sort(),
        ambiguous: ambiguous.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)),
    };
}
