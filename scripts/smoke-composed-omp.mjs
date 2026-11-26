// Real OMP, one installed KSD product and a deterministic loopback model. No provider credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [ompArg, upstreamArg] = process.argv.slice(2);
assert.ok(
  process.argv.length === 4 && [ompArg, upstreamArg].every((path) => path && isAbsolute(path)),
  'Usage: node scripts/smoke-composed-omp.mjs /trusted/omp /pinned/engineering-checkout',
);
const binary = realpathSync(ompArg);
const upstream = realpathSync(upstreamArg);
const candidate = fileURLToPath(new URL('..', import.meta.url));
const helpers = join(upstream, 'plugins', 'erosiano-dev', 'test', 'eval');
const { createRpc, isolatedEnvironment, verifyCommandCatalog } = await import(
  pathToFileURL(join(helpers, 'smoke-omp.mjs')).href
);
const { startFixture } = await import(pathToFileURL(join(helpers, 'smoke-omp-prompt.mjs')).href);

function run(program, args, cwd, env) {
  const output = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    shell: false,
  });
  assert.equal(output.error, undefined);
  assert.equal(output.status, 0, String(output.stderr).slice(-3000));
}

function text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .filter((part) => part?.type === 'text')
        .map((part) => part.text)
        .join('\n')
    : '';
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'ksd-omp-composed-')));
try {
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home);
  mkdirSync(join(project, 'src'), { recursive: true });
  const env = isolatedEnvironment(home);
  run('git', ['init', '-q', '-b', 'main'], project, env);
  writeFileSync(join(project, 'src', 'main.ts'), 'export const value = 1;\n');
  writeFileSync(join(project, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}');
  writeFileSync(
    join(env.PI_CODING_AGENT_DIR, 'config.yml'),
    JSON.stringify({
      bash: { enabled: false },
      tools: { approvalMode: 'always-ask', approval: { ei_status: 'allow' } },
    }),
  );
  run(binary, ['plugin', 'marketplace', 'add', candidate], project, env);
  run(binary, ['plugin', 'install', 'ksd-intelligence@ksd-intelligence'], project, env);
  const fixture = await startFixture();
  try {
    const rpc = createRpc(binary, project, home, {}, fixture.endpoint, { installed: true });
    try {
      await rpc.wait((frame) => frame.type === 'ready');
      verifyCommandCatalog(await rpc.request('get_available_commands'));
      await fixture.turn(rpc, 'balanced', {
        message: '/erosiano-dev review src',
        steps: [
          {
            inspect: (body) => {
              const names = new Set((body.tools ?? []).map((tool) => tool.function?.name));
              for (const name of ['ei_status', 'ei_search', 'ei_impact', 'ei_changes']) {
                assert.ok(names.has(name), 'Missing native tool ' + name);
              }
              const input = body.messages
                .filter((message) => message.role === 'user')
                .map((message) => text(message.content))
                .join('\n');
              assert.match(input, /Optional KSD Intelligence native tools/);
              assert.match(input, /never waives native gates/);
            },
            call: { name: 'ei_status', args: {} },
          },
          {
            inspect: (body) => {
              const last = body.messages.filter((message) => message.role === 'tool').at(-1);
              assert.match(text(last?.content), /STATUS degraded/);
            },
          },
        ],
      });
      await rpc.request('prompt', { message: '/engineering-proxy adaptive' });
      await fixture.turn(rpc, 'adaptive');
    } finally {
      try {
        await rpc.close();
      } catch (error) {
        throw new Error(error.message + '\nOMP stderr: ' + rpc.diagnostics().trim(), {
          cause: error,
        });
      }
    }
  } finally {
    await fixture.close();
  }
  console.log(
    'PASS: real OMP single marketplace install, one new policy, native EI status, legacy alias and adaptive mode.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
