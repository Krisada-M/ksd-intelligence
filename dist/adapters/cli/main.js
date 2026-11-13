#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildIndex } from '../../core/engine/build.js';
import { renderStatus, workspaceStatus } from '../../core/engine/status.js';
import { checkTypescriptRuntime, pinnedTypescriptVersion, setupTypescriptRuntime, } from '../../core/engine/typescript.js';
import { loadWorkspace } from '../../core/engine/workspace.js';
import { initProject } from '../../core/workspace/init.js';
import { rootsFromEnv } from '../../workflow/catalog.js';
import { prepareWorkflow } from '../../workflow/loader.js';
import { renderWorkflow } from '../../workflow/render.js';
import { routeTask } from '../../workflow/router.js';
import { checkSources, defaultLockPath, formatReports, readLock, reportStatus, writeLock, } from '../../workflow/sources.js';
const USAGE = `usage:
  main.js init  [--root <path>] [--force] [--dry-run] [--json]
  main.js setup [--check]                         (installs the pinned TypeScript runtime; --check only verifies)
  main.js index [--root <path>]                   (scans and publishes the census; part 1 of M2a)
  main.js status [--root <path>] [--json]         (index, coverage, runtime, TypeScript, store, lock)
  main.js route --task "..." [--stage plan|investigate|implement|verify|review|ship] [--risk normal|high] [--type bug|feature|refactor|security|performance|ui]
  main.js load  --task "..." [same options]      (needs checkouts; fails closed)
  main.js sources check [--write] [--lock <path>]  (never clones or fetches)`;
async function run(argv) {
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
            write: { type: 'boolean' },
            lock: { type: 'string' },
            check: { type: 'boolean' },
        },
    });
    const [command, sub] = positionals;
    const lockPath = values.lock ?? defaultLockPath();
    if (command === 'setup') {
        const version = pinnedTypescriptVersion();
        // --check only reads files; plain setup is the one command that uses the network (D44).
        const result = values.check === true
            ? await checkTypescriptRuntime({ version })
            : await setupTypescriptRuntime({ version });
        if (!result.ok) {
            console.log(`typescript ${version}: degraded (${result.reason}) · ${result.fix}`);
            return 1;
        }
        console.log(`typescript ${result.runtime.version}: ready · ${result.runtime.path} · sha256 ${result.sha256}`);
        return 0;
    }
    if (command === 'status') {
        if (process.env.EI_DISABLED === '1') {
            console.log('STATUS disabled (EI_DISABLED)');
            return 0;
        }
        const status = await workspaceStatus(values.root ?? process.cwd());
        console.log(values.json === true ? JSON.stringify(status, null, 2) : renderStatus(status));
        return status.state === 'ready' ? 0 : 1;
    }
    if (command === 'index') {
        const workspace = await loadWorkspace(values.root ?? process.cwd());
        const started = performance.now();
        const outcome = await buildIndex(workspace, {
            onProgress: (message) => console.error(`ei index: ${message}`),
        });
        if (!outcome.ok) {
            console.log(`INDEX ${outcome.code}: ${outcome.message} · ${outcome.fix}`);
            return 1;
        }
        const seconds = ((performance.now() - started) / 1000).toFixed(2);
        console.log(`INDEX published in ${seconds} s (${workspace.root})`);
        console.log(renderStatus(await workspaceStatus(workspace.root)));
        return 0;
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
        const status = result.configOverwritten
            ? 'overwritten'
            : result.configCreated
                ? 'created'
                : 'already exists, skipped';
        console.log('Project initialized:');
        console.log(`  Repo ID:    ${result.repoId}`);
        console.log(`  Root:       ${result.root}`);
        console.log(`  Cache dir:  ${result.cacheDir}`);
        console.log(`  Config:     ${result.configPath} (${status})`);
        console.log(`  Git:        ${result.git.isRepo ? `yes (${result.git.gitRoot ?? 'root'})` : 'not a git repository'}`);
        console.log(`  TS configs: ${result.tsconfigs.length > 0 ? result.tsconfigs.join(', ') : 'none found'}`);
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
        };
        if (command === 'route') {
            console.log(JSON.stringify(routeTask(query), null, 2));
            return 0;
        }
        const workflow = await prepareWorkflow({
            ...query,
            strict: true,
            roots: rootsFromEnv(process.env),
            lock: await readLock(lockPath),
        });
        console.log(renderWorkflow(workflow));
        return 0;
    }
    if (command === 'sources' && sub === 'check') {
        const lock = await readLock(lockPath);
        const result = await checkSources(lock, rootsFromEnv(process.env), {
            write: values.write === true,
        });
        console.log(formatReports(result.reports));
        if (result.reports.some((report) => report.written))
            await writeLock(lockPath, result.lock);
        return result.reports.some((report) => reportStatus(report) === 'ERROR') ? 1 : 0;
    }
    console.error(USAGE);
    return 2;
}
try {
    process.exitCode = await run(process.argv.slice(2));
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
