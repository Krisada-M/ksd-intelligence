import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTypescriptRuntime,
  pinnedTypescriptVersion,
  typescriptRuntimeDir,
} from '../../dist/core/engine/typescript.js';

const cli = fileURLToPath(new URL('../../dist/adapters/cli/main.js', import.meta.url));
const version = pinnedTypescriptVersion();
const runtime = await checkTypescriptRuntime({ version });
assert.ok(runtime.ok, runtime.ok ? undefined : `TypeScript ${version}: ${runtime.reason}`);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ei-round-6-')));
const home = join(scratch, 'home');
const repo = join(scratch, 'fixture');
const src = join(repo, 'src');
const env = { HOME: home, PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1' };
const fanout = 320;

function ei(...args) {
  return JSON.parse(
    execFileSync(process.execPath, [cli, ...args, '--root', repo, '--json'], {
      cwd: repo,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
}

try {
  cpSync(typescriptRuntimeDir({ version }), typescriptRuntimeDir({ version, cacheHome: home }), {
    recursive: true,
    dereference: true,
  });
  mkdirSync(src, { recursive: true });
  execFileSync('git', ['init', '--quiet', '--template='], { cwd: repo, env });
  writeFileSync(
    join(repo, 'package.json'),
    '{"name":"round-6-fixture","private":true,"type":"module"}\n',
  );
  writeFileSync(
    join(repo, 'tsconfig.json'),
    '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext"},"include":["src/**/*.ts"]}\n',
  );
  writeFileSync(join(src, 'fanout.ts'), 'export function shared(x: number) { return x + 1; }\n');
  for (let i = 0; i < fanout; i++) {
    const id = String(i).padStart(3, '0');
    writeFileSync(
      join(src, `case-${id}.ts`),
      `import { shared } from './fanout.js';\nexport function use${id}() { return shared(${i}); }\n`,
    );
  }

  ei('index', '--full');
  const shared = ei('impact', 'src/fanout.ts#shared');
  const calls = shared.byDepth[0].filter(
    (node) => node.via === 'CALLS' && node.strength === 'compiler',
  );
  const expected = Array.from({ length: fanout }, (_, i) => {
    const id = String(i).padStart(3, '0');
    return `src/case-${id}.ts#use${id}`;
  });
  assert.deepEqual(calls.map((node) => node.symbol).sort(), expected);

  const target = 'src/case-000.ts#use000';
  const before = ei('impact', target);
  assert.equal(before.reach.direct, 0);
  writeFileSync(
    join(src, 'late.ts'),
    "import { use000 } from './case-000.js';\nexport function late() { return use000(); }\n",
  );
  const after = ei('impact', target);
  assert.notEqual(after.freshness.workingTreeHash, before.freshness.workingTreeHash);
  assert.ok(
    after.byDepth[0].some((node) => node.symbol === 'src/late.ts#late' && node.via === 'CALLS'),
  );

  const doctor = ei('doctor', '--deep', '--differential', '300');
  assert.equal(doctor.differences.count, 0);
  assert.equal(doctor.differential.declarations, 300);
  assert(doctor.differential.references > 0);
  assert.deepEqual(doctor.differential.misses, []);
  console.log(
    JSON.stringify(
      {
        lane: 'synthetic correctness smoke; not R8 or platform acceptance',
        platform: `${platform()} ${arch()}`,
        node: process.version,
        typescript: version,
        compilerCallers: calls.length,
        untrackedCallerIndexed: true,
        graphDifferences: doctor.differences.count,
        differentialDeclarations: doctor.differential.declarations,
        differentialReferences: doctor.differential.references,
        differentialMisses: doctor.differential.misses.length,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
