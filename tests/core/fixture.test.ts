import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';

// Fixture is data for the engine golden cases, never compiled into dist-test;
// resolve it from the repo root so it works from src and from dist-test alike.
const fixtureRoot = path.resolve(process.cwd(), 'tests/fixtures/mono');

function rel(p: string): string {
  return path.join(fixtureRoot, p);
}

function readFixture(p: string): string {
  return fs.readFileSync(rel(p), 'utf8');
}

function assertZeroDiagnostics(root: string): void {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  assert.ok(configPath, `tsconfig.json not found under ${root}`);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    },
  );
  assert.ok(parsed, `failed to parse tsconfig under ${root}`);
  assert.deepEqual(parsed.errors, [], `tsconfig errors under ${root}`);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const formatted = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(formatted, [], `diagnostics under ${root}:\n${formatted.join('\n')}`);
}

test('fixture type-checks with zero diagnostics', () => {
  assertZeroDiagnostics(fixtureRoot);
});

test('fixture type-checks outside this repository (self-contained)', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ksd-fixture-'));
  try {
    fs.cpSync(fixtureRoot, tmp, { recursive: true });
    assertZeroDiagnostics(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fixture: all files the golden cases rely on exist', () => {
  const files = [
    'ei.config.json',
    'tsconfig.base.json',
    'packages/shared/package.json',
    'packages/shared/src/money.ts',
    'packages/shared/src/legacy.cjs',
    'packages/payments/package.json',
    'packages/payments/src/index.ts',
    'packages/payments/src/fee.ts',
    'packages/payments/src/fee.test.ts',
    'packages/payments/src/service.ts',
    'packages/payments/src/processor.ts',
    'packages/payments/src/stripe.ts',
    'packages/payments/src/manual.ts',
    'packages/payments/src/checkout-flow.ts',
    'packages/payments/src/cycle-a.ts',
    'packages/payments/src/cycle-b.ts',
    'packages/api/package.json',
    'packages/api/src/routes.ts',
    'packages/api/src/charge.ts',
    'packages/api/src/handlers.ts',
    'packages/api/src/handlers/refund.ts',
    'packages/api/src/report.js',
    'apps/web/package.json',
    'apps/web/src/checkout.ts',
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(rel(f)), `missing fixture file: ${f}`);
  }
});

test('fixture: package privacy matches the golden contract', () => {
  const payments = JSON.parse(readFixture('packages/payments/package.json'));
  assert.equal(payments.name, '@fx/payments');
  assert.equal(payments.main, 'src/index.ts');
  assert.notEqual(payments.private, true, 'payments must not be private (public-export-surface)');

  for (const p of [
    'packages/shared/package.json',
    'packages/api/package.json',
    'apps/web/package.json',
  ]) {
    const pkg = JSON.parse(readFixture(p));
    assert.equal(pkg.private, true, `${p} must be private`);
  }
});

test('fixture: barrel exports only fee and PaymentService', () => {
  const index = readFixture('packages/payments/src/index.ts');
  assert.ok(index.includes("export * from './fee'"));
  assert.ok(index.includes("export { default as PaymentService } from './service'"));
  const forbidden = /from '\.\/(processor|stripe|manual|checkout-flow|cycle-a|cycle-b)/;
  assert.doesNotMatch(
    index,
    forbidden,
    'barrel must not export processor/stripe/manual/checkout-flow/cycle files',
  );
});
