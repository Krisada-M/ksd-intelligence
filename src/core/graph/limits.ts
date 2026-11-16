import type { DatabaseSync } from 'node:sqlite';
import type { ImpactLimits } from '../kernel/types.js';

/** D55: repository context, never target completeness or verdict inputs. */
export function repositoryLimits(db: DatabaseSync): ImpactLimits {
  const row = db
    .prepare(
      `SELECT
       (SELECT COUNT(*) FROM gap_sites WHERE code IN ('dynamic-import', 'cjs-require')
         AND detail = '*') AS unbounded,
       (SELECT COUNT(*) FROM files WHERE reason IN ('excluded', 'secret', 'symlink')
         OR (reason = 'outside-index-scope' AND kind NOT IN ('json', 'other'))) AS excluded,
       (SELECT COUNT(*) FROM file_index WHERE extraction = 'not-in-program') AS failed`,
    )
    .get();
  return {
    unboundedDynamicImports: Number(row?.unbounded ?? 0),
    excludedFiles: Number(row?.excluded ?? 0),
    failedFiles: Number(row?.failed ?? 0),
  };
}
