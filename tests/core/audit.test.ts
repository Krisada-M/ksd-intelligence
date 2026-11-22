import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import extension, { type OmpExtensionApi } from '../../src/adapters/omp/extension.js';
import {
  AUDIT_FILE,
  clearAuditState,
  parseSince,
  recordAudit,
  stripCodeDetail,
  summarizeAudit,
} from '../../src/core/audit/index.js';
import { renderStatus, workspaceStatus } from '../../src/core/engine/status.js';
import { resolveWorkspaceCache } from '../../src/core/engine/workspace.js';
import { defaultSkillsDir } from '../../src/workflow/packs.js';
import { cleanup, emptyLock, FRONTMATTER_BODY, writeSkillFile } from '../workflow/fixtures.js';
import { ensureRuntime, FIXTURE } from './index-helpers.js';

const execFileAsync = promisify(execFile);

function findRepoRoot(startUrl: string): string {
  let dir = new URL('.', startUrl).pathname;
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('package.json not found');
    dir = parent;
  }
}

const REPO_ROOT = findRepoRoot(import.meta.url);
const CLI_ENTRY = join(REPO_ROOT, 'dist/adapters/cli/main.js');
const AUDIT_MODULE = new URL('../../src/core/audit/log.js', import.meta.url).href;
const LOCK_MODULE = new URL('../../src/core/engine/lock.js', import.meta.url).href;
const MCP_TOOLS_URL = new URL('../../../scripts/mcp/tools.mjs', import.meta.url).href;

before(ensureRuntime);

function mockPi(): {
  pi: OmpExtensionApi;
  registered: Parameters<OmpExtensionApi['registerTool']>[0][];
} {
  const registered: Parameters<OmpExtensionApi['registerTool']>[0][] = [];
  const makeSchema = (): ReturnType<OmpExtensionApi['zod']['string']> => {
    const self = {
      optional: () => self,
      describe: () => self,
      int: () => self,
      min: () => self,
      max: () => self,
    };
    return self;
  };
  const pi: OmpExtensionApi = {
    zod: {
      string: makeSchema,
      boolean: makeSchema,
      number: makeSchema,
      array: makeSchema,
      enum: makeSchema,
      object: makeSchema,
    },
    registerTool: (tool) => {
      registered.push(tool);
    },
  };
  return { pi, registered };
}

describe('M2c Round 3 — audit log, ei audit, ei cache clear', () => {
  it('truncates task strings to 200 characters and strips secrets, tokens, and home paths', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-audit-redact-')));
    try {
      const repo = join(work, 'repo');
      const cacheDir = join(work, 'cache', 'repo1');
      await mkdir(join(repo, 'src'), { recursive: true });
      const markerSource = 'SECRET_SOURCE_BODY_MARKER_NEVER_LOGGED';
      await writeFile(
        join(repo, 'src/a.ts'),
        `// ${markerSource}\nexport function calc() { return 1; }\n`,
      );

      const secretVal = 'super_secret_env_value_999';
      const ghToken = 'ghp_1234567890abcdefghij';
      const skToken = 'sk-proj-abc123456789xyz';
      const longTail = 'x'.repeat(250);
      const rawTask = `Fix ${repo}/src/a.ts with Bearer my_bearer_token_abc and ${ghToken} and ${skToken} and ${secretVal} and /home/alice/project ${longTail}`;

      recordAudit(
        cacheDir,
        {
          ts: '2026-11-22T10:00:00.000Z',
          tool: 'ei_workflow',
          outcome: 'result',
          ms: 12.345,
          engine: '0.2.0',
          task: rawTask,
          target: `${repo}/src/a.ts#calc`,
          codes: [
            `unresolved-name-match: ${repo}/src/a.ts:2 — ${markerSource}`,
            'public-export-surface',
          ],
        },
        {
          env: {
            HOME: join(work, 'home-fake'),
            MY_API_TOKEN: secretVal,
          },
          root: repo,
        },
      );

      assert.equal(statSync(cacheDir).mode & 0o777, 0o700);
      const auditPath = join(cacheDir, AUDIT_FILE);
      assert.equal(statSync(auditPath).mode & 0o777, 0o600);

      const raw = await readFile(auditPath, 'utf8');
      const lines = raw.trimEnd().split('\n');
      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]!) as {
        task: string;
        target: string;
        codes: string[];
      };

      assert.equal(entry.task.length, 200);
      assert.equal(entry.target, 'src/a.ts#calc');
      assert.deepEqual(entry.codes, ['unresolved-name-match', 'public-export-surface']);

      assert.ok(!raw.includes(markerSource), 'source marker leaked');
      assert.ok(!raw.includes(ghToken), 'ghp token leaked');
      assert.ok(!raw.includes(skToken), 'sk token leaked');
      assert.ok(!raw.includes('my_bearer_token_abc'), 'Bearer token leaked');
      assert.ok(!raw.includes(secretVal), 'env secret leaked');
      assert.ok(!raw.includes('/home/alice'), 'home path leaked');
      assert.ok(!raw.includes(repo), 'absolute repo root leaked');
      const realHome = homedir();
      if (realHome.length > 1) assert.ok(!raw.includes(realHome), 'process homedir leaked');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('stripCodeDetail forwards env and root on fallback sanitization', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-audit-strip-')));
    try {
      const repo = join(work, 'repo');
      const cacheDir = join(work, 'cache', 'repo1');
      const customSecret = 'custom_strip_secret_12345';
      const rawNonPrefixed = `${repo}/src/secret.ts failed with ${customSecret}`;

      const stripped = stripCodeDetail(rawNonPrefixed, {
        env: { CUSTOM_SECRET: customSecret },
        root: repo,
      });
      assert.ok(!stripped.includes(repo), 'direct stripCodeDetail leaked root');
      assert.ok(!stripped.includes(customSecret), 'direct stripCodeDetail leaked env secret');
      assert.ok(stripped.includes('src/secret.ts'));
      assert.ok(stripped.includes('[REDACTED]'));

      recordAudit(
        cacheDir,
        {
          ts: '2026-11-22T10:00:00.000Z',
          tool: 'ei_impact',
          outcome: 'result',
          ms: 5,
          engine: '0.2.0',
          codes: [rawNonPrefixed],
        },
        { env: { CUSTOM_SECRET: customSecret }, root: repo },
      );
      const raw = await readFile(join(cacheDir, AUDIT_FILE), 'utf8');
      assert.ok(!raw.includes(repo), 'recordAudit codes leaked root');
      assert.ok(!raw.includes(customSecret), 'recordAudit codes leaked env secret');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('isolates write failures under 50 ms and surfaces once in ei_status (ENOSPC + read-only dir)', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-audit-fail-')));
    try {
      const repo = join(work, 'repo');
      const cacheHome = join(work, 'home');
      await mkdir(repo, { recursive: true });
      await mkdir(cacheHome, { recursive: true });
      const { cacheDir } = await resolveWorkspaceCache(repo, cacheHome);
      await mkdir(cacheDir, { recursive: true, mode: 0o700 });
      clearAuditState(cacheDir);

      // 1) Simulated ENOSPC via injectable writeLine
      const t0 = performance.now();
      recordAudit(
        cacheDir,
        {
          ts: new Date().toISOString(),
          tool: 'ei_impact',
          outcome: 'result',
          ms: 5,
          engine: '0.2.0',
        },
        {
          writeLine: () => {
            const err = new Error('no space left on device') as NodeJS.ErrnoException;
            err.code = 'ENOSPC';
            throw err;
          },
        },
      );
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 50, `failure took ${elapsed} ms (>= 50 ms)`);

      const s1 = await workspaceStatus(repo, { cacheHome });
      assert.equal(s1.auditWarning, 'ENOSPC');
      assert.match(renderStatus(s1), /^Audit {7}write failed \(ENOSPC\); non-blocking$/m);

      // Second ei_status does not repeat the warning
      const s2 = await workspaceStatus(repo, { cacheHome });
      assert.equal(s2.auditWarning, undefined);
      assert.doesNotMatch(renderStatus(s2), /^Audit /m);

      // Recovery: a successful write resets reported state so a later failure surfaces once again
      recordAudit(cacheDir, {
        ts: new Date().toISOString(),
        tool: 'ei_status',
        outcome: 'result',
        ms: 1,
        engine: '0.2.0',
      });
      recordAudit(
        cacheDir,
        {
          ts: new Date().toISOString(),
          tool: 'ei_impact',
          outcome: 'result',
          ms: 2,
          engine: '0.2.0',
        },
        {
          writeLine: () => {
            const err = new Error('no space left on device') as NodeJS.ErrnoException;
            err.code = 'ENOSPC';
            throw err;
          },
        },
      );
      const sRecovered = await workspaceStatus(repo, { cacheHome });
      assert.equal(sRecovered.auditWarning, 'ENOSPC');

      // 2) Real read-only directory (0o500) on a fresh cacheDir when non-root
      if (process.geteuid?.() !== 0) {
        const repoRo = join(work, 'repo-ro');
        await mkdir(repoRo, { recursive: true });
        const { cacheDir: cacheDirRo } = await resolveWorkspaceCache(repoRo, cacheHome);
        await mkdir(cacheDirRo, { recursive: true, mode: 0o700 });
        await chmod(cacheDirRo, 0o500);
        try {
          const t1 = performance.now();
          recordAudit(cacheDirRo, {
            ts: new Date().toISOString(),
            tool: 'ei_changes',
            outcome: 'result',
            ms: 4,
            engine: '0.2.0',
          });
          const elapsedRo = performance.now() - t1;
          assert.ok(elapsedRo < 50, `0o500 failure took ${elapsedRo} ms`);
          const sRo1 = await workspaceStatus(repoRo, { cacheHome });
          assert.equal(sRo1.auditWarning, 'EACCES');
          assert.match(renderStatus(sRo1), /^Audit {7}write failed \(EACCES\); non-blocking$/m);
          const sRo2 = await workspaceStatus(repoRo, { cacheHome });
          assert.equal(sRo2.auditWarning, undefined);
        } finally {
          await chmod(cacheDirRo, 0o700);
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('concurrent 2-process appenders produce only complete JSONL lines', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-audit-conc-')));
    try {
      const cacheDir = join(work, 'cache');
      const spawnWriter = (workerId: number): Promise<void> =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `import { recordAudit } from ${JSON.stringify(AUDIT_MODULE)};
               for (let i = 0; i < 40; i++) {
                 recordAudit(process.env.CACHE_DIR, {
                   ts: new Date().toISOString(),
                   tool: 'ei_impact',
                   outcome: 'result',
                   ms: i + 1,
                   engine: '0.2.0',
                   target: 'pkg/f.ts#fn_' + ${workerId} + '_' + i,
                   task: 'worker ' + ${workerId} + ' iteration ' + i + ' ' + 'a'.repeat(120),
                 });
               }`,
            ],
            { env: { ...process.env, CACHE_DIR: cacheDir }, stdio: 'inherit' },
          );
          child.on('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)),
          );
          child.on('error', reject);
        });

      await Promise.all([spawnWriter(1), spawnWriter(2)]);
      const raw = await readFile(join(cacheDir, AUDIT_FILE), 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      assert.equal(lines.length, 80);
      for (const line of lines) {
        const parsed = JSON.parse(line) as { tool: string; target: string };
        assert.equal(parsed.tool, 'ei_impact');
        assert.match(parsed.target, /^pkg\/f\.ts#fn_[12]_\d+$/);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('rotates at maxBytes, reads rotated archives in ei audit, skips corrupt lines, and tracks changedWithoutPriorImpact', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-audit-rot-')));
    try {
      const repo = join(work, 'repo');
      const cacheHome = join(work, 'home');
      await mkdir(repo, { recursive: true });
      await mkdir(cacheHome, { recursive: true });
      const { cacheDir } = await resolveWorkspaceCache(repo, cacheHome);

      const now = Date.now();
      const iso = (offsetSec: number) => new Date(now + offsetSec * 1000).toISOString();

      // Write enough entries with small maxBytes to trigger .1, .2, .3 rotation
      recordAudit(
        cacheDir,
        {
          ts: iso(-120),
          tool: 'ei_impact',
          outcome: 'result',
          ms: 25,
          engine: '0.2.0',
          target: 'src/a.ts#checkedFn',
          targets: ['src/a.ts#checkedFn'],
          risk: 'low',
          action: 'proceed',
        },
        { maxBytes: 180, maxRotations: 3 },
      );
      recordAudit(
        cacheDir,
        {
          ts: iso(-90),
          tool: 'ei_status',
          outcome: 'result',
          ms: 120,
          engine: '0.2.0',
          statusState: 'ready',
        },
        { maxBytes: 180, maxRotations: 3 },
      );
      recordAudit(
        cacheDir,
        {
          ts: iso(-60),
          tool: 'ei_changes',
          outcome: 'result',
          ms: 210,
          engine: '0.2.0',
          risk: 'high',
          action: 'run-tests',
          changedSymbols: ['src/a.ts#checkedFn', 'src/b.ts#uncheckedFn'],
        },
        { maxBytes: 180, maxRotations: 3 },
      );
      // Old entry outside --since 1h window (2 days old)
      recordAudit(
        cacheDir,
        {
          ts: new Date(now - 2 * 86_400_000).toISOString(),
          tool: 'ei_workflow',
          outcome: 'result',
          ms: 5,
          engine: '0.2.0',
          task: 'old task',
        },
        { maxBytes: 180, maxRotations: 3 },
      );

      assert.ok(existsSync(join(cacheDir, `${AUDIT_FILE}.1`)));
      assert.ok(existsSync(join(cacheDir, `${AUDIT_FILE}.2`)));

      // Append 2 corrupt lines into audit.jsonl
      const existing = await readFile(join(cacheDir, AUDIT_FILE), 'utf8');
      await writeFile(
        join(cacheDir, AUDIT_FILE),
        `${existing}{not-valid-json\n{"ts":"invalid-date","tool":"ei_impact","ms":1}\n`,
      );

      const summary = summarizeAudit(cacheDir, { sinceMs: parseSince('7d', now)! });
      assert.equal(summary.corruptLines, 2);
      assert.equal(summary.totalCalls, 4);
      assert.ok(summary.filesRead >= 3);
      assert.equal(summary.callsByTool.ei_impact, 1);
      assert.equal(summary.callsByTool.ei_changes, 1);
      assert.equal(summary.verdictDistribution.high, 1);
      assert.equal(summary.slowestCalls[0]?.tool, 'ei_changes');
      assert.deepEqual(summary.changedWithoutPriorImpact, ['src/b.ts#uncheckedFn']);

      // CLI `ei audit --since 1h --json` skips the 2-day-old entry and writes NO new audit line
      const cliRes = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, 'audit', '--since', '1h', '--root', repo, '--json'],
        { env: { ...process.env, HOME: cacheHome } },
      );
      const parsed = JSON.parse(cliRes.stdout) as typeof summary;
      assert.equal(parsed.totalCalls, 3);
      assert.equal(parsed.corruptLines, 2);
      assert.deepEqual(parsed.changedWithoutPriorImpact, ['src/b.ts#uncheckedFn']);

      // Invalid --since returns exit 2
      await assert.rejects(
        execFileAsync(process.execPath, [CLI_ENTRY, 'audit', '--since', 'bogus', '--root', repo], {
          env: { ...process.env, HOME: cacheHome },
        }),
        (err: { code?: number }) => err.code === 2,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('EI_DISABLED=1 writes nothing, and ei cache clear removes repo cache without touching runtime/', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-audit-clear-')));
    try {
      const repo = join(work, 'repo');
      const cacheHome = join(work, 'home');
      await mkdir(repo, { recursive: true });
      const runtimeDir = join(cacheHome, '.cache/ksd-intelligence/runtime');
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, 'marker.txt'), 'keep-me');

      const { cacheDir } = await resolveWorkspaceCache(repo, cacheHome);

      // EI_DISABLED=1 writes nothing
      recordAudit(
        cacheDir,
        {
          ts: new Date().toISOString(),
          tool: 'ei_status',
          outcome: 'result',
          ms: 2,
          engine: '0.2.0',
        },
        { env: { EI_DISABLED: '1' } },
      );
      assert.equal(existsSync(join(cacheDir, AUDIT_FILE)), false);

      // Write real audit + dummy index file
      recordAudit(cacheDir, {
        ts: new Date().toISOString(),
        tool: 'ei_status',
        outcome: 'result',
        ms: 2,
        engine: '0.2.0',
      });
      await writeFile(join(cacheDir, 'index.sqlite'), 'dummy');
      assert.equal(existsSync(join(cacheDir, AUDIT_FILE)), true);

      // Live build lock prevents clearing
      const holder: ChildProcess = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { acquireBuildLock } from ${JSON.stringify(LOCK_MODULE)};
           console.log(acquireBuildLock(process.env.LOCK_DIR).ok ? 'held' : 'refused');
           process.stdin.resume();`,
        ],
        { env: { ...process.env, LOCK_DIR: cacheDir }, stdio: ['pipe', 'pipe', 'inherit'] },
      );
      try {
        await new Promise<void>((resolve) => holder.stdout?.once('data', () => resolve()));
        await assert.rejects(
          execFileAsync(process.execPath, [CLI_ENTRY, 'cache', 'clear', '--root', repo], {
            env: { ...process.env, HOME: cacheHome },
          }),
          (err: { code?: number }) => err.code === 1,
        );
        assert.equal(existsSync(join(cacheDir, AUDIT_FILE)), true);
      } finally {
        holder.kill('SIGKILL');
        await new Promise((resolve) => holder.once('exit', resolve));
      }

      // Now clear succeeds and preserves runtime/
      const cleared = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, 'cache', 'clear', '--root', repo],
        { env: { ...process.env, HOME: cacheHome } },
      );
      assert.match(cleared.stdout, /^CACHE CLEARED /);
      assert.equal(existsSync(cacheDir), false);
      assert.equal(await readFile(join(runtimeDir, 'marker.txt'), 'utf8'), 'keep-me');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('OMP, CLI, and AGY MCP adapters record audit entries across all 4 tools', async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), 'ei-audit-adapters-')));
    const skillRoot = join(work, 'skills-provider');
    try {
      const repo = join(work, 'mono');
      const cacheHome = join(work, 'home');
      await mkdir(cacheHome, { recursive: true });
      cpSync(FIXTURE, repo, { recursive: true });

      const lockPath = join(work, 'skills.lock.json');
      await writeFile(lockPath, JSON.stringify(emptyLock()));
      await writeSkillFile(
        skillRoot,
        'matt:diagnosing-bugs',
        FRONTMATTER_BODY('diagnosing-bugs', 'BODY'),
      );

      // 1) OMP extension adapter
      const { pi, registered } = mockPi();
      extension(pi, {
        env: { ...process.env, EI_MATT_ROOT: skillRoot },
        lockPath,
        skillsDir: defaultSkillsDir(),
        cacheHome,
        createPolicyExtension: () => {},
      });

      const wfTool = registered.find((t) => t.name === 'ei_workflow')!;
      const stTool = registered.find((t) => t.name === 'ei_status')!;
      const impTool = registered.find((t) => t.name === 'ei_impact')!;
      const chgTool = registered.find((t) => t.name === 'ei_changes')!;

      const wfRes = await wfTool.execute(
        'w1',
        { task: 'fix bug', stage: 'investigate', type: 'bug' },
        undefined,
        undefined,
        { cwd: repo },
      );
      assert.deepEqual(wfRes.details, {
        type: 'bug',
        classifiedBy: 'caller',
        stage: 'investigate',
        skillIds: ['matt:diagnosing-bugs'],
        ready: true,
      });

      await stTool.execute('s1', {}, undefined, undefined, { cwd: repo });
      await impTool.execute('i1', { targets: ['calculateFee'] }, undefined, undefined, {
        cwd: repo,
      });
      await chgTool.execute('c1', {}, undefined, undefined, { cwd: repo });

      // 2) AGY MCP adapter
      const { createTools } = (await import(MCP_TOOLS_URL)) as {
        createTools: (opts: { root: string; env?: NodeJS.ProcessEnv }) => {
          call: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
        };
      };
      const mcp = createTools({ root: repo, env: { ...process.env, HOME: cacheHome } });
      await mcp.call('ei_status', {}, new AbortController().signal);
      await mcp.call('ei_impact', { targets: ['roundMoney'] }, new AbortController().signal);

      // 3) CLI adapter
      await execFileAsync(process.execPath, [CLI_ENTRY, 'status', '--root', repo], {
        env: { ...process.env, HOME: cacheHome },
      }).catch(() => {});

      const { cacheDir } = await resolveWorkspaceCache(repo, cacheHome);
      const summary = summarizeAudit(cacheDir);
      assert.equal(summary.callsByTool.ei_workflow, 1);
      assert.equal(summary.callsByTool.ei_status, 3);
      assert.equal(summary.callsByTool.ei_impact, 2);
      assert.equal(summary.callsByTool.ei_changes, 1);
      assert.equal(summary.corruptLines, 0);
    } finally {
      await cleanup(work);
    }
  });
});
