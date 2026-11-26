import { parseYamlSubset, serializeYamlSubset } from './yaml.js';

export const LEARNING_SOURCES = [
  'owner-confirmed',
  'code-observed',
  'test-verified',
  'model-inferred',
] as const;
export type LearningSource = (typeof LEARNING_SOURCES)[number];

/** DESIGN §7.7 plus `anchor.contentHash`; status is computed on read, never stored. */
export interface Learning {
  id: string;
  claim: string;
  anchor: { kind: 'symbol' | 'file'; key: string; contentHash: string };
  source: LearningSource;
  createdAt: string;
  reviewedAt?: string;
  supersedes?: string;
}

export const LEARNING_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_CLAIM_CHARS = 1_000;

const KNOWN_TOP = new Set([
  'id',
  'claim',
  'anchor',
  'source',
  'createdAt',
  'reviewedAt',
  'supersedes',
  'status',
]);
const KNOWN_ANCHOR = new Set(['kind', 'key', 'contentHash']);

export type ParsedLearning =
  { ok: true; learning: Learning; warnings: string[] } | { ok: false; message: string };

function isSource(value: string): value is LearningSource {
  return LEARNING_SOURCES.some((source) => source === value);
}

/** Reads one learning file; unknown fields are reported and ignored, missing ones reject it. */
export function parseLearning(text: string): ParsedLearning {
  const parsed = parseYamlSubset(text);
  if (!parsed.ok) return parsed;
  const map = parsed.value;
  const warnings = Object.keys(map)
    .filter((key) => !KNOWN_TOP.has(key))
    .map((key) => `unknown field "${key}" ignored`);
  const anchor = map.anchor;
  if (typeof anchor !== 'object') return { ok: false, message: 'missing field "anchor"' };
  warnings.push(
    ...Object.keys(anchor)
      .filter((key) => !KNOWN_ANCHOR.has(key))
      .map((key) => `unknown field "anchor.${key}" ignored`),
  );
  const { id, claim, source, createdAt, reviewedAt, supersedes } = map;
  for (const [name, value] of [
    ['id', id],
    ['claim', claim],
    ['source', source],
    ['createdAt', createdAt],
    ['anchor.kind', anchor.kind],
    ['anchor.key', anchor.key],
    ['anchor.contentHash', anchor.contentHash],
  ] as const) {
    if (typeof value !== 'string' || value === '')
      return { ok: false, message: `missing field "${name}"` };
  }
  if (typeof id !== 'string' || !LEARNING_ID_RE.test(id))
    return { ok: false, message: 'invalid id' };
  if (typeof source !== 'string' || !isSource(source))
    return { ok: false, message: 'invalid source' };
  if (anchor.kind !== 'symbol' && anchor.kind !== 'file')
    return { ok: false, message: 'invalid anchor.kind' };
  if (typeof claim !== 'string' || typeof createdAt !== 'string')
    return { ok: false, message: 'invalid field' };
  if (typeof anchor.key !== 'string' || typeof anchor.contentHash !== 'string') {
    return { ok: false, message: 'invalid anchor' };
  }
  if (
    supersedes !== undefined &&
    (typeof supersedes !== 'string' || !LEARNING_ID_RE.test(supersedes))
  ) {
    return { ok: false, message: 'invalid supersedes' };
  }
  return {
    ok: true,
    warnings,
    learning: {
      id,
      claim,
      anchor: { kind: anchor.kind, key: anchor.key, contentHash: anchor.contentHash },
      source,
      createdAt,
      ...(typeof reviewedAt === 'string' ? { reviewedAt } : {}),
      ...(typeof supersedes === 'string' ? { supersedes } : {}),
    },
  };
}

export function serializeLearning(learning: Learning): string {
  return serializeYamlSubset([
    ['id', learning.id],
    ['claim', learning.claim],
    [
      'anchor',
      [
        ['kind', learning.anchor.kind],
        ['key', learning.anchor.key],
        ['contentHash', learning.anchor.contentHash],
      ],
    ],
    ['source', learning.source],
    ['createdAt', learning.createdAt],
    ...(learning.reviewedAt === undefined
      ? []
      : [['reviewedAt', learning.reviewedAt] as [string, string]]),
    ...(learning.supersedes === undefined
      ? []
      : [['supersedes', learning.supersedes] as [string, string]]),
  ]);
}
