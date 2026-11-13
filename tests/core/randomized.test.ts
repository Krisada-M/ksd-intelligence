import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { Indexer } from '../../src/core/indexing/indexer.js';
import { coldLines, difference, fixtureRepo, impactOf, publishedLines } from './index-helpers.js';

// D36: random sequences of edits on a copy of the fixture; after every step the incremental index
// must equal a cold build. Short in `npm test`; EI_RANDOM_STEPS / EI_RANDOM_SEEDS for long runs.
const STEPS = Number(process.env.EI_RANDOM_STEPS ?? 12);
const SEEDS = (process.env.EI_RANDOM_SEEDS ?? '1,2')
  .split(',')
  .map(Number)
  .filter((n) => Number.isInteger(n));

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sourceFiles(root: string): string[] {
  const found: string[] = [];
  for (const top of ['packages', 'apps']) {
    for (const entry of readdirSync(join(root, top), { withFileTypes: true, recursive: true })) {
      const path = join(entry.parentPath, entry.name);
      if (entry.isFile() && /\.(ts|js|cjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
        found.push(relative(root, path));
      }
    }
  }
  return found.sort();
}

type Op = (root: string, n: number, pick: <T>(items: readonly T[]) => T) => string;

const OPS: Record<string, Op> = {
  'body edit': (root, n, pick) => {
    const file = pick(
      sourceFiles(root).filter((f) =>
        /\)\s*(:[^{=]+)?\{\n/.test(readFileSync(join(root, f), 'utf8')),
      ),
    );
    const text = readFileSync(join(root, file), 'utf8');
    writeFileSync(join(root, file), text.replace(/(\)\s*(:[^{=]+)?\{\n)/, `$1  void ${n};\n`));
    return file;
  },
  'signature edit': (root, n, pick) => {
    const file = pick(
      sourceFiles(root).filter((f) =>
        /export function \w+\(/.test(readFileSync(join(root, f), 'utf8')),
      ),
    );
    const text = readFileSync(join(root, file), 'utf8');
    writeFileSync(
      join(root, file),
      text.replace(
        /export function (\w+)\(([^)]*)\)/,
        (_m, name: string, params: string) =>
          `export function ${name}(${params.trim() === '' ? '' : `${params}, `}p${n}?: number)`,
      ),
    );
    return file;
  },
  'export toggle': (root, _n, pick) => {
    const file = pick(
      sourceFiles(root).filter((f) =>
        /^(export )?function \w+/m.test(readFileSync(join(root, f), 'utf8')),
      ),
    );
    const text = readFileSync(join(root, file), 'utf8');
    const toggled = /^export function/m.test(text)
      ? text.replace(/^export function/m, 'function')
      : text.replace(/^function/m, 'export function');
    writeFileSync(join(root, file), toggled);
    return file;
  },
  'add file': (root, n, pick) => {
    const dir = pick([
      'packages/api/src',
      'packages/payments/src',
      'apps/web/src',
      'packages/shared/src',
    ]);
    const file = `${dir}/gen${n}.ts`;
    const body = pick([
      "import { roundMoney } from '@fx/shared/money';\nexport function gen() {\n  return roundMoney(1);\n}\n",
      "import { calculateFee, PaymentService } from '@fx/payments';\nexport const gen = () => calculateFee(1) + new PaymentService().charge(2);\n",
      'export function calculateFee(): number {\n  return 0;\n}\nexport const charge = { charge: calculateFee };\n',
    ]);
    writeFileSync(join(root, file), body);
    return file;
  },
  'delete file': (root, _n, pick) => {
    const file = pick(sourceFiles(root).filter((f) => !f.endsWith('index.ts')));
    rmSync(join(root, file));
    return file;
  },
  rename: (root, n, pick) => {
    const file = pick(sourceFiles(root));
    const target = file.replace(/(\.\w+)$/, `_r${n}$1`);
    renameSync(join(root, file), join(root, target));
    return `${file} -> ${target}`;
  },
  barrel: (root, _n, pick) => {
    const file = join(root, 'packages/payments/src/index.ts');
    if (!existsSync(file)) return 'barrel missing';
    const text = readFileSync(file, 'utf8');
    const line = pick([
      "export * from './fee';\n",
      "export { b } from './cycle-b';\n",
      "export * from './stripe';\n",
    ]);
    writeFileSync(file, text.includes(line) ? text.replace(line, '') : text + line);
    return `barrel ${line.trim()}`;
  },
  'paths change': (root, _n, pick) => {
    const file = join(root, 'tsconfig.base.json');
    const text = readFileSync(file, 'utf8');
    const target = pick(['packages/payments/src/index.ts', 'packages/payments/src/service.ts']);
    writeFileSync(file, text.replace(/("@fx\/payments": \[")[^"]+/, `$1${target}`));
    return `@fx/payments -> ${target}`;
  },
};

// Three ways to the same index: one Indexer for every step; a 1 MB budget, always exceeded, so
// every program gives its checker back after each batch; and a new Indexer before every step, as
// a new engine process would be, so no state can carry over between updates (D47, D50).
const RUNS: { seed: number; label: string; memoryBudgetMb?: number; newSession?: boolean }[] = [
  ...SEEDS.map((seed) => ({ seed, label: '' })),
  { seed: SEEDS[0] ?? 1, label: ', 1 MB budget', memoryBudgetMb: 1 },
  { seed: SEEDS[0] ?? 1, label: ', new Indexer each step', newSession: true },
];

describe('seeded randomised incremental == cold (D36)', () => {
  for (const [run, { seed, label, memoryBudgetMb, newSession }] of RUNS.entries()) {
    it(`seed ${seed}, ${STEPS} steps${label}`, { timeout: 600_000 }, async () => {
      const repo = await fixtureRepo(`random-${seed}-${run}`);
      const random = prng(seed);
      const pick = <T>(items: readonly T[]): T => {
        const item = items[Math.floor(random() * items.length)];
        if (item === undefined) throw new Error('pick from an empty list');
        return item;
      };
      const history: string[] = [];
      try {
        let indexer = new Indexer(ts, repo, join(repo, '..', 'cache'), { memoryBudgetMb });
        await indexer.index({ impact: impactOf(repo) });
        for (let step = 1; step <= STEPS; step++) {
          const name = pick(Object.keys(OPS));
          const op = OPS[name];
          if (op === undefined) continue;
          if (newSession === true) indexer = new Indexer(ts, repo, indexer.cacheDir);
          history.push(`${step}. ${name}: ${op(repo, step, pick)}`);
          const report = await indexer.index({ impact: impactOf(repo) });
          assert.deepEqual(report.problems, [], `seed ${seed}: verify\n${history.join('\n')}`);
          const diff = difference(
            publishedLines(indexer.cacheDir),
            await coldLines(repo, join(repo, '..', `cold-${step}`)),
          );
          assert.deepEqual(
            diff,
            { onlyFirst: [], onlySecond: [] },
            `seed ${seed} diverged (rerun: EI_RANDOM_SEEDS=${seed} EI_RANDOM_STEPS=${step})\n${history.join('\n')}`,
          );
          rmSync(join(repo, '..', `cold-${step}`), { recursive: true, force: true });
        }
      } finally {
        rmSync(dirname(repo), { recursive: true, force: true });
      }
    });
  }
});
