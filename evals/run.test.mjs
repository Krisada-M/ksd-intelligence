import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { grade } from './grade.mjs';
import { runFixtureTest, testPath, testToolName } from './test-tool.mjs';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

test('eval OMP uses only the explicitly selected private home', (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ksd-eval-home-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const normalHome = join(root, 'normal');
  const evalHome = join(root, 'eval');
  const probe = join(root, 'omp-home.txt');
  const linkedHome = join(root, 'linked');
  for (const path of [normalHome, evalHome]) mkdirSync(path, { mode: 0o700 });
  symlinkSync(normalHome, linkedHome);
  // Stop at the first OMP invocation so verification never spends model quota.
  writeFileSync(
    join(root, 'omp'),
    '#!/bin/sh\nprintf "%s\\n" "$HOME" "$PI_CODING_AGENT_DIR" >"$OMP_PROBE"\nexit 1\n',
    { mode: 0o700 },
  );
  const run = (home) =>
    spawnSync(process.execPath, [runner], {
      env: {
        ...process.env,
        HOME: normalHome,
        USERPROFILE: normalHome,
        PI_CODING_AGENT_DIR: join(normalHome, '.omp/agent'),
        OMP_PROBE: probe,
        EI_EVAL_HOME: home,
        TMPDIR: root,
        PATH: [root, process.env.PATH].join(delimiter),
      },
      encoding: 'utf8',
    });
  run(evalHome);
  assert.equal(readFileSync(probe, 'utf8'), `${evalHome}\n${join(evalHome, '.omp/agent')}\n`);
  rmSync(probe);
  symlinkSync(join(normalHome, '.omp'), join(evalHome, '.omp'));
  for (const path of [linkedHome, evalHome]) {
    const refused = run(path);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /EI_EVAL_HOME.*private/);
    assert.equal(existsSync(probe), false);
  }
});

const end = (toolName, text, isError = false, details) => ({
  type: 'tool_execution_end',
  toolName,
  isError,
  result: { content: [{ type: 'text', text }], details },
});
const start = (toolName, toolCallId) => ({ type: 'tool_execution_start', toolName, toolCallId });
const impactVerdict = (action) =>
  end('ei_impact', 'Impact summary', false, [{ verdict: { action } }]);
const edit = [start('edit', 'edit'), end('edit', 'File updated')];
const proceed = end('ei_changes', 'Changes summary', false, { verdict: { action: 'proceed' } });
const answer = {
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Reported evidence.' }] },
};

test('a failed impact call does not mask a successful retry before review', () => {
  const impactError = { ...end('ei_impact', 'index-failed', true), toolCallId: 'first' };
  const impactOk = { ...end('ei_impact', 'ACTION proceed'), toolCallId: 'retry' };
  const events = [
    { type: 'tool_execution_start', toolName: 'ei_impact', toolCallId: 'first' },
    impactError,
    { type: 'tool_execution_start', toolName: 'ei_impact', toolCallId: 'retry' },
    impactOk,
    end('ei_changes', 'Nothing changed in working tree'),
    answer,
  ];
  assert.equal(grade({ changes: true }, events, false), null);
});

for (const [action, failure] of [
  ['run-tests', 'run-tests not verified in transcript'],
  ['ask-owner', 'edited despite ask-owner'],
]) {
  test(`target-not-found does not mask a later ${action} verdict before editing`, () => {
    const notFound = end('ei_impact', 'Target not found', false, [{ code: 'target-not-found' }]);
    const check = (...impacts) =>
      grade({ edit: true }, [notFound, ...impacts, ...edit, proceed, answer], true);
    assert.equal(check(impactVerdict(action)), failure);
    assert.equal(check(impactVerdict(action), impactVerdict('proceed')), failure);
  });
}

test('required tests need a passing sandbox result after the last edit', () => {
  const prefix = [impactVerdict('run-tests'), ...edit];
  const runTest = start(testToolName, 'test');
  const pass = {
    ...end(testToolName, '# pass 1', false, { passed: true }),
    toolCallId: runTest.toolCallId,
  };
  const check = (...events) => grade({ edit: true }, [...prefix, ...events, proceed, answer], true);
  assert.equal(check(...edit, runTest, pass), null);
  assert.equal(check(runTest, pass, ...edit), 'run-tests not verified in transcript');
  assert.equal(check(runTest, { ...pass, isError: true }), 'run-tests not verified in transcript');
  assert.equal(
    check(end('bash', '# pass 1', false, { passed: true })),
    'run-tests not verified in transcript',
  );
});

test('sandbox test must start after the last edit and match the passing result', () => {
  const runTest = start(testToolName, 'early');
  const pass = { ...end(testToolName, '# pass 1', false, { passed: true }), toolCallId: 'early' };
  const check = (...events) =>
    grade({ edit: true }, [impactVerdict('run-tests'), ...events, proceed, answer], true);
  assert.equal(check(...edit, runTest, pass), null);
  assert.equal(check(runTest, ...edit, pass), 'run-tests not verified in transcript');
  assert.equal(
    check(runTest, ...edit, start(testToolName, 'later'), pass),
    'run-tests not verified in transcript',
  );
});

test('sandbox blocks host files', { skip: process.platform !== 'linux' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ksd-eval-test-tool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'fixture');
  const node = realpathSync(process.execPath);
  const testFile = join(root, 'original');
  const hostFile = join(root, 'outside');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
  writeFileSync(join(cwd, testPath), 'throw new Error("modified test should not run");');
  writeFileSync(hostFile, 'outside');
  writeFileSync(join(cwd, 'src/subject.js'), 'export const answer = 42;');
  writeFileSync(
    testFile,
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answer } from './subject.js';
test('doubles the input', () => {
  assert.equal(answer, 42);
  assert.throws(() => readFileSync(${JSON.stringify(hostFile)}), { code: 'ENOENT' });
  assert.equal(process.env.HOME, undefined);
});
`,
  );
  const good = runFixtureTest(cwd, node, testFile);
  assert.equal(good.passed, true, good.output);
  writeFileSync(join(cwd, 'src/subject.js'), 'export const answer = 0;');
  const bad = runFixtureTest(cwd, node, testFile);
  assert.equal(bad.passed, false);
  assert.match(bad.output, /0 !== 42/);
});
