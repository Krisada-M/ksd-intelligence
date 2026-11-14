import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isRecord } from '../kernel/guards.js';
import { impactConfigHash } from '../indexing/stamp.js';
import { probe, type ProbeResult } from '../workspace/probe.js';
import {
  FAILURE_FILE,
  SCHEMA_VERSION,
  indexPath,
  openPublished,
  readFiles,
  readMeta,
  readSchemaVersion,
  type FileRecord,
} from '../../storage/sqlite.js';
import { isHolderAlive, readLockHolder } from './lock.js';
import { chooseRuntime, memoryLimitMb, type EngineRuntime } from './runtime.js';
import { pinnedTypescriptVersion, resolveTypescript, type TypescriptCheck } from './typescript.js';
import { loadWorkspace } from './workspace.js';

/** TOOLS.md §6 budget. */
export const STATUS_BUDGET = 3_000;

export interface Coverage {
  scanned: number;
  indexable: number;
  orphan: number;
  unindexed: number;
  /** Count per reason (orphan and unindexed rows). */
  reasons: Record<string, number>;
  packages: number;
}

/** What the extract and resolve phases stored (M2a.2). */
export interface GraphCounts {
  declarations: number;
  edges: number;
  /** Resolved and skipped use targets (not the deduplicated edge-row count). */
  uses: Record<string, number>;
  /** Indexable files by extraction status: `ok`, `parse-error`, `not-in-program`. */
  extraction: Record<string, number>;
  unresolved: Record<string, number>;
  gapSites: Record<string, number>;
  /** Bare imports that resolve to nothing: dependencies not installed. */
  externalUnresolved: number;
}

export interface IndexInfo {
  path: string;
  sizeBytes: number;
  schemaVersion: number;
  /** Raw build metadata (`built_at`, `phases`, `last_action`, `typescript_version`, …). */
  meta: Record<string, string>;
  tsconfigs: string[];
  tsconfigBases: string[];
  tsconfigErrors: string[];
  coverage: Coverage;
  graph: GraphCounts;
}

export interface BuildFailure {
  at: string;
  reason: string;
  problems: string[];
}

export interface WorkspaceStatus {
  state: 'ready' | 'degraded';
  /** Why the state is degraded, and the one owner action that fixes it. */
  reason: string | null;
  fix: string | null;
  root: string;
  repoId: string;
  cacheDir: string;
  config: { path: string | null; errors: string[] };
  runtime: EngineRuntime;
  memoryLimitMb: number;
  typescript: TypescriptCheck;
  index: IndexInfo | null;
  indexError: string | null;
  /** The last build that failed VERIFY after the published one, if any. */
  failure: BuildFailure | null;
  drift: ProbeResult | null;
  lock: { pid: number; startedAt: string; alive: boolean } | null;
}

function stringList(raw: string | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function coverageOf(files: readonly FileRecord[]): Coverage {
  const coverage: Coverage = {
    scanned: files.length,
    indexable: 0,
    orphan: 0,
    unindexed: 0,
    reasons: {},
    packages: new Set(files.map((file) => file.package).filter((pkg) => pkg !== null)).size,
  };
  for (const file of files) {
    if (file.status === 'indexable') coverage.indexable++;
    if (file.status === 'orphan') coverage.orphan++;
    if (file.status === 'unindexed') coverage.unindexed++;
    if (file.reason !== null) {
      coverage.reasons[file.reason] = (coverage.reasons[file.reason] ?? 0) + 1;
    }
  }
  return coverage;
}

function grouped(db: DatabaseSync, sql: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of db.prepare(sql).all()) result[String(row.k)] = Number(row.n);
  return result;
}

function graphOf(db: DatabaseSync): GraphCounts {
  const count = (sql: string): number => Number(db.prepare(sql).get()?.n ?? 0);
  const useRow =
    db
      .prepare(
        `SELECT COALESCE(SUM(indexed_uses), 0) AS indexed,
         COALESCE(SUM(local_uses), 0) AS local,
         COALESCE(SUM(external), 0) AS external,
         COALESCE(SUM(external_unresolved), 0) AS 'external-unresolved',
         COALESCE(SUM(unresolved_other), 0) AS 'unresolved-other',
         COALESCE(SUM(outside_scope), 0) AS 'outside-scope' FROM file_index`,
      )
      .get() ?? {};
  return {
    declarations: count("SELECT COUNT(*) AS n FROM declarations WHERE name != '<module>'"),
    edges: count('SELECT COUNT(*) AS n FROM edges'),
    uses: Object.fromEntries(Object.entries(useRow).map(([key, value]) => [key, Number(value)])),
    extraction: grouped(db, 'SELECT extraction AS k, COUNT(*) AS n FROM file_index GROUP BY k'),
    unresolved: grouped(db, 'SELECT reason AS k, COUNT(*) AS n FROM unresolved GROUP BY k'),
    gapSites: grouped(db, 'SELECT code AS k, COUNT(*) AS n FROM gap_sites GROUP BY k'),
    externalUnresolved: count('SELECT COALESCE(SUM(external_unresolved), 0) AS n FROM file_index'),
  };
}

/** The published index, read-only; null when none exists. Throws when it cannot be read. */
function readIndex(cacheDir: string): { info: IndexInfo; files: FileRecord[] } | null {
  const db = openPublished(cacheDir);
  if (db === null) return null;
  try {
    const schemaVersion = readSchemaVersion(db);
    const current = schemaVersion === SCHEMA_VERSION;
    const meta = current ? readMeta(db) : {};
    const files = current ? readFiles(db) : [];
    return {
      info: {
        path: indexPath(cacheDir),
        sizeBytes: statSync(indexPath(cacheDir)).size,
        schemaVersion,
        meta,
        tsconfigs: stringList(meta.tsconfigs),
        tsconfigBases: stringList(meta.tsconfig_bases),
        tsconfigErrors: stringList(meta.tsconfig_errors),
        coverage: coverageOf(files),
        graph: current
          ? graphOf(db)
          : {
              declarations: 0,
              edges: 0,
              uses: {},
              extraction: {},
              unresolved: {},
              gapSites: {},
              externalUnresolved: 0,
            },
      },
      files,
    };
  } finally {
    db.close();
  }
}

function readFailure(cacheDir: string, publishedAt: string | undefined): BuildFailure | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cacheDir, FAILURE_FILE), 'utf8'));
    if (!isRecord(raw) || typeof raw.at !== 'string' || typeof raw.reason !== 'string') return null;
    // A later successful publish supersedes the failure.
    if (publishedAt !== undefined && publishedAt > raw.at) return null;
    const problems = Array.isArray(raw.problems) ? raw.problems.map(String) : [];
    return { at: raw.at, reason: raw.reason, problems };
  } catch {
    return null;
  }
}

function driftCount(drift: ProbeResult): number {
  return drift.added.length + drift.deleted.length + drift.changed.length;
}

function degradation(
  status: Omit<WorkspaceStatus, 'state' | 'reason' | 'fix'>,
  configHash: string,
): [string, string] | null {
  const { typescript, index, indexError, drift, failure } = status;
  if (!typescript.ok) return [typescript.reason, typescript.fix];
  if (indexError !== null) return [`index unreadable: ${indexError}`, 'run: ei index'];
  if (index === null) return ['no index', 'run: ei index'];
  if (index.schemaVersion !== SCHEMA_VERSION) {
    return [
      `index schema ${index.schemaVersion}, engine expects ${SCHEMA_VERSION}`,
      'run: ei index',
    ];
  }
  if (failure !== null) {
    return [`last build failed verification, older index kept`, 'run: ei doctor --deep'];
  }
  if (index.meta.config_hash !== configHash) {
    return ['impact config changed since the last build', 'run: ei index'];
  }
  if (index.meta.typescript_version !== typescript.runtime.version) {
    return [
      `index built with typescript ${index.meta.typescript_version}, runtime is ${typescript.runtime.version}`,
      'run: ei index',
    ];
  }
  if (drift !== null && driftCount(drift) > 0) {
    return [`stale index: ${driftCount(drift)} files drifted`, 'run: ei index'];
  }
  return null;
}

/** Everything `ei_status` and `ei status` report; reads files only, never starts the engine. */
export async function workspaceStatus(
  start: string,
  options: { cacheHome?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<WorkspaceStatus> {
  const workspace = await loadWorkspace(start, options.cacheHome);
  const { impact } = workspace.config;
  const [runtime, typescript] = await Promise.all([
    chooseRuntime(options.env),
    resolveTypescript({
      version: pinnedTypescriptVersion(),
      cacheHome: options.cacheHome,
      repoRoot: workspace.root,
      useWorkspaceTypescript: impact.useWorkspaceTypescript,
    }),
  ]);

  let index: IndexInfo | null = null;
  let indexError: string | null = null;
  let drift: ProbeResult | null = null;
  try {
    const read = readIndex(workspace.cacheDir);
    index = read?.info ?? null;
    if (read && read.info.schemaVersion === SCHEMA_VERSION) {
      drift = await probe(workspace.root, impact, read.files);
    }
  } catch (error) {
    indexError = error instanceof Error ? error.message : String(error);
  }

  const holder = readLockHolder(workspace.cacheDir);
  const partial = {
    root: workspace.root,
    repoId: workspace.repoId,
    cacheDir: workspace.cacheDir,
    config: { path: workspace.configPath, errors: workspace.configErrors },
    runtime,
    memoryLimitMb: memoryLimitMb(impact.maxMemoryMb),
    typescript,
    index,
    indexError,
    failure: readFailure(workspace.cacheDir, index?.meta.built_at),
    drift,
    lock: holder && { pid: holder.pid, startedAt: holder.startedAt, alive: isHolderAlive(holder) },
  };
  const degraded = degradation(partial, impactConfigHash(impact));
  return {
    state: degraded === null ? 'ready' : 'degraded',
    reason: degraded?.[0] ?? null,
    fix: degraded?.[1] ?? null,
    ...partial,
  };
}

/** DESIGN §14: the engine's peak memory, as of the last build. */
function peakNote(raw: string | undefined): string {
  return raw === undefined
    ? ''
    : ` · engine peak ${Number(raw).toLocaleString('en-US')} MB (last build)`;
}

/** Why the index scope needed more than one program (DESIGN §6.2.1), from build metadata. */
function splitNote(raw: string | undefined): string {
  if (raw === undefined) return '';
  const parsed: unknown = JSON.parse(raw);
  const keys = Array.isArray(parsed) ? parsed.map(String) : [];
  return keys.length === 0 ? '' : ` (split by ${list(keys, 4)})`;
}

/** D49: the text shows home-relative paths; `details` keeps them absolute. */
export function homeRelative(path: string, home: string = homedir()): string {
  if (home === '' || home === '/') return path;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function list(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

function seconds(ms: number | string | undefined): string {
  return ms === undefined ? '?' : `${(Number(ms) / 1000).toFixed(1)}`;
}

function kilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en-US')} KB`;
}

function counted(record: Record<string, number>): string {
  const entries = Object.entries(record)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return entries.length === 0 ? 'none' : entries.map(([k, n]) => `${k} ${n}`).join(' · ');
}

function phasesOf(meta: Record<string, string>): string {
  try {
    const phases: unknown = JSON.parse(meta.phases ?? '{}');
    if (!isRecord(phases)) return '';
    const total = Object.values(phases).reduce<number>((sum, ms) => sum + Number(ms), 0);
    const parts = Object.entries(phases).map(([name, ms]) => `${name} ${seconds(Number(ms))}`);
    return `${seconds(total)} s (${parts.join(' · ')})`;
  } catch {
    return '';
  }
}

function indexLine(status: WorkspaceStatus): string {
  const { index, drift } = status;
  if (status.indexError !== null) return `unreadable (${status.indexError}) · run: ei index`;
  if (index === null) return 'none · run: ei index';
  const built = (index.meta.built_at ?? '?').slice(0, 16).replace('T', ' ');
  let freshness = 'not probed';
  if (drift !== null) {
    // Live timings stay in `details.drift.ms`; the text is byte-identical for the same state.
    const probeNote = `${drift.freshness} probe`;
    freshness =
      driftCount(drift) === 0
        ? `fresh (${probeNote})`
        : `stale: ${drift.changed.length} changed · ${drift.added.length} added · ${drift.deleted.length} deleted (${probeNote})`;
  }
  return `published ${built} UTC · ${freshness} · last ${index.meta.last_action ?? 'build'} ${phasesOf(index.meta)}`;
}

function coverageLine(coverage: Coverage): string {
  const unindexedReasons = Object.entries(coverage.reasons)
    .filter(([reason]) => reason !== 'no-tsconfig')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([reason, count]) => `${reason} ${count}`);
  const why = unindexedReasons.length > 0 ? ` (${unindexedReasons.join(' · ')})` : '';
  return (
    `${coverage.scanned.toLocaleString('en-US')} scanned · ${coverage.indexable.toLocaleString('en-US')} indexable · ` +
    `${coverage.orphan} orphan (no tsconfig) · ${coverage.unindexed.toLocaleString('en-US')} unindexed${why}`
  );
}

function problemsLine(index: IndexInfo, failure: BuildFailure | null): string {
  const { graph } = index;
  const parts = [
    `${graph.extraction['parse-error'] ?? 0} files failed to parse`,
    `${graph.extraction['not-in-program'] ?? 0} not in a program`,
    `${graph.unresolved['unresolved-import'] ?? 0} unresolved imports`,
    `${graph.unresolved['unresolved-name-match'] ?? 0} unresolved name matches`,
    graph.externalUnresolved === 0
      ? 'dependencies installed: yes'
      : `dependencies installed: no (${graph.externalUnresolved} bare imports unresolved)`,
  ];
  const reasons =
    failure === null
      ? 'none'
      : `${failure.reason}: ${list(
          failure.problems.map((p) => p.slice(0, 120)),
          3,
        )}`;
  return `${parts.join(' · ')} · incompleteReasons: ${reasons}`;
}

function typescriptLine(ts: TypescriptCheck): string {
  if (!ts.ok) return `${ts.reason} · ${ts.fix}`;
  const trust =
    ts.sha256 === null
      ? 'workspace copy, not hash-pinned'
      : `verified sha256 ${ts.sha256.slice(0, 12)}`;
  return `${ts.runtime.version} (${ts.runtime.source}) · ${homeRelative(ts.runtime.path)} · ${trust}`;
}

/** The `ei_status` / `ei status` text (TOOLS.md §6). */
export function renderStatus(status: WorkspaceStatus): string {
  const lines = [
    status.state === 'ready'
      ? 'STATUS ready'
      : `STATUS degraded (${status.reason}) · ${status.fix}`,
    `Index       ${indexLine(status)}`,
  ];
  const { index, drift } = status;
  if (index !== null) {
    lines.push(`Coverage    ${coverageLine(index.coverage)}`);
    const { graph, meta } = index;
    lines.push(
      `Graph       ${graph.declarations.toLocaleString('en-US')} declarations · ${graph.edges.toLocaleString('en-US')} edges · ` +
        `programs ${meta.programs ?? '?'}${splitNote(meta.program_split)}`,
    );
    lines.push(`Problems    ${problemsLine(index, status.failure)}`);
    lines.push(`Gap sites   ${counted(graph.gapSites)}`);
    const tsconfigProblems =
      index.tsconfigErrors.length === 0
        ? 'none'
        : `${index.tsconfigErrors.length}: ${list(
            index.tsconfigErrors.map((error) => error.slice(0, 160)),
            3,
          )}`;
    lines.push(
      `Scope       ${index.coverage.packages} packages · tsconfigs ${index.tsconfigs.length} (${list(index.tsconfigs, 6)}) · bases ${index.tsconfigBases.length} · tsconfig problems ${tsconfigProblems}`,
    );
  }
  if (drift !== null && driftCount(drift) > 0) {
    lines.push(`Drift       ${list([...drift.changed, ...drift.added, ...drift.deleted], 5)}`);
  }
  const config = status.config;
  if (config.path === null) {
    lines.push('Config      no ei.config.json · detected defaults (run: ei init)');
  } else if (config.errors.length === 0) {
    lines.push('Config      ei.config.json ok');
  } else {
    lines.push(
      `Config      ei.config.json: ${config.errors.length} problems, defaults used for those sections: ${list(config.errors, 3)}`,
    );
  }
  lines.push(
    `Runtime     ${status.runtime.kind} ${status.runtime.version} (${homeRelative(status.runtime.command)}) · memory limit ${status.memoryLimitMb.toLocaleString('en-US')} MB${peakNote(status.index?.meta.peak_rss_mb)}`,
  );
  lines.push(`TypeScript  ${typescriptLine(status.typescript)}`);
  lines.push(
    index === null
      ? `Store       none yet · cache ${homeRelative(status.cacheDir)}`
      : `Store       ${homeRelative(index.path)} · ${kilobytes(index.sizeBytes)} · schema ${index.schemaVersion}`,
  );
  const lock = status.lock;
  if (lock === null) lines.push('Lock        free');
  else if (lock.alive) lines.push(`Lock        held by pid ${lock.pid} since ${lock.startedAt}`);
  else lines.push(`Lock        stale (pid ${lock.pid} gone; the next build takes it over)`);
  if (index !== null) {
    const { indexed = 0, ...skippedUses } = index.graph.uses;
    const useTotal = Object.values(index.graph.uses).reduce((sum, count) => sum + count, 0);
    lines.push(
      `Uses        approximate · indexed ${indexed.toLocaleString('en-US')} · skipped ${counted(skippedUses)} · ` +
        `indexed share ${useTotal === 0 ? 'n/a' : `${((indexed / useTotal) * 100).toFixed(1)}%`}`,
    );
  }

  const text = lines.join('\n');
  // Budget guard: lists above are already capped with "+N more"; this only fires on huge paths.
  return text.length <= STATUS_BUDGET
    ? text
    : `${text.slice(0, STATUS_BUDGET - 40)}\n… (truncated at ${STATUS_BUDGET} characters)`;
}
