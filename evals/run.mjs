import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases } from './cases.mjs';
import { grade } from './grade.mjs';
import { testPath, testToolName } from './test-tool.mjs';

const built = fileURLToPath(new URL('../dist/adapters/', import.meta.url));
const model = process.env.EI_EVAL_MODEL ?? 'openai-codex/gpt-5.6-luna';
const tempRoot = realpathSync(tmpdir());
const scratch = mkdtempSync(join(tempRoot, 'ksd-eval-'));
const overlay = join(scratch, 'omp-eval.yml');
const testFile = join(scratch, 'subject.test.js');
const testSource = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './caller.ts';
test('doubles the input', () => assert.equal(evaluate(3), 6));
`;
const requestedHome = process.env.EI_EVAL_HOME;
const home = requestedHome === undefined ? join(scratch, 'home') : realpathSync(requestedHome);
if (requestedHome === undefined) {
  mkdirSync(home, { mode: 0o700 });
} else {
  const normalHome = realpathSync(homedir());
  const dir = statSync(home);
  if (
    !home.startsWith(`${tempRoot}${sep}`) ||
    home === normalHome ||
    home.startsWith(`${normalHome}${sep}`) ||
    normalHome.startsWith(`${home}${sep}`) ||
    !dir.isDirectory() ||
    dir.uid !== process.getuid?.() ||
    (dir.mode & 0o077) !== 0 ||
    ['.omp', '.omp/agent'].some((path) =>
      lstatSync(join(home, path), { throwIfNoEntry: false })?.isSymbolicLink(),
    )
  ) {
    console.error('EI_EVAL_HOME must be a dedicated private directory created with mktemp -d');
    process.exit(2);
  }
}

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local/share'),
  XDG_STATE_HOME: join(home, '.local/state'),
  OMP_PROFILE: '',
  PI_CODING_AGENT_DIR: join(home, '.omp/agent'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  EI_DISABLED: '',
};
const preflight = spawnSync('omp', ['--version'], { env, encoding: 'utf8' });
if (preflight.error?.code === 'ENOENT') {
  console.log('NOT VERIFIED: omp not installed');
  process.exit(2);
}
if (preflight.status !== 0) throw new Error('omp --version failed');

const setup = spawnSync(process.execPath, [join(built, 'cli/main.js'), 'setup'], {
  env,
  timeout: 60_000,
});
if (setup.status !== 0) throw new Error('ei setup in isolated HOME failed');

// Authorize only the fixed sandbox, not OMP's general execution tools.
writeFileSync(overlay, `tools:\n  approval:\n    ${testToolName}: allow\n`, { mode: 0o600 });
writeFileSync(testFile, testSource, { mode: 0o600 });
const node = realpathSync(process.execPath);

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
    writeFileSync(join(cwd, testPath), testSource);
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
      '-e',
      fileURLToPath(new URL('./test-tool.mjs', import.meta.url)),
      '--config',
      overlay,
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
      `read,edit,${testToolName},ei_impact,ei_changes,ei_search,ei_status`,
      `${spec.prompt}\nWork only in this disposable fixture. Follow the engineering tools' verdicts. If tests are required, call ${testToolName}. Do not install, stage, commit, use the network, or modify any path outside this fixture.`,
    ],
    {
      cwd,
      env: { ...env, EI_EVAL_FIXTURE: cwd, EI_EVAL_NODE: node, EI_EVAL_TEST_FILE: testFile },
      encoding: 'utf8',
      timeout: 55_000,
      maxBuffer: 8 * 1024 * 1024,
    },
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
    if (unavailable && requestedHome === undefined) {
      console.log('For Codex login, set EI_EVAL_HOME as shown in docs/release-checklist.md.');
    }
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
