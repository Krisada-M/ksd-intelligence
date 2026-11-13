import { createHash } from 'node:crypto';
import type { ImpactConfig } from '../kernel/config.js';
import { scan, type ScanSummary, type TypescriptApi } from '../workspace/scan.js';
import { beginBuild, publishBuild, writeFiles, writeMeta } from '../../storage/sqlite.js';
import { loadWorkspace } from './workspace.js';

/** Recorded at build time; a different hash later means the index no longer matches the config. */
export function impactConfigHash(impact: ImpactConfig): string {
  return createHash('sha256').update(JSON.stringify(impact)).digest('hex');
}

export interface IndexArgs {
  root: string;
  cacheDir: string;
  typescriptPath: string;
}

/**
 * Part 1 of the index pipeline (runs in the engine child): SCAN, then write the census to a
 * staging database and PUBLISH it. Extraction, resolution and verification arrive in M2a.2.
 */
export async function runIndex(
  args: IndexArgs,
  ts: TypescriptApi,
  progress: (message: string, data?: unknown) => void,
): Promise<ScanSummary> {
  const workspace = await loadWorkspace(args.root);
  progress('scan', { root: workspace.root });
  const { records, summary } = await scan(workspace.root, workspace.config.impact, ts);

  progress('publish', { files: records.length });
  const db = beginBuild(args.cacheDir);
  try {
    writeFiles(db, records);
    writeMeta(db, {
      root: workspace.root,
      built_at: new Date().toISOString(),
      scan_ms: String(summary.ms),
      listing: summary.listing,
      typescript_version: ts.version,
      typescript_path: args.typescriptPath,
      config_hash: impactConfigHash(workspace.config.impact),
      runtime: `${process.versions.bun === undefined ? 'node' : 'bun'} ${process.versions.bun ?? process.versions.node}`,
      tsconfigs: JSON.stringify(summary.tsconfigs),
      tsconfig_bases: JSON.stringify(summary.tsconfigBases),
      tsconfig_errors: JSON.stringify(summary.tsconfigErrors),
    });
  } catch (error) {
    db.close();
    throw error;
  }
  publishBuild(db, args.cacheDir);
  return summary;
}
