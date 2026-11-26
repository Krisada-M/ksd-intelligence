const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Escape before applying ANSI so repository-controlled text cannot alter terminal state.
function safe(text) {
    return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
        if (char === '\n')
            return '\\n';
        if (char === '\t')
            return '\\t';
        return `\\u{${char.codePointAt(0)?.toString(16).padStart(2, '0')}}`;
    });
}
function width(text) {
    let size = 0;
    for (const cluster of graphemes.segment(text)) {
        const code = cluster.segment.codePointAt(0) ?? 0;
        if (/\p{Mark}/u.test(cluster.segment[0] ?? '') || code === 0x200d)
            continue;
        size +=
            code >= 0x1100 &&
                (code <= 0x115f ||
                    (code >= 0x2329 && code <= 0x232a) ||
                    (code >= 0x2e80 && code <= 0xa4cf) ||
                    (code >= 0xac00 && code <= 0xd7a3) ||
                    (code >= 0xf900 && code <= 0xfaff) ||
                    (code >= 0xfe10 && code <= 0xfe6f) ||
                    (code >= 0xff01 && code <= 0xff60) ||
                    (code >= 0xffe0 && code <= 0xffe6) ||
                    code >= 0x1f000)
                ? 2
                : 1;
    }
    return size;
}
function styled(text, role, options) {
    const escaped = safe(text);
    if (!options.color || role === undefined)
        return escaped;
    const code = {
        success: '32',
        warning: '33',
        unknown: '35',
        error: '31',
        critical: '1;31',
        dim: '2',
        tag: '36',
    }[role];
    return `\u001b[${code}m${escaped}\u001b[0m`;
}
function symbol(role, options) {
    if (role === 'success')
        return options.ascii ? 'ok' : '✓';
    if (role === 'warning')
        return options.ascii ? '!' : '⚠';
    if (role === 'error' || role === 'critical')
        return options.ascii ? 'x' : '✗';
    return '?';
}
function actionRole(verdict) {
    if (verdict.action === 'ask-owner')
        return 'error';
    if (verdict.action === 'run-tests')
        return 'warning';
    if (verdict.action === 'check-gaps' || verdict.level === 'unknown')
        return 'unknown';
    return 'success';
}
function headline(target, verdict, completeness, options) {
    const role = actionRole(verdict);
    const levelRole = verdict.level === 'critical' ? 'critical' : role;
    return `${styled(symbol(role, options), role, options)} ${styled(target, undefined, options)} ${styled(verdict.action, role, options)} · ${styled(verdict.level, levelRole, options)} · ${safe(completeness)}`;
}
function label(key) {
    return key.includes('#')
        ? key.slice(key.lastIndexOf('#') + 1)
        : key.slice(key.lastIndexOf('/') + 1);
}
function fileOf(key) {
    return key.split('#', 1)[0] ?? key;
}
function shortLocations(locations) {
    const basenames = new Map();
    const paths = new Set(locations);
    for (const path of paths) {
        const base = path.split('/').at(-1) ?? path;
        basenames.set(base, (basenames.get(base) ?? 0) + 1);
    }
    const result = new Map();
    for (const path of paths) {
        const base = path.split('/').at(-1) ?? path;
        result.set(path, basenames.get(base) === 1 ? base : path);
    }
    return result;
}
function nodeRows(nodes) {
    return [...nodes]
        .sort((a, b) => label(a.symbol).localeCompare(label(b.symbol)) ||
        a.span.file.localeCompare(b.span.file) ||
        a.span.startLine - b.span.startLine)
        .map((node) => ({
        text: label(node.symbol),
        location: `${node.span.file}:${node.span.startLine}`,
        tag: node.gapScoped ? 'gap' : node.route ? 'route' : undefined,
    }));
}
function section(name, rows) {
    return { text: name, role: 'dim', children: rows };
}
function folded(rows, options) {
    if (options.all || rows.length <= 10)
        return rows;
    return [...rows.slice(0, 10), { text: `+ ${rows.length - 10} more (--all)`, role: 'dim' }];
}
function wrapWords(text, room) {
    const words = safe(text).split(/ +/);
    const lines = [];
    let current = '';
    for (const word of words) {
        if (current && width(`${current} ${word}`) > room) {
            lines.push(current);
            current = word;
        }
        else {
            current = current ? `${current} ${word}` : word;
        }
    }
    lines.push(current);
    return lines;
}
function linesFor(rows, options) {
    const output = [];
    const paths = shortLocations(rows.flatMap(function collect(row) {
        return [row.location ?? '', ...(row.children ?? []).flatMap(collect)]
            .filter(Boolean)
            .map((item) => item.replace(/:\d+$/, ''));
    }));
    const draw = (items, prefix) => {
        items.forEach((row, index) => {
            const last = index === items.length - 1;
            const continuing = options.ascii ? '|  ' : '│  ';
            const joint = options.ascii ? '|- ' : '├─ ';
            const end = options.ascii ? '\\- ' : '└─ ';
            const branch = last ? '   ' : continuing;
            const connector = last ? end : joint;
            const location = row.location;
            const path = location?.replace(/:\d+$/, '') ?? '';
            const displayed = location === undefined ? '' : `${paths.get(path) ?? path}${location.slice(path.length)}`;
            const tag = row.tag ? ` ${row.tag}` : '';
            const text = safe(row.text) + tag;
            const displayLocation = safe(displayed);
            const inline = displayed !== '' &&
                options.columns >= 60 &&
                width(prefix + connector + text + ' ' + displayLocation) <= options.columns;
            const wrapped = inline
                ? [safe(row.text)]
                : wrapWords(row.text, Math.max(12, options.columns - width(prefix + connector + tag)));
            output.push(`${prefix}${connector}${styled(wrapped[0] ?? '', row.role, options)}${row.tag ? ` ${styled(row.tag, row.tag === 'gap' ? 'unknown' : 'tag', options)}` : ''}${inline ? ` ${styled(displayed, 'dim', options)}` : ''}`);
            for (const continuation of wrapped.slice(1))
                output.push(`${prefix}${branch}${styled(continuation, row.role, options)}`);
            if (displayed !== '' && !inline)
                output.push(`${prefix}${branch}${styled(displayed, 'dim', options)}`);
            if (row.children?.length)
                draw(folded(row.children, options), prefix + branch);
        });
    };
    draw(rows, '');
    return output;
}
function footer(index, scanned, engine) {
    return `${index}${scanned === undefined ? '' : ` · ${scanned} files`}${engine === undefined ? '' : ` · engine ${engine}`}`;
}
function renderImpactResult(result, batch, options) {
    const rows = [
        section(`reach ${result.reach.direct} → ${result.reach.total} · ${result.reach.files} files · ${result.reach.packages} pkgs · ${result.reach.routes} routes`, []),
    ];
    if (result.factors.length)
        rows.push(section('risk', folded(result.factors.map((text) => ({ text })), options)));
    if (result.byDepth.some((level) => level.length))
        rows.push(section('callers', result.byDepth.flatMap((nodes, index) => nodes.length ? [section(`depth ${index + 1}`, nodeRows(nodes))] : [])));
    if (result.bridged.length)
        rows.push(section('gaps · heuristic bridges', nodeRows(result.bridged)));
    if (result.tests.length)
        rows.push(section('tests', result.tests.map((path) => ({ text: label(path), location: path, tag: 'test' }))));
    if (result.completeness.reasons.length)
        rows.push(section('gaps', result.completeness.reasons.map((text) => ({ text, role: 'unknown' }))));
    if (result.verdict.requiredActions.length)
        rows.push(section('next', result.verdict.requiredActions.map((text) => ({ text }))));
    const header = headline(label(result.target), result.verdict, result.completeness.status, options);
    if (options.collapsed)
        return [header];
    return [
        header,
        ...linesFor(rows, options),
        styled(footer(`index ${batch.index.state}`, result.scannedFiles, result.engine.version), 'dim', options),
    ];
}
function renderImpactAnswer(answer, batch, options) {
    if (answer.kind !== 'result') {
        const role = answer.kind === 'failure' ? 'error' : 'unknown';
        return [
            styled(`${symbol(role, options)} ${answer.input} ${answer.code}: ${answer.message}`, role, options),
        ];
    }
    const value = answer.value;
    if ('target' in value)
        return renderImpactResult(value, batch, options);
    const file = value;
    const result = file.aggregate;
    const heading = result
        ? headline(file.file, result.verdict, result.completeness.status, options)
        : `${symbol('unknown', options)} ${safe(file.file)} · ${file.results.length} exported symbols`;
    if (options.collapsed)
        return [heading];
    const rows = file.results.map((entry) => ({
        text: `${label(entry.target)} ${entry.verdict.action} · ${entry.verdict.level}`,
        location: entry.span ? `${entry.span.file}:${entry.span.startLine}` : undefined,
    }));
    if (file.remainder)
        rows.push({ text: `${file.remainder} other declarations` });
    return [
        heading,
        ...linesFor([
            section('symbols', rows),
            ...(result ? [section(`reach ${result.reach.direct} → ${result.reach.total}`, [])] : []),
        ], options),
        styled(footer(`index ${batch.index.state}`, file.scannedFiles, file.engine?.version), 'dim', options),
    ];
}
function outcomeHeader(name, outcome, options) {
    if (outcome.kind === 'result')
        return null;
    const role = outcome.kind === 'failure' ? 'error' : 'unknown';
    return styled(`${symbol(role, options)} ${name} ${outcome.code}: ${outcome.message}`, role, options);
}
function renderChanges({ value: outcome, verificationNote }, options) {
    const unavailable = outcomeHeader('changes', outcome, options);
    if (unavailable !== null)
        return [unavailable];
    if (outcome.kind !== 'result')
        return [];
    const result = outcome.value;
    const header = headline('changes', result.verdict, result.impact.completeness.status, options);
    if (options.collapsed)
        return [header];
    const rows = [];
    if (result.nothingChanged)
        rows.push(section('changed', [{ text: 'nothing changed' }]));
    else {
        rows.push(section('changed', result.changedSymbols.map((item) => ({
            text: `${label(item.symbol)} · ${item.change}`,
            location: item.span ? `${item.span.file}:${item.span.startLine}` : fileOf(item.symbol),
            children: item.directCallers?.length
                ? [section('callers', nodeRows(item.directCallers))]
                : undefined,
        }))));
    }
    if (result.changedFiles.length)
        rows.push(section('files', result.changedFiles.map((item) => ({
            text: `${item.status} ${item.indexed ? 'indexed' : 'outside index'}`,
            location: item.path,
        }))));
    if (result.unindexedDetails?.length)
        rows.push(section('gaps', result.unindexedDetails.map((item) => ({
            text: `${item.reason} · ${item.status}`,
            location: item.path,
            role: 'unknown',
        }))));
    else if (result.unindexedChanges.length)
        rows.push(section('gaps', result.unindexedChanges.map((path) => ({
            text: 'outside index',
            location: path,
            role: 'unknown',
        }))));
    if (result.impact.tests.length)
        rows.push(section('tests', result.impact.tests.map((path) => ({ text: label(path), location: path, tag: 'test' }))));
    if (result.impact.completeness.reasons.length)
        rows.push(section('gaps', result.impact.completeness.reasons.map((text) => ({ text, role: 'unknown' }))));
    const changed = result.nothingChanged !== true && result.changedFiles.length > 0;
    if (changed && verificationNote?.line !== undefined) {
        rows.push(section('verification', [{ text: verificationNote.line }]));
    }
    const nextHint = changed ? verificationNote?.nextHint : undefined;
    if (result.verdict.requiredActions.length || nextHint !== undefined) {
        const next = result.verdict.requiredActions.map((text) => ({ text }));
        if (nextHint !== undefined)
            next.push({ text: nextHint.trimStart() });
        rows.push(section('next', next));
    }
    return [
        header,
        ...linesFor(rows, options),
        styled(footer(`index ${result.indexState ?? 'unknown'}`, result.scannedFiles, result.engine.version), 'dim', options),
    ];
}
function renderSearch(outcome, options) {
    const unavailable = outcomeHeader('search', outcome, options);
    if (unavailable !== null)
        return [unavailable];
    if (outcome.kind !== 'result')
        return [];
    const value = outcome.value;
    const role = value.indexState === 'stale' ? 'unknown' : 'success';
    const header = `${styled(symbol(role, options), role, options)} search ${safe(value.query)} · ${value.totalMatches} matches · ${value.indexState}`;
    if (options.collapsed)
        return [header];
    const rows = [
        section('matches', value.hits.map((hit) => ({
            text: `${label(hit.symbol)} · ${hit.kind}`,
            location: `${hit.span.file}:${hit.span.startLine}`,
            tag: hit.route ? 'route' : undefined,
        }))),
    ];
    if (!value.hits.length && value.totalMatches === 0)
        rows.push(section('next', [
            {
                text: value.indexState === 'stale' ? 'refresh index and search again' : 'try another query',
            },
        ]));
    if (value.staleReason)
        rows.push(section('gaps', [{ text: value.staleReason, role: 'unknown' }]));
    if (value.totalMatches > value.hits.length)
        rows.push(section('next', [
            {
                text: `${value.totalMatches - value.hits.length} matches outside retrieved limit ${value.limit}; refine query or increase --limit`,
            },
        ]));
    return [
        header,
        ...linesFor(rows, options),
        styled(footer(`index ${value.indexState}`, value.scannedFiles, value.engine.version), 'dim', options),
    ];
}
function renderStatus(status, options) {
    const role = status.state === 'ready' ? 'success' : 'warning';
    const header = `${styled(symbol(role, options), role, options)} status ${styled(status.state, role, options)}${status.reason ? ` · ${safe(status.reason)}` : ''}`;
    if (options.collapsed)
        return [header];
    const index = status.index;
    const rows = [
        section('index', index
            ? [
                {
                    text: `${index.coverage.indexable} indexable · ${index.coverage.scanned} scanned · ${index.coverage.packages} packages`,
                },
                { text: `${index.graph.declarations} declarations · ${index.graph.edges} edges` },
                ...index.tsconfigErrors.map((text) => ({ text, role: 'unknown' })),
            ]
            : [{ text: status.indexError ?? 'none yet', role: 'unknown' }]),
        section('runtime', [
            {
                text: `${status.runtime.kind} ${status.runtime.version} · TypeScript ${status.typescript.ok ? status.typescript.runtime.version : status.typescript.reason}`,
            },
        ]),
        section('config', [
            { text: status.config.path ?? 'defaults · run ei init' },
            ...status.config.errors.map((text) => ({ text, role: 'unknown' })),
        ]),
        section('store', [{ text: index?.path ?? status.cacheDir }]),
    ];
    if (status.failure)
        rows.push(section('gaps', [
            {
                text: `${status.failure.reason}: ${status.failure.problems.join('; ')}`,
                role: 'unknown',
            },
        ]));
    if (status.auditWarning)
        rows.push(section('gaps', [{ text: status.auditWarning, role: 'unknown' }]));
    if (status.fix)
        rows.push(section('next', [{ text: status.fix }]));
    return [
        header,
        ...linesFor(rows, options),
        styled(footer('status', index?.coverage.scanned, index?.meta.engine_version), 'dim', options),
    ];
}
function renderAudit(audit, options) {
    const role = audit.corruptLines ? 'warning' : 'success';
    const header = `${styled(symbol(role, options), role, options)} audit · ${audit.totalCalls} calls${audit.since ? ` · since ${safe(audit.since)}` : ''}`;
    if (options.collapsed)
        return [header];
    const counted = (source) => Object.entries(source)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, count]) => ({ text: `${name} ${count}` }));
    const rows = [
        section('tools', counted(audit.callsByTool)),
        section('risk', counted(audit.verdictDistribution)),
        section('gaps', [
            ...(audit.corruptLines
                ? [{ text: `${audit.corruptLines} corrupt lines`, role: 'unknown' }]
                : []),
            ...audit.changedWithoutPriorImpact.map((text) => ({ text, role: 'unknown' })),
        ]),
    ];
    return [
        header,
        ...linesFor(rows, options),
        styled(`${audit.filesRead} audit files read`, 'dim', options),
    ];
}
function renderSkills(input, options) {
    const { discovery, registryIssues } = input;
    const issues = [...discovery.issues, ...registryIssues];
    const role = issues.length ? 'warning' : 'success';
    const header = `${styled(symbol(role, options), role, options)} skills ${safe(input.platform)} · ${discovery.skills.length} discovered · ${issues.length} issues`;
    if (options.collapsed)
        return [header];
    const rows = [
        section('skills', discovery.skills.map((skill) => ({
            text: `${skill.name} · ${skill.explicitOnly ? 'opt-in' : 'auto'} · ${skill.sourceLabel}`,
            location: skill.file,
        }))),
        ...(issues.length
            ? [
                section('gaps', issues.map((issue) => ({
                    text: `${issue.code}: ${issue.message}`,
                    role: 'unknown',
                }))),
            ]
            : []),
    ];
    return [
        header,
        ...linesFor(rows, options),
        styled(`${discovery.autoVisible.length} auto · ${discovery.explicitOnly.length} opt-in`, 'dim', options),
    ];
}
export function renderResultView(input, options) {
    if (input.kind === 'impact') {
        const rows = input.value.answers.flatMap((answer, index) => [
            ...(index ? [''] : []),
            ...renderImpactAnswer(answer, input.value, options),
        ]);
        if (!options.collapsed && input.learningsLine !== undefined) {
            rows.push(safe(input.learningsLine));
        }
        return rows;
    }
    if (input.kind === 'changes')
        return renderChanges(input, options);
    if (input.kind === 'search')
        return renderSearch(input.value, options);
    if (input.kind === 'status')
        return renderStatus(input.value, options);
    if (input.kind === 'audit')
        return renderAudit(input.value, options);
    return renderSkills(input, options);
}
export function terminalViewOptions(input) {
    if (input.json || input.plain || input.env.NO_COLOR !== undefined || input.env.TERM === 'dumb')
        return undefined;
    if (!input.isTTY && (!input.env.FORCE_COLOR || input.env.FORCE_COLOR === '0'))
        return undefined;
    return {
        columns: input.columns,
        color: input.env.FORCE_COLOR !== '0',
        ascii: input.env.EI_ASCII === '1' ||
            !/utf-?8/i.test(input.env.LC_ALL ?? input.env.LC_CTYPE ?? input.env.LANG ?? 'UTF-8'),
        all: input.all,
    };
}
