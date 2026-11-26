import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEARNING_ID_RE, parseLearning, serializeLearning, type Learning } from './learning.js';

/** The only repository directory V2 writes to, and only through the owner's CLI commands. */
export const LEARNINGS_DIR = join('.ksd', 'learnings');
const PROPOSALS_DIR = 'learnings-proposed';

export interface LoadedLearnings {
  learnings: Learning[];
  /** Files that were skipped or read with warnings, as `<file>: <message>`. */
  problems: string[];
}

function load(dir: string): LoadedLearnings {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.yaml'));
  } catch {
    return { learnings: [], problems: [] };
  }
  const out: LoadedLearnings = { learnings: [], problems: [] };
  for (const file of files.sort()) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch (error) {
      out.problems.push(
        `${file}: unreadable (${error instanceof Error ? error.message : String(error)})`,
      );
      continue;
    }
    const parsed = parseLearning(text);
    if (!parsed.ok) {
      out.problems.push(`${file}: skipped (${parsed.message})`);
      continue;
    }
    if (`${parsed.learning.id}.yaml` !== file) {
      out.problems.push(
        `${file}: skipped (id "${parsed.learning.id}" does not match the file name)`,
      );
      continue;
    }
    out.problems.push(...parsed.warnings.map((warning) => `${file}: ${warning}`));
    out.learnings.push(parsed.learning);
  }
  return out;
}

export function readLearnings(root: string): LoadedLearnings {
  return load(join(root, LEARNINGS_DIR));
}

export function readProposals(cacheDir: string): LoadedLearnings {
  return load(join(cacheDir, PROPOSALS_DIR));
}

function slug(claim: string): string {
  const words = claim.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return words.slice(0, 5).join('-').slice(0, 40).replace(/-+$/, '');
}

export function newLearningId(claim: string): string {
  const base = slug(claim);
  return `${base === '' ? 'learning' : base}-${randomBytes(3).toString('hex')}`;
}

// Cache files are private; repository files keep ordinary modes so they commit like any file.
function writeAtomic(dir: string, learning: Learning, cache: boolean): void {
  if (!LEARNING_ID_RE.test(learning.id))
    throw new Error(`knowledge: invalid learning id "${learning.id}"`);
  mkdirSync(dir, { recursive: true, ...(cache ? { mode: 0o700 } : {}) });
  const target = join(dir, `${learning.id}.yaml`);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, serializeLearning(learning), cache ? { mode: 0o600 } : {});
  renameSync(temp, target);
}

/** Agent proposals go to the private cache only; this has no path into the repository. */
export function writeProposal(cacheDir: string, learning: Learning): void {
  writeAtomic(join(cacheDir, PROPOSALS_DIR), learning, true);
}

function findProposal(cacheDir: string, id: string): Learning {
  const proposal = readProposals(cacheDir).learnings.find((entry) => entry.id === id);
  if (proposal === undefined) throw new Error(`knowledge: no proposal "${id}"`);
  return proposal;
}

/**
 * Owner-run `ei learning approve`: copies a proposal into `.ksd/learnings/` as
 * owner-confirmed, then removes the proposal. The only code that adds a repository file.
 */
export function approveProposal(
  root: string,
  cacheDir: string,
  id: string,
  now: Date = new Date(),
): Learning {
  const proposal = findProposal(cacheDir, id);
  if (readLearnings(root).learnings.some((entry) => entry.id === id)) {
    throw new Error(`knowledge: learning "${id}" already exists in ${LEARNINGS_DIR}`);
  }
  const approved: Learning = {
    ...proposal,
    source: 'owner-confirmed',
    reviewedAt: now.toISOString(),
  };
  writeAtomic(join(root, LEARNINGS_DIR), approved, false);
  rmSync(join(cacheDir, PROPOSALS_DIR, `${id}.yaml`), { force: true });
  return approved;
}

/** Owner-run `ei learning review`: the owner has read the changed code; record its new hash. */
export function reviewLearning(
  root: string,
  id: string,
  contentHash: string,
  now: Date = new Date(),
): Learning {
  const learning = readLearnings(root).learnings.find((entry) => entry.id === id);
  if (learning === undefined) throw new Error(`knowledge: no learning "${id}" in ${LEARNINGS_DIR}`);
  const reviewed: Learning = {
    ...learning,
    anchor: { ...learning.anchor, contentHash },
    reviewedAt: now.toISOString(),
  };
  writeAtomic(join(root, LEARNINGS_DIR), reviewed, false);
  return reviewed;
}

/** Owner-run `ei learning reject`: deletes a proposal from the cache. */
export function rejectProposal(cacheDir: string, id: string): void {
  findProposal(cacheDir, id);
  rmSync(join(cacheDir, PROPOSALS_DIR, `${id}.yaml`), { force: true });
}
