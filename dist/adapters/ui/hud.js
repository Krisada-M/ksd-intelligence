const blocks = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
const sparkBlocks = '⣀⣄⣤⣦⣶⣷⣿';
const phaseOrder = ['scan', 'program', 'extract', 'resolve', 'verify', 'publish'];
const phaseRamp = ['34', '36', '35', '95', '33', '94'];
const minThroughputMs = 2000;
const minThroughputSamples = 5;
const reset = '\x1b[0m';
function safe(text) {
    return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}
function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0)
        return '?';
    return `${Number((ms / 1000).toFixed(2))}s`;
}
function wrap(text, prefix, columns) {
    const lines = [];
    const indent = ' '.repeat(width(prefix));
    let line = prefix;
    let hasWord = false;
    for (const word of safe(text).split(/ +/)) {
        if (hasWord && width(`${line} ${word}`) > columns) {
            lines.push(line);
            line = indent;
            hasWord = false;
        }
        let remaining = word;
        const room = columns - width(line);
        while (width(remaining) > room) {
            const piece = fit(remaining, room);
            lines.push(line + piece);
            remaining = remaining.slice(piece.length);
            line = indent;
        }
        line += `${hasWord ? ' ' : ''}${remaining}`;
        hasWord = true;
    }
    lines.push(line);
    return lines;
}
function width(text) {
    let size = 0;
    for (const char of text) {
        const point = char.codePointAt(0) ?? 0;
        if (/\p{Mark}/u.test(char) || point === 0x200d || point === 0xfe0f)
            continue;
        size +=
            point >= 0x1100 &&
                (point <= 0x11ff ||
                    (point >= 0x2e80 && point <= 0xa4cf) ||
                    (point >= 0xac00 && point <= 0xd7ff) ||
                    (point >= 0xf900 && point <= 0xfaff) ||
                    (point >= 0xfe10 && point <= 0xfe6f) ||
                    (point >= 0xff01 && point <= 0xff60) ||
                    (point >= 0xffe0 && point <= 0xffe6) ||
                    (point >= 0x1f300 && point <= 0x1faff))
                ? 2
                : 1;
    }
    return size;
}
function fit(text, columns) {
    let result = '';
    let used = 0;
    for (const char of safe(text)) {
        const size = width(char);
        if (used + size > columns)
            break;
        result += char;
        used += size;
    }
    return result;
}
function colorTier(env) {
    if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit')
        return 'truecolor';
    return env.TERM?.includes('256color') ? '256' : '16';
}
function bar(fraction, length, tier, ascii) {
    const eighths = Math.max(0, Math.min(length * 8, Math.round(fraction * length * 8)));
    const full = Math.floor(eighths / 8);
    const rest = eighths % 8;
    if (ascii || tier === '16')
        return `${'#'.repeat(full)}${rest ? ':' : ''}${'.'.repeat(length - full - (rest ? 1 : 0))}`;
    const filled = `${'█'.repeat(full)}${blocks[rest] ?? ''}`;
    if (tier === 'none')
        return filled + '·'.repeat(length - full - (rest ? 1 : 0));
    const ramp = tier === 'truecolor'
        ? [
            '\x1b[38;2;67;190;113m',
            '\x1b[38;2;76;154;240m',
            '\x1b[38;2;163;113;228m',
            '\x1b[38;2;237;119;171m',
        ]
        : ['\x1b[38;5;77m', '\x1b[38;5;75m', '\x1b[38;5;141m', '\x1b[38;5;212m'];
    let colored = '';
    for (let index = 0; index < filled.length; index++) {
        colored += `${ramp[Math.min(3, Math.floor((index * 4) / length))]}${filled[index]}`;
    }
    return `${colored}${reset}${'·'.repeat(length - full - (rest ? 1 : 0))}`;
}
function spark(samples, ascii) {
    if (!samples.length)
        return ascii ? '.' : '⣀';
    const max = Math.max(1, ...samples);
    return samples
        .map((sample) => {
        const index = Math.min(6, Math.floor((sample * 7) / max));
        return ascii ? '.:-=+*#'[index] : sparkBlocks[index];
    })
        .join('');
}
function color(text, code, enabled) {
    return enabled ? `\x1b[${code}m${text}${reset}` : text;
}
export function openHud(options) {
    const { stream, env } = options;
    if (!stream.isTTY ||
        options.plain ||
        options.json ||
        'NO_COLOR' in env ||
        env.TERM === 'dumb' ||
        'CI' in env ||
        env.EI_NO_ANIMATION === '1')
        return undefined;
    const tier = colorTier(env);
    const ascii = tier === '16' ||
        env.EI_ASCII === '1' ||
        !/utf-?8/i.test(`${env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ''}`);
    const now = options.now ?? Date.now;
    const started = now();
    const phases = new Map();
    const samples = [];
    let current;
    let observedPhase;
    const observations = [];
    let latestRate = 0;
    let drawnAt = -Infinity;
    let lines = 0;
    let timer;
    let closed = false;
    let cursorHidden = false;
    function erase() {
        if (!lines)
            return;
        stream.write(`\x1b[${lines}A`);
        for (let index = 0; index < lines; index++)
            stream.write('\r\x1b[2K\x1b[1B');
        stream.write(`\x1b[${lines}A`);
        lines = 0;
    }
    function draw() {
        if (closed || !current)
            return;
        const columns = Math.max(20, stream.columns || 80);
        const narrow = columns < 60;
        const glyph = ascii ? ['-', '>', '+'] : ['◇', '◈', '◆'];
        const phaseNames = options.command === 'index'
            ? [...new Set([...phaseOrder, ...phases.keys()])]
            : [...phases.keys()];
        const currentIndex = phaseNames.indexOf(current.phase);
        const prefix = `${ascii ? '|' : '▌'}ei ${options.command}  `;
        const elapsed = now() - started;
        const suffix = `${current.kind ? ` · ${current.kind}` : ''}  ${duration(elapsed)}`;
        const heading = `${prefix}${fit(options.repo, Math.max(0, columns - width(prefix) - width(suffix)))}${suffix}`;
        const body = [heading];
        if (!narrow && (options.previous || (current.kind === 'cold' && current.reason)))
            body.push(`  ${options.previous ? `last run ${duration(options.previous.durationMs)}` : ''}${current.kind === 'cold' && current.reason ? ` · why: ${safe(current.reason)}` : ''}`);
        if (!narrow)
            body.push('');
        for (const [index, phase] of phaseNames.entries()) {
            if (narrow && phase !== current.phase)
                continue;
            const event = phases.get(phase);
            let status = 0;
            if (index === currentIndex)
                status = 1;
            if (index < currentIndex && event)
                status = 2;
            const done = event?.done;
            const total = event?.total;
            const known = done !== undefined &&
                total !== undefined &&
                total > 0 &&
                Number.isFinite(done) &&
                Number.isFinite(total);
            let fraction = status === 2 ? 1 : 0;
            if (known)
                fraction = Math.min(1, Math.max(0, done) / total);
            let beam = bar(fraction, narrow ? 10 : 16, tier, ascii);
            if (!known && status === 1) {
                const length = narrow || ascii ? 10 : 16;
                const position = Math.floor(now() / 100) % length;
                const dot = ascii ? '.' : '·';
                beam = `${dot.repeat(position)}${ascii ? '#' : '█'}${dot.repeat(length - position - 1)}`;
            }
            let count = '';
            if (known)
                count = `${Math.max(0, done).toLocaleString('en-US')}/${total.toLocaleString('en-US')}`;
            if (!known && status === 2)
                count = 'ok';
            if (!known && status === 1)
                count = 'building';
            const label = ` ${glyph[status]} ${phase.padEnd(8)} ${beam} ${count}`;
            body.push(label);
        }
        if (!narrow && elapsed >= minThroughputMs && samples.length >= minThroughputSamples)
            body.push('', ` files/s ${spark(samples, ascii)}   ${Math.round(latestRate).toLocaleString('en-US')}`);
        if (current.file)
            body.push(` ${ascii ? '>' : '›'} ${safe(current.file)}`);
        erase();
        if (!cursorHidden) {
            stream.write('\x1b[?25l');
            cursorHidden = true;
        }
        for (const line of body)
            stream.write(`\r\x1b[2K${fitAnsi(line, columns)}\n`);
        lines = body.length;
        drawnAt = now();
        timer = setTimeout(draw, 100);
        timer.unref();
    }
    function update(event) {
        if (closed)
            return;
        const time = now();
        if (event.done !== undefined && Number.isFinite(event.done) && event.done >= 0) {
            if (observedPhase !== event.phase ||
                event.done < (observations[observations.length - 1]?.count ?? 0)) {
                observations.length = 0;
                observedPhase = event.phase;
            }
            const baseline = observations[0];
            if (baseline && time > baseline.time && event.done >= baseline.count) {
                latestRate = ((event.done - baseline.count) * 1000) / (time - baseline.time);
                samples.push(latestRate);
                if (samples.length > 24)
                    samples.shift();
            }
            observations.push({ count: event.done, time });
            while (observations.length > 2 && time - (observations[1]?.time ?? time) > 2000)
                observations.shift();
        }
        phases.set(event.phase, event);
        current = {
            ...event,
            kind: event.kind ?? current?.kind,
            reason: event.reason ?? current?.reason,
        };
        if (time - drawnAt < 100)
            return;
        clearTimeout(timer);
        timer = undefined;
        draw();
    }
    return {
        get throughput() {
            return samples;
        },
        update,
        close() {
            if (closed)
                return;
            closed = true;
            clearTimeout(timer);
            erase();
            if (cursorHidden)
                stream.write('\x1b[?25h');
        },
    };
}
// Width is measured on visible characters, not ANSI colour controls.
function fitAnsi(line, columns) {
    const parts = line.split(/(\x1b\[[\d;]*m)/g);
    let remaining = columns;
    let result = '';
    for (const part of parts) {
        if (part.startsWith('\x1b[')) {
            result += part;
            continue;
        }
        const clipped = fit(part, remaining);
        result += clipped;
        remaining -= width(clipped);
        if (remaining <= 0)
            break;
    }
    return line.includes('\x1b[') ? `${result}${reset}` : result;
}
export function renderHudSummary(input) {
    const ascii = input.ascii ?? false;
    const columns = Math.max(20, input.columns ?? 80);
    const enabled = input.color === true;
    const success = input.outcome !== 'failed';
    let mark = ascii ? 'ok' : '◆';
    if (!success)
        mark = ascii ? 'x' : '✗';
    const name = `${input.command} ${input.outcome}`;
    const diff = input.previous && success && Number.isFinite(input.previous.durationMs)
        ? input.durationMs - input.previous.durationMs
        : undefined;
    let comparison = '';
    if (diff !== undefined) {
        let sign = '+';
        if (diff < 0)
            sign = ascii ? '-' : '−';
        comparison = `  ${sign}${duration(Math.abs(diff))} vs last`;
    }
    const coverage = success ? input.coverage : undefined;
    const scanned = coverage?.scanned.toLocaleString('en-US');
    const codeFiles = coverage?.codeFiles ?? 0;
    const count = scanned === undefined
        ? ''
        : ` · ${scanned} scanned · ${codeFiles.toLocaleString('en-US')} code files`;
    const header = `${mark} ${name}${input.kind ? `  ${input.kind}` : ''}${count} · ${duration(input.durationMs)}${comparison}`;
    const compiler = coverage?.extraction.ok ?? 0;
    const lexical = coverage?.extraction.lexical ?? 0;
    const notInProgram = coverage?.extraction['not-in-program'] ?? 0;
    const errors = coverage?.extraction['parse-error'] ?? 0;
    const indexed = compiler + lexical + notInProgram + errors;
    const fraction = codeFiles > 0 ? indexed / codeFiles : 0;
    const lowCoverage = codeFiles > 0 && fraction < 0.8;
    const highLexical = lexical * 5 > indexed;
    let tone = '32';
    if (lowCoverage || highLexical)
        tone = '33';
    if (!success || (codeFiles > 0 && fraction < 0.3))
        tone = '31';
    const lines = wrap(header, '', columns).map((line) => color(line, tone, enabled));
    if (input.reason)
        lines.push(...wrap(input.reason, '  ', columns));
    if (input.drift)
        lines.push(` drift     ${safe(input.drift)}`);
    if (input.activeIndex && !success)
        lines.push(` in use    ${safe(input.activeIndex)}`);
    const phases = input.phases?.filter((phase) => Number.isFinite(phase.durationMs) && phase.durationMs >= 0) ??
        [];
    const totalTime = phases.reduce((sum, phase) => sum + phase.durationMs, 0);
    if (success && phases.length) {
        const extra = Math.max(0, Math.min(24, columns - 12) - phases.length);
        let spent = 0;
        let used = 0;
        const segments = phases.map((phase, index) => {
            spent += phase.durationMs;
            const end = totalTime > 0 ? Math.round((spent / totalTime) * extra) : 0;
            let stroke = '━';
            if (ascii)
                stroke = phase.phase === 'publish' ? 'u' : (phase.phase[0] ?? '?');
            const segment = color(stroke.repeat(1 + end - used), phaseRamp[index % phaseRamp.length] ?? '34', enabled);
            used = end;
            return segment;
        });
        lines.push('', ` timeline  ${segments.join('')}`, ...wrap(phases
            .map(({ phase, durationMs }) => `${phase} ${durationMs < 1000 ? `${durationMs}ms` : duration(durationMs)}`)
            .join(' · '), '           ', columns));
    }
    const throughput = input.throughput;
    if (success &&
        input.durationMs >= minThroughputMs &&
        throughput &&
        throughput.length >= minThroughputSamples)
        lines.push(` files/s   ${spark(throughput, ascii)}   ${Math.round(throughput.at(-1) ?? 0).toLocaleString('en-US')}`);
    const outsideScope = coverage?.outsideScope ?? 0;
    if (codeFiles > 0) {
        const barLine = bar(fraction, Math.min(16, columns - 16), 'none', ascii);
        lines.push(color(` coverage  ${barLine} ${Math.round(fraction * 100)}%`, tone, enabled));
        lines.push(...wrap(`${indexed.toLocaleString('en-US')} indexed · ${outsideScope.toLocaleString('en-US')} outside scope`, '           ', columns));
        const missing = notInProgram === 0 ? '' : ` · ${notInProgram.toLocaleString('en-US')} not in program`;
        lines.push(...wrap(`${compiler.toLocaleString('en-US')} compiler · ${lexical.toLocaleString('en-US')} lexical only · ${errors.toLocaleString('en-US')} errors${missing}`, '           ', columns));
    }
    const hints = [...(input.includeWarnings ?? [])];
    if (lowCoverage) {
        if (outsideScope > 0) {
            hints.push(`${outsideScope.toLocaleString('en-US')} code files outside scope: ei_impact will be partial; check include in ei.config.json`);
        }
        else {
            hints.push(`${(codeFiles - indexed).toLocaleString('en-US')} code files unindexed: ei_impact will be partial; check ei status`);
        }
    }
    if (highLexical)
        hints.push(`${lexical.toLocaleString('en-US')} files are not in a TypeScript program: ei_impact will be partial; check tsconfig include / allowJs`);
    if (!lowCoverage && !highLexical && input.next)
        hints.push(input.next);
    if (hints.length > 0)
        lines.push('');
    for (const hint of hints)
        lines.push(...wrap(hint, ascii ? ' > ' : ' › ', columns));
    return `${lines.map((line) => fitAnsi(line, columns)).join('\n')}\n`;
}
