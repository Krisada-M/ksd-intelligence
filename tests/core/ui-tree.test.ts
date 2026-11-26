import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  renderResultView,
  terminalViewOptions,
  type ViewOptions,
} from '../../src/adapters/ui/tree.js';
import type { ImpactBatch } from '../../src/core/impact/session.js';
import type { WorkspaceStatus } from '../../src/core/engine/status.js';
import type {
  ChangesResult,
  ImpactNode,
  ImpactResult,
  SearchResult,
} from '../../src/core/kernel/types.js';
import type { AuditSummary } from '../../src/core/audit/summary.js';
import type { SkillDiscoveryResult } from '../../src/workflow/packs.js';

const options: ViewOptions = { columns: 80, color: false, ascii: false };
const stamp = { version: '1.1.0', typescript: '5.9.3', extractor: '1' };

function node(symbol: string, file: string, startLine: number): ImpactNode {
  return {
    symbol,
    via: 'CALLS',
    strength: 'compiler',
    span: { file, startLine, endLine: startLine },
  };
}

function impact(nodes: ImpactNode[]): ImpactBatch {
  const result: ImpactResult = {
    target: 'packages/payments/src/fee.ts#calculateFee',
    byDepth: [nodes, [node('routes.POST', 'packages/api/src/routes.ts', 3)]],
    bridged: [],
    tests: ['packages/payments/tests/fee.test.ts'],
    completeness: { status: 'partial', reasons: ['computed-member-access: dynamic registry'] },
    reach: {
      direct: nodes.length,
      total: nodes.length + 1,
      files: 3,
      packages: 2,
      crossPackage: true,
      routes: 1,
    },
    factors: ['public-export-surface', 'route', 'cross-package'],
    limits: { unboundedDynamicImports: 0, excludedFiles: 1, failedFiles: 0 },
    scannedFiles: 26,
    verdict: {
      level: 'medium',
      action: 'run-tests',
      zones: [],
      requiredActions: ['run fee.test.ts before reporting'],
      basis: ['route'],
    },
    freshness: { workingTreeHash: 'hash', includesUntracked: false },
    engine: stamp,
  };
  return {
    answers: [{ input: result.target, kind: 'result', value: result }],
    index: { state: 'fresh', updatedFiles: 0, driftedFiles: [] },
  };
}

const callers = [
  node('submit', 'packages/checkout/src/checkout.ts', 4),
  node('chargeHandler', 'packages/payments/src/checkout.ts', 3),
];

describe('terminal result view', () => {
  it('renders nested depth and deterministic path suffixes at 80 and 120 columns', () => {
    for (const columns of [80, 120]) {
      const lines = renderResultView(
        { kind: 'impact', value: impact(callers) },
        { ...options, columns },
      );
      assert.equal(lines[0], '⚠ calculateFee run-tests · medium · partial');
      assert.ok(lines.some((line) => line.includes('├─ callers')));
      assert.ok(lines.some((line) => line.includes('depth 2')));
      assert.ok(lines.some((line) => line.includes('checkout/src/checkout.ts:4')));
      assert.ok(lines.some((line) => line.includes('payments/src/checkout.ts:3')));
      assert.match(lines.at(-1) ?? '', /index fresh · 26 files · engine 1\.1\.0/);
    }
  });

  it('puts locations on separate lines below 60 columns and keeps names intact', () => {
    const lines = renderResultView(
      { kind: 'impact', value: impact(callers) },
      { ...options, columns: 50 },
    );
    const submit = lines.findIndex((line) => /[├└]─ submit$/.test(line));
    assert.ok(submit >= 0);
    assert.match(lines[submit + 1] ?? '', /checkout\/src\/checkout\.ts:4$/);
    assert.ok(lines.some((line) => line.includes('computed-member-access: dynamic registry')));
  });

  it('folds each long list after ten rows without claiming omitted search results', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      node(`caller${String(index).padStart(2, '0')}`, `src/caller${index}.ts`, index + 1),
    );
    const folded = renderResultView({ kind: 'impact', value: impact(many) }, options).join('\n');
    assert.match(folded, /caller09/);
    assert.doesNotMatch(folded, /caller10/);
    assert.match(folded, /\+ 2 more \(--all\)/);
    assert.match(
      renderResultView({ kind: 'impact', value: impact(many) }, { ...options, all: true }).join(
        '\n',
      ),
      /caller11/,
    );

    const search: SearchResult = {
      query: 'foo',
      limit: 10,
      totalMatches: 20,
      hits: [],
      indexState: 'fresh',
      engine: stamp,
    };
    const text = renderResultView(
      { kind: 'search', value: { kind: 'result', value: search } },
      options,
    ).join('\n');
    assert.match(text, /20 matches/);
    assert.match(text, /20 matches outside retrieved limit 10/);
    assert.doesNotMatch(text, /\+ 20 more \(--all\)/);
  });

  it('uses ASCII and explicit words without relying on colour', () => {
    const plain = renderResultView(
      { kind: 'impact', value: impact(callers) },
      { ...options, ascii: true },
    );
    assert.match(plain[0] ?? '', /^! calculateFee run-tests · medium · partial$/);
    assert.ok(plain.some((line) => line.startsWith('|- callers')));
    assert.ok(plain.some((line) => line.includes('\\- depth 2')));
    assert.doesNotMatch(plain.join('\n'), /[\u001b├└│✓⚠✗]/u);
    const colored = renderResultView(
      { kind: 'impact', value: impact(callers) },
      { ...options, color: true },
    );
    assert.match(colored[0] ?? '', /\u001b\[33m⚠\u001b\[0m/);
    assert.match(colored[0] ?? '', /run-tests/);
    assert.equal(
      renderResultView({ kind: 'impact', value: impact(callers) }, { ...options, collapsed: true })
        .length,
      1,
    );
  });

  it('measures Thai combining marks and wide paths, escapes terminal controls', () => {
    const thai = node('ตรวจสอบ', 'packages/ชำระเงิน/src/表.ts', 8);
    const text = renderResultView(
      { kind: 'impact', value: impact([thai]) },
      { ...options, columns: 60 },
    );
    assert.ok(text.some((line) => line.includes('ตรวจสอบ 表.ts:8')));
    const malicious = impact([node('fee\u001b[2J\nq', 'src/evil\u001b[31m.ts', 5)]);
    const output = renderResultView(
      { kind: 'impact', value: malicious },
      { ...options, color: true },
    ).join('\n');
    assert.doesNotMatch(output, /\u001b\[2J|\u001b\[31m\.ts/);
    assert.match(output, /fee\\u\{1b\}\[2J\\nq/);
    assert.match(output, /evil\\u\{1b\}\[31m\.ts/);
  });

  it('distinguishes guidance and failure from evidence-bearing results', () => {
    const batch = impact(callers);
    batch.answers = [
      {
        input: 'fee',
        kind: 'guidance',
        code: 'ambiguous-target',
        message: 'select exact key',
        candidates: ['one', 'two'],
      },
      { input: 'secret', kind: 'failure', code: 'index-failed', message: 'index unavailable' },
    ];
    const text = renderResultView({ kind: 'impact', value: batch }, options).join('\n');
    assert.match(text, /\? fee ambiguous-target: select exact key/);
    assert.match(text, /✗ secret index-failed: index unavailable/);
    assert.doesNotMatch(text, /reach |index fresh/);
    assert.match(
      renderResultView(
        {
          kind: 'changes',
          value: { kind: 'guidance', code: 'index-building', message: 'retry shortly' },
        },
        options,
      )[0] ?? '',
      /retry shortly/,
    );
  });

  it('renders native status and changed-symbol outcomes without inventing evidence', () => {
    const status: WorkspaceStatus = {
      state: 'degraded',
      reason: 'no index',
      fix: 'run: ei index',
      root: '/tmp/repo',
      repoId: 'repo',
      cacheDir: '/tmp/cache',
      config: { path: null, errors: [], zones: [] },
      runtime: { kind: 'node', command: '/usr/bin/node', version: '22.5' },
      memoryLimitMb: 512,
      typescript: { ok: false, reason: 'runtime missing', fix: 'run: ei setup' },
      index: null,
      indexError: null,
      failure: null,
      drift: null,
      lock: null,
    };
    const statusLines = renderResultView({ kind: 'status', value: status }, options).join('\n');
    assert.match(statusLines, /status degraded · no index/);
    assert.match(statusLines, /run: ei index/);
    assert.doesNotMatch(statusLines, /\d+ indexed/);

    const result = impact(callers).answers[0];
    assert.ok(result?.kind === 'result' && 'target' in result.value);
    const changed: ChangesResult = {
      base: 'HEAD',
      changedFiles: [{ path: 'src/fee.ts', status: 'M', indexed: true }],
      changedSymbols: [
        {
          symbol: 'src/fee.ts#calculateFee',
          change: 'modified',
          span: { file: 'src/fee.ts', startLine: 4, endLine: 4 },
        },
      ],
      unindexedChanges: [],
      impact: {
        byDepth: result.value.byDepth,
        tests: result.value.tests,
        completeness: result.value.completeness,
        reach: result.value.reach,
        factors: result.value.factors,
      },
      verdict: result.value.verdict,
      freshness: result.value.freshness,
      engine: stamp,
      limits: result.value.limits,
    };
    const changesLines = renderResultView(
      { kind: 'changes', value: { kind: 'result', value: changed } },
      options,
    ).join('\n');
    assert.match(changesLines, /calculateFee · modified/);
    assert.match(changesLines, /calculateFee · modified fee\.ts:4/);
  });

  it('renders audit and skills from typed values', () => {
    const audit: AuditSummary = {
      since: '7d',
      totalCalls: 4,
      corruptLines: 1,
      filesRead: 2,
      callsByTool: { ei_impact: 3, ei_search: 1 },
      verdictDistribution: { medium: 2 },
      slowestCalls: [],
      changedWithoutPriorImpact: ['src/fee.ts'],
    };
    assert.match(
      renderResultView({ kind: 'audit', value: audit }, options).join('\n'),
      /1 corrupt lines/,
    );
    const discovery: SkillDiscoveryResult = {
      platform: 'omp',
      skills: [],
      autoVisible: [],
      explicitOnly: [],
      shadowed: [],
      issues: [],
    };
    assert.match(
      renderResultView(
        {
          kind: 'skills',
          platform: 'omp',
          discovery,
          registryIssues: [{ code: 'MISSING', message: 'registry entry absent' }],
        },
        options,
      ).join('\n'),
      /MISSING: registry entry absent/,
    );
  });

  it('selects terminal styling only under allowed conditions', () => {
    const base = {
      env: { LANG: 'en_US.UTF-8' },
      columns: 80,
      isTTY: true,
      plain: false,
      json: false,
      all: false,
    };
    assert.deepEqual(terminalViewOptions(base), { ...options, color: true, all: false });
    assert.deepEqual(terminalViewOptions({ ...base, env: { FORCE_COLOR: '0' } }), {
      ...options,
      all: false,
    });
    assert.equal(terminalViewOptions({ ...base, isTTY: false }), undefined);
    assert.equal(
      terminalViewOptions({ ...base, isTTY: false, env: { FORCE_COLOR: '0' } }),
      undefined,
    );
    assert.equal(terminalViewOptions({ ...base, plain: true }), undefined);
    assert.equal(terminalViewOptions({ ...base, json: true }), undefined);
    assert.equal(
      terminalViewOptions({ ...base, env: { NO_COLOR: '', FORCE_COLOR: '1' } }),
      undefined,
    );
    assert.equal(
      terminalViewOptions({ ...base, env: { TERM: 'dumb', FORCE_COLOR: '1' } }),
      undefined,
    );
    assert.deepEqual(
      terminalViewOptions({ ...base, isTTY: false, env: { FORCE_COLOR: '1', EI_ASCII: '1' } }),
      { ...options, color: true, ascii: true, all: false },
    );
  });
});
