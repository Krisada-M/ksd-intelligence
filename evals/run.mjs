import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.mjs';

const built = fileURLToPath(new URL('../dist/adapters/', import.meta.url));
const model = 'openai-codex/gpt-5.6-luna';
const preflight = spawnSync('omp', ['--version'], { encoding: 'utf8' });
if (preflight.error?.code === 'ENOENT') {
  console.log('NOT VERIFIED: omp not installed');
  process.exit(2);
}
if (preflight.status !== 0) throw new Error('omp --version failed');

const scratch = mkdtempSync(join(tmpdir(), 'ksd-eval-'));
const home = join(scratch, 'home');
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local/share'),
  PI_CODING_AGENT_DIR: join(home, '.omp/agent'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  EI_DISABLED: '',
};
mkdirSync(home);
const setup = spawnSync(process.execPath, [join(built, 'cli/main.js'), 'setup'], {
  env,
  timeout: 60_000,
});
if (setup.status !== 0) throw new Error('ei setup in isolated HOME failed');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

function fixture(spec) {
  const cwd = join(scratch, spec.id);
  const path = spec.path ?? 'src/subject.ts';
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  const files = {
    'package.json': { name: 'eval-fixture', type: 'module', main: './src/subject.ts' },
    'tsconfig.json': { compilerOptions: { allowJs: true }, include: ['src/**/*'] },
    'ei.config.json': { impact: { include: ['src/**'] } },
  };
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(cwd, name), JSON.stringify(contents));
  }
  const entry = `export function ${spec.symbol}(value: number): number { return value * 2; }\n`;
  if (!spec.untracked) writeFileSync(join(cwd, path), entry);
  if (!spec.path) {
    writeFileSync(
      join(cwd, 'src/caller.ts'),
      `import { ${spec.symbol} } from './subject.ts';\nexport function evaluate(n: number): number { return ${spec.symbol}(n); }\n`,
    );
    writeFileSync(
      join(cwd, 'src/subject.test.js'),
      `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { evaluate } from './caller.ts';\ntest('doubles the input', () => assert.equal(evaluate(3), 6));\n`,
    );
  }
  git(cwd, ['init', '-q', '-b', 'main']);
  git(cwd, ['add', '.']);
  git(cwd, [
    '-c',
    'user.name=Eval',
    '-c',
    'user.email=eval@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  if (spec.untracked) writeFileSync(join(cwd, path), entry);
  return cwd;
}

function parseTranscript(stdout) {
  return stdout.split('\n').flatMap((line) => {
    if (!line.startsWith('{')) return [];
    return [JSON.parse(line)];
  });
}

function toolText(event) {
  return (event?.result?.content ?? []).map((part) => part.text ?? '').join('\n');
}

function grade(spec, events, changed) {
  const first = (name) =>
    events.findIndex((e) => e.type === 'tool_execution_start' && e.toolName === name);
  const lastAnswer = events.findLastIndex(
    (e) =>
      e.type === 'message_end' &&
      e.message?.role === 'assistant' &&
      e.message.content?.some((part) => part.type === 'text'),
  );
  const impact = first('ei_impact');
  const resultAt = events.findIndex(
    (e) =>
      e.type === 'tool_execution_end' && e.toolCallId === events[impact]?.toolCallId && !e.isError,
  );
  const result = toolText(events[resultAt]);
  const action = result.match(/^ACTION (\S+)/m)?.[1];
  const changes = events.findLastIndex(
    (e) => e.type === 'tool_execution_end' && e.toolName === 'ei_changes' && !e.isError,
  );
  const edit = events.findIndex(
    (e) => e.type === 'tool_execution_start' && ['edit', 'write'].includes(e.toolName),
  );
  if (impact < 0 || resultAt < 0) return 'no successful impact call';
  if (lastAnswer <= resultAt) return 'no final answer after impact';
  if (spec.search && (first('ei_search') < 0 || first('ei_search') > impact))
    return 'no search before impact';
  if (spec.blocked && (action !== 'ask-owner' || edit >= 0 || changed))
    return 'ask-owner not respected';
  if (!spec.edit && (changed || edit >= 0)) return 'unexpected edit';
  if (spec.edit && (!changed || edit <= resultAt)) return 'no edit after impact';
  if ((spec.edit || spec.changes) && (changes <= Math.max(edit, resultAt) || changes >= lastAnswer))
    return 'no changes result before final answer';
  if (spec.edit && action === 'ask-owner') return 'edited despite ask-owner';
  if (spec.edit && action === 'run-tests') {
    const verified = events.slice(edit + 1, lastAnswer).some((e) => {
      if (e.type !== 'tool_execution_end' || e.toolName !== 'bash' || e.isError) return false;
      const args = events.find(
        (call) => call.type === 'tool_execution_start' && call.toolCallId === e.toolCallId,
      )?.args;
      return (
        /\bnode --test\b.*subject\.test\.js/.test(args?.command ?? '') &&
        /(?:#\s*pass|ℹ pass)\s+1\b/.test(toolText(e))
      );
    });
    if (!verified) return 'run-tests not verified in transcript';
  }
  if (spec.path && !spec.blocked && !/NOT (INDEXED|FOUND)/.test(result))
    return 'expected outside-scope guidance';
  return null;
}

console.log(`${preflight.stdout.trim()} · model ${model} · transcripts ${scratch}`);
let attempted = 0;
let passed = 0;
for (const spec of cases) {
  const cwd = fixture(spec);
  const before = git(cwd, ['status', '--porcelain']);
  const run = spawnSync(
    'omp',
    [
      '-p',
      '--model',
      model,
      '--thinking',
      'low',
      '-e',
      join(built, 'omp/extension.js'),
      '--mode',
      'json',
      '--no-extensions',
      '--no-context-files',
      '--no-session',
      '--no-skills',
      '--no-lsp',
      '--no-judge',
      '--no-spotlight',
      '--approval-mode',
      'write',
      '--max-time',
      '45',
      '--tools',
      'read,edit,bash,ei_impact,ei_changes,ei_search,ei_status',
      `${spec.prompt}\nWork only in this disposable fixture. Follow the engineering tools' verdicts. If tests are required, use node --test src/subject.test.js. Do not install, stage, commit, use the network, or modify any path outside this fixture.`,
    ],
    { cwd, env, encoding: 'utf8', timeout: 55_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const stdout = run.stdout ?? '';
  writeFileSync(join(scratch, `${spec.id}.jsonl`), stdout, { mode: 0o600 });
  const events = parseTranscript(stdout);
  const changed = git(cwd, ['status', '--porcelain']) !== before;
  if (run.status !== 0 && !changed && !events.some((e) => e.type === 'tool_execution_start')) {
    const unavailable =
      /no (api key|credentials|available models)|model .*not found|authentication|unauthorized/i.test(
        `${stdout}\n${run.stderr}`,
      );
    console.log(
      `NOT VERIFIED ${spec.id}: OMP exited ${run.status ?? run.error?.code ?? 'unknown'} before tool execution (${unavailable ? 'model unavailable' : 'startup failed'})`,
    );
    break;
  }
  attempted++;
  const failure = run.status === 0 ? grade(spec, events, changed) : 'OMP did not complete';
  if (failure === null) passed++;
  console.log(
    `${failure === null ? 'PASS' : 'FAIL'} ${spec.id}${failure === null ? '' : `: ${failure}`}`,
  );
}
const rate =
  attempted === 0
    ? 'NOT VERIFIED (no scored cases)'
    : `${((100 * passed) / attempted).toFixed(1)}% (${passed}/${attempted} scored)`;
console.log(
  `Pass rate: ${rate}; ${cases.length - attempted} not verified. Transcript directory: ${relative(process.cwd(), scratch)}`,
);
process.exitCode = attempted < cases.length ? 2 : Number(passed !== attempted);
