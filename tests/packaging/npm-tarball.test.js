import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const scope = '@krisada-m/ksd-intelligence';

// D65: the package must work from the registry tarball alone, with no file from this checkout.
describe('npm tarball (D65)', () => {
  it('installs in an empty directory and runs ei and the MCP server', async (t) => {
    const work = await mkdtemp(join(tmpdir(), 'ksd-npm-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    const packDir = join(work, 'pack');
    const project = join(work, 'consumer');
    const target = join(work, 'target');
    await Promise.all([mkdir(packDir), mkdir(project), mkdir(target)]);

    const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
    assert.equal(manifest.name, scope);
    assert.notEqual(manifest.private, true, 'private package cannot be published');
    assert.equal(manifest.publishConfig?.access, 'public');

    const packResult = JSON.parse(
      execFileSync(
        'npm',
        ['pack', '.', '--json', '--ignore-scripts', '--pack-destination', packDir],
        {
          cwd: repo,
          encoding: 'utf8',
        },
      ),
    );
    const packed = Array.isArray(packResult) ? packResult[0] : packResult[scope];
    assert.equal(packed?.name, scope, 'npm pack must describe the local package');
    const paths = packed.files.map((file) => file.path);
    for (const required of [
      'LICENSE',
      'README.md',
      'dist/adapters/cli/main.js',
      'dist/engineering/index.js',
      'dist/engineering/practices.json',
      'engineering.lock.json',
      '.antigravity-plugin/plugin.json',
      'rules/engineering.md',
      'agy-skills/erosiano-review/SKILL.md',
    ]) {
      assert.ok(paths.includes(required), `tarball lacks ${required}`);
    }
    for (const path of paths) {
      assert.ok(!path.startsWith('dist/policy/'), `tarball leaks obsolete policy ${path}`);
      assert.ok(
        !/^(tests|docs|spikes|src|\.scratch|\.github|dist-test)\//.test(path),
        `tarball leaks ${path}`,
      );
    }

    await writeFile(join(project, 'package.json'), '{"name":"consumer","private":true}\n');
    execFileSync(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(packDir, packed.filename)],
      { cwd: project, stdio: 'pipe' },
    );
    const ei = join(project, 'node_modules', '.bin', 'ei');
    const binDir = join(project, 'node_modules', '.bin');
    const help = [
      ['ei', /usage:[\s\S]*mcp\s+--root/],
      ['ksd-check-changed', /usage:.*--diff.*--eslint-report/i],
      ['ksd-review-verdict', /usage:.*--report/i],
    ].map(([name, usage]) => ({
      name,
      usage,
      ...spawnSync(join(binDir, name), ['--help'], { encoding: 'utf8', cwd: target }),
    }));
    assert.deepEqual(
      help.map(({ name, status, stderr }) => ({ name, status, stderr })),
      help.map(({ name }) => ({ name, status: 0, stderr: '' })),
    );
    for (const { stdout, usage } of help) assert.match(stdout, usage);

    // The npm launchers delegate non-help invocations to the pinned engineering bins.
    for (const name of ['ksd-check-changed', 'ksd-review-verdict']) {
      const result = spawnSync(join(binDir, name), [], { encoding: 'utf8', cwd: target });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /Usage:/);
    }

    const practices = spawnSync(join(binDir, 'erosiano-practices'), ['--group', 'typescript'], {
      encoding: 'utf8',
      cwd: target,
    });
    assert.equal(practices.status, 0, practices.stderr);
    assert.match(practices.stdout, /T02/);
    const baseline = spawnSync(
      join(binDir, 'erosiano-baseline'),
      ['--root', target, '--scope', '.'],
      { encoding: 'utf8', cwd: target },
    );
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).coverage, 'SAMPLED_EVIDENCE_ONLY');

    // `ei` with no arguments prints usage and exits 2; it must not crash on a missing file.
    let usage = '';
    try {
      execFileSync(ei, [], { cwd: project, stdio: 'pipe' });
      assert.fail('expected exit code 2');
    } catch (error) {
      assert.equal(error.status, 2);
      usage = String(error.stderr) + String(error.stdout);
    }
    assert.match(usage, /usage:/);
    assert.match(usage, /mcp\s+--root/);

    // `ei status` locates the package's own package.json (pinned TypeScript); a rename must not break it.
    // Degraded (no runtime installed yet) exits non-zero; only the output matters here.
    let status = '';
    try {
      status = execFileSync(ei, ['status', '--root', target], {
        cwd: project,
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      status = String(error.stdout) + String(error.stderr);
    }
    assert.match(status, /^STATUS /m);
    assert.doesNotMatch(status, /package\.json not found/);

    const child = spawn(ei, ['mcp', '--root', target], {
      cwd: project,
      env: { ...process.env, EI_DISABLED: '', KSD_MCP_WORKFLOW: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => child.kill());
    const reply = new Promise((resolve, reject) => {
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf('\n');
        if (index >= 0) resolve(JSON.parse(buffer.slice(0, index)));
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`mcp exited early with ${code}`)));
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          clientInfo: { name: 'tarball-test', version: '1' },
          capabilities: {},
        },
      }) + '\n',
    );
    const hello = await reply;
    assert.equal(hello.result.protocolVersion, '2025-11-25');
  });
});
