import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { buildIndex, type BuildOptions, type EngineOutcome } from '../engine/build.js';
import { isHolderAlive, readLockHolder } from '../engine/lock.js';
import type { Workspace } from '../engine/workspace.js';
import { impactConfigHash } from '../indexing/stamp.js';
import type { RiskZoneConfig } from '../kernel/config.js';
import { isRecord } from '../kernel/guards.js';
import type { ImpactResult } from '../kernel/types.js';
import { applyRiskZones } from '../kernel/verdict.js';
import { probe } from '../workspace/probe.js';
import {
  FAILURE_FILE,
  SCHEMA_VERSION,
  openPublished,
  readFiles,
  readMeta,
  readSchemaVersion,
  type FileRecord,
} from '../../storage/sqlite.js';
import { ImpactQuery, type ImpactAnswer } from './query.js';

export interface ImpactBatch {
  answers: ImpactAnswer[];
  index: {
    state: 'fresh' | 'updated' | 'stale' | 'building';
    updatedFiles: number;
    driftedFiles: string[];
  };
}

export interface ImpactSessionOptions {
  build?: (workspace: Workspace, options: BuildOptions) => Promise<EngineOutcome>;
  waitMs?: number;
  /**
   * When true, wait for an in-flight build or lock holder to finish after `waitMs` expires
   * rather than returning a stale result while a child process is still running (used by the
   * CLI so the process never exits and kills the child in a loop; R4, D56).
   */
  waitAfterExpiry?: boolean;
  onProgress?: BuildOptions['onProgress'];
}

function failure(targets: readonly string[], message: string): ImpactAnswer[] {
  return targets.map((input) => ({
    input,
    kind: 'failure',
    code: 'index-failed',
    message: `index-failed: ${message}`,
    retry: true,
  }));
}

function building(targets: readonly string[]): ImpactAnswer[] {
  return targets.map((input) => ({
    input,
    kind: 'guidance',
    code: 'index-building',
    message: 'index-building: index update is still running; retry shortly',
  }));
}

function fileOfKey(key: string): string {
  const hash = key.indexOf('#');
  return hash === -1 ? key : key.slice(0, hash);
}

function staleResult(
  value: ImpactResult,
  reason: string,
  riskZones: 'default' | readonly RiskZoneConfig[],
): ImpactResult {
  const paths = [
    value.span?.file ?? fileOfKey(value.target),
    ...value.byDepth.flat().map((node) => node.span.file),
  ];
  const verdict = applyRiskZones(
    {
      ...value.verdict,
      basis: [...new Set([...value.verdict.basis, 'stale-index'])],
    },
    paths,
    riskZones,
    {
      incomplete: true,
      hasFactors: value.factors.length > 0,
      preMatchedZones: value.verdict.zones,
    },
  );
  return {
    ...value,
    completeness: {
      status: 'partial',
      reasons: [...new Set([...value.completeness.reasons, reason])],
    },
    verdict,
  };
}

function markStale(
  answer: ImpactAnswer,
  reason: string,
  riskZones: 'default' | readonly RiskZoneConfig[],
): ImpactAnswer {
  if (answer.kind !== 'result') return answer;
  if ('results' in answer.value) {
    return {
      ...answer,
      value: {
        ...answer.value,
        results: answer.value.results.map((result) => staleResult(result, reason, riskZones)),
        ...(answer.value.aggregate === undefined
          ? {}
          : { aggregate: staleResult(answer.value.aggregate, reason, riskZones) }),
      },
    };
  }
  return { ...answer, value: staleResult(answer.value, reason, riskZones) };
}

function updatedFiles(outcome: EngineOutcome, fallback: number): number {
  if (!outcome.ok || !isRecord(outcome.value.drift)) return fallback;
  const { added, changed, deleted } = outcome.value.drift;
  if (typeof added !== 'number' || typeof changed !== 'number' || typeof deleted !== 'number') {
    return fallback;
  }
  return added + changed + deleted;
}

function lastFailure(cacheDir: string, builtAt: string | undefined): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cacheDir, FAILURE_FILE), 'utf8'));
    if (
      !isRecord(raw) ||
      typeof raw.at !== 'string' ||
      (builtAt !== undefined && builtAt > raw.at)
    ) {
      return null;
    }
    const problems = Array.isArray(raw.problems)
      ? raw.problems.filter((value) => typeof value === 'string')
      : [];
    return (
      problems.join('; ') ||
      (typeof raw.reason === 'string' ? raw.reason : 'index verification failed')
    );
  } catch {
    return null;
  }
}

function driftFingerprint(
  root: string,
  driftedFiles: readonly string[],
  configHash: string,
): string {
  const parts = [`config:${configHash}`];
  for (const path of driftedFiles) {
    try {
      const stat = statSync(join(root, path));
      parts.push(`${path}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push(`${path}:missing`);
    }
  }
  return parts.join('\n');
}

function staleReasonText(
  driftedFiles: readonly string[],
  staleReason: string,
  failureMessage: string,
): string {
  const paths = driftedFiles.slice(0, 10).join(', ');
  const omitted = driftedFiles.length > 10 ? ` (+${driftedFiles.length - 10} more)` : '';
  return `stale-index: ${paths}${omitted}${staleReason ? `; ${staleReason}` : ''}${failureMessage}`;
}

const TIMED_OUT = Symbol('build wait expired');
const ABORTED = Symbol('wait aborted');

interface SharedBuild {
  task: Promise<EngineOutcome>;
  controller: AbortController;
  waiters: Set<{ signal?: AbortSignal }>;
  progressCallbacks: Set<NonNullable<BuildOptions['onProgress']>>;
  hasDetachedWaiter: boolean;
  cancelled: boolean;
}

/** One repository's query coordinator. No database is held open between calls. */
export class ImpactSession {
  private activeBuild: SharedBuild | null = null;
  private lastFailed: { fingerprint: string; message: string } | null = null;
  private readonly build: NonNullable<ImpactSessionOptions['build']>;
  private readonly waitMs: number;
  private readonly waitAfterExpiry: boolean;
  private readonly onProgress: BuildOptions['onProgress'];

  constructor(
    private readonly workspace: Workspace,
    options: ImpactSessionOptions = {},
  ) {
    this.build = options.build ?? buildIndex;
    this.waitMs = options.waitMs ?? 60_000;
    this.waitAfterExpiry = options.waitAfterExpiry ?? false;
    this.onProgress = options.onProgress;
  }

  private ensureBuild(): SharedBuild {
    if (this.activeBuild !== null && !this.activeBuild.cancelled) {
      return this.activeBuild;
    }
    const controller = new AbortController();
    const waiters = new Set<{ signal?: AbortSignal }>();
    const progressCallbacks = new Set<NonNullable<BuildOptions['onProgress']>>();
    const onProgress: BuildOptions['onProgress'] = (message, data) => {
      this.onProgress?.(message, data);
      for (const cb of progressCallbacks) cb(message, data);
    };
    const shared: SharedBuild = {
      task: Promise.resolve({
        ok: false,
        code: 'index-failed',
        message: 'uninitialized',
        fix: 'retry',
      }),
      controller,
      waiters,
      progressCallbacks,
      hasDetachedWaiter: false,
      cancelled: false,
    };
    const task = Promise.resolve()
      .then(() =>
        this.build(this.workspace, {
          onProgress,
          signal: controller.signal,
        }),
      )
      .catch((error: unknown): EngineOutcome => ({
        ok: false,
        code: 'index-failed',
        message: error instanceof Error ? error.message : String(error),
        fix: 'retry once: ei index',
      }));
    shared.task = task;
    this.activeBuild = shared;
    void task.then(() => {
      if (this.activeBuild === shared) this.activeBuild = null;
    });
    return shared;
  }

  private async runBuildWait(
    deadline: number,
    callOptions: { signal?: AbortSignal; onProgress?: BuildOptions['onProgress'] },
  ): Promise<EngineOutcome | typeof TIMED_OUT> {
    // If an earlier cancelled build is still tearing down its child process, wait for teardown
    // before starting a fresh build so we neither join a dying build nor race the lock file.
    while (this.activeBuild !== null && this.activeBuild.cancelled) {
      const cancelling = this.activeBuild;
      const settled = await this.raceWait(cancelling.task, deadline, callOptions.signal);
      if (settled === ABORTED || callOptions.signal?.aborted) {
        return { ok: false, code: 'index-failed', message: 'Cancelled', fix: 'retry' };
      }
      if (settled === TIMED_OUT) return TIMED_OUT;
    }

    const shared = this.ensureBuild();
    const waiter = { signal: callOptions.signal };
    shared.waiters.add(waiter);
    if (callOptions.onProgress !== undefined) shared.progressCallbacks.add(callOptions.onProgress);

    let settled: EngineOutcome | typeof TIMED_OUT | typeof ABORTED;
    try {
      settled = await this.raceWait(shared.task, deadline, callOptions.signal);
      if (settled === TIMED_OUT && this.waitAfterExpiry && !callOptions.signal?.aborted) {
        settled = await this.raceWait(shared.task, Number.POSITIVE_INFINITY, callOptions.signal);
      }
    } finally {
      shared.waiters.delete(waiter);
      if (callOptions.onProgress !== undefined) {
        shared.progressCallbacks.delete(callOptions.onProgress);
      }
    }

    if (settled === TIMED_OUT && !callOptions.signal?.aborted) {
      shared.hasDetachedWaiter = true;
      return TIMED_OUT;
    }

    if (settled === ABORTED || callOptions.signal?.aborted) {
      const noLiveWaiters = [...shared.waiters].every((w) => w.signal?.aborted === true);
      if (noLiveWaiters && !shared.hasDetachedWaiter && !shared.cancelled) {
        shared.cancelled = true;
        shared.controller.abort();
      }
      if (shared.cancelled) await shared.task;
      return { ok: false, code: 'index-failed', message: 'Cancelled', fix: 'retry' };
    }

    return settled;
  }

  private raceWait<T>(
    promise: Promise<T>,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<T | typeof TIMED_OUT | typeof ABORTED> {
    if (signal?.aborted) return Promise.resolve(ABORTED);
    const competitors: Promise<T | typeof TIMED_OUT | typeof ABORTED>[] = [promise];
    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(deadline)) {
      const remaining = Math.max(0, deadline - Date.now());
      competitors.push(
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), remaining);
        }),
      );
    }
    let onAbort: (() => void) | undefined;
    if (signal !== undefined) {
      competitors.push(
        new Promise<typeof ABORTED>((resolve) => {
          onAbort = () => resolve(ABORTED);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    return Promise.race(competitors).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
    });
  }

  private async untilPublished(
    previousId: string | null,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<'published' | 'released' | 'timed-out' | 'aborted'> {
    while (Date.now() < deadline) {
      if (signal?.aborted) return 'aborted';
      const db = openPublished(this.workspace.cacheDir);
      try {
        if (db !== null && readMeta(db).build_id !== previousId) return 'published';
      } finally {
        db?.close();
      }
      const holder = readLockHolder(this.workspace.cacheDir);
      if (holder === null || !isHolderAlive(holder)) {
        const check = openPublished(this.workspace.cacheDir);
        try {
          return check !== null && readMeta(check).build_id !== previousId
            ? 'published'
            : 'released';
        } finally {
          check?.close();
        }
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return signal?.aborted ? 'aborted' : 'timed-out';
  }

  private answer(
    targets: readonly string[],
    depth: number | undefined,
    db: DatabaseSync,
    options?: { files?: readonly FileRecord[]; meta?: Record<string, string> },
  ): ImpactAnswer[] {
    return new ImpactQuery(db, this.workspace.config.impact, {
      ...options,
      riskZones: this.workspace.config.riskZones,
    }).batch(targets, depth);
  }

  async query(
    targets: readonly string[],
    depth?: number,
    callOptions: { signal?: AbortSignal; onProgress?: BuildOptions['onProgress'] } = {},
  ): Promise<ImpactBatch> {
    if (callOptions.signal?.aborted) {
      return {
        answers: failure(targets, 'Cancelled'),
        index: { state: 'stale', updatedFiles: 0, driftedFiles: [] },
      };
    }
    const invalid =
      targets.length < 1 ||
      targets.length > 5 ||
      targets.some((target) => typeof target !== 'string' || target.length === 0) ||
      (depth !== undefined && (!Number.isInteger(depth) || depth < 1 || depth > 10));
    if (invalid) {
      return {
        answers:
          targets.length === 0
            ? [
                {
                  input: '',
                  kind: 'failure',
                  code: 'INVALID_INPUT',
                  message: 'provide 1–5 targets and depth 1–10',
                },
              ]
            : targets.map((input) => ({
                input,
                kind: 'failure',
                code: 'INVALID_INPUT',
                message: 'provide 1–5 targets and depth 1–10',
              })),
        index: { state: 'fresh', updatedFiles: 0, driftedFiles: [] },
      };
    }

    let db: DatabaseSync | null = null;
    let prefetched: { files?: readonly FileRecord[]; meta?: Record<string, string> } | undefined;
    let driftedFiles: string[] = [];
    let fingerprint = '';
    let previousId: string | null = null;
    let staleReason = '';
    try {
      const configHash = impactConfigHash(this.workspace.config.impact);
      db = openPublished(this.workspace.cacheDir);
      if (db !== null) {
        if (readSchemaVersion(db) !== SCHEMA_VERSION) {
          staleReason = 'published schema does not match current index';
          db.close();
          db = null;
        } else {
          const meta = readMeta(db);
          previousId = meta.build_id ?? null;
          const persistedFailure = lastFailure(this.workspace.cacheDir, meta.built_at);
          if (persistedFailure !== null) staleReason = `update failed: ${persistedFailure}`;
          const files = readFiles(db);
          prefetched = { files, meta };
          const drift = await probe(
            this.workspace.root,
            this.workspace.config.impact,
            files,
            this.workspace.config.impact.freshness,
          );
          driftedFiles = [...new Set([...drift.added, ...drift.changed, ...drift.deleted])].sort();
          if (meta.config_hash !== configHash) {
            staleReason = 'index configuration changed';
            driftedFiles = [...new Set([...driftedFiles, 'ei.config.json'])].sort();
          }
          if (driftedFiles.length === 0 && persistedFailure !== null) {
            this.lastFailed = null;
            const reason = `stale-index: ${staleReason}`;
            return {
              answers: this.answer(targets, depth, db, prefetched).map((answer) =>
                markStale(answer, reason, this.workspace.config.riskZones),
              ),
              index: { state: 'stale', updatedFiles: 0, driftedFiles },
            };
          }
          if (driftedFiles.length === 0) {
            this.lastFailed = null;
            const answers = this.answer(targets, depth, db, prefetched);
            return { answers, index: { state: 'fresh', updatedFiles: 0, driftedFiles: [] } };
          }
          fingerprint = driftFingerprint(this.workspace.root, driftedFiles, configHash);
          if (this.lastFailed !== null && this.lastFailed.fingerprint === fingerprint) {
            const reason = staleReasonText(
              driftedFiles,
              staleReason,
              `; update failed: ${this.lastFailed.message}`,
            );
            return {
              answers: this.answer(targets, depth, db, prefetched).map((answer) =>
                markStale(answer, reason, this.workspace.config.riskZones),
              ),
              index: { state: 'stale', updatedFiles: 0, driftedFiles },
            };
          }
        }
      }

      const deadline = Date.now() + this.waitMs;
      let outcome = await this.runBuildWait(deadline, callOptions);
      if (callOptions.signal?.aborted) {
        return {
          answers: failure(targets, 'Cancelled'),
          index: { state: 'stale', updatedFiles: 0, driftedFiles },
        };
      }
      if (outcome !== TIMED_OUT && !outcome.ok && outcome.code === 'busy') {
        const status = await this.untilPublished(
          previousId,
          this.waitAfterExpiry ? Number.POSITIVE_INFINITY : deadline,
          callOptions.signal,
        );
        if (status === 'aborted' || callOptions.signal?.aborted) {
          return {
            answers: failure(targets, 'Cancelled'),
            index: { state: 'stale', updatedFiles: 0, driftedFiles },
          };
        }
        outcome =
          status === 'published'
            ? { ok: true, value: { action: 'update' } }
            : status === 'released' || this.waitAfterExpiry
              ? {
                  ok: false,
                  code: 'index-failed',
                  message: 'another session released the lock without publishing',
                  fix: 'run: ei index',
                }
              : TIMED_OUT;
      }
      if (outcome !== TIMED_OUT && outcome.ok && outcome.value.action === 'failed') {
        const problems = outcome.value.problems;
        outcome = {
          ok: false,
          code: 'index-failed',
          message: Array.isArray(problems) ? problems.join('; ') : 'index verification failed',
          fix: 'retry once: ei index',
        };
      }
      if (outcome !== TIMED_OUT && outcome.ok) {
        db?.close();
        db = null;
        db = openPublished(this.workspace.cacheDir);
        if (db === null || readSchemaVersion(db) !== SCHEMA_VERSION) {
          outcome = {
            ok: false,
            code: 'index-failed',
            message: 'build completed without publishing a compatible index',
            fix: 'retry once: ei index',
          };
        } else {
          this.lastFailed = null;
          const answers = this.answer(targets, depth, db);
          return {
            answers,
            index: {
              state: 'updated',
              updatedFiles: updatedFiles(outcome, driftedFiles.length),
              driftedFiles,
            },
          };
        }
      }
      if (outcome !== TIMED_OUT && !outcome.ok && fingerprint !== '') {
        this.lastFailed = { fingerprint, message: outcome.message };
      }
      if (db === null) {
        return {
          answers: outcome === TIMED_OUT ? building(targets) : failure(targets, outcome.message),
          index: {
            state: outcome === TIMED_OUT ? 'building' : 'stale',
            updatedFiles: 0,
            driftedFiles,
          },
        };
      }
      const failureMessage = outcome === TIMED_OUT ? '' : `; update failed: ${outcome.message}`;
      const reason = staleReasonText(driftedFiles, staleReason, failureMessage);
      return {
        answers: this.answer(targets, depth, db, prefetched).map((answer) =>
          markStale(answer, reason, this.workspace.config.riskZones),
        ),
        index: { state: 'stale', updatedFiles: 0, driftedFiles },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        answers: failure(targets, message),
        index: { state: 'stale', updatedFiles: 0, driftedFiles },
      };
    } finally {
      db?.close();
    }
  }

  getWorkspace(): Workspace {
    return this.workspace;
  }

  /**
   * Ensure the published index is fresh using a full content hash (`freshness: 'hash'`), never
   * `'stat'`. Caller owns closing the returned `db` when non-null.
   */
  async prepareForChanges(
    callOptions: { signal?: AbortSignal; onProgress?: BuildOptions['onProgress'] } = {},
  ): Promise<ChangesSessionContext> {
    return this.prepareSessionDb('hash', callOptions, true);
  }

  /**
   * Ensure the published index is ready for lexical search using configured freshness (`'stat'`
   * by default). Caller owns closing the returned `db` when non-null.
   */
  async prepareForSearch(
    callOptions: { signal?: AbortSignal; onProgress?: BuildOptions['onProgress'] } = {},
  ): Promise<SearchSessionContext> {
    const ctx = await this.prepareSessionDb(
      this.workspace.config.impact.freshness,
      callOptions,
      false,
    );
    return {
      db: ctx.db,
      indexState: ctx.indexState,
      updatedFiles: ctx.updatedFiles,
      driftedFiles: ctx.driftedFiles,
      staleReason: ctx.staleReason,
      failureMessage: ctx.failureMessage,
      ...(ctx.meta !== undefined ? { meta: ctx.meta } : {}),
      ...(ctx.scannedFiles !== undefined ? { scannedFiles: ctx.scannedFiles } : {}),
    };
  }

  private async prepareSessionDb(
    freshness: 'stat' | 'hash',
    callOptions: { signal?: AbortSignal; onProgress?: BuildOptions['onProgress'] } = {},
    capturePreUpdate = false,
  ): Promise<ChangesSessionContext> {
    if (callOptions.signal?.aborted) {
      return {
        db: null,
        indexState: 'failed',
        updatedFiles: 0,
        driftedFiles: [],
        staleReason: null,
        failureMessage: 'Cancelled',
        preUpdateIndexable: null,
      };
    }

    let db: DatabaseSync | null = null;
    let driftedFiles: string[] = [];
    let fingerprint = '';
    let previousId: string | null = null;
    let staleReason = '';
    let preUpdateIndexable: Set<string> | null = null;
    let meta: Record<string, string> | undefined;
    let scannedFiles: number | undefined;
    try {
      const configHash = impactConfigHash(this.workspace.config.impact);
      db = openPublished(this.workspace.cacheDir);
      if (db !== null) {
        if (readSchemaVersion(db) !== SCHEMA_VERSION) {
          staleReason = 'published schema does not match current index';
          db.close();
          db = null;
        } else {
          meta = readMeta(db);
          previousId = meta.build_id ?? null;
          const persistedFailure = lastFailure(this.workspace.cacheDir, meta.built_at);
          if (persistedFailure !== null) staleReason = `update failed: ${persistedFailure}`;
          const files = readFiles(db);
          scannedFiles = files.length;
          if (capturePreUpdate) {
            preUpdateIndexable = new Set(
              files.filter((f) => f.status === 'indexable').map((f) => f.path),
            );
          }
          const drift = await probe(
            this.workspace.root,
            this.workspace.config.impact,
            files,
            freshness,
          );
          driftedFiles = [...new Set([...drift.added, ...drift.changed, ...drift.deleted])].sort();
          if (meta.config_hash !== configHash) {
            staleReason = 'index configuration changed';
            driftedFiles = [...new Set([...driftedFiles, 'ei.config.json'])].sort();
          }
          if (driftedFiles.length === 0 && persistedFailure !== null) {
            this.lastFailed = null;
            return {
              db,
              indexState: 'stale',
              updatedFiles: 0,
              driftedFiles,
              staleReason: `stale-index: ${staleReason}`,
              failureMessage: null,
              preUpdateIndexable,
              meta,
              scannedFiles,
            };
          }
          if (driftedFiles.length === 0) {
            this.lastFailed = null;
            return {
              db,
              indexState: 'fresh',
              updatedFiles: 0,
              driftedFiles: [],
              staleReason: null,
              failureMessage: null,
              preUpdateIndexable,
              meta,
              scannedFiles,
            };
          }
          fingerprint = driftFingerprint(this.workspace.root, driftedFiles, configHash);
          if (this.lastFailed !== null && this.lastFailed.fingerprint === fingerprint) {
            return {
              db,
              indexState: 'stale',
              updatedFiles: 0,
              driftedFiles,
              staleReason: staleReasonText(
                driftedFiles,
                staleReason,
                `; update failed: ${this.lastFailed.message}`,
              ),
              failureMessage: null,
              preUpdateIndexable,
              meta,
              scannedFiles,
            };
          }
        }
      }

      const deadline = Date.now() + this.waitMs;
      let outcome = await this.runBuildWait(deadline, callOptions);
      if (callOptions.signal?.aborted) {
        db?.close();
        return {
          db: null,
          indexState: 'failed',
          updatedFiles: 0,
          driftedFiles,
          staleReason: null,
          failureMessage: 'Cancelled',
          preUpdateIndexable,
        };
      }
      if (outcome !== TIMED_OUT && !outcome.ok && outcome.code === 'busy') {
        const status = await this.untilPublished(
          previousId,
          this.waitAfterExpiry ? Number.POSITIVE_INFINITY : deadline,
          callOptions.signal,
        );
        if (status === 'aborted' || callOptions.signal?.aborted) {
          db?.close();
          return {
            db: null,
            indexState: 'failed',
            updatedFiles: 0,
            driftedFiles,
            staleReason: null,
            failureMessage: 'Cancelled',
            preUpdateIndexable,
          };
        }
        outcome =
          status === 'published'
            ? { ok: true, value: { action: 'update' } }
            : status === 'released' || this.waitAfterExpiry
              ? {
                  ok: false,
                  code: 'index-failed',
                  message: 'another session released the lock without publishing',
                  fix: 'run: ei index',
                }
              : TIMED_OUT;
      }
      if (outcome !== TIMED_OUT && outcome.ok && outcome.value.action === 'failed') {
        const problems = outcome.value.problems;
        outcome = {
          ok: false,
          code: 'index-failed',
          message: Array.isArray(problems) ? problems.join('; ') : 'index verification failed',
          fix: 'retry once: ei index',
        };
      }
      if (outcome !== TIMED_OUT && outcome.ok) {
        db?.close();
        db = openPublished(this.workspace.cacheDir);
        if (db === null || readSchemaVersion(db) !== SCHEMA_VERSION) {
          db?.close();
          db = null;
          outcome = {
            ok: false,
            code: 'index-failed',
            message: 'build completed without publishing a compatible index',
            fix: 'retry once: ei index',
          };
        } else {
          this.lastFailed = null;
          return {
            db,
            indexState: 'updated',
            updatedFiles: updatedFiles(outcome, driftedFiles.length),
            driftedFiles,
            staleReason: null,
            failureMessage: null,
            preUpdateIndexable,
          };
        }
      }
      if (outcome !== TIMED_OUT && !outcome.ok && fingerprint !== '') {
        this.lastFailed = { fingerprint, message: outcome.message };
      }
      if (db === null) {
        return {
          db: null,
          indexState: outcome === TIMED_OUT ? 'building' : 'failed',
          updatedFiles: 0,
          driftedFiles,
          staleReason: null,
          failureMessage:
            outcome === TIMED_OUT
              ? 'index update is still running; retry shortly'
              : outcome.message,
          preUpdateIndexable,
        };
      }
      const failureMessage = outcome === TIMED_OUT ? '' : `; update failed: ${outcome.message}`;
      return {
        db,
        indexState: 'stale',
        updatedFiles: 0,
        driftedFiles,
        staleReason: staleReasonText(driftedFiles, staleReason, failureMessage),
        failureMessage: null,
        preUpdateIndexable,
        ...(meta !== undefined ? { meta } : {}),
        ...(scannedFiles !== undefined ? { scannedFiles } : {}),
      };
    } catch (error) {
      db?.close();
      return {
        db: null,
        indexState: 'failed',
        updatedFiles: 0,
        driftedFiles,
        staleReason: null,
        failureMessage: error instanceof Error ? error.message : String(error),
        preUpdateIndexable,
      };
    }
  }
}

export interface SearchSessionContext {
  db: DatabaseSync | null;
  indexState: 'fresh' | 'updated' | 'stale' | 'building' | 'failed';
  updatedFiles: number;
  driftedFiles: string[];
  staleReason: string | null;
  failureMessage: string | null;
  meta?: Record<string, string>;
  scannedFiles?: number;
}

export interface ChangesSessionContext extends SearchSessionContext {
  preUpdateIndexable: Set<string> | null;
}
