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
    indexed: 1203,
    outsideScope: 37,
    errors: 0,
    phases: [
      { phase: 'scan', durationMs: 1000 },
      { phase: 'extract', durationMs: 3200 },
    ],
    next: 'ready for ei impact',
  });
  assert.match(built, /index built.*cold.*4\.2s.*−0\.6s vs last/);
  assert.match(built, /coverage.*97%/);
  assert.match(built, /1,203 indexed.*37 outside scope.*0 errors/);
  assert.match(built, /timeline/);
  assert.doesNotMatch(built, /\x1b\[/);
  const updated = renderHudSummary({
    command: 'index',
    outcome: 'updated',
    durationMs: 500,
    drift: '2 changed files',
    files: 2,
  });
  assert.match(updated, /index updated.*2 files.*0\.5s/);
  assert.match(updated, /drift.*2 changed files/);
  assert.doesNotMatch(updated, /coverage|timeline/);
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
    indexed: 1,
    outsideScope: 0,
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
