import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';
import {
  buildMrProposalPayload,
  formatUpdateMarkdown,
  runSkillsUpdatePipeline,
} from '../../scripts/ci/check-skills-updates.mjs';
import { PROVIDERS, skillIdsOf } from '../../dist/workflow/catalog.js';
import { defaultRegistryPath, readRegistry, writeRegistry } from '../../dist/workflow/registry.js';
import { checkSources, writeLock } from '../../dist/workflow/sources.js';
import { PROVIDER_IDS } from '../../dist/workflow/types.js';

const execFileAsync = promisify(execFile);

async function git(root, ...args) {
  const { stdout } = await execFileAsync('git', [
    '-C',
    root,
    '-c',
    'user.name=ci-test',
    '-c',
    'user.email=ci-test@example.invalid',
    ...args,
  ]);
  return stdout.trim();
}

describe('GitLab CI unified skill update pipeline', () => {
  it('.gitlab-ci.yml disables upstream git hooks, checks both AGY and OMP, and never auto-merges', async () => {
    const yaml = await readFile('.gitlab-ci.yml', 'utf8');
    assert.match(yaml, /core\.hooksPath/);
    assert.match(yaml, /skills check --platform agy/);
    assert.match(yaml, /skills check --platform omp/);
    assert.match(yaml, /scripts\/ci\/check-skills-updates\.mjs/);
    assert.doesNotMatch(yaml, /merge_when_pipeline_succeeds:\s*true/);
    assert.doesNotMatch(yaml, /git merge|glab mr merge/i);
  });

  it('buildMrProposalPayload always creates a Draft MR with auto-merge disabled', () => {
    const fakeStaged = {
      stageId: 'stage-123',
      status: 'staged',
      validation: {
        ok: true,
        runtimes: {
          agy: { ok: true, discoveredCount: 5, optInCount: 1 },
          omp: { ok: true, discoveredCount: 5, optInCount: 1 },
        },
      },
      diff: {
        hasUpdates: true,
        providers: [],
        findings: [],
        blockingFindings: [],
      },
    };
    const okPayload = buildMrProposalPayload({
      staged: fakeStaged,
      sourceBranch: 'chore/skills-update-stage-123',
    });
    assert.match(okPayload.title, /^Draft: /);
    assert.equal(okPayload.merge_when_pipeline_succeeds, false);

    const blockedPayload = buildMrProposalPayload({
      staged: {
        ...fakeStaged,
        status: 'blocked',
        validation: { ...fakeStaged.validation, ok: false },
      },
      sourceBranch: 'chore/skills-update-stage-123',
    });
    assert.match(blockedPayload.title, /^Draft: \[BLOCKED\] /);
    assert.equal(blockedPayload.merge_when_pipeline_succeeds, false);
    assert.match(blockedPayload.labels, /blocked/);
    assert.match(formatUpdateMarkdown(fakeStaged), /Auto-merge is \*\*disabled\*\*/);
  });

  it('runSkillsUpdatePipeline emits report artifacts and proposes a Draft MR without auto-merge', async () => {
    const work = await mkdtemp(join(tmpdir(), 'ksd-gitlab-ci-'));
    try {
      const roots = {};
      const baseRegistry = await readRegistry(defaultRegistryPath());
      const emptyLock = {
        version: 1,
        providers: Object.fromEntries(
          PROVIDER_IDS.map((p) => [
            p,
            {
              repo: PROVIDERS[p].repo,
              commit: null,
              rootSubpath: PROVIDERS[p].rootSubpath,
              skills: Object.fromEntries(skillIdsOf(p).map((id) => [id, { sha256: null }])),
            },
          ]),
        ),
      };

      for (const provider of PROVIDER_IDS) {
        const dir = join(work, provider);
        await mkdir(dir, { recursive: true });
        await git(dir, 'init', '-q');
        for (const id of skillIdsOf(provider)) {
          const name = id.split(':')[1];
          const file = join(dir, PROVIDERS[provider].rootSubpath, name, 'SKILL.md');
          await mkdir(join(file, '..'), { recursive: true });
          await writeFile(file, `---\nname: ${name}\ndescription: ${name}\n---\nv1\n`);
        }
        await git(dir, 'add', '-f', '-A');
        await git(dir, 'commit', '-q', '-m', 'v1');
        roots[provider] = dir;
      }

      const initial = await checkSources(emptyLock, roots, { write: true });
      const lockPath = join(work, 'skills.lock.json');
      const registryPath = join(work, 'skills.registry.json');
      await writeLock(lockPath, initial.lock);
      for (const p of PROVIDER_IDS)
        baseRegistry.providers[p].commit = initial.lock.providers[p].commit;
      await writeRegistry(registryPath, baseRegistry);

      // Introduce an upstream update in matt.
      const tddFile = join(roots.matt, PROVIDERS.matt.rootSubpath, 'tdd', 'SKILL.md');
      await writeFile(tddFile, '---\nname: tdd\ndescription: tdd\n---\nv2\n');
      await git(roots.matt, 'add', '-f', '-A');
      await git(roots.matt, 'commit', '-q', '-m', 'v2');

      const calls = [];
      const result = await runSkillsUpdatePipeline({
        roots,
        stateDir: join(work, 'state'),
        reportDir: join(work, 'report'),
        lockPath,
        registryPath,
        proposeMr: true,
        gitlabApiUrl: 'https://gitlab.example.invalid/api/v4',
        projectId: '42',
        gitlabToken: 'stub-token',
        fetchImpl: async (url, init) => {
          calls.push({ url, body: JSON.parse(init.body) });
          return { ok: true, status: 201 };
        },
      });

      assert.equal(result.staged.status, 'staged');
      assert.equal(result.mrProposal.submitted, true);
      assert.equal(calls.length, 1);
      assert.match(calls[0].body.title, /^Draft: /);
      assert.equal(calls[0].body.merge_when_pipeline_succeeds, false);
      assert.match(await readFile(result.reportPath, 'utf8'), /KSD Unified Skill Update Report/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
