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
import { renderStatus, workspaceStatus } from '../../core/engine/status.js';
import { loadWorkspace } from '../../core/engine/workspace.js';
import { impactDetails, renderImpact } from '../../core/impact/render.js';
import { ImpactSession, type ImpactSessionOptions } from '../../core/impact/session.js';
import { isRecord } from '../../core/kernel/guards.js';
import { rootsFromEnv } from '../../workflow/catalog.js';
import { prepareWorkflow } from '../../workflow/loader.js';
import { renderWorkflow } from '../../workflow/render.js';
import { defaultLockPath, readLock } from '../../workflow/sources.js';
import { RISKS, STAGES, TASK_TYPES } from '../../workflow/types.js';
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
  approval: 'read';
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
  /** Injectable for tests; defaults to the real KSD policy entry. */
  createPolicyExtension?: (pi: OmpExtensionApi) => void;
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

function registerEiWorkflow(
  pi: OmpExtensionApi,
  env: NodeJS.ProcessEnv,
  lockPath: string,
  skillsDir?: string,
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
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) return errorResult('Cancelled');
      try {
        const workflow = await prepareWorkflow({
          ...params,
          strict: true,
          roots: rootsFromEnv(env),
          lock: await readLock(lockPath),
          skillsDir,
        });
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
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}

function registerEiStatus(pi: OmpExtensionApi, env: NodeJS.ProcessEnv): void {
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
      try {
        const status = await workspaceStatus(ctx?.cwd ?? process.cwd(), { env });
        return { content: [{ type: 'text', text: renderStatus(status) }], details: status };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          `index-failed: ${message}. Retry once; if it fails again, continue without ei_status and say so in your report.`,
        );
      }
    },
  });
}

function registerEiImpact(pi: OmpExtensionApi, deps: ExtensionDeps): void {
  const z = pi.zod;
  const sessions = new Map<string, ImpactSession>();

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
      'Before you change a function, method, class, type or exported constant, call this to see what depends on it: callers by depth with file:line, how far the change reaches, the tests that reach it, and whether the picture is complete. Accepts up to 5 targets as names (`calculateFee`, `PaymentService.charge`), `path#name`, `path:line`, or a file path. Read-only.',
    parameters: z.object({
      targets: targetsSchema,
      depth: depthSchema,
    }),
    approval: 'read',
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) return errorResult('Cancelled');
      try {
        const rawTargets = isRecord(params) ? params.targets : undefined;
        const rawDepth = isRecord(params) ? params.depth : undefined;
        if (
          !Array.isArray(rawTargets) ||
          rawTargets.length < 1 ||
          rawTargets.length > 5 ||
          rawTargets.some((target) => typeof target !== 'string' || target.trim() === '')
        ) {
          return errorResult('INVALID_INPUT: provide 1–5 non-empty string targets');
        }
        if (
          rawDepth !== undefined &&
          (typeof rawDepth !== 'number' ||
            !Number.isInteger(rawDepth) ||
            rawDepth < 1 ||
            rawDepth > 10)
        ) {
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

        const text = renderImpact(batch);
        if (text === 'Cancelled') return errorResult('Cancelled');
        const details = impactDetails(batch);
        const failed = batch.answers.some((answer) => answer.kind === 'failure');
        if (failed) {
          return { isError: true, content: [{ type: 'text', text }], details };
        }
        return { content: [{ type: 'text', text }], details };
      } catch (error) {
        if (signal?.aborted) return errorResult('Cancelled');
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(
          `index-failed: ${message}. Retry once; if it fails again, continue without ei_impact and say so in your report.`,
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

  try {
    registerEiWorkflow(pi, env, deps.lockPath ?? defaultLockPath(), deps.skillsDir);
  } catch (error) {
    warnLoad('ei_workflow tool', error);
  }

  try {
    registerEiStatus(pi, env);
  } catch (error) {
    warnLoad('ei_status tool', error);
  }

  try {
    registerEiImpact(pi, deps);
  } catch (error) {
    warnLoad('ei_impact tool', error);
  }
}
