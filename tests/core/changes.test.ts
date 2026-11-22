import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import ts from 'typescript';
import { runChanges } from '../../src/core/changes/changes.js';
import {
  CHANGES_BUDGET,
  renderChanges,
  renderChangesOutcome,
} from '../../src/core/changes/render.js';
import { loadWorkspace } from '../../src/core/engine/workspace.js';
import { ImpactSession } from '../../src/core/impact/session.js';
import { Indexer } from '../../src/core/indexing/indexer.js';
import type { ChangesResult } from '../../src/core/kernel/types.js';
import { ensureRuntime, FIXTURE, impactOf } from './index-helpers.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = join(process.cwd(), 'dist/adapters/cli/main.js');
const SNAP_DIR = join(process.cwd(), 'tests/snapshots/changes');
const LEVEL_RE = /\b(low|medium|high|critical|unknown)\b/gi;

function replaceExact(text: string, search: string, replacement: string): string {
  assert.ok(text.includes(search), `expected fixture text to contain ${JSON.stringify(search)}`);
  return text.replace(search, replacement);
}

before(ensureRuntime);

function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  }).trim();
}

async function createGitMonoRepo(
  prefix: string,
  options: { riskZones?: 'default' | []; branch?: string } = {},
): Promise<{ work: string; repo: string; cacheHome: string }> {
  const work = await realpath(await mkdtemp(join(tmpdir(), `ei-chg-${prefix}-`)));
  const repo = join(work, 'mono');
  const cacheHome = join(work, 'cache-home');
  await mkdir(cacheHome, { recursive: true });
  cpSync(FIXTURE, repo, { recursive: true });
  if (options.riskZones !== undefined) {
    const cfgPath = join(repo, 'ei.config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    cfg.riskZones = options.riskZones;
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  }
  const branch = options.branch ?? 'main';
  gitSync(repo, 'init', '-q', '-b', branch);
  gitSync(repo, 'add', '-A');
  gitSync(repo, 'commit', '-qm', 'base');
  return { work, repo, cacheHome };
}

/** Shared X03 invariant helper (M2c Acceptance #2): no changed path may be hidden. */
function assertX03(result: ChangesResult, expectedChangedPaths: readonly string[]): void {
  const indexedPaths = new Set(result.changedFiles.filter((f) => f.indexed).map((f) => f.path));
  const unindexedPaths = new Set(result.unindexedChanges);
  for (const path of expectedChangedPaths) {
    assert.ok(
      indexedPaths.has(path) || unindexedPaths.has(path),
      `X03 violation: changed path ${path} omitted from both indexed changedFiles and unindexedChanges`,
    );
  }
  for (const file of result.changedFiles) {
    if (!file.indexed) {
      assert.ok(
        unindexedPaths.has(file.path),
        `X03 violation: unindexed changedFile ${file.path} missing from unindexedChanges`,
      );
    }
  }
  if (result.unindexedChanges.length > 0) {
    assert.equal(result.impact.completeness.status, 'partial');
    assert.ok(
      result.impact.completeness.reasons.some((r) => r.startsWith('outside-index-scope:')),
      'unindexedChanges must add outside-index-scope reason',
    );
  }
}

function assertOneVerdict(text: string, label: string): void {
  const actionLines = text.split('\n').filter((line) => line.startsWith('ACTION '));
  assert.equal(actionLines.length, 1, `${label}: expected exactly one ACTION line`);
  const matches = actionLines[0]!.match(LEVEL_RE) ?? [];
  assert.equal(matches.length, 1, `${label}: expected exactly one level word on ACTION line`);
}

function assertNoEnvironmentLeak(text: string, repoPath: string, label: string): void {
  assert.ok(!text.includes(repoPath), `${label}: leaked repo path`);
  const home = homedir();
  if (home.length > 1) assert.ok(!text.includes(home), `${label}: leaked home dir`);
  assert.ok(!text.includes(String(process.pid)), `${label}: leaked pid`);
}

async function runOnRepo(
  repo: string,
  cacheHome: string,
  options: Parameters<typeof runChanges>[1] = {},
  sessionOptions: ConstructorParameters<typeof ImpactSession>[1] = {},
): Promise<{ result: ChangesResult; text: string }> {
  const workspace = await loadWorkspace(repo, cacheHome);
  const session = new ImpactSession(workspace, sessionOptions);
  const outcome = await runChanges(session, options);
  assert.equal(outcome.kind, 'result', JSON.stringify(outcome));
  const text = renderChanges(outcome.value);
  assert.ok(text.length <= CHANGES_BUDGET, `output exceeded budget: ${text.length}`);
  if (!outcome.value.nothingChanged) {
    assertOneVerdict(text, 'changes');
    assertNoEnvironmentLeak(text, repo, 'changes');
  }
  return { result: outcome.value, text };
}

describe('M2c Round 2 — ei_changes', () => {
  it('Golden P05: untracked .sql in migrations triggers unindexedChanges + critical ask-owner', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('p05', { riskZones: 'default' });
    try {
      await mkdir(join(repo, 'packages/api/migrations'), { recursive: true });
      await writeFile(
        join(repo, 'packages/api/migrations/001.sql'),
        'CREATE TABLE charges (id TEXT PRIMARY KEY);\n',
      );
      const { result, text } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/api/migrations/001.sql']);
      assert.deepEqual(result.unindexedChanges, ['packages/api/migrations/001.sql']);
      assert.equal(result.verdict.level, 'critical');
      assert.equal(result.verdict.action, 'ask-owner');
      assert.ok(result.verdict.zones.includes('migrations'));
      assert.equal(result.impact.completeness.status, 'partial');
      assert.match(
        text,
        /^ACTION ask-owner · level critical \(zone migrations\) · picture partial/m,
      );
      assert.match(text, /^Not analysed \(1\)/m);
      assert.match(text, /packages\/api\/migrations\/001\.sql/);
      const snap = (await readFile(join(SNAP_DIR, 'P05.txt'), 'utf8')).trimEnd();
      assert.equal(text, snap);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('Golden X01: body edits to calculateFee and roundMoney produce union of both caller sets', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('x01', { riskZones: 'default' });
    try {
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      const moneyPath = join(repo, 'packages/shared/src/money.ts');
      await writeFile(
        feePath,
        replaceExact(
          await readFile(feePath, 'utf8'),
          'return legacy.toCents(amount) as number;',
          'return (legacy.toCents(amount) as number) + 0;',
        ),
      );
      await writeFile(
        moneyPath,
        replaceExact(
          await readFile(moneyPath, 'utf8'),
          'return Math.round(n * 100) / 100;',
          'return Math.trunc(n * 100) / 100;',
        ),
      );
      const { result, text } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/payments/src/fee.ts', 'packages/shared/src/money.ts']);
      assert.deepEqual(
        result.changedSymbols
          .map((s) => [s.symbol, s.change])
          .sort((a, b) => a[0]!.localeCompare(b[0]!)),
        [
          ['packages/payments/src/fee.ts#calculateFee', 'modified'],
          ['packages/shared/src/money.ts#roundMoney', 'modified'],
        ],
      );
      const d1Symbols = new Set((result.impact.byDepth[0] ?? []).map((n) => n.symbol));
      assert.ok(d1Symbols.has('packages/payments/src/fee.ts#calculateFee'), 'from roundMoney');
      assert.ok(d1Symbols.has('packages/api/src/charge.ts#chargeHandler'), 'from calculateFee');
      assert.ok(
        d1Symbols.has('packages/payments/src/service.ts#PaymentService.charge'),
        'from calculateFee',
      );
      assert.ok(result.impact.tests.includes('packages/payments/src/fee.test.ts'));
      assert.match(text, /Modified \(2\)/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('Golden X02: adding required parameter to calculateFee reports signature-changed first with callers', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('x02', { riskZones: 'default' });
    try {
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      await writeFile(
        feePath,
        replaceExact(
          await readFile(feePath, 'utf8'),
          'export function calculateFee(amount: number): number;\nexport function calculateFee(amount: number, currency: string): number;\nexport function calculateFee(amount: number, currency?: string): number {\n  void currency;',
          'export function calculateFee(amount: number, rate: number): number;\nexport function calculateFee(amount: number, rate: number, currency: string): number;\nexport function calculateFee(amount: number, rate: number, currency?: string): number {\n  void rate;\n  void currency;',
        ),
      );
      const { result, text } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/payments/src/fee.ts']);
      assert.equal(result.changedSymbols[0]?.symbol, 'packages/payments/src/fee.ts#calculateFee');
      assert.equal(result.changedSymbols[0]?.change, 'signature-changed');
      assert.ok((result.changedSymbols[0]?.callers ?? 0) >= 4);
      assert.match(text, /^Signature changed, still called \(1\)/m);
      const snap = (await readFile(join(SNAP_DIR, 'X02.txt'), 'utf8')).trimEnd();
      assert.equal(text, snap);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('detects untracked, staged-only, unstaged-only, and staged+unstaged changes once each', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('git-states', {
      riskZones: 'default',
    });
    try {
      // Untracked file
      await writeFile(
        join(repo, 'packages/shared/src/untracked.ts'),
        'export function untrackedFn(): number { return 1; }\n',
      );
      // Staged-only edit
      const moneyPath = join(repo, 'packages/shared/src/money.ts');
      await writeFile(
        moneyPath,
        replaceExact(
          await readFile(moneyPath, 'utf8'),
          'Math.round(n * 100)',
          'Math.round(n * 100 + 0)',
        ),
      );
      gitSync(repo, 'add', 'packages/shared/src/money.ts');
      // Staged + unstaged edit on same file (fee.ts)
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      const feeOrig = await readFile(feePath, 'utf8');
      await writeFile(
        feePath,
        replaceExact(feeOrig, 'roundMoney(amount);', 'roundMoney(amount + 1);'),
      );
      gitSync(repo, 'add', 'packages/payments/src/fee.ts');
      await writeFile(
        feePath,
        replaceExact(feeOrig, 'roundMoney(amount);', 'roundMoney(amount + 2);'),
      );
      // Unstaged-only edit
      const chargePath = join(repo, 'packages/api/src/charge.ts');
      await writeFile(
        chargePath,
        replaceExact(await readFile(chargePath, 'utf8'), 'calculateFee(10);', 'calculateFee(11);'),
      );

      const expected = [
        'packages/api/src/charge.ts',
        'packages/payments/src/fee.ts',
        'packages/shared/src/money.ts',
        'packages/shared/src/untracked.ts',
      ];
      const { result } = await runOnRepo(repo, cacheHome);
      assertX03(result, expected);
      assert.deepEqual(result.changedFiles.map((f) => f.path).sort(), expected);
      assert.ok(
        result.changedSymbols.some(
          (s) =>
            s.symbol === 'packages/shared/src/untracked.ts#untrackedFn' && s.change === 'added',
        ),
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('deleted file with live importers lists exports as removed first with unresolved-import users', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('deleted-file', {
      riskZones: 'default',
    });
    try {
      await rm(join(repo, 'packages/shared/src/money.ts'));
      const { result, text } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/shared/src/money.ts']);
      const roundMoney = result.changedSymbols.find(
        (s) => s.symbol === 'packages/shared/src/money.ts#roundMoney',
      );
      assert.ok(roundMoney);
      assert.equal(roundMoney.change, 'removed');
      assert.ok((roundMoney.liveUsers?.length ?? 0) > 0);
      assert.equal(result.changedSymbols[0]?.change, 'removed');
      assert.match(text, /^Removed, still used \(\d+\)/m);
      assert.match(text, /UNRESOLVED_IMPORT|UNRESOLVED_NAME_MATCH/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('renamed file (with and without edits) reports old keys removed, new keys added, old users shown, zones on both paths', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('renamed-file', {
      riskZones: 'default',
    });
    try {
      gitSync(repo, 'mv', 'packages/payments/src/fee.ts', 'packages/shared/src/renamed-fee.ts');
      const { result, text } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/shared/src/renamed-fee.ts']);
      const cf = result.changedFiles.find((f) => f.path === 'packages/shared/src/renamed-fee.ts');
      assert.equal(cf?.status, 'R');
      assert.equal(cf?.oldPath, 'packages/payments/src/fee.ts');
      assert.ok(
        result.changedSymbols.some(
          (s) => s.symbol === 'packages/payments/src/fee.ts#calculateFee' && s.change === 'removed',
        ),
      );
      assert.ok(
        result.changedSymbols.some(
          (s) =>
            s.symbol === 'packages/shared/src/renamed-fee.ts#calculateFee' && s.change === 'added',
        ),
      );
      // Zone matched on oldPath (packages/payments/src/fee.ts)
      assert.ok(result.verdict.zones.includes('payments'));
      assert.match(text, /^Removed, still used \(\d+\)/m);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('in-place symbol rename reports old symbol removed with users first and new symbol added', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('symbol-rename', {
      riskZones: 'default',
    });
    try {
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      await writeFile(
        feePath,
        replaceExact(
          await readFile(feePath, 'utf8'),
          'export function calculateFee(amount: number): number;\nexport function calculateFee(amount: number, currency: string): number;\nexport function calculateFee(amount: number, currency?: string): number {',
          'export function computeFee(amount: number): number;\nexport function computeFee(amount: number, currency: string): number;\nexport function computeFee(amount: number, currency?: string): number {',
        ),
      );
      const { result, text } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/payments/src/fee.ts']);
      assert.equal(result.changedSymbols[0]?.symbol, 'packages/payments/src/fee.ts#calculateFee');
      assert.equal(result.changedSymbols[0]?.change, 'removed');
      assert.ok((result.changedSymbols[0]?.liveUsers?.length ?? 0) > 0);
      assert.ok(
        result.changedSymbols.some(
          (s) => s.symbol === 'packages/payments/src/fee.ts#computeFee' && s.change === 'added',
        ),
      );
      assert.match(text, /^Removed, still used \(1\)/m);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('whitespace-only and comment-only edits list file as indexed with 0 changedSymbols and 0 impact', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('whitespace-only', {
      riskZones: 'default',
    });
    try {
      const moneyPath = join(repo, 'packages/shared/src/money.ts');
      const orig = await readFile(moneyPath, 'utf8');
      await writeFile(moneyPath, `// leading comment\n\n${orig}\n/* trailing comment */\n`);
      const { result } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/shared/src/money.ts']);
      assert.deepEqual(result.changedSymbols, []);
      assert.equal(result.impact.reach.total, 0);
      assert.equal(result.changedFiles[0]?.indexed, true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('inferred return type body edit classifies as signature-changed (per surface.ts semantics)', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('inferred-return', { riskZones: [] });
    try {
      const inferFile = join(repo, 'packages/shared/src/inferred.ts');
      await writeFile(inferFile, 'export function inferMe(x: number) {\n  return x + 1;\n}\n');
      gitSync(repo, 'add', 'packages/shared/src/inferred.ts');
      gitSync(repo, 'commit', '-qm', 'add inferred');

      await writeFile(inferFile, 'export function inferMe(x: number) {\n  return `${x}`;\n}\n');
      const { result } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/shared/src/inferred.ts']);
      assert.deepEqual(
        result.changedSymbols.map((s) => [s.symbol, s.change]),
        [['packages/shared/src/inferred.ts#inferMe', 'signature-changed']],
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('unindexed & secret files (.sql, chmod 000 .env.local, JSON, binary, excluded dir, orphan .ts) never read secret content and apply zone floors', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('unindexed-kinds', {
      riskZones: 'default',
    });
    const envPath = join(repo, 'packages/api/.env.local');
    try {
      const cfgPath = join(repo, 'ei.config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
      cfg.impact = { ...(cfg.impact as Record<string, unknown>), exclude: ['**/ignored/**'] };
      await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      gitSync(repo, 'add', 'ei.config.json');
      gitSync(repo, 'commit', '-qm', 'add exclude');

      await mkdir(join(repo, 'packages/api/migrations'), { recursive: true });
      await writeFile(join(repo, 'packages/api/migrations/002.sql'), 'SELECT 1;\n');
      await writeFile(envPath, 'API_SECRET=never-read\n');
      await chmod(envPath, 0o000);
      await writeFile(join(repo, 'packages/api/app.config.json'), '{"ok":true}\n');
      await writeFile(join(repo, 'packages/api/logo.bin'), Buffer.from([0, 1, 2, 3, 255]));
      await mkdir(join(repo, 'packages/api/ignored'), { recursive: true });
      await writeFile(join(repo, 'packages/api/ignored/skip.ts'), 'export const s = 1;\n');
      await mkdir(join(repo, 'orphan-dir'), { recursive: true });
      await writeFile(join(repo, 'orphan-dir/orphan.ts'), 'export const o = 1;\n');

      const expected = [
        'orphan-dir/orphan.ts',
        'packages/api/.env.local',
        'packages/api/app.config.json',
        'packages/api/ignored/skip.ts',
        'packages/api/logo.bin',
        'packages/api/migrations/002.sql',
      ];
      const { result, text } = await runOnRepo(repo, cacheHome);
      assertX03(result, expected);
      assert.deepEqual(result.unindexedChanges, expected);
      assert.equal(result.impact.completeness.status, 'partial');
      assert.equal(result.verdict.level, 'critical');
      assert.equal(result.verdict.action, 'ask-owner');
      assert.ok(result.verdict.zones.includes('migrations'));
      assert.ok(result.verdict.zones.includes('prod-config'));
      assert.match(text, /Not analysed \(6\)/);
      assert.match(text, /secret file; content never read/);
      assert.match(text, /excluded by configuration; content never read/);
      assert.match(text, /outside impact\.include scope/);
    } finally {
      await chmod(envPath, 0o644).catch(() => {});
      await rm(work, { recursive: true, force: true });
    }
  });

  it('changed file with syntax error reports parse-error and partial completeness', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('parse-error', { riskZones: [] });
    try {
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      await writeFile(feePath, 'export function broken( {\n');
      const { result } = await runOnRepo(repo, cacheHome);
      assertX03(result, ['packages/payments/src/fee.ts']);
      assert.equal(result.impact.completeness.status, 'partial');
      assert.ok(result.impact.completeness.reasons.some((r) => r.startsWith('parse-error:')));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('git error states (no git, detached HEAD, no default branch, shallow without merge-base, bad base, flag injection) fail clearly', async () => {
    const baseWork = await realpath(await mkdtemp(join(tmpdir(), 'ei-chg-giterr-')));
    try {
      // 1. Non-git directory
      const nonGit = join(baseWork, 'non-git');
      await mkdir(nonGit, { recursive: true });
      await writeFile(join(nonGit, 'a.ts'), 'export const a = 1;\n');
      const w1 = await loadWorkspace(nonGit, join(baseWork, 'c1'));
      const r1 = await runChanges(w1);
      assert.equal(r1.kind, 'failure');
      assert.equal(r1.code, 'INVALID_INPUT');
      assert.match(r1.message, /not a git repository/);

      // 2. Detached HEAD without --base, and leading-dash injection, and missing --base
      const { work, repo, cacheHome } = await createGitMonoRepo('errors', {
        branch: 'feature-only',
      });
      try {
        // No default branch (feature-only)
        const wNoBranch = await loadWorkspace(repo, cacheHome);
        const rNoBranch = await runChanges(wNoBranch);
        assert.equal(rNoBranch.kind, 'failure');
        assert.match(rNoBranch.message, /no default branch found/);

        // Leading '-' injection
        const rInject = await runChanges(wNoBranch, { base: '--output=/tmp/evil' });
        assert.equal(rInject.kind, 'failure');
        assert.equal(rInject.code, 'INVALID_INPUT');
        assert.match(rInject.message, /must not start with "-"/);

        // Missing base ref
        const rMissing = await runChanges(wNoBranch, { base: 'does-not-exist' });
        assert.equal(rMissing.kind, 'failure');
        assert.match(rMissing.message, /does not exist/);

        // Detached HEAD
        gitSync(repo, 'checkout', '-q', '--detach');
        const rDetached = await runChanges(wNoBranch);
        assert.equal(rDetached.kind, 'failure');
        assert.match(rDetached.message, /HEAD is detached/);

        // Shallow clone with no common merge-base with main
        const shallow = join(baseWork, 'shallow');
        await mkdir(shallow, { recursive: true });
        gitSync(shallow, 'init', '-q', '-b', 'topic');
        await writeFile(join(shallow, 'a.ts'), 'export const a = 1;\n');
        gitSync(shallow, 'add', 'a.ts');
        gitSync(shallow, 'commit', '-qm', 'orphan-topic');
        gitSync(shallow, 'checkout', '-q', '--orphan', 'main');
        gitSync(shallow, 'rm', '-rf', '.');
        await writeFile(join(shallow, 'b.ts'), 'export const b = 2;\n');
        gitSync(shallow, 'add', 'b.ts');
        gitSync(shallow, 'commit', '-qm', 'orphan-main');
        gitSync(shallow, 'checkout', '-q', 'topic');
        const wShallow = await loadWorkspace(shallow, join(baseWork, 'c-shallow'));
        const rShallow = await runChanges(wShallow);
        assert.equal(rShallow.kind, 'failure');
        assert.match(rShallow.message, /merge-base/);
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    } finally {
      await rm(baseWork, { recursive: true, force: true });
    }
  });

  it('works from a git worktree and from a subdirectory cwd', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('worktree-subdir', {
      riskZones: 'default',
    });
    const wt = join(work, 'wt');
    try {
      gitSync(repo, 'worktree', 'add', '-q', '-b', 'wt-branch', wt, 'main');
      const feeInWt = join(wt, 'packages/payments/src/fee.ts');
      await writeFile(
        feeInWt,
        replaceExact(
          await readFile(feeInWt, 'utf8'),
          'roundMoney(amount);',
          'roundMoney(amount + 1);',
        ),
      );
      await runOnRepo(wt, cacheHome);
      const wtWarm = await runOnRepo(wt, cacheHome);
      assertX03(wtWarm.result, ['packages/payments/src/fee.ts']);

      // Subdirectory cwd inside repo
      const subRes = await runOnRepo(join(wt, 'packages/payments/src'), cacheHome);
      assertX03(subRes.result, ['packages/payments/src/fee.ts']);
      assert.equal(wtWarm.text, subRes.text);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('300 changed files stay within 8000 chars and over-budget keeps Signature changed, still called in full', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('budget-300', {
      riskZones: 'default',
    });
    try {
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      await writeFile(
        feePath,
        replaceExact(
          await readFile(feePath, 'utf8'),
          'export function calculateFee(amount: number): number;\nexport function calculateFee(amount: number, currency: string): number;\nexport function calculateFee(amount: number, currency?: string): number {\n  void currency;',
          'export function calculateFee(amount: number, extra: number): number;\nexport function calculateFee(amount: number, extra: number, currency: string): number;\nexport function calculateFee(amount: number, extra: number, currency?: string): number {\n  void extra;\n  void currency;',
        ),
      );
      await mkdir(join(repo, 'packages/api/migrations'), { recursive: true });
      const created: string[] = ['packages/payments/src/fee.ts'];
      for (let i = 0; i < 300; i++) {
        const p = `packages/api/migrations/m_${String(i).padStart(3, '0')}.sql`;
        await writeFile(join(repo, p), `-- migration ${i}\n`);
        created.push(p);
      }
      const { result, text } = await runOnRepo(repo, cacheHome);
      assertX03(result, created);
      assert.ok(text.length <= CHANGES_BUDGET, `got ${text.length}`);
      assert.match(text, /^CHANGES vs main .* — 301 files,/m);
      assert.match(text, /^ACTION ask-owner · level critical/m);
      assert.match(text, /^Signature changed, still called \(1\)/m);
      assert.match(text, /calculateFee {2}packages\/payments\/src\/fee\.ts/);
      assert.match(text, /packages\/api\/src\/charge\.ts/);
      assert.match(text, /^Next: /m);
      assert.match(text, /^— index /m);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('is byte-deterministic across repeated calls and returns nothing-changed on stale index with empty diff', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('determinism', {
      riskZones: 'default',
    });
    try {
      const workspace = await loadWorkspace(repo, cacheHome);
      await new Indexer(ts, workspace.root, workspace.cacheDir).index({
        impact: impactOf(repo),
        full: true,
        freshness: 'hash',
      });
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      const orig = await readFile(feePath, 'utf8');
      await writeFile(
        feePath,
        replaceExact(orig, 'roundMoney(amount);', 'roundMoney(amount + 1);'),
      );
      await new Indexer(ts, workspace.root, workspace.cacheDir).index({
        impact: impactOf(repo),
        freshness: 'hash',
      });
      await writeFile(feePath, orig);
      const emptyRes = await runOnRepo(repo, cacheHome);
      assert.equal(emptyRes.result.nothingChanged, true);
      assert.equal(
        emptyRes.text,
        `CHANGES vs main (merge-base ${emptyRes.result.mergeBase}) — nothing changed in the working tree.`,
      );
      assert.doesNotMatch(emptyRes.text, /stale/);

      // Repeated non-empty calls (with no edits between them) are byte-identical
      await writeFile(
        feePath,
        replaceExact(orig, 'roundMoney(amount);', 'roundMoney(amount + 1);'),
      );
      await runOnRepo(repo, cacheHome);
      const first = await runOnRepo(repo, cacheHome);
      const second = await runOnRepo(repo, cacheHome);
      assert.equal(first.text, second.text);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('planned targets (D58): renamed-file symbol, ambiguous bare name, 0 and 50 targets, unchanged verdict', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('planned', { riskZones: 'default' });
    try {
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      await writeFile(
        feePath,
        replaceExact(
          await readFile(feePath, 'utf8'),
          'roundMoney(amount);',
          'roundMoney(amount + 1);',
        ),
      );
      gitSync(repo, 'mv', 'packages/shared/src/money.ts', 'packages/shared/src/cash.ts');

      // Base call without planned
      const noPlan = await runOnRepo(repo, cacheHome);

      // 0 planned targets -> all changed symbols in Not in plan, verdict unchanged
      const zeroPlan = await runOnRepo(repo, cacheHome, { planned: [] });
      assert.deepEqual(zeroPlan.result.verdict, noPlan.result.verdict);
      assert.equal(zeroPlan.result.plan?.plannedCount, 0);
      assert.ok((zeroPlan.result.plan?.notInPlan.length ?? 0) > 0);
      assert.match(zeroPlan.text, /^Not in plan \(\d+\)/m);

      // Renamed file symbol + ambiguous bare name ('charge') + 50 targets
      const manyTargets = [
        'packages/shared/src/money.ts#roundMoney',
        'charge',
        ...Array.from({ length: 48 }, (_, i) => `nonexistentTarget${i}`),
      ];
      const richPlan = await runOnRepo(repo, cacheHome, { planned: manyTargets });
      assert.deepEqual(richPlan.result.verdict, noPlan.result.verdict);
      assert.equal(richPlan.result.plan?.plannedCount, 50);
      assert.equal(richPlan.result.plan?.ambiguous.length, 1);
      assert.equal(richPlan.result.plan?.ambiguous[0]?.target, 'charge');
      assert.equal(richPlan.result.plan?.unchanged.length, 48);
      // calculateFee is not in plannedTargets -> appears in Not in plan with its callers!
      const calcNotInPlan = richPlan.result.plan?.notInPlan.find(
        (item) => item.symbol === 'packages/payments/src/fee.ts#calculateFee',
      );
      assert.ok(calcNotInPlan);
      assert.ok(calcNotInPlan.liveUsers.length > 0);
      assert.match(richPlan.text, /^Not in plan \(\d+\)/m);
      assert.match(richPlan.text, /^Planned, unchanged \(48\)/m);
      assert.match(richPlan.text, /^Plan guidance \(1\)/m);
      assert.match(richPlan.text, /AMBIGUOUS charge/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('forces freshness: "hash" (catches same-length restored-mtime edits) and falls back to partial stale on build failure', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('hash-and-stale', {
      riskZones: 'default',
    });
    try {
      const workspace = await loadWorkspace(repo, cacheHome);
      await new Indexer(ts, workspace.root, workspace.cacheDir).index({
        impact: impactOf(repo),
        full: true,
        freshness: 'hash',
      });

      // Mutation M6 check: same-length edit with restored atime & mtime
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      const orig = await readFile(feePath, 'utf8');
      const origStat = statSync(feePath);
      const edited = replaceExact(orig, 'return 0;', 'return 1;');
      assert.equal(Buffer.byteLength(edited), Buffer.byteLength(orig), 'exact same byte length');
      await writeFile(feePath, edited);
      utimesSync(feePath, origStat.atime, origStat.mtime);

      // Fresh hash probe must detect the edit even though (size, mtimeMs) is unchanged!
      const freshHashRes = await runOnRepo(repo, cacheHome);
      assert.equal(freshHashRes.result.indexState, 'updated');
      assert.deepEqual(
        freshHashRes.result.changedSymbols.map((s) => [s.symbol, s.change]),
        [['packages/payments/src/fee.ts#unusedHelper', 'modified']],
      );

      // Now make another edit and simulate a failed/timed-out build -> must be stale/partial, never complete
      await writeFile(feePath, replaceExact(orig, 'return 0;', 'return 2;'));
      const staleRes = await runOnRepo(
        repo,
        cacheHome,
        {},
        {
          waitMs: 5,
          build: () => new Promise(() => {}),
        },
      );
      assert.equal(staleRes.result.indexState, 'stale');
      assert.equal(staleRes.result.impact.completeness.status, 'partial');
      assert.ok(
        staleRes.result.impact.completeness.reasons.some((r) => r.startsWith('stale-index:')),
      );
      assert.equal(staleRes.result.verdict.level, 'high');
      assert.equal(staleRes.result.verdict.action, 'ask-owner');
      assert.match(staleRes.text, /picture partial \(stale index\)/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('CLI `ei changes --json` exposes phase-split timings and honors EI_DISABLED=1', async () => {
    const { work, repo, cacheHome } = await createGitMonoRepo('cli', { riskZones: 'default' });
    try {
      const feePath = join(repo, 'packages/payments/src/fee.ts');
      await writeFile(
        feePath,
        replaceExact(
          await readFile(feePath, 'utf8'),
          'roundMoney(amount);',
          'roundMoney(amount + 1);',
        ),
      );
      const env = { ...process.env };
      const { stdout } = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, 'changes', '--root', repo, '--base', 'main', '--json'],
        { env },
      );
      const parsed = JSON.parse(stdout) as ChangesResult;
      assertX03(parsed, ['packages/payments/src/fee.ts']);
      assert.ok(parsed.timings !== undefined);
      assert.equal(typeof parsed.timings.updateMs, 'number');
      assert.equal(typeof parsed.timings.baseParseMs, 'number');
      assert.equal(typeof parsed.timings.traverseMs, 'number');
      assert.equal(typeof parsed.timings.renderMs, 'number');

      const disabled = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, 'changes', '--root', repo],
        { env: { ...env, EI_DISABLED: '1' } },
      );
      assert.equal(disabled.stdout.trim(), 'CHANGES disabled (EI_DISABLED)');

      // Depth 2 lists transitive callers too
      const d2 = await runOnRepo(repo, cacheHome, { base: 'main', depth: 2 });
      assert.match(d2.text, /^Depth 2 \(\d+\)/m);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('renderChangesOutcome formats guidance and failures cleanly', () => {
    assert.equal(
      renderChangesOutcome({
        kind: 'guidance',
        code: 'index-building',
        message: 'building',
      }),
      'INDEX BUILDING — index build still running after 60 s. Call again; the answer will use the finished index.',
    );
    assert.match(
      renderChangesOutcome({
        kind: 'failure',
        code: 'index-failed',
        message: 'boom',
        retry: true,
      }),
      /^index-failed: boom\. Retry once/,
    );
  });
});
