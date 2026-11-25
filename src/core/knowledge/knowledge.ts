import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectConfig } from '../kernel/config.js';
import { isRecord } from '../kernel/guards.js';
import {
  anchorIndexFromDb,
  currentAnchorHash,
  evaluateLearnings,
  type AnchorIndex,
  type EvaluatedLearning,
} from './anchors.js';
import { MAX_CLAIM_CHARS, type Learning } from './learning.js';
import { newLearningId, readLearnings, readProposals, writeProposal } from './store.js';
import { impactLearningsLine as learningsLine, learningsFor } from './render.js';

export interface KnowledgeWorkspace {
  root: string;
  cacheDir: string;
  config: ProjectConfig;
}

/** The part of `ImpactSession` anchors need: a fresh (or explicitly stale) index database. */
export interface IndexProvider {
  prepareForSearch(options?: { signal?: AbortSignal }): Promise<{
    db: DatabaseSync | null;
    indexState: 'fresh' | 'updated' | 'stale' | 'building' | 'failed';
  }>;
}

export interface KnowledgeSnapshot {
  learnings: EvaluatedLearning[];
  proposals: EvaluatedLearning[];
  problems: string[];
}

/** Runs `fn` with an anchor index only when the index is current; otherwise with null. */
export async function withAnchorIndex<T>(
  provider: IndexProvider,
  fn: (index: AnchorIndex | null) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const ctx = await provider.prepareForSearch({ signal });
  try {
    // A stale or failed index could point at the wrong lines; anchors then stay unchecked.
    const current = ctx.db !== null && (ctx.indexState === 'fresh' || ctx.indexState === 'updated');
    return await fn(current && ctx.db !== null ? anchorIndexFromDb(ctx.db) : null);
  } finally {
    ctx.db?.close();
  }
}

export async function snapshot(
  ws: KnowledgeWorkspace,
  index: AnchorIndex | null,
): Promise<KnowledgeSnapshot> {
  const repo = readLearnings(ws.root);
  const proposed = readProposals(ws.cacheDir);
  return {
    learnings: await evaluateLearnings(repo.learnings, ws.root, index),
    proposals: await evaluateLearnings(proposed.learnings, ws.root, index),
    problems: [...repo.problems, ...proposed.problems.map((problem) => `proposal ${problem}`)],
  };
}

export type ProposeOutcome =
  { kind: 'result'; value: Learning } | { kind: 'failure'; code: 'INVALID_INPUT'; message: string };

const PROPOSE_SOURCES = ['model-inferred', 'code-observed'] as const;

function invalid(message: string): ProposeOutcome {
  return { kind: 'failure', code: 'INVALID_INPUT', message };
}

async function insideRoot(root: string, path: string): Promise<boolean> {
  if (path === '' || path.startsWith('/') || path.split(/[\\/]/).includes('..')) return false;
  const rootReal = await realpath(root);
  const real = await realpath(join(root, path)).catch(() => null);
  if (real === null || !real.startsWith(`${rootReal}${sep}`)) return false;
  return (await stat(real)).isFile();
}

/**
 * Records an agent proposal in the cache. `target` is a symbol key (`path#name`) or a
 * repository file path; the anchor hash is taken now, from the code as it is.
 */
export async function proposeLearning(
  ws: KnowledgeWorkspace,
  index: AnchorIndex | null,
  raw: unknown,
  now: Date = new Date(),
): Promise<ProposeOutcome> {
  if (!isRecord(raw)) return invalid('expected { claim, target, source }');
  const { claim, target, source } = raw;
  if (typeof claim !== 'string' || claim.trim() === '' || claim.includes('\0')) {
    return invalid('claim must be non-empty text');
  }
  if (claim.length > MAX_CLAIM_CHARS)
    return invalid(`claim longer than ${MAX_CLAIM_CHARS} characters`);
  const kind = PROPOSE_SOURCES.find((entry) => entry === source);
  if (kind === undefined) return invalid('source must be "model-inferred" or "code-observed"');
  if (typeof target !== 'string' || target.trim() === '')
    return invalid('target must be path#name or a file path');
  const key = target.trim();
  const anchorKind = key.includes('#') ? 'symbol' : 'file';
  if (anchorKind === 'file' && !(await insideRoot(ws.root, key))) {
    return invalid(`${key} is not a file in this repository`);
  }
  if (anchorKind === 'symbol' && index === null) {
    return invalid('index not current; call again after ei_status shows it ready');
  }
  const hash = await currentAnchorHash(ws.root, { kind: anchorKind, key, contentHash: '' }, index);
  if (hash === null || hash === 'unknown') return invalid(`${key} not found in the index`);
  const learning: Learning = {
    id: newLearningId(claim),
    claim: claim.trim(),
    anchor: { kind: anchorKind, key, contentHash: hash },
    source: kind,
    createdAt: now.toISOString(),
  };
  writeProposal(ws.cacheDir, learning);
  return { kind: 'result', value: learning };
}

/**
 * The line `ei_impact` appends for these symbol keys, or undefined when knowledge is disabled
 * or nothing is recorded for them (so the V1 text is unchanged).
 */
export async function impactLearningsLine(
  ws: KnowledgeWorkspace,
  provider: IndexProvider,
  keys: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!ws.config.knowledge.enabled || keys.length === 0) return undefined;
  try {
    const snap = await withAnchorIndex(provider, (index) => snapshot(ws, index), signal);
    return learningsLine(learningsFor(snap.learnings, keys), learningsFor(snap.proposals, keys));
  } catch (error) {
    return `Learnings: unavailable (${error instanceof Error ? error.message : String(error)}); call ei_learning list.`;
  }
}
