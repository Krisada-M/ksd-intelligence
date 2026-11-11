import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { PROVIDERS, catalog, lookupSkill, skillIdsOf } from '../../src/workflow/catalog.js';
import { sha256Hex } from '../../src/workflow/loader.js';
import type { SkillsLock } from '../../src/workflow/sources.js';
import { WorkflowError, type ProviderId, type SkillId } from '../../src/workflow/types.js';

export const FRONTMATTER_BODY = (name: string, body: string): string => `---\nname: ${name}\n---\n${body}`;

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(resolve(tmpdir(), `ksd-${prefix}-`));
}

export async function cleanup(...dirs: string[]): Promise<void> {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}

export function skillPath(root: string, id: string): string {
  const entry = lookupSkill(id);
  if (!entry) throw new WorkflowError('NOT_ALLOWLISTED', `fixture: ${id} not in catalog`);
  return resolve(root, PROVIDERS[entry.provider].rootSubpath, entry.path);
}

export async function writeSkillFile(root: string, id: string, content: string): Promise<string> {
  const file = skillPath(root, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

// A lock with every skill unpinned; tests override single entries.
export function emptyLock(): SkillsLock {
  const provider = (id: ProviderId): SkillsLock['providers'][ProviderId] => ({
    repo: PROVIDERS[id].repo,
    commit: null,
    rootSubpath: PROVIDERS[id].rootSubpath,
    skills: Object.fromEntries(skillIdsOf(id).map((skillId) => [skillId, { sha256: null }])),
  });
  return { version: 1, providers: { matt: provider('matt'), poteto: provider('poteto'), osmani: provider('osmani') } };
}

export function lockWithHash(id: SkillId, content: string): SkillsLock {
  const lock = emptyLock();
  const entry = catalog[id];
  lock.providers[entry.provider].skills[id] = { sha256: sha256Hex(Buffer.from(content)) };
  return lock;
}

