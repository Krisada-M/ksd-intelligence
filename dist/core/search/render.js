/** TOOLS.md §7 character budget for `ei_search`. */
export const SEARCH_BUDGET = 4_000;
function plural(count, singular, pluralForm) {
    return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}
function shortName(symbol) {
    const hash = symbol.indexOf('#');
    return hash === -1 ? symbol : symbol.slice(hash + 1);
}
function sanitizeDisplay(text) {
    return text.replace(/[\r\n\t]+/g, ' ');
}
function formatHitRow(hit) {
    const kindCol = hit.kind.padEnd(8);
    const loc = `${hit.span.file}:${hit.span.startLine}`;
    const sigRaw = sanitizeDisplay(hit.signature).trim() || shortName(hit.symbol);
    const sig = sigRaw.length > 80 ? `${sigRaw.slice(0, 79)}…` : sigRaw;
    const facts = [];
    if (hit.route)
        facts.push('route');
    if (hit.exported)
        facts.push('exported');
    if (hit.callers > 0)
        facts.push(plural(hit.callers, 'caller', 'callers'));
    const shownFacts = facts.slice(0, 2);
    return `  ${kindCol}  ${loc}  ${sig}${shownFacts.length > 0 ? `  ${shownFacts.join(' · ')}` : ''}`;
}
function formatFooter(result) {
    const state = result.indexState === 'stale'
        ? 'STALE INDEX'
        : result.indexState === 'updated'
            ? (result.updatedFiles ?? 0) > 0
                ? `index updated (${plural(result.updatedFiles ?? 0, 'file', 'files')})`
                : 'index updated'
            : 'index fresh';
    const tsVer = !result.engine.typescript || result.engine.typescript === 'unknown'
        ? 'n/a'
        : result.engine.typescript;
    const engVer = !result.engine.version || result.engine.version === 'unknown' ? 'n/a' : result.engine.version;
    return `— ${state} · search: lexical only · ${plural(result.scannedFiles ?? 0, 'file', 'files')} · ts ${tsVer} · engine ${engVer}`;
}
export function renderSearch(result, budget = SEARCH_BUDGET) {
    const queryText = sanitizeDisplay(result.query);
    const footer = formatFooter(result);
    if (result.hits.length === 0) {
        const line1 = `SEARCH "${queryText}" — no matches. Try identifiers that would appear in the code.`;
        const out = `${line1}\n${footer}`;
        return out.length <= budget ? out : out.slice(0, budget);
    }
    const next = 'Next: call ei_impact with the symbol you intend to change.';
    const makeHeader = (shown) => `SEARCH "${queryText}" — ${shown.toLocaleString('en-US')} of ${plural(result.totalMatches, 'match', 'matches')}`;
    const hitRows = result.hits.map(formatHitRow);
    const full = [makeHeader(result.hits.length), ...hitRows, next, footer].join('\n');
    if (full.length <= budget)
        return full;
    const chosen = [];
    for (const row of hitRows) {
        const nextShown = chosen.length + 1;
        const remaining = Math.max(0, result.totalMatches - nextShown);
        const candidateLines = [
            makeHeader(nextShown),
            ...chosen,
            row,
            ...(remaining > 0 ? [`  (+${plural(remaining, 'more match', 'more matches')})`] : []),
            next,
            footer,
        ];
        if (candidateLines.join('\n').length > budget)
            break;
        chosen.push(row);
    }
    const remaining = Math.max(0, result.totalMatches - chosen.length);
    const out = [
        makeHeader(chosen.length),
        ...chosen,
        ...(remaining > 0 ? [`  (+${plural(remaining, 'more match', 'more matches')})`] : []),
        next,
        footer,
    ].join('\n');
    return out.length <= budget ? out : out.slice(0, budget);
}
export function renderSearchOutcome(outcome, budget = SEARCH_BUDGET) {
    if (outcome.kind === 'failure') {
        if (outcome.message === 'Cancelled')
            return 'Cancelled';
        if (outcome.code === 'INVALID_INPUT') {
            return `INVALID_INPUT: ${outcome.message}`.slice(0, budget);
        }
        const prefix = outcome.message.startsWith('index-failed:')
            ? outcome.message
            : `index-failed: ${outcome.message}`;
        return `${prefix}. Retry once; if it fails again, continue without ei_search and say so in your report.`.slice(0, budget);
    }
    if (outcome.kind === 'guidance') {
        return 'INDEX BUILDING — index build still running after 60 s. Call again; the answer will use the finished index.'.slice(0, budget);
    }
    return renderSearch(outcome.value, budget);
}
