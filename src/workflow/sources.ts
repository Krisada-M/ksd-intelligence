import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PROVIDERS, skillIdsOf, type ProviderRoots } from './catalog.js';
import { readSkill } from './loader.js';
import { PROVIDER_IDS, WorkflowError, type ProviderId, type WorkflowErrorCode } from './types.js';

const execFileAsync = promisify(execFile);

export interface LockSkill {
  sha256: string | null;
}

export interface LockProvider {
  repo: string;
  commit: string | null;
  rootSubpath: string;
  skills: Record<string, LockSkill>;
}

export interface SkillsLock {
  version: 1;
  providers: Record<ProviderId, LockProvider>;
}

const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// Resolves to <repo>/skills.lock.json from both src/workflow and dist/workflow.
export function defaultLockPath(): string {
  return fileURLToPath(new URL('../../skills.lock.json', import.meta.url));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lockError(message: string): WorkflowError {
  return new WorkflowError('LOCK_INVALID', message);
}

function parseProvider(provider: ProviderId, raw: unknown): LockProvider {
  const where = `providers.${provider}`;
  if (!isRecord(raw)) throw lockError(`${where} must be an object`);
  const info = PROVIDERS[provider];
  const { repo, commit, rootSubpath, skills: rawSkills } = raw;

  if (repo !== info.repo)
    throw lockError(`${where}.repo is ${JSON.stringify(repo)}, catalog expects ${info.repo}`);
  if (rootSubpath !== info.rootSubpath)
    throw lockError(
      `${where}.rootSubpath is ${JSON.stringify(rootSubpath)}, catalog expects ${info.rootSubpath}`,
    );
  if (commit !== null && !(typeof commit === 'string' && COMMIT.test(commit))) {
    throw lockError(`${where}.commit must be null or a 40-char lowercase hex SHA`);
  }
  if (!isRecord(rawSkills)) throw lockError(`${where}.skills must be an object`);

  const expectedIds = skillIdsOf(provider);
  const unknown = Object.keys(rawSkills).filter((id) => !expectedIds.includes(id));
  if (unknown.length > 0)
    throw lockError(`${where}.skills has ids not in the catalog: ${unknown.join(', ')}`);

  const skills: Record<string, LockSkill> = {};
  for (const id of expectedIds) {
    const entry = rawSkills[id];
    if (!isRecord(entry)) throw lockError(`${where}.skills[${id}] missing or not an object`);
    const { sha256 } = entry;
    if (sha256 !== null && !(typeof sha256 === 'string' && SHA256.test(sha256))) {
      throw lockError(`${where}.skills[${id}].sha256 must be null or 64-char lowercase hex`);
    }
    skills[id] = { sha256 };
  }
  return { repo: info.repo, commit, rootSubpath: info.rootSubpath, skills };
}

export function parseLock(text: string): SkillsLock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw lockError(`not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw) || raw.version !== 1) throw lockError('version must be 1');
  const providers = raw.providers;
  if (!isRecord(providers)) throw lockError('providers must be an object');
  return {
    version: 1,
    providers: {
      matt: parseProvider('matt', providers.matt),
      poteto: parseProvider('poteto', providers.poteto),
      osmani: parseProvider('osmani', providers.osmani),
    },
  };
}

export async function readLock(path: string): Promise<SkillsLock> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw lockError(
      `cannot read lock file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseLock(text);
}

export async function writeLock(path: string, lock: SkillsLock): Promise<void> {
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}

export type SourceProblemCode = WorkflowErrorCode | 'NOT_A_GIT_CHECKOUT' | 'COMMIT_MISMATCH';

export interface SourceProblem {
  code: SourceProblemCode;
  message: string;
}

export interface ProviderReport {
  provider: ProviderId;
  root: string | null;
  head: string | null;
  lockCommit: string | null;
  skillsFound: number;
  skillsTotal: number;
  hashesVerified: number;
  problems: SourceProblem[];
  // True when `--write` replaced this provider's commit and hashes in the lock.
  written: boolean;
}

export type ReportStatus = 'OK' | 'UNPINNED' | 'ERROR';

export function reportStatus(report: ProviderReport): ReportStatus {
  if (report.problems.length > 0) return 'ERROR';
  if (report.lockCommit === null || report.hashesVerified < report.skillsTotal) return 'UNPINNED';
  return 'OK';
}

async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD']);
    const head = stdout.trim();
    return COMMIT.test(head) ? head : null;
  } catch {
    return null;
  }
}

interface ProviderFacts {
  root: string | null;
  head: string | null;
  // id -> sha256 of a skill the loader would accept; ids that fail are only in `problems`.
  hashes: Map<string, string>;
  problems: SourceProblem[];
}

async function gatherFacts(provider: ProviderId, roots: ProviderRoots): Promise<ProviderFacts> {
  const ids = skillIdsOf(provider);
  const hashes = new Map<string, string>();
  const problems: SourceProblem[] = [];
  const root = roots[provider];
  const head = root && isAbsolute(root) ? await gitHead(root) : null;

  for (const id of ids) {
    try {
      hashes.set(id, (await readSkill(id, roots)).sha256);
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      problems.push({ code: error.code, message: error.detail });
    }
  }
  // A missing/nonexistent root already yields one problem per skill; collapse them into one.
  const rootProblem = problems.find(
    (p) => p.code === 'PROVIDER_ROOT_MISSING' || p.code === 'PROVIDER_ROOT_NOT_FOUND',
  );
  if (rootProblem) return { root: root ?? null, head, hashes, problems: [rootProblem] };

  if (head === null) {
    problems.push({
      code: 'NOT_A_GIT_CHECKOUT',
      message: `${PROVIDERS[provider].envVar}=${root} has no readable git HEAD`,
    });
  }
  return { root: root ?? null, head, hashes, problems };
}

function reportFor(
  provider: ProviderId,
  facts: ProviderFacts,
  lock: LockProvider,
  written: boolean,
): ProviderReport {
  const problems = [...facts.problems];
  let hashesVerified = 0;
  for (const [id, actual] of facts.hashes) {
    const pinned = lock.skills[id]?.sha256 ?? null;
    if (pinned === null) continue;
    if (pinned === actual) hashesVerified += 1;
    else
      problems.push({
        code: 'HASH_MISMATCH',
        message: `${id}: file sha256 ${actual}, lock pins ${pinned}`,
      });
  }
  if (lock.commit !== null && facts.head !== null && facts.head !== lock.commit) {
    problems.push({
      code: 'COMMIT_MISMATCH',
      message: `checkout HEAD ${facts.head}, lock pins ${lock.commit}`,
    });
  }
  return {
    provider,
    root: facts.root,
    head: facts.head,
    lockCommit: lock.commit,
    skillsFound: facts.hashes.size,
    skillsTotal: skillIdsOf(provider).length,
    hashesVerified,
    problems,
    written,
  };
}

// Never clones or fetches. With `write`, a provider's commit and hashes are replaced only when its
// root exists, HEAD is readable and every catalog skill passes the loader's checks.
export async function checkSources(
  lock: SkillsLock,
  roots: ProviderRoots,
  options: { write: boolean },
): Promise<{ reports: ProviderReport[]; lock: SkillsLock }> {
  const nextProviders: Record<ProviderId, LockProvider> = { ...lock.providers };
  const reports: ProviderReport[] = [];

  for (const provider of PROVIDER_IDS) {
    const facts = await gatherFacts(provider, roots);
    const current = lock.providers[provider];
    const complete = facts.problems.length === 0 && facts.head !== null;
    if (options.write && complete) {
      const skills: Record<string, LockSkill> = {};
      for (const [id, sha256] of facts.hashes) skills[id] = { sha256 };
      nextProviders[provider] = { ...current, commit: facts.head, skills };
    }
    const next = nextProviders[provider];
    reports.push(reportFor(provider, facts, next, options.write && complete));
  }
  return { reports, lock: { version: 1, providers: nextProviders } };
}

function short(sha: string | null): string {
  return sha === null ? '-' : sha.slice(0, 12);
}

export function formatReports(reports: ProviderReport[]): string {
  const rows = [['provider', 'status', 'skills', 'hashes', 'HEAD', 'lock commit', 'codes']];
  for (const r of reports) {
    const codes = [...new Set(r.problems.map((p) => p.code))].join(',') || '-';
    rows.push([
      r.provider,
      reportStatus(r),
      `${r.skillsFound}/${r.skillsTotal}`,
      `${r.hashesVerified}/${r.skillsTotal}`,
      short(r.head),
      short(r.lockCommit),
      codes,
    ]);
  }
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? '').length))) ?? [];
  const lines = rows.map((row) =>
    row
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join('  ')
      .trimEnd(),
  );
  for (const r of reports) {
    for (const p of r.problems) lines.push(`${r.provider}: ${p.code}: ${p.message}`);
    if (r.written)
      lines.push(`${r.provider}: lock updated (commit ${short(r.head)}, ${r.skillsFound} hashes)`);
  }
  return lines.join('\n');
}
