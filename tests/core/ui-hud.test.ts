import test from 'node:test';
import assert from 'node:assert/strict';
import { openHud, renderHudSummary } from '../../src/adapters/ui/hud.js';

function terminal(columns = 80, isTTY = true): { stream: NodeJS.WriteStream; text: () => string } {
  let output = '';
  const stream = new Proxy(process.stderr, {
    get(target, key, receiver) {
      if (key === 'isTTY') return isTTY;
      if (key === 'columns') return columns;
      if (key === 'write')
        return (chunk: string) => {
          output += chunk;
          return true;
        };
      return Reflect.get(target, key, receiver);
    },
  });
  return { stream, text: () => output };
}

const env: NodeJS.ProcessEnv = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
};

test('inactive HUD emits no escape sequences', () => {
  for (const disabled of [
    { isTTY: false },
    { plain: true },
    { json: true },
    { env: { ...env, NO_COLOR: '' } },
    { env: { ...env, TERM: 'dumb' } },
    { env: { ...env, CI: 'true' } },
    { env: { ...env, EI_NO_ANIMATION: '1' } },
  ]) {
    const { stream, text } = terminal(80, disabled.isTTY !== false);
    const result = openHud({ command: 'index', repo: 'repo', stream, env, ...disabled });
    assert.equal(result, undefined);
    assert.equal(text(), '');
  }
});

test('determinate progress shows eighth blocks and measured counts; indeterminate phase never invents percentage', () => {
  const { stream, text } = terminal();
  const hud = openHud({ command: 'index', repo: 'repo', stream, env, now: () => 1000 });
  assert.ok(hud);
  hud.update({ phase: 'extract', done: 1, total: 128, file: 'src/a.ts', kind: 'cold' });
  assert.match(text(), /extract.*▏.*1\/128/s);
  assert.match(text(), /src\/a\.ts/);
  assert.doesNotMatch(text(), /ETA|\d+%/);
  hud.close();
});

test('redraw throttles bursts, clears pending frame, and restores cursor once', () => {
  const { stream, text } = terminal();
  let now = 0;
  const hud = openHud({ command: 'index', repo: 'repo', stream, env, now: () => now });
  assert.ok(hud);
  hud.update({ phase: 'scan', done: 1, total: 8 });
  const before = text();
  now = 1;
  hud.update({ phase: 'scan', done: 2, total: 8 });
  assert.equal(text(), before);
  hud.close();
  hud.close();
  assert.equal((text().match(/\x1b\[\?25h/g) ?? []).length, 1);
  assert.match(text(), /\x1b\[2K/);
});

test('narrow and ASCII terminals show current phase and ticker without Unicode bars', () => {
  const { stream, text } = terminal(50);
  const hud = openHud({ command: 'doctor', repo: 'repo', stream, env: { ...env, EI_ASCII: '1' } });
  assert.ok(hud);
  hud.update({ phase: 'program', file: 'src/a.ts' });
  assert.match(text(), /program.*building/);
  assert.match(text(), /src\/a\.ts/);
  assert.doesNotMatch(text(), /files\/s|\u28c0|▏/);
  hud.close();
});

test('colour tiers render truecolour, 256-colour and plain 16-colour bars', () => {
  for (const [extra, required, excluded] of [
    [{ COLORTERM: 'truecolor', TERM: 'xterm-256color' }, '\x1b[38;2;', ''],
    [{ TERM: 'xterm-256color' }, '\x1b[38;5;', '\x1b[38;2;'],
    [{ TERM: 'xterm' }, '####', '\x1b[38;'],
  ] as const) {
    const { stream, text } = terminal();
    const hud = openHud({
      command: 'index',
      repo: 'repo',
      stream,
      env: { LANG: 'en_US.UTF-8', ...extra },
    });
    assert.ok(hud);
    hud.update({ phase: 'scan', done: 2, total: 8 });
    assert.ok(text().includes(required), text());
    if (excluded) assert.ok(!text().includes(excluded), text());
    hud.close();
  }
});

test('throughput uses observed count and elapsed time and is exposed for summary', () => {
  const { stream } = terminal();
  let now = 0;
  const hud = openHud({ command: 'index', repo: 'repo', stream, env, now: () => now });
  assert.ok(hud);
  hud.update({ phase: 'extract', done: 0, total: 20 });
  now = 1000;
  hud.update({ phase: 'extract', done: 10, total: 20 });
  assert.deepEqual(hud.throughput, [10]);
  hud.close();
});

test('summary distinguishes measured built, unchanged, failed and partial evidence', () => {
  const built = renderHudSummary({
    command: 'index',
    outcome: 'built',
    kind: 'cold',
    durationMs: 4200,
    previous: { durationMs: 4800 },
    coverage: { scanned: 1240, codeFiles: 1240, outsideScope: 37, extraction: { ok: 1203 } },
    phases: [
      { phase: 'scan', durationMs: 1000 },
      { phase: 'extract', durationMs: 3200 },
    ],
    next: 'ready for ei impact',
  });
  assert.match(built, /index built.*cold.*4\.2s.*−0\.6s vs last/);
  assert.match(built, /coverage.*97%/);
  assert.match(built, /1,203 indexed.*37 outside scope/);
  assert.match(built, /1,203 compiler · 0 lexical only · 0 errors/);
  assert.match(built, /timeline/);
  assert.doesNotMatch(built, /\x1b\[/);
  const updated = renderHudSummary({
    command: 'index',
    outcome: 'updated',
    durationMs: 500,
    drift: '2 changed files',
    coverage: { scanned: 12, codeFiles: 2, outsideScope: 0, extraction: { ok: 2 } },
  });
  assert.match(updated, /index updated.*12 scanned · 2 code files.*0\.5s/);
  assert.match(updated, /drift.*2 changed files/);
  assert.doesNotMatch(updated, /timeline/);
  assert.match(
    renderHudSummary({ command: 'index', outcome: 'unchanged', durationMs: 60 }),
    /index unchanged.*0\.06s/,
  );
  const failed = renderHudSummary({
    command: 'index',
    outcome: 'failed',
    durationMs: 200,
    reason: 'TS failed: bad type',
    activeIndex: 'previous index',
    next: 'ei doctor --deep',
    coverage: { scanned: 1, codeFiles: 1, outsideScope: 0, extraction: { ok: 1 } },
  });
  assert.match(failed, /index failed/);
  assert.match(failed, /TS failed: bad type/);
  assert.match(failed, /previous index/);
  assert.doesNotMatch(failed, /index built|coverage/);
  assert.doesNotMatch(
    renderHudSummary({ command: 'doctor', outcome: 'completed', durationMs: 100 }),
    /coverage|timeline|files\/s/,
  );
});

test('coverage reconciles scanned and code files and colors exact coverage thresholds', () => {
  for (const [indexed, code, percent, color] of [
    [4, 212, '2%', '31'],
    [299, 1000, '30%', '31'],
    [30, 100, '30%', '33'],
    [799, 1000, '80%', '33'],
    [80, 100, '80%', '32'],
  ] as const) {
    const summary = renderHudSummary({
      command: 'index',
      outcome: 'built',
      durationMs: 3210,
      coverage: {
        scanned: 3493,
        codeFiles: code,
        outsideScope: code - indexed,
        extraction: { ok: indexed },
      },
      color: true,
      next: 'ready for ei impact',
    });
    const plain = summary.replaceAll(/\x1b\[[\d;]*m/g, '').replaceAll(/\s+/g, ' ');
    assert.match(plain, new RegExp(`3,493 scanned · ${code.toLocaleString('en-US')} code files`));
    assert.ok(summary.includes(`\x1b[${color}m coverage`));
    assert.ok(plain.includes(` ${percent}`));
    if (indexed === 4) {
      assert.ok(
        plain.includes(
          '› 208 code files outside scope: ei_impact will be partial; check include in ei.config.json',
        ),
      );
      assert.doesNotMatch(summary, /ready for ei impact/);
    }
  }
});

test('coverage includes every in-scope extraction outcome without calling errors lexical', () => {
  const summary = renderHudSummary({
    command: 'index',
    outcome: 'built',
    durationMs: 500,
    coverage: {
      scanned: 15,
      codeFiles: 10,
      outsideScope: 0,
      extraction: { ok: 5, lexical: 2, 'not-in-program': 2, 'parse-error': 1 },
    },
  });
  assert.match(summary, /coverage .*100%/);
  assert.match(summary, /10 indexed/);
  assert.match(summary, /5 compiler · 2 lexical only · 1 errors · 2 not in program/);
  assert.doesNotMatch(summary, /check tsconfig/);
});

test('timeline gives even a short phase a colored stroke and a measured legend entry', () => {
  const input = {
    command: 'index',
    outcome: 'built',
    durationMs: 4880,
    phases: [
      { phase: 'scan', durationMs: 40 },
      { phase: 'program', durationMs: 1200 },
      { phase: 'extract', durationMs: 40 },
      { phase: 'resolve', durationMs: 3500 },
      { phase: 'verify', durationMs: 100 },
      { phase: 'publish', durationMs: 0 },
    ],
  } as const;
  const summary = renderHudSummary({ ...input, color: true });
  const timeline = summary.split('\n').find((line) => line.includes(' timeline ')) ?? '';
  const strokes = [...timeline.matchAll(/\x1b\[([\d;]+)m(━+)/g)];
  assert.equal(strokes.length, 6);
  assert.equal(new Set(strokes.map((match) => match[1])).size, 6);
  assert.match(
    summary.replaceAll(/\s+/g, ' '),
    /scan 40ms · program 1\.2s · extract 40ms · resolve 3\.5s · verify 100ms · publish 0ms/,
  );
  const ascii = renderHudSummary({ ...input, ascii: true });
  assert.match(ascii, /timeline +s+p+e+r+v+u+/);
});

test('files/s waits for both two seconds and five measured samples', () => {
  for (const [elapsed, count, visible] of [
    [1999, 5, false],
    [2000, 4, false],
    [2000, 5, true],
  ] as const) {
    const { stream, text } = terminal();
    let now = 0;
    const hud = openHud({ command: 'index', repo: 'repo', stream, env, now: () => now });
    assert.ok(hud);
    hud.update({ phase: 'extract', done: 0, total: count });
    for (let sample = 1; sample <= count; sample++) {
      now = (elapsed * sample) / count;
      hud.update({ phase: 'extract', done: sample, total: count });
    }
    hud.close();
    assert.equal(text().includes('files/s'), visible, `live: ${elapsed}ms, ${count} samples`);
    const summary = renderHudSummary({
      command: 'index',
      outcome: 'built',
      durationMs: elapsed,
      throughput: hud.throughput,
    });
    assert.equal(summary.includes('files/s'), visible, `summary: ${elapsed}ms, ${count} samples`);
  }
});

test('narrow summaries keep the full include pattern and suggestion', () => {
  const pattern = 'packages/long-service-name/src/another-directory/*';
  const warning = `include "${pattern}" matches 1 files; "${pattern}*" would match 4`;
  const summary = renderHudSummary({
    command: 'index',
    outcome: 'unchanged',
    durationMs: 10,
    columns: 32,
    includeWarnings: [warning],
  });
  assert.ok(summary.replaceAll(/\s/g, '').includes(warning.replaceAll(/\s/g, '')));
  assert.ok(
    summary
      .trimEnd()
      .split('\n')
      .every((line) => [...line].length <= 32),
  );
});
