import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseProjectConfig, type ProjectConfig } from '../../src/core/kernel/config.js';
import { parseJunit, parseOutput, parseTap } from '../../src/core/verify/parse.js';
import { latestReports, REPORTS_PER_CHECK } from '../../src/core/verify/store.js';
import {
  runVerification,
  validateVerifyInput,
  type VerifyWorkspace,
} from '../../src/core/verify/verify.js';

const NODE = process.execPath;
const dirs: string[] = [];

after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    stdio: 'ignore',
  });
}

function config(checks: unknown[] = [], reports: unknown[] = []): ProjectConfig {
  const { config: parsed, errors } = parseProjectConfig(
    JSON.stringify({ verification: { enabled: true, checks, reports } }),
  );
  assert.deepEqual(errors, []);
  return parsed;
}

function nodeCheck(name: string, script: string, timeoutSec = 30): unknown {
  return { name, command: [NODE, '-e', script], timeoutSec };
}

/** A committed repo whose ei.config.json holds the given verification section. */
async function repo(cfg: ProjectConfig): Promise<VerifyWorkspace> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ei-verify-')));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  await writeFile(join(root, 'ei.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  dirs.push(`${root}-cache`);
  return { root, cacheDir: `${root}-cache`, config: cfg };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('verify: input boundary', () => {
  it('rejects names with separators, spaces or paths and anything but one name', () => {
    for (const bad of ['unit;rm -rf /', 'unit test', '../unit', 'a/b', '$(id)', '', '-x']) {
      assert.equal(validateVerifyInput({ check: bad }).ok, false, bad);
    }
    assert.equal(validateVerifyInput({ check: 'unit', report: 'junit' }).ok, false);
    assert.equal(validateVerifyInput({ check: 'unit', command: ['sh'] }).ok, false);
    assert.equal(validateVerifyInput({ check: ['unit'] }).ok, false);
    assert.deepEqual(validateVerifyInput({ check: 'unit' }), {
      ok: true,
      request: { check: 'unit' },
    });
  });

  it('a name outside the allowlist runs nothing', async () => {
    const ws = await repo(config([nodeCheck('unit', 'process.exit(0)')]));
    let calls = 0;
    const runner = async (): Promise<never> => {
      calls++;
      throw new Error('must not run');
    };
    for (const name of ['lint', 'unit;id']) {
      const outcome = await runVerification(ws, { check: name }, { runner });
      if (outcome.kind === 'failure') {
        assert.equal(outcome.code, 'INVALID_INPUT');
        continue;
      }
      assert.equal(outcome.value.status, 'NOT_VERIFIED');
    }
    assert.equal(calls, 0);
    assert.deepEqual(latestReports(ws.cacheDir), []);
  });

  it('an uncommitted edit to ei.config.json runs nothing', async () => {
    const ws = await repo(config([nodeCheck('unit', 'process.exit(0)')]));
    await writeFile(join(ws.root, 'ei.config.json'), '{"verification":{"enabled":true}}\n');
    let calls = 0;
    const outcome = await runVerification(
      ws,
      { check: 'unit' },
      {
        runner: async () => {
          calls++;
          throw new Error('must not run');
        },
      },
    );
    assert.equal(outcome.kind, 'result');
    assert.equal(outcome.kind === 'result' && outcome.value.status, 'NOT_VERIFIED');
    assert.equal(calls, 0);
  });

  it('config drops malformed checks instead of guessing', () => {
    const { config: cfg, errors } = parseProjectConfig(
      JSON.stringify({
        verification: {
          enabled: true,
          checks: [
            { name: 'a b', command: ['npm', 'test'] },
            { name: 'shell', command: 'npm test' },
            { name: 'ok', command: ['npm', 'test'] },
            { name: 'ok', command: ['npm', 'run', 'lint'] },
          ],
        },
      }),
    );
    assert.deepEqual(cfg.verification.checks, [
      { name: 'ok', command: ['npm', 'test'], timeoutSec: 600 },
    ]);
    assert.equal(errors.length, 3);
  });
});

describe('verify: status rules', () => {
  it('exit 0 with "0 tests" output is SKIPPED, never PASS', async () => {
    const ws = await repo(config([nodeCheck('unit', 'console.log("# tests 0\\n# pass 0")')]));
    const outcome = await runVerification(ws, { check: 'unit' });
    assert.equal(outcome.kind === 'result' && outcome.value.status, 'SKIPPED');
  });

  it('a runner that prints PASS but exits 1 is FAIL', async () => {
    const ws = await repo(
      config([
        nodeCheck(
          'unit',
          'console.log("PASS all good\\n# tests 3\\n# pass 3\\n# fail 0"); process.exit(1)',
        ),
      ]),
    );
    const outcome = await runVerification(ws, { check: 'unit' });
    assert.ok(outcome.kind === 'result');
    assert.equal(outcome.value.status, 'FAIL');
    assert.equal(outcome.value.exitCode, 1);
  });

  it('exit 0 with tests run is PASS, and the report is stored', async () => {
    const ws = await repo(
      config([nodeCheck('unit', 'console.log("# tests 2\\n# pass 2\\n# fail 0")')]),
    );
    const outcome = await runVerification(ws, { check: 'unit' });
    assert.ok(outcome.kind === 'result');
    assert.equal(outcome.value.status, 'PASS');
    assert.deepEqual(outcome.value.counts, { tests: 2, passed: 2, failed: 0, skipped: 0 });
    assert.equal(latestReports(ws.cacheDir)[0]?.status, 'PASS');
  });

  it('timeout is ERROR and the whole process tree is gone', async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log('grandchild ' + c.pid);",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const ws = await repo(config([nodeCheck('slow', script, 1)]));
    const outcome = await runVerification(ws, { check: 'slow' });
    assert.ok(outcome.kind === 'result');
    assert.equal(outcome.value.status, 'ERROR');
    const pid = Number(/grandchild (\d+)/.exec(outcome.value.outputTail.join('\n'))?.[1]);
    assert.ok(pid > 0, 'grandchild pid printed');
    // Real OS process: SIGKILL delivery is asynchronous, so poll briefly for its exit.
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(pid), false, `grandchild ${pid} survived the timeout`);
  });

  it('a command that cannot start is ERROR', async () => {
    const ws = await repo(config([{ name: 'missing', command: ['ei-no-such-binary-xyz'] }]));
    const outcome = await runVerification(ws, { check: 'missing' });
    assert.equal(outcome.kind === 'result' && outcome.value.status, 'ERROR');
  });
});

describe('verify: secrets and revision', () => {
  it('secret-named variables never reach the check or the report', async () => {
    const ws = await repo(
      config([
        nodeCheck(
          'env',
          'console.log(JSON.stringify(process.env)); console.log("# tests 1\\n# pass 1")',
        ),
      ]),
    );
    const env = {
      ...process.env,
      GITLAB_TOKEN: 'x',
      DEPLOY_SECRET: 'y-secret-value-123',
      HARMLESS: 'visible',
    };
    const outcome = await runVerification(ws, { check: 'env' }, { env });
    assert.ok(outcome.kind === 'result');
    const childEnv = JSON.parse(outcome.value.outputTail[0] ?? '{}') as Record<string, string>;
    assert.equal(childEnv.HARMLESS, 'visible');
    assert.equal('GITLAB_TOKEN' in childEnv, false);
    assert.equal('DEPLOY_SECRET' in childEnv, false);
    const stored = await readdir(join(ws.cacheDir, 'verify', 'env'));
    const text = await readFile(join(ws.cacheDir, 'verify', 'env', stored[0] ?? ''), 'utf8');
    assert.equal(text.includes('y-secret-value-123'), false);
    assert.equal(text.includes('GITLAB_TOKEN'), false);
  });

  it('a secret printed by the check is redacted from the report', async () => {
    const ws = await repo(
      config([nodeCheck('leak', 'console.log("token ghp_abcdefghijklmnop1234")')]),
    );
    const outcome = await runVerification(ws, { check: 'leak' });
    assert.ok(outcome.kind === 'result');
    assert.equal(outcome.value.outputTail.join('\n').includes('ghp_abcdefghijklmnop1234'), false);
    assert.equal(outcome.value.redacted, true);
  });

  it('a dirty working tree is flagged', async () => {
    const ws = await repo(config([nodeCheck('unit', 'console.log("# tests 1\\n# pass 1")')]));
    const clean = await runVerification(ws, { check: 'unit' });
    assert.equal(clean.kind === 'result' && clean.value.dirty, false);
    await writeFile(join(ws.root, 'a.ts'), 'export const a = 2;\n');
    const dirty = await runVerification(ws, { check: 'unit' });
    assert.ok(dirty.kind === 'result');
    assert.equal(dirty.value.dirty, true);
    assert.notEqual(dirty.value.treeState, clean.kind === 'result' && clean.value.treeState);
  });

  it(`keeps the newest ${REPORTS_PER_CHECK} reports per check`, async () => {
    const ws = await repo(config([nodeCheck('unit', 'console.log("# tests 1\\n# pass 1")')]));
    for (let i = 0; i < REPORTS_PER_CHECK + 2; i++) await runVerification(ws, { check: 'unit' });
    assert.equal((await readdir(join(ws.cacheDir, 'verify', 'unit'))).length, REPORTS_PER_CHECK);
  });
});

describe('verify: result files', () => {
  const junit =
    '<testsuite><testcase name="a"/><testcase name="b"><failure>x</failure></testcase></testsuite>';

  it('a JUnit file older than the source change is not used', async () => {
    const ws = await repo(
      config([], [{ name: 'junit', format: 'junit', path: 'out/junit.xml', covers: ['**/*.ts'] }]),
    );
    await writeFile(join(ws.root, '.gitignore'), 'out/\n');
    execFileSync('mkdir', ['-p', join(ws.root, 'out')]);
    await writeFile(join(ws.root, 'out/junit.xml'), junit);
    const past = new Date(Date.now() - 60_000);
    await utimes(join(ws.root, 'out/junit.xml'), past, past);
    await writeFile(join(ws.root, 'a.ts'), 'export const a = 3;\n');
    const stale = await runVerification(ws, { report: 'junit' });
    assert.ok(stale.kind === 'result');
    assert.equal(stale.value.status, 'NOT_VERIFIED');
    assert.match(stale.value.summary, /stale/);

    const future = new Date(Date.now() + 60_000);
    await utimes(join(ws.root, 'out/junit.xml'), future, future);
    const fresh = await runVerification(ws, { report: 'junit' });
    assert.ok(fresh.kind === 'result');
    assert.equal(fresh.value.status, 'FAIL');
    assert.deepEqual(fresh.value.failures, ['b']);
  });

  it('a report path that escapes the repository is not read', async () => {
    const ws = await repo(config([], [{ name: 'junit', format: 'junit', path: 'link.xml' }]));
    const outside = await mkdtemp(join(tmpdir(), 'ei-verify-out-'));
    dirs.push(outside);
    await writeFile(join(outside, 'r.xml'), '<testcase name="a"/>');
    execFileSync('ln', ['-s', join(outside, 'r.xml'), join(ws.root, 'link.xml')]);
    const outcome = await runVerification(ws, { report: 'junit' });
    assert.equal(outcome.kind === 'result' && outcome.value.status, 'NOT_VERIFIED');
  });
});

describe('verify: parsers', () => {
  it('reads node:test, jest, vitest and mocha summaries; unknown output gives no counts', () => {
    assert.deepEqual(parseOutput('# tests 4\n# pass 3\n# fail 1\n# skipped 0').counts, {
      tests: 4,
      passed: 3,
      failed: 1,
      skipped: 0,
    });
    assert.equal(parseOutput('Tests:       1 failed, 2 passed, 3 total').counts?.failed, 1);
    assert.equal(parseOutput('      Tests  1 failed | 2 passed (3)').counts?.tests, 3);
    assert.equal(parseOutput('  2 passing (5ms)\n  1 failing').counts?.failed, 1);
    assert.equal(parseOutput('No tests found, exiting with code 0').counts?.tests, 0);
    assert.equal(parseOutput('All matched files use Prettier code style!').counts, null);
  });

  it('TAP counts only top-level points; JUnit counts testcases', () => {
    const tap = parseTap('ok 1 - a\n    not ok 1 - sub\nnot ok 2 - b\nok 3 - c # SKIP\n1..3\n');
    assert.deepEqual(tap.counts, { tests: 3, passed: 1, failed: 1, skipped: 1 });
    assert.deepEqual(tap.failures, ['b']);
    assert.deepEqual(parseJunit('<testcase name="a"><skipped/></testcase>').counts, {
      tests: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
    });
  });
});
