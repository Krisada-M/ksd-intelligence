/** TOOLS.md §4 per-target character budget. */
export const TARGET_BUDGET = 4_000;
/** TOOLS.md §4 whole-batch character budget (up to 5 targets). */
export const BATCH_BUDGET = 12_000;
const DEFAULT_INDEX = {
    state: 'fresh',
    updatedFiles: 0,
    driftedFiles: [],
};
function plural(count, singular, pluralForm) {
    return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`;
}
function shortName(keyOrInput) {
    const hash = keyOrInput.indexOf('#');
    return hash === -1 ? keyOrInput : keyOrInput.slice(hash + 1);
}
function fileOfKey(key) {
    const hash = key.indexOf('#');
    return hash === -1 ? key : key.slice(0, hash);
}
function sortNodes(nodes) {
    return [...nodes].sort((a, b) => {
        if (a.span.file !== b.span.file)
            return a.span.file < b.span.file ? -1 : 1;
        if (a.span.startLine !== b.span.startLine)
            return a.span.startLine - b.span.startLine;
        if (a.symbol !== b.symbol)
            return a.symbol < b.symbol ? -1 : 1;
        return a.via < b.via ? -1 : a.via > b.via ? 1 : 0;
    });
}
function formatNodeRow(node) {
    const loc = `${node.span.file}:${node.span.startLine}`;
    const sym = shortName(node.symbol);
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
    return `  ${loc}  ${sym}  ${node.via}${suffix}`;
}
function formatGapReason(reason, targetFile, targetLine) {
    const withLoc = /^([a-z-]+): ([^:;\s]+:\d+) — (.+)$/.exec(reason);
    if (withLoc !== null) {
        const [, code = '', loc = '', detail = ''] = withLoc;
        switch (code) {
            case 'dynamic-import':
                return `dynamic-import ${loc} — computed path (${detail}); check whether it can load this file`;
            case 'cjs-require':
                return `cjs-require ${loc} — CommonJS require (${detail}); check callers at this require site`;
            case 'computed-member-access':
                return `computed-member-access ${loc} — computed key access on ${detail}; check dynamic readers`;
            case 'interface-dispatch':
                return `interface-dispatch ${loc} — call via interface ${detail}; check whether runtime receiver is this implementation`;
            case 'parse-error':
                return `parse-error ${loc} — syntax error in ${detail}; fix syntax so callers in this file can be indexed`;
            case 'unsupported-syntax':
                return `unsupported-syntax ${loc} — ${detail}; check this site manually`;
            case 'unresolved-import':
                return `unresolved-import ${loc} — unresolved import of ${detail}; check whether it targets this declaration`;
            case 'unresolved-name-match':
                return `unresolved-name-match ${loc} — untyped access to ${detail}; check whether receiver can be this target`;
            case 'string-name-match':
                return `string-name-match ${loc} — string literal "${detail}"; check whether it references this declaration dynamically`;
            default:
                return `${code} ${loc} — ${detail}; check this site`;
        }
    }
    const withoutLoc = /^([a-z-]+): (.+)$/.exec(reason);
    const loc = `${targetFile}:${targetLine}`;
    if (withoutLoc !== null) {
        const [, code = '', detail = ''] = withoutLoc;
        if (code === 'stale-index') {
            return `stale-index — drifted: ${detail}; re-run after the index update`;
        }
        return `${code} ${loc} — ${detail}`;
    }
    return `gap ${loc} — ${reason}`;
}
function formatFooter(limits, scannedFiles, engine, index, isStale) {
    const stateText = isStale
        ? 'index stale'
        : index.state === 'updated'
            ? index.updatedFiles > 0
                ? `index updated (${plural(index.updatedFiles, 'file', 'files')})`
                : 'index updated'
            : 'index fresh';
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
    const tsVer = !engine.typescript || engine.typescript === 'unknown' ? 'n/a' : engine.typescript;
    const engVer = !engine.version || engine.version === 'unknown' ? 'n/a' : engine.version;
    return `— ${stateText} · ${plural(scannedFiles, 'file', 'files')}${limitsText} · ts ${tsVer} · engine ${engVer}`;
}
function formatNext(result, isStale, hasGapRows) {
    const testCount = result.tests.length;
    let base;
    if (isStale || result.verdict.action === 'check-gaps') {
        base =
            testCount > 0
                ? `check the listed gap sites before relying on the caller list, then run ${testCount === 1 ? 'the test above' : 'the tests above'} and call ei_changes before you report done.`
                : 'check the listed gap sites before relying on the caller list, and call ei_changes before you report done.';
    }
    else if (result.verdict.action === 'run-tests') {
        base =
            testCount === 1
                ? 'after your change, run the test above; call ei_changes before you report done.'
                : testCount > 1
                    ? 'after your change, run the tests above; call ei_changes before you report done.'
                    : 'after your change, run the package tests; call ei_changes before you report done.';
    }
    else {
        base =
            testCount > 0
                ? `after your change, run ${testCount === 1 ? 'the test above' : 'the tests above'}; call ei_changes before you report done.`
                : 'make your change and call ei_changes before you report done.';
    }
    const gapSuffix = hasGapRows
        ? ' Rows marked gap may have users the index cannot see; call ei_impact on them if you change what they receive.'
        : '';
    return `Next: ${base}${gapSuffix}`;
}
function depthOverflowLine(minDepth, maxDepth, count, fileCount, inBatch) {
    const depthLabel = minDepth === maxDepth ? `Depth ${minDepth}` : `Depth ${minDepth}–${maxDepth}`;
    const head = `${depthLabel}: ${count.toLocaleString('en-US')} more in ${plural(fileCount, 'file', 'files')}.`;
    if (maxDepth === 1 && !inBatch)
        return head;
    return `${head} Call again with depth ${minDepth} and a single target to list them.`;
}
function populatedDepthRange(sortedLevels) {
    let minDepth = 0;
    let maxDepth = 0;
    for (let i = 0; i < sortedLevels.length; i++) {
        if ((sortedLevels[i]?.length ?? 0) === 0)
            continue;
        if (minDepth === 0)
            minDepth = i + 1;
        maxDepth = i + 1;
    }
    return minDepth === 0 ? [1, 1] : [minDepth, maxDepth];
}
function distinctFiles(nodes) {
    return new Set(nodes.map((node) => node.span.file)).size;
}
function buildCallersSection(sortedLevels, charBudget, inBatch) {
    const nonEmpty = sortedLevels.some((level) => level.length > 0);
    if (!nonEmpty)
        return ['Callers: none'];
    // First try rendering every depth level in full.
    const fullLines = [];
    for (let i = 0; i < sortedLevels.length; i++) {
        const nodes = sortedLevels[i] ?? [];
        if (nodes.length === 0)
            continue;
        const d = i + 1;
        fullLines.push(d === 1
            ? `Callers, depth 1 (${nodes.length.toLocaleString('en-US')})`
            : `Depth ${d} (${nodes.length.toLocaleString('en-US')})`);
        for (const node of nodes)
            fullLines.push(formatNodeRow(node));
    }
    if (fullLines.join('\n').length <= charBudget)
        return fullLines;
    // Over budget: reserve summary lines for levels d >= 2 first, keep depth 1 complete as far as possible.
    const deeperSummaries = new Map();
    for (let i = 1; i < sortedLevels.length; i++) {
        const nodes = sortedLevels[i] ?? [];
        if (nodes.length === 0)
            continue;
        deeperSummaries.set(i + 1, depthOverflowLine(i + 1, i + 1, nodes.length, distinctFiles(nodes), inBatch));
    }
    const d1 = sortedLevels[0] ?? [];
    const d1Header = `Callers, depth 1 (${d1.length.toLocaleString('en-US')})`;
    const reservedForDeeper = [...deeperSummaries.values()].reduce((sum, line) => sum + line.length + 1, 0);
    // Check if all of depth 1 fits alongside deeper summaries.
    const d1Rows = [];
    let d1Len = d1Header.length;
    let allD1Fits = true;
    const overflowReserve = 120;
    for (let idx = 0; idx < d1.length; idx++) {
        const node = d1[idx];
        const row = formatNodeRow(node);
        const isLast = idx === d1.length - 1;
        const needed = isLast
            ? d1Len + 1 + row.length + reservedForDeeper
            : d1Len + 1 + row.length + reservedForDeeper + overflowReserve;
        if (needed > charBudget) {
            const rest = d1.slice(idx);
            d1Rows.push(`  ${depthOverflowLine(1, 1, rest.length, distinctFiles(rest), inBatch)}`);
            allD1Fits = false;
            break;
        }
        d1Rows.push(row);
        d1Len += 1 + row.length;
    }
    const out = [d1Header, ...d1Rows];
    if (!allD1Fits) {
        for (const summary of deeperSummaries.values())
            out.push(summary);
        if (out.join('\n').length <= charBudget)
            return out;
        const allNodes = sortedLevels.flat();
        const [minDepth, maxDepth] = populatedDepthRange(sortedLevels);
        return [
            depthOverflowLine(minDepth, maxDepth, allNodes.length, distinctFiles(allNodes), inBatch),
        ];
    }
    // Depth 1 fit completely! Try expanding depth 2, 3, ... in order if budget permits.
    let currentLen = out.join('\n').length;
    for (let i = 1; i < sortedLevels.length; i++) {
        const nodes = sortedLevels[i] ?? [];
        if (nodes.length === 0)
            continue;
        const d = i + 1;
        const summary = deeperSummaries.get(d);
        deeperSummaries.delete(d);
        const remainingSummariesLen = [...deeperSummaries.values()].reduce((sum, line) => sum + line.length + 1, 0);
        const levelHeader = `Depth ${d} (${nodes.length.toLocaleString('en-US')})`;
        const levelRows = nodes.map(formatNodeRow);
        const levelBlockLen = 1 + levelHeader.length + levelRows.reduce((s, r) => s + 1 + r.length, 0);
        if (currentLen + levelBlockLen + remainingSummariesLen <= charBudget) {
            out.push(levelHeader, ...levelRows);
            currentLen += levelBlockLen;
        }
        else {
            out.push(summary);
            for (const restSummary of deeperSummaries.values())
                out.push(restSummary);
            break;
        }
    }
    return out;
}
function renderSymbolBlock(line1, result, index, budget, inBatch) {
    const isStale = index.state === 'stale' ||
        result.completeness.reasons.some((reason) => reason.startsWith('stale-index:'));
    const zoneText = result.verdict.zones.length > 0
        ? ` (${result.verdict.zones.length === 1 ? 'zone' : 'zones'} ${result.verdict.zones.join(', ')})`
        : '';
    const line2 = isStale
        ? `ACTION check-gaps · level unknown${zoneText} · picture partial (stale index)`
        : result.completeness.status !== 'complete'
            ? `ACTION ${result.verdict.action} · level ${result.verdict.level}${zoneText} · picture ${result.completeness.status} (${plural(result.completeness.reasons.length, 'gap', 'gaps')})`
            : `ACTION ${result.verdict.action} · level ${result.verdict.level}${zoneText} · picture complete`;
    const { reach } = result;
    const factors = result.factors.length === 0 ? 'none' : result.factors.join(', ');
    const line3 = `REACH ${reach.direct.toLocaleString('en-US')} direct · ${reach.total.toLocaleString('en-US')} total · ${plural(reach.files, 'file', 'files')} · ${plural(reach.packages, 'package', 'packages')} · ${plural(reach.routes, 'route', 'routes')} · factors: ${factors}`;
    const targetFile = result.span?.file ?? fileOfKey(result.target);
    const targetLine = result.span?.startLine ?? 1;
    const sortedLevels = result.byDepth.map(sortNodes);
    const hasGapRows = sortedLevels.some((level) => level.some((node) => node.gapScoped === true));
    const testsLines = result.tests.length === 0
        ? ['Tests: none']
        : [
            `Tests (${result.tests.length.toLocaleString('en-US')})`,
            ...result.tests.slice(0, 10).map((t) => `  ${t}`),
            ...(result.tests.length > 10
                ? [`  (+${(result.tests.length - 10).toLocaleString('en-US')} more)`]
                : []),
        ];
    const reasons = result.completeness.reasons;
    const gapsLines = reasons.length === 0
        ? ['Gaps: none']
        : [
            `Gaps (${reasons.length.toLocaleString('en-US')})`,
            ...reasons.slice(0, 10).map((r) => `  ${formatGapReason(r, targetFile, targetLine)}`),
            ...(reasons.length > 10
                ? [`  (+${(reasons.length - 10).toLocaleString('en-US')} more)`]
                : []),
        ];
    const nextLine = formatNext(result, isStale, hasGapRows);
    const footerLine = formatFooter(result.limits, result.scannedFiles ?? result.reach.files, result.engine, index, isStale);
    const headerBlock = [line1, line2, line3].join('\n');
    let tailLines = [...testsLines, ...gapsLines, nextLine, footerLine];
    let tailBlock = tailLines.join('\n');
    // If even header + tail is tight against budget, compact Tests and Gaps so callers/summary fit.
    if (headerBlock.length + 2 + tailBlock.length + 140 > budget) {
        const compactTests = result.tests.length === 0
            ? 'Tests: none'
            : `Tests (${result.tests.length.toLocaleString('en-US')}): ${result.tests[0]}${result.tests.length > 1 ? ` (+${result.tests.length - 1} more)` : ''}`;
        const compactGaps = reasons.length === 0
            ? 'Gaps: none'
            : `Gaps (${reasons.length.toLocaleString('en-US')}): ${formatGapReason(reasons[0], targetFile, targetLine)}${reasons.length > 1 ? ` (+${reasons.length - 1} more)` : ''}`;
        tailLines = [compactTests, compactGaps, nextLine, footerLine];
        tailBlock = tailLines.join('\n');
    }
    const callersBudget = Math.max(0, budget - headerBlock.length - tailBlock.length - 3);
    const callersLines = buildCallersSection(sortedLevels, callersBudget, inBatch);
    const assembled = `${headerBlock}\n\n${callersLines.join('\n')}\n${tailBlock}`;
    if (assembled.length <= budget)
        return assembled;
    // Hard ceiling fallback: keep first three lines, one overflow summary line, and footer.
    const totalCallers = sortedLevels.reduce((sum, level) => sum + level.length, 0);
    const allNodes = sortedLevels.flat();
    const [minDepth, maxDepth] = populatedDepthRange(sortedLevels);
    const overflow = depthOverflowLine(minDepth, maxDepth, totalCallers, distinctFiles(allNodes), inBatch);
    const summary = totalCallers > 0 ? overflow : 'Callers: none';
    const minimal = [headerBlock, summary, nextLine, footerLine].join('\n');
    if (minimal.length <= budget)
        return minimal;
    return [headerBlock, overflow].join('\n').slice(0, budget);
}
function renderFileBlock(fileResult, index, budget, inBatch) {
    const { file, results, remainder, aggregate } = fileResult;
    if (aggregate !== undefined) {
        const single = results.length === 1 ? results[0] : undefined;
        const header = single !== undefined
            ? `IMPACT ${shortName(single.target)} — ${single.span?.file ?? file}:${single.span?.startLine ?? 1} (${file}; ${plural(remainder, 'other declaration', 'other declarations')} with no callers outside file)`
            : results.length === 0
                ? `IMPACT ${file}:1 — 0 exported declarations with callers outside file (${plural(remainder, 'other declaration', 'other declarations')} in file)`
                : `IMPACT ${results.map((r) => shortName(r.target)).join(', ')} — ${file}:1 (${plural(remainder, 'other declaration', 'other declarations')} with no callers outside file)`;
        return renderSymbolBlock(header, aggregate, index, budget, inBatch);
    }
    if (results.length === 1) {
        const single = results[0];
        const locFile = single.span?.file ?? file;
        const locLine = single.span?.startLine ?? 1;
        const line1 = `IMPACT ${shortName(single.target)} — ${locFile}:${locLine} (${file}; ${plural(remainder, 'other declaration', 'other declarations')} with no callers outside file)`;
        return renderSymbolBlock(line1, single, index, budget, inBatch);
    }
    const staleReason = index.state === 'stale'
        ? `stale-index: ${index.driftedFiles.slice(0, 10).join(', ') || 'working tree drifted'}`
        : null;
    if (results.length === 0) {
        const emptyResult = {
            target: `${file}#<module>`,
            span: { file, startLine: 1, endLine: 1 },
            byDepth: [],
            bridged: [],
            tests: [],
            completeness: staleReason !== null
                ? { status: 'partial', reasons: [staleReason] }
                : { status: 'complete', reasons: [] },
            reach: { direct: 0, total: 0, files: 0, packages: 0, crossPackage: false, routes: 0 },
            factors: [],
            limits: fileResult.limits ?? {
                unboundedDynamicImports: 0,
                excludedFiles: 0,
                failedFiles: 0,
            },
            scannedFiles: fileResult.scannedFiles ?? 0,
            verdict: staleReason !== null
                ? {
                    level: 'unknown',
                    action: 'check-gaps',
                    zones: [],
                    requiredActions: [],
                    basis: ['stale-index'],
                }
                : { level: 'low', action: 'proceed', zones: [], requiredActions: [], basis: [] },
            freshness: { workingTreeHash: '', includesUntracked: true },
            engine: fileResult.engine ?? { version: '0.2.0', typescript: 'n/a', extractor: '' },
        };
        const line1 = `IMPACT ${file}:1 — 0 exported declarations with callers outside file (${plural(remainder, 'other declaration', 'other declarations')} in file)`;
        return renderSymbolBlock(line1, emptyResult, index, budget, inBatch);
    }
    // Fallback for synthetic FileImpactResult without aggregate: deduplicate callers at shallowest depth.
    const first = results[0];
    const maxDepth = Math.max(...results.map((r) => r.byDepth.length));
    const seenSymbols = new Set();
    const byDepth = [];
    for (let d = 0; d < maxDepth; d++) {
        const levelMap = new Map();
        for (const r of results) {
            for (const node of r.byDepth[d] ?? []) {
                if (seenSymbols.has(node.symbol))
                    continue;
                levelMap.set(`${node.symbol}\0${node.via}`, node);
            }
        }
        for (const node of levelMap.values())
            seenSymbols.add(node.symbol);
        byDepth.push([...levelMap.values()]);
    }
    const uniqueNodes = byDepth.flat();
    const distinctNodeFiles = new Set(uniqueNodes.map((n) => n.span.file));
    const distinctRouteFiles = new Set(uniqueNodes.filter((n) => n.route).map((n) => n.span.file));
    const reasons = [...new Set(results.flatMap((r) => r.completeness.reasons))].sort();
    const factors = [...new Set(results.flatMap((r) => r.factors))];
    const tests = [...new Set(results.flatMap((r) => r.tests))].sort();
    const incomplete = reasons.length > 0 || results.some((r) => r.completeness.status !== 'complete');
    const combined = {
        target: `${file}#<module>`,
        span: { file, startLine: 1, endLine: 1 },
        byDepth,
        bridged: [],
        tests,
        completeness: { status: incomplete ? 'partial' : 'complete', reasons },
        reach: uniqueNodes.length > 0
            ? {
                direct: new Set((byDepth[0] ?? []).map((n) => n.symbol)).size,
                total: seenSymbols.size,
                files: distinctNodeFiles.size,
                packages: Math.max(...results.map((r) => r.reach.packages)),
                crossPackage: results.some((r) => r.reach.crossPackage),
                routes: distinctRouteFiles.size,
            }
            : {
                direct: Math.max(...results.map((r) => r.reach.direct)),
                total: Math.max(...results.map((r) => r.reach.total)),
                files: Math.max(...results.map((r) => r.reach.files)),
                packages: Math.max(...results.map((r) => r.reach.packages)),
                crossPackage: results.some((r) => r.reach.crossPackage),
                routes: Math.max(...results.map((r) => r.reach.routes)),
            },
        factors,
        limits: first.limits,
        scannedFiles: first.scannedFiles,
        verdict: {
            level: incomplete ? 'unknown' : factors.length > 0 ? 'medium' : 'low',
            action: incomplete ? 'check-gaps' : factors.length > 0 ? 'run-tests' : 'proceed',
            zones: [...new Set(results.flatMap((r) => r.verdict.zones))],
            requiredActions: [...new Set(results.flatMap((r) => r.verdict.requiredActions))],
            basis: [...new Set(results.flatMap((r) => r.verdict.basis))],
        },
        freshness: first.freshness,
        engine: first.engine,
    };
    const names = results.map((r) => shortName(r.target)).join(', ');
    const line1 = `IMPACT ${names} — ${file}:1 (${plural(remainder, 'other declaration', 'other declarations')} with no callers outside file)`;
    return renderSymbolBlock(line1, combined, index, budget, inBatch);
}
/** Render one `ImpactAnswer` within `budget` characters (default 4,000). */
export function renderAnswer(answer, index = DEFAULT_INDEX, options = {}) {
    const budget = options.budget ?? TARGET_BUDGET;
    const inBatch = options.inBatch ?? false;
    if (answer.kind === 'failure') {
        if (answer.message === 'Cancelled' || answer.message === 'index-failed: Cancelled') {
            return 'Cancelled';
        }
        if (answer.code === 'index-failed') {
            const prefix = answer.message.startsWith('index-failed:')
                ? answer.message
                : `index-failed: ${answer.message}`;
            const clean = prefix.endsWith('.') ? prefix.slice(0, -1) : prefix;
            return `${clean}. Retry once; if it fails again, continue without ei_impact and say so in your report.`.slice(0, budget);
        }
        return `INVALID_INPUT: ${answer.message}`.slice(0, budget);
    }
    if (answer.kind === 'guidance') {
        if (answer.code === 'ambiguous-target') {
            const candidates = [...(answer.candidates ?? [])].sort();
            const header = `AMBIGUOUS ${answer.input} — ${plural(candidates.length, 'declaration', 'declarations')}. Call again with one of:`;
            const lines = [header];
            let len = header.length;
            for (let i = 0; i < candidates.length; i++) {
                const line = `  ${candidates[i]}`;
                const remaining = candidates.length - i;
                const overflow = `  (+${remaining.toLocaleString('en-US')} more. Call again with path#name to select one.)`;
                if (len + 1 + line.length + (i + 1 < candidates.length ? 1 + overflow.length : 0) >
                    budget) {
                    lines.push(overflow);
                    break;
                }
                lines.push(line);
                len += 1 + line.length;
            }
            return lines.join('\n').slice(0, budget);
        }
        if (answer.code === 'index-building') {
            return 'INDEX BUILDING — index build still running after 60 s. Call again; the answer will use the finished index.'.slice(0, budget);
        }
        // target-not-found (including NOT INDEXED <path> — <reason>)
        if (answer.message.startsWith('NOT INDEXED ')) {
            return answer.message.slice(0, budget);
        }
        const nearest = (answer.nearest ?? []).slice(0, 5);
        const lines = nearest.length > 0
            ? [
                `NOT FOUND ${answer.input}. Closest names in the index:`,
                ...nearest.map((item) => `  ${item}`),
                'If the symbol is new and unsaved, save the file and call again.',
            ]
            : [`${answer.message}.`, 'If the symbol is new and unsaved, save the file and call again.'];
        return lines.join('\n').slice(0, budget);
    }
    if ('file' in answer.value) {
        return renderFileBlock(answer.value, index, budget, inBatch);
    }
    const result = answer.value;
    const file = result.span?.file ?? fileOfKey(result.target);
    const line = result.span?.startLine ?? 1;
    const name = shortName(result.target);
    let line1;
    if (answer.parentTarget !== undefined) {
        const asked = shortName(answer.input);
        line1 = `IMPACT ${asked} (nearest indexed parent ${answer.parentTarget}) — ${file}:${line}`;
    }
    else if (answer.resolvedFromLine !== undefined) {
        line1 = `IMPACT ${name} — ${file}:${line} (nearest indexed declaration enclosing line ${answer.resolvedFromLine})`;
    }
    else {
        line1 = `IMPACT ${name} — ${file}:${line}`;
    }
    return renderSymbolBlock(line1, result, index, budget, inBatch);
}
/**
 * Render an `ImpactBatch` (1–5 targets) within per-target (4,000) and batch (12,000) budgets.
 * When a batch exceeds 12,000 characters, per-target budgets are scaled down while preserving
 * at least the first three lines (`IMPACT`, `ACTION`, `REACH`) of every target.
 */
export function renderImpact(batch, options = {}) {
    const targetBudget = options.targetBudget ?? TARGET_BUDGET;
    const batchBudget = options.batchBudget ?? BATCH_BUDGET;
    const { answers, index } = batch;
    if (answers.length === 0)
        return '';
    const inBatch = answers.length > 1;
    const blocks = answers.map((answer) => renderAnswer(answer, index, { budget: targetBudget, inBatch }));
    const separatorLen = (answers.length - 1) * 2;
    const totalLen = blocks.reduce((sum, block) => sum + block.length, 0) + separatorLen;
    if (totalLen <= batchBudget)
        return blocks.join('\n\n');
    // Scale per-target budgets so the joined blocks fit within batchBudget while keeping first 3 lines.
    const available = Math.max(0, batchBudget - separatorLen);
    const equalShare = Math.floor(available / answers.length);
    let remainingBudget = available;
    let largeCount = 0;
    for (const block of blocks) {
        if (block.length <= equalShare)
            remainingBudget -= block.length;
        else
            largeCount++;
    }
    const largeShare = largeCount > 0 ? Math.floor(remainingBudget / largeCount) : equalShare;
    const scaled = answers.map((answer, i) => {
        const current = blocks[i];
        if (current.length <= equalShare)
            return current;
        return renderAnswer(answer, index, { budget: Math.min(targetBudget, largeShare), inBatch });
    });
    return scaled.join('\n\n').slice(0, batchBudget);
}
/** Typed `details` payload for `ei_impact` and `ei impact --json`: `ImpactResult[]` and guidance objects. */
export function impactDetails(batch) {
    const out = [];
    for (const answer of batch.answers) {
        if (answer.kind === 'result') {
            if ('target' in answer.value) {
                out.push(answer.value);
            }
            else if (answer.value.aggregate !== undefined) {
                out.push(answer.value.aggregate);
            }
            else if (answer.value.results.length > 0) {
                out.push(...answer.value.results);
            }
            else {
                out.push(answer.value);
            }
        }
        else {
            out.push(answer);
        }
    }
    return out;
}
