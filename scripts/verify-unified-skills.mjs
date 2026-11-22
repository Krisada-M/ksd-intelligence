#!/usr/bin/env node
/**
 * Dual-runtime verification script for KSD unified AGY + OMP skills (`npm run verify:skills`).
 *
 * Checks:
 *  1. Shared registry + lockfile consistency (`skills.registry.json` <-> `skills.lock.json`)
 *  2. AGY native skill discovery (catalog + optional `--detect-host`)
 *  3. OMP native skill discovery (catalog + optional `--detect-host` / `--profile`)
 *  4. Real AGY MCP stdio subprocess (`scripts/agy-mcp.mjs --root <repo> --workflow`)
 *  5. Real OMP runtime extension + skill loader (when `bun` + installed `@oh-my-pi/pi-coding-agent` exist)
 *
 * Read-only: never mutates user customizations (`~/.gemini/**`, `~/.omp/**`) or runs upstream scripts.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { discoverAgySkills } from '../dist/adapters/agy/skills.js';
import { discoverOmpSkills } from '../dist/adapters/omp/skills.js';
import {
  defaultRegistryPath,
  readRegistry,
  validateRegistryConsistency,
} from '../dist/workflow/registry.js';
import { defaultLockPath, readLock } from '../dist/workflow/sources.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

const SCENARIOS = [
  {
    label: 'implement+TDD',
    args: { task: 'implement checkout discount calculator', stage: 'implement' },
    expect: [
      'Orchestrator: ksd-intelligence',
      'Primary Pack: matt-sdlc',
      '# Skill invoked: matt:tdd',
    ],
  },
  {
    label: 'debug',
    args: { task: 'debug payment webhook race condition', stage: 'investigate' },
    expect: ['Primary Pack: matt-sdlc', '# Skill invoked: matt:diagnosing-bugs'],
  },
  {
    label: 'REQ-mismatch+potetoMode',
    args: {
      task: 'fix REQ mismatch: order total ignores coupon cap',
      stage: 'review',
      potetoMode: true,
    },
    expect: [
      'Primary Pack: pstack-analysis',
      'Opt-In Modes: poteto-mode',
      'Compliance Gate: REQ × Code × Test × Runtime Evidence',
      '# Skill invoked: poteto:blast-radius',
      '# Skill invoked: matt:code-review',
      '# Opt-in pack invoked: poteto-mode',
    ],
  },
  {
    label: 'UI-verify',
    args: { task: 'verify checkout modal UI layout responsiveness', stage: 'verify' },
    expect: [
      'Primary Pack: osmani-quality',
      'Compliance Gate: REQ × Code × Test × Runtime Evidence',
      '# Skill invoked: osmani:browser-testing-with-devtools',
    ],
  },
  {
    label: 'arch-review',
    args: { task: 'review architecture of billing service boundaries', stage: 'review' },
    expect: [
      'Primary Pack: pstack-analysis',
      'Compliance Gate: REQ × Code × Test × Runtime Evidence',
      '# Skill invoked: poteto:blast-radius',
    ],
  },
];

function hasPinnedSourceEnv(env) {
  return Boolean(env.EI_MATT_ROOT && env.EI_POTETO_ROOT && env.EI_OSMANI_ROOT);
}

async function verifyAgyMcp(env) {
  const child = spawn(
    process.execPath,
    [join(REPO_ROOT, 'scripts/agy-mcp.mjs'), '--root', REPO_ROOT, '--workflow'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const responses = new Map();
  let buf = '';
  const waiters = new Map();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      responses.set(frame.id, frame);
      const resolveWaiter = waiters.get(frame.id);
      if (resolveWaiter) {
        waiters.delete(frame.id);
        resolveWaiter(frame);
      }
    }
  });

  const request = (id, method, params) =>
    new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => rejectReq(new Error(`MCP timeout on ${method}#${id}`)), 15000);
      timer.unref();
      waiters.set(id, (frame) => {
        clearTimeout(timer);
        resolveReq(frame);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const list = await request(1, 'tools/list', { _meta: MCP_META });
    const tools = list.result?.tools ?? [];
    const wf = tools.find((tool) => tool.name === 'ei_workflow');
    if (!wf || wf.inputSchema?.properties?.potetoMode?.type !== 'boolean') {
      return {
        ok: false,
        label: 'VERIFIED_FAIL',
        detail: 'ei_workflow missing boolean potetoMode schema',
      };
    }

    const status = await request(2, 'tools/call', {
      _meta: MCP_META,
      name: 'ei_status',
      arguments: {},
    });
    const statusLine = (status.result?.content?.[0]?.text ?? '').split('\n')[0] ?? '';

    if (!hasPinnedSourceEnv(env)) {
      const failClosed = await request(3, 'tools/call', {
        _meta: MCP_META,
        name: 'ei_workflow',
        arguments: { task: 'fix crash', stage: 'investigate' },
      });
      const ok = Boolean(failClosed.result?.isError);
      return {
        ok,
        label: ok ? 'VERIFIED' : 'VERIFIED_FAIL',
        detail: `${statusLine} · schema ok · fail-closed without EI_*_ROOT`,
      };
    }

    let nextId = 10;
    for (const scenario of SCENARIOS) {
      const res = await request(nextId++, 'tools/call', {
        _meta: MCP_META,
        name: 'ei_workflow',
        arguments: scenario.args,
      });
      const text = res.result?.content?.[0]?.text ?? '';
      if (res.result?.isError) {
        return {
          ok: false,
          label: 'VERIFIED_FAIL',
          detail: `${scenario.label}: ${text.slice(0, 120)}`,
        };
      }
      for (const expected of scenario.expect) {
        if (!text.includes(expected)) {
          return {
            ok: false,
            label: 'VERIFIED_FAIL',
            detail: `${scenario.label}: missing "${expected}"`,
          };
        }
      }
    }

    return {
      ok: true,
      label: 'VERIFIED',
      detail: `${statusLine} · 5/5 scenarios + potetoMode opt-in passed`,
    };
  } finally {
    child.stdin.end();
    await Promise.race([
      new Promise((resolveExit) => child.once('close', resolveExit)),
      new Promise((resolveTimeout) => setTimeout(resolveTimeout, 300)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function verifyOmpLive(env) {
  const realHome = env.SNAP_REAL_HOME ?? env.HOME ?? homedir();
  const ompPkg = join(realHome, '.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent');
  if (!existsSync(ompPkg)) {
    return {
      ok: true,
      label: 'NOT VERIFIED',
      detail: 'installed OMP package not found on this machine',
    };
  }

  const bunBin = existsSync(join(realHome, '.bun/bin/bun'))
    ? join(realHome, '.bun/bin/bun')
    : 'bun';
  const script = `
import { loadExtensions } from ${JSON.stringify(join(ompPkg, 'src/extensibility/extensions/loader.ts'))};
import { scanSkillsFromDir } from ${JSON.stringify(join(ompPkg, 'src/discovery/helpers.ts'))};
const cwd = ${JSON.stringify(REPO_ROOT)};
const loaded = await loadExtensions([${JSON.stringify(join(REPO_ROOT, 'dist/adapters/omp/extension.js'))}], cwd);
if (loaded.errors.length > 0) throw new Error('loadExtensions errors: ' + JSON.stringify(loaded.errors));
const ext = loaded.extensions[0];
const wf = ext.tools.get('ei_workflow');
if (!wf) throw new Error('ei_workflow not registered');
const scan = await scanSkillsFromDir({ cwd, home: '/tmp/ksd-verify-none', repoRoot: cwd }, {
  dir: ${JSON.stringify(join(REPO_ROOT, 'skills'))},
  providerId: 'claude-plugins',
  level: 'user',
  pluginName: 'ksd-intelligence',
});
if (scan.warnings.length > 0) throw new Error('scan warnings: ' + JSON.stringify(scan.warnings));
const poteto = scan.items.find((s) => s.name === 'poteto-mode');
if (!poteto?.frontmatter?.disableModelInvocation && !poteto?.frontmatter?.['disable-model-invocation']) {
  throw new Error('poteto-mode missing disable-model-invocation in OMP scan');
}
const hasSources = Boolean(process.env.EI_MATT_ROOT && process.env.EI_POTETO_ROOT && process.env.EI_OSMANI_ROOT);
let executed = 0;
if (hasSources) {
  const scenarios = ${JSON.stringify(SCENARIOS)};
  for (const s of scenarios) {
    const res = await wf.definition.execute('verify-' + s.label, s.args, undefined, undefined, { cwd });
    const text = res.content?.[0]?.text ?? '';
    if (res.isError) throw new Error(s.label + ': ' + text);
    for (const token of s.expect) {
      if (!text.includes(token)) throw new Error(s.label + ': missing ' + token);
    }
    executed += 1;
  }
}
console.log(JSON.stringify({ tools: [...ext.tools.keys()], commands: [...ext.commands.keys()], catalogSkills: scan.items.length, executed }));
`;

  try {
    const { stdout } = await execFileAsync(bunBin, ['-e', script], { env });
    const parsed = JSON.parse(stdout.trim());
    return {
      ok: true,
      label: 'VERIFIED',
      detail: `tools=[${parsed.tools.join(',')}] commands=[${parsed.commands.join(',')}] catalog=${parsed.catalogSkills} scenarios=${parsed.executed}/${hasPinnedSourceEnv(env) ? SCENARIOS.length : 0}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, label: 'VERIFIED_FAIL', detail: message.slice(0, 240) };
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'detect-host': { type: 'boolean' },
      profile: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  const detectHost = values['detect-host'] === true;
  const registryIssues = await validateRegistryConsistency(
    await readRegistry(defaultRegistryPath()),
    await readLock(defaultLockPath()),
  );
  const agyDiscovery = await discoverAgySkills({
    detectHostPaths: detectHost,
    requireCatalog: true,
  });
  const ompDiscovery = await discoverOmpSkills({
    detectHostPaths: detectHost,
    profile: values.profile,
    requireCatalog: true,
  });

  const agyPotetoOptIn = agyDiscovery.explicitOnly.some((s) => s.name === 'poteto-mode');
  const ompPotetoOptIn = ompDiscovery.explicitOnly.some((s) => s.name === 'poteto-mode');
  const agyMcp = await verifyAgyMcp(process.env);
  const ompLive = await verifyOmpLive(process.env);

  const checks = [
    {
      name: 'registry-lock',
      ok: registryIssues.length === 0,
      label: registryIssues.length === 0 ? 'VERIFIED' : 'VERIFIED_FAIL',
      detail: `${registryIssues.length} issues`,
    },
    {
      name: 'agy-discovery',
      ok: agyDiscovery.issues.length === 0 && agyPotetoOptIn,
      label: agyDiscovery.issues.length === 0 && agyPotetoOptIn ? 'VERIFIED' : 'VERIFIED_FAIL',
      detail: `${agyDiscovery.skills.length} skills · poteto-mode opt-in=${agyPotetoOptIn} · issues=${agyDiscovery.issues.length} · snap=${agyDiscovery.paths.snapDetected}`,
    },
    {
      name: 'omp-discovery',
      ok: ompDiscovery.issues.length === 0 && ompPotetoOptIn,
      label: ompDiscovery.issues.length === 0 && ompPotetoOptIn ? 'VERIFIED' : 'VERIFIED_FAIL',
      detail: `${ompDiscovery.skills.length} skills · poteto-mode opt-in=${ompPotetoOptIn} · issues=${ompDiscovery.issues.length} · profile=${ompDiscovery.environment.profile}`,
    },
    { name: 'agy-mcp-stdio', ...agyMcp },
    { name: 'omp-live-runtime', ...ompLive },
  ];

  const allOk = checks.every((check) => check.ok);
  if (values.json) {
    console.log(JSON.stringify({ ok: allOk, detectHost, checks }, null, 2));
  } else {
    console.log(`KSD UNIFIED SKILLS VERIFY (${allOk ? 'PASS' : 'FAIL'})`);
    for (const check of checks) {
      console.log(`  [${check.label.padEnd(13)}] ${check.name.padEnd(18)} ${check.detail}`);
    }
  }
  process.exitCode = allOk ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
