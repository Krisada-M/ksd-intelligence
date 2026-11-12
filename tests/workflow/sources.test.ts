import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { it } from 'node:test';
import { promisify } from 'node:util';
import { skillIdsOf } from '../../src/workflow/catalog.js';
import {
  checkSources,
  formatReports,
  parseLock,
  readLock,
  reportStatus,
  type ProviderReport,
  type SkillsLock,
} from '../../src/workflow/sources.js';
import { WorkflowError } from '../../src/workflow/types.js';
import {
  FRONTMATTER_BODY,
  cleanup,
  emptyLock,
  skillPath,
  tempDir,
  writeSkillFile,
} from './fixtures.js';

const run = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', [
    '-C',
    root,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    ...args,
  ]);
  return stdout.trim();
}

// A real git checkout holding every poteto skill, so HEAD and hashes are genuine.
async function potetoCheckout(): Promise<string> {
  const root = await tempDir('git');
  await git(root, 'init', '-q');
  for (const id of skillIdsOf('poteto'))
    await writeSkillFile(root, id, FRONTMATTER_BODY(id, `body of ${id}`));
  // -f: a developer's global gitignore may list SKILL.md.
  await git(root, 'add', '-f', '-A');
  await git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

function potetoReport(reports: ProviderReport[]): ProviderReport {
  const report = reports.find((r) => r.provider === 'poteto');
  assert.ok(report);
  return report;
}

it('parseLock accepts an unpinned lock and rejects malformed ones', () => {
  const text = JSON.stringify(emptyLock());
  assert.equal(parseLock(text).version, 1);

  const bad = (mutate: (lock: SkillsLock) => void): void => {
    const lock = emptyLock();
    mutate(lock);
    assert.throws(() => parseLock(JSON.stringify(lock)), /LOCK_INVALID/);
  };
  bad((lock) => {
    lock.providers.matt.commit = 'abc';
  });
  bad((lock) => {
    lock.providers.matt.skills['matt:tdd'] = { sha256: 'xyz' };
  });
  bad((lock) => {
    lock.providers.matt.skills['matt:not-in-catalog'] = { sha256: null };
  });
  bad((lock) => {
    delete lock.providers.osmani.skills['osmani:shipping-and-launch'];
  });
  bad((lock) => {
    lock.providers.poteto.rootSubpath = 'plugins/pstack/skills';
  });
  bad((lock) => {
    lock.providers.matt.repo = 'https://example.invalid/skills.git';
  });
  assert.throws(() => parseLock('{not json'), /LOCK_INVALID/);
  assert.throws(() => parseLock('{"version":2,"providers":{}}'), /LOCK_INVALID/);
});

it('readLock reports a missing lock file as LOCK_INVALID', async () => {
  const dir = await tempDir('lock');
  try {
    await assert.rejects(
      readLock(join(dir, 'nope.json')),
      (e: unknown) => e instanceof WorkflowError && e.code === 'LOCK_INVALID',
    );
  } finally {
    await cleanup(dir);
  }
});

it('sources check without checkouts reports PROVIDER_ROOT_MISSING per provider', async () => {
  const { reports } = await checkSources(emptyLock(), {}, { write: false });
  assert.deepEqual(
    reports.map((r) => [r.provider, r.problems.map((p) => p.code)]),
    [
      ['matt', ['PROVIDER_ROOT_MISSING']],
      ['poteto', ['PROVIDER_ROOT_MISSING']],
      ['osmani', ['PROVIDER_ROOT_MISSING']],
    ],
  );
  assert.ok(reports.every((r) => reportStatus(r) === 'ERROR'));
});

it('sources check reports PROVIDER_ROOT_NOT_FOUND for a path that does not exist', async () => {
  const gone = await tempDir('gone');
  await cleanup(gone);
  const { reports } = await checkSources(emptyLock(), { poteto: gone }, { write: false });
  assert.deepEqual(
    potetoReport(reports).problems.map((p) => p.code),
    ['PROVIDER_ROOT_NOT_FOUND'],
  );
});

it('sources check reports SKILL_NOT_FOUND when the root is the wrong directory', async () => {
  const root = await tempDir('wrongroot');
  try {
    const report = potetoReport(
      (await checkSources(emptyLock(), { poteto: root }, { write: false })).reports,
    );
    assert.deepEqual([...new Set(report.problems.map((p) => p.code))].sort(), [
      'NOT_A_GIT_CHECKOUT',
      'SKILL_NOT_FOUND',
    ]);
    assert.equal(report.skillsFound, 0);
  } finally {
    await cleanup(root);
  }
});

it('unpinned checkout is UNPINNED, --write pins HEAD and hashes, then it is OK', async () => {
  const root = await potetoCheckout();
  try {
    const before = potetoReport(
      (await checkSources(emptyLock(), { poteto: root }, { write: false })).reports,
    );
    assert.equal(reportStatus(before), 'UNPINNED');
    assert.equal(before.skillsFound, 3);

    const written = await checkSources(emptyLock(), { poteto: root }, { write: true });
    const head = await git(root, 'rev-parse', 'HEAD');
    assert.equal(written.lock.providers.poteto.commit, head);
    assert.equal(potetoReport(written.reports).written, true);
    assert.match(
      written.lock.providers.poteto.skills['poteto:how']?.sha256 ?? '',
      /^[0-9a-f]{64}$/,
    );
    // Providers without a usable checkout are left untouched.
    assert.equal(written.lock.providers.matt.commit, null);

    const after = potetoReport(
      (
        await checkSources(
          parseLock(JSON.stringify(written.lock)),
          { poteto: root },
          { write: false },
        )
      ).reports,
    );
    assert.equal(reportStatus(after), 'OK');
    assert.equal(after.hashesVerified, 3);
  } finally {
    await cleanup(root);
  }
});

it('detects HASH_MISMATCH and COMMIT_MISMATCH after the checkout changes; --write does not write incomplete providers', async () => {
  const root = await potetoCheckout();
  try {
    const pinned = (await checkSources(emptyLock(), { poteto: root }, { write: true })).lock;

    await writeFile(skillPath(root, 'poteto:how'), FRONTMATTER_BODY('how', 'edited upstream'));
    await git(root, 'commit', '-q', '-am', 'upstream change');

    const drift = potetoReport(
      (await checkSources(pinned, { poteto: root }, { write: false })).reports,
    );
    assert.deepEqual(drift.problems.map((p) => p.code).sort(), [
      'COMMIT_MISMATCH',
      'HASH_MISMATCH',
    ]);
    assert.match(formatReports([drift]), /HASH_MISMATCH.*poteto:how/);

    await writeFile(skillPath(root, 'poteto:why'), 'broken, no frontmatter');
    const refused = await checkSources(pinned, { poteto: root }, { write: true });
    assert.equal(potetoReport(refused.reports).written, false);
    assert.deepEqual(refused.lock.providers.poteto, pinned.providers.poteto);
  } finally {
    await cleanup(root);
  }
});
