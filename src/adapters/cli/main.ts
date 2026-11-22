#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  auditFieldsForChanges,
  auditFieldsForImpact,
  auditFieldsForSearch,
  auditFieldsForWorkflow,
  clearAuditState,
  consumeAuditWarning,
  parseSince,
  recordAudit,
  renderAuditSummary,
  summarizeAudit,
} from '../../core/audit/index.js';
import { buildIndex, doctorDeep } from '../../core/engine/build.js';
import { isHolderAlive, readLockHolder } from '../../core/engine/lock.js';
import { homeRelative, renderStatus, workspaceStatus } from '../../core/engine/status.js';
import {
  checkTypescriptRuntime,
  engineVersion,
  pinnedTypescriptVersion,
  setupTypescriptRuntime,
} from '../../core/engine/typescript.js';
import { loadWorkspace, resolveWorkspaceCache } from '../../core/engine/workspace.js';
import { runChanges } from '../../core/changes/changes.js';
import { renderChangesOutcome } from '../../core/changes/render.js';
import { impactDetails, renderImpact } from '../../core/impact/render.js';
import { ImpactSession } from '../../core/impact/session.js';
import { runSearch, validateSearchInput } from '../../core/search/lexical.js';
import { renderSearchOutcome } from '../../core/search/render.js';
import { initProject } from '../../core/workspace/init.js';
import { discoverAgySkills } from '../agy/skills.js';
import { discoverOmpSkills } from '../omp/skills.js';
import { rootsFromEnv } from '../../workflow/catalog.js';
import { prepareWorkflow } from '../../workflow/loader.js';
import { listSkillPacks, type SkillPlatform } from '../../workflow/packs.js';
import {
  defaultRegistryPath,
  readRegistry,
  validateRegistryConsistency,
} from '../../workflow/registry.js';
import { renderWorkflow } from '../../workflow/render.js';
import { routeTask } from '../../workflow/router.js';
import {
  checkUpstreamUpdates,
  publishStagedUpdate,
  rollbackSkillUpdate,
  stageSkillUpdate,
} from '../../workflow/updates.js';
import {
  checkSources,
  defaultLockPath,
  formatReports,
  readLock,
  reportStatus,
  writeLock,
} from '../../workflow/sources.js';
import { WorkflowError } from '../../workflow/types.js';

function doctorPassed(report: Record<string, unknown>): boolean {
  const differences = report.differences;
  const count =
    typeof differences === 'object' && differences !== null && 'count' in differences
      ? differences.count
      : 1;
  const differential = report.differential;
  const misses =
    typeof differential === 'object' &&
    differential !== null &&
    'misses' in differential &&
    Array.isArray(differential.misses)
      ? differential.misses.length
      : 0;
  return count === 0 && misses === 0;
}

function counterNote(report: Record<string, unknown>): string {
  const counters = report.counterDifferences;
  const count =
    typeof counters === 'object' && counters !== null && 'count' in counters ? counters.count : 0;
  return typeof count === 'number' && count > 0
    ? `INFO ${count} files have use counters that differ from the cold rebuild (statistics only, not a failure: TypeScript infers lazily, so they depend on checking order)`
    : '';
}

function renderDoctor(report: Record<string, unknown>): string {
  return [
    doctorPassed(report) ? 'DOCTOR ok' : 'DOCTOR differences found',
    counterNote(report),
    JSON.stringify(
      {
        differences: report.differences,
        counterDifferences: report.counterDifferences,
        differential: report.differential,
      },
      null,
      2,
    ),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

const USAGE = `usage:
  main.js init    [--root <path>] [--force] [--dry-run] [--json]
  main.js setup   [--check]                       (installs the pinned TypeScript runtime; --check only verifies)
  main.js index   [--root <path>] [--full] [--json] (update the index from the working tree; --full rebuilds cold)
  main.js impact  <target…> [--depth <n>] [--root <path>] [--json] (who depends on 1–5 targets)
  main.js changes [--base <ref>] [--depth <n>] [--planned <target>]... [--root <path>] [--json] (impact of uncommitted changes)
  main.js search  <query> [--limit <n>] [--root <path>] [--json] (find declarations by words or identifier)
  main.js doctor  --deep [--root <path>] [--differential <n|all>] [--json]  (cold rebuild diffed against the index)
  main.js status  [--root <path>] [--json]        (index, coverage, runtime, TypeScript, store, lock)
  main.js audit   [--since <7d|24h|30m|ISO>] [--root <path>] [--json] (summarize audit.jsonl)
  main.js cache   clear [--root <path>] [--json]  (remove index and audit cache for this repository)
  main.js route   --task "..." [--stage plan|investigate|implement|verify|review|ship] [--risk normal|high] [--type bug|feature|refactor|security|performance|ui] [--poteto-mode]
  main.js load    --task "..." [same options]     (needs checkouts; fails closed)
  main.js skills  list|check [--platform agy|omp] [--root <path>] [--profile <name>] [--detect-host] [--json]
  main.js skills  diff [--lock <path>] [--registry <path>] [--json]
  main.js skills  sync [--stage] [--state-dir <path>] [--lock <path>] [--registry <path>] [--json]
  main.js skills  publish --stage-id <id> --approve [--state-dir <path>] [--lock <path>] [--registry <path>] [--json]
  main.js skills  rollback [--release <id>] [--state-dir <path>] [--lock <path>] [--registry <path>] [--json]
  main.js sources check [--write] [--lock <path>] (never clones or fetches)
  main.js mcp     --root <path> [--workflow]      (local stdio MCP server for Antigravity)`;

async function tryResolveCacheCli(
  root: string | undefined,
): Promise<{ root: string; cacheDir: string } | null> {
  try {
    const info = await resolveWorkspaceCache(root ?? process.cwd());
    return { root: info.root, cacheDir: info.cacheDir };
  } catch {
    return null;
  }
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      task: { type: 'string' },
      stage: { type: 'string' },
      risk: { type: 'string' },
      type: { type: 'string' },
      'poteto-mode': { type: 'boolean' },
      platform: { type: 'string' },
      profile: { type: 'string' },
      'detect-host': { type: 'boolean' },
      registry: { type: 'string' },
      'state-dir': { type: 'string' },
      'stage-id': { type: 'string' },
      release: { type: 'string' },
      approve: { type: 'boolean' },
      write: { type: 'boolean' },
      lock: { type: 'string' },
      check: { type: 'boolean' },
      full: { type: 'boolean' },
      deep: { type: 'boolean' },
      differential: { type: 'string' },
      depth: { type: 'string' },
      limit: { type: 'string' },
      base: { type: 'string' },
      planned: { type: 'string', multiple: true },
      since: { type: 'string' },
      workflow: { type: 'boolean' },
    },
  });
  const [command, sub] = positionals;
  const lockPath = values.lock ?? defaultLockPath();
  const registryPath = values.registry ?? defaultRegistryPath();

  if (command === 'setup') {
    const version = pinnedTypescriptVersion();
    // --check only reads files; plain setup is the one command that uses the network (D44).
    const result =
      values.check === true
        ? await checkTypescriptRuntime({ version })
        : await setupTypescriptRuntime({ version });
    if (!result.ok) {
      console.log(`typescript ${version}: degraded (${result.reason}) · ${result.fix}`);
      return 1;
    }
    console.log(
      `typescript ${result.runtime.version}: ready · ${result.runtime.path} · sha256 ${result.sha256}`,
    );
    return 0;
  }

  if (command === 'status') {
    if (process.env.EI_DISABLED === '1') {
      console.log('STATUS disabled (EI_DISABLED)');
      return 0;
    }
    const started = performance.now();
    const status = await workspaceStatus(values.root ?? process.cwd());
    recordAudit(
      status.cacheDir,
      {
        ts: new Date().toISOString(),
        tool: 'ei_status',
        adapter: 'cli',
        outcome: 'result',
        ms: performance.now() - started,
        engine: engineVersion(),
        ...(status.typescript.ok ? { ts_version: status.typescript.runtime.version } : {}),
        statusState: status.state,
      },
      { root: status.root },
    );
    const extraWarning = consumeAuditWarning(status.cacheDir);
    if (extraWarning !== null) status.auditWarning = extraWarning;
    console.log(values.json === true ? JSON.stringify(status, null, 2) : renderStatus(status));
    return status.state === 'ready' ? 0 : 1;
  }

  if (command === 'audit') {
    let sinceMs: number | undefined;
    if (values.since !== undefined) {
      const parsed = parseSince(values.since);
      if (parsed === null) {
        console.error(
          `INVALID_INPUT: invalid --since ${JSON.stringify(values.since)}; expected e.g. 7d, 24h, 30m, or ISO timestamp`,
        );
        return 2;
      }
      sinceMs = parsed;
    }
    const { cacheDir } = await resolveWorkspaceCache(values.root ?? process.cwd());
    const summary = summarizeAudit(cacheDir, {
      ...(sinceMs !== undefined ? { sinceMs, sinceLabel: values.since } : {}),
    });
    console.log(
      values.json === true ? JSON.stringify(summary, null, 2) : renderAuditSummary(summary),
    );
    return 0;
  }

  if (command === 'cache') {
    if (sub !== 'clear') {
      console.error(USAGE);
      return 2;
    }
    const { repoId, cacheDir } = await resolveWorkspaceCache(values.root ?? process.cwd());
    const holder = readLockHolder(cacheDir);
    if (holder !== null && isHolderAlive(holder)) {
      if (values.json === true) {
        console.log(
          JSON.stringify({ cleared: false, locked: true, repoId, pid: holder.pid }, null, 2),
        );
      } else {
        console.error(
          `CACHE LOCKED ${repoId} · build lock held by pid ${holder.pid} since ${holder.startedAt}`,
        );
      }
      return 1;
    }
    const existed = existsSync(cacheDir);
    await rm(cacheDir, { recursive: true, force: true });
    clearAuditState(cacheDir);
    if (values.json === true) {
      console.log(JSON.stringify({ cleared: true, existed, repoId, cacheDir }, null, 2));
    } else {
      console.log(
        existed
          ? `CACHE CLEARED ${repoId} · removed ${homeRelative(cacheDir)}`
          : `CACHE CLEARED ${repoId} · nothing to clear (${homeRelative(cacheDir)})`,
      );
    }
    return 0;
  }

  if (command === 'index') {
    const workspace = await loadWorkspace(values.root ?? process.cwd());
    const started = performance.now();
    const outcome = await buildIndex(workspace, {
      full: values.full === true,
      onProgress: (message) => console.error(`ei index: ${message}`),
    });
    if (!outcome.ok) {
      console.log(`INDEX ${outcome.code}: ${outcome.message} · ${outcome.fix}`);
      return 1;
    }
    if (values.json === true) {
      console.log(JSON.stringify(outcome.value, null, 2));
      return outcome.value.action === 'failed' ? 1 : 0;
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(2);
    const { action, reason } = outcome.value;
    console.log(`INDEX ${String(action)} in ${seconds} s (${String(reason)})`);
    console.log(renderStatus(await workspaceStatus(workspace.root)));
    return action === 'failed' ? 1 : 0;
  }

  if (command === 'impact') {
    const started = performance.now();
    const targets = positionals.slice(1);
    const rawDepth = values.depth;
    const depth = rawDepth === undefined ? undefined : Number.parseInt(rawDepth, 10);
    if (
      targets.length < 1 ||
      targets.length > 5 ||
      (rawDepth !== undefined &&
        (depth === undefined ||
          !Number.isInteger(depth) ||
          String(depth) !== rawDepth.trim() ||
          depth < 1 ||
          depth > 10))
    ) {
      const cache = await tryResolveCacheCli(values.root);
      if (cache !== null) {
        recordAudit(
          cache.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_impact',
            adapter: 'cli',
            outcome: 'failure',
            ms: performance.now() - started,
            engine: engineVersion(),
            code: 'INVALID_INPUT',
            codes: ['INVALID_INPUT'],
            ...(targets.length > 0 ? { targets } : {}),
          },
          { root: cache.root },
        );
      }
      const batch = {
        answers: [
          {
            input: targets[0] ?? '',
            kind: 'failure' as const,
            code: 'INVALID_INPUT' as const,
            message: 'provide 1–5 targets and depth 1–10',
          },
        ],
        index: { state: 'fresh' as const, updatedFiles: 0, driftedFiles: [] },
      };
      console.log(
        values.json === true ? JSON.stringify(batch.answers[0], null, 2) : renderImpact(batch),
      );
      return 2;
    }
    const workspace = await loadWorkspace(values.root ?? process.cwd());
    const session = new ImpactSession(workspace, {
      waitAfterExpiry: true,
      onProgress: (message) => console.error(`ei impact: ${message}`),
    });
    const batch = await session.query(targets, depth);
    recordAudit(
      workspace.cacheDir,
      {
        ts: new Date().toISOString(),
        tool: 'ei_impact',
        adapter: 'cli',
        outcome: 'result',
        ms: performance.now() - started,
        engine: engineVersion(),
        ...auditFieldsForImpact(batch, engineVersion()),
      },
      { root: workspace.root },
    );
    const details = impactDetails(batch);
    if (values.json === true) {
      console.log(JSON.stringify(details.length === 1 ? details[0] : details, null, 2));
    } else {
      console.log(renderImpact(batch));
    }
    return batch.answers.some((answer) => answer.kind === 'failure') ? 1 : 0;
  }

  if (command === 'changes') {
    if (process.env.EI_DISABLED === '1') {
      console.log('CHANGES disabled (EI_DISABLED)');
      return 0;
    }
    const started = performance.now();
    const rawDepth = values.depth;
    const depth = rawDepth === undefined ? undefined : Number.parseInt(rawDepth, 10);
    if (
      rawDepth !== undefined &&
      (depth === undefined ||
        !Number.isInteger(depth) ||
        String(depth) !== rawDepth.trim() ||
        depth < 1 ||
        depth > 10)
    ) {
      const cache = await tryResolveCacheCli(values.root);
      if (cache !== null) {
        recordAudit(
          cache.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_changes',
            adapter: 'cli',
            outcome: 'failure',
            ms: performance.now() - started,
            engine: engineVersion(),
            code: 'INVALID_INPUT',
            codes: ['INVALID_INPUT'],
          },
          { root: cache.root },
        );
      }
      const outcome = {
        kind: 'failure' as const,
        code: 'INVALID_INPUT' as const,
        message: 'depth must be an integer 1–10',
      };
      console.log(
        values.json === true ? JSON.stringify(outcome, null, 2) : renderChangesOutcome(outcome),
      );
      return 2;
    }
    const workspace = await loadWorkspace(values.root ?? process.cwd());
    const session = new ImpactSession(workspace, {
      waitAfterExpiry: true,
      onProgress: (message) => console.error(`ei changes: ${message}`),
    });
    const outcome = await runChanges(session, {
      base: values.base,
      depth,
      planned: values.planned,
    });
    recordAudit(
      workspace.cacheDir,
      {
        ts: new Date().toISOString(),
        tool: 'ei_changes',
        adapter: 'cli',
        outcome: outcome.kind,
        ms: performance.now() - started,
        engine: engineVersion(),
        ...auditFieldsForChanges(outcome, engineVersion()),
      },
      { root: workspace.root },
    );
    const rendered = renderChangesOutcome(outcome);
    if (values.json === true) {
      console.log(JSON.stringify(outcome.kind === 'result' ? outcome.value : outcome, null, 2));
    } else {
      console.log(rendered);
    }
    return outcome.kind === 'failure' ? 1 : 0;
  }

  if (command === 'search') {
    if (process.env.EI_DISABLED === '1') {
      console.log('SEARCH disabled (EI_DISABLED)');
      return 0;
    }
    const started = performance.now();
    const rawLimit = values.limit;
    const parsedLimit =
      rawLimit === undefined
        ? undefined
        : /^\d+$/.test(rawLimit.trim())
          ? Number.parseInt(rawLimit.trim(), 10)
          : Number.NaN;
    const query = positionals.slice(1).join(' ');
    const valid = validateSearchInput(query, parsedLimit);
    if (!valid.ok) {
      const cache = await tryResolveCacheCli(values.root);
      if (cache !== null) {
        recordAudit(
          cache.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_search',
            adapter: 'cli',
            outcome: 'failure',
            ms: performance.now() - started,
            engine: engineVersion(),
            code: 'INVALID_INPUT',
            codes: ['INVALID_INPUT'],
            ...(query !== '' ? { query } : {}),
            ...(parsedLimit !== undefined && Number.isInteger(parsedLimit)
              ? { limit: parsedLimit }
              : {}),
          },
          { root: cache.root },
        );
      }
      const outcome = {
        kind: 'failure' as const,
        code: 'INVALID_INPUT' as const,
        message: valid.message,
      };
      console.log(
        values.json === true ? JSON.stringify(outcome, null, 2) : renderSearchOutcome(outcome),
      );
      return 2;
    }
    const workspace = await loadWorkspace(values.root ?? process.cwd());
    const session = new ImpactSession(workspace, {
      waitAfterExpiry: true,
      onProgress: (message) => console.error(`ei search: ${message}`),
    });
    const outcome = await runSearch(session, {
      query: valid.query,
      limit: valid.limit,
    });
    recordAudit(
      workspace.cacheDir,
      {
        ts: new Date().toISOString(),
        tool: 'ei_search',
        adapter: 'cli',
        outcome: outcome.kind,
        ms: performance.now() - started,
        engine: engineVersion(),
        ...auditFieldsForSearch(outcome, engineVersion(), valid.query, valid.limit),
      },
      { root: workspace.root },
    );
    const rendered = renderSearchOutcome(outcome);
    if (values.json === true) {
      console.log(JSON.stringify(outcome.kind === 'result' ? outcome.value : outcome, null, 2));
    } else {
      console.log(rendered);
    }
    return outcome.kind === 'failure' ? 1 : 0;
  }

  if (command === 'doctor') {
    if (values.deep !== true) {
      console.error(USAGE);
      return 2;
    }
    const workspace = await loadWorkspace(values.root ?? process.cwd());
    const raw = values.differential ?? '0';
    const differential = raw === 'all' ? -1 : Number.parseInt(raw, 10);
    if (!Number.isInteger(differential)) {
      console.error(`--differential must be a number or "all", got ${raw}`);
      return 2;
    }
    const outcome = await doctorDeep(workspace, {
      differential,
      onProgress: (message) => console.error(`ei doctor: ${message}`),
    });
    if (!outcome.ok) {
      console.log(`DOCTOR ${outcome.code}: ${outcome.message} · ${outcome.fix}`);
      return 1;
    }
    if (values.json === true) {
      console.log(JSON.stringify(outcome.value, null, 2));
    } else {
      console.log(renderDoctor(outcome.value));
    }
    return doctorPassed(outcome.value) ? 0 : 1;
  }

  if (command === 'init') {
    const result = await initProject({
      root: values.root,
      force: values.force === true,
      dryRun: values['dry-run'] === true,
    });
    if (values.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    const dry = values['dry-run'] === true;
    const status = result.configOverwritten
      ? dry
        ? 'would overwrite'
        : 'overwritten'
      : result.configCreated
        ? dry
          ? 'would create'
          : 'created'
        : 'already exists, skipped';
    console.log('Project initialized:');
    console.log(`  Repo ID:    ${result.repoId}`);
    console.log(`  Root:       ${result.root}`);
    console.log(`  Cache dir:  ${result.cacheDir}`);
    console.log(`  Config:     ${result.configPath} (${status})`);
    console.log(
      `  Git:        ${result.git.isRepo ? `yes (${result.git.gitRoot ?? 'root'})` : 'not a git repository'}`,
    );
    console.log(`  Include:    ${result.config.impact.include.join(', ')}`);
    console.log(
      `  TS configs: ${result.tsconfigs.length > 0 ? result.tsconfigs.join(', ') : 'none found'}`,
    );
    console.log(
      `  Omitted tsconfig dirs: ${result.omittedTsconfigDirs.length > 0 ? result.omittedTsconfigDirs.join(', ') : 'none'}`,
    );
    if (result.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const warning of result.warnings) {
        console.log(`  - ${warning}`);
      }
    }
    return 0;
  }

  if (command === 'route' || command === 'load') {
    const query = {
      task: values.task ?? '',
      stage: values.stage,
      risk: values.risk,
      type: values.type,
      potetoMode: values['poteto-mode'] === true,
    };
    if (command === 'route') {
      console.log(JSON.stringify(routeTask(query), null, 2));
      return 0;
    }
    const started = performance.now();
    try {
      const workflow = await prepareWorkflow({
        ...query,
        strict: true,
        roots: rootsFromEnv(process.env),
        lock: await readLock(lockPath),
      });
      const cache = await tryResolveCacheCli(values.root);
      if (cache !== null) {
        recordAudit(
          cache.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_workflow',
            adapter: 'cli',
            outcome: 'result',
            ms: performance.now() - started,
            engine: engineVersion(),
            ...auditFieldsForWorkflow(workflow),
          },
          { root: cache.root },
        );
      }
      console.log(renderWorkflow(workflow));
      return 0;
    } catch (error) {
      const cache = await tryResolveCacheCli(values.root);
      if (cache !== null) {
        recordAudit(
          cache.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_workflow',
            adapter: 'cli',
            outcome: 'error',
            ms: performance.now() - started,
            engine: engineVersion(),
            code: error instanceof WorkflowError ? error.code : 'WORKFLOW_ERROR',
            ...(query.task !== '' ? { task: query.task } : {}),
            ...(query.stage !== undefined ? { stage: query.stage } : {}),
          },
          { root: cache.root },
        );
      }
      throw error;
    }
  }

  if (command === 'skills' && (sub === 'list' || sub === 'check')) {
    const rawPlatform = values.platform ?? 'omp';
    if (rawPlatform !== 'agy' && rawPlatform !== 'omp') {
      console.error(`invalid --platform ${JSON.stringify(rawPlatform)}; expected agy or omp`);
      return 2;
    }
    const platform: SkillPlatform = rawPlatform;
    const result =
      platform === 'agy'
        ? await discoverAgySkills({
            workspaceRoot: values.root,
            detectHostPaths: values['detect-host'] === true,
            requireCatalog: true,
          })
        : await discoverOmpSkills({
            workspaceRoot: values.root,
            profile: values.profile,
            detectHostPaths: values['detect-host'] === true,
            requireCatalog: true,
          });
    const registryIssues =
      sub === 'check'
        ? await validateRegistryConsistency(
            await readRegistry(registryPath),
            await readLock(lockPath),
          )
        : [];
    const totalIssues = result.issues.length + registryIssues.length;

    if (values.json === true) {
      console.log(
        JSON.stringify(
          sub === 'list'
            ? { platform, packs: listSkillPacks(), discovery: result }
            : { ...result, registryIssues },
          null,
          2,
        ),
      );
      return sub === 'check' && totalIssues > 0 ? 1 : 0;
    }
    console.log(
      `SKILLS ${platform} · ${result.skills.length} discovered (${result.autoVisible.length} auto, ${result.explicitOnly.length} opt-in) · ${totalIssues} issues`,
    );
    for (const skill of result.skills) {
      const mode = skill.explicitOnly ? 'opt-in' : 'auto';
      console.log(`  ${skill.name.padEnd(28)} ${mode.padEnd(8)} ${skill.sourceLabel}`);
    }
    for (const issue of result.issues) {
      console.log(`  ISSUE ${issue.code}: ${issue.message}`);
    }
    for (const issue of registryIssues) {
      console.log(`  REGISTRY ${issue.code}: ${issue.message}`);
    }
    return sub === 'check' && totalIssues > 0 ? 1 : 0;
  }

  if (command === 'skills' && sub === 'diff') {
    const check = await checkUpstreamUpdates({
      roots: rootsFromEnv(process.env),
      lockPath,
      registryPath,
    });
    if (values.json === true) {
      console.log(JSON.stringify(check, null, 2));
      return check.blockingFindings.length > 0 ? 1 : 0;
    }
    console.log(
      `SKILLS DIFF · updates=${check.hasUpdates ? 'yes' : 'no'} · blocking=${check.blockingFindings.length} · warnings=${check.findings.length - check.blockingFindings.length}`,
    );
    for (const p of check.providers) {
      console.log(
        `  ${p.provider.padEnd(8)} commit ${(p.previousCommit ?? '-').slice(0, 12)} -> ${(p.nextCommit ?? '-').slice(0, 12)} · changed=${p.changed.length} added=${p.added.length} removed=${p.removed.length} renamed=${p.renamed.length}`,
      );
    }
    for (const finding of check.findings) {
      console.log(`  [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}`);
    }
    return check.blockingFindings.length > 0 ? 1 : 0;
  }

  if (command === 'skills' && sub === 'sync') {
    const { stagePath, staged } = await stageSkillUpdate({
      roots: rootsFromEnv(process.env),
      lockPath,
      registryPath,
      stateDir: values['state-dir'],
      workspaceRoot: values.root,
    });
    if (values.json === true) {
      console.log(JSON.stringify({ stagePath, staged }, null, 2));
      return staged.validation.ok ? 0 : 1;
    }
    console.log(
      `SKILLS SYNC ${staged.status.toUpperCase()} · stageId=${staged.stageId} · agy=${staged.validation.runtimes.agy.ok ? 'OK' : 'FAIL'} · omp=${staged.validation.runtimes.omp.ok ? 'OK' : 'FAIL'} · file=${stagePath}`,
    );
    for (const finding of staged.diff.findings) {
      console.log(`  [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}`);
    }
    if (staged.validation.ok) {
      console.log(
        `Next: review diff, then run: ei skills publish --stage-id ${staged.stageId} --approve`,
      );
    }
    return staged.validation.ok ? 0 : 1;
  }

  if (command === 'skills' && sub === 'publish') {
    const stageId = values['stage-id'];
    if (!stageId) {
      console.error('usage: main.js skills publish --stage-id <id> --approve [--state-dir <path>]');
      return 2;
    }
    const { snapshotPath, snapshot } = await publishStagedUpdate({
      stageId,
      approve: values.approve === true,
      lockPath,
      registryPath,
      stateDir: values['state-dir'],
      force: values.force === true,
    });
    if (values.json === true) {
      console.log(JSON.stringify({ snapshotPath, snapshot }, null, 2));
      return 0;
    }
    console.log(
      `SKILLS PUBLISHED releaseId=${snapshot.releaseId} from ${snapshot.stageId} · rollback snapshot=${snapshotPath}`,
    );
    return 0;
  }

  if (command === 'skills' && sub === 'rollback') {
    const restored = await rollbackSkillUpdate({
      releaseId: values.release,
      lockPath,
      registryPath,
      stateDir: values['state-dir'],
    });
    if (values.json === true) {
      console.log(JSON.stringify(restored, null, 2));
      return 0;
    }
    console.log(`SKILLS ROLLED BACK to previous state of release ${restored.restoredFrom}`);
    return 0;
  }

  if (command === 'sources' && sub === 'check') {
    const lock = await readLock(lockPath);
    const result = await checkSources(lock, rootsFromEnv(process.env), {
      write: values.write === true,
    });
    console.log(formatReports(result.reports));
    if (result.reports.some((report) => report.written)) await writeLock(lockPath, result.lock);
    return result.reports.some((report) => reportStatus(report) === 'ERROR') ? 1 : 0;
  }

  if (command === 'mcp') {
    if (sub !== undefined) {
      console.error('usage: main.js mcp --root /absolute/path/to/repository [--workflow]');
      return 2;
    }
    const stdioUrl = new URL('../../../scripts/mcp/stdio.mjs', import.meta.url).href;
    const { createStdioServer, resolveMcpRoot } = (await import(stdioUrl)) as {
      createStdioServer: (options: { root: string; env?: NodeJS.ProcessEnv }) => {
        close: () => void;
        done: Promise<void>;
      };
      resolveMcpRoot: (
        supplied: string | undefined,
        env?: NodeJS.ProcessEnv,
      ) => Promise<{ ok: true; root: string } | { ok: false; message: string }>;
    };
    const resolved = await resolveMcpRoot(values.root, process.env);
    if (!resolved.ok) {
      console.error(resolved.message);
      return 2;
    }
    const env = values.workflow === true ? { ...process.env, KSD_MCP_WORKFLOW: '1' } : process.env;
    const server = createStdioServer({ root: resolved.root, env });
    await server.done;
    return 0;
  }

  console.error(USAGE);
  return 2;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
