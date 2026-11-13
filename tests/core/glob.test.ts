import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchAny, matchGlob } from '../../src/core/kernel/glob.js';

type Row = readonly [pattern: string, path: string, expected: boolean];

const matchGlobRows: readonly Row[] = [
  // literals and wildcards
  ['src/a.ts', 'src/a.ts', true],
  ['src/a.ts', 'src/axts', false],
  ['*.ts', 'a.ts', true],
  ['*.ts', 'src/a.ts', false],
  ['src/*', 'src/a/b.ts', false],
  ['a?c', 'abc', true],
  ['a?c', 'a/c', false],
  ['a?c', 'ac', false],
  ['(a)+[b].ts', '(a)+[b].ts', true],
  ['a.ts', 'aXts', false],

  // ** as a whole segment
  ['**', 'a/b/c.ts', true],
  ['**/a.ts', 'a.ts', true],
  ['**/a.ts', 'x/y/a.ts', true],
  ['**/a.ts', 'x/ba.ts', false],
  ['src/**', 'src/a/b.ts', true],
  ['src/**', 'src', false],
  ['src/**/c.ts', 'src/c.ts', true],
  ['src/**/c.ts', 'src/a/b/c.ts', true],
  ['src/**/c.ts', 'lib/c.ts', false],
  ['a**b', 'a/b', false],
  ['a**b', 'axxb', true],

  // alternation
  ['*.{ts,tsx}', 'a.tsx', true],
  ['*.{ts,tsx}', 'a.js', false],
  ['{src,lib}/**', 'lib/x/y.ts', true],
  ['{src,lib}/**', 'bin/x.ts', false],
  ['x.{a,{b,c}}', 'x.c', true],
  ['x.{a,{b,c}}', 'x.d', false],
  ['{**/a,b}.ts', 'q/a.ts', true],
  ['a{b', 'a{b', true],
  ['a,b', 'a,b', true],

  // docs/RISK.md §2.1 zone patterns
  ['**/payments/**', 'packages/payments/src/fee.ts', true],
  ['**/payments/**', 'payments/fee.ts', true],
  ['**/payments/**', 'packages/payment/src/fee.ts', false],
  ['**/billing/**', 'apps/web/billing/page.tsx', true],
  ['**/subscription*/**', 'src/subscriptions/plan.ts', true],
  ['**/subscription*/**', 'src/subscription/plan.ts', true],
  ['**/subscription*/**', 'src/sub/plan.ts', false],
  ['**/auth/**', 'packages/api/src/auth/login.ts', true],
  ['**/session*/**', 'src/sessions/store.ts', true],
  ['**/middleware.ts', 'middleware.ts', true],
  ['**/middleware.ts', 'src/middleware.ts', true],
  ['**/middleware.ts', 'src/middleware.tsx', false],
  ['**/migrations/**', 'db/migrations/001_init.sql', true],
  ['**/*.sql', 'db/001_init.sql', true],
  ['**/*.sql', 'init.sql', true],
  ['**/*.sql', 'db/init.sqlx', false],
  ['**/schema.prisma', 'prisma/schema.prisma', true],
  ['**/drizzle/**', 'apps/api/drizzle/0000.ts', true],
  ['**/.env*', '.env', true],
  ['**/.env*', 'apps/web/.env.local', true],
  ['**/.env*', 'apps/web/env.local', false],
  ['**/*production*.{json,ts,yaml,yml}', 'config/app.production.yaml', true],
  ['**/*production*.{json,ts,yaml,yml}', 'production.json', true],
  ['**/*production*.{json,ts,yaml,yml}', 'config/production.toml', false],

  // docs/RISK.md §6 default index excludes
  ['**/*.pem', 'certs/server.pem', true],
  ['**/*.key', 'server.key', true],
  ['**/*credentials*', 'infra/aws-credentials.json', true],
  ['**/secrets/**', 'infra/secrets/a.txt', true],
  ['**/node_modules/**', 'packages/a/node_modules/x/index.js', true],
  ['**/dist/**', 'packages/a/dist/index.js', true],
  ['**/.git/**', '.git/HEAD', true],

  // src/core/workspace/init.ts include and route globs
  ['packages/**', 'packages/a/src/x.ts', true],
  ['packages/**', 'apps/a/src/x.ts', false],
  ['apps/**', 'apps/web/page.tsx', true],
  ['src/**', 'src/index.ts', true],
  ['src/routes.ts', 'src/routes.ts', true],
  ['src/app/api/**/route.{ts,tsx,js,jsx}', 'src/app/api/users/route.ts', true],
  ['src/app/api/**/route.{ts,tsx,js,jsx}', 'src/app/api/route.js', true],
  ['src/app/api/**/route.{ts,tsx,js,jsx}', 'src/app/api/users/[id]/route.tsx', true],
  ['src/app/api/**/route.{ts,tsx,js,jsx}', 'src/app/api/users/page.ts', false],
  ['src/pages/api/**/*.{ts,tsx,js,jsx}', 'src/pages/api/hello.ts', true],
  ['src/pages/api/**/*.{ts,tsx,js,jsx}', 'src/pages/api/a/b.jsx', true],
  ['src/pages/api/**/*.{ts,tsx,js,jsx}', 'src/pages/index.ts', false],
  ['app/api/**/route.{ts,tsx,js,jsx}', 'app/api/x/route.ts', true],
  ['pages/api/**/*.{ts,tsx,js,jsx}', 'pages/api/x.js', true],
  ['packages/api/src/routes.ts', 'packages/api/src/routes.ts', true],
  ['packages/api/src/routes.ts', 'packages/api/src/routes.tsx', false],
];

describe('matchGlob', () => {
  for (const [pattern, path, expected] of matchGlobRows) {
    it(`${pattern} ${expected ? 'matches' : 'does not match'} ${path}`, () => {
      assert.equal(matchGlob(pattern, path), expected);
    });
  }

  it('treats a leading ! as a literal; negation belongs to matchAny', () => {
    assert.equal(matchGlob('!a.ts', 'a.ts'), false);
    assert.equal(matchGlob('!a.ts', '!a.ts'), true);
  });
});

describe('matchAny', () => {
  const rows: ReadonlyArray<readonly [string, string[], string, boolean]> = [
    ['no patterns', [], 'a.ts', false],
    ['one hit among several', ['x/**', '**/*.ts'], 'src/a.ts', true],
    ['no hit', ['x/**', '**/*.js'], 'src/a.ts', false],
    ['negation removes a positive hit', ['src/**', '!**/*.test.ts'], 'src/a.test.ts', false],
    ['negation leaves other paths', ['src/**', '!**/*.test.ts'], 'src/a.ts', true],
    ['negation first, order does not matter', ['!**/*.test.ts', 'src/**'], 'src/a.test.ts', false],
    ['only negations match nothing', ['!**/*.test.ts'], 'src/a.ts', false],
    ['negated alternation', ['**', '!**/{dist,node_modules}/**'], 'a/dist/x.js', false],
    ['negated alternation, other path', ['**', '!**/{dist,node_modules}/**'], 'a/src/x.js', true],
  ];

  for (const [name, patterns, path, expected] of rows) {
    it(name, () => {
      assert.equal(matchAny(patterns, path), expected);
    });
  }
});
