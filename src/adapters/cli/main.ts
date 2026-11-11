#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { rootsFromEnv } from '../../workflow/catalog.js';
import { prepareWorkflow } from '../../workflow/loader.js';
import { renderWorkflow } from '../../workflow/render.js';
import { routeTask } from '../../workflow/router.js';
import {
  checkSources,
  defaultLockPath,
  formatReports,
  readLock,
  reportStatus,
  writeLock,
} from '../../workflow/sources.js';

const USAGE = `usage:
  main.js route --task "..." [--stage plan|investigate|implement|verify|review|ship] [--risk normal|high] [--type bug|feature|refactor|security|performance|ui]
  main.js load  --task "..." [same options]      (needs checkouts; fails closed)
  main.js sources check [--write] [--lock <path>]  (never clones or fetches)`;

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: 'string' },
      stage: { type: 'string' },
      risk: { type: 'string' },
      type: { type: 'string' },
      write: { type: 'boolean' },
      lock: { type: 'string' },
    },
  });
  const [command, sub] = positionals;
  const lockPath = values.lock ?? defaultLockPath();

  if (command === 'route' || command === 'load') {
    const query = { task: values.task ?? '', stage: values.stage, risk: values.risk, type: values.type };
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
    const result = await checkSources(lock, rootsFromEnv(process.env), { write: values.write === true });
    console.log(formatReports(result.reports));
    if (result.reports.some((report) => report.written)) await writeLock(lockPath, result.lock);
    return result.reports.some((report) => reportStatus(report) === 'ERROR') ? 1 : 0;
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
