// MOCK-ONLY for the OMP ExtensionAPI harness; the core runs real git and real processes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import extension, { type OmpExtensionApi } from '../../src/adapters/omp/extension.js';
import { parseProjectConfig } from '../../src/core/kernel/config.js';
import type { VerificationReport } from '../../src/core/verify/report.js';
import { changesVerificationNote, renderVerifyReport } from '../../src/core/verify/render.js';
import { readRevision } from '../../src/core/verify/revision.js';
import { loadVerificationState, runVerification } from '../../src/core/verify/verify.js';

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

interface MockSchema {
  optional(): MockSchema;
  describe(text: string): MockSchema;
  int(): MockSchema;
  min(value: number): MockSchema;
  max(value: number): MockSchema;
}

function schema(): MockSchema {
  const self: MockSchema = {
    optional: () => self,
    describe: () => self,
    int: () => self,
    min: () => self,
    max: () => self,
  };
  return self;
}

type Tool = Parameters<OmpExtensionApi['registerTool']>[0];

function load(cwd: string, runner?: () => Promise<never>): Tool[] {
  const registered: Tool[] = [];
  const pi: OmpExtensionApi = {
    zod: {
      string: schema,
      number: schema,
      boolean: schema,
      array: schema,
      enum: schema,
      object: schema,
    },
    registerTool: (tool) => {
      registered.push(tool);
    },
  };
  extension(pi, {
    createPolicyExtension: () => {},
    cwd,
    cacheHome: `${cwd}-cache`,
    env: {},
    ...(runner === undefined ? {} : { verifyRunner: runner }),
  });
  return registered;
}

async function repo(verification: unknown): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ei-verify-tool-')));
  dirs.push(root, `${root}-cache`);
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      stdio: 'ignore',
    });
  };
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'ei.config.json'), JSON.stringify({ verification }));
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return root;
}

const PASSING = [process.execPath, '-e', 'console.log("# tests 1\\n# pass 1")'];

describe('ei_verify registration', () => {
  it('is not registered while verification is disabled (the default)', async () => {
    const off = await repo({ enabled: false, checks: [{ name: 'test', command: PASSING }] });
    const names = load(off).map((tool) => tool.name);
    assert.equal(names.includes('ei_verify'), false);
    assert.deepEqual(
      names,
      load(await repo(undefined)).map((tool) => tool.name),
    );
  });

  it('declares exec for a check and read for a result file', async () => {
    const on = await repo({ enabled: true, checks: [{ name: 'test', command: PASSING }] });
    const tool = load(on).find((entry) => entry.name === 'ei_verify');
    assert.ok(tool !== undefined && typeof tool.approval === 'function');
    assert.equal(tool.approval({ check: 'test' }), 'exec');
    assert.equal(tool.approval({ report: 'junit' }), 'read');
    assert.equal(tool.approval({ check: 'test', report: 'junit' }), 'exec');
    assert.equal(tool.approval('anything'), 'exec');
    assert.deepEqual(
      tool.formatApprovalDetails?.({ check: 'test' })?.[0],
      `Command: ${PASSING.join(' ')}`,
    );
    assert.match(tool.description, /Checks: test\./);
    const docs = await readFile('docs/TOOLS.md', 'utf8');
    const documented = docs.split(/^## 7a\. `ei_verify`.*$/m)[1]?.match(/^> (.+)$/m)?.[1];
    assert.equal(tool.description, `${documented ?? '(missing)'} Checks: test.`);
  });

  it('agent input other than one configured name never reaches the runner', async () => {
    const on = await repo({ enabled: true, checks: [{ name: 'test', command: PASSING }] });
    let calls = 0;
    const tool = load(on, async () => {
      calls++;
      throw new Error('must not run');
    }).find((entry) => entry.name === 'ei_verify');
    assert.ok(tool !== undefined);
    for (const params of [
      { check: 'test; rm -rf ~' },
      { check: 'test', command: ['sh', '-c', 'id'] },
      { check: 'npm test' },
      { check: 'lint' },
    ]) {
      const result = await tool.execute('id', params, undefined, undefined, { cwd: on });
      const text = result.content[0]?.text ?? '';
      assert.match(text, /INVALID_INPUT|NOT_VERIFIED/, text);
    }
    assert.equal(calls, 0);
  });

  it('runs the configured check and answers with line 1 first', async () => {
    const on = await repo({ enabled: true, checks: [{ name: 'test', command: PASSING }] });
    const tool = load(on).find((entry) => entry.name === 'ei_verify');
    assert.ok(tool !== undefined);
    const result = await tool.execute('id', { check: 'test' }, undefined, undefined, { cwd: on });
    assert.match(result.content[0]?.text ?? '', /^VERIFY test — PASS · [0-9a-f]{12}\n/);
  });
});

describe('verification text', () => {
  const base: VerificationReport = {
    check: 'test',
    revision: 'a'.repeat(40),
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'PASS',
    exitCode: 0,
    artifacts: [],
    summary: 'exit 0',
    redacted: false,
    source: 'check',
    dirty: true,
    treeState: 't',
    durationMs: 1200,
    counts: { tests: 2, passed: 2, failed: 0, skipped: 0 },
    failures: [],
    outputTail: ['ok'],
  };

  it('a dirty tree is reported on line 1', () => {
    const text = renderVerifyReport(base, '1.0.0');
    assert.equal(text.split('\n')[0], `VERIFY test — PASS · ${'a'.repeat(12)} · dirty`);
  });

  it('ei_changes names only reports for the current tree; otherwise Next asks for ei_verify', async () => {
    const root = await repo({ enabled: true, checks: [{ name: 'test', command: PASSING }] });
    const { config } = parseProjectConfig(
      JSON.stringify({
        verification: { enabled: true, checks: [{ name: 'test', command: PASSING }] },
      }),
    );
    const ws = { root, cacheDir: `${root}-cache`, config };
    const before = await loadVerificationState(ws);
    assert.ok(before !== undefined);
    assert.match(
      changesVerificationNote(before.reports, before.revision, before.checkNames).nextHint ?? '',
      /call ei_verify \(test\)/,
    );
    await runVerification(ws, { check: 'test' });
    const now = await loadVerificationState(ws);
    assert.ok(now !== undefined);
    assert.equal(
      changesVerificationNote(now.reports, now.revision, now.checkNames).line,
      'Verified for this tree: test PASS (ei_verify)',
    );
    await writeFile(join(root, 'new.ts'), 'export {};\n');
    const changed = await readRevision(root);
    assert.equal(changesVerificationNote(now.reports, changed, now.checkNames).line, undefined);
    const off = await loadVerificationState({ ...ws, config: parseProjectConfig('{}').config });
    assert.equal(off, undefined);
  });
});
