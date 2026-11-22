/** TOOLS.md §5 character budget for `ei_changes`. */
export const CHANGES_BUDGET = 8_000;
function plural(count, singular, pluralForm) {
    return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}
function shortSymbolName(symbol) {
    const hash = symbol.indexOf('#');
    return hash === -1 ? symbol : symbol.slice(hash + 1);
}
function fileOfKey(symbol) {
    const hash = symbol.indexOf('#');
    return hash === -1 ? symbol : symbol.slice(0, hash);
}
function formatBase(result) {
    return result.mergeBase !== undefined
        ? `${result.base} (merge-base ${result.mergeBase})`
        : result.base;
}
function formatFooter(result) {
    const state = result.indexState === 'stale'
        ? 'index stale (full hash)'
        : result.indexState === 'updated'
            ? (result.updatedFiles ?? 0) > 0
                ? `index updated (${plural(result.updatedFiles ?? 0, 'file', 'files')}, full hash)`
                : 'index updated (full hash)'
            : 'index fresh (full hash)';
    const limits = result.limits;
    const limitParts = [];
    if (limits.unboundedDynamicImports > 0) {
        limitParts.push(plural(limits.unboundedDynamicImports, 'unbounded dynamic import', 'unbounded dynamic imports'));
    }
    if (limits.excludedFiles > 0) {
        limitParts.push(plural(limits.excludedFiles, 'excluded file', 'excluded files'));
    }
    if (limits.failedFiles > 0) {
        limitParts.push(`${plural(limits.failedFiles, 'file', 'files')} failed to index`);
    }
    const limitsText = limitParts.length > 0 ? ` · limits: ${limitParts.join(', ')}` : '';
    const tsVer = !result.engine.typescript || result.engine.typescript === 'unknown'
        ? 'n/a'
        : result.engine.typescript;
    const engVer = !result.engine.version || result.engine.version === 'unknown' ? 'n/a' : result.engine.version;
    return `— ${state} · ${plural(result.scannedFiles ?? 0, 'file', 'files')}${limitsText} · ts ${tsVer} · engine ${engVer}`;
}
function formatPrioritySymbol(sym) {
    const name = shortSymbolName(sym.symbol);
    const file = sym.span?.file ?? fileOfKey(sym.symbol);
    const line = sym.span?.startLine ?? 1;
    const lines = [`  ${name}  ${file}:${line}`];
    if (sym.change === 'removed') {
        for (const user of sym.liveUsers ?? []) {
            const note = user.reason === 'unresolved-import'
                ? 'UNRESOLVED_IMPORT (points at removed symbol/file)'
                : user.reason === 'unresolved-name-match'
                    ? 'UNRESOLVED_NAME_MATCH (points at nothing)'
                    : user.reason === 'string-name-match'
                        ? 'STRING_MATCH'
                        : 'RE-EXPORT (points at removed symbol)';
            lines.push(`    ${user.file}:${user.line}  ${shortSymbolName(user.source)}  ${note}`);
        }
    }
    else {
        const callers = sym.directCallers ?? [];
        for (const node of callers) {
            const markers = [];
            if (node.route)
                markers.push('route');
            if (node.strength === 'heuristic')
                markers.push('heuristic');
            if (node.boundaries)
                markers.push(...node.boundaries);
            if (node.gapScoped)
                markers.push('gap');
            const suffix = markers.length > 0 ? `  ${markers.join(' ')}` : '';
            lines.push(`    ${node.span.file}:${node.span.startLine}  ${shortSymbolName(node.symbol)}  ${node.via}${suffix}`);
        }
        const extra = (sym.callers ?? callers.length) - callers.length;
        if (extra > 0) {
            lines.push(`    (+${extra.toLocaleString('en-US')} transitive callers)`);
        }
    }
    return lines;
}
function formatSummarySymbolLine(sym) {
    const name = shortSymbolName(sym.symbol);
    const file = sym.span?.file ?? fileOfKey(sym.symbol);
    const line = sym.span?.startLine ?? 1;
    const callers = sym.callers ?? 0;
    const callerText = sym.change === 'removed'
        ? callers === 0
            ? '0 users'
            : plural(callers, 'user', 'users')
        : plural(callers, 'caller', 'callers');
    return `  ${name}  ${file}:${line}  ${callerText}`;
}
function formatNext(result) {
    const hasUnindexed = result.unindexedChanges.length > 0;
    const unindexedNote = hasUnindexed ? ' and the "Not analysed" list' : '';
    const testCount = result.impact.tests.length;
    const { action, level } = result.verdict;
    if (action === 'ask-owner') {
        const batchNote = level === 'critical' ? '; do not batch with other changes' : '';
        return `Next: include this verdict${unindexedNote} in your report; ask the owner before proceeding${batchNote}.`;
    }
    if (action === 'check-gaps') {
        const testPart = testCount > 0 ? ` and run ${testCount === 1 ? 'the test above' : 'the tests above'}` : '';
        return `Next: include this verdict${unindexedNote} in your report; inspect the listed gap sites${testPart} before reporting done.`;
    }
    if (action === 'run-tests') {
        const testPart = testCount === 1
            ? 'run the test above'
            : testCount > 1
                ? 'run the tests above'
                : 'run the package tests';
        return `Next: ${testPart}, and include this verdict${unindexedNote} in your report.`;
    }
    return `Next: include this verdict${unindexedNote} in your report.`;
}
function compactSection(title, items, maxItems = 3) {
    if (items.length === 0)
        return [];
    if (items.length <= maxItems)
        return [`${title} (${items.length.toLocaleString('en-US')})`, ...items];
    const shown = items.slice(0, maxItems).map((line) => line.trim());
    return [
        `${title} (${items.length.toLocaleString('en-US')}): ${shown.join('; ')} (+${(items.length - maxItems).toLocaleString('en-US')} more)`,
    ];
}
export function renderChangesOutcome(outcome, budget = CHANGES_BUDGET) {
    if (outcome.kind === 'failure') {
        if (outcome.message === 'Cancelled')
            return 'Cancelled';
        if (outcome.code === 'INVALID_INPUT') {
            return `INVALID_INPUT: ${outcome.message}`.slice(0, budget);
        }
        const prefix = outcome.message.startsWith('index-failed:')
            ? outcome.message
            : `index-failed: ${outcome.message}`;
        return `${prefix}. Retry once; if it fails again, continue without ei_changes and say so in your report.`.slice(0, budget);
    }
    if (outcome.kind === 'guidance') {
        return 'INDEX BUILDING — index build still running after 60 s. Call again; the answer will use the finished index.'.slice(0, budget);
    }
    return renderChanges(outcome.value, budget);
}
function formatUserLine(user) {
    const note = user.reason === 'unresolved-import'
        ? 'UNRESOLVED_IMPORT (points at removed symbol/file)'
        : user.reason === 'unresolved-name-match'
            ? 'UNRESOLVED_NAME_MATCH (points at nothing)'
            : user.reason === 'string-name-match'
                ? 'STRING_MATCH'
                : user.reason === 're-export'
                    ? 'RE-EXPORT (points at removed symbol)'
                    : 'CALLS';
    return `    ${user.file}:${user.line}  ${shortSymbolName(user.source)}  ${note}`;
}
export function renderChanges(result, budget = CHANGES_BUDGET) {
    const renderStart = performance.now();
    const finish = (text) => {
        if (result.timings !== undefined && !Object.isFrozen(result.timings)) {
            result.timings.renderMs = Math.round((performance.now() - renderStart) * 100) / 100;
        }
        return text;
    };
    if (result.nothingChanged === true || result.changedFiles.length === 0) {
        return finish(`CHANGES vs ${formatBase(result)} — nothing changed in the working tree.`.slice(0, budget));
    }
    const isStale = result.indexState === 'stale' ||
        result.impact.completeness.reasons.some((r) => r.startsWith('stale-index:'));
    const zoneText = result.verdict.zones.length > 0
        ? ` (${result.verdict.zones.length === 1 ? 'zone' : 'zones'} ${result.verdict.zones.join(', ')})`
        : '';
    const line1 = `CHANGES vs ${formatBase(result)} — ${plural(result.changedFiles.length, 'file', 'files')}, ${plural(result.changedSymbols.length, 'symbol', 'symbols')}`;
    const line2 = isStale
        ? `ACTION ${result.verdict.action} · level ${result.verdict.level}${zoneText} · picture partial (stale index)`
        : result.impact.completeness.status !== 'complete'
            ? `ACTION ${result.verdict.action} · level ${result.verdict.level}${zoneText} · picture ${result.impact.completeness.status} (${plural(result.impact.completeness.reasons.length, 'gap', 'gaps')})`
            : `ACTION ${result.verdict.action} · level ${result.verdict.level}${zoneText} · picture complete`;
    const { reach, factors } = result.impact;
    const factorsText = factors.length === 0 ? 'none' : factors.join(', ');
    const line3 = `REACH ${reach.direct.toLocaleString('en-US')} direct · ${reach.total.toLocaleString('en-US')} total · ${plural(reach.files, 'file', 'files')} · ${plural(reach.packages, 'package', 'packages')} · ${plural(reach.routes, 'route', 'routes')} · factors: ${factorsText}`;
    const headerLines = [line1, line2, line3, ''];
    const removedWithUsers = result.changedSymbols.filter((s) => s.change === 'removed' && ((s.callers ?? 0) > 0 || (s.liveUsers?.length ?? 0) > 0));
    const sigChangedWithUsers = result.changedSymbols.filter((s) => s.change === 'signature-changed' && ((s.callers ?? 0) > 0 || (s.liveUsers?.length ?? 0) > 0));
    const sigChangedNoUsers = result.changedSymbols.filter((s) => s.change === 'signature-changed' &&
        (s.callers ?? 0) === 0 &&
        (s.liveUsers?.length ?? 0) === 0);
    const modified = result.changedSymbols.filter((s) => s.change === 'modified');
    const added = result.changedSymbols.filter((s) => s.change === 'added');
    const removedNoUsers = result.changedSymbols.filter((s) => s.change === 'removed' && (s.callers ?? 0) === 0 && (s.liveUsers?.length ?? 0) === 0);
    // Priority sections: removed/signature-changed symbols with live users are kept in full first.
    const priorityLines = [];
    if (removedWithUsers.length > 0) {
        priorityLines.push(`Removed, still used (${removedWithUsers.length.toLocaleString('en-US')})`);
        for (const sym of removedWithUsers)
            priorityLines.push(...formatPrioritySymbol(sym));
    }
    if (sigChangedWithUsers.length > 0) {
        priorityLines.push(`Signature changed, still called (${sigChangedWithUsers.length.toLocaleString('en-US')})`);
        for (const sym of sigChangedWithUsers)
            priorityLines.push(...formatPrioritySymbol(sym));
    }
    // Plan sections (D58)
    const planLines = [];
    if (result.plan?.provided) {
        if (result.plan.notInPlan.length > 0) {
            planLines.push(`Not in plan (${result.plan.notInPlan.length.toLocaleString('en-US')})`);
            for (const item of result.plan.notInPlan) {
                const symObj = {
                    symbol: item.symbol,
                    change: item.change,
                    callers: item.callers,
                    liveUsers: item.liveUsers,
                };
                planLines.push(formatSummarySymbolLine(symObj));
                for (const user of item.liveUsers) {
                    planLines.push(formatUserLine(user));
                }
            }
        }
        if (result.plan.unchanged.length > 0) {
            planLines.push(`Planned, unchanged (${result.plan.unchanged.length.toLocaleString('en-US')})`);
            for (const target of result.plan.unchanged)
                planLines.push(`  ${target}`);
        }
        if (result.plan.ambiguous.length > 0) {
            planLines.push(`Plan guidance (${result.plan.ambiguous.length.toLocaleString('en-US')})`);
            for (const amb of result.plan.ambiguous) {
                planLines.push(`  AMBIGUOUS ${amb.target} — ${amb.candidates.join(', ')}`);
            }
        }
    }
    const symSection = (title, list) => list.length === 0
        ? []
        : [`${title} (${list.length.toLocaleString('en-US')})`, ...list.map(formatSummarySymbolLine)];
    const depthLines = [];
    for (let d = 1; d < result.impact.byDepth.length; d++) {
        const levelNodes = result.impact.byDepth[d] ?? [];
        if (levelNodes.length === 0)
            continue;
        depthLines.push(`Depth ${d + 1} (${levelNodes.length.toLocaleString('en-US')})`);
        for (const node of levelNodes) {
            const markers = [];
            if (node.route)
                markers.push('route');
            if (node.strength === 'heuristic')
                markers.push('heuristic');
            if (node.boundaries)
                markers.push(...node.boundaries);
            if (node.gapScoped)
                markers.push('gap');
            const suffix = markers.length > 0 ? `  ${markers.join(' ')}` : '';
            depthLines.push(`  ${node.span.file}:${node.span.startLine}  ${shortSymbolName(node.symbol)}  ${node.via}${suffix}`);
        }
    }
    const symbolDetailLines = [
        ...symSection('Signature changed', sigChangedNoUsers),
        ...symSection('Modified', modified),
        ...symSection('Added', added),
        ...symSection('Removed', removedNoUsers),
        ...depthLines,
    ];
    const unindexedItems = (result.unindexedDetails ?? []).map((d) => `  ${d.path} — ${d.reason}`);
    const unindexedLines = unindexedItems.length === 0
        ? []
        : [`Not analysed (${unindexedItems.length.toLocaleString('en-US')})`, ...unindexedItems];
    const testsLines = result.impact.tests.length === 0
        ? ['Tests to run: none']
        : [
            `Tests to run (${result.impact.tests.length.toLocaleString('en-US')})`,
            ...result.impact.tests.map((t) => `  ${t}`),
        ];
    const reasons = result.impact.completeness.reasons;
    const gapsLines = reasons.length === 0
        ? ['Gaps: none']
        : [`Gaps (${reasons.length.toLocaleString('en-US')})`, ...reasons.map((r) => `  ${r}`)];
    const nextLine = formatNext(result);
    const footerLine = formatFooter(result);
    const tailLines = [nextLine, footerLine];
    const assemble = (p, pl, sd, ui, ts, gp) => [...headerLines, ...p, ...pl, ...sd, ...ui, ...ts, ...gp, ...tailLines].join('\n');
    const full = assemble(priorityLines, planLines, symbolDetailLines, unindexedLines, testsLines, gapsLines);
    if (full.length <= budget)
        return finish(full);
    // Progressive compaction preserving header, verdict, reach, priority sections, Next, and footer.
    const cGaps = reasons.length <= 1
        ? gapsLines
        : compactSection('Gaps', reasons.map((r) => `  ${r}`), 2);
    let text = assemble(priorityLines, planLines, symbolDetailLines, unindexedLines, testsLines, cGaps);
    if (text.length <= budget)
        return finish(text);
    const cTests = result.impact.tests.length <= 1
        ? testsLines
        : compactSection('Tests to run', result.impact.tests.map((t) => `  ${t}`), 2);
    text = assemble(priorityLines, planLines, symbolDetailLines, unindexedLines, cTests, cGaps);
    if (text.length <= budget)
        return finish(text);
    const cUnindexed = compactSection('Not analysed', unindexedItems, 3);
    text = assemble(priorityLines, planLines, symbolDetailLines, cUnindexed, cTests, cGaps);
    if (text.length <= budget)
        return finish(text);
    const cSymDetails = [
        ...compactSection('Signature changed', sigChangedNoUsers.map(formatSummarySymbolLine), 2),
        ...compactSection('Modified', modified.map(formatSummarySymbolLine), 2),
        ...compactSection('Added', added.map(formatSummarySymbolLine), 2),
        ...compactSection('Removed', removedNoUsers.map(formatSummarySymbolLine), 2),
    ];
    text = assemble(priorityLines, planLines, cSymDetails, cUnindexed, cTests, cGaps);
    if (text.length <= budget)
        return finish(text);
    const cPlan = result.plan?.provided
        ? [
            ...(result.plan.notInPlan.length > 0
                ? [`Not in plan (${result.plan.notInPlan.length.toLocaleString('en-US')})`]
                : []),
            ...(result.plan.unchanged.length > 0
                ? [`Planned, unchanged (${result.plan.unchanged.length.toLocaleString('en-US')})`]
                : []),
            ...(result.plan.ambiguous.length > 0
                ? [`Plan guidance (${result.plan.ambiguous.length.toLocaleString('en-US')})`]
                : []),
        ]
        : [];
    text = assemble(priorityLines, cPlan, cSymDetails, cUnindexed, cTests, cGaps);
    if (text.length <= budget)
        return finish(text);
    // Even tighter summary counts while keeping header + verdict + reach + priorityLines intact.
    const cSummary = [
        ...(sigChangedNoUsers.length > 0
            ? [`Signature changed (${sigChangedNoUsers.length.toLocaleString('en-US')})`]
            : []),
        ...(modified.length > 0 ? [`Modified (${modified.length.toLocaleString('en-US')})`] : []),
        ...(added.length > 0 ? [`Added (${added.length.toLocaleString('en-US')})`] : []),
        ...(removedNoUsers.length > 0
            ? [`Removed (${removedNoUsers.length.toLocaleString('en-US')})`]
            : []),
        ...(unindexedItems.length > 0
            ? [`Not analysed (${unindexedItems.length.toLocaleString('en-US')})`]
            : []),
        ...(result.impact.tests.length > 0
            ? [`Tests to run (${result.impact.tests.length.toLocaleString('en-US')})`]
            : []),
        ...(reasons.length > 0 ? [`Gaps (${reasons.length.toLocaleString('en-US')})`] : []),
    ];
    text = assemble(priorityLines, cPlan, cSummary, [], [], []);
    if (text.length <= budget)
        return finish(text);
    // Last-resort hard cap: keep line1-3 + priorityLines as far as budget permits + tailLines.
    const fixedTail = `\n${nextLine}\n${footerLine}`;
    const fixedHead = `${line1}\n${line2}\n${line3}\n\n`;
    const remaining = Math.max(0, budget - fixedHead.length - fixedTail.length);
    const body = [...priorityLines, ...cPlan, ...cSummary].join('\n');
    if (body.length <= remaining)
        return finish(`${fixedHead}${body}${fixedTail}`);
    return finish(`${fixedHead}${body.slice(0, Math.max(0, remaining - 20))}\n… (truncated)${fixedTail}`.slice(0, budget));
}
