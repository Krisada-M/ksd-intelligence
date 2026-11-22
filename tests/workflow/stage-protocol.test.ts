import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { PRECEDENCE_HEADER, renderWorkflow } from '../../src/workflow/render.js';
import type { Stage, Workflow } from '../../src/workflow/types.js';

function findRepoRoot(startUrl: string): string {
  let dir = new URL('.', startUrl).pathname;
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) throw new Error('package.json not found');
    dir = parent;
  }
}

function makeWorkflow(stage: Stage): Workflow {
  return {
    task: 'update billing flow',
    type: 'feature',
    classifiedBy: 'caller',
    stage,
    risk: 'normal',
    skillIds: ['matt:tdd'],
    orchestrator: 'ksd-intelligence',
    primaryPack: 'matt-sdlc',
    secondaryPacks: [],
    secondaryReasons: {},
    optInPacks: [],
    requirementCompliance: { required: false, dimensions: [], trigger: 'none' },
    mayMerge: false,
    mayDeploy: false,
    loaded: [],
    packInstructions: [],
    missing: [],
    ready: true,
  };
}

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('M2c Round 3 — stage protocol & workflow import isolation', () => {
  it('renders RISK §2.5 stage protocol line after Stage: and keeps PRECEDENCE_HEADER first', () => {
    const expected: Record<Stage, string | null> = {
      plan: null,
      investigate:
        "Stage Protocol: Before changing a symbol, call `ei_impact` on it and follow the verdict's action.",
      implement:
        "Stage Protocol: Before changing a symbol, call `ei_impact` on it and follow the verdict's action.",
      verify:
        'Stage Protocol: Run the tests listed by `ei_impact` / `ei_changes`; report real output.',
      review:
        'Stage Protocol: Call `ei_changes` and include its verdict and `unindexedChanges` in your report.',
      ship: 'Stage Protocol: Call `ei_changes` and include its verdict and `unindexedChanges` in your report.',
    };

    for (const stage of Object.keys(expected) as Stage[]) {
      const text = renderWorkflow(makeWorkflow(stage));
      assert.ok(text.startsWith(PRECEDENCE_HEADER), `${stage}: PRECEDENCE_HEADER must come first`);
      const stageLineIdx = text.indexOf(`Stage: ${stage}\n`);
      assert.ok(stageLineIdx > PRECEDENCE_HEADER.length, `${stage}: missing Stage line`);
      const line = expected[stage];
      if (line === null) {
        assert.doesNotMatch(text, /^Stage Protocol:/m, 'plan must have no Stage Protocol line');
      } else {
        const expectedPair = `Stage: ${stage}\n${line}\n`;
        assert.ok(text.includes(expectedPair), `${stage}: expected "${expectedPair}" in:\n${text}`);
      }
    }
  });

  it('AST isolation check: src/workflow/** has zero imports from src/core/impact/** or src/core/changes/** or ../core/', () => {
    const root = findRepoRoot(import.meta.url);
    const workflowDir = join(root, 'src/workflow');
    const files = collectTsFiles(workflowDir);
    assert.ok(files.length > 0, 'expected workflow .ts files');

    const forbidden = ['core/impact', 'core/changes', '../core/'];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      const pre = ts.preProcessFile(content, true, true);
      const specifiers = pre.importedFiles.map((imp) => imp.fileName);

      // Also walk AST for dynamic import() or require() calls
      const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const isImportOrRequire =
            node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require');
          const arg = node.arguments[0];
          if (isImportOrRequire && arg && ts.isStringLiteralLike(arg)) {
            specifiers.push(arg.text);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);

      for (const spec of specifiers) {
        for (const bad of forbidden) {
          assert.ok(
            !spec.includes(bad),
            `Layer violation in ${file}: forbidden import specifier "${spec}"`,
          );
        }
      }
    }
  });
});
