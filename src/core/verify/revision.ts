import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { matchAny } from '../kernel/glob.js';

const execFileAsync = promisify(execFile);

export interface Revision {
  /** `git rev-parse HEAD`, or `unknown` outside a git checkout or before the first commit. */
  sha: string;
  dirty: boolean;
  /** Hash of HEAD plus every uncommitted change; equal only when the tree is the same. */
  treeState: string;
  /** Repository-relative paths with uncommitted changes, including untracked files. */
  changedPaths: string[];
}

async function git(root: string, args: readonly string[]): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 256 * 2 ** 20,
    });
    return stdout;
  } catch {
    return null;
  }
}

function porcelainPaths(status: Buffer, prefix: string): string[] {
  const entries = status.toString('utf8').split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? '';
    if (entry.length < 4) continue;
    // Porcelain paths are relative to the git top level; keep those under the workspace root.
    const path = entry.slice(3);
    if (path.startsWith(prefix)) paths.push(path.slice(prefix.length));
    // Renames and copies carry the old path as the next NUL field.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return paths.sort();
}

/** HEAD and the uncommitted state of the work tree; `changedPaths` are relative to `root`. */
export async function readRevision(root: string): Promise<Revision> {
  const head = await git(root, ['rev-parse', '--verify', 'HEAD']);
  const sha = head === null ? 'unknown' : head.toString('utf8').trim();
  const prefix = (await git(root, ['rev-parse', '--show-prefix']))?.toString('utf8').trim() ?? '';
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const changedPaths = status === null ? [] : porcelainPaths(status, prefix);
  const hash = createHash('sha256').update(sha).update('\0');
  if (status !== null) hash.update(status);
  const diff = sha === 'unknown' ? null : await git(root, ['diff', 'HEAD', '--binary']);
  if (diff !== null) hash.update(diff);
  // Untracked files are not in the diff; their size and mtime stand in for content.
  for (const path of changedPaths) {
    const stat = await lstat(join(root, path)).catch(() => null);
    hash.update(`\0${path}\0${stat === null ? 'gone' : `${stat.size}:${stat.mtimeMs}`}`);
  }
  return {
    sha,
    dirty: status === null || changedPaths.length > 0,
    treeState: hash.digest('hex'),
    changedPaths,
  };
}

/**
 * Newest change time (ms) of the files a report covers: the last commit touching them, or
 * the mtime of any uncommitted file under them (a deleted one counts as now).
 */
export async function newestCoveredChange(
  root: string,
  covers: readonly string[],
  revision: Revision,
  now: number = Date.now(),
): Promise<number> {
  const pathspecs = covers.map((glob) =>
    glob.startsWith('!') ? `:(exclude,glob)${glob.slice(1)}` : `:(glob)${glob}`,
  );
  const log = await git(root, ['log', '-1', '--format=%ct', '--', ...pathspecs]);
  const committed = log === null ? 0 : Number(log.toString('utf8').trim() || 0) * 1000;
  let newest = committed;
  for (const path of revision.changedPaths) {
    if (!matchAny(covers, path)) continue;
    const stat = await lstat(join(root, path)).catch(() => null);
    newest = Math.max(newest, stat === null ? now : stat.mtimeMs);
  }
  return newest;
}
