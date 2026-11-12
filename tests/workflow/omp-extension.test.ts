// MOCK-ONLY: exercises the adapter against a hand-written stand-in for OMP's ExtensionAPI.
// It proves the adapter's own logic, not compatibility with a running OMP.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import extension, { type OmpExtensionApi } from '../../src/adapters/omp/extension.js';
import { cleanup, emptyLock, FRONTMATTER_BODY, tempDir, writeSkillFile } from './fixtures.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface MockSchema {
  kind: string;
  values?: readonly string[];
  /** Object schemas: the declared property names. */
  keys?: string[];
  optional(): MockSchema;
  describe(text: string): MockSchema;
}

function schema(kind: string, values?: readonly string[], keys?: string[]): MockSchema {
  const self: MockSchema = {
    kind,
    ...(values ? { values } : {}),
    ...(keys ? { keys } : {}),
    optional: () => self,
    describe: () => self,
  };
  return self;
}

const noPolicy = () => {};

function mockPi(): {
  pi: OmpExtensionApi;
  registered: Parameters<OmpExtensionApi['registerTool']>[0][];
} {
  const registered: Parameters<OmpExtensionApi['registerTool']>[0][] = [];
  const pi: OmpExtensionApi = {
    zod: {
      string: () => schema('string'),
      enum: (values) => schema('enum', values),
      object: (shape) => schema('object', undefined, Object.keys(shape)),
    },
    registerTool: (tool) => {
      registered.push(tool);
    },
  };
  return { pi, registered };
}

it('registers read-only ei_workflow and ei_status tools', () => {
  const { pi, registered } = mockPi();
  extension(pi, { env: {}, createPolicyExtension: noPolicy });
  assert.deepEqual(
    registered.map((tool) => [tool.name, tool.approval]),
    [
      ['ei_workflow', 'read'],
      ['ei_status', 'read'],
    ],
  );
  const params = registered[1]?.parameters;
  assert.ok(params && 'keys' in params);
  assert.deepEqual(params.keys, [], 'ei_status takes no input');
});

it('EI_DISABLED=1 skips the ei_* tools only', () => {
  const { pi, registered } = mockPi();
  let policyStarted = false;
  extension(pi, {
    env: { EI_DISABLED: '1' },
    createPolicyExtension: () => {
      policyStarted = true;
    },
  });
  assert.equal(policyStarted, true, 'policy module must still start');
  assert.equal(registered.length, 0);
});

it('a failing policy module does not prevent the ei_* tools from registering', () => {
  const { pi, registered } = mockPi();
  extension(pi, {
    env: {},
    createPolicyExtension: () => {
      throw new Error('policy boom');
    },
  });
  assert.deepEqual(
    registered.map((tool) => tool.name),
    ['ei_workflow', 'ei_status'],
  );
});

it('ei_status reports a degraded state with its fix, success-shaped, for the session cwd', async () => {
  const { pi, registered } = mockPi();
  const repo = await tempDir('status-repo');
  try {
    extension(pi, { env: process.env, createPolicyExtension: noPolicy });
    // The test HOME is empty, so the pinned TypeScript runtime is not provisioned.
    const result = await registered[1]?.execute('call', {}, undefined, undefined, { cwd: repo });
    assert.equal(result?.isError, undefined);
    const text = result?.content[0]?.text ?? '';
    assert.equal(
      text.split('\n')[0],
      'STATUS degraded (typescript runtime missing) · run: ei setup',
    );
    assert.match(text, /^Index {7}none · run: ei index$/m);
    assert.ok(text.length <= 3000);
    const details = result?.details;
    assert.ok(typeof details === 'object' && details !== null && 'root' in details);
    assert.equal(details.root, repo);
  } finally {
    await cleanup(repo);
  }
});

it('missing provider roots return an error result instead of throwing', async () => {
  const { pi, registered } = mockPi();
  const dir = await tempDir('ext');
  try {
    const lockPath = join(dir, 'skills.lock.json');
    await writeFile(lockPath, JSON.stringify(emptyLock()));
    extension(pi, { env: {}, lockPath, createPolicyExtension: noPolicy });
    const result = await registered[0]?.execute(
      'call',
      { task: 'fix payment race condition', stage: 'investigate' },
      undefined,
    );
    assert.equal(result?.isError, true);
    assert.match(result?.content[0]?.text ?? '', /SKILLS_UNAVAILABLE.*PROVIDER_ROOT_MISSING/);
  } finally {
    await cleanup(dir);
  }
});

it('an unreadable lock file returns an error result', async () => {
  const { pi, registered } = mockPi();
  extension(pi, {
    env: {},
    lockPath: '/nonexistent/skills.lock.json',
    createPolicyExtension: noPolicy,
  });
  const result = await registered[0]?.execute('call', { task: 'x', stage: 'plan' }, undefined);
  assert.equal(result?.isError, true);
  assert.match(result?.content[0]?.text ?? '', /LOCK_INVALID/);
});

it('passes the caller type through and reports classifiedBy', async () => {
  const { pi, registered } = mockPi();
  const dir = await tempDir('ext');
  const root = await tempDir('ext-root');
  try {
    const lockPath = join(dir, 'skills.lock.json');
    await writeFile(lockPath, JSON.stringify(emptyLock()));
    await writeSkillFile(root, 'matt:diagnosing-bugs', FRONTMATTER_BODY('diagnosing-bugs', 'BODY'));
    extension(pi, { env: { EI_MATT_ROOT: root }, lockPath, createPolicyExtension: noPolicy });
    const result = await registered[0]?.execute(
      'call',
      { task: 'แก้บั๊กการชำระเงิน', stage: 'investigate', type: 'bug' },
      undefined,
    );
    assert.equal(result?.isError, undefined);
    assert.match(result?.content[0]?.text ?? '', /classifiedBy: caller/);
    assert.deepEqual(result?.details, {
      type: 'bug',
      classifiedBy: 'caller',
      stage: 'investigate',
      skillIds: ['matt:diagnosing-bugs'],
      ready: true,
    });
  } finally {
    await cleanup(dir, root);
  }
});

it('an aborted call returns Cancelled', async () => {
  const { pi, registered } = mockPi();
  extension(pi, { env: {}, createPolicyExtension: noPolicy });
  const result = await registered[0]?.execute(
    'call',
    { task: 'x', stage: 'plan' },
    AbortSignal.abort(),
  );
  assert.equal(result?.isError, true);
  assert.equal(result?.content[0]?.text, 'Cancelled');
});
