import { readFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { isRecord } from '../kernel/guards.js';
import type { CensusRecord } from '../workspace/scan.js';

/**
 * A workspace package as golden P2 `public-export-surface` needs it: whether it is private and
 * which indexed files its `package.json` entry fields point to.
 */
export interface PackageInfo {
  /** Repo-relative directory of the `package.json` (`.` at the root). */
  dir: string;
  name: string | null;
  private: boolean;
  /** Indexable files an entry field resolves to, sorted. */
  entries: string[];
  /** Entry values that resolve to no indexable file (a wildcard, a missing build output). */
  unresolved: string[];
}

const ENTRY_FIELDS = ['main', 'module', 'types', 'typings', 'browser'] as const;

/** Every string an `exports` map can resolve to, conditions and subpaths included. */
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (isRecord(value)) return Object.values(value).flatMap(exportTargets);
  return [];
}

/** The workspace packages of a census, read from their `package.json` files, sorted by dir. */
export function readPackages(root: string, census: readonly CensusRecord[]): PackageInfo[] {
  const indexable = new Set(census.filter((r) => r.status === 'indexable').map((r) => r.path));
  const packages: PackageInfo[] = [];
  for (const record of census) {
    // Never-read files (excluded, secret) have no hash; their content is not ours to read.
    if (basename(record.path) !== 'package.json' || record.hash === null) continue;
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(join(root, record.path), 'utf8'));
    } catch {
      continue; // an unreadable package.json names no package
    }
    if (!isRecord(pkg)) continue;
    const dir = dirname(record.path);
    const values = [
      ...ENTRY_FIELDS.map((field) => pkg[field]).filter((v) => typeof v === 'string'),
      ...exportTargets(pkg.exports),
    ];
    const entries = new Set<string>();
    const unresolved = new Set<string>();
    for (const value of values) {
      // Keep unresolved entries explicit. Guessing a build-output-to-source mapping could
      // misidentify the public surface and hide the package's real entry.
      const path = posix.join(dir, value);
      if (!value.includes('*') && indexable.has(path)) entries.add(path);
      else unresolved.add(value);
    }
    packages.push({
      dir,
      name: typeof pkg.name === 'string' ? pkg.name : null,
      private: pkg.private === true,
      entries: [...entries].sort(),
      unresolved: [...unresolved].sort(),
    });
  }
  return packages.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}
