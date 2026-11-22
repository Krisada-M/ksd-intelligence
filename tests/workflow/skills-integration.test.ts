import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildAgySkillsConfig, discoverAgySkills } from '../../src/adapters/agy/skills.js';
import extension, { type OmpExtensionApi } from '../../src/adapters/omp/extension.js';
import { discoverOmpSkills } from '../../src/adapters/omp/skills.js';
import { loadPackSkill, prepareWorkflow } from '../../src/workflow/loader.js';
import {
  SKILL_PACKS,
  defaultSkillsDir,
  discoverSkillsForPlatform,
  listSkillPacks,
  parseSkillFrontmatter,
} from '../../src/workflow/packs.js';
import { PRECEDENCE_HEADER, renderWorkflow } from '../../src/workflow/render.js';
import { routeTask } from '../../src/workflow/router.js';
import {
  CATALOG_SKILL_NAMES,
  COMPLIANCE_DIMENSIONS,
  ORCHESTRATOR_SKILL_ID,
  SKILL_PACK_IDS,
  WorkflowError,
} from '../../src/workflow/types.js';
import { FRONTMATTER_BODY, cleanup, emptyLock, tempDir, writeSkillFile } from './fixtures.js';

const execFileAsync = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL('../../../dist/adapters/cli/main.js', import.meta.url));

async function writeCatalogSkill(
  root: string,
  dirName: string,
  frontmatterLines: string[],
  body: string,
): Promise<string> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  await writeFile(file, `---\n${frontmatterLines.join('\n')}\n---\n\n${body}\n`);
  return file;
}

describe('KSD platform-agnostic skill catalog', () => {
  it('parses plain indented multiline YAML frontmatter descriptions without consuming nested mappings', () => {
    const parsed = parseSkillFrontmatter(
      [
        '---',
        'name: example-skill',
        'description:',
        '  First line of description',
        '  and second line.',
        'metadata:',
        '  author: someone',
        '---',
        '# Body',
      ].join('\n'),
    );
    assert.equal(parsed?.name, 'example-skill');
    assert.equal(parsed?.description, 'First line of description and second line.');
  });

  it('registers all four engineering packs with upstream attribution and opt-in poteto-mode', () => {
    const packs = listSkillPacks();
    assert.deepEqual(
      packs.map((pack) => pack.id),
      [...SKILL_PACK_IDS],
    );
    assert.equal(SKILL_PACKS['poteto-mode'].activation, 'opt-in');
    assert.equal(SKILL_PACKS['poteto-mode'].disableModelInvocation, true);
    assert.deepEqual(SKILL_PACKS['poteto-mode'].allowlistedLeafSkills, []);
    assert.deepEqual(
      listSkillPacks({ includeOptIn: false }).map((pack) => pack.id),
      ['matt-sdlc', 'pstack-analysis', 'osmani-quality'],
    );
    for (const pack of packs) {
      assert.match(pack.upstream.repo, /^https:\/\/github\.com\//);
      assert.equal(pack.upstream.license, 'MIT');
      assert.ok(pack.upstream.skills.length > 0, `${pack.id} lists upstream references`);
      assert.ok(!pack.skillFile.startsWith('/'), `${pack.id} skillFile is repo-relative`);
    }
  });

  it('discovers bundled catalog cleanly for both AGY and OMP with zero audit issues', async () => {
    const agy = await discoverAgySkills();
    const omp = await discoverOmpSkills();

    for (const result of [agy, omp]) {
      assert.deepEqual(result.issues, [], `${result.platform} catalog must have no audit issues`);
      assert.deepEqual(
        result.skills.map((skill) => skill.name).sort(),
        [...CATALOG_SKILL_NAMES].sort(),
      );
      assert.deepEqual(
        result.explicitOnly.map((skill) => skill.name),
        ['poteto-mode'],
        `${result.platform}: poteto-mode must be explicit opt-in only`,
      );
      assert.ok(
        !result.autoVisible.some((skill) => skill.name === 'poteto-mode'),
        `${result.platform}: poteto-mode must not appear in autoVisible`,
      );
    }
  });

  it('AGY adapter honors workspace precedence, skills.json entries, and preserves user overrides', async () => {
    const workspace = await tempDir('agy-ws');
    const userDir = await tempDir('agy-user');
    const sharedDir = await tempDir('agy-shared');
    try {
      await writeCatalogSkill(
        join(workspace, '.agents', 'skills'),
        'matt-sdlc',
        ['name: matt-sdlc', 'description: Workspace customized Matt SDLC'],
        'Workspace override body',
      );
      await writeCatalogSkill(
        userDir,
        'osmani-quality',
        ['name: osmani-quality', 'description: User customized Osmani quality'],
        'User override body',
      );
      await writeCatalogSkill(
        sharedDir,
        'team-lint',
        ['name: team-lint', 'description: Shared team lint workflow'],
        'Shared skill body',
      );
      await writeCatalogSkill(
        sharedDir,
        'excluded-exp',
        ['name: excluded-exp', 'description: Experimental skill'],
        'Excluded skill body',
      );

      const cfg = buildAgySkillsConfig({
        workspaceRoot: workspace,
        skillsDir: sharedDir,
        exclude: ['excluded-.*'],
      });
      assert.ok(!cfg.entries[0]?.path.includes('/home/'), 'config must not embed user home');
      await mkdir(join(workspace, '.agents'), { recursive: true });
      await writeFile(join(workspace, '.agents', 'skills.json'), JSON.stringify(cfg, null, 2));

      const result = await discoverAgySkills({
        workspaceRoot: workspace,
        userSkillsDir: userDir,
      });

      assert.deepEqual(result.issues, []);
      const byName = new Map(result.skills.map((skill) => [skill.name, skill]));
      assert.equal(byName.get('matt-sdlc')?.sourceLabel, 'agy:workspace');
      assert.equal(byName.get('osmani-quality')?.sourceLabel, 'agy:user');
      assert.equal(byName.get('pstack-analysis')?.sourceLabel, 'ksd:catalog');
      assert.equal(byName.get('team-lint')?.name, 'team-lint');
      assert.equal(byName.has('excluded-exp'), false);
      assert.ok(
        result.shadowed.some(
          (entry) => entry.name === 'matt-sdlc' && entry.keptFrom === 'agy:workspace',
        ),
      );
      assert.ok(
        result.shadowed.some(
          (entry) => entry.name === 'osmani-quality' && entry.keptFrom === 'agy:user',
        ),
      );
    } finally {
      await cleanup(workspace, userDir, sharedDir);
    }
  });

  it('OMP adapter honors project and user precedence over marketplace plugin skills', async () => {
    const workspace = await tempDir('omp-ws');
    const userDir = await tempDir('omp-user');
    try {
      await writeCatalogSkill(
        join(workspace, '.omp', 'skills'),
        'pstack-analysis',
        ['name: pstack-analysis', 'description: Project pstack override'],
        'Project override',
      );
      await writeCatalogSkill(
        userDir,
        'matt-sdlc',
        ['name: matt-sdlc', 'description: User matt override'],
        'User override',
      );

      const result = await discoverOmpSkills({
        workspaceRoot: workspace,
        userSkillsDir: userDir,
      });

      assert.deepEqual(result.issues, []);
      const byName = new Map(result.skills.map((skill) => [skill.name, skill]));
      assert.equal(byName.get('pstack-analysis')?.sourceLabel, 'omp:project');
      assert.equal(byName.get('matt-sdlc')?.sourceLabel, 'omp:user');
      assert.equal(byName.get('osmani-quality')?.sourceLabel, 'omp:plugin:ksd-intelligence');
      assert.deepEqual(
        result.explicitOnly.map((skill) => skill.name),
        ['poteto-mode'],
      );
    } finally {
      await cleanup(workspace, userDir);
    }
  });
});

describe('KSD skill routing scenarios & opt-in enforcement', () => {
  it('routes implementation to matt-sdlc as single primary owner', () => {
    const route = routeTask({
      task: 'implement checkout discount calculator',
      stage: 'implement',
    });
    assert.equal(route.orchestrator, ORCHESTRATOR_SKILL_ID);
    assert.equal(route.primaryPack, 'matt-sdlc');
    assert.deepEqual(route.skillIds, ['matt:tdd']);
    assert.deepEqual(route.secondaryPacks, []);
    assert.deepEqual(route.optInPacks, []);
  });

  it('routes debugging to matt-sdlc without recursive orchestration', () => {
    const route = routeTask({
      task: 'debug payment webhook race condition',
      stage: 'investigate',
    });
    assert.equal(route.type, 'bug');
    assert.equal(route.primaryPack, 'matt-sdlc');
    assert.deepEqual(route.skillIds, ['matt:diagnosing-bugs']);
    assert.deepEqual(route.secondaryPacks, []);
    assert.deepEqual(route.optInPacks, []);
  });

  it('routes REQ mismatch review with REQ × Code × Test × Runtime Evidence compliance gate', () => {
    const featureReq = routeTask({
      task: 'audit REQ mismatch against checkout spec',
      stage: 'review',
    });
    assert.equal(featureReq.primaryPack, 'matt-sdlc');
    assert.deepEqual(featureReq.skillIds, ['matt:code-review']);
    assert.equal(featureReq.requirementCompliance.required, true);
    assert.equal(featureReq.requirementCompliance.trigger, 'keyword');
    assert.deepEqual(featureReq.requirementCompliance.dimensions, COMPLIANCE_DIMENSIONS);

    const bugReq = routeTask({
      task: 'fix REQ mismatch: order total ignores coupon cap',
      stage: 'review',
    });
    assert.equal(bugReq.primaryPack, 'pstack-analysis');
    assert.deepEqual(bugReq.skillIds, ['poteto:blast-radius', 'matt:code-review']);
    assert.deepEqual(bugReq.secondaryPacks, ['matt-sdlc']);
    assert.equal(bugReq.secondaryReasons['matt-sdlc'], 'requirement-compliance');
    assert.equal(bugReq.requirementCompliance.required, true);
  });

  it('routes UI verification to osmani-quality browser verification', () => {
    const route = routeTask({
      task: 'verify checkout modal UI layout responsiveness',
      stage: 'verify',
    });
    assert.equal(route.type, 'ui');
    assert.equal(route.primaryPack, 'osmani-quality');
    assert.deepEqual(route.skillIds, ['osmani:browser-testing-with-devtools']);
    assert.equal(route.requirementCompliance.required, true);
  });

  it('routes architecture review to pstack-analysis', () => {
    const route = routeTask({
      task: 'review architecture of billing service boundaries',
      stage: 'review',
    });
    assert.equal(route.type, 'refactor');
    assert.equal(route.primaryPack, 'pstack-analysis');
    assert.deepEqual(route.skillIds, ['poteto:blast-radius']);
    assert.equal(route.requirementCompliance.required, true);
  });

  it('never enables poteto-mode automatically even when task mentions it', () => {
    const route = routeTask({
      task: 'run poteto-mode multi-phase architecture refactor',
      stage: 'investigate',
    });
    assert.equal(route.orchestrator, ORCHESTRATOR_SKILL_ID);
    assert.equal(route.primaryPack, 'pstack-analysis');
    assert.deepEqual(route.optInPacks, []);
    assert.ok(!route.secondaryPacks.includes('poteto-mode'));
  });

  it('activates poteto-mode only via explicit opt-in while keeping KSD primary', async () => {
    const root = await tempDir('poteto-optin');
    try {
      await writeSkillFile(root, 'poteto:how', FRONTMATTER_BODY('how', 'HOW_BODY'));
      const workflow = await prepareWorkflow({
        task: 'multi-phase billing architecture migration',
        stage: 'investigate',
        potetoMode: true,
        roots: { poteto: root },
        lock: emptyLock(),
        strict: true,
      });

      assert.equal(workflow.orchestrator, ORCHESTRATOR_SKILL_ID);
      assert.equal(workflow.primaryPack, 'pstack-analysis');
      assert.deepEqual(workflow.optInPacks, ['poteto-mode']);
      assert.deepEqual(workflow.secondaryPacks, ['poteto-mode']);
      assert.equal(workflow.secondaryReasons['poteto-mode'], 'explicit-opt-in');
      assert.equal(workflow.packInstructions.length, 1);
      assert.equal(workflow.packInstructions[0]?.id, 'poteto-mode');
      assert.equal(workflow.mayMerge, false);
      assert.equal(workflow.mayDeploy, false);

      const rendered = renderWorkflow(workflow);
      assert.ok(rendered.startsWith(PRECEDENCE_HEADER));
      assert.match(rendered, /Orchestrator: ksd-intelligence/);
      assert.match(rendered, /Primary Pack: pstack-analysis/);
      assert.match(rendered, /Opt-In Modes: poteto-mode/);
      assert.match(rendered, /# Opt-in pack invoked: poteto-mode/);
    } finally {
      await cleanup(root);
    }
  });
});

describe('Skill safety audit: missing deps, duplicates, incompatible calls, recursion', () => {
  it('detects missing catalog skills, duplicates, home paths, opt-in violations, incompatible calls, recursion, and path escape', async () => {
    const badRoot = await tempDir('bad-skills');
    const outside = await tempDir('outside-skills');
    try {
      // Missing disable-model-invocation on poteto-mode + hardcoded home path + Cursor directive.
      await writeCatalogSkill(
        badRoot,
        'poteto-mode',
        ['name: poteto-mode', 'description: Broken poteto mode'],
        'Use /home/alice/skills and subagent_type: "poteto-agent" with claude-opus-5-5-xhigh-fast and AskQuestion.',
      );

      // Duplicate frontmatter name across two folders inside the same root + recursive directive.
      await writeCatalogSkill(
        badRoot,
        'dup-a',
        ['name: custom-dup', 'description: First copy'],
        'Automatically start swarm and enable ask-matt on every task.',
      );
      await writeCatalogSkill(
        badRoot,
        'dup-b',
        ['name: custom-dup', 'description: Second copy'],
        'Second copy body.',
      );

      // Symlink escaping the scanned skills directory.
      const escapedTarget = resolve(outside, 'SKILL.md');
      await writeFile(escapedTarget, FRONTMATTER_BODY('escaped', 'outside'));
      await mkdir(join(badRoot, 'escaped-skill'), { recursive: true });
      await symlink(escapedTarget, join(badRoot, 'escaped-skill', 'SKILL.md'));

      const report = await discoverSkillsForPlatform({
        platform: 'agy',
        roots: [{ path: badRoot, label: 'test:bad' }],
        requireCatalog: true,
      });

      const codes = new Set(report.issues.map((issue) => issue.code));
      assert.ok(codes.has('MISSING_CATALOG_SKILL'), 'flags missing catalog skills');
      assert.ok(
        codes.has('AUTO_OPT_IN_VIOLATION'),
        'flags poteto-mode without disable-model-invocation',
      );
      assert.ok(codes.has('USER_HOME_PATH'), 'flags hardcoded user-home path');
      assert.ok(codes.has('INCOMPATIBLE_TOOL_CALL'), 'flags Cursor-only directives');
      assert.ok(codes.has('DUPLICATE_SKILL'), 'flags duplicate skill names in root');
      assert.ok(codes.has('RECURSIVE_ORCHESTRATION'), 'flags recursive router activation');
      assert.ok(codes.has('PATH_ESCAPE'), 'flags symlink escaping root');

      await assert.rejects(
        loadPackSkill('poteto-mode', badRoot),
        (error: unknown) => error instanceof WorkflowError && error.code === 'INVALID_SKILL',
      );
    } finally {
      await cleanup(badRoot, outside);
    }
  });
});

describe('Adapter & CLI verification (MOCK-ONLY OMP + real Node CLI subprocess)', () => {
  it('MOCK-ONLY OMP extension supports explicit potetoMode opt-in without breaking default details', async () => {
    const dir = await tempDir('omp-optin');
    const root = await tempDir('omp-matt');
    try {
      const lockPath = join(dir, 'skills.lock.json');
      await writeFile(lockPath, JSON.stringify(emptyLock()));
      await writeSkillFile(root, 'matt:tdd', FRONTMATTER_BODY('tdd', 'TDD_BODY'));

      const registered: Parameters<OmpExtensionApi['registerTool']>[0][] = [];
      const self = {
        optional: () => self,
        describe: () => self,
        int: () => self,
        min: () => self,
        max: () => self,
      };
      const pi: OmpExtensionApi = {
        zod: {
          string: () => self,
          boolean: () => self,
          number: () => self,
          array: () => self,
          enum: () => self,
          object: () => self,
        },
        registerTool: (tool) => {
          registered.push(tool);
        },
      };

      extension(pi, {
        env: { EI_MATT_ROOT: root },
        lockPath,
        skillsDir: defaultSkillsDir(),
        createPolicyExtension: () => {},
      });

      const result = await registered[0]?.execute(
        'call-1',
        { task: 'implement multi-phase billing engine', stage: 'implement', potetoMode: true },
        undefined,
      );
      assert.equal(result?.isError, undefined);
      assert.match(result?.content[0]?.text ?? '', /Opt-In Modes: poteto-mode/);
      assert.match(result?.content[0]?.text ?? '', /# Opt-in pack invoked: poteto-mode/);
      assert.deepEqual(result?.details, {
        type: 'feature',
        classifiedBy: 'default',
        stage: 'implement',
        skillIds: ['matt:tdd'],
        ready: true,
        optInPacks: ['poteto-mode'],
      });
    } finally {
      await cleanup(dir, root);
    }
  });

  it('real CLI `ei skills check` passes for both agy and omp and `ei route --poteto-mode` works', async () => {
    const agyCheck = await execFileAsync(process.execPath, [
      CLI_ENTRY,
      'skills',
      'check',
      '--platform',
      'agy',
      '--json',
    ]);
    const agyParsed = JSON.parse(agyCheck.stdout) as {
      platform: string;
      skills: { name: string }[];
      explicitOnly: { name: string }[];
      issues: unknown[];
    };
    assert.equal(agyParsed.platform, 'agy');
    assert.equal(agyParsed.issues.length, 0);
    assert.deepEqual(
      agyParsed.explicitOnly.map((s) => s.name),
      ['poteto-mode'],
    );

    const ompCheck = await execFileAsync(process.execPath, [
      CLI_ENTRY,
      'skills',
      'check',
      '--platform',
      'omp',
      '--json',
    ]);
    const ompParsed = JSON.parse(ompCheck.stdout) as {
      platform: string;
      issues: unknown[];
      explicitOnly: { name: string }[];
    };
    assert.equal(ompParsed.platform, 'omp');
    assert.equal(ompParsed.issues.length, 0);
    assert.deepEqual(
      ompParsed.explicitOnly.map((s) => s.name),
      ['poteto-mode'],
    );

    const routed = await execFileAsync(process.execPath, [
      CLI_ENTRY,
      'route',
      '--task',
      'audit REQ mismatch on checkout',
      '--stage',
      'review',
      '--poteto-mode',
    ]);
    const routeJson = JSON.parse(routed.stdout) as {
      orchestrator: string;
      primaryPack: string;
      optInPacks: string[];
      requirementCompliance: { required: boolean; dimensions: string[] };
    };
    assert.equal(routeJson.orchestrator, 'ksd-intelligence');
    assert.equal(routeJson.primaryPack, 'matt-sdlc');
    assert.deepEqual(routeJson.optInPacks, ['poteto-mode']);
    assert.equal(routeJson.requirementCompliance.required, true);
    assert.deepEqual(routeJson.requirementCompliance.dimensions, [...COMPLIANCE_DIMENSIONS]);
  });
});
