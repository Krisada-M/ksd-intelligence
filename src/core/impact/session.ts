import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { DatabaseSync } from 'node:sqlite';
import { buildIndex, type BuildOptions, type EngineOutcome } from '../engine/build.js';
import { isHolderAlive, readLockHolder } from '../engine/lock.js';
import type { Workspace } from '../engine/workspace.js';
import { impactConfigHash } from '../indexing/stamp.js';
import { isRecord } from '../kernel/guards.js';
import type { ImpactResult } from '../kernel/types.js';
import { probe } from '../workspace/probe.js';
import {
  FAILURE_FILE,
  SCHEMA_VERSION,
  openPublished,
  readFiles,
  readMeta,
  readSchemaVersion,
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

function staleResult(value: ImpactResult, reason: string): ImpactResult {
  return {
    ...value,
    completeness: {
      status: 'partial',
      reasons: [...new Set([...value.completeness.reasons, reason])],
    },
    verdict: {
      ...value.verdict,
      level: 'unknown',
      action: 'check-gaps',
      basis: [...new Set([...value.verdict.basis, 'stale-index'])],
    },
  };
}

function markStale(answer: ImpactAnswer, reason: string): ImpactAnswer {
  if (answer.kind !== 'result') return answer;
  if ('results' in answer.value) {
    return {
      ...answer,
      value: {
        ...answer.value,
        results: answer.value.results.map((result) => staleResult(result, reason)),
      },
    };
  }
  return { ...answer, value: staleResult(answer.value, reason) };
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

/** One repository's query coordinator. No database is held open between calls. */
export class ImpactSession {
  private building: Promise<EngineOutcome> | null = null;
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

  private startBuild(): Promise<EngineOutcome> {
    if (this.building !== null) return this.building;
    const task = Promise.resolve()
      .then(() => this.build(this.workspace, { onProgress: this.onProgress }))
      .catch((error: unknown): EngineOutcome => ({
        ok: false,
        code: 'index-failed',
        message: error instanceof Error ? error.message : String(error),
        fix: 'retry once: ei index',
      }));
    this.building = task;
    void task.then(() => {
      if (this.building === task) this.building = null;
    });
    return task;
  }

  private async untilPublished(previousId: string | null, deadline: number): Promise<boolean> {
    while (Date.now() < deadline) {
      const db = openPublished(this.workspace.cacheDir);
      try {
        if (db !== null && readMeta(db).build_id !== previousId) return true;
      } finally {
        db?.close();
      }
      if (!Number.isFinite(deadline)) {
        const holder = readLockHolder(this.workspace.cacheDir);
        if (holder === null || !isHolderAlive(holder)) {
          const check = openPublished(this.workspace.cacheDir);
          try {
            return check !== null && readMeta(check).build_id !== previousId;
          } finally {
            check?.close();
          }
        }
      }
      await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  private answer(
    targets: readonly string[],
    depth: number | undefined,
    db: DatabaseSync,
  ): ImpactAnswer[] {
    return new ImpactQuery(db, this.workspace.config.impact).batch(targets, depth);
  }

  async query(targets: readonly string[], depth?: number): Promise<ImpactBatch> {
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
          const drift = await probe(
            this.workspace.root,
            this.workspace.config.impact,
            readFiles(db),
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
              answers: this.answer(targets, depth, db).map((answer) => markStale(answer, reason)),
              index: { state: 'stale', updatedFiles: 0, driftedFiles },
            };
          }
          if (driftedFiles.length === 0) {
            this.lastFailed = null;
            const answers = this.answer(targets, depth, db);
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
              answers: this.answer(targets, depth, db).map((answer) => markStale(answer, reason)),
              index: { state: 'stale', updatedFiles: 0, driftedFiles },
            };
          }
        }
      }

      const deadline = Date.now() + this.waitMs;
      const task = this.startBuild();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, this.waitMs));
      });
      let outcome: EngineOutcome | typeof TIMED_OUT;
      try {
        outcome = await Promise.race([task, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (outcome === TIMED_OUT && this.waitAfterExpiry) {
        outcome = await task;
      }
      if (outcome !== TIMED_OUT && !outcome.ok && outcome.code === 'busy') {
        const published = await this.untilPublished(
          previousId,
          this.waitAfterExpiry ? Number.POSITIVE_INFINITY : deadline,
        );
        outcome = published
          ? { ok: true, value: { action: 'update' } }
          : this.waitAfterExpiry
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
        answers: this.answer(targets, depth, db).map((answer) => markStale(answer, reason)),
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
}
