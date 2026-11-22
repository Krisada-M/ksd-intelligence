import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ChangeFileStatus } from '../kernel/types.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 256 * 2 ** 20;

export interface GitDiffEntry {
  path: string;
  status: ChangeFileStatus;
  oldPath?: string;
  isSubmodule: boolean;
  invalidUtf8: boolean;
}

export interface DiffBaseResolution {
  baseLabel: string;
  baseSha: string;
  mergeBase?: string;
  gitPrefix: string;
}

export type GitResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ ok: true; stdout: Buffer } | { ok: false; stderr: string; code: number | null }> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'buffer',
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; code?: number | null; message?: string };
    const stderr = Buffer.isBuffer(err.stderr)
      ? err.stderr.toString('utf8')
      : (err.stderr ?? err.message ?? '');
    return {
      ok: false,
      stderr: stderr.trim(),
      code: typeof err.code === 'number' ? err.code : null,
    };
  }
}

export function validateBaseRef(base: string): string | null {
  const trimmed = base.trim();
  if (trimmed === '') return 'base must be a non-empty git ref';
  if (trimmed.startsWith('-')) return 'base must not start with "-"';
  if (/[\0\r\n]/.test(trimmed)) return 'base contains invalid control characters';
  return null;
}

async function revParseCommit(root: string, ref: string): Promise<string | null> {
  // Always use `--end-of-options` when supported, falling back safely since leading `-` is rejected.
  const first = await runGit(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  if (first.ok) return first.stdout.toString('utf8').trim();
  if (first.stderr.includes('unknown option')) {
    const second = await runGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    return second.ok ? second.stdout.toString('utf8').trim() : null;
  }
  return null;
}

async function resolveDefaultBranch(
  root: string,
): Promise<{ ref: string; display: string } | null> {
  const originHead = await runGit(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
  if (originHead.ok) {
    const full = originHead.stdout.toString('utf8').trim();
    if (full !== '' && (await revParseCommit(root, full)) !== null) {
      const display = full.startsWith('refs/remotes/') ? full.slice('refs/remotes/'.length) : full;
      return { ref: full, display };
    }
  }
  for (const branch of ['main', 'master']) {
    const ref = `refs/heads/${branch}`;
    if ((await revParseCommit(root, ref)) !== null) {
      return { ref, display: branch };
    }
  }
  return null;
}

export async function resolveDiffBase(
  root: string,
  explicitBase?: string,
): Promise<GitResult<DiffBaseResolution>> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.toString('utf8').trim() !== 'true') {
    return { ok: false, message: 'not a git repository; ei_changes requires a git working tree' };
  }

  const headCommit = await revParseCommit(root, 'HEAD');
  if (headCommit === null) {
    return {
      ok: false,
      message: 'repository has no commits yet (unborn HEAD); create an initial commit or pass base',
    };
  }

  const prefixRes = await runGit(root, ['rev-parse', '--show-prefix']);
  const gitPrefix = prefixRes.ok ? prefixRes.stdout.toString('utf8').replace(/\r?\n$/, '') : '';

  if (explicitBase !== undefined) {
    const err = validateBaseRef(explicitBase);
    if (err !== null) return { ok: false, message: err };
    const clean = explicitBase.trim();
    const baseSha = await revParseCommit(root, clean);
    if (baseSha === null) {
      return { ok: false, message: `base ref '${clean}' does not exist or is not a commit` };
    }
    return { ok: true, value: { baseLabel: clean, baseSha, gitPrefix } };
  }

  const headSym = await runGit(root, ['symbolic-ref', '-q', 'HEAD']);
  if (!headSym.ok) {
    return {
      ok: false,
      message: 'HEAD is detached; pass base (e.g. main) to specify what to compare against',
    };
  }

  const branch = await resolveDefaultBranch(root);
  if (branch === null) {
    return {
      ok: false,
      message: 'no default branch found (checked origin/HEAD, main, master); pass base explicitly',
    };
  }

  const mergeBaseRes = await runGit(root, ['merge-base', 'HEAD', branch.ref]);
  if (!mergeBaseRes.ok) {
    return {
      ok: false,
      message: `cannot compute merge-base with ${branch.display} (shallow clone or unrelated history?); fetch full history or pass base explicitly`,
    };
  }
  const mergeBaseSha = mergeBaseRes.stdout.toString('utf8').trim();
  if (mergeBaseSha === '') {
    return {
      ok: false,
      message: `cannot compute merge-base with ${branch.display}; pass base explicitly`,
    };
  }

  return {
    ok: true,
    value: {
      baseLabel: branch.display,
      baseSha: mergeBaseSha,
      mergeBase: mergeBaseSha.slice(0, 7),
      gitPrefix,
    },
  };
}

function splitNulBuffers(buf: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      parts.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

function decodePath(raw: Buffer): { text: string; invalidUtf8: boolean } {
  const text = raw.toString('utf8');
  const invalidUtf8 = Buffer.compare(Buffer.from(text, 'utf8'), raw) !== 0;
  return { text, invalidUtf8 };
}

function normalizeStatus(code: string): ChangeFileStatus {
  const ch = code[0] ?? 'M';
  if (ch === 'A' || ch === 'C') return 'A';
  if (ch === 'D') return 'D';
  if (ch === 'R') return 'R';
  return 'M';
}

export async function collectWorkingTreeChanges(
  root: string,
  baseSha: string,
): Promise<GitResult<GitDiffEntry[]>> {
  const diffRes = await runGit(root, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--raw',
    '-z',
    '-M',
    '--relative',
    baseSha,
    '--',
  ]);
  if (!diffRes.ok) {
    return { ok: false, message: `git diff failed: ${diffRes.stderr || 'unknown error'}` };
  }

  const byPath = new Map<string, GitDiffEntry>();
  const tokens = splitNulBuffers(diffRes.stdout);
  for (let i = 0; i < tokens.length;) {
    const header = tokens[i++]?.toString('utf8') ?? '';
    if (header === '' || !header.startsWith(':')) continue;
    const fields = header.slice(1).split(' ');
    const oldMode = fields[0] ?? '';
    const newMode = fields[1] ?? '';
    const rawStatus = fields[4] ?? 'M';
    const isSubmodule = oldMode === '160000' || newMode === '160000';
    const status = normalizeStatus(rawStatus);
    if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
      const oldRaw = tokens[i++];
      const newRaw = tokens[i++];
      if (oldRaw === undefined || newRaw === undefined) continue;
      const oldDecoded = decodePath(oldRaw);
      const newDecoded = decodePath(newRaw);
      byPath.set(newDecoded.text, {
        path: newDecoded.text,
        status,
        ...(status === 'R' ? { oldPath: oldDecoded.text } : {}),
        isSubmodule,
        invalidUtf8: oldDecoded.invalidUtf8 || newDecoded.invalidUtf8,
      });
    } else {
      const pathRaw = tokens[i++];
      if (pathRaw === undefined) continue;
      const decoded = decodePath(pathRaw);
      byPath.set(decoded.text, {
        path: decoded.text,
        status,
        isSubmodule,
        invalidUtf8: decoded.invalidUtf8,
      });
    }
  }

  const untrackedRes = await runGit(root, [
    '-c',
    'core.quotePath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  if (!untrackedRes.ok) {
    return {
      ok: false,
      message: `git ls-files failed: ${untrackedRes.stderr || 'unknown error'}`,
    };
  }
  for (const raw of splitNulBuffers(untrackedRes.stdout)) {
    if (raw.length === 0) continue;
    const decoded = decodePath(raw);
    const clean = decoded.text.endsWith('/') ? decoded.text.slice(0, -1) : decoded.text;
    if (clean === '' || byPath.has(clean)) continue;
    let isSubmodule = decoded.text.endsWith('/');
    if (!isSubmodule && !decoded.invalidUtf8) {
      try {
        if (lstatSync(join(root, clean)).isDirectory()) isSubmodule = true;
      } catch {
        // Leave false; unreadable handling partitions it safely later.
      }
    }
    byPath.set(clean, {
      path: clean,
      status: 'A',
      isSubmodule,
      invalidUtf8: decoded.invalidUtf8,
    });
  }

  const sorted = [...byPath.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return { ok: true, value: sorted };
}

export async function readBaseBlob(
  root: string,
  baseSha: string,
  gitPrefix: string,
  repoRelativePath: string,
): Promise<string | null> {
  const res = await runGit(root, ['show', `${baseSha}:${gitPrefix}${repoRelativePath}`]);
  if (!res.ok) return null;
  // Binary detection: any NUL byte marks binary so TS parser never ingests binary blobs.
  if (res.stdout.includes(0)) return null;
  return res.stdout.toString('utf8');
}
