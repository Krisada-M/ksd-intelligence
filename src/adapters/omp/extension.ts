/**
 * OMP extension entry: KSD policy module + `ei_workflow` tool in one plugin.
 *
 * STATUS: live-verified pieces — policy module migrated byte-identical from KSD 0.6.0
 * (73fc916) in M1c, ei_workflow verified live in OMP 18.18.8 in M1.
 *
 * Registration order is KSD first, then ei_* (docs/DESIGN.md §10.1). A failure in
 * either part must not prevent the other from registering. Kill switches are
 * independent: ENGINEERING_PROXY_DISABLED=1 (checked inside the policy module)
 * disables only policy injection and /engineering-review; EI_DISABLED=1 disables
 * only the ei_* tools.
 */
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
}

interface SchemaBuilder {
  string(): SchemaLike;
  enum(values: readonly string[]): SchemaLike;
  object(shape: Record<string, SchemaLike>): SchemaLike;
}

interface ToolParams {
  task: string;
  stage: string;
  risk?: string;
  type?: string;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  details?: unknown;
  isError?: boolean;
}

interface OmpToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: SchemaLike;
  approval: 'read';
  execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined): Promise<ToolResult>;
}

export interface OmpExtensionApi {
  zod: SchemaBuilder;
  registerTool(tool: OmpToolDefinition): void;
}

export interface ExtensionDeps {
  env?: NodeJS.ProcessEnv;
  lockPath?: string;
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

function registerEiWorkflow(pi: OmpExtensionApi, env: NodeJS.ProcessEnv, lockPath: string): void {
  const z = pi.zod;

  pi.registerTool({
    name: 'ei_workflow',
    label: 'KSD Skills Workflow',
    description:
      'Choose and read allowlisted Matt Pocock, poteto and Addy Osmani skills for an engineering task and stage. ' +
      'Pass `type` when you can classify the task yourself (including non-English text); otherwise a keyword guess is used and reported.',
    parameters: z.object({
      task: z.string(),
      stage: z.enum(STAGES),
      risk: z.enum(RISKS).optional(),
      type: z.enum(TASK_TYPES).optional().describe('Caller-asserted task type; overrides the keyword classifier'),
    }),
    approval: 'read',
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) return errorResult('Cancelled');
      try {
        const workflow = await prepareWorkflow({
          ...params,
          strict: true,
          roots: rootsFromEnv(env),
          lock: await readLock(lockPath),
        });
        return {
          content: [{ type: 'text', text: renderWorkflow(workflow) }],
          details: {
            type: workflow.type,
            classifiedBy: workflow.classifiedBy,
            stage: workflow.stage,
            skillIds: workflow.skillIds,
            ready: workflow.ready,
          },
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  });
}

// Advisory tool: every failure becomes an error result for the agent, never a crashed session.
export default function ksdIntelligenceExtension(pi: OmpExtensionApi, deps: ExtensionDeps = {}): void {
  const env = deps.env ?? process.env;
  const startPolicy = deps.createPolicyExtension ?? ((api: OmpExtensionApi) => createPolicyExtension(api));

  try {
    startPolicy(pi);
  } catch (error) {
    warnLoad('KSD policy module', error);
  }

  if (env.EI_DISABLED === '1') return;

  try {
    registerEiWorkflow(pi, env, deps.lockPath ?? defaultLockPath());
  } catch (error) {
    warnLoad('ei_workflow tool', error);
  }
}
