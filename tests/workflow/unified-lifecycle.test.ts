import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { detectAgyPaths, discoverAgySkills } from '../../src/adapters/agy/skills.js';
import { detectOmpEnvironment, discoverOmpSkills } from '../../src/adapters/omp/skills.js';
import { PROVIDERS, catalog, skillIdsOf, type ProviderRoots } from '../../src/workflow/catalog.js';
import {
  defaultRegistryPath,
  parseRegistry,
  readRegistry,
  validateRegistryConsistency,
  writeRegistry,
} from '../../src/workflow/registry.js';
import { checkSources, defaultLockPath, readLock, writeLock } from '../../src/workflow/sources.js';
import {
  checkUpstreamUpdates,
  publishStagedUpdate,
  rollbackSkillUpdate,
  stageSkillUpdate,
} from '../../src/workflow/updates.js';
import { PROVIDER_IDS, WorkflowError } from '../../src/workflow/types.js';
import {
  FRONTMATTER_BODY,
  cleanup,
  emptyLock,
  skillPath,
  tempDir,
  writeSkillFile,
} from './fixtures.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL('../../../dist/adapters/cli/main.js', import.meta.url));

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [
    '-C',
    root,
    '-c',
    'user.name=ksd-test',
    '-c',
    'user.email=ksd-test@example.invalid',
    ...args,
  ]);
  return stdout.trim();
}

async function createAllProviderCheckouts(): Promise<{
  roots: Required<Record<'matt' | 'poteto' | 'osmani', string>>;
  dirs: string[];
}> {
  const matt = await tempDir('up-matt');
  const poteto = await tempDir('up-poteto');
  const osmani = await tempDir('up-osmani');
  const roots = { matt, poteto, osmani };
  const registry = await readRegistry(defaultRegistryPath());

  for (const provider of PROVIDER_IDS) {
    const root = roots[provider];
    await git(root, 'init', '-q');
    for (const id of skillIdsOf(provider)) {
      await writeSkillFile(root, id, FRONTMATTER_BODY(id, `body of ${id}`));
    }
    // Also populate referenced upstream playbooks (including opt-in poteto-mode).
    for (const pack of Object.values(registry.packs)) {
      if (pack.provider !== provider) continue;
      for (const relPath of pack.upstream.sourcePaths) {
        const abs = join(root, PROVIDERS[provider].rootSubpath, relPath);
        if (existsSync(abs)) continue;
        await mkdir(join(abs, '..'), { recursive: true });
        const name = relPath.split('/')[0] ?? 'skill';
        const extra = name === 'poteto-mode' ? '\ndisable-model-invocation: true' : '';
        await writeFile(
          abs,
          `---\nname: ${name}\ndescription: upstream ${name}${extra}\n---\nref\n`,
        );
      }
    }
    await git(root, 'add', '-f', '-A');
    await git(root, 'commit', '-q', '-m', 'initial');
  }

  return { roots, dirs: [matt, poteto, osmani] };
}

async function writeSkillMd(root: string, name: string, body: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  await writeFile(file, `---\nname: ${name}\ndescription: ${name} desc\n---\n\n${body}\n`);
  return file;
}

describe('Unified Skill Registry & Lockfile', () => {
  it('committed skills.registry.json matches skills.lock.json with zero consistency issues', async () => {
    const registry = await readRegistry(defaultRegistryPath());
    const lock = await readLock(defaultLockPath());
    const issues = await validateRegistryConsistency(registry, lock);
    assert.deepEqual(issues, []);
    assert.equal(registry.orchestrator, 'ksd-intelligence');
    assert.deepEqual(registry.packs['poteto-mode'].supportedRuntimes, ['agy', 'omp']);
    assert.equal(registry.packs['poteto-mode'].activation, 'opt-in');
    assert.equal(registry.packs['poteto-mode'].disableModelInvocation, true);
  });

  it('detects registry/lock drift, cycles, missing runtime support, opt-in and policy violations', async () => {
    const registry = await readRegistry(defaultRegistryPath());
    const lock = await readLock(defaultLockPath());

    const mutated = parseRegistry(JSON.stringify(registry));
    mutated.providers.matt.commit = '0'.repeat(40);
    mutated.packs['pstack-analysis'].dependencies.packs = ['poteto-mode'];
    mutated.packs['matt-sdlc'].supportedRuntimes = ['omp'];
    mutated.packs['poteto-mode'].activation = 'auto';
    mutated.packs['osmani-quality'].ksdAdaptation.wrapperPath = 'src/policy/index.js';

    const issues = await validateRegistryConsistency(mutated, lock);
    const codes = new Set(issues.map((issue) => issue.code));
    assert.ok(codes.has('REGISTRY_LOCK_DRIFT'));
    assert.ok(codes.has('CYCLIC_DEPENDENCY'));
    assert.ok(codes.has('RUNTIME_UNSUPPORTED'));
    assert.ok(codes.has('OPT_IN_VIOLATION'));
    assert.ok(codes.has('POLICY_BOUNDARY_VIOLATION'));
  });
});

describe('First-class AGY & OMP native path detection and customization preservation', () => {
  it('AGY detects workspace, Snap, global, shared, and catalog paths without hardcoded usernames', async () => {
    const fakeHome = await tempDir('agy-home');
    const workspace = await tempDir('agy-ws');
    try {
      const snapCommon = join(fakeHome, 'snap', 'antigravity-cli', 'common');
      const snapSkills = join(snapCommon, '.gemini', 'antigravity-cli', 'skills');
      const globalSkills = join(fakeHome, '.gemini', 'config', 'skills');
      const sharedSkills = join(fakeHome, '.agents', 'skills');
      const wsSkills = join(workspace, '.agents', 'skills');

      await writeSkillMd(wsSkills, 'matt-sdlc', 'workspace override');
      await writeSkillMd(snapSkills, 'pstack-analysis', 'snap override');
      await writeSkillMd(globalSkills, 'osmani-quality', 'global override');
      await writeSkillMd(sharedSkills, 'shared-custom', 'shared skill');

      const env: NodeJS.ProcessEnv = {
        HOME: snapCommon,
        SNAP_REAL_HOME: fakeHome,
        SNAP_USER_COMMON: snapCommon,
        ANTIGRAVITY_APP_DATA_DIR: join(snapCommon, '.gemini', 'antigravity-cli'),
      };

      const paths = detectAgyPaths({ workspaceRoot: workspace, env });
      assert.equal(paths.realHome, fakeHome);
      assert.equal(paths.snapDetected, true);
      assert.ok(paths.snapSkillsDirs.includes(snapSkills));
      assert.ok(paths.globalSkillsDirs.includes(globalSkills));
      assert.equal(paths.sharedSkillsDir, sharedSkills);

      const discovery = await discoverAgySkills({
        workspaceRoot: workspace,
        detectHostPaths: true,
        env,
      });
      assert.deepEqual(discovery.issues, []);
      const byName = new Map(discovery.skills.map((s) => [s.name, s]));
      assert.equal(byName.get('matt-sdlc')?.sourceLabel, 'agy:workspace');
      assert.equal(byName.get('pstack-analysis')?.sourceLabel, 'agy:snap');
      assert.equal(byName.get('osmani-quality')?.sourceLabel, 'agy:global');
      assert.equal(byName.get('shared-custom')?.sourceLabel, 'agy:shared');
      assert.equal(byName.get('ksd-intelligence')?.sourceLabel, 'ksd:catalog');
      assert.deepEqual(
        discovery.explicitOnly.map((s) => s.name),
        ['poteto-mode'],
      );
    } finally {
      await cleanup(fakeHome, workspace);
    }
  });

  it('OMP respects profiles, RULES.md, config files, and symlinked user skills without overwriting them', async () => {
    const fakeHome = await tempDir('omp-home');
    const workspace = await tempDir('omp-ws');
    try {
      const profileAgent = join(fakeHome, '.omp', 'profiles', 'work', 'agent');
      const sharedSkills = join(fakeHome, '.agents', 'skills');
      const profileSkills = join(profileAgent, 'skills');
      const projectOmp = join(workspace, '.omp');

      await mkdir(profileSkills, { recursive: true });
      await mkdir(join(projectOmp, 'skills'), { recursive: true });

      await writeFile(join(profileAgent, 'RULES.md'), '# User OMP rules\n');
      await writeFile(join(profileAgent, 'config.yml'), 'theme: default\n');
      await writeFile(join(profileAgent, 'engineering-proxy.json'), '{"enabled":true}\n');
      await writeFile(join(projectOmp, 'RULES.md'), '# Project OMP rules\n');

      // Realistic OMP setup: symlink inside profile skills pointing to ~/.agents/skills/<name>.
      await writeSkillMd(sharedSkills, 'custom-shared', 'shared body');
      await symlink(join(sharedSkills, 'custom-shared'), join(profileSkills, 'custom-shared'));
      await writeSkillMd(profileSkills, 'matt-sdlc', 'profile override');

      const env: NodeJS.ProcessEnv = { HOME: fakeHome, OMP_PROFILE: 'work' };
      const envInfo = detectOmpEnvironment({ workspaceRoot: workspace, env });
      assert.equal(envInfo.profile, 'work');
      assert.equal(envInfo.agentDir, profileAgent);
      assert.ok(envInfo.rulesFiles.every((r) => r.exists));
      assert.ok(envInfo.configFiles.some((c) => c.kind === 'config.yml' && c.exists));
      assert.ok(envInfo.configFiles.some((c) => c.kind === 'engineering-proxy.json' && c.exists));

      const discovery = await discoverOmpSkills({
        workspaceRoot: workspace,
        detectHostPaths: true,
        env,
      });
      assert.deepEqual(discovery.issues, []);
      const byName = new Map(discovery.skills.map((s) => [s.name, s]));
      assert.equal(byName.get('matt-sdlc')?.sourceLabel, 'omp:profile:work');
      assert.equal(byName.get('custom-shared')?.sourceLabel, 'omp:profile:work');
      assert.equal(byName.get('pstack-analysis')?.sourceLabel, 'omp:plugin:ksd-intelligence');
      assert.deepEqual(
        discovery.explicitOnly.map((s) => s.name),
        ['poteto-mode'],
      );
    } finally {
      await cleanup(fakeHome, workspace);
    }
  });
});

describe('Reproducible update lifecycle: diff, stage, validate, approve, atomic publish, rollback', () => {
  it('stages, approves, atomically publishes for both AGY & OMP, and rolls back cleanly', async () => {
    const work = await tempDir('lifecycle');
    const stateDir = join(work, 'state');
    const lockPath = join(work, 'skills.lock.json');
    const registryPath = join(work, 'skills.registry.json');
    const { roots, dirs } = await createAllProviderCheckouts();

    try {
      // Seed initial pinned lock + registry from the fresh git checkouts.
      const initialChecked = await checkSources(emptyLock(), roots, { write: true });
      await writeLock(lockPath, initialChecked.lock);
      const baseRegistry = await readRegistry(defaultRegistryPath());
      for (const provider of PROVIDER_IDS) {
        baseRegistry.providers[provider].commit = initialChecked.lock.providers[provider].commit;
      }
      await writeRegistry(registryPath, baseRegistry);

      const originalCommit = initialChecked.lock.providers.matt.commit;
      const originalHash = initialChecked.lock.providers.matt.skills['matt:tdd']?.sha256;

      // Upstream changes: edit matt:tdd, add a new upstream skill, and add an unexecuted script.
      await writeSkillFile(roots.matt, 'matt:tdd', FRONTMATTER_BODY('tdd', 'updated tdd body v2'));
      const newSkillDir = join(roots.matt, PROVIDERS.matt.rootSubpath, 'brand-new-skill');
      await mkdir(newSkillDir, { recursive: true });
      await writeFile(join(newSkillDir, 'SKILL.md'), FRONTMATTER_BODY('brand-new-skill', 'new'));
      const scriptDir = join(roots.matt, PROVIDERS.matt.rootSubpath, 'tdd', 'scripts');
      const sentinel = join(work, 'script-was-executed');
      await mkdir(scriptDir, { recursive: true });
      await writeFile(join(scriptDir, 'hook.sh'), `#!/bin/sh\ntouch ${sentinel}\n`);
      await git(roots.matt, 'add', '-f', '-A');
      await git(roots.matt, 'commit', '-q', '-m', 'upstream v2');
      const updatedCommit = await git(roots.matt, 'rev-parse', 'HEAD');

      // 1. Stage update (validates dependencies + AGY + OMP without mutating live lock/registry).
      const { staged } = await stageSkillUpdate({
        roots,
        lockPath,
        registryPath,
        stateDir,
      });
      assert.equal(staged.status, 'staged');
      assert.equal(staged.validation.ok, true);
      assert.equal(staged.validation.runtimes.agy.ok, true);
      assert.equal(staged.validation.runtimes.omp.ok, true);
      assert.equal(staged.diff.hasUpdates, true);
      const mattDiff = staged.diff.providers.find((p) => p.provider === 'matt');
      assert.ok(mattDiff);
      assert.equal(mattDiff.commitChanged, true);
      assert.equal(mattDiff.changed.length, 1);
      assert.equal(mattDiff.changed[0]?.id, 'matt:tdd');
      assert.ok(mattDiff.added.includes('brand-new-skill/SKILL.md'));
      assert.ok(
        mattDiff.findings.some((f) => f.code === 'UPSTREAM_SCRIPT_DETECTED'),
        'flags upstream script for manual review',
      );
      assert.equal(existsSync(sentinel), false, 'upstream script must NEVER be executed');

      // Live lock must still be untouched prior to explicit approval.
      assert.equal((await readLock(lockPath)).providers.matt.commit, originalCommit);

      // 2. Unapproved publish is rejected.
      await assert.rejects(
        publishStagedUpdate({
          stageId: staged.stageId,
          approve: false,
          lockPath,
          registryPath,
          stateDir,
        }),
        (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_INPUT',
      );

      // 3. Approved publish atomically updates BOTH lockfile & registry while preserving local adaptations.
      const { snapshot } = await publishStagedUpdate({
        stageId: staged.stageId,
        approve: true,
        lockPath,
        registryPath,
        stateDir,
      });
      const publishedLock = await readLock(lockPath);
      const publishedRegistry = await readRegistry(registryPath);
      assert.equal(publishedLock.providers.matt.commit, updatedCommit);
      assert.equal(publishedRegistry.providers.matt.commit, updatedCommit);
      assert.notEqual(publishedLock.providers.matt.skills['matt:tdd']?.sha256, originalHash);
      assert.equal(
        publishedRegistry.packs['poteto-mode'].activation,
        'opt-in',
        'local KSD opt-in adaptation preserved',
      );
      assert.deepEqual(await validateRegistryConsistency(publishedRegistry, publishedLock), []);

      // 4. Atomic rollback restores exact previous lockfile and registry.
      const restored = await rollbackSkillUpdate({
        releaseId: snapshot.releaseId,
        lockPath,
        registryPath,
        stateDir,
      });
      assert.equal(restored.restoredFrom, snapshot.releaseId);
      assert.equal((await readLock(lockPath)).providers.matt.commit, originalCommit);
      assert.equal((await readRegistry(registryPath)).providers.matt.commit, originalCommit);
      assert.equal(
        (await readLock(lockPath)).providers.matt.skills['matt:tdd']?.sha256,
        originalHash,
      );
    } finally {
      await cleanup(work, ...dirs);
    }
  });

  it('detects renames, removed dependencies, and poteto-mode opt-in breakage and blocks publishing', async () => {
    const work = await tempDir('breaking');
    const stateDir = join(work, 'state');
    const lockPath = join(work, 'skills.lock.json');
    const registryPath = join(work, 'skills.registry.json');
    const { roots, dirs } = await createAllProviderCheckouts();

    try {
      const initial = await checkSources(emptyLock(), roots, { write: true });
      await writeLock(lockPath, initial.lock);
      const baseRegistry = await readRegistry(defaultRegistryPath());
      for (const provider of PROVIDER_IDS) {
        baseRegistry.providers[provider].commit = initial.lock.providers[provider].commit;
      }
      await writeRegistry(registryPath, baseRegistry);

      // Simulate upstream rename of matt:tdd -> matt:tdd-v2 (identical bytes).
      const oldPath = skillPath(roots.matt, 'matt:tdd');
      const oldBytes = await readFile(oldPath);
      await rm(join(roots.matt, PROVIDERS.matt.rootSubpath, 'tdd'), {
        recursive: true,
        force: true,
      });
      const renamedDir = join(roots.matt, PROVIDERS.matt.rootSubpath, 'tdd-v2');
      await mkdir(renamedDir, { recursive: true });
      await writeFile(join(renamedDir, 'SKILL.md'), oldBytes);
      await git(roots.matt, 'add', '-f', '-A');
      await git(roots.matt, 'commit', '-q', '-m', 'rename tdd');

      // Simulate upstream poteto-mode dropping disable-model-invocation: true.
      const potetoFile = join(
        roots.poteto,
        PROVIDERS.poteto.rootSubpath,
        'poteto-mode',
        'SKILL.md',
      );
      await writeFile(potetoFile, '---\nname: poteto-mode\ndescription: auto now\n---\nbody\n');
      await git(roots.poteto, 'add', '-f', '-A');
      await git(roots.poteto, 'commit', '-q', '-m', 'break opt-in');

      const check = await checkUpstreamUpdates({ roots, lockPath, registryPath });
      const mattDiff = check.providers.find((p) => p.provider === 'matt');
      assert.ok(mattDiff);
      assert.ok(mattDiff.removed.includes(catalog['matt:tdd'].path));
      assert.ok(
        mattDiff.renamed.some(
          (r) => r.fromPath === 'tdd/SKILL.md' && r.toPath === 'tdd-v2/SKILL.md',
        ),
        'hash-matched rename detected',
      );
      const codes = new Set(check.blockingFindings.map((f) => f.code));
      assert.ok(codes.has('BREAKING_DEPENDENCY_REMOVED'));
      assert.ok(codes.has('AUTO_OPT_IN_VIOLATION'));

      const { staged } = await stageSkillUpdate({ roots, lockPath, registryPath, stateDir });
      assert.equal(staged.status, 'blocked');
      assert.equal(staged.validation.ok, false);

      await assert.rejects(
        publishStagedUpdate({
          stageId: staged.stageId,
          approve: true,
          lockPath,
          registryPath,
          stateDir,
        }),
        /blocked/,
      );
    } finally {
      await cleanup(work, ...dirs);
    }
  });

  it('real CLI subcommands `skills diff`, `skills sync`, `skills publish`, `skills rollback` work end-to-end', async () => {
    const work = await tempDir('cli-lifecycle');
    const stateDir = join(work, 'state');
    const lockPath = join(work, 'skills.lock.json');
    const registryPath = join(work, 'skills.registry.json');
    const { roots, dirs } = await createAllProviderCheckouts();

    try {
      const initial = await checkSources(emptyLock(), roots, { write: true });
      await writeLock(lockPath, initial.lock);
      const baseRegistry = await readRegistry(defaultRegistryPath());
      for (const provider of PROVIDER_IDS) {
        baseRegistry.providers[provider].commit = initial.lock.providers[provider].commit;
      }
      await writeRegistry(registryPath, baseRegistry);

      await writeSkillFile(
        roots.osmani,
        'osmani:shipping-and-launch',
        FRONTMATTER_BODY('ship', 'v2'),
      );
      await git(roots.osmani, 'add', '-f', '-A');
      await git(roots.osmani, 'commit', '-q', '-m', 'osmani v2');

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        EI_MATT_ROOT: roots.matt,
        EI_POTETO_ROOT: roots.poteto,
        EI_OSMANI_ROOT: roots.osmani,
      };
      const common = ['--lock', lockPath, '--registry', registryPath];

      const diffOut = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, 'skills', 'diff', ...common, '--json'],
        { env },
      );
      const diffJson = JSON.parse(diffOut.stdout) as {
        hasUpdates: boolean;
        blockingFindings: unknown[];
      };
      assert.equal(diffJson.hasUpdates, true);
      assert.equal(diffJson.blockingFindings.length, 0);

      const syncOut = await execFileAsync(
        process.execPath,
        [CLI_ENTRY, 'skills', 'sync', ...common, '--state-dir', stateDir, '--json'],
        { env },
      );
      const syncJson = JSON.parse(syncOut.stdout) as {
        staged: { stageId: string; status: string };
      };
      assert.equal(syncJson.staged.status, 'staged');

      await execFileAsync(
        process.execPath,
        [
          CLI_ENTRY,
          'skills',
          'publish',
          '--stage-id',
          syncJson.staged.stageId,
          '--approve',
          ...common,
          '--state-dir',
          stateDir,
        ],
        { env },
      );
      const newHead = await git(roots.osmani, 'rev-parse', 'HEAD');
      assert.equal((await readLock(lockPath)).providers.osmani.commit, newHead);

      await execFileAsync(
        process.execPath,
        [CLI_ENTRY, 'skills', 'rollback', ...common, '--state-dir', stateDir],
        { env },
      );
      assert.equal(
        (await readLock(lockPath)).providers.osmani.commit,
        initial.lock.providers.osmani.commit,
      );
    } finally {
      await cleanup(work, ...dirs);
    }
  });

  it('missing provider roots fail cleanly during diff without mutating anything', async () => {
    const missingRoots: ProviderRoots = {};
    const check = await checkUpstreamUpdates({ roots: missingRoots });
    assert.equal(check.blockingFindings.length, 3);
    assert.ok(check.blockingFindings.every((f) => f.code === 'PROVIDER_UNAVAILABLE'));
  });
});
