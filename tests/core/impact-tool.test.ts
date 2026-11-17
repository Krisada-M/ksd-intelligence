// MOCK-ONLY for OMP ExtensionAPI harness; also exercises real child process builds and CLI.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import extension, {
  type ExtensionDeps,
  type OmpExtensionApi,
} from '../../src/adapters/omp/extension.js';
import { buildIndex, type EngineOutcome } from '../../src/core/engine/build.js';
import { loadWorkspace } from '../../src/core/engine/workspace.js';
import { isRecord } from '../../src/core/kernel/guards.js';
import type { ImpactResult } from '../../src/core/kernel/types.js';
import { DatabaseSync } from 'node:sqlite';
import { indexPath } from '../../src/storage/sqlite.js';
import { ensureRuntime, fixtureRepo } from './index-helpers.js';

const execFileAsync = promisify(execFile);

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

function setupExtension(deps: ExtensionDeps = {}) {
  const registered: Parameters<OmpExtensionApi['registerTool']>[0][] = [];
  const pi: OmpExtensionApi = {
    zod: {
      string: () => schema(),
      number: () => schema(),
      array: () => schema(),
      enum: () => schema(),
      object: () => schema(),
    },
    registerTool: (tool) => {
      registered.push(tool);
    },
  };
  extension(pi, { createPolicyExtension: () => {}, ...deps });
  const impactTool = registered.find((tool) => tool.name === 'ei_impact');
  return { registered, impactTool };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('M2b Step 3.2 — ei_impact OMP tool and CLI', () => {
  let repo: string;
  let cacheHome: string;

  before(async () => {
    repo = await fixtureRepo('impact-tool');
    cacheHome = dirname(repo);
    await writeFile(join(repo, '.env'), 'SECRET=1\n');
    const workspace = await loadWorkspace(repo, cacheHome);
    const outcome = await buildIndex(workspace);
    assert.ok(outcome.ok, JSON.stringify(outcome));
  });

  after(async () => {
    if (repo) await rm(dirname(repo), { recursive: true, force: true });
  });

  it('EI_DISABLED=1 registers no ei_* tool', () => {
    const { registered } = setupExtension({ env: { EI_DISABLED: '1' } });
    assert.deepEqual(registered, []);
  });

  it('rejects invalid inputs (0 targets, 6 targets, depth 0, depth 11, non-string) without throwing', async () => {
    const { impactTool } = setupExtension({ cacheHome });
    assert.ok(impactTool);

    const invalidInputs: unknown[] = [
      { targets: [] },
      { targets: ['a', 'b', 'c', 'd', 'e', 'f'] },
      { targets: ['calculateFee'], depth: 0 },
      { targets: ['calculateFee'], depth: 11 },
      { targets: [123] },
      { targets: [''] },
      null,
    ];

    for (const bad of invalidInputs) {
      const res = await impactTool.execute('call', bad as never, undefined, undefined, {
        cwd: repo,
      });
      assert.equal(res.isError, true, `expected error for ${JSON.stringify(bad)}`);
      assert.match(res.content[0]?.text ?? '', /^INVALID_INPUT:/);
    }
  });

  it('returns guidance outcomes without isError, and index-failed with isError', async () => {
    const { impactTool } = setupExtension({ cacheHome });
    assert.ok(impactTool);

    // Ambiguous
    const ambiguous = await impactTool.execute(
      'call',
      { targets: ['charge'] },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.equal(ambiguous.isError, undefined);
    assert.match(ambiguous.content[0]?.text ?? '', /^AMBIGUOUS charge — 5 declarations/);

    // Not found
    const notFound = await impactTool.execute(
      'call',
      { targets: ['calcFee'] },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.equal(notFound.isError, undefined);
    assert.match(notFound.content[0]?.text ?? '', /^NOT FOUND calcFee\./);

    // NOT INDEXED (.env)
    const notIndexed = await impactTool.execute(
      'call',
      { targets: ['.env'] },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.equal(notIndexed.isError, undefined);
    assert.match(notIndexed.content[0]?.text ?? '', /^NOT INDEXED \.env — secret$/);

    // Index building (waitMs expired on an unindexed repo)
    const buildingRepo = await fixtureRepo('impact-tool-building');
    try {
      const { impactTool: buildingTool } = setupExtension({
        cacheHome: dirname(buildingRepo),
        impactSession: {
          waitMs: 10,
          build: () => new Promise<EngineOutcome>(() => {}),
        },
      });
      assert.ok(buildingTool);
      const buildingRes = await buildingTool.execute(
        'call',
        { targets: ['calculateFee'] },
        undefined,
        undefined,
        { cwd: buildingRepo },
      );
      assert.equal(buildingRes.isError, undefined);
      assert.match(buildingRes.content[0]?.text ?? '', /^INDEX BUILDING — /);
    } finally {
      await rm(dirname(buildingRepo), { recursive: true, force: true });
    }

    // Index failed
    const failedRepo = await fixtureRepo('impact-tool-failed');
    try {
      const { impactTool: failedTool } = setupExtension({
        cacheHome: dirname(failedRepo),
        impactSession: {
          build: async (): Promise<EngineOutcome> => ({
            ok: false,
            code: 'index-failed',
            message: 'engine crashed during setup',
            fix: 'retry once',
          }),
        },
      });
      assert.ok(failedTool);
      const failedRes = await failedTool.execute(
        'call',
        { targets: ['calculateFee'] },
        undefined,
        undefined,
        { cwd: failedRepo },
      );
      assert.equal(failedRes.isError, true);
      assert.match(
        failedRes.content[0]?.text ?? '',
        /^index-failed: engine crashed during setup\. Retry once;/,
      );
    } finally {
      await rm(dirname(failedRepo), { recursive: true, force: true });
    }
  });

  it('turns a throw inside the query core into an index-failed error result', async () => {
    const corruptRepo = await fixtureRepo('impact-tool-corrupt');
    try {
      const workspace = await loadWorkspace(corruptRepo, dirname(corruptRepo));
      const built = await buildIndex(workspace);
      assert.ok(built.ok);
      // Corrupt meta.packages in the published index so ImpactQuery throws on construction.
      const db = new DatabaseSync(indexPath(workspace.cacheDir));
      try {
        db.prepare("UPDATE meta SET value = '123' WHERE key = 'packages'").run();
      } finally {
        db.close();
      }

      const { impactTool } = setupExtension({ cacheHome: dirname(corruptRepo) });
      assert.ok(impactTool);
      const res = await impactTool.execute(
        'call',
        { targets: ['calculateFee'] },
        undefined,
        undefined,
        { cwd: corruptRepo },
      );
      assert.equal(res.isError, true);
      assert.match(res.content[0]?.text ?? '', /^index-failed: index meta\.packages is not a list/);
    } finally {
      await rm(dirname(corruptRepo), { recursive: true, force: true });
    }
  });

  it('aborts an in-flight engine build, returns Cancelled, and leaves no child process alive', async () => {
    const abortRepo = await fixtureRepo('impact-tool-abort');
    try {
      const { impactTool } = setupExtension({ cacheHome: dirname(abortRepo) });
      assert.ok(impactTool);

      const controller = new AbortController();
      let childPid: number | null = null;
      const pending = impactTool.execute(
        'call',
        { targets: ['calculateFee'] },
        controller.signal,
        (update) => {
          if (
            isRecord(update.details) &&
            typeof update.details.pid === 'number' &&
            childPid === null
          ) {
            childPid = update.details.pid;
            controller.abort();
          }
        },
        { cwd: abortRepo },
      );

      const res = await pending;
      assert.equal(res.isError, true);
      assert.equal(res.content[0]?.text, 'Cancelled');
      assert.ok(childPid !== null, 'expected progress update with child pid before abort');
      assert.equal(isPidAlive(childPid), false, `child pid ${childPid} must be dead after abort`);
    } finally {
      await rm(dirname(abortRepo), { recursive: true, force: true });
    }
  });

  it('carries ImpactResult[] in details that matches the rendered text', async () => {
    const { impactTool } = setupExtension({ cacheHome });
    assert.ok(impactTool);

    const res = await impactTool.execute(
      'call',
      { targets: ['packages/payments/src/fee.ts#calculateFee', 'localOnly'], depth: 2 },
      undefined,
      undefined,
      { cwd: repo },
    );
    assert.equal(res.isError, undefined);
    const text = res.content[0]?.text ?? '';
    assert.ok(Array.isArray(res.details));
    const details = res.details as ImpactResult[];
    assert.equal(details.length, 2);
    assert.equal(details[0]?.target, 'packages/payments/src/fee.ts#calculateFee');
    assert.equal(details[0]?.verdict.level, 'medium');
    assert.equal(details[1]?.target, 'packages/payments/src/fee.ts#localOnly');
    assert.equal(details[1]?.verdict.level, 'low');
    assert.match(text, /IMPACT calculateFee — packages\/payments\/src\/fee\.ts:9/);
    assert.match(text, /ACTION run-tests · level medium · picture complete/);
    assert.match(text, /IMPACT localOnly — packages\/payments\/src\/fee\.ts:19/);
    assert.match(text, /ACTION proceed · level low · picture complete/);
  });

  it('resolves the same repository index from a subdirectory and from a git worktree subdirectory', async () => {
    const { impactTool } = setupExtension({ cacheHome });
    assert.ok(impactTool);

    // 1. Subdirectory of `repo`
    const subDir = join(repo, 'packages/payments/src');
    const fromRoot = await impactTool.execute(
      'call',
      { targets: ['calculateFee'], depth: 1 },
      undefined,
      undefined,
      { cwd: repo },
    );
    const fromSub = await impactTool.execute(
      'call',
      { targets: ['calculateFee'], depth: 1 },
      undefined,
      undefined,
      { cwd: subDir },
    );
    assert.equal(fromSub.content[0]?.text, fromRoot.content[0]?.text);

    // 2. Git worktree (`git worktree add`) and a subdirectory inside that worktree
    const wtBase = await realpath(await mkdtemp(join(tmpdir(), 'ei-worktree-')));
    const wtDir = join(wtBase, 'wt');
    try {
      await execFileAsync('git', ['init', '-q'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      await execFileAsync('git', ['add', '.'], { cwd: repo });
      await execFileAsync('git', ['commit', '-qm', 'init'], { cwd: repo });
      await execFileAsync('git', ['worktree', 'add', '-q', '-b', 'wt-branch', wtDir], {
        cwd: repo,
      });

      const wtWorkspace = await loadWorkspace(wtDir, wtBase);
      const wtSubWorkspace = await loadWorkspace(join(wtDir, 'packages/api/src'), wtBase);
      assert.equal(wtSubWorkspace.root, wtWorkspace.root);
      assert.equal(wtSubWorkspace.repoId, wtWorkspace.repoId);
      assert.equal(wtSubWorkspace.cacheDir, wtWorkspace.cacheDir);

      // Build once on the worktree root, then query from a worktree subdirectory without rebuilding.
      const built = await buildIndex(wtWorkspace);
      assert.ok(built.ok);
      let builds = 0;
      const { impactTool: wtTool } = setupExtension({
        cacheHome: wtBase,
        impactSession: {
          build: async () => {
            builds++;
            throw new Error('worktree subdirectory must reuse the worktree index');
          },
        },
      });
      assert.ok(wtTool);
      const fromWtRoot = await wtTool.execute(
        'call',
        { targets: ['calculateFee'], depth: 1 },
        undefined,
        undefined,
        { cwd: wtDir },
      );
      const fromWtSub = await wtTool.execute(
        'call',
        { targets: ['calculateFee'], depth: 1 },
        undefined,
        undefined,
        { cwd: join(wtDir, 'packages/api/src') },
      );
      assert.equal(fromWtSub.isError, undefined);
      assert.equal(fromWtSub.content[0]?.text, fromWtRoot.content[0]?.text);
      assert.equal(builds, 0);
    } finally {
      await execFileAsync('git', ['worktree', 'remove', '--force', wtDir], { cwd: repo }).catch(
        () => {},
      );
      await rm(wtBase, { recursive: true, force: true });
    }
  });

  it('CLI ei impact prints rendered text or --json typed result and sets exit codes', async () => {
    const cli = join(process.cwd(), 'dist/adapters/cli/main.js');
    const cliRepo = await fixtureRepo('impact-cli-repo');
    try {
      const cliWorkspace = await loadWorkspace(cliRepo);
      const built = await buildIndex(cliWorkspace);
      assert.ok(built.ok, JSON.stringify(built));

      // 1. Valid symbol result with --json -> exit 0, typed ImpactResult
      const { stdout: jsonOut } = await execFileAsync(process.execPath, [
        cli,
        'impact',
        'packages/payments/src/fee.ts#calculateFee',
        '--depth',
        '1',
        '--root',
        cliRepo,
        '--json',
      ]);
      const parsed: unknown = JSON.parse(jsonOut);
      assert.ok(isRecord(parsed));
      assert.equal(parsed.target, 'packages/payments/src/fee.ts#calculateFee');
      assert.ok(isRecord(parsed.verdict) && parsed.verdict.level === 'medium');

      // 2. Valid symbol result text -> exit 0, matches C01 snapshot
      const { stdout: textOut } = await execFileAsync(process.execPath, [
        cli,
        'impact',
        'packages/payments/src/fee.ts#calculateFee',
        '--depth',
        '1',
        '--root',
        cliRepo,
      ]);
      assert.match(textOut, /^IMPACT calculateFee — packages\/payments\/src\/fee\.ts:9/m);
      assert.match(textOut, /^ACTION run-tests · level medium · picture complete/m);

      // 3. Guidance result (ambiguous) -> exit 0
      const { stdout: ambOut } = await execFileAsync(process.execPath, [
        cli,
        'impact',
        'charge',
        '--root',
        cliRepo,
      ]);
      assert.match(ambOut, /^AMBIGUOUS charge — 5 declarations/);

      // 4. Invalid input (depth 11) -> non-zero exit code
      await assert.rejects(
        execFileAsync(process.execPath, [
          cli,
          'impact',
          'calculateFee',
          '--depth',
          '11',
          '--root',
          cliRepo,
        ]),
        (err: { code?: number }) => err.code === 2,
      );
    } finally {
      await rm(dirname(cliRepo), { recursive: true, force: true });
    }

    // 5. Failure (index-failed when TypeScript runtime is missing in an empty HOME) -> non-zero exit code
    const emptyHome = await realpath(await mkdtemp(join(tmpdir(), 'ei-cli-empty-home-')));
    const unindexedRepo = await fixtureRepo('cli-fail');
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [cli, 'impact', 'calculateFee', '--root', unindexedRepo], {
          env: { ...process.env, HOME: emptyHome },
        }),
        (err: { code?: number; stdout?: string }) =>
          err.code === 1 && (err.stdout ?? '').includes('index-failed:'),
      );
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
      await rm(dirname(unindexedRepo), { recursive: true, force: true });
    }
  });
});
