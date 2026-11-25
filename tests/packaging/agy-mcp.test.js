import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PassThrough } from 'node:stream';
import { createStdioServer } from '../../scripts/mcp/stdio.mjs';

const entry = fileURLToPath(new URL('../../scripts/agy-mcp.mjs', import.meta.url));
const cliEntry = fileURLToPath(new URL('../../dist/adapters/cli/main.js', import.meta.url));
const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function start(env = {}, customArgs) {
  const root = await mkdtemp(join(tmpdir(), 'ksd-mcp-'));
  const args = customArgs ? customArgs(root) : [entry, '--root', root];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, EI_DISABLED: '', KSD_MCP_WORKFLOW: '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  const waiters = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line !== '') {
        const frame = JSON.parse(line);
        const found = waiters.findIndex((waiter) => waiter.predicate(frame));
        if (found >= 0) waiters.splice(found, 1)[0].resolve(frame);
        else frames.push(frame);
      }
    }
  });

  const frame = (predicate = () => true) => {
    const found = frames.findIndex(predicate);
    if (found >= 0) return Promise.resolve(frames.splice(found, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.push(waiter);
      const timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('MCP response timed out'));
      }, 15000);
      timeout.unref();
      waiter.resolve = (message) => {
        clearTimeout(timeout);
        resolve(message);
      };
    });
  };
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const request = async (id, method, params) => {
    send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return frame((message) => message.id === id);
  };
  const stop = async () => {
    if (!child.killed && child.exitCode === null) {
      child.stdin.end();
      await Promise.race([
        new Promise((resolve) => child.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await rm(root, { recursive: true, force: true });
  };
  return { root, child, send, request, frame, stop };
}

describe('AGY MCP stdio adapter — protocol and security', () => {
  it('requires an explicitly configured absolute root', async () => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, KSD_MCP_ROOT: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 2);
    assert.match(stderr, /requires --root/);
  });

  it('rejects nested roots that would resolve to a broader workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ksd-mcp-parent-'));
    try {
      const nested = join(parent, 'nested');
      await mkdir(nested);
      await writeFile(join(parent, 'ei.config.json'), '{}\n');
      const child = spawn(process.execPath, [entry, '--root', nested], {
        env: { ...process.env, KSD_MCP_ROOT: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      const code = await new Promise((resolve) => child.once('close', resolve));
      assert.equal(code, 2);
      assert.match(stderr, /must be the exact accessible KSD workspace root/);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('2025-11-25 lifecycle, read-only tools and status without an index', async (t) => {
    const c = await start();
    t.after(c.stop);
    const before = await c.request(1, 'tools/list', {});
    assert.equal(before.error.code, -32000);
    const hello = await c.request(2, 'initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'test', version: '1' },
      capabilities: {},
    });
    assert.equal(hello.result.protocolVersion, '2025-11-25');
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await c.request(3, 'tools/list', {});
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ['ei_status', 'ei_impact', 'ei_changes', 'ei_search'],
    );
    assert.ok(list.result.tools.every((tool) => tool.annotations.readOnlyHint === true));
    assert.equal(list.result.tools[1].inputSchema.additionalProperties, false);
    assert.equal(list.result.tools[2].inputSchema.additionalProperties, false);
    assert.equal(list.result.tools[3].inputSchema.additionalProperties, false);
    const status = await c.request(4, 'tools/call', { name: 'ei_status', arguments: {} });
    assert.match(status.result.content[0].text, /^STATUS degraded/);
    assert.equal(status.result.resultType, undefined);
  });

  it('2026-07-28 stateless discover, tools/list and tools/call', async (t) => {
    const c = await start();
    t.after(c.stop);
    const meta = { _meta: modernMeta };
    const discover = await c.request(1, 'server/discover', meta);
    assert.deepEqual(discover.result.supportedVersions, ['2026-07-28']);
    assert.equal(discover.result.resultType, 'complete');
    assert.equal(discover.result.cacheScope, 'private');
    assert.equal(
      discover.result._meta['io.modelcontextprotocol/serverInfo'].name,
      'ksd-intelligence',
    );
    const list = await c.request(2, 'tools/list', meta);
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result.ttlMs, 0);
    assert.equal(list.result.tools.length, 4);
    const status = await c.request(3, 'tools/call', { ...meta, name: 'ei_status', arguments: {} });
    assert.match(status.result.content[0].text, /^STATUS degraded/);
    assert.equal(status.result.resultType, 'complete');
  });

  it('publishes the documented AGY descriptions for every tool', async (t) => {
    const c = await start({ KSD_MCP_WORKFLOW: '1' });
    t.after(c.stop);
    const { result } = await c.request(1, 'tools/list', { _meta: modernMeta });
    const docs = await readFile(new URL('../../docs/TOOLS.md', import.meta.url), 'utf8');
    const sections = docs.split(/^## \d+\. /m).slice(1);
    const documented = Object.fromEntries(
      sections.flatMap((section) => {
        const name = section.match(/^`(ei_\w+)`/)?.[1];
        if (!name) return [];
        const description =
          section.match(/^\*\*Description \(AGY MCP\):\*\*\n> (.+)$/m)?.[1] ??
          section.match(/^\*\*Description \(registered text\):\*\*\n> (.+)$/m)?.[1];
        return [[name, description]];
      }),
    );
    const registered = Object.fromEntries(
      result.tools.map((tool) => [tool.name, tool.description]),
    );
    assert.deepEqual(registered, documented);
  });

  it('invalid inputs, unknown tool and unsupported protocol fail without access to arbitrary root', async (t) => {
    const c = await start();
    t.after(c.stop);
    const meta = { _meta: modernMeta };
    const invalid = await c.request(1, 'tools/call', {
      ...meta,
      name: 'ei_impact',
      arguments: { targets: ['calculateFee'], root: '/etc' },
    });
    assert.equal(invalid.result.isError, true);
    assert.match(invalid.result.content[0].text, /^INVALID_INPUT: unknown argument/);
    const badDepth = await c.request(2, 'tools/call', {
      ...meta,
      name: 'ei_impact',
      arguments: { targets: ['a'], depth: 11 },
    });
    assert.equal(badDepth.result.isError, true);
    const badSearch = await c.request(20, 'tools/call', {
      ...meta,
      name: 'ei_search',
      arguments: { query: '   ', limit: 21 },
    });
    assert.equal(badSearch.result.isError, true);
    assert.match(badSearch.result.content[0].text, /^INVALID_INPUT:/);
    const badBase = await c.request(21, 'tools/call', {
      ...meta,
      name: 'ei_changes',
      arguments: { base: '--output=/tmp/pwn' },
    });
    assert.equal(badBase.result.isError, true);
    assert.match(badBase.result.content[0].text, /^INVALID_INPUT:/);
    const changesNoGit = await c.request(22, 'tools/call', {
      ...meta,
      name: 'ei_changes',
      arguments: {},
    });
    assert.equal(changesNoGit.result.isError, true);
    assert.match(changesNoGit.result.content[0].text, /^INVALID_INPUT: not a git repository/);
    const unknown = await c.request(3, 'tools/call', {
      ...meta,
      name: 'shell_exec',
      arguments: { command: 'whoami' },
    });
    assert.equal(unknown.result.isError, true);
    const unsupported = await c.request(4, 'tools/list', {
      _meta: { ...modernMeta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' },
    });
    assert.equal(unsupported.error.code, -32022);
    assert.ok(unsupported.error.data.supported.includes('2026-07-28'));
  });

  it('ei_workflow is opt-in and remains read-only with strict source pinning', async (t) => {
    const c = await start({ KSD_MCP_WORKFLOW: '1' });
    t.after(c.stop);
    const meta = { _meta: modernMeta };
    const list = await c.request(1, 'tools/list', meta);
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ['ei_status', 'ei_impact', 'ei_changes', 'ei_search', 'ei_workflow'],
    );
    const workflowTool = list.result.tools.find((tool) => tool.name === 'ei_workflow');
    assert.equal(workflowTool.inputSchema.properties.potetoMode.type, 'boolean');
    const response = await c.request(2, 'tools/call', {
      ...meta,
      name: 'ei_workflow',
      arguments: { task: 'fix crash', stage: 'investigate' },
    });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /KSD_FAILED:|SKILLS_UNAVAILABLE:/);
    const badOptIn = await c.request(3, 'tools/call', {
      ...meta,
      name: 'ei_workflow',
      arguments: { task: 'fix crash', stage: 'investigate', potetoMode: 'yes' },
    });
    assert.equal(badOptIn.result.isError, true);
    assert.match(badOptIn.result.content[0].text, /^INVALID_INPUT:/);
  });

  it('EI_DISABLED hides all tools', async (t) => {
    const c = await start({ EI_DISABLED: '1', KSD_MCP_WORKFLOW: '1' });
    t.after(c.stop);
    const list = await c.request(1, 'tools/list', { _meta: modernMeta });
    assert.deepEqual(list.result.tools, []);
  });

  it('malformed and oversized frames return bounded JSON-RPC errors', async (t) => {
    const c = await start();
    t.after(c.stop);
    c.child.stdin.write('not-json\n');
    const malformed = await c.frame((message) => message.error?.code === -32700);
    assert.equal(malformed.id, null);
    c.child.stdin.write('x'.repeat(1024 * 1024 + 1) + '\n');
    const oversized = await c.frame((message) => message.error?.message?.includes('1 MiB'));
    assert.equal(oversized.id, null);
    const discover = await c.request(8, 'server/discover', { _meta: modernMeta });
    assert.equal(discover.result.resultType, 'complete');
  });

  it('cancellation aborts in-flight calls and suppresses further responses', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.setEncoding('utf8');
    output.on('data', (chunk) => {
      out += chunk;
    });
    let aborted = false;
    const server = createStdioServer({
      root: '/',
      input,
      output,
      toolset: {
        definitions: [{ name: 'slow' }],
        async call(_name, _args, signal) {
          await new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return { content: [{ type: 'text', text: 'done' }] };
        },
      },
    });
    const send = (message) => input.write(JSON.stringify(message) + '\n');
    send({
      jsonrpc: '2.0',
      id: 'a',
      method: 'tools/call',
      params: { _meta: modernMeta, name: 'slow', arguments: {} },
    });
    send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'a' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.doesNotMatch(out, /"id":"a"/);
    server.close();
    input.end();
  });

  it('CLI subcommand `ei mcp --root <root> --workflow` starts stdio server with ei_workflow enabled', async (t) => {
    const c = await start({}, (root) => [cliEntry, 'mcp', '--root', root, '--workflow']);
    t.after(c.stop);
    const meta = { _meta: modernMeta };
    const list = await c.request(1, 'tools/list', meta);
    assert.deepEqual(
      list.result.tools.map((tool) => tool.name),
      ['ei_status', 'ei_impact', 'ei_changes', 'ei_search', 'ei_workflow'],
    );
    const workflowTool = list.result.tools.find((tool) => tool.name === 'ei_workflow');
    assert.equal(workflowTool.inputSchema.properties.potetoMode.type, 'boolean');
  });
});
