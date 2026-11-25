import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const testToolName = 'ei_eval_test';
export const testPath = 'src/subject.test.js';

export function runFixtureTest(cwd, node, testFile) {
  const libs = ['/usr/lib', '/usr/lib64', '/lib', '/lib64'].filter(existsSync);
  const run = spawnSync(
    'bwrap',
    [
      '--unshare-all',
      '--die-with-parent',
      '--clearenv',
      '--ro-bind',
      node,
      '/node',
      ...libs.flatMap((lib) => ['--ro-bind', lib, lib]),
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp',
      '--ro-bind',
      cwd,
      '/fixture',
      '--ro-bind',
      testFile,
      `/fixture/${testPath}`,
      '--chdir',
      '/fixture',
      '--',
      '/node',
      '--test',
      '--test-reporter=tap',
      testPath,
    ],
    { encoding: 'utf8', timeout: 8000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' },
  );
  if (run.error)
    throw new Error(`Fixture test unavailable: ${run.error.code ?? run.error.message}`);
  return {
    passed:
      run.status === 0 &&
      /^ok 1 - doubles the input$/m.test(run.stdout) &&
      /^# pass 1\s*$/m.test(run.stdout),
    output: `${run.stdout}${run.stderr}`.trim(),
  };
}

export default function register(pi) {
  const { EI_EVAL_FIXTURE, EI_EVAL_NODE, EI_EVAL_TEST_FILE } = process.env;
  pi.registerTool({
    name: testToolName,
    label: 'Run fixture test',
    description: `Run the original ${testPath} against the current fixture. No arguments.`,
    parameters: pi.zod.object({}),
    approval: 'exec',
    loadMode: 'essential',
    async execute(_id, _params, signal, _update, ctx) {
      if (signal?.aborted) throw new Error('Fixture test cancelled');
      if (!EI_EVAL_FIXTURE || ctx.cwd !== EI_EVAL_FIXTURE || !EI_EVAL_NODE || !EI_EVAL_TEST_FILE) {
        throw new Error('Fixture test requires the eval runner');
      }
      const { passed, output } = runFixtureTest(ctx.cwd, EI_EVAL_NODE, EI_EVAL_TEST_FILE);
      return { content: [{ type: 'text', text: output }], details: { passed } };
    },
  });
}
