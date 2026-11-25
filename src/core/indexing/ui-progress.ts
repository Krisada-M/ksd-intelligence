import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildProgress {
  phase: string;
  done?: number;
  total?: number;
  file?: string;
  kind?: 'cold' | 'update';
  reason?: string;
}

export interface BuildHistoryEntry {
  durationMs: number;
  reason?: string;
}

export function readBuildHistory(cacheDir: string): BuildHistoryEntry[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(cacheDir, 'runs.json'), 'utf8'));
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is BuildHistoryEntry => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
      return (
        'durationMs' in entry &&
        typeof entry.durationMs === 'number' &&
        Number.isFinite(entry.durationMs) &&
        entry.durationMs >= 0 &&
        (!('reason' in entry) || typeof entry.reason === 'string')
      );
    });
  } catch {
    return [];
  }
}

/** Called only by the lock holder after a successful publish. */
export function recordBuildHistory(cacheDir: string, entry: BuildHistoryEntry): void {
  const path = join(cacheDir, 'runs.json');
  const temp = join(cacheDir, `.runs-${randomUUID()}.json`);
  try {
    writeFileSync(temp, `${JSON.stringify([...readBuildHistory(cacheDir), entry].slice(-20))}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
