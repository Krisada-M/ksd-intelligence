export interface HudEvent {
  phase: string;
  done?: number;
  total?: number;
  file?: string;
  kind?: 'cold' | 'update';
  reason?: string;
}

export interface HudPrevious {
  durationMs: number;
  reason?: string;
}

export interface Hud {
  readonly throughput: readonly number[];
  update(event: HudEvent): void;
  close(): void;
}

export interface HudOptions {
  command: 'index' | 'setup' | 'doctor';
  repo: string;
  stream: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  plain?: boolean;
  json?: boolean;
  previous?: HudPrevious;
  now?: () => number;
}

export interface HudSummary {
  command: 'index' | 'setup' | 'doctor';
  outcome: 'built' | 'updated' | 'unchanged' | 'failed' | 'completed';
  durationMs: number;
  kind?: 'cold' | 'update';
  previous?: HudPrevious;
  reason?: string;
  phases?: readonly { phase: string; durationMs: number }[];
  indexed?: number;
  outsideScope?: number;
  errors?: number;
  files?: number;
  drift?: string;
  activeIndex?: string;
  next?: string;
  throughput?: readonly number[];
  columns?: number;
  color?: boolean;
  ascii?: boolean;
}

const blocks = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
const sparkBlocks = '⣀⣄⣤⣦⣶⣷⣿';
const phaseOrder = ['scan', 'program', 'extract', 'resolve', 'verify', 'publish'];
const reset = '\x1b[0m';

function safe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  return `${Number((ms / 1000).toFixed(2))}s`;
}

function width(text: string): number {
  let size = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(char) || point === 0x200d || point === 0xfe0f) continue;
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

function fit(text: string, columns: number): string {
  let result = '';
  let used = 0;
  for (const char of safe(text)) {
    const size = width(char);
    if (used + size > columns) break;
    result += char;
    used += size;
  }
  return result;
}

function colorTier(env: NodeJS.ProcessEnv): 'truecolor' | '256' | '16' {
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  return env.TERM?.includes('256color') ? '256' : '16';
}

function bar(
  fraction: number,
  length: number,
  tier: 'truecolor' | '256' | '16' | 'none',
  ascii: boolean,
): string {
  const eighths = Math.max(0, Math.min(length * 8, Math.round(fraction * length * 8)));
  const full = Math.floor(eighths / 8);
  const rest = eighths % 8;
  if (ascii || tier === '16')
    return `${'#'.repeat(full)}${rest ? ':' : ''}${'.'.repeat(length - full - (rest ? 1 : 0))}`;
  const filled = `${'█'.repeat(full)}${blocks[rest] ?? ''}`;
  if (tier === 'none') return filled + '·'.repeat(length - full - (rest ? 1 : 0));
  const ramp =
    tier === 'truecolor'
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

function spark(samples: readonly number[], ascii: boolean): string {
  if (!samples.length) return ascii ? '.' : '⣀';
  const max = Math.max(1, ...samples);
  return samples
    .map((sample) => {
      const index = Math.min(6, Math.floor((sample * 7) / max));
      return ascii ? '.:-=+*#'[index] : sparkBlocks[index];
    })
    .join('');
}

function color(text: string, code: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${text}${reset}` : text;
}

export function openHud(options: HudOptions): Hud | undefined {
  const { stream, env } = options;
  if (
    !stream.isTTY ||
    options.plain ||
    options.json ||
    'NO_COLOR' in env ||
    env.TERM === 'dumb' ||
    'CI' in env ||
    env.EI_NO_ANIMATION === '1'
  )
    return undefined;

  const tier = colorTier(env);
  const ascii =
    tier === '16' ||
    env.EI_ASCII === '1' ||
    !/utf-?8/i.test(`${env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ''}`);
  const now = options.now ?? Date.now;
  const started = now();
  const phases = new Map<string, HudEvent>();
  const samples: number[] = [];
  let current: HudEvent | undefined;
  let observedPhase: string | undefined;
  const observations: { count: number; time: number }[] = [];
  let latestRate = 0;
  let drawnAt = -Infinity;
  let lines = 0;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let cursorHidden = false;

  function erase(): void {
    if (!lines) return;
    stream.write(`\x1b[${lines}A`);
    for (let index = 0; index < lines; index++) stream.write('\r\x1b[2K\x1b[1B');
    stream.write(`\x1b[${lines}A`);
    lines = 0;
  }

  function draw(): void {
    if (closed || !current) return;
    const columns = Math.max(20, stream.columns || 80);
    const narrow = columns < 60;
    const glyph = ascii ? ['-', '>', '+'] : ['◇', '◈', '◆'];
    const phaseNames =
      options.command === 'index'
        ? [...new Set([...phaseOrder, ...phases.keys()])]
        : [...phases.keys()];
    const currentIndex = phaseNames.indexOf(current.phase);
    const prefix = `${ascii ? '|' : '▌'}ei ${options.command}  `;
    const suffix = `${current.kind ? ` · ${current.kind}` : ''}  ${duration(now() - started)}`;
    const heading = `${prefix}${fit(options.repo, Math.max(0, columns - width(prefix) - width(suffix)))}${suffix}`;
    const body = [heading];
    if (!narrow && (options.previous || (current.kind === 'cold' && current.reason)))
      body.push(
        `  ${options.previous ? `last run ${duration(options.previous.durationMs)}` : ''}${current.kind === 'cold' && current.reason ? ` · why: ${safe(current.reason)}` : ''}`,
      );
    if (!narrow) body.push('');
    for (const [index, phase] of phaseNames.entries()) {
      if (narrow && phase !== current.phase) continue;
      const event = phases.get(phase);
      let status = 0;
      if (index === currentIndex) status = 1;
      if (index < currentIndex && event) status = 2;
      const done = event?.done;
      const total = event?.total;
      const known =
        done !== undefined &&
        total !== undefined &&
        total > 0 &&
        Number.isFinite(done) &&
        Number.isFinite(total);
      let fraction = status === 2 ? 1 : 0;
      if (known) fraction = Math.min(1, Math.max(0, done) / total);
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
      if (!known && status === 2) count = 'ok';
      if (!known && status === 1) count = 'building';
      const label = ` ${glyph[status]} ${phase.padEnd(8)} ${beam} ${count}`;
      body.push(label);
    }
    if (!narrow)
      body.push(
        '',
        samples.length
          ? ` files/s ${spark(samples, ascii)}   ${Math.round(latestRate).toLocaleString('en-US')}`
          : ' files/s measuring',
      );
    if (current.file) body.push(` ${ascii ? '>' : '›'} ${safe(current.file)}`);
    erase();
    if (!cursorHidden) {
      stream.write('\x1b[?25l');
      cursorHidden = true;
    }
    for (const line of body) stream.write(`\r\x1b[2K${fitAnsi(line, columns)}\n`);
    lines = body.length;
    drawnAt = now();
    timer = setTimeout(draw, 100);
    timer.unref();
  }

  function update(event: HudEvent): void {
    if (closed) return;
    const time = now();
    if (event.done !== undefined && Number.isFinite(event.done) && event.done >= 0) {
      if (
        observedPhase !== event.phase ||
        event.done < (observations[observations.length - 1]?.count ?? 0)
      ) {
        observations.length = 0;
        observedPhase = event.phase;
      }
      const baseline = observations[0];
      if (baseline && time > baseline.time && event.done >= baseline.count) {
        latestRate = ((event.done - baseline.count) * 1000) / (time - baseline.time);
        samples.push(latestRate);
        if (samples.length > 24) samples.shift();
      }
      observations.push({ count: event.done, time });
      while (observations.length > 2 && time - (observations[1]?.time ?? time) > 2000)
        observations.shift();
    }
    phases.set(event.phase, event);
    current = event;
    if (time - drawnAt < 100) return;
    clearTimeout(timer);
    timer = undefined;
    draw();
  }

  return {
    get throughput(): readonly number[] {
      return samples;
    },
    update,
    close(): void {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      erase();
      if (cursorHidden) stream.write('\x1b[?25h');
    },
  };
}

// Width is measured on visible characters, not ANSI colour controls.
function fitAnsi(line: string, columns: number): string {
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
    if (remaining <= 0) break;
  }
  return line.includes('\x1b[') ? `${result}${reset}` : result;
}

export function renderHudSummary(input: HudSummary): string {
  const ascii = input.ascii ?? false;
  const columns = Math.max(20, input.columns ?? 80);
  const enabled = input.color === true;
  const success = input.outcome !== 'failed';
  let mark = ascii ? 'ok' : '◆';
  if (!success) mark = ascii ? 'x' : '✗';
  const name = `${input.command} ${input.outcome}`;
  const diff =
    input.previous && success && Number.isFinite(input.previous.durationMs)
      ? input.durationMs - input.previous.durationMs
      : undefined;
  let comparison = '';
  if (diff !== undefined) {
    let sign = '+';
    if (diff < 0) sign = ascii ? '-' : '−';
    comparison = `  ${sign}${duration(Math.abs(diff))} vs last`;
  }
  const count = input.files === undefined ? '' : ` · ${input.files.toLocaleString('en-US')} files`;
  const header = `${mark} ${name}${input.kind ? `  ${input.kind}` : ''}${count} · ${duration(input.durationMs)}${comparison}`;
  const lines = [color(fit(header, columns), success ? '32' : '31', enabled)];
  if (input.reason) lines.push(`  ${safe(input.reason)}`);
  if (input.drift) lines.push(` drift     ${safe(input.drift)}`);
  if (input.activeIndex && !success) lines.push(` in use    ${safe(input.activeIndex)}`);
  const phases =
    input.phases?.filter((phase) => Number.isFinite(phase.durationMs) && phase.durationMs >= 0) ??
    [];
  const totalTime = phases.reduce((sum, phase) => sum + phase.durationMs, 0);
  if (success && phases.length && totalTime > 0) {
    const size = Math.min(24, columns - 12);
    let spent = 0;
    const segments = phases.map((phase, index) => {
      const start = Math.round((spent / totalTime) * size);
      spent += phase.durationMs;
      const end = index === phases.length - 1 ? size : Math.round((spent / totalTime) * size);
      const ramp = ['32', '34', '35', '95'];
      let stroke = index % 2 ? '─' : '━';
      if (ascii) stroke = index % 2 ? '-' : '=';
      return color(
        stroke.repeat(Math.max(0, end - start)),
        ramp[index % ramp.length] ?? '32',
        enabled,
      );
    });
    lines.push(
      '',
      ` timeline  ${segments.join('')}`,
      `           ${phases.map((phase) => safe(phase.phase)).join(' ')}`,
    );
  }
  if (success && input.throughput?.length)
    lines.push(
      ` files/s   ${spark(input.throughput, ascii)}   ${Math.round(input.throughput[input.throughput.length - 1] ?? 0).toLocaleString('en-US')}`,
    );
  if (
    success &&
    input.indexed !== undefined &&
    input.outsideScope !== undefined &&
    input.indexed + input.outsideScope > 0
  ) {
    const percentage = Math.round((100 * input.indexed) / (input.indexed + input.outsideScope));
    lines.push(
      ` coverage  ${bar(input.indexed / (input.indexed + input.outsideScope), Math.min(16, columns - 15), enabled ? '256' : 'none', ascii)} ${percentage}%`,
    );
    lines.push(
      `           ${input.indexed.toLocaleString('en-US')} indexed · ${input.outsideScope.toLocaleString('en-US')} outside scope${input.errors === undefined ? '' : ` · ${input.errors.toLocaleString('en-US')} errors`}`,
    );
  }
  if (input.next) lines.push('', ` ${ascii ? '>' : '›'} ${safe(input.next)}`);
  return `${lines.map((line) => fitAnsi(line, columns)).join('\n')}\n`;
}
