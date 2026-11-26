/**
 * OMP extension entry: KSD policy module + `ei_workflow`, `ei_status` and `ei_impact` tools in one plugin.
 *
 * STATUS: live-verified pieces — policy module migrated byte-identical from KSD 0.6.0
 * (73fc916) in M1c, ei_workflow verified live in OMP 18.18.8 in M1, ei_status (M2a.1) uses the
 * `ctx.cwd` documented for tool `execute` in OMP 18.19.0 (omp://extensions.md §2), ei_impact
 * (M2b) verified against OMP 18.22.0 extension types (`@oh-my-pi/pi-coding-agent`
 * `extensibility/extensions/types.d.ts`, `wrapper.ts`, `@oh-my-pi/omptype` `src/zod.ts`).
 *
 * Registration order is KSD first, then ei_* (docs/DESIGN.md §10.1). A failure in
 * either part must not prevent the other from registering. Kill switches are
 * independent: ENGINEERING_PROXY_DISABLED=1 (checked inside the policy module)
 * disables only policy injection and /engineering-review; EI_DISABLED=1 disables
 * only the ei_* tools.
 */
import {
  auditFieldsForChanges,
  auditFieldsForImpact,
  auditFieldsForSearch,
  auditFieldsForWorkflow,
  consumeAuditWarning,
  recordAudit,
} from '../../core/audit/index.js';
import { runChanges } from '../../core/changes/changes.js';
import { renderChangesOutcome } from '../../core/changes/render.js';
import { renderStatus, workspaceStatus } from '../../core/engine/status.js';
import { engineVersion } from '../../core/engine/typescript.js';
import {
  loadWorkspace,
  readProjectConfigSync,
  resolveWorkspaceCache,
} from '../../core/engine/workspace.js';
import { impactDetails, renderImpact } from '../../core/impact/render.js';
import { ImpactSession, type ImpactSessionOptions } from '../../core/impact/session.js';
import { isRecord } from '../../core/kernel/guards.js';
import {
  impactLearningsLine,
  proposeLearning,
  snapshot,
  withAnchorIndex,
} from '../../core/knowledge/knowledge.js';
import {
  learningsFor,
  quoteClaim,
  renderLearningList,
  PROPOSAL_LABEL,
} from '../../core/knowledge/render.js';
import type { ProjectConfig } from '../../core/kernel/config.js';
import { runSearch, validateSearchInput } from '../../core/search/lexical.js';
import { renderSearchOutcome } from '../../core/search/render.js';
import { changesVerificationNote, renderVerifyOutcome } from '../../core/verify/render.js';
import {
  loadVerificationState,
  runVerification,
  validateVerifyInput,
  type VerifyOptions,
} from '../../core/verify/verify.js';
import { rootsFromEnv } from '../../workflow/catalog.js';
import { prepareWorkflow } from '../../workflow/loader.js';
import { renderWorkflow } from '../../workflow/render.js';
import { defaultLockPath, readLock } from '../../workflow/sources.js';
import { RISKS, STAGES, TASK_TYPES, WorkflowError } from '../../workflow/types.js';
import { createExtension as createPolicyExtension } from '../../policy/index.js';
import { SECTION_KEY } from '../../policy/policy.js';

interface SchemaLike {
  optional(): SchemaLike;
  describe(text: string): SchemaLike;
  int?(): SchemaLike;
  min?(value: number): SchemaLike;
  max?(value: number): SchemaLike;
}

interface SchemaBuilder {
  string(): SchemaLike;
  boolean?(): SchemaLike;
  number?(): SchemaLike;
  array?(element: SchemaLike): SchemaLike;
  enum(values: readonly string[]): SchemaLike;
  object(shape: Record<string, SchemaLike>): SchemaLike;
}

interface ToolParams {
  task: string;
  stage: string;
  risk?: string;
  type?: string;
  potetoMode?: boolean;
}

interface ImpactParams {
  targets: string[];
  depth?: number;
}

interface ChangesParams {
  base?: string;
  depth?: number;
  planned?: string[];
}

interface SearchParams {
  query: string;
  limit?: number;
}

interface LearningParams {
  action: string;
  target?: string;
  claim?: string;
  source?: string;
}

interface VerifyParams {
  check?: string;
  report?: string;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  details?: unknown;
  isError?: boolean;
}

interface OmpToolDefinition<P> {
  name: string;
  label: string;
  description: string;
  parameters: SchemaLike;
  /** OMP tier (omp://approval-mode.md): every V1 tool is `read`; `ei_verify` decides per call. */
  approval: 'read' | ((args: unknown) => 'read' | 'exec');
  formatApprovalDetails?: (args: unknown) => string[] | undefined;
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal | undefined,
    onUpdate?: (result: ToolResult) => void,
    ctx?: { cwd?: string },
  ): Promise<ToolResult>;
}

export interface OmpExtensionApi {
  zod: SchemaBuilder;
  registerTool<P>(tool: OmpToolDefinition<P>): void;
}

export interface ExtensionDeps {
  env?: NodeJS.ProcessEnv;
  lockPath?: string;
  skillsDir?: string;
  cacheHome?: string;
  impactSession?: ImpactSessionOptions;
  /** Where the load-time config is read to decide which V2 tools register (default: cwd). */
  cwd?: string;
  /** Injectable for tests; defaults to the real KSD policy entry. */
  createPolicyExtension?: (pi: OmpExtensionApi) => void;
  /** Injectable for tests; defaults to the real check runner. */
  verifyRunner?: VerifyOptions['runner'];
}

function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

// Load-time errors have no ctx.ui yet; console.error with KSD's SECTION_KEY tag is
// the closest equivalent of KSD's own warning channel (`ctx.ui.notify(msg, "warning")`).
function warnLoad(stage: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ksd-intelligence: ${stage} failed to register (${SECTION_KEY}): ${message}`);
}

async function tryResolveCache(
  cwd: string | undefined,
  cacheHome: string | undefined,
): Promise<{ root: string; cacheDir: string } | null> {
  try {
    const info = await resolveWorkspaceCache(cwd ?? process.cwd(), cacheHome);
    return { root: info.root, cacheDir: info.cacheDir };
  } catch {
    return null;
  }
}

function registerEiWorkflow(
  pi: OmpExtensionApi,
  env: NodeJS.ProcessEnv,
  lockPath: string,
  skillsDir?: string,
  cacheHome?: string,
): void {
  const z = pi.zod;
  const shape: Record<string, SchemaLike> = {
    task: z.string(),
    stage: z.enum(STAGES),
    risk: z.enum(RISKS).optional(),
    type: z
      .enum(TASK_TYPES)
      .optional()
      .describe('Caller-asserted task type; overrides the keyword classifier'),
  };
  if (z.boolean) {
    shape.potetoMode = z
      .boolean()
      .optional()
      .describe(
        'Explicit opt-in for poteto-mode multi-phase workflow; never enabled automatically',
      );
  }

  pi.registerTool<ToolParams>({
    name: 'ei_workflow',
    label: 'KSD Skills Workflow',
    description:
      'Choose and read allowlisted Matt Pocock, poteto/pstack and Addy Osmani skills for an engineering task and stage. ' +
      'Pass `type` when you can classify the task yourself (including non-English text); otherwise a keyword guess is used and reported. ' +
      'Set `potetoMode: true` only when the user explicitly opts into poteto-mode.',
    parameters: z.object(shape),
    approval: 'read',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return errorResult('Cancelled');
      const started = performance.now();
      try {
        const workflow = await prepareWorkflow({
          ...params,
          strict: true,
          roots: rootsFromEnv(env),
          lock: await readLock(lockPath),
          skillsDir,
        });
        const cache = await tryResolveCache(ctx?.cwd, cacheHome);
        if (cache !== null) {
          recordAudit(
            cache.cacheDir,
            {
              ts: new Date().toISOString(),
              tool: 'ei_workflow',
              adapter: 'omp',
              outcome: 'result',
              ms: performance.now() - started,
              engine: engineVersion(),
              ...auditFieldsForWorkflow(workflow),
            },
            { env, root: cache.root },
          );
        }
        return {
          content: [{ type: 'text', text: renderWorkflow(workflow) }],
          details: {
            type: workflow.type,
            classifiedBy: workflow.classifiedBy,
            stage: workflow.stage,
            skillIds: workflow.skillIds,
            ready: workflow.ready,
            ...(workflow.optInPacks.length > 0 ? { optInPacks: workflow.optInPacks } : {}),
          },
        };
      } catch (error) {
        const cache = await tryResolveCache(ctx?.cwd, cacheHome);
        if (cache !== null) {
          const task =
            isRecord(params) && typeof params.task === 'string' ? params.task : undefined;
          const stage =
            isRecord(params) && typeof params.stage === 'string' ? params.stage : undefined;
          recordAudit(
            cache.cacheDir,
            {
              ts: new Date().toISOString(),
              tool: 'ei_workflow',
              adapter: 'omp',
              outcome: 'error',
              ms: performance.now() - started,
              engine: engineVersion(),
              code: error instanceof WorkflowError ? error.code : 'WORKFLOW_ERROR',
              ...(task !== undefined ? { task } : {}),
              ...(stage !== undefined ? { stage } : {}),
            },
            { env, root: cache.root },
          );
        }
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}

function registerEiStatus(pi: OmpExtensionApi, deps: ExtensionDeps, env: NodeJS.ProcessEnv): void {
  pi.registerTool<Record<string, never>>({
    name: 'ei_status',
    label: 'KSD Index Status',
    description:
      'Shows whether the code index is ready and how much of the repository it covers. ' +
      'Call this if an ei_ result looks empty, stale or wrong.',
    // No input: nothing the agent passes can reach the engine or its environment.
    parameters: pi.zod.object({}),
    approval: 'read',
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return errorResult('Cancelled');
      const started = performance.now();
      try {
        const status = await workspaceStatus(ctx?.cwd ?? process.cwd(), {
          cacheHome: deps.cacheHome,
          env,
        });
        recordAudit(
          status.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_status',
            adapter: 'omp',
            outcome: 'result',
            ms: performance.now() - started,
            engine: engineVersion(),
            ...(status.typescript.ok ? { ts_version: status.typescript.runtime.version } : {}),
            statusState: status.state,
          },
          { env, root: status.root },
        );
        const extraWarning = consumeAuditWarning(status.cacheDir);
        if (extraWarning !== null) status.auditWarning = extraWarning;
        return { content: [{ type: 'text', text: renderStatus(status) }], details: status };
      } catch (error) {
        const cache = await tryResolveCache(ctx?.cwd, deps.cacheHome);
        if (cache !== null) {
          recordAudit(
            cache.cacheDir,
            {
              ts: new Date().toISOString(),
              tool: 'ei_status',
              adapter: 'omp',
              outcome: 'error',
              ms: performance.now() - started,
              engine: engineVersion(),
              code: 'index-failed',
            },
            { env, root: cache.root },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          `index-failed: ${message}. Retry once; if it fails again, continue without ei_status and say so in your report.`,
        );
      }
    },
  });
}

function registerEiImpact(
  pi: OmpExtensionApi,
  deps: ExtensionDeps,
  env: NodeJS.ProcessEnv,
  sessions: Map<string, ImpactSession>,
): void {
  const z = pi.zod;

  const targetsSchema = (() => {
    const base = z.array ? z.array(z.string()) : z.string();
    const min = base.min ? base.min(1) : base;
    const max = min.max ? min.max(5) : min;
    return max.describe('1–5 targets: bare name, Class.member, path#name, path:line, or file path');
  })();

  const depthSchema = (() => {
    const base = z.number ? z.number() : z.string();
    const int = base.int ? base.int() : base;
    const min = int.min ? int.min(1) : int;
    const max = min.max ? min.max(10) : min;
    return max.optional().describe('How many caller levels to list (1–10, default 2)');
  })();

  pi.registerTool<ImpactParams>({
    name: 'ei_impact',
    label: 'KSD Code Impact',
    description:
      'Before editing a function, method, class, type or exported constant, call this even for comment-only edits. It shows callers by depth with file:line, how far the change reaches, the tests that reach it, and whether the picture is complete. Accepts up to 5 targets as names (`calculateFee`, `PaymentService.charge`), `path#name`, `path:line`, or a file path. Read-only.',
    parameters: z.object({
      targets: targetsSchema,
      depth: depthSchema,
    }),
    approval: 'read',
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return errorResult('Cancelled');
      const started = performance.now();
      const recordInvalid = async (targets?: readonly string[]): Promise<void> => {
        const cache = await tryResolveCache(ctx?.cwd, deps.cacheHome);
        if (cache === null) return;
        recordAudit(
          cache.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_impact',
            adapter: 'omp',
            outcome: 'failure',
            ms: performance.now() - started,
            engine: engineVersion(),
            code: 'INVALID_INPUT',
            codes: ['INVALID_INPUT'],
            ...(targets && targets.length > 0 ? { targets: [...targets] } : {}),
          },
          { env, root: cache.root },
        );
      };
      try {
        const rawTargets = isRecord(params) ? params.targets : undefined;
        const rawDepth = isRecord(params) ? params.depth : undefined;
        if (
          !Array.isArray(rawTargets) ||
          rawTargets.length < 1 ||
          rawTargets.length > 5 ||
          rawTargets.some((target) => typeof target !== 'string' || target.trim() === '')
        ) {
          await recordInvalid();
          return errorResult('INVALID_INPUT: provide 1–5 non-empty string targets');
        }
        if (
          rawDepth !== undefined &&
          (typeof rawDepth !== 'number' ||
            !Number.isInteger(rawDepth) ||
            rawDepth < 1 ||
            rawDepth > 10)
        ) {
          await recordInvalid(rawTargets);
          return errorResult('INVALID_INPUT: depth must be an integer 1–10');
        }

        const workspace = await loadWorkspace(ctx?.cwd ?? process.cwd(), deps.cacheHome);
        let session = sessions.get(workspace.cacheDir);
        if (session === undefined) {
          session = new ImpactSession(workspace, deps.impactSession);
          sessions.set(workspace.cacheDir, session);
        }

        const batch = await session.query(rawTargets, rawDepth, {
          signal,
          onProgress: (message, data) => {
            onUpdate?.({ content: [{ type: 'text', text: message }], details: data });
          },
        });
        if (signal?.aborted) return errorResult('Cancelled');

        const keys = impactDetails(batch).flatMap((item) =>
          'target' in item && typeof item.target === 'string' ? [item.target] : [],
        );
        const learningsLine = await impactLearningsLine(workspace, session, keys, signal);
        const impactText = renderImpact(batch);
        // Appended after the V1 block, never inside it; absent when knowledge is off or empty.
        const text =
          learningsLine === undefined || impactText === 'Cancelled'
            ? impactText
            : `${impactText}\n${learningsLine}`;
        if (text === 'Cancelled') return errorResult('Cancelled');
        recordAudit(
          workspace.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_impact',
            adapter: 'omp',
            outcome: 'result',
            ms: performance.now() - started,
            engine: engineVersion(),
            ...auditFieldsForImpact(batch, engineVersion()),
          },
          { env, root: workspace.root },
        );
        const details = impactDetails(batch);
        const failed = batch.answers.some((answer) => answer.kind === 'failure');
        if (failed) {
          return { isError: true, content: [{ type: 'text', text }], details };
        }
        return { content: [{ type: 'text', text }], details };
      } catch (error) {
        if (signal?.aborted) return errorResult('Cancelled');
        const cache = await tryResolveCache(ctx?.cwd, deps.cacheHome);
        if (cache !== null) {
          recordAudit(
            cache.cacheDir,
            {
              ts: new Date().toISOString(),
              tool: 'ei_impact',
              adapter: 'omp',
              outcome: 'error',
              ms: performance.now() - started,
              engine: engineVersion(),
              code: 'index-failed',
            },
            { env, root: cache.root },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          `index-failed: ${message}. Retry once; if it fails again, continue without ei_impact and say so in your report.`,
        );
      }
    },
  });
}

function registerEiChanges(
  pi: OmpExtensionApi,
  deps: ExtensionDeps,
  env: NodeJS.ProcessEnv,
  sessions: Map<string, ImpactSession>,
): void {
  const z = pi.zod;

  const baseSchema = z
    .string()
    .optional()
    .describe('Git ref to compare against (default: merge-base with the default branch)');

  const depthSchema = (() => {
    const base = z.number ? z.number() : z.string();
    const int = base.int ? base.int() : base;
    const min = int.min ? int.min(1) : int;
    const max = min.max ? min.max(10) : min;
    return max.optional().describe('Levels of callers to list (1–10, default 1)');
  })();

  const plannedSchema = (z.array ? z.array(z.string()) : z.string())
    .optional()
    .describe('Planned symbol targets or file paths; unmentioned changes appear under Not in plan');

  pi.registerTool<ChangesParams>({
    name: 'ei_changes',
    label: 'KSD Changed Code Impact',
    description:
      'Call with no arguments when asked to review the current diff, even if you did not edit or the working tree is clean. Also call after editing code, before reporting the work done. It reads uncommitted changes and lists changed symbols, their impact, tests to run, and files it cannot analyse. A post-edit result with no tests does not waive an earlier ei_impact run-tests verdict. Read-only.',
    parameters: z.object({
      base: baseSchema,
      depth: depthSchema,
      planned: plannedSchema,
    }),
    approval: 'read',
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return errorResult('Cancelled');
      const started = performance.now();
      const recordInvalid = async (): Promise<void> => {
        const cache = await tryResolveCache(ctx?.cwd, deps.cacheHome);
        if (cache === null) return;
        recordAudit(
          cache.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_changes',
            adapter: 'omp',
            outcome: 'failure',
            ms: performance.now() - started,
            engine: engineVersion(),
            code: 'INVALID_INPUT',
            codes: ['INVALID_INPUT'],
          },
          { env, root: cache.root },
        );
      };
      try {
        const rawBase = isRecord(params) ? params.base : undefined;
        const rawDepth = isRecord(params) ? params.depth : undefined;
        const rawPlanned = isRecord(params) ? params.planned : undefined;

        if (rawBase !== undefined && typeof rawBase !== 'string') {
          await recordInvalid();
          return errorResult('INVALID_INPUT: base must be a string');
        }
        if (
          rawDepth !== undefined &&
          (typeof rawDepth !== 'number' ||
            !Number.isInteger(rawDepth) ||
            rawDepth < 1 ||
            rawDepth > 10)
        ) {
          await recordInvalid();
          return errorResult('INVALID_INPUT: depth must be an integer 1–10');
        }
        if (
          rawPlanned !== undefined &&
          (!Array.isArray(rawPlanned) ||
            rawPlanned.some((target) => typeof target !== 'string' || target.trim() === ''))
        ) {
          await recordInvalid();
          return errorResult('INVALID_INPUT: planned must be an array of non-empty strings');
        }

        const workspace = await loadWorkspace(ctx?.cwd ?? process.cwd(), deps.cacheHome);
        let session = sessions.get(workspace.cacheDir);
        if (session === undefined) {
          session = new ImpactSession(workspace, deps.impactSession);
          sessions.set(workspace.cacheDir, session);
        }

        const outcome = await runChanges(session, {
          base: rawBase,
          depth: rawDepth,
          planned: rawPlanned,
          signal,
          onProgress: (message, data) => {
            onUpdate?.({ content: [{ type: 'text', text: message }], details: data });
          },
        });
        if (signal?.aborted) return errorResult('Cancelled');

        const verification = await loadVerificationState(workspace);
        const text = renderChangesOutcome(
          outcome,
          undefined,
          verification &&
            changesVerificationNote(
              verification.reports,
              verification.revision,
              verification.checkNames,
            ),
        );
        if (text === 'Cancelled') return errorResult('Cancelled');
        recordAudit(
          workspace.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_changes',
            adapter: 'omp',
            outcome: outcome.kind,
            ms: performance.now() - started,
            engine: engineVersion(),
            ...auditFieldsForChanges(outcome, engineVersion()),
          },
          { env, root: workspace.root },
        );
        if (outcome.kind === 'failure') {
          return { isError: true, content: [{ type: 'text', text }], details: outcome };
        }
        if (outcome.kind === 'guidance') {
          return { content: [{ type: 'text', text }], details: outcome };
        }
        return { content: [{ type: 'text', text }], details: outcome.value };
      } catch (error) {
        if (signal?.aborted) return errorResult('Cancelled');
        const cache = await tryResolveCache(ctx?.cwd, deps.cacheHome);
        if (cache !== null) {
          recordAudit(
            cache.cacheDir,
            {
              ts: new Date().toISOString(),
              tool: 'ei_changes',
              adapter: 'omp',
              outcome: 'error',
              ms: performance.now() - started,
              engine: engineVersion(),
              code: 'index-failed',
            },
            { env, root: cache.root },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          `index-failed: ${message}. Retry once; if it fails again, continue without ei_changes and say so in your report.`,
        );
      }
    },
  });
}

function registerEiSearch(
  pi: OmpExtensionApi,
  deps: ExtensionDeps,
  env: NodeJS.ProcessEnv,
  sessions: Map<string, ImpactSession>,
): void {
  const z = pi.zod;

  const limitSchema = (() => {
    const base = z.number ? z.number() : z.string();
    const int = base.int ? base.int() : base;
    const min = int.min ? int.min(1) : int;
    const max = min.max ? min.max(20) : min;
    return max.optional().describe('Maximum matches to return (1–20, default 8)');
  })();

  pi.registerTool<SearchParams>({
    name: 'ei_search',
    label: 'KSD Code Search',
    description:
      'Find where something is implemented when you do not know the symbol name. Give a few words or identifiers ("retry payment webhook", "session cookie parse"). Returns ranked declarations with file:line. For a symbol you can already name, call ei_impact directly.',
    parameters: z.object({
      query: z.string().describe('1–200 characters of words or identifiers to search for'),
      limit: limitSchema,
    }),
    approval: 'read',
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return errorResult('Cancelled');
      const started = performance.now();
      const rawQuery = isRecord(params) ? params.query : undefined;
      const rawLimit = isRecord(params) ? params.limit : undefined;
      const recordInvalid = async (queryText?: string, limitVal?: number): Promise<void> => {
        const cache = await tryResolveCache(ctx?.cwd, deps.cacheHome);
        if (cache === null) return;
        recordAudit(
          cache.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_search',
            adapter: 'omp',
            outcome: 'failure',
            ms: performance.now() - started,
            engine: engineVersion(),
            code: 'INVALID_INPUT',
            codes: ['INVALID_INPUT'],
            ...(queryText !== undefined ? { query: queryText } : {}),
            ...(limitVal !== undefined && Number.isInteger(limitVal) ? { limit: limitVal } : {}),
          },
          { env, root: cache.root },
        );
      };
      try {
        const valid = validateSearchInput(rawQuery, rawLimit);
        if (!valid.ok) {
          await recordInvalid(
            typeof rawQuery === 'string' ? rawQuery : undefined,
            typeof rawLimit === 'number' ? rawLimit : undefined,
          );
          return errorResult(`INVALID_INPUT: ${valid.message}`);
        }

        const workspace = await loadWorkspace(ctx?.cwd ?? process.cwd(), deps.cacheHome);
        let session = sessions.get(workspace.cacheDir);
        if (session === undefined) {
          session = new ImpactSession(workspace, deps.impactSession);
          sessions.set(workspace.cacheDir, session);
        }

        const outcome = await runSearch(session, {
          query: valid.query,
          limit: valid.limit,
          signal,
          onProgress: (message, data) => {
            onUpdate?.({ content: [{ type: 'text', text: message }], details: data });
          },
        });
        if (signal?.aborted) return errorResult('Cancelled');

        const text = renderSearchOutcome(outcome);
        if (text === 'Cancelled') return errorResult('Cancelled');
        recordAudit(
          workspace.cacheDir,
          {
            ts: new Date().toISOString(),
            tool: 'ei_search',
            adapter: 'omp',
            outcome: outcome.kind,
            ms: performance.now() - started,
            engine: engineVersion(),
            ...auditFieldsForSearch(outcome, engineVersion(), valid.query, valid.limit),
          },
          { env, root: workspace.root },
        );
        if (outcome.kind === 'failure') {
          return { isError: true, content: [{ type: 'text', text }], details: outcome };
        }
        if (outcome.kind === 'guidance') {
          return { content: [{ type: 'text', text }], details: outcome };
        }
        return { content: [{ type: 'text', text }], details: outcome.value };
      } catch (error) {
        if (signal?.aborted) return errorResult('Cancelled');
        const cache = await tryResolveCache(ctx?.cwd, deps.cacheHome);
        if (cache !== null) {
          recordAudit(
            cache.cacheDir,
            {
              ts: new Date().toISOString(),
              tool: 'ei_search',
              adapter: 'omp',
              outcome: 'error',
              ms: performance.now() - started,
              engine: engineVersion(),
              code: 'index-failed',
              ...(typeof rawQuery === 'string' ? { query: rawQuery } : {}),
            },
            { env, root: cache.root },
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          `index-failed: ${message}. Retry once; if it fails again, continue without ei_search and say so in your report.`,
        );
      }
    },
  });
}

const LEARNING_DESCRIPTION =
  'Read the project decisions recorded for code you are about to change, or propose one. `action: "list"` with an optional `target` (path#name or a file path) returns recorded learnings as quoted data with their source and status; only an unchanged owner-confirmed or test-verified learning is a decision, everything else is an unconfirmed note. `action: "propose"` with `claim`, `target` and `source` ("model-inferred" or "code-observed") stores a proposal for the owner to approve; it never writes to the repository.';

function registerEiLearning(
  pi: OmpExtensionApi,
  deps: ExtensionDeps,
  sessions: Map<string, ImpactSession>,
): void {
  const z = pi.zod;
  pi.registerTool<LearningParams>({
    name: 'ei_learning',
    label: 'KSD Project Learnings',
    description: LEARNING_DESCRIPTION,
    parameters: z.object({
      action: z.enum(['list', 'propose']),
      target: z.string().optional().describe('path#name or a repository file path'),
      claim: z
        .string()
        .optional()
        .describe('propose: the decision in one or two sentences (max 1,000 characters)'),
      source: z.enum(['model-inferred', 'code-observed']).optional(),
    }),
    approval: 'read',
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return errorResult('Cancelled');
      try {
        const action = isRecord(params) ? params.action : undefined;
        if (action !== 'list' && action !== 'propose') {
          return errorResult('INVALID_INPUT: action must be "list" or "propose"');
        }
        const workspace = await loadWorkspace(ctx?.cwd ?? process.cwd(), deps.cacheHome);
        let session = sessions.get(workspace.cacheDir);
        if (session === undefined) {
          session = new ImpactSession(workspace, deps.impactSession);
          sessions.set(workspace.cacheDir, session);
        }
        if (action === 'propose') {
          const outcome = await withAnchorIndex(
            session,
            (index) => proposeLearning(workspace, index, params),
            signal,
          );
          if (outcome.kind === 'failure') return errorResult(`${outcome.code}: ${outcome.message}`);
          const text = [
            `PROPOSED ${outcome.value.id} — ${PROPOSAL_LABEL}; stored outside the repository`,
            `  > ${quoteClaim(outcome.value.claim)}`,
            'Next: tell the owner; it takes effect only after `ei learning approve`.',
          ].join('\n');
          return { content: [{ type: 'text', text }], details: outcome.value };
        }
        const target =
          isRecord(params) && typeof params.target === 'string' ? params.target.trim() : '';
        const snap = await withAnchorIndex(session, (index) => snapshot(workspace, index), signal);
        const scoped =
          target === ''
            ? snap
            : {
                ...snap,
                learnings: learningsFor(snap.learnings, [target]),
                proposals: learningsFor(snap.proposals, [target]),
              };
        const text = renderLearningList({ scope: target === '' ? 'all' : target, ...scoped });
        return { content: [{ type: 'text', text }], details: scoped };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          `ei_learning failed: ${message}. Continue without learnings and say so.`,
        );
      }
    },
  });
}

// A call naming a check runs a process, so it asks at OMP's `exec` tier; reading a file is `read`.
function verifyApproval(args: unknown): 'read' | 'exec' {
  if (isRecord(args) && typeof args.report === 'string' && args.check === undefined) return 'read';
  return 'exec';
}

function registerEiVerify(
  pi: OmpExtensionApi,
  deps: ExtensionDeps,
  env: NodeJS.ProcessEnv,
  loadConfig: ProjectConfig,
): void {
  const z = pi.zod;
  const checkNames = (loadConfig.verification.checks ?? []).map((check) => check.name);
  const reportNames = (loadConfig.verification.reports ?? []).map((report) => report.name);
  const configured = [
    checkNames.length > 0 ? `Checks: ${checkNames.join(', ')}.` : 'No checks configured.',
    reportNames.length > 0 ? `Result files: ${reportNames.join(', ')}.` : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  pi.registerTool<VerifyParams>({
    name: 'ei_verify',
    label: 'KSD Verification Evidence',
    description:
      `Before you say tests, typecheck or lint pass, call this to get a recorded result. Pass \`check\` with a name the owner configured; it runs that exact command and returns PASS, FAIL, SKIPPED, ERROR or NOT_VERIFIED with the git revision. Pass \`report\` instead to read a configured JUnit/TAP file. Only a PASS result supports a claim that tests pass. Running a check asks for approval. ${configured}`.trim(),
    parameters: z.object({
      check: z.string().optional().describe('Name of an owner-configured check, e.g. "test"'),
      report: z.string().optional().describe('Name of an owner-configured result file'),
    }),
    approval: verifyApproval,
    formatApprovalDetails: (args) => {
      if (!isRecord(args) || typeof args.check !== 'string') return undefined;
      const name = args.check;
      // Show the argv that will run, read fresh from the committed config.
      const config = readProjectConfigSync(deps.cwd ?? process.cwd());
      const check = config?.verification.checks?.find((entry) => entry.name === name);
      return check === undefined
        ? [`Check "${name}" is not configured; nothing will run`]
        : [`Command: ${check.command.join(' ')}`, `Timeout: ${check.timeoutSec} s`];
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return errorResult('Cancelled');
      try {
        const valid = validateVerifyInput(params);
        if (!valid.ok) return errorResult(`INVALID_INPUT: ${valid.message}`);
        const workspace = await loadWorkspace(ctx?.cwd ?? process.cwd(), deps.cacheHome);
        const outcome = await runVerification(workspace, valid.request, {
          env,
          signal,
          ...(deps.verifyRunner === undefined ? {} : { runner: deps.verifyRunner }),
        });
        const text = renderVerifyOutcome(outcome, engineVersion());
        if (outcome.kind === 'failure') return errorResult(text);
        return { content: [{ type: 'text', text }], details: outcome.value };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          `NOT_VERIFIED: ei_verify could not complete (${message}). Do not claim tests pass.`,
        );
      }
    },
  });
}

// Advisory tool: every failure becomes an error result for the agent, never a crashed session.
export default function ksdIntelligenceExtension(
  pi: OmpExtensionApi,
  deps: ExtensionDeps = {},
): void {
  const env = deps.env ?? process.env;
  const startPolicy =
    deps.createPolicyExtension ?? ((api: OmpExtensionApi) => createPolicyExtension(api));

  try {
    startPolicy(pi);
  } catch (error) {
    warnLoad('KSD policy module', error);
  }

  if (env.EI_DISABLED === '1') return;

  const sessions = new Map<string, ImpactSession>();

  try {
    registerEiWorkflow(pi, env, deps.lockPath ?? defaultLockPath(), deps.skillsDir, deps.cacheHome);
  } catch (error) {
    warnLoad('ei_workflow tool', error);
  }

  try {
    registerEiStatus(pi, deps, env);
  } catch (error) {
    warnLoad('ei_status tool', error);
  }

  try {
    registerEiImpact(pi, deps, env, sessions);
  } catch (error) {
    warnLoad('ei_impact tool', error);
  }

  try {
    registerEiChanges(pi, deps, env, sessions);
  } catch (error) {
    warnLoad('ei_changes tool', error);
  }

  try {
    registerEiSearch(pi, deps, env, sessions);
  } catch (error) {
    warnLoad('ei_search tool', error);
  }

  let config: ProjectConfig | null;
  try {
    config = readProjectConfigSync(deps.cwd ?? process.cwd());
  } catch (error) {
    warnLoad('V2 tool configuration', error);
    return;
  }
  if (config === null) return;

  // Keep registration failures isolated so one module cannot hide the other.
  try {
    if (config.knowledge.enabled) registerEiLearning(pi, deps, sessions);
  } catch (error) {
    warnLoad('ei_learning tool', error);
  }

  try {
    if (config.verification.enabled) registerEiVerify(pi, deps, env, config);
  } catch (error) {
    warnLoad('ei_verify tool', error);
  }
}
