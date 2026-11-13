import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ImpactConfig } from '../kernel/config.js';

const INDEXING_DIR = fileURLToPath(new URL('.', import.meta.url));
// The census classification decides what is indexable, so it is part of the extractor too.
const SCAN_MODULE = fileURLToPath(new URL('../workspace/scan.js', import.meta.url));

let moduleHash: string | undefined;

function hashOfExtractorModules(): string {
  if (moduleHash === undefined) {
    const hash = createHash('sha256');
    const files = readdirSync(INDEXING_DIR)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => `${INDEXING_DIR}/${name}`);
    for (const file of [...files, SCAN_MODULE]) hash.update(readFileSync(file));
    moduleHash = hash.digest('hex');
  }
  return moduleHash;
}

/**
 * D23: the extractor stamp, part of every cache key. Built extractor modules + TypeScript version +
 * the index-relevant config, so a change to any of them invalidates every record without anyone
 * remembering to bump a version.
 */
export function extractorStamp(typescriptVersion: string, configHash: string): string {
  return createHash('sha256')
    .update(`${hashOfExtractorModules()}\n${typescriptVersion}\n${configHash}`)
    .digest('hex')
    .slice(0, 16);
}

/** Recorded at build time; a different hash later means the index no longer matches the config. */
export function impactConfigHash(impact: ImpactConfig): string {
  return createHash('sha256').update(JSON.stringify(impact)).digest('hex');
}
