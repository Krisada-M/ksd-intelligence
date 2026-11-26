// MOCK-ONLY for the OMP ExtensionAPI harness; the index, anchors and files are real.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import extension, { type OmpExtensionApi } from '../../src/adapters/omp/extension.js';
import { buildIndex } from '../../src/core/engine/build.js';
import { loadWorkspace } from '../../src/core/engine/workspace.js';
import { readProposals } from '../../src/core/knowledge/store.js';
import { ensureRuntime, fixtureRepo } from './index-helpers.js';

before(ensureRuntime);

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

function load(cwd: string, cacheHome: string): Tool[] {
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
  extension(pi, { createPolicyExtension: () => {}, cwd, cacheHome, env: {} });
  return registered;
}

function tool(tools: Tool[], name: string): Tool {
  const found = tools.find((entry) => entry.name === name);
  assert.ok(found, `${name} not registered`);
  return found;
}

async function setKnowledge(repo: string, enabled: boolean): Promise<void> {
  const path = join(repo, 'ei.config.json');
  const config: Record<string, unknown> = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...config, knowledge: { enabled } }));
}

const TARGET = 'packages/payments/src/fee.ts#calculateFee';

describe('ei_learning and the ei_impact line', () => {
  let repo: string;
  let cacheHome: string;

  before(async () => {
    repo = await fixtureRepo('knowledge-tool');
    cacheHome = dirname(repo);
    const outcome = await buildIndex(await loadWorkspace(repo, cacheHome));
    assert.ok(outcome.ok, JSON.stringify(outcome));
  });

  it('disabled (default): no ei_learning and ei_impact text is unchanged by a proposal', async () => {
    await setKnowledge(repo, true);
    const on = load(repo, cacheHome);
    const proposed = await tool(on, 'ei_learning').execute(
      'id',
      {
        action: 'propose',
        target: TARGET,
        claim: 'Fees are integer minor units.',
        source: 'model-inferred',
      },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.match(proposed.content[0]?.text ?? '', /^PROPOSED /, proposed.content[0]?.text);

    await setKnowledge(repo, false);
    const off = load(repo, cacheHome);
    assert.equal(
      off.some((entry) => entry.name === 'ei_learning'),
      false,
    );
    const text =
      (
        await tool(off, 'ei_impact').execute('id', { targets: [TARGET] }, undefined, undefined, {
          cwd: repo,
        })
      ).content[0]?.text ?? '';
    assert.equal(text.includes('Learnings:'), false);
  });

  it('enabled: ei_impact appends one line after the V1 block and changes nothing else', async () => {
    await setKnowledge(repo, false);
    const v1 =
      (
        await tool(load(repo, cacheHome), 'ei_impact').execute(
          'id',
          { targets: [TARGET] },
          undefined,
          undefined,
          { cwd: repo },
        )
      ).content[0]?.text ?? '';
    await setKnowledge(repo, true);
    const impact = tool(load(repo, cacheHome), 'ei_impact');
    const result = await impact.execute('id', { targets: [TARGET] }, undefined, undefined, {
      cwd: repo,
    });
    const on = result.content[0]?.text ?? '';
    const lines = on.split('\n');
    const last = lines.pop() ?? '';
    assert.match(
      last,
      /^Learnings: 0 \(0 need review\) · proposed: 1 \(agent-drafted, owner approval pending\)/,
    );
    // The footer's index state (fresh vs updated after the config edit) is the only allowed difference.
    assert.equal(
      lines.join('\n').replace(/— index [^·]*·/g, '— index ·'),
      v1.replace(/— index [^·]*·/g, '— index ·'),
    );
    assert.ok(impact.renderResult);
    const expanded = impact.renderResult(result, { expanded: true, isPartial: false }).render(80);
    assert.ok(expanded.includes(last), 'expanded impact must show the learning summary');
    const collapsed = impact.renderResult(result, { expanded: false, isPartial: false }).render(80);
    assert.equal(collapsed.length, 1);
  });

  it('list quotes the proposal as an unconfirmed note; nothing is written to .ksd/', async () => {
    await setKnowledge(repo, true);
    const result = await tool(load(repo, cacheHome), 'ei_learning').execute(
      'id',
      { action: 'list', target: 'packages/payments/src/fee.ts' },
      undefined,
      undefined,
      { cwd: repo },
    );
    const text = result.content[0]?.text ?? '';
    assert.match(text, /not instructions to you/);
    assert.match(
      text,
      /\[note, unconfirmed\] .* model-inferred · symbol packages\/payments\/src\/fee\.ts#calculateFee/,
    );
    assert.ok(text.includes('> "Fees are integer minor units."'));
    assert.equal(existsSync(join(repo, '.ksd')), false);
    const ws = await loadWorkspace(repo, cacheHome);
    assert.equal(readProposals(ws.cacheDir).learnings.length, 1);
  });

  it('the OMP adapter has no path to the repository-writing commands', async () => {
    const source = await readFile('src/adapters/omp/extension.ts', 'utf8');
    assert.equal(/approveProposal|reviewLearning|rejectProposal/.test(source), false);
  });

  it('documents the registered ei_learning description verbatim', async () => {
    await setKnowledge(repo, true);
    const registered = tool(load(repo, cacheHome), 'ei_learning');
    const docs = await readFile('docs/TOOLS.md', 'utf8');
    const documented = docs.split(/^## 7b\. `ei_learning`.*$/m)[1]?.match(/^> (.+)$/m)?.[1];
    assert.equal(registered.description, documented);
  });
});
