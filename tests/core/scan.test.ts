import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import ts from 'typescript';
import {
  defaultConfig,
  parseProjectConfig,
  type ImpactConfig,
} from '../../src/core/kernel/config.js';
import { scan, type CensusRecord } from '../../src/core/workspace/scan.js';

const FIXTURE = fileURLToPath(new URL('../../../tests/fixtures/mono', import.meta.url));

/** The fixture's own impact config (ei.config.json sets only routes; include stays the default). */
function fixtureImpact(): ImpactConfig {
  const { config, errors } = parseProjectConfig(
    readFileSync(join(FIXTURE, 'ei.config.json'), 'utf8'),
  );
  assert.deepEqual(errors, []);
  return config.impact;
}

type Row = [
  path: string,
  kind: string,
  status: string,
  reason: string | null,
  pkg: string | null,
  tsconfig: string | null,
];

const PAYMENTS = 'packages/payments';
const api = (file: string, kind = 'ts'): Row => [
  `packages/api/src/${file}`,
  kind,
  'indexable',
  null,
  'packages/api',
  'tsconfig.json',
];
const payments = (file: string): Row => [
  `${PAYMENTS}/src/${file}`,
  'ts',
  'indexable',
  null,
  PAYMENTS,
  'tsconfig.json',
];
const shared = (file: string, kind: string): Row => [
  `packages/shared/src/${file}`,
  kind,
  'indexable',
  null,
  'packages/shared',
  'tsconfig.json',
];

// Every file of tests/fixtures/mono with its expected classification (acceptance 2).
const FIXTURE_CENSUS: Row[] = [
  ['apps/web/package.json', 'json', 'unindexed', 'other-kind', 'apps/web', null],
  ['apps/web/src/checkout.ts', 'ts', 'indexable', null, 'apps/web', 'tsconfig.json'],
  ['ei.config.json', 'json', 'unindexed', 'outside-index-scope', null, null],
  ['packages/api/package.json', 'json', 'unindexed', 'other-kind', 'packages/api', null],
  api('charge.ts'),
  api('handlers.ts'),
  api('handlers/refund.ts'),
  api('report.js', 'js'),
  api('routes.ts'),
  [`${PAYMENTS}/package.json`, 'json', 'unindexed', 'other-kind', PAYMENTS, null],
  payments('checkout-flow.ts'),
  payments('cycle-a.ts'),
  payments('cycle-b.ts'),
  payments('fee.test.ts'),
  payments('fee.ts'),
  payments('index.ts'),
  payments('manual.ts'),
  payments('processor.ts'),
  payments('service.ts'),
  payments('stripe.ts'),
  ['packages/shared/package.json', 'json', 'unindexed', 'other-kind', 'packages/shared', null],
  shared('globals.d.ts', 'd.ts'),
  shared('legacy.cjs', 'cjs'),
  shared('money.ts', 'ts'),
  ['tsconfig.base.json', 'json', 'unindexed', 'outside-index-scope', null, null],
  ['tsconfig.json', 'json', 'unindexed', 'outside-index-scope', null, null],
];

function rows(records: CensusRecord[]): Row[] {
  return records.map((r) => [r.path, r.kind, r.status, r.reason, r.package, r.tsconfig]);
}

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

describe('scan census', () => {
  let work: string;
  before(async () => {
    work = await realpath(await mkdtemp(join(tmpdir(), 'ei-scan-')));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('accounts for every fixture file: indexable, orphan or unindexed with a reason', async () => {
    const { records, summary } = await scan(FIXTURE, fixtureImpact(), ts);
    assert.deepEqual(rows(records), FIXTURE_CENSUS);
    assert.equal(summary.listing, 'git', 'the fixture is tracked in this repository');
    assert.deepEqual(
      {
        scanned: summary.scanned,
        indexable: summary.indexable,
        orphan: summary.orphan,
        unindexed: summary.unindexed,
      },
      { scanned: 26, indexable: 19, orphan: 0, unindexed: 7 },
    );
    assert.deepEqual(summary.reasons, { 'other-kind': 4, 'outside-index-scope': 3 });
    assert.equal(summary.packages, 4);
    assert.deepEqual(summary.tsconfigs, ['tsconfig.json']);
    assert.deepEqual(
      summary.tsconfigBases,
      ['tsconfig.base.json'],
      'an extends-only base owns nothing',
    );
    assert.deepEqual(summary.tsconfigErrors, []);
    for (const record of records) {
      assert.equal(
        record.hash,
        sha256(join(FIXTURE, record.path)),
        `content hash of ${record.path}`,
      );
      assert.equal(record.size, readFileSync(join(FIXTURE, record.path)).length);
    }
  });

  it('a copy outside git (walk listing) gives the same census', async () => {
    const copy = join(work, 'walk');
    cpSync(FIXTURE, copy, { recursive: true });
    const { records, summary } = await scan(copy, fixtureImpact(), ts);
    assert.equal(summary.listing, 'walk');
    assert.deepEqual(rows(records), FIXTURE_CENSUS);
  });

  it('secret, excluded, ignored, symlinked, orphan and other-kind files, without reading excluded content', async () => {
    const copy = join(work, 'mixed');
    cpSync(FIXTURE, copy, { recursive: true });
    await writeFile(join(copy, '.env'), 'TOKEN=never-read\n');
    await writeFile(join(copy, 'packages/api/server.pem'), 'never read\n');
    await mkdir(join(copy, 'packages/api/dist'));
    await writeFile(join(copy, 'packages/api/dist/out.js'), 'export {};\n');
    await mkdir(join(copy, 'tools'));
    await writeFile(join(copy, 'tools/orphan.ts'), 'export const x = 1;\n');
    await writeFile(join(copy, 'README.md'), '# fixture\n');
    await writeFile(join(copy, '.gitignore'), 'ignored.ts\nbuild/\n');
    await writeFile(join(copy, 'packages/api/src/ignored.ts'), 'export {};\n');
    await mkdir(join(copy, 'build'));
    await writeFile(join(copy, 'build/out.ts'), 'export {};\n');
    await symlink('../../../.env', join(copy, 'packages/api/src/link.ts'));
    // Unreadable: if the scan read any excluded file, hashing it would throw.
    const unreadable = ['.env', 'packages/api/server.pem', 'packages/api/dist/out.js'];
    if (process.getuid?.() !== 0) for (const path of unreadable) chmodSync(join(copy, path), 0o000);

    const impact: ImpactConfig = { ...defaultConfig().impact, include: ['**'] };
    const { records, summary } = await scan(copy, impact, ts);
    const byPath = new Map(rows(records).map((row) => [row[0], row]));

    assert.deepEqual(byPath.get('.env'), ['.env', 'other', 'unindexed', 'secret', null, null]);
    assert.deepEqual(byPath.get('packages/api/server.pem')?.slice(2, 4), ['unindexed', 'secret']);
    assert.deepEqual(byPath.get('packages/api/dist/out.js')?.slice(2, 4), [
      'unindexed',
      'excluded',
    ]);
    assert.deepEqual(byPath.get('packages/api/src/link.ts')?.slice(2, 4), ['unindexed', 'symlink']);
    assert.deepEqual(byPath.get('tools/orphan.ts'), [
      'tools/orphan.ts',
      'ts',
      'orphan',
      'no-tsconfig',
      null,
      null,
    ]);
    assert.deepEqual(byPath.get('README.md')?.slice(2, 4), ['unindexed', 'other-kind']);
    assert.equal(byPath.has('packages/api/src/ignored.ts'), false, '.gitignore honoured');
    assert.equal(byPath.has('build/out.ts'), false, 'ignored directory not entered');
    for (const path of [...unreadable, 'packages/api/src/link.ts']) {
      assert.equal(records.find((r) => r.path === path)?.hash, null, `${path} content never read`);
    }
    assert.equal(summary.orphan, 1);
    assert.equal(summary.scanned, records.length);
    assert.equal(summary.indexable + summary.orphan + summary.unindexed, summary.scanned);
  });

  it('follows project references to configs whose name is not tsconfig*.json', async () => {
    const dir = join(work, 'refs');
    await mkdir(join(dir, 'lib/src'), { recursive: true });
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ files: [], references: [{ path: './lib/project.json' }] }),
    );
    await writeFile(
      join(dir, 'lib/project.json'),
      JSON.stringify({ compilerOptions: { composite: true }, include: ['src'] }),
    );
    await writeFile(join(dir, 'lib/src/a.ts'), 'export const a = 1;\n');
    await writeFile(join(dir, 'lib/loose.ts'), 'export const b = 2;\n');
    const impact: ImpactConfig = { ...defaultConfig().impact, include: ['**'] };
    const { records, summary } = await scan(dir, impact, ts);
    const byPath = new Map(rows(records).map((row) => [row[0], row]));
    assert.deepEqual(byPath.get('lib/src/a.ts')?.slice(2), [
      'indexable',
      null,
      null,
      'lib/project.json',
    ]);
    assert.deepEqual(byPath.get('lib/loose.ts')?.slice(2, 4), ['orphan', 'no-tsconfig']);
    assert.deepEqual(summary.tsconfigs, ['lib/project.json', 'tsconfig.json']);
  });
});
