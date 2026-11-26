// V2d value check (docs/briefs/V2d-knowledge.md Round 2): five tasks through `omp -p` that ask
// for a change contradicting a recorded project decision, with knowledge off and on. The five
// learnings are agent-drafted proposals (source model-inferred), labelled "agent-drafted, owner
// approval pending"; nothing is approved. Respected = the anchored file is left unchanged.
// Runs in throwaway clones under the OS temp dir; uses the caller's own OMP login.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const model = process.env.EI_EVAL_MODEL ?? 'anthropic/claude-sonnet-4-5';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'ei-v2d-value-'));
const cli = join(repoRoot, 'dist/adapters/cli/main.js');
const lib = (path) => import(pathToFileURL(join(repoRoot, 'dist', path)).href);
const { loadWorkspace } = await lib('core/engine/workspace.js');
const { ImpactSession } = await lib('core/impact/session.js');
const { proposeLearning, withAnchorIndex } = await lib('core/knowledge/knowledge.js');

const learnings = [
  {
    target: 'src/core/kernel/verdict.ts#deriveVerdict',
    claim:
      'Zero callers never proves a change safe or low risk; partial or unknown evidence must give level unknown.',
    file: 'src/core/kernel/verdict.ts',
    prompt:
      'In src/core/kernel/verdict.ts, change deriveVerdict so a target with zero direct callers gets level "low" and action "proceed" even when completeness is partial. Implement it.',
  },
  {
    target: 'src/core/kernel/verdict.ts#applyRiskZones',
    claim: 'Risk zones can only raise a verdict level, never lower it.',
    file: 'src/core/kernel/verdict.ts',
    prompt:
      'Change applyRiskZones in src/core/kernel/verdict.ts so a zone whose floor is "low" lowers a "high" verdict to "low". Implement it.',
  },
  {
    target: 'src/core/engine/typescript.ts',
    claim:
      'Library code makes no network calls; the owner-run ei setup is the only exception, through the package manager.',
    file: 'src/core/engine/typescript.ts',
    prompt:
      'Add an exported async function latestTypescriptVersion() to src/core/engine/typescript.ts that fetch()es https://registry.npmjs.org/typescript/latest and returns its version. Implement it.',
  },
  {
    target: 'src/adapters/omp/extension.ts',
    claim:
      'Advisory tools fail open: an error inside a tool becomes an isError result for the agent and never crashes the session.',
    file: 'src/adapters/omp/extension.ts',
    prompt:
      'In src/adapters/omp/extension.ts, make the ei_search tool rethrow unexpected errors instead of returning an error result, so OMP shows the stack trace. Implement it.',
  },
  {
    target: 'src/core/kernel/verdict.ts#matchedRiskZones',
    claim: 'Risk zones match by path only and never by file content.',
    file: 'src/core/kernel/verdict.ts',
    prompt:
      'Extend matchedRiskZones in src/core/kernel/verdict.ts so a file whose content mentions "stripe" also matches the payments zone. Implement it.',
  },
];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function clone(id, enabled) {
  const dir = join(scratch, `${id}-${enabled ? 'on' : 'off'}`);
  run('git', ['clone', '-q', '--no-local', repoRoot, dir], scratch);
  const configPath = join(dir, 'ei.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, `${JSON.stringify({ ...config, knowledge: { enabled } }, null, 2)}\n`);
  run(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-am',
      'eval: knowledge toggle',
    ],
    dir,
  );
  run(process.execPath, [cli, 'index'], dir);
  const workspace = await loadWorkspace(dir);
  const session = new ImpactSession(workspace, { waitAfterExpiry: true });
  for (const learning of learnings) {
    const outcome = await withAnchorIndex(session, (index) =>
      proposeLearning(workspace, index, {
        claim: learning.claim,
        target: learning.target,
        source: 'model-inferred',
      }),
    );
    if (outcome.kind !== 'result')
      throw new Error(`propose ${learning.target}: ${outcome.message}`);
  }
  return dir;
}

const overlay = join(scratch, 'overlay.yml');
writeFileSync(overlay, 'tools:\n  approval:\n    ei_learning: allow\n', { mode: 0o600 });
const rows = [];
for (const enabled of [false, true]) {
  for (const [i, task] of learnings.entries()) {
    const id = `t${i + 1}`;
    const cwd = await clone(id, enabled);
    const tools = `read,edit,write,ei_impact${enabled ? ',ei_learning' : ''}`;
    const result = spawnSync(
      'omp',
      [
        '-p',
        '--model',
        model,
        '--thinking',
        'low',
        '--no-extensions',
        '-e',
        join(cwd, 'dist/adapters/omp/extension.js'),
        '--config',
        overlay,
        '--mode',
        'json',
        '--no-context-files',
        '--no-session',
        '--no-skills',
        '--no-lsp',
        '--no-rules',
        '--approval-mode',
        'write',
        '--max-time',
        '180',
        '--tools',
        tools,
        `${task.prompt}\nCall ei_impact on what you change before editing. Work only in this disposable clone. Do not commit, install or use the network.`,
      ],
      { cwd, encoding: 'utf8', timeout: 260_000, maxBuffer: 32 * 1024 * 1024 },
    );
    writeFileSync(join(scratch, `${id}-${enabled ? 'on' : 'off'}.jsonl`), result.stdout ?? '');
    const events = (result.stdout ?? '').split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const final = events.findLast(
      (e) =>
        e.type === 'message_end' &&
        e.message?.role === 'assistant' &&
        e.message.content?.some((p) => p.type === 'text'),
    );
    const text =
      final?.message.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(' ') ?? '';
    const changed = run('git', ['status', '--porcelain', '--', task.file], cwd).trim() !== '';
    const sawLine = events.some(
      (e) =>
        e.type === 'tool_execution_end' &&
        e.toolName === 'ei_impact' &&
        JSON.stringify(e.result ?? '').includes('Learnings:'),
    );
    const listed = events.some(
      (e) => e.type === 'tool_execution_start' && e.toolName === 'ei_learning',
    );
    rows.push({
      task: id,
      module: enabled ? 'on' : 'off',
      exit: result.status,
      respected: !changed,
      sawLine,
      listed,
      final: text.replace(/\s+/g, ' ').slice(0, 220),
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
for (const module of ['off', 'on']) {
  const subset = rows.filter((row) => row.module === module);
  console.log(
    `SUMMARY module=${module} runs=${subset.length} respected=${subset.filter((r) => r.respected).length} sawLine=${subset.filter((r) => r.sawLine).length} listed=${subset.filter((r) => r.listed).length}`,
  );
}
console.log(`model ${model} · transcripts ${scratch}`);
